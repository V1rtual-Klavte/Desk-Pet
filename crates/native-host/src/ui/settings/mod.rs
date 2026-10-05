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

pub mod panels;
pub mod schema;
pub mod updates;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::error::{AppError, AppResult};
use crate::ui::font::{self, FontSnapshot};
use crate::ui::MainThreadQueue;
use crate::{rust_debug, rust_info, rust_warn};

use panels::{
    ListPanel, MemoryChange, MemoryChangeAction, MemoryDetail, MemoryDetailState, MemoryOverview,
    PanelRow, RowAction,
};
use schema::{field, FieldKind};

/// 设置值。形状与控件一一对应：枚举以 `Text` 承载（值必须命中 schema 的选项）。
#[derive(Debug, Clone, PartialEq)]
pub enum SettingsValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

impl SettingsValue {
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(*value),
            _ => None,
        }
    }
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(value) => Some(value),
            _ => None,
        }
    }
}

/// Node 推送的整表快照（键 → 值）。缺键 = 该字段未配置（控件显示为未设置）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsSnapshot {
    pub values: BTreeMap<String, SettingsValue>,
}

/// 一次提交的单个改动。
#[derive(Debug, Clone, PartialEq)]
pub struct SettingEdit {
    pub key: String,
    pub value: SettingsValue,
}

/// 一个人格卡（Card）选项（`FieldKind::CardChoice` 的选项来源）。
///
/// 数据来自 Node 的人格注册表（不是 CONFIG 副本）：`cards()` 每次窗口打开时取一次，
/// 关闭释放（§6.4 的资源纪律）。`id` 是切换的唯一键，`name` 只作展示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardOption {
    pub id: String,
    pub name: String,
}

/// 一个激活 Profile 选项（`FieldKind::ProfileChoice` 的选项来源）。
///
/// 数据来自 Node 的 Profile 域（`discoverAllProfiles` + `readProfileMeta`，不是 CONFIG
/// 副本）：`profiles()` 每次窗口打开时取一次，关闭释放。`id` 是切换的唯一键。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileOption {
    pub id: String,
    pub name: String,
    pub description: String,
}

// ── 本批管理面的值类型（内容与格式都由 Node 定义，Rust 只显示与回传）──

/// 主动消息开关的权威快照（真相源在宿主 SQLite，经 Node 的控制通道读写）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProactiveSnapshot {
    pub enabled: bool,
    pub revision: i64,
}

/// 当前卡阶段文案（`text` 是行编辑格式，Node 侧定义与校验）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardStages {
    pub card_id: String,
    pub fallback: bool,
    pub text: String,
}

/// 变量池只读预览（`text` 是 Node 组装的展示文本）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardVariablePool {
    pub card_id: Option<String>,
    pub text: String,
}

/// 音效库（逐事件分配行）。
///
/// 行是「事件 + 行内下拉」形态：`id` = 事件键（写回时原样回传），
/// `pick.options` = 可选音效（含 `none` 静音）、`pick.selected` = 当前分配；
/// 「试听」是次动作（`RowAction::Preview`，播放当前分配）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoundLibrary {
    pub rows: Vec<PanelRow>,
}

/// MCP 服务器编辑文档（`name` 缺省时是新建模板）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerDoc {
    pub text: String,
}

/// Profile 管理动作（新建/重命名/删除/导出/导入/恢复默认资源）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileManageOp {
    /// 新建空 Profile（无参数：新 id 与默认名由 Node 按现有目录取最小未占用序号）。
    Create,
    /// 重命名（id + 新显示名；id 在动作入口按当前选中项解析，不在这里猜）。
    Rename { profile_id: String, name: String },
    Delete(String),
    Export(String),
    Import,
    RestoreDefaults,
}

/// Profile 管理结果：中性说明 + 操作后的可用列表（列表是 Node 的权威投影）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileManageOutcome {
    pub message: String,
    pub profiles: Vec<ProfileOption>,
    /// 仅新建：新 Profile 的 id（宿主据此把草稿选中项指向新项）。
    pub new_id: Option<String>,
}

/// Card 管理动作（新建/重命名/删除/导出/导入）。
///
/// 与 Profile 同口径：id 在动作入口按当前选中卡解析，空 id 不在这里猜；导入的 id 取自
/// 卡片 frontmatter，由 Node 校验。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardManageOp {
    /// 新建：显示名由用户在原生输入框里给，id 由 Node 从显示名推导（撞名自动加后缀）。
    Create { name: String },
    /// 重命名：只改 frontmatter 的显示名，文件名、阶段文案与变量状态都不动。
    Rename { card_id: String, name: String },
    Delete(String),
    Export(String),
    Import,
}

/// Card 管理结果：中性说明 + 操作后的可用列表（列表是 Node 的权威投影）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardManageOutcome {
    pub message: String,
    pub cards: Vec<CardOption>,
    /// 仅新建：新卡的 id（宿主据此把草稿选中项指向新卡）。
    pub new_id: Option<String>,
    /// 操作后运行时仍在激活的卡（空 = 当前没有激活卡，无活动 Card 的降级态是允许的）。
    /// 草稿选中项被删掉时用它回落，避免保存时拿一个不存在的 id 去切换。
    pub active_id: String,
}

/// 记忆维护动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryMaintenanceOp {
    Backup,
    Export,
    RebuildIndex,
}

/// 行编辑文档的目标（保存/重新加载走哪个端口方法；文本格式由 Node 定义与校验）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentTarget {
    /// V1RTUAL.md 用户指令（可编辑）。
    V1rtual,
    /// 当前卡阶段文案（可编辑；可重新生成）。
    CardStages,
    /// 当前卡本体 markdown（可编辑：角色设定、语言风格、输出规则、行为进阶、变量定义）。
    CardMarkdown,
    /// Card 作者模版（只读：提示词全文，供复制给外部 AI 生成新卡）。
    CardTemplate,
    /// MCP 服务器编辑（`name` 空 = 新建模板；内置只允许改 args/env）。
    McpServer { name: String },
    /// 变量池只读预览。
    VariablePool,
    /// 记忆来源原话（只读回看）。
    MemoryEvidence,
}

impl DocumentTarget {
    pub fn is_read_only(&self) -> bool {
        matches!(
            self,
            Self::VariablePool | Self::MemoryEvidence | Self::CardTemplate
        )
    }
}

/// 当前打开的文档（标题 + Node 已提交文本 + 加载/只读状态）。
///
/// 未保存编辑由平台控件持有（关闭/切换时丢弃，与设置草稿同一条纪律）；本结构只在
/// 数据刷新与保存成功时被替换。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentState {
    pub title: String,
    pub target: DocumentTarget,
    /// Node 提供的已提交文本；`loaded=false` 时是空串（界面显示「读取中…」）。
    pub content: String,
    pub loaded: bool,
}

/// 设置数据端口（W4/设置接线实现）。
///
/// 实现方必须遵守：
/// - `fetch` 返回的键必须来自 CONFIG 的现值（读什么回什么），不补默认值；
/// - `commit` 走 CONFIG 的既有原子保存路径（`write_runtime_config` 一侧），
///   写盘失败必须如实返回错误；
/// - `cards` 返回人格注册表的可用 Card（切换由 Node 走注册表唯一入口，界面不自己拼）；
/// - `check_update` 触发与通用页「检查更新」按钮同一入口（W10b 起接 UpdatePort）。
pub trait SettingsPort: Send + Sync {
    fn fetch(&self) -> AppResult<SettingsSnapshot>;
    fn commit(&self, changes: &[SettingEdit]) -> AppResult<()>;
    fn check_update(&self) -> AppResult<()>;
    /// 可选能力：未接线时如实报错（界面显示「未接线」，不伪造空列表）。
    fn cards(&self) -> AppResult<Vec<CardOption>> {
        Err(AppError::Other(
            "人格卡列表端口未接线（Node 人格注册表接线就绪后生效）".into(),
        ))
    }

    /// 外观页：激活 Profile 选项（选项来自 Node 的 Profile 域，不是 CONFIG 副本；
    /// 切换由 Node 走 `switchActiveProfile` 唯一入口）。
    fn profiles(&self) -> AppResult<Vec<ProfileOption>> {
        Err(AppError::Other(
            "Profile 列表端口未接线（Node Profile 域接线就绪后生效）".into(),
        ))
    }

    // ── 管理面（W9d，全部可选；未接线时如实报错，界面不显示假列表）──
    //
    // 写操作不发明新语义：MCP 开关走既有 CONFIG 写路径 + 原子写盘，Skill 开关走既有
    // frontmatter 写入口，记忆纠正/遗忘走既有 `memory_apply_change`（actor/信任门槛
    // 在 Node 与 Rust 既有门禁内，端口不放宽）。

    /// 工具页：MCP 服务器行（内置 + 自定义；`id` = 服务器名）。
    fn mcp_servers(&self) -> AppResult<Vec<PanelRow>> {
        Err(AppError::Other(
            "MCP 服务器列表端口未接线（Node 管理面接线就绪后生效）".into(),
        ))
    }

    /// 工具页：逐项开关一个 MCP 服务器（走既有写入口，含「服务器正被占用」拒绝）。
    fn set_mcp_server_enabled(&self, _name: &str, _enabled: bool) -> AppResult<()> {
        Err(AppError::Other("MCP 服务器开关端口未接线".into()))
    }

    /// 工具页：Skill 清单（`id` = skills 域内相对路径）。
    fn skills(&self) -> AppResult<panels::SkillCatalog> {
        Err(AppError::Other(
            "Skill 清单端口未接线（Node 管理面接线就绪后生效）".into(),
        ))
    }

    /// 工具页：逐项开关一个 Skill（写 frontmatter `enabled`；未收录/无 frontmatter 如实报错）。
    fn set_skill_enabled(&self, _relative_path: &str, _enabled: bool) -> AppResult<()> {
        Err(AppError::Other("Skill 开关端口未接线".into()))
    }

    /// 工具页：工具策略声明表（只读；PermissionKernel 仍是唯一终裁）。
    fn tool_policies(&self) -> AppResult<Vec<PanelRow>> {
        Err(AppError::Other(
            "工具策略端口未接线（Node 管理面接线就绪后生效）".into(),
        ))
    }

    /// 记忆页：库总览（状态 + 条目 + 整理作业）。
    ///
    /// `scope`/`scope_id` 是可选范围筛选（user/card/session；card/session 的具体 id
    /// 由 Node 补激活值），只影响条目列表。
    fn memory_overview(
        &self,
        _scope: Option<&str>,
        _scope_id: Option<&str>,
    ) -> AppResult<MemoryOverview> {
        Err(AppError::Other(
            "记忆库端口未接线（Node 管理面接线就绪后生效）".into(),
        ))
    }

    /// 记忆页：条目详情 + 历史版本（`id` 不存在时如实报错，不返回空详情）。
    fn memory_item_detail(&self, _id: &str) -> AppResult<MemoryDetail> {
        Err(AppError::Other("记忆详情端口未接线".into()))
    }

    /// 记忆页：一次治理变更（纠正/核心画像标记/遗忘），返回提交后的新 revision。
    fn memory_change(&self, _change: &MemoryChange) -> AppResult<i64> {
        Err(AppError::Other("记忆变更端口未接线".into()))
    }

    // ── 本批管理面（全部可选；未接线如实报错，界面不显示假值）──

    /// 通用页「↺ 默认」：内置 CONFIG 模板的整表投影（默认值的唯一真值点在 Node）。
    fn defaults(&self) -> AppResult<SettingsSnapshot> {
        Err(AppError::Other("默认值端口未接线".into()))
    }

    /// 通用页「导出配置」：Node 弹保存对话框并写盘；取消返回 `Ok(None)`。
    fn export_config(&self) -> AppResult<Option<String>> {
        Err(AppError::Other("配置导出端口未接线".into()))
    }

    /// 通用页「导入配置」：Node 弹打开对话框、校验后替换 CONFIG 并写盘；取消返回 `Ok(false)`。
    fn import_config(&self) -> AppResult<bool> {
        Err(AppError::Other("配置导入端口未接线".into()))
    }

    /// AI 页：主动开关（`None` = 只读查询；处理走 scanner 的控制通道）。
    fn proactive_control(&self, _enabled: Option<bool>) -> AppResult<ProactiveSnapshot> {
        Err(AppError::Other("主动开关端口未接线".into()))
    }

    /// AI 页：读取 V1RTUAL.md 的用户指令文本。
    fn v1rtual_read(&self) -> AppResult<String> {
        Err(AppError::Other("V1RTUAL 指令端口未接线".into()))
    }

    /// AI 页：全量写入 V1RTUAL.md 用户指令。
    fn v1rtual_write(&self, _content: &str) -> AppResult<()> {
        Err(AppError::Other("V1RTUAL 指令端口未接线".into()))
    }

    /// AI 页：阶段文案读取（`card_id` 缺省 = 激活卡）。
    fn card_stages_read(&self, _card_id: Option<&str>) -> AppResult<CardStages> {
        Err(AppError::Other("阶段文案端口未接线".into()))
    }

    /// AI 页：阶段文案保存（Node 解析行格式并校验后写 stages 文件）。
    fn card_stages_write(&self, _card_id: Option<&str>, _text: &str) -> AppResult<()> {
        Err(AppError::Other("阶段文案端口未接线".into()))
    }

    /// AI 页：阶段文案重新生成。
    fn card_stages_regenerate(&self, _card_id: Option<&str>) -> AppResult<CardStages> {
        Err(AppError::Other("阶段文案端口未接线".into()))
    }

    /// AI 页：变量池只读预览。
    fn card_variable_pool(&self, _card_id: Option<&str>) -> AppResult<CardVariablePool> {
        Err(AppError::Other("变量池端口未接线".into()))
    }

    /// AI 页：Card 管理动作（新建/重命名/删除/导出/导入）。
    fn card_manage(&self, _op: &CardManageOp) -> AppResult<CardManageOutcome> {
        Err(AppError::Other("Card 管理端口未接线".into()))
    }

    /// AI 页：Card 本体 markdown 读取（`card_id` 缺省 = 当前选中卡）。
    fn card_markdown_read(&self, _card_id: Option<&str>) -> AppResult<String> {
        Err(AppError::Other("Card 文档端口未接线".into()))
    }

    /// AI 页：Card 本体 markdown 保存（Node 解析校验后按原路径写回）。
    fn card_markdown_write(&self, _card_id: Option<&str>, _text: &str) -> AppResult<()> {
        Err(AppError::Other("Card 文档端口未接线".into()))
    }

    /// AI 页：Card 作者模版全文（只读提示词，供复制给外部 AI）。
    fn card_template(&self) -> AppResult<String> {
        Err(AppError::Other("Card 模版端口未接线".into()))
    }

    /// 外观页：Profile 管理动作（复制/删除/导出/导入/恢复默认资源）。
    fn profile_manage(&self, _op: &ProfileManageOp) -> AppResult<ProfileManageOutcome> {
        Err(AppError::Other("Profile 管理端口未接线".into()))
    }

    /// 外观页：音效库（逐事件分配行；选项与选中值都在行里）。
    fn sound_library(&self) -> AppResult<SoundLibrary> {
        Err(AppError::Other("音效库端口未接线".into()))
    }

    /// 外观页：单个事件的音效分配写回（`sound_id = "none"` 表示静音）。
    fn sound_set_assignment(&self, _event: &str, _sound_id: &str) -> AppResult<()> {
        Err(AppError::Other("音效分配端口未接线".into()))
    }

    /// 外观页：清空分配覆盖，全部事件回内置默认。
    fn sound_reset(&self) -> AppResult<()> {
        Err(AppError::Other("音效分配端口未接线".into()))
    }

    /// 外观页：试听一条预设。
    fn sound_preview(&self, _sound_id: &str) -> AppResult<()> {
        Err(AppError::Other("音效试听端口未接线".into()))
    }

    /// 工具页：MCP 编辑文档（`name` 缺省 = 新建模板）。
    fn mcp_server_doc(&self, _name: Option<&str>) -> AppResult<McpServerDoc> {
        Err(AppError::Other("MCP 编辑端口未接线".into()))
    }

    /// 工具页：MCP 文本编辑保存（内置 args/env、自定义增/改）。
    fn mcp_edit_text(&self, _text: &str) -> AppResult<()> {
        Err(AppError::Other("MCP 编辑端口未接线".into()))
    }

    /// 工具页：删除自定义 MCP 服务器（内置拒绝）。
    fn mcp_delete(&self, _name: &str) -> AppResult<()> {
        Err(AppError::Other("MCP 编辑端口未接线".into()))
    }

    /// 工具页：连接测试（返回 (ok, 中性说明)；连接失败是结果不是异常）。
    fn mcp_test(&self, _name: &str) -> AppResult<(bool, String)> {
        Err(AppError::Other("MCP 测试端口未接线".into()))
    }

    /// 工具页：MCP JSON 导入，返回 `(导入条数, 是否被用户取消)`。
    fn mcp_import(&self) -> AppResult<(u32, bool)> {
        Err(AppError::Other("MCP 导入端口未接线".into()))
    }

    /// 工具页：MCP JSON 导出；取消返回 `Ok(None)`。
    fn mcp_export(&self) -> AppResult<Option<String>> {
        Err(AppError::Other("MCP 导出端口未接线".into()))
    }

