//! 原生 UI ↔ Node 的桥接端口（W9b）：宿主 → Node 请求面 + 设置/编辑器端口实现。
//!
//! 权属（执行契约 §3、§6.4）：**CONFIG / Profile 文件是唯一真相源**，写入口只在
//! Node（既有类型化读写路径）；Rust 侧只持不可变显示快照与临时草稿。本模块提供
//! 「怎么问 Node」的机制，不提供任何配置解析或默认值。
//!
//! # 请求面传输（两条既有通道，不改 `ipc/**` 的冻结协议）
//!
//! - 宿主 → Node：`HostBridge::publish_event` 投事件 [`HOST_REQUEST_EVENT`]，
//!   载荷 `{ requestId, method, args }`（方法/形状的唯一定义点在 TS 侧
//!   `src/services/host/types.ts` 的 `HostRequestMap`）；
//! - Node → 宿主：`host_request_result` 命令回执（由 `main.rs` 的分派器转给
//!   [`HostLink::complete`]），失败以结构化 code/message 保真透出为
//!   [`AppError::Remote`]，超时与业务失败分开。
//!
//! 为什么不是 `HostBridge::call`：Node 侧的宿主请求处理器注册（connection.ts 的
//! `NODE_NO_HANDLER` 分支）尚未落地，且本包文件边界不含 `ipc/**` 与
//! `src/services/host/connection.ts`；事件 + 回执两条通道都已端到端可用，方法名/
//! 参数/结果形状与请求/响应通道完全一致 —— W4 的「Node 侧命令面」落地后可整体
//! 换过去，处理器体一行不改。
//!
//! # 线程纪律
//!
//! [`HostLink::request`] 是**阻塞**调用：默认只允许在工作线程使用（设置/编辑器的
//! 端口实现都在后台线程）；UI 主线程路径只用非阻塞的 [`HostLink::notify`] 或
//! [`HostLink::publish_event`]（发送器是 `try_send`，不阻塞调用线程）。唯一例外是
//! `HostLinkChatIntentPort` 的**会话管理六条**（new/close/delete/restore/history/
//! switch）：平台层 UI 回调在请求/回执往返上有界阻塞（超时即上界），属用户尺度低频
//! 动作，A2 已裁定接受。热路径（发送 / slash / 停止）不得走 `request` —— 领域结算点
//! 是回合结束，有界等待只会给出假的 TIMEOUT（见 `ui/chat/intents.rs` 文件头）。
//! 回执在 IPC 分派线程上到达并唤醒等待者，两条路径不互相等待。

mod editor;
mod parse;
mod settings;
#[cfg(test)]
mod test_support;

pub use editor::EditorPortImpl;
pub use settings::SettingsPortImpl;
pub(crate) use parse::parse_settings_snapshot;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::Duration;

use serde_json::{json, Value};

use self::parse::{join_profiles_path, required_f64};
use crate::error::{AppError, AppResult};
use crate::ui::stage::StageProfile;
use crate::{rust_debug, rust_warn};

/// 宿主 → Node 请求的事件名（与 TS 侧 `HOST_REQUEST_EVENT` 同名成对维护）。
pub const HOST_REQUEST_EVENT: &str = "deskpet-host-request";

/// 回执命令名（登记在 `HostCommandMap`）。
pub const HOST_REQUEST_RESULT_METHOD: &str = "host_request_result";

/// 阻塞请求的默认期限。取宽松值：设置提交含配置文件原子写盘与重试（写队列自带
/// 退避重试），编辑器保存含 profile.yaml 读-改-写；超时后调用方拿到 `TIMEOUT`
/// （与业务失败分开），不静默挂起。
pub const HOST_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// 用户尺度交互的等待上限（文件对话框由用户决定时长；阶段文案/记忆整理含模型调用）。
/// 这些请求不能吃默认 10s：超时发生在操作仍进行时，界面会拿到假的 TIMEOUT。
pub const USER_INTERACTION_TIMEOUT: Duration = Duration::from_secs(600);

/// 发布事件的闭包（由 bootstrap 注入：解析当前 Node 代际的 HostBridge）。
type EventSender = Arc<dyn Fn(&str, Value) -> AppResult<()> + Send + Sync>;

enum PendingEntry {
    /// 等结果的阻塞调用方。
    Waiter(std_mpsc::SyncSender<AppResult<Value>>),
    /// 只记录结果的单向请求（如拖动写回；备注用于留痕区分）。
    LogOnly { note: String },
}

