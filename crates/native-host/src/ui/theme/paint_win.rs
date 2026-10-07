//! Windows 绘制适配：把主题 token 转成 GDI 能直接执行的原语。
//!
//! ## 分层（为什么本文件两平台都编译）
//!
//! 上半段是**纯逻辑**（颜色换算、条纹/立体线/投影的几何与配色、位图 → DIB 字节），
//! 不含任何 Win32 依赖，两个平台都编译 —— 它在开发机（macOS）上就能跑单测，
//! 这是本模块最容易出错的部分（字节序、行序、周期裁剪）唯一能在本机验证的地方。
//! 下半段（`#[cfg(windows)]` 的 [`gdi`] 子模块）才是真正的 GDI 调用，
//! 由 `pub use gdi::*` 平铺到本模块命名空间。
//!
//! ## GDI 表达的取舍（逐条注明）
//!
//! - **alpha**：GDI 纯色（`COLORREF`/`HBRUSH`）没有 alpha 通道。需要半透明时一律走
//!   `AlphaBlend`（1×1 预乘 DIB 拉伸成目标矩形）；确定底色且语义是「叠加」的场合
//!   （条纹、Bevel、文字投影）先在 sRGB 空间做 `composite_over` 近似再画实色 ——
//!   sRGB 合成与线性空间合成有肉眼可见的细微差，这是就地注明的取舍，不做 gamma 校正。
//! - **渐变**：一律走「1×H 预乘 BGRA 条 + `AlphaBlend` 拉伸」，逐行取样与设计稿的多停
//!   渐变一一对应（设计稿的 `linear-gradient` 本就是任意停靠点）。**不用 `GradientFill`
//!   的 `GRADIENT_FILL_RECT_V`**：本机（Windows 11 26100）实测该 API 对**窗口 DC** 返回
//!   `TRUE` 却一个像素都不写（同一个 API 对 `CreateDIBSection` 的离屏 DC 正常），
//!   `Fill::Linear` 底的窗口背景会整片透明——图层编辑器窗口「能看见桌面」的直接原因；
//!   而 `AlphaBlend` 在窗口 DC 上实测正常（舞台合成也一直用它）。两条路径对不透明 stop
//!   观感一致，代价是每次渐变多一次 1×H 位图拉伸。
//! - **`Fill::Radial`**：GDI 没有径向渐变，退化为 [`Fill::base_color`]（末档色）实填充。
//! - **`Fill::Striped`**：按周期逐线画（不走 `CreatePatternBrush`）。理由：条纹色都带
//!   alpha，pattern brush 是颜色拷贝、表达不了半透明；而周期只有 2–7px、线数在百级，
//!   `AlphaBlend` 逐线填充的成本可忽略，且没有 pattern brush 的平铺相位与 DIB 生命周期。
//! - **`Bevel` 的 blur**：GDI 没有模糊。`blur > 0` 退化为「主带降低 alpha + 最多 3 条
//!   内侧 1px 递减带」（[`edge_bands`]），是软边的粗略近似，不是真高斯。
//! - **多层顺序**：`Sheen` / `Bevel` / 一组条纹的声明序 = CSS 序（**首项在最上**）；
//!   GDI 顺序填充是「后画盖先画」，绘制时倒序迭代（[`paint_order_first_on_top`]），
//!   与 macOS 侧 zPosition 递减同口径。
//! - **`Elevation`（投影）**：GDI 没有投影。用「按 dy/spread 偏移扩散后的矩形 +
//!   `AlphaBlend` 均匀半透明填充」近似（[`elevation_bands`]）；blur 被压缩成均匀 alpha，
//!   没有衰减梯度。窗口非矩形时的精确投影需要 `UpdateLayeredWindow` 整窗合成路径
//!   （舞台子窗口已走该路径），聊天/顶栏这类矩形窗口不做。
//! - **圆角**：`Radii` 只用在 ownerdraw 按钮上（`CreateRoundRectRgn` + `SetWindowRgn`），
//!   圆角随 `WM_SIZE` 重设；气泡/输入框承载在 RichEdit 上（区域裁剪会与滚动条、
//!   IME 候选窗互相干扰），保持直角 —— 见交付报告的「RichtEdit 承载件不做圆角」。
//!
//! ## Bitmap → DIB 的行序
//!
//! [`super::noise::Bitmap`] 是左上原点、自上而下的 RGBA8；GDI 的 DIB 默认自下而上。
//! 本模块统一用**负 `biHeight`** 声明顶朝下 DIB（与 `render/win.rs` 的既有做法同款），
//! 因此 [`bitmap_dib_bytes`] **不翻转行序**：缓冲第 0 行 = 位图顶行。
//! 若哪天改成正 `biHeight`，必须同时翻转行序，否则整块纹理上下颠倒 ——
//! 测试 `位图_dib_行序与负高度声明` 钉住这一对关系。

use super::noise::Bitmap;
use super::tokens::{
    Bevel, BevelLine, EdgeSide, Elevation, Fill, InsetLine, Rgba, Shadow, Stripe, Tokens,
};

// ==========================================
// 纯逻辑（两平台编译；单测在本机可跑）
// ==========================================

/// 像素矩形（物理像素，左上原点，右/下开区间）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    pub const fn right(&self) -> i32 {
        self.x + self.w
    }

    pub const fn bottom(&self) -> i32 {
        self.y + self.h
    }

    pub const fn is_empty(&self) -> bool {
        self.w <= 0 || self.h <= 0
    }

    /// 点（同一坐标系）是否落在矩形内。右/下开区间，与 GDI `PtInRect` 同口径 ——
    /// 顶栏的「绘制与命中共用同一份矩形」以此为底座，边界差一像素会让入口点不中
    /// 或被当成拖动区。
    pub const fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }

    /// 四边内缩 `d` 像素（可为负 = 外扩）。
    pub const fn deflate(&self, d: i32) -> Self {
        Self {
            x: self.x + d,
            y: self.y + d,
            w: self.w - 2 * d,
            h: self.h - 2 * d,
        }
    }

    pub const fn offset(&self, dx: i32, dy: i32) -> Self {
        Self {
            x: self.x + dx,
            y: self.y + dy,
            w: self.w,
            h: self.h,
        }
    }
}

/// 一条要画的色带（`color` 是**直通 alpha**；画的时候按覆盖关系走 AlphaBlend 或预合成）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Band {
    pub rect: Rect,
    pub color: Rgba,
}

/// `Rgba` → GDI `COLORREF`：**字节序是 0x00BBGGRR**（蓝在高位、红在最末字节），
/// 不是直觉上的 RGB。alpha 在纯色里表达不了，直接丢弃（需要半透明走 AlphaBlend）。
pub fn colorref(c: Rgba) -> u32 {
    let ch = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
    (ch(c.b) << 16) | (ch(c.g) << 8) | ch(c.r)
}

/// `COLORREF` → `Rgba`（opaque）。用于把 `SetWindowLongPtrW` 里存的字色取回来。
pub fn rgba_from_colorref(v: u32) -> Rgba {
    let ch = |shift: u32| ((v >> shift) & 0xFF) as f32 / 255.0;
    Rgba::rgba(ch(0), ch(8), ch(16), 1.0)
}

/// sRGB 空间的 src-over 合成（`fg` 盖在 `bg` 上），输出不透明。
///
/// 只在「底色已知且语义是叠加」的近似里用；真正的逐像素混合走 AlphaBlend。
pub fn composite_over(fg: Rgba, bg: Rgba) -> Rgba {
    let a = fg.a.clamp(0.0, 1.0);
    let mix = |f: f32, b: f32| f * a + b * (1.0 - a);
    Rgba::rgba(mix(fg.r, bg.r), mix(fg.g, bg.g), mix(fg.b, bg.b), 1.0)
}

/// 竖向渐变的第 `t`（0..1）档取样（两停之间线性插值，alpha 一同插值）。
pub fn sample_linear(stops: &[(f32, Rgba)], t: f32) -> Rgba {
    if stops.is_empty() {
        return Rgba::black_alpha(1.0);
    }
    let t = t.clamp(0.0, 1.0);
    if t <= stops[0].0 {
        return stops[0].1;
    }
    let last = stops[stops.len() - 1];
    if t >= last.0 {
        return last.1;
    }
    for pair in stops.windows(2) {
        let (t0, c0) = pair[0];
        let (t1, c1) = pair[1];
        if t >= t0 && t <= t1 {
            let span = (t1 - t0).max(f32::EPSILON);
            let k = (t - t0) / span;
            let lerp = |a: f32, b: f32| a + (b - a) * k;
            return Rgba::rgba(
                lerp(c0.r, c1.r),
                lerp(c0.g, c1.g),
                lerp(c0.b, c1.b),
                lerp(c0.a, c1.a),
            );
        }
    }
    last.1
}

/// 任意 `Fill` 在第 `t` 档的代表色（`Radial` 退化为 `base_color`）。
pub fn sample_fill(fill: &Fill, t: f32) -> Rgba {
    match fill {
        Fill::Solid(c) => *c,
        Fill::Linear(stops) | Fill::Striped { stops, .. } => sample_linear(stops, t),
        Fill::Radial { .. } => fill.base_color(),
    }
}

/// 一条周期条纹在该矩形里要画的线（CSS `repeating-linear-gradient` 的等价物：
/// 从矩形顶边起、每 `period` 像素一条 `line` 像素高的线，最后一条裁到矩形内）。
///
/// 周期或线宽非法（≤0.5px / alpha 为 0）时返回空 —— 这是**有意**的静默：
/// token 表在编译期固定，非法值属于表本身的错误；这里只是不让它变成死循环或负宽。
pub fn stripe_bands(rect: Rect, stripe: &Stripe) -> Vec<Band> {
    if rect.is_empty() || stripe.period < 0.5 || stripe.line < 0.5 || stripe.color.a <= 0.0 {
        return Vec::new();
    }
    let period = (stripe.period.round() as i32).max(1);
    let line = (stripe.line.round() as i32).max(1).min(period);
    let mut bands = Vec::new();
    let mut y = rect.y;
    while y < rect.bottom() {
        let h = line.min(rect.bottom() - y);
        bands.push(Band {
            rect: Rect::new(rect.x, y, rect.w, h),
            color: stripe.color,
        });
        y += period;
    }
    bands
}

/// 模糊退化的 alpha 衰减：`blur > 0` 时把线 alpha 按 `1/(1+0.35·blur)` 压低（约 blur=5 时腰斩），
/// 下限保留 35% —— GDI 没有真模糊，这是「软边」的粗略近似，不是物理正确的扩散。
fn soften(alpha: f32, blur: f32) -> f32 {
    if blur <= 0.0 {
        alpha
    } else {
        (alpha / (1.0 + 0.35 * blur)).max(alpha * 0.35)
    }
}

