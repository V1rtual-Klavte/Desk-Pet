//! 主题 token：类型词汇 + 三套预设值。
//!
//! 本文件是**主题的唯一真相源**。同名的 CSS 设计稿在
//! `docs/history/design/theme-candidates.html`，那里的 55 个自定义属性与本文件的
//! 语义槽位一一对应（映射见每个字段的注释）；改任何一处都要两边同改。
//!
//! 为什么不是「把 CSS 原样搬过来」：原生绘制没有 `box-shadow` / `border-radius` /
//! `linear-gradient` 这些复合声明，只有「一次填充 + 一圈描边 + 投影」三件套。
//! 所以这里把 CSS 的复合声明拆成原生能直接执行的原子： [`Fill`]（填充）、
//! [`Bevel`]（内立体线）、[`Elevation`]（外投影）。三套主题共用同一组槽位，
//! 换主题 = 换一张值表，不是换一套绘制代码。

use super::texture::Tex;

// ==========================================
// 颜色与填充
// ==========================================

/// 颜色：分量 0..1，`a` 为透明度。构造全是 `const fn`，供三张表在编译期求值。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    /// `0xRRGGBB`，不透明。
    pub const fn hex(v: u32) -> Self {
        Self::rgba(
            ((v >> 16) & 0xFF) as f32 / 255.0,
            ((v >> 8) & 0xFF) as f32 / 255.0,
            (v & 0xFF) as f32 / 255.0,
            1.0,
        )
    }

    pub const fn rgb(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b, a: 1.0 }
    }

    pub const fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    /// 同色换透明度（CSS 里大量 `rgba(...,.5)` 的等价写法）。
    pub const fn with_alpha(self, a: f32) -> Self {
        Self { a, ..self }
    }

    /// 黑/白线（内立体线用）。
    pub const fn white_alpha(a: f32) -> Self {
        Self::rgba(1.0, 1.0, 1.0, a)
    }

    pub const fn black_alpha(a: f32) -> Self {
        Self::rgba(0.0, 0.0, 0.0, a)
    }
}

/// 一条周期条纹（CSS `repeating-linear-gradient` 的原生等价）。
///
/// 设计稿里拉丝面板是两条纹叠加：2px 周期的白线与 7px 周期的黑线。
#[derive(Debug, Clone, Copy)]
pub struct Stripe {
    /// 周期（px）。
    pub period: f32,
    /// 线宽（px）。
    pub line: f32,
    pub color: Rgba,
}

/// 一档填充。`stops` 一律是「从上到下」的顺序（CSS 默认 180deg 的方向）。
#[derive(Debug, Clone, Copy)]
pub enum Fill {
    Solid(Rgba),
    /// 竖向线性渐变。
    Linear(&'static [(f32, Rgba)]),
    /// 径向渐变；`center` / `radius` 是相对容器的比例（CSS 的百分比写法）。
    Radial {
        cx: f32,
        cy: f32,
        rx: f32,
        ry: f32,
        stops: &'static [(f32, Rgba)],
    },
    /// 竖向线性渐变 + 细条纹（拉丝金属的底）。
    Striped {
        stops: &'static [(f32, Rgba)],
        stripes: &'static [Stripe],
    },
}

impl Fill {
    /// 取一层近似代表色（给不支持渐变的场合兜底：GDI 纯色画刷、占位块）。
    pub fn base_color(&self) -> Rgba {
        match self {
            Fill::Solid(c) => *c,
            Fill::Linear(stops) | Fill::Striped { stops, .. } => stops
                .first()
                .map(|(_, c)| *c)
                .unwrap_or(Rgba::black_alpha(1.0)),
            Fill::Radial { stops, .. } => stops
                .last()
                .map(|(_, c)| *c)
                .unwrap_or(Rgba::black_alpha(1.0)),
        }
    }
}

/// 边的侧别。`Top` / `Bottom` 受承载图层翻转影响（翻转视图 y 向下）；
/// `Left` / `Right` 两平台同向（AppKit 的翻转只镜像 y，x 始终向右）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeSide {
    Top,
    Bottom,
    Left,
    Right,
}

/// 内立体线：CSS `inset box-shadow` 的原生等价。
///
/// 原生没有 inset 阴影，做法是沿内边缘画 1px（或更宽）的线：
/// 顶亮线造「凸起」，底暗线造「凹陷」。`blur > 0` 时用一条逐渐透明的窄带近似。
///
/// 一笔 CSS 声明可以有多条 inset 阴影（同一边也能叠多条，如铬主题 `--finner` 的
/// 软压暗 + 硬白线都贴上缘；`inset 1px 1px 0` 同时出顶线与左边线）。所以这里按
/// **声明序**存成一条线表 —— 首条在 CSS 里最靠近观察者，绘制也按同一序（见各平台
/// 绘制层），`inset 0 0 0 1px` 的整圈内环用 [`BevelLine::Ring`] 表达。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Bevel {
    pub lines: &'static [BevelLine],
}

impl Bevel {
    /// 无立体线。`const` 而非 `Default` —— 三张表要在 `static` 里求值。
    pub const NONE: Self = Self { lines: &[] };
}

/// `Bevel` 里的一条线：贴某条边，或沿四边一圈的内环。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BevelLine {
    /// 贴 `side` 边的一条线。
    Edge { side: EdgeSide, line: InsetLine },
    /// 整圈内环（CSS `inset 0 0 0 1px` 一类）：四条互不重叠的边线，
    /// 竖线避开横线占住的角 —— 同一 alpha 在角上重叠会二次合成、比其余边深。
    Ring { line: InsetLine },
}

impl BevelLine {
    pub const fn top(line: InsetLine) -> Self {
        Self::Edge {
            side: EdgeSide::Top,
            line,
        }
    }

    pub const fn bottom(line: InsetLine) -> Self {
        Self::Edge {
            side: EdgeSide::Bottom,
            line,
        }
    }

    pub const fn left(line: InsetLine) -> Self {
        Self::Edge {
            side: EdgeSide::Left,
            line,
        }
    }

    pub const fn right(line: InsetLine) -> Self {
        Self::Edge {
            side: EdgeSide::Right,
            line,
        }
    }

    pub const fn ring(line: InsetLine) -> Self {
        Self::Ring { line }
    }
}

/// 一条内边缘线。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InsetLine {
    pub color: Rgba,
    /// 线宽（px）。
    pub width: f32,
    /// 模糊半径（px）。0 = 硬线；> 0 用渐变带近似软边。
    pub blur: f32,
}

impl InsetLine {
    pub const fn hard(color: Rgba, width: f32) -> Self {
        Self {
            color,
            width,
            blur: 0.0,
        }
    }

    pub const fn soft(color: Rgba, width: f32, blur: f32) -> Self {
        Self { color, width, blur }
    }
}

/// 单线绘制入口（`paint::apply_line` / `paint_win::draw_inset`）的输入：
/// 一条线（侧别由入口参数决定）或一个 [`Bevel`]（各线自带侧别与顺序）。
///
/// 两种输入并存的原因：顶栏底线、输入区上边线这类"只压一条边"的调用点在调用点
/// 构造一条 [`InsetLine`]；`--logsh` 这类一笔声明多条异色 inset 阴影的值直接传
/// 整个 [`Bevel`]。
#[derive(Debug, Clone, Copy)]
pub enum EdgeLines {
    /// 一条线；绘制入口的侧别参数生效。
    Single(InsetLine),
    /// 一叠线；绘制入口的侧别参数被忽略（各线自带侧别与顺序）。
    Stack(Bevel),
}

impl From<&InsetLine> for EdgeLines {
    fn from(line: &InsetLine) -> Self {
        Self::Single(*line)
    }
}

impl From<&Bevel> for EdgeLines {
    fn from(bevel: &Bevel) -> Self {
        Self::Stack(*bevel)
    }
}

/// 一条外投影。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shadow {
    /// 纵向偏移（px，正 = 向下）。
    pub dy: f32,
    pub blur: f32,
    /// 扩散（px，正 = 外扩）。
    pub spread: f32,
    pub color: Rgba,
}

/// 外投影栈：接触阴影（贴边、锐） + 环境阴影（远、散）。
///
/// 设计稿的教训：**不用彩色泛光**。所有主题的投影只有这两种，靠偏移与模糊区分层次。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Elevation {
    pub contact: Option<Shadow>,
    pub ambient: Option<Shadow>,
}

impl Elevation {
    pub const NONE: Self = Self {
        contact: None,
        ambient: None,
    };
}

/// 圆角三档（设计稿的 `--r1` / `--r2` / `--r3`）。
#[derive(Debug, Clone, Copy)]
pub struct Radii {
    /// 小件：标签、chip、输入框。
    pub sm: f32,
    /// 大件：气泡。
    pub md: f32,
    /// 按钮。
    pub btn: f32,
}

// ==========================================
// 主题
// ==========================================

/// 全套主题值。三套预设共用这一组槽位。
#[derive(Debug, Clone, Copy)]
pub struct Tokens {
    // ── 舞台（主窗角色底） ──
    /// `--stage-bg`：舞台背景。
    pub stage_bg: Fill,
    /// 舞台纹理层（设计稿 `#verdigris .stage` 的 `background-image:var(--verdigris),…`）。
    /// 第二笔 linear-gradient 与 `stage_bg` 同值，由填充层承担，不在这里重复。
    pub stage_tex: Option<Sheen>,
    /// 舞台是否铺细颗粒（设计稿 `.stage::before` 的 `--grain`，透明度 0.05）。
    pub stage_grain: Option<f32>,

    // ── 聊天面板 ──
    /// `--pbg`：面板底。
    pub panel_bg: Fill,
    /// `--ptex`：面板纹理层（叠在面板底之上）。
    pub panel_tex: Option<Sheen>,
    /// `--panel-grain`：面板细颗粒（设计稿 `.chat::after`，透明度 0.028）。
    pub panel_grain: Option<f32>,
    /// `--outline`：面板相邻边界的**中性**极细线（不是主题色，避免彩色描边显廉价）。
    pub outline: Rgba,
    /// `--pshadow`：面板投影。
    pub panel_shadow: Elevation,
    /// `--pedge` 侧的内立体线（设计稿 `--pshadow` 里的 `inset` 部分）。
    pub panel_bevel: Bevel,

    // ── 顶栏 ──
    /// `--bar`：顶栏底。
    pub bar_bg: Fill,
    /// `--bare`：顶栏下边线。
    pub bar_edge: Rgba,
    /// `--barsh`：顶栏内立体线。
    pub bar_bevel: Bevel,
    /// `--barsh` 里的 `var(--contact)`：顶栏外投影（设计稿五套里只有铜绿声明，
    /// 其余四套的 `--barsh` 只有 inset 线 —— 该槽位为空）。
    pub bar_shadow: Elevation,

