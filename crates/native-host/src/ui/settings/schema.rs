//! 原生设置窗的表单 schema（W9a）。
//!
//! **这不是配置的第二定义点**：schema 只有「界面上有哪些控件、键叫什么、控件是什么
//! 形状」；字段的**值与默认值一律来自 CONFIG**（Node 经 [`super::SettingsPort`] 推送
//! 快照、提交回写）。这里不写默认值、不做单位换算，只做控件描述与提交校验
//! （枚举合法值、数值范围与步长）。
//!
//! `key` 与 CONFIG 路径逐字一致（如 `general.popup.chatWidth`、`appearance.font.size`），
//! 这样 Node 侧映射不需要第二张表；本包已覆盖的字段与剩余批次见交付报告。

/// 枚举选项（值与显示标签）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    pub value: &'static str,
    pub label: &'static str,
}

/// 控件类型。`Action` 不绑定字段值，是「按一下执行一件事」的入口（如检查更新）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FieldKind {
    Bool,
    /// 数值输入。`step` 供文本输入的增减与校验用；`unit` 只是标签后缀。
    Number {
        min: f64,
        max: f64,
        step: f64,
        unit: &'static str,
    },
    /// 数值档位：**CONFIG 里仍是数字**，界面按给定档位做分段控件（如「弱 / 强」）。
    ///
    /// 与 [`FieldKind::Enum`] 的区别是**落盘类型**：`Enum` 存字符串，这个存数字 ——
    /// 用在「取值其实是离散的，但存量与契约都是数字」的字段上（灵动强度 1/2，
    /// 用户规则「改成弱/强 实际值 1/2」），这样 CONFIG 格式与读取链一个字都不用动。
    /// 档位之外的数值（存量里可能有的 1.5、0.8 等）仍如实读回并按最近档显示，
    /// **不静默改成档位值** —— 用户没动它就不该被改写。
    NumberChoice {
        /// `(标签, 数值)`；界面按声明序摆分段。
        options: &'static [(&'static str, f64)],
    },
    /// 单行文本。`secret` = 密码样式显示（如 API Key）。
    Text {
        secret: bool,
    },
    /// 多行文本（如命令白名单，一行一项）。
    Multiline,
    Enum(&'static [Choice]),
    /// 系统字体族选择（选项由 [`crate::commands::font_cmd::list_system_fonts`] 枚举）。
    FontFamily,
    /// 人格卡（Card）选择（选项由 Node 的人格注册表经 `SettingsPort::cards` 提供；
    /// 值 = Card id，切换走注册表唯一入口，不是普通 CONFIG 写）。
    CardChoice,
    /// 激活 Profile 选择（选项由 Node 的 Profile 域经 `SettingsPort::profiles` 提供；
    /// 值 = Profile id（CONFIG 路径 `appearance.activeProfile`），切换走
    /// `switchActiveProfile` 唯一入口，不是普通 CONFIG 写）。
    ProfileChoice,
    /// 只读展示（如固定位置坐标由窗口拖动写回，设置窗只显示当前值）。
    /// 值由 [`super::info_text`] 从快照投影，不参与提交。
    Info,
    /// 快捷键录制：点击进入录制，捕获真实按键后写入 `key` 与本平台修饰键两个键
    /// （组合校验走 `ui::shortcut::parse_spec` 唯一校验点）。
    Shortcut,
    /// 快捷键修饰键的提交键表条目：由 [`FieldKind::Shortcut`] 按平台写入，
    /// 本身不渲染控件（留在 schema 里是为了让提交校验仍按键表收口）。
    ShortcutModifiers,
    /// 动作入口（`check_update` 等）；提交映射不包含它。
    Action,
}

impl FieldKind {
    pub fn is_action(&self) -> bool {
        matches!(self, FieldKind::Action)
    }
}

/// 单个字段。
#[derive(Debug, Clone, Copy)]
pub struct Field {
    /// CONFIG 路径（与 Node getter 的字段链同名）。
    pub key: &'static str,
    pub label: &'static str,
    pub kind: FieldKind,
    /// 控件下方的说明；空串 = 不显示。
    pub help: &'static str,
}

/// 一组字段。
#[derive(Debug, Clone, Copy)]
pub struct Section {
    pub title: &'static str,
    pub fields: &'static [Field],
}

/// 一个设置 Tab（通用 / 外观 / AI / 工具 / 记忆）。
#[derive(Debug, Clone, Copy)]
pub struct Tab {
    pub id: &'static str,
    pub label: &'static str,
    pub sections: &'static [Section],
}

// `POPUP_MODE` 删除记录（2026-10-05）：`general.popup.mode`（弹窗位置）随窗口几何那批设置项
// 一起从界面撤下，这个选项表没有消费者了。窗口位置模式仍由 CONFIG 的该键决定（默认值不变），
// 只是不再提供界面切换。

const LOG_LEVELS: &[Choice] = &[
    Choice {
        value: "debug",
        label: "debug",
    },
    Choice {
        value: "info",
        label: "info",
    },
    Choice {
        value: "warn",
        label: "warn",
    },
    Choice {
        value: "error",
        label: "error",
    },
];

const ERROR_OVERLAY: &[Choice] = &[
    Choice {
        value: "auto",
        label: "auto（dev 弹、生产不弹）",
    },
    Choice {
        value: "always",
        label: "always（两端都弹）",
    },
    Choice {
        value: "never",
        label: "never（只写日志）",
    },
];

const EFFECT_MODE: &[Choice] = &[
    Choice {
        value: "off",
        label: "静态",
    },
    Choice {
        value: "parallax",
        label: "灵动图层",
    },
];

