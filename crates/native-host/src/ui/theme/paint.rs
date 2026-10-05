//! 主题 token → AppKit/QuartzCore 绘制适配（macOS 平台层）。
//!
//! 平台无关的 token 词汇与三套预设值在 [`super::tokens`]；本文件只回答一个问题：
//! **一个 token 在原生绘制里具体变成什么**。
//!
//! ## 口径
//!
//! - token 的几何与顺序一律以**左上原点**表达（与 CSS 设计稿同款）。原生图层有两种
//!   几何方向：翻转视图（`isFlipped`）的 backing layer 是 y 向下，普通视图是 y 向上。
//!   调用方用 `flipped` 告知本模块，镜像在模块内完成（顶边线、竖向渐变方向、投影
//!   偏移都受影响）。
//! - 背景件一律画成**负 zPosition 的子层**（见 [`FILL_Z`] 一带的常量），保证任何后
//!   加的子视图都盖在它们上面；对同一块底板重复调用是幂等的（同名前缀子层先清后建）。
//!   按钮例外，见下。
//! - **多层的声明序 = CSS 序**：`--ptex` 的多背景、`Bevel` 的多笔 inset 阴影、
//!   一组条纹，都是"首个声明在最上"（zPosition 随声明序**递减**），token 表照
//!   设计稿原样排、绘制层不做第二次排序。
//! - 所有 CALayer 写入都包在 `without_implicit_animation` 里（不产生隐式动画）。
//!
//! ## 已知近似（与设计稿的差异，全部如实记录）
//!
//! - `CAGradientLayer` 没有 CSS 的多重背景与 `mix-blend-mode`：面板纹理的多层用
//!   **多个子层叠加**表达；细颗粒是普通 alpha 叠加，不模拟 `overlay` 混合。
//! - `CALayer` 一层只有一条投影：`Elevation.ambient` 与 `contact` 同时存在时取
//!   `ambient`（`contact` 只在单独存在时生效）；`spread` 用 `shadowPath` 外扩/内缩
//!   近似；CSS `blur` 半径按 2×高斯 σ 换算成 `shadowRadius`。
//! - `blur > 0` 的内立体线用「实色 → 透明」的窄渐变带近似软边。
//! - **按钮的文字画在图层 `contents` 里（在子层之下）**，所以按钮底只能取
//!   [`Fill::base_color`] 的实色（渐变底只用于容器视图；写渐变色子层会盖住按钮文字）。
//! - 条纹图案按 [`PATTERN_SCALE`] 光栅化（Retina 1:1）；纹理图案按「像素 = 点」
//!   （与 CSS `background-size: auto` 同口径，高 DPI 下由 Core Animation 上采样）。
//! - 图案色经 `NSColor(patternImage:)` 平铺：`backgroundColor` 取图案 `CGColor` 时由
//!   Core Animation 解析为重复排布。
//!
//!   **这条是实测过的，别再怀疑**（曾有实现者担心 CA 不认图案色，做实验证伪了这个担心）：
//!   8×8 黑白棋盘图案设为 `CALayer.backgroundColor`，离线 `render(in:)` 出 64×64 位图后
//!   数亮度档位 —— **25 档**，即图案真的平铺出来了（若被忽略会是纯色的 1–2 档）。
//!   注意实验的对照坑：手搓 `CGPattern` + `CGColorSpace(patternBaseSpace: nil)` 那条路
//!   在同样的测量下只有 2 档（图案没出来），而 `NSColor(patternImage:)` 是 25 档 ——
//!   所以**必须走 `NSColor(patternImage:)`**，不要「优化」成手搓 CGPattern。
//!   另注：彩色图案的 `CGColor` 分量数组只能给 1 个 alpha，给 4 个会得到 nil。

use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_app_kit::{
    NSBitmapFormat, NSBitmapImageRep, NSButton, NSColor, NSDeviceRGBColorSpace, NSFocusRingType,
    NSForegroundColorAttributeName, NSImage, NSShadow, NSShadowAttributeName,
};
use objc2_core_graphics::{CGColor, CGPath};
use objc2_foundation::{
    NSArray, NSMutableAttributedString, NSNumber, NSPoint, NSRange, NSRect, NSSize, NSString,
};
use objc2_quartz_core::{CAAutoresizingMask, CAGradientLayer, CALayer};

use super::noise::Bitmap;
use super::texture::{self, Tex};
use super::tokens::{
    Bevel, BevelLine, EdgeLines, Elevation, Fill, InsetLine, Layer as SheenLayer, Rgba, Shadow,
    Sheen, Stripe, Tokens,
};
use crate::rust_debug;
use crate::ui::platform::macos_widgets::{as_any, without_implicit_animation};

// 侧别枚举的唯一定义点在 tokens（平台无关，Bevel 线表要用）；这里重导出，
// 平台侧既有的 `paint::EdgeSide` 路径不变。
pub(crate) use super::tokens::EdgeSide;

/// 条纹图案的光栅化倍率（device px / point）。
///
/// 设计稿的条纹是分辨率无关的 CSS 渐变；原生侧用位图平铺，按 Retina 1:1 生成
/// 才能保住 1–2px 线宽。非 Retina 屏由 Core Animation 下采样（条纹略软，尺寸不变）。
const PATTERN_SCALE: f64 = 2.0;

// 背景件子层命名前缀与 z 序。全部为负值：任何后加的子视图（z = 0）都在它们上面。
const FILL_PREFIX: &str = "deskpet.theme.fill.";
const SHEEN_PREFIX: &str = "deskpet.theme.sheen.";
const GRAIN_PREFIX: &str = "deskpet.theme.grain.";
const BEVEL_PREFIX: &str = "deskpet.theme.bevel.";
const EDGE_PREFIX: &str = "deskpet.theme.edge.";
const FILL_Z: f64 = -100.0;
const SHEEN_Z: f64 = -90.0;
const GRAIN_Z: f64 = -80.0;
const BEVEL_Z: f64 = -70.0;
const EDGE_Z: f64 = -60.0;

// ==========================================
// 颜色与位图
// ==========================================

/// `Rgba`（0..1 的 f32）→ AppKit 分量（`CGFloat`/f64，越界值夹取到 [0, 1]）。
pub(crate) fn rgba_components(c: Rgba) -> [f64; 4] {
    [c.r, c.g, c.b, c.a].map(|v| f64::from(v.clamp(0.0, 1.0)))
}

/// sRGB 颜色（AppKit 分量是 f64，token 分量是 f32）。
pub(crate) fn color(rgba: Rgba) -> Retained<NSColor> {
    let [r, g, b, a] = rgba_components(rgba);
    NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a)
}

/// `Bitmap`（RGBA8，左上原点，直通 alpha）→ `NSImage`（尺寸 = 像素数，CSS `auto` 同口径）。
pub(crate) fn image(bitmap: &Bitmap) -> Option<Retained<NSImage>> {
    bitmap_image(
        bitmap,
        NSSize::new(f64::from(bitmap.width), f64::from(bitmap.height)),
    )
}

/// 按给定点尺寸构造 `NSImage`（条纹图案用：位图是 2×，点尺寸要除回去）。
fn bitmap_image(bitmap: &Bitmap, size: NSSize) -> Option<Retained<NSImage>> {
    if bitmap.width == 0 || bitmap.height == 0 {
        return None;
    }
    let expected = (bitmap.width as usize) * (bitmap.height as usize) * 4;
    if bitmap.pixels.len() < expected {
        rust_debug!(
            "主题纹理像素不足（{} < {expected}），拒绝建图",
            bitmap.pixels.len()
        );
        return None;
    }
    unsafe {
        let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            ptr::null_mut(),
            bitmap.width as isize,
            bitmap.height as isize,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            NSBitmapFormat::AlphaNonpremultiplied,
            (bitmap.width as isize) * 4,
            32,
        )?;
        let dest = rep.bitmapData();
        if dest.is_null() {
            return None;
        }
        ptr::copy_nonoverlapping(bitmap.pixels.as_ptr(), dest, expected);
        let image = NSImage::initWithSize(NSImage::alloc(), size);
        image.addRepresentation(&rep);
        Some(image)
    }
}

// ==========================================
// 图案（NSColor(patternImage:) 平铺）
// ==========================================

/// 图案缓存键：纹理按 id；条纹按 `'static` 切片的指针 + 长度（token 表是编译期常量，
/// 同一切片就是同一配方）。
#[derive(PartialEq, Eq, Hash)]
enum PatternKey {
    Tex(Tex),
    Stripes(usize, usize),
}

thread_local! {
    /// 图案色缓存。图案的构造（光栅 → NSImage → CGPattern）不便宜，而同一主题会
    /// 反复重建视图；颜色本身不含透明度语义（透明度由叠加层的 `opacity` 承担）。
    static PATTERN_CACHE: RefCell<HashMap<PatternKey, Retained<NSColor>>> =
        RefCell::new(HashMap::new());
}

fn texture_pattern(tex: Tex) -> Option<Retained<NSColor>> {
    PATTERN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(hit) = cache.get(&PatternKey::Tex(tex)) {
            return Some(hit.clone());
        }
        let bitmap = texture::get(tex);
        let image = image(&bitmap)?;
        let pattern = NSColor::colorWithPatternImage(&image);
        cache.insert(PatternKey::Tex(tex), pattern.clone());
        Some(pattern)
    })
}

fn stripes_pattern(stripes: &'static [Stripe]) -> Option<Retained<NSColor>> {
    let key = PatternKey::Stripes(stripes.as_ptr() as usize, stripes.len());
    PATTERN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(hit) = cache.get(&key) {
            return Some(hit.clone());
        }
        let bitmap = stripe_bitmap(stripes, PATTERN_SCALE);
        let size = NSSize::new(
            f64::from(bitmap.width) / PATTERN_SCALE,
            f64::from(bitmap.height) / PATTERN_SCALE,
        );
        let image = bitmap_image(&bitmap, size)?;
        let pattern = NSColor::colorWithPatternImage(&image);
        cache.insert(key, pattern.clone());
        Some(pattern)
    })
}