    // ── 文字 ──
    /// `--ink`：主文字。
    pub ink: Rgba,
    /// `--dim`：次要文字。
    pub dim: Rgba,
    /// `--acc`：强调色（状态点、工具名、进度）。
    pub accent: Rgba,

    // ── 会话标签 ──
    /// `--fbg2`：标签行 / 面板叠加区 / 状态行的底。
    pub strip_bg: Rgba,
    /// `--tabon`：选中标签底。
    pub tab_on_bg: Fill,
    /// `--tabone`：选中标签描边。
    pub tab_on_edge: Rgba,
    /// `--tabonsh`：选中标签内立体线。
    pub tab_on_bevel: Bevel,
    /// `--tabonsh` 里的 `var(--contact)`：选中标签外投影（拉丝 / 铬为空）。
    pub tab_on_shadow: Elevation,
    /// 未选中标签的文字色 = `dim`。

    // ── 消息 ──
    /// `--me`：用户气泡底。
    pub bubble_user_bg: Fill,
    /// `--meink`：用户气泡文字。
    pub bubble_user_ink: Rgba,
    /// `--meedge`：用户气泡描边。
    pub bubble_user_edge: Rgba,
    /// `--mesh`：用户气泡内立体线。
    pub bubble_user_bevel: Bevel,
    /// `--me` 系列的外投影（设计稿里 `--mesh` 含 `--contact`）。
    pub bubble_user_shadow: Elevation,
    /// `--aibg`：助手气泡底（2026-10-05 与设计稿同批加的槽位；文字用 `ink`）。
    pub bubble_ai_bg: Fill,
    /// `--aiedge`：助手气泡描边。
    pub bubble_ai_edge: Rgba,

    /// `--tbg`：思考块 / 工具卡底。
    pub tool_bg: Fill,
    /// `--tedge`：思考块 / 工具卡描边。
    pub tool_edge: Rgba,
    /// `--tink`：工具卡文字。
    pub tool_ink: Rgba,
    /// `--tsh`：思考块 / 工具卡內立体线。
    pub tool_bevel: Bevel,
    /// 思考块 / 工具卡外投影（设计稿里 `--tsh` 的非 inset 部分，如拉丝的
    /// `0 1px 0 rgba(255,255,255,.08)` 白线、铜绿的 `var(--contact)`）。
    pub tool_shadow: Elevation,
    /// `--logsh`：消息流容器的内阴影（同笔声明可以含多条异色内线条，
    /// 如铬主题的上白 + 下蓝灰双线）。非 inset 的外线不在这里表达 —— 拉丝
    /// `--logsh` 的外白线在实机与设计稿里都被相邻区带盖住，刻意弃用（见 BRUSHED 注释）。
    pub log_inset: Option<Bevel>,

    // ── 按钮（`--bbg` 族） ──
    /// `--bbg`：普通按钮底。
    pub btn_bg: Fill,
    /// `--bink`：普通按钮文字。
    pub btn_ink: Rgba,
    /// `--bedge`：普通按钮描边。
    pub btn_edge: Rgba,
    /// `--bsh`：普通按钮内立体线。
    pub btn_bevel: Bevel,
    /// `--bsh` 里的 `var(--contact)`：普通按钮外投影。
    pub btn_shadow: Elevation,
    /// `--bts`：普通按钮文字投影。
    pub btn_text_shadow: Option<Shadow>,

    // ── 主按钮（`--sbg` 族：发送 / 停止 / 选中的 chip） ──
    /// `--sbg`：主按钮底。
    pub primary_bg: Fill,
    /// `--sink`：主按钮文字。
    pub primary_ink: Rgba,
    /// `--sedge`：主按钮描边。
    pub primary_edge: Rgba,
    /// `--ssh`：主按钮内立体线。
    pub primary_bevel: Bevel,
    /// `--ssh` 里的 `var(--contact)`：主按钮外投影。
    pub primary_shadow: Elevation,
    /// `--sts`：主按钮文字投影。
    pub primary_text_shadow: Option<Shadow>,

    // ── 输入区 ──
    /// `--ibg`：输入区底。
    pub input_bar_bg: Fill,
    /// `--iedge`：输入区上边线。
    pub input_bar_edge: Rgba,
    /// `--fbg`：输入框 / 待发 chip 底。
    pub field_bg: Fill,
    /// `--fedge`：输入框描边。
    pub field_edge: Rgba,
    /// `--finner`：输入框内立体线。
    pub field_bevel: Bevel,

    // ── 分隔线 ──
    /// `--grule`：分组分隔线（设置页 / 编辑器）。
    /// 与 [`Tokens::outline`] **不同义、不可互替**：`outline` 是舞台↔聊天这类相邻面板的中性分界，
    /// `rule` 是同一面板内部的分组线。
    pub rule: Rgba,

    // ── 设置窗（左竖栏 Tab / 开关） ──
    // 视觉基准 = 设计稿 `docs/history/design/theme-candidates.html` 每套主题的「设置窗」段。
    /// `--rail`：左竖栏（Tab 导航）底。
    pub rail_bg: Fill,
    /// `--raile`：竖栏与内容区的分界。
    pub rail_edge: Rgba,
    /// `--tg`：开关**关**态轨道底。
    pub switch_off_bg: Fill,
    /// `--tge`：开关关态描边。
    pub switch_off_edge: Rgba,
    /// `--tgk`：开关滑块（两态共用）。
    pub switch_knob: Fill,
    /// `--tgon`：开关**开**态轨道底。
    pub switch_on_bg: Fill,
    /// `--tgone`：开关开态描边。
    pub switch_on_edge: Rgba,

    // ── 语义状态色 ──
    // 设置页 / 编辑器需要的三档状态色，按每套主题的调性定，
    // 不引系统色（系统色会破主题）。
    /// 成功 / 完成。
    pub ok: Rgba,
    /// 警告 / 未选中的提示。
    pub warn: Rgba,
    /// 失败 / 危险操作。
    pub danger: Rgba,

    // ── 几何 ──
    pub radii: Radii,

    // ── 外观极性 ──
    /// 标准控件（设置页的下拉、滚动条、系统按钮）应采取的明暗极性。
    /// 三套主题都是固定外观，不跟随系统。
    pub dark: bool,
}

/// 面板纹理层：按顺序叠加的若干层（对应设计稿 `--ptex` 的逗号分隔多层）。
#[derive(Debug, Clone, Copy)]
pub struct Sheen(pub &'static [Layer]);

#[derive(Debug, Clone, Copy)]
pub enum Layer {
    /// 竖向线性渐变。
    Grad(&'static [(f32, Rgba)]),
    /// 周期条纹。允许把设计稿里相邻的多条 `repeating-linear-gradient` 合并成一组；
    /// 组内同样**声明序 = CSS 序，首条在最上**（绘制层按此合成）。
    Stripes(&'static [Stripe]),
    /// 噪声纹理（整块铺满）。
    Tex { tex: Tex, alpha: f32 },
    /// 单条边线（1px 起；如铬面板 `--ptex` 的「地平线」）。
    Edge {
        side: EdgeSide,
        color: Rgba,
        width: f32,
    },
}

// ==========================================
// 三套预设
// ==========================================

/// 主题标识。取值与 CONFIG `appearance.theme` 的字符串逐字一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeId {
    /// 拉丝金属：深灰面板 + 琥珀强调（暗）。
    Brushed,
    /// Y2K 铬：浅面板 + 品红强调 + 深紫舞台（明暗混搭）。
    Chrome,
    /// 铜绿：深绿面板 + 黄铜强调（暗）。
    Verdigris,
    /// 暮蓝：深紫面板 + 暮粉强调（暗）。
    Nightfall,
    /// 青花：白瓷面板 + 靛蓝强调 + 朱红主按钮（明）。
    Azurite,
}

impl ThemeId {
    pub const ALL: [ThemeId; 5] = [
        ThemeId::Brushed,
        ThemeId::Chrome,
        ThemeId::Verdigris,
        ThemeId::Nightfall,
        ThemeId::Azurite,
    ];

    /// CONFIG 字符串。非法值由读取期规则收拢为默认（见 `read_theme_id`）。
    pub const fn as_str(self) -> &'static str {
        match self {
            ThemeId::Brushed => "brushed",
            ThemeId::Chrome => "chrome",
            ThemeId::Verdigris => "verdigris",
            ThemeId::Nightfall => "nightfall",
            ThemeId::Azurite => "azurite",
        }
    }

    /// 中文显示名（设置页下拉用）。
    pub const fn label(self) -> &'static str {
        match self {
            ThemeId::Brushed => "拉丝金属",
            ThemeId::Chrome => "铬",
            ThemeId::Verdigris => "铜绿",
            ThemeId::Nightfall => "暮蓝",
            ThemeId::Azurite => "青花",
        }
    }

    /// 解析 CONFIG 字符串。未知值返回 `None`，由调用方收拢为默认（不建兼容映射）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "brushed" => Some(ThemeId::Brushed),
            "chrome" => Some(ThemeId::Chrome),
            "verdigris" => Some(ThemeId::Verdigris),
            "nightfall" => Some(ThemeId::Nightfall),
            "azurite" => Some(ThemeId::Azurite),
            _ => None,
        }
    }

    pub const fn tokens(self) -> &'static Tokens {
        match self {
            ThemeId::Brushed => &BRUSHED,
            ThemeId::Chrome => &CHROME,
            ThemeId::Verdigris => &VERDIGRIS,
            ThemeId::Nightfall => &NIGHTFALL,
            ThemeId::Azurite => &AZURITE,
        }
    }
}

impl Default for ThemeId {
    fn default() -> Self {
        ThemeId::Brushed
    }
}

/// 全局 `--contact`：贴边的接触投影（设计稿 `:root` 定义，各套主题共用）。
const CONTACT: Shadow = Shadow {
    dy: 1.0,
    blur: 2.0,
    spread: 0.0,
    color: Rgba::black_alpha(0.30),
};

/// 全局 `--ambient`：面板的环境投影（设计稿 `:root` 定义，各套主题共用）。
///
/// 与 [`CONTACT`] 一样是**全局量而非主题量** —— 设计稿把它放在 `:root`，对账
/// （`assert_elevation_matches`）也从 `:root` 解析；写在主题块里的同名变量**不会**
/// 被读到。所以这里与设计稿同口径：谁要用就引用这个常量，不要在表里另写数值。
const AMBIENT: Shadow = Shadow {
    dy: 10.0,
    blur: 24.0,
    spread: -14.0,
    color: Rgba::black_alpha(0.55),
};