/// 界面主题五选一。
///
/// 值与 CONFIG `appearance.theme`、TS 侧 `ThemeId`、Rust `ui::theme::ThemeId`
/// **逐字一致**（四份字面量是同一个枚举的四种写法；改动要一起改）。
/// 与 `ui::theme::ThemeId::ALL` 有对账测试钉住，漏一处会红。
const THEME: &[Choice] = &[
    Choice {
        value: "brushed",
        label: "拉丝金属",
    },
    Choice {
        value: "chrome",
        label: "铬",
    },
    Choice {
        value: "verdigris",
        label: "铜绿",
    },
    Choice {
        value: "nightfall",
        label: "暮蓝",
    },
    Choice {
        value: "azurite",
        label: "青花",
    },
];

// 会话投递的文案与选项顺序按旧壳（SettingsPanel 的 AITab「对话投递」三段式）：
// 默认发送方式 / 插话批量处理 / 稍后继续的后续消息；两段批量策略的选项措辞与顺序
// 各自独立（插话段「集中处理补充」在前，稍后继续段「逐条处理」在前），不合并成一张表。
const DELIVERY: &[Choice] = &[
    Choice {
        value: "steer",
        label: "插话",
    },
    Choice {
        value: "followUp",
        label: "稍后继续",
    },
];

const STEERING_BATCH: &[Choice] = &[
    Choice {
        value: "all",
        label: "集中处理补充",
    },
    Choice {
        value: "one-at-a-time",
        label: "逐条处理",
    },
];

const FOLLOW_UP_BATCH: &[Choice] = &[
    Choice {
        value: "one-at-a-time",
        label: "逐条处理",
    },
    Choice {
        value: "all",
        label: "集中处理",
    },
];

const SAFETY_MODE: &[Choice] = &[
    Choice {
        value: "just_do_it",
        label: "全放行",
    },
    Choice {
        value: "tell_me",
        label: "告知确认",
    },
    Choice {
        value: "let_me_tk",
        label: "全部确认",
    },
];

const DREAMING_MODE: &[Choice] = &[
    Choice {
        value: "manual",
        label: "手动",
    },
    Choice {
        value: "idle",
        label: "空闲自动",
    },
];

// ── 通用 ──

const GENERAL_POPUP: &[Field] = &[
    // 2026-10-05 收敛（用户规则「去掉当前坐标，以及窗口四个参数显示设置，以及预览尺寸，没必要留」）：
    // 这一段原有 7 项，撤掉 6 项只留下面这一项。撤掉的是：
    //   general.popup.mode（弹窗位置）、general.popup.fixedPosition（当前坐标）、
    //   general.popup.defaultSize.w / .h、general.popup.chatWidth、action.previewPopupSize。
    //
    // **它们仍是 CONFIG 里的有效键**：窗口拖动、分隔条拖动会持续写回，
    // 只是不再摆到用户面前 —— 窗口尺寸用鼠标直接调更直观，设置页留一排 px 数字反而劝退。
    // 改这些键请编辑运行时配置文件（用途与入口见 docs/current/runtime-data.md 的同名清单）。
    Field {
        key: "general.popup.autoPopupOnMessage",
        label: "收到消息自动弹出",
        kind: FieldKind::Bool,
        help: "",
    },
];

const GENERAL_SHORTCUT: &[Field] = &[
    Field {
        key: "general.shortcut.key",
        label: "呼出快捷键",
        kind: FieldKind::Shortcut,
        help: "点击后按下新组合键（至少一个修饰键）；Esc 取消",
    },
    // 两个修饰键键位留在 schema 里，由录制控件按当前平台写入；
    // 不渲染独立控件（FieldKind::ShortcutModifiers），但提交校验仍按键表收口。
    Field {
        key: "general.shortcut.macModifiers",
        label: "macOS 修饰键",
        kind: FieldKind::ShortcutModifiers,
        help: "",
    },
    Field {
        key: "general.shortcut.winModifiers",
        label: "Windows 修饰键",
        kind: FieldKind::ShortcutModifiers,
        help: "",
    },
];

const GENERAL_MISC: &[Field] = &[
    Field {
        key: "general.logging.level",
        label: "日志级别",
        kind: FieldKind::Enum(LOG_LEVELS),
        help: "",
    },
    Field {
        key: "general.errors.overlay",
        label: "异常覆盖层",
        kind: FieldKind::Enum(ERROR_OVERLAY),
        help: "",
    },
];

/// 应用控制：重启与更新共用统一退出序列（先写盘、后重启）。
const GENERAL_RESTART: &[Field] = &[Field {
    key: "action.restart",
    label: "重启应用",
    kind: FieldKind::Action,
    help: "先保存未保存的改动（有改动时），写盘失败不重启；有已下载的更新会在退出时安装",
}];

/// 更新入口（契约 §6.4/W10c：手动「检查更新」不许因原生化而消失）。
const GENERAL_UPDATE: &[Field] = &[Field {
    key: "action.checkUpdate",
    label: "检查更新",
    kind: FieldKind::Action,
    help: "启动约 30 秒后会自动检查一次；这里可以随时手动再查（有候选会进入确认与下载流程）",
}];

/// 配置的默认值与导入导出（本批）：默认值来自 Node 的内置模板，导入导出走原生文件对话框。
const GENERAL_CONFIG_IO: &[Field] = &[
    Field {
        key: "action.resetDefaults",
        label: "↺ 默认值",
        kind: FieldKind::Action,
        help: "把内置默认值填入草稿（不直接写盘、不动密钥字段）；看到「待保存」后点保存才生效",
    },
    Field {
        key: "action.exportConfig",
        label: "导出配置",
        kind: FieldKind::Action,
        help: "把当前运行时 CONFIG 写成 YAML 文件；导出内容可能包含密钥，分享前先检查",
    },
    Field {
        key: "action.importConfig",
        label: "导入配置",
        kind: FieldKind::Action,
        help: "选择一份 YAML 覆盖当前运行时 CONFIG（校验失败不会写盘）",
    },
];

