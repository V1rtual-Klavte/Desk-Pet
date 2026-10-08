//! 灵动图层几何核 —— 零 UI 依赖的纯函数。
//!
//! 基线是 W0 冻结的 `src/composables/useParallax.ts`：五层直接映射、零惯性、
//! 指哪打哪。原生渲染器与图层编辑器**必须**共用本模块，不得在任一侧另写一份
//! 位移/深度数学（执行契约 §6.1）。
//!
//! 本模块只算几何，不做任何绘制、纹理、滤镜或字体工作。被授权删除的效果
//! （`shadow` / `brightness` / `contrast` / `saturate` 与景深）不在这里出现，
//! 也不为它们保留参数位。
//!
//! 与基线的两处有意差异，均由执行契约授权并在此登记：
//! 1. 偏移只在最终格式（百分比）上工作。基线里「整数即旧像素、当场换百分比」
//!    的兼容分支不迁入；含整数 `offsetX/offsetY` 的既有 Profile 需要用户在
//!    W6 前裁定是按百分比重读还是保留换算（见未完成总表 §8）。
//! 2. 基线把结果拼成 CSS 字符串并做 `toFixed(1)` / `toFixed(3)` 舍入。舍入是
//!    呈现层的事，本模块返回未舍入的 `f64`；渲染器负责最终量化。

/// `appearance.popupSize.w` 的缺省值：基线在配置缺失时用它做位移归一化基准。
pub const DEFAULT_POPUP_WIDTH: f64 = 730.0;

/// 每单位 `sensitivity × intensity` 的基准位移（逻辑像素）。
pub const TRAVEL_UNIT: f64 = 40.0;

/// 深度归一化跨度：`sensitivity × intensity / DEPTH_SPAN` 夹到 `[0, 1]` 得到层深度。
pub const DEPTH_SPAN: f64 = 1.6;

/// 深度缩放的两端：`depth = 0` 取近端，`depth = 1` 取远端。
pub const DEPTH_SCALE_NEAR: f64 = 1.02;
pub const DEPTH_SCALE_FAR: f64 = 0.98;

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    if value < low {
        low
    } else if value > high {
        high
    } else {
        value
    }
}

/// 窗口几何（屏幕坐标系，逻辑像素）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowGeometry {
    /// 窗口左上角在屏幕上的位置，与光标同一坐标系。
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 全局光标位置（屏幕坐标系，逻辑像素）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorPosition {
    pub x: f64,
    pub y: f64,
}

/// 单层几何输入。`offset_*_percent` 是最终格式的百分比偏移。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerGeometryInput {
    pub enabled: bool,
    pub sensitivity: f64,
    /// 层自定义缩放。
    pub scale: f64,
    pub offset_x_percent: f64,
    pub offset_y_percent: f64,
}

/// 单层几何输出。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerTransform {
    /// `false` 表示该层不参与绘制（基线里的 `display: none`）。
    pub visible: bool,
    pub offset_x_percent: f64,
    pub offset_y_percent: f64,
    /// 光标项位移，已含 `maxTravel`（逻辑像素）。
    pub translate_x: f64,
    pub translate_y: f64,
    /// 层自定义缩放 × 深度缩放。
    pub scale: f64,
}

/// 一帧的几何输入。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneInput {
    /// 灵动总开关。关闭时所有层静态呈现：位移归零，缩放仍按深度计算
    /// （基线的 `active` 只影响光标项，不隐藏图层）。
    pub enabled: bool,
    /// 窗口是否可见（收起 / 隐藏时为 `false`）。
    pub visible: bool,
    pub intensity: f64,
    pub window: WindowGeometry,
    /// `appearance.popupSize.w`；为 0 或 NaN 时回落到 [`DEFAULT_POPUP_WIDTH`]。
    pub popup_width: f64,
    /// 全局光标。`None` 表示尚未取到（首帧、窗口隐藏、跨屏刷新）。
    pub cursor: Option<CursorPosition>,
}