// ── 拉丝金属（暗）──
// 读数来自设计稿 #brushed 块。面板是「拉丝钢板 + 倒角」，投影只有接触与环境两层。
pub static BRUSHED: Tokens = Tokens {
    stage_bg: Fill::Linear(&[(0.0, Rgba::hex(0x2D3137)), (1.0, Rgba::hex(0x1D2024))]),
    stage_tex: None,
    stage_grain: Some(0.05),

    panel_bg: Fill::Solid(Rgba::hex(0x33373D)),
    panel_tex: Some(Sheen(&[
        Layer::Stripes(&[
            Stripe {
                period: 2.0,
                line: 1.0,
                color: Rgba::white_alpha(0.05),
            },
            Stripe {
                period: 7.0,
                line: 1.0,
                color: Rgba::black_alpha(0.055),
            },
        ]),
        Layer::Grad(&[
            (0.0, Rgba::white_alpha(0.08)),
            (0.16, Rgba::white_alpha(0.0)),
            (1.0, Rgba::black_alpha(0.14)),
        ]),
    ])),
    panel_grain: Some(0.028),
    outline: Rgba::black_alpha(0.55),
    panel_shadow: Elevation {
        contact: None,
        ambient: Some(Shadow {
            dy: 10.0,
            blur: 24.0,
            spread: -14.0,
            color: Rgba::black_alpha(0.55),
        }),
    },
    // `inset 1px 1px 0 white .15`（顶 + 左亮线）、`inset -1px 0 0 black .55`（右边暗线）。
    panel_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.15), 1.0)),
            BevelLine::left(InsetLine::hard(Rgba::white_alpha(0.15), 1.0)),
            BevelLine::right(InsetLine::hard(Rgba::black_alpha(0.55), 1.0)),
        ],
    },

    bar_bg: Fill::Linear(&[
        (0.0, Rgba::hex(0x4C525A)),
        (0.48, Rgba::hex(0x3D434A)),
        (0.52, Rgba::hex(0x32373D)),
        (1.0, Rgba::hex(0x3E444B)),
    ]),
    bar_edge: Rgba::hex(0x181B1E),
    bar_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.19), 1.0)),
            BevelLine::bottom(InsetLine::hard(Rgba::black_alpha(0.5), 1.0)),
        ],
    },
    // 设计稿 `--barsh` 只有两条 inset 线，无外投影。
    bar_shadow: Elevation::NONE,

    ink: Rgba::hex(0xE7EAEE),
    dim: Rgba::hex(0x9BA3AD),
    accent: Rgba::hex(0xE8A33D),

    strip_bg: Rgba::black_alpha(0.14),
    tab_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0x565D66)), (1.0, Rgba::hex(0x42484F))]),
    tab_on_edge: Rgba::hex(0x1E2125),
    tab_on_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.18), 1.0)),
            BevelLine::bottom(InsetLine::hard(Rgba::black_alpha(0.45), 1.0)),
        ],
    },
    tab_on_shadow: Elevation::NONE,

    bubble_user_bg: Fill::Linear(&[(0.0, Rgba::hex(0x575E67)), (1.0, Rgba::hex(0x454B53))]),
    bubble_user_ink: Rgba::hex(0xF3F5F8),
    bubble_user_edge: Rgba::hex(0x24282D),
    bubble_user_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.15), 1.0)),
            BevelLine::bottom(InsetLine::hard(Rgba::black_alpha(0.38), 1.0)),
        ],
    },
    bubble_user_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    bubble_ai_bg: Fill::Linear(&[(0.0, Rgba::hex(0x3E444C)), (1.0, Rgba::hex(0x363C43))]),
    bubble_ai_edge: Rgba::hex(0x1D2126),

    tool_bg: Fill::Solid(Rgba::hex(0x24282C)),
    tool_edge: Rgba::hex(0x121416),
    tool_ink: Rgba::hex(0x9FE870),
    // `--tsh: inset 0 2px 5px black .6, 0 1px 0 white .08`：顶部压暗是内线，
    // 下方 1px 白线是**外线**（投影层表达，见 tool_shadow）。
    tool_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::black_alpha(0.6),
            2.0,
            5.0,
        ))],
    },
    tool_shadow: Elevation {
        contact: Some(Shadow {
            dy: 1.0,
            blur: 0.0,
            spread: 0.0,
            color: Rgba::white_alpha(0.08),
        }),
        ambient: None,
    },
    // `--logsh` 的第二笔 `0 1px 0 white .07` 是**外线**：在实机承载件（滚动视图 /
    // 画布）上被下一条区带盖住或裁掉，设计稿自身（`.log` 之后的 `.pstack` 上边框）
    // 同样盖住它 —— 渲染不可见，不表达（值留在设计稿里）。
    log_inset: Some(Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::black_alpha(0.45),
            2.0,
            6.0,
        ))],
    }),

    btn_bg: Fill::Linear(&[
        (0.0, Rgba::hex(0x575D65)),
        (0.48, Rgba::hex(0x474D55)),
        (0.52, Rgba::hex(0x383D44)),
        (1.0, Rgba::hex(0x434952)),
    ]),
    btn_ink: Rgba::hex(0xE0E5EB),
    btn_edge: Rgba::hex(0x1C1F23),
    btn_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.21), 1.0)),
            BevelLine::bottom(InsetLine::soft(Rgba::black_alpha(0.48), 2.0, 3.0)),
        ],
    },
    btn_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    btn_text_shadow: Some(Shadow {
        dy: -1.0,
        blur: 0.0,
        spread: 0.0,
        color: Rgba::black_alpha(0.5),
    }),

    primary_bg: Fill::Linear(&[
        (0.0, Rgba::hex(0xF7CB7E)),
        (0.46, Rgba::hex(0xE1A446)),
        (0.52, Rgba::hex(0xC1822A)),
        (1.0, Rgba::hex(0xC98C34)),
    ]),
    primary_ink: Rgba::hex(0x2E1E06),
    primary_edge: Rgba::hex(0x8A5816),
    primary_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.6), 1.0)),
            BevelLine::bottom(InsetLine::soft(
                Rgba::rgba(90.0 / 255.0, 50.0 / 255.0, 0.0, 0.42),
                2.0,
                4.0,
            )),
        ],
    },
    primary_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    primary_text_shadow: Some(Shadow {
        dy: 1.0,
        blur: 0.0,
        spread: 0.0,
        color: Rgba::white_alpha(0.35),
    }),

    input_bar_bg: Fill::Linear(&[(0.0, Rgba::hex(0x3D4249)), (1.0, Rgba::hex(0x2E3238))]),
    input_bar_edge: Rgba::hex(0x14171A),
    field_bg: Fill::Solid(Rgba::hex(0x212427)),
    field_edge: Rgba::hex(0x101214),
    field_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::black_alpha(0.65),
            2.0,
            5.0,
        ))],
    },

    rule: Rgba::hex(0x22262A),

    rail_bg: Fill::Linear(&[(0.0, Rgba::hex(0x3A3F45)), (1.0, Rgba::hex(0x2F3439))]),
    rail_edge: Rgba::hex(0x181B1E),
    switch_off_bg: Fill::Solid(Rgba::hex(0x232629)),
    switch_off_edge: Rgba::hex(0x111315),
    switch_knob: Fill::Linear(&[(0.0, Rgba::hex(0xE4E9EE)), (1.0, Rgba::hex(0xA8B0B9))]),
    switch_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0xF0B95E)), (1.0, Rgba::hex(0xC9872C))]),
    switch_on_edge: Rgba::hex(0x8A5816),

    ok: Rgba::hex(0x8FCB6A),
    warn: Rgba::hex(0xE8A33D),
    danger: Rgba::hex(0xE0705F),

    radii: Radii {
        sm: 4.0,
        md: 6.0,
        btn: 5.0,
    },
    dark: true,
};

