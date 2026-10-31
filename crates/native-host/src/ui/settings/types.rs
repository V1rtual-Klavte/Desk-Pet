//! 设置域的公共数据 shape、端口面与校验/草稿模型。
//!
//! T2.8 把原 `settings/mod.rs` 的数据声明（`SettingsValue` … `SwitchStates`）、
//! `SettingsPort` 端口面、`validate_value` 与 `SettingsDraft` 收在本文件；`mod.rs`
//! 只保留进程级单例与模块声明，并经 `pub use types::*` 维持原有取用路径。
//!
//! 防碎片化裁决（T2.8 用户指令）：原计划的 `validate.rs` / `draft.rs` 生产代码
//! 均不足 250 行，并入本文件；`MemoryPager` / `MemoryItemsView` 等数据 shape 按
//! 「全部数据 type 留在 types.rs」也留在本文件（分页纯函数在 `ui.rs`）。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::rust_debug;
use crate::ui::font::FontSnapshot;

use super::panels::{
    self, ListPanel, McpServerForm, McpServerSave, MemoryChange, MemoryDetail, MemoryOverview,
    PanelRow,
};
use super::schema::{self, field, FieldKind};

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

// MCP 服务器编辑面是**表单**（W5-B）：字段类型与保存载荷在 `panels.rs`
// （`McpServerForm` / `McpServerSave` / `mcp_form_rows` / `mcp_save_from_values`）；
// 整段 markdown 文档编辑路径已删除，不保留并存的双轨。

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
    /// 指定 Card 的本体 markdown（可编辑：角色设定、语言风格、输出规则、行为进阶、变量定义）。
    ///
    /// 目标 = 卡列表里选中的那一张（行级「编辑」与「人格」小节的编辑入口共用同一坐标）；
    /// 文档一旦打开就绑定在这个 card_id 上（读到写回同一张卡，不随列表选择漂移）。
    CardMarkdown { card_id: String },
    /// Card 作者模版（只读：提示词全文，供复制给外部 AI 生成新卡）。
    CardTemplate,
    /// MCP 服务器编辑表单（`name` 空 = 新建模板；非空 = 原服务器名，保存时作撞名/改名坐标）。
    McpServer { name: String },
    /// 变量池只读预览。
    VariablePool,
}

impl DocumentTarget {
    pub fn is_read_only(&self) -> bool {
        matches!(self, Self::VariablePool | Self::CardTemplate)
    }
}

/// 文档内容：文本目标 = Node 提交的文本；MCP 目标 = 表单字段值（控件逐项渲染）。
///
/// 两种形状由目标裁定，不并存：MCP 表单不再有「一段文本」的读法。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentContent {
    Text(String),
    McpForm(McpServerForm),
}

impl DocumentContent {
    /// 文本目标的正文（表单目标为 `None`：平台层表单控件不读它）。
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::McpForm(_) => None,
        }
    }

    /// 未加载时的占位内容（`loaded=false` 期间；按目标给空文本或空表单）。
    pub fn empty(target: &DocumentTarget) -> Self {
        match target {
            DocumentTarget::McpServer { name } => Self::McpForm(McpServerForm {
                name: name.clone(),
                transport: panels::McpTransport::Stdio,
                command: String::new(),
                args: String::new(),
                url: String::new(),
                env: String::new(),
                headers: String::new(),
                enabled: true,
            }),
            _ => Self::Text(String::new()),
        }
    }
}