    /// 工具页：上传 .md 作为 Skill；取消返回 `Ok(None)`，返回 `Ok(Some(name))` = 成功。
    fn skill_upload(&self) -> AppResult<Option<String>> {
        Err(AppError::Other("Skill 上传端口未接线".into()))
    }

    /// 工具页：删除 Skill（skills 域内相对路径）。
    fn skill_delete(&self, _relative_path: &str) -> AppResult<()> {
        Err(AppError::Other("Skill 删除端口未接线".into()))
    }

    /// 记忆页：一条来源的原话回看（展示文本由 Node 组装）。
    fn memory_source_evidence(&self, _source_id: &str) -> AppResult<String> {
        Err(AppError::Other("记忆来源端口未接线".into()))
    }

    /// 记忆页：手动整理（runDreamingSweep 的唯一手动入口）。
    fn memory_dreaming_sweep(&self) -> AppResult<String> {
        Err(AppError::Other("记忆整理端口未接线".into()))
    }

    /// 记忆页：一致性备份 / 导出只读视图 / 重建索引。
    fn memory_maintenance(&self, _op: MemoryMaintenanceOp) -> AppResult<String> {
        Err(AppError::Other("记忆维护端口未接线".into()))
    }

    /// 记忆页：恢复（`preview_only=true` 只预检；false = 应用最近一次托管备份）。
    fn memory_restore(&self, _preview_only: bool) -> AppResult<String> {
        Err(AppError::Other("记忆恢复端口未接线".into()))
    }
}

/// 未接线端口：如实报错（用户动作不静默吞掉）。
pub struct NullSettingsPort;

impl SettingsPort for NullSettingsPort {
    fn fetch(&self) -> AppResult<SettingsSnapshot> {
        Err(AppError::Other(
            "设置端口未接线（Node 侧设置读写接线属 W4；本包只提供界面与端口）".into(),
        ))
    }
    fn commit(&self, _changes: &[SettingEdit]) -> AppResult<()> {
        Err(AppError::Other(
            "设置端口未接线，改动未写入 CONFIG（W4 接线后生效）".into(),
        ))
    }
    fn check_update(&self) -> AppResult<()> {
        Err(AppError::Other(
            "更新检查未接线（Node 设置端口注入后生效；手动入口保留在通用页）".into(),
        ))
    }
}

/// 校验一个值是否符合字段形状（枚举命中、数值在范围内、文本形状匹配）。
pub fn validate_value(field: &schema::Field, value: &SettingsValue) -> AppResult<()> {
    let mismatch = |expected: &str| {
        Err(AppError::Config(format!(
            "字段 {} 需要 {expected} 值",
            field.key
        )))
    };
    match field.kind {
        FieldKind::Bool => match value {
            SettingsValue::Bool(_) => Ok(()),
            _ => mismatch("布尔"),
        },
        // 档位字段（如灵动强度「弱/强」）落盘仍是数字，**不按档位校验** ——
        // 存量里可能有档位之外的中间值（如 1.5），拒绝它会把「打开设置再保存」
        // 变成一次静默改写。档位只约束**呈现**，不约束取值。
        FieldKind::NumberChoice { .. } => match value {
            SettingsValue::Number(_) => Ok(()),
            _ => mismatch("数值"),
        },
        FieldKind::Number { min, max, .. } => match value {
            SettingsValue::Number(number) => {
                if !number.is_finite() || *number < min || *number > max {
                    Err(AppError::Config(format!(
                        "字段 {} 数值越界（{min}..={max}）",
                        field.key
                    )))
                } else {
                    Ok(())
                }
            }
            _ => mismatch("数值"),
        },
        FieldKind::Text { .. }
        | FieldKind::Multiline
        | FieldKind::FontFamily
        | FieldKind::CardChoice
        | FieldKind::ProfileChoice
        | FieldKind::Shortcut
        | FieldKind::ShortcutModifiers => match value {
            SettingsValue::Text(_) => Ok(()),
            _ => mismatch("文本"),
        },
        FieldKind::Enum(choices) => match value {
            SettingsValue::Text(text) => {
                if choices.iter().any(|choice| choice.value == text) {
                    Ok(())
                } else {
                    Err(AppError::Config(format!(
                        "字段 {} 的取值不在枚举内: {text}",
                        field.key
                    )))
                }
            }
            _ => mismatch("枚举"),
        },
        FieldKind::Action => Err(AppError::Config(format!(
            "字段 {} 是动作入口，不参与值提交",
            field.key
        ))),
        FieldKind::Info => Err(AppError::Config(format!(
            "字段 {} 是只读展示，不参与值提交",
            field.key
        ))),
    }
}

// ── 界面显示单位 ↔ CONFIG 存储单位的适配（唯一换算点）──
//
// 静默访问的两个冷却键：CONFIG 键名与磁盘值都是**毫秒**（键名带 `Ms` 是 CONFIG
// 的形状），而界面按旧壳口径用**秒**编辑/显示（schema 的 `unit: "s"`，范围也按秒
// 收口）。换算在两个边界的中间态做：
// - 快照载入 / 「↺ 默认」填入：毫秒 → 秒（旧壳 `Math.round(ms / 1000)` 的取整口径）；
// - 提交（`changes()`）：秒 → 毫秒（×1000 取整）。
// `staySeconds`（本就秒）与 `settleMs`（防抖保持毫秒）不在表内，原样透传。
// 键与 schema 的对应关系由 `冷却换算键与 schema 的单位一致` 测试钉住。

/// 需要在界面侧按秒显示、按毫秒存储的 CONFIG 键（当前只有两个冷却键）。
const MS_KEY_DISPLAY_SECONDS: &[&str] = &[
    "ai.silentAccess.cooldownMs",
    "ai.silentAccess.samePageCooldownMs",
];

/// 快照值 → 界面显示值（毫秒键取整成秒；其余原样）。
fn to_display_value(key: &str, value: SettingsValue) -> SettingsValue {
    match value {
        SettingsValue::Number(ms) if MS_KEY_DISPLAY_SECONDS.contains(&key) => {
            SettingsValue::Number((ms / 1000.0).round())
        }
        other => other,
    }
}

/// 界面显示值 → CONFIG 存储值（秒 → 毫秒取整；其余原样）。
fn to_config_value(key: &str, value: SettingsValue) -> SettingsValue {
    match value {
        SettingsValue::Number(seconds) if MS_KEY_DISPLAY_SECONDS.contains(&key) => {
            SettingsValue::Number((seconds * 1000.0).round())
        }
        other => other,
    }
}

/// 草稿模型：committed（上次成功读入/保存的值）与当前编辑值分开。
///
/// 关闭窗口即丢弃草稿（`revert_all`），不落盘、不跨会话保留 —— 与旧设置面板
/// 「不保存就还原」同语义。
#[derive(Debug, Default)]
pub struct SettingsDraft {
    committed: SettingsSnapshot,
    current: SettingsSnapshot,
    dirty: BTreeSet<String>,
}

impl SettingsDraft {
    /// 载入整表快照：committed 与编辑值都重置为该快照，清空 dirty。
    ///
    /// 毫秒键（见 [`MS_KEY_DISPLAY_SECONDS`]）在这里统一换成界面单位（秒）。
    pub fn load(&mut self, snapshot: SettingsSnapshot) {
        let snapshot = SettingsSnapshot {
            values: snapshot
                .values
                .into_iter()
                .map(|(key, value)| {
                    let value = to_display_value(&key, value);
                    (key, value)
                })
                .collect(),
        };
        self.committed = snapshot.clone();
        self.current = snapshot;
        self.dirty.clear();
    }

    /// 当前编辑值（含未保存改动）。
    pub fn value(&self, key: &str) -> Option<&SettingsValue> {
        self.current.values.get(key)
    }

    /// 当前整表（平台渲染用）。
    pub fn current_values(&self) -> &BTreeMap<String, SettingsValue> {
        &self.current.values
    }

    /// 字段的基线（已保存）值。
    pub fn committed_value(&self, key: &str) -> Option<&SettingsValue> {
        self.committed.values.get(key)
    }

    /// 写入一个字段值（校验后）。
    pub fn set(&mut self, key: &str, value: SettingsValue) -> AppResult<()> {
        let Some(field) = field(key) else {
            return Err(AppError::Config(format!("未知设置字段: {key}")));
        };
        validate_value(field, &value)?;
        if self.committed.values.get(key) == Some(&value) {
            // 改回原值 = 不再是改动。
            self.dirty.remove(key);
            self.current.values.insert(key.to_string(), value);
            return Ok(());
        }
        self.current.values.insert(key.to_string(), value);
        self.dirty.insert(key.to_string());
        Ok(())
    }

    pub fn is_dirty(&self) -> bool {
        !self.dirty.is_empty()
    }

    pub fn dirty_keys(&self) -> impl Iterator<Item = &str> {
        self.dirty.iter().map(String::as_str)
    }

    /// 是否有未保存的字体改动（关闭窗口时要回滚预览）。
    pub fn font_dirty(&self) -> bool {
        self.dirty
            .iter()
            .any(|key| key.starts_with("appearance.font."))
    }

    /// 待提交改动（按 key 有序，提交顺序稳定）。
    ///
    /// 毫秒键（冷却）在这里换算回 CONFIG 单位（秒 → 毫秒）；提交出去的永远是
    /// 磁盘口径的值。
    pub fn changes(&self) -> Vec<SettingEdit> {
        self.dirty
            .iter()
            .filter_map(|key| {
                self.current.values.get(key).map(|value| SettingEdit {
                    key: key.clone(),
                    value: to_config_value(key, value.clone()),
                })
            })
            .collect()
    }

    /// 当前未保存改动（**界面单位**，不做毫秒回换）；供快照重拉时把用户编辑
    /// 放回草稿（与 [`Self::set`] 的入参口径一致）。
    pub fn pending_edits(&self) -> Vec<SettingEdit> {
        self.dirty
            .iter()
            .filter_map(|key| {
                self.current.values.get(key).map(|value| SettingEdit {
                    key: key.clone(),
                    value: value.clone(),
                })
            })
            .collect()
    }

    /// 「↺ 默认」：把内置默认值（Node 的 CONFIG 模板投影）填进草稿。
    ///
    /// 只处理 schema 里有控件的键（模板里没有控件的结构字段不产生草稿改动）；
    /// 值经既有校验后成为 dirty 项，**保存前不落盘** —— 「恢复默认」是可撤销的编辑。
    ///
    /// **密钥字段不动**（模板里是空串，填进草稿会在保存时把用户凭据抹掉）：
    /// 凭据不是「可恢复的默认值」，清空与否只能由用户显式编辑决定。
    /// 返回本次草稿里的改动总数（调用方用于中性提示）。
    pub fn apply_defaults(&mut self, values: &BTreeMap<String, SettingsValue>) -> usize {
        for (key, value) in values {
            match field(key).map(|field| field.kind) {
                None => continue,
                // 密钥（如 ai.apiKey）跳过：见上。
                Some(FieldKind::Text { secret: true }) => continue,
                Some(_) => {}
            }
            // 默认值快照与运行快照同源（CONFIG 模板投影），毫秒键同样换算成界面单位。
            let value = to_display_value(key, value.clone());
            if let Err(error) = self.set(key, value) {
                rust_debug!("默认值写入草稿失败（跳过该项）: {error}");
            }
        }
        self.dirty.len()
    }

    /// 提交成功：当前编辑值成为新基线。
    pub fn mark_saved(&mut self) {
        self.committed = self.current.clone();
        self.dirty.clear();
    }

    /// 丢弃全部未保存改动。
    pub fn revert_all(&mut self) {
        self.current = self.committed.clone();
        self.dirty.clear();
    }

    /// 草稿值的字体快照投影（预览用；不落盘）。
    pub fn font_snapshot(&self) -> FontSnapshot {
        font_snapshot_from(&self.current)
    }

    /// 基线（已保存）值的字体快照投影。
    pub fn committed_font_snapshot(&self) -> FontSnapshot {
        font_snapshot_from(&self.committed)
    }
}

/// 从整表快照投影字体快照：只读 `appearance.font.family` 与 `appearance.font.size`，
/// 不读配置默认值（缺键 → `None` → 系统 fallback）。
pub fn font_snapshot_from(snapshot: &SettingsSnapshot) -> FontSnapshot {
    let family = snapshot
        .values
        .get("appearance.font.family")
        .and_then(SettingsValue::as_text)
        .map(ToString::to_string);
    let size = snapshot
        .values
        .get("appearance.font.size")
        .and_then(SettingsValue::as_number);
    FontSnapshot { family, size }
}

// ── 本批：行编辑文档的加载/保存分发（端口方法按目标裁定；文本格式由 Node 定义）──

fn document_title(target: &DocumentTarget) -> String {
    match target {
        DocumentTarget::V1rtual => "V1RTUAL.md 用户指令".to_string(),
        DocumentTarget::CardStages => "当前卡阶段文案".to_string(),
        DocumentTarget::CardMarkdown => "当前 Card".to_string(),
        DocumentTarget::CardTemplate => "Card 模版（只读）".to_string(),
        DocumentTarget::McpServer { name } if name.is_empty() => "MCP 服务器（新建）".to_string(),
        DocumentTarget::McpServer { name } => format!("MCP 服务器：{name}"),
        DocumentTarget::VariablePool => "变量池预览（只读）".to_string(),
        DocumentTarget::MemoryEvidence => "记忆来源原话（只读）".to_string(),
    }
}

/// Card 模版面板的首行引导语。
///
/// 与模版正文分开定义：正文的唯一来源是运行时 `cards/_template.md`（用户可改、可被
/// 恢复默认资源覆盖），引导语是产品文案，两边的变更理由不同。面板显示什么就复制什么，
/// 所以引导语和正文在这里拼成同一段文本，不在平台层各拼一遍。
const CARD_TEMPLATE_INTRO: &str =
    "可复制下面的模版，扔给 AI 生成。可以说：参照下面的模版，生成一份《明日方舟》里黍的人格卡";

/// 按目标拉取文档内容（端口全部是既有请求面；本函数不解析文本）。
fn load_document(port: &dyn SettingsPort, target: &DocumentTarget) -> AppResult<String> {
    match target {
        DocumentTarget::V1rtual => port.v1rtual_read(),
        DocumentTarget::CardStages => Ok(port.card_stages_read(None)?.text),
        DocumentTarget::CardMarkdown => port.card_markdown_read(None),
        DocumentTarget::CardTemplate => Ok(format!("{CARD_TEMPLATE_INTRO}\n\n{}", port.card_template()?)),
        DocumentTarget::McpServer { name } => Ok(port
            .mcp_server_doc(if name.is_empty() {
                None
            } else {
                Some(name.as_str())
            })?
            .text),
        DocumentTarget::VariablePool => Ok(port.card_variable_pool(None)?.text),
        // 原话文档由 open_evidence_document 自行组装（需要条目上下文），不走这里。
        DocumentTarget::MemoryEvidence => {
            Err(AppError::Other("来源原话文档不支持按目标加载".into()))
        }
    }
}

/// 按目标提交文档；返回中性成功说明（内容校验失败如实抛出）。
fn save_document(
    port: &dyn SettingsPort,
    target: &DocumentTarget,
    content: &str,
) -> AppResult<String> {
    match target {
        DocumentTarget::V1rtual => {
            port.v1rtual_write(content)?;
            Ok("V1RTUAL 指令已保存（下一个回合生效）".to_string())
        }
        DocumentTarget::CardStages => {
            port.card_stages_write(None, content)?;
            Ok("阶段文案已保存（下一个回合生效）".to_string())
        }
        DocumentTarget::McpServer { name } => {
            port.mcp_edit_text(content)?;
            Ok(if name.is_empty() {
                "MCP 服务器已新增".to_string()
            } else {
                format!("MCP 服务器已保存：{name}")
            })
        }
        DocumentTarget::CardMarkdown => {
            port.card_markdown_write(None, content)?;
            Ok("Card 已保存（下一个回合生效）".to_string())
        }
        DocumentTarget::VariablePool
        | DocumentTarget::MemoryEvidence
        | DocumentTarget::CardTemplate => Err(AppError::Config("只读预览不能保存".into())),
    }
}

// ── 通用页辅助：只读显示投影 / 快捷键录制 / 尺寸预览 / 重启 ──

/// 快捷键修饰键的捕获集合（平台层从原生事件填充布尔位，域层统一序列化成 CONFIG 名称）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ShortcutModifiers {
    pub control: bool,
    pub command: bool,
    pub alt: bool,
    pub shift: bool,
}

impl ShortcutModifiers {
    pub fn any(&self) -> bool {
        self.control || self.command || self.alt || self.shift
    }

    /// CONFIG 名称。顺序固定 Control / Command / Alt / Shift（与旧设置面板一致）；
    /// 布尔位天然去重，不产生重复项。
    fn names(&self) -> Vec<String> {
        let mut names = Vec::new();
        if self.control {
            names.push("Control".to_string());
        }
        if self.command {
            names.push("Command".to_string());
        }
        if self.alt {
            names.push("Alt".to_string());
        }
        if self.shift {
            names.push("Shift".to_string());
        }
        names
    }
}