// ── Y2K 铬（明暗混搭：浅面板压在深紫舞台上） ──
pub static CHROME: Tokens = Tokens {
    stage_bg: Fill::Radial {
        cx: 0.18,
        cy: 0.08,
        rx: 1.30,
        ry: 1.20,
        stops: &[
            (0.0, Rgba::hex(0x33236F)),
            (0.66, Rgba::hex(0x150F33)),
            (1.0, Rgba::hex(0x0C0920)),
        ],
    },
    stage_tex: None,
    stage_grain: Some(0.05),

    panel_bg: Fill::Solid(Rgba::hex(0xAEBBC8)),
    // 柱面铬：10 档竖直明暗交替，是「圆柱反光」的关键，不能用两档渐变糊过去。
    panel_tex: Some(Sheen(&[
        Layer::Grad(&[
            (0.00, Rgba::hex(0xECF3F9)),
            (0.13, Rgba::hex(0xC0CCD9)),
            (0.26, Rgba::hex(0x8B9AA9)),
            (0.39, Rgba::hex(0xE8F0F7)),
            (0.51, Rgba::hex(0x9EADBC)),
            (0.54, Rgba::hex(0x7B8A99)),
            (0.66, Rgba::hex(0xB7C5D2)),
            (0.78, Rgba::hex(0xDEE8F0)),
            (0.90, Rgba::hex(0x93A2B1)),
            (1.00, Rgba::hex(0xC6D2DE)),
        ]),
        // 第二层是「地平线」：`linear-gradient(0deg,…)` 的起点在**底边**。
        // 注意按 CSS 多背景序它在柱面渐变**之下**（首层在上），而柱面全部不透明 ——
        // 设计稿自身渲染时这条线同样被盖住；本 token 忠实保留声明，不擅自提层。
        Layer::Edge {
            side: EdgeSide::Bottom,
            color: Rgba::white_alpha(0.6),
            width: 1.0,
        },
    ])),
    panel_grain: Some(0.028),
    outline: Rgba::rgba(44.0 / 255.0, 58.0 / 255.0, 78.0 / 255.0, 0.34),
    panel_shadow: Elevation {
        contact: None,
        ambient: Some(Shadow {
            dy: 10.0,
            blur: 24.0,
            spread: -14.0,
            color: Rgba::black_alpha(0.55),
        }),
    },
    // `--pshadow`：top/left `inset 1px 1px 0 white .95`、bottom/right
    // `inset -2px -2px 3px rgba(70,90,120,.45)`、整圈 `inset 0 0 0 1px white .55`。
    panel_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.95), 1.0)),
            BevelLine::left(InsetLine::hard(Rgba::white_alpha(0.95), 1.0)),
            BevelLine::bottom(InsetLine::soft(
                Rgba::rgba(70.0 / 255.0, 90.0 / 255.0, 120.0 / 255.0, 0.45),
                2.0,
                3.0,
            )),
            BevelLine::right(InsetLine::soft(
                Rgba::rgba(70.0 / 255.0, 90.0 / 255.0, 120.0 / 255.0, 0.45),
                2.0,
                3.0,
            )),
            BevelLine::ring(InsetLine::hard(Rgba::white_alpha(0.55), 1.0)),
        ],
    },

    bar_bg: Fill::Linear(&[
        (0.00, Rgba::hex(0xF8FBFE)),
        (0.44, Rgba::hex(0xD4DEE8)),
        (0.52, Rgba::hex(0xA9BACB)),
        (1.00, Rgba::hex(0xCAD7E3)),
    ]),
    bar_edge: Rgba::hex(0xF0F6FB),
    bar_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.95), 1.0)),
            BevelLine::bottom(InsetLine::hard(
                Rgba::rgba(90.0 / 255.0, 110.0 / 255.0, 140.0 / 255.0, 0.42),
                1.0,
            )),
        ],
    },
    // 设计稿 `--barsh` 只有两条 inset 线，无外投影。
    bar_shadow: Elevation::NONE,

    ink: Rgba::hex(0x151A2A),
    dim: Rgba::hex(0x4A5670),
    accent: Rgba::hex(0xFF3D97),

    strip_bg: Rgba::white_alpha(0.22),
    tab_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xCAD7E3))]),
    tab_on_edge: Rgba::hex(0xF4FAFE),
    tab_on_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(1.0), 1.0)),
            BevelLine::bottom(InsetLine::hard(
                Rgba::rgba(80.0 / 255.0, 100.0 / 255.0, 130.0 / 255.0, 0.35),
                1.0,
            )),
        ],
    },
    tab_on_shadow: Elevation::NONE,

    bubble_user_bg: Fill::Linear(&[
        (0.00, Rgba::hex(0x9BE8FF)),
        (0.48, Rgba::hex(0x54B8EE)),
        (0.52, Rgba::hex(0x2E8ED6)),
        (1.00, Rgba::hex(0x3FA0E0)),
    ]),
    bubble_user_ink: Rgba::hex(0x062139),
    bubble_user_edge: Rgba::hex(0xE8F6FF),
    bubble_user_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.8), 1.0)),
            BevelLine::bottom(InsetLine::hard(
                Rgba::rgba(20.0 / 255.0, 80.0 / 255.0, 140.0 / 255.0, 0.35),
                1.0,
            )),
        ],
    },
    bubble_user_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    bubble_ai_bg: Fill::Linear(&[(0.0, Rgba::hex(0xF2F7FB)), (1.0, Rgba::hex(0xDEE8F1))]),
    bubble_ai_edge: Rgba::hex(0xFBFDFF),

    tool_bg: Fill::Linear(&[
        (0.0, Rgba::white_alpha(0.62)),
        (
            1.0,
            Rgba::rgba(216.0 / 255.0, 229.0 / 255.0, 242.0 / 255.0, 0.52),
        ),
    ]),
    tool_edge: Rgba::rgba(255.0 / 255.0, 255.0 / 255.0, 255.0 / 255.0, 0.9),
    tool_ink: Rgba::hex(0x33405C),
    // `--tsh: inset 0 1px 0 #fff, inset 0 -1px 0 rgba(80,100,130,.25)`：两条硬线。
    tool_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(1.0), 1.0)),
            BevelLine::bottom(InsetLine::hard(
                Rgba::rgba(80.0 / 255.0, 100.0 / 255.0, 130.0 / 255.0, 0.25),
                1.0,
            )),
        ],
    },
    tool_shadow: Elevation::NONE,
    // `--logsh`：上白（软）+ 下蓝灰（软）双线，不是单条黑线。
    log_inset: Some(Bevel {
        lines: &[
            BevelLine::top(InsetLine::soft(Rgba::white_alpha(0.5), 1.0, 2.0)),
            BevelLine::bottom(InsetLine::soft(
                Rgba::rgba(60.0 / 255.0, 80.0 / 255.0, 110.0 / 255.0, 0.32),
                1.0,
                3.0,
            )),
        ],
    }),

    btn_bg: Fill::Linear(&[
        (0.00, Rgba::hex(0xFFFFFF)),
        (0.46, Rgba::hex(0xDEE9F3)),
        (0.52, Rgba::hex(0xADBECE)),
        (1.00, Rgba::hex(0xC8D6E2)),
    ]),
    btn_ink: Rgba::hex(0x1A2233),
    btn_edge: Rgba::hex(0xEFF6FB),
    btn_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(1.0), 1.0)),
            BevelLine::bottom(InsetLine::soft(
                Rgba::rgba(70.0 / 255.0, 90.0 / 255.0, 120.0 / 255.0, 0.42),
                2.0,
                3.0,
            )),
        ],
    },
    btn_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    btn_text_shadow: Some(Shadow {
        dy: 1.0,
        blur: 0.0,
        spread: 0.0,
        color: Rgba::white_alpha(0.8),
    }),

    primary_bg: Fill::Linear(&[
        (0.00, Rgba::hex(0xFFC6E4)),
        (0.44, Rgba::hex(0xFF74B7)),
        (0.54, Rgba::hex(0xE8177E)),
        (1.00, Rgba::hex(0xC4106A)),
    ]),
    primary_ink: Rgba::hex(0xFFFFFF),
    primary_edge: Rgba::hex(0xFFE3F2),
    primary_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.7), 1.0)),
            BevelLine::bottom(InsetLine::soft(
                Rgba::rgba(140.0 / 255.0, 0.0, 70.0 / 255.0, 0.45),
                2.0,
                4.0,
            )),
        ],
    },
    primary_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    primary_text_shadow: Some(Shadow {
        dy: -1.0,
        blur: 0.0,
        spread: 0.0,
        color: Rgba::rgba(140.0 / 255.0, 0.0, 70.0 / 255.0, 0.55),
    }),

    input_bar_bg: Fill::Linear(&[(0.0, Rgba::hex(0xC7D4E0)), (1.0, Rgba::hex(0xA7B6C5))]),
    input_bar_edge: Rgba::hex(0x8C9DAE),
    field_bg: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xE7EFF7))]),
    field_edge: Rgba::hex(0xF2F8FD),
    // `--finner`：软压暗 + 硬白线**都贴上缘**（此前白 .9 硬线被错放在底边）。
    field_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::soft(
                Rgba::rgba(40.0 / 255.0, 60.0 / 255.0, 100.0 / 255.0, 0.26),
                1.0,
                2.0,
            )),
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.9), 1.0)),
        ],
    },

    rule: Rgba::rgba(60.0 / 255.0, 80.0 / 255.0, 110.0 / 255.0, 0.35),

    rail_bg: Fill::Linear(&[(0.0, Rgba::hex(0xD3DEE9)), (1.0, Rgba::hex(0xAEBDCB))]),
    rail_edge: Rgba::hex(0xF0F6FB),
    switch_off_bg: Fill::Linear(&[(0.0, Rgba::hex(0xB7C4D1)), (1.0, Rgba::hex(0x9CACBC))]),
    switch_off_edge: Rgba::hex(0xF0F6FB),
    switch_knob: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xC4D1DD))]),
    switch_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0xFF9CCB)), (1.0, Rgba::hex(0xE8177E))]),
    switch_on_edge: Rgba::hex(0xFFE3F2),

    ok: Rgba::hex(0x1E9E6A),
    warn: Rgba::hex(0xC97A0E),
    danger: Rgba::hex(0xD01F4A),

    radii: Radii {
        sm: 8.0,
        md: 13.0,
        btn: 9.0,
    },
    dark: false,
};

// ── 铜绿（暗） ──
pub static VERDIGRIS: Tokens = Tokens {
    stage_bg: Fill::Linear(&[(0.0, Rgba::hex(0x24413A)), (1.0, Rgba::hex(0x162924))]),
    // `#verdigris .stage{background-image:var(--verdigris),…;background-size:cover}`
    // 的氧化斑块；第二笔渐变与 `stage_bg` 同值（设计稿的 `#16292 4` 是笔误，见报告）。
    stage_tex: Some(Sheen(&[Layer::Tex {
        tex: Tex::Verdigris,
        alpha: 1.0,
    }])),
    stage_grain: Some(0.05),

    panel_bg: Fill::Solid(Rgba::hex(0x1E3630)),
    // 铜绿斑块：低频噪声整块铺满（不平铺，避免重复感），上叠一层竖向明暗。
    panel_tex: Some(Sheen(&[
        Layer::Tex {
            tex: Tex::Verdigris,
            alpha: 1.0,
        },
        Layer::Grad(&[
            (0.0, Rgba::white_alpha(0.05)),
            (1.0, Rgba::black_alpha(0.16)),
        ]),
    ])),
    // `.chat::after` 的细颗粒对所有主题一视同仁（0.028），此前铜绿被误关。
    panel_grain: Some(0.028),
    outline: Rgba::black_alpha(0.48),
    panel_shadow: Elevation {
        contact: Some(Shadow {
            dy: 1.0,
            blur: 2.0,
            spread: 0.0,
            color: Rgba::black_alpha(0.30),
        }),
        ambient: Some(Shadow {
            dy: 10.0,
            blur: 24.0,
            spread: -14.0,
            color: Rgba::black_alpha(0.55),
        }),
    },
    panel_bevel: Bevel::NONE,

    bar_bg: Fill::Linear(&[(0.0, Rgba::hex(0x26443B)), (1.0, Rgba::hex(0x1D352E))]),
    bar_edge: Rgba::hex(0x0D1A15),
    // 设计稿 `--barsh` 的第二笔是 `var(--contact)`（唯一一套带顶栏外投影的主题）。
    bar_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::rgba(220.0 / 255.0, 1.0, 240.0 / 255.0, 0.08),
            1.0,
        ))],
    },
    bar_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },

    ink: Rgba::hex(0xDCEBE4),
    dim: Rgba::hex(0x7FA394),
    accent: Rgba::hex(0xC8A15C),

    strip_bg: Rgba::white_alpha(0.03),
    tab_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0x2A463E)), (1.0, Rgba::hex(0x1F3830))]),
    tab_on_edge: Rgba::hex(0x0D1713),
    // 设计稿该主题的 `--tabonsh` 只有接触阴影（`var(--contact)`），内立体线为空。
    tab_on_bevel: Bevel::NONE,
    tab_on_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },

    bubble_user_bg: Fill::Linear(&[(0.0, Rgba::hex(0x2A4A41)), (1.0, Rgba::hex(0x203A33))]),
    bubble_user_ink: Rgba::hex(0xEAF5EF),
    bubble_user_edge: Rgba::hex(0x12241E),
    bubble_user_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::white_alpha(0.10),
            1.0,
        ))],
    },
    bubble_user_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    bubble_ai_bg: Fill::Linear(&[(0.0, Rgba::hex(0x2C4C42)), (1.0, Rgba::hex(0x244139))]),
    bubble_ai_edge: Rgba::hex(0x10211B),

    tool_bg: Fill::Solid(Rgba::hex(0x101F1A)),
    tool_edge: Rgba::hex(0x08110D),
    tool_ink: Rgba::hex(0xC8A15C),
    // `--tsh: var(--contact)`：工具卡只有接触投影，没有内立体线
    // （此前误把 `--logsh` 的软压暗抄到了 tool_bevel.top）。
    tool_bevel: Bevel::NONE,
    tool_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    log_inset: Some(Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::black_alpha(0.16),
            1.0,
            3.0,
        ))],
    }),

    btn_bg: Fill::Linear(&[(0.0, Rgba::hex(0x26443B)), (1.0, Rgba::hex(0x1D352E))]),
    btn_ink: Rgba::hex(0xDEEDE6),
    btn_edge: Rgba::hex(0x0D1A15),
    btn_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::rgba(220.0 / 255.0, 1.0, 240.0 / 255.0, 0.08),
            1.0,
        ))],
    },
    btn_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    btn_text_shadow: None,

    primary_bg: Fill::Linear(&[(0.0, Rgba::hex(0xC09A50)), (1.0, Rgba::hex(0x8E6C2C))]),
    primary_ink: Rgba::hex(0x2A1E06),
    primary_edge: Rgba::hex(0x5E4715),
    primary_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::rgba(1.0, 245.0 / 255.0, 215.0 / 255.0, 0.35),
            1.0,
        ))],
    },
    primary_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    primary_text_shadow: None,

    input_bar_bg: Fill::Linear(&[(0.0, Rgba::hex(0x223D35)), (1.0, Rgba::hex(0x1A302A))]),
    input_bar_edge: Rgba::hex(0x0A120F),
    field_bg: Fill::Solid(Rgba::hex(0x070D0B)),
    field_edge: Rgba::hex(0x08110D),
    field_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::black_alpha(0.55),
            2.0,
            5.0,
        ))],
    },

    rule: Rgba::hex(0x101F1A),

    rail_bg: Fill::Linear(&[(0.0, Rgba::hex(0x213B33)), (1.0, Rgba::hex(0x182D27))]),
    rail_edge: Rgba::hex(0x0C1512),
    switch_off_bg: Fill::Solid(Rgba::hex(0x070D0B)),
    switch_off_edge: Rgba::hex(0x08110D),
    switch_knob: Fill::Solid(Rgba::hex(0xDEEDE6)),
    switch_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0xC09A50)), (1.0, Rgba::hex(0x8E6C2C))]),
    switch_on_edge: Rgba::hex(0x5E4715),

    ok: Rgba::hex(0x7FB58C),
    warn: Rgba::hex(0xC8A15C),
    danger: Rgba::hex(0xC97A63),

    radii: Radii {
        sm: 4.0,
        md: 7.0,
        btn: 5.0,
    },
    dark: true,
};

