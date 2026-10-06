//! 管理面数据模型（W9d）：MCP / Skill / 工具策略 / 记忆库的动态列表与详情。
//!
//! 权属（执行契约 §3、§6.4）：**数据只来自 Node**（经 [`super::SettingsPort`] 的新方法，
//! 方法体把请求打到既有领域入口）；Rust 只持**不可变显示快照 + 临时草稿**，
//! 不解析 CONFIG/Profile、不读记忆 SQLite、不落第二份持久状态。
//!
//! 行是**展示投影**：`title`/`subtitle` 由 Node 侧投影（与聊天投影同款「Node 组装读模型、
//! 界面只渲染」）；本模块只保留渲染所需的最小结构（开关状态、行动作、选择坐标）。
//!
//! 约束：管理面的写操作不发明新语义 —— 开关走既有写入口（MCP 配置写、Skill frontmatter），
//! 记忆纠正/遗忘走既有 `memory_apply_change`（actor/信任门槛在 Node + Rust 既有门禁，
//! 界面不放宽）。平台层的危险动作（遗忘）先走原生确认再调用本域。

use std::collections::BTreeMap;

use serde_json::Value;

use crate::error::{AppError, AppResult};

/// 面板 id（平台层按它把行动作回传给本域；也是渲染时区分面板的坐标）。
pub const PANEL_MCP: &str = "tools.mcp";
pub const PANEL_SKILLS: &str = "tools.skills";
pub const PANEL_POLICIES: &str = "tools.policies";
pub const PANEL_MEMORY_ITEMS: &str = "memory.items";
pub const PANEL_MEMORY_JOBS: &str = "memory.jobs";
/// 记忆详情的来源行（当前选中条目的来源逐条一行；点行展开该条原话）。
pub const PANEL_MEMORY_SOURCES: &str = "memory.sources";
/// 记忆页的托管备份列表（点行 = 选中该份备份，供预览/应用）。
pub const PANEL_MEMORY_BACKUPS: &str = "memory.backups";
/// 外观页的音效试听面板（行按钮 = 试听该事件当前分配的音效）。
pub const PANEL_SOUNDS: &str = "appearance.sounds";
/// 外观页的 Profile 列表（点行 = 选中管理对象；与激活态分开）。
pub const PANEL_PROFILES: &str = "appearance.profiles";
/// AI 页的人格卡列表（点行 = 选中管理对象；行内「编辑」打开该卡文档）。
pub const PANEL_CARDS: &str = "ai.cards";

/// 一行的动作形状（平台层按钮的点击归宿）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowAction {
    /// 纯展示行（工具策略、历史版本、整理作业）。
    None,
    /// 逐项开关：点击由本域取反并走既有写入口（MCP 服务器 / Skill）。
    Toggle,
    /// 点开加载详情（记忆条目）。
    Select,
    /// 打开编辑表单（MCP 服务器：字段控件逐项编辑）。
    Edit,
    /// 删除该行代表的资源（自定义 MCP 服务器 / Skill；内置与默认资源拒绝）。
    Delete,
    /// 试听该行代表的音效（音效事件行）。
    Preview,
    /// 行内下拉：主控件是弹出选择（选项见 `PanelRow::pick`），
    /// 选中某值后由平台把（行 id, 值）回传领域入口（音效事件行）。
    Pick,
    /// 凭据输入：点击弹原生输入框，值经领域入口定向写进应用自有存储
    /// （MCP 面板的「GitHub 令牌」行；值不回显、不写 CONFIG）。
    Credential,
    /// 终止一条整理作业（记忆页作业行的主按钮；仅 Node 标记为可取消的行会出现）。
    Cancel,
    /// 继续一条受限的整理作业（review 阶段被暂停/取消/失败后恢复并跑到收口）。
    Resume,
    /// 选中一行（备份列表：点击把该行设为当前操作对象；`enabled` = 是否已选中）。
    Choose,
}

impl RowAction {
    /// 线格式 → 动作；未知取值按「只读行」处理（不猜测动作）。
    pub fn parse(value: &str) -> Self {
        match value {
            "toggle" => Self::Toggle,
            "select" => Self::Select,
            "edit" => Self::Edit,
            "delete" => Self::Delete,
            "preview" => Self::Preview,
            "pick" => Self::Pick,
            "credential" => Self::Credential,
            "cancel" => Self::Cancel,
            "resume" => Self::Resume,
            "choose" => Self::Choose,
            _ => Self::None,
        }
    }
}