/// 录制结果写进草稿（自由函数：不依赖设置窗单例，草稿模型即可测试）。
///
/// 按键归一化与组合校验走 `ui::shortcut::parse_spec`（唯一校验点，至少一个修饰键
/// 的护栏也在那里）；两个键都写进草稿，由既有保存路径提交。
pub fn write_shortcut(
    draft: &mut SettingsDraft,
    key: &str,
    modifiers: ShortcutModifiers,
    modifiers_key: &str,
) -> AppResult<()> {
    let names = modifiers.names();
    let spec = crate::ui::shortcut::parse_spec(key, &names)
        .map_err(|error| AppError::Config(error.detail))?;
    draft.set("general.shortcut.key", SettingsValue::Text(spec.key))?;
    draft.set(modifiers_key, SettingsValue::Text(names.join("\n")))?;
    Ok(())
}

/// 只读展示字段的投影（`FieldKind::Info` 的显示文本；数据只来自快照，不补默认值）。
pub fn info_text(key: &str, values: &BTreeMap<String, SettingsValue>) -> String {
    match key {
        // 固定位置坐标：快照把 `{x, y}` 展开成 `.x` / `.y` 两个标量键；未设置时两键都缺。
        "general.popup.fixedPosition" => {
            let x = values
                .get("general.popup.fixedPosition.x")
                .and_then(SettingsValue::as_number);
            let y = values
                .get("general.popup.fixedPosition.y")
                .and_then(SettingsValue::as_number);
            match (x, y) {
                (Some(x), Some(y)) => format!("({}, {})", x as i64, y as i64),
                _ => "未设置".to_string(),
            }
        }
        other => {
            rust_debug!("只读展示字段 {other} 还没有投影规则（显示空文本）");
            String::new()
        }
    }
}

/// 快捷键当前组合（键 + 平台修饰键列表；缺键返回 `None`，由平台展示为「未设置」）。
pub fn shortcut_parts(
    values: &BTreeMap<String, SettingsValue>,
    modifiers_key: &str,
) -> Option<(String, Vec<String>)> {
    let key = values
        .get("general.shortcut.key")
        .and_then(SettingsValue::as_text)?;
    if key.trim().is_empty() {
        return None;
    }
    let modifiers = values
        .get(modifiers_key)
        .and_then(SettingsValue::as_text)
        .map(|text| {
            text.split('\n')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some((key.to_string(), modifiers))
}

/// 字段的动态帮助行（当前只有 Bash 白名单的「N 个命令」计数）。
///
/// 计数取草稿现值（多行文本的非空行数，与运行时 `bashWhitelist` 的解析口径一致）；
/// 平台在字段静态 help 下方再渲染一行，并在刷新时重算（`None` = 该字段无动态行）。
pub fn dynamic_field_hint(key: &str, values: &BTreeMap<String, SettingsValue>) -> Option<String> {
    match key {
        "tools.bash.whitelist" => {
            let count = values
                .get(key)
                .and_then(SettingsValue::as_text)
                .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
                .unwrap_or(0);
            Some(format!("{count} 个命令"))
        }
        _ => None,
    }
}

// ── 平台控件共用（两平台同语义，纯逻辑放这里以便在开发机上跑单测）──

/// Tab 标签 → Tab 下标（平台控件 tag/id 的统一校验口）。
///
/// macOS 的竖栏行按钮 `tag` 就是下标；Windows 的按钮 `id = TAB_BASE + 下标`，
/// 调用方先减基址再进来。越界/负值一律 `None`（控件状态异常时不静默落到某个 Tab）。
pub fn tab_index_for_tag(tag: isize) -> Option<usize> {
    usize::try_from(tag)
        .ok()
        .filter(|index| *index < schema::TABS.len())
}

/// 主动消息开关按钮的标题：按钮本身就是状态显示（旧壳的复选框语义）。
///
/// 状态未读到（`None`：未进入过本页/未接线/读失败）时回中性动作文案；
/// 按钮点击的写入行为不变（读现状取反，见 [`SettingsUi::toggle_proactive`]）。
pub fn proactive_button_title(snapshot: Option<ProactiveSnapshot>) -> String {
    match snapshot {
        Some(snapshot) if snapshot.enabled => "主动消息：已开启".to_string(),
        Some(_) => "主动消息：已关闭".to_string(),
        None => "切换主动消息开关".to_string(),
    }
}

/// `FieldKind::Bool` 开关控件的开/关状态镜像（平台控件句柄 → 状态）。
///
/// 为什么需要它：两平台的开关都是**自绘**控件（macOS 贴在 NSButton 的 CALayer 上，
/// Windows 是 `BS_OWNERDRAW` 按钮）—— 不承载系统复选状态语义，开/关只存在于这张表：
/// 绘制、读值（harvest）与刷新回写三处共用同一事实。
///
/// 键用控件句柄的整数值（`HWND` 在 windows-sys 里就是 `isize`），所以表本身平台无关：
/// 纯逻辑随本文件在开发机（macOS）上跑单测；Windows 分支本机编不了（见 native-host
/// AGENTS §2），与 `paint_win` 把纯逻辑半段两平台编译的理由相同。
#[derive(Default)]
pub struct SwitchStates {
    states: HashMap<isize, bool>,
}

impl SwitchStates {
    /// 登记控件与初始状态（控件创建时调用一次；重复登记按新值覆盖）。
    pub fn register(&mut self, control: isize, on: bool) {
        self.states.insert(control, on);
    }

    /// 注销控件（销毁时调用；未登记的键是无操作）。
    pub fn unregister(&mut self, control: isize) {
        self.states.remove(&control);
    }

    /// 清空全部登记（窗口整体销毁时调用；句柄会被系统复用，不能留陈旧项）。
    pub fn clear(&mut self) {
        self.states.clear();
    }

    /// 控件是否登记过（`WM_DRAWITEM` 靠它把开关从普通按钮面里分流出来）。
    pub fn contains(&self, control: isize) -> bool {
        self.states.contains_key(&control)
    }

    /// 当前状态；未登记按「关」读取（正常路径先 register 后读）。
    pub fn get(&self, control: isize) -> bool {
        self.states.get(&control).copied().unwrap_or(false)
    }

    /// 写入状态（数据刷新回写与提交失败回滚）。
    pub fn set(&mut self, control: isize, on: bool) {
        self.states.insert(control, on);
    }

    /// 翻转并返回新状态（点击提交路径；提交失败时调用方用 `set` 回滚）。
    pub fn toggle(&mut self, control: isize) -> bool {
        let next = !self.get(control);
        self.set(control, next);
        next
    }
}

/// 通知档位：决定平台**怎么呈现**（不是怎么配色）。
///
/// 用户规则（2026-10-05）：「提示信息全在左下角，改成弹窗最好」——
/// 于是分两档：**出错弹模态窗**（必须看见并确认），**普通回执走顶部浮层**
/// （几秒自动消失，不打断操作）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NoticeLevel {
    /// 告知性回执（已保存 / 正在刷新）—— 顶部浮层，自动消失。
    #[default]
    Info,
    /// 警告（未就绪 / 部分成功）—— 顶部浮层，配色取 `warn`。
    Warning,
    /// 错误（这次操作没成功）—— 模态弹窗，必须确认。
    Error,
}

/// 平台渲染所需的整窗视图快照。
#[derive(Debug, Clone, Default)]
pub struct SettingsView {
    pub values: BTreeMap<String, SettingsValue>,
    pub dirty: BTreeSet<String>,
    pub notice: Option<String>,
    /// 最近一条通知的档位。
    ///
    /// 平台据此**分档呈现**：`Error` 走模态弹窗（必须确认），
    /// `Info` / `Warning` 走顶部浮层（几秒自动消失、不打断操作）。
    /// 此前档位是平台在绘制时按站点硬选的，文案本身不带语义 —— 用户报
    /// 「提示信息全在左下角」正是这个口径的直接后果。
    pub notice_level: NoticeLevel,
    /// 通知代际：每来一条**新**通知 +1。
    ///
    /// 平台靠它判断「这是一条新通知」：浮层的自动消失计时不能靠文本比较 ——
    /// 同一句话连报两次时文本相等，会被误判成「还是那一条」而不再计时。
    pub notice_generation: u64,
    pub connected: bool,
    pub font_families: Option<Arc<Vec<String>>>,
    /// 人格卡选项（窗口打开时拉取一次；`None` = 尚未拉到/未接线）。
    pub card_options: Option<Arc<Vec<CardOption>>>,
    /// 激活 Profile 选项（外观页；窗口打开时拉取一次）。
    pub profile_options: Option<Arc<Vec<ProfileOption>>>,
    /// 主动消息开关的当前状态（AI 页进入时读一次；`None` = 尚未读到，按钮显示中性文案）。
    pub proactive: Option<ProactiveSnapshot>,
    pub saving: bool,
}

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
    /// 主动消息开关的权威状态（AI 页进入时读一次；关窗释放）。
    proactive: Mutex<Option<ProactiveSnapshot>>,
    /// 主动状态读取在途（与切换动作分开：两者都可能触发读）。
    proactive_loading: AtomicBool,
    /// 管理面数据（W9d）。
    panels: Mutex<PanelState>,
    /// 记忆治理变更在途（同一时刻只提交一个，避免连点并发写同一库）。
    memory_change_in_flight: AtomicBool,
    /// 本批：行编辑文档（V1RTUAL / 阶段文案 / 音效 / MCP / 只读预览）。
    document: Mutex<Option<DocumentState>>,
    /// 本批：记忆范围筛选（None = 全部；值域 user/card/session，card/session 的 id 由 Node 补激活值）。
    memory_scope: Mutex<Option<String>>,
    /// 本批：文档保存/加载在途（同一时刻只跑一个，避免连点并发写同一文件）。
    document_in_flight: AtomicBool,
}

static SETTINGS_UI: OnceLock<SettingsUi> = OnceLock::new();

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

impl SettingsUi {
    fn new() -> Self {
        Self {
            port: Mutex::new(Arc::new(NullSettingsPort)),
            draft: Mutex::new(SettingsDraft::default()),
            queue: OnceLock::new(),
            window_open: AtomicBool::new(false),
            loading: AtomicBool::new(false),
            fonts_loading: AtomicBool::new(false),
            saving: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            notice: Mutex::new(None),
            notice_level: Mutex::new(NoticeLevel::Info),
            notice_generation: Mutex::new(0),
            font_families: Mutex::new(None),
            cards_loading: AtomicBool::new(false),
            card_options: Mutex::new(None),
            profiles_loading: AtomicBool::new(false),
            profile_options: Mutex::new(None),
            proactive: Mutex::new(None),
            proactive_loading: AtomicBool::new(false),
            panels: Mutex::new(PanelState::default()),
            memory_change_in_flight: AtomicBool::new(false),
            document: Mutex::new(None),
            memory_scope: Mutex::new(None),
            document_in_flight: AtomicBool::new(false),
        }
    }

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// 平台在 UI 启动时安装主线程队列。
    pub fn install_main_queue(&self, queue: Arc<MainThreadQueue>) {
        if self.queue.set(queue).is_err() {
            rust_warn!("设置 UI 主线程队列重复安装（忽略后一次）");
        }
    }

    /// 注入设置端口（Node 接线就绪后调用）。
    pub fn install_port(&self, port: Arc<dyn SettingsPort>) {
        *Self::lock(&self.port) = port;
        self.connected.store(true, Ordering::SeqCst);
        rust_info!("设置端口已注入");
    }

    fn run_on_ui(&self, job: impl FnOnce() + Send + 'static) {
        match self.queue.get() {
            Some(queue) => queue.push(Box::new(job)),
            None => rust_warn!("设置 UI 未安装主线程队列，本次刷新调度被跳过"),
        }
    }

    /// 通知平台刷新整窗（平台自己取 [`Self::view`]）。
    fn refresh(&self) {
        if self.window_open.load(Ordering::SeqCst) {
            self.run_on_ui(|| {
                let _ = crate::ui::platform::imp::settings_refresh();
            });
        }
    }

    // ── 打开 / 关闭 ──

    /// 打开设置窗（先建窗显示现状，再在后台拉取快照）。
    pub fn open_window(&self) {
        self.run_on_ui(|| {
            if let Err(error) = crate::ui::platform::imp::open_settings_window() {
                rust_warn!("设置窗口打开失败: {error}");
            }
        });
        self.window_open.store(true, Ordering::SeqCst);
        self.schedule_fetch(true);
    }

    /// 关闭设置窗后由平台回调：丢弃草稿、回滚字体预览、释放字体列表缓存。
    ///
    /// 字体是「即时预览」语义：有未保存的字体改动时，关闭要把全局快照回滚到
    /// 已提交基线（否则窗口关了、预览还留在控件上）。
    pub fn note_window_closed(&self) {
        self.window_open.store(false, Ordering::SeqCst);
        let mut draft = Self::lock(&self.draft);
        if draft.font_dirty() {
            let snapshot = draft.committed_font_snapshot();
            let applied = font::store(snapshot);
            rust_info!(
                "设置窗关闭：未保存的字体改动已回滚（family={:?}，size={:?}）",
                applied.family,
                applied.size
            );
            if let Err(error) = crate::ui::platform::imp::apply_font_snapshot(applied) {
                rust_warn!("回滚字体应用失败: {error}");
            }
        }
        draft.revert_all();
        drop(draft);
        self.loading.store(false, Ordering::SeqCst);
        *Self::lock(&self.notice) = None;
        // §6.4：关闭即销毁 UI 资源 —— 字体族与人格卡列表都不跨窗口保留。
        *Self::lock(&self.font_families) = None;
        *Self::lock(&self.card_options) = None;
        *Self::lock(&self.profile_options) = None;
        // 主动开关状态同样关窗释放：状态真值在宿主 SQLite，重开重读。
        *Self::lock(&self.proactive) = None;
        self.proactive_loading.store(false, Ordering::SeqCst);
        // 管理面同样关闭即释放：列表、详情与未保存的内容草稿都不跨窗口保留。
        let mut panels = Self::lock(&self.panels);
        *panels = PanelState::default();
        drop(panels);
        self.memory_change_in_flight.store(false, Ordering::SeqCst);
        // 本批：行编辑文档与记忆范围筛选同样不跨窗口保留（§6.4 资源纪律）。
        *Self::lock(&self.document) = None;
        *Self::lock(&self.memory_scope) = None;
        self.document_in_flight.store(false, Ordering::SeqCst);
    }

    /// 重新拉取设置快照（「刷新」按钮；拉取期间保留本地草稿）。
    pub fn reload(&self) {
        if !self.connected.load(Ordering::SeqCst) {
            self.set_notice(Some(
                "设置数据未接线（Node 设置读写端口就绪后自动生效）".into(),
            ));
            return;
        }
        self.set_notice(Some("正在刷新…".into()));
        self.schedule_fetch(true);
    }

    /// 静默重拉（进入通用页时刷新坐标等被宿主写回的字段）：不提示「正在刷新」，
    /// 成功也不清通知 —— 别把更新候选等既有提示顺手抹掉。
    pub fn refresh_silently(&self) {
        if !self.connected.load(Ordering::SeqCst) {
            return;
        }
        self.schedule_fetch(false);
    }

    pub fn is_window_open(&self) -> bool {
        self.window_open.load(Ordering::SeqCst)
    }

    // ── 快照 / 控件动作（平台层调用，全部在主线程） ──

    /// 平台渲染取数。
    pub fn view(&self) -> SettingsView {
        let draft = Self::lock(&self.draft);
        SettingsView {
            values: draft.current_values().clone(),
            dirty: draft.dirty_keys().map(ToString::to_string).collect(),
            notice: Self::lock(&self.notice).clone(),
            notice_level: Self::lock(&self.notice_level).clone(),
            notice_generation: Self::lock(&self.notice_generation).clone(),
            connected: self.connected.load(Ordering::SeqCst),
            font_families: Self::lock(&self.font_families).clone(),
            card_options: Self::lock(&self.card_options).clone(),
            profile_options: Self::lock(&self.profile_options).clone(),
            proactive: *Self::lock(&self.proactive),
            saving: self.saving.load(Ordering::SeqCst),
        }
    }

    /// 控件改值：写入草稿；字体字段即时预览（全局快照 + 各窗口应用）。
    pub fn set_value(&self, key: &str, value: SettingsValue) -> AppResult<()> {
        let font_preview = {
            let mut draft = Self::lock(&self.draft);
            draft.set(key, value)?;
            if key.starts_with("appearance.font.") {
                Some(draft.font_snapshot())
            } else {
                None
            }
        };
        if let Some(snapshot) = font_preview {
            let applied = font::store(snapshot);
            if let Err(error) = crate::ui::platform::imp::apply_font_snapshot(applied.clone()) {
                rust_warn!("字体预览应用失败: {error}");
            }
            rust_debug!(
                "字体预览已应用（family={:?}，size={:?}）",
                applied.family,
                applied.size
            );
        }
        self.refresh();
        Ok(())
    }