/// 一组周期条纹光栅化为「一个周期高」的 RGBA8 图案（纯函数，可测）。
///
/// - 高度 = 最大周期 × `scale`（向上取整；条纹周期以设计 px 表达）；
/// - 每条条纹在其周期的前 `line` px 内着色（`pos % period < line`），
///   逐条按源覆盖（source-over）叠加，直通 alpha 存 8 位；
/// - **声明序 = CSS 多背景序，首条在最上**：合成从末条画起、首条最后画
///   （数组是 `&'static` 编译期常量，不能就地倒序，用反向迭代）；
/// - 横向均匀：宽度固定 8 点，只影响采样分辨率。
fn stripe_bitmap(stripes: &[Stripe], scale: f64) -> Bitmap {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let period = stripes
        .iter()
        .fold(1.0f64, |acc, s| acc.max(f64::from(s.period)));
    let height = ((period * scale).round() as u32).max(1);
    let width = ((8.0 * scale).round() as u32).max(1);
    let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
    for y in 0..height {
        // 该像素行中心的「设计 px」位置。
        let pos = (f64::from(y) + 0.5) / scale;
        let mut acc = [0.0f32; 4];
        for stripe in stripes.iter().rev() {
            let stripe_period = f64::from(stripe.period).max(1.0);
            let line = f64::from(stripe.line).clamp(0.0, stripe_period);
            if pos % stripe_period >= line {
                continue;
            }
            let sa = stripe.color.a.clamp(0.0, 1.0);
            if sa <= 0.0 {
                continue;
            }
            let out_a = sa + acc[3] * (1.0 - sa);
            if out_a > 0.0 {
                acc[0] = (stripe.color.r * sa + acc[0] * acc[3] * (1.0 - sa)) / out_a;
                acc[1] = (stripe.color.g * sa + acc[1] * acc[3] * (1.0 - sa)) / out_a;
                acc[2] = (stripe.color.b * sa + acc[2] * acc[3] * (1.0 - sa)) / out_a;
            }
            acc[3] = out_a;
        }
        for x in 0..width {
            let i = ((y as usize) * (width as usize) + (x as usize)) * 4;
            pixels[i] = quantize(acc[0]);
            pixels[i + 1] = quantize(acc[1]);
            pixels[i + 2] = quantize(acc[2]);
            pixels[i + 3] = quantize(acc[3]);
        }
    }
    Bitmap {
        width,
        height,
        pixels,
    }
}

fn quantize(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

// ==========================================
// 内边缘线（Bevel / InsetLine）
// ==========================================

/// 图层坐标里的矩形（左上原点；`flipped` 已在生成时镜像）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RectF {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 一条待画的内边缘线。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct EdgeBand {
    pub rect: RectF,
    pub color: Rgba,
    /// 0 = 硬线；> 0 用「实色 → 透明」的窄渐变带近似软边。
    pub blur: f32,
    /// 实色端贴哪条视觉边（软边从该边向内渐隐；顶/底走竖向渐变，左/右走横向）。
    pub solid_side: EdgeSide,
}

/// 「这块底板该画几条立体线、每条在哪个 rect」的纯计算。
///
/// 顺序 = `Bevel.lines` 的声明序（CSS 多笔 inset 阴影的书写序），绘制层据此保证
/// 首条在最上；`Ring` 展开成四条互不重叠的边线。
pub(crate) fn bevel_bands(bevel: &Bevel, size: (f64, f64), flipped: bool) -> Vec<EdgeBand> {
    let mut bands = Vec::new();
    for item in bevel.lines {
        match item {
            BevelLine::Edge { side, line } => bands.push(edge_band(line, *side, size, flipped)),
            BevelLine::Ring { line } => bands.extend(ring_bands(line, size)),
        }
    }
    bands
}

/// 单条内边缘线 → 带（顶栏底线 / 消息流内阴影等单线场景同用）。
///
/// 带长 = `width + blur`（软边把过渡长度算进带内）；位置按 `side` 贴住对应边，
/// `flipped` 决定哪一端是「上」（左/右两侧与翻转无关：AppKit 只镜像 y）。
pub(crate) fn edge_band(
    line: &InsetLine,
    side: EdgeSide,
    size: (f64, f64),
    flipped: bool,
) -> EdgeBand {
    let (w, h) = size;
    let thickness = (f64::from(line.width) + f64::from(line.blur)).max(1.0);
    let rect = match side {
        EdgeSide::Top => RectF {
            x: 0.0,
            y: if flipped {
                0.0
            } else {
                (h - thickness).max(0.0)
            },
            w,
            h: thickness.min(h.max(1.0)),
        },
        EdgeSide::Bottom => RectF {
            x: 0.0,
            y: if flipped {
                (h - thickness).max(0.0)
            } else {
                0.0
            },
            w,
            h: thickness.min(h.max(1.0)),
        },
        EdgeSide::Left => RectF {
            x: 0.0,
            y: 0.0,
            w: thickness.min(w.max(1.0)),
            h,
        },
        EdgeSide::Right => RectF {
            x: (w - thickness).max(0.0),
            y: 0.0,
            w: thickness.min(w.max(1.0)),
            h,
        },
    };
    EdgeBand {
        rect,
        color: line.color,
        blur: line.blur,
        solid_side: side,
    }
}

/// 内环（CSS `inset 0 0 0 1px`）：四条互不重叠的边线。
///
/// 横向两条占满全宽、纵向两条只在横线之间 —— 同一 alpha 在角上重叠会二次合成、
/// 比其余边深，这样切开就没有角斑。环宽夹取到不超过短边的一半，防退化尺寸。
pub(crate) fn ring_bands(line: &InsetLine, size: (f64, f64)) -> Vec<EdgeBand> {
    let (w, h) = size;
    if w <= 0.0 || h <= 0.0 {
        return Vec::new();
    }
    let thickness = f64::from(line.width).max(1.0).min(w.min(h) / 2.0).max(1.0);
    let mut bands = Vec::new();
    let mut push = |rect: RectF, side: EdgeSide| {
        bands.push(EdgeBand {
            rect,
            color: line.color,
            blur: line.blur,
            solid_side: side,
        });
    };
    push(
        RectF {
            x: 0.0,
            y: 0.0,
            w,
            h: thickness,
        },
        EdgeSide::Top,
    );
    push(
        RectF {
            x: 0.0,
            y: (h - thickness).max(0.0),
            w,
            h: thickness,
        },
        EdgeSide::Bottom,
    );
    let side_h = h - thickness * 2.0;
    if side_h > 0.0 {
        push(
            RectF {
                x: 0.0,
                y: thickness,
                w: thickness,
                h: side_h,
            },
            EdgeSide::Left,
        );
        push(
            RectF {
                x: (w - thickness).max(0.0),
                y: thickness,
                w: thickness,
                h: side_h,
            },
            EdgeSide::Right,
        );
    }
    bands
}

/// 把 `Bevel` 画成内边缘线（同名前缀子层先清后建，幂等）。
///
/// z 随声明序**递减**：CSS 多笔阴影首笔在最上，越靠前的线 zPosition 越高。
pub(crate) fn apply_bevel(layer: &CALayer, bevel: &Bevel, flipped: bool) {
    let bands = bevel_bands(bevel, layer_size(layer), flipped);
    without_implicit_animation(|| {
        remove_sublayers(layer, BEVEL_PREFIX);
        for (index, band) in bands.iter().enumerate() {
            add_band(
                layer,
                &format!("{BEVEL_PREFIX}{index}"),
                BEVEL_Z - index as f64,
                band,
                flipped,
            );
        }
    });
}

/// 单线入口：一条 [`InsetLine`]（侧别由 `side` 给）或一个 [`Bevel`]
/// （各线自带侧别与顺序，`side` 被忽略）。`None` = 清除这条线（token 可选时用）。
pub(crate) fn apply_line(
    layer: &CALayer,
    side: EdgeSide,
    line: Option<impl Into<EdgeLines>>,
    flipped: bool,
) {
    let size = layer_size(layer);
    let bands = match line.map(Into::into) {
        None => Vec::new(),
        Some(EdgeLines::Single(line)) => vec![edge_band(&line, side, size, flipped)],
        Some(EdgeLines::Stack(bevel)) => bevel_bands(&bevel, size, flipped),
    };
    without_implicit_animation(|| {
        remove_sublayers(layer, EDGE_PREFIX);
        for (index, band) in bands.iter().enumerate() {
            add_band(
                layer,
                &format!("{EDGE_PREFIX}{index}"),
                EDGE_Z - index as f64,
                band,
                flipped,
            );
        }
    });
}

/// 渐变带的两端顺序（纯函数，可测）：`true` = 实色放 `colors[0]`（渐变起点）。
///
/// 带子的渐变起点固定是（竖向：上端 `y=0`；横向：左端 `x=0`）。竖向带的上端在
/// 翻转图层里是视觉上缘、在普通图层里是视觉下缘，所以要按 `flipped` 反过来；
/// 横向带两平台同向（AppKit 翻转只镜像 y），实色贴左即放首位。
fn band_solid_first(side: EdgeSide, flipped: bool) -> bool {
    match side {
        EdgeSide::Top => flipped,
        EdgeSide::Bottom => !flipped,
        EdgeSide::Left => true,
        EdgeSide::Right => false,
    }
}

fn add_band(layer: &CALayer, name: &str, z: f64, band: &EdgeBand, flipped: bool) {
    let rect = NSRect::new(
        NSPoint::new(band.rect.x, band.rect.y),
        NSSize::new(band.rect.w, band.rect.h),
    );
    if band.blur <= 0.0 {
        let line = CALayer::new();
        line.setName(Some(&NSString::from_str(name)));
        line.setZPosition(z);
        line.setFrame(rect);
        line.setBackgroundColor(Some(&color(band.color).CGColor()));
        layer.addSublayer(&line);
        return;
    }
    let gradient = CAGradientLayer::new();
    gradient.setName(Some(&NSString::from_str(name)));
    gradient.setZPosition(z);
    gradient.setFrame(rect);
    // 竖向带的渐变端点沿 y、横向带沿 x；实色端在起点则放首位，否则放末位。
    let (start, end) = if matches!(band.solid_side, EdgeSide::Top | EdgeSide::Bottom) {
        (NSPoint::new(0.5, 0.0), NSPoint::new(0.5, 1.0))
    } else {
        (NSPoint::new(0.0, 0.5), NSPoint::new(1.0, 0.5))
    };
    gradient.setStartPoint(start);
    gradient.setEndPoint(end);
    let solid_first = band_solid_first(band.solid_side, flipped);
    let solid = color(band.color);
    let clear = color(band.color.with_alpha(0.0));
    let stops = if solid_first {
        [solid, clear]
    } else {
        [clear, solid]
    };
    set_gradient(&gradient, &stops, &[0.0, 1.0]);
    layer.addSublayer(&gradient);
}

// ==========================================
// 外投影
// ==========================================

/// `Shadow` → `CALayer.shadow*` 的直接取值。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ShadowSpec {
    /// `shadowOffset`：正 y = 视觉向下（已按 `flipped` 镜像到图层坐标）。
    pub offset: (f64, f64),
    /// `shadowRadius`。
    pub radius: f64,
    /// `shadowOpacity`。
    pub opacity: f32,
    /// `shadowColor`（alpha 已拆到 `opacity`）。
    pub color: Rgba,
    /// `spread`：正 = 外扩；由 `shadowPath` 近似。
    pub spread: f64,
}