/// 行内下拉的一个选项（显示标签 + 选中后回传的值）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowOption {
    /// 选中后原样回传领域入口的值（音效行 = soundId；`none` = 静音）。
    pub value: String,
    pub label: String,
}

/// 行内下拉（`RowAction::Pick` 时生效）：可选值 + 当前选中值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowPick {
    pub options: Vec<RowOption>,
    /// 当前选中值（与某 `options[].value` 对应；不在表里时平台回退显示第一项）。
    pub selected: String,
}

/// 列表行（平台通用渲染：标题 + 副标题 + 主/次动作按钮）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelRow {
    /// 行坐标（MCP=服务器名，Skill=域内相对路径，记忆=条目 id；写操作原样回传）。
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub action: RowAction,
    /// 次动作按钮（如 MCP 行的「编辑」、Skill 行的「删除」）；None = 不渲染第二个按钮。
    pub secondary: RowAction,
    /// 开关类行的当前状态（按钮文案「已启用」/「已关闭」）；其它行无意义。
    pub enabled: bool,
    /// 行内下拉（`action == RowAction::Pick` 时必填；其它行恒 `None`）。
    pub pick: Option<RowPick>,
}

/// 一个管理面板（标题 + 说明 + 错误 + 行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListPanel {
    pub id: &'static str,
    pub title: &'static str,
    /// 面板说明：静态文案，由 `ui/settings/mod.rs` 的 `*_panels()` 组装。
    pub hint: String,
    /// 读取失败原因；`None` 且 `loaded=true` 时空列表才是「真的没有」。
    pub error: Option<String>,
    /// 成功读取的诊断（如 Skill 目录索引告警）；与 `error` 不同形。
    pub warning: Option<String>,
    /// 是否已有过成功读取（false = 尚未拉到，平台显示「读取中…」）。
    pub loaded: bool,
    pub rows: Vec<PanelRow>,
}

/// 记忆条目详情（只读快照；`content` 是纠正的基线，另有临时草稿在 UI 域）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryDetail {
    pub item_id: String,
    /// 详情读取时的库 revision（纠正/遗忘提交的 baseRevision；stale 由 Rust 抛冲突）。
    pub revision: i64,
    pub version: i64,
    pub pinned: bool,
    /// 只读概要（类型/范围/状态/来源/重要性与时间；Node 组装的展示投影）。
    pub info: String,
    pub content: String,
    /// 当前版本的来源行（一行一条来源，`id` = sourceId，动作 select；
    /// 点行展开该条的完整证据/原话 —— 空 = 没有可回看的来源）。
    pub sources: Vec<PanelRow>,
    /// 历史版本行（含来源审计摘要；只读）。
    pub history: Vec<PanelRow>,
}

/// 展开中的来源原话（记忆详情「来源原话」区）。
///
/// **同时最多展开一条**（点击同一条收起、点另一条切换）—— 这是「原话回看不无限膨胀」
/// 的边界：不再像旧文档那样一次预取多条并拼接铺开，每次只有一条在途/在屏。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryEvidenceState {
    Loading { source_id: String },
    Ready { source_id: String, text: String },
    Error { source_id: String, error: String },
}

impl MemoryEvidenceState {
    pub fn source_id(&self) -> &str {
        match self {
            Self::Loading { source_id } | Self::Ready { source_id, .. } | Self::Error { source_id, .. } => source_id,
        }
    }
}

/// 记忆库总览（状态行 + 条目 + 整理作业）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryOverview {
    /// 库当前 revision（展示与后续变更的基准）。
    pub revision: i64,
    /// 状态行文本（「库版本 revision N · M 条当前记忆 · K 个整理作业」）。
    pub status_text: String,
    pub items: Vec<PanelRow>,
    pub jobs: Vec<PanelRow>,
}

