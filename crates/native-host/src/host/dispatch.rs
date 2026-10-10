//! 原生宿主完整命令分派器（W4）。
//!
//! 覆盖 `src/services/host/types.ts` 的 `HostCommandMap` 全部 141 条（总数以 types.ts
//! 为准；分项已复核为「107 冻结 + 34 扩展」：冻结件删 `profile_clone`（「新建 Profile」
//! 改造）与 `mcp_send`，MCP 裸行收发改由 `mcp_write` / `mcp_read` 两条有意扩展承担）。
//! A2 追加 `apply_chat_projection` / `apply_titlebar_status`，
//! A3 追加 `set_popup_placement` / `set_popup_size`，管理面批次追加通用文件对话框
//! `pick_file_open` / `pick_file_save` 与自动呼出开关 `set_popup_auto_show`，
//! 主题批次追加界面主题下发 `apply_theme`，设置页 Card 管理批次追加人格文件删除
//! `personality_file_delete`，自带 MCP 批次追加凭据读写 `mcp_credential_set` /
//! `mcp_credential_delete` / `mcp_credential_status` / `mcp_credential_get`，
//! 聊天图片批次追加删会话清理 `chat_delete_session_images`，
//! 折叠批次追加会话根写入 `session_write_text`（会话专用放宽路径，边界钉在会话根）；
//! 会话检索批次追加 `conversation_index_status` / `conversation_index_replace` /
//! `conversation_index_prune` / `conversation_search` / `conversation_context`。
//! 每条：从 JSON 参数解出（**参数名逐字对齐矩阵的 camelCase 线格式**）
//! → 调用 `commands/**` 或对应域的实现 → 结果按矩阵形状序列化。
//!
//! # 错误保真
//!
//! 失败一律返回结构化 [`AppError`]：`code`/`message` 经 `ipc/bridge.rs` 的
//! `respond_app_err` → `WireError` 原样过 IPC（`{code,message}`），**不降级为字符串**。
//! 本模块不把错误折成成功、不伪造默认值；未知方法只回「命令矩阵外的方法」这一
//! 明确错误（产品宿主不静默忽略任何调用）。
//!
//! # blob 通道
//!
//! 二进制结果（`file_read_binary` / `profile_file_read` / `personality_file_read`）
//! 经 `BlobRegistry::issue_host_blob` 签发句柄，结果里写 `$hostBlobRef` 标记；
//! Node 侧经 `blob_read` + 二进制通道物化回 `Uint8Array`（应用层结果不缩水）。
//! 二进制参数（`profile_file_write.content` / `personality_file_write.content`）
//! 由桥在分派前物化为 JSON number 数组（`$wireBlob` 上传标记的既有路径），
//! 本模块按 `Vec<u8>` 收窄 —— 不新造第二套通道。
//!
//! # 调用方 principal（单 Node 架构）
//!
//! 原生宿主只有一条来自唯一 Node 的命令面，没有 WebView 窗口；业务身份
//! （tool_permit 借用者、memory actor 门禁、截图窗口白名单）必须显式化，
//! 落在 [`NativeDispatcher`] 的 `caller`：
//! - 产品宿主 = [`WindowId::Main`]；E2E 隔离宿主 = [`WindowId::E2e`]；
//! - `memory_apply_change` 的 actor 门禁按 `caller` + actor/action 判定
//!   （见 [`memory_change_window_label`]）——冻结矩阵里没有窗口字段，Node 的
//!   `actor` 是唯一入口身份，映射保住既有的存储 actor 语义；
//! - `capture_screenshot` / `save_screenshot` 的调用方白名单与 `tool_permit_*`
//!   的借用者窗口身份都取 `caller`。
//!
//! # E2E 命令
//!
//! `e2e_memory_reset` / `e2e_memory_performance` 的域实现自带「debug + is_e2e」
//! 双闸；`e2e_options` / `e2e_complete` / `e2e_trace` 是宿主级测试协议（需要
//! `main.rs` 的 E2E 私有通道），由 `E2eDispatcher` 承接 —— 本分派器对这三条给出
//! 明确错误而不是未知方法，保证 141 条在分派面上「条条有着落」。

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::commands::{
    chat_images, cursor, font_cmd, logging, mcp_bridge, mcp_credentials, memory_cmd, monitor_ctl,
    observation_cmd, personality_fs_cmd, profile_cmd, resources_cmd, screenshot_cmd, session_fs,
    skill_cmd, tool_exec, tool_permit,
};
use crate::error::{AppError, AppResult};
use crate::host::{WindowId, WindowPort};
use crate::ipc::blob::{host_blob_marker, BlobRegistry};
use crate::ipc::bridge::{CommandDispatcher, DispatchContext};
use crate::ipc::protocol::RunScope;
use crate::memory::commands as memory_commands;
use crate::memory::{self, MemoryState, MemoryStore};
use crate::monitor::MonitorState;
use crate::paths::AppPaths;
use crate::ui::chat::TranscriptProjection;
use crate::ui::ports::HostLink;
use crate::ui::{shortcut, UiHandle};
use crate::{rust_warn, update};

/// 命中矩阵外方法时的错误前缀（测试用它对账「没有分派臂」与「有臂但参数错误」）。
pub(crate) const OUTSIDE_MATRIX_PREFIX: &str = "命令矩阵外的方法：";

/// `get_runtime_paths` 的应答载荷（与 `src/services/paths` 的 `RuntimePathsPayload`
/// 逐字段同形，camelCase）。
/// 引导分派器与 E2E 分派器共用同一构造点，不各拼一份。
pub fn runtime_paths_payload(paths: &AppPaths) -> Value {
    let display = |path: &std::path::Path| path.to_string_lossy().to_string();
    json!({
        "data": display(&paths.data_root),
        "memory": display(&paths.memory),
        "sessions": display(&paths.sessions),
        "personality": display(&paths.personality),
        "profiles": display(&paths.profiles),
        "settings": display(&paths.settings),
        "configFile": display(&paths.config_file),
        "runtimeMode": paths.runtime_mode,
    })
}

/// 分派器依赖集合（`main.rs` 装配后交给监督器；测试用替身注入）。
pub struct NativeDispatcherDeps {
    pub paths: AppPaths,
    /// 调用方 principal（产品 = Main；E2E 隔离宿主 = E2e）。
    pub caller: WindowId,
    pub ui: UiHandle,
    pub windows: Arc<dyn WindowPort>,
    pub monitor: Arc<MonitorState>,
    pub mcp: Arc<mcp_bridge::McpPool>,
    pub bash: Arc<tool_exec::BashPool>,
    pub permits: Arc<tool_permit::ToolPermitPool>,
    pub dialogs: Arc<dyn crate::host::FileDialogPort>,
    pub assets: Arc<dyn crate::host::AssetScopePort>,
    pub lifecycle: Arc<dyn crate::host::LifecyclePort>,
    pub host_link: Arc<HostLink>,
    pub audio: Arc<dyn crate::audio::AudioPort>,
}

/// 原生宿主完整命令分派器。
pub struct NativeDispatcher {
    paths: AppPaths,
    caller: WindowId,
    ui: UiHandle,
    windows: Arc<dyn WindowPort>,
    monitor: Arc<MonitorState>,
    /// 主动档位投影（与 `monitor` 并列的 dispatcher 级运行期状态；不进 SQLite）：
    /// Node 经 `proactive_control` 下发，缺省回落中档。消费者是 proactive 域的终裁命令。
    proactive_limits: Arc<crate::proactive::ProactiveLimitsState>,
    mcp: Arc<mcp_bridge::McpPool>,
    bash: Arc<tool_exec::BashPool>,
    permits: Arc<tool_permit::ToolPermitPool>,
    dialogs: Arc<dyn crate::host::FileDialogPort>,
    assets: Arc<dyn crate::host::AssetScopePort>,
    lifecycle: Arc<dyn crate::host::LifecyclePort>,
    host_link: Arc<HostLink>,
    audio: Arc<dyn crate::audio::AudioPort>,
    welcome_played: AtomicBool,
    /// 记忆库惰性打开：第一条记忆命令才打开（`--smoke` 不触库）。
    /// 打开失败不缓存失败结论，下一条命令会如实重报同一个错误（不降级、不假成功）。
    memory: OnceLock<MemoryState>,
    memory_open: Mutex<()>,
}

impl NativeDispatcher {
    pub fn new(deps: NativeDispatcherDeps) -> Self {
        Self {
            paths: deps.paths,
            caller: deps.caller,
            ui: deps.ui,
            windows: deps.windows,
            monitor: deps.monitor,
            proactive_limits: Arc::new(crate::proactive::ProactiveLimitsState::default()),
            mcp: deps.mcp,
            bash: deps.bash,
            permits: deps.permits,
            dialogs: deps.dialogs,
            assets: deps.assets,
            lifecycle: deps.lifecycle,
            host_link: deps.host_link,
            audio: deps.audio,
            welcome_played: AtomicBool::new(false),
            memory: OnceLock::new(),
            memory_open: Mutex::new(()),
        }
    }

    /// `get_runtime_paths` 的应答（引导分派器在应答成功后另发 `--smoke` 信号）。
    pub fn runtime_paths(&self) -> Value {
        runtime_paths_payload(&self.paths)
    }

    /// 分派器持有的运行时路径（E2E 分派器的 `e2e_trace` 等宿主级设施复用同一决定点，
    /// 不建第二份 `AppPaths` 拷贝）。
    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    /// 惰性打开记忆库。打开失败如实透出原错误（含 `MEMORY` 码），不缓存、不降级；
    /// 用短锁串行化并发首开（SQLite 打开是重 IO，不让两条命令同时打库）。
    fn memory(&self) -> AppResult<&MemoryState> {
        if let Some(state) = self.memory.get() {
            return Ok(state);
        }
        let _guard = self.memory_open.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = self.memory.get() {
            return Ok(state);
        }
        let store = MemoryStore::open(&self.paths)?;
        Ok(self.memory.get_or_init(|| MemoryState::new(store)))
    }

