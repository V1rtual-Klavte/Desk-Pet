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

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::ui::editor::{EditorLayer, EditorPort, EditorProfile, EditorSave};
use crate::ui::settings::panels::{
    self, MemoryChange, MemoryDetail, MemoryOverview, PanelRow, SkillCatalog,
};
use crate::ui::settings::{
    self, CardManageOp, CardManageOutcome, CardOption, CardStages, CardVariablePool,
    McpServerDoc, MemoryMaintenanceOp, ProactiveSnapshot, ProfileManageOp, ProfileManageOutcome,
    SettingEdit, SettingsPort, SettingsSnapshot, SettingsValue, SoundLibrary,
};
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

/// profiles 域内相对路径 → 绝对路径（宿主保留最终路径裁决）。
///
/// `profiles_root` 来自 `AppPaths.profiles`（唯一数据根决定点，本模块不自行推算）。
/// 只接受纯 `Normal` 分段（拒绝绝对路径、`..`、`.`、空串与平台前缀）；文件存在性
/// 与凭据判定仍由消费点（渲染器 / Profile 命令）走既有 `AppPaths::validate_*`。
pub fn join_profiles_path(profiles_root: &Path, relative: &str) -> AppResult<PathBuf> {
    let rel = Path::new(relative);
    if relative.is_empty()
        || rel.is_absolute()
        || !rel.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(AppError::PathEscape);
    }
    Ok(profiles_root.join(rel))
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

fn required_f64(value: &Value, key: &str) -> AppResult<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| AppError::Config(format!("字段缺少或不是有限数值: {key}")))
}

// ==========================================
// SettingsPort 实现（经 HostLink 收发）
// ==========================================

/// 设置端口：读 = `settings_read`、写 = `settings_commit`（Node 侧走既有原子保存路径）。
pub struct SettingsPortImpl {
    link: Arc<HostLink>,
}

impl SettingsPortImpl {
    pub fn new(link: Arc<HostLink>) -> Self {
        Self { link }
    }
}