/// `Shadow` → CALayer 参数（纯函数，可测）。
///
/// token 的 `dy` 是 CSS 口径（正 = 向下）；CALayer 的 y 正方向取决于图层几何，
/// 翻转图层直接用 `dy`，普通图层取镜像。
pub(crate) fn shadow_spec(shadow: &Shadow, flipped: bool) -> ShadowSpec {
    ShadowSpec {
        offset: (0.0, vertical_offset(shadow.dy, flipped)),
        radius: f64::from(shadow.blur) / 2.0,
        opacity: shadow.color.a.clamp(0.0, 1.0),
        color: shadow.color.with_alpha(1.0),
        spread: f64::from(shadow.spread),
    }
}

/// 视觉「向下」在图层坐标里的符号：翻转图层 = +y，普通图层 = -y。
fn vertical_offset(dy: f32, flipped: bool) -> f64 {
    let dy = f64::from(dy);
    if flipped {
        dy
    } else {
        -dy
    }
}

/// 投影路径矩形：`spread` 正 = 外扩（矩形放大）、负 = 内缩；缩到非正尺寸时退回
/// 1×1 并保持中心（防御极端 token 值）。
pub(crate) fn shadow_path_rect(rect: RectF, spread: f64) -> RectF {
    let w = (rect.w + spread * 2.0).max(1.0);
    let h = (rect.h + spread * 2.0).max(1.0);
    RectF {
        x: rect.x + (rect.w - w) / 2.0,
        y: rect.y + (rect.h - h) / 2.0,
        w,
        h,
    }
}

/// 取本次生效的一条投影：`ambient` 优先（CALayer 一层只有一条影），
/// 没有 `ambient` 时退到 `contact`。
fn pick_shadow(elevation: &Elevation) -> Option<Shadow> {
    elevation.ambient.or(elevation.contact)
}

/// 把 `Elevation` 应用到图层（同层重复调用幂等；无投影时显式清零）。
pub(crate) fn apply_elevation(
    layer: &CALayer,
    elevation: &Elevation,
    flipped: bool,
    corner_radius: f64,
) {
    let Some(shadow) = pick_shadow(elevation) else {
        without_implicit_animation(|| {
            layer.setShadowOpacity(0.0);
            layer.setShadowPath(None);
        });
        return;
    };
    let spec = shadow_spec(&shadow, flipped);
    let bounds = layer.bounds();
    let path_rect = shadow_path_rect(
        RectF {
            x: bounds.origin.x,
            y: bounds.origin.y,
            w: bounds.size.width,
            h: bounds.size.height,
        },
        spec.spread,
    );
    without_implicit_animation(|| {
        layer.setShadowColor(Some(&color(spec.color).CGColor()));
        layer.setShadowOpacity(spec.opacity);
        layer.setShadowOffset(NSSize::new(spec.offset.0, spec.offset.1));
        layer.setShadowRadius(spec.radius);
        let path = unsafe {
            CGPath::with_rounded_rect(
                NSRect::new(
                    NSPoint::new(path_rect.x, path_rect.y),
                    NSSize::new(path_rect.w, path_rect.h),
                ),
                corner_radius,
                corner_radius,
                ptr::null(),
            )
        };
        layer.setShadowPath(Some(&path));
    });
}

// ==========================================
// 填充与纹理层
// ==========================================

/// 把 `Fill` 画成图层底（同名前缀子层先清后建，幂等）。
///
/// 实色走图层 `backgroundColor`；渐变/径向/条纹走负 z 的子层。调用方须保证
/// 目标图层的 `contents` 不承载内容 —— 按钮的文字在 contents 里，请改用
/// [`Face`]（见 [`style_button`]）。
pub(crate) fn apply_fill(layer: &CALayer, fill: &Fill, flipped: bool) {
    without_implicit_animation(|| {
        remove_sublayers(layer, FILL_PREFIX);
        match fill {
            Fill::Solid(c) => {
                layer.setBackgroundColor(Some(&color(*c).CGColor()));
            }
            Fill::Linear(stops) => {
                layer.setBackgroundColor(None);
                if let Some(gradient) = linear_gradient(stops, flipped, layer.bounds()) {
                    gradient.setName(Some(&NSString::from_str(&format!("{FILL_PREFIX}base"))));
                    gradient.setZPosition(FILL_Z);
                    layer.addSublayer(&gradient);
                }
            }
            Fill::Radial {
                cx,
                cy,
                rx,
                ry,
                stops,
            } => {
                layer.setBackgroundColor(None);
                if let Some(gradient) = radial_gradient(*cx, *cy, *rx, *ry, stops, layer.bounds()) {
                    gradient.setName(Some(&NSString::from_str(&format!("{FILL_PREFIX}base"))));
                    gradient.setZPosition(FILL_Z);
                    layer.addSublayer(&gradient);
                }
            }
            Fill::Striped { stops, stripes } => {
                layer.setBackgroundColor(None);
                if let Some(gradient) = linear_gradient(stops, flipped, layer.bounds()) {
                    gradient.setName(Some(&NSString::from_str(&format!("{FILL_PREFIX}base"))));
                    gradient.setZPosition(FILL_Z);
                    layer.addSublayer(&gradient);
                }
                if let Some(pattern) = stripes_pattern(stripes) {
                    add_pattern_layer(
                        layer,
                        &format!("{FILL_PREFIX}stripes"),
                        FILL_Z + 1.0,
                        &pattern,
                        1.0,
                        layer.bounds(),
                    );
                }
            }
        }
    });
}

/// 窗口底（设置窗 / 编辑器窗的内容视图）：整面 `Backdrop`（底 + 纹理 + 颗粒）
/// 铺满视图图层。
///
/// 与 [`paint_backdrop`] 的唯一区别是**缩放行为**：内容视图的图层是窗口缩放的
/// 目标（视图 frame 随窗口变化，而 paint 生成的渐变/纹理子层不会自动跟随），
/// 这里给全部绘制子层加「宽高可变」自缩放掩码
/// （`kCALayerWidthSizable | kCALayerHeightSizable`），窗口拉大后底仍铺满。
/// 实色底走 `backgroundColor` 本就跟随，掩码对它无副作用。
pub(crate) fn apply_window_backdrop(layer: &CALayer, spec: &Backdrop) {
    paint_backdrop(layer, spec);
    without_implicit_animation(|| {
        let Some(sublayers) = (unsafe { layer.sublayers() }) else {
            return;
        };
        for sublayer in sublayers.iter() {
            sublayer.setAutoresizingMask(
                CAAutoresizingMask::LayerWidthSizable | CAAutoresizingMask::LayerHeightSizable,
            );
        }
    });
}

/// 面板纹理层（`--ptex`）：声明序 = CSS 多背景序 —— **首层在最上**，逐层一种画法。
///
/// z 随声明序递减（首层 zPosition 最高）：CSS 的 `background: A, B` 里 A 在 B 之上，
/// token 表就按这行声明原样排，绘制层不再做第二次排序。
pub(crate) fn apply_sheen(layer: &CALayer, sheen: &Sheen, flipped: bool) {
    without_implicit_animation(|| {
        remove_sublayers(layer, SHEEN_PREFIX);
        let bounds = layer.bounds();
        for (index, item) in sheen.0.iter().enumerate() {
            let name = format!("{SHEEN_PREFIX}{index}");
            let z = SHEEN_Z - index as f64;
            match item {
                SheenLayer::Grad(stops) => {
                    if let Some(gradient) = linear_gradient(stops, flipped, bounds) {
                        gradient.setName(Some(&NSString::from_str(&name)));
                        gradient.setZPosition(z);
                        layer.addSublayer(&gradient);
                    }
                }
                SheenLayer::Stripes(stripes) => {
                    if let Some(pattern) = stripes_pattern(stripes) {
                        add_pattern_layer(layer, &name, z, &pattern, 1.0, bounds);
                    }
                }
                SheenLayer::Tex { tex, alpha } => {
                    if let Some(pattern) = texture_pattern(*tex) {
                        add_pattern_layer(layer, &name, z, &pattern, alpha.clamp(0.0, 1.0), bounds);
                    }
                }
                SheenLayer::Edge { side, color, width } => {
                    let line = InsetLine::hard(*color, *width);
                    let band = edge_band(
                        &line,
                        *side,
                        (bounds.size.width, bounds.size.height),
                        flipped,
                    );
                    add_band(layer, &name, z, &band, flipped);
                }
            }
        }
    });
}

/// 细颗粒叠加层（`--stage-grain` / `--panel-grain`，同一张 `Tex::Grain` 按不同
/// 透明度叠在底板之上）。
pub(crate) fn apply_grain(layer: &CALayer, alpha: f32) {
    without_implicit_animation(|| {
        remove_sublayers(layer, GRAIN_PREFIX);
        if let Some(pattern) = texture_pattern(Tex::Grain) {
            add_pattern_layer(
                layer,
                GRAIN_PREFIX,
                GRAIN_Z,
                &pattern,
                alpha.clamp(0.0, 1.0),
                layer.bounds(),
            );
        }
    });
}

fn add_pattern_layer(
    layer: &CALayer,
    name: &str,
    z: f64,
    pattern: &NSColor,
    opacity: f32,
    bounds: NSRect,
) {
    let overlay = CALayer::new();
    overlay.setName(Some(&NSString::from_str(name)));
    overlay.setZPosition(z);
    overlay.setFrame(bounds);
    overlay.setBackgroundColor(Some(&pattern.CGColor()));
    overlay.setOpacity(opacity);
    layer.addSublayer(&overlay);
}

/// 圆角（`Radii` 的三档取值由调用方决定）。
pub(crate) fn set_corner_radius(layer: &CALayer, radius: f64) {
    without_implicit_animation(|| layer.setCornerRadius(radius));
}

/// 外描边（`panel_edge` / `*_edge`）：图层边框画在 `bounds` 内缘。
pub(crate) fn set_stroke(layer: &CALayer, rgba: Rgba, width: f64) {
    without_implicit_animation(|| {
        if width <= 0.0 {
            layer.setBorderWidth(0.0);
            return;
        }
        layer.setBorderWidth(width);
        layer.setBorderColor(Some(&color(rgba).CGColor()));
    });
}

fn linear_gradient(
    stops: &[(f32, Rgba)],
    flipped: bool,
    bounds: NSRect,
) -> Option<Retained<CAGradientLayer>> {
    if stops.is_empty() {
        return None;
    }
    let gradient = CAGradientLayer::new();
    gradient.setFrame(bounds);
    // 竖向渐变：stops 按「从上到下」给（CSS 口径），首档必须落在视觉上缘。
    // 翻转图层上缘是 y=0（起点 0、终点 1）；普通图层上缘是 y=1（起点 1、终点 0）。
    let (start, end) = if flipped { (0.0, 1.0) } else { (1.0, 0.0) };
    gradient.setStartPoint(NSPoint::new(0.5, start));
    gradient.setEndPoint(NSPoint::new(0.5, end));
    let colors: Vec<Retained<NSColor>> = stops.iter().map(|(_, c)| color(*c)).collect();
    let locations: Vec<f64> = stops.iter().map(|(p, _)| f64::from(*p)).collect();
    set_gradient(&gradient, &colors, &locations);
    Some(gradient)
}