    /// transport 无关的分派入口（测试直接驱动；`CommandDispatcher` 实现只是它的壳）。
    pub fn dispatch_with(
        &self,
        method: &str,
        args: Value,
        blobs: &BlobRegistry,
        scope: &RunScope,
    ) -> AppResult<Value> {
        let args = &args;
        match method {
            // ── 应用生命周期（types.ts: app_restart）──
            // W10c 收口语义：restart 走统一退出序列；有 staged 更新时由 helper 替换并重启。
            "app_restart" => {
                self.lifecycle.restart()?;
                Ok(Value::Null)
            }

            // ── 光标与弹窗定位（cursor.rs）──
            "get_cursor_position" => ser(cursor::get_cursor_position()?),
            "compute_popup_position" => {
                let win_w = arg_i32(args, "winW")?;
                let win_h = arg_i32(args, "winH")?;
                ser(cursor::compute_popup_position(
                    self.windows.as_ref(),
                    win_w,
                    win_h,
                )?)
            }

            // ── 系统观察与显示器（monitor_ctl.rs）──
            "set_monitor_enabled" => {
                monitor_ctl::set_monitor_enabled(&self.monitor, arg_bool(args, "enabled")?)?;
                Ok(Value::Null)
            }
            "get_runtime_activity" => {
                ser(monitor_ctl::get_runtime_activity(self.windows.as_ref())?)
            }

            // ── 字体（font_cmd.rs）──
            "list_system_fonts" => ser(font_cmd::list_system_fonts()),

            // ── 日志与诊断（logging.rs）──
            "log_messages" => {
                logging::log_messages(arg_strings(args, "msgs")?);
                Ok(Value::Null)
            }
            "set_log_config" => {
                logging::set_log_config(arg_u8(args, "level")?);
                Ok(Value::Null)
            }
            "report_frontend_error" => {
                logging::report_frontend_error(
                    arg_str(args, "source")?,
                    arg_str(args, "message")?,
                    arg_str(args, "stack")?,
                );
                Ok(Value::Null)
            }
            "open_devtools" => {
                logging::open_devtools(self.windows.as_ref())?;
                Ok(Value::Null)
            }

            // ── 窗口增强（window/settings.rs）──
            "enhance_settings_window" => {
                crate::window::settings::enhance_settings_window(self.windows.as_ref())?;
                Ok(Value::Null)
            }
            "enhance_layer_editor_window" => {
                crate::window::settings::enhance_layer_editor_window(self.windows.as_ref())?;
                Ok(Value::Null)
            }
            "set_picker_window_level" => {
                crate::window::settings::set_picker_window_level(
                    self.windows.as_ref(),
                    arg_bool(args, "picking")?,
                )?;
                Ok(Value::Null)
            }

            // ── 全局快捷键（W5 有意扩展）──
            // modifiers 已由 Node 按平台解析好；宿主只做名称→键码/修饰位编译。
            "configure_global_shortcut" => {
                let key = arg_str(args, "key")?;
                let modifiers = arg_strings(args, "modifiers")?;
                let spec = shortcut::parse_spec(&key, &modifiers)
                    .map_err(|error| AppError::Config(format!("全局快捷键组合无效: {error}")))?;
                let compiled = spec
                    .compile()
                    .map_err(|error| AppError::Config(format!("全局快捷键不受支持: {error}")))?;
                self.ui.apply_global_shortcut(compiled)?;
                Ok(Value::Null)
            }

            // ── 聊天图片自动预览（W7 有意扩展）──
            "configure_chat_image_preview" => {
                // 收到前保持关闭（fail-closed）。
                crate::ui::chat::configure_inline_previews(arg_bool(args, "enabled")?);
                Ok(Value::Null)
            }

            "audio_play_wav" => {
                self.audio
                    .play_wav(&decode_audio_clip(&arg_str(args, "data")?)?)?;
                Ok(Value::Null)
            }
            "ui_set_sound_cues" => {
                let clips = args
                    .get("clips")
                    .ok_or_else(|| AppError::Config("音效配置缺少clips".into()))?;
                let read_clip = |key: &str| -> AppResult<Option<Vec<u8>>> {
                    match clips.get(key) {
                        Some(Value::Null) => Ok(None),
                        Some(Value::String(data)) => decode_audio_clip(data).map(Some),
                        _ => Err(AppError::Config(format!("音效配置字段{key}无效"))),
                    }
                };
                self.audio.configure_cues(
                    read_clip("welcome")?,
                    read_clip("popup")?,
                    read_clip("retract")?,
                )?;
                if self.caller != WindowId::E2e && !self.welcome_played.swap(true, Ordering::SeqCst)
                {
                    self.audio.play(crate::audio::AudioCue::Welcome)?;
                }
                Ok(Value::Null)
            }

            // ── 应用内更新（W10b 有意扩展）──
            other if update::is_update_command(other) => update::handle_command(other, args),

            // ── 原生 UI 状态推送与宿主请求回执（W9b 有意扩展）──
            "apply_font_snapshot" => {
                let family = arg_opt_str(args, "family")?;
                let size = arg_opt_f64(args, "size")?;
                self.ui
                    .apply_font_snapshot(crate::ui::font::FontSnapshot { family, size })?;
                Ok(Value::Null)
            }
            // 界面主题：取值由 `ui::theme::normalize` 收拢（非法值 → 默认，不报错中断）。
            // 宿主不读 CONFIG、不复制默认值，只接收推送的主题 id。
            "apply_theme" => {
                let theme = arg_opt_str(args, "theme")?.unwrap_or_default();
                self.ui.apply_theme(theme)?;
                Ok(Value::Null)
            }
            "apply_stage_profile" => {
                let profile = crate::ui::ports::parse_stage_profile(&self.paths.profiles, args)?;
                self.ui.apply_stage_profile(profile)?;
                Ok(Value::Null)
            }
            "set_chat_panel" => {
                // open 缺省/null = 不改变当前开合（语义见 types.ts）。
                let open = arg_opt_bool(args, "open")?;
                let width = arg_opt_f64(args, "width")?;
                self.ui.set_chat_panel(open, width)?;
                Ok(Value::Null)
            }
            // ── 弹窗摆位与尺寸的运行时闭环（A3 有意扩展）──
            // 形状登记在 types.ts：{mode:"cursor"} | {mode:"fixed", x?, y?}；fixed 带
            // 坐标时宿主立即摆位，不带坐标 = 过渡态「固定模式、锚定当前位置」
            // （见 PlacementMode::from_wire）。载荷非法一律 CONFIG 错误，不静默回退。
            "set_popup_placement" => {
                let mode = crate::ui::state::PlacementMode::from_wire(
                    &arg_str(args, "mode")?,
                    arg_opt_f64(args, "x")?,
                    arg_opt_f64(args, "y")?,
                )
                .ok_or_else(|| {
                    AppError::Config("弹窗摆位模式无效（未知 mode 或坐标不成对/无效）".into())
                })?;
                self.ui.set_popup_placement(mode)?;
                Ok(Value::Null)
            }
            // w/h 来自 `general.popup.defaultSize`（Node 已按设置 schema 约束值域；
            // 宿主再校验有限正数并约束到主窗最小尺寸）。
            "set_popup_size" => {
                let width = arg_opt_f64(args, "w")?
                    .ok_or_else(|| AppError::Config("命令缺少数值参数: w".into()))?;
                let height = arg_opt_f64(args, "h")?
                    .ok_or_else(|| AppError::Config("命令缺少数值参数: h".into()))?;
                self.ui.set_popup_size(width, height)?;
                Ok(Value::Null)
            }
            // ── 自动呼出开关（本批有意扩展）──
            // 值只来自 Node 的 getter（不复制默认值）；宿主收到前按 false（fail-closed）。
            // 只存开关：是否/何时呼出由原生 UI 在「新提交的助手条目」到达时自行裁决
            // （§9.4 裁定 1：Node 不得驱动窗口显隐与层级，所以这里没有、也不会有
            // 「显示窗口」的命令）。
            "set_popup_auto_show" => {
                crate::ui::state::store_popup_auto_show(arg_bool(args, "enabled")?);
                Ok(Value::Null)
            }
            // ── 会话投影与顶栏状态推送（A2 有意扩展）──
            "apply_chat_projection" => {
                // ⚠️ 接收端语义（A2 明确警告，后续面板生产者在接入前必读）：
                // 本帧是**整帧读模型** —— `messages` 整帧覆盖（帧内缺省 = 空列表 =
                // 清空正文），queue/interrupted/slashCommands/recoveredPlans/
                // defaultDelivery 等会话/视图态面板**缺省即清空**，usage 与
                // sessions/sessionHistory 缺省保持现值。线上生产者只有一条
                // （`pushSessionProjection`：sessionId/sessions/sessionHistory/messages
                // 同一 builder）；**后续其余面板字段必须并入这同一条 builder**，
                // 否则两条生产者轮流发帧会互相清空（每次会话变化一帧不带 messages，
                // 就把正文抹掉）。划分与理由见
                // `ui/chat/projection.rs::TranscriptProjection` 文档。
                let projection = TranscriptProjection::from_value(args)?;
                crate::ui::chat::chat_ui().apply_projection(projection);
                // 原生 UI 自行裁决窗口显隐（§9.4 裁定 1）：落帧后请原生 UI 检查投影是否
                // 带来「新提交的助手条目」（`general.popup.autoPopupOnMessage`），命中且
                // 开关开启、主窗收起时，由原生 UI 走既有呼出状态机自己呼出。这是投影的
                // **派生效果**：投递给 UI 主线程异步执行，不等待、不影响本命令的返回
                // （正文投影已经应用）；无窗口宿主（E2E/单测）里任务只入队不执行 ——
                // 没有窗口可呼出，平台侧 `note_auto_popup_check` 对「UI 未初始化」留痕。
                self.ui
                    .queue()
                    .push(Box::new(crate::ui::platform::imp::note_auto_popup_check));
                Ok(Value::Null)
            }
            "apply_titlebar_status" => {
                // text 空白由 titlebar::store 按 None 同义处理（回落缺省「就绪」）。
                let text = arg_opt_str(args, "text")?;
                self.ui.apply_titlebar_status(text)?;
                Ok(Value::Null)
            }
            "host_request_result" => {
                let request_id = arg_u64(args, "requestId")?;
                let ok = arg_bool(args, "ok")?;
                let outcome: AppResult<Value> = if ok {
                    Ok(args.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    let code = args
                        .pointer("/error/code")
                        .and_then(Value::as_str)
                        .unwrap_or("OTHER")
                        .to_string();
                    let message = args
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Node 未提供失败说明")
                        .to_string();
                    Err(AppError::Remote { code, message })
                };
                if !self.host_link.complete(request_id, outcome) {
                    // 已超时/已取消后迟到的回执：按在的归宿丢弃，不复活请求（不是错误）。
                    rust_warn!("收到未知宿主请求号的回执（已超时或已取消）：{request_id}");
                }
                Ok(Value::Null)
            }
            "pick_profile_asset" => {
                // 编辑器「换素材」：返回绝对路径；用户取消 = null（不是错误）。
                Ok(match self.dialogs.pick_file()? {
                    Some(path) => Value::String(path),
                    None => Value::Null,
                })
            }
            // ── 通用文件对话框（本批有意扩展；配置/资料导入导出、Skill 上传等）──
            // 只负责选路径，不读不写文件（读写仍走既有 file_* 命令）。
            // 过滤器非法（空扩展名列表/空标签）如实报 CONFIG，不静默用默认过滤器。
            "pick_file_open" => {
                let extensions = arg_strings(args, "extensions")?;
                let label = arg_str(args, "label")?;
                if extensions.is_empty() || label.trim().is_empty() {
                    return Err(AppError::Config(
                        "pick_file_open 需要非空的 extensions 与 label".into(),
                    ));
                }
                let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
                Ok(match self.dialogs.pick_file_filtered(&label, &refs)? {
                    Some(path) => Value::String(path),
                    None => Value::Null,
                })
            }
            "pick_file_save" => {
                let suggested = arg_str(args, "suggestedName")?;
                let filter_label = arg_str(args, "filterLabel")?;
                let extension = arg_str(args, "extension")?;
                if extension.trim().is_empty() || filter_label.trim().is_empty() {
                    return Err(AppError::Config(
                        "pick_file_save 需要非空的 filterLabel 与 extension".into(),
                    ));
                }
                Ok(
                    match self
                        .dialogs
                        .save_file(&suggested, &filter_label, &extension)?
                    {
                        Some(path) => Value::String(path),
                        None => Value::Null,
                    },
                )
            }

            // ── Bash（tool_exec/bash.rs）──
            "bash_exec" => {
                let result = tool_exec::run_bash(
                    (*self.bash).clone(),
                    arg_str(args, "command")?,
                    arg_opt_str(args, "cwd")?,
                    arg_opt_str(args, "executionId")?,
                    arg_opt_u64(args, "timeoutMs")?,
                    arg_opt_usize(args, "maxBytes")?,
                    arg_opt_usize(args, "maxLines")?,
                    arg_opt_bool(args, "spill")?,
                    // 发起会话（回传到后台完成事件、供完成通知落进正确会话）；缺省表示无归属。
                    arg_opt_str(args, "sessionId")?,
                )?;
                ser(result)
            }
            "bash_cancel" => {
                let execution_id = arg_str(args, "executionId")?;
                Ok(Value::Bool(tool_exec::cancel_in_pool(
                    &self.bash,
                    &execution_id,
                )?))
            }

            // ── 文件系统（tool_exec/fs.rs）──
            "file_read" => ser(tool_exec::file_read(
                arg_str(args, "path")?,
                arg_opt_usize(args, "maxBytes")?,
            )?),
            "file_read_binary" => {
                let data = tool_exec::file_read_binary(
                    arg_str(args, "path")?,
                    arg_opt_usize(args, "maxBytes")?,
                )?;
                self.bytes_result(blobs, scope, data)
            }
            "file_write" => ser(tool_exec::file_write(
                arg_str(args, "path")?,
                arg_str(args, "content")?,
                arg_opt_usize(args, "maxBytes")?,
            )?),
            "file_write_atomic" => ser(tool_exec::file_write_atomic(
                arg_str(args, "path")?,
                arg_str(args, "content")?,
                arg_opt_usize(args, "maxBytes")?,
            )?),
            "file_append" => {
                // maxBytes 是必填（矩阵：Rust u64，不是 Option）。
                tool_exec::file_append(
                    arg_str(args, "path")?,
                    arg_str(args, "content")?,
                    arg_u64(args, "maxBytes")?,
                )?;
                Ok(Value::Null)
            }
            "file_rename" => {
                tool_exec::file_rename(
                    arg_str(args, "sourcePath")?,
                    arg_str(args, "destinationPath")?,
                )?;
                Ok(Value::Null)
            }
            "file_remove" => {
                tool_exec::file_remove(
                    arg_str(args, "path")?,
                    arg_bool(args, "recursive")?,
                    arg_bool(args, "force")?,
                )?;
                Ok(Value::Null)
            }
            "dir_create" => {
                tool_exec::dir_create(arg_str(args, "path")?, arg_bool(args, "recursive")?)?;
                Ok(Value::Null)
            }
            "file_list" => ser(tool_exec::file_list(arg_str(args, "path")?)?),
            "file_info" => ser(tool_exec::file_info(arg_str(args, "path")?)?),
            "file_exists" => Ok(Value::Bool(tool_exec::file_exists(arg_str(args, "path")?)?)),
            "file_canonical_path" => Ok(Value::String(tool_exec::file_canonical_path(arg_str(
                args, "path",
            )?)?)),

            // ── 聊天图片准入（chat_images.rs）──
            "pick_chat_images" => ser(chat_images::pick_chat_images(
                self.dialogs.as_ref(),
                self.assets.as_ref(),
            )?),
            "validate_chat_images" => ser(chat_images::validate_chat_images(
                self.assets.as_ref(),
                arg_strings(args, "paths")?,
            )?),
            // 删会话连带清理托管聊天图片：包含判定在 chat_images.rs（只删托管根内的
            // 常规文件，根外/目录/符号链接/已消失一律 skipped）。
            "chat_delete_session_images" => ser(chat_images::chat_delete_session_images(
                &self.paths,
                arg_strings(args, "paths")?,
            )?),

            // ── 静默观察与截图（observation_cmd.rs / screenshot_cmd.rs）──
            "observation_capture_screen" => ser(observation_cmd::observation_capture_screen(
                self.windows.as_ref(),
                &self.monitor,
            )?),
            "observation_read_targets" => {
                let targets: Vec<observation_cmd::ReadTarget> =
                    from_value(args.get("targets").cloned().ok_or_else(|| {
                        AppError::Config("observation_read_targets 缺少 targets".into())
                    })?)?;
                ser(observation_cmd::observation_read_targets(
                    self.windows.as_ref(),
                    &self.monitor,
                    &self.paths,
                    targets,
                )?)
            }
            "capture_screenshot" => ser(screenshot_cmd::capture_screenshot(
                Some(self.caller),
                self.windows.as_ref(),
                &self.monitor,
            )?),
            "save_screenshot" => ser(screenshot_cmd::save_screenshot(
                Some(self.caller),
                &self.paths,
                self.assets.as_ref(),
                arg_str(args, "imageBase64")?,
            )?),

            // ── 本地工具剩余（tool_exec/desktop.rs、system.rs）──
            "app_open" => ser(tool_exec::app_open(arg_str(args, "path")?)?),
            "clipboard_read" => ser(tool_exec::clipboard_read()?),
            "clipboard_write" => ser(tool_exec::clipboard_write(arg_str(args, "text")?)?),
            "system_info" => ser(tool_exec::system_info()),

            // ── MCP 进程桥（mcp_bridge.rs）──
            // 结果结构体没有 rename_all：线格式是 snake_case 的 server_id（矩阵同款）。
            "mcp_spawn" => ser(mcp_bridge::mcp_spawn(
                &self.mcp,
                arg_str(args, "name")?,
                arg_str(args, "command")?,
                arg_strings(args, "args")?,
                arg_str(args, "transport")?,
                arg_opt_string_map(args, "env")?,
            )?),
            // 裸行收发：id 配对 / 通知处理都在 Node 侧 pi-mcp 客户端，宿主按行转发。
            "mcp_write" => {
                mcp_bridge::mcp_write(
                    &self.mcp,
                    arg_str(args, "serverId")?,
                    arg_str(args, "line")?,
                )?;
                Ok(Value::Null)
            }
            "mcp_read" => ser(mcp_bridge::mcp_read(
                &self.mcp,
                arg_str(args, "serverId")?,
                arg_opt_u64(args, "timeoutMs")?,
            )?),
            "mcp_kill" => ser(mcp_bridge::mcp_kill(&self.mcp, arg_str(args, "serverId")?)?),

            // ── 记忆文件种子（memory_cmd.rs）──
            "init_memory_files" => Ok(Value::String(memory_cmd::init_memory_files(&self.paths)?)),

            // ── 运行时路径与配置 ──
            "get_runtime_paths" => Ok(self.runtime_paths()),
            "resolve_runtime_path" => {
                let scope = arg_str(args, "scope")?;
                let segments = arg_strings(args, "segments")?;
                Ok(Value::String(resolve_runtime_path(
                    &self.paths,
                    &scope,
                    &segments,
                )?))
            }
            "read_runtime_config" => Ok(Value::String(read_runtime_config(&self.paths)?)),
            "write_runtime_config" => {
                write_runtime_config(&self.paths, arg_str(args, "content")?)?;
                Ok(Value::Null)
            }
            "read_session_ui_state" => Ok(match read_session_ui_state(&self.paths)? {
                Some(text) => Value::String(text),
                None => Value::Null,
            }),
            "write_session_ui_state" => {
                write_session_ui_state(&self.paths, arg_str(args, "content")?)?;
                Ok(Value::Null)
            }

            // ── 会话文件（session_fs.rs）──
            "session_read_text" => Ok(Value::String(session_fs::read_session_text(
                &self.paths.sessions,
                &arg_str(args, "path")?,
                arg_opt_usize(args, "maxLines")?,
                arg_opt_usize(args, "tailBytes")?,
            )?)),
            "session_write_text" => {
                // maxBytes 是必填（矩阵：u64，不是 Option）：会话写路径不设「不限大小」形态，
                // 上限由 Node 按会话口径下发。
                session_fs::write_session_text(
                    &self.paths.sessions,
                    &arg_str(args, "path")?,
                    &arg_str(args, "content")?,
                    arg_u64(args, "maxBytes")?,
                )?;
                Ok(Value::Null)
            }

            // ── Profile（profile_cmd.rs）──
            "profile_file_write" => {
                profile_cmd::profile_file_write(
                    arg_str(args, "profileId")?,
                    arg_str(args, "relativePath")?,
                    arg_bytes(args, "content")?,
                    &self.paths,
                )?;
                Ok(Value::Null)
            }
            "profile_file_read" => {
                let data = profile_cmd::profile_file_read(
                    arg_str(args, "profileId")?,
                    arg_str(args, "relativePath")?,
                    &self.paths,
                )?;
                self.bytes_result(blobs, scope, data)
            }
            "profile_delete" => {
                profile_cmd::profile_delete(arg_str(args, "profileId")?, &self.paths)?;
                Ok(Value::Null)
            }
            "export_profile_zip" => Ok(
                match profile_cmd::export_profile_zip(
                    self.dialogs.as_ref(),
                    &self.paths.profiles,
                    arg_str(args, "profileId")?,
                )? {
                    Some(path) => Value::String(path),
                    None => Value::Null,
                },
            ),
            "profile_asset_base" => Ok(Value::String(profile_cmd::profile_asset_base(
                arg_str(args, "profileId")?,
                &self.paths,
            )?)),
            "list_profiles" => ser(profile_cmd::list_profiles(&self.paths)?),
            "list_profile_files" => ser(profile_cmd::list_profile_files(
                arg_str(args, "profileId")?,
                arg_opt_str(args, "subdir")?,
                &self.paths,
            )?),

            // ── 默认资源与 Skill（resources_cmd.rs / skill_cmd.rs）──
            "restore_default_resources" => {
                ser(resources_cmd::restore_default_resources(&self.paths)?)
            }
            "skill_delete" => {
                resources_cmd::skill_delete(arg_str(args, "relativePath")?, &self.paths)?;
                Ok(Value::Null)
            }
            "skill_catalog_fingerprint" => ser(skill_cmd::skill_catalog_fingerprint(&self.paths)?),

            // ── 人格文件（personality_fs_cmd.rs）──
            "personality_file_read" => {
                let data =
                    personality_fs_cmd::personality_file_read(arg_str(args, "path")?, &self.paths)?;
                self.bytes_result(blobs, scope, data)
            }
            "personality_file_write" => {
                Ok(Value::String(personality_fs_cmd::personality_file_write(
                    arg_str(args, "path")?,
                    arg_bytes(args, "content")?,
                    &self.paths,
                )?))
            }
            "personality_file_list" => ser(personality_fs_cmd::personality_file_list(
                arg_str(args, "dirPath")?,
                &self.paths,
            )?),
            "personality_file_delete" => {
                personality_fs_cmd::personality_file_delete(arg_str(args, "path")?, &self.paths)?;
                Ok(Value::Null)
            }

            // ── 工具许可（tool_permit.rs）──
            "tool_permit_acquire" => {
                let outcome = tool_permit::tool_permit_acquire(
                    &self.permits,
                    &self.paths,
                    self.caller,
                    arg_str(args, "requestId")?,
                    arg_str(args, "kind")?,
                    arg_str(args, "borrowerId")?,
                    arg_str(args, "sessionId")?,
                    arg_i64(args, "runGeneration")?,
                    arg_str(args, "operationId")?,
                )?;
                // 排队时阻塞等待（分派在阻塞线程池上执行）；取消经 tool_permit_cancel。
                Ok(Value::Bool(match outcome {
                    tool_permit::AcquireOutcome::Granted => true,
                    tool_permit::AcquireOutcome::Queued(wait) => wait.wait(),
                }))
            }
            "tool_permit_attach" => ser(tool_permit::tool_permit_attach(
                &self.permits,
                &self.paths,
                self.caller,
                arg_str(args, "borrowerId")?,
            )?),
            "tool_permit_release" => {
                tool_permit::tool_permit_release(
                    &self.permits,
                    &self.paths,
                    self.caller,
                    arg_str(args, "borrowerId")?,
                    arg_str(args, "requestId")?,
                )?;
                Ok(Value::Null)
            }
            "tool_permit_cancel" => Ok(Value::Bool(tool_permit::tool_permit_cancel(
                &self.permits,
                &self.paths,
                self.caller,
                arg_str(args, "borrowerId")?,
                arg_str(args, "requestId")?,
            )?)),
            "tool_permit_set_max_shared_readers" => Ok(Value::from(
                tool_permit::tool_permit_set_max_shared_readers(
                    &self.permits,
                    &self.paths,
                    arg_usize(args, "limit")?,
                )? as u64,
            )),
            "tool_permit_snapshot" => ser(tool_permit::tool_permit_snapshot(
                &self.permits,
                &self.paths,
            )?),

            // ── 记忆（memory/commands.rs）──
            // 失败（含 MEMORY_CONFLICT）走结构化 AppError；结果形状与协议生成物一致。
            "conversation_index_status" => {
                memory_commands::conversation_index_status(self.memory()?)
            }
            "conversation_index_replace" => {
                let expected_fingerprint = match args.get("expectedFingerprint") {
                    Some(Value::Null) => None,
                    Some(Value::String(value)) => Some(value.clone()),
                    Some(_) => {
                        return Err(AppError::Config(
                            "参数不是字符串或 null: expectedFingerprint".into(),
                        ))
                    }
                    None => {
                        return Err(AppError::Config("命令缺少参数: expectedFingerprint".into()))
                    }
                };
                memory_commands::conversation_index_replace(
                    self.memory()?,
                    arg_str(args, "sessionId")?,
                    arg_str(args, "fingerprint")?,
                    expected_fingerprint,
                    arg_i64(args, "expectedForgetEpoch")?,
                    arg_value(args, "entries")?,
                    args.get("batch").filter(|value| !value.is_null()).cloned(),
                )
                .map(Value::from)
            }
            "conversation_index_prune" => {
                Ok(Value::from(memory_commands::conversation_index_prune(
                    self.memory()?,
                    arg_strings(args, "sessionIds")?,
                )?))
            }
            "conversation_search" => memory_commands::conversation_search(
                self.memory()?,
                arg_str(args, "query")?,
                arg_str(args, "sessionId")?,
                arg_opt_i64(args, "limit")?,
                arg_opt_i64(args, "before")?,
                arg_opt_bool(args, "recentFallback")?,
            ),
            "conversation_context" => memory_commands::conversation_context(
                self.memory()?,
                arg_str(args, "sessionId")?,
                arg_str(args, "anchorEntryId")?,
                arg_opt_i64(args, "afterSeq")?,
                arg_opt_i64(args, "limit")?,
                arg_opt_i64(args, "before")?,
            ),
            "memory_status" => memory_commands::memory_status(self.memory()?),
            "memory_list" => ser(memory_commands::memory_list(
                self.memory()?,
                arg_opt_str(args, "scope")?,
                arg_opt_str(args, "scopeId")?,
                arg_opt_i64(args, "limit")?,
            )?),
            "memory_detail" => ser(memory_commands::memory_detail(
                self.memory()?,
                arg_str(args, "id")?,
            )?),
            "memory_history" => ser(memory_commands::memory_history(
                self.memory()?,
                arg_str(args, "id")?,
            )?),
            "memory_register_sources" => Ok(Value::from(memory_commands::memory_register_sources(
                self.memory()?,
                arg_value(args, "sources")?
                    .as_array()
                    .cloned()
                    .ok_or_else(|| {
                        AppError::Config("memory_register_sources 的 sources 不是数组".into())
                    })?,
            )? as u64)),
            "memory_query" => ser(memory_commands::memory_query(
                self.memory()?,
                arg_str(args, "query")?,
                arg_opt_str(args, "scope")?,
                arg_opt_str(args, "scopeId")?,
                arg_opt_str(args, "sessionId")?,
                arg_opt_i64(args, "limit")?,
            )?),
            "memory_recall_candidates" => memory_commands::memory_recall_candidates(
                self.memory()?,
                arg_str(args, "query")?,
                arg_opt_str(args, "cardId")?,
                arg_str(args, "sessionId")?,
                arg_opt_i64(args, "limit")?,
                args.get("targets")
                    .filter(|value| !value.is_null())
                    .and_then(Value::as_array)
                    .cloned(),
                arg_opt_bool(args, "allowExpiredTargets")?,
            ),
            "memory_get_items" => ser(memory_commands::memory_get_items(
                self.memory()?,
                arg_strings(args, "ids")?,
            )?),
            "memory_apply_change" => {
                let actor = arg_str(args, "actor")?;
                let action = arg_str(args, "action")?;
                let trusted_session_id = arg_opt_str(args, "trustedSessionId")?;
                let window_label = memory_change_window_label(
                    self.caller,
                    &actor,
                    &action,
                    trusted_session_id.as_deref(),
                )?;
                Ok(Value::from(memory_commands::memory_apply_change(
                    window_label,
                    self.memory()?,
                    arg_str(args, "operationId")?,
                    arg_i64(args, "baseRevision")?,
                    action,
                    arg_opt_str(args, "itemId")?,
                    arg_opt_i64(args, "expectedVersion")?,
                    args.get("draft").filter(|value| !value.is_null()).cloned(),
                    actor,
                    arg_opt_str(args, "trustedUserEventId")?,
                    trusted_session_id,
                    match args.get("conversationFences") {
                        None | Some(Value::Null) => None,
                        Some(value @ Value::Array(_)) => Some(value.clone()),
                        Some(_) => {
                            return Err(AppError::Config(
                                "conversationFences 不是数组或 null".into(),
                            ))
                        }
                    },
                )?))
            }
            "memory_job_start" => memory_commands::memory_job_start(
                self.memory()?,
                arg_str(args, "phase")?,
                arg_str(args, "leaseOwner")?,
            ),
            "memory_job_list" => ser(memory_commands::memory_job_list(
                self.memory()?,
                arg_opt_i64(args, "limit")?,
                arg_opt_i64(args, "offset")?,
            )?),
            "memory_job_checkpoint" => memory_commands::memory_job_checkpoint(
                self.memory()?,
                arg_str(args, "jobId")?,
                arg_str(args, "cursor")?,
                arg_opt_strings(args, "coveredSourceIds")?,
                arg_str(args, "leaseOwner")?,
                arg_opt_i64(args, "leaseMs")?,
            ),
            "memory_job_cancel" => memory_commands::memory_job_cancel(
                self.memory()?,
                arg_str(args, "jobId")?,
                arg_str(args, "leaseOwner")?,
            ),
            "memory_job_resume" => memory_commands::memory_job_resume(
                self.memory()?,
                arg_str(args, "jobId")?,
                arg_str(args, "leaseOwner")?,
            ),
            "memory_job_sources" => ser(memory_commands::memory_job_sources(
                self.memory()?,
                arg_str(args, "jobId")?,
                arg_opt_str(args, "origin")?,
            )?),
            "memory_pending_source_count" => {
                Ok(Value::from(memory_commands::memory_pending_source_count(
                    self.memory()?,
                    arg_opt_str(args, "origin")?,
                )?))
            }
            "memory_source_evidence" => ser(memory_commands::memory_source_evidence(
                self.memory()?,
                arg_str(args, "sourceId")?,
            )?),
            "memory_candidates_add" => Ok(Value::from(memory_commands::memory_candidates_add(
                self.memory()?,
                arg_str(args, "jobId")?,
                arg_value(args, "candidates")?
                    .as_array()
                    .cloned()
                    .ok_or_else(|| {
                        AppError::Config("memory_candidates_add 的 candidates 不是数组".into())
                    })?,
            )? as u64)),
            "memory_dreaming_commit" => Ok(Value::from(memory_commands::memory_dreaming_commit(
                self.memory()?,
                arg_str(args, "jobId")?,
                arg_i64(args, "baseRevision")?,
            )?)),
            "memory_dreaming_budget_reserve" => {
                memory_commands::memory_dreaming_budget_reserve(
                    self.memory()?,
                    arg_str(args, "reservationId")?,
                    arg_str(args, "localDate")?,
                    arg_i64(args, "reservedTokens")?,
                )?;
                Ok(Value::Null)
            }
            "memory_dreaming_budget_settle" => {
                memory_commands::memory_dreaming_budget_settle(
                    self.memory()?,
                    arg_str(args, "reservationId")?,
                    arg_str(args, "localDate")?,
                    arg_i64(args, "reservedTokens")?,
                    arg_opt_i64(args, "usedTokens")?,
                )?;
                Ok(Value::Null)
            }
            "memory_dreaming_budget" => {
                memory_commands::memory_dreaming_budget(self.memory()?, arg_str(args, "localDate")?)
            }
            "memory_export" => Ok(Value::String(memory_commands::memory_export(
                self.memory()?,
            )?)),
            "memory_backup" => Ok(Value::String(memory_commands::memory_backup(
                self.memory()?,
            )?)),
            "memory_rebuild" => Ok(Value::from(memory_commands::memory_rebuild(
                self.memory()?,
            )?)),
            "memory_restore" => Ok(Value::from(memory_commands::memory_restore(
                self.memory()?,
                &self.paths,
                arg_str(args, "backupPath")?,
            )?)),
            "memory_restore_preview" => {
                memory_commands::memory_restore_preview(&self.paths, arg_str(args, "backupPath")?)
            }

            // ── MCP 凭据（commands/mcp_credentials.rs；存储在同库 mcp_credentials 表）──
            // 值与错误文案纪律：值只经 `mcp_credential_get` 的定向返回出去（消费方只有
            // Node 连接期注入），本层不把值写进任何日志/回执。
            "mcp_credential_set" => {
                mcp_credentials::mcp_credential_set(
                    self.memory()?,
                    arg_str(args, "server")?,
                    arg_str(args, "var")?,
                    arg_str(args, "value")?,
                )?;
                Ok(Value::Null)
            }
            "mcp_credential_delete" => Ok(Value::Bool(mcp_credentials::mcp_credential_delete(
                self.memory()?,
                arg_str(args, "server")?,
                arg_str(args, "var")?,
            )?)),
            "mcp_credential_status" => ser(mcp_credentials::mcp_credential_status(
                self.memory()?,
                arg_str(args, "server")?,
            )?),
            "mcp_credential_get" => ser(mcp_credentials::mcp_credential_get(
                self.memory()?,
                arg_str(args, "server")?,
                arg_str(args, "var")?,
            )?),

            // ── 主动陪伴（proactive/commands.rs；request: Value → Value）──
            "proactive_scan" => crate::proactive::commands::proactive_scan(
                self.memory()?,
                &self.proactive_limits,
                arg_value(args, "request")?,
            ),
            "proactive_query" => crate::proactive::commands::proactive_query(
                self.memory()?,
                arg_value(args, "request")?,
            ),
            "proactive_change" => crate::proactive::commands::proactive_change(
                self.memory()?,
                arg_value(args, "request")?,
            ),
            "proactive_claim" => crate::proactive::commands::proactive_claim(
                self.memory()?,
                &self.proactive_limits,
                arg_value(args, "request")?,
            ),
            "proactive_validate" => crate::proactive::commands::proactive_validate(
                self.memory()?,
                arg_value(args, "request")?,
            ),
            "proactive_settle" => crate::proactive::commands::proactive_settle(
                self.memory()?,
                &self.proactive_limits,
                arg_value(args, "request")?,
            ),
            "proactive_reconcile" => crate::proactive::commands::proactive_reconcile(
                self.memory()?,
                &self.proactive_limits,
                arg_value(args, "request")?,
            ),
            "proactive_control" => crate::proactive::commands::proactive_control(
                self.memory()?,
                &self.proactive_limits,
                arg_value(args, "request")?,
            ),
            "proactive_auxiliary_budget_reserve" => {
                crate::proactive::commands::proactive_auxiliary_budget_reserve(
                    self.memory()?,
                    arg_value(args, "request")?,
                )
            }
            "proactive_auxiliary_budget_settle" => {
                crate::proactive::commands::proactive_auxiliary_budget_settle(
                    self.memory()?,
                    arg_value(args, "request")?,
                )
            }

            // ── 测试宿主专用（仅 debug + is_e2e 生效；域实现自带双闸）──
            "e2e_memory_reset" => memory::benchmark::e2e_memory_reset(self.memory()?, &self.paths),
            "e2e_memory_performance" => {
                memory::benchmark::e2e_memory_performance(self.memory()?, arg_usize(args, "count")?)
            }
            // 宿主级测试协议需要 E2E 私有通道（main.rs 的 E2eChannel）；产品分派器
            // 明确拒绝，不冒充「未知命令」，E2E 隔离宿主里由 E2eDispatcher 承接。
            "e2e_options" | "e2e_complete" | "e2e_trace" => Err(AppError::Config(format!(
                "{method} 是 E2E 隔离宿主的私有测试协议命令，产品宿主不提供"
            ))),

            other => Err(AppError::Other(format!(
                "{OUTSIDE_MATRIX_PREFIX}{other}（不在 HostCommandMap；原生宿主不静默忽略）"
            ))),
        }
    }

    /// 二进制结果经 blob 通道：签发句柄 → 写 `$hostBlobRef` 标记。
    fn bytes_result(
        &self,
        blobs: &BlobRegistry,
        scope: &RunScope,
        data: Vec<u8>,
    ) -> AppResult<Value> {
        let blob = blobs.issue_host_blob(scope.clone(), data, None)?;
        Ok(host_blob_marker(&blob))
    }
}

impl CommandDispatcher for NativeDispatcher {
    fn dispatch(&self, ctx: &DispatchContext, args: Value) -> AppResult<Value> {
        self.dispatch_with(&ctx.method, args, ctx.blobs.as_ref(), &ctx.scope)
    }
}

/// 记忆变更的窗口门禁在单 Node 架构下的映射。
///
/// 存储 actor 由 principal（`caller`）+ actor/action 判定：`current_input` 只允许
/// 主宿主；`user_ui` 在设置面是治理 actor、在主宿主且 `add + trustedSessionId` 时
/// 是 `user_ui_current`；`internal` 只允许主宿主（debug 下另有 E2E 宿主）。冻结矩阵
/// 里没有窗口 label 字段 —— 映射保住同一存储 actor 语义，非法组合报 `MEMORY`
/// 错误，不放宽为「谁都能写任何 actor」。
fn memory_change_window_label<'a>(
    caller: WindowId,
    actor: &str,
    action: &str,
    trusted_session_id: Option<&str>,
) -> AppResult<&'a str> {
    let mismatch = || AppError::Memory("记忆变更调用窗口身份与操作类型不匹配".into());
    // 返回的标签取自 `WindowId::label()`（窗口身份的唯一定义点，见 host/mod.rs）——
    // 不在此处写第二份窗口名字面量。
    match caller {
        WindowId::Main => match actor {
            "current_input" => Ok(WindowId::Main.label()),
            // add + 可信会话 = 聊天气泡「记住这条」→ user_ui_current。
            "user_ui" if action == "add" && trusted_session_id.is_some_and(|id| !id.is_empty()) => {
                Ok(WindowId::Main.label())
            }
            // 其余 user_ui（纠正/忘记/核心画像）= 设置面的治理动作。
            "user_ui" => Ok(WindowId::Settings.label()),
            "internal" => Ok(WindowId::Main.label()),
            _ => Err(mismatch()),
        },
        // E2E 隔离宿主：只放行 internal。
        WindowId::E2e if cfg!(debug_assertions) => match actor {
            "internal" => Ok(WindowId::E2e.label()),
            _ => Err(mismatch()),
        },
        _ => Err(mismatch()),
    }
}