/// 一条内边缘线 → 色带。`side` 决定贴哪条边（顶/底占满全宽，左/右占满全高）。
///
/// 主带厚度 = `ceil(width)`（至少 1px）；`blur > 0` 时在主带内侧追加最多 3 条 1px
/// 递减带（0.45 / 0.20 / 0.08 系数），模拟透明渐变带。
pub fn edge_bands(line: &InsetLine, rect: Rect, side: EdgeSide) -> Vec<Band> {
    if rect.is_empty() || line.width <= 0.0 || line.color.a <= 0.0 {
        return Vec::new();
    }
    let horizontal = matches!(side, EdgeSide::Top | EdgeSide::Bottom);
    let span = if horizontal { rect.h } else { rect.w };
    let width = (line.width.ceil() as i32).max(1).min(span);
    let mut bands = Vec::new();
    let main = if horizontal {
        let y = if side == EdgeSide::Top {
            rect.y
        } else {
            rect.bottom() - width
        };
        Rect::new(rect.x, y, rect.w, width)
    } else {
        let x = if side == EdgeSide::Left {
            rect.x
        } else {
            rect.right() - width
        };
        Rect::new(x, rect.y, width, rect.h)
    };
    bands.push(Band {
        rect: main,
        color: line.color.with_alpha(soften(line.color.a, line.blur)),
    });
    if line.blur > 0.0 {
        let rings = ((line.blur / 2.0).floor() as i32).clamp(0, 3);
        const FADE: [f32; 3] = [0.45, 0.20, 0.08];
        for k in 0..rings {
            let offset = width + k;
            if offset >= span {
                break;
            }
            let rect = if horizontal {
                let y = if side == EdgeSide::Top {
                    rect.y + offset
                } else {
                    rect.bottom() - offset - 1
                };
                Rect::new(rect.x, y, rect.w, 1)
            } else {
                let x = if side == EdgeSide::Left {
                    rect.x + offset
                } else {
                    rect.right() - offset - 1
                };
                Rect::new(x, rect.y, 1, rect.h)
            };
            bands.push(Band {
                rect,
                color: line.color.with_alpha(line.color.a * FADE[k as usize]),
            });
        }
    }
    bands
}

/// 内环（CSS `inset 0 0 0 1px`）：四条互不重叠的边线。
///
/// 横向两条占满全宽、纵向两条只在横线之间 —— 同一 alpha 在角上重叠会二次合成、
/// 比其余边深。环宽夹取到不超过短边的一半，防退化尺寸。
pub fn ring_bands(line: &InsetLine, rect: Rect) -> Vec<Band> {
    if rect.is_empty() || line.width <= 0.0 || line.color.a <= 0.0 {
        return Vec::new();
    }
    let t = (line.width.ceil() as i32)
        .max(1)
        .min(rect.w.min(rect.h) / 2)
        .max(1);
    let color = line.color.with_alpha(soften(line.color.a, line.blur));
    let mut bands = vec![
        Band {
            rect: Rect::new(rect.x, rect.y, rect.w, t),
            color,
        },
        Band {
            rect: Rect::new(rect.x, rect.bottom() - t, rect.w, t),
            color,
        },
    ];
    let side_h = rect.h - t * 2;
    if side_h > 0 {
        bands.push(Band {
            rect: Rect::new(rect.x, rect.y + t, t, side_h),
            color,
        });
        bands.push(Band {
            rect: Rect::new(rect.right() - t, rect.y + t, t, side_h),
            color,
        });
    }
    bands
}

/// `Bevel`（内立体线）→ 色带，顺序 = `Bevel.lines` 的声明序；缺项不画线。
pub fn bevel_bands(bevel: &Bevel, rect: Rect) -> Vec<Band> {
    let mut bands = Vec::new();
    for item in bevel.lines {
        match item {
            BevelLine::Edge { side, line } => bands.extend(edge_bands(line, rect, *side)),
            BevelLine::Ring { line } => bands.extend(ring_bands(line, rect)),
        }
    }
    bands
}

/// 声明序 = CSS 多背景序的绘制顺序（纯函数，可测）：**首项在最上**。
///
/// 用于 `Sheen` 的多层与一组条纹（`Layer::Stripes` / `Fill::Striped`）；
/// GDI 顺序填充是「后画盖先画」，所以返回倒序索引：先画最后一项，首项最后画、
/// 盖在其余之上。
pub fn paint_order_first_on_top(count: usize) -> impl ExactSizeIterator<Item = usize> {
    (0..count).rev()
}

/// `Elevation` → 投影近似矩形（均匀半透明，见模块头「投影」条）。
///
/// 每层投影一张：`spread` 外扩（可为负 = 内缩），再向下偏移 `dy`。
/// 投影画在承载元素**之前**（先影后物），矩形交叠部分会被元素自己盖住。
pub fn elevation_bands(elevation: &Elevation, rect: Rect) -> Vec<Band> {
    let mut bands = Vec::new();
    for shadow in [elevation.contact, elevation.ambient].into_iter().flatten() {
        if shadow.color.a <= 0.0 {
            continue;
        }
        let spread = shadow.spread.round() as i32;
        let dy = shadow.dy.round() as i32;
        let band = Rect::new(
            rect.x - spread,
            rect.y - spread + dy,
            rect.w + spread * 2,
            rect.h + spread * 2,
        );
        if band.is_empty() {
            continue;
        }
        bands.push(Band {
            rect: band,
            color: shadow.color,
        });
    }
    bands
}

/// 开关滑块矩形（纯逻辑，两平台可测）：关态贴左、开态贴右。
///
/// 轨道 32×17、滑块 13×13、距外缘 2px（1px 边框 + 1px 内距，与设计稿 `.sw i`
/// 的 `top:1/left:1` 含边框口径一致）；轨道过矮时滑块收缩（不越界）。
pub fn switch_knob_rect(rect: Rect, on: bool) -> Rect {
    let knob = 13.min((rect.h - 4).max(1));
    let x = if on {
        (rect.right() - 2 - knob).max(rect.x + 2)
    } else {
        rect.x + 2
    };
    Rect::new(x, rect.y + (rect.h - knob) / 2, knob, knob)
}

/// DIB 的 `biHeight`：本模块统一用负值声明**顶朝下**（与 `render/win.rs` 同款）。
///
/// 负高度 = 内存第 0 行就是图像顶行，与 [`Bitmap`] 的排布一致，所以
/// [`bitmap_dib_bytes`] 不翻转；改成正值必须翻转，见模块头。
pub fn dib_height(height: u32) -> i32 {
    -(height as i32)
}

/// 8 位通道的预乘（`AlphaBlend` 的 `AC_SRC_ALPHA` 要求源位图预乘）。
fn premul(channel: u8, alpha: u8) -> u8 {
    (u32::from(channel) * u32::from(alpha) / 255) as u8
}

/// `Bitmap`（RGBA8、左上原点、自上而下）→ DIB 像素缓冲（预乘 BGRA、**顶朝下**）。
///
/// **行序**：与 [`dib_height`] 的负高度声明配对 —— 第 0 行原样落在缓冲开头，不翻转。
pub fn bitmap_dib_bytes(bitmap: &Bitmap) -> Vec<u8> {
    let mut out = vec![0u8; bitmap.width as usize * bitmap.height as usize * 4];
    for (src, dst) in bitmap.pixels.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
        let a = src[3];
        dst[0] = premul(src[2], a); // B
        dst[1] = premul(src[1], a); // G
        dst[2] = premul(src[0], a); // R
        dst[3] = a;
    }
    out
}

/// ownerdraw 按钮的角色（决定用哪一族 token）。数值会存进 `GWLP_USERDATA`，
/// 必须与 [`paint_win::gdi`] 的存取约定保持「小于 1<<24」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum ButtonRole {
    /// 普通按钮（`btn_bg` 族）。
    Normal = 1,
    /// 主按钮（发送 / 停止；`primary_bg` 族）。
    Primary = 2,
    /// 顶栏关闭「×」：`btn_bg` 族 + `dim` 字，悬浮时底色换 `danger`。
    Close = 3,
    /// 未选中的会话标签：无底、`dim` 字。
    TabOff = 4,
    /// 选中的会话标签（`tab_on_*` 族）。
    TabOn = 5,
    /// 待发送条目 chip（`field_bg` 族）。
    Pending = 7,
    /// 标签上的小「×」：`btn_bg` 族 + `dim` 字（不换 danger，避免与主关闭混淆）。
    TabClose = 8,
    /// 面板文字链（「工具 N」「Σ 用量」这类点击展开明细的入口）：无底无边、`ink` 字。
    Link = 9,
}

impl ButtonRole {
    pub const fn code(self) -> usize {
        self as usize
    }

    /// 未登记值收拢为 [`ButtonRole::Normal`]（控件寿命内只有我们写这个值，
    /// 收拢只防御「GWLP_USERDATA 被别的代码写过」这一种情况）。
    pub const fn from_code(code: usize) -> Self {
        match code {
            2 => ButtonRole::Primary,
            3 => ButtonRole::Close,
            4 => ButtonRole::TabOff,
            5 => ButtonRole::TabOn,
            7 => ButtonRole::Pending,
            8 => ButtonRole::TabClose,
            9 => ButtonRole::Link,
            _ => ButtonRole::Normal,
        }
    }
}

/// 一个 ownerdraw 按钮的面（角色 + 状态 → 具体 token 值）。
#[derive(Debug, Clone, Copy)]
pub struct ButtonFace {
    /// `None` = 无底（未选中标签落在条底上）。
    pub bg: Option<Fill>,
    /// 底色的代表色（禁用字/文字投影的预合成背景）。
    pub bg_base: Rgba,
    pub ink: Rgba,
    pub edge: Option<Rgba>,
    pub bevel: Option<Bevel>,
    /// 外投影（`--bsh` / `--ssh` / `--tabonsh` 的 `var(--contact)`）。
    pub shadow: Elevation,
    pub text_shadow: Option<Shadow>,
    /// 状态叠加（悬浮/按下的整面半透明覆盖）。
    pub overlay: Option<Rgba>,
}

/// 角色 + 状态 → 按钮面。悬浮/按下的差异：
/// - 关闭「×」悬浮 → 底色换 `danger`（设计稿唯一的悬浮换色）；
/// - 其余按钮悬浮 → 一层极淡的叠加（暗主题提亮 / 亮主题压暗）；
/// - 按下 → 一层 `black_alpha(0.16)` 叠加（所有角色统一）。
pub fn button_face(
    tokens: &'static Tokens,
    role: ButtonRole,
    hovered: bool,
    pressed: bool,
) -> ButtonFace {
    let (bg, ink, edge, bevel, shadow, text_shadow) = match role {
        ButtonRole::Normal => (
            Some(tokens.btn_bg),
            tokens.btn_ink,
            Some(tokens.btn_edge),
            Some(tokens.btn_bevel),
            tokens.btn_shadow,
            tokens.btn_text_shadow,
        ),
        ButtonRole::Primary => (
            Some(tokens.primary_bg),
            tokens.primary_ink,
            Some(tokens.primary_edge),
            Some(tokens.primary_bevel),
            tokens.primary_shadow,
            tokens.primary_text_shadow,
        ),
        // 关闭「×」：**无面**（与 macOS 顶栏一致 —— 只有字，悬浮才整块转 `danger`；
        // 顶栏是渐变底，给面就会补出一块白板，见 `draw_button` 的无底分支）。
        ButtonRole::Close => (None, tokens.dim, None, None, Elevation::NONE, None),
        // 未选中标签与文字链都无底无边：落在条底上，只出文字。
        ButtonRole::TabOff => (None, tokens.dim, None, None, Elevation::NONE, None),
        ButtonRole::Link => (None, tokens.ink, None, None, Elevation::NONE, None),
        ButtonRole::TabOn => (
            Some(tokens.tab_on_bg),
            tokens.ink,
            Some(tokens.tab_on_edge),
            Some(tokens.tab_on_bevel),
            tokens.tab_on_shadow,
            None,
        ),
        ButtonRole::Pending => (
            Some(tokens.field_bg),
            tokens.ink,
            Some(tokens.field_edge),
            Some(tokens.field_bevel),
            Elevation::NONE,
            None,
        ),
        ButtonRole::TabClose => (
            Some(tokens.btn_bg),
            tokens.dim,
            Some(tokens.btn_edge),
            Some(tokens.btn_bevel),
            tokens.btn_shadow,
            None,
        ),
    };
    let mut face = ButtonFace {
        bg,
        bg_base: bg
            .map(|fill| fill.base_color())
            .unwrap_or_else(|| composite_over(tokens.strip_bg, tokens.panel_bg.base_color())),
        ink,
        edge,
        bevel,
        shadow,
        text_shadow,
        overlay: None,
    };
    if hovered {
        if role == ButtonRole::Close {
            face.bg = Some(Fill::Solid(tokens.danger));
            face.bg_base = tokens.danger;
            face.ink = Rgba::white_alpha(0.95);
        } else {
            let overlay = if tokens.dark {
                Rgba::white_alpha(0.07)
            } else {
                Rgba::black_alpha(0.05)
            };
            face.overlay = Some(overlay);
        }
    }
    if pressed {
        face.overlay = Some(Rgba::black_alpha(0.16));
    }
    face
}