// ── 外观 ──

const APPEARANCE_DISPLAY: &[Field] = &[
    Field {
        key: "appearance.activeProfile",
        label: "当前 Profile",
        kind: FieldKind::ProfileChoice,
        help: "切换角色外观包；选项来自运行时 profiles 目录，切换会重载舞台与素材",
    },
    // Profile 列表由窗口打开时拉取一次；外部增删后用手动刷新，不用重开设置窗。
    Field {
        key: "action.refreshProfiles",
        label: "刷新 Profile 列表",
        kind: FieldKind::Action,
        help: "重新扫描运行时 profiles 目录（外部新增/删除 Profile 后不用重开设置窗）",
    },
    // 图层编辑器入口：编辑对象就是上面选中的当前 Profile 的图层素材，
    // 所以与「当前 Profile / 刷新列表」同组相邻（选 → 刷 → 编辑一条线），
    // 不落「Profile 资源」组（那组是打包级新建/导入导出/删除的文件管理）。
    Field {
        key: "action.openLayerEditor",
        label: "打开图层编辑器",
        kind: FieldKind::Action,
        help: "打开独立的图层编辑器窗口，调整当前 Profile 的图层顺序、显隐与缩放；内容随当前 Profile 变化，改完在编辑器里保存",
    },
    Field {
        key: "appearance.effectMode",
        label: "角色效果",
        kind: FieldKind::Enum(EFFECT_MODE),
        help: "",
    },
    Field {
        key: "appearance.theme",
        label: "界面主题",
        kind: FieldKind::Enum(THEME),
        help: "产品预设三选一（不可改色值）；与 Profile 无关，换 Profile 不换主题",
    },
    Field {
        key: "appearance.parallax.intensity",
        label: "灵动强度",
        kind: FieldKind::NumberChoice {
            options: &[("弱", 1.0), ("强", 2.0)],
        },
        help: "1 = 弱、2 = 强；只影响灵动图层的位移幅度",
    },
    Field {
        key: "appearance.chatImagePreview",
        label: "聊天图片自动预览",
        kind: FieldKind::Bool,
        help: "关闭时历史消息只显示图片占位，点击占位仍可打开查看器",
    },
];

const APPEARANCE_FONT: &[Field] = &[
    Field {
        key: "appearance.font.family",
        label: "全局字体",
        kind: FieldKind::FontFamily,
        help: "只列系统已安装字体；空 = 跟随系统默认字体",
    },
    Field {
        key: "appearance.font.size",
        label: "全局字号",
        kind: FieldKind::Number {
            min: 10.0,
            max: 24.0,
            step: 1.0,
            unit: "px",
        },
        help: "",
    },
];

/// Profile 资源管理（本批）：动作对象 = 当前选中 Profile（下拉草稿值；删除/导出前平台会再确认）。
/// 「编辑」类动作打开行编辑文档（内容与校验都在 Node）。
const APPEARANCE_PROFILE: &[Field] = &[
    Field {
        key: "action.profileCreate",
        label: "新建 Profile",
        kind: FieldKind::Action,
        help: "创建一个空 Profile（无素材），之后可重命名并逐层添加素材",
    },
    Field {
        key: "action.profileRename",
        label: "重命名当前 Profile",
        kind: FieldKind::Action,
        help: "修改当前 Profile 的显示名（立即生效；目录名与素材不受影响）",
    },
    Field {
        key: "action.profileExport",
        label: "导出当前 Profile",
        kind: FieldKind::Action,
        help: "打包为 zip（含 profile.yaml 与素材）",
    },
    Field {
        key: "action.profileImport",
        label: "导入 Profile",
        kind: FieldKind::Action,
        help: "选择一个导出的 zip；Profile 名取自文件名，同名目录会被覆盖",
    },
    Field {
        key: "action.profileDelete",
        label: "删除当前 Profile",
        kind: FieldKind::Action,
        help: "删除运行时 profiles 目录下的当前 Profile（默认 Profile 与内置资源拒绝删除）",
    },
    Field {
        key: "action.profileRestoreDefaults",
        label: "恢复默认资源",
        kind: FieldKind::Action,
        help: "用随包默认覆盖同名 Card/Profile/Skill；自建资源保留",
    },
];

/// 音效：恢复内置默认（事件分配本身在「音效分配」面板的行内下拉里改）。
const APPEARANCE_SOUND: &[Field] = &[Field {
    key: "action.soundResetDefaults",
    label: "↺ 恢复默认",
    kind: FieldKind::Action,
    help: "把所有事件分配恢复为内置默认（清空自定义分配）；立即生效",
}];

// ── AI ──

const AI_MODEL: &[Field] = &[
    Field {
        key: "ai.provider",
        label: "提供方",
        kind: FieldKind::Text { secret: false },
        help: "",
    },
    Field {
        key: "ai.endpoint",
        label: "端点",
        kind: FieldKind::Text { secret: false },
        help: "",
    },
    Field {
        key: "ai.apiKey",
        label: "密钥",
        kind: FieldKind::Text { secret: true },
        help: "",
    },
    Field {
        key: "ai.model",
        label: "模型",
        kind: FieldKind::Text { secret: false },
        help: "",
    },
    Field {
        key: "ai.auxModel",
        label: "辅助模型",
        kind: FieldKind::Text { secret: false },
        help: "子代理 / 记忆整理 / 主动规划；留空跟随聊天模型",
    },
    Field {
        key: "ai.requireApiKey",
        label: "需要 API Key",
        kind: FieldKind::Bool,
        help: "",
    },
];