impl MemoryOverview {
    /// 空总览（尚未读到时的中性值；`loaded` 由 UI 域另记）。
    pub fn empty() -> Self {
        Self {
            revision: 0,
            status_text: String::new(),
            items: Vec::new(),
            jobs: Vec::new(),
        }
    }
}

/// 一次记忆条目治理变更（update=纠正/核心画像标记；forget=遗忘）。
///
/// 与 Node 侧既有 `memory_apply_change` 的语义对齐：actor=user_ui 由 Node 组装，
/// `baseRevision`/`expectedVersion` 来自详情读取快照（stale 基准由 Rust 拒绝）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryChange {
    pub action: MemoryChangeAction,
    pub item_id: String,
    pub expected_version: i64,
    pub base_revision: i64,
    /// update 时的新正文（仅纠正提交；核心画像标记不动正文）。
    pub content: Option<String>,
    /// update 时的核心画像目标状态（None = 不改）。
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryChangeAction {
    Update,
    Forget,
}

impl MemoryChangeAction {
    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::Update => "update",
            Self::Forget => "forget",
        }
    }
}

/// Skill 面板读回执：清单 + 目录索引告警。
///
/// `index_error` 是**成功读取**的一条诊断（指纹核对失败时 Node 保留上一份清单）；
/// 与读取失败的 `ListPanel::error` 不同形 —— 界面要把「索引不可用」和「真的没有 Skill」分开。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCatalog {
    pub rows: Vec<PanelRow>,
    pub index_error: Option<String>,
}

// ── MCP 服务器编辑表单（W5-B：字段控件取代整段 markdown 文档）──
//
// 表单是「Node 组装读模型、界面只渲染」的又一次应用：字段值、标签、校验与落盘都在
// Node 的 MCP 域；本模块只持字段（键 + 控件形态 + 当前值）与保存载荷的线协议形状。
// 整段文本编辑（`## 小节` 行格式）已删除，不再有「一段文本」的第二定义点。

/// MCP 传输方式（表单下拉的两个选项；sse 已弃用，不在选项里）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpTransport {
    Stdio,
    Http,
}

impl McpTransport {
    /// 下拉选项表（线值, 显示标签）；顺序即渲染顺序，取值即线协议取值。
    pub const OPTIONS: &'static [(&'static str, &'static str)] =
        &[("stdio", "stdio（本地命令）"), ("http", "http（远程 URL）")];

    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Http => "http",
        }
    }

    /// 线格式解析：未知取值返回 `None`（调用方如实报错，不猜默认值）。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stdio" => Some(Self::Stdio),
            "http" => Some(Self::Http),
            _ => None,
        }
    }
}

/// MCP 表单的字段键（控件读值时原样回带；保存载荷按它组装 —— 键表只有这一份）。
pub const MCP_FIELD_NAME: &str = "name";
pub const MCP_FIELD_TRANSPORT: &str = "transport";
pub const MCP_FIELD_COMMAND: &str = "command";
pub const MCP_FIELD_ARGS: &str = "args";
pub const MCP_FIELD_URL: &str = "url";
pub const MCP_FIELD_ENV: &str = "env";
pub const MCP_FIELD_HEADERS: &str = "headers";
pub const MCP_FIELD_ENABLED: &str = "enabled";

/// MCP 服务器编辑表单的字段值（全部来自 Node）。
///
/// `name` 是**目标服务器名**：新建为空串，编辑为原服务器名（保存时作 `original_name`
/// 回传 —— 撞名与改名判定都在 Node）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerForm {
    pub name: String,
    pub transport: McpTransport,
    pub command: String,
    /// 每行一个参数。
    pub args: String,
    pub url: String,
    /// KEY=VALUE 每行一条（行格式的解析在 Node 的 MCP 域）。
    pub env: String,
    pub headers: String,
    pub enabled: bool,
}

/// MCP 表单保存载荷（控件值 → 线协议字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerSave {
    /// 原服务器名（空 = 新增；非空 = 更新原条目，允许改名）。
    pub original_name: String,
    pub name: String,
    pub transport: McpTransport,
    pub command: String,
    pub args: String,
    pub url: String,
    pub env: String,
    pub headers: String,
    pub enabled: bool,
}

