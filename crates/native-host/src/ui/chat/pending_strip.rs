//! 待发送条（A3 pending images）的共享件：缩略图缓存 + chip 宽度与横向滚动几何。
//!
//! 2026-10-06 用户实测两件事定下本模块的范围：
//! 1. 粘贴进来的图在待发送区只有「文件名（大小）✕」、看不到图 —— 用户期待看到
//!    自己刚粘进来的图 → 加**缩略图**；
//! 2. 粘贴多张时超宽的 chip 露不全也点不到（第二条只露半截，撤选够不着）→ 待发送条
//!    **横向可滚**（平台层用各自的原生机制；本模块给出尺寸/滚动/可达性的唯一几何口径）。
//!
//! 分工（与 `placeholders.rs` 的「占位零解码」互不冲突）：
//! - `placeholders.rs` 管**元数据**（文件名/大小/可用性；历史占位与待发送条目共用），
//!   它明确不解码；本模块只服务**待发送区**，对这些路径各做一次性缩略解码。
//! - 历史消息的内联预览归 `appearance.chatImagePreview` 开关（`images/inline.rs`，
//!   默认关、占位零预读）；那条开关的语义是**历史消息的内联预览**，待发送区是用户
//!   自己刚加的图（加完就要发），不落在那条语义里，故本模块不读该开关。
//!
//! 线程纪律：`rebuild_pending` 随每次整帧刷新重入，**不得**在其中同步解码
//! （用户粘的图可能几 MB）。[`PendingThumbCache::request`] 只做一次 `stat` + 查表；
//! 未命中返回 [`PendingThumbJob`]，由调用方（`ChatUi`，见 `ui.rs::pending_thumb`）
//! 丢进 `deskpet-pending-thumb` 工作线程执行 [`decode_thumbnail`]，完成后重推整帧
//! 快照。未就绪时平台层按既有文字形态显示（**不显示半个图**），就绪后随下一帧贴上。
//!
//! 缓存键 = 路径 + 文件长度 + mtime（纳秒）：同一路径内容被替换即视为新条目、重新
//! 解码。条目随 [`PendingThumbCache::retain_paths`]（每次 `rebuild_pending` 同步条内
//! 集合）回收 —— 缓存规模 = 待发送区条目数（≤ `limits.json` 的每消息张数），不随
//! 历史粘贴次数增长。解码失败同样记住（同键不再重试；文件内容变了键就变，自然重试）。
//!
//! 缩放口径：解码/缩放全走 `images/` 的既有实现 —— 目标尺寸 [`fit_in_box`] 的缩放
//! 数学来自 `decode::fit_dimensions`（只缩不放、四舍五入、至少 1 像素的唯一实现点），
//! 实际重采样用 `encode::resize_rgba`；本模块不新建缩放器。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::images::{decode, encode, limits, validate, DecodedFrame};

// ==========================================
// 尺寸/滚动几何（两平台共用的唯一口径）
// ==========================================

/// 缩略图的**逻辑显示盒**：高 18（chip 高 22 − 上下各 2 内缩）、宽上限 40。
///
/// 宽上限让极端长宽比（全景截图）不会把 chip 撑满；显示尺寸永远从这一盒等比内接，
/// 两平台同值（macOS 的 `NSButton` 图像位与 Windows 的 owner-draw 都按它摆放）。
pub const THUMB_BOX_HEIGHT: f64 = 18.0;
pub const THUMB_BOX_MAX_WIDTH: f64 = 40.0;

/// 缩略图**解码像素盒** = 逻辑盒 × 3：覆盖 Retina 2x 与 Windows 最高 300% DPI
/// （更高缩放时平台把已解码像素轻放大，代价可忽略）。解码即定稿，两平台共用一份缓存。
pub const THUMB_DECODE_BOX_WIDTH: u32 = 120; // 40 × 3
pub const THUMB_DECODE_BOX_HEIGHT: u32 = 54; // 18 × 3

/// chip 内容宽的公式常量：文案左右内边距（既有 `+20` 口径）、缩略图与文案的间距。
pub const CHIP_H_PADDING: f64 = 20.0;
pub const THUMB_TEXT_GAP: f64 = 4.0;