// 技术参数按「设置页瘦身」边界撤下界面（值保留在 CONFIG/getter，YAML 可改）：
// `ai.contextMaxTokens`、`ai.thinking.effort`、`ai.loop.*` 与记忆技术参数不再有控件。
// 消费点见 config.ts 的对应 getter 与运行内核，删除界面控件不影响取值。

const AI_CONVERSATION: &[Field] = &[
    Field {
        key: "ai.conversation.defaultDelivery",
        label: "默认发送方式（忙碌时）",
        kind: FieldKind::Enum(DELIVERY),
        help: "聊天框里可为单条消息覆盖；空闲时两种方式都直接开始新回合",
    },
    Field {
        key: "ai.conversation.steeringMode",
        label: "插话批量处理",
        kind: FieldKind::Enum(STEERING_BATCH),
        help: "",
    },
    Field {
        key: "ai.conversation.followUpMode",
        label: "稍后继续的后续消息",
        kind: FieldKind::Enum(FOLLOW_UP_BATCH),
        help: "批量策略在下一回合开始前生效，不重排已排队消息",
    },
];

const AI_SAFETY: &[Field] = &[
    Field {
        key: "ai.safety.mode",
        label: "确认策略",
        kind: FieldKind::Enum(SAFETY_MODE),
        help: "",
    },
    Field {
        key: "ai.safety.sessionTrustEnabled",
        label: "会话信任 NORMAL 工具",
        kind: FieldKind::Bool,
        help: "",
    },
];

/// 人格（Card）管理面：切换当前激活 Card，以及 Card 的增删改查与模版。
///
/// 选项来源是 Node 的人格注册表（`personality_cards` 请求），不是静态枚举 ——
/// Card 是用户可增删的运行时资源；本字段的值仍是 CONFIG 路径（`ai.personality.active`），
/// 提交时由 Node 走注册表唯一入口 `switchPersonality`。
///
/// 动作对象 = 当前激活 Card（与 Profile 资源同口径）：删除与导入前由平台再确认；
/// 「编辑」打开文档编辑窗（内容与校验都在 Node），「模版」是只读的提示词面板。
const AI_PERSONALITY: &[Field] = &[
    Field {
        key: "ai.personality.active",
        label: "人格卡",
        kind: FieldKind::CardChoice,
        help: "当前激活的人格卡；切换会加载对应阶段文案与变量池",
    },
    Field {
        key: "action.cardCreate",
        label: "新建 Card",
        kind: FieldKind::Action,
        help: "输入角色名，以随包模版为骨架创建一张新卡",
    },
    Field {
        key: "action.cardTemplate",
        label: "模版",
        kind: FieldKind::Action,
        help: "打开模版提示词，可复制给 AI 生成新卡",
    },
    Field {
        key: "action.cardEdit",
        label: "编辑当前 Card",
        kind: FieldKind::Action,
        help: "编辑当前卡的角色设定、语言风格、输出规则、行为进阶与变量定义",
    },
    Field {
        key: "action.cardRename",
        label: "重命名当前 Card",
        kind: FieldKind::Action,
        help: "只改显示名（立即生效；文件名、阶段文案与变量状态不受影响）",
    },
    Field {
        key: "action.cardExport",
        label: "导出当前 Card",
        kind: FieldKind::Action,
        help: "把当前卡的 markdown 原文导出到文件",
    },
    Field {
        key: "action.cardImport",
        label: "导入 Card",
        kind: FieldKind::Action,
        help: "选择一份 Card markdown；id 取自 frontmatter，同名卡会被覆盖",
    },
    Field {
        key: "action.cardDelete",
        label: "删除当前 Card",
        kind: FieldKind::Action,
        help: "删除卡片与它的阶段文案、变量状态；激活中的卡需先切到别的卡",
    },
];

const AI_COMPANION: &[Field] = &[
    Field {
        key: "ai.plan.enabled",
        label: "启用任务计划",
        kind: FieldKind::Bool,
        help: "",
    },
    Field {
        key: "ai.humanizer.enabled",
        label: "拟人表达",
        kind: FieldKind::Bool,
        help: "与主动总开关联动：只有主动开启时才有表达机会",
    },
    Field {
        key: "ai.memory.enabled",
        label: "长期记忆",
        kind: FieldKind::Bool,
        help: "召回与候选收集总开关",
    },
    Field {
        key: "ai.memory.dreaming.mode",
        label: "记忆整理模式",
        kind: FieldKind::Enum(DREAMING_MODE),
        help: "",
    },
];

/// 陪伴管理动作（本批）：主动开关、指令与阶段文案、变量池预览。
/// 均走请求面（Node 侧既有领域入口），不在这里落任何第二份状态。
const AI_COMPANION_ACTIONS: &[Field] = &[
    Field {
        key: "action.toggleProactive",
        label: "切换主动消息开关",
        kind: FieldKind::Action,
        help: "按钮上显示当前状态；点击取反（状态在宿主侧，进入本页时读取一次，切换后立即刷新）",
    },
    Field {
        key: "action.editV1rtual",
        label: "编辑 V1RTUAL 指令",
        kind: FieldKind::Action,
        help: "编辑 memory/V1RTUAL.md 的用户自定义指令（保存后下一个回合生效）",
    },
    Field {
        key: "action.editCardStages",
        label: "编辑阶段文案",
        kind: FieldKind::Action,
        help: "编辑当前卡的阶段/兜底文案（行格式在文档内说明；保存前会做完整校验）",
    },
    Field {
        key: "action.regenerateCardStages",
        label: "重新生成阶段文案",
        kind: FieldKind::Action,
        help: "按当前卡设定重新生成一套角色化文案（会覆盖同卡已生成的文案）",
    },
    Field {
        key: "action.showVariablePool",
        label: "查看变量池",
        kind: FieldKind::Action,
        help: "只读预览当前内存变量池（系统/角色/互动变量）",
    },
];