/// 表单控件的形态（平台按形态建控件；标签与顺序的唯一来源是 [`mcp_form_rows`]）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpFieldControl {
    /// 单行文本（name / command / url）。
    Line(String),
    /// 多行文本（args / env / headers）。
    Multiline(String),
    /// 二选一下拉（transport；`selected` 是当前线值）。
    Choice {
        options: &'static [(&'static str, &'static str)],
        selected: &'static str,
    },
    /// 勾选（enabled）。
    Bool(bool),
}

/// 表单字段总数（[`mcp_form_rows`] 恒返回这么多行）。
///
/// 平台层按「字段 id 段」遍历控件（如换主题时重刷）时用它，不各自数第二遍；
/// 由 `表单字段数与行表一致` 的单测钉住。
pub const MCP_FORM_FIELD_COUNT: usize = 8;

/// 表单一行（控件坐标 + 标签 + 当前值）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpFieldRow {
    /// 控件读值坐标（保存时原样回带；见 `MCP_FIELD_*`）。
    pub key: &'static str,
    pub label: &'static str,
    pub control: McpFieldControl,
}

/// 表单行（顺序固定 = 渲染顺序）：name → transport → command → args → url → env → headers → enabled。
///
/// `draft` 是保存失败重开时恢复的用户编辑（key → 值）：命中的键用草稿值，
/// 缺键回落表单值；非法草稿值（transport/enabled）也回落 —— 草稿只恢复编辑，
/// 不产生表单模型之外的取值。
pub fn mcp_form_rows(form: &McpServerForm, draft: Option<&BTreeMap<String, String>>) -> Vec<McpFieldRow> {
    let value = |key: &str, fallback: &str| -> String {
        draft
            .and_then(|values| values.get(key))
            .cloned()
            .unwrap_or_else(|| fallback.to_string())
    };
    let transport = draft
        .and_then(|values| values.get(MCP_FIELD_TRANSPORT))
        .and_then(|raw| McpTransport::parse(raw))
        .unwrap_or(form.transport);
    let enabled = match draft.and_then(|values| values.get(MCP_FIELD_ENABLED)).map(String::as_str) {
        Some("true") => true,
        Some("false") => false,
        _ => form.enabled,
    };
    vec![
        McpFieldRow {
            key: MCP_FIELD_NAME,
            label: "名称",
            control: McpFieldControl::Line(value(MCP_FIELD_NAME, &form.name)),
        },
        McpFieldRow {
            key: MCP_FIELD_TRANSPORT,
            label: "传输方式",
            control: McpFieldControl::Choice {
                options: McpTransport::OPTIONS,
                selected: transport.as_wire(),
            },
        },
        McpFieldRow {
            key: MCP_FIELD_COMMAND,
            label: "命令",
            control: McpFieldControl::Line(value(MCP_FIELD_COMMAND, &form.command)),
        },
        McpFieldRow {
            key: MCP_FIELD_ARGS,
            label: "参数（每行一个）",
            control: McpFieldControl::Multiline(value(MCP_FIELD_ARGS, &form.args)),
        },
        McpFieldRow {
            key: MCP_FIELD_URL,
            label: "URL",
            control: McpFieldControl::Line(value(MCP_FIELD_URL, &form.url)),
        },
        McpFieldRow {
            key: MCP_FIELD_ENV,
            label: "环境变量（KEY=VALUE 每行一条）",
            control: McpFieldControl::Multiline(value(MCP_FIELD_ENV, &form.env)),
        },
        McpFieldRow {
            key: MCP_FIELD_HEADERS,
            label: "请求头（KEY=VALUE 每行一条）",
            control: McpFieldControl::Multiline(value(MCP_FIELD_HEADERS, &form.headers)),
        },
        McpFieldRow {
            key: MCP_FIELD_ENABLED,
            label: "启用",
            control: McpFieldControl::Bool(enabled),
        },
    ]
}

/// 表单的草稿值投影（保存失败留草稿、重开恢复用；与 [`mcp_form_rows`] 的取值口径一致）。
pub fn mcp_form_values(form: &McpServerForm) -> BTreeMap<String, String> {
    mcp_form_rows(form, None)
        .into_iter()
        .map(|row| {
            let value = match row.control {
                McpFieldControl::Line(text) | McpFieldControl::Multiline(text) => text,
                McpFieldControl::Choice { selected, .. } => selected.to_string(),
                McpFieldControl::Bool(enabled) => enabled.to_string(),
            };
            (row.key.to_string(), value)
        })
        .collect()
}