/// 禁用态按钮的实色等价（macOS `paint.rs::style_button` 的镜像口径：
/// **底色降 50% 透明度 + 标题降 50%**；评审实机证据：只降标题色的旧口径
/// 对比度只有 ~2:1，看起来像「配色错了的可用按钮」——2026-10-05）。
///
/// GDI 纯色画刷没有 alpha，两处都预合成为实色：
/// - `wash`：面板底 50% 的一层覆盖 —— 绘制端先画实色 fill 再叠它，等价于
///   `mix(fill, 面板底, 50%)`，同时保留渐变的下半强度（比把 fill 直接压成
///   代表色更接近 macOS 的「底降透明度」观感）；
/// - `washed_base`：冲洗后的底色实色（文字投影的预合成背景用）；
/// - `ink`：标题色 50% 预合成到 `washed_base` 上的实色（`DrawTextW` 没有 alpha）。
///
/// `backdrop` 是按钮所在表面的底色（调用方给；聊天窗统一用面板底，
/// 与 `flat_over_panel` 的兜底口径一致 —— 输入条上的按钮会有一档可见度差，
/// 就地注明这一近似）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisabledFace {
    /// 叠在已画实色 fill 上的 50% 面板底（`fill_color` 的 alpha 通路走 AlphaBlend）。
    pub wash: Rgba,
    /// 冲洗后的底色实色（标题/文字投影的预合成背景）。
    pub washed_base: Rgba,
    /// 预合成的标题实色。
    pub ink: Rgba,
}

/// 角色面 + 表面底色 → 禁用态的实色等价（见 [`DisabledFace`]；纯函数，两平台可测）。
pub fn disabled_face(face: &ButtonFace, backdrop: Rgba) -> DisabledFace {
    let wash = backdrop.with_alpha(backdrop.a * 0.5);
    let washed_base = composite_over(wash, face.bg_base);
    DisabledFace {
        wash,
        washed_base,
        ink: composite_over(face.ink.with_alpha(face.ink.a * 0.5), washed_base),
    }
}

/// 语义文字角色（设置窗 / 编辑器窗的 STATIC 与文字按钮）。
///
/// 聊天窗的静态字色按控件直接记录具体颜色；设置/编辑器窗的标签按**语义角色**登记，
/// 角色 → token 的映射只有 [`text_color`] 这一份 —— 换主题重刷时同一个函数给新值，
/// 平台文件里不再各自写一遍 `ink`/`dim`/`danger` 的对应关系。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextRole {
    /// 正文：字段标签、条目标题、文档标题（`--ink`）。
    Body,
    /// 说明 / 次要信息：帮助文本、提示行、状态行（`--dim`）。
    Hint,
    /// 错误：失败诊断（`danger`）。
    Error,
    /// 警告：非阻塞提示（`warn`）。
    Warning,
}

/// 文字角色 → 字色 token（错误与警告各归其位，不得对调）。
pub fn text_color(tokens: &'static Tokens, role: TextRole) -> Rgba {
    match role {
        TextRole::Body => tokens.ink,
        TextRole::Hint => tokens.dim,
        TextRole::Error => tokens.danger,
        TextRole::Warning => tokens.warn,
    }
}

// ==========================================
// GDI 原语（仅 Windows 编译；本机只做离线类型核对）
// ==========================================

