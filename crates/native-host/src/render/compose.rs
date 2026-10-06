//! 帧计划：几何核输出 → 每层绘制指令的纯映射。
//!
//! 这里只把 [`LayerTransform`]（位移/深度缩放/百分比偏移，来自冻结的几何核）与纹理、
//! 窗口尺寸合成为「绘制框」；量化（取整/clamp）是各平台后端自己的事：
//! - macOS 把绘制框直接写成 CALayer 的 bounds + position（点坐标，Retina 由 CA 处理）；
//! - Windows 再按客户区像素比换算成整数矩形后 AlphaBlend。
//!
//! 素材的合成基准与原型一致：**按窗口高度等比适配**，再叠几何核给出的 `scale`：
//! `显示高 = 纹理高 × (窗口高 / 纹理高) × transform.scale`。

use super::geometry::{LayerTransform, WindowGeometry};
use super::texture::TextureId;

/// 单层绘制指令。`center_*` 相对窗口左上角（逻辑像素，左上原点，与几何核同坐标系）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerDraw {
    /// 层槽位 = 层在输入列表中的下标。**同一纹理可以被多个槽共享**（同一素材出现在
    /// 多个层时只上传一次），所以「槽」而不是纹理才是绘制实例的身份：macOS 的
    /// CALayer 一个实例只能出现在一个位置，必须按槽建层。
    pub slot: u32,
    pub texture: TextureId,
    pub center_x: f64,
    pub center_y: f64,
    pub width: f64,
    pub height: f64,
    /// 本层绘制时的整体不透明度（[`normalize_opacity`] 之后的 [0, 1]）。
    /// 缺省 = 1.0（不透明），即编辑器线索之外的路径与历史行为逐位一致。
    pub opacity: f64,
}

/// 一帧的绘制计划。`draws` 按 z 序排列：**索引 0 最先绘制（最底层）**，
/// 与输入层列表顺序一致（L0 → L4，L4 在最上）。
#[derive(Debug, Clone, PartialEq)]
pub struct FramePlan {
    /// 本帧的窗口几何（逻辑像素）。
    pub window: WindowGeometry,
    pub draws: Vec<LayerDraw>,
}

/// 图层不透明度的统一归一化（两平台共用同一口径）：非有限值按 1.0（不透明 ——
/// 「未设置」的语义就是完整绘制，与历史行为逐位一致），其余夹到 `[0, 1]`。
pub fn normalize_opacity(opacity: f64) -> f64 {
    if !opacity.is_finite() {
        return 1.0;
    }
    opacity.clamp(0.0, 1.0)
}

/// 不透明度 → Windows `SourceConstantAlpha` 字节（0..=255，四舍五入）。
///
/// 单独成跨平台纯函数是为了让这条 Windows 口径在本机（macOS）也能被单测钉住；
/// `win.rs` 只负责把它装进 `BLENDFUNCTION`（文档口径：源含 alpha 先乘 SCA/255，
/// 再按逐像素 alpha 合成 —— 对预乘 BGRA 正是「整层调暗」）。
pub fn source_constant_alpha(opacity: f64) -> u8 {
    (normalize_opacity(opacity) * 255.0).round() as u8
}

/// 计算单层绘制框；`None` 表示本帧不绘制该层。
///
/// 不绘制的情形：层不可见、纹理尺寸为零、窗口尺寸尚未就绪（此时任何绘制都无意义，
/// 也不产出退化的零尺寸指令）。`opacity` 只进绘制指令，不参与几何。
pub fn layer_draw(
    slot: u32,
    texture: TextureId,
    transform: &LayerTransform,
    texture_width: u32,
    texture_height: u32,
    opacity: f64,
    window: &WindowGeometry,
) -> Option<LayerDraw> {
    if !transform.visible || texture_width == 0 || texture_height == 0 {
        return None;
    }
    if !(window.width > 0.0) || !(window.height > 0.0) {
        return None;
    }
    let base_scale = window.height / texture_height as f64;
    let scale = base_scale * transform.scale;
    Some(LayerDraw {
        slot,
        texture,
        center_x: window.width / 2.0
            + transform.translate_x
            + transform.offset_x_percent / 100.0 * window.width,
        center_y: window.height / 2.0
            + transform.translate_y
            + transform.offset_y_percent / 100.0 * window.height,
        width: texture_width as f64 * scale,
        height: texture_height as f64 * scale,
        opacity: normalize_opacity(opacity),
    })
}