/// 宿主 → Node 请求面的连接体：请求号分配、在途登记、事件投递与回执结算。
pub struct HostLink {
    sender: RwLock<Option<EventSender>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, PendingEntry>>,
}

impl Default for HostLink {
    fn default() -> Self {
        Self::new()
    }
}

impl HostLink {
    pub fn new() -> Self {
        Self {
            sender: RwLock::new(None),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// 注入事件发送器（bootstrap 在监督器建好、UI 启动前调用一次）。
    pub fn install_sender(&self, sender: EventSender) {
        *self
            .sender
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(sender);
    }

    /// 发送器是否已接线（未接线时所有请求如实报错，不伪造成功）。
    pub fn connected(&self) -> bool {
        self.sender
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .is_some()
    }

    /// 取当前事件发送器（未接线时如实报错，不伪造成功）。
    fn event_sender(&self) -> AppResult<EventSender> {
        self.sender
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .ok_or_else(|| {
                AppError::Other("宿主 → Node 通道未接线（Node 未连接或引导未完成）".into())
            })
    }

    fn publish(&self, request_id: u64, method: &str, args: Value) -> AppResult<()> {
        self.event_sender()?(
            HOST_REQUEST_EVENT,
            json!({ "requestId": request_id, "method": method, "args": args }),
        )
    }

    /// 发布一条**裸事件**（宿主 → Node；无请求号、无回执）。
    ///
    /// 用途是 UI → Node 的**回执方向**（`deskpet-plan-confirm-resolved` /
    /// `deskpet-plan-step-decision` 等）：Node 侧已按事件名订阅，语义是单向投递
    /// （领域结算方只结算一次，不承诺重放、不回执）。与请求面共用同一发送器
    /// （bootstrap 注入的 `bridge.publish_event`，`try_send` 非阻塞）；未接线时
    /// 如实报错。**不登记在途请求**：裸事件没有回执可等。
    pub fn publish_event(&self, event: &str, payload: Value) -> AppResult<()> {
        self.event_sender()?(event, payload)
    }

    /// 阻塞请求：投递后等回执（[`HOST_REQUEST_TIMEOUT`] 或调用方给的期限）。
    ///
    /// **只能在非 UI 线程调用**（见模块头）。超时移除在途登记；迟到的回执按
    /// 「已超时」的归宿丢弃并留痕，不复活该请求。
    pub fn request(&self, method: &str, args: Value, deadline: Duration) -> AppResult<Value> {
        let request_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = std_mpsc::sync_channel(1);
        Self::lock(&self.pending).insert(request_id, PendingEntry::Waiter(tx));
        if let Err(error) = self.publish(request_id, method, args) {
            Self::lock(&self.pending).remove(&request_id);
            return Err(error);
        }
        match rx.recv_timeout(deadline) {
            Ok(outcome) => outcome,
            Err(_) => {
                Self::lock(&self.pending).remove(&request_id);
                Err(AppError::Timeout)
            }
        }
    }

    /// 单向请求（不等回执）：结果只留痕。用于 UI 主线程的拖动写回等路径。
    pub fn notify(&self, method: &str, args: Value, note: impl Into<String>) -> AppResult<()> {
        let request_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        Self::lock(&self.pending).insert(request_id, PendingEntry::LogOnly { note: note.into() });
        if let Err(error) = self.publish(request_id, method, args) {
            Self::lock(&self.pending).remove(&request_id);
            return Err(error);
        }
        Ok(())
    }

    /// 结算一条回执（由分派器的 `host_request_result` 调用）。
    /// 返回 false = 无此在途请求（已超时/已取消/未知号），由调用方留痕。
    pub fn complete(&self, request_id: u64, outcome: AppResult<Value>) -> bool {
        let entry = Self::lock(&self.pending).remove(&request_id);
        match entry {
            Some(PendingEntry::Waiter(tx)) => {
                // 接收方可能已因超时离开：send 失败即「没人要了」，不是错误。
                let _ = tx.send(outcome);
                true
            }
            Some(PendingEntry::LogOnly { note }) => {
                match &outcome {
                    Ok(_) => rust_debug!("宿主请求 {note} 已回执"),
                    Err(error) => rust_warn!("宿主请求 {note} 失败：{error}"),
                }
                true
            }
            None => false,
        }
    }
}

/// 进程级 HostLink（平台拖动路径与端口实现共用同一实例；bootstrap 安装）。
static HOST_LINK: OnceLock<Arc<HostLink>> = OnceLock::new();

/// bootstrap 安装进程级实例（`ui::start_service` 之前调用一次）。
pub fn install_host_link(link: Arc<HostLink>) {
    if HOST_LINK.set(link).is_err() {
        rust_warn!("HostLink 重复安装（忽略后一次）");
    }
}

pub fn host_link() -> Option<&'static Arc<HostLink>> {
    HOST_LINK.get()
}

/// 分隔条拖动结束：把运行时宽度写回 `general.popup.chatWidth`（单向，结果只留痕）。
///
/// UI 主线程调用（非阻塞）；Node 未接线时如实留痕、不改本地布局 —— 运行时体验
/// 与持久化解耦，下一次启动以磁盘值为准。
pub fn request_chat_width_writeback(width: f64) {
    if !width.is_finite() || width <= 0.0 {
        rust_warn!("分隔条宽度写回跳过：宽度无效（{width}）");
        return;
    }
    let Some(link) = host_link() else {
        rust_warn!("分隔条宽度写回跳过：宿主 → Node 请求面未接线");
        return;
    };
    match link.notify(
        "set_chat_width",
        json!({ "width": width }),
        "分隔条宽度写回",
    ) {
        Ok(()) => rust_debug!("分隔条宽度已提交写回：{width:.0}"),
        Err(error) => rust_warn!("分隔条宽度写回失败：{error}"),
    }
}

/// 聊天内联预览管理器（`configure_chat_image_preview` 的宿主侧唯一实例）。
///
/// W7b 的接入要求是「管理器随 ChatUi 持有」；W8b 的聊天域尚未挂接它，本包先落
/// 进程级单例把命令接通（开关收到前保持关闭 = fail-closed）。**W8b 接线时改为
/// 消费本函数返回的同一实例**（或把单例搬进 ChatUi 并保留本访问器），不要新建
/// 第二个管理器。
pub fn inline_preview() -> &'static crate::images::inline::InlinePreviewManager {
    static PREVIEW: OnceLock<crate::images::inline::InlinePreviewManager> = OnceLock::new();
    PREVIEW.get_or_init(crate::images::inline::InlinePreviewManager::new)
}