/// 盒子内等比内接（只缩不放；整数像素口径）。
///
/// 只做「选边」——哪条边先顶到盒子上限就按哪条边收；缩放数学（`min(1.0)` 不放大、
/// 四舍五入、至少 1 像素）全部来自 [`decode::fit_dimensions`]（全仓唯一实现点），
/// 本函数不复制第二套缩放公式。
pub fn fit_in_box(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    // 比较 w/h 与盒子的宽高比（交叉相乘，整数精确）：横边先顶就按宽收，否则按高收。
    if u64::from(width) * u64::from(max_height) >= u64::from(height) * u64::from(max_width) {
        decode::fit_dimensions(width, height, max_width)
    } else {
        decode::fit_dimensions(width, height, max_height)
    }
}

/// 缩略图在 chip 内的逻辑显示尺寸（pt；整数，口径与 [`fit_in_box`] 一致、不放大）。
pub fn thumb_display_size(frame_width: u32, frame_height: u32) -> (u32, u32) {
    fit_in_box(
        frame_width,
        frame_height,
        THUMB_BOX_MAX_WIDTH as u32,
        THUMB_BOX_HEIGHT as u32,
    )
}

/// 待发送 chip 的内容宽：缩略图（如有）+ 间距 + 文案 + 水平内边距，钳到 `[min, max]`。
///
/// 缩略图与文案、✕ 的**总宽**都在这一个公式里（两平台不再各写各的宽度算式）；
/// `thumb_width = 0.0` 即无缩略图的纯文案形态（未就绪 / 不可用）。
pub fn chip_width(text_width: f64, thumb_width: f64, min_width: f64, max_width: f64) -> f64 {
    let mut width = text_width + CHIP_H_PADDING;
    if thumb_width > 0.0 {
        width += thumb_width + THUMB_TEXT_GAP;
    }
    width.clamp(min_width, max_width)
}

/// 条内第 `index` 个条目的左缘（逻辑）：左内边距起，逐条累加（含条目间距）。
pub fn chip_offset(index: usize, widths: &[f64], pad_x: f64, gap: f64) -> f64 {
    let mut x = pad_x;
    for width in widths.iter().take(index) {
        x += width + gap;
    }
    x
}

/// 条内容总宽（逻辑；一个条目都没有 = 0）。超过视口宽的部分即滚动量。
pub fn strip_content_width(widths: &[f64], pad_x: f64, gap: f64) -> f64 {
    match widths.len() {
        0 => 0.0,
        count => pad_x * 2.0 + widths.iter().sum::<f64>() + gap * (count - 1) as f64,
    }
}

/// 横向滚动量钳制到 `[0, 内容宽 − 视口宽]`（负数与越界都收口；内容不超宽时恒 0）。
/// 两平台共用（macOS 每次重建/重排后回写 `NSScrollView`，Windows 写进条内偏移）。
pub fn clamp_scroll(offset: f64, content_width: f64, viewport_width: f64) -> f64 {
    offset.clamp(0.0, (content_width - viewport_width).max(0.0))
}

/// 让一个条目**完整入视**所需的滚动量（左缘 + 宽 − 视口宽，下限 0）。
///
/// 语义即「可达性」：滚动量取 [`clamp_scroll`] 上限以内的该值时，条目左右缘都落在
/// 视口里（前提：条目宽 ≤ 视口宽 —— chip 宽上限 200 是条宽的预算边界，见测试）。
pub fn reveal_offset(chip_left: f64, chip_width: f64, viewport_width: f64) -> f64 {
    (chip_left + chip_width - viewport_width).max(0.0)
}

// ==========================================
// 缩略图缓存
// ==========================================

/// 缓存键：同一路径的**内容指纹**。长度或 mtime 任一变化即视为新条目（重新解码）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PendingThumbKey {
    path: String,
    len: u64,
    /// 修改时间（UNIX 纪元纳秒）；个别文件系统取不到时退化为 `None`
    /// （键仍带 path + len 两段指纹，不做静默替换）。
    modified_nanos: Option<u128>,
}

impl PendingThumbKey {
    /// 由路径探测键。文件缺失/不是常规文件/元数据读不到 → `None`（不可用，不排解码）。
    fn from_path(path: &str) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let modified_nanos = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos());
        Some(Self {
            path: path.to_string(),
            len: metadata.len(),
            modified_nanos,
        })
    }

    /// 源路径（工作线程解码用）。
    pub fn path(&self) -> &str {
        &self.path
    }
}