#[cfg(windows)]
mod gdi {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::ptr;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        AlphaBlend, CreateCompatibleDC, CreateDIBSection, CreateEllipticRgn, CreateRoundRectRgn,
        CreateRectRgn, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, FillRect, FillRgn,
        GetWindowRgn, InvalidateRect, RestoreDC, SaveDC, SelectClipRgn, SelectObject, SetBkMode,
        SetTextColor, SetWindowRgn, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS, HBITMAP, HBRUSH, HDC, HFONT,
        HGDIOBJ, HRGN,
    };
    use windows_sys::Win32::UI::Controls::WM_MOUSELEAVE;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowLongPtrW, SendMessageW, SetWindowLongPtrW, GWLP_USERDATA,
        WM_GETFONT, WM_MOUSEMOVE, WM_NCDESTROY, WM_SIZE,
    };

    use crate::ui::theme::noise::Bitmap;
    // `Tex` 从 texture 模块直接取（`tokens` 里的 `Tex` 是私有导入，不能走那条路）。
    use crate::ui::theme::texture::{self, Tex};
    use crate::ui::theme::tokens::{
        Bevel, EdgeLines, EdgeSide, Elevation, Fill, InsetLine, Layer, Rgba, Sheen,
    };

    use super::{
        bevel_bands, bitmap_dib_bytes, colorref, composite_over, dib_height, disabled_face,
        edge_bands, elevation_bands, paint_order_first_on_top, premul, rgba_from_colorref,
        sample_linear, stripe_bands, ButtonFace, ButtonRole, Rect,
    };

    // ── GDI 文本常量（windows-sys 0.52 未登记 DT_*；与 windows_chat.rs 同款就地定义）──
    const DT_CENTER: u32 = 0x0000_0001;
    const DT_VCENTER: u32 = 0x0000_0004;
    const DT_SINGLELINE: u32 = 0x0000_0020;
    const DT_NOPREFIX: u32 = 0x0000_0800;
    const DT_END_ELLIPSIS: u32 = 0x0000_8000;
    /// `SetBkMode` 的 TRANSPARENT（gdi32 的取值，windows-sys 里 `TRANSPARENT` 是 u32，API 要 i32）。
    const TRANSPARENT: i32 = 1;

    // ==========================================
    // 主题 GDI 资源缓存（线程内；UI 主线程）
    // ==========================================

    /// 一个 32bpp **顶朝下** DIB（负 `biHeight`，与 `render/win.rs` 的做法同款）。
    struct Dib {
        hdc: HDC,
        bitmap: HBITMAP,
        old: HGDIOBJ,
        bits: *mut u8,
        width: i32,
        height: i32,
        byte_len: usize,
    }

    impl Dib {
        fn new(width: i32, height: i32) -> Option<Dib> {
            if width <= 0 || height <= 0 {
                return None;
            }
            unsafe {
                let hdc = CreateCompatibleDC(0);
                if hdc == 0 {
                    return None;
                }
                // windows-sys 0.52 的 BITMAPINFO 没有 Default：先清零再写显式字段。
                let mut header: BITMAPINFO = std::mem::zeroed();
                header.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: dib_height(height as u32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..std::mem::zeroed()
                };
                let mut bits: *mut c_void = ptr::null_mut();
                let bitmap = CreateDIBSection(hdc, &header, DIB_RGB_COLORS, &mut bits, 0, 0);
                if bitmap == 0 || bits.is_null() {
                    DeleteDC(hdc);
                    return None;
                }
                let old = SelectObject(hdc, bitmap);
                let byte_len = width as usize * height as usize * 4;
                ptr::write_bytes(bits as *mut u8, 0, byte_len);
                Some(Dib {
                    hdc,
                    bitmap,
                    old,
                    bits: bits as *mut u8,
                    width,
                    height,
                    byte_len,
                })
            }
        }

        fn write(&mut self, bytes: &[u8]) {
            let n = self.byte_len.min(bytes.len());
            unsafe {
                ptr::copy_nonoverlapping(bytes.as_ptr(), self.bits, n);
            }
        }
    }

    impl Drop for Dib {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.hdc, self.old);
                DeleteObject(self.bitmap);
                DeleteDC(self.hdc);
            }
        }
    }

    #[derive(Default)]
    struct Cache {
        /// 建账时的主题代际；与新代际不符即整账作废（防「换了主题还用旧画刷」）。
        generation: u64,
        brushes: HashMap<u32, HBRUSH>,
        textures: HashMap<Tex, Dib>,
        /// 1×1 预乘 DIB（半透明纯色矩形用；逐次覆写像素，不重建）。
        solid: Option<Dib>,
        /// 1×H 预乘条（半透明竖向渐变用；高度变化才重建）。
        strip: Option<Dib>,
    }

    impl Cache {
        /// 全新建账（不能用 `..Default::default()` 的结构体更新：本类型实现了 `Drop`，
        /// 从它里面移出字段是 E0509）。
        fn fresh(generation: u64) -> Self {
            Self {
                generation,
                brushes: HashMap::new(),
                textures: HashMap::new(),
                solid: None,
                strip: None,
            }
        }
    }

    impl Drop for Cache {
        fn drop(&mut self) {
            unsafe {
                for (_, brush) in self.brushes.drain() {
                    DeleteObject(brush);
                }
            }
            // Dib 的 Drop 释放 HBITMAP / HDC。
            self.textures.clear();
            self.solid = None;
            self.strip = None;
        }
    }

    thread_local! {
        // 初值代际取不可能命中的值：首次使用必先按真实代际建账。
        static CACHE: RefCell<Cache> = RefCell::new(Cache::fresh(u64::MAX));
    }

    /// 取得当前代际的缓存；代际不符先整账释放再重建（GDI 对象不释放就是泄漏）。
    fn with_cache<R>(f: impl FnOnce(&mut Cache) -> R) -> R {
        CACHE.with(|cell| {
            let mut cache = cell.borrow_mut();
            let generation = crate::ui::theme::generation();
            if cache.generation != generation {
                *cache = Cache::fresh(generation);
            }
            f(&mut cache)
        })
    }

    /// 主动释放主题 GDI 资源（换主题时由平台广播先调用一次；下次绘制按新 token 重建）。
    pub fn release_theme_resources() {
        CACHE.with(|cell| {
            let generation = crate::ui::theme::generation();
            *cell.borrow_mut() = Cache::fresh(generation);
        });
    }

    // ==========================================
    // 填充原语
    // ==========================================

    fn win_rect(r: Rect) -> RECT {
        RECT {
            left: r.x,
            top: r.y,
            right: r.right(),
            bottom: r.bottom(),
        }
    }

    fn ch(v: f32) -> u8 {
        (v.clamp(0.0, 1.0) * 255.0).round() as u8
    }

    /// `AlphaBlend`（AC_SRC_OVER + AC_SRC_ALPHA，源是预乘 BGRA）。
    fn blend(hdc: HDC, dest: Rect, src_hdc: HDC, src: Rect, constant: u8) {
        let ftn = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: constant,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        unsafe {
            AlphaBlend(
                hdc, dest.x, dest.y, dest.w, dest.h, src_hdc, src.x, src.y, src.w, src.h, ftn,
            );
        }
    }

    /// 半透明纯色矩形：1×1 预乘 DIB 拉伸 + `AlphaBlend`。
    fn fill_alpha(hdc: HDC, rect: Rect, color: Rgba) {
        if rect.is_empty() || color.a <= 0.0 {
            return;
        }
        with_cache(|cache| {
            if cache.solid.is_none() {
                cache.solid = Dib::new(1, 1);
            }
            let Some(solid) = cache.solid.as_mut() else {
                return;
            };
            let a = ch(color.a);
            solid.write(&[
                premul(ch(color.b), a),
                premul(ch(color.g), a),
                premul(ch(color.r), a),
                a,
            ]);
            blend(hdc, rect, solid.hdc, Rect::new(0, 0, 1, 1), 255);
        });
    }

    /// 纯色填充。alpha < 1 自动改走 [`fill_alpha`]（GDI 纯色刷表达不了 alpha）。
    pub fn fill_color(hdc: HDC, rect: Rect, color: Rgba) {
        if rect.is_empty() || color.a <= 0.0 {
            return;
        }
        if color.a < 0.999 {
            fill_alpha(hdc, rect, color);
            return;
        }
        with_cache(|cache| {
            let key = colorref(color);
            let brush = match cache.brushes.get(&key) {
                Some(&brush) => brush,
                None => {
                    let brush = unsafe { CreateSolidBrush(key) };
                    cache.brushes.insert(key, brush);
                    brush
                }
            };
            let r = win_rect(rect);
            unsafe {
                FillRect(hdc, &r, brush);
            }
        });
    }

    /// 竖向渐变：逐行取样写 1×H 预乘条，再整块 `AlphaBlend` 拉伸。
    ///
    /// **不走 `GradientFill`**：见模块头「渐变」条 —— 它在窗口 DC 上会静默不写像素。
    pub fn fill_gradient(hdc: HDC, rect: Rect, stops: &[(f32, Rgba)]) {
        if rect.is_empty() || stops.is_empty() {
            return;
        }
        if stops.len() == 1 {
            fill_color(hdc, rect, stops[0].1);
            return;
        }
        gradient_fill_alpha(hdc, rect, stops);
    }

    /// 半透明竖向渐变：逐行取样写 1×H 预乘条，再整块拉伸混合。
    fn gradient_fill_alpha(hdc: HDC, rect: Rect, stops: &[(f32, Rgba)]) {
        let height = rect.h;
        with_cache(|cache| {
            let needs_new = cache
                .strip
                .as_ref()
                .map(|d| d.height != height)
                .unwrap_or(true);
            if needs_new {
                cache.strip = Dib::new(1, height);
            }
            let Some(strip) = cache.strip.as_mut() else {
                return;
            };
            let mut bytes = vec![0u8; height as usize * 4];
            for y in 0..height {
                let t = if height <= 1 {
                    0.0
                } else {
                    y as f32 / (height - 1) as f32
                };
                let color = sample_linear(stops, t);
                let a = ch(color.a);
                let i = y as usize * 4;
                bytes[i] = premul(ch(color.b), a);
                bytes[i + 1] = premul(ch(color.g), a);
                bytes[i + 2] = premul(ch(color.r), a);
                bytes[i + 3] = a;
            }
            strip.write(&bytes);
            blend(hdc, rect, strip.hdc, Rect::new(0, 0, 1, height), 255);
        });
    }

    /// `Fill` → 矩形填充（`Radial` 退化为 `base_color`；`Striped` = 渐变 + 逐条周期线）。
    pub fn fill_rect(hdc: HDC, rect: Rect, fill: &Fill) {
        match fill {
            Fill::Solid(color) => fill_color(hdc, rect, *color),
            Fill::Linear(stops) => fill_gradient(hdc, rect, stops),
            Fill::Radial { .. } => fill_color(hdc, rect, fill.base_color()),
            Fill::Striped { stops, stripes } => {
                fill_gradient(hdc, rect, stops);
                // 声明序 = 首条在最上：底层先画、首条最后画（与 `--ptex` 同规则）。
                for index in paint_order_first_on_top(stripes.len()) {
                    for band in stripe_bands(rect, &stripes[index]) {
                        fill_color(hdc, band.rect, band.color);
                    }
                }
            }
        }
    }

    /// 实心圆点（状态指示：设计稿顶栏状态位前的 `--acc` 圆点）。
    ///
    /// 用「椭圆区域 + `FillRgn`」而不是 `Ellipse`：后者要同时改 DC 的笔/刷再恢复，
    /// 这里只要一次填充，区域路线对 DC 状态的打扰更少。区域由本函数创建、
    /// `FillRgn` 后立即释放（系统不接管）。
    pub fn draw_dot(
        hdc: HDC,
        center_x: i32,
        center_y: i32,
        radius: i32,
        color: Rgba,
        backdrop: Rgba,
    ) {
        if radius <= 0 || color.a <= 0.0 {
            return;
        }
        // 区域填充没有 alpha 通路：半透明时按给定底预合成（圆点只有几像素，误差不可见）。
        let opaque = if color.a >= 0.999 {
            color
        } else {
            composite_over(color, backdrop)
        };
        unsafe {
            let region: HRGN = CreateEllipticRgn(
                center_x - radius,
                center_y - radius,
                center_x + radius,
                center_y + radius,
            );
            if region == 0 {
                return;
            }
            let brush = with_cache(|cache| {
                let key = colorref(opaque);
                match cache.brushes.get(&key) {
                    Some(&brush) => brush,
                    None => {
                        let brush = CreateSolidBrush(key);
                        cache.brushes.insert(key, brush);
                        brush
                    }
                }
            });
            FillRgn(hdc, region, brush);
            DeleteObject(region);
        }
    }

    /// 主题开关：轨道（`switch_off_*` / `switch_on_*` 的 Fill + 1px 边）+ 滑块。
    ///
    /// 开/关两态由调用方状态表给出（ownerdraw BUTTON 不承载 `BM_SETCHECK` 语义）；
    /// 禁用态按 45% 叠到轨道底预合成（`FillRgn` 无 alpha 通路，同 [`draw_dot`]）。
    /// 滑块用 [`draw_dot`] 的圆盘近似（设计滑块 13×13 + 半高圆角 = 圆形）。
    pub fn draw_switch(hdc: HDC, rect: Rect, on: bool, disabled: bool) {
        if rect.is_empty() {
            return;
        }
        let t = crate::ui::theme::tokens();
        let (track, edge) = if on {
            (t.switch_on_bg, t.switch_on_edge)
        } else {
            (t.switch_off_bg, t.switch_off_edge)
        };
        fill_rect(hdc, rect, &track);
        draw_frame(hdc, rect, edge, &Bevel::NONE);
        let knob_rect = super::switch_knob_rect(rect, on);
        let knob = t.switch_knob.base_color();
        let knob = if disabled {
            composite_over(knob.with_alpha(knob.a * 0.45), track.base_color())
        } else {
            knob
        };
        draw_dot(
            hdc,
            knob_rect.x + knob_rect.w / 2,
            knob_rect.y + knob_rect.h / 2,
            (knob_rect.w / 2).max(1),
            knob,
            track.base_color(),
        );
    }

    /// `Sheen` 纹理层：声明序 = CSS 多背景序，**首层在最上**（最后画）。
    pub fn draw_sheen(hdc: HDC, rect: Rect, sheen: &Sheen) {
        for index in paint_order_first_on_top(sheen.0.len()) {
            match &sheen.0[index] {
                Layer::Grad(stops) => fill_gradient(hdc, rect, stops),
                Layer::Stripes(stripes) => {
                    for index in paint_order_first_on_top(stripes.len()) {
                        for band in stripe_bands(rect, &stripes[index]) {
                            fill_color(hdc, band.rect, band.color);
                        }
                    }
                }
                Layer::Tex { tex, alpha } => draw_texture(hdc, rect, *tex, *alpha),
                Layer::Edge { side, color, width } => {
                    let line = InsetLine::hard(*color, *width);
                    for band in edge_bands(&line, rect, *side) {
                        fill_color(hdc, band.rect, band.color);
                    }
                }
            }
        }
    }

    /// `Bevel` 内立体线：声明序 = CSS 多笔阴影序，首条最后画、盖在后面的线上。
    pub fn draw_bevel(hdc: HDC, rect: Rect, bevel: &Bevel) {
        for band in bevel_bands(bevel, rect).into_iter().rev() {
            fill_color(hdc, band.rect, band.color);
        }
    }

    /// 单线入口：一条 [`InsetLine`]（`top` 决定贴顶/底）或一个 [`Bevel`]
    /// （各线自带侧别与顺序，`top` 被忽略）。
    pub fn draw_inset(hdc: HDC, rect: Rect, line: impl Into<EdgeLines>, top: bool) {
        let bands = match line.into() {
            EdgeLines::Single(line) => {
                let side = if top { EdgeSide::Top } else { EdgeSide::Bottom };
                edge_bands(&line, rect, side)
            }
            EdgeLines::Stack(bevel) => bevel_bands(&bevel, rect),
        };
        for band in bands.into_iter().rev() {
            fill_color(hdc, band.rect, band.color);
        }
    }

    /// `Elevation` 投影近似（均匀半透明矩形；GDI 无模糊，见模块头）。
    pub fn draw_elevation(hdc: HDC, rect: Rect, elevation: &Elevation) {
        for band in elevation_bands(elevation, rect) {
            fill_color(hdc, band.rect, band.color);
        }
    }

    /// 卡片/气泡外框：1px 描边 + 内侧立体线（承载控件按 2px 内缩，两条线才露得出来）。
    pub fn draw_frame(hdc: HDC, rect: Rect, edge: Rgba, bevel: &Bevel) {
        if rect.is_empty() {
            return;
        }
        if rect.w >= 4 && rect.h >= 4 {
            fill_color(hdc, Rect::new(rect.x, rect.y, rect.w, 1), edge);
            fill_color(hdc, Rect::new(rect.x, rect.bottom() - 1, rect.w, 1), edge);
            fill_color(hdc, Rect::new(rect.x, rect.y + 1, 1, rect.h - 2), edge);
            fill_color(
                hdc,
                Rect::new(rect.right() - 1, rect.y + 1, 1, rect.h - 2),
                edge,
            );
        } else {
            fill_color(hdc, rect, edge);
        }
        draw_bevel(hdc, rect.deflate(1), bevel);
    }

    /// 纹理平铺（`Grain` / `Verdigris`）；`alpha` 是整层的额外透明度（`SourceConstantAlpha`）。
    pub fn draw_texture(hdc: HDC, rect: Rect, tex: Tex, alpha: f32) {
        if rect.is_empty() || alpha <= 0.0 {
            return;
        }
        let constant = ch(alpha);
        if constant == 0 {
            return;
        }
        with_cache(|cache| {
            if !cache.textures.contains_key(&tex) {
                let bitmap = texture::get(tex);
                if let Some(dib) = dib_from_bitmap(&bitmap) {
                    cache.textures.insert(tex, dib);
                }
            }
            let Some(dib) = cache.textures.get(&tex) else {
                return;
            };
            let (tile_w, tile_h) = (dib.width, dib.height);
            let mut y = rect.y;
            while y < rect.bottom() {
                let h = tile_h.min(rect.bottom() - y);
                let mut x = rect.x;
                while x < rect.right() {
                    let w = tile_w.min(rect.right() - x);
                    blend(
                        hdc,
                        Rect::new(x, y, w, h),
                        dib.hdc,
                        Rect::new(0, 0, w, h),
                        constant,
                    );
                    x += tile_w;
                }
                y += tile_h;
            }
        });
    }

    fn dib_from_bitmap(bitmap: &Bitmap) -> Option<Dib> {
        let mut dib = Dib::new(bitmap.width as i32, bitmap.height as i32)?;
        dib.write(&bitmap_dib_bytes(bitmap));
        Some(dib)
    }

    // ==========================================
    // ownerdraw 按钮
    // ==========================================

    /// ownerdraw 按钮绘制（聊天窗与主窗顶栏共用；字体从控件自己的 `WM_GETFONT` 取）。
    pub fn draw_button(
        hdc: HDC,
        hwnd: HWND,
        rect: Rect,
        face: &ButtonFace,
        label: &str,
        pressed: bool,
        disabled: bool,
    ) {
        if rect.is_empty() {
            return;
        }
        // 禁用态：底 + 标题都降 50%（macOS `style_button` 的口径）。
        // GDI 没有 alpha：底是「实色 fill 画满后叠一层 50% 面板底」，标题是预合成
        // 实色（见 [`disabled_face`]）—— 只降标题色的旧口径对比度 ~2:1，像「配色
        // 错了的可用按钮」（评审实机证据 2026-10-05）。
        let disabled_state = if disabled {
            Some(disabled_face(
                face,
                crate::ui::theme::tokens().panel_bg.base_color(),
            ))
        } else {
            None
        };
        // 投影先画（先影后物）：交叠部分由按钮自己盖住，只露外面一圈。
        draw_elevation(hdc, rect, &face.shadow);
        if let Some(bg) = &face.bg {
            fill_rect(hdc, rect, bg);
        } else {
            // 无底角色（`TabOff` / `Link`）：系统会先把 ownerdraw 控件擦成**默认按钮面**
            // （浅灰/白块），所以「无底」不能真的不画 —— 必须显式盖回它坐在哪层底上，
            // 否则实机看到的就是把手带 ▴ 与未选中会话标签上的「莫名其妙的白底」
            // （用户 2026-10-07 实拍）。`bg_base` 在无底角色上就是「条底压面板底」的
            // 代表色，正是这层表面色。
            // 调用方记过表面色就用它（顶栏/把手带的底色与 `bg_base` 不同）。
            fill_color(hdc, rect, surface_color_of(hwnd).unwrap_or(face.bg_base));
        }
        if let Some(state) = &disabled_state {
            // 50% 面板底「冲洗」压在实色 fill 上：等价于 mix(fill, 面板底, 50%)。
            fill_color(hdc, rect, state.wash);
        }
        if let Some(edge) = face.edge {
            draw_frame(hdc, rect, edge, &face.bevel.unwrap_or(Bevel::NONE));
        } else if let Some(bevel) = &face.bevel {
            draw_bevel(hdc, rect, bevel);
        }
        if let Some(overlay) = face.overlay {
            fill_color(hdc, rect, overlay);
        }
        let font = unsafe { SendMessageW(hwnd, WM_GETFONT, 0, 0) } as HFONT;
        let old = if font != 0 {
            unsafe { SelectObject(hdc, font) }
        } else {
            0
        };
        let text = wide(label);
        let shift = i32::from(pressed);
        let base = disabled_state
            .as_ref()
            .map(|state| state.washed_base)
            .unwrap_or(face.bg_base);
        let ink = disabled_state
            .as_ref()
            .map(|state| state.ink)
            .unwrap_or(face.ink);
        let flags = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS;
        unsafe {
            SetBkMode(hdc, TRANSPARENT);
            if let Some(shadow) = face.text_shadow {
                let dy = shadow.dy.round() as i32 + shift;
                let mut r = win_rect(rect.offset(shift, dy));
                SetTextColor(hdc, colorref(composite_over(shadow.color, base)));
                DrawTextW(hdc, text.as_ptr(), -1, &mut r, flags);
            }
            let mut r = win_rect(rect.offset(shift, shift));
            SetTextColor(hdc, colorref(ink));
            DrawTextW(hdc, text.as_ptr(), -1, &mut r, flags);
            if old != 0 {
                SelectObject(hdc, old);
            }
        }
    }

    /// 单面顶栏的条内入口（设置 /「×」）：直接画在条面上，**无面时什么都不画**。
    ///
    /// 顶栏不再用子控件承载这些入口 —— 子窗口是不透明表面，条底渐变透不过来
    /// （实机症状：STATIC 白板 + 按钮深色方板，2026-10-07）。与 [`draw_button`]
    /// 的差异：
    /// - 无底角色**不补表面色**：面就是条底本身，什么都不画即为正确；
    /// - 圆角走 **DC 剪切区域**（`SelectClipRgn`，只作用于本次绘制、随 `RestoreDC`
    ///   复原），不依赖窗口区域 `SetWindowRgn`（实机观察到窗口区域未生效，见
    ///   `apply_round_region` 的失败留痕）；
    /// - 省略文字投影：条内角色（`TabOff` / `Close`）的 `text_shadow` 都是 `None`。
    pub fn draw_bar_entry(
        hdc: HDC,
        rect: Rect,
        face: &ButtonFace,
        label: &str,
        font: HFONT,
        pressed: bool,
        radius_px: i32,
    ) {
        if rect.is_empty() {
            return;
        }
        let saved = unsafe { SaveDC(hdc) };
        let mut region: HRGN = 0;
        if radius_px > 0 {
            let r = radius_px.min(rect.w / 2).min(rect.h / 2).max(1);
            region = unsafe {
                CreateRoundRectRgn(
                    rect.x,
                    rect.y,
                    rect.right() + 1,
                    rect.bottom() + 1,
                    r * 2,
                    r * 2,
                )
            };
            if region != 0 {
                unsafe { SelectClipRgn(hdc, region) };
            }
        }
        if let Some(bg) = &face.bg {
            fill_rect(hdc, rect, bg);
        }
        if let Some(edge) = face.edge {
            draw_frame(hdc, rect, edge, &face.bevel.unwrap_or(Bevel::NONE));
        } else if let Some(bevel) = &face.bevel {
            draw_bevel(hdc, rect, bevel);
        }
        if let Some(overlay) = face.overlay {
            fill_color(hdc, rect, overlay);
        }
        let old = if font != 0 {
            unsafe { SelectObject(hdc, font) }
        } else {
            0
        };
        let text = wide(label);
        let shift = i32::from(pressed);
        let flags = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS;
        unsafe {
            SetBkMode(hdc, TRANSPARENT);
            let mut r = win_rect(rect.offset(shift, shift));
            SetTextColor(hdc, colorref(face.ink));
            DrawTextW(hdc, text.as_ptr(), -1, &mut r, flags);
            if old != 0 {
                SelectObject(hdc, old);
            }
        }
        // 先复原 DC（把区域从 DC 上摘下）再释放句柄：`SelectClipRgn` 不复制区域，
        // 提前释放会让 DC 拖着悬空句柄。
        if saved != 0 {
            unsafe { RestoreDC(hdc, saved) };
        }
        if region != 0 {
            unsafe { DeleteObject(region) };
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `WM_CTLCOLORSTATIC` 的返回画刷（缓存复用；画刷无 alpha，调用方传已定色）。
    pub fn solid_brush(color: Rgba) -> HBRUSH {
        with_cache(|cache| {
            let key = colorref(color);
            match cache.brushes.get(&key) {
                Some(&brush) => brush,
                None => {
                    let brush = unsafe { CreateSolidBrush(key) };
                    cache.brushes.insert(key, brush);
                    brush
                }
            }
        })
    }

    /// 记录控件字色（`GWLP_USERDATA`；alpha 忽略）。
    ///
    /// 约定：按钮角色占低 24 位（[`ButtonRole`] 的小整数），STATIC 字色把 bit24 置 1
    /// 后存 COLORREF。两类控件互不读取对方的存储，天然隔离。
    pub fn set_text_color(hwnd: HWND, color: Rgba) {
        if hwnd == 0 {
            return;
        }
        let stored = (colorref(color) as isize) | TEXT_COLOR_MARK;
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, stored) };
    }

    /// 读回控件字色；从未写过 → `None`（调用方兜底 `tokens().ink`）。
    pub fn text_color_of(hwnd: HWND) -> Option<Rgba> {
        if hwnd == 0 {
            return None;
        }
        let raw = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) };
        if raw & TEXT_COLOR_MARK == 0 {
            None
        } else {
            Some(rgba_from_colorref((raw & 0x00FF_FFFF) as u32))
        }
    }

    /// 记录按钮角色（`WM_DRAWITEM` 时读回）。
    pub fn set_role(hwnd: HWND, role: ButtonRole) {
        if hwnd == 0 {
            return;
        }
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, role.code() as isize) };
    }

    pub fn role_of(hwnd: HWND) -> ButtonRole {
        if hwnd == 0 {
            return ButtonRole::Normal;
        }
        let raw = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as usize;
        ButtonRole::from_code(raw)
    }

    // ── 悬浮跟踪 + 圆角（ownerdraw 按钮的子类；只装在我们的按钮上）──

    const TEXT_COLOR_MARK: isize = 1 << 24;
    /// 子类 id（控件内唯一；输入框子类用的是 1，且不在同一控件上，互不影响）。
    const BUTTON_SUBCLASS_ID: usize = 0x57_54;

    thread_local! {
        static HOVERED: RefCell<HashSet<HWND>> = RefCell::new(HashSet::new());
        /// 「这个控件坐在哪一层底色上」（无底角色的自绘底用）。
        ///
        /// ownerdraw 控件在 `WM_DRAWITEM` 之前会被系统按**默认按钮面**擦一遍，
        /// 而底色是渐变或条底时，返回实色刷子照样补出一块异色板 —— 用户实拍的
        /// 「莫名其妙的白底白框」就是这个。所以：**绘制端**读这里的表面色把底
        /// 盖回去（顶栏条内入口已改单面绘制、不走这条路，见 `windows_main.rs`）。
        static SURFACE_COLORS: RefCell<HashMap<HWND, Rgba>> = RefCell::new(HashMap::new());
    }

    /// 记录控件所在的表面底色（无底按钮的「底」；`WM_NCDESTROY` 时自动清除）。
    pub fn set_surface_color(hwnd: HWND, color: Rgba) {
        if hwnd == 0 {
            return;
        }
        SURFACE_COLORS.with(|cell| {
            cell.borrow_mut().insert(hwnd, color);
        });
    }

    /// 读回控件所在表面底色；从未写过 → `None`（绘制端回落 `bg_base`）。
    pub fn surface_color_of(hwnd: HWND) -> Option<Rgba> {
        SURFACE_COLORS.with(|cell| cell.borrow().get(&hwnd).copied())
    }

    pub fn button_hovered(hwnd: HWND) -> bool {
        HOVERED.with(|set| set.borrow().contains(&hwnd))
    }

    /// 把按钮接上主题绘制：悬浮跟踪 + 圆角区域（半径物理像素；0 = 不裁圆角）。
    pub fn install_button(hwnd: HWND, radius_px: i32) {
        if hwnd == 0 {
            return;
        }
        unsafe {
            SetWindowSubclass(
                hwnd,
                Some(button_subclass_proc),
                BUTTON_SUBCLASS_ID,
                radius_px.max(0) as usize,
            );
        }
        apply_round_region(hwnd, radius_px);
    }

    /// 圆角区域（随 `WM_SIZE` 重设；尺寸没变时重复设置是幂等开销，可接受）。
    fn apply_round_region(hwnd: HWND, radius_px: i32) {
        if hwnd == 0 || radius_px <= 0 {
            return;
        }
        unsafe {
            let mut rect: RECT = std::mem::zeroed();
            if GetClientRect(hwnd, &mut rect) == 0 {
                return;
            }
            let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
            if w <= 0 || h <= 0 {
                return;
            }
            let r = radius_px.min(w / 2).min(h / 2).max(1);
            let region: HRGN = CreateRoundRectRgn(0, 0, w + 1, h + 1, r * 2, r * 2);
            if region == 0 {
                return;
            }
            // 成功时区域归系统所有；失败时还归我们，必须自己释放（漏 = GDI 句柄泄漏）。
            if SetWindowRgn(hwnd, region, 1) == 0 {
                // 实机诊断（2026-10-07）：区域被系统拒绝时控件按直角渲染。本轮实机
                // 观察到所有 ownerdraw 按钮圆角整体失效（发送/会话标签/顶栏按钮全
                // 直角）；这一行把「API 拒绝」与「区域生效但绘制端没吃它」切开，
                // 实机日志一读即可定案。
                crate::rust_warn!("按钮圆角区域被系统拒绝（hwnd={hwnd}），本次按直角渲染");
                DeleteObject(region);
            } else {
                // 一次性实机探针（2026-10-07，**读到一行即定案、随后删除**）：
                // 「区域被接受、按钮却仍是直角」时要区分「区域被系统丢掉」与
                // 「区域在、绘制端没吃它」。只探第一只控件，避免 WM_SIZE 风暴刷屏。
                // 读法：2/3 = 区域在（SIMPLEREGION/COMPLEXREGION）；1 = NULLREGION
                //（没保住）；0 = ERROR。
                static PROBED: std::sync::atomic::AtomicBool =
                    std::sync::atomic::AtomicBool::new(false);
                if !PROBED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    let probe: HRGN = CreateRectRgn(0, 0, 1, 1);
                    if probe != 0 {
                        let kind = GetWindowRgn(hwnd, probe);
                        DeleteObject(probe);
                        crate::rust_info!(
                            "圆角区域实机探针（一次性）：hwnd={hwnd} GetWindowRgn={kind}（2=SIMPLEREGION / 3=COMPLEXREGION / 1=NULLREGION / 0=ERROR）"
                        );
                    }
                }
            }
        }
    }

    unsafe extern "system" fn button_subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        refdata: usize,
    ) -> LRESULT {
        match msg {
            WM_MOUSEMOVE => {
                let first = HOVERED.with(|set| set.borrow_mut().insert(hwnd));
                if first {
                    unsafe { InvalidateRect(hwnd, ptr::null(), 1) };
                }
                // TrackMouseEvent 是一次性的：每次移动都重新登记离开通知。
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                unsafe { TrackMouseEvent(&mut track) };
            }
            WM_MOUSELEAVE => {
                let removed = HOVERED.with(|set| set.borrow_mut().remove(&hwnd));
                if removed {
                    unsafe { InvalidateRect(hwnd, ptr::null(), 1) };
                }
            }
            WM_SIZE => apply_round_region(hwnd, refdata as i32),
            WM_NCDESTROY => {
                HOVERED.with(|set| {
                    set.borrow_mut().remove(&hwnd);
                });
                // 表面色按句柄记账：控件销毁时必须一起销账（句柄会被复用，
                // 留着会让下一个控件继承上一个的底）。
                SURFACE_COLORS.with(|cell| {
                    cell.borrow_mut().remove(&hwnd);
                });
                unsafe {
                    RemoveWindowSubclass(hwnd, Some(button_subclass_proc), BUTTON_SUBCLASS_ID)
                };
            }
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }
}