    /// 动作入口（如「检查更新」）。
    ///
    /// 依赖当前控件值的两个入口（`预览尺寸` / `重启`）要求平台层先采全表进草稿
    /// （用户在输入框里的编辑也算改动）；这里只消费草稿，不反读控件。
    pub fn run_action(&self, key: &str) -> AppResult<()> {
        match key {
            "action.checkUpdate" => self.check_update(),
            "action.restart" => self.restart_app(),
            "action.refreshProfiles" => self.refresh_profiles(),
            // ── 本批：通用页 ──
            "action.resetDefaults" => self.reset_defaults(),
            "action.exportConfig" => self.export_config(),
            "action.importConfig" => self.import_config(),
            // ── 本批：AI 页 ──
            "action.toggleProactive" => self.toggle_proactive(),
            "action.editV1rtual" => {
                self.open_document(DocumentTarget::V1rtual);
                Ok(())
            }
            "action.editCardStages" => {
                self.open_document(DocumentTarget::CardStages);
                Ok(())
            }
            "action.regenerateCardStages" => self.regenerate_card_stages(),
            "action.showVariablePool" => {
                self.open_document(DocumentTarget::VariablePool);
                Ok(())
            }
            // ── 本批：AI 页（Card 增删改查）──
            "action.cardCreate" => self.create_card(),
            "action.cardTemplate" => {
                self.open_document(DocumentTarget::CardTemplate);
                Ok(())
            }
            "action.cardEdit" => {
                self.open_document(DocumentTarget::CardMarkdown);
                Ok(())
            }
            "action.cardRename" => self.rename_current_card(),
            "action.cardExport" => self.card_manage(CardManageOp::Export(String::new())),
            "action.cardImport" => self.card_manage(CardManageOp::Import),
            "action.cardDelete" => self.card_manage(CardManageOp::Delete(String::new())),
            // ── 本批：外观页 ──
            "action.soundResetDefaults" => self.sound_reset_defaults(),
            "action.profileCreate" => self.profile_manage(ProfileManageOp::Create),
            "action.profileRename" => self.rename_current_profile(),
            "action.profileDelete" => self.profile_manage(ProfileManageOp::Delete(String::new())),
            "action.profileExport" => self.profile_manage(ProfileManageOp::Export(String::new())),
            "action.profileImport" => self.profile_manage(ProfileManageOp::Import),
            "action.profileRestoreDefaults" => {
                self.profile_manage(ProfileManageOp::RestoreDefaults)
            }
            "action.openLayerEditor" => {
                // 与托盘/聊天「图层」按钮同一条入口（`EditorUi::open_window`）：
                // 窗口门禁与载入调度都在那里，不只是建窗。真正建窗在平台层，
                // 失败在编辑器域内留痕（与既有入口同语义，不在这里另造错误通道）。
                crate::ui::editor::editor_ui().open_window();
                Ok(())
            }
            // ── 本批：工具页 ──
            "action.mcpAddServer" => {
                self.open_document(DocumentTarget::McpServer {
                    name: String::new(),
                });
                Ok(())
            }
            "action.mcpImport" => self.mcp_import(),
            "action.mcpExport" => self.mcp_export(),
            "action.skillUpload" => self.skill_upload(),
            // ── 本批：记忆页 ──
            "action.memorySweep" => self.memory_sweep(),
            "action.memoryBackup" => self.memory_maintenance(MemoryMaintenanceOp::Backup),
            "action.memoryExport" => self.memory_maintenance(MemoryMaintenanceOp::Export),
            "action.memoryRebuildIndex" => {
                self.memory_maintenance(MemoryMaintenanceOp::RebuildIndex)
            }
            "action.memoryRestorePreview" => self.memory_restore(true),
            "action.memoryRestoreApply" => self.memory_restore(false),
            "action.memorySourceEvidence" => self.open_evidence_document(),
            "action.memoryScopeAll" => {
                self.set_memory_scope(None);
                Ok(())
            }
            "action.memoryScopeUser" => {
                self.set_memory_scope(Some("user"));
                Ok(())
            }
            "action.memoryScopeCard" => {
                self.set_memory_scope(Some("card"));
                Ok(())
            }
            "action.memoryScopeSession" => {
                self.set_memory_scope(Some("session"));
                Ok(())
            }
            other => Err(AppError::Other(format!("未知动作入口: {other}"))),
        }
    }

    // ── 本批：通用页（恢复默认 / 配置导入导出）──