/// 控件读值（key → 值）→ 保存载荷。
///
/// 缺字段 / 非法取值如实报错（结构化 CONFIG）—— 控件层读不出值时，不把它静默当空串。
/// 域校验（name 非空、stdio 必须有 command、http 必须有 url、env/headers 行格式）在 Node；
/// 这里只保证线协议形状（八个键齐全、transport / enabled 是登记取值）。
pub fn mcp_save_from_values(
    original_name: &str,
    values: &BTreeMap<String, String>,
) -> AppResult<McpServerSave> {
    let text = |key: &str| -> AppResult<&str> {
        values
            .get(key)
            .map(String::as_str)
            .ok_or_else(|| AppError::Config(format!("MCP 表单缺少字段 {key}")))
    };
    let transport_raw = text(MCP_FIELD_TRANSPORT)?;
    let transport = McpTransport::parse(transport_raw).ok_or_else(|| {
        AppError::Config(format!("MCP 表单的 transport 取值非法: {transport_raw}"))
    })?;
    let enabled = match text(MCP_FIELD_ENABLED)? {
        "true" => true,
        "false" => false,
        other => return Err(AppError::Config(format!("MCP 表单的 enabled 取值非法: {other}"))),
    };
    Ok(McpServerSave {
        original_name: original_name.to_string(),
        name: text(MCP_FIELD_NAME)?.to_string(),
        transport,
        command: text(MCP_FIELD_COMMAND)?.to_string(),
        args: text(MCP_FIELD_ARGS)?.to_string(),
        url: text(MCP_FIELD_URL)?.to_string(),
        env: text(MCP_FIELD_ENV)?.to_string(),
        headers: text(MCP_FIELD_HEADERS)?.to_string(),
        enabled,
    })
}

/// 记忆条目详情的渲染视图（`content` 已应用 UI 域的未保存草稿）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryDetailView {
    pub item_id: String,
    pub version: i64,
    pub pinned: bool,
    pub info: String,
    /// 当前编辑值：有草稿用草稿，否则用已提交内容。
    pub content: String,
    pub history: Vec<PanelRow>,
}

/// 记忆详情区的渲染状态（未选中 / 读取中 / 失败 / 就绪四态，平台按状态分支）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryDetailState {
    None,
    Loading,
    Error(String),
    Ready(MemoryDetailView),
}

/// 解析一行的载荷（共享形状；`rows` 数组里的单个对象）。
fn parse_row(value: &Value) -> AppResult<PanelRow> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("管理面行缺少 id".into()))?;
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("管理面行缺少 title".into()))?;
    let action = RowAction::parse(
        value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("none"),
    );
    let pick = match value.get("pick") {
        Some(pick) => Some(parse_pick(pick)?),
        None => None,
    };
    // `pick` 与 `Pick` 动作必须成对：缺选项画不出可点的下拉，多选项则是没动作的死数据。
    if (action == RowAction::Pick) != pick.is_some() {
        return Err(AppError::Config(
            "管理面行 pick 载荷与 pick 动作不成对".into(),
        ));
    }
    Ok(PanelRow {
        id: id.to_string(),
        title: title.to_string(),
        subtitle: value
            .get("subtitle")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        action,
        secondary: RowAction::parse(
            value
                .get("action2")
                .and_then(Value::as_str)
                .unwrap_or("none"),
        ),
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pick,
    })
}

/// 解析行内下拉的载荷（`{ options: [{value, label}...], selected }`）。
fn parse_pick(value: &Value) -> AppResult<RowPick> {
    let options = value
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("行内下拉缺少 options".into()))?;
    if options.is_empty() {
        return Err(AppError::Config("行内下拉 options 不能为空".into()));
    }
    let mut parsed = Vec::with_capacity(options.len());
    for option in options {
        let option_value = option
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("行内下拉选项缺少 value".into()))?;
        let label = option
            .get("label")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("行内下拉选项缺少 label".into()))?;
        parsed.push(RowOption {
            value: option_value.to_string(),
            label: label.to_string(),
        });
    }
    Ok(RowPick {
        options: parsed,
        selected: value
            .get("selected")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("行内下拉缺少 selected".into()))?
            .to_string(),
    })
}