/// 光标相对窗口中心的归一化位置，夹到 `[-1, 1]`。
///
/// 返回 `None` 表示本帧没有有效光标项：总开关关闭、窗口不可见、窗口尺寸未就绪
/// 或光标未知 —— 此时位移归零，但层的深度缩放照常生效。
pub fn normalized_cursor(scene: &SceneInput) -> Option<(f64, f64)> {
    if !scene.enabled || !scene.visible {
        return None;
    }
    let cursor = scene.cursor?;
    if !(scene.window.width > 0.0) || !(scene.window.height > 0.0) {
        return None;
    }
    let cx = scene.window.width / 2.0;
    let cy = scene.window.height / 2.0;
    let nx = clamp((cursor.x - scene.window.x - cx) / cx, -1.0, 1.0);
    let ny = clamp((cursor.y - scene.window.y - cy) / cy, -1.0, 1.0);
    Some((nx, ny))
}

/// 层深度：`sensitivity × intensity / DEPTH_SPAN`，夹到 `[0, 1]`。
pub fn layer_depth(sensitivity: f64, intensity: f64) -> f64 {
    clamp(sensitivity * intensity / DEPTH_SPAN, 0.0, 1.0)
}

/// 深度缩放：从 [`DEPTH_SCALE_NEAR`] 线性插值到 [`DEPTH_SCALE_FAR`]。
pub fn depth_scale(depth: f64) -> f64 {
    DEPTH_SCALE_NEAR + (DEPTH_SCALE_FAR - DEPTH_SCALE_NEAR) * depth
}

/// 该层在当前灵敏度下的最大位移（逻辑像素）。
///
/// 基线按**窗口宽度**等比缩放，纵向位移与横向共用同一个 `maxTravel`；
/// 这是既有语义，不在这里「修正」。
pub fn max_travel(sensitivity: f64, intensity: f64, window_width: f64, popup_width: f64) -> f64 {
    // 对应基线的 `popupSize.w || 730`：只对 0 / NaN 回落，其余（含负值）原样使用。
    let denominator = if popup_width == 0.0 || popup_width.is_nan() {
        DEFAULT_POPUP_WIDTH
    } else {
        popup_width
    };
    sensitivity * intensity * TRAVEL_UNIT * (window_width / denominator)
}

/// 计算单层几何。
pub fn layer_transform(scene: &SceneInput, layer: &LayerGeometryInput) -> LayerTransform {
    if !layer.enabled {
        return LayerTransform {
            visible: false,
            offset_x_percent: layer.offset_x_percent,
            offset_y_percent: layer.offset_y_percent,
            translate_x: 0.0,
            translate_y: 0.0,
            scale: layer.scale,
        };
    }

    let travel = max_travel(
        layer.sensitivity,
        scene.intensity,
        scene.window.width,
        scene.popup_width,
    );
    let (translate_x, translate_y) = match normalized_cursor(scene) {
        Some((nx, ny)) => (nx * travel, ny * travel),
        None => (0.0, 0.0),
    };

    LayerTransform {
        visible: true,
        offset_x_percent: layer.offset_x_percent,
        offset_y_percent: layer.offset_y_percent,
        translate_x,
        translate_y,
        scale: layer.scale * depth_scale(layer_depth(layer.sensitivity, scene.intensity)),
    }
}