// ==========================================
// 运行时路径与配置
// ==========================================

fn resolve_runtime_path(paths: &AppPaths, scope: &str, segments: &[String]) -> AppResult<String> {
    let mut path = match scope {
        "data" => paths.data_root.clone(),
        "memory" => paths.memory.clone(),
        "sessions" => paths.sessions.clone(),
        "personality" => paths.personality.clone(),
        "profiles" => paths.profiles.clone(),
        "settings" => paths.settings.clone(),
        _ => return Err(AppError::Other(format!("未知运行时路径域: {scope}"))),
    };
    for segment in segments {
        let candidate = std::path::Path::new(segment);
        if candidate.is_absolute()
            || candidate
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(AppError::PathEscape);
        }
        path.push(candidate);
    }
    Ok(path.to_string_lossy().to_string())
}

fn read_runtime_config(paths: &AppPaths) -> AppResult<String> {
    std::fs::read_to_string(&paths.config_file)
        .map_err(|e| AppError::Io(format!("读取配置失败 {:?}: {e}", paths.config_file)))
}

fn write_runtime_config(paths: &AppPaths, content: String) -> AppResult<()> {
    let parent = paths
        .config_file
        .parent()
        .ok_or_else(|| AppError::Config("配置文件路径没有父目录".into()))?;
    std::fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建配置目录失败: {e}")))?;
    std::fs::write(&paths.config_file, content)
        .map_err(|e| AppError::Io(format!("写入配置失败: {e}")))
}