fn radial_gradient(
    cx: f32,
    cy: f32,
    rx: f32,
    ry: f32,
    stops: &[(f32, Rgba)],
    bounds: NSRect,
) -> Option<Retained<CAGradientLayer>> {
    if stops.is_empty() {
        return None;
    }
    let gradient = CAGradientLayer::new();
    gradient.setFrame(bounds);
    unsafe { gradient.setType(objc2_quartz_core::kCAGradientLayerRadial) };
    // CAGradientLayer 的径向：起点是圆心，起点→终点向量的长度定半径；rx/ry 不同时
    // 得到椭圆（与 CSS `radial-gradient(… at …)` 的椭圆近似，非逐位一致）。
    gradient.setStartPoint(NSPoint::new(f64::from(cx), f64::from(cy)));
    gradient.setEndPoint(NSPoint::new(
        f64::from(cx) + f64::from(rx),
        f64::from(cy) + f64::from(ry),
    ));
    let colors: Vec<Retained<NSColor>> = stops.iter().map(|(_, c)| color(*c)).collect();
    let locations: Vec<f64> = stops.iter().map(|(p, _)| f64::from(*p)).collect();
    set_gradient(&gradient, &colors, &locations);
    Some(gradient)
}

fn set_gradient(gradient: &CAGradientLayer, colors: &[Retained<NSColor>], locations: &[f64]) {
    let cg_colors: Vec<Retained<CGColor>> = colors.iter().map(|c| c.CGColor()).collect();
    let color_array = cg_color_array(&cg_colors);
    unsafe { gradient.setColors(Some(&color_array)) };
    let numbers: Vec<Retained<NSNumber>> = locations
        .iter()
        .map(|l| NSNumber::new_cgfloat(*l))
        .collect();
    gradient.setLocations(Some(&NSArray::from_retained_slice(&numbers)));
}

/// 把 CGColor 装进 `setColors:` 要的 `NSArray`。
///
/// **不能直接 `NSArray::from_retained_slice::<CGColor>`** —— 那条路会把元素的静态
/// 类型记成 `^{CGColor}`，而 `NSArray` 只接受 ObjC 对象（`^@`）；objc2 在
/// `initWithObjects:count:` 上有运行期类型校验，会**直接 panic**：
/// `expected argument at index 0 to have type code '^@', but found '^^{CGColor}'`
/// （表现是应用起不来，崩在 `objc2-foundation/src/generated/NSArray.rs`）。
///
/// 修法是把指针擦成 [`AnyObject`] 再进数组 —— 这与 ObjC 里写
/// `@[(__bridge id)color.CGColor, …]` 是同一件事：CGColor 是 CoreFoundation 类型，
/// 但底层就是 ObjC 对象（`__NSCFType`），能响应 retain/release，所以放进 NSArray 合法。
/// **对象身份与所有权都不变**：调用方仍持有 `Retained<CGColor>`，数组各自 retain 一份。
fn cg_color_array(colors: &[Retained<CGColor>]) -> Retained<NSArray> {
    let objects: Vec<&AnyObject> = colors
        .iter()
        .map(|cg| unsafe { &*(Retained::as_ptr(cg) as *const AnyObject) })
        .collect();
    let array = NSArray::from_slice(&objects);
    // `setColors:` 收无泛型的 NSArray；元素身份不变，只是擦掉 Rust 侧泛型。
    unsafe { Retained::cast_unchecked(array) }
}

// ==========================================
// 按钮
// ==========================================

/// 按钮的主题形态（token 里的按钮族）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Face {
    /// 普通按钮（`--bbg` 族）：顶栏导航、图片、跳转、面板 chip。
    Normal,
    /// 小圆角 chip（`--bbg` 族 + `--r1`）：面板 chip、标签条「＋ / 历史」
    /// （设计稿 `.chip/.tabadd/.tabhist` 用 `--r1`，而 `.btn/.sbtn` 用 `--r3`）。
    Chip,
    /// 主按钮（`--sbg` 族）：发送 / 选中的 chip。
    Primary,
    /// 小圆角主色 chip（`--sbg` 族 + `--r1`）：停止按钮（设计稿 `.stop`）。
    ChipPrimary,
    /// 输入框式 chip（`--fbg` 族）：待发送图片条目。
    Field,
    /// 选中的会话标签（`--tabon` 族）。
    TabOn,
    /// 无底无边、仅文字（未选中标签、「×」等；`ink` 由调用方给主题槽位颜色）。
    Text { ink: Rgba },
}

struct FaceSpec {
    fill: Option<Fill>,
    ink: Rgba,
    edge: Option<Rgba>,
    bevel: Bevel,
    /// 外投影（`--bsh` / `--ssh` / `--tabonsh` 里的 `var(--contact)`）。
    shadow: Elevation,
    radius: f64,
    text_shadow: Option<Shadow>,
}

fn face_spec(face: Face) -> FaceSpec {
    face_spec_with(super::tokens(), face)
}

/// 面 → 具体 token 值。`tokens` 显式传入：运行期由 [`face_spec`] 取全局当前主题，
/// 单测可以按主题逐张表核对（不受全局状态与并行用例影响）。
fn face_spec_with(t: &'static Tokens, face: Face) -> FaceSpec {
    match face {
        Face::Normal => FaceSpec {
            fill: Some(t.btn_bg),
            ink: t.btn_ink,
            edge: Some(t.btn_edge),
            bevel: t.btn_bevel,
            shadow: t.btn_shadow,
            radius: f64::from(t.radii.btn),
            text_shadow: t.btn_text_shadow,
        },
        Face::Chip => FaceSpec {
            fill: Some(t.btn_bg),
            ink: t.btn_ink,
            edge: Some(t.btn_edge),
            bevel: t.btn_bevel,
            shadow: t.btn_shadow,
            radius: f64::from(t.radii.sm),
            text_shadow: t.btn_text_shadow,
        },
        Face::Primary => FaceSpec {
            fill: Some(t.primary_bg),
            ink: t.primary_ink,
            edge: Some(t.primary_edge),
            bevel: t.primary_bevel,
            shadow: t.primary_shadow,
            radius: f64::from(t.radii.btn),
            text_shadow: t.primary_text_shadow,
        },
        Face::ChipPrimary => FaceSpec {
            fill: Some(t.primary_bg),
            ink: t.primary_ink,
            edge: Some(t.primary_edge),
            bevel: t.primary_bevel,
            shadow: t.primary_shadow,
            radius: f64::from(t.radii.sm),
            text_shadow: t.primary_text_shadow,
        },
        Face::Field => FaceSpec {
            fill: Some(t.field_bg),
            ink: t.ink,
            edge: Some(t.field_edge),
            bevel: t.field_bevel,
            shadow: Elevation::NONE,
            radius: f64::from(t.radii.sm),
            text_shadow: None,
        },
        Face::TabOn => FaceSpec {
            fill: Some(t.tab_on_bg),
            ink: t.ink,
            edge: Some(t.tab_on_edge),
            bevel: t.tab_on_bevel,
            shadow: t.tab_on_shadow,
            radius: f64::from(t.radii.sm),
            text_shadow: None,
        },
        Face::Text { ink } => FaceSpec {
            fill: None,
            ink,
            edge: None,
            bevel: Bevel::NONE,
            shadow: Elevation::NONE,
            radius: 0.0,
            text_shadow: None,
        },
    }
}

/// 按主题给按钮贴皮：实色底（why 见模块头）、描边、内立体线、圆角、标题色与文字投影。
///
/// 需要重刷可用态（启用/禁用）的按钮在 `setEnabled` 之后再调一次即可 ——
/// 禁用态 = **底色降透明度 + 标题降透明度**（自绘底没有系统 bezel 的自动变灰）。
/// 只降标题色的旧口径实测对比度 ~2:1，看起来像「配色错了的可用按钮」（评审实机
/// 证据 2026-10-05）；底色先透明化，标题的降透明才有「灰掉」的语义。
pub(crate) fn style_button(button: &NSButton, face: Face) {
    button.setBordered(false);
    button.setWantsLayer(true);
    // 自绘面没有系统 bezel：键焦点落到按钮上时系统会画聚焦环（实机：设置窗
    // 首行竖栏 Tab 顶着白色圆角圈，2026-10-05），与主题面互斥，统一关掉。
    button.setFocusRingType(NSFocusRingType::None);
    let spec = face_spec(face);
    let enabled = button.isEnabled();
    if let Some(layer) = button.layer() {
        without_implicit_animation(|| {
            remove_sublayers(&layer, BEVEL_PREFIX);
            match &spec.fill {
                Some(fill) => {
                    // 禁用态：底改中性 `--fbg2`（strip_bg），不再把主色减半叠成泥色
                    // （2026-10-05 评审实测：主色 ×0.5 叠深底 + 标题再 ×0.5 = 1.48:1
                    // 不可读；设计稿口径是「中性半透明底 + 可辨的次要文字」）。
                    let painted = if enabled {
                        fill.base_color()
                    } else {
                        crate::ui::theme::tokens().strip_bg
                    };
                    layer.setBackgroundColor(Some(&color(painted).CGColor()));
                }
                None => layer.setBackgroundColor(None),
            }
            if let Some(edge) = spec.edge {
                if enabled {
                    layer.setBorderWidth(1.0);
                    layer.setBorderColor(Some(&color(edge).CGColor()));
                } else {
                    layer.setBorderWidth(0.0);
                }
            } else {
                layer.setBorderWidth(0.0);
            }
            layer.setCornerRadius(spec.radius);
        });
        // 按钮层的几何随视图（普通 NSView，y 向上）；按钮视图自身不翻转。
        // 禁用态不画立体线与外投影（复评实测：主按钮 bevel 的底缘浅线在禁用态是
        // 控件内唯一亮于底的元素，读作残留错线）。
        if enabled {
            apply_bevel(&layer, &spec.bevel, false);
            // `--bsh` / `--ssh` / `--tabonsh` 的 `var(--contact)` 外投影（同一坐标口径）。
            apply_elevation(&layer, &spec.shadow, false, spec.radius);
        }
    }
    let (ink, shadow) = if enabled {
        (spec.ink, spec.text_shadow.as_ref())
    } else {
        // 禁用文字取 **bright ink 全值**：AppKit 还会把禁用标题整体压暗约四成
        // （复评实测：ink×0.75 经系统压制后仅 1.2~2.1:1；等效基准应是亮文字），
        // 全值经压制后 ≈3:1——足够读出「这是不可用的按钮」。同时**去掉文字投影**：
        // 主按钮的深色投影会把小按钮上的浅字再压暗一档（复评：发送 1.35:1 vs
        // 同路径的保存 2.87:1，差异即投影在小控件上的占比）。
        (crate::ui::theme::tokens().ink, None)
    };
    set_title_ink(button, ink, shadow);
}