/// 按给定顺序（L0 → L4）计算整帧，输出顺序与输入一致（z 序由消费方负责）。
pub fn scene_transforms(scene: &SceneInput, layers: &[LayerGeometryInput]) -> Vec<LayerTransform> {
    layers
        .iter()
        .map(|layer| layer_transform(scene, layer))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认五层的灵敏度（`DEFAULT_LAYERS` 的 L0→L4）。
    const DEFAULT_SENSITIVITIES: [f64; 5] = [0.2, 0.5, 0.8, 1.2, 1.6];

    /// 浮点容差：公式与基线逐项等价，但 `lerp` 的浮点结合顺序不同，
    /// 末位可能差 1 ULP。容差只吸收这一项，不吸收公式错误。
    const EPS: f64 = 1e-9;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < EPS,
            "期望 {expected}，实际 {actual}（差 {}）",
            (actual - expected).abs()
        );
    }

    fn window() -> WindowGeometry {
        WindowGeometry {
            x: 100.0,
            y: 200.0,
            width: 730.0,
            height: 450.0,
        }
    }

    fn scene(
        enabled: bool,
        visible: bool,
        intensity: f64,
        cursor: Option<CursorPosition>,
    ) -> SceneInput {
        SceneInput {
            enabled,
            visible,
            intensity,
            window: window(),
            popup_width: DEFAULT_POPUP_WIDTH,
            cursor,
        }
    }

    fn layer(sensitivity: f64) -> LayerGeometryInput {
        LayerGeometryInput {
            enabled: true,
            sensitivity,
            scale: 1.0,
            offset_x_percent: 0.0,
            offset_y_percent: 0.0,
        }
    }

    /// 窗口中心（730×450 的窗口位于 (100,200)）—— 归一化必为 (0, 0)。
    const CENTER: CursorPosition = CursorPosition { x: 465.0, y: 425.0 };
    /// 窗口右下角 —— 归一化必为 (1, 1)。
    const BOTTOM_RIGHT: CursorPosition = CursorPosition { x: 830.0, y: 650.0 };
    /// 窗口左上角 —— 归一化必为 (-1, -1)。
    const TOP_LEFT: CursorPosition = CursorPosition { x: 100.0, y: 200.0 };

    #[test]
    fn 居中光标零位移_缩放仍按深度() {
        let s = scene(true, true, 1.0, Some(CENTER));
        // 深度 = s / 1.6；缩放 = 1.02 - 0.04 × 深度
        let expected_scales = [1.015, 1.0075, 1.0, 0.99, 0.98];
        for (i, sensitivity) in DEFAULT_SENSITIVITIES.iter().enumerate() {
            let t = layer_transform(&s, &layer(*sensitivity));
            assert!(t.visible);
            assert_close(t.translate_x, 0.0);
            assert_close(t.translate_y, 0.0);
            assert_close(t.scale, expected_scales[i]);
        }
    }

    #[test]
    fn 右下角满位移_位移等于最大行程() {
        let s = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
        // maxTravel = s × 40 × (730 / 730) = s × 40
        let expected: [(f64, f64); 5] = [
            (8.0, 1.015),
            (20.0, 1.0075),
            (32.0, 1.0),
            (48.0, 0.99),
            (64.0, 0.98),
        ];
        for (i, sensitivity) in DEFAULT_SENSITIVITIES.iter().enumerate() {
            let t = layer_transform(&s, &layer(*sensitivity));
            assert_close(t.translate_x, expected[i].0);
            assert_close(t.translate_y, expected[i].0);
            assert_close(t.scale, expected[i].1);
        }
    }

    #[test]
    fn 左上角反向满位移() {
        let s = scene(true, true, 1.0, Some(TOP_LEFT));
        assert_close(layer_transform(&s, &layer(0.2)).translate_x, -8.0);
        assert_close(layer_transform(&s, &layer(0.2)).translate_y, -8.0);
        assert_close(layer_transform(&s, &layer(1.6)).translate_x, -64.0);
        assert_close(layer_transform(&s, &layer(1.6)).translate_y, -64.0);
    }

    #[test]
    fn 窗口外光标夹到边界() {
        let far = CursorPosition {
            x: 5000.0,
            y: 5000.0,
        };
        let s = scene(true, true, 1.0, Some(far));
        let t = layer_transform(&s, &layer(0.2));
        assert_close(t.translate_x, 8.0);
        assert_close(t.translate_y, 8.0);
        let behind = CursorPosition {
            x: -5000.0,
            y: -5000.0,
        };
        let s = scene(true, true, 1.0, Some(behind));
        let t = layer_transform(&s, &layer(0.2));
        assert_close(t.translate_x, -8.0);
        assert_close(t.translate_y, -8.0);
    }

    #[test]
    fn 总开关关闭或窗口不可见时位移归零但不改缩放() {
        for s in [
            scene(false, true, 1.0, Some(BOTTOM_RIGHT)),
            scene(true, false, 1.0, Some(BOTTOM_RIGHT)),
        ] {
            let t = layer_transform(&s, &layer(0.8));
            assert!(t.visible, "总开关只影响位移，不隐藏图层");
            assert_close(t.translate_x, 0.0);
            assert_close(t.translate_y, 0.0);
            assert_close(t.scale, 1.0);
        }
    }

    #[test]
    fn 光标未知或窗口尺寸未就绪时位移归零() {
        let no_cursor = scene(true, true, 1.0, None);
        assert_close(layer_transform(&no_cursor, &layer(0.8)).translate_x, 0.0);

        let mut zero_size = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
        zero_size.window.width = 0.0;
        assert_close(layer_transform(&zero_size, &layer(0.8)).translate_x, 0.0);
        assert_close(layer_transform(&zero_size, &layer(0.8)).scale, 1.0);

        let mut zero_height = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
        zero_height.window.height = 0.0;
        assert_close(layer_transform(&zero_height, &layer(0.8)).translate_y, 0.0);
    }

    #[test]
    fn 位移基准是窗口宽而不是高() {
        // 基线：maxTravel 只由窗宽与配置弹窗宽决定，纵向共用同一行程。
        let s = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
        let t = layer_transform(&s, &layer(0.5));
        assert_close(t.translate_y, 20.0);
        assert_close(t.translate_x, 20.0);
    }

    #[test]
    fn 配置弹窗宽参与归一化() {
        let mut s = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
        s.popup_width = 365.0; // 730 / 365 = 2 倍行程
        assert_close(layer_transform(&s, &layer(0.5)).translate_x, 40.0);
    }

    #[test]
    fn 弹窗宽为零或非数时回落默认值() {
        for bad in [0.0, f64::NAN] {
            let mut s = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
            s.popup_width = bad;
            assert_close(layer_transform(&s, &layer(0.2)).translate_x, 8.0);
        }
    }

    #[test]
    fn 窗口更宽时行程等比放大() {
        let mut s = scene(
            true,
            true,
            1.0,
            Some(CursorPosition {
                x: 1560.0,
                y: 650.0,
            }),
        );
        s.window.width = 1460.0; // 归一化分母随之变为 730，右边缘仍是 nx = 1
        let t = layer_transform(&s, &layer(0.2));
        assert_close(t.translate_x, 16.0);
        assert_close(t.translate_y, 16.0);
    }

    #[test]
    fn 强度缩放同时作用于位移与深度() {
        // s = 0.8 × 0.5 = 0.4 → maxTravel = 16，depth = 0.25 → scale = 1.01
        let s = scene(true, true, 0.5, Some(BOTTOM_RIGHT));
        let t = layer_transform(&s, &layer(0.8));
        assert_close(t.translate_x, 16.0);
        assert_close(t.translate_y, 16.0);
        assert_close(t.scale, 1.01);
    }

    #[test]
    fn 层自定义缩放乘在深度缩放之上() {
        let s = scene(true, true, 1.0, Some(CENTER));
        let mut l = layer(0.8); // depth = 0.5 → depthScale = 1.0
        l.scale = 2.0;
        assert_close(layer_transform(&s, &l).scale, 2.0);

        let mut l = layer(1.6); // depth = 1.0 → depthScale = 0.98
        l.scale = 2.0;
        assert_close(layer_transform(&s, &l).scale, 1.96);
    }

    #[test]
    fn 灵敏度超过上限时深度与行程各自夹紧() {
        // depth 夹到 1，但 maxTravel 不夹：s = 5 → 200 像素行程。
        let s = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
        let t = layer_transform(&s, &layer(5.0));
        assert_close(t.scale, 0.98);
        assert_close(t.translate_x, 200.0);
    }

    #[test]
    fn 禁用层不参与绘制且保留自身偏移() {
        let s = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
        let mut l = layer(0.8);
        l.enabled = false;
        l.offset_x_percent = 12.5;
        let t = layer_transform(&s, &l);
        assert!(!t.visible);
        assert_close(t.translate_x, 0.0);
        assert_close(t.translate_y, 0.0);
        assert_close(t.offset_x_percent, 12.5);
    }

    #[test]
    fn 百分比偏移原样透传() {
        let s = scene(true, true, 1.0, Some(CENTER));
        let mut l = layer(0.5);
        l.offset_x_percent = 12.5;
        l.offset_y_percent = -7.25;
        let t = layer_transform(&s, &l);
        assert_close(t.offset_x_percent, 12.5);
        assert_close(t.offset_y_percent, -7.25);
    }

    #[test]
    fn 整帧输出顺序与输入一致() {
        let s = scene(true, true, 1.0, Some(BOTTOM_RIGHT));
        let layers: Vec<_> = DEFAULT_SENSITIVITIES
            .iter()
            .enumerate()
            .map(|(i, sensitivity)| {
                let mut l = layer(*sensitivity);
                l.offset_y_percent = i as f64;
                l
            })
            .collect();
        let out = scene_transforms(&s, &layers);
        assert_eq!(out.len(), layers.len());
        for (i, t) in out.iter().enumerate() {
            assert_close(t.offset_y_percent, i as f64);
        }
    }
}