/// 组装整帧计划（输入顺序即 z 序）。输入项是 `(槽位, 几何输出, 纹理, 不透明度)`；
/// `None` 的纹理（禁用/未加载成功）直接跳过。
pub fn frame_plan<'a, I>(window: &WindowGeometry, layers: I) -> FramePlan
where
    I: IntoIterator<Item = (u32, &'a LayerTransform, Option<(TextureId, u32, u32)>, f64)>,
{
    let mut draws = Vec::new();
    for (slot, transform, texture, opacity) in layers {
        let Some((id, width, height)) = texture else {
            continue;
        };
        if let Some(draw) = layer_draw(slot, id, transform, width, height, opacity, window) {
            draws.push(draw);
        }
    }
    FramePlan {
        window: *window,
        draws,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::geometry::LayerTransform;

    const WINDOW: WindowGeometry = WindowGeometry {
        x: 0.0,
        y: 0.0,
        width: 730.0,
        height: 450.0,
    };

    fn transform() -> LayerTransform {
        LayerTransform {
            visible: true,
            offset_x_percent: 0.0,
            offset_y_percent: 0.0,
            translate_x: 0.0,
            translate_y: 0.0,
            scale: 1.0,
        }
    }

    #[test]
    fn 满窗素材_按窗口高适配且居中() {
        let draw =
            layer_draw(0, TextureId::new(1), &transform(), 730, 450, 1.0, &WINDOW).unwrap();
        assert_eq!(draw.slot, 0);
        assert_eq!(draw.opacity, 1.0, "不传线索时恒为不透明");
        assert!((draw.width - 730.0).abs() < 1e-9);
        assert!((draw.height - 450.0).abs() < 1e-9);
        assert!((draw.center_x - 365.0).abs() < 1e-9);
        assert!((draw.center_y - 225.0).abs() < 1e-9);
    }

    #[test]
    fn 位移与百分比偏移进入中心坐标_缩放乘在基准上() {
        let mut t = transform();
        t.translate_x = 8.0;
        t.translate_y = -16.0;
        t.offset_x_percent = 10.0;
        t.offset_y_percent = -20.0;
        t.scale = 2.0;
        // 半尺寸素材：基准缩放 = 450 / 225 = 2，再乘 transform.scale = 2 → 4
        let draw = layer_draw(2, TextureId::new(2), &t, 365, 225, 1.0, &WINDOW).unwrap();
        assert!((draw.width - 365.0 * 4.0).abs() < 1e-9);
        assert!((draw.height - 225.0 * 4.0).abs() < 1e-9);
        assert!((draw.center_x - (365.0 + 8.0 + 73.0)).abs() < 1e-9);
        assert!((draw.center_y - (225.0 - 16.0 - 90.0)).abs() < 1e-9);
    }

    #[test]
    fn 不可见层不产出绘制指令() {
        let mut t = transform();
        t.visible = false;
        assert!(layer_draw(0, TextureId::new(1), &t, 730, 450, 1.0, &WINDOW).is_none());
    }

    #[test]
    fn 零尺寸纹理不产出绘制指令() {
        assert!(layer_draw(0, TextureId::new(1), &transform(), 0, 450, 1.0, &WINDOW).is_none());
        assert!(layer_draw(0, TextureId::new(1), &transform(), 730, 0, 1.0, &WINDOW).is_none());
    }

    #[test]
    fn 窗口尺寸未就绪不产出绘制指令() {
        let zero = WindowGeometry {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        assert!(layer_draw(0, TextureId::new(1), &transform(), 730, 450, 1.0, &zero).is_none());
        let nan = WindowGeometry {
            x: 0.0,
            y: 0.0,
            width: f64::NAN,
            height: 450.0,
        };
        assert!(layer_draw(0, TextureId::new(1), &transform(), 730, 450, 1.0, &nan).is_none());
    }

    #[test]
    fn 整帧顺序与输入一致_缺纹理的层被跳过() {
        let t = transform();
        let plan = frame_plan(
            &WINDOW,
            [
                (0, &t, Some((TextureId::new(1), 730, 450)), 1.0),
                (1, &t, None, 1.0),
                (2, &t, Some((TextureId::new(3), 100, 100)), 0.6),
            ],
        );
        assert_eq!(plan.draws.len(), 2);
        assert_eq!(plan.draws[0].slot, 0);
        assert_eq!(plan.draws[0].texture, TextureId::new(1));
        assert_eq!(plan.draws[1].slot, 2);
        assert_eq!(plan.draws[1].texture, TextureId::new(3));
        assert_eq!(plan.draws[1].opacity, 0.6, "每层不透明度随输入进入指令");
    }

    #[test]
    fn 同一纹理可被多个槽共享() {
        // 同一素材出现在两个层：绘制指令是两条（各自的槽与位置），纹理是同一个。
        let t = transform();
        let plan = frame_plan(
            &WINDOW,
            [
                (0, &t, Some((TextureId::new(7), 100, 100)), 1.0),
                (1, &t, Some((TextureId::new(7), 100, 100)), 1.0),
            ],
        );
        assert_eq!(plan.draws.len(), 2);
        assert_eq!(plan.draws[0].slot, 0);
        assert_eq!(plan.draws[1].slot, 1);
        assert_eq!(plan.draws[0].texture, plan.draws[1].texture);
    }

    /// 线索层之外零差异：同一层只换不透明度，绘制指令除 `opacity` 外逐字段相等
    /// （几何 golden 不受不透明度影响）。
    #[test]
    fn 不透明度只进绘制指令_几何逐位一致() {
        let mut t = transform();
        t.translate_x = 8.0;
        t.translate_y = -16.0;
        t.offset_x_percent = 10.0;
        t.offset_y_percent = -20.0;
        t.scale = 2.0;
        let solid = layer_draw(2, TextureId::new(2), &t, 365, 225, 1.0, &WINDOW).unwrap();
        let ghost = layer_draw(2, TextureId::new(2), &t, 365, 225, 0.15, &WINDOW).unwrap();
        assert_eq!(
            ghost,
            LayerDraw {
                opacity: 0.15,
                ..solid
            },
            "除 opacity 外（含槽位/纹理/中心/宽高）必须逐位一致"
        );
    }

    /// 归一化口径：非有限值按 1.0（「未设置 = 不透明」，与历史行为一致），
    /// 其余夹到 `[0, 1]`；归一化发生在指令生成处。
    #[test]
    fn 不透明度归一化_非有限值按不透明() {
        assert_eq!(normalize_opacity(1.0), 1.0);
        assert_eq!(normalize_opacity(0.6), 0.6);
        assert_eq!(normalize_opacity(0.15), 0.15);
        assert_eq!(normalize_opacity(0.0), 0.0);
        assert_eq!(normalize_opacity(-1.0), 0.0);
        assert_eq!(normalize_opacity(2.0), 1.0);
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                normalize_opacity(bad),
                1.0,
                "未设置/坏值 = 不透明（历史行为）"
            );
        }
        let clamped =
            layer_draw(0, TextureId::new(1), &transform(), 730, 450, 7.0, &WINDOW).unwrap();
        assert_eq!(clamped.opacity, 1.0, "越界值不进 LayerDraw");
    }

    /// Windows 侧恒定透明度的字节量化（跨平台纯函数，本机可测）：255 = 现状常量。
    #[test]
    fn windows恒定透明度字节_按层量化() {
        assert_eq!(source_constant_alpha(1.0), 255, "不透明 = 既有常量");
        assert_eq!(source_constant_alpha(0.0), 0);
        assert_eq!(source_constant_alpha(0.6), 153, "0.6 × 255 = 153");
        assert_eq!(source_constant_alpha(0.15), 38, "0.15 × 255 = 38.25 → 38");
        assert_eq!(source_constant_alpha(f64::NAN), 255, "未设置按不透明");
        assert_eq!(source_constant_alpha(3.0), 255);
        assert_eq!(source_constant_alpha(-1.0), 0);
    }
}