/// 一次取缩略图的结果（平台层按它决定贴图还是退回纯文案）。
#[derive(Debug, Clone)]
pub enum PendingThumbStatus {
    /// 已就绪（`Arc` 共享像素，克隆零拷贝）。
    Ready(DecodedFrame),
    /// 工作线程正在解码：本次先按文字形态显示，完成后由就绪通知触发重建。
    Loading,
    /// 不可用（元数据读不到 / 已解码失败）：按文字形态显示，不再重复尝试。
    Unavailable,
}

/// 交给工作线程执行的解码任务（[`PendingThumbCache::request`] 未命中时产出）。
#[derive(Debug, Clone)]
pub struct PendingThumbJob {
    key: PendingThumbKey,
}

impl PendingThumbJob {
    pub fn path(&self) -> &str {
        self.key.path()
    }
}

#[derive(Default)]
struct CacheState {
    /// 已完结条目：`Some(frame)` 已解码；`None` = 解码失败（记住，不重试同键）。
    entries: HashMap<PendingThumbKey, Option<DecodedFrame>>,
    /// 在途解码（同一键只派一个工作线程）。
    inflight: HashSet<PendingThumbKey>,
}

/// 待发送缩略图缓存（`Send + Sync`，进程级挂 `ChatUi`；可在工作线程回填）。
#[derive(Default)]
pub struct PendingThumbCache {
    state: Mutex<CacheState>,
}

impl PendingThumbCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取一张缩略图：命中即返回；未命中登记在途并交出事务（调用方派线程）。
    ///
    /// 只做一次 `stat` + 查表 —— 绝不在调用线程解码（调用点在 UI 主线程的
    /// `rebuild_pending` 里）。
    pub fn request(&self, path: &str) -> (PendingThumbStatus, Option<PendingThumbJob>) {
        let Some(key) = PendingThumbKey::from_path(path) else {
            return (PendingThumbStatus::Unavailable, None);
        };
        let mut state = self.lock();
        if let Some(entry) = state.entries.get(&key) {
            return match entry {
                Some(frame) => (PendingThumbStatus::Ready(frame.clone()), None),
                None => (PendingThumbStatus::Unavailable, None),
            };
        }
        if !state.inflight.insert(key.clone()) {
            return (PendingThumbStatus::Loading, None);
        }
        (
            PendingThumbStatus::Loading,
            Some(PendingThumbJob { key }),
        )
    }

    /// 工作线程回填：`Ok(frame)` 记为就绪，`Err` 记为失败（两者都清在途位）。
    ///
    /// 晚到的结果不做代际丢弃：键含内容指纹，旧键的产物只会挂在旧键上，而平台
    /// 只按当前文件的键取（改过的文件是活不成的旧键）。
    pub fn complete(&self, job: &PendingThumbJob, frame: Option<DecodedFrame>) {
        let mut state = self.lock();
        state.inflight.remove(&job.key);
        state.entries.insert(job.key.clone(), frame);
    }

    /// 线程派发失败时撤销在途位（下次重建会重新建任务）；不留「永远 Loading」的假态。
    pub fn abandon(&self, job: &PendingThumbJob) {
        self.lock().inflight.remove(&job.key);
    }

    /// 只保留 `paths` 里的条目：撤选/发送/切会话后，条外像素随之下岗。
    ///
    /// 调用点 = 每次 `rebuild_pending`（条内集合就是当前待发送区）。条内条目被
    /// retain 掉后又**恰好**重入（罕见竞态）时最多多解一次；同键解码结果相同，
    /// 不会出现两份不同内容。
    pub fn retain_paths(&self, paths: &[String]) {
        let mut state = self.lock();
        state
            .entries
            .retain(|key, _| paths.iter().any(|path| path == &key.path));
        state
            .inflight
            .retain(|key| paths.iter().any(|path| path == &key.path));
    }

    fn lock(&self) -> MutexGuard<'_, CacheState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// 工作线程执行体：有界读取 → 解码首帧（EXIF 方向照常应用）→ 缩到解码像素盒。