impl Field {
    /// 界面显示标签（2026-10-05）：带单位的数值字段把单位并入标签
    /// （「停留时长（秒）」「弹窗宽（px）」）——此前单位只存在于 schema，
    /// 界面上 60/2000 这类数字没有量纲，用户无从判断含义（交互逻辑实机反馈）。
    /// 单一实现点：macOS/Windows 两平台渲染与标签截断护栏测试共用。
    pub fn display_label(&self) -> String {
        match self.kind {
            FieldKind::Number { unit, .. } if !unit.is_empty() => {
                format!("{}（{unit}）", self.label)
            }
            _ => self.label.to_string(),
        }
    }
}

// 静默访问的四个节奏参数：CONFIG 键名与磁盘值保持原本口径（`staySeconds` 秒、
// `settleMs` 毫秒、两个 `*CooldownMs` 毫秒），界面按旧壳口径显示 —— 停留**秒**、
// 防抖**毫秒**、全局/同页冷却**秒**。冷却键的秒↔毫秒换算在草稿边界做唯一一次
// （`settings/mod.rs` 的 `MS_KEY_DISPLAY_SECONDS`，schema 不自行换算）；
// 本表的范围/步长按**显示单位**（秒）收口。
const AI_SILENT: &[Field] = &[
    Field {
        key: "ai.silentAccess.enabled",
        // 标签避免与小节标题「静默访问」逐字重复（实机反馈：区块标题下第一行
        // 又是同名标签，读起来像渲染错误）。
        label: "启用静默访问",
        kind: FieldKind::Bool,
        help: "允许观察窗口、截图与手边文件；读取哪些文件由 AI 根据当前窗口判断，用于带来源的了解。主动消息由独立开关控制",
    },
    Field {
        key: "ai.silentAccess.staySeconds",
        label: "停留时长",
        kind: FieldKind::Number {
            min: 5.0,
            max: 600.0,
            step: 5.0,
            unit: "s",
        },
        help: "",
    },
    Field {
        key: "ai.silentAccess.settleMs",
        label: "防抖",
        kind: FieldKind::Number {
            min: 0.0,
            max: 30_000.0,
            step: 500.0,
            unit: "ms",
        },
        help: "",
    },
    Field {
        key: "ai.silentAccess.cooldownMs",
        label: "全局冷却",
        kind: FieldKind::Number {
            min: 0.0,
            max: 600.0,
            step: 1.0,
            unit: "s",
        },
        help: "",
    },
    Field {
        key: "ai.silentAccess.samePageCooldownMs",
        label: "同页冷却",
        kind: FieldKind::Number {
            min: 0.0,
            max: 600.0,
            step: 1.0,
            unit: "s",
        },
        help: "",
    },
];

// ── 工具 ──

const TOOLS_BASH: &[Field] = &[Field {
    key: "tools.bash.whitelist",
    label: "命令白名单",
    kind: FieldKind::Multiline,
    help: "一行一项；只影响自动放行判定，硬基线仍由 Rust 裁决",
}];

// 工具页的 MCP / Skill / 工具策略管理面不再走静态字段：动态列表由
// `ui/settings/panels.rs` 的管理面模型承载（数据来自 Node，逐项开关走既有写入口）。

/// 工具页动作（本批）：MCP 新增/导入导出、Skill 上传。
/// 行级编辑/删除在管理面列表的行按钮上（MCP「编辑」、Skill「删除」）。
const TOOLS_ACTIONS: &[Field] = &[
    Field {
        key: "action.mcpAddServer",
        label: "新增 MCP 服务器",
        kind: FieldKind::Action,
        help: "打开编辑文档填写自定义服务器（保存后写 CONFIG 并热重载列表）",
    },
    Field {
        key: "action.mcpImport",
        label: "导入 MCP 配置",
        kind: FieldKind::Action,
        help: "从 JSON 数组导入自定义服务器（会替换现有自定义列表）",
    },
    Field {
        key: "action.mcpExport",
        label: "导出 MCP 配置",
        kind: FieldKind::Action,
        help: "把当前自定义服务器列表导出为 JSON；内容可能含密钥，分享前先检查",
    },
    Field {
        key: "action.skillUpload",
        label: "上传 Skill",
        kind: FieldKind::Action,
        help: "选择一份 SKILL.md（需带 name frontmatter；写入前会做完整校验）",
    },
];

// ── 记忆 ──

// 记忆页只保留库管理动作：技术参数（coreTokenBudget / recallTokenBudget / maxSessions）
// 已按「设置页瘦身」边界撤下界面（值保留在 CONFIG/getter，YAML 可改）。
// 库管理（条目浏览/纠正/遗忘/历史/整理作业）走管理面模型（`panels.rs`），不进静态字段表。

