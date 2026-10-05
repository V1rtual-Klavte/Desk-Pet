//! 窗口几何写回（A3）：用户改窗口尺寸/位置 → CONFIG（`general.popup` 的
//! `defaultSize` / `fixedPosition`）。
//!
//! 方向：原生 UI → Node，复用 W9b 的宿主请求面单向通道 `HostLink::notify`
//! （与分隔条宽度写回 `set_chat_width` 同一先例、同一事件信封与回执归宿）。
//! **CONFIG 的唯一写入者仍是 Node**：`set_popup_geometry` 由
//! `src/services/native-ui/host-requests.ts` 用既有 `setOverride` + `flushConfig`
//! 原子写盘承接；本模块不解析 YAML、不另存配置副本（执行契约 §3/§6.4）。
//!
//! 触发点（平台层负责，含各自的去抖/节流；本模块只做提交）：
//! - macOS：窗口拖动结束（`windowDidMove` + 本地一次性去抖定时器）与
//!   用户缩放结束（`windowDidEndLiveResize` 边沿）；
//! - Windows：交互式移动/缩放结束（`WM_EXITSIZEMOVE` 边沿）。
//!
//! 位置写回只在**固定语义**（`PlacementMode::is_fixed()`，含「fixed 但还没有坐标」
//! 的过渡态）触发（由平台层判定；`general.popup.mode` 的 Node → 宿主推送与
//! 「fixed 立即摆位」见 `set_popup_placement` 命令，本模块只做写回半边）。
//!
//! **反向方向（Node → 宿主）的防回环**：`set_popup_size` 应用配置尺寸后，平台层的
//! 写回边沿先经 [`AppliedSize`] 判定 —— 观测值与刚应用值一致 = 不是用户新操作，
//! 跳过写回，不会形成「应用 → 写回 → 再应用」的回路或反复写盘（写回方向的第二个
//! 兜底在 Node 侧：值与配置一致时 `setPopupGeometry` 本就不落盘）。
//! 写回失败只留痕：运行时体验与持久化解耦，下一次启动以磁盘值为准，不回滚本地布局。

use serde_json::json;

use crate::{rust_debug, rust_warn};

/// 提交一次窗口尺寸写回（逻辑像素；目标键 `general.popup.defaultSize.w/.h`）。
pub fn request_size_writeback(width: f64, height: f64) {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        rust_warn!("窗口尺寸写回跳过：尺寸无效（{width}×{height}）");
        return;
    }
    notify(
        json!({ "size": { "w": width.round(), "h": height.round() } }),
        "窗口尺寸写回",
    );
}

/// 提交一次固定位置写回（逻辑像素、左上原点；目标键 `general.popup.fixedPosition`）。
pub fn request_position_writeback(x: f64, y: f64) {
    if !x.is_finite() || !y.is_finite() {
        rust_warn!("固定位置写回跳过：坐标无效（{x},{y}）");
        return;
    }
    notify(
        json!({ "position": { "x": x.round(), "y": y.round() } }),
        "固定位置写回",
    );
}

/// 单向提交（不等回执；结果由 `HostLink` 侧留痕）。
fn notify(args: serde_json::Value, note: &str) {
    let Some(link) = crate::ui::ports::host_link() else {
        rust_warn!("{note}跳过：宿主 → Node 请求面未接线");
        return;
    };
    match link.notify("set_popup_geometry", args, note.to_string()) {
        Ok(()) => rust_debug!("{note}已提交"),
        Err(error) => rust_warn!("{note}失败：{error}"),
    }
}

/// Node → 宿主程序性应用尺寸（`set_popup_size`）的防回环记录。
///
/// 平台层在应用前调用 [`Self::record`] 记下刚应用值；用户操作结束的写回边沿先问
/// [`Self::suppresses`] —— 观测尺寸与刚应用值一致 = 这次边沿不是用户的新操作
/// （程序性 `setFrame`/`SetWindowPos` 可能触发 resize 结束通知的边界情况），跳过写回。
/// 比较口径是四舍五入到整数的逻辑像素，与 `set_popup_geometry` 的取整写回同一精度，
/// 避免浮点尾差把程序应用误判成用户操作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AppliedSize(Option<(i64, i64)>);

impl AppliedSize {
    /// 记录一次由配置应用的尺寸；非有限值或非正尺寸不记录（保持原记录不变）。
    ///
    /// 正常路径上 `UiHandle::set_popup_size` 已校验，这里再挡一道是为了让记录本身
    /// 始终只存「真实应用过的值」——脏值进不来，判定就不会因脏记录误抑制写回。
    pub fn record(&mut self, width: f64, height: f64) {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return;
        }
        self.0 = Some((width.round() as i64, height.round() as i64));
    }

    /// 观测尺寸是否与最近一次程序应用值一致（`true` = 该写回边沿应被抑制）。
    pub fn suppresses(&self, width: f64, height: f64) -> bool {
        self.0 == Some((width.round() as i64, height.round() as i64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 应用尺寸后的相同观测不触发写回() {
        let mut applied = AppliedSize::default();
        assert!(
            !applied.suppresses(730.0, 450.0),
            "从未应用过尺寸时不免除写回"
        );

        applied.record(730.0, 450.0);
        assert!(
            applied.suppresses(730.0, 450.0),
            "程序应用触发的写回边沿必须被抑制"
        );
        // 取整后相同（浮点尾差 / 亚像素）同样抑制：与配置值一致，落盘本会是空操作。
        assert!(applied.suppresses(730.4, 449.6));
        // 用户拖出的新尺寸照常写回（不会因抑制位吞掉真实用户操作）。
        assert!(!applied.suppresses(731.0, 450.0));
        assert!(!applied.suppresses(730.0, 451.0));
    }

    #[test]
    fn 应用尺寸覆盖旧记录且无效值不覆盖() {
        let mut applied = AppliedSize::default();
        applied.record(800.0, 600.0);
        applied.record(1024.0, 768.0);
        assert!(applied.suppresses(1024.0, 768.0));
        assert!(!applied.suppresses(800.0, 600.0), "新应用值覆盖旧值");

        // 无效尺寸不记录，也不破坏已有记录（防御性；UiHandle 已先校验）。
        applied.record(f64::NAN, 768.0);
        applied.record(-1.0, 768.0);
        applied.record(1024.0, f64::INFINITY);
        assert!(applied.suppresses(1024.0, 768.0));

        // 显式验证「用户改回旧程序应用尺寸」的边界：记录的是最近一次应用值，
        // 只有与它一致才抑制；重新应用新值后旧值不再被抑制。
        applied.record(800.0, 600.0);
        assert!(applied.suppresses(800.0, 600.0));
        assert!(!applied.suppresses(1024.0, 768.0));
    }
}