#[cfg(windows)]
pub use gdi::*;

// ==========================================
// 纯逻辑单测（在 macOS 上真跑）
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::theme::tokens::{InsetLine, Layer, Stripe, ThemeId};

    /// 开关滑块几何：关态贴左、开态贴右（32×17 → 13×13，距外缘 2px）。
    #[test]
    fn 开关滑块几何换边() {
        let rect = Rect::new(0, 0, 32, 17);
        let off = switch_knob_rect(rect, false);
        assert_eq!((off.x, off.y, off.w, off.h), (2, 2, 13, 13), "关态贴左");
        let on = switch_knob_rect(rect, true);
        assert_eq!((on.x, on.y, on.w, on.h), (17, 2, 13, 13), "开态贴右");
        // 过矮轨道：滑块收缩且不越出轨道（右缘 = 宽 - 2）。
        let squat = switch_knob_rect(Rect::new(0, 0, 32, 8), true);
        assert!(
            squat.x >= 2 && squat.x + squat.w <= 30,
            "过矮轨道不越界: {squat:?}"
        );
        let squat_off = switch_knob_rect(Rect::new(0, 0, 32, 8), false);
        assert_eq!(squat_off.x, 2, "过矮轨道关态仍贴左");
    }

    // `Fill` 的 stop 表是 `&'static`：测试里必须用 static 承载（临时量不会做常量提升）。
    static LINEAR_STOPS: [(f32, Rgba); 2] =
        [(0.0, Rgba::hex(0xAA_AA_AA)), (1.0, Rgba::hex(0xBB_BB_BB))];
    static STRIPED_STOPS: [(f32, Rgba); 2] =
        [(0.0, Rgba::hex(0xCC_CC_CC)), (1.0, Rgba::hex(0xDD_DD_DD))];
    static RADIAL_STOPS: [(f32, Rgba); 2] =
        [(0.0, Rgba::hex(0x01_02_03)), (1.0, Rgba::hex(0x0A_0B_0C))];
    static EMPTY_STOPS: [(f32, Rgba); 0] = [];

    #[test]
    fn colorref_是_bgr_字节序() {
        assert_eq!(
            colorref(Rgba::rgb(1.0, 0.0, 0.0)),
            0x0000_00FF,
            "红必须在最末字节"
        );
        assert_eq!(colorref(Rgba::rgb(0.0, 1.0, 0.0)), 0x0000_FF00);
        assert_eq!(colorref(Rgba::rgb(0.0, 0.0, 1.0)), 0x00FF_0000, "蓝在高位");
        assert_eq!(colorref(Rgba::hex(0x12_34_56)), 0x0056_3412);
    }

    #[test]
    fn colorref_忽略_alpha_且边界收敛() {
        let red = Rgba::hex(0xFF0000);
        assert_eq!(
            colorref(red.with_alpha(0.0)),
            colorref(red),
            "纯色无 alpha 语义"
        );
        assert_eq!(colorref(red.with_alpha(1.0)), 0x0000_00FF);
        // R=-1→0、G=2→255、B=0.5→128 ⇒ 0xBBGGRR = 0x80_FF_00。
        assert_eq!(
            colorref(Rgba::rgb(-1.0, 2.0, 0.5)),
            0x0080_FF00,
            "越界分量收敛到 0/255"
        );
    }

    #[test]
    fn rgba_colorref_往返() {
        for value in [0x0000_0000u32, 0x0012_3456, 0x00FF_FFFF] {
            assert_eq!(colorref(rgba_from_colorref(value)), value);
        }
    }

    /// `Fill::base_color` 三变体的兜底：Linear/Striped 取首档、Radial 取末档、空表给黑。
    #[test]
    fn base_color_三变体兜底取值() {
        let solid = Fill::Solid(Rgba::hex(0x112233));
        assert_eq!(solid.base_color(), Rgba::hex(0x112233));

        let linear = Fill::Linear(&LINEAR_STOPS);
        assert_eq!(linear.base_color(), Rgba::hex(0xAA_AA_AA), "线性取首档");

        let striped = Fill::Striped {
            stops: &STRIPED_STOPS,
            stripes: &[],
        };
        assert_eq!(striped.base_color(), Rgba::hex(0xCC_CC_CC), "条纹底取首档");

        let radial = Fill::Radial {
            cx: 0.5,
            cy: 0.5,
            rx: 1.0,
            ry: 1.0,
            stops: &RADIAL_STOPS,
        };
        assert_eq!(radial.base_color(), Rgba::hex(0x0A_0B_0C), "径向取末档");

        let empty = Fill::Linear(&EMPTY_STOPS);
        assert_eq!(
            empty.base_color(),
            Rgba::black_alpha(1.0),
            "空表兜底为不透明黑"
        );
    }

    #[test]
    fn 合成_alpha_边界() {
        let opaque_bg = Rgba::hex(0x000000);
        let half_white = Rgba::white_alpha(0.5);
        let mixed = composite_over(half_white, opaque_bg);
        assert!((mixed.r - 0.5).abs() < 0.01 && mixed.a == 1.0);

        // 完全透明的前景 = 底色原样。
        let mut fg = half_white;
        fg.a = 0.0;
        assert_eq!(composite_over(fg, opaque_bg), opaque_bg);
    }

    #[test]
    fn 条纹_周期与裁剪() {
        let stripe = Stripe {
            period: 4.0,
            line: 1.0,
            color: Rgba::white_alpha(0.5),
        };
        let bands = stripe_bands(Rect::new(0, 0, 10, 10), &stripe);
        let ys: Vec<i32> = bands.iter().map(|b| b.rect.y).collect();
        assert_eq!(ys, vec![0, 4, 8], "每 4px 一条");
        assert!(bands.iter().all(|b| b.rect.h == 1 && b.rect.w == 10));

        // 末尾条裁到矩形内。
        let stripe7 = Stripe {
            period: 7.0,
            line: 3.0,
            color: Rgba::white_alpha(0.5),
        };
        let bands = stripe_bands(Rect::new(0, 0, 4, 8), &stripe7);
        assert_eq!(bands.len(), 2);
        assert_eq!(bands[0].rect, Rect::new(0, 0, 4, 3));
        assert_eq!(
            bands[1].rect,
            Rect::new(0, 7, 4, 1),
            "最后一条被裁到矩形底边"
        );

        // 起点不在 0 的矩形（画在任意位置）也按顶边对齐。
        let bands = stripe_bands(Rect::new(5, 10, 2, 9), &stripe7);
        assert_eq!(bands[0].rect.y, 10);
        assert_eq!(bands[1].rect.y, 17);

        // 周期小于线宽：线宽收敛为一整个周期，不重叠成死循环（末条仍裁到矩形内）。
        let dense = Stripe {
            period: 2.0,
            line: 7.0,
            color: Rgba::white_alpha(0.5),
        };
        let bands = stripe_bands(Rect::new(0, 0, 1, 5), &dense);
        assert_eq!(
            bands.iter().map(|b| b.rect.y).collect::<Vec<_>>(),
            vec![0, 2, 4]
        );
        assert_eq!(
            bands.iter().map(|b| b.rect.h).collect::<Vec<_>>(),
            vec![2, 2, 1]
        );
    }

    #[test]
    fn 条纹_非法参数不画() {
        let rect = Rect::new(0, 0, 10, 10);
        assert!(stripe_bands(
            rect,
            &Stripe {
                period: 0.0,
                line: 1.0,
                color: Rgba::white_alpha(1.0)
            }
        )
        .is_empty());
        assert!(stripe_bands(
            rect,
            &Stripe {
                period: 4.0,
                line: 0.0,
                color: Rgba::white_alpha(1.0)
            }
        )
        .is_empty());
        assert!(stripe_bands(
            rect,
            &Stripe {
                period: 4.0,
                line: 1.0,
                color: Rgba::white_alpha(0.0)
            }
        )
        .is_empty());
        assert!(stripe_bands(
            Rect::new(0, 0, 0, 10),
            &Stripe {
                period: 4.0,
                line: 1.0,
                color: Rgba::white_alpha(1.0)
            }
        )
        .is_empty());
    }

    #[test]
    fn bevel_缺项不画线_有线宽正确() {
        let rect = Rect::new(0, 0, 100, 50);
        assert!(bevel_bands(&Bevel::NONE, rect).is_empty(), "没有线就不该画");

        // `lines` 是 `&'static`：测试里用 static 承载（临时量不做常量提升）。
        static TOP_ONLY: [BevelLine; 1] = [BevelLine::top(InsetLine::hard(
            Rgba::white_alpha(0.15),
            1.0,
        ))];
        static WIDE: [BevelLine; 2] = [
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.2), 2.0)),
            BevelLine::bottom(InsetLine::hard(Rgba::black_alpha(0.5), 1.0)),
        ];

        let top = Bevel { lines: &TOP_ONLY };
        let bands = bevel_bands(&top, rect);
        assert_eq!(bands.len(), 1);
        assert_eq!(bands[0].rect, Rect::new(0, 0, 100, 1), "顶线贴顶边、1px");
        assert_eq!(bands[0].color.a, 0.15, "硬线不动 alpha");

        let wide = Bevel { lines: &WIDE };
        let bands = bevel_bands(&wide, rect);
        assert_eq!(bands.len(), 2);
        assert_eq!(bands[0].rect, Rect::new(0, 0, 100, 2));
        assert_eq!(bands[1].rect, Rect::new(0, 49, 100, 1), "底线贴底边");
        assert_eq!(
            bevel_bands(&wide, Rect::new(0, 0, 100, 0)).len(),
            0,
            "空矩形不画"
        );
    }

    /// 左右两侧的线：占满全高、贴在对应纵边；左/右方向只影响位置，不受「上下」影响。
    #[test]
    fn 边缘线_左右两侧贴边() {
        let rect = Rect::new(10, 20, 100, 50);
        let line = InsetLine::hard(Rgba::black_alpha(0.55), 1.0);
        assert_eq!(
            edge_bands(&line, rect, EdgeSide::Left)[0].rect,
            Rect::new(10, 20, 1, 50),
            "左边线贴 x = 0、占满全高"
        );
        assert_eq!(
            edge_bands(&line, rect, EdgeSide::Right)[0].rect,
            Rect::new(109, 20, 1, 50),
            "右边线贴 x = right - width"
        );
        // 软边的递减带沿横向推进（不是往下）。
        let soft = InsetLine::soft(Rgba::black_alpha(0.6), 1.0, 6.0);
        let bands = edge_bands(&soft, rect, EdgeSide::Right);
        assert!(bands.len() > 1, "软边应有递减带");
        assert_eq!(bands[1].rect, Rect::new(108, 20, 1, 50), "递减带向左推进");
    }

    /// 内环展开为四条互不重叠的边线：竖线只占横线之间的高度，角上不二次合成。
    #[test]
    fn 内环四条不重叠() {
        let rect = Rect::new(0, 0, 100, 50);
        let line = InsetLine::hard(Rgba::white_alpha(0.55), 1.0);
        let bands = ring_bands(&line, rect);
        assert_eq!(bands.len(), 4, "上、下、左、右各一条");
        assert_eq!(bands[0].rect, Rect::new(0, 0, 100, 1));
        assert_eq!(bands[1].rect, Rect::new(0, 49, 100, 1));
        assert_eq!(bands[2].rect, Rect::new(0, 1, 1, 48), "左边线避开上下两条");
        assert_eq!(bands[3].rect, Rect::new(99, 1, 1, 48), "右边线同理");
        for (index, band) in bands.iter().enumerate() {
            for other in bands.iter().skip(index + 1) {
                let overlap = band.rect.x < other.rect.right()
                    && other.rect.x < band.rect.right()
                    && band.rect.y < other.rect.bottom()
                    && other.rect.y < band.rect.bottom();
                assert!(
                    !overlap,
                    "内环的边线不许互相重叠：{:?} vs {:?}",
                    band.rect, other.rect
                );
            }
        }
    }

    /// 绘制顺序：声明序 = CSS 多背景序，首项最后画（在最上）—— 纹理层与条纹共用。
    #[test]
    fn 纹理层绘制顺序_首项最后画() {
        assert_eq!(paint_order_first_on_top(1).collect::<Vec<_>>(), vec![0]);
        assert_eq!(
            paint_order_first_on_top(3).collect::<Vec<_>>(),
            vec![2, 1, 0]
        );
        // 三套主题都按同一序；首层索引在绘制序里必须排最后。
        for id in ThemeId::ALL {
            let sheen = id.tokens().panel_tex.expect("三套主题都有面板纹理");
            let order: Vec<usize> = paint_order_first_on_top(sheen.0.len()).collect();
            assert_eq!(order.last(), Some(&0), "{id:?} 首层应最后画（在最上）");
            assert_eq!(order.len(), sheen.0.len());
        }
        // 合并进一个 `Layer::Stripes` 的多条条纹也要按同一规则逐条排。
        for id in ThemeId::ALL {
            let sheen_id = id.tokens().panel_tex.expect("三套主题都有面板纹理");
            for layer in sheen_id.0 {
                if let Layer::Stripes(stripes) = layer {
                    let order: Vec<usize> = paint_order_first_on_top(stripes.len()).collect();
                    assert_eq!(order.last(), Some(&0), "{id:?} 首条条纹应最后画（在最上）");
                }
            }
        }
    }

    #[test]
    fn bevel_模糊退化为降_alpha_的实线() {
        let rect = Rect::new(0, 0, 40, 40);
        let hard = InsetLine::hard(Rgba::black_alpha(0.6), 1.0);
        let soft = InsetLine::soft(Rgba::black_alpha(0.6), 1.0, 6.0);
        let hard_bands = edge_bands(&hard, rect, EdgeSide::Top);
        let soft_bands = edge_bands(&soft, rect, EdgeSide::Top);
        assert_eq!(hard_bands.len(), 1, "hard 只有主带");
        assert_eq!(soft_bands.len(), 4, "主带 + 3 条递减带（blur 6 → 3 环）");
        assert!(
            soft_bands[0].color.a < hard_bands[0].color.a,
            "软边主带 alpha 必须降低"
        );
        // 递减带：越靠内越淡，且都比主带淡。
        assert!(soft_bands[1].color.a > soft_bands[2].color.a);
        assert!(soft_bands[2].color.a > soft_bands[3].color.a);
        assert_eq!(soft_bands[1].rect.y, 1, "第一条递减带紧贴主带内侧");
        assert!(soft_bands[3].color.a < soft_bands[0].color.a);
    }

    #[test]
    fn 投影_偏移扩散与负扩散() {
        let rect = Rect::new(10, 20, 100, 50);
        let contact = Shadow {
            dy: 1.0,
            blur: 2.0,
            spread: 0.0,
            color: Rgba::black_alpha(0.3),
        };
        let bands = elevation_bands(
            &Elevation {
                contact: Some(contact),
                ambient: None,
            },
            rect,
        );
        assert_eq!(bands.len(), 1);
        assert_eq!(
            bands[0].rect,
            Rect::new(10, 21, 100, 50),
            "dy 下移、spread 0 不变宽"
        );

        let ambient = Shadow {
            dy: 10.0,
            blur: 24.0,
            spread: -14.0,
            color: Rgba::black_alpha(0.55),
        };
        let bands = elevation_bands(
            &Elevation {
                contact: None,
                ambient: Some(ambient),
            },
            rect,
        );
        // 负 spread = 四周内缩 14（x+14、y+14），再按 dy=10 下移 ⇒ y = 20 + 14 + 10 = 44。
        assert_eq!(
            bands[0].rect,
            Rect::new(24, 44, 72, 22),
            "负 spread 内缩、dy 下移"
        );

        assert!(elevation_bands(&Elevation::NONE, rect).is_empty());
    }

    /// **行序钉子**：Bitmap 第 0 行（顶行）原样落在 DIB 缓冲开头，配合负 `biHeight`
    /// 的顶朝下声明，GDI 渲染不会上下翻转。改成正高度就必须翻转行序。
    #[test]
    fn 位图_dib_行序与负高度声明() {
        let mut pixels = vec![0u8; 2 * 2 * 4];
        // 第 0 行（顶）：两个不透明像素；第 1 行（底）：两个不透明像素。
        pixels[0..4].copy_from_slice(&[10, 20, 30, 255]); // (0,0) RGBA
        pixels[4..8].copy_from_slice(&[40, 50, 60, 255]); // (1,0)
        pixels[8..12].copy_from_slice(&[70, 80, 90, 255]); // (0,1)
        pixels[12..16].copy_from_slice(&[100, 110, 120, 255]); // (1,1)
        let bitmap = Bitmap {
            width: 2,
            height: 2,
            pixels,
        };

        let bytes = bitmap_dib_bytes(&bitmap);
        assert_eq!(
            &bytes[0..4],
            &[30, 20, 10, 255],
            "缓冲开头 = 位图顶行左像素（BGRA）"
        );
        assert_eq!(&bytes[4..8], &[60, 50, 40, 255]);
        assert_eq!(
            &bytes[8..12],
            &[90, 80, 70, 255],
            "第 2 行紧随其后：顶朝下，不翻转"
        );
        assert_eq!(&bytes[12..16], &[120, 110, 100, 255]);

        assert_eq!(dib_height(2), -2, "DIB 必须声明为负高度（顶朝下）");
        assert!(dib_height(640) < 0);
    }

    #[test]
    fn 位图_dib_预乘与尺寸() {
        let bitmap = Bitmap {
            width: 1,
            height: 1,
            pixels: vec![255, 128, 0, 128], // R=255 G=128 B=0 A=128
        };
        let bytes = bitmap_dib_bytes(&bitmap);
        assert_eq!(bytes.len(), 4);
        assert_eq!(bytes, vec![0, 64, 128, 128], "B=A=0 参与预乘，R 减半");
    }

    /// 命中口径：右/下开区间（与 GDI `PtInRect` 一致）。顶栏按钮「绘制与命中
    /// 共用同一份矩形」，边界差一像素就会「看得见点不中」或误触发拖动。
    #[test]
    fn 矩形含点判定为右下开区间() {
        let rect = Rect::new(10, 20, 30, 18);
        assert!(rect.contains(10, 20), "左上角在矩形内");
        assert!(rect.contains(39, 37), "右下角内侧在矩形内");
        assert!(!rect.contains(40, 37), "右缘（开区间）不在矩形内");
        assert!(!rect.contains(10, 38), "下缘（开区间）不在矩形内");
        assert!(!rect.contains(9, 20), "左侧外不在矩形内");
        assert!(!rect.contains(10, 19), "上侧外不在矩形内");
        assert!(!Rect::new(0, 0, 0, 0).contains(0, 0), "空矩形不含任何点");
    }

    #[test]
    fn 按钮面_角色映射() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            match button_face(tokens, ButtonRole::Normal, false, false).bg {
                Some(Fill::Linear(stops)) | Some(Fill::Striped { stops, .. }) => {
                    assert_eq!(
                        stops[0].1,
                        tokens.btn_bg.base_color(),
                        "{id:?} 普通按钮取 btn_bg"
                    );
                }
                Some(Fill::Solid(c)) => assert_eq!(c, tokens.btn_bg.base_color()),
                _ => panic!("{id:?} 普通按钮必须有底"),
            }
            assert_eq!(
                button_face(tokens, ButtonRole::Normal, false, false).ink,
                tokens.btn_ink
            );
            match button_face(tokens, ButtonRole::Primary, false, false).bg {
                Some(fill) => assert_eq!(fill.base_color(), tokens.primary_bg.base_color()),
                None => panic!("主按钮必须有底"),
            }
            assert!(
                button_face(tokens, ButtonRole::TabOff, false, false)
                    .bg
                    .is_none(),
                "未选中标签无底"
            );
            assert_eq!(
                button_face(tokens, ButtonRole::TabOff, false, false).ink,
                tokens.dim
            );
            // 关闭「×」是**无面**入口（与 macOS 顶栏一致：只有字，悬浮整块转
            // `danger`，由下一测试钉住）。这里钉的是「无面」契约本身：退回
            // `btn_bg` 按钮面 = 在顶栏渐变上补一块白板（实机症状）。
            let close = button_face(tokens, ButtonRole::Close, false, false);
            assert!(
                close.bg.is_none(),
                "{id:?} 关闭键为无面文字入口（与 macOS 顶栏一致）"
            );
            assert_eq!(close.ink, tokens.dim, "{id:?} 关闭键默认字色取 dim");
            assert!(
                close.edge.is_none() && close.bevel.is_none(),
                "{id:?} 关闭键无描边/立体线（无面）"
            );
        }
    }

    #[test]
    fn 按钮面_悬浮关闭键换_danger_其余只叠一层() {
        let tokens = ThemeId::Brushed.tokens();
        match button_face(tokens, ButtonRole::Close, true, false).bg {
            Some(Fill::Solid(c)) => assert_eq!(c, tokens.danger, "关闭键悬浮底色换 danger"),
            other => panic!("关闭键悬浮应为 danger 实色，得到 {other:?}"),
        }
        let hovered = button_face(tokens, ButtonRole::Normal, true, false);
        assert_eq!(
            hovered.bg.map(|fill| fill.base_color()),
            Some(tokens.btn_bg.base_color()),
            "普通按钮悬浮不改底色，只叠一层"
        );
        assert!(hovered.overlay.is_some());
        assert!(button_face(tokens, ButtonRole::Normal, false, false)
            .overlay
            .is_none());
        let pressed = button_face(tokens, ButtonRole::Normal, false, true);
        assert!(pressed.overlay.is_some(), "按下也叠一层");
    }

    #[test]
    fn 取样_覆盖停靠点与越界() {
        let stops = [
            (0.0, Rgba::hex(0x000000)),
            (0.5, Rgba::hex(0x808080)),
            (1.0, Rgba::hex(0xFFFFFF)),
        ];
        assert_eq!(sample_linear(&stops, -1.0), Rgba::hex(0x000000));
        assert_eq!(sample_linear(&stops, 2.0), Rgba::hex(0xFFFFFF));
        let mid = sample_linear(&stops, 0.25);
        assert!((mid.r - 0.25).abs() < 0.01, "0.25 处应在两档中间");
        assert_eq!(sample_linear(&[], 0.5), Rgba::black_alpha(1.0), "空表兜底");
        assert_eq!(
            sample_fill(&Fill::Solid(Rgba::hex(0x010203)), 0.7),
            Rgba::hex(0x010203)
        );
    }

    /// 设置窗 / 编辑器窗的语义文字角色 → token 槽位。
    /// `Error` 必须取 `danger`、`Warning` 必须取 `warn`，**对调必红**。
    #[test]
    fn 文字角色映射到各自_token() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            assert_eq!(text_color(t, TextRole::Body), t.ink, "{id:?} 正文取 ink");
            assert_eq!(text_color(t, TextRole::Hint), t.dim, "{id:?} 说明取 dim");
            assert_eq!(
                text_color(t, TextRole::Error),
                t.danger,
                "{id:?} 错误必须取 danger"
            );
            assert_eq!(
                text_color(t, TextRole::Warning),
                t.warn,
                "{id:?} 警告必须取 warn"
            );
            assert_ne!(
                text_color(t, TextRole::Error),
                text_color(t, TextRole::Warning),
                "{id:?} danger 与 warn 同值时对调不可检"
            );
            assert_ne!(t.ink, t.dim, "{id:?} ink 与 dim 不应同值");
        }
    }

    /// 「保存」类提交动作 → `primary_*` 面（设置窗 / 编辑器的 ownerdraw 主按钮全靠它）。
    /// 底、字、描边三处都必须是 primary 族 —— 只对底断言会漏掉字色串族。
    #[test]
    fn 主按钮面全套取_primary_族() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            let face = button_face(tokens, ButtonRole::Primary, false, false);
            match face.bg {
                Some(fill) => {
                    assert_eq!(fill.base_color(), tokens.primary_bg.base_color(), "{id:?}")
                }
                None => panic!("{id:?} 主按钮必须有底"),
            }
            assert_eq!(
                face.ink, tokens.primary_ink,
                "{id:?} 主按钮字色取 primary_ink"
            );
            assert_eq!(
                face.edge,
                Some(tokens.primary_edge),
                "{id:?} 主按钮描边取 primary_edge"
            );
        }
    }

    /// `Link`（面板文字链「工具 N」「Σ 用量」）：无底、无边、无立体线，字色取 `ink`
    /// （不是 `dim` —— 与未选中标签 `TabOff` 的区分点就在这）。悬浮不特殊化。
    #[test]
    fn 文字链面无底取_ink() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            let face = button_face(tokens, ButtonRole::Link, false, false);
            assert!(face.bg.is_none(), "{id:?} 文字链无底");
            assert!(face.edge.is_none(), "{id:?} 文字链无边");
            assert!(face.bevel.is_none(), "{id:?} 文字链无立体线");
            assert_eq!(face.shadow.contact, None, "{id:?} 文字链无投影");
            assert_eq!(face.shadow.ambient, None, "{id:?} 文字链无投影");
            assert_eq!(face.ink, tokens.ink, "{id:?} 文字链字色取 ink");
            assert_ne!(
                face.ink, tokens.dim,
                "{id:?} ink 与 dim 同值就与未选中标签分不开"
            );
            // 悬浮走通用叠加路径，不做特殊处理（与其它非关闭角色一致）。
            let hovered = button_face(tokens, ButtonRole::Link, true, false);
            assert!(hovered.overlay.is_some(), "{id:?} 悬浮叠加与其它角色同路径");
        }
        assert_eq!(
            ButtonRole::from_code(ButtonRole::Link.code()),
            ButtonRole::Link
        );
        assert_eq!(ButtonRole::Link.code(), 9);
    }

    /// 禁用态：底与标题都降 50%（macOS `style_button` 的口径）。钉两条公式：
    /// 冲洗层 = 面板底 50%；标题 = 原字色 50% 合成在**冲洗后的底**上（不是原底）。
    /// 只降标题色的旧口径必须不再可能（标题必须区别于可用态字色）。
    #[test]
    fn 禁用态_底与标题都降五十() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            let backdrop = tokens.panel_bg.base_color();
            let face = button_face(tokens, ButtonRole::Primary, false, false);
            let disabled = disabled_face(&face, backdrop);
            assert!(
                (disabled.wash.a - backdrop.a * 0.5).abs() < 1e-6,
                "{id:?} 冲洗层 = 面板底 50%"
            );
            let washed = composite_over(disabled.wash, face.bg_base);
            assert_eq!(disabled.washed_base, washed, "{id:?} 冲洗后底色公式");
            assert_eq!(
                disabled.ink,
                composite_over(face.ink.with_alpha(face.ink.a * 0.5), washed),
                "{id:?} 标题 = 50% 字色合成在冲洗后的底上"
            );
            assert_ne!(
                disabled.ink, face.ink,
                "{id:?} 禁用标题必须区别于可用态（只降底不降字的旧口径）"
            );
            assert_ne!(
                disabled.washed_base, face.bg_base,
                "{id:?} 禁用底必须被面板底冲洗（只降标题的旧口径）"
            );
        }
    }

    /// 按钮外投影槽位：`--bsh` / `--ssh` / `--tabonsh` 各自的 `var(--contact)`
    /// 必须落在对应角色的面上（`Contact` 三主题同值 = `0 1px 2px rgba(0,0,0,.30)`）。
    #[test]
    fn 按钮面投影取各自_contact() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            let normal = button_face(tokens, ButtonRole::Normal, false, false);
            assert_eq!(
                normal.shadow, tokens.btn_shadow,
                "{id:?} 普通按钮取 btn_shadow"
            );
            assert_eq!(
                normal
                    .shadow
                    .contact
                    .expect("三主题 --bsh 都含 --contact")
                    .dy,
                1.0
            );
            let primary = button_face(tokens, ButtonRole::Primary, false, false);
            assert_eq!(
                primary.shadow, tokens.primary_shadow,
                "{id:?} 主按钮取 primary_shadow"
            );
            let tab = button_face(tokens, ButtonRole::TabOn, false, false);
            assert_eq!(
                tab.shadow, tokens.tab_on_shadow,
                "{id:?} 选中标签取 tab_on_shadow"
            );
            // 无 contact 的角色不许被顺带贴上投影。
            let pending = button_face(tokens, ButtonRole::Pending, false, false);
            assert_eq!(
                pending.shadow,
                Elevation::NONE,
                "{id:?} 待发送 chip 只有 --finner，无投影"
            );
            let tab_off = button_face(tokens, ButtonRole::TabOff, false, false);
            assert_eq!(tab_off.shadow, Elevation::NONE);
        }
    }
}
