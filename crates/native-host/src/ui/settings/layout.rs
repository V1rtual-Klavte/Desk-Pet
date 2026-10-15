//! 两平台设置窗共用的逻辑坐标网格；平台只做坐标系与 DPI 转换。

pub const MARGIN: f64 = 16.0;
pub const RAIL_W: f64 = 104.0;
pub const CONTENT_TOP: f64 = 11.0;
pub const FOOTER_H: f64 = 46.0;

/// 一个视图矩形（逻辑点；`y` 从上往下量）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SettingsRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 设置窗主版面：左竖栏 / 内容滚动区 / 底部操作条（状态行 + 刷新/保存）。
pub(crate) struct SettingsLayout {
    /// 左竖栏：从窗口顶铺到操作条上沿。
    pub rail: SettingsRect,
    /// 内容滚动区：竖栏右侧，上边距 `CONTENT_TOP`、下边界停在操作条上。
    pub scroll: SettingsRect,
    /// 操作条上缘的 1px 分隔线（设计稿 `.sfoot` 的 `border-top: 1px solid var(--bare)`）。
    pub separator: SettingsRect,
    /// 状态行（操作条左端）。
    pub status: SettingsRect,
    /// 「刷新」（操作条右端，主操作左边）。
    pub refresh: SettingsRect,
    /// 「保存」（操作条最右的主操作）。
    pub save: SettingsRect,
}

/// 按窗口尺寸算主版面（纯函数，可测）。
pub(crate) fn settings_layout(width: f64, height: f64) -> SettingsLayout {
    SettingsLayout {
        rail: SettingsRect {
            x: 0.0,
            y: 0.0,
            w: RAIL_W,
            h: (height - FOOTER_H).max(120.0),
        },
        scroll: SettingsRect {
            x: RAIL_W + MARGIN,
            y: CONTENT_TOP,
            w: (width - RAIL_W - MARGIN * 2.0).max(80.0),
            h: (height - CONTENT_TOP - FOOTER_H).max(80.0),
        },
        separator: SettingsRect {
            x: 0.0,
            y: height - FOOTER_H,
            w: width,
            h: 1.0,
        },
        // 底部操作条（设计稿 `.sfoot`）：状态行在左，主操作贴右。
        // 页脚按钮右缘与内容控件右缘对齐（2026-10-05 评审：旧版外凸 16.5pt、
        // 与内容不共网格）。控件右缘 = 窗宽 − 外边距 16 − 内容内边距 16 = width − 32。
        status: SettingsRect {
            x: MARGIN,
            y: height - 30.0,
            w: (width - 236.0).max(80.0),
            h: 20.0,
        },
        refresh: SettingsRect {
            x: width - 212.0,
            y: height - 34.0,
            w: 88.0,
            h: 28.0,
        },
        save: SettingsRect {
            x: width - 116.0,
            y: height - 34.0,
            w: 84.0,
            h: 28.0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 内容与页脚共网格且滚动区不侵入页脚() {
        for (width, height) in [(540.0, 640.0), (720.0, 480.0), (960.0, 900.0)] {
            let layout = settings_layout(width, height);
            assert_eq!(layout.scroll.x, 120.0);
            assert_eq!(layout.scroll.y + layout.scroll.h, layout.separator.y);
            assert_eq!(layout.rail.y + layout.rail.h, layout.separator.y);
            assert_eq!(layout.save.x + layout.save.w, width - 32.0);
            assert_eq!(layout.refresh.x + layout.refresh.w + 8.0, layout.save.x);
            assert!(layout.status.x + layout.status.w <= layout.refresh.x);
            assert!(layout.save.y >= layout.separator.y);
            assert!(layout.save.y + layout.save.h <= height);
        }
    }
}