    /// 「↺ 默认」：拉内置默认值填进草稿（保存前不落盘；失败如实提示）。
    pub fn reset_defaults(&self) -> AppResult<()> {
        if !self.connected.load(Ordering::SeqCst) {
            self.set_error("设置数据未接线，无法读取默认值");
            return Ok(());
        }
        self.set_notice(Some("正在读取默认值…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-defaults".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.defaults() {
                    Ok(snapshot) => {
                        let dirty = Self::lock(&ui.draft).apply_defaults(&snapshot.values);
                        ui.set_notice(Some(if dirty == 0 {
                            "当前配置已与默认值一致".to_string()
                        } else {
                            format!("已填入默认值（{dirty} 项待保存）")
                        }));
                    }
                    Err(error) => ui.set_error(format!("默认值读取失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("默认值线程创建失败: {error}"))),
        }
    }

    /// 「导出配置」：Node 弹保存对话框并写盘；取消是正常结果。
    pub fn export_config(&self) -> AppResult<()> {
        self.set_notice(Some("正在导出配置…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-config-export".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.export_config() {
                    Ok(Some(path)) => ui.set_notice(Some(format!("配置已导出：{path}"))),
                    Ok(None) => ui.set_notice(Some("已取消导出".into())),
                    Err(error) => ui.set_error(format!("配置导出失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("导出线程创建失败: {error}"))),
        }
    }

    /// 「导入配置」：Node 弹打开对话框、校验后替换 CONFIG 并写盘；成功后重拉快照。
    pub fn import_config(&self) -> AppResult<()> {
        self.set_notice(Some("正在导入配置…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-config-import".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.import_config() {
                    Ok(true) => {
                        ui.set_notice(Some("配置已导入并写盘".into()));
                        // 磁盘配置已被替换：重拉整表（保留用户未保存的草稿改动，与刷新同一条合并语义）。
                        ui.schedule_fetch(false);
                    }
                    Ok(false) => ui.set_notice(Some("已取消导入".into())),
                    Err(error) => ui.set_error(format!("配置导入失败（未写盘）：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("导入线程创建失败: {error}"))),
        }
    }

    // ── 本批：AI 页 ──

    /// 主动消息开关：先读权威状态再取反写回（两步都在工作线程）。
    ///
    /// 写入行为与旧实现一致；差别只在成功后把权威快照存进 UI 状态，按钮标题
    /// （[`proactive_button_title`]）随刷新显示新状态。失败时状态不动。
    pub fn toggle_proactive(&self) -> AppResult<()> {
        self.set_notice(Some("正在切换主动消息…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-proactive".into())
            .spawn(move || {
                let ui = settings_ui();
                let outcome = port
                    .proactive_control(None)
                    .and_then(|current| port.proactive_control(Some(!current.enabled)));
                match outcome {
                    Ok(snapshot) => {
                        *Self::lock(&ui.proactive) = Some(snapshot);
                        ui.set_notice(Some(format!(
                            "主动消息已{}（revision {}）",
                            if snapshot.enabled { "开启" } else { "关闭" },
                            snapshot.revision
                        )));
                    }
                    Err(error) => {
                        // 用户可见错误必须同时留痕（统一日志出口）：状态行只显示一行，
                        // 截断后读不到全文（2026-10-05 实机「记忆数据库不可用: 主动…」）。
                        rust_warn!("主动消息切换失败（状态未变）：{error}");
                        ui.set_error(format!("主动消息切换失败（状态未变）：{error}"))
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("主动开关线程创建失败: {error}"))),
        }
    }

    /// AI 页首次进入：读取主动开关的权威状态（在途去重；已缓存则直接刷新）。
    ///
    /// 失败只留痕不改按钮标题 —— 按钮点击自身仍是「读现状取反」的完整两步，
    /// 不依赖这次预读。
    pub fn ensure_proactive(&self) {
        if Self::lock(&self.proactive).is_some() {
            self.refresh();
            return;
        }
        if self.proactive_loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-proactive-read".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.proactive_control(None) {
                    Ok(snapshot) => *Self::lock(&ui.proactive) = Some(snapshot),
                    Err(error) => rust_warn!("主动开关状态读取失败（按钮保持中性文案）: {error}"),
                }
                ui.proactive_loading.store(false, Ordering::SeqCst);
                ui.refresh();
            });
        if let Err(error) = spawn {
            self.proactive_loading.store(false, Ordering::SeqCst);
            rust_warn!("主动状态读取线程创建失败: {error}");
        }
    }

    /// 阶段文案重新生成；成功时把结果替换进已打开的阶段文档。
    pub fn regenerate_card_stages(&self) -> AppResult<()> {
        self.set_notice(Some("正在重新生成阶段文案…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-stages".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.card_stages_regenerate(None) {
                    Ok(stages) => {
                        {
                            let mut doc = Self::lock(&ui.document);
                            match doc.as_mut() {
                                Some(state) if state.target == DocumentTarget::CardStages => {
                                    state.content = stages.text;
                                    state.loaded = true;
                                }
                                _ => {
                                    *doc = Some(DocumentState {
                                        title: document_title(&DocumentTarget::CardStages),
                                        target: DocumentTarget::CardStages,
                                        content: stages.text,
                                        loaded: true,
                                    });
                                }
                            }
                        }
                        let ui = settings_ui();
                        ui.note_document_changed();
                        ui.refresh();
                        ui.set_notice(Some(format!("阶段文案已重新生成（{}）", stages.card_id)));
                    }
                    Err(error) => {
                        settings_ui().set_error(format!("阶段文案生成失败：{error}"))
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("阶段文案线程创建失败: {error}"))),
        }
    }

    // ── 本批：行编辑文档（打开/保存/关闭） ──

    /// 文档区变化（打开/关闭/加载完成）：推进面板代数，让平台重建管理面（含文档区）。
    fn note_document_changed(&self) {
        Self::lock(&self.panels).generation += 1;
    }

    /// 当前文档快照（平台渲染）。
    pub fn document(&self) -> Option<DocumentState> {
        Self::lock(&self.document).clone()
    }

    /// 关闭文档（丢弃未保存编辑；不发请求）。
    pub fn close_document(&self) {
        *Self::lock(&self.document) = None;
        self.note_document_changed();
        self.refresh();
    }

    /// 打开文档并后台拉取内容；失败时关闭文档并给中性说明（不留旧文本冒充新内容）。
    pub fn open_document(&self, target: DocumentTarget) {
        *Self::lock(&self.document) = Some(DocumentState {
            title: document_title(&target),
            target: target.clone(),
            content: String::new(),
            loaded: false,
        });
        self.note_document_changed();
        self.refresh();
        self.spawn_document_load(target);
    }

    fn spawn_document_load(&self, target: DocumentTarget) {
        if self.document_in_flight.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-doc-load".into())
            .spawn(move || {
                let result = load_document(port.as_ref(), &target);
                let ui = settings_ui();
                match result {
                    Ok(content) => {
                        let mut doc = Self::lock(&ui.document);
                        if let Some(state) = doc.as_mut() {
                            if state.target == target {
                                state.content = content;
                                state.loaded = true;
                            }
                        }
                        drop(doc);
                        ui.note_document_changed();
                        ui.document_in_flight.store(false, Ordering::SeqCst);
                        ui.refresh();
                    }
                    Err(error) => {
                        let mut doc = Self::lock(&ui.document);
                        if doc.as_ref().map(|state| &state.target) == Some(&target) {
                            *doc = None;
                        }
                        drop(doc);
                        ui.note_document_changed();
                        ui.document_in_flight.store(false, Ordering::SeqCst);
                        ui.set_error(format!("内容读取失败：{error}"));
                    }
                }
            });
        if let Err(error) = spawn {
            self.document_in_flight.store(false, Ordering::SeqCst);
            rust_warn!("文档读取线程创建失败: {error}");
        }
    }

    /// 保存文档：后台走端口写入口；成功后重拉（显示的永远是已提交文本）。
    pub fn save_document(&self, content: &str) -> AppResult<()> {
        let Some(state) = self.document() else {
            return Err(AppError::Other("没有打开的文档".into()));
        };
        if state.target.is_read_only() {
            return Err(AppError::Config("只读预览不能保存".into()));
        }
        if !self.connected.load(Ordering::SeqCst) {
            self.set_error("设置数据未接线，无法保存");
            return Ok(());
        }
        if self.document_in_flight.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次读写还在进行中".into()));
            return Ok(());
        }
        self.set_notice(Some("正在保存…".into()));
        let port = Self::lock(&self.port).clone();
        let target = state.target;
        let content = content.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-doc-save".into())
            .spawn(move || {
                let ui = settings_ui();
                match save_document(port.as_ref(), &target, &content) {
                    Ok(notice) => {
                        // 重拉权威文本（Node 校验后的落盘内容）；重拉失败保留刚提交的文本。
                        if let Ok(fresh) = load_document(port.as_ref(), &target) {
                            let mut doc = Self::lock(&ui.document);
                            if let Some(state) = doc.as_mut() {
                                if state.target == target {
                                    state.content = fresh;
                                    state.loaded = true;
                                }
                            }
                        }
                        if matches!(target, DocumentTarget::McpServer { .. }) {
                            ui.spawn_tools_fetch();
                        }
                        ui.note_document_changed();
                        ui.document_in_flight.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(notice));
                    }
                    Err(error) => {
                        ui.document_in_flight.store(false, Ordering::SeqCst);
                        ui.set_error(format!("保存失败（未写入）：{error}"));
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                self.document_in_flight.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("保存线程创建失败: {error}")))
            }
        }
    }

    /// 测试当前文档对应的 MCP 服务器连接（仅服务器已有名字的 MCP 文档可用）。
    pub fn test_document_mcp_server(&self) -> AppResult<()> {
        let Some(state) = self.document() else {
            return Err(AppError::Other("没有打开的文档".into()));
        };
        let DocumentTarget::McpServer { name } = state.target else {
            return Err(AppError::Config("当前文档不是 MCP 服务器".into()));
        };
        if name.is_empty() {
            return Err(AppError::Config(
                "新建服务器还没有名字：保存后再测试".into(),
            ));
        }
        self.set_notice(Some(format!("正在测试 {name} …")));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-mcp-test".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.mcp_test(&name) {
                    Ok((true, message)) => ui.set_notice(Some(format!("{name}：{message}"))),
                    Ok((false, message)) => {
                        ui.set_error(format!("{name} 连接失败：{message}"))
                    }
                    Err(error) => ui.set_notice(Some(format!("连接测试未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("连接测试线程创建失败: {error}"))),
        }
    }

    // ── 本批：外观页（Profile 管理）──

    /// Profile 管理动作：`id` 由平台在动作触发前填进 op（空 = 用当前选中 Profile）。
    /// 平台的动作字段不携带参数，这里把空 id 解析成草稿选中项，避免静默操作错对象。
    pub fn profile_manage(&self, op: ProfileManageOp) -> AppResult<()> {
        let op = match op {
            ProfileManageOp::Delete(id) if id.is_empty() => {
                ProfileManageOp::Delete(self.active_profile_id()?)
            }
            ProfileManageOp::Export(id) if id.is_empty() => {
                ProfileManageOp::Export(self.active_profile_id()?)
            }
            other => other,
        };
        self.set_notice(Some("正在处理 Profile…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-profile".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.profile_manage(&op) {
                    Ok(outcome) => {
                        *Self::lock(&ui.profile_options) = Some(Arc::new(outcome.profiles));
                        // 新建成功后把草稿选中项指向新项：列表立即选定它，用户按保存即切换过去。
                        if let Some(new_id) = &outcome.new_id {
                            if let Err(error) = ui
                                .set_value("appearance.activeProfile", SettingsValue::Text(new_id.clone()))
                            {
                                rust_warn!("新建 Profile 后预选中失败（列表仍会刷新）: {error}");
                            }
                        }
                        ui.set_notice(Some(outcome.message));
                    }
                    Err(error) => ui.set_notice(Some(format!("Profile 操作未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!(
                "Profile 操作线程创建失败: {error}"
            ))),
        }
    }

    /// 重命名当前选中 Profile：先弹原生输入框取新名（取消 = 不写任何值），再走管理动作。
    ///
    /// 目标 id 与删除/导出同口径（草稿选中项）；预填值从 `profile_options` 缓存取显示名，
    /// 缓存缺失时回落 id（不会猜一个不存在的名字）。
    fn rename_current_profile(&self) -> AppResult<()> {
        let profile_id = self.active_profile_id()?;
        let current = Self::lock(&self.profile_options)
            .as_ref()
            .and_then(|options| options.iter().find(|option| option.id == profile_id))
            .map(|option| option.name.clone())
            .unwrap_or_else(|| profile_id.clone());
        let Some(name) = crate::ui::platform::imp::prompt_text(
            "重命名 Profile",
            "新显示名（目录名与素材不受影响）",
            &current,
        )?
        else {
            return Ok(()); // 取消：不写任何值
        };
        self.profile_manage(ProfileManageOp::Rename { profile_id, name })
    }

    /// 当前激活 Profile 的 id（来自快照草稿；没有则如实报错）。
    fn active_profile_id(&self) -> AppResult<String> {
        Self::lock(&self.draft)
            .value("appearance.activeProfile")
            .and_then(SettingsValue::as_text)
            .map(ToString::to_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Other("没有激活的 Profile".into()))
    }

    // ── 本批：AI 页（Card 管理）──

    /// Card 管理动作：`id` 由平台在动作触发前填进 op（空 = 用草稿里选中的卡）。
    /// 与 Profile 同口径，空 id 解析成当前选中项，避免静默操作错对象。
    pub fn card_manage(&self, op: CardManageOp) -> AppResult<()> {
        let op = match op {
            CardManageOp::Delete(id) if id.is_empty() => {
                CardManageOp::Delete(self.active_card_id()?)
            }
            CardManageOp::Export(id) if id.is_empty() => {
                CardManageOp::Export(self.active_card_id()?)
            }
            other => other,
        };
        self.set_notice(Some("正在处理 Card…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-card".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.card_manage(&op) {
                    Ok(CardManageOutcome {
                        message,
                        cards,
                        new_id,
                        active_id,
                    }) => {
                        // 选中项回填：新建指向新卡；否则若草稿选的卡已从返回列表里消失
                        // （刚被删掉），回落到运行时仍在激活的卡 —— 不回落的话，保存时会拿
                        // 一个不存在的 id 去切换。先算再搬 `cards`，免得为取一次值多克隆一份列表。
                        let selected = Self::lock(&ui.draft)
                            .value("ai.personality.active")
                            .and_then(SettingsValue::as_text)
                            .map(ToString::to_string);
                        let fallback = new_id.clone().or_else(|| {
                            let gone = selected
                                .as_deref()
                                .is_some_and(|id| !cards.iter().any(|card| card.id == id));
                            (gone && !active_id.is_empty()).then(|| active_id.clone())
                        });
                        *Self::lock(&ui.card_options) = Some(Arc::new(cards));
                        if let Some(id) = fallback {
                            if let Err(error) =
                                ui.set_value("ai.personality.active", SettingsValue::Text(id))
                            {
                                rust_warn!("Card 操作后回填选中项失败（列表仍会刷新）: {error}");
                            }
                        }
                        ui.set_notice(Some(message));
                    }
                    Err(error) => ui.set_notice(Some(format!("Card 操作未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("Card 操作线程创建失败: {error}"))),
        }
    }

    /// 新建 Card：先弹原生输入框取角色名（取消 = 不写任何值），再走管理动作。
    ///
    /// id 不在这一层推导：显示名到 id 的清洗与撞名避让都在 Node 侧一次裁定，
    /// 免得宿主与 Node 各有一套推导规则、结果还会分叉。
    fn create_card(&self) -> AppResult<()> {
        let Some(name) = crate::ui::platform::imp::prompt_text(
            "新建 Card",
            "角色名（会作为卡片 id 的来源；重名自动加后缀）",
            "",
        )?
        else {
            return Ok(()); // 取消：不写任何值
        };
        self.card_manage(CardManageOp::Create { name })
    }

    /// 重命名当前选中 Card：弹原生输入框取新显示名（取消 = 不写任何值）。
    ///
    /// 只改显示名，文件名与 id 不动 —— 阶段文案与变量状态都挂在 id 上，改名不该牵连它们。
    fn rename_current_card(&self) -> AppResult<()> {
        let card_id = self.active_card_id()?;
        let current = Self::lock(&self.card_options)
            .as_ref()
            .and_then(|options| options.iter().find(|option| option.id == card_id))
            .map(|option| option.name.clone())
            .unwrap_or_else(|| card_id.clone());
        let Some(name) = crate::ui::platform::imp::prompt_text(
            "重命名 Card",
            "新显示名（文件名、阶段文案与变量状态不受影响）",
            &current,
        )?
        else {
            return Ok(()); // 取消：不写任何值
        };
        self.card_manage(CardManageOp::Rename { card_id, name })
    }

    /// 草稿里选中的 Card id（没有选中项时如实报错）。
    fn active_card_id(&self) -> AppResult<String> {
        Self::lock(&self.draft)
            .value("ai.personality.active")
            .and_then(SettingsValue::as_text)
            .map(ToString::to_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Other("没有选中的 Card".into()))
    }

    // ── 本批：工具页动作 ──

    fn mcp_import(&self) -> AppResult<()> {
        self.set_notice(Some("正在导入 MCP 配置…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-mcp-import".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.mcp_import() {
                    Ok((_, true)) => ui.set_notice(Some("已取消导入".into())),
                    Ok((count, false)) => {
                        ui.set_notice(Some(format!("已导入 {count} 个 MCP 服务器")));
                        ui.spawn_tools_fetch();
                    }
                    Err(error) => ui.set_error(format!("MCP 导入失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("MCP 导入线程创建失败: {error}"))),
        }
    }

    fn mcp_export(&self) -> AppResult<()> {
        self.set_notice(Some("正在导出 MCP 配置…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-mcp-export".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.mcp_export() {
                    Ok(Some(path)) => ui.set_notice(Some(format!("MCP 配置已导出：{path}"))),
                    Ok(None) => ui.set_notice(Some("已取消导出".into())),
                    Err(error) => ui.set_error(format!("MCP 导出失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("MCP 导出线程创建失败: {error}"))),
        }
    }

    fn skill_upload(&self) -> AppResult<()> {
        self.set_notice(Some("正在上传 Skill…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-skill-upload".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.skill_upload() {
                    Ok(Some(name)) => {
                        ui.set_notice(Some(format!("Skill 已上传：{name}")));
                        ui.spawn_tools_fetch();
                    }
                    Ok(None) => ui.set_notice(Some("已取消上传".into())),
                    Err(error) => ui.set_error(format!("Skill 上传失败（未写入）：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("Skill 上传线程创建失败: {error}"))),
        }
    }

    /// 管理面行次动作（MCP 编辑/删除、Skill 删除）。
    pub fn panel_secondary_action(
        &self,
        panel: &str,
        row_id: &str,
        action: RowAction,
    ) -> AppResult<()> {
        match (panel, action) {
            (panels::PANEL_MCP, RowAction::Edit) => {
                self.open_document(DocumentTarget::McpServer {
                    name: row_id.to_string(),
                });
                Ok(())
            }
            (panels::PANEL_MCP, RowAction::Delete) => self.spawn_row_delete(panel, row_id, "删除"),
            (panels::PANEL_SKILLS, RowAction::Delete) => {
                self.spawn_row_delete(panel, row_id, "删除")
            }
            _ => Err(AppError::Other(format!("行 {row_id} 没有可执行的次动作"))),
        }
    }

    fn spawn_row_delete(&self, panel: &str, row_id: &str, label: &'static str) -> AppResult<()> {
        let (panel, row_id) = (panel.to_string(), row_id.to_string());
        self.set_notice(Some(format!("正在{label}…")));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-row-delete".into())
            .spawn(move || {
                let ui = settings_ui();
                let result = match panel.as_str() {
                    panels::PANEL_MCP => port.mcp_delete(&row_id),
                    panels::PANEL_SKILLS => port.skill_delete(&row_id),
                    _ => Err(AppError::Other("未知面板".into())),
                };
                match result {
                    Ok(()) => {
                        ui.set_notice(Some(format!("{row_id} 已{label}")));
                        ui.spawn_tools_fetch();
                    }
                    Err(error) => ui.set_error(format!("{label}失败（未改动）：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("{label}线程创建失败: {error}"))),
        }
    }

    // ── 本批：记忆页动作 ──

    /// 记忆范围筛选（None = 全部）；设置后立即重拉条目列表。
    pub fn set_memory_scope(&self, scope: Option<&str>) {
        *Self::lock(&self.memory_scope) = scope.map(ToString::to_string);
        self.spawn_memory_fetch();
        self.refresh();
    }

    fn memory_sweep(&self) -> AppResult<()> {
        self.set_notice(Some("正在整理记忆（可能需要一段时间）…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-sweep".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.memory_dreaming_sweep() {
                    Ok(message) => {
                        ui.set_notice(Some(message));
                        ui.spawn_memory_fetch();
                    }
                    Err(error) => ui.set_notice(Some(format!("记忆整理未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("记忆整理线程创建失败: {error}"))),
        }
    }

    fn memory_maintenance(&self, op: MemoryMaintenanceOp) -> AppResult<()> {
        self.set_notice(Some("正在执行记忆维护…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-maintenance".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.memory_maintenance(op) {
                    Ok(message) => {
                        ui.set_notice(Some(message));
                        ui.spawn_memory_fetch();
                    }
                    Err(error) => ui.set_notice(Some(format!("记忆维护未完成：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("记忆维护线程创建失败: {error}"))),
        }
    }

    fn memory_restore(&self, preview_only: bool) -> AppResult<()> {
        self.set_notice(Some(
            if preview_only {
                "正在预检备份…"
            } else {
                "正在恢复备份…"
            }
            .into(),
        ));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-restore".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.memory_restore(preview_only) {
                    Ok(message) => {
                        ui.set_notice(Some(message));
                        if !preview_only {
                            ui.spawn_memory_fetch();
                        }
                    }
                    Err(error) => ui.set_notice(Some(format!(
                        "{}未完成：{error}",
                        if preview_only {
                            "备份预检"
                        } else {
                            "恢复"
                        }
                    ))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("恢复线程创建失败: {error}"))),
        }
    }

    /// 打开「来源原话」只读文档：对当前选中条目的来源逐条取证据（上限 5 条）。
    fn open_evidence_document(&self) -> AppResult<()> {
        let source_ids = {
            let state = Self::lock(&self.panels);
            state
                .detail
                .as_ref()
                .map(|detail| detail.source_ids.clone())
                .unwrap_or_default()
        };
        if source_ids.is_empty() {
            self.set_notice(Some("该条目没有可回看的来源".into()));
            return Ok(());
        }
        let target = DocumentTarget::MemoryEvidence;
        *Self::lock(&self.document) = Some(DocumentState {
            title: document_title(&target),
            target: target.clone(),
            content: String::new(),
            loaded: false,
        });
        self.refresh();
        if self.document_in_flight.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-evidence".into())
            .spawn(move || {
                let mut text = String::new();
                for (index, source_id) in source_ids.iter().take(5).enumerate() {
                    match port.memory_source_evidence(source_id) {
                        Ok(entry) => {
                            if index > 0 {
                                text.push_str("\n\n────────────────\n\n");
                            }
                            text.push_str(&entry);
                        }
                        Err(error) => {
                            if index > 0 {
                                text.push_str("\n\n────────────────\n\n");
                            }
                            text.push_str(&format!("【来源 {source_id}】读取失败：{error}"));
                        }
                    }
                }
                if source_ids.len() > 5 {
                    text.push_str(&format!(
                        "\n\n（其余 {} 条来源未展开：一次最多显示 5 条）",
                        source_ids.len() - 5
                    ));
                }
                let ui = settings_ui();
                {
                    let mut doc = Self::lock(&ui.document);
                    if let Some(state) = doc.as_mut() {
                        if state.target == target {
                            state.content = text;
                            state.loaded = true;
                        }
                    }
                }
                ui.note_document_changed();
                ui.document_in_flight.store(false, Ordering::SeqCst);
                ui.refresh();
            });
        if let Err(error) = spawn {
            self.document_in_flight.store(false, Ordering::SeqCst);
            rust_warn!("来源原话线程创建失败: {error}");
        }
        Ok(())
    }

    /// 强制重拉 Profile 列表（外部增删 Profile 后不用重开设置窗）。
    ///
    /// 清缓存后走既有 `ensure_profiles`（在途去重；失败经通知如实呈现）。
    pub fn refresh_profiles(&self) -> AppResult<()> {
        *Self::lock(&self.profile_options) = None;
        self.ensure_profiles();
        Ok(())
    }

    // `preview_popup_size` 删除记录（2026-10-05 用户规则「…以及预览尺寸，没必要留」）：
    // 动作字段与函数一并退场（平台侧的 `action.previewPopupSize` 分支同批删除）。
    // 窗口尺寸改用鼠标直接调（`set_popup_size` 运行期入口不变，拖动仍会写回 CONFIG）。

    // `number_value` 删除记录（2026-10-05）：它唯一的消费者是随「预览尺寸」一起退场的
    // `preview_popup_size` 已删。**注意它的语义**（按 schema 值域夹取；缺键即如实报错、
    // 不落兜底值）是这一族的正确口径 —— 将来再有「读草稿里的数值去驱动窗口/系统」的需求，
    // 按原样加回来，**不要**改成 `unwrap_or(默认值)`。

    /// 录制结果落草稿：按键归一化与组合校验走 `ui::shortcut::parse_spec`（唯一校验点，
    /// 至少一个修饰键的护栏也在那里）；修饰键按平台写入对应的 CONFIG 键。
    ///
    /// `modifiers_key` 由平台层传入（macOS=`general.shortcut.macModifiers`
    /// / Windows=`general.shortcut.winModifiers`）——平台边界只此一处。
    pub fn apply_shortcut(
        &self,
        key: &str,
        modifiers: ShortcutModifiers,
        modifiers_key: &str,
    ) -> AppResult<()> {
        write_shortcut(&mut Self::lock(&self.draft), key, modifiers, modifiers_key)?;
        self.refresh();
        Ok(())
    }

    /// 「重启」：先把草稿写盘（有改动时），成功后才走统一退出序列重启。
    ///
    /// 写盘失败不重启（旧设置面板同语义）：直接重启会把未落盘的改动丢掉，
    /// 用户以为是「重启后生效」，实际是改动没了。没有改动时直接重启。
    pub fn restart_app(&self) -> AppResult<()> {
        let changes = Self::lock(&self.draft).changes();
        if changes.is_empty() {
            self.set_notice(Some("正在重启…".into()));
            return updates::request_restart();
        }
        if self.saving.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次保存还在进行中".into()));
            return Ok(());
        }
        self.set_notice(Some("正在保存并重启…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-restart".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.commit(&changes) {
                    Ok(()) => {
                        Self::lock(&ui.draft).mark_saved();
                        // 提交已完成：先落回 saving 态，重启失败时界面不卡在「保存中」。
                        ui.saving.store(false, Ordering::SeqCst);
                        // 重启失败不改写已保存的事实：文案只说「重启失败」。
                        if let Err(error) = updates::request_restart() {
                            ui.set_error(format!(
                                "设置已保存，但重启失败：{error}；可稍后手动重启"
                            ));
                        }
                    }
                    Err(error) => {
                        ui.saving.store(false, Ordering::SeqCst);
                        ui.set_error(format!("配置写盘失败，已取消重启：{error}"));
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                self.saving.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("重启线程创建失败: {error}")))
            }
        }
    }

    /// 手动检查更新（后台执行、结果以中性通知呈现）。
    ///
    /// 失败文案由 [updates::check_interactive] 带阶段前缀（检查 / 下载校验 / 重启），
    /// 这里原样呈现；成功时不覆写候选或安装提示。
    pub fn check_update(&self) -> AppResult<()> {
        self.set_notice(Some("正在检查更新…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-update".into())
            .spawn(move || match port.check_update() {
                Ok(()) => {} // 具体结果由 UpdatePort 交互流程留痕/呈现，不能覆盖候选与安装状态。
                Err(error) => settings_ui().set_notice(Some(format!("{error}"))),
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("更新检查线程创建失败: {error}"))),
        }
    }

    /// 保存：后台提交草稿改动；成功后才更新基线。
    pub fn save(&self) -> AppResult<()> {
        let changes = Self::lock(&self.draft).changes();
        if changes.is_empty() {
            self.set_notice(Some("没有需要保存的改动".into()));
            return Ok(());
        }
        if self.saving.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次保存还在进行中".into()));
            return Ok(());
        }
        self.set_notice(Some("正在保存…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-save".into())
            .spawn(move || match port.commit(&changes) {
                Ok(()) => {
                    let ui = settings_ui();
                    let font_snapshot = {
                        let mut draft = Self::lock(&ui.draft);
                        draft.mark_saved();
                        draft.font_snapshot()
                    };
                    // 保存成功 = 字体预览成为已提交基线（再应用一次，保证与磁盘一致）。
                    let applied = font::store(font_snapshot);
                    if let Err(error) = crate::ui::platform::imp::apply_font_snapshot(applied) {
                        rust_warn!("保存后字体应用失败: {error}");
                    }
                    ui.saving.store(false, Ordering::SeqCst);
                    ui.set_notice(Some("已保存".into()));
                }
                Err(error) => {
                    let ui = settings_ui();
                    ui.saving.store(false, Ordering::SeqCst);
                    ui.set_error(format!("保存失败（改动保留在草稿里）：{error}"));
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                self.saving.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("保存线程创建失败: {error}")))
            }
        }
    }

    /// 中性通知（保存回执、未接线说明等）—— 走**顶部浮层**分档。
    ///
    /// 与 [`Self::set_error`] 是一对：这里只装「告知」，不装「失败」。
    /// 拿不准时用这个（宁可轻一档，也不该把回执弹成要确认的模态）。
    pub fn set_notice(&self, notice: Option<String>) {
        self.set_notice_with(NoticeLevel::Info, notice);
    }

    /// 错误通知 —— 走**模态弹窗**分档，用户必须确认。
    ///
    /// 判据：**这次操作没有成功**，且用户需要知道（保存失败、校验不过、动作未执行）。
    /// 纯告知性的（「已保存」「正在刷新」）用 [`Self::set_notice`]。
    pub fn set_error(&self, notice: impl Into<String>) {
        self.set_notice_with(NoticeLevel::Error, Some(notice.into()));
    }

    /// 警告通知 —— 走顶部浮层，但配色取 `warn`（未就绪 / 部分成功）。
    pub fn set_warning(&self, notice: impl Into<String>) {
        self.set_notice_with(NoticeLevel::Warning, Some(notice.into()));
    }

    fn set_notice_with(&self, level: NoticeLevel, notice: Option<String>) {
        *Self::lock(&self.notice_level) = level;
        *Self::lock(&self.notice) = notice;
        // 代际只对**非空**通知推进：清空通知（`set_notice(None)`）不该被平台
        // 当成「来了一条新通知」而去弹一次空浮层。
        if Self::lock(&self.notice).is_some() {
            *Self::lock(&self.notice_generation) += 1;
        }
        self.refresh();
    }

    /// 请求字体族列表（窗口打开时一次；已缓存则直接刷新界面）。
    pub fn ensure_font_families(&self) {
        if Self::lock(&self.font_families).is_some() {
            self.refresh();
            return;
        }
        // 枚举是数百毫秒级的同步 IO（fontdb 扫描），必须离开主线程。
        if self.fonts_loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-fonts".into())
            .spawn(|| {
                let families = Arc::new(crate::commands::font_cmd::list_system_fonts());
                let ui = settings_ui();
                *Self::lock(&ui.font_families) = Some(families.clone());
                ui.fonts_loading.store(false, Ordering::SeqCst);
                rust_info!("系统字体枚举完成：{} 个族", families.len());
                ui.refresh();
            });
        if let Err(error) = spawn {
            self.fonts_loading.store(false, Ordering::SeqCst);
            rust_warn!("字体枚举线程创建失败: {error}");
        }
    }

    // ── 人格卡选项 ──

    /// 请求人格卡列表（窗口打开时一次；已缓存则直接刷新界面）。
    ///
    /// 选项来自 Node 的人格注册表（`SettingsPort::cards`）；未接线/失败时如实
    /// 通知，不留假列表。工作线程执行（可能要走 IPC），结果经主线程队列回投。
    pub fn ensure_cards(&self) {
        if Self::lock(&self.card_options).is_some() {
            self.refresh();
            return;
        }
        if self.cards_loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-cards".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.cards() {
                    Ok(options) => {
                        *Self::lock(&ui.card_options) = Some(Arc::new(options));
                        ui.cards_loading.store(false, Ordering::SeqCst);
                        ui.refresh();
                    }
                    Err(error) => {
                        ui.cards_loading.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("人格卡列表不可用：{error}")));
                        rust_warn!("人格卡列表拉取失败: {error}");
                    }
                }
            });
        if let Err(error) = spawn {
            self.cards_loading.store(false, Ordering::SeqCst);
            rust_warn!("人格卡列表线程创建失败: {error}");
        }
    }

    /// 当前展示用的人格卡列表（平台控件重建选项时取，与 `view()` 同源）。
    pub fn card_options(&self) -> Option<Arc<Vec<CardOption>>> {
        Self::lock(&self.card_options).clone()
    }

    // ── Profile 选项（外观页，W9c 管理面第三步）──

    /// 请求激活 Profile 列表（外观页打开时一次；已缓存则直接刷新界面）。
    ///
    /// 选项来自 Node 的 Profile 域（`discoverAllProfiles` + `readProfileMeta` 的轻量读；
    /// 不把 Profile 内容带进设置窗，也不进内存缓存）。切换由 Node 走
    /// `switchActiveProfile` 唯一入口（激活、落盘、通知其它窗口一体收口）。
    pub fn ensure_profiles(&self) {
        if Self::lock(&self.profile_options).is_some() {
            self.refresh();
            return;
        }
        if self.profiles_loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-profiles".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.profiles() {
                    Ok(options) => {
                        *Self::lock(&ui.profile_options) = Some(Arc::new(options));
                        ui.profiles_loading.store(false, Ordering::SeqCst);
                        ui.refresh();
                    }
                    Err(error) => {
                        ui.profiles_loading.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("Profile 列表不可用：{error}")));
                        rust_warn!("Profile 列表拉取失败: {error}");
                    }
                }
            });
        if let Err(error) = spawn {
            self.profiles_loading.store(false, Ordering::SeqCst);
            rust_warn!("Profile 列表线程创建失败: {error}");
        }
    }

    /// 当前展示用的 Profile 列表（平台控件重建选项时取，与 `view()` 同源）。
    pub fn profile_options(&self) -> Option<Arc<Vec<ProfileOption>>> {
        Self::lock(&self.profile_options).clone()
    }

    // ── 管理面（W9d）：工具页 ──

    /// 管理面数据代数：数据每次变化 +1；平台层只在代数变化时重建面板控件。
    pub fn panel_generation(&self) -> u64 {
        Self::lock(&self.panels).generation
    }

    /// 工具页的三个面板（渲染快照）。
    pub fn tools_panels(&self) -> Vec<ListPanel> {
        let state = Self::lock(&self.panels);
        vec![
            ListPanel {
                id: panels::PANEL_MCP,
                title: "MCP 服务器",
                hint: "按每服务器开关控制，全部关闭即不使用 MCP；启用的服务器在运行开始时借用、结束即释放（占用中的服务器拒绝开关）。".to_string(),
                error: state.mcp_error.clone(),
                warning: None,
                loaded: state.tools_loaded,
                rows: state.mcp.clone(),
            },
            ListPanel {
                id: panels::PANEL_SKILLS,
                title: "Skill",
                hint: "关闭只是停用（删除在文件系统处理）；开关写入 SKILL.md 的 enabled 字段，下一个回合生效。Skill 不额外授予工具权限。".to_string(),
                error: state.skills_error.clone(),
                warning: state.skills_index_error.clone(),
                loaded: state.tools_loaded,
                rows: state.skills.clone(),
            },
            ListPanel {
                id: panels::PANEL_POLICIES,
                title: "工具策略（声明）",
                hint: "只读：工具在代码里声明的默认策略，不代表本次运行的有效授权；实际执行仍按本次参数与权限终裁。".to_string(),
                error: state.policies_error.clone(),
                warning: None,
                loaded: state.tools_loaded,
                rows: state.policies.clone(),
            },
        ]
    }

    /// 首次进入工具页：拉取三个面板（一次后台任务、代数只 +1）。
    pub fn ensure_tools_panels(&self) {
        {
            let state = Self::lock(&self.panels);
            if state.tools_loaded || state.tools_loading {
                return;
            }
        }
        self.spawn_tools_fetch();
    }

    /// 工具页「刷新」：强制重拉（在途去重，不叠加请求）。
    pub fn refresh_tools_panels(&self) {
        self.spawn_tools_fetch();
    }

    fn spawn_tools_fetch(&self) {
        {
            let mut state = Self::lock(&self.panels);
            if state.tools_loading {
                return;
            }
            state.tools_loading = true;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-tools".into())
            .spawn(move || {
                // 三个面板各自成败：失败面板记原因，成功面板照常显示（互不拖累）。
                // 阻塞的 IPC 调用不在锁内进行（锁只用于装卸快照）。
                let mcp = port.mcp_servers();
                let skills = port.skills();
                let policies = port.tool_policies();
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    match mcp {
                        Ok(rows) => {
                            state.mcp = rows;
                            state.mcp_error = None;
                        }
                        Err(error) => state.mcp_error = Some(format!("列表读取失败：{error}")),
                    }
                    match skills {
                        Ok(catalog) => {
                            state.skills = catalog.rows;
                            state.skills_index_error = catalog.index_error;
                            state.skills_error = None;
                        }
                        Err(error) => state.skills_error = Some(format!("列表读取失败：{error}")),
                    }
                    match policies {
                        Ok(rows) => {
                            state.policies = rows;
                            state.policies_error = None;
                        }
                        Err(error) => state.policies_error = Some(format!("列表读取失败：{error}")),
                    }
                    state.tools_loaded = true;
                    state.tools_loading = false;
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            Self::lock(&self.panels).tools_loading = false;
            rust_warn!("工具面板拉取线程创建失败: {error}");
        }
    }

    /// 逐项开关一个 MCP 服务器 / Skill：先读快照取反，后台走既有写入口，成功后重读面板。
    pub fn toggle_panel_row(&self, panel: &str, row_id: &str) -> AppResult<()> {
        let (panel, row_id, enabled) = {
            let state = Self::lock(&self.panels);
            let rows: Option<&Vec<PanelRow>> = match panel {
                panels::PANEL_MCP => Some(&state.mcp),
                panels::PANEL_SKILLS => Some(&state.skills),
                _ => None,
            };
            let Some(rows) = rows else {
                return Err(AppError::Other(format!("面板 {panel} 没有可切换的行")));
            };
            let Some(row) = rows.iter().find(|row| row.id == row_id) else {
                // 列表在用户点击的间隙被重读过：不猜状态，要求刷新。
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            };
            if row.action != RowAction::Toggle {
                return Err(AppError::Other(format!("行 {row_id} 不是开关行")));
            }
            (panel.to_string(), row_id.to_string(), !row.enabled)
        };
        self.set_notice(Some("正在写入…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-toggle".into())
            .spawn(move || {
                let ui = settings_ui();
                let result = match panel.as_str() {
                    panels::PANEL_MCP => port.set_mcp_server_enabled(&row_id, enabled),
                    panels::PANEL_SKILLS => port.set_skill_enabled(&row_id, enabled),
                    _ => Err(AppError::Other("未知面板".into())),
                };
                match result {
                    Ok(()) => {
                        ui.set_notice(Some(format!(
                            "{row_id} 已{}",
                            if enabled { "启用" } else { "关闭" }
                        )));
                        // 写入口可能改变列表内容（如自定义服务器被删/占用拒绝的后续状态）：
                        // 以 Node 重读为准，界面不自行推进本地行状态。
                        ui.spawn_tools_fetch();
                    }
                    Err(error) => ui.set_notice(Some(format!("开关未生效：{error}"))),
                }
            });
        if let Err(error) = spawn {
            return Err(AppError::Other(format!("开关线程创建失败: {error}")));
        }
        Ok(())
    }

    // ── 本批：外观页（音效试听面板）──

    /// 外观页的音效试听面板（渲染快照）。
    pub fn sound_panels(&self) -> Vec<ListPanel> {
        let state = Self::lock(&self.panels);
        vec![ListPanel {
            id: panels::PANEL_SOUNDS,
            title: "音效分配",
            hint: "点开行内下拉更改各事件音效（none = 静音，立即生效）；「试听」播放该事件当前分配，「↺ 恢复默认」清空自定义分配。".to_string(),
            error: state.sounds_error.clone(),
            warning: None,
            loaded: state.sounds_loaded,
            rows: state.sounds.clone(),
        }]
    }

    /// 首次进入外观页：拉取音效试听行（在途去重）。
    pub fn ensure_sound_panel(&self) {
        {
            let state = Self::lock(&self.panels);
            if state.sounds_loaded || state.sounds_loading {
                return;
            }
        }
        self.spawn_sound_fetch();
    }

    /// 音效面板「刷新」/ 保存分配后重读。
    pub fn refresh_sound_panel(&self) {
        self.spawn_sound_fetch();
    }

    fn spawn_sound_fetch(&self) {
        {
            let mut state = Self::lock(&self.panels);
            if state.sounds_loading {
                return;
            }
            state.sounds_loading = true;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-sounds".into())
            .spawn(move || {
                let result = port.sound_library();
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    match result {
                        Ok(library) => {
                            state.sounds = library.rows;
                            state.sounds_error = None;
                        }
                        Err(error) => {
                            state.sounds_error = Some(format!("音效列表读取失败：{error}"))
                        }
                    }
                    state.sounds_loaded = true;
                    state.sounds_loading = false;
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            Self::lock(&self.panels).sounds_loading = false;
            rust_warn!("音效面板拉取线程创建失败: {error}");
        }
    }

    /// 试听一条音效（不改配置；失败如实提示）。
    fn preview_sound(&self, sound_id: &str) -> AppResult<()> {
        if sound_id.is_empty() {
            return Err(AppError::Config("试听缺少音效 id".into()));
        }
        self.set_notice(Some("正在试听…".into()));
        let port = Self::lock(&self.port).clone();
        let sound_id = sound_id.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-sound-preview".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.sound_preview(&sound_id) {
                    Ok(()) => ui.set_notice(Some(format!("已试听：{sound_id}"))),
                    Err(error) => ui.set_error(format!("试听失败：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("试听线程创建失败: {error}"))),
        }
    }

    /// 面板行「试听」：播放该行当前分配的音效。
    ///
    /// 平台只回传行 id（= 事件键）；当前分配值从行快照的 `pick.selected` 取
    /// （平台不解析行数据）。`none`/缺行如实拒绝，不静默播别的。
    pub fn preview_panel_row(&self, panel: &str, row_id: &str) -> AppResult<()> {
        if panel != panels::PANEL_SOUNDS {
            return Err(AppError::Other(format!("面板 {panel} 没有可试听的行")));
        }
        let selected = {
            let state = Self::lock(&self.panels);
            let Some(row) = state.sounds.iter().find(|row| row.id == row_id) else {
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            };
            row.pick.as_ref().map(|pick| pick.selected.clone())
        };
        match selected {
            Some(sound_id) if sound_id != "none" && !sound_id.is_empty() => {
                self.preview_sound(&sound_id)
            }
            Some(_) => Err(AppError::Config("该事件当前是静音，没有可试听的内容".into())),
            None => Err(AppError::Other(format!("行 {row_id} 没有音效分配"))),
        }
    }

    /// 行内下拉选择一个值（当前只有音效事件行）：与 `toggle_panel_row` 同构 ——
    /// 先读快照校验行与动作，再后台走领域写入口；**不自行推进本地选中值**，
    /// 成功后以 Node 重读为准（失败如实提示，不把「没写进去」显示成已更新）。
    pub fn pick_panel_row(&self, panel: &str, row_id: &str, value: &str) -> AppResult<()> {
        if panel != panels::PANEL_SOUNDS {
            return Err(AppError::Other(format!("面板 {panel} 没有下拉行")));
        }
        {
            let state = Self::lock(&self.panels);
            let Some(row) = state.sounds.iter().find(|row| row.id == row_id) else {
                return Err(AppError::Other("列表已更新，请刷新后重试".into()));
            };
            if row.action != RowAction::Pick {
                return Err(AppError::Other(format!("行 {row_id} 不是下拉行")));
            }
        }
        self.set_notice(Some("正在写入音效分配…".into()));
        let port = Self::lock(&self.port).clone();
        let row_id = row_id.to_string();
        let value = value.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-sound-assign".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.sound_set_assignment(&row_id, &value) {
                    Ok(()) => {
                        ui.set_notice(Some(format!("音效已更新：{row_id} → {value}")));
                        // 写入口改变行内容（选中值/试听可用性）：以 Node 重读为准。
                        ui.refresh_sound_panel();
                    }
                    Err(error) => ui.set_error(format!("音效分配未生效：{error}")),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("音效分配线程创建失败: {error}"))),
        }
    }

    /// 音效「↺ 恢复默认」：把所有事件分配恢复为内置默认（清空分配覆盖）。
    ///
    /// 语义定义点在 Node（`sound_reset` 清空分配覆盖 = 全事件回默认）；这里只投
    /// 请求并重读面板，失败如实提示（不把「没写进去」显示成已恢复）。
    pub fn sound_reset_defaults(&self) -> AppResult<()> {
        self.set_notice(Some("正在恢复默认音效…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-sound-reset".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.sound_reset() {
                    Ok(()) => {
                        ui.set_notice(Some("音效分配已恢复默认".to_string()));
                        ui.refresh_sound_panel();
                    }
                    Err(error) => {
                        ui.set_error(format!("恢复默认音效失败（未写入）：{error}"))
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("音效恢复线程创建失败: {error}"))),
        }
    }

    // ── 管理面（W9d）：记忆页 ──

    /// 记忆页两个面板（条目 + 自动整理）。
    pub fn memory_panels(&self) -> Vec<ListPanel> {
        let state = Self::lock(&self.panels);
        let overview = state.memory.clone().unwrap_or_else(MemoryOverview::empty);
        vec![
            ListPanel {
                id: panels::PANEL_MEMORY_ITEMS,
                title: "已记住",
                hint: "纠正与遗忘立即提交（不走设置保存），遗忘只清应用管理的记忆与回灌资格：原始聊天、已导出文件与外部备份要另在会话管理或文件系统里处理。".to_string(),
                error: state.memory_error.clone(),
                warning: None,
                loaded: state.memory_loaded,
                rows: overview.items,
            },
            ListPanel {
                id: panels::PANEL_MEMORY_JOBS,
                // 面板名对齐旧壳的「自动整理」小节（下面的列表即「历史作业」）。
                title: "自动整理",
                hint: "整理由运行期自动触发（空闲或手动入口在聊天侧）；这里只读历史作业状态，冲突、失败或取消都有明确终态。".to_string(),
                error: state.memory_error.clone(),
                warning: None,
                loaded: state.memory_loaded,
                rows: overview.jobs,
            },
        ]
    }

    /// 记忆状态行（「库版本 revision N · …」；未读到为 None）。
    /// 有范围筛选时前缀标注当前筛选（界面显示的筛选必须与实际查询一致）。
    pub fn memory_status_text(&self) -> Option<String> {
        let state = Self::lock(&self.panels);
        if !state.memory_loaded {
            return None;
        }
        let status = state
            .memory
            .as_ref()
            .map(|overview| overview.status_text.clone())
            .unwrap_or_default();
        let scope = match Self::lock(&self.memory_scope).as_deref() {
            Some("user") => "筛选：仅用户级　",
            Some("card") => "筛选：仅当前角色　",
            Some("session") => "筛选：仅当前会话　",
            _ => "",
        };
        Some(format!("{scope}{status}"))
    }

    /// 详情区渲染状态（未选中 / 读取中 / 失败 / 就绪）。
    pub fn memory_detail_state(&self) -> MemoryDetailState {
        let state = Self::lock(&self.panels);
        if let Some(error) = &state.detail_error {
            return MemoryDetailState::Error(error.clone());
        }
        if let Some(detail) = &state.detail {
            return MemoryDetailState::Ready(panels::MemoryDetailView {
                item_id: detail.item_id.clone(),
                version: detail.version,
                pinned: detail.pinned,
                info: detail.info.clone(),
                content: state
                    .content_draft
                    .clone()
                    .unwrap_or_else(|| detail.content.clone()),
                history: detail.history.clone(),
            });
        }
        if state.detail_loading {
            MemoryDetailState::Loading
        } else {
            MemoryDetailState::None
        }
    }

    /// 首次进入记忆页：拉取总览（状态 + 条目 + 作业）。
    pub fn ensure_memory(&self) {
        {
            let state = Self::lock(&self.panels);
            if state.memory_loaded || state.memory_loading {
                return;
            }
        }
        self.spawn_memory_fetch();
    }

    /// 记忆页「刷新」：强制重拉总览（在途去重）。
    pub fn refresh_memory(&self) {
        self.spawn_memory_fetch();
    }

    fn spawn_memory_fetch(&self) {
        {
            let mut state = Self::lock(&self.panels);
            if state.memory_loading {
                return;
            }
            state.memory_loading = true;
        }
        let port = Self::lock(&self.port).clone();
        let scope = Self::lock(&self.memory_scope).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory".into())
            .spawn(move || {
                let result = port.memory_overview(scope.as_deref(), None);
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    match result {
                        Ok(overview) => {
                            state.memory = Some(overview);
                            state.memory_error = None;
                        }
                        Err(error) => state.memory_error = Some(format!("记忆库读取失败：{error}")),
                    }
                    state.memory_loaded = true;
                    state.memory_loading = false;
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            Self::lock(&self.panels).memory_loading = false;
            rust_warn!("记忆面板拉取线程创建失败: {error}");
        }
    }

    /// 点开一条记忆：后台拉详情 + 历史；换条目先清旧详情与草稿。
    pub fn open_memory_item(&self, id: &str) {
        if id.is_empty() {
            return;
        }
        {
            let mut state = Self::lock(&self.panels);
            state.detail = None;
            state.detail_error = None;
            state.detail_loading = true;
            state.content_draft = None;
            state.generation += 1;
        }
        self.refresh();
        let port = Self::lock(&self.port).clone();
        let id = id.to_string();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-detail".into())
            .spawn(move || {
                let result = port.memory_item_detail(&id);
                let ui = settings_ui();
                {
                    let mut state = Self::lock(&ui.panels);
                    state.detail_loading = false;
                    match result {
                        Ok(detail) => state.detail = Some(detail),
                        Err(error) => state.detail_error = Some(format!("详情读取失败：{error}")),
                    }
                    state.generation += 1;
                }
                ui.refresh();
            });
        if let Err(error) = spawn {
            let mut state = Self::lock(&self.panels);
            state.detail_loading = false;
            state.detail_error = Some(format!("详情线程创建失败: {error}"));
            drop(state);
            self.refresh();
        }
    }

    /// 平台在重建详情控件前暂存文本框内容（未保存编辑不因刷新丢失）。
    pub fn stash_memory_content(&self, content: &str) {
        let mut state = Self::lock(&self.panels);
        if state.detail.is_some() {
            state.content_draft = Some(content.to_string());
        }
    }

    /// 保存纠正：同一 id 写新版本（旧版本转 superseded，历史仍可查）。
    pub fn memory_save_correction(&self, content: &str) -> AppResult<()> {
        let (item_id, version, revision, committed) = {
            let state = Self::lock(&self.panels);
            let Some(detail) = state.detail.as_ref() else {
                return Err(AppError::Other("没有选中的记忆条目".into()));
            };
            (
                detail.item_id.clone(),
                detail.version,
                detail.revision,
                detail.content.clone(),
            )
        };
        let content = content.trim().to_string();
        if content.is_empty() {
            return Err(AppError::Config("记忆内容不能为空".into()));
        }
        if content == committed {
            self.set_notice(Some("内容没有变化，未提交".into()));
            return Ok(());
        }
        self.spawn_memory_change(
            MemoryChange {
                action: MemoryChangeAction::Update,
                item_id,
                expected_version: version,
                base_revision: revision,
                content: Some(content),
                pinned: None,
            },
            "纠正",
        );
        Ok(())
    }

    /// 核心画像标记：只更新 pinned，保留完整草稿与来源。
    pub fn memory_toggle_pinned(&self) -> AppResult<()> {
        let (item_id, version, revision, pinned) = {
            let state = Self::lock(&self.panels);
            let Some(detail) = state.detail.as_ref() else {
                return Err(AppError::Other("没有选中的记忆条目".into()));
            };
            (
                detail.item_id.clone(),
                detail.version,
                detail.revision,
                detail.pinned,
            )
        };
        self.spawn_memory_change(
            MemoryChange {
                action: MemoryChangeAction::Update,
                item_id,
                expected_version: version,
                base_revision: revision,
                content: None,
                pinned: Some(!pinned),
            },
            if pinned {
                "移出核心画像"
            } else {
                "加入核心画像"
            },
        );
        Ok(())
    }

    /// 遗忘一条记忆（平台层已做原生确认；本域只负责提交）。
    pub fn memory_forget(&self) -> AppResult<()> {
        let (item_id, version, revision) = {
            let state = Self::lock(&self.panels);
            let Some(detail) = state.detail.as_ref() else {
                return Err(AppError::Other("没有选中的记忆条目".into()));
            };
            (detail.item_id.clone(), detail.version, detail.revision)
        };
        self.spawn_memory_change(
            MemoryChange {
                action: MemoryChangeAction::Forget,
                item_id,
                expected_version: version,
                base_revision: revision,
                content: None,
                pinned: None,
            },
            "遗忘",
        );
        Ok(())
    }

    /// 记忆治理变更的后台提交：成功后重读总览与详情（界面显示的永远是已提交状态）。
    fn spawn_memory_change(&self, change: MemoryChange, label: &'static str) {
        if self.memory_change_in_flight.swap(true, Ordering::SeqCst) {
            self.set_notice(Some("上一次记忆操作还在进行中".into()));
            return;
        }
        self.set_notice(Some(format!("正在提交{label}…")));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-memory-change".into())
            .spawn(move || {
                let ui = settings_ui();
                let outcome = port.memory_change(&change);
                let (reload_detail, notice) = match outcome {
                    Ok(revision) => {
                        let mut state = Self::lock(&ui.panels);
                        state.content_draft = None;
                        if change.action == MemoryChangeAction::Forget {
                            // 遗忘成功：条目已不在库里，收起详情。
                            state.detail = None;
                        }
                        let reload = state
                            .detail
                            .as_ref()
                            .map(|detail| detail.item_id.clone());
                        drop(state);
                        let notice = match change.action {
                            MemoryChangeAction::Forget => format!(
                                "已忘记这条记忆（revision {revision}）：原始聊天、已导出文件与外部备份不受影响"
                            ),
                            MemoryChangeAction::Update if change.pinned == Some(true) => {
                                format!("已加入核心画像（revision {revision}）")
                            }
                            MemoryChangeAction::Update if change.pinned == Some(false) => {
                                format!("已移出核心画像（revision {revision}）")
                            }
                            MemoryChangeAction::Update => {
                                format!("已提交纠正并同步运行记忆（revision {revision}）")
                            }
                        };
                        (reload, notice)
                    }
                    Err(error) => (None, format!("{label}未提交：{error}")),
                };
                // 成功后重读总览（无论成败，让界面回到已提交状态；重读失败各自记因）。
                let scope = Self::lock(&ui.memory_scope).clone();
                let overview = port.memory_overview(scope.as_deref(), None);
                {
                    let mut state = Self::lock(&ui.panels);
                    match overview {
                        Ok(overview) => {
                            state.memory = Some(overview);
                            state.memory_error = None;
                        }
                        Err(error) => {
                            state.memory_error = Some(format!("记忆库读取失败：{error}"))
                        }
                    }
                }
                if let Some(id) = reload_detail {
                    let mut state = Self::lock(&ui.panels);
                    match port.memory_item_detail(&id) {
                        Ok(detail) => state.detail = Some(detail),
                        Err(error) => {
                            state.detail_error = Some(format!("详情读取失败：{error}"))
                        }
                    }
                }
                {
                    let mut state = Self::lock(&ui.panels);
                    state.generation += 1;
                }
                ui.memory_change_in_flight.store(false, Ordering::SeqCst);
                ui.set_notice(Some(notice));
            });
        if let Err(error) = spawn {
            self.memory_change_in_flight.store(false, Ordering::SeqCst);
            self.set_error(format!("{label}线程创建失败: {error}"));
        }
    }

    // ── 后台拉取 ──

    fn schedule_fetch(&self, clear_notice: bool) {
        if self.loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-settings-fetch".into())
            .spawn(move || {
                let ui = settings_ui();
                match port.fetch() {
                    Ok(snapshot) => {
                        {
                            let mut draft = Self::lock(&ui.draft);
                            // 拉取期间用户已改的字段保留用户值（后到的旧快照不覆盖草稿）。
                            // 用界面单位的待保存值（与 `set` 同口径）；提交口径的
                            // `changes()` 已换成 CONFIG 单位，不能用于这里。
                            let pending = draft.pending_edits();
                            draft.load(snapshot);
                            for edit in pending {
                                if let Err(error) = draft.set(&edit.key, edit.value) {
                                    rust_debug!("拉取合并草稿失败（忽略该项）: {error}");
                                }
                            }
                        }
                        ui.loading.store(false, Ordering::SeqCst);
                        if clear_notice {
                            ui.set_notice(None);
                        }
                    }
                    Err(error) => {
                        ui.loading.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("设置数据未接线：{error}")));
                    }
                }
            });
        if let Err(error) = spawn {
            self.loading.store(false, Ordering::SeqCst);
            rust_warn!("设置拉取线程创建失败: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(pairs: &[(&str, SettingsValue)]) -> SettingsSnapshot {
        SettingsSnapshot {
            values: pairs
                .iter()
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect(),
        }
    }

    fn bool_snapshot(key: &str, value: bool) -> SettingsSnapshot {
        snapshot(&[(key, SettingsValue::Bool(value))])
    }

    #[test]
    fn 草稿记录改动并在提交后成为基线() {
        let mut draft = SettingsDraft::default();
        draft.load(bool_snapshot("appearance.chatImagePreview", false));
        draft
            .set("appearance.chatImagePreview", SettingsValue::Bool(true))
            .unwrap();
        assert!(draft.is_dirty());
        let changes = draft.changes();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].key, "appearance.chatImagePreview");
        draft.mark_saved();
        assert!(!draft.is_dirty());
        assert_eq!(
            draft.value("appearance.chatImagePreview"),
            Some(&SettingsValue::Bool(true))
        );
    }

    #[test]
    fn 改回原值不再算改动() {
        let mut draft = SettingsDraft::default();
        draft.load(bool_snapshot("appearance.chatImagePreview", true));
        draft
            .set("appearance.chatImagePreview", SettingsValue::Bool(false))
            .unwrap();
        assert!(draft.is_dirty());
        draft
            .set("appearance.chatImagePreview", SettingsValue::Bool(true))
            .unwrap();
        assert!(!draft.is_dirty());
    }

    #[test]
    fn 丢弃草稿回到基线() {
        let mut draft = SettingsDraft::default();
        draft.load(bool_snapshot("appearance.chatImagePreview", false));
        draft
            .set("appearance.chatImagePreview", SettingsValue::Bool(true))
            .unwrap();
        draft.revert_all();
        assert!(!draft.is_dirty());
        assert_eq!(
            draft.value("appearance.chatImagePreview"),
            Some(&SettingsValue::Bool(false))
        );
    }

    #[test]
    fn 未知键与类型不符被拒绝() {
        let mut draft = SettingsDraft::default();
        draft.load(SettingsSnapshot::default());
        assert!(draft.set("nope", SettingsValue::Bool(true)).is_err());
        assert!(
            draft
                .set("general.logging.level", SettingsValue::Bool(true))
                .is_err(),
            "枚举字段不能塞布尔"
        );
        assert!(
            draft
                .set("general.logging.level", SettingsValue::Text("nope".into()))
                .is_err(),
            "非法枚举值被拒绝"
        );
        assert!(draft
            .set("general.logging.level", SettingsValue::Text("debug".into()))
            .is_ok());
    }

    #[test]
    fn 数值越界与非有限值被拒绝() {
        let mut draft = SettingsDraft::default();
        draft.load(SettingsSnapshot::default());
        assert!(draft
            .set("appearance.font.size", SettingsValue::Number(2.0))
            .is_err());
        assert!(draft
            .set("appearance.font.size", SettingsValue::Number(f64::NAN))
            .is_err());
        assert!(draft
            .set("appearance.font.size", SettingsValue::Number(16.0))
            .is_ok());
    }

    #[test]
    fn 动作字段不参与值提交() {
        let mut draft = SettingsDraft::default();
        draft.load(SettingsSnapshot::default());
        assert!(draft
            .set("action.checkUpdate", SettingsValue::Bool(true))
            .is_err());
        // 只读展示字段（`FieldKind::Info`）同理「值只从快照投影、不接受提交」，
        // 但 2026-10-05 撤掉「当前坐标」后**界面上已没有 Info 字段**（见 schema.rs 的说明），
        // 这条断言暂时没有对应字段可钉 —— 机制本身仍在 `FieldKind::Info` 与
        // `validate_value` 的拒绝分支里，待下个只读展示字段出现时补回来。
    }

    #[test]
    fn 字体快照投影只读字体两个键_缺键回落系统() {
        let empty = font_snapshot_from(&SettingsSnapshot::default());
        assert!(empty.is_empty());

        let filled = font_snapshot_from(&snapshot(&[
            (
                "appearance.font.family",
                SettingsValue::Text("PingFang SC".into()),
            ),
            ("appearance.font.size", SettingsValue::Number(16.0)),
            (
                "appearance.effectMode",
                SettingsValue::Text("parallax".into()),
            ),
        ]));
        assert_eq!(filled.family.as_deref(), Some("PingFang SC"));
        assert_eq!(filled.size, Some(16.0));
    }

    #[test]
    fn 字体改动被识别为需要回滚的改动() {
        let mut draft = SettingsDraft::default();
        draft.load(snapshot(&[
            (
                "appearance.font.family",
                SettingsValue::Text("Arial".into()),
            ),
            ("appearance.chatImagePreview", SettingsValue::Bool(false)),
        ]));
        draft
            .set("appearance.chatImagePreview", SettingsValue::Bool(true))
            .unwrap();
        assert!(!draft.font_dirty());
        draft
            .set(
                "appearance.font.family",
                SettingsValue::Text("Songti SC".into()),
            )
            .unwrap();
        assert!(draft.font_dirty());
    }

    #[test]
    fn 未接线端口如实报错() {
        let port = NullSettingsPort;
        assert!(port.fetch().is_err());
        assert!(port.commit(&[]).is_err());
        assert!(port.check_update().is_err());
        // 人格卡列表同样如实报错（不返回空列表冒充「没有 Card」）。
        assert!(port.cards().is_err());
        // Profile 列表同理（未接线不冒充「没有 Profile」）。
        assert!(port.profiles().is_err());
    }

    #[test]
    fn 提交改动按键有序且带值() {
        let mut draft = SettingsDraft::default();
        draft.load(SettingsSnapshot::default());
        draft
            .set("ai.silentAccess.staySeconds", SettingsValue::Number(60.0))
            .unwrap();
        draft
            .set(
                "appearance.effectMode",
                SettingsValue::Text("parallax".into()),
            )
            .unwrap();
        let changes = draft.changes();
        // 按 CONFIG 键**字母序**（`ai.` 排在 `appearance.` 之前 —— 这正是这条测试要钉的口径）。
        assert_eq!(changes[0].key, "ai.silentAccess.staySeconds");
        assert_eq!(changes[1].key, "appearance.effectMode");
    }

    #[test]
    fn 快捷录制写两个键且缺修饰键被拒绝() {
        let mut draft = SettingsDraft::default();
        draft.load(SettingsSnapshot::default());
        let modifiers = ShortcutModifiers {
            control: true,
            command: true,
            alt: false,
            shift: false,
        };
        write_shortcut(&mut draft, "p", modifiers, "general.shortcut.macModifiers").unwrap();
        assert_eq!(
            draft.value("general.shortcut.key"),
            Some(&SettingsValue::Text("P".into())),
            "单字符按键大小写归一化由 parse_spec 收口"
        );
        assert_eq!(
            draft.value("general.shortcut.macModifiers"),
            Some(&SettingsValue::Text("Control\nCommand".into()))
        );

        // 缺修饰键：护栏在 parse_spec，草稿不留脏值。
        let mut bare_draft = SettingsDraft::default();
        bare_draft.load(SettingsSnapshot::default());
        assert!(write_shortcut(
            &mut bare_draft,
            "P",
            ShortcutModifiers::default(),
            "general.shortcut.macModifiers"
        )
        .is_err());
        assert!(!bare_draft.is_dirty());
    }

    #[test]
    fn 固定位置只读投影读x与y两个快照键() {
        let values = BTreeMap::from([
            (
                "general.popup.fixedPosition.x".to_string(),
                SettingsValue::Number(-1290.0),
            ),
            (
                "general.popup.fixedPosition.y".to_string(),
                SettingsValue::Number(88.0),
            ),
        ]);
        assert_eq!(
            info_text("general.popup.fixedPosition", &values),
            "(-1290, 88)"
        );
        assert_eq!(
            info_text("general.popup.fixedPosition", &BTreeMap::new()),
            "未设置"
        );
    }

    #[test]
    fn 快捷键显示投影按平台键拆分修饰键() {
        let values = BTreeMap::from([
            (
                "general.shortcut.key".to_string(),
                SettingsValue::Text("P".into()),
            ),
            (
                "general.shortcut.macModifiers".to_string(),
                SettingsValue::Text("Control\nCommand".into()),
            ),
        ]);
        let (key, modifiers) = shortcut_parts(&values, "general.shortcut.macModifiers").unwrap();
        assert_eq!(key, "P");
        assert_eq!(modifiers, vec!["Control", "Command"]);
        assert!(shortcut_parts(&BTreeMap::new(), "general.shortcut.macModifiers").is_none());
    }

    // ── 本批新增动作：恢复默认（跳过密钥）/ 重启（先写盘）/ 预览尺寸 ──

    #[test]
    fn 恢复默认跳过密钥与非法项只填有效字段() {
        let mut draft = SettingsDraft::default();
        draft.load(snapshot(&[
            ("ai.apiKey", SettingsValue::Text("用户已填的密钥".into())),
            ("appearance.chatImagePreview", SettingsValue::Bool(false)),
        ]));
        let defaults = BTreeMap::from([
            // 模板里的密钥是空串：填进草稿会在保存时把用户凭据抹掉，必须跳过。
            ("ai.apiKey".to_string(), SettingsValue::Text(String::new())),
            (
                "appearance.chatImagePreview".to_string(),
                SettingsValue::Bool(true),
            ),
            (
                "ai.silentAccess.staySeconds".to_string(),
                SettingsValue::Number(60.0),
            ),
            // 未知键不是可编辑字段：跳过而不是进草稿。
            ("nope".to_string(), SettingsValue::Bool(true)),
            // 越界值（字号上限 24）经既有校验被拒：跳过而不是写脏值。
            (
                "appearance.font.size".to_string(),
                SettingsValue::Number(999.0),
            ),
        ]);
        let dirty = draft.apply_defaults(&defaults);
        assert_eq!(dirty, 2, "只有两项有效默认改动进入草稿");
        assert_eq!(
            draft.value("appearance.chatImagePreview"),
            Some(&SettingsValue::Bool(true))
        );
        assert_eq!(
            draft.value("ai.silentAccess.staySeconds"),
            Some(&SettingsValue::Number(60.0))
        );
        // 密钥字段原样保留（既不改值也不标脏）。
        assert_eq!(
            draft.value("ai.apiKey"),
            Some(&SettingsValue::Text("用户已填的密钥".into()))
        );
        assert!(!draft.dirty_keys().any(|key| key == "ai.apiKey"));
        // 未知键与越界值都不进草稿。
        assert!(!draft.dirty_keys().any(|key| key == "nope"));
        assert_eq!(draft.value("appearance.font.size"), None);
        // 返回值 = 草稿改动数（调用方的中性提示用它）。
        assert_eq!(draft.changes().len(), dirty);
    }

    /// 记录提交内容的设置端口替身；`fail` 控制写盘成败。
    struct RecordingPort {
        fail: AtomicBool,
        commits: Mutex<Vec<Vec<SettingEdit>>>,
    }

    impl SettingsPort for RecordingPort {
        fn fetch(&self) -> AppResult<SettingsSnapshot> {
            Err(AppError::Other("测试替身未实现 fetch".into()))
        }

        fn commit(&self, changes: &[SettingEdit]) -> AppResult<()> {
            self.commits
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(changes.to_vec());
            if self.fail.load(Ordering::SeqCst) {
                Err(AppError::Other("磁盘只读".into()))
            } else {
                Ok(())
            }
        }

        fn check_update(&self) -> AppResult<()> {
            Err(AppError::Other("测试替身未实现 check_update".into()))
        }
    }

    /// 有界等待后台线程把状态落进 UI（设置动作是「先返回、后台结算」语义）。
    fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !condition() {
            assert!(std::time::Instant::now() < deadline, "等待超时：{what}");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn 重启先写盘_失败不重启_成功才标记已保存() {
        let ui = settings_ui();
        let port = Arc::new(RecordingPort {
            fail: AtomicBool::new(true),
            commits: Mutex::new(Vec::new()),
        });
        ui.install_port(port.clone());
        {
            let mut draft = ui.draft.lock().unwrap_or_else(|error| error.into_inner());
            draft.load(snapshot(&[(
                "appearance.chatImagePreview",
                SettingsValue::Bool(false),
            )]));
            draft
                .set("appearance.chatImagePreview", SettingsValue::Bool(true))
                .unwrap();
        }

        // 写盘失败：取消重启、草稿保留、saving 复位（可重试）。
        ui.restart_app().unwrap();
        wait_until(
            || {
                ui.view()
                    .notice
                    .as_deref()
                    .is_some_and(|notice| notice.contains("配置写盘失败，已取消重启"))
            },
            "写盘失败通知",
        );
        assert_eq!(
            port.commits
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            1,
            "重启前必须把草稿改动提交一次"
        );
        let commit = port
            .commits
            .lock()
            .unwrap_or_else(|error| error.into_inner())[0]
            .clone();
        assert_eq!(commit.len(), 1);
        assert_eq!(commit[0].key, "appearance.chatImagePreview");
        assert_eq!(commit[0].value, SettingsValue::Bool(true));
        assert!(
            ui.draft
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_dirty(),
            "写盘失败时改动必须保留在草稿里"
        );
        assert!(!ui.saving.load(Ordering::SeqCst), "失败后 saving 必须复位");

        // 写盘成功：改动成为新基线；重启入口在测试进程未安装 → 如实报告「已保存但重启失败」。
        // （失败的改动仍留在草稿里，重试直接提交同一份待保存改动。）
        port.fail.store(false, Ordering::SeqCst);
        ui.restart_app().unwrap();
        wait_until(
            || {
                ui.view()
                    .notice
                    .as_deref()
                    .is_some_and(|notice| notice.contains("设置已保存，但重启失败"))
            },
            "已保存但重启失败通知",
        );
        assert_eq!(
            port.commits
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            2,
            "第二次重启同样先提交"
        );
        assert!(
            !ui.draft
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_dirty(),
            "提交成功后才标记新基线"
        );
        assert!(!ui.saving.load(Ordering::SeqCst));
    }

    #[test]
    fn 无改动时重启不写盘只走重启入口() {
        let ui = SettingsUi::new();
        let port = Arc::new(RecordingPort {
            fail: AtomicBool::new(false),
            commits: Mutex::new(Vec::new()),
        });
        ui.install_port(port.clone());
        // 空草稿：直接重启；重启入口在测试进程未安装 → 如实报错（正是「走没走写盘」的判据）。
        let error = ui.restart_app().unwrap_err();
        assert!(error.to_string().contains("重启入口未初始化"));
        assert!(
            port.commits
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "没有改动时不得产生空提交"
        );
        assert_eq!(
            ui.view().notice.as_deref(),
            Some("正在重启…"),
            "空改动分支的通知不得是「正在保存并重启」"
        );
    }

    /// 竖栏标签映射：范围内才给出 Tab 下标，越界/负值一律拒绝。
    #[test]
    fn 竖栏标签在范围内才映射到_tab_下标() {
        for index in 0..schema::TABS.len() {
            assert_eq!(
                tab_index_for_tag(index as isize),
                Some(index),
                "tag={index} 应映射到下标 {index}"
            );
        }
        assert_eq!(tab_index_for_tag(-1), None, "负 tag 不得落到某个 Tab");
        assert_eq!(
            tab_index_for_tag(schema::TABS.len() as isize),
            None,
            "越界 tag 不得落到某个 Tab"
        );
        assert_eq!(tab_index_for_tag(isize::MAX), None);
    }

    /// 开关镜像表：登记/读取/翻转/回滚写/注销的全部状态迁移。
    #[test]
    fn 开关镜像表状态迁移() {
        let mut states = SwitchStates::default();
        // 未登记：contains 为假、读取兜底关。
        assert!(!states.contains(41));
        assert!(!states.get(41));

        states.register(41, false);
        assert!(states.contains(41));
        assert!(!states.get(41), "登记为关");

        states.set(41, true);
        assert!(states.get(41), "刷新回写开");

        // 翻转返回新状态并落表（点击提交路径）；失败回滚写回旧值。
        assert!(!states.toggle(41), "开→关");
        assert!(!states.get(41));
        assert!(states.toggle(41), "关→开");
        assert!(states.get(41));
        states.set(41, false); // 提交失败的回滚写法
        assert!(!states.get(41));

        states.unregister(41);
        assert!(!states.contains(41), "注销后从绘制分流里消失");

        // 句柄会被系统复用：整体清空后不留陈旧项。
        states.register(7, true);
        states.clear();
        assert!(!states.contains(7));
    }

    // ── 界面单位换算（冷却键：界面秒 / CONFIG 毫秒）──

    /// 换算键表与 schema 必须一致：键存在、是数值控件、界面单位是秒。
    #[test]
    fn 冷却换算键与_schema_的单位一致() {
        assert!(!MS_KEY_DISPLAY_SECONDS.is_empty());
        for key in MS_KEY_DISPLAY_SECONDS {
            let field = field(key).unwrap_or_else(|| panic!("{key} 必须在 schema 里"));
            match field.kind {
                FieldKind::Number { unit, .. } => {
                    assert_eq!(unit, "s", "{key} 是界面秒键，schema 单位必须标秒")
                }
                other => panic!("{key} 必须是数值控件: {other:?}"),
            }
        }
    }

    /// 快照载入按秒取整显示；提交（changes）按毫秒回写；两者互逆到毫秒精度。
    #[test]
    fn 冷却键载入按秒提交按毫秒() {
        let mut draft = SettingsDraft::default();
        draft.load(snapshot(&[
            ("ai.silentAccess.cooldownMs", SettingsValue::Number(5000.0)),
            (
                "ai.silentAccess.samePageCooldownMs",
                SettingsValue::Number(7800.0),
            ),
            // 防抖与停留不是换算键：原样透传（防抖保持毫秒、停留本就秒）。
            ("ai.silentAccess.settleMs", SettingsValue::Number(2000.0)),
            ("ai.silentAccess.staySeconds", SettingsValue::Number(60.0)),
        ]));
        assert_eq!(
            draft.committed_value("ai.silentAccess.cooldownMs"),
            Some(&SettingsValue::Number(5.0)),
            "5000ms → 5s（旧壳 Math.round 口径）"
        );
        assert_eq!(
            draft.committed_value("ai.silentAccess.samePageCooldownMs"),
            Some(&SettingsValue::Number(8.0)),
            "7800ms → 8s（四舍五入）"
        );
        assert_eq!(
            draft.committed_value("ai.silentAccess.settleMs"),
            Some(&SettingsValue::Number(2000.0))
        );
        assert_eq!(
            draft.committed_value("ai.silentAccess.staySeconds"),
            Some(&SettingsValue::Number(60.0))
        );

        // 用户在界面把冷却从 5s 改成 7s：提交值必须是 7000ms。
        draft
            .set("ai.silentAccess.cooldownMs", SettingsValue::Number(7.0))
            .unwrap();
        assert!(draft.is_dirty());
        let changes = draft.changes();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].key, "ai.silentAccess.cooldownMs");
        assert_eq!(changes[0].value, SettingsValue::Number(7000.0));

        // 拉取合并用的 pending_edits 是界面单位（写回草稿要走 set 的秒值域，
        // 不能用已换算成毫秒的 changes()）。
        let pending = draft.pending_edits();
        assert_eq!(pending[0].value, SettingsValue::Number(7.0));
        let mut merged = SettingsDraft::default();
        merged.load(snapshot(&[(
            "ai.silentAccess.cooldownMs",
            SettingsValue::Number(5000.0),
        )]));
        merged
            .set(&pending[0].key, pending[0].value.clone())
            .unwrap();
        assert_eq!(
            merged.value("ai.silentAccess.cooldownMs"),
            Some(&SettingsValue::Number(7.0))
        );
    }

    /// 「↺ 默认」的模板投影同样是 CONFIG 单位（毫秒）：填进草稿前换算成秒。
    #[test]
    fn 恢复默认把毫秒模板换成秒再入草稿() {
        let mut draft = SettingsDraft::default();
        draft.load(snapshot(&[(
            "ai.silentAccess.cooldownMs",
            SettingsValue::Number(9000.0),
        )]));
        let defaults = BTreeMap::from([(
            "ai.silentAccess.cooldownMs".to_string(),
            SettingsValue::Number(5000.0),
        )]);
        assert_eq!(draft.apply_defaults(&defaults), 1);
        assert_eq!(
            draft.value("ai.silentAccess.cooldownMs"),
            Some(&SettingsValue::Number(5.0)),
            "默认模板 5000ms 必须以 5s 进草稿（否则超第二单位值域被拒）"
        );
        assert_eq!(
            draft.changes()[0].value,
            SettingsValue::Number(5000.0),
            "提交时换回毫秒"
        );
    }

    // ── 主动开关 / 面板计数 / 动态帮助 ──

    #[test]
    fn 主动开关按钮标题显示三态() {
        assert_eq!(
            proactive_button_title(Some(ProactiveSnapshot {
                enabled: true,
                revision: 3
            })),
            "主动消息：已开启"
        );
        assert_eq!(
            proactive_button_title(Some(ProactiveSnapshot {
                enabled: false,
                revision: 4
            })),
            "主动消息：已关闭"
        );
        assert_eq!(
            proactive_button_title(None),
            "切换主动消息开关",
            "状态未读到时不得伪报开/关"
        );
    }

    #[test]
    fn bash_白名单计数只数非空行() {
        let values = BTreeMap::from([(
            "tools.bash.whitelist".to_string(),
            SettingsValue::Text("ls\n\n  cat  \ngrep".into()),
        )]);
        assert_eq!(
            dynamic_field_hint("tools.bash.whitelist", &values).as_deref(),
            Some("3 个命令")
        );
        // 缺键（快照未到）：计数如实为 0，不编造。
        assert_eq!(
            dynamic_field_hint("tools.bash.whitelist", &BTreeMap::new()).as_deref(),
            Some("0 个命令")
        );
        // 其它字段没有动态行。
        assert!(dynamic_field_hint("general.popup.mode", &values).is_none());
    }

    // ── 外观页：图层编辑器入口 ──

    /// 「图层编辑器」动作的接线：分发必须走到 [`crate::ui::editor::EditorUi::open_window`]
    /// ——与托盘/聊天「图层」按钮同一条入口（窗口门禁与载入调度都在那里）。
    ///
    /// 真正建窗的那一刀在平台层（`platform::imp::open_editor_window`）：单元测试进程
    /// 没有 UI 主线程队列，`EditorUi::run_on_ui` 会留痕跳过；这里钉到门禁被拉起为止，
    /// 实机建窗与渲染留给实机验证。编辑器门禁是进程级单例：本用例是全测试二进制里
    /// 唯一打开它的用例（编辑器域用例只碰草稿与素材，不看门禁）。
    #[test]
    fn 图层编辑器动作路由到编辑器窗口门禁() {
        let editor = crate::ui::editor::editor_ui();
        assert!(
            !editor.is_window_open(),
            "前置：编辑器窗口门禁初始必须是关闭态"
        );
        SettingsUi::new()
            .run_action("action.openLayerEditor")
            .expect("已接线的动作不得返回「未知动作入口」");
        assert!(
            editor.is_window_open(),
            "动作必须经 EditorUi::open_window 打开（窗口门禁 + 载入调度；建窗在平台层）"
        );
        assert!(
            SettingsUi::new().run_action("action.no_such_action").is_err(),
            "未知动作仍要被拒绝（新入口不得放宽兜底分支）"
        );
    }
}