impl SettingsPort for SettingsPortImpl {
    fn fetch(&self) -> AppResult<SettingsSnapshot> {
        let value = self
            .link
            .request("settings_read", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_settings_snapshot(&value)
    }

    fn commit(&self, changes: &[SettingEdit]) -> AppResult<()> {
        let mut wire_changes = Vec::with_capacity(changes.len());
        for edit in changes {
            wire_changes.push(json!({
                "key": edit.key,
                "value": settings_value_to_json(&edit.value)?,
            }));
        }
        self.link.request(
            "settings_commit",
            json!({ "changes": wire_changes }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn cards(&self) -> AppResult<Vec<CardOption>> {
        let value = self
            .link
            .request("personality_cards", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_card_options(&value)
    }

    fn profiles(&self) -> AppResult<Vec<crate::ui::settings::ProfileOption>> {
        let value = self
            .link
            .request("profile_list", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_profile_options(&value)
    }

    fn check_update(&self) -> AppResult<()> {
        settings::updates::check_interactive(true)
    }

    // ── 管理面（W9d）：工具页 ──

    fn mcp_servers(&self) -> AppResult<Vec<PanelRow>> {
        let value = self
            .link
            .request("tools_mcp_servers", json!({}), HOST_REQUEST_TIMEOUT)?;
        panels::parse_rows_field(&value)
    }

    fn set_mcp_server_enabled(&self, name: &str, enabled: bool) -> AppResult<()> {
        self.link.request(
            "tools_mcp_toggle",
            json!({ "id": name, "enabled": enabled }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn skills(&self) -> AppResult<SkillCatalog> {
        let value = self
            .link
            .request("tools_skills", json!({}), HOST_REQUEST_TIMEOUT)?;
        let rows = panels::parse_rows_field(&value)?;
        Ok(SkillCatalog {
            rows,
            index_error: value
                .get("indexError")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        })
    }

    fn set_skill_enabled(&self, relative_path: &str, enabled: bool) -> AppResult<()> {
        self.link.request(
            "tools_skill_toggle",
            json!({ "id": relative_path, "enabled": enabled }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn tool_policies(&self) -> AppResult<Vec<PanelRow>> {
        let value = self
            .link
            .request("tools_tool_policies", json!({}), HOST_REQUEST_TIMEOUT)?;
        panels::parse_rows_field(&value)
    }

    // ── 管理面（W9d）：记忆页 ──

    fn memory_overview(
        &self,
        scope: Option<&str>,
        scope_id: Option<&str>,
    ) -> AppResult<MemoryOverview> {
        let mut args = serde_json::Map::new();
        if let Some(scope) = scope {
            args.insert("scope".into(), Value::String(scope.to_string()));
        }
        if let Some(scope_id) = scope_id {
            args.insert("scopeId".into(), Value::String(scope_id.to_string()));
        }
        let value =
            self.link
                .request("memory_overview", Value::Object(args), HOST_REQUEST_TIMEOUT)?;
        parse_memory_overview(&value)
    }

    fn memory_item_detail(&self, id: &str) -> AppResult<MemoryDetail> {
        let value = self.link.request(
            "memory_item_detail",
            json!({ "id": id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        parse_memory_detail(&value)
    }

    fn memory_change(&self, change: &MemoryChange) -> AppResult<i64> {
        let mut args = json!({
            "action": change.action.as_wire(),
            "itemId": change.item_id,
            "expectedVersion": change.expected_version,
            "baseRevision": change.base_revision,
        });
        let object = args
            .as_object_mut()
            .ok_or_else(|| AppError::Other("记忆变更载荷构造失败".into()))?;
        if let Some(content) = &change.content {
            object.insert("content".into(), Value::String(content.clone()));
        }
        if let Some(pinned) = change.pinned {
            object.insert("pinned".into(), Value::Bool(pinned));
        }
        let value = self
            .link
            .request("memory_item_change", args, HOST_REQUEST_TIMEOUT)?;
        value
            .get("revision")
            .and_then(Value::as_i64)
            .ok_or_else(|| AppError::Config("memory_item_change 回执缺少 revision".into()))
    }

    // ── 本批管理面（通用 / AI / 外观 / 工具 / 记忆）──

    fn defaults(&self) -> AppResult<SettingsSnapshot> {
        let value = self
            .link
            .request("settings_defaults", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_settings_snapshot(&value)
    }

    fn export_config(&self) -> AppResult<Option<String>> {
        // 含原生保存对话框：等待上限按用户尺度（见 USER_INTERACTION_TIMEOUT）。
        let value = self
            .link
            .request("config_export", json!({}), USER_INTERACTION_TIMEOUT)?;
        parse_saved_path(&value, "config_export")
    }

    fn import_config(&self) -> AppResult<bool> {
        let value = self
            .link
            .request("config_import", json!({}), USER_INTERACTION_TIMEOUT)?;
        Ok(value
            .get("imported")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("config_import 回执缺少 imported".into()))?)
    }

    fn proactive_control(&self, enabled: Option<bool>) -> AppResult<ProactiveSnapshot> {
        let args = match enabled {
            Some(enabled) => json!({ "enabled": enabled }),
            None => json!({ "enabled": Value::Null }),
        };
        let value = self
            .link
            .request("proactive_control", args, HOST_REQUEST_TIMEOUT)?;
        Ok(ProactiveSnapshot {
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| AppError::Config("proactive_control 回执缺少 enabled".into()))?,
            // 与兄弟方法 `memory_item_change` 同口径：revision 缺失是协议违规，不是
            // 「回到 0」—— 静默兜底会让界面拿着假 revision 去提交后续变更。
            revision: value
                .get("revision")
                .and_then(Value::as_i64)
                .ok_or_else(|| AppError::Config("proactive_control 回执缺少 revision".into()))?,
        })
    }

    fn v1rtual_read(&self) -> AppResult<String> {
        let value = self
            .link
            .request("v1rtual_read", json!({}), HOST_REQUEST_TIMEOUT)?;
        required_text(&value, "content", "v1rtual_read")
    }

    fn v1rtual_write(&self, content: &str) -> AppResult<()> {
        self.link.request(
            "v1rtual_write",
            json!({ "content": content }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn card_stages_read(&self, card_id: Option<&str>) -> AppResult<CardStages> {
        let value = self.link.request(
            "card_stages_read",
            card_id_args(card_id),
            USER_INTERACTION_TIMEOUT,
        )?;
        parse_card_stages(&value)
    }

    fn card_stages_write(&self, card_id: Option<&str>, text: &str) -> AppResult<()> {
        let mut args = card_id_args(card_id);
        args["text"] = Value::String(text.to_string());
        self.link
            .request("card_stages_write", args, USER_INTERACTION_TIMEOUT)?;
        Ok(())
    }

    fn card_stages_regenerate(&self, card_id: Option<&str>) -> AppResult<CardStages> {
        // 生成含模型调用：等待上限按用户尺度。
        let value = self.link.request(
            "card_stages_regenerate",
            card_id_args(card_id),
            USER_INTERACTION_TIMEOUT,
        )?;
        parse_card_stages(&value)
    }

    fn card_variable_pool(&self, card_id: Option<&str>) -> AppResult<CardVariablePool> {
        let value = self.link.request(
            "card_variable_pool",
            card_id_args(card_id),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(CardVariablePool {
            card_id: value
                .get("cardId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            text: required_text(&value, "text", "card_variable_pool")?,
        })
    }

    fn card_manage(&self, op: &CardManageOp) -> AppResult<CardManageOutcome> {
        let (args, timeout) = match op {
            // 新建/重命名/删除只改文件：通用请求上限。
            CardManageOp::Create { name } => (
                json!({ "op": "create", "name": name }),
                HOST_REQUEST_TIMEOUT,
            ),
            CardManageOp::Rename { card_id, name } => (
                json!({ "op": "rename", "cardId": card_id, "name": name }),
                HOST_REQUEST_TIMEOUT,
            ),
            CardManageOp::Delete(id) => (
                json!({ "op": "delete", "cardId": id }),
                HOST_REQUEST_TIMEOUT,
            ),
            // 导出/导入含原生文件对话框：等待上限按用户尺度。
            CardManageOp::Export(id) => (
                json!({ "op": "export", "cardId": id }),
                USER_INTERACTION_TIMEOUT,
            ),
            CardManageOp::Import => (json!({ "op": "import" }), USER_INTERACTION_TIMEOUT),
        };
        let value = self.link.request("card_manage", args, timeout)?;
        let cards = value
            .pointer("/list/cards")
            .ok_or_else(|| AppError::Config("card_manage 回执缺少 list.cards".into()))?;
        Ok(CardManageOutcome {
            message: required_text(&value, "message", "card_manage")?,
            cards: parse_card_options(&json!({ "cards": cards }))?,
            // 仅新建回执带 newId；其余操作缺省即「没有新项」，不是协议违规（见字段注释）。
            new_id: value
                .get("newId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            // 激活卡缺字段按空串处理 = 没有激活卡（无活动 Card 允许降级运行），不是协议违规。
            active_id: value
                .get("activeId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }

    fn card_markdown_read(&self, card_id: Option<&str>) -> AppResult<String> {
        let value = self.link.request(
            "card_markdown_read",
            card_id_args(card_id),
            HOST_REQUEST_TIMEOUT,
        )?;
        required_text(&value, "text", "card_markdown_read")
    }

    fn card_markdown_write(&self, card_id: Option<&str>, text: &str) -> AppResult<()> {
        let mut args = card_id_args(card_id);
        args["text"] = Value::String(text.to_string());
        // 与 card_stages_write 同口径：都是保存文档，等待上限按用户尺度。
        self.link
            .request("card_markdown_write", args, USER_INTERACTION_TIMEOUT)?;
        Ok(())
    }

    fn card_template(&self) -> AppResult<String> {
        let value = self
            .link
            .request("card_template", json!({}), HOST_REQUEST_TIMEOUT)?;
        required_text(&value, "text", "card_template")
    }

    fn profile_manage(&self, op: &ProfileManageOp) -> AppResult<ProfileManageOutcome> {
        let (args, timeout) = match op {
            // 新建/重命名不经原生文件对话框：通用请求上限。
            ProfileManageOp::Create => (json!({ "op": "create" }), HOST_REQUEST_TIMEOUT),
            ProfileManageOp::Rename { profile_id, name } => (
                json!({ "op": "rename", "profileId": profile_id, "name": name }),
                HOST_REQUEST_TIMEOUT,
            ),
            ProfileManageOp::Delete(id) => (
                json!({ "op": "delete", "profileId": id }),
                HOST_REQUEST_TIMEOUT,
            ),
            // 导出/导入含原生文件对话框：等待上限按用户尺度。
            ProfileManageOp::Export(id) => (
                json!({ "op": "export", "profileId": id }),
                USER_INTERACTION_TIMEOUT,
            ),
            ProfileManageOp::Import => (json!({ "op": "import" }), USER_INTERACTION_TIMEOUT),
            // 恢复默认资源要写回整棵资源树：给宽松上限，避免半途假超时。
            ProfileManageOp::RestoreDefaults => (
                json!({ "op": "restore_defaults" }),
                USER_INTERACTION_TIMEOUT,
            ),
        };
        let value = self.link.request("profile_manage", args, timeout)?;
        let profiles = value
            .pointer("/list/profiles")
            .ok_or_else(|| AppError::Config("profile_manage 回执缺少 list.profiles".into()))?;
        Ok(ProfileManageOutcome {
            message: required_text(&value, "message", "profile_manage")?,
            profiles: parse_profile_options(&json!({ "profiles": profiles }))?,
            // 仅新建回执带 newId；其余操作缺省即「没有新项」，不是协议违规（见调用方字段注释）。
            new_id: value
                .get("newId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        })
    }

    fn sound_library(&self) -> AppResult<SoundLibrary> {
        let value = self
            .link
            .request("sound_library", json!({}), HOST_REQUEST_TIMEOUT)?;
        Ok(SoundLibrary {
            // rows 缺省 = 无事件行（协议上不是违规：事件清单是代码登记，空表如实呈现）。
            rows: match value.get("rows") {
                Some(rows) => panels::parse_rows(rows)?,
                None => Vec::new(),
            },
        })
    }

    fn sound_set_assignment(&self, event: &str, sound_id: &str) -> AppResult<()> {
        self.link.request(
            "sound_set_assignment",
            json!({ "event": event, "soundId": sound_id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn sound_reset(&self) -> AppResult<()> {
        self.link
            .request("sound_reset", json!({}), HOST_REQUEST_TIMEOUT)?;
        Ok(())
    }

    fn sound_preview(&self, sound_id: &str) -> AppResult<()> {
        self.link.request(
            "sound_preview",
            json!({ "soundId": sound_id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn mcp_server_doc(&self, name: Option<&str>) -> AppResult<McpServerDoc> {
        let args = match name {
            Some(name) => json!({ "name": name }),
            None => json!({ "name": Value::Null }),
        };
        let value = self
            .link
            .request("mcp_server_doc", args, HOST_REQUEST_TIMEOUT)?;
        Ok(McpServerDoc {
            text: required_text(&value, "text", "mcp_server_doc")?,
        })
    }

    fn mcp_edit_text(&self, text: &str) -> AppResult<()> {
        self.link.request(
            "mcp_edit",
            json!({ "op": "text", "text": text }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn mcp_delete(&self, name: &str) -> AppResult<()> {
        self.link.request(
            "mcp_edit",
            json!({ "op": "delete", "name": name }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn mcp_test(&self, name: &str) -> AppResult<(bool, String)> {
        // 真实连接可能等待子进程启动/握手：给 60s 上限（仍远离默认 10s）。
        let value =
            self.link
                .request("mcp_test", json!({ "name": name }), Duration::from_secs(60))?;
        Ok((
            // 缺 ok 不按「未成功」静默收场：测试结论的每个字段都是结果本身，
            // 缺失是协议违规，如实报错（Node 的 result 类型是 { ok, message } 全必填）。
            value
                .get("ok")
                .and_then(Value::as_bool)
                .ok_or_else(|| AppError::Config("mcp_test 回执缺少 ok".into()))?,
            required_text(&value, "message", "mcp_test")?,
        ))
    }

    fn mcp_import(&self) -> AppResult<(u32, bool)> {
        let value = self
            .link
            .request("mcp_import", json!({}), USER_INTERACTION_TIMEOUT)?;
        // 取消与「导入 0 条」是两种结果，两字段都必须显式给出：缺 imported 静默按 0
        // 会与取消混淆，缺 canceled 静默按 false 会把取消说成导入成功。
        let imported = value
            .get("imported")
            .and_then(Value::as_u64)
            .ok_or_else(|| AppError::Config("mcp_import 回执缺少 imported".into()))?;
        let canceled = value
            .get("canceled")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("mcp_import 回执缺少 canceled".into()))?;
        Ok((imported as u32, canceled))
    }

    fn mcp_export(&self) -> AppResult<Option<String>> {
        let value = self
            .link
            .request("mcp_export", json!({}), USER_INTERACTION_TIMEOUT)?;
        parse_saved_path(&value, "mcp_export")
    }

    fn skill_upload(&self) -> AppResult<Option<String>> {
        let value = self
            .link
            .request("skill_upload", json!({}), USER_INTERACTION_TIMEOUT)?;
        match value.get("name") {
            // 显式 null = 用户取消（Node 的类型是 `string | null`，取消必发 null）。
            Some(Value::Null) => Ok(None),
            Some(Value::String(name)) if !name.is_empty() => Ok(Some(name.clone())),
            // 缺 name 键 ≠ 取消：静默当取消会把协议违规吞成正常结果。
            None => Err(AppError::Config(
                "skill_upload 回执缺少 name（取消应显式发 null）".into(),
            )),
            Some(_) => Err(AppError::Config("skill_upload 回执的 name 形状非法".into())),
        }
    }

    fn skill_delete(&self, relative_path: &str) -> AppResult<()> {
        self.link.request(
            "skill_delete",
            json!({ "id": relative_path }),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn memory_source_evidence(&self, source_id: &str) -> AppResult<String> {
        let value = self.link.request(
            "memory_source_evidence",
            json!({ "sourceId": source_id }),
            HOST_REQUEST_TIMEOUT,
        )?;
        let info = required_text(&value, "info", "memory_source_evidence")?;
        // 缺 evidence 不当作「空证据」：空串是 Node 显式发来的事实（证据确实为空），
        // 缺字段是协议违规 —— 两者在界面上必须可区分。
        let evidence = value
            .get("evidence")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("memory_source_evidence 回执缺少 evidence".into()))?
            .to_string();
        // original 的三态必须分开：显式 null 是「确实没有原话」这一事实（Node 的
        // 类型是 `string | null`，读取失败或条目已回收时发 null），缺键是协议违规 ——
        // 旧实现把两者混同成「原话已不可用」，坏回执会被伪装成正常的不可用结论。
        let original = match value.get("original") {
            Some(Value::Null) => None,
            Some(Value::String(text)) => Some(text),
            Some(_) => {
                return Err(AppError::Config(
                    "memory_source_evidence 回执的 original 形状非法（应为 string 或 null）".into(),
                ))
            }
            None => {
                return Err(AppError::Config(
                    "memory_source_evidence 回执缺少 original（不可用时应显式发 null）".into(),
                ))
            }
        };
        Ok(format!(
            "【来源 {source_id}】\n{info}\n\n登记时的有界证据：\n{}\n\n会话原话：\n{}",
            if evidence.is_empty() {
                "（空）"
            } else {
                &evidence
            },
            match original {
                Some(text) => text.to_string(),
                None => "（原话已不可用：会话条目已回收或不再满足可信来源判定）".to_string(),
            }
        ))
    }

    fn memory_dreaming_sweep(&self) -> AppResult<String> {
        // 手动整理含模型调用（可能分钟级）：等待上限按用户尺度。
        let value =
            self.link
                .request("memory_dreaming_sweep", json!({}), USER_INTERACTION_TIMEOUT)?;
        required_text(&value, "message", "memory_dreaming_sweep")
    }

    fn memory_maintenance(&self, op: MemoryMaintenanceOp) -> AppResult<String> {
        let op = match op {
            MemoryMaintenanceOp::Backup => "backup",
            MemoryMaintenanceOp::Export => "export",
            MemoryMaintenanceOp::RebuildIndex => "rebuild_index",
        };
        // 备份/重建是数据库级 IO：给宽松上限（不选对话框，故不用用户交互档）。
        let value = self.link.request(
            "memory_maintenance",
            json!({ "op": op }),
            Duration::from_secs(120),
        )?;
        required_text(&value, "message", "memory_maintenance")
    }

    fn memory_restore(&self, preview_only: bool) -> AppResult<String> {
        let value = self.link.request(
            "memory_restore",
            json!({ "op": if preview_only { "preview" } else { "apply" } }),
            Duration::from_secs(120),
        )?;
        required_text(&value, "message", "memory_restore")
    }
}

/// `{ values: { key: bool|number|string } }` → [`SettingsSnapshot`]。
/// 键原样（CONFIG 路径），值只收三种标量；其它形状是协议违规，如实报错。
pub fn parse_settings_snapshot(value: &Value) -> AppResult<SettingsSnapshot> {
    let values = value
        .get("values")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::Config("settings_read 回执缺少 values".into()))?;
    let mut snapshot = SettingsSnapshot::default();
    for (key, raw) in values {
        let parsed = match raw {
            Value::Bool(flag) => SettingsValue::Bool(*flag),
            Value::Number(number) => SettingsValue::Number(
                number
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .ok_or_else(|| AppError::Config(format!("设置值不是有限数值: {key}")))?,
            ),
            Value::String(text) => SettingsValue::Text(text.clone()),
            _ => {
                return Err(AppError::Config(format!(
                    "设置值形状不受支持（只收 bool/number/string）: {key}"
                )))
            }
        };
        snapshot.values.insert(key.clone(), parsed);
    }
    Ok(snapshot)
}

fn settings_value_to_json(value: &SettingsValue) -> AppResult<Value> {
    Ok(match value {
        SettingsValue::Bool(flag) => Value::Bool(*flag),
        SettingsValue::Number(number) => {
            serde_json::Number::from_f64(*number)
                .map(Value::Number)
                .ok_or_else(|| AppError::Config("设置值不是有限数值".into()))?
        }
        SettingsValue::Text(text) => Value::String(text.clone()),
    })
}

/// `{ active, cards: [{id,name,description}] }` → 选项列表（激活项由草稿值承载）。
fn parse_card_options(value: &Value) -> AppResult<Vec<CardOption>> {
    let cards = value
        .get("cards")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("personality_cards 回执缺少 cards".into()))?;
    let mut options = Vec::with_capacity(cards.len());
    for card in cards {
        let id = card
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("人格卡缺少 id".into()))?;
        let name = card
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("人格卡缺少 name".into()))?;
        options.push(CardOption {
            id: id.to_string(),
            name: name.to_string(),
        });
    }
    Ok(options)
}

/// `{ profiles: [{id,name,description}] }` → Profile 选项（激活项由草稿值承载）。
fn parse_profile_options(value: &Value) -> AppResult<Vec<crate::ui::settings::ProfileOption>> {
    let profiles = value
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("profile_list 回执缺少 profiles".into()))?;
    let mut options = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let id = profile
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("Profile 选项缺少 id".into()))?;
        options.push(crate::ui::settings::ProfileOption {
            id: id.to_string(),
            name: profile
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string(),
            description: profile
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        });
    }
    Ok(options)
}

/// `{ revision, statusText, items: [...], jobs: [...] }` → [`MemoryOverview`]。
///
/// 缺 `revision`/`statusText` 是协议违规（如实报错）；`items`/`jobs` 缺省按空数组
/// （「还没读到」与「确实是空」由 UI 域的 loaded 位区分）。
pub fn parse_memory_overview(value: &Value) -> AppResult<MemoryOverview> {
    let revision = value
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Config("memory_overview 回执缺少 revision".into()))?;
    let status_text = value
        .get("statusText")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("memory_overview 回执缺少 statusText".into()))?
        .to_string();
    let items = parse_optional_rows(value, "items")?;
    let jobs = parse_optional_rows(value, "jobs")?;
    Ok(MemoryOverview {
        revision,
        status_text,
        items,
        jobs,
    })
}

/// `{ revision, itemId, version, pinned, info, content, history: [...] }` → [`MemoryDetail`]。
pub fn parse_memory_detail(value: &Value) -> AppResult<MemoryDetail> {
    let item_id = value
        .get("itemId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("memory_item_detail 回执缺少 itemId".into()))?
        .to_string();
    let revision = value
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Config("memory_item_detail 回执缺少 revision".into()))?;
    let version = value
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Config("memory_item_detail 回执缺少 version".into()))?;
    Ok(MemoryDetail {
        item_id,
        revision,
        version,
        // pinned/info/content 与 itemId/version 同口径：Node 的类型是全必填
        // （MemoryItemDetailPayload）。缺字段静默按 false/空串兜底会把「核心画像
        // 标记丢了」「详情是空的」这类坏回执伪装成正常结果，界面据此下错判断。
        pinned: value
            .get("pinned")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("memory_item_detail 回执缺少 pinned".into()))?,
        info: required_text(value, "info", "memory_item_detail")?,
        content: required_text(value, "content", "memory_item_detail")?,
        // 来源 id 缺省 = 没有可回看的来源（读取时机差异，不是协议违规）。
        source_ids: value
            .get("sourceIds")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        history: parse_optional_rows(value, "history")?,
    })
}

fn parse_optional_rows(value: &Value, key: &str) -> AppResult<Vec<PanelRow>> {
    match value.get(key) {
        Some(rows) => panels::parse_rows(rows),
        None => Ok(Vec::new()),
    }
}

// ── 本批管理面的解析辅助 ──

/// 取必填文本字段；缺字段/形状不符是协议违规，如实报错（不补空串冒充成功）。
fn required_text(value: &Value, key: &str, method: &str) -> AppResult<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| AppError::Config(format!("{method} 回执缺少文本字段 {key}")))
}

/// `{ cardId? }` 的公共参数（None = Node 取激活卡）。
fn card_id_args(card_id: Option<&str>) -> Value {
    match card_id {
        Some(card_id) => json!({ "cardId": card_id }),
        None => json!({ "cardId": Value::Null }),
    }
}

fn parse_card_stages(value: &Value) -> AppResult<CardStages> {
    Ok(CardStages {
        card_id: required_text(value, "cardId", "card_stages")?,
        // fallback 是「当前文案是否 Card 不可用时的兜底」这一事实本身，缺字段
        // 静默按 false 会把兜底文案冒充成 Card 文案（Node 侧两个方法都必发此字段）。
        fallback: value
            .get("fallback")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("card_stages 回执缺少 fallback".into()))?,
        text: required_text(value, "text", "card_stages")?,
    })
}

/// `{ saved, path }` → `Option<path>`（saved=false = 用户取消，不是失败）。
fn parse_saved_path(value: &Value, method: &str) -> AppResult<Option<String>> {
    let saved = value
        .get("saved")
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::Config(format!("{method} 回执缺少 saved")))?;
    if !saved {
        return Ok(None);
    }
    match value.get("path") {
        Some(Value::String(path)) if !path.is_empty() => Ok(Some(path.clone())),
        _ => Err(AppError::Config(format!("{method} 回执已保存但缺少 path"))),
    }
}

// ==========================================
// EditorPort 实现（经 HostLink 收发）
// ==========================================

/// 编辑器端口：读/写都经 Node 的既有 Profile 通路（本域不解析 Profile 文件）。
pub struct EditorPortImpl {
    link: Arc<HostLink>,
    /// `AppPaths.profiles` 的克隆（数据根唯一决定点，启动时取自 AppPaths）。
    profiles_root: PathBuf,
    /// 原生文件对话框（「换素材」与 `pick_profile_asset` 命令共用同一实现类型）。
    dialogs: Arc<dyn crate::host::FileDialogPort>,
}

impl EditorPortImpl {
    pub fn new(
        link: Arc<HostLink>,
        profiles_root: PathBuf,
        dialogs: Arc<dyn crate::host::FileDialogPort>,
    ) -> Self {
        Self {
            link,
            profiles_root,
            dialogs,
        }
    }
}

impl EditorPort for EditorPortImpl {
    fn load(&self) -> AppResult<EditorProfile> {
        let value = self
            .link
            .request("editor_load", json!({}), HOST_REQUEST_TIMEOUT)?;
        parse_editor_profile(&self.profiles_root, &value)
    }

    fn save(&self, save: &EditorSave) -> AppResult<()> {
        self.link.request(
            "editor_save",
            editor_save_payload(save),
            HOST_REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    fn pick_asset(&self) -> AppResult<Option<String>> {
        // 与 `pick_profile_asset` 命令同一实现（`NativeFileDialog`，图片过滤器）：
        // 用户取消是正常结果 `Ok(None)`，不伪装成错误；UI 未启动时对话框实现如实报错。
        self.dialogs.pick_file()
    }
}

/// `editor_save` 的线载荷（抽成自由函数：这段是与 Node 的**形状契约**，必须可被
/// 单测直接盯住 —— 曾经在这里回传绝对路径，Node 的 `stripProfilePrefix` 失配后把
/// 绝对路径写进了 `profile.yaml`）。
fn editor_save_payload(save: &EditorSave) -> Value {
    let layers: Vec<Value> = save
        .layers
        .iter()
        .map(|layer| {
            json!({
                // 线格式路径（profiles 域内相对），与 `editor_load` 的出参形状对称。
                "path": layer.wire_path,
                // 换素材选中的外部来源：Node 据此复制进 Profile（入库）后才写 yaml；
                // 素材已在 Profile 内时为 null。
                "sourcePath": layer
                    .source_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string()),
                "name": layer.name,
                "enabled": layer.enabled,
                "locked": layer.locked,
                "sensitivity": layer.sensitivity,
                "scale": layer.scale,
                "offsetXPercent": layer.offset_x_percent,
                "offsetYPercent": layer.offset_y_percent,
            })
        })
        .collect();
    json!({
        "profileId": save.profile_id,
        "layers": layers,
        "intensity": save.intensity,
        "effectEnabled": save.effect_enabled,
    })
}

fn parse_editor_profile(profiles_root: &Path, value: &Value) -> AppResult<EditorProfile> {
    let profile_id = value
        .get("profileId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("editor_load 回执缺少 profileId".into()))?
        .to_string();
    // profileName 必填：Node 的类型是全必填，回落 profileId 会把「显示名丢了」的
    // 坏回执伪装成正常的 id 显示（与 parse_profile_options 的显示名回落不同 ——
    // 那里回落是 Node 类型本身允许的可选形状）。
    let profile_name = value
        .get("profileName")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("editor_load 回执缺少 profileName".into()))?
        .to_string();
    let layers = value
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("editor_load 回执缺少 layers".into()))?;
    let mut parsed = Vec::with_capacity(layers.len());
    for (index, layer) in layers.iter().enumerate() {
        let relative = layer
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // 空 path = 该层尚无素材（Profile 允许的空占位）：保持空路径，渲染器按
        // 禁用层跳过解码；非空路径经 profiles 域内相对路径校验后拼绝对路径。
        let path = if relative.is_empty() {
            PathBuf::new()
        } else {
            join_profiles_path(profiles_root, relative)?
        };
        parsed.push(EditorLayer {
            path,
            // 线格式路径原样留底：保存回传的是它，不是拼出来的绝对路径（见字段文档）。
            wire_path: relative.to_string(),
            // 载入的素材已在 Profile 内，无需入库复制。
            source_path: None,
            // name/enabled/locked 必填（Node 的 EditorLayerPayload 全必填）：缺字段
            // 静默按空串/false 兜底会让结点把坏回执当成「无名层」「禁用层」渲染。
            // 空串本身仍是合法值（空占位层：无素材即无名、disabled），只有缺键报错。
            name: layer
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Config(format!("editor_load 回执第 {index} 层缺少 name")))?
                .to_string(),
            enabled: layer
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    AppError::Config(format!("editor_load 回执第 {index} 层缺少 enabled"))
                })?,
            locked: layer
                .get("locked")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    AppError::Config(format!("editor_load 回执第 {index} 层缺少 locked"))
                })?,
            sensitivity: required_f64(layer, "sensitivity")?,
            scale: required_f64(layer, "scale")?,
            offset_x_percent: required_f64(layer, "offsetXPercent")?,
            offset_y_percent: required_f64(layer, "offsetYPercent")?,
        });
    }
    Ok(EditorProfile {
        profile_id,
        profile_name,
        layers: parsed,
        effect_enabled: value
            .get("effectEnabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::Config("editor_load 回执缺少 effectEnabled".into()))?,
        intensity: required_f64(value, "intensity")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    fn test_link() -> (
        Arc<HostLink>,
        Arc<Mutex<Vec<(String, Value)>>>,
        Arc<AtomicBool>,
    ) {
        let link = Arc::new(HostLink::new());
        let published: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let installed = Arc::new(AtomicBool::new(false));
        let sink = published.clone();
        let flag = installed.clone();
        link.install_sender(Arc::new(move |event: &str, payload: Value| {
            flag.store(true, Ordering::SeqCst);
            sink.lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((event.to_string(), payload));
            Ok(())
        }));
        (link, published, installed)
    }

    fn last_request(published: &Arc<Mutex<Vec<(String, Value)>>>) -> (u64, String, Value) {
        // 请求可能由子线程投递（`请求结果按回执结算`）：这里**有界等待**它落进 sink。
        // 直接读会与线程调度抢跑 —— 主线程赢时 sink 还是空的，测试假红；
        // 等满期限仍为空才是真失败（没有投递这件事本身）。
        let deadline = Instant::now() + Duration::from_secs(2);
        let (event, payload) = loop {
            if let Some(entry) = published
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .last()
                .cloned()
            {
                break entry;
            }
            assert!(Instant::now() < deadline, "必须已投递一条事件");
            std::thread::yield_now();
        };
        assert_eq!(event, HOST_REQUEST_EVENT);
        (
            payload
                .get("requestId")
                .and_then(Value::as_u64)
                .expect("requestId"),
            payload
                .get("method")
                .and_then(Value::as_str)
                .expect("method")
                .to_string(),
            payload.get("args").cloned().unwrap_or(Value::Null),
        )
    }

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
    fn 设置快照解析只收三种标量() {
        let snapshot = parse_settings_snapshot(&json!({
            "values": { "appearance.chatImagePreview": false, "appearance.font.size": 17, "general.shortcut.key": "P" }
        }))
        .unwrap();
        assert_eq!(
            snapshot.values.get("appearance.chatImagePreview"),
            Some(&SettingsValue::Bool(false))
        );
        assert_eq!(
            snapshot.values.get("appearance.font.size"),
            Some(&SettingsValue::Number(17.0))
        );
        assert_eq!(
            snapshot.values.get("general.shortcut.key"),
            Some(&SettingsValue::Text("P".into()))
        );

        // 数组/对象值（客户端不该发）如实报错，不静默吞。
        assert!(
            parse_settings_snapshot(&json!({ "values": { "tools.bash.whitelist": ["ls"] } }))
                .is_err()
        );
        assert!(parse_settings_snapshot(&json!({ "nope": {} })).is_err());
    }

    #[test]
    fn 设置端口提交形状与回执透出() {
        let link = Arc::new(HostLink::new());
        let port = SettingsPortImpl::new(link);
        // 未接线：如实失败，不伪造成功。
        assert!(port.fetch().is_err());
        assert!(port
            .commit(&[SettingEdit {
                key: "appearance.font.size".into(),
                value: SettingsValue::Number(16.0),
            }])
            .is_err());
        assert!(port.cards().is_err());
    }

    #[test]
    fn profile选项解析保留id与显示名() {
        let options = parse_profile_options(&json!({
            "active": "sugar-pink",
            "profiles": [
                { "id": "sugar-pink", "name": "Sugar Pink", "description": "粉糖" },
                { "id": "plain" }
            ]
        }))
        .unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].id, "sugar-pink");
        assert_eq!(options[0].name, "Sugar Pink");
        assert_eq!(options[1].name, "plain", "缺显示名回落 id");
        assert!(parse_profile_options(&json!({ "active": null })).is_err());
        assert!(parse_profile_options(&json!({ "profiles": [{ "name": "无 id" }] })).is_err());
    }

    #[test]
    fn 管理面端口未接线时如实报错() {
        let port = SettingsPortImpl::new(Arc::new(HostLink::new()));
        assert!(port.profiles().is_err());
        assert!(port.mcp_servers().is_err());
        assert!(port.set_mcp_server_enabled("filesystem", true).is_err());
        assert!(port.skills().is_err());
        assert!(port.set_skill_enabled("demo", false).is_err());
        assert!(port.tool_policies().is_err());
        assert!(port.memory_overview(None, None).is_err());
        assert!(port.memory_item_detail("m1").is_err());
        assert!(port
            .memory_change(&MemoryChange {
                action: crate::ui::settings::panels::MemoryChangeAction::Forget,
                item_id: "m1".into(),
                expected_version: 1,
                base_revision: 1,
                content: None,
                pinned: None,
            })
            .is_err());
    }

    #[test]
    fn 记忆总览解析保留状态行与两类行() {
        let overview = parse_memory_overview(&json!({
            "revision": 7,
            "statusText": "库版本 revision 7 · 3 条当前记忆 · 2 个整理作业",
            "items": [
                { "id": "m1", "title": "喜欢猫", "subtitle": "fact · user · v2", "action": "select", "enabled": true }
            ],
            "jobs": [
                { "id": "j1", "title": "review · completed", "subtitle": "作业 j1" }
            ]
        }))
        .unwrap();
        assert_eq!(overview.revision, 7);
        assert!(overview.status_text.contains("revision 7"));
        assert_eq!(overview.items.len(), 1);
        assert_eq!(
            overview.items[0].action,
            crate::ui::settings::panels::RowAction::Select
        );
        assert_eq!(overview.jobs.len(), 1);
        assert_eq!(
            overview.jobs[0].action,
            crate::ui::settings::panels::RowAction::None
        );

        // 缺 revision / statusText：协议违规，如实报错（不补默认值）。
        assert!(parse_memory_overview(&json!({ "statusText": "x" })).is_err());
        assert!(parse_memory_overview(&json!({ "revision": 1 })).is_err());
        // 缺 items/jobs 按空数组（读取时机差异，不是协议违规）。
        let sparse = parse_memory_overview(&json!({ "revision": 1, "statusText": "x" })).unwrap();
        assert!(sparse.items.is_empty() && sparse.jobs.is_empty());
    }

    #[test]
    fn 记忆详情解析包含版本与历史行() {
        let detail = parse_memory_detail(&json!({
            "revision": 9,
            "itemId": "m1",
            "version": 3,
            "pinned": true,
            "info": "类型：fact",
            "content": "喜欢猫",
            "history": [
                { "id": "m1:1", "title": "v1 · superseded", "subtitle": "旧内容" }
            ]
        }))
        .unwrap();
        assert_eq!(detail.item_id, "m1");
        assert_eq!(detail.revision, 9);
        assert_eq!(detail.version, 3);
        assert!(detail.pinned);
        assert_eq!(detail.history.len(), 1);
        assert_eq!(detail.history[0].id, "m1:1");

        // 缺 itemId/version：协议违规如实报错。
        assert!(parse_memory_detail(&json!({ "revision": 1, "version": 1 })).is_err());
        assert!(parse_memory_detail(&json!({ "revision": 1, "itemId": "m1" })).is_err());

        // 缺 pinned/info/content：协议违规，如实报错并点名字段（不按 false/空串兜底）。
        let full = json!({
            "revision": 9,
            "itemId": "m1",
            "version": 3,
            "pinned": true,
            "info": "类型：fact",
            "content": "喜欢猫",
        });
        for missing in ["pinned", "info", "content"] {
            let mut broken = full.clone();
            broken.as_object_mut().unwrap().remove(missing);
            let error = parse_memory_detail(&broken).unwrap_err();
            assert_missing_field(error, missing);
        }
    }

    #[test]
    fn 记忆变更载荷带可选字段且回执解析新版() {
        let (link, published, _) = test_link();
        let port = SettingsPortImpl::new(link.clone());
        let waiting = std::thread::spawn(move || {
            port.memory_change(&MemoryChange {
                action: crate::ui::settings::panels::MemoryChangeAction::Update,
                item_id: "m1".into(),
                expected_version: 2,
                base_revision: 5,
                content: Some("新内容".into()),
                pinned: Some(false),
            })
        });
        let (request_id, method, args) = wait_last_request(&published);
        assert_eq!(method, "memory_item_change");
        assert_eq!(args["action"], json!("update"));
        assert_eq!(args["itemId"], json!("m1"));
        assert_eq!(args["expectedVersion"], json!(2));
        assert_eq!(args["baseRevision"], json!(5));
        assert_eq!(args["content"], json!("新内容"));
        assert_eq!(args["pinned"], json!(false));
        assert!(link.complete(request_id, Ok(json!({ "revision": 11 }))));
        assert_eq!(waiting.join().unwrap().unwrap(), 11);

        // 缺 revision 的回执按协议违规报错，不返回假版本号。
        let (link, published, _) = test_link();
        let port = SettingsPortImpl::new(link.clone());
        let waiting = std::thread::spawn(move || {
            port.memory_change(&MemoryChange {
                action: crate::ui::settings::panels::MemoryChangeAction::Forget,
                item_id: "m1".into(),
                expected_version: 1,
                base_revision: 1,
                content: None,
                pinned: None,
            })
        });
        let (request_id, _, args) = wait_last_request(&published);
        assert_eq!(args["action"], json!("forget"));
        assert!(args.get("content").is_none(), "Forget 不带 content");
        assert!(link.complete(request_id, Ok(json!({}))));
        assert!(waiting.join().unwrap().is_err());
    }

    /// 等请求投递（并发下 `last_request` 可能先于工作线程执行）。
    fn wait_last_request(published: &Arc<Mutex<Vec<(String, Value)>>>) -> (u64, String, Value) {
        for _ in 0..500 {
            {
                let list = published.lock().unwrap_or_else(|e| e.into_inner());
                if let Some((event, payload)) = list.last().cloned() {
                    assert_eq!(event, HOST_REQUEST_EVENT);
                    return (
                        payload
                            .get("requestId")
                            .and_then(Value::as_u64)
                            .expect("requestId"),
                        payload
                            .get("method")
                            .and_then(Value::as_str)
                            .expect("method")
                            .to_string(),
                        payload.get("args").cloned().unwrap_or(Value::Null),
                    );
                }
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("等待宿主请求投递超时");
    }

    /// 文件对话框替身：`pick_file` 返回注入值（`None` = 用户取消）。
    struct StubDialogs(Option<&'static str>);

    impl crate::host::FileDialogPort for StubDialogs {
        fn pick_images(&self) -> AppResult<Vec<String>> {
            Err(AppError::Other("测试替身未实现 pick_images".into()))
        }

        fn pick_file(&self) -> AppResult<Option<String>> {
            Ok(self.0.map(ToString::to_string))
        }

        fn save_file(
            &self,
            _suggested_name: &str,
            _filter_label: &str,
            _extension: &str,
        ) -> AppResult<Option<String>> {
            Err(AppError::Other("测试替身未实现 save_file".into()))
        }
    }

    #[test]
    fn 编辑器端口载荷走域内相对路径() {
        let link = Arc::new(HostLink::new());
        let port = EditorPortImpl::new(
            link,
            test_profiles_root(),
            Arc::new(StubDialogs(Some("/tmp/asset.png"))),
        );
        // 按**生产形状**构造：`path` 是拼出来的绝对路径、`wire_path` 才是线格式。
        // （旧版本这里把 `path` 直接填成相对路径，于是"载荷走相对路径"的断言恒真，
        // 而生产上回传的是绝对路径 —— 测试绿、yaml 被写坏。）
        let input = crate::ui::editor::EditorLayer {
            path: test_profiles_root().join("sugar-pink/materials/L2/body.png"),
            wire_path: "sugar-pink/materials/L2/body.png".into(),
            source_path: None,
            name: "body.png".into(),
            enabled: true,
            locked: false,
            sensitivity: 0.8,
            scale: 1.0,
            offset_x_percent: 2.0,
            offset_y_percent: -3.0,
        };
        // 回归断言：载荷必须回传线格式路径，绝不回传绝对路径。
        let payload = editor_save_payload(&EditorSave {
            profile_id: "sugar-pink".into(),
            layers: vec![input.clone()],
            intensity: 1.2,
            effect_enabled: true,
        });
        let wire = payload["layers"][0]["path"].as_str().unwrap_or_default();
        assert_eq!(wire, "sugar-pink/materials/L2/body.png");
        assert_eq!(payload["layers"][0]["sourcePath"], Value::Null);
        assert!(
            !Path::new(wire).is_absolute(),
            "载荷 path 必须是 profiles 域内相对路径，不能是绝对路径"
        );
        // 未接线：请求如实失败。
        assert!(port
            .save(&EditorSave {
                profile_id: "sugar-pink".into(),
                layers: vec![input],
                intensity: 1.2,
                effect_enabled: true,
            })
            .is_err());
        // 换素材已接线到文件对话框：选中即透传绝对路径；取消是 Ok(None)，不是错误。
        assert_eq!(
            port.pick_asset().unwrap().as_deref(),
            Some("/tmp/asset.png")
        );
        let cancel = EditorPortImpl::new(
            Arc::new(HostLink::new()),
            test_profiles_root(),
            Arc::new(StubDialogs(None)),
        );
        assert_eq!(cancel.pick_asset().unwrap(), None);
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

    #[test]
    fn 编辑器载入解析拼出绝对层路径() {
        let profiles_root = test_profiles_root();
        let value = json!({
            "profileId": "sugar-pink",
            "profileName": "Sugar Pink",
            "layers": [{
                "path": "sugar-pink/materials/L2/body.png",
                "name": "body.png",
                "enabled": true,
                "locked": false,
                "sensitivity": 0.8,
                "scale": 1.0,
                "offsetXPercent": 0.0,
                "offsetYPercent": 0.0
            }, {
                "path": "",
                "name": "",
                "enabled": false,
                "locked": false,
                "sensitivity": 1.2,
                "scale": 1.0,
                "offsetXPercent": 0.0,
                "offsetYPercent": 0.0
            }],
            "effectEnabled": false,
            "intensity": 0.5
        });
        let profile = parse_editor_profile(&profiles_root, &value).unwrap();
        assert_eq!(profile.profile_id, "sugar-pink");
        assert!(profile.layers[0]
            .path
            .ends_with("profiles/sugar-pink/materials/L2/body.png"));
        assert!(
            profile.layers[1].path.as_os_str().is_empty(),
            "空路径层保持空，交给禁用跳过"
        );
        assert!(!profile.effect_enabled);
        assert_eq!(profile.intensity, 0.5);

        // profileName / 图层 name/enabled/locked 缺键：协议违规，点名报错，不兜底成
        // id / 空串 / false（空串层名是合法事实，缺键不是）。
        let mut broken = value.clone();
        broken.as_object_mut().unwrap().remove("profileName");
        let error = parse_editor_profile(&profiles_root, &broken).unwrap_err();
        assert_missing_field(error, "profileName");
        for missing in ["name", "enabled", "locked"] {
            let mut broken = value.clone();
            broken["layers"][0].as_object_mut().unwrap().remove(missing);
            let error = parse_editor_profile(&profiles_root, &broken).unwrap_err();
            assert_missing_field(error, missing);
        }
    }

    // ── 本批管理面（27 条 HostRequestMap 方法）的请求形状与回执解析 ──
    //
    // 方法名 + args 字段是宿主与 Node 两侧共用的线格式（TS `HostRequestMap`）：
    // 名字或字段写错不会报编译错，只会静默失联。因此每条的断言都把方法名与
    // args 全形状逐字钉死；回执侧对缺字段/类型不符如实报错（不静默兜底），
    // 远端错误保真透出（不吞、不伪造成功）。

    /// 调一次端口方法并结算回执：等请求投递 → `check_args` 断言线格式 → 结算
    /// `reply` → 返回调用结果（测试线程与端口调用线程分离，与既有用例同构）。
    ///
    /// 每次调用前清空记录：`last_request` 等的是「投递一条事件」，多次调用共用
    /// 一个 sink 时，若不清空会读到上一次的请求（假绿）。上一条请求在本函数返回
    /// 前已经投递并结算完毕，不会有迟到的旧事件。
    fn call_port<T: Send + 'static>(
        link: &Arc<HostLink>,
        published: &Arc<Mutex<Vec<(String, Value)>>>,
        expect_method: &str,
        call: impl FnOnce(Arc<HostLink>) -> AppResult<T> + Send + 'static,
        check_args: impl FnOnce(&Value),
        reply: AppResult<Value>,
    ) -> AppResult<T> {
        published
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        let thread_link = link.clone();
        let handle = std::thread::spawn(move || call(thread_link));
        let (request_id, method, args) = last_request(published);
        assert_eq!(
            method, expect_method,
            "请求方法名是两侧共用的线格式，逐字钉死"
        );
        check_args(&args);
        assert!(link.complete(request_id, reply), "回执必须结算到在途请求");
        handle.join().expect("端口调用线程不得 panic")
    }

    /// 断言回执解析失败是「协议违规 + 点名缺失字段」，而不只是「报了某个错」：
    /// 错误码必须归 CONFIG，文案必须含字段名 —— 否则用户看到错误也不知道是
    /// 哪一侧发了坏回执。
    fn assert_missing_field(error: AppError, field: &str) {
        assert_eq!(error.code(), "CONFIG", "缺字段是协议违规，必须归 CONFIG");
        assert!(
            error.to_string().contains(field),
            "错误文案要点名缺失字段 {field}，实际: {error}"
        );
    }

    #[test]
    fn 通用页端口请求形状与回执解析() {
        let (link, published, _) = test_link();

        // settings_defaults：与 settings_read 同形（`{ values }`）。
        let snapshot = call_port(
            &link,
            &published,
            "settings_defaults",
            |link| SettingsPortImpl::new(link).defaults(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "values": { "appearance.chatImagePreview": true, "general.popup.chatWidth": 320 } })),
        )
        .unwrap();
        assert_eq!(
            snapshot.values.get("appearance.chatImagePreview"),
            Some(&SettingsValue::Bool(true))
        );
        assert_eq!(
            snapshot.values.get("general.popup.chatWidth"),
            Some(&SettingsValue::Number(320.0))
        );
        // 缺 values：协议违规如实报错，不返回空快照冒充「默认值全空」。
        assert!(call_port(
            &link,
            &published,
            "settings_defaults",
            |link| SettingsPortImpl::new(link).defaults(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .is_err());

        // config_export：saved=false 是用户取消（Ok(None)），不是失败。
        let saved = call_port(
            &link,
            &published,
            "config_export",
            |link| SettingsPortImpl::new(link).export_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": true, "path": "/tmp/config-export.yaml" })),
        )
        .unwrap();
        assert_eq!(saved.as_deref(), Some("/tmp/config-export.yaml"));
        let canceled = call_port(
            &link,
            &published,
            "config_export",
            |link| SettingsPortImpl::new(link).export_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": false, "path": Value::Null })),
        )
        .unwrap();
        assert_eq!(canceled, None);
        // saved=true 但缺 path：协议违规，不返回假路径。
        assert!(call_port(
            &link,
            &published,
            "config_export",
            |link| SettingsPortImpl::new(link).export_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": true })),
        )
        .is_err());
        // 缺 saved：协议违规，不当取消也不当失败吞掉。
        assert!(call_port(
            &link,
            &published,
            "config_export",
            |link| SettingsPortImpl::new(link).export_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .is_err());

        // config_import：imported 必填布尔，类型不符如实报错。
        let imported = call_port(
            &link,
            &published,
            "config_import",
            |link| SettingsPortImpl::new(link).import_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": true })),
        )
        .unwrap();
        assert!(imported);
        assert!(call_port(
            &link,
            &published,
            "config_import",
            |link| SettingsPortImpl::new(link).import_config(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": "yes" })),
        )
        .is_err());

        // proactive_control：None = 只读查询（enabled 发 null）；Some = 切换。
        let snapshot = call_port(
            &link,
            &published,
            "proactive_control",
            |link| SettingsPortImpl::new(link).proactive_control(None),
            |args| assert_eq!(args, &json!({ "enabled": Value::Null })),
            Ok(json!({ "enabled": true, "revision": 7 })),
        )
        .unwrap();
        assert!(snapshot.enabled);
        assert_eq!(snapshot.revision, 7);
        let snapshot = call_port(
            &link,
            &published,
            "proactive_control",
            |link| SettingsPortImpl::new(link).proactive_control(Some(false)),
            |args| assert_eq!(args, &json!({ "enabled": false })),
            Ok(json!({ "enabled": false, "revision": 8 })),
        )
        .unwrap();
        assert!(!snapshot.enabled);
        assert_eq!(snapshot.revision, 8);
        // 缺 enabled：协议违规，不按 false 冒充「已关闭」。
        let error = call_port(
            &link,
            &published,
            "proactive_control",
            |link| SettingsPortImpl::new(link).proactive_control(None),
            |args| assert_eq!(args, &json!({ "enabled": Value::Null })),
            Ok(json!({ "revision": 1 })),
        )
        .unwrap_err();
        assert_missing_field(error, "enabled");
        // 缺 revision：与兄弟方法 memory_item_change 同口径报错，不静默按 0 兜底
        // （假 revision 会让后续变更带着错误版本去提交）。
        let error = call_port(
            &link,
            &published,
            "proactive_control",
            |link| SettingsPortImpl::new(link).proactive_control(None),
            |args| assert_eq!(args, &json!({ "enabled": Value::Null })),
            Ok(json!({ "enabled": true })),
        )
        .unwrap_err();
        assert_missing_field(error, "revision");
    }

    #[test]
    fn ai页文本与阶段文案端口请求形状() {
        let (link, published, _) = test_link();

        // v1rtual_read：content 必填；缺字段如实报错，不返回空指令。
        let content = call_port(
            &link,
            &published,
            "v1rtual_read",
            |link| SettingsPortImpl::new(link).v1rtual_read(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "content": "始终用中文回答" })),
        )
        .unwrap();
        assert_eq!(content, "始终用中文回答");
        assert!(call_port(
            &link,
            &published,
            "v1rtual_read",
            |link| SettingsPortImpl::new(link).v1rtual_read(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .is_err());

        // v1rtual_write：全量文本回传。
        call_port(
            &link,
            &published,
            "v1rtual_write",
            |link| SettingsPortImpl::new(link).v1rtual_write("新的用户指令"),
            |args| assert_eq!(args, &json!({ "content": "新的用户指令" })),
            Ok(Value::Null),
        )
        .unwrap();

        // card_stages_read：cardId 缺省发 null；回执 cardId/text 必填。
        let stages = call_port(
            &link,
            &published,
            "card_stages_read",
            |link| SettingsPortImpl::new(link).card_stages_read(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": "yuki", "fallback": true, "text": "executing.thinking: 思考中…" })),
        )
        .unwrap();
        assert_eq!(stages.card_id, "yuki");
        assert!(stages.fallback);
        assert_eq!(stages.text, "executing.thinking: 思考中…");
        let stages = call_port(
            &link,
            &published,
            "card_stages_read",
            |link| SettingsPortImpl::new(link).card_stages_read(Some("angelkawaii")),
            |args| assert_eq!(args, &json!({ "cardId": "angelkawaii" })),
            Ok(json!({ "cardId": "angelkawaii", "fallback": false, "text": "x" })),
        )
        .unwrap();
        assert_eq!(stages.card_id, "angelkawaii");
        // 缺 text：协议违规，不返回空文案冒充成功。
        assert!(call_port(
            &link,
            &published,
            "card_stages_read",
            |link| SettingsPortImpl::new(link).card_stages_read(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": "yuki", "fallback": true })),
        )
        .is_err());
        // 缺 fallback：协议违规，不按 false 把兜底文案冒充成 Card 文案。
        let error = call_port(
            &link,
            &published,
            "card_stages_read",
            |link| SettingsPortImpl::new(link).card_stages_read(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": "yuki", "text": "x" })),
        )
        .unwrap_err();
        assert_missing_field(error, "fallback");

        // card_stages_write：cardId + text；缺省卡发 null。
        call_port(
            &link,
            &published,
            "card_stages_write",
            |link| SettingsPortImpl::new(link).card_stages_write(Some("yuki"), "执行中: 思考中…"),
            |args| {
                assert_eq!(
                    args,
                    &json!({ "cardId": "yuki", "text": "执行中: 思考中…" })
                )
            },
            Ok(Value::Null),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "card_stages_write",
            |link| SettingsPortImpl::new(link).card_stages_write(None, "x"),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null, "text": "x" })),
            Ok(Value::Null),
        )
        .unwrap();

        // card_stages_regenerate：与读取同参；回执按同一解析。
        let regenerated = call_port(
            &link,
            &published,
            "card_stages_regenerate",
            |link| SettingsPortImpl::new(link).card_stages_regenerate(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": "yuki", "fallback": false, "text": "新生成的文案" })),
        )
        .unwrap();
        assert_eq!(regenerated.text, "新生成的文案");
        assert!(!regenerated.fallback);
    }

    #[test]
    fn 变量池与记忆总览范围参数形状() {
        let (link, published, _) = test_link();

        // card_variable_pool：cardId 缺省发 null；回执 cardId 可空、text 必填。
        let pool = call_port(
            &link,
            &published,
            "card_variable_pool",
            |link| SettingsPortImpl::new(link).card_variable_pool(None),
            |args| assert_eq!(args, &json!({ "cardId": Value::Null })),
            Ok(json!({ "cardId": Value::Null, "text": "mood: 开心\nenergy: 0.8" })),
        )
        .unwrap();
        assert_eq!(pool.card_id, None);
        assert!(pool.text.contains("mood: 开心"));
        let pool = call_port(
            &link,
            &published,
            "card_variable_pool",
            |link| SettingsPortImpl::new(link).card_variable_pool(Some("yuki")),
            |args| assert_eq!(args, &json!({ "cardId": "yuki" })),
            Ok(json!({ "cardId": "yuki", "text": "x" })),
        )
        .unwrap();
        assert_eq!(pool.card_id.as_deref(), Some("yuki"));
        // 缺 text：协议违规，不返回空预览。
        assert!(call_port(
            &link,
            &published,
            "card_variable_pool",
            |link| SettingsPortImpl::new(link).card_variable_pool(Some("yuki")),
            |args| assert_eq!(args, &json!({ "cardId": "yuki" })),
            Ok(json!({ "cardId": "yuki" })),
        )
        .is_err());

        // memory_overview 的 scope 透传：两键都传 / 只传 scope / 都不传（空对象）。
        let overview = call_port(
            &link,
            &published,
            "memory_overview",
            |link| SettingsPortImpl::new(link).memory_overview(Some("card"), Some("card-1")),
            |args| assert_eq!(args, &json!({ "scope": "card", "scopeId": "card-1" })),
            Ok(json!({ "revision": 3, "statusText": "库版本 revision 3" })),
        )
        .unwrap();
        assert_eq!(overview.revision, 3);
        call_port(
            &link,
            &published,
            "memory_overview",
            |link| SettingsPortImpl::new(link).memory_overview(Some("user"), None),
            |args| {
                assert_eq!(args.get("scope").and_then(Value::as_str), Some("user"));
                assert!(args.get("scopeId").is_none(), "scope_id 缺省时不发键");
            },
            Ok(json!({ "revision": 1, "statusText": "x" })),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "memory_overview",
            |link| SettingsPortImpl::new(link).memory_overview(None, None),
            |args| assert_eq!(args, &json!({}), "不筛选时发空参数对象"),
            Ok(json!({ "revision": 1, "statusText": "x" })),
        )
        .unwrap();
    }

    #[test]
    fn profile管理动作逐条线格式() {
        let (link, published, _) = test_link();
        let outcome_reply = json!({
            "message": "已新建 新 Profile 1",
            "newId": "profile1",
            "list": {
                "active": "sugar-pink",
                "profiles": [{ "id": "sugar-pink", "name": "Sugar Pink", "description": "粉糖" }]
            }
        });

        // 新建：不带 profileId；回执的 newId 进 Outcome（宿主据此预选中新项）。
        let outcome = call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Create),
            |args| {
                assert_eq!(args, &json!({ "op": "create" }));
                assert!(args.get("profileId").is_none(), "create 不带 profileId");
            },
            Ok(outcome_reply.clone()),
        )
        .unwrap();
        assert_eq!(outcome.message, "已新建 新 Profile 1");
        assert_eq!(outcome.profiles.len(), 1);
        assert_eq!(outcome.profiles[0].id, "sugar-pink");
        assert_eq!(outcome.new_id.as_deref(), Some("profile1"));

        // 重命名：id + 名字逐字上线。
        let renamed = call_port(
            &link,
            &published,
            "profile_manage",
            |link| {
                SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Rename {
                    profile_id: "sugar-pink".into(),
                    name: "小雨".into(),
                })
            },
            |args| {
                assert_eq!(
                    args,
                    &json!({ "op": "rename", "profileId": "sugar-pink", "name": "小雨" })
                )
            },
            Ok(json!({
                "message": "已重命名为 小雨",
                "list": { "active": "sugar-pink", "profiles": [] }
            })),
        )
        .unwrap();
        assert_eq!(renamed.message, "已重命名为 小雨");
        // 非新建回执没有 newId：解析为 None，不冒充「新建了某一项」。
        assert_eq!(renamed.new_id, None);

        call_port(
            &link,
            &published,
            "profile_manage",
            |link| {
                SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Delete("other".into()))
            },
            |args| assert_eq!(args, &json!({ "op": "delete", "profileId": "other" })),
            Ok(outcome_reply.clone()),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "profile_manage",
            |link| {
                SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Export("other".into()))
            },
            |args| assert_eq!(args, &json!({ "op": "export", "profileId": "other" })),
            Ok(outcome_reply.clone()),
        )
        .unwrap();
        // export 的文件对话框等待上限在 USER_INTERACTION_TIMEOUT（形状之外的行为，
        // 这里只能钉形状；上限本身由常量消费点保证）。
        call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::Import),
            |args| {
                assert_eq!(args, &json!({ "op": "import" }));
                assert!(args.get("profileId").is_none(), "import 不带 profileId");
            },
            Ok(outcome_reply.clone()),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link).profile_manage(&ProfileManageOp::RestoreDefaults),
            |args| {
                assert_eq!(args, &json!({ "op": "restore_defaults" }));
                assert!(
                    args.get("profileId").is_none(),
                    "restore_defaults 不带 profileId"
                );
            },
            Ok(outcome_reply.clone()),
        )
        .unwrap();

        // 缺 list.profiles：协议违规，不返回空列表冒充「没有 Profile」。
        assert!(call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link)
                .profile_manage(&ProfileManageOp::Delete("other".into())),
            |args| assert_eq!(args, &json!({ "op": "delete", "profileId": "other" })),
            Ok(json!({ "message": "已删除" })),
        )
        .is_err());
        // 缺 message：协议违规。
        assert!(call_port(
            &link,
            &published,
            "profile_manage",
            |link| SettingsPortImpl::new(link)
                .profile_manage(&ProfileManageOp::Delete("other".into())),
            |args| assert_eq!(args, &json!({ "op": "delete", "profileId": "other" })),
            Ok(json!({ "list": { "active": Value::Null, "profiles": [] } })),
        )
        .is_err());
    }

    #[test]
    fn 音效端口请求形状() {
        let (link, published, _) = test_link();

        // sound_library：rows 承载逐事件下拉（选项 + 选中值）；rows 缺省 = 无事件行。
        let library = call_port(
            &link,
            &published,
            "sound_library",
            |link| SettingsPortImpl::new(link).sound_library(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({
                "rows": [{
                    "id": "welcome",
                    "title": "欢迎",
                    "action": "pick",
                    "action2": "preview",
                    "pick": {
                        "options": [
                            { "value": "none", "label": "静音" },
                            { "value": "chime", "label": "铃声" }
                        ],
                        "selected": "chime"
                    }
                }]
            })),
        )
        .unwrap();
        assert_eq!(library.rows.len(), 1);
        assert_eq!(
            library.rows[0].action,
            crate::ui::settings::panels::RowAction::Pick
        );
        assert_eq!(
            library.rows[0].secondary,
            crate::ui::settings::panels::RowAction::Preview
        );
        assert_eq!(library.rows[0].pick.as_ref().unwrap().selected, "chime");
        let bare = call_port(
            &link,
            &published,
            "sound_library",
            |link| SettingsPortImpl::new(link).sound_library(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .unwrap();
        assert!(bare.rows.is_empty());
        // pick 动作缺 pick 载荷：协议违规（画不出可点的下拉）。
        assert!(call_port(
            &link,
            &published,
            "sound_library",
            |link| SettingsPortImpl::new(link).sound_library(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "rows": [{ "id": "welcome", "title": "欢迎", "action": "pick" }] })),
        )
        .is_err());

        // sound_set_assignment / sound_reset / sound_preview：单事件写回、恢复默认、单条试听。
        call_port(
            &link,
            &published,
            "sound_set_assignment",
            |link| SettingsPortImpl::new(link).sound_set_assignment("welcome", "none"),
            |args| assert_eq!(args, &json!({ "event": "welcome", "soundId": "none" })),
            Ok(Value::Null),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "sound_reset",
            |link| SettingsPortImpl::new(link).sound_reset(),
            |args| assert_eq!(args, &json!({})),
            Ok(Value::Null),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "sound_preview",
            |link| SettingsPortImpl::new(link).sound_preview("chime"),
            |args| assert_eq!(args, &json!({ "soundId": "chime" })),
            Ok(Value::Null),
        )
        .unwrap();
    }

    #[test]
    fn mcp编辑与测试端口请求形状() {
        let (link, published, _) = test_link();

        // mcp_server_doc：name 缺省发 null（新建模板）；回执取 text。
        let doc = call_port(
            &link,
            &published,
            "mcp_server_doc",
            |link| SettingsPortImpl::new(link).mcp_server_doc(None),
            |args| assert_eq!(args, &json!({ "name": Value::Null })),
            Ok(json!({ "text": "## name\n新服务器" })),
        )
        .unwrap();
        assert_eq!(doc.text, "## name\n新服务器");
        let doc = call_port(
            &link,
            &published,
            "mcp_server_doc",
            |link| SettingsPortImpl::new(link).mcp_server_doc(Some("filesystem")),
            |args| assert_eq!(args, &json!({ "name": "filesystem" })),
            Ok(json!({ "text": "## name\nfilesystem" })),
        )
        .unwrap();
        assert_eq!(doc.text, "## name\nfilesystem");
        // 缺 text：协议违规，不返回空文档冒充成功。
        let error = call_port(
            &link,
            &published,
            "mcp_server_doc",
            |link| SettingsPortImpl::new(link).mcp_server_doc(Some("filesystem")),
            |args| assert_eq!(args, &json!({ "name": "filesystem" })),
            Ok(json!({})),
        )
        .unwrap_err();
        assert_missing_field(error, "text");

        // mcp_edit：文本保存与删除共用一条方法，op 区分。
        call_port(
            &link,
            &published,
            "mcp_edit",
            |link| SettingsPortImpl::new(link).mcp_edit_text("## name\nfs"),
            |args| assert_eq!(args, &json!({ "op": "text", "text": "## name\nfs" })),
            Ok(Value::Null),
        )
        .unwrap();
        call_port(
            &link,
            &published,
            "mcp_edit",
            |link| SettingsPortImpl::new(link).mcp_delete("web"),
            |args| assert_eq!(args, &json!({ "op": "delete", "name": "web" })),
            Ok(Value::Null),
        )
        .unwrap();

        // mcp_test：连接失败是结果不是异常；缺 message / 缺 ok 都是协议违规，如实报错。
        let (ok, message) = call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("filesystem"),
            |args| assert_eq!(args, &json!({ "name": "filesystem" })),
            Ok(json!({ "ok": true, "message": "连接成功，发现 3 个工具" })),
        )
        .unwrap();
        assert!(ok);
        assert_eq!(message, "连接成功，发现 3 个工具");
        let (failed, message) = call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(json!({ "ok": false, "message": "服务器处于关闭状态：启用后再测试" })),
        )
        .unwrap();
        assert!(!failed);
        assert!(message.contains("关闭状态"));
        let (ok, _) = call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(json!({ "ok": false, "message": "连接失败（原因未提供）" })),
        )
        .unwrap();
        assert!(!ok, "连接失败是结果，不谎报连接成功");
        // 缺 ok：协议违规（Node 的结果类型是 `{ ok, message }` 全必填），如实报错，
        // 不静默按「未成功」收场 —— 那会把坏回执吞成正常的失败结论。
        let error = call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(json!({ "message": "连接失败（原因未提供）" })),
        )
        .unwrap_err();
        assert_missing_field(error, "ok");
        assert!(call_port(
            &link,
            &published,
            "mcp_test",
            |link| SettingsPortImpl::new(link).mcp_test("web"),
            |args| assert_eq!(args, &json!({ "name": "web" })),
            Ok(json!({ "ok": true })),
        )
        .is_err());
    }

    #[test]
    fn mcp导入导出与skill端口回执() {
        let (link, published, _) = test_link();

        // mcp_import：导入条数与取消分开报。
        let (count, canceled) = call_port(
            &link,
            &published,
            "mcp_import",
            |link| SettingsPortImpl::new(link).mcp_import(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": 3, "canceled": false })),
        )
        .unwrap();
        assert_eq!(count, 3);
        assert!(!canceled);
        let (count, canceled) = call_port(
            &link,
            &published,
            "mcp_import",
            |link| SettingsPortImpl::new(link).mcp_import(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": 0, "canceled": true })),
        )
        .unwrap();
        assert_eq!(count, 0);
        assert!(canceled, "取消必须与「导入 0 条」分开呈现");
        // 缺 imported：协议违规，不按 0 冒充「导入 0 条」。
        let error = call_port(
            &link,
            &published,
            "mcp_import",
            |link| SettingsPortImpl::new(link).mcp_import(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "canceled": false })),
        )
        .unwrap_err();
        assert_missing_field(error, "imported");
        // 缺 canceled：协议违规，不按 false 把取消吞成成功。
        let error = call_port(
            &link,
            &published,
            "mcp_import",
            |link| SettingsPortImpl::new(link).mcp_import(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "imported": 3 })),
        )
        .unwrap_err();
        assert_missing_field(error, "canceled");

        // mcp_export：saved/path 与 config_export 同一纪律。
        let path = call_port(
            &link,
            &published,
            "mcp_export",
            |link| SettingsPortImpl::new(link).mcp_export(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": true, "path": "/tmp/mcp-servers.json" })),
        )
        .unwrap();
        assert_eq!(path.as_deref(), Some("/tmp/mcp-servers.json"));
        let canceled = call_port(
            &link,
            &published,
            "mcp_export",
            |link| SettingsPortImpl::new(link).mcp_export(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": false, "path": Value::Null })),
        )
        .unwrap();
        assert_eq!(canceled, None);
        assert!(call_port(
            &link,
            &published,
            "mcp_export",
            |link| SettingsPortImpl::new(link).mcp_export(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "saved": true })),
        )
        .is_err());

        // skill_upload：非空 name = 成功；null = 取消；空串/非字符串 = 协议违规。
        let name = call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "name": "demo-skill" })),
        )
        .unwrap();
        assert_eq!(name.as_deref(), Some("demo-skill"));
        let canceled = call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "name": Value::Null })),
        )
        .unwrap();
        assert_eq!(canceled, None);
        assert!(call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "name": "" })),
        )
        .is_err());
        assert!(call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "name": 42 })),
        )
        .is_err());
        // 缺 name 键：协议违规，不当作「用户取消」静默收场（取消必发显式 null）。
        let error = call_port(
            &link,
            &published,
            "skill_upload",
            |link| SettingsPortImpl::new(link).skill_upload(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({})),
        )
        .unwrap_err();
        assert_missing_field(error, "name");

        // skill_delete：域内相对路径原样回传。
        call_port(
            &link,
            &published,
            "skill_delete",
            |link| SettingsPortImpl::new(link).skill_delete("demo/SKILL.md"),
            |args| assert_eq!(args, &json!({ "id": "demo/SKILL.md" })),
            Ok(Value::Null),
        )
        .unwrap();
    }

    #[test]
    fn 记忆维护与来源回看端口请求形状() {
        let (link, published, _) = test_link();

        // memory_source_evidence：sourceId 必填；info 必填，evidence/original 组装成展示文本。
        let text = call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({
                "sourceId": "s-1",
                "available": true,
                "info": "来源：user/trusted_user　资格：可记忆",
                "evidence": "登记时的有界证据",
                "original": "会话里的完整原话"
            })),
        )
        .unwrap();
        assert!(text.contains("【来源 s-1】"));
        assert!(text.contains("登记时的有界证据"));
        assert!(text.contains("会话里的完整原话"));
        // original=null：如实标注「原话已不可用」，不拿证据冒充原话。
        let text = call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "info": "i", "evidence": "", "original": Value::Null })),
        )
        .unwrap();
        assert!(text.contains("（空）"), "空证据如实标注");
        assert!(text.contains("原话已不可用"), "原话缺失如实标注");
        // 缺 info：协议违规。
        assert!(call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "evidence": "e" })),
        )
        .is_err());
        // 缺 evidence：协议违规；空串是显式事实（界面显示「（空）」），缺字段不是。
        let error = call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "info": "i", "original": "原话" })),
        )
        .unwrap_err();
        assert_missing_field(error, "evidence");
        // 缺 original 键：协议违规（显式 null 才是「确实没有原话」这一事实），如实
        // 报错并点名字段 —— 旧实现把缺键与 null 混同成「原话已不可用」。
        let error = call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "info": "i", "evidence": "e" })),
        )
        .unwrap_err();
        assert_missing_field(error, "original");
        // original 形状非法（非 string/null）：同样报错，不静默当作不可用。
        assert!(call_port(
            &link,
            &published,
            "memory_source_evidence",
            |link| SettingsPortImpl::new(link).memory_source_evidence("s-1"),
            |args| assert_eq!(args, &json!({ "sourceId": "s-1" })),
            Ok(json!({ "info": "i", "evidence": "e", "original": 42 })),
        )
        .is_err());

        // memory_dreaming_sweep：手动整理入口；message 必填。
        let message = call_port(
            &link,
            &published,
            "memory_dreaming_sweep",
            |link| SettingsPortImpl::new(link).memory_dreaming_sweep(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "message": "整理完成：提交 2 条" })),
        )
        .unwrap();
        assert_eq!(message, "整理完成：提交 2 条");
        assert!(call_port(
            &link,
            &published,
            "memory_dreaming_sweep",
            |link| SettingsPortImpl::new(link).memory_dreaming_sweep(),
            |args| assert_eq!(args, &json!({})),
            Ok(json!({ "path": Value::Null })),
        )
        .is_err());

        // memory_maintenance：三个 op 的线格式逐字钉死；message 必填。
        let message = call_port(
            &link,
            &published,
            "memory_maintenance",
            |link| SettingsPortImpl::new(link).memory_maintenance(MemoryMaintenanceOp::Backup),
            |args| assert_eq!(args, &json!({ "op": "backup" })),
            Ok(json!({ "message": "一致性备份已写入：/data/backups/a.sqlite3" })),
        )
        .unwrap();
        assert!(message.contains("一致性备份"));
        let message = call_port(
            &link,
            &published,
            "memory_maintenance",
            |link| SettingsPortImpl::new(link).memory_maintenance(MemoryMaintenanceOp::Export),
            |args| assert_eq!(args, &json!({ "op": "export" })),
            Ok(json!({ "message": "只读导出已写入" })),
        )
        .unwrap();
        assert_eq!(message, "只读导出已写入");
        let message = call_port(
            &link,
            &published,
            "memory_maintenance",
            |link| {
                SettingsPortImpl::new(link).memory_maintenance(MemoryMaintenanceOp::RebuildIndex)
            },
            |args| assert_eq!(args, &json!({ "op": "rebuild_index" })),
            Ok(json!({ "message": "索引已重建（revision 12）" })),
        )
        .unwrap();
        assert!(message.contains("revision 12"));
        assert!(call_port(
            &link,
            &published,
            "memory_maintenance",
            |link| SettingsPortImpl::new(link).memory_maintenance(MemoryMaintenanceOp::Backup),
            |args| assert_eq!(args, &json!({ "op": "backup" })),
            Ok(json!({ "path": "/data/backups/a.sqlite3" })),
        )
        .is_err());

        // memory_restore：preview/apply 两种线格式；message 必填。
        let message = call_port(
            &link,
            &published,
            "memory_restore",
            |link| SettingsPortImpl::new(link).memory_restore(true),
            |args| assert_eq!(args, &json!({ "op": "preview" })),
            Ok(json!({ "message": "预检通过：3 张表可恢复" })),
        )
        .unwrap();
        assert!(message.contains("预检通过"));
        let message = call_port(
            &link,
            &published,
            "memory_restore",
            |link| SettingsPortImpl::new(link).memory_restore(false),
            |args| assert_eq!(args, &json!({ "op": "apply" })),
            Ok(json!({ "message": "恢复完成（revision 13）" })),
        )
        .unwrap();
        assert!(message.contains("恢复完成"));
        assert!(call_port(
            &link,
            &published,
            "memory_restore",
            |link| SettingsPortImpl::new(link).memory_restore(true),
            |args| assert_eq!(args, &json!({ "op": "preview" })),
            Ok(json!({ "revision": 3 })),
        )
        .is_err());
    }

    #[test]
    fn 远端错误码与文案原样透出不吞() {
        let (link, published, _) = test_link();

        // 写方法失败：结构化 code/message 保真（丢码等于改语义）。
        let error = call_port(
            &link,
            &published,
            "v1rtual_write",
            |link| SettingsPortImpl::new(link).v1rtual_write("x"),
            |args| assert_eq!(args, &json!({ "content": "x" })),
            Err(AppError::Remote {
                code: "MEMORY_CONFLICT".into(),
                message: "版本冲突".into(),
            }),
        )
        .unwrap_err();
        assert_eq!(error.code(), "MEMORY_CONFLICT");
        assert!(error.to_string().contains("版本冲突"));

        // 读方法失败同理：不折叠成空结果、不伪造成功。
        let error = call_port(
            &link,
            &published,
            "memory_dreaming_sweep",
            |link| SettingsPortImpl::new(link).memory_dreaming_sweep(),
            |args| assert_eq!(args, &json!({})),
            Err(AppError::Remote {
                code: "OTHER".into(),
                message: "模型不可用".into(),
            }),
        )
        .unwrap_err();
        assert_eq!(error.code(), "OTHER");
        assert!(error.to_string().contains("模型不可用"));
    }

    fn test_profiles_root() -> PathBuf {
        PathBuf::from("/tmp/deskpet-test/data/profiles")
    }
}