/// 会话列表 UI 状态文件名（`sessions/` 下唯一允许丢弃的文件）。
const SESSION_UI_STATE_FILE: &str = "index.json";

fn read_session_ui_state(paths: &AppPaths) -> AppResult<Option<String>> {
    let file = paths.sessions.join(SESSION_UI_STATE_FILE);
    if !file.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(file)
        .map(Some)
        .map_err(|e| AppError::Io(format!("读取会话 UI 状态失败: {e}")))
}

fn write_session_ui_state(paths: &AppPaths, content: String) -> AppResult<()> {
    let file = paths.sessions.join(SESSION_UI_STATE_FILE);
    std::fs::write(file, content).map_err(|e| AppError::Io(format!("写入会话 UI 状态失败: {e}")))
}

// ==========================================
// 参数收窄：参数名逐字对齐 `src/services/host/types.ts` 的 camelCase 线格式。
// 缺必填/类型不符一律 CONFIG 错误；可选参数缺省与显式 null 等价（None）。
// ==========================================

fn ser<T: Serialize>(value: T) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|error| AppError::Other(format!("结果序列化失败: {error}")))
}

fn from_value<T: DeserializeOwned>(value: Value) -> AppResult<T> {
    serde_json::from_value(value)
        .map_err(|error| AppError::Config(format!("命令参数解析失败: {error}")))
}

