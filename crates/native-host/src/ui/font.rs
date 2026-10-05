//! 全局字体快照（W9a）：`appearance.font` 的 Native 侧应用点。
//!
//! 权属划分（执行契约 §6.4）：
//! - **`appearance.font` 是唯一裁定点**，住在 CONFIG、由 Node 的
//!   `@/services/font` 读取；Rust 不读 CONFIG、不复制默认值，只接收推送的
//!   **不可变快照** 并应用到各窗口控件。
//! - 字体**不随 Profile、不复制字体文件**：快照里只有族名与字号，字体本体由
//!   系统提供；族名缺失或系统查不到时使用系统 fallback（各平台实现里
//!   `fontWithName`/`CreateFont` 的失败分支），不静默绑定到其它族。
//! - 枚举系统字体走既有 Rust 命令 [`crate::commands::font_cmd::list_system_fonts`]
//!   （fontdb 扫描系统字体目录/注册表），本模块不自建第二份枚举。
//!
//! 本模块只保存快照与纯逻辑（归一化/夹取），平台应用在
//! `ui/platform/{macos,windows}.rs` 的 `apply_font_snapshot`。

use std::sync::{Mutex, MutexGuard};

/// 字号范围：与设置界面现有输入约束一致（Vue `AppearanceTab` 的 `min="10" max="24"`）。
///
/// 越界值在归一化时夹取而不是报错：快照来自 Node 的配置读取，界面侧另有输入约束；
/// 这里防守的是手改 CONFIG 后的极端值把原生控件排版打崩。
pub const FONT_SIZE_MIN: f64 = 10.0;
pub const FONT_SIZE_MAX: f64 = 24.0;

/// 全局字体快照。两个字段都可缺省：
/// - `family: None` = 未配置族名 → 各窗口用系统默认字体；
/// - `size: None` = 未配置字号 → 各控件用自身基线字号（如正文 13.5、标签 11）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FontSnapshot {
    pub family: Option<String>,
    /// 全局字号。注意：这是「正文」语义的字号；小号辅助文本由控件基线按比例取用，
    /// 不直接等于该值。
    pub size: Option<f64>,
}

impl FontSnapshot {
    /// 归一化：族名去空白、空串归 `None`；字号夹到 [`FONT_SIZE_MIN`]`..=`[`FONT_SIZE_MAX`]，
    /// 非有限值归 `None`（NaN/inf 不得进入平台字体 API）。
    pub fn normalized(mut self) -> Self {
        self.family = self
            .family
            .map(|family| family.trim().to_string())
            .filter(|family| !family.is_empty());
        self.size = self
            .size
            .filter(|size| size.is_finite())
            .map(|size| size.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX));
        self
    }

    /// 正文基准字号（快照未配置时用调用方给出的基线）。
    pub fn body_size_or(&self, base: f64) -> f64 {
        self.size.unwrap_or(base)
    }

    /// 辅助文本字号：按正文基准同比缩放（如标签基线 11 / 正文 13.5 ≈ 0.81）。
    pub fn scaled_size(&self, base: f64, body_base: f64) -> f64 {
        match self.size {
            Some(size) if body_base > 0.0 => base * (size / body_base),
            _ => base,
        }
    }

    /// 是否为空快照（两字段都未配置）。
    pub fn is_empty(&self) -> bool {
        self.family.is_none() && self.size.is_none()
    }
}

static SNAPSHOT: Mutex<FontSnapshot> = Mutex::new(FontSnapshot {
    family: None,
    size: None,
});

fn lock() -> MutexGuard<'static, FontSnapshot> {
    SNAPSHOT.lock().unwrap_or_else(|error| error.into_inner())
}

/// 当前生效快照（各平台窗口控件构建/刷新时读取；这是 Native 侧唯一读取点）。
pub fn snapshot() -> FontSnapshot {
    lock().clone()
}

/// 写入快照（归一化后保存）。返回归一化结果，调用方据此回报/应用。
pub fn store(snapshot: FontSnapshot) -> FontSnapshot {
    let normalized = snapshot.normalized();
    *lock() = normalized.clone();
    normalized
}

/// 清空快照（测试用；产品路径不调用）。
#[cfg(test)]
pub(crate) fn reset_for_test() {
    *lock() = FontSnapshot::default();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 归一化去空白并把空族名归空() {
        let snapshot = FontSnapshot {
            family: Some("  PingFang SC  ".into()),
            size: Some(16.0),
        }
        .normalized();
        assert_eq!(snapshot.family.as_deref(), Some("PingFang SC"));

        let blank = FontSnapshot {
            family: Some("   ".into()),
            size: None,
        }
        .normalized();
        assert_eq!(blank.family, None);
        assert!(blank.is_empty());
    }

    #[test]
    fn 字号越界被夹取_非有限值归空() {
        let too_small = FontSnapshot {
            family: None,
            size: Some(2.0),
        }
        .normalized();
        assert_eq!(too_small.size, Some(FONT_SIZE_MIN));
        let too_large = FontSnapshot {
            family: None,
            size: Some(99.0),
        }
        .normalized();
        assert_eq!(too_large.size, Some(FONT_SIZE_MAX));
        let nan = FontSnapshot {
            family: None,
            size: Some(f64::NAN),
        }
        .normalized();
        assert_eq!(nan.size, None, "非有限字号不得进入平台字体 API");
    }

    #[test]
    fn 快照缺省时回落基线_配置时按比例缩放辅助字号() {
        let empty = FontSnapshot::default();
        assert_eq!(empty.body_size_or(13.5), 13.5);
        assert_eq!(empty.scaled_size(11.0, 13.5), 11.0);

        let configured = FontSnapshot {
            family: None,
            size: Some(20.25),
        };
        assert_eq!(configured.body_size_or(13.5), 20.25);
        // 20.25 / 13.5 = 1.5 → 标签基线 11 → 16.5
        assert!((configured.scaled_size(11.0, 13.5) - 16.5).abs() < 1e-9);
    }

    #[test]
    fn 存储快照读取一致且互不串扰() {
        reset_for_test();
        let stored = store(FontSnapshot {
            family: Some(" Songti SC ".into()),
            size: Some(99.0),
        });
        assert_eq!(stored.family.as_deref(), Some("Songti SC"));
        assert_eq!(stored.size, Some(FONT_SIZE_MAX));
        assert_eq!(snapshot(), stored);
        reset_for_test();
        assert!(snapshot().is_empty(), "测试收尾必须清空全局状态");
    }
}