/// `[ {...}, ... ]` → 行列表（协议违规如实报错，不静默丢行）。
pub fn parse_rows(value: &Value) -> AppResult<Vec<PanelRow>> {
    let rows = value
        .as_array()
        .ok_or_else(|| AppError::Config("管理面 rows 不是数组".into()))?;
    rows.iter().map(parse_row).collect()
}

/// `{ ...回执, rows: [...] }` → 行列表（取 `rows` 键）。
pub fn parse_rows_field(value: &Value) -> AppResult<Vec<PanelRow>> {
    let rows = value
        .get("rows")
        .ok_or_else(|| AppError::Config("管理面回执缺少 rows".into()))?;
    parse_rows(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 行解析保留动作与开关状态() {
        let rows = parse_rows(&json!([
            { "id": "filesystem", "title": "📁 文件系统", "subtitle": "内置 · npx", "action": "toggle", "enabled": true },
            { "id": "web", "title": "搜索", "subtitle": "自定义", "action": "select" },
            { "id": "h", "title": "历史", "subtitle": "" }
        ]))
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].action, RowAction::Toggle);
        assert!(rows[0].enabled);
        assert_eq!(rows[1].action, RowAction::Select);
        assert!(!rows[1].enabled, "缺省 enabled 必须是 false，不是 true");
        assert_eq!(rows[2].action, RowAction::None, "缺省动作是只读行");
    }

    #[test]
    fn 行解析对协议违规如实报错() {
        assert!(
            parse_rows(&json!({ "rows": [] })).is_err(),
            "非数组如实报错"
        );
        assert!(
            parse_rows(&json!([{ "title": "无 id" }])).is_err(),
            "缺 id 的行不能静默跳过"
        );
        assert!(parse_rows_field(&json!({ "nope": [] })).is_err());
    }

    #[test]
    fn 未知动作按只读行处理() {
        assert_eq!(RowAction::parse("mystery"), RowAction::None);
        assert_eq!(RowAction::parse(""), RowAction::None);
        // 本批扩展的动作必须能解析（写进线格式的取值不能被吃掉）。
        assert_eq!(RowAction::parse("edit"), RowAction::Edit);
        assert_eq!(RowAction::parse("delete"), RowAction::Delete);
        assert_eq!(RowAction::parse("preview"), RowAction::Preview);
        assert_eq!(RowAction::parse("pick"), RowAction::Pick);
        assert_eq!(RowAction::parse("credential"), RowAction::Credential);
        // 记忆作业行的取消/继续与备份行的选中：线取值与 Node 行投影逐字一致。
        assert_eq!(RowAction::parse("cancel"), RowAction::Cancel);
        assert_eq!(RowAction::parse("resume"), RowAction::Resume);
        assert_eq!(RowAction::parse("choose"), RowAction::Choose);
    }

    #[test]
    fn 来源原话状态携带来源坐标() {
        let states = [
            MemoryEvidenceState::Loading {
                source_id: "s-1".into(),
            },
            MemoryEvidenceState::Ready {
                source_id: "s-1".into(),
                text: "原话".into(),
            },
            MemoryEvidenceState::Error {
                source_id: "s-1".into(),
                error: "读取失败".into(),
            },
        ];
        // 三态的坐标都取得到（平台据此判断「落地的结果属不属于当前展开的那一条」）。
        for state in states {
            assert_eq!(state.source_id(), "s-1");
        }
    }

    #[test]
    fn 行内下拉载荷按线格式解析() {
        let rows = parse_rows(&json!([
            {
                "id": "newMessage",
                "title": "新消息",
                "action": "pick",
                "pick": {
                    "options": [
                        { "value": "none", "label": "静音" },
                        { "value": "chime", "label": "清脆" }
                    ],
                    "selected": "chime"
                }
            }
        ]))
        .unwrap();
        let pick = rows[0].pick.as_ref().expect("pick 载荷要解析出来");
        assert_eq!(pick.selected, "chime");
        assert_eq!(pick.options.len(), 2);
        assert_eq!(pick.options[0].value, "none");
        assert_eq!(pick.options[1].label, "清脆");
        assert!(rows[0].pick.is_some(), "Pick 动作必须带选项");
    }

    // ── MCP 表单（W5-B）──

    fn 表单样例() -> McpServerForm {
        McpServerForm {
            name: "demo".to_string(),
            transport: McpTransport::Http,
            command: String::new(),
            args: "-y\npkg".to_string(),
            url: "https://example.com/mcp".to_string(),
            env: "TOKEN=1".to_string(),
            headers: "A=b".to_string(),
            enabled: false,
        }
    }

    fn 行控件(rows: &[McpFieldRow], key: &str) -> McpFieldControl {
        rows.iter()
            .find(|row| row.key == key)
            .unwrap_or_else(|| panic!("表单缺少字段 {key}"))
            .control
            .clone()
    }

    #[test]
    fn 表单字段数与行表一致() {
        let rows = mcp_form_rows(&表单样例(), None);
        assert_eq!(
            rows.len(),
            MCP_FORM_FIELD_COUNT,
            "平台层按 id 段遍历控件：字段数变了必须同批改常量"
        );
        assert_eq!(
            rows.iter().map(|row| row.key).collect::<Vec<_>>(),
            vec![
                MCP_FIELD_NAME,
                MCP_FIELD_TRANSPORT,
                MCP_FIELD_COMMAND,
                MCP_FIELD_ARGS,
                MCP_FIELD_URL,
                MCP_FIELD_ENV,
                MCP_FIELD_HEADERS,
                MCP_FIELD_ENABLED,
            ],
            "字段顺序是渲染顺序（定义点只在这里）"
        );
        // 控件形态按字段固定：transport 是二选一、enabled 是勾选、args/env/headers 是多行。
        assert!(matches!(
            行控件(&rows, MCP_FIELD_TRANSPORT),
            McpFieldControl::Choice { options, selected } if options == McpTransport::OPTIONS && selected == "http"
        ));
        assert!(matches!(行控件(&rows, MCP_FIELD_ENABLED), McpFieldControl::Bool(false)));
        for key in [MCP_FIELD_ARGS, MCP_FIELD_ENV, MCP_FIELD_HEADERS] {
            assert!(matches!(行控件(&rows, key), McpFieldControl::Multiline(_)), "{key} 应是多行控件");
        }
        for key in [MCP_FIELD_NAME, MCP_FIELD_COMMAND, MCP_FIELD_URL] {
            assert!(matches!(行控件(&rows, key), McpFieldControl::Line(_)), "{key} 应是单行控件");
        }
    }

    #[test]
    fn 表单草稿只覆盖命中字段() {
        let form = 表单样例();
        let mut draft = BTreeMap::new();
        draft.insert(MCP_FIELD_NAME.to_string(), "renamed".to_string());
        draft.insert(MCP_FIELD_TRANSPORT.to_string(), "stdio".to_string());
        draft.insert(MCP_FIELD_ENABLED.to_string(), "true".to_string());
        let rows = mcp_form_rows(&form, Some(&draft));
        assert!(matches!(
            行控件(&rows, MCP_FIELD_NAME),
            McpFieldControl::Line(text) if text == "renamed"
        ));
        assert!(matches!(
            行控件(&rows, MCP_FIELD_TRANSPORT),
            McpFieldControl::Choice { selected: "stdio", .. }
        ));
        assert!(matches!(行控件(&rows, MCP_FIELD_ENABLED), McpFieldControl::Bool(true)));
        // 未命中草稿的字段保持表单值（草稿是覆盖层，不是第二份表单）。
        assert!(matches!(
            行控件(&rows, MCP_FIELD_ARGS),
            McpFieldControl::Multiline(text) if text == "-y\npkg"
        ));
        // 非法草稿值不产生表单模型之外的取值：transport/enabled 回落表单值。
        let mut bad = BTreeMap::new();
        bad.insert(MCP_FIELD_TRANSPORT.to_string(), "sse".to_string());
        bad.insert(MCP_FIELD_ENABLED.to_string(), "yes".to_string());
        let rows = mcp_form_rows(&form, Some(&bad));
        assert!(matches!(
            行控件(&rows, MCP_FIELD_TRANSPORT),
            McpFieldControl::Choice { selected: "http", .. }
        ));
        assert!(matches!(行控件(&rows, MCP_FIELD_ENABLED), McpFieldControl::Bool(false)));
    }

    #[test]
    fn 表单控件值表与行表取值同源() {
        let form = 表单样例();
        let values = mcp_form_values(&form);
        assert_eq!(values.len(), MCP_FORM_FIELD_COUNT);
        assert_eq!(values.get(MCP_FIELD_NAME).map(String::as_str), Some("demo"));
        assert_eq!(values.get(MCP_FIELD_TRANSPORT).map(String::as_str), Some("http"));
        assert_eq!(values.get(MCP_FIELD_ENABLED).map(String::as_str), Some("false"));
        // 行表按这份值表渲染：逐字段一致（保存读回来的值与控件初值同形）。
        let rows = mcp_form_rows(&form, None);
        for row in &rows {
            let value = match &row.control {
                McpFieldControl::Line(text) | McpFieldControl::Multiline(text) => text.clone(),
                McpFieldControl::Choice { selected, .. } => (*selected).to_string(),
                McpFieldControl::Bool(enabled) => enabled.to_string(),
            };
            assert_eq!(values.get(row.key), Some(&value), "字段 {} 的行值与值表不一致", row.key);
        }
    }

    #[test]
    fn 表单保存载荷逐字段组装与拒绝() {
        let mut values: BTreeMap<String, String> = mcp_form_values(&表单样例());
        let save = mcp_save_from_values("old-name", &values).unwrap();
        assert_eq!(save.original_name, "old-name");
        assert_eq!(save.name, "demo");
        assert_eq!(save.transport, McpTransport::Http);
        assert_eq!(save.args, "-y\npkg");
        assert_eq!(save.url, "https://example.com/mcp");
        assert_eq!(save.env, "TOKEN=1");
        assert_eq!(save.headers, "A=b");
        assert!(!save.enabled);

        // 缺字段：结构化 CONFIG，点名字段（不把读不出的控件值静默当空串）。
        let missing = MCP_FIELD_URL;
        values.remove(missing);
        let error = mcp_save_from_values("demo", &values).unwrap_err();
        assert_eq!(error.code(), "CONFIG");
        assert!(error.to_string().contains(missing), "错误要点名缺字段: {error}");

        // 非法 transport / enabled：同样如实拒绝（取值只认登记枚举）。
        let mut bad_transport = mcp_form_values(&表单样例());
        bad_transport.insert(MCP_FIELD_TRANSPORT.to_string(), "sse".to_string());
        let error = mcp_save_from_values("demo", &bad_transport).unwrap_err();
        assert_eq!(error.code(), "CONFIG");
        assert!(error.to_string().contains("transport"));
        let mut bad_enabled = mcp_form_values(&表单样例());
        bad_enabled.insert(MCP_FIELD_ENABLED.to_string(), "yes".to_string());
        let error = mcp_save_from_values("demo", &bad_enabled).unwrap_err();
        assert_eq!(error.code(), "CONFIG");
        assert!(error.to_string().contains("enabled"));
    }

    #[test]
    fn 行内下拉与动作不成对如实报错() {
        // 有动作没载荷：画不出可点的下拉。
        assert!(
            parse_rows(&json!([{ "id": "a", "title": "A", "action": "pick" }])).is_err()
        );
        // 有载荷没动作：渲染不出来的死数据。
        assert!(parse_rows(&json!([{
            "id": "b", "title": "B",
            "pick": { "options": [{ "value": "x", "label": "X" }], "selected": "x" }
        }]))
        .is_err());
        // 空选项表与缺 selected 都是协议违规。
        assert!(parse_rows(&json!([{
            "id": "c", "title": "C", "action": "pick",
            "pick": { "options": [], "selected": "x" }
        }]))
        .is_err());
        assert!(parse_rows(&json!([{
            "id": "d", "title": "D", "action": "pick",
            "pick": { "options": [{ "value": "x", "label": "X" }] }
        }]))
        .is_err());
    }
}