fn arg_value(args: &Value, key: &str) -> AppResult<Value> {
    args.get(key)
        .cloned()
        .filter(|value| !value.is_null())
        .ok_or_else(|| AppError::Config(format!("命令缺少参数: {key}")))
}

fn decode_audio_clip(data: &str) -> AppResult<Vec<u8>> {
    use base64::Engine;
    const MAX_AUDIO_WAV_BYTES: usize = 8 * 1024 * 1024;
    if data.len() > MAX_AUDIO_WAV_BYTES * 4 / 3 + 4 {
        return Err(AppError::Tool("音效数据超过播放上限".into()));
    }
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| AppError::Tool(format!("音效编码无效: {error}")))
}

fn arg_str(args: &Value, key: &str) -> AppResult<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| AppError::Config(format!("命令缺少字符串参数: {key}")))
}

fn arg_opt_str(args: &Value, key: &str) -> AppResult<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(AppError::Config(format!("参数不是字符串或 null: {key}"))),
    }
}

fn arg_bool(args: &Value, key: &str) -> AppResult<bool> {
    args.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::Config(format!("命令缺少布尔参数: {key}")))
}

fn arg_opt_bool(args: &Value, key: &str) -> AppResult<Option<bool>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(AppError::Config(format!("参数不是布尔或 null: {key}"))),
    }
}