/// 当前打开的文档（标题 + Node 已提交内容 + 加载/只读状态）。
///
/// 未保存编辑由平台控件持有（关闭/切换时丢弃，与设置草稿同一条纪律）；本结构只在
/// 数据刷新与保存成功时被替换。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentState {
    pub title: String,
    pub target: DocumentTarget,
    /// Node 提供的已提交内容；`loaded=false` 时是空文本 / 空表单（界面显示「读取中…」）。
    pub content: DocumentContent,
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

    /// 工具页：写入一条 MCP 凭据（`row_id` = 凭据行坐标，Node 定义并解析回 server/var）。
    ///
    /// 值定向写进应用自有存储（宿主 `mcp_credential_set`）：**不写 CONFIG、不回显、
    /// 不进日志**；空值由领域入口拒绝（界面同样在输入后判一次空）。
    fn mcp_credential_set(&self, _row_id: &str, _value: &str) -> AppResult<()> {
        Err(AppError::Other("MCP 凭据写入端口未接线".into()))
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
    /// `scope`/`scope_id` 是可选范围筛选（user/session；session 的具体 id
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

    /// 工具页：MCP 编辑表单（`name` 缺省 = 新建模板；返回逐字段值）。
    fn mcp_server_form(&self, _name: Option<&str>) -> AppResult<McpServerForm> {
        Err(AppError::Other("MCP 编辑端口未接线".into()))
    }

    /// 工具页：MCP 表单保存（`original_name` 空 = 新增；非空 = 更新/改名）。
    fn mcp_save(&self, _save: &McpServerSave) -> AppResult<()> {
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

    /// 设置页：手动触发一次静默了解（不受档位开关限制，不计入当天自动次数）。
    fn silent_understanding_run_now(&self) -> AppResult<String> {
        Err(AppError::Other("静默了解端口未接线".into()))
    }

    /// 记忆页：一致性备份 / 导出只读视图 / 重建索引。
    fn memory_maintenance(&self, _op: MemoryMaintenanceOp) -> AppResult<String> {
        Err(AppError::Other("记忆维护端口未接线".into()))
    }

    /// 记忆页：托管备份列表（`id` = 备份绝对路径；行由 Node 投影，点击行 = 选中）。
    fn memory_backup_list(&self) -> AppResult<Vec<PanelRow>> {
        Err(AppError::Other("记忆备份列表端口未接线".into()))
    }

    /// 记忆页：恢复（`preview_only=true` 只预检；false = 应用；`backup_path` = 选中那一份）。
    ///
    /// 路径边界由 Rust 记忆命令裁决（只接受托管备份目录内的文件），端口不另外放宽。
    fn memory_restore(&self, _preview_only: bool, _backup_path: &str) -> AppResult<String> {
        Err(AppError::Other("记忆恢复端口未接线".into()))
    }

    /// 记忆页：终止一条整理作业（只有进行中的作业可取消；是否生效由记忆域裁决）。
    fn memory_job_cancel(&self, _job_id: &str) -> AppResult<String> {
        Err(AppError::Other("记忆作业取消耗口未接线".into()))
    }

    /// 记忆页：继续一条受限的整理作业（review 阶段恢复并跑到收口；不接受非 review 作业）。
    fn memory_job_resume(&self, _job_id: &str) -> AppResult<String> {
        Err(AppError::Other("记忆作业继续端口未接线".into()))
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
    pub fn load(&mut self, snapshot: SettingsSnapshot) {
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
    pub fn changes(&self) -> Vec<SettingEdit> {
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

    /// 当前未保存改动（值口径与 [`Self::set`] 的入参一致）；
    /// 供快照重拉时把用户编辑放回草稿。
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
            if let Err(error) = self.set(key, value.clone()) {
                rust_debug!("默认值写入草稿失败（跳过该项）: {error}");
            }
        }
        self.dirty.len()
    }

    /// 只确认本次真正提交的值；等待写盘期间的新编辑仍保留为 dirty。
    pub fn mark_saved(&mut self, changes: &[SettingEdit]) {
        for edit in changes {
            self.committed.values.insert(edit.key.clone(), edit.value.clone());
        }
        self.dirty = self.current.values.iter()
            .filter(|(key, value)| self.committed.values.get(*key) != Some(*value))
            .map(|(key, _)| key.clone())
            .collect();
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
/// 「已记住」分页行的渲染数据（页码 + 按钮可用性 + 中间文案）。
///
/// 平台只渲染 `prev_enabled` / `next_enabled` / `label`，不自行算页数
/// （两平台一致的形状由此保证）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryPager {
    /// 当前页（1 起，已 clamp）。
    pub page: usize,
    /// 总页数 = ceil(N / 5)。
    pub page_count: usize,
    /// 总条数。
    pub total: usize,
    /// 「上一页」是否可用（首页禁用）。
    pub prev_enabled: bool,
    /// 「下一页」是否可用（末页禁用）。
    pub next_enabled: bool,
    /// 中间文本（`第 x / y 页 · 共 N 条`）—— 两平台共用同一条格式。
    pub label: String,
}
/// 「已记住」面板的当前页视图（切片后的面板 + 分页行）—— 平台渲染的唯一入口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryItemsView {
    /// 切片后的「已记住」面板（行 = 当前页；说明/错误/读取状态与全量面板同源）。
    pub panel: ListPanel,
    /// 分页行数据；`None` = 没有条目（空态不显示分页行）。
    pub pager: Option<MemoryPager>,
}
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
    pub(super) fn names(&self) -> Vec<String> {
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
    pub saving: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::settings::test_support::*;

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
        draft.mark_saved(&changes);
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
    fn 提交改动按键有序且带值() {
        let mut draft = SettingsDraft::default();
        draft.load(SettingsSnapshot::default());
        draft
            .set("ai.silentAccess.frequency", SettingsValue::Text("low".into()))
            .unwrap();
        draft
            .set(
                "appearance.effectMode",
                SettingsValue::Text("parallax".into()),
            )
            .unwrap();
        let changes = draft.changes();
        // 按 CONFIG 键**字母序**（`ai.` 排在 `appearance.` 之前 —— 这正是这条测试要钉的口径）。
        assert_eq!(changes[0].key, "ai.silentAccess.frequency");
        assert_eq!(changes[1].key, "appearance.effectMode");
    }

    /// 三处档位走枚举校验收口；静默时段是 0–23 的数值（0 合法，不参与兜底）。
    #[test]
    fn 档位枚举与静默时段值走既有校验收口() {
        let mut draft = SettingsDraft::default();
        draft.load(SettingsSnapshot::default());
        for tier in ["off", "low", "medium", "high"] {
            draft
                .set("ai.proactive.frequency", SettingsValue::Text(tier.into()))
                .unwrap();
            draft
                .set("ai.silentAccess.frequency", SettingsValue::Text(tier.into()))
                .unwrap();
            draft
                .set("ai.memory.dreaming.tier", SettingsValue::Text(tier.into()))
                .unwrap();
        }
        assert!(
            draft
                .set("ai.proactive.frequency", SettingsValue::Text("always".into()))
                .is_err(),
            "四档之外的取值必须被枚举校验拒绝"
        );
        draft
            .set("ai.proactive.quietStartHour", SettingsValue::Number(0.0))
            .unwrap();
        draft
            .set("ai.proactive.quietEndHour", SettingsValue::Number(23.0))
            .unwrap();
        assert!(
            draft
                .set("ai.proactive.quietStartHour", SettingsValue::Number(24.0))
                .is_err(),
            "24 时越界必须被拒绝"
        );
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
                "ai.silentAccess.frequency".to_string(),
                SettingsValue::Text("high".into()),
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
            draft.value("ai.silentAccess.frequency"),
            Some(&SettingsValue::Text("high".into()))
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

}
