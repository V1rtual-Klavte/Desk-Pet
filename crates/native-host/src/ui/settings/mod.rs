//! 原生设置窗域（W9a）：表单 schema、草稿/提交模型、与 Node 的设置端口。
//!
//! W9d 增补**管理面**（`panels.rs`）：工具页的 MCP / Skill / 工具策略与记忆页的
//! 条目浏览 / 纠正 / 遗忘 / 整理作业。管理面数据同样只来自 Node（端口新方法），
//! 窗口只持不可变快照 + 未保存的内容草稿，关窗即释放；写操作走既有领域入口。
//!
//! 权属划分（执行契约 §6.4、§2.2）：
//! - **CONFIG 仍是唯一真相源**，由 Node 的类型化 getter 读取/写入；Rust 不读 CONFIG、
//!   不复制默认值。本域只持有**不可变显示快照 + 临时草稿**（草稿只活到窗口关闭，
//!   不落盘、不进 localStorage 体系的对应物）。
//! - [`SettingsPort`] 是唯一数据口：`fetch` 拉快照、`commit` 提交改动、`check_update`
//!   走手动检查更新（W10b 的 UpdatePort 就绪前，这里保留入口与端口）。
//!   端口未注入时如实报「未接线」，不伪造成功、不显示假值。
//! - 系统字体枚举走既有 Rust 命令（`commands::font_cmd::list_system_fonts`），
//!   只在窗口打开时枚举一次并缓存；关闭窗口不保留控件与列表（§6.4 的资源纪律）。
//!
//! 线程纪律：控件动作都在 UI 主线程；`fetch`/`commit`/`check_update` 是可能阻塞的
//! IO（IPC/文件），一律在工作线程执行，结果经主线程队列回投。
//!
//! 文件划分（T2.8）：本文件只留声明、`PanelState` / `SettingsUi` 的数据 shape 与
//! 进程级单例；`types.rs` 收数据 type / 端口 / 校验 / 草稿，`documents.rs` 收行编辑
//! 文档与备份投影，`ui.rs` 收 `SettingsUi` 的行为与面板逻辑（分页/快捷键纯函数
//! 因防碎片化并入 `ui.rs`）。公开取用路径仍经本文件的 `pub use` 保持不变。

pub(crate) mod layout;
pub mod panels;
pub mod schema;
pub mod updates;

mod documents;
mod types;
mod ui;

#[cfg(test)]
mod test_support;

pub use documents::{memory_backup_hint, resolve_backup_selection};
pub use types::*;
pub use ui::{
    clamp_memory_page, dynamic_field_hint, info_text, memory_page_bounds, memory_page_count,
    memory_pager, resolve_option_selection, shortcut_parts, tab_index_for_tag, write_shortcut,
    MEMORY_PAGE_SIZE,
};

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use crate::ui::MainThreadQueue;

use panels::{MemoryDetail, MemoryOverview, PanelRow};

/// 管理面（W9d）的数据快照：工具页与记忆页的动态列表 / 详情。
///
/// 只持**不可变显示快照 + 未保存的内容草稿**；窗口关闭即整体释放（§6.4 资源纪律），
/// 不落盘、不跨窗口保留。`generation` 每次数据变化 +1，平台层据此重建面板控件
/// （schema 控件不受影响，编辑中的文本框不会被管理面刷新打断）。
#[derive(Default)]
struct PanelState {
    tools_loading: bool,
    tools_loaded: bool,
    mcp: Vec<PanelRow>,
    mcp_error: Option<String>,
    skills: Vec<PanelRow>,
    skills_error: Option<String>,
    /// Skill 目录索引告警（成功读取的诊断，与 `skills_error` 不同形）。
    skills_index_error: Option<String>,
    policies: Vec<PanelRow>,
    policies_error: Option<String>,
    /// 外观页：音效事件试听行。
    sounds_loading: bool,
    sounds_loaded: bool,
    sounds: Vec<PanelRow>,
    sounds_error: Option<String>,