// 记忆页动作（2026-10-05 规整）。
//
// 用户规则：「这一大堆规整下，观感和交互太差了」—— 原来 11 个动作**平铺在一个「库管理」小节**
// 里，没有分组，且说明全是 `scope=user` 这类**实现口径**（用户看不懂）。现在按**功能**拆成 4 个小节：
// 筛选范围 / 整理与维护 / 备份与恢复 / 当前条目；按钮文案去掉「范围：」前缀（小节标题已经说明了），
// 说明改成人话并缩短。
//
// 分组与文案属于**共享层**责任：平台只按 `Section` 画分组线（渲染层不做 key→分组的映射，
// 否则就是第二个定义点）。

/// 记忆页：条目列表的范围筛选（四选一）。
///
/// 说明：这里四个动作是**同一组互斥选项**，不是四个独立命令。平台将来若做成分段控件，
/// 选中态要由记忆作用域快照决定 —— 目前仍是四个动作按钮（分段化需要一个能承载
/// 「选项 + 当前值」的字段形态，是独立的一小批）。
const MEMORY_SCOPE: &[Field] = &[
    Field {
        key: "action.memoryScopeAll",
        label: "全部",
        kind: FieldKind::Action,
        help: "用户级、角色级、会话级的记忆都列出来",
    },
    Field {
        key: "action.memoryScopeUser",
        label: "仅用户级",
        kind: FieldKind::Action,
        help: "只列跨会话的长期事实",
    },
    Field {
        key: "action.memoryScopeCard",
        label: "仅当前角色",
        kind: FieldKind::Action,
        help: "只列属于当前激活角色的记忆",
    },
    Field {
        key: "action.memoryScopeSession",
        label: "仅当前会话",
        kind: FieldKind::Action,
        help: "只列当前会话产生的记忆",
    },
];

/// 记忆页：整理与维护（都不改正文，可放心点）。
const MEMORY_MAINTAIN: &[Field] = &[
    Field {
        key: "action.memorySweep",
        label: "立即整理一次",
        kind: FieldKind::Action,
        help: "会调用模型，可能需要一会儿；完成后自动刷新列表",
    },
    Field {
        key: "action.memoryRebuildIndex",
        label: "重建索引",
        kind: FieldKind::Action,
        help: "只重建派生索引，正文与事实不变",
    },
    Field {
        key: "action.memoryExport",
        label: "导出只读视图",
        kind: FieldKind::Action,
        help: "导出一份给人看的 Markdown，不回写数据",
    },
];

/// 记忆页：备份与恢复。
///
/// 顺序按**破坏性递增**排：备份（无破坏）→ 预览（只读）→ 应用（覆盖当前库）。
/// 「应用最近备份」是**破坏性操作**，平台应给它 `danger` 色系并保留二次确认。
const MEMORY_BACKUP: &[Field] = &[
    Field {
        key: "action.memoryBackup",
        label: "备份现在",
        kind: FieldKind::Action,
        help: "生成一份可恢复的备份；不改变当前记忆库",
    },
    Field {
        key: "action.memoryRestorePreview",
        label: "预览最近备份",
        kind: FieldKind::Action,
        help: "只读校验最近一份备份能不能用，不应用",
    },
    Field {
        key: "action.memoryRestoreApply",
        label: "应用最近备份",
        kind: FieldKind::Action,
        help: "用备份覆盖当前记忆库 —— 不可撤销，请先预览确认版本",
    },
];

/// 记忆页：**当前选中条目**的来源证据（绑定列表选择，独立成节 ——
/// 它混在全局操作里时，用户看不出「这按钮作用在哪」）。
const MEMORY_SOURCE: &[Field] = &[Field {
    key: "action.memorySourceEvidence",
    label: "查看来源原话",
    kind: FieldKind::Action,
    help: "显示这条记忆的出处与会话里的原话（最多 5 条）",
}];

/// 全部设置 Tab。顺序即界面顺序（通用 / AI / 记忆 / 工具 / 外观，与旧壳设置页一致）。
pub const TABS: &[Tab] = &[
    Tab {
        id: "general",
        label: "通用",
        sections: &[
            Section {
                title: "弹窗",
                fields: GENERAL_POPUP,
            },
            Section {
                title: "快捷键",
                fields: GENERAL_SHORTCUT,
            },
            Section {
                title: "日志与异常",
                fields: GENERAL_MISC,
            },
            Section {
                title: "配置",
                fields: GENERAL_CONFIG_IO,
            },
            Section {
                title: "更新",
                fields: GENERAL_UPDATE,
            },
            Section {
                title: "应用",
                fields: GENERAL_RESTART,
            },
        ],
    },
    Tab {
        id: "ai",
        label: "AI",
        sections: &[
            Section {
                title: "模型",
                fields: AI_MODEL,
            },
            Section {
                title: "会话",
                fields: AI_CONVERSATION,
            },
            Section {
                title: "安全",
                fields: AI_SAFETY,
            },
            Section {
                title: "人格",
                fields: AI_PERSONALITY,
            },
            Section {
                title: "陪伴",
                fields: AI_COMPANION,
            },
            Section {
                title: "陪伴管理",
                fields: AI_COMPANION_ACTIONS,
            },
            Section {
                title: "静默访问",
                fields: AI_SILENT,
            },
        ],
    },
    Tab {
        id: "memory",
        label: "记忆",
        sections: &[
            Section {
                title: "筛选范围",
                fields: MEMORY_SCOPE,
            },
            Section {
                title: "整理与维护",
                fields: MEMORY_MAINTAIN,
            },
            Section {
                title: "备份与恢复",
                fields: MEMORY_BACKUP,
            },
            Section {
                title: "当前条目",
                fields: MEMORY_SOURCE,
            },
        ],
    },
    Tab {
        id: "tools",
        label: "工具",
        sections: &[
            Section {
                title: "Bash",
                fields: TOOLS_BASH,
            },
            Section {
                title: "管理动作",
                fields: TOOLS_ACTIONS,
            },
        ],
    },
    Tab {
        id: "appearance",
        label: "外观",
        sections: &[
            Section {
                title: "角色展示",
                fields: APPEARANCE_DISPLAY,
            },
            Section {
                title: "Profile 资源",
                fields: APPEARANCE_PROFILE,
            },
            Section {
                title: "字体（全局）",
                fields: APPEARANCE_FONT,
            },
            Section {
                title: "音效",
                fields: APPEARANCE_SOUND,
            },
        ],
    },
];