/// 只换按钮标题颜色/投影（不重贴底；`Face::Text` 的标签、轻量状态刷新同用）。
pub(crate) fn set_title_ink(button: &NSButton, ink: Rgba, shadow: Option<&Shadow>) {
    let title = button.title();
    let attributed =
        NSMutableAttributedString::initWithString(NSMutableAttributedString::alloc(), &title);
    let range = NSRange {
        location: 0,
        length: title.length(),
    };
    unsafe {
        attributed.addAttribute_value_range(
            NSForegroundColorAttributeName,
            as_any(&*color(ink)),
            range,
        );
    }
    if let Some(shadow) = shadow {
        let text_shadow = NSShadow::new();
        // 文字画在普通（y 向上）的按钮视图里：视觉向下 = 负 y，与 CALayer 未翻转口径同。
        text_shadow.setShadowOffset(NSSize::new(0.0, -f64::from(shadow.dy)));
        text_shadow.setShadowBlurRadius(f64::from(shadow.blur));
        text_shadow.setShadowColor(Some(&color(shadow.color)));
        unsafe {
            attributed.addAttribute_value_range(
                NSShadowAttributeName,
                as_any(&*text_shadow),
                range,
            );
        }
    }
    button.setAttributedTitle(&attributed);
}

// ==========================================
// 复合底板（面板 / 顶栏 / 输入框共用）
// ==========================================

/// 一块底板的完整外观（token 槽位与设计稿的 `--pbg/--ptex/--panel-grain/--pedge/…`
/// 一族一一对应）。token 全是 `Copy`，这里按值持有，调用方直接贴 token 字段。
#[derive(Clone, Copy)]
pub(crate) struct Backdrop {
    /// 底（`--pbg` / `--bar` / `--ibg` / `--fbg`）。
    pub fill: Fill,
    /// 纹理层（`--ptex`；无则 `None`）。
    pub sheen: Option<Sheen>,
    /// 细颗粒透明度（`--panel-grain`；无则不叠）。
    pub grain: Option<f32>,
    /// 外描边（`--pedge` 等；`None` = 无边框）。
    pub stroke: Option<Rgba>,
    /// 描边宽（px；通常 1.0）。
    pub stroke_width: f64,
    /// 内立体线（`--pshadow` 的 inset 部分 / `--barsh` 等）。
    pub bevel: Bevel,
    /// 外投影（`Elevation::NONE` = 无）。
    pub elevation: Elevation,
    /// 圆角（`Radii` 取值；0 = 直角）。
    pub corner_radius: f64,
    /// 目标图层是否左上原点（翻转视图）。
    pub flipped: bool,
}

/// 画一块底板：底 → 纹理层 → 颗粒 → 描边 → 内立体线 → 圆角 → 投影。
///
/// 幂等：各步按自身前缀清旧建新；重复调用不会叠层。
pub(crate) fn paint_backdrop(layer: &CALayer, spec: &Backdrop) {
    apply_fill(layer, &spec.fill, spec.flipped);
    match spec.sheen {
        Some(sheen) => apply_sheen(layer, &sheen, spec.flipped),
        None => without_implicit_animation(|| remove_sublayers(layer, SHEEN_PREFIX)),
    }
    match spec.grain {
        Some(alpha) => apply_grain(layer, alpha),
        None => without_implicit_animation(|| remove_sublayers(layer, GRAIN_PREFIX)),
    }
    match spec.stroke {
        Some(color) => set_stroke(layer, color, spec.stroke_width),
        None => set_stroke(layer, Rgba::black_alpha(0.0), 0.0),
    }
    apply_bevel(layer, &spec.bevel, spec.flipped);
    set_corner_radius(layer, spec.corner_radius);
    apply_elevation(layer, &spec.elevation, spec.flipped, spec.corner_radius);
}

// ==========================================
// 内部工具
// ==========================================

fn layer_size(layer: &CALayer) -> (f64, f64) {
    let bounds = layer.bounds();
    (bounds.size.width, bounds.size.height)
}

/// 摘掉名字带前缀的全部子层（本模块所有背景件都靠它做「先清后建」的幂等）。
///
/// **必须先收集再摘，不能边枚举边删**：`sublayers` 的 `iter()` 走 `NSFastEnumeration`，
/// 而 `removeFromSuperlayer` 会改到底层子层数组，Foundation 立刻抛
/// `mutation detected during enumeration`；objc2 把 ObjC 异常转成 Rust panic，
/// **整个宿主当场崩**。触发条件是「重绘时层上已有旧件」，也就是幂等清理的**第二趟** ——
/// 所以启动绘制阶段就会撞上（`paint_backdrop` 每次重绘都会走这里）。
/// 收集到 `Vec` 里再摘，把枚举与修改分成两步，就绕开了这个保护机制。
///
/// **`-subviews` 没这个问题，别顺手去"修"**：`-[NSView subviews]` 返回的是**快照副本**
/// （实测：4 个子视图边枚举边 `removeFromSuperview` 不炸），`-[CALayer sublayers]` 不是。
/// 两者同名同形却不同行为，`macos_chat.rs` 里几处 `subviews().iter()` + 摘除的写法是安全的。
/// objc2 的检查在**每次 `next()`**上（见 `objc2-foundation/src/iter.rs`），
/// 所以「还剩 ≥2 项时改集合」必炸，恰好只剩 1 项时反而逃得掉 —— 别用单元素场景去试。
fn remove_sublayers(layer: &CALayer, prefix: &str) {
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return;
    };
    let doomed: Vec<_> = sublayers
        .iter()
        .filter(|sublayer| {
            sublayer
                .name()
                .is_some_and(|name| name.to_string().starts_with(prefix))
        })
        .collect();
    for sublayer in doomed {
        sublayer.removeFromSuperlayer();
    }
}

// ==========================================
// 开关（设置窗 `FieldKind::Bool`）
// ==========================================

/// 开关滑块子层的命名前缀（唯一一件；幂等重绘靠它先清后建）。
const SWITCH_KNOB_PREFIX: &str = "deskpet.theme.switchknob.";
/// 滑块 z 序（负值：任何后加的子视图都在它上面）。
const SWITCH_KNOB_Z: f64 = -50.0;
/// 设计尺寸（逻辑点）：滑块 13×13、距外缘 2px（1px 边框 + 1px 内距，与设计稿
/// `.sw i` 的 `top:1/left:1` 含边框口径一致）。
const SWITCH_KNOB_SIZE: f64 = 13.0;
const SWITCH_KNOB_INSET: f64 = 2.0;

/// 主题开关：轨道按开/关取 `switch_on_*` / `switch_off_*`，滑块贴左（关）/
/// 贴右（开）并带 `--contact` 影。
///
/// 幂等（同前缀子层先清后建）；轨道尺寸由调用方 `setFrame` 给出（设计 32×17），
/// 滑块随轨道高度自适应（过矮时收缩，不越界）。
pub(crate) fn apply_switch(layer: &CALayer, on: bool) {
    apply_switch_with(layer, on, super::tokens());
}