fn arg_u64(args: &Value, key: &str) -> AppResult<u64> {
    args.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::Config(format!("命令缺少非负整数参数: {key}")))
}

fn arg_opt_u64(args: &Value, key: &str) -> AppResult<Option<u64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| AppError::Config(format!("参数不是非负整数或 null: {key}"))),
    }
}

fn arg_i64(args: &Value, key: &str) -> AppResult<i64> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Config(format!("命令缺少整数参数: {key}")))
}

fn arg_opt_i64(args: &Value, key: &str) -> AppResult<Option<i64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| AppError::Config(format!("参数不是整数或 null: {key}"))),
    }
}

fn arg_i32(args: &Value, key: &str) -> AppResult<i32> {
    let value = arg_i64(args, key)?;
    i32::try_from(value).map_err(|_| AppError::Config(format!("参数超出 i32 范围: {key}")))
}

fn arg_opt_f64(args: &Value, key: &str) -> AppResult<Option<f64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or_else(|| AppError::Config(format!("参数不是有限数值或 null: {key}"))),
    }
}

fn arg_usize(args: &Value, key: &str) -> AppResult<usize> {
    let value = arg_u64(args, key)?;
    usize::try_from(value).map_err(|_| AppError::Config(format!("参数超出 usize 范围: {key}")))
}

fn arg_opt_usize(args: &Value, key: &str) -> AppResult<Option<usize>> {
    match arg_opt_u64(args, key)? {
        None => Ok(None),
        Some(value) => usize::try_from(value)
            .map(Some)
            .map_err(|_| AppError::Config(format!("参数超出 usize 范围: {key}"))),
    }
}

/// `level: number`（0=DEBUG..3=ERROR，Rust 侧为 u8）。
fn arg_u8(args: &Value, key: &str) -> AppResult<u8> {
    let value = arg_u64(args, key)?;
    u8::try_from(value).map_err(|_| AppError::Config(format!("参数超出 u8 范围: {key}")))
}

/// 可选字符串数组：缺省 / null = None；给了就必须是字符串数组（逐项校验复用 `arg_strings`）。
fn arg_opt_strings(args: &Value, key: &str) -> AppResult<Option<Vec<String>>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(_)) => Ok(Some(arg_strings(args, key)?)),
        Some(_) => Err(AppError::Config(format!("参数不是字符串数组或 null: {key}"))),
    }
}

fn arg_strings(args: &Value, key: &str) -> AppResult<Vec<String>> {
    let items = args
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config(format!("命令缺少字符串数组参数: {key}")))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(
            item.as_str()
                .map(ToString::to_string)
                .ok_or_else(|| AppError::Config(format!("字符串数组含非字符串项: {key}")))?,
        );
    }
    Ok(out)
}

/// 字节参数（JSON number 数组；`$wireBlob` 上传标记已由桥在分派前物化为这个形态）。
fn arg_bytes(args: &Value, key: &str) -> AppResult<Vec<u8>> {
    let items = args
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config(format!("命令缺少字节数组参数: {key}")))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let byte = item
            .as_u64()
            .filter(|value| *value <= u64::from(u8::MAX))
            .ok_or_else(|| AppError::Config(format!("字节数组含非 0-255 项: {key}")))?;
        out.push(byte as u8);
    }
    Ok(out)
}