/// 按 key 查字段（校验提交值用）。
pub fn field(key: &str) -> Option<&'static Field> {
    for tab in TABS {
        for section in tab.sections {
            for field in section.fields {
                if field.key == key {
                    return Some(field);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn 键全局唯一且带配置域前缀() {
        let mut seen = HashSet::new();
        for tab in TABS {
            for section in tab.sections {
                for field in section.fields {
                    assert!(seen.insert(field.key), "键重复: {}", field.key);
                    if field.kind.is_action() {
                        assert!(field.key.starts_with("action."), "动作键: {}", field.key);
                    } else {
                        assert!(
                            field.key.contains('.'),
                            "普通字段键必须是配置路径: {}",
                            field.key
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn 动作字段与普通字段互不混入提交映射() {
        assert!(field("action.checkUpdate").unwrap().kind.is_action());
        assert!(!field("general.logging.level").unwrap().kind.is_action());
        assert!(field("不存在的键").is_none());
    }

    #[test]
    fn 数值字段范围自洽() {
        for tab in TABS {
            for section in tab.sections {
                for field in section.fields {
                    if let FieldKind::Number { min, max, step, .. } = field.kind {
                        assert!(min < max, "{}: min 必须小于 max", field.key);
                        assert!(step > 0.0, "{}: step 必须为正", field.key);
                    }
                }
            }
        }
    }

    #[test]
    fn 枚举字段的选项值非空且去重() {
        for tab in TABS {
            for section in tab.sections {
                for field in section.fields {
                    if let FieldKind::Enum(choices) = field.kind {
                        assert!(!choices.is_empty(), "{}: 枚举不能为空", field.key);
                        let mut values = HashSet::new();
                        for choice in choices {
                            assert!(!choice.value.is_empty());
                            assert!(values.insert(choice.value), "{}: 选项值重复", field.key);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn 五个入口齐备() {
        let ids: Vec<&str> = TABS.iter().map(|tab| tab.id).collect();
        assert_eq!(ids, vec!["general", "ai", "memory", "tools", "appearance"]);
    }

    /// 「设置页瘦身」边界：技术参数不得回流界面控件（值保留在 CONFIG/getter，YAML 可改）。
    #[test]
    fn 撤下的技术参数不再有界面控件() {
        for key in [
            "ai.contextMaxTokens",
            "ai.thinking.effort",
            "ai.loop.maxRetry",
            "ai.loop.maxToolCallsPerTurn",
            "ai.loop.maxParallelTools",
            "ai.memory.coreTokenBudget",
            "ai.memory.recallTokenBudget",
            "ai.memory.maxSessions",
        ] {
            assert!(
                super::field(key).is_none(),
                "{key} 已按瘦身边界撤下界面，不得再有控件"
            );
        }
    }

    /// 记忆页删空「记忆参数」后不留空壳小节（TABS 里不得出现空 fields）。
    #[test]
    fn 没有空小节() {
        for tab in TABS {
            for section in tab.sections {
                assert!(
                    !section.fields.is_empty(),
                    "{}/{} 是空小节（删空后必须整节移除）",
                    tab.id,
                    section.title
                );
            }
        }
    }

    /// 冷却键的界面单位必须是秒（秒↔毫秒换算在草稿边界的唯一键表里，见 mod.rs）。
    #[test]
    fn 静默访问冷却键界面单位是秒() {
        for key in [
            "ai.silentAccess.cooldownMs",
            "ai.silentAccess.samePageCooldownMs",
        ] {
            let field = super::field(key).unwrap_or_else(|| panic!("{key} 应在 schema 里"));
            match field.kind {
                FieldKind::Number { unit, .. } => {
                    assert_eq!(unit, "s", "{key} 的界面单位必须是秒（旧壳口径）")
                }
                other => panic!("{key} 必须是数值控件: {other:?}"),
            }
        }
        match super::field("ai.silentAccess.settleMs").unwrap().kind {
            FieldKind::Number { unit, .. } => {
                assert_eq!(unit, "ms", "防抖保持毫秒（不与冷却一起换算）")
            }
            other => panic!("防抖必须是数值控件: {other:?}"),
        }
    }

    #[test]
    fn 激活profile字段在外观页且走动态选项控件() {
        let appearance = TABS.iter().find(|tab| tab.id == "appearance").unwrap();
        let active = appearance
            .sections
            .iter()
            .flat_map(|section| section.fields.iter())
            .find(|field| field.key == "appearance.activeProfile")
            .unwrap();
        assert!(matches!(active.kind, FieldKind::ProfileChoice));
        assert_eq!(
            super::field("appearance.activeProfile").map(|item| item.kind),
            Some(FieldKind::ProfileChoice),
            "键必须能在全局字段表里按 CONFIG 路径查到"
        );
    }

    /// 主题下拉的选项必须与 `ui::theme::ThemeId` 逐条对齐。
    ///
    /// 同一个枚举在四处各写了一遍字面量（CONFIG 注释 / TS `ThemeId` / 本表 /
    /// `ui::theme::ThemeId`）。跨语言的查不了，同一个 crate 里的这两处必须钉住 ——
    /// 加主题时只改一边，设置页会显示一个宿主认不出、读回来被收拢成默认的选项。
    #[test]
    fn 外观页主题选项与主题域逐条对齐() {
        let appearance = TABS.iter().find(|tab| tab.id == "appearance").unwrap();
        let field = appearance
            .sections
            .iter()
            .flat_map(|section| section.fields.iter())
            .find(|field| field.key == "appearance.theme")
            .expect("外观页必须有界面主题字段");

        let FieldKind::Enum(choices) = field.kind else {
            panic!("界面主题必须是枚举下拉，实际 {:?}", field.kind);
        };

        let from_schema: Vec<&str> = choices.iter().map(|choice| choice.value).collect();
        let from_theme: Vec<&str> = crate::ui::theme::ThemeId::ALL
            .iter()
            .map(|id| id.as_str())
            .collect();
        assert_eq!(
            from_schema, from_theme,
            "下拉选项与主题域的顺序和取值必须一致"
        );

        // 标签也要对得上，否则设置页显示的是一套名字、别的文档写的是另一套。
        for (choice, id) in choices.iter().zip(crate::ui::theme::ThemeId::ALL) {
            assert_eq!(
                choice.label,
                id.label(),
                "主题 {} 的显示名不一致",
                choice.value
            );
        }

        assert_eq!(
            super::field("appearance.theme").map(|item| item.kind),
            Some(field.kind),
            "键必须能在全局字段表里按 CONFIG 路径查到"
        );
    }

    #[test]
    fn 人格卡字段在陪伴页且走动态选项控件() {
        let ai = TABS.iter().find(|tab| tab.id == "ai").unwrap();
        let field = ai
            .sections
            .iter()
            .flat_map(|section| section.fields.iter())
            .find(|field| field.key == "ai.personality.active")
            .unwrap();
        assert!(matches!(field.kind, FieldKind::CardChoice));
        assert!(
            !field.kind.is_action(),
            "人格卡是值字段（提交走 CONFIG 路径），不是动作入口"
        );
    }

    #[test]
    fn 通用页快捷键走录制控件且修饰键只作键表条目() {
        let general = TABS.iter().find(|tab| tab.id == "general").unwrap();
        let fields: Vec<&Field> = general
            .sections
            .iter()
            .flat_map(|section| section.fields.iter())
            .collect();
        let key = fields
            .iter()
            .find(|field| field.key == "general.shortcut.key")
            .unwrap();
        assert!(matches!(key.kind, FieldKind::Shortcut));
        for modifiers_key in [
            "general.shortcut.macModifiers",
            "general.shortcut.winModifiers",
        ] {
            let field = fields
                .iter()
                .find(|field| field.key == modifiers_key)
                .unwrap();
            assert!(
                matches!(field.kind, FieldKind::ShortcutModifiers),
                "{modifiers_key} 由录制控件写入，不应是可编辑文本控件"
            );
        }
    }

    // `固定位置是只读展示字段` 删除记录（2026-10-05）：用户规则「去掉当前坐标、窗口四个参数、
    // 预览尺寸，没必要留」—— 该字段（`FieldKind::Info` 的唯一使用者）已从界面撤下，
    // 这条断言没有对象了。**机制保留**：`FieldKind::Info` 与 `validate_value` 的拒绝分支
    // 仍在，下个只读展示字段出现时按原样加回一条同款测试。

    /// 设置窗的图层编辑器入口（2026-10-05）：编辑对象是当前 Profile 的图层素材，
    /// 入口放外观页「角色展示」组（紧跟 Profile 选择与列表刷新两行）。
    #[test]
    fn 图层编辑器入口在外观页角色展示组且是动作字段() {
        let appearance = TABS.iter().find(|tab| tab.id == "appearance").unwrap();
        let section = appearance
            .sections
            .iter()
            .find(|section| section.title == "角色展示")
            .expect("外观页必须有「角色展示」组");
        let field = section
            .fields
            .iter()
            .find(|field| field.key == "action.openLayerEditor")
            .expect("「角色展示」组必须有图层编辑器入口（当前 Profile 的素材编辑入口）");
        assert!(field.kind.is_action(), "图层编辑器入口是动作，不绑定配置值");
        assert!(
            field.help.contains("独立") && field.help.contains("Profile"),
            "说明必须写明独立窗口且内容随当前 Profile 变化：{}",
            field.help
        );
        // 全局键表按同一键可查（两平台按 schema 渲染与分发，不能只在本组里存在）。
        assert_eq!(
            super::field("action.openLayerEditor").map(|item| item.kind),
            Some(FieldKind::Action)
        );
    }

    #[test]
    fn 字体字段落在外观页且字号范围与字体域一致() {
        let font_tab = TABS.iter().find(|tab| tab.id == "appearance").unwrap();
        let fields: Vec<&Field> = font_tab
            .sections
            .iter()
            .flat_map(|section| section.fields.iter())
            .collect();
        let family = fields
            .iter()
            .find(|f| f.key == "appearance.font.family")
            .unwrap();
        assert!(matches!(family.kind, FieldKind::FontFamily));
        let size = fields
            .iter()
            .find(|f| f.key == "appearance.font.size")
            .unwrap();
        match size.kind {
            FieldKind::Number { min, max, .. } => {
                assert_eq!(min, crate::ui::font::FONT_SIZE_MIN);
                assert_eq!(max, crate::ui::font::FONT_SIZE_MAX);
            }
            other => panic!("字号必须是数值控件: {other:?}"),
        }
    }
}