// ── 暮蓝（暗）──
// 读数来自设计稿 #nightfall 块。蓝紫偏暖、低对比、大圆角，**没有硬边** ——
// 面板靠色阶分层而不是靠描边，所以 `--pshadow` 只有一条顶亮线 + 全局环境投影。
// 那点暮粉（`--acc`）来自立绘里发梢的高光，整套主题只允许它和主按钮亮起来。
pub static NIGHTFALL: Tokens = Tokens {
    stage_bg: Fill::Radial {
        cx: 0.30,
        cy: 0.0,
        rx: 1.26,
        ry: 1.08,
        stops: &[
            (0.0, Rgba::hex(0x40386E)),
            (0.52, Rgba::hex(0x232046)),
            (1.0, Rgba::hex(0x12112A)),
        ],
    },
    stage_tex: None,
    stage_grain: Some(0.05),

    panel_bg: Fill::Solid(Rgba::hex(0x232145)),
    // 两层：先一层紫白高光转暗的竖向渐变，再一层极淡的 74deg 斜纹。
    // 设计稿这一层原写 166deg，而原生 `Layer::Grad` 只表达竖向渐变 —— 已把设计稿
    // 统一成 180deg，两边同值，不做「设计稿一个角度、原生另一个角度」的假还原。
    panel_tex: Some(Sheen(&[
        Layer::Grad(&[
            (
                0.0,
                Rgba::rgba(219.0 / 255.0, 208.0 / 255.0, 255.0 / 255.0, 0.085),
            ),
            (
                0.42,
                Rgba::rgba(219.0 / 255.0, 208.0 / 255.0, 255.0 / 255.0, 0.0),
            ),
            (1.0, Rgba::black_alpha(0.22)),
        ]),
        Layer::Stripes(&[Stripe {
            period: 5.0,
            line: 1.0,
            color: Rgba::rgba(219.0 / 255.0, 208.0 / 255.0, 255.0 / 255.0, 0.02),
        }]),
    ])),
    panel_grain: Some(0.028),
    outline: Rgba::rgba(9.0 / 255.0, 8.0 / 255.0, 22.0 / 255.0, 0.6),
    panel_shadow: Elevation {
        contact: None,
        ambient: Some(AMBIENT),
    },
    panel_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::rgba(226.0 / 255.0, 216.0 / 255.0, 255.0 / 255.0, 0.10),
            1.0,
        ))],
    },

    bar_bg: Fill::Linear(&[(0.0, Rgba::hex(0x2B2757)), (1.0, Rgba::hex(0x221F46))]),
    bar_edge: Rgba::hex(0x100F26),
    bar_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::rgba(226.0 / 255.0, 216.0 / 255.0, 255.0 / 255.0, 0.11),
            1.0,
        ))],
    },
    // 设计稿 `--barsh` 只有一条 inset 线，无外投影。
    bar_shadow: Elevation::NONE,

    ink: Rgba::hex(0xE6E2F7),
    dim: Rgba::hex(0x948FBE),
    accent: Rgba::hex(0xE0709C),

    strip_bg: Rgba::rgba(226.0 / 255.0, 216.0 / 255.0, 255.0 / 255.0, 0.04),
    tab_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0x352F6B)), (1.0, Rgba::hex(0x2A2658))]),
    tab_on_edge: Rgba::hex(0x191640),
    tab_on_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::rgba(230.0 / 255.0, 220.0 / 255.0, 255.0 / 255.0, 0.13),
            1.0,
        ))],
    },
    tab_on_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },

    bubble_user_bg: Fill::Linear(&[(0.0, Rgba::hex(0x3A3470)), (1.0, Rgba::hex(0x2E2A5C))]),
    bubble_user_ink: Rgba::hex(0xF3EEFF),
    bubble_user_edge: Rgba::hex(0x1A1740),
    bubble_user_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::rgba(230.0 / 255.0, 220.0 / 255.0, 255.0 / 255.0, 0.12),
            1.0,
        ))],
    },
    bubble_user_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    bubble_ai_bg: Fill::Linear(&[(0.0, Rgba::hex(0x2A2751)), (1.0, Rgba::hex(0x252248))]),
    bubble_ai_edge: Rgba::hex(0x191640),

    tool_bg: Fill::Solid(Rgba::hex(0x181635)),
    tool_edge: Rgba::hex(0x0E0C24),
    tool_ink: Rgba::hex(0xC0A9DC),
    tool_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::rgba(10.0 / 255.0, 6.0 / 255.0, 30.0 / 255.0, 0.4),
            1.0,
            4.0,
        ))],
    },
    tool_shadow: Elevation::NONE,
    log_inset: Some(Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::rgba(10.0 / 255.0, 6.0 / 255.0, 30.0 / 255.0, 0.36),
            2.0,
            10.0,
        ))],
    }),

    btn_bg: Fill::Linear(&[(0.0, Rgba::hex(0x322D64)), (1.0, Rgba::hex(0x262250))]),
    btn_ink: Rgba::hex(0xE6E2F7),
    btn_edge: Rgba::hex(0x161334),
    btn_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(
            Rgba::rgba(226.0 / 255.0, 216.0 / 255.0, 255.0 / 255.0, 0.12),
            1.0,
        ))],
    },
    btn_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    btn_text_shadow: None,

    primary_bg: Fill::Linear(&[(0.0, Rgba::hex(0xF095B7)), (1.0, Rgba::hex(0xC25380))]),
    primary_ink: Rgba::hex(0x2E0A1C),
    primary_edge: Rgba::hex(0x8E3A5C),
    primary_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.45), 1.0))],
    },
    primary_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    primary_text_shadow: None,

    input_bar_bg: Fill::Linear(&[(0.0, Rgba::hex(0x282550)), (1.0, Rgba::hex(0x1E1B3E))]),
    input_bar_edge: Rgba::hex(0x131029),
    field_bg: Fill::Solid(Rgba::hex(0x171530)),
    field_edge: Rgba::hex(0x100E26),
    field_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::rgba(10.0 / 255.0, 6.0 / 255.0, 30.0 / 255.0, 0.5),
            2.0,
            6.0,
        ))],
    },

    rule: Rgba::hex(0x302C5C),

    rail_bg: Fill::Linear(&[(0.0, Rgba::hex(0x2A2754)), (1.0, Rgba::hex(0x211E46))]),
    rail_edge: Rgba::hex(0x12112A),
    switch_off_bg: Fill::Solid(Rgba::hex(0x171530)),
    switch_off_edge: Rgba::hex(0x100E26),
    switch_knob: Fill::Linear(&[(0.0, Rgba::hex(0xE6E2F7)), (1.0, Rgba::hex(0x9C96C8))]),
    switch_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0xF095B7)), (1.0, Rgba::hex(0xC25380))]),
    switch_on_edge: Rgba::hex(0x8E3A5C),

    ok: Rgba::hex(0x8CD3A6),
    warn: Rgba::hex(0xE9B45E),
    danger: Rgba::hex(0xE2655C),

    radii: Radii {
        sm: 10.0,
        md: 16.0,
        btn: 12.0,
    },
    dark: true,
};