    memory_loading: bool,
    memory_loaded: bool,
    memory_error: Option<String>,
    memory: Option<MemoryOverview>,
    detail: Option<MemoryDetail>,
    detail_loading: bool,
    detail_error: Option<String>,
    /// 详情文本框里未保存的内容草稿（空串也是有效草稿；保存成功/换条目时清空）。
    content_draft: Option<String>,
    /// 展开中的来源原话（同时最多一条；换条目时清空）。
    evidence: Option<panels::MemoryEvidenceState>,
    /// 托管备份列表（行 = 一份备份；选择态由 UI 叠加）。
    backups: Vec<PanelRow>,
    backups_loaded: bool,
    backups_loading: bool,
    backups_error: Option<String>,
    /// 当前选中的备份路径（预览/应用的作用对象；缺省与失效时回退最新一份）。
    backup_selected: Option<String>,
    /// 「已记住」列表现页（1 起；0 = 尚未设置，读取时按第 1 页收口）。
    /// 范围筛选取值变化回第 1 页；数据刷新后总页数变小则 clamp（保持页、不无脑回第 1 页）。
    memory_page: usize,

    generation: u64,
}

/// 进程级设置 UI 单例。
pub struct SettingsUi {
    port: Mutex<Arc<dyn SettingsPort>>,
    draft: Mutex<SettingsDraft>,
    queue: OnceLock<Arc<MainThreadQueue>>,
    window_open: AtomicBool,
    /// 设置快照拉取在途（与字体枚举分开：两者可能同时进行）。
    loading: AtomicBool,
    /// 字体族枚举在途。
    fonts_loading: AtomicBool,
    saving: AtomicBool,
    connected: AtomicBool,
    notice: Mutex<Option<String>>,
    /// 当前通知的档位（与 `notice` 同步写）。
    notice_level: Mutex<NoticeLevel>,
    /// 通知代际（见 [`SettingsView::notice_generation`]）。
    notice_generation: Mutex<u64>,
    font_families: Mutex<Option<Arc<Vec<String>>>>,
    /// 人格卡选项在途（与字体枚举分开：两者可能同时进行）。
    cards_loading: AtomicBool,
    card_options: Mutex<Option<Arc<Vec<CardOption>>>>,
    /// Profile 选项在途（与人格卡分开：外观页与 AI 页各自拉取）。
    profiles_loading: AtomicBool,
    profile_options: Mutex<Option<Arc<Vec<ProfileOption>>>>,
    /// 管理面数据（W9d）。
    panels: Mutex<PanelState>,
    /// 记忆治理变更在途（同一时刻只提交一个，避免连点并发写同一库）。
    memory_change_in_flight: AtomicBool,
    /// 本批：行编辑文档（V1RTUAL / 阶段文案 / 音效 / MCP / 只读预览）。
    document: Mutex<Option<DocumentState>>,
    /// 本批：记忆范围筛选（None = 全部；值域 user/session，session 的 id 由 Node 补激活值）。
    memory_scope: Mutex<Option<String>>,
    /// 本批：文档保存/加载在途（同一时刻只跑一个，避免连点并发写同一文件）。
    document_in_flight: AtomicBool,
}

static SETTINGS_UI: OnceLock<SettingsUi> = OnceLock::new();
/// 手动静默了解的单飞闩：上一批结束前，设置页按钮不重复触发。
static SILENT_OBSERVATION_RUNNING: AtomicBool = AtomicBool::new(false);

/// 进程级单例。
pub fn settings_ui() -> &'static SettingsUi {
    SETTINGS_UI.get_or_init(SettingsUi::new)
}

/// 平台在 UI 启动时安装主线程队列（跨线程刷新调度需要唤醒主循环）。
pub fn install_main_queue(queue: Arc<MainThreadQueue>) {
    settings_ui().install_main_queue(queue);
}

/// 注入设置端口（Node 设置接线就绪后调用；未注入时界面如实显示「未接线」）。
pub fn install_port(port: Arc<dyn SettingsPort>) {
    settings_ui().install_port(port);
}