///
/// 读取上限与内联预览同一条（`limits.json` 的单张字节上限；准入时已过一遍，这里防的
/// 是「入区后文件被换大」——超限即明确报错，不把超大文件拉进内存，也不产出半张图）。
pub fn decode_thumbnail(job: &PendingThumbJob) -> crate::error::AppResult<DecodedFrame> {
    use crate::error::AppError;

    let max_bytes = limits::image_limits()?.max_bytes;
    let path = Path::new(job.path());
    let Some(bytes) = validate::read_within(path, max_bytes)? else {
        return Err(AppError::Tool(format!(
            "图片超过 {} MiB 上限，无法生成待发送缩略图",
            max_bytes / 1024 / 1024
        )));
    };
    let decoded = decode::decode_static(&bytes)?;
    let (width, height) = decoded.image.dimensions();
    if width == 0 || height == 0 {
        return Err(AppError::Other("图片尺寸为 0，无法生成缩略图".to_string()));
    }
    let (thumb_width, thumb_height) = fit_in_box(
        width,
        height,
        THUMB_DECODE_BOX_WIDTH,
        THUMB_DECODE_BOX_HEIGHT,
    );
    if (thumb_width, thumb_height) == (width, height) {
        // 小图不放大：像素原样交出（显示层也只缩不放）。
        return Ok(DecodedFrame {
            width,
            height,
            rgba: std::sync::Arc::from(decoded.image.into_raw()),
        });
    }
    let scaled = encode::resize_rgba(&decoded.image, thumb_width, thumb_height);
    Ok(DecodedFrame {
        width: thumb_width,
        height: thumb_height,
        rgba: std::sync::Arc::from(scaled.into_raw()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;

    /// 解码像素盒与显示盒的内接：宽图按宽收、高图按高收、小图原样（不放大）、
    /// 极端细长不塌到 0。把 [`fit_in_box`] 的选边改为恒定按高（或去掉不放大）即红。
    #[test]
    fn fit_in_box_shrinks_only_and_picks_the_binding_edge() {
        // 400×100 → 宽先顶盒：scale = 120/400 → (120, 30)。
        assert_eq!(fit_in_box(400, 100, 120, 54), (120, 30));
        // 100×400 → 高先顶盒：scale = 54/400 → (14, 54)（13.5 四舍五入）。
        assert_eq!(fit_in_box(100, 400, 120, 54), (14, 54));
        // 恰好等于盒：原样。
        assert_eq!(fit_in_box(120, 54, 120, 54), (120, 54));
        // 小图不放大（两个方向都小于盒）。
        assert_eq!(fit_in_box(10, 10, 120, 54), (10, 10));
        // 极端细长：不塌到 0。
        assert_eq!(fit_in_box(4000, 1, 120, 54), (120, 1));
        assert_eq!(fit_in_box(1, 4000, 120, 54), (1, 54));
    }

    /// 显示尺寸用同一盒（40 × 18）的同一条内接口径，且与解码盒成 3 倍关系。
    #[test]
    fn thumb_display_size_is_the_point_scale_of_the_decode_box() {
        assert_eq!(thumb_display_size(1200, 300), (40, 10));
        assert_eq!(thumb_display_size(54, 54), (18, 18));
        assert_eq!(thumb_display_size(6, 6), (6, 6)); // 小图不放大
        assert_eq!(
            (THUMB_DECODE_BOX_WIDTH, THUMB_DECODE_BOX_HEIGHT),
            (THUMB_BOX_MAX_WIDTH as u32 * 3, THUMB_BOX_HEIGHT as u32 * 3),
            "解码盒 = 逻辑盒 × 3（Retina/300% DPI 预算），改一处必须同步另一处"
        );
    }

    /// chip 宽 = 文案 + 内边距（+ 缩略图与间距），并在 [min,max] 钳制。
    /// 改动钳制边界、漏算缩略图或间距都会让本用例变红。
    #[test]
    fn chip_width_adds_thumbnail_and_padding_then_clamps() {
        // 纯文案：100 + 20 = 120（在 64..200 内）。
        assert_eq!(chip_width(100.0, 0.0, 64.0, 200.0), 120.0);
        // 带缩略图：100 + 20 + 18 + 4 = 142。
        assert_eq!(chip_width(100.0, 18.0, 64.0, 200.0), 142.0);
        // 超长文案被上限钳住（缩略图不能把 chip 顶破 200 的预算）。
        assert_eq!(chip_width(500.0, 40.0, 64.0, 200.0), 200.0);
        // 短文案被下限托住。
        assert_eq!(chip_width(4.0, 0.0, 64.0, 200.0), 64.0);
    }

    /// 条内容宽 = 左右内边距 + Σ宽 + 间距 ×（条数 − 1）；空条为 0，单条无间距。
    #[test]
    fn strip_content_width_counts_padding_and_gaps_exactly() {
        assert_eq!(strip_content_width(&[], 10.0, 6.0), 0.0);
        assert_eq!(strip_content_width(&[200.0], 10.0, 6.0), 220.0);
        // 4 条满宽（用户实测的多张截图形态）：20 + 800 + 3×6 = 838。
        let full = [200.0; 4];
        assert_eq!(strip_content_width(&full, 10.0, 6.0), 838.0);
        // 左缘累进：第 4 条的左缘 = 10 + 3×(200+6) = 628。
        assert_eq!(chip_offset(3, &full, 10.0, 6.0), 628.0);
        assert_eq!(chip_offset(0, &full, 10.0, 6.0), 10.0);
    }

    /// **可达性核心**（用户实测「多张截图不能滚动、点不到」的回归断言）：
    /// 超宽时每个 chip 都能滚到完整入视 —— 逐条验证 `reveal_offset` 不超过
    /// 最大滚动量，且该偏移下条的左右缘都落在视口内。
    ///
    /// 把 `strip_content_width` 少算一个间距（或 `clamp_scroll` 上限算错）即红：
    /// 最后一条会差几个像素露不全。
    #[test]
    fn every_chip_is_reachable_by_scrolling_when_the_strip_overflows() {
        let widths = [200.0; 4];
        let (pad_x, gap, viewport) = (10.0, 6.0, 360.0);
        let content = strip_content_width(&widths, pad_x, gap);
        let max_scroll = clamp_scroll(f64::INFINITY, content, viewport);
        assert_eq!(content, 838.0);
        assert_eq!(max_scroll, 478.0, "最大滚动量 = 内容宽 − 视口宽");

        for (index, width) in widths.iter().enumerate() {
            let left = chip_offset(index, &widths, pad_x, gap);
            let target = clamp_scroll(reveal_offset(left, *width, viewport), content, viewport);
            assert!(
                target <= max_scroll,
                "第 {} 条的滚动量超过上限，滚到底也看不到",
                index + 1
            );
            assert!(
                left >= target - 0.001 && left + width <= target + viewport + 0.001,
                "第 {} 条在目标偏移 {target} 下没有完整入视（[{left}, {}]）",
                index + 1,
                left + width
            );
        }
        // 最后一条滚到 468 即完整入视（左缘 628 + 宽 200 − 视口 360）；离上限还差
        // 的 10 是内容右侧的内边距 —— 两个数各算各的，把其中一个改成另一个值即红。
        let last = 3;
        let last_left = chip_offset(last, &widths, pad_x, gap);
        assert_eq!(reveal_offset(last_left, widths[last], viewport), 468.0);
        assert_eq!(max_scroll - reveal_offset(last_left, widths[last], viewport), 10.0);

        // 不超宽时任何偏移都收口为 0（不会无谓地滚动）。
        assert_eq!(clamp_scroll(50.0, 300.0, 360.0), 0.0);
        // 负偏移收口为 0。
        assert_eq!(clamp_scroll(-20.0, 838.0, 360.0), 0.0);
    }

    /// 缓存键识别「同一路径内容已变」：重写文件（长度变化）后必须重新解码；
    /// 长度不变时按显式改写的 mtime 判定（不依赖写盘时钟粒度）。
    #[test]
    fn thumb_key_identifies_content_change_on_the_same_path() {
        let dir = fixtures::temp_dir("pending-thumb-key");
        let path = dir.join("照片.png");
        std::fs::write(&path, fixtures::png_solid(8, 8)).unwrap();
        let path_text = path.to_string_lossy().into_owned();
        let first = PendingThumbKey::from_path(&path_text).expect("键必须可建");

        // 同内容重复探测：键稳定（第二次请求才不会重复解码）。
        assert_eq!(first, PendingThumbKey::from_path(&path_text).unwrap());

        // 内容变长（同一路径）：新键。
        std::fs::write(&path, fixtures::png_solid(9, 9)).unwrap();
        let longer = PendingThumbKey::from_path(&path_text).unwrap();
        assert_ne!(first, longer, "长度变化必须换键");

        // 长度不变、只改 mtime：新键（内容指纹的另一半）。
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000))
            .unwrap();
        drop(file);
        let retouched = PendingThumbKey::from_path(&path_text).unwrap();
        assert_eq!(retouched.len, longer.len);
        assert_ne!(longer, retouched, "mtime 变化必须换键");

        // 缺失文件：如实不可用（不建键、不排解码）。
        assert!(PendingThumbKey::from_path(&dir.join("missing.png").to_string_lossy()).is_none());

        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 缓存状态机：未命中 → Loading（**不产出 Ready，也就不会显示半个图**）；
    /// 回填后才 Ready；失败被记住（同键不再重试）；retain 回收条外条目。
    #[test]
    fn cache_serves_ready_only_after_completion_and_remembers_failures() {
        let dir = fixtures::temp_dir("pending-thumb-cache");
        let path = dir.join("图.png");
        std::fs::write(&path, fixtures::png_solid(8, 8)).unwrap();
        let path_text = path.to_string_lossy().into_owned();
        let cache = PendingThumbCache::new();

        // 首次请求：Loading + 一个任务；重复请求不重复派发。
        let (status, job) = cache.request(&path_text);
        assert!(
            matches!(status, PendingThumbStatus::Loading),
            "解码完成前不得给出 Ready（未就绪时平台只画文字）"
        );
        let job = job.expect("首次未命中必须交出一个解码任务");
        let (status, second_job) = cache.request(&path_text);
        assert!(matches!(status, PendingThumbStatus::Loading));
        assert!(second_job.is_none(), "在途同键不得重复派发");

        // 回填后：Ready 且不再派任务。
        let frame = decode_thumbnail(&job).expect("夹具必须可解");
        cache.complete(&job, Some(frame));
        let (status, job) = cache.request(&path_text);
        assert!(matches!(status, PendingThumbStatus::Ready(_)), "回填后可取到像素");
        assert!(job.is_none());

        // 失败记住：同键直接 Unavailable（不反复重解坏文件）。
        let broken = dir.join("坏图.png");
        std::fs::write(&broken, b"not an image").unwrap();
        let broken_text = broken.to_string_lossy().into_owned();
        let (_, job) = cache.request(&broken_text);
        let job = job.expect("坏文件也先派一次解码");
        assert!(decode_thumbnail(&job).is_err(), "坏文件不得解出半张图");
        cache.complete(&job, None);
        let (status, job) = cache.request(&broken_text);
        assert!(matches!(status, PendingThumbStatus::Unavailable));
        assert!(job.is_none(), "已记住的失败不得重复派发");

        // retain 只留条内：条外条目连同像素下岗，再取要重新解码。
        let keep = vec![path_text.clone()];
        cache.retain_paths(&keep);
        assert!(matches!(cache.request(&path_text).0, PendingThumbStatus::Ready(_)));
        let (status, job) = cache.request(&broken_text);
        assert!(matches!(status, PendingThumbStatus::Loading), "条外条目已被回收");
        assert!(job.is_some());

        // 撤选（retain 空集）后全部回收。
        cache.retain_paths(&[]);
        let (status, job) = cache.request(&path_text);
        assert!(matches!(status, PendingThumbStatus::Loading));
        assert!(job.is_some(), "条被清空后缓存不残留像素");

        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 解码缩略图：大图缩进解码像素盒、小图不放大、坏文件如实报错（不产出半图）。
    #[test]
    fn decode_thumbnail_scales_into_the_pixel_box_without_upscaling() {
        let dir = fixtures::temp_dir("pending-thumb-decode");

        let big = dir.join("大图.png");
        std::fs::write(&big, fixtures::png_solid(400, 100)).unwrap();
        let cache = PendingThumbCache::new();
        let (_, job) = cache.request(&big.to_string_lossy());
        let frame = decode_thumbnail(&job.unwrap()).expect("大图必须可解");
        assert_eq!(
            (frame.width, frame.height),
            (THUMB_DECODE_BOX_WIDTH, 30),
            "400×100 缩到 120 宽（等比）"
        );
        assert_eq!(frame.rgba.len(), 120 * 30 * 4);

        let small = dir.join("小图.png");
        std::fs::write(&small, fixtures::png_solid(10, 10)).unwrap();
        let (_, job) = cache.request(&small.to_string_lossy());
        let frame = decode_thumbnail(&job.unwrap()).expect("小图必须可解");
        assert_eq!((frame.width, frame.height), (10, 10), "小图不放大");

        let missing = dir.join("缺失.png");
        let (status, job) = cache.request(&missing.to_string_lossy());
        assert!(matches!(status, PendingThumbStatus::Unavailable));
        assert!(job.is_none(), "元数据读不到不排解码");

        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 从源码里截出某个函数的正文：签名之后、下一个顶层函数/方法（0 或 4 空格缩进）之前。
    fn function_body<'a>(name: &str, source: &'a str, signature: &str) -> &'a str {
        let start = source
            .find(signature)
            .unwrap_or_else(|| panic!("{name}: 找不到 {signature}"));
        let body = &source[start..];
        let end = [
            "\nfn ",
            "\nunsafe fn ",
            "\npub fn ",
            "\n    fn ",
            "\n    unsafe fn ",
            "\n    pub fn ",
        ]
        .iter()
        .filter_map(|marker| body.find(marker))
        .min();
        match end {
            Some(end) => &body[..end],
            None => body,
        }
    }

    /// 宽度与滚动是**一套口径**（2026-10-06 用户要求：缩略图加宽与「超宽可滚」
    /// 一次算清）：两个平台的重建函数都必须用共享 `chip_width` / `strip_content_width`
    /// —— 任何一边退回各写各的宽度算式（漏缩略图/漏间距）或漏算内容总宽即红。
    #[test]
    fn pending_strip_geometry_is_shared_by_both_platforms() {
        for (name, source) in [
            ("macos_chat.rs", include_str!("../platform/macos_chat.rs")),
            ("windows_chat.rs", include_str!("../platform/windows_chat.rs")),
        ] {
            let rebuild = function_body(name, source, "fn rebuild_pending(");
            assert!(
                rebuild.contains("chip_width("),
                "{name}: chip 宽必须来自共享 pending_strip::chip_width"
            );
            assert!(
                rebuild.contains("strip_content_width("),
                "{name}: 条内容总宽必须来自共享 pending_strip::strip_content_width"
            );
            assert!(
                rebuild.contains("retain_pending_thumbs"),
                "{name}: 重建必须同步缩略图缓存保留集（条外像素下岗）"
            );
        }
    }

    /// 防回归（2026-10-06 用户实测「待发送 chip 两个 ✕」）：chip 标题只由共享
    /// `pending_label` 产出，**重建函数里不得再出现 ✕ 字面量**；Windows 与 macOS
    /// 两个平台文件都查（本模块两平台都编译，任一平台的 CI 都会跑到这条）。
    ///
    /// 曾出问题的形态是 `format!("{} ✕", pending_label(image))` —— 把这行写回去即红。
    #[test]
    fn pending_chip_labels_never_append_a_second_cross_in_either_platform() {
        for (name, source) in [
            ("macos_chat.rs", include_str!("../platform/macos_chat.rs")),
            ("windows_chat.rs", include_str!("../platform/windows_chat.rs")),
        ] {
            let rebuild = function_body(name, source, "fn rebuild_pending(");
            assert!(
                rebuild.contains("pending_label"),
                "{name}: 待发送 chip 标题必须用共享的 pending_label"
            );
            // 只看**代码**：行注释里写「曾经多拼一个 ✕」这类回归说明是应该鼓励的，
            // 不该被这条守卫打红（第一版没剥注释，写说明的人反而撞红）。
            let code_only: String = rebuild
                .lines()
                .map(|line| line.split("//").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !code_only.contains('✕'),
                "{name}: rebuild_pending 不得再拼接 ✕（两个 ✕ 的用户实测回归）"
            );
        }
    }
}