fn arg_opt_string_map(args: &Value, key: &str) -> AppResult<Option<HashMap<String, String>>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => {
            let mut out = HashMap::with_capacity(map.len());
            for (entry_key, entry_value) in map {
                let value = entry_value
                    .as_str()
                    .ok_or_else(|| AppError::Config(format!("{key} 含非字符串值: {entry_key}")))?;
                out.insert(entry_key.clone(), value.to_string());
            }
            Ok(Some(out))
        }
        Some(_) => Err(AppError::Config(format!("参数不是对象或 null: {key}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::native_ports::NativeAssetScope;
    use crate::host::{FileDialogPort, LifecyclePort};
    use crate::ipc::blob::parse_host_blob_marker;
    use crate::ipc::protocol::RunScope;
    use crate::ui::{MainThreadQueue, UiHandle};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicUsize;

    // ── 测试替身 ──

    struct FakeWindowPort;

    impl WindowPort for FakeWindowPort {
        fn show(&self, window: WindowId, _focus: bool) -> AppResult<()> {
            Err(AppError::Other(format!(
                "测试替身无窗口: {}",
                window.label()
            )))
        }
        fn hide(&self, window: WindowId) -> AppResult<()> {
            Err(AppError::Other(format!(
                "测试替身无窗口: {}",
                window.label()
            )))
        }
        fn focus(&self, window: WindowId) -> AppResult<()> {
            Err(AppError::Other(format!(
                "测试替身无窗口: {}",
                window.label()
            )))
        }
        fn set_level(&self, window: WindowId, _level: crate::host::WindowLevel) -> AppResult<()> {
            Err(AppError::Other(format!(
                "测试替身无窗口: {}",
                window.label()
            )))
        }
        fn present(&self, window: WindowId) -> AppResult<()> {
            Err(AppError::Other(format!(
                "测试替身无窗口: {}",
                window.label()
            )))
        }
        fn visibility(&self, window: WindowId) -> AppResult<crate::host::WindowVisibility> {
            Err(AppError::Other(format!(
                "测试替身无窗口: {}",
                window.label()
            )))
        }
        fn set_position(&self, window: WindowId, _x: i32, _y: i32) -> AppResult<()> {
            Err(AppError::Other(format!(
                "测试替身无窗口: {}",
                window.label()
            )))
        }
        fn open_devtools(&self, window: WindowId) -> AppResult<()> {
            Err(AppError::Other(format!(
                "测试替身无窗口: {}",
                window.label()
            )))
        }
    }

    struct FakeDialogs;

    impl FileDialogPort for FakeDialogs {
        fn pick_images(&self) -> AppResult<Vec<String>> {
            Ok(Vec::new())
        }
        fn pick_file(&self) -> AppResult<Option<String>> {
            Ok(None)
        }
        fn save_file(&self, _name: &str, _label: &str, _ext: &str) -> AppResult<Option<String>> {
            Ok(None)
        }
    }

    struct FakeLifecycle(Arc<AtomicUsize>);

    impl LifecyclePort for FakeLifecycle {
        fn exit(&self, _code: i32) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn restart(&self) -> AppResult<()> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    /// 在别的线程创建队列：测试线程不是「UI 主线程」且没有唤醒器，
    /// 凡触达原生 UI 的分派臂都会如实回「UI 尚未启动」，不会执行 AppKit/Win32。
    fn isolated_ui_handle() -> UiHandle {
        std::thread::spawn(|| UiHandle::new(MainThreadQueue::new()))
            .join()
            .unwrap()
    }

    struct TestEnv {
        dispatcher: NativeDispatcher,
        root: PathBuf,
        blobs: BlobRegistry,
        scope: RunScope,
        lifecycle_calls: Arc<AtomicUsize>,
    }

    impl TestEnv {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "deskpet-dispatch-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or(0)
            ));
            for dir in [
                "memory",
                "sessions",
                "personality",
                "profiles",
                "skills",
                "settings",
                "logs",
            ] {
                std::fs::create_dir_all(root.join(dir)).unwrap();
            }
            let paths = test_paths(&root);
            let lifecycle_calls = Arc::new(AtomicUsize::new(0));
            let dispatcher = NativeDispatcher::new(NativeDispatcherDeps {
                paths,
                caller: WindowId::Main,
                ui: isolated_ui_handle(),
                windows: Arc::new(FakeWindowPort),
                monitor: Arc::new(MonitorState::default()),
                mcp: Arc::new(mcp_bridge::McpPool::default()),
                bash: Arc::new(tool_exec::BashPool::default()),
                permits: Arc::new(tool_permit::ToolPermitPool::default()),
                dialogs: Arc::new(FakeDialogs),
                assets: Arc::new(NativeAssetScope::new()),
                lifecycle: Arc::new(FakeLifecycle(lifecycle_calls.clone())),
                host_link: Arc::new(HostLink::new()),
                audio: crate::audio::native_audio(isolated_ui_handle()),
            });
            Self {
                dispatcher,
                root,
                blobs: BlobRegistry::new(),
                scope: RunScope {
                    app_epoch: "test-epoch".into(),
                    node_epoch: 1,
                    ..Default::default()
                },
                lifecycle_calls,
            }
        }

        fn call(&self, method: &str, args: Value) -> AppResult<Value> {
            self.dispatcher
                .dispatch_with(method, args, &self.blobs, &self.scope)
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            // SQLite 文件在 Windows 上可能仍被句柄持有；清理失败不影响断言。
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn test_paths(root: &Path) -> AppPaths {
        AppPaths {
            data_root: root.to_path_buf(),
            memory: root.join("memory"),
            sessions: root.join("sessions"),
            personality: root.join("personality"),
            profiles: root.join("profiles"),
            skills: root.join("skills"),
            settings: root.join("settings"),
            logs: root.join("logs"),
            config_file: root.join("settings").join("CONFIG.yaml"),
            runtime_mode: "test",
            seed_personality_cards: root.join("seeds/personality/cards"),
            seed_profiles: root.join("seeds/profiles"),
            seed_skills: root.join("seeds/skills"),
        }
    }

    fn str_path(path: &Path) -> Value {
        Value::String(path.to_string_lossy().into_owned())
    }

    /// 从 `types.ts` 的 `HostCommandMap` 块里抽出命令名（行首恰好两格缩进的
    /// snake_case 键）。冻结件就是唯一清单，Rust 侧不再维护第二份拷贝。
    fn matrix_command_names() -> Vec<String> {
        const TYPES_TS: &str = include_str!("../../../../src/services/host/types.ts");
        let start = TYPES_TS
            .find("export type HostCommandMap = {")
            .expect("types.ts 必须包含 HostCommandMap");
        let rest = &TYPES_TS[start..];
        let end = rest
            .find("\n}\n")
            .expect("HostCommandMap 块必须有顶层结束括号");
        let mut names = Vec::new();
        for line in rest[..end].lines() {
            // 恰好两格缩进（更深缩进的 args/result 字段与注释不算键行）。
            let Some(candidate) = line.strip_prefix("  ") else {
                continue;
            };
            if candidate.starts_with(' ')
                || candidate.starts_with("//")
                || candidate.starts_with("*")
            {
                continue;
            }
            let Some((key, _)) = candidate.split_once(": ") else {
                continue;
            };
            if !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                names.push(key.to_string());
            }
        }
        names
    }

    // ── 矩阵覆盖（核心验收物）──

    #[test]
    fn types_ts的全部命令都有分派臂() {
        // 本用例对**每条命令**空参真调用一遍分派：其中 `apply_theme` 会走
        // `UiHandle::apply_theme` → `theme::store`（不经平台端口的进程级全局），
        // 与 `ui::theme` 的驻留断言共用同一份全局 —— 按那里的纪律拿同一把锁串行，
        // 否则会互踩出偶发红（空参收拢为默认主题，读方无感，写方互斥即可）。
        let _guard = crate::ui::theme::GLOBAL_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let names = matrix_command_names();
        // 计数以 `types.ts` 实际内容为准：MCP 桥裸行收发把 `mcp_send` 换成
        // `mcp_write` / `mcp_read`（净 +1），`profile_clone` 随「新建 Profile」改造删除
        // （-1），分项已复核为「107 冻结 + 21 扩展」。最近三条：设置页管理面
        // 带来的通用文件对话框 `pick_file_open` / `pick_file_save`（配置/资料导入导出与
        // Skill 上传选路径；图片过滤器的 `pick_profile_asset` 不适配）与自动呼出开关
        // `set_popup_auto_show`（`general.popup.autoPopupOnMessage`，宿主存 flag、由原生 UI
        // 自行裁决呼出）—— 补登记时一并把这条计数改到位。设置页 Card 管理本批追加
        // `personality_file_delete`（人格文件域删除，只删普通文件、拒绝链接叶子），
        // 分项随之变为「107 冻结 + 22 扩展」。
        // 本批追加 `memory_pending_source_count`（dreaming 开作业前查水位之后有无待处理来源；
        // 漏登记会让整理链条「跳过」变成未定义行为）—— 分项随之变为「107 冻结 + 23 扩展」。
        // 自带 MCP 批次追加凭据读写四条（`mcp_credential_set` / `_delete` / `_status` / `_get`：
        // 令牌存自有 SQLite、不写 CONFIG；漏登记会让「设置面写不进令牌」变成未知方法）
        // —— 分项随之变为「107 冻结 + 27 扩展」。
        // 本批追加 `chat_delete_session_images`（删会话连带清理托管聊天图片；漏登记会让
        // 删会话的图片清理成为未知方法，僵尸文件只能等 200 上限自然淘汰）—— 分项变为
        // 「107 冻结 + 28 扩展」。
        // 折叠批次追加 `session_write_text`（会话根专用写入路径：折叠结果超工具面 5 MiB
        // 时由它落地；漏登记会让折叠结果写不出去、`too-large` 无声回归）—— 分项变为
        // 「107 冻结 + 29 扩展」。
        // 会话原文索引追加五条 conversation_*，分项为「107 冻结 + 34 扩展」。
        assert_eq!(names.len(), 141, "HostCommandMap 条数（以 types.ts 为准）");
        for name in [
            "conversation_index_status",
            "conversation_index_replace",
            "conversation_index_prune",
            "conversation_search",
            "conversation_context",
        ] {
            assert!(
                names.contains(&name.to_string()),
                "新会话检索命令未登记: {name}"
            );
        }
        assert!(names.contains(&"init_memory_files".to_string()));
        assert!(names.contains(&"e2e_memory_reset".to_string()));
        // A2 追加的两条必须在分派面上（本测试只对账「有臂」，行为见下方专项测试）。
        assert!(names.contains(&"apply_chat_projection".to_string()));
        assert!(names.contains(&"apply_titlebar_status".to_string()));
        // 音频重建的两条（见上）：漏登记会让「UI 承诺了不存在的能力」。
        assert!(names.contains(&"audio_play_wav".to_string()));
        assert!(names.contains(&"ui_set_sound_cues".to_string()));
        // 主题批次追加的一条：`appearance.theme` 的 Node → 宿主下发。
        // 漏登记会让「设置页选的主题推送不进来」，界面永远停在默认主题。
        assert!(names.contains(&"apply_theme".to_string()));
        // 本批追加的文件对话框两条（见上）：漏登记会让「Node 承诺了不存在的选路径能力」。
        assert!(names.contains(&"pick_file_open".to_string()));
        assert!(names.contains(&"pick_file_save".to_string()));
        // 本批追加的自动呼出开关（见上）：漏登记会让「设置里开了开关但推送无声失败」。
        assert!(names.contains(&"set_popup_auto_show".to_string()));

        let env = TestEnv::new("matrix");
        for name in &names {
            let outcome = env.call(name, json!({}));
            if let Err(error) = outcome {
                let message = error.to_string();
                assert!(
                    !message.starts_with(OUTSIDE_MATRIX_PREFIX),
                    "命令 {name} 没有分派臂：{message}"
                );
            }
        }
    }

    #[test]
    fn 矩阵外的方法回明确错误而不是静默忽略() {
        let env = TestEnv::new("outside");
        let error = env.call("not_a_real_command", json!({})).unwrap_err();
        assert!(
            error.to_string().starts_with(OUTSIDE_MATRIX_PREFIX),
            "{error}"
        );
    }

    // ── 参数名逐字对齐（camelCase）──

    #[test]
    fn 参数名必须与矩阵逐字一致() {
        let env = TestEnv::new("argnames");
        // 必填参数的另一个大小写形态一律 CONFIG 错误（不是被忽略后走默认值）。
        let snake = env.call(
            "profile_file_write",
            json!({ "profile_id": "p1", "relative_path": "a.txt", "content": [1] }),
        );
        assert_eq!(snake.unwrap_err().code(), "CONFIG");
        let camel = env.call(
            "profile_file_write",
            json!({ "profileId": "p1", "relativePath": "a.txt", "content": [1] }),
        );
        assert!(camel.is_ok(), "{camel:?}");

        // 数值参数名逐字：limit（tool_permit_set_max_shared_readers）。
        let wrong = env.call("tool_permit_set_max_shared_readers", json!({ "max": 4 }));
        assert_eq!(wrong.unwrap_err().code(), "CONFIG");
        let right = env.call("tool_permit_set_max_shared_readers", json!({ "limit": 4 }));
        assert_eq!(right.unwrap(), json!(4));
    }

    // ── 文件读写与 blob 往返 ──

    #[test]
    fn 文件读写往返且二进制结果走blob通道() {
        let env = TestEnv::new("fs");
        let target = env.root.join("workspace/hello.txt");

        let written = env
            .call(
                "file_write",
                json!({ "path": str_path(&target), "content": "你好，桌宠", "maxBytes": null }),
            )
            .unwrap();
        assert_eq!(written, json!({ "success": true }));

        let read = env
            .call(
                "file_read",
                json!({ "path": str_path(&target), "maxBytes": null }),
            )
            .unwrap();
        assert_eq!(read["content"], json!("你好，桌宠"));
        assert_eq!(read["size"], json!(15));

        let exists = env
            .call("file_exists", json!({ "path": str_path(&target) }))
            .unwrap();
        assert_eq!(exists, json!(true));

        // 二进制结果：结果是 $hostBlobRef 标记，句柄内容与写入字节一致。
        let marker = env
            .call("file_read_binary", json!({ "path": str_path(&target) }))
            .unwrap();
        let blob = parse_host_blob_marker(&marker).expect("二进制结果必须是 blob 标记");
        assert_eq!(blob.scope.app_epoch, env.scope.app_epoch);
        let bytes = env.blobs.open_read(&blob.id, &env.scope).unwrap();
        assert_eq!(&bytes[..], "你好，桌宠".as_bytes());
    }

    #[test]
    fn profile与人格文件的字节参数从数字数组解码() {
        let env = TestEnv::new("bytes");

        // 模拟桥物化后的 `$wireBlob`：content 是 JSON number 数组。
        let written = env
            .call(
                "profile_file_write",
                json!({
                    "profileId": "sugar-pink",
                    "relativePath": "materials/L0/body.bin",
                    "content": [0, 1, 2, 255]
                }),
            )
            .unwrap();
        assert_eq!(written, Value::Null);
        let marker = env
            .call(
                "profile_file_read",
                json!({ "profileId": "sugar-pink", "relativePath": "materials/L0/body.bin" }),
            )
            .unwrap();
        let blob = parse_host_blob_marker(&marker).unwrap();
        assert_eq!(
            &env.blobs.open_read(&blob.id, &env.scope).unwrap()[..],
            &[0, 1, 2, 255]
        );

        // 越界字节值如实报错，不截断。
        let bad = env.call(
            "personality_file_write",
            json!({ "path": "stages/x.json", "content": [256] }),
        );
        assert_eq!(bad.unwrap_err().code(), "CONFIG");

        let absolute = env
            .call(
                "personality_file_write",
                json!({ "path": "stages/x.json", "content": [123, 34, 125] }),
            )
            .unwrap();
        let absolute = std::path::PathBuf::from(absolute.as_str().unwrap());
        assert!(
            absolute.ends_with(Path::new("personality").join("stages").join("x.json")),
            "{absolute:?}"
        );

        let marker = env
            .call("personality_file_read", json!({ "path": "stages/x.json" }))
            .unwrap();
        let blob = parse_host_blob_marker(&marker).unwrap();
        assert_eq!(
            &env.blobs.open_read(&blob.id, &env.scope).unwrap()[..],
            b"{\"}"
        );

        let list = env
            .call("personality_file_list", json!({ "dirPath": "stages" }))
            .unwrap();
        assert_eq!(list, json!(["x.json"]));
    }

    // ── 路径与配置 ──

    #[test]
    fn 运行时路径解析与越权拒绝() {
        let env = TestEnv::new("paths");
        let resolved = env
            .call(
                "resolve_runtime_path",
                json!({ "scope": "sessions", "segments": ["a", "b.json"] }),
            )
            .unwrap();
        let expected = env
            .root
            .join("sessions")
            .join("a")
            .join("b.json")
            .to_string_lossy()
            .into_owned();
        assert_eq!(resolved, Value::String(expected));

        let escape = env.call(
            "resolve_runtime_path",
            json!({ "scope": "sessions", "segments": [".."] }),
        );
        assert_eq!(escape.unwrap_err().code(), "PATH_ESCAPE");
        let unknown = env.call(
            "resolve_runtime_path",
            json!({ "scope": "nope", "segments": [] }),
        );
        assert!(unknown.is_err());

        let paths = env.call("get_runtime_paths", json!({})).unwrap();
        assert_eq!(paths["runtimeMode"], json!("test"));
        assert!(paths["configFile"]
            .as_str()
            .unwrap()
            .ends_with("CONFIG.yaml"));
    }

    #[test]
    fn 会话ui状态读写往返() {
        let env = TestEnv::new("session-ui");
        assert_eq!(
            env.call("read_session_ui_state", json!({})).unwrap(),
            Value::Null
        );
        env.call(
            "write_session_ui_state",
            json!({ "content": "{\"active\":null}" }),
        )
        .unwrap();
        assert_eq!(
            env.call("read_session_ui_state", json!({})).unwrap(),
            json!("{\"active\":null}")
        );
    }

    // ── 错误保真 ──

    #[test]
    fn 结构化错误码不经分派层退化() {
        let env = TestEnv::new("errors");
        // 凭据路径：词法优先，路径不存在也报 SENSITIVE_PATH。
        let sensitive = env
            .call(
                "file_read",
                json!({ "path": str_path(&env.root.join(".ssh/id_rsa")) }),
            )
            .unwrap_err();
        assert_eq!(sensitive.code(), "SENSITIVE_PATH");

        let missing = env
            .call("session_read_text", json!({ "path": "missing.jsonl" }))
            .unwrap_err();
        assert_eq!(missing.code(), "PATH_NOT_FOUND");

        let escape = env
            .call("session_read_text", json!({ "path": "../outside.jsonl" }))
            .unwrap_err();
        assert_eq!(escape.code(), "PATH_ESCAPE");

        // 已知有消费者按码分支的 MEMORY_CONFLICT 由域实现透出（此处验证未知 id 不 panic 且走结构化错误）。
        let bad_restore = env
            .call("memory_restore", json!({ "backupPath": "nope.sqlite3" }))
            .unwrap_err();
        assert_eq!(bad_restore.code(), "PATH_NOT_FOUND");
    }

    // ── 记忆：惰性打开 + actor 门禁映射 ──

    #[test]
    fn 记忆命令惰性打开存储且往返结构化() {
        let env = TestEnv::new("memory");
        let initialized = env.call("init_memory_files", json!({})).unwrap();
        assert_eq!(
            initialized,
            Value::String(env.root.join("memory").to_string_lossy().into_owned())
        );

        let status = env.call("memory_status", json!({})).unwrap();
        assert!(status["revision"].is_i64(), "{status}");
        let base = status["revision"].as_i64().unwrap();

        let revision = env
            .call(
                "memory_apply_change",
                json!({
                    "operationId": "test-clear",
                    "baseRevision": base,
                    "action": "clear",
                    "actor": "internal",
                    "conversationFences": []
                }),
            )
            .unwrap();
        assert!(revision.is_i64());

        let listed = env.call("memory_list", json!({ "limit": 10 })).unwrap();
        assert_eq!(listed, json!([]));
        assert_eq!(
            env.call("memory_detail", json!({ "id": "nope" })).unwrap(),
            Value::Null
        );
    }

    // ── MCP 凭据：分派臂、camelCase 参数与「状态不回值」 ──

    #[test]
    fn mcp凭据命令往返且状态不回值() {
        let env = TestEnv::new("mcp-credentials");
        env.call(
            "mcp_credential_set",
            json!({ "server": "github", "var": "GITHUB_TOKEN", "value": "probe-token" }),
        )
        .unwrap();
        assert_eq!(
            env.call(
                "mcp_credential_get",
                json!({ "server": "github", "var": "GITHUB_TOKEN" })
            )
            .unwrap(),
            json!("probe-token")
        );
        // 名单命令只回变量名：值不得出现在 status 回执里。
        let status = env
            .call("mcp_credential_status", json!({ "server": "github" }))
            .unwrap();
        assert_eq!(status, json!(["GITHUB_TOKEN"]));
        assert!(!status.to_string().contains("probe-token"), "{status}");
        // 未设置也是成功回执（null），由 Node 按「变量缺失」如实失败。
        assert_eq!(
            env.call(
                "mcp_credential_get",
                json!({ "server": "github", "var": "OTHER" })
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(
            env.call(
                "mcp_credential_delete",
                json!({ "server": "github", "var": "GITHUB_TOKEN" })
            )
            .unwrap(),
            json!(true)
        );
        assert_eq!(
            env.call(
                "mcp_credential_delete",
                json!({ "server": "github", "var": "GITHUB_TOKEN" })
            )
            .unwrap(),
            json!(false)
        );
        // 空值拒绝走结构化 CONFIG（不静默存空、不折成成功）。
        assert_eq!(
            env.call(
                "mcp_credential_set",
                json!({ "server": "github", "var": "GITHUB_TOKEN", "value": "   " })
            )
            .unwrap_err()
            .code(),
            "CONFIG"
        );
    }

    #[test]
    fn 记忆actor映射与既定窗口门禁一致() {
        // 主窗：LLM 记忆工具（绑定可信用户输入）。
        assert_eq!(
            memory_change_window_label(WindowId::Main, "current_input", "add", None).unwrap(),
            "main"
        );
        // 主窗：聊天气泡「记住这条」= user_ui_current（add + 可信会话）。
        assert_eq!(
            memory_change_window_label(WindowId::Main, "user_ui", "add", Some("s-1")).unwrap(),
            "main"
        );
        // 设置面治理动作（纠正/忘记/核心画像）。
        assert_eq!(
            memory_change_window_label(WindowId::Main, "user_ui", "update", None).unwrap(),
            "settings"
        );
        assert_eq!(
            memory_change_window_label(WindowId::Main, "internal", "clear", None).unwrap(),
            "main"
        );
        // E2E 隔离宿主：只放行 internal。
        assert_eq!(
            memory_change_window_label(WindowId::E2e, "internal", "clear", None).unwrap(),
            "e2e"
        );
        let error =
            memory_change_window_label(WindowId::E2e, "current_input", "add", None).unwrap_err();
        assert_eq!(error.code(), "MEMORY");
        // 未知 actor 不放宽。
        let error = memory_change_window_label(WindowId::Main, "chat", "add", None).unwrap_err();
        assert_eq!(error.code(), "MEMORY");
    }

    // ── 测试命令护栏 ──

    #[test]
    fn e2e命令在非隔离宿主如实拒绝() {
        let env = TestEnv::new("e2e");
        assert_eq!(
            env.call("e2e_memory_reset", json!({})).unwrap_err().code(),
            "CONFIG"
        );
        assert_eq!(
            env.call("e2e_memory_performance", json!({ "count": 1000 }))
                .unwrap_err()
                .code(),
            "CONFIG"
        );
        // 宿主级测试协议：明确报「E2E 私有」，不是「矩阵外」。
        let error = env.call("e2e_options", json!({})).unwrap_err();
        assert!(!error.to_string().starts_with(OUTSIDE_MATRIX_PREFIX));
        assert_eq!(error.code(), "CONFIG");
    }

    // ── 生命周期与宿主请求回执 ──

    #[test]
    fn 重启命令走生命周期端口且回执按请求号结算() {
        let env = TestEnv::new("restart");
        assert_eq!(env.call("app_restart", json!({})).unwrap(), Value::Null);
        assert_eq!(
            env.lifecycle_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );

        // 未知请求号：按「已超时」归宿丢弃并留痕，不作为错误上报。
        let late = env.call(
            "host_request_result",
            json!({ "requestId": 999, "ok": true, "result": {} }),
        );
        assert_eq!(late.unwrap(), Value::Null);

        // ok=false 缺 error.code 时按 OTHER 保底，且不 panic。
        let failed = env.call(
            "host_request_result",
            json!({ "requestId": 1, "ok": false }),
        );
        assert!(failed.is_ok());
    }

    #[test]
    fn 未接通的窗口命令如实报错而不是伪造成功() {
        let env = TestEnv::new("windows");
        // 观察快照对窗口读取失败按「不可见/非前台」的既有语义降级（monitor/visibility.rs），
        // 但命令本身仍要成功返回快照。
        let activity = env.call("get_runtime_activity", json!({})).unwrap();
        assert_eq!(activity["isPetVisible"], json!(false));

        // 直接依赖窗口端口的命令：端口失败必须如实透出，不伪造成功。
        assert!(env.call("enhance_settings_window", json!({})).is_err());
        assert!(env.call("enhance_layer_editor_window", json!({})).is_err());
        assert!(env.call("open_devtools", json!({})).is_err());
        // compute_popup_position 的窗口增强失败只留痕（不升级为错误），但参数缺省仍必须报错。
        assert_eq!(
            env.call("compute_popup_position", json!({}))
                .unwrap_err()
                .code(),
            "CONFIG"
        );
    }

    // ── A2：会话投影与顶栏状态推送 ──

    #[test]
    fn 会话投影走整帧解析臂且失败如实报错() {
        let env = TestEnv::new("a2-projection");
        // 合法会话侧帧：解析成功并落到聊天单例（测试环境无 UI 队列，只留痕不报错）。
        let applied = env
            .call(
                "apply_chat_projection",
                json!({
                    "sessionId": "s1",
                    "sessions": [{"id": "s1", "name": "新会话", "createdAt": 0, "interrupted": false}]
                }),
            )
            .unwrap();
        assert_eq!(applied, Value::Null);

        // 缺 sessionId：如实报解析错误（不是矩阵外、不静默丢帧）。
        let broken = env
            .call("apply_chat_projection", json!({ "sessions": [] }))
            .unwrap_err();
        assert!(
            broken.to_string().contains("聊天读模型投影解析失败"),
            "{broken}"
        );
        assert_eq!(broken.code(), "OTHER");
    }

    #[test]
    fn 顶栏状态推送未启动ui时如实报错() {
        let env = TestEnv::new("a2-titlebar");
        // 本测试环境原生 UI 未启动（隔离队列无唤醒器）：平台刷新如实报错，
        // 与其它窗口命令同一口径，不伪造成功。文本/空白回落语义由
        // `ui/titlebar.rs` 的单测覆盖；这里只验证分派臂的参数与透出。
        let outcome = env.call("apply_titlebar_status", json!({ "text": null }));
        let error = outcome.unwrap_err();
        assert!(
            !error.to_string().starts_with(OUTSIDE_MATRIX_PREFIX),
            "{error}"
        );
    }
}