fn apply_switch_with(layer: &CALayer, on: bool, t: &super::tokens::Tokens) {
    let (track, edge) = if on {
        (t.switch_on_bg, t.switch_on_edge)
    } else {
        (t.switch_off_bg, t.switch_off_edge)
    };
    let (w, h) = layer_size(layer);
    let knob = SWITCH_KNOB_SIZE.min((h - SWITCH_KNOB_INSET * 2.0).max(1.0));
    let knob_x = if on {
        (w - SWITCH_KNOB_INSET - knob).max(SWITCH_KNOB_INSET)
    } else {
        SWITCH_KNOB_INSET
    };
    without_implicit_animation(|| {
        remove_sublayers(layer, SWITCH_KNOB_PREFIX);
        apply_fill(layer, &track, false);
        set_stroke(layer, edge, 1.0);
        set_corner_radius(layer, h / 2.0);
        let knob_layer = CALayer::new();
        knob_layer.setName(Some(&NSString::from_str(SWITCH_KNOB_PREFIX)));
        knob_layer.setZPosition(SWITCH_KNOB_Z);
        knob_layer.setFrame(NSRect::new(
            NSPoint::new(knob_x, (h - knob) / 2.0),
            NSSize::new(knob, knob),
        ));
        apply_fill(&knob_layer, &t.switch_knob, false);
        set_corner_radius(&knob_layer, knob / 2.0);
        // 滑块影 = 设计稿全局 `--contact`（`0 1px 2px rgba(0,0,0,.30)`，三主题同值）。
        // tokens 里与气泡接触影同值 —— 借用它取单一真值，不在绘制层复制常量。
        apply_elevation(&knob_layer, &t.bubble_user_shadow, false, knob / 2.0);
        layer.addSublayer(&knob_layer);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::theme::ThemeId;
    use objc2_core_graphics::CGColor;

    /// 读回 CGColor 的 sRGB 分量（测试用；只支持 4 分量的 RGBA 色彩空间）。
    fn cgcolor_components(c: &CGColor) -> [f64; 4] {
        assert_eq!(
            CGColor::number_of_components(Some(c)),
            4,
            "测试只支持 RGBA 色彩空间（monochrome 需区分处理）"
        );
        let comps = CGColor::components(Some(c));
        assert!(!comps.is_null(), "CGColor 分量指针为空");
        unsafe { [*comps, *comps.add(1), *comps.add(2), *comps.add(3)] }
    }

    fn named_sublayers(layer: &CALayer, prefix: &str) -> Vec<Retained<CALayer>> {
        let Some(sublayers) = (unsafe { layer.sublayers() }) else {
            return Vec::new();
        };
        sublayers
            .iter()
            .filter(|s| {
                s.name()
                    .is_some_and(|name| name.to_string().starts_with(prefix))
            })
            .collect()
    }

    /// 读回一层 `Fill` 的实际首色：实色读 `backgroundColor`，渐变读渐变层首色
    /// （三主题里同一槽位可能是实色或渐变，测试不预设）。
    fn fill_first_color(layer: &CALayer) -> Retained<CGColor> {
        if let Some(bg) = layer.backgroundColor() {
            return bg;
        }
        let fills = named_sublayers(layer, &format!("{FILL_PREFIX}base"));
        assert_eq!(fills.len(), 1, "渐变 Fill 恰好一件底子层");
        let gradient: &CAGradientLayer =
            unsafe { &*(Retained::as_ptr(&fills[0]) as *const CAGradientLayer) };
        let colors = gradient.colors().expect("渐变层有 colors");
        let first = colors.objectAtIndex(0);
        unsafe { Retained::cast_unchecked(first) }
    }

    fn assert_color_close(actual: &CGColor, expected: Rgba, what: &str) {
        let got = cgcolor_components(actual);
        let want = rgba_components(expected);
        assert!(
            got.iter()
                .zip(want.iter())
                .all(|(a, b)| (a - b).abs() < 0.01),
            "{what}：期望 {want:?}，实际 {got:?}"
        );
    }

    /// 开关绘制路径**真跑一遍**（AGENTS §9：新增绘制路径必须有单测走通）：
    /// 轨道取色、滑块换边、幂等（同前缀重建不叠加）。
    #[test]
    fn 开关轨道取色与滑块换边() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            let layer = CALayer::new();
            layer.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(32.0, 17.0)));
            // 关态：轨道底/边取 switch_off_*，滑块贴左且只有一件。
            apply_switch_with(&layer, false, t);
            let bg = fill_first_color(&layer);
            assert_color_close(&bg, t.switch_off_bg.base_color(), "关态轨道底");
            let border = layer.borderColor().expect("轨道有描边");
            assert_color_close(&border, t.switch_off_edge, "关态轨道描边");
            let knobs = named_sublayers(&layer, SWITCH_KNOB_PREFIX);
            assert_eq!(knobs.len(), 1, "{id:?} 恰好一件滑块");
            let frame = knobs[0].frame();
            assert!(
                (frame.origin.x - SWITCH_KNOB_INSET).abs() < 0.01,
                "{id:?} 关态滑块贴左，实际 x={}",
                frame.origin.x
            );
            assert!(
                (frame.size.width - SWITCH_KNOB_SIZE).abs() < 0.01,
                "{id:?} 滑块 13×13"
            );
            let knob_bg = fill_first_color(&knobs[0]);
            assert_color_close(&knob_bg, t.switch_knob.base_color(), "滑块底");
            // 开态：轨道换 switch_on_*、滑块贴右、仍只有一件（幂等重绘不叠加）。
            apply_switch_with(&layer, true, t);
            let bg = fill_first_color(&layer);
            assert_color_close(&bg, t.switch_on_bg.base_color(), "开态轨道底");
            let border = layer.borderColor().expect("轨道有描边");
            assert_color_close(&border, t.switch_on_edge, "开态轨道描边");
            let knobs = named_sublayers(&layer, SWITCH_KNOB_PREFIX);
            assert_eq!(knobs.len(), 1, "{id:?} 幂等：不叠加第二件滑块");
            let frame = knobs[0].frame();
            assert!(
                ((frame.origin.x + frame.size.width) - (32.0 - SWITCH_KNOB_INSET)).abs() < 0.01,
                "{id:?} 开态滑块贴右，实际右缘={}",
                frame.origin.x + frame.size.width
            );
        }
    }

    /// 渐变真的能建出来 —— **这条是崩溃回归测试**。
    ///
    /// 曾经的写法是 `NSArray::from_retained_slice::<CGColor>`，元素静态类型被记成
    /// `^{CGColor}`，而 `NSArray` 只收 ObjC 对象（`^@`）；objc2 在
    /// `initWithObjects:count:` 上的运行期类型校验直接 panic，**表现是整个应用起不来**
    /// （崩在 `objc2-foundation/src/generated/NSArray.rs`）。编译期查不出来，
    /// 只有真把这条路径走一遍才会炸，所以必须有这条测试。
    ///
    /// 三套主题的三种渐变形状都过一遍：线性（`Fill::Linear`）、柱面多档（Chrome 面板
    /// 的 10 档）、径向（Chrome 的舞台底）。
    #[test]
    fn 三套主题的渐变都能建出来() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            let bounds = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(320.0, 200.0));

            // 面板底：实色 / 渐变 / 带条纹都要能整条落地（含子层装配）。
            let host = CALayer::new();
            host.setFrame(bounds);
            apply_fill(&host, &tokens.panel_bg, false);

            // 线性与多档：把三套主题里所有 `Fill::Linear` 都建一遍。
            for fill in [
                tokens.bar_bg,
                tokens.btn_bg,
                tokens.primary_bg,
                tokens.bubble_user_bg,
            ] {
                if let Fill::Linear(stops) = fill {
                    let layer = linear_gradient(stops, false, bounds).expect("线性渐变应能构建");
                    let colors = layer.colors().expect("setColors 必须真的写进去");
                    assert_eq!(
                        colors.count(),
                        stops.len(),
                        "{:?}：写进渐变的色档数应与 token 一致",
                        id
                    );
                }
            }

            // 径向：Chrome 的舞台底是径向，其余是线性；两种都要走通。
            if let Fill::Radial {
                cx,
                cy,
                rx,
                ry,
                stops,
            } = tokens.stage_bg
            {
                let layer =
                    radial_gradient(cx, cy, rx, ry, stops, bounds).expect("径向渐变应能构建");
                assert_eq!(
                    layer.colors().expect("setColors 必须真的写进去").count(),
                    stops.len()
                );
            }
        }
    }

    /// 清理旧件不能边枚举边摘 —— **这条是崩溃回归测试**。
    ///
    /// 曾经的写法是 `for sublayer in sublayers.iter() { …removeFromSuperlayer() }`：
    /// `NSArray::iter()` 走 `NSFastEnumeration`，而 `removeFromSuperlayer` 会改底层子层数组，
    /// Foundation 抛 `mutation detected during enumeration`，objc2 把它转成 Rust panic。
    /// 触发条件是**重绘时层上已有旧件**（幂等清理的第二趟），所以启动绘制阶段就会撞，
    /// 表现同样是**整个应用起不来**。编译期查不出来，只有真走一遍清理才会炸。
    #[test]
    fn 清理子层不在枚举期间改集合() {
        let host = CALayer::new();
        host.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(64.0, 64.0)));

        // 三条带前缀的旧件 + 一条不该动的：删除发生在第一条之后，
        // 枚举还没走完就已被改，正是崩溃的现场。
        for index in 0..3 {
            let stale = CALayer::new();
            stale.setName(Some(&NSString::from_str(&format!("{SHEEN_PREFIX}{index}"))));
            host.addSublayer(&stale);
        }
        let keep = CALayer::new();
        keep.setName(Some(&NSString::from_str("deskpet.theme.bevel.0")));
        host.addSublayer(&keep);

        remove_sublayers(&host, SHEEN_PREFIX);

        let remaining = (unsafe { host.sublayers() }).expect("父层应还剩子层");
        assert_eq!(remaining.count(), 1, "只该留下不带前缀的那条");
        assert_eq!(
            remaining
                .objectAtIndex(0)
                .name()
                .expect("留下的层有名字")
                .to_string(),
            "deskpet.theme.bevel.0",
            "留下的必须是不带前缀的那条（前缀按字面匹配，不误伤别的前缀）"
        );
    }

    /// `Rgba`（0..1）→ AppKit 分量：边界与 alpha 原样、越界夹取。
    #[test]
    fn rgbei_分量边界与alpha() {
        assert_eq!(rgba_components(Rgba::hex(0x000000)), [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(rgba_components(Rgba::hex(0xFFFFFF)), [1.0, 1.0, 1.0, 1.0]);
        let half = rgba_components(Rgba::rgba(0.5, 0.25, 0.75, 0.4));
        for (got, want) in half.into_iter().zip([0.5, 0.25, 0.75, 0.4]) {
            // f32 → f64 有表示误差（如 0.4f32 ≠ 0.4f64），按分量近似比。
            assert!((got - want).abs() < 1e-6, "分量 {got} != {want}");
        }
        // 越界值（token 不该产生，但转换不做假设）夹到 [0,1]。
        let wild = Rgba::rgba(-1.0, 2.0, 0.5, 1.5);
        assert_eq!(rgba_components(wild), [0.0, 1.0, 0.5, 1.0]);
    }

    /// 按索引名精确找一件子层（`named_sublayers` 前缀匹配；命名唯一时用它取单件）。
    fn sheen_layer_by_index(host: &CALayer, index: usize) -> Option<Retained<CALayer>> {
        named_sublayers(host, &format!("{SHEEN_PREFIX}{index}"))
            .into_iter()
            .next()
    }

    /// 一件带的颜色（硬线读 `backgroundColor`；软边读渐变带的两端——另一端是同色透明）。
    fn band_colors(layer: &CALayer) -> Vec<Rgba> {
        if let Some(bg) = layer.backgroundColor() {
            let [r, g, b, a] = cgcolor_components(&bg);
            return vec![Rgba::rgba(r as f32, g as f32, b as f32, a as f32)];
        }
        // 测试里软边带都是本模块用 CAGradientLayer 建的；借用的对象指针按类型重解释。
        let gradient: &CAGradientLayer =
            unsafe { &*(layer as *const CALayer as *const CAGradientLayer) };
        let colors = gradient.colors().expect("软边带是渐变层");
        (0..colors.count())
            .map(|i| {
                let c: Retained<CGColor> =
                    unsafe { Retained::cast_unchecked(colors.objectAtIndex(i)) };
                let [r, g, b, a] = cgcolor_components(&c);
                Rgba::rgba(r as f32, g as f32, b as f32, a as f32)
            })
            .collect()
    }

    /// 带中是否含某色（RGB 分量与 alpha 都在容差内）。
    fn band_has_color(layer: &CALayer, wanted: Rgba) -> bool {
        band_colors(layer).iter().any(|c| {
            (c.r - wanted.r).abs() < 0.01
                && (c.g - wanted.g).abs() < 0.01
                && (c.b - wanted.b).abs() < 0.01
                && (c.a - wanted.a).abs() < 0.01
        })
    }

    /// **层序回归测试**：`--ptex` 的声明序 = CSS 多背景序，**首层在最上**。
    ///
    /// 把 `apply_sheen` 真走一遍（生成子层、读回 zPosition）：此前按声明序递增 z，
    /// 拉丝的条纹与铜绿的纹理都被后声明的渐变盖住。首层的 z 必须严格高于其余层。
    #[test]
    fn 面板纹理首层在最上() {
        // 本用例真跑 apply_sheen：铜绿面板会生成斑块纹理进全局缓存，与
        // `全局主题状态机_代际与纹理驻留` 的驻留断言共用同一份全局 —— 必须串行。
        let _guard = crate::ui::theme::GLOBAL_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        static TWO_LAYERS: [SheenLayer; 2] = [
            SheenLayer::Grad(&[
                (0.0, Rgba::white_alpha(0.08)),
                (1.0, Rgba::black_alpha(0.14)),
            ]),
            SheenLayer::Edge {
                side: EdgeSide::Bottom,
                color: Rgba::white_alpha(0.6),
                width: 1.0,
            },
        ];
        let sheen = Sheen(&TWO_LAYERS);
        let host = CALayer::new();
        host.setFrame(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(200.0, 120.0),
        ));
        apply_sheen(&host, &sheen, false);

        let first = sheen_layer_by_index(&host, 0).expect("首层子层");
        let second = sheen_layer_by_index(&host, 1).expect("第二层子层");
        assert!(
            first.zPosition() > second.zPosition(),
            "首层 zPosition({}) 必须高于第二层({})：CSS 首个背景在最上",
            first.zPosition(),
            second.zPosition()
        );
        assert_eq!(second.zPosition(), SHEEN_Z - 1.0, "z 按声明序递减");

        // 三套主题同一条规则：逐索引读回，z 必须严格递减（首层最高）。
        for id in ThemeId::ALL {
            let t = id.tokens();
            let sheen = t.panel_tex.expect("三套主题都有面板纹理");
            let host = CALayer::new();
            host.setFrame(NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(320.0, 200.0),
            ));
            apply_sheen(&host, &sheen, false);
            let zs: Vec<f64> = (0..sheen.0.len())
                .map(|index| {
                    sheen_layer_by_index(&host, index)
                        .unwrap_or_else(|| panic!("{id:?} 第 {index} 层没画出来"))
                        .zPosition()
                })
                .collect();
            for pair in zs.windows(2) {
                assert!(
                    pair[0] > pair[1],
                    "{id:?} 子层应按声明序递减 z，实际 {zs:?}"
                );
            }
            assert_eq!(zs[0], SHEEN_Z, "{id:?} 首层 z = SHEEN_Z");
        }
    }

    /// **层序与侧别回归**：铬面板的「地平线」画在**底边**（设计稿 `0deg` 的起点在底边）。
    ///
    /// 承载层是普通（y 向上）图层，视觉底边 = 低 y；`apply_sheen(…, false)` 下白线
    /// 必须贴 y ≈ 0（此前画在顶边）。
    #[test]
    fn 铬面板地平线画在底边() {
        let t = ThemeId::Chrome.tokens();
        let sheen = t.panel_tex.expect("铬主题有面板纹理");
        let host = CALayer::new();
        host.setFrame(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(200.0, 120.0),
        ));
        apply_sheen(&host, &sheen, false);
        let edge = sheen_layer_by_index(&host, 1).expect("第二层是地平线");
        let frame = edge.frame();
        assert!(
            frame.origin.y.abs() < 0.01,
            "白线贴视觉底边（非翻转图层 y=0），实际 y={}",
            frame.origin.y
        );
        assert_eq!(frame.size.height, 1.0, "1px 线");
        assert_color_close(
            &edge.backgroundColor().expect("边线是实色层"),
            Rgba::white_alpha(0.6),
            "地平线色",
        );
    }

    /// **声明序回归**：`Bevel.lines` 首条在最上（同侧多条线时），逐条都画。
    #[test]
    fn 立体线首条在最上() {
        static SOFT_THEN_HARD: [BevelLine; 2] = [
            BevelLine::top(InsetLine::soft(Rgba::black_alpha(0.26), 1.0, 2.0)),
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.9), 1.0)),
        ];
        let bevel = Bevel {
            lines: &SOFT_THEN_HARD,
        };
        let host = CALayer::new();
        host.setFrame(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(200.0, 120.0),
        ));
        apply_bevel(&host, &bevel, false);

        let layers = named_sublayers(&host, BEVEL_PREFIX);
        assert_eq!(layers.len(), 2, "两条顶线都要画");
        let first = named_sublayers(&host, &format!("{BEVEL_PREFIX}0"))
            .into_iter()
            .next()
            .expect("首条子层");
        let second = named_sublayers(&host, &format!("{BEVEL_PREFIX}1"))
            .into_iter()
            .next()
            .expect("第二条子层");
        assert!(
            first.zPosition() > second.zPosition(),
            "首条（软压暗）在最上：z({}) > z({})",
            first.zPosition(),
            second.zPosition()
        );
    }

    /// `FaceSpec` 的外投影槽位：`--bsh` / `--ssh` / `--tabonsh` 的 `var(--contact)`
    /// 必须接到对应按钮面（`style_button` 会把它 apply 到按钮层）。
    #[test]
    fn 按钮面的外投影槽位() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            assert_eq!(
                face_spec_with(t, Face::Normal).shadow,
                t.btn_shadow,
                "{id:?} 普通按钮"
            );
            assert_eq!(
                face_spec_with(t, Face::Primary).shadow,
                t.primary_shadow,
                "{id:?} 主按钮"
            );
            assert_eq!(
                face_spec_with(t, Face::TabOn).shadow,
                t.tab_on_shadow,
                "{id:?} 选中标签"
            );
            assert_eq!(
                face_spec_with(t, Face::Field).shadow,
                Elevation::NONE,
                "{id:?} 输入框无外投影"
            );
            assert_eq!(
                face_spec_with(t, Face::Text { ink: t.ink }).shadow,
                Elevation::NONE,
                "{id:?} 纯文字无外投影"
            );
        }
    }

    /// **单线入口回归**：`apply_line` 收到 `Bevel`（`--logsh` 多条内线）时逐条画；
    /// 铬主题的上白 + 下蓝灰两条都要出现，且分别在消息流容器的上/下缘。
    #[test]
    fn 消息流内阴影支持多条线() {
        for id in ThemeId::ALL {
            let t = id.tokens();
            let bevel = t.log_inset.expect("三套主题都有 --logsh");
            let host = CALayer::new();
            host.setFrame(NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(320.0, 200.0),
            ));
            // 平台的调用形状：侧别参数对 Bevel 输入被忽略。
            apply_line(&host, EdgeSide::Top, Some(&bevel), false);
            let layers = named_sublayers(&host, EDGE_PREFIX);
            assert_eq!(
                layers.len(),
                bevel.lines.len(),
                "{id:?} 每条 --logsh 内线都要画出来"
            );
        }

        let t = ThemeId::Chrome.tokens();
        let host = CALayer::new();
        host.setFrame(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(320.0, 200.0),
        ));
        apply_line(&host, EdgeSide::Top, t.log_inset.as_ref(), false);
        let layers = named_sublayers(&host, EDGE_PREFIX);
        assert_eq!(
            layers.len(),
            2,
            "铬的消息流内阴影是双线（此前只有单条黑线）"
        );
        // 普通（未翻转）图层：视觉上缘是高 y，视觉下缘是 y = 0。
        let white = layers
            .iter()
            .find(|l| l.frame().origin.y > 190.0)
            .expect("上白线贴上缘（高 y）");
        let grey = layers
            .iter()
            .find(|l| l.frame().origin.y.abs() < 0.01)
            .expect("下蓝灰线贴下缘（y = 0）");
        assert!(
            band_has_color(white, Rgba::white_alpha(0.5)),
            "上缘是白 .5 软线，实际 {:?}",
            band_colors(white)
        );
        assert!(
            band_has_color(
                grey,
                Rgba::rgba(60.0 / 255.0, 80.0 / 255.0, 110.0 / 255.0, 0.32)
            ),
            "下缘是蓝灰 .32 软线，实际 {:?}",
            band_colors(grey)
        );
    }

    /// `Fill::base_color` 的三种变体兜底：实色取自身；渐变取首档（从上往下）；
    /// 径向取末档（中心 → 边缘的终点）；空档退回黑（不 panic）。
    #[test]
    fn 底色兜底取三种变体的代表值() {
        let solid = Fill::Solid(Rgba::hex(0x123456));
        assert_eq!(solid.base_color(), Rgba::hex(0x123456));

        // token 表的 stops 必须是 `'static`（编译期常量），测试同口径。
        static LINEAR_STOPS: [(f32, Rgba); 2] =
            [(0.0, Rgba::hex(0x111111)), (1.0, Rgba::hex(0x222222))];
        static STRIPE_STOPS: [(f32, Rgba); 1] = [(0.0, Rgba::hex(0x333333))];
        static RADIAL_STOPS: [(f32, Rgba); 2] =
            [(0.0, Rgba::hex(0x444444)), (1.0, Rgba::hex(0x555555))];

        let linear = Fill::Linear(&LINEAR_STOPS);
        assert_eq!(linear.base_color(), Rgba::hex(0x111111), "渐变取首档");

        let striped = Fill::Striped {
            stops: &STRIPE_STOPS,
            stripes: &[],
        };
        assert_eq!(striped.base_color(), Rgba::hex(0x333333), "条纹取渐变首档");

        let radial = Fill::Radial {
            cx: 0.5,
            cy: 0.5,
            rx: 1.0,
            ry: 1.0,
            stops: &RADIAL_STOPS,
        };
        assert_eq!(radial.base_color(), Rgba::hex(0x555555), "径向取末档");

        assert_eq!(
            Fill::Linear(&[]).base_color(),
            Rgba::black_alpha(1.0),
            "空档不 panic、退回黑"
        );
        let empty_radial = Fill::Radial {
            cx: 0.0,
            cy: 0.0,
            rx: 1.0,
            ry: 1.0,
            stops: &[],
        };
        assert_eq!(empty_radial.base_color(), Rgba::black_alpha(1.0));
    }

    /// 立体线：无项不画；硬线宽 = width、贴对应边；软线带高 = width + blur、
    /// 实色端在上缘（顶边线）。
    #[test]
    fn 立体线该画几条与在哪() {
        let size = (100.0, 50.0);
        assert!(bevel_bands(&Bevel::NONE, size, true).is_empty(), "无线不画");

        // `lines` 是 `&'static`：测试里用 static 承载（临时量不做常量提升）。
        static TOP_ONLY: [BevelLine; 1] =
            [BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.5), 2.0))];
        static BOTH: [BevelLine; 2] = [
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.5), 1.0)),
            BevelLine::bottom(InsetLine::soft(Rgba::black_alpha(0.5), 2.0, 5.0)),
        ];

        let top_only = Bevel { lines: &TOP_ONLY };
        let bands = bevel_bands(&top_only, size, true);
        assert_eq!(bands.len(), 1, "只有顶线时只画一条");
        assert_eq!(
            bands[0].rect,
            RectF {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 2.0
            },
            "翻转图层：顶线贴 y = 0、线宽即带高"
        );
        assert_eq!(bands[0].blur, 0.0);

        let both = Bevel { lines: &BOTH };
        let bands = bevel_bands(&both, size, true);
        assert_eq!(bands.len(), 2, "顶 + 底各一条");
        assert_eq!(bands[1].rect.y, 43.0, "底线贴翻转图层下缘（50 - 7）");
        assert_eq!(bands[1].rect.h, 7.0, "软边带高 = width + blur");
        assert_eq!(
            bands[1].solid_side,
            EdgeSide::Bottom,
            "底线的实色端贴下缘、向上渐隐（凹陷的内阴影方向）"
        );
    }

    /// 同一侧可以叠多条线（铬主题 `--finner` 的软压暗 + 硬白线都贴上缘）：
    /// 顺序 = 声明序，两条都真的生成。
    #[test]
    fn 同侧多条线按声明序展开() {
        let size = (100.0, 50.0);
        static TWO_TOPS: [BevelLine; 2] = [
            BevelLine::top(InsetLine::soft(
                Rgba::rgba(40.0 / 255.0, 60.0 / 255.0, 100.0 / 255.0, 0.26),
                1.0,
                2.0,
            )),
            BevelLine::top(InsetLine::hard(Rgba::white_alpha(0.9), 1.0)),
        ];
        let two_tops = Bevel { lines: &TWO_TOPS };
        let bands = bevel_bands(&two_tops, size, true);
        assert_eq!(bands.len(), 2, "两条顶线都要出现（此前第二条被塞到底边）");
        assert!(
            bands.iter().all(|band| band.solid_side == EdgeSide::Top),
            "两条都贴上缘"
        );
        assert_eq!(bands[1].rect.h, 1.0, "第二条是硬白线");
    }

    /// 内环展开成四条互不重叠的边线（横线占满全宽、竖线只在横线之间）。
    #[test]
    fn 内环四条不重叠() {
        let size = (100.0, 50.0);
        let bands = ring_bands(&InsetLine::hard(Rgba::white_alpha(0.55), 1.0), size);
        assert_eq!(bands.len(), 4);
        assert_eq!(
            bands[0].rect,
            RectF {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 1.0
            }
        );
        assert_eq!(
            bands[1].rect,
            RectF {
                x: 0.0,
                y: 49.0,
                w: 100.0,
                h: 1.0
            }
        );
        assert_eq!(
            bands[2].rect,
            RectF {
                x: 0.0,
                y: 1.0,
                w: 1.0,
                h: 48.0
            }
        );
        assert_eq!(
            bands[3].rect,
            RectF {
                x: 99.0,
                y: 1.0,
                w: 1.0,
                h: 48.0
            }
        );
        assert!(ring_bands(&InsetLine::hard(Rgba::white_alpha(0.5), 1.0), (0.0, 0.0)).is_empty());
    }

    /// 左右两侧：占满全高、贴对应纵边，与图层翻转无关（AppKit 只镜像 y）。
    #[test]
    fn 左右边线与翻转无关() {
        let size = (100.0, 50.0);
        let line = InsetLine::hard(Rgba::black_alpha(0.55), 1.0);
        for flipped in [true, false] {
            let left = edge_band(&line, EdgeSide::Left, size, flipped);
            assert_eq!(
                left.rect,
                RectF {
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 50.0
                }
            );
            let right = edge_band(&line, EdgeSide::Right, size, flipped);
            assert_eq!(
                right.rect,
                RectF {
                    x: 99.0,
                    y: 0.0,
                    w: 1.0,
                    h: 50.0
                }
            );
        }
    }

    /// 未翻转图层（y 向上）镜像：顶线贴上缘（回退到高 y），底线贴 y = 0。
    #[test]
    fn 未翻转图层的边缘镜像() {
        let size = (100.0, 50.0);
        let top = edge_band(
            &InsetLine::hard(Rgba::white_alpha(0.5), 2.0),
            EdgeSide::Top,
            size,
            false,
        );
        assert_eq!(top.rect.y, 48.0, "普通图层上缘是高 y");
        let bottom = edge_band(
            &InsetLine::hard(Rgba::black_alpha(0.5), 1.0),
            EdgeSide::Bottom,
            size,
            false,
        );
        assert_eq!(bottom.rect.y, 0.0, "普通图层下缘是 y = 0");
    }

    /// 软边渐变的颜色顺序：竖向带看 `flipped`（上端在两种几何里相反）；
    /// 横向带两平台同向（左端即起点）。
    #[test]
    fn 软边渐变的方向() {
        assert!(
            band_solid_first(EdgeSide::Top, true),
            "翻转 + 实色在上缘 → colors[0] 实色"
        );
        assert!(
            !band_solid_first(EdgeSide::Top, false),
            "普通图层同场景要反过来"
        );
        assert!(
            !band_solid_first(EdgeSide::Bottom, true),
            "翻转 + 实色在下缘 → colors[0] 透明"
        );
        assert!(
            band_solid_first(EdgeSide::Bottom, false),
            "普通图层同场景要反过来"
        );
        assert!(band_solid_first(EdgeSide::Left, true) && band_solid_first(EdgeSide::Left, false));
        assert!(
            !band_solid_first(EdgeSide::Right, true) && !band_solid_first(EdgeSide::Right, false)
        );
    }

    /// 单线的带与 `Bevel` 同口径（顶栏底线、消息流顶部内阴影走同一实现）。
    #[test]
    fn 单线与立体线同口径() {
        let size = (80.0, 40.0);
        let inset = InsetLine::soft(Rgba::black_alpha(0.45), 2.0, 6.0);
        let band = edge_band(&inset, EdgeSide::Top, size, true);
        assert_eq!(
            band.rect,
            RectF {
                x: 0.0,
                y: 0.0,
                w: 80.0,
                h: 8.0
            }
        );
        assert_eq!(band.solid_side, EdgeSide::Top);
    }

    /// `Shadow.dy` 的符号约定：正 dy = 视觉向下；翻转图层直接用 +y（CALayer 的
    /// y 正方向），普通图层取镜像仍保证视觉向下。
    #[test]
    fn 投影偏移跟随dy符号() {
        let down = Shadow {
            dy: 10.0,
            blur: 24.0,
            spread: -14.0,
            color: Rgba::black_alpha(0.55),
        };
        assert_eq!(
            shadow_spec(&down, true).offset,
            (0.0, 10.0),
            "翻转图层：正 dy = +y（CALayer 的 y 正方向）"
        );
        assert_eq!(
            shadow_spec(&down, false).offset,
            (0.0, -10.0),
            "普通图层：镜像到 -y，视觉仍向下"
        );

        let up = Shadow {
            dy: -1.0,
            blur: 0.0,
            spread: 0.0,
            color: Rgba::white_alpha(0.35),
        };
        assert!(shadow_spec(&up, true).offset.1 < 0.0, "负 dy 保持向上");
    }

    /// 投影的模糊换算与透明度拆分：`radius = blur / 2`（CSS 半径 = 2×σ），
    /// `shadowColor` 只留 RGB、alpha 进 `shadowOpacity`。
    #[test]
    fn 投影半径与透明度拆分() {
        let shadow = Shadow {
            dy: 1.0,
            blur: 2.0,
            spread: 0.0,
            color: Rgba::black_alpha(0.30),
        };
        let spec = shadow_spec(&shadow, true);
        assert_eq!(spec.radius, 1.0);
        assert_eq!(spec.opacity, 0.30);
        assert_eq!(spec.color, Rgba::black_alpha(1.0));
    }

    /// `spread` 正 = 外扩、负 = 内缩；缩到非正尺寸退回 1×1 并保持中心。
    #[test]
    fn 投影路径矩形外扩内缩() {
        let rect = RectF {
            x: 10.0,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        };
        assert_eq!(
            shadow_path_rect(rect, 4.0),
            RectF {
                x: 6.0,
                y: 16.0,
                w: 108.0,
                h: 58.0
            },
            "正 spread 外扩"
        );
        assert_eq!(
            shadow_path_rect(rect, -14.0),
            RectF {
                x: 24.0,
                y: 34.0,
                w: 72.0,
                h: 22.0
            },
            "负 spread 内缩（设计稿 ambient 的 -14）"
        );
        let tiny = shadow_path_rect(
            RectF {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            },
            -20.0,
        );
        assert_eq!(
            tiny,
            RectF {
                x: 4.5,
                y: 4.5,
                w: 1.0,
                h: 1.0
            },
            "极端内缩退回 1×1 且居中"
        );
    }

    /// 条纹光栅化：图案高度 = 最大周期；一条条纹只覆盖其周期前段；透明度按 8 位量化。
    #[test]
    fn 条纹图案周期与线宽() {
        let stripes = [
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
        ];
        let bitmap = stripe_bitmap(&stripes, 1.0);
        assert_eq!(bitmap.height, 7, "高度取最大周期");
        assert_eq!(bitmap.width, 8);
        let alpha = |y: usize, x: usize| bitmap.pixels[(y * bitmap.width as usize + x) * 4 + 3];
        // 第 0 行同时落在两条线的周期前段：两层各自叠加（设计稿就是两条纹叠着画）。
        let both = 0.05 + 0.055 * (1.0 - 0.05);
        assert_eq!(alpha(0, 0), quantize(both), "第 0 行被白线与黑线同时覆盖");
        assert_eq!(alpha(1, 3), 0, "两条线的周期外都是透明");
        assert_eq!(
            alpha(6, 0),
            quantize(0.05),
            "第 6 行只在 2px 周期的白线里（6 % 7 ≥ 1）"
        );
    }

    /// 条纹叠加按源覆盖合成（不是覆盖式替换）。
    #[test]
    fn 条纹叠加合成() {
        let stripes = [
            Stripe {
                period: 4.0,
                line: 2.0,
                color: Rgba::white_alpha(0.5),
            },
            Stripe {
                period: 4.0,
                line: 2.0,
                color: Rgba::black_alpha(0.5),
            },
        ];
        let bitmap = stripe_bitmap(&stripes, 1.0);
        let alpha = |y: usize| bitmap.pixels[y * bitmap.width as usize * 4 + 3];
        assert_eq!(alpha(0), quantize(0.75), "0.5 + 0.5×(1-0.5) = 0.75");
        assert_eq!(alpha(3), 0, "线外仍是透明");
    }

    /// **声明序回归**：一组条纹里首条在最上（与 `--ptex` 多背景同一规则）。
    ///
    /// 用可区分的不透明度钉住合成方向：白 .3 应盖在黑 .8 上（白分量 ≈ .3/.86 ≈ .349），
    /// 画反会得到 ≈ .07 —— 单看 alpha 分不出来。
    #[test]
    fn 条纹首条在最上() {
        let stripes = [
            Stripe {
                period: 4.0,
                line: 2.0,
                color: Rgba::white_alpha(0.3),
            },
            Stripe {
                period: 4.0,
                line: 2.0,
                color: Rgba::black_alpha(0.8),
            },
        ];
        let bitmap = stripe_bitmap(&stripes, 1.0);
        let white = bitmap.pixels[0] as f32 / 255.0;
        let alpha = bitmap.pixels[3] as f32 / 255.0;
        assert!((alpha - 0.86).abs() < 0.01, "合成 alpha = .3 + .8×.7");
        assert!(
            (white - 0.349).abs() < 0.02,
            "白 .3 应在黑 .8 之上（白分量 ≈ .349），实际 {white}"
        );
    }
}