// ── 青花（明）──
// 读数来自设计稿 #azurite 块。白瓷釉面 + 靛蓝，**全局只有一处红**（主按钮 = 需要
// 用户拍板的动作）；面板边界靠一圈极细白描边 + 靛色极细线，不靠投影堆厚度，
// 所以 `--pshadow` 只有一条内环 + 全局环境投影。
//
// 2026-10-05 加浓（用户反馈「不够青花」）：初版把结构色全压在白附近，实机看下来
// 只是一片发白的浅色主题，读不出「青花」。这次按**钴蓝要够浓、白瓷要够净**重取：
// 顶栏与设置竖栏改成明显的钴蓝淡染（不再是近白）、分界线拉到看得见的蓝、主色收到
// 更正的钴蓝、正文墨色加深。**朱红主按钮不动** —— 那一笔红是青花的魂，动了就不是
// 青花了。改值必须与设计稿同改（编译期逐字对账会拦）。
pub static AZURITE: Tokens = Tokens {
    stage_bg: Fill::Radial {
        cx: 0.70,
        cy: 0.08,
        rx: 1.24,
        ry: 1.04,
        stops: &[
            (0.0, Rgba::hex(0xF3F8FE)),
            (0.58, Rgba::hex(0xDFE9F8)),
            (1.0, Rgba::hex(0xC8D8EF)),
        ],
    },
    stage_tex: None,
    stage_grain: Some(0.05),

    panel_bg: Fill::Solid(Rgba::hex(0xF5F9FE)),
    // 第二层是**釉面高光**：设计稿写成 `linear-gradient(180deg, 白 .95 0 1px, transparent 1px)`，
    // 对账的分类器靠 `transparent 1px` 认出它是「边线」，与这里的 `Layer::Edge` 对上。
    panel_tex: Some(Sheen(&[
        Layer::Grad(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xE8F1FC))]),
        Layer::Edge {
            side: EdgeSide::Top,
            color: Rgba::white_alpha(0.95),
            width: 1.0,
        },
    ])),
    panel_grain: Some(0.028),
    outline: Rgba::rgba(31.0 / 255.0, 79.0 / 255.0, 168.0 / 255.0, 0.42),
    panel_shadow: Elevation {
        contact: None,
        ambient: Some(AMBIENT),
    },
    panel_bevel: Bevel {
        lines: &[BevelLine::ring(InsetLine::hard(
            Rgba::white_alpha(0.95),
            1.0,
        ))],
    },

    bar_bg: Fill::Linear(&[(0.0, Rgba::hex(0xE9F1FD)), (1.0, Rgba::hex(0xCFE0F6))]),
    bar_edge: Rgba::hex(0xA8C0E0),
    bar_bevel: Bevel {
        lines: &[
            BevelLine::top(InsetLine::hard(Rgba::hex(0xFFFFFF), 1.0)),
            BevelLine::bottom(InsetLine::hard(
                Rgba::rgba(31.0 / 255.0, 79.0 / 255.0, 168.0 / 255.0, 0.22),
                1.0,
            )),
        ],
    },
    // 设计稿 `--barsh` 只有两条 inset 线，无外投影。
    bar_shadow: Elevation::NONE,

    ink: Rgba::hex(0x0E2450),
    dim: Rgba::hex(0x4A5F85),
    accent: Rgba::hex(0x1F4FA8),

    strip_bg: Rgba::rgba(31.0 / 255.0, 79.0 / 255.0, 168.0 / 255.0, 0.07),
    tab_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xC9DAF3))]),
    tab_on_edge: Rgba::hex(0xA4BCE0),
    tab_on_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(Rgba::hex(0xFFFFFF), 1.0))],
    },
    tab_on_shadow: Elevation::NONE,

    bubble_user_bg: Fill::Linear(&[(0.0, Rgba::hex(0xD3E3F9)), (1.0, Rgba::hex(0xB4CBEE))]),
    bubble_user_ink: Rgba::hex(0x0A1E45),
    bubble_user_edge: Rgba::hex(0x9BB8DF),
    bubble_user_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.85), 1.0))],
    },
    bubble_user_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    bubble_ai_bg: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xE7F0FB))]),
    bubble_ai_edge: Rgba::hex(0xC3D4EC),

    tool_bg: Fill::Solid(Rgba::hex(0xDCE8F9)),
    tool_edge: Rgba::hex(0xB4C8E6),
    tool_ink: Rgba::hex(0x1B3F7E),
    tool_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.9), 1.0))],
    },
    tool_shadow: Elevation::NONE,
    log_inset: Some(Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::rgba(31.0 / 255.0, 79.0 / 255.0, 168.0 / 255.0, 0.12),
            2.0,
            8.0,
        ))],
    }),

    btn_bg: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xD3E1F6))]),
    btn_ink: Rgba::hex(0x102A4D),
    btn_edge: Rgba::hex(0xAEC3E2),
    btn_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(Rgba::hex(0xFFFFFF), 1.0))],
    },
    btn_shadow: Elevation {
        contact: Some(CONTACT),
        ambient: None,
    },
    btn_text_shadow: Some(Shadow {
        dy: 1.0,
        blur: 0.0,
        spread: 0.0,
        color: Rgba::white_alpha(0.9),
    }),

    primary_bg: Fill::Linear(&[(0.0, Rgba::hex(0xDE5744)), (1.0, Rgba::hex(0xB3311F))]),
    primary_ink: Rgba::hex(0xFFF6F2),
    primary_edge: Rgba::hex(0x8E2415),
    primary_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.45), 1.0))],
    },
    // `--ssh` 的裸外投影（朱红侧的接触阴影）独占 contact 槽，不引用全局 `--contact`。
    primary_shadow: Elevation {
        contact: Some(Shadow {
            dy: 1.0,
            blur: 2.0,
            spread: 0.0,
            color: Rgba::rgba(120.0 / 255.0, 35.0 / 255.0, 20.0 / 255.0, 0.3),
        }),
        ambient: None,
    },
    primary_text_shadow: Some(Shadow {
        dy: -1.0,
        blur: 0.0,
        spread: 0.0,
        color: Rgba::rgba(90.0 / 255.0, 20.0 / 255.0, 10.0 / 255.0, 0.35),
    }),

    input_bar_bg: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xDEE9F8))]),
    input_bar_edge: Rgba::hex(0xB4C8E6),
    field_bg: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xEEF4FC))]),
    field_edge: Rgba::hex(0xC3D4EC),
    field_bevel: Bevel {
        lines: &[BevelLine::top(InsetLine::soft(
            Rgba::rgba(31.0 / 255.0, 79.0 / 255.0, 168.0 / 255.0, 0.16),
            1.0,
            3.0,
        ))],
    },

    rule: Rgba::hex(0xC3D4EC),

    rail_bg: Fill::Linear(&[(0.0, Rgba::hex(0xE4EEFC)), (1.0, Rgba::hex(0xCDDFF6))]),
    rail_edge: Rgba::hex(0xA8C0E0),
    switch_off_bg: Fill::Linear(&[(0.0, Rgba::hex(0xE1ECFB)), (1.0, Rgba::hex(0xCBDCF3))]),
    switch_off_edge: Rgba::hex(0xA8C0E0),
    switch_knob: Fill::Linear(&[(0.0, Rgba::hex(0xFFFFFF)), (1.0, Rgba::hex(0xC2D2E8))]),
    switch_on_bg: Fill::Linear(&[(0.0, Rgba::hex(0x2E63BC)), (1.0, Rgba::hex(0x1F4FA8))]),
    switch_on_edge: Rgba::hex(0x17397A),

    ok: Rgba::hex(0x2F7D5E),
    warn: Rgba::hex(0xA8761C),
    danger: Rgba::hex(0xB3311F),

    radii: Radii {
        sm: 5.0,
        md: 8.0,
        btn: 6.0,
    },
    dark: false,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// 视觉基准 = 设计稿 `docs/history/design/theme-candidates.html`（根 AGENTS.md：改色改纹理要两处同改）。
    /// 这条把设计稿**真的读进来**做逐字比对，不是把同一份数字抄两遍。
    ///
    /// 为什么必须有：本批曾经凭「设计稿没有设置页」的错误判断删掉了整组开关槽位 ——
    /// 编译照过、测试照绿，只有真人比对设计稿才会发现。有了这条，漏一个或改一边就会红。
    ///
    /// 代价：设计稿成了**编译期依赖**，动它的主题变量块要同步本文件（这正是想要的约束）；
    /// 若设计稿被归档改名，这里会直接编译失败，提醒改基准。
    const DESIGN_DOC: &str = include_str!("../../../../../docs/history/design/theme-candidates.html");

    /// 取设计稿里某套主题变量块内某个 CSS 变量的原始值。
    ///
    /// 锚点是变量块的完整选择器串（三套主题各一行，且各自唯一）——
    /// 设计稿改了这几行的写法，这里会**报错而不是静默取空**。
    fn design_var(theme: &str, var: &str) -> String {
        let anchor = format!("#{theme} .rig,#{theme} .set,#{theme} .samples{{");
        let at = DESIGN_DOC
            .find(&anchor)
            .unwrap_or_else(|| panic!("设计稿里找不到 {theme} 的变量块锚点：{anchor}"));
        let rest = &DESIGN_DOC[at + anchor.len()..];
        let end = rest.find('}').expect("变量块应以 } 结束");
        let block = &rest[..end];

        // 带冒号匹配：`--rail:` 不会误命中 `--raile:`，`--tg:` 不会误命中 `--tgon:`。
        let key = format!("{var}:");
        let at = block
            .find(&key)
            .unwrap_or_else(|| panic!("设计稿 {theme} 的变量块里没有 {var}"));
        let tail = &block[at + key.len()..];
        let stop = tail.find(';').unwrap_or(tail.len());
        tail[..stop].trim().to_string()
    }

    /// 从一段 CSS 值里取出全部 `#RRGGBB`（`#181B1E`、`linear-gradient(#A,#B)` 同口径）。
    fn css_hexes(value: &str) -> Vec<u32> {
        let bytes = value.as_bytes();
        let mut out = Vec::new();
        for i in 0..bytes.len() {
            if bytes[i] != b'#' {
                continue;
            }
            // 颜色字面量全是 ASCII，按字节切不会切到多字节字符中间。
            let Some(hex) = value.get(i + 1..i + 7) else {
                continue;
            };
            if hex.chars().all(|c| c.is_ascii_hexdigit()) {
                out.push(u32::from_str_radix(hex, 16).expect("6 位十六进制"));
            }
        }
        out
    }

    /// `Rgba` → `0xRRGGBB`（与 [`Rgba::hex`] 互逆，用于和设计稿比对）。
    fn rgba_hex(c: Rgba) -> u32 {
        let q = |v: f32| ((v.clamp(0.0, 1.0) * 255.0).round() as u32) & 0xFF;
        (q(c.r) << 16) | (q(c.g) << 8) | q(c.b)
    }

    /// 填充的代表色序列：实色 1 个、渐变/条纹/径向按档位顺序全部取出。
    fn fill_hexes(fill: &Fill) -> Vec<u32> {
        match fill {
            Fill::Solid(c) => vec![rgba_hex(*c)],
            Fill::Linear(stops) | Fill::Striped { stops, .. } => {
                stops.iter().map(|(_, c)| rgba_hex(*c)).collect()
            }
            Fill::Radial { stops, .. } => stops.iter().map(|(_, c)| rgba_hex(*c)).collect(),
        }
    }

    /// 设置窗族的 7 个槽位：三套主题逐一与设计稿比对（顺序与档位都要一致）。
    #[test]
    fn 设置窗槽位与设计稿逐字一致() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            let name = id.as_str();
            let cases: [(&str, Vec<u32>, Vec<u32>); 7] = [
                (
                    "--rail",
                    css_hexes(&design_var(name, "--rail")),
                    fill_hexes(&t.rail_bg),
                ),
                (
                    "--raile",
                    css_hexes(&design_var(name, "--raile")),
                    vec![rgba_hex(t.rail_edge)],
                ),
                (
                    "--tg",
                    css_hexes(&design_var(name, "--tg")),
                    fill_hexes(&t.switch_off_bg),
                ),
                (
                    "--tge",
                    css_hexes(&design_var(name, "--tge")),
                    vec![rgba_hex(t.switch_off_edge)],
                ),
                (
                    "--tgk",
                    css_hexes(&design_var(name, "--tgk")),
                    fill_hexes(&t.switch_knob),
                ),
                (
                    "--tgon",
                    css_hexes(&design_var(name, "--tgon")),
                    fill_hexes(&t.switch_on_bg),
                ),
                (
                    "--tgone",
                    css_hexes(&design_var(name, "--tgone")),
                    vec![rgba_hex(t.switch_on_edge)],
                ),
            ];
            for (css, want, got) in cases {
                assert!(!want.is_empty(), "{name} 的 {css}：设计稿里没解析出颜色");
                assert_eq!(
                    got, want,
                    "{name} 的 {css}：Rust token 与设计稿不一致（改色要两处同改）"
                );
            }
        }
    }

    /// 助手气泡槽位（`--aibg`/`--aiedge`）：2026-10-05 与设计稿同批加的 AI 侧气泡
    /// （用户反馈「聊天没有气泡感」后定的），逐字对账 —— 改色同样要两处同改。
    #[test]
    fn 助手气泡槽位与设计稿逐字一致() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            let name = id.as_str();
            let want_bg = css_hexes(&design_var(name, "--aibg"));
            assert!(
                !want_bg.is_empty(),
                "{name} 的 --aibg：设计稿里没解析出颜色"
            );
            assert_eq!(
                fill_hexes(&t.bubble_ai_bg),
                want_bg,
                "{name} 的 --aibg：Rust token 与设计稿不一致（改色要两处同改）"
            );
            assert_eq!(
                vec![rgba_hex(t.bubble_ai_edge)],
                css_hexes(&design_var(name, "--aiedge")),
                "{name} 的 --aiedge：Rust token 与设计稿不一致（改色要两处同改）"
            );
        }
    }

    // ── 阴影类槽位的对账：解析设计稿的 box-shadow 值，逐项与 token 比对 ──

    /// 取一个选择器规则体（`selector{...}` 的花括号内文）。
    fn rule_body(selector: &str) -> String {
        let at = DESIGN_DOC
            .find(selector)
            .unwrap_or_else(|| panic!("设计稿里找不到规则：{selector}"));
        let rest = &DESIGN_DOC[at + selector.len()..];
        let end = rest.find('}').expect("规则应以 } 结束");
        rest[..end].to_string()
    }

    /// 取 `:root` 里的某个全局变量（`--contact` / `--ambient` 定义在这里）。
    fn root_var(var: &str) -> String {
        let block = rule_body(":root{");
        let key = format!("{var}:");
        let at = block
            .find(&key)
            .unwrap_or_else(|| panic!("设计稿 :root 里没有 {var}"));
        let tail = &block[at + key.len()..];
        let stop = tail.find(';').unwrap_or(tail.len());
        tail[..stop].trim().to_string()
    }

    /// 展开 `--contact` / `--ambient` 引用（阴影槽位只用到这两个全局变量）。
    ///
    /// `css_hexes` 解析不了含 `var()` 的复合值，所以比对前先展开；展开后残留任何
    /// `var(` 都直接报错（避免把「没解析」静默当成「没有」）。
    fn resolve_shadow_vars(value: &str) -> String {
        let resolved = value
            .replace("var(--contact)", &root_var("--contact"))
            .replace("var(--ambient)", &root_var("--ambient"));
        assert!(
            !resolved.contains("var("),
            "阴影槽位只允许 --contact / --ambient 两个 var 引用，实际：{value}"
        );
        resolved
    }

    /// 按顶层逗号切一项 CSS 值（忽略括号内的逗号）。
    fn split_top_level(value: &str) -> Vec<String> {
        let mut items = Vec::new();
        let mut depth = 0i32;
        let mut start = 0usize;
        for (index, ch) in value.char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => depth -= 1,
                ',' if depth == 0 => {
                    items.push(value[start..index].trim().to_string());
                    start = index + 1;
                }
                _ => {}
            }
        }
        items.push(value[start..].trim().to_string());
        items.into_iter().filter(|item| !item.is_empty()).collect()
    }

    /// 解析后的一条 CSS 阴影项。
    #[derive(Debug, Clone, Copy)]
    struct CssShadow {
        inset: bool,
        dx: f32,
        dy: f32,
        blur: f32,
        spread: f32,
        /// `(r, g, b, a)`，0..1。
        color: (f32, f32, f32, f32),
    }

    fn parse_color(part: &str) -> (f32, f32, f32, f32) {
        let part = part.trim();
        if let Some(hex) = part.strip_prefix('#') {
            let value =
                u32::from_str_radix(hex, 16).unwrap_or_else(|_| panic!("非法十六进制色：{part}"));
            let (r, g, b) = if hex.len() == 3 {
                let q = |c: char| {
                    let v = c
                        .to_digit(16)
                        .unwrap_or_else(|| panic!("非法十六进制色：{part}"))
                        as f32;
                    v * 16.0 + v
                };
                let mut chars = hex.chars();
                (
                    q(chars.next().unwrap()),
                    q(chars.next().unwrap()),
                    q(chars.next().unwrap()),
                )
            } else {
                (
                    ((value >> 16) & 0xFF) as f32,
                    ((value >> 8) & 0xFF) as f32,
                    (value & 0xFF) as f32,
                )
            };
            return (r / 255.0, g / 255.0, b / 255.0, 1.0);
        }
        let inner = part
            .strip_prefix("rgba(")
            .or_else(|| part.strip_prefix("rgb("))
            .unwrap_or_else(|| panic!("不认识的 CSS 颜色：{part}"));
        let inner = inner.trim_end_matches(')');
        let nums: Vec<f32> = inner
            .split(',')
            .map(|n| n.trim().parse::<f32>().expect("颜色分量"))
            .collect();
        assert!(
            nums.len() == 3 || nums.len() == 4,
            "颜色分量数应为 3 或 4：{part}"
        );
        (
            nums[0] / 255.0,
            nums[1] / 255.0,
            nums[2] / 255.0,
            nums.get(3).copied().unwrap_or(1.0),
        )
    }

    /// 解析一条 shadow 项（`inset 0 1px 2px rgba(...)` / `0 1px 0 #fff`）。
    fn parse_shadow(item: &str) -> CssShadow {
        let item = item.trim();
        let inset = item.starts_with("inset");
        let rest = if inset {
            item["inset".len()..].trim_start()
        } else {
            item
        };
        let color_at = ["rgba(", "rgb(", "#"]
            .iter()
            .filter_map(|needle| rest.find(needle))
            .min()
            .unwrap_or_else(|| panic!("阴影项没有颜色：{item}"));
        let numbers_part = &rest[..color_at];
        let numbers: Vec<f32> = numbers_part
            .split_whitespace()
            .map(|token| {
                token
                    .strip_suffix("px")
                    .unwrap_or(token)
                    .parse::<f32>()
                    .unwrap_or_else(|_| panic!("阴影项有非数字 token：{item}"))
            })
            .collect();
        assert!(
            (2..=4).contains(&numbers.len()),
            "阴影项的偏移/模糊档数应为 2–4：{item}"
        );
        CssShadow {
            inset,
            dx: numbers[0],
            dy: numbers[1],
            blur: numbers.get(2).copied().unwrap_or(0.0),
            spread: numbers.get(3).copied().unwrap_or(0.0),
            color: parse_color(&rest[color_at..]),
        }
    }

    fn parse_shadows(resolved: &str) -> Vec<CssShadow> {
        split_top_level(resolved)
            .iter()
            .map(|item| parse_shadow(item))
            .collect()
    }

    /// CSS inset 项 → 期望的 `(侧别, 线宽, 模糊, 色)`：正 x → 左边线、负 x → 右边线、
    /// 正 y → 顶线、负 y → 底线；`0 0 …` 只有扩散 → 整圈内环。
    fn expected_edge(side: EdgeSide, numbers: &CssShadow) -> (EdgeSide, f32, f32, Rgba) {
        let width = numbers.dx.abs().max(numbers.dy.abs()).max(numbers.spread);
        let (r, g, b, a) = numbers.color;
        (side, width, numbers.blur, Rgba::rgba(r, g, b, a))
    }

    fn line_side_rank(side: EdgeSide) -> u8 {
        match side {
            EdgeSide::Top => 0,
            EdgeSide::Bottom => 1,
            EdgeSide::Left => 2,
            EdgeSide::Right => 3,
        }
    }

    fn line_key(
        side: EdgeSide,
        width: f32,
        blur: f32,
        color: Rgba,
    ) -> (u8, i32, i32, u8, u8, u8, i32) {
        (
            line_side_rank(side),
            (width * 100.0).round() as i32,
            (blur * 100.0).round() as i32,
            (color.r * 255.0).round() as u8,
            (color.g * 255.0).round() as u8,
            (color.b * 255.0).round() as u8,
            (color.a * 1000.0).round() as i32,
        )
    }

    /// 一条 `--pshadow` 一类的值：inset 项逐条映射为期望的 Bevel 线，与 token 比对。
    ///
    /// 非 inset 项（外投影）不在这里管，由 [`assert_elevation_matches`] 负责。
    fn assert_bevel_matches(theme: &str, var: &str, bevel: &Bevel) {
        let resolved = resolve_shadow_vars(&design_var(theme, var));
        let shadows = parse_shadows(&resolved);

        let mut want: Vec<(u8, i32, i32, u8, u8, u8, i32)> = Vec::new();
        let mut want_rings: Vec<(i32, i32, u8, u8, u8, i32)> = Vec::new();
        for shadow in shadows.iter().filter(|shadow| shadow.inset) {
            let (r, g, b, a) = shadow.color;
            if shadow.dx == 0.0 && shadow.dy == 0.0 {
                want_rings.push((
                    (shadow.spread * 100.0).round() as i32,
                    (shadow.blur * 100.0).round() as i32,
                    (r * 255.0).round() as u8,
                    (g * 255.0).round() as u8,
                    (b * 255.0).round() as u8,
                    (a * 1000.0).round() as i32,
                ));
                continue;
            }
            let mut sides = Vec::new();
            if shadow.dx > 0.0 {
                sides.push(EdgeSide::Left);
            } else if shadow.dx < 0.0 {
                sides.push(EdgeSide::Right);
            }
            if shadow.dy > 0.0 {
                sides.push(EdgeSide::Top);
            } else if shadow.dy < 0.0 {
                sides.push(EdgeSide::Bottom);
            }
            for side in sides {
                let (side, width, blur, color) = expected_edge(side, shadow);
                want.push(line_key(side, width, blur, color));
            }
        }
        want.sort();

        let mut got = Vec::new();
        let mut got_rings = Vec::new();
        for item in bevel.lines {
            match item {
                BevelLine::Edge { side, line } => {
                    got.push(line_key(*side, line.width, line.blur, line.color));
                }
                BevelLine::Ring { line } => got_rings.push((
                    (line.width * 100.0).round() as i32,
                    (line.blur * 100.0).round() as i32,
                    (line.color.r * 255.0).round() as u8,
                    (line.color.g * 255.0).round() as u8,
                    (line.color.b * 255.0).round() as u8,
                    (line.color.a * 1000.0).round() as i32,
                )),
            }
        }
        got.sort();
        want_rings.sort();
        got_rings.sort();

        assert_eq!(
            got, want,
            "{theme} 的 {var}：Bevel 线（侧别/宽/模糊/色）与设计稿不符，设计稿={resolved}"
        );
        assert_eq!(got_rings, want_rings, "{theme} 的 {var}：内环与设计稿不符");
    }

    fn shadow_close(a: &Shadow, b: &Shadow) -> bool {
        (a.dy - b.dy).abs() < 0.01
            && (a.blur - b.blur).abs() < 0.01
            && (a.spread - b.spread).abs() < 0.01
            && (a.color.r - b.color.r).abs() < 0.01
            && (a.color.g - b.color.g).abs() < 0.01
            && (a.color.b - b.color.b).abs() < 0.01
            && (a.color.a - b.color.a).abs() < 0.01
    }

    fn css_shadow_to_shadow(shadow: &CssShadow) -> Shadow {
        assert!(
            shadow.dx == 0.0,
            "外投影不该有 x 偏移（Shadow 只表达纵向下移）"
        );
        let (r, g, b, a) = shadow.color;
        Shadow {
            dy: shadow.dy,
            blur: shadow.blur,
            spread: shadow.spread,
            color: Rgba::rgba(r, g, b, a),
        }
    }

    /// 一条 `--bsh` 一类的值：非 inset 项映射为 Elevation 的 contact / ambient。
    ///
    /// `var(--contact)` → `contact`、`var(--ambient)` → `ambient`、裸外线（如拉丝
    /// `--tsh` 的 `0 1px 0 white .08`）按 contact 对待。
    fn assert_elevation_matches(theme: &str, var: &str, elevation: &Elevation) {
        let raw = design_var(theme, var);
        let mut want_contact: Option<Shadow> = None;
        let mut want_ambient: Option<Shadow> = None;
        for item in split_top_level(&raw) {
            if item == "var(--contact)" {
                let shadow = parse_shadow(&root_var("--contact"));
                want_contact = Some(css_shadow_to_shadow(&shadow));
            } else if item == "var(--ambient)" {
                let shadow = parse_shadow(&root_var("--ambient"));
                want_ambient = Some(css_shadow_to_shadow(&shadow));
            } else {
                let parsed = parse_shadow(&item);
                if !parsed.inset {
                    want_contact = Some(css_shadow_to_shadow(&parsed));
                }
            }
        }
        match (&elevation.contact, &want_contact) {
            (None, None) => {}
            (Some(got), Some(want)) => assert!(
                shadow_close(got, want),
                "{theme} 的 {var}：contact 投影 {got:?} 与设计稿 {want:?} 不符"
            ),
            _ => panic!(
                "{theme} 的 {var}：contact 有无与设计稿不符（token {elevation:?}，设计稿 {want_contact:?}）"
            ),
        }
        match (&elevation.ambient, &want_ambient) {
            (None, None) => {}
            (Some(got), Some(want)) => assert!(
                shadow_close(got, want),
                "{theme} 的 {var}：ambient 投影 {got:?} 与设计稿 {want:?} 不符"
            ),
            _ => panic!(
                "{theme} 的 {var}：ambient 有无与设计稿不符（token {elevation:?}，设计稿 {want_ambient:?}）"
            ),
        }
    }

    /// 阴影/立体线槽位：五套主题的 `--pshadow` / `--tsh` / `--bsh` / `--ssh` /
    /// `--tabonsh` / `--mesh` / `--barsh` 与 token 逐项比对（含 var 展开）。
    ///
    /// 说明一处**刻意不表达**的值：
    /// - 拉丝 `--logsh` 的 `0 1px 0 rgba(255,255,255,.07)` 外白线：在实机承载件上被
    ///   下一条区带盖住或裁掉，设计稿自身也被 `.pstack` 的上边框盖住 —— 不可见，
    ///   不建表达（评估记录在交付报告）。
    #[test]
    fn 阴影槽位与设计稿逐字一致() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            let name = id.as_str();
            assert_bevel_matches(name, "--pshadow", &t.panel_bevel);
            assert_elevation_matches(name, "--pshadow", &t.panel_shadow);
            assert_bevel_matches(name, "--tsh", &t.tool_bevel);
            assert_elevation_matches(name, "--tsh", &t.tool_shadow);
            assert_bevel_matches(name, "--bsh", &t.btn_bevel);
            assert_elevation_matches(name, "--bsh", &t.btn_shadow);
            assert_bevel_matches(name, "--ssh", &t.primary_bevel);
            assert_elevation_matches(name, "--ssh", &t.primary_shadow);
            assert_bevel_matches(name, "--tabonsh", &t.tab_on_bevel);
            assert_elevation_matches(name, "--tabonsh", &t.tab_on_shadow);
            assert_bevel_matches(name, "--mesh", &t.bubble_user_bevel);
            assert_elevation_matches(name, "--mesh", &t.bubble_user_shadow);
            assert_bevel_matches(name, "--barsh", &t.bar_bevel);
            assert_elevation_matches(name, "--barsh", &t.bar_shadow);
        }
    }

    /// `--logsh`：inset 部分与 `log_inset` 逐条一致（铬的上白 + 下蓝灰双线由此锚定）。
    #[test]
    fn 消息流内阴影与设计稿逐字一致() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            let bevel = t.log_inset.expect("三套主题都填了 --logsh 的内线条");
            assert_bevel_matches(id.as_str(), "--logsh", &bevel);
        }
    }

    /// `--finner`：输入框内立体线与设计稿一致（铬的两条都贴上缘）。
    #[test]
    fn 输入框内阴影与设计稿逐字一致() {
        for id in ThemeId::ALL {
            assert_bevel_matches(id.as_str(), "--finner", &id.tokens().field_bevel);
        }
    }

    /// 面板纹理：层数与类型按设计稿 `--ptex` 的声明序一一对应（声明序 = CSS 序，
    /// 首层在最上，由绘制层保证）；铬的第二层是**底边**地平线。
    ///
    /// token 允许把相邻的多个 `repeating-linear-gradient` 合并进一个
    /// `Layer::Stripes`（拉丝的两组条纹就是这样存的），所以比对时把 Stripes 层
    /// 按 `stripes.len()` 展开成同样多个「周期条纹」单位再逐项比。
    #[test]
    fn 面板纹理层序与设计稿逐字一致() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            let sheen = t.panel_tex.expect("三套主题都有 --ptex");
            let raw = design_var(id.as_str(), "--ptex");
            let items = split_top_level(&raw);

            let mut token_kinds: Vec<&str> = Vec::new();
            for layer in sheen.0 {
                match layer {
                    Layer::Grad(_) => token_kinds.push("渐变"),
                    Layer::Stripes(stripes) => {
                        for _ in 0..stripes.len() {
                            token_kinds.push("周期条纹");
                        }
                    }
                    Layer::Tex { .. } => token_kinds.push("斑块纹理"),
                    Layer::Edge { .. } => token_kinds.push("边线"),
                }
            }
            let css_kinds: Vec<&str> = items
                .iter()
                .map(|css| {
                    if css.starts_with("var(--verdigris)") {
                        "斑块纹理"
                    } else if css.contains("repeating-linear-gradient(") {
                        "周期条纹"
                    } else if css.contains("transparent 1px") {
                        "边线"
                    } else if css.contains("linear-gradient(") {
                        "渐变"
                    } else {
                        panic!("{} 的 --ptex 有不认识的层：{css}", id.as_str())
                    }
                })
                .collect();
            assert_eq!(
                token_kinds,
                css_kinds,
                "{} 的 --ptex 层序：token {token_kinds:?} 与设计稿 {css_kinds:?} 不符",
                id.as_str()
            );
        }

        // 铬的两层：柱面多档渐变在前、地平线在后；0deg 的起点在底边。
        let chrome_items = split_top_level(&design_var("chrome", "--ptex"));
        assert!(
            chrome_items[1].starts_with("linear-gradient(0deg,"),
            "第二层是 0deg 的地平线"
        );
        match ThemeId::Chrome.tokens().panel_tex.expect("铬有 --ptex").0[1] {
            Layer::Edge { side, color, width } => {
                assert_eq!(side, EdgeSide::Bottom, "0deg 起点在底边，白线画在底边");
                assert_eq!(width, 1.0);
                let (r, g, b, a) = parse_color("rgba(255,255,255,.6)");
                assert!(
                    (color.r - r).abs() < 0.01
                        && (color.g - g).abs() < 0.01
                        && (color.b - b).abs() < 0.01
                        && (color.a - a).abs() < 0.01,
                    "地平线色应为 white .6，实际 {color:?}"
                );
            }
            other => panic!("铬 --ptex 第二层应为边线，实际 {other:?}"),
        }
    }

    /// 舞台纹理：设计稿只有铜绿定义 `#verdigris .stage{background-image:var(--verdigris),…}`。
    #[test]
    fn 舞台纹理与设计稿逐字一致() {
        let rule = rule_body("#verdigris .stage{");
        let items = split_top_level(
            rule.split("background-image:")
                .nth(1)
                .map(|tail| tail.split(';').next().expect("background-image 声明"))
                .expect("设计稿 verdigris 舞台应有 background-image"),
        );
        assert!(
            items[0].starts_with("var(--verdigris)"),
            "首层是氧化斑块纹理"
        );
        match ThemeId::Verdigris
            .tokens()
            .stage_tex
            .expect("铜绿舞台有斑块纹理")
            .0
        {
            [Layer::Tex { tex, .. }] => assert_eq!(*tex, Tex::Verdigris),
            layers => panic!("铜绿舞台纹理应恰有一层斑块，实际 {layers:?}"),
        }
        assert!(ThemeId::Brushed.tokens().stage_tex.is_none());
        assert!(ThemeId::Chrome.tokens().stage_tex.is_none());
        // 另外两套主题在设计稿里没有 `.stage` 覆盖规则（用 `--stage-bg` 作底）。
        assert!(!DESIGN_DOC.contains("#brushed .stage{"));
        assert!(!DESIGN_DOC.contains("#chrome .stage{"));
    }

    /// 面板细颗粒：设计稿 `.chat::after` 对所有主题叠 `0.028`（铜绿此前被误关）。
    #[test]
    fn 面板颗粒与设计稿逐字一致() {
        let rule = rule_body(".chat::after{");
        assert!(
            rule.contains("background-image:var(--grain)"),
            "颗粒用的是 --grain 纹理"
        );
        assert!(rule.contains("opacity:.028"), "细颗粒透明度 0.028");
        for id in ThemeId::ALL {
            assert_eq!(
                id.tokens().panel_grain,
                Some(0.028),
                "{} 的面板颗粒应与设计稿一致",
                id.as_str()
            );
        }
    }
}