/// 解析 `apply_stage_profile` 的载荷为 [`StageProfile`]（缺字段/类型不符即报错，
/// 不给「静默兜底值」—— Node 侧按类型必填发全量字段）。
pub fn parse_stage_profile(profiles_root: &Path, args: &Value) -> AppResult<StageProfile> {
    let layers = args
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("apply_stage_profile 缺少 layers".into()))?;
    let mut parsed = Vec::with_capacity(layers.len());
    for layer in layers {
        let path = layer
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("舞台层缺少 path".into()))?;
        parsed.push(crate::render::LayerSpec {
            path: join_profiles_path(profiles_root, path)?,
            enabled: layer
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| AppError::Config("舞台层缺少 enabled".into()))?,
            sensitivity: required_f64(layer, "sensitivity")?,
            scale: required_f64(layer, "scale")?,
            offset_x_percent: required_f64(layer, "offsetXPercent")?,
            offset_y_percent: required_f64(layer, "offsetYPercent")?,
            // 不透明度不进线协议（不是「缺字段兜底」）：Node 推的是已提交 Profile 的
            // 显示投影，主窗必须全亮；线索是编辑器预览的宿主内部投影
            // （`ui::editor::cue_specs`），不经过本解析。
            opacity: crate::render::LayerSpec::DEFAULT_OPACITY,
        });
    }
    Ok(StageProfile {
        layers: parsed,
        effect_enabled: args
            .get("effectEnabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("apply_stage_profile 缺少 effectEnabled".into()))?,
        intensity: required_f64(args, "intensity")?,
        popup_width: required_f64(args, "popupWidth")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::ports::test_support::*;

    #[test]
    fn 未接线时请求如实报错不挂起() {
        let link = HostLink::new();
        assert!(!link.connected());
        let error = link
            .request("settings_read", json!({}), Duration::from_millis(50))
            .unwrap_err();
        assert_eq!(error.code(), "OTHER");
        assert!(
            link.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "失败后不留在途"
        );
    }

    #[test]
    fn 请求超时如实报超时码且迟到回执不再复活() {
        let (link, published, _) = test_link();
        let waiting = link.clone();
        let handle = std::thread::spawn(move || {
            waiting.request("settings_read", json!({}), Duration::from_millis(30))
        });
        let (request_id, method, _) = loop {
            if let Ok(list) = published.try_lock() {
                if let Some((event, payload)) = list.last() {
                    if event == HOST_REQUEST_EVENT {
                        break (
                            payload.get("requestId").and_then(Value::as_u64).unwrap(),
                            payload
                                .get("method")
                                .and_then(Value::as_str)
                                .unwrap()
                                .to_string(),
                            (),
                        );
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        assert_eq!(method, "settings_read");
        let outcome = handle.join().unwrap();
        assert_eq!(outcome.unwrap_err().code(), "TIMEOUT");
        // 超时后到达的回执：complete 返回 false（调用方留痕），不投给任何人。
        assert!(!link.complete(request_id, Ok(json!({"values": {}}))));
    }

    #[test]
    fn 请求结果按回执结算() {
        let (link, published, _) = test_link();
        let waiting = link.clone();
        let handle = std::thread::spawn(move || {
            waiting.request("settings_read", json!({}), Duration::from_secs(2))
        });
        let (request_id, _, _) = last_request(&published);
        assert!(link.complete(
            request_id,
            Ok(json!({ "values": { "appearance.font.size": 16 } }))
        ));
        let value = handle.join().unwrap().unwrap();
        assert_eq!(value["values"]["appearance.font.size"], json!(16));
    }

    #[test]
    fn 单向请求的失败结果只留痕不炸() {
        let (link, published, _) = test_link();
        link.notify("set_chat_width", json!({"width": 300.0}), "测试")
            .unwrap();
        let (request_id, method, args) = last_request(&published);
        assert_eq!(method, "set_chat_width");
        assert_eq!(args["width"], json!(300.0));
        assert!(link.complete(
            request_id,
            Err(AppError::Remote {
                code: "CONFIG".into(),
                message: "写盘失败".into()
            })
        ));
        // 未知号按「无此在途请求」如实返回 false。
        assert!(!link.complete(request_id, Ok(Value::Null)));
    }

    #[test]
    fn 裸事件发布走同一发送器且不登记在途() {
        let (link, published, _) = test_link();
        link.publish_event(
            "deskpet-plan-confirm-resolved",
            json!({ "planId": "p1", "result": { "confirmed": true, "mode": "auto" } }),
        )
        .unwrap();
        {
            let list = published.lock().unwrap_or_else(|e| e.into_inner());
            let (event, payload) = list.last().cloned().expect("必须已投递一条事件");
            assert_eq!(event, "deskpet-plan-confirm-resolved");
            assert_eq!(payload["planId"], json!("p1"));
        }
        // 裸事件没有回执可等，不占请求号。
        assert!(
            link.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "裸事件不登记在途"
        );
        // 未接线：如实报错，不伪造成功。
        let bare = HostLink::new();
        let error = bare
            .publish_event("deskpet-plan-confirm-resolved", json!({}))
            .unwrap_err();
        assert_eq!(error.code(), "OTHER");
    }

    #[test]
    fn 舞台载荷缺字段即报错() {
        let profiles_root = test_profiles_root();
        let good = json!({
            "layers": [{
                "path": "sugar-pink/materials/L0/bg.png",
                "enabled": true,
                "sensitivity": 0.2,
                "scale": 1.0,
                "offsetXPercent": 0.0,
                "offsetYPercent": 0.0
            }],
            "effectEnabled": true,
            "intensity": 1.0,
            "popupWidth": 730.0
        });
        let profile = parse_stage_profile(&profiles_root, &good).unwrap();
        assert_eq!(profile.layers.len(), 1);
        assert_eq!(profile.popup_width, 730.0);
        assert!(profile.layers[0].path.ends_with("materials/L0/bg.png"));

        // 缺 intensity：报错而不是静默用兜底值。
        let mut broken = good.clone();
        broken.as_object_mut().unwrap().remove("intensity");
        assert!(parse_stage_profile(&profiles_root, &broken).is_err());

        // 越界路径（绝对 / ..）被拒绝。
        let mut escaping = good.clone();
        escaping["layers"][0]["path"] = json!("/etc/passwd");
        assert_eq!(
            parse_stage_profile(&profiles_root, &escaping)
                .unwrap_err()
                .code(),
            "PATH_ESCAPE"
        );
        let mut dotted = good.clone();
        dotted["layers"][0]["path"] = json!("sugar-pink/../../secret");
        assert_eq!(
            parse_stage_profile(&profiles_root, &dotted)
                .unwrap_err()
                .code(),
            "PATH_ESCAPE"
        );
    }
}
