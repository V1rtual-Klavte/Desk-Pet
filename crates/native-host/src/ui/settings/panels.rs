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

use serde_json::Value;

use crate::error::{AppError, AppResult};

/// 面板 id（平台层按它把行动作回传给本域；也是渲染时区分面板的坐标）。
pub const PANEL_MCP: &str = "tools.mcp";
pub const PANEL_SKILLS: &str = "tools.skills";
pub const PANEL_POLICIES: &str = "tools.policies";
pub const PANEL_MEMORY_ITEMS: &str = "memory.items";
pub const PANEL_MEMORY_JOBS: &str = "memory.jobs";
/// 外观页的音效试听面板（行按钮 = 试听该事件当前分配的音效）。
pub const PANEL_SOUNDS: &str = "appearance.sounds";

/// 一行的动作形状（平台层按钮的点击归宿）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowAction {
    /// 纯展示行（工具策略、历史版本、整理作业）。
    None,
    /// 逐项开关：点击由本域取反并走既有写入口（MCP 服务器 / Skill）。
    Toggle,
    /// 点开加载详情（记忆条目）。
    Select,
    /// 打开行编辑文档（MCP 服务器的 args/env 与自定义条目）。
    Edit,
    /// 删除该行代表的资源（自定义 MCP 服务器 / Skill；内置与默认资源拒绝）。
    Delete,
    /// 试听该行代表的音效（音效事件行）。
    Preview,
    /// 行内下拉：主控件是弹出选择（选项见 `PanelRow::pick`），
    /// 选中某值后由平台把（行 id, 值）回传领域入口（音效事件行）。
    Pick,
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
    /// 当前版本的来源 id（原话回看入口逐条取证据；空 = 没有可回看的来源）。
    pub source_ids: Vec<String>,
    /// 历史版本行（含来源审计摘要；只读）。
    pub history: Vec<PanelRow>,
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
