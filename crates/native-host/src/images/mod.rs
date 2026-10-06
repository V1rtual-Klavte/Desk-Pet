//! 图片域：解码 / 缩放 / 编码的唯一实现（执行契约 §5）。
//!
//! 六条消费路径共用本模块，不各自再建缩放/编码实现：
//! 1. **模型请求附件** —— [`request::prepare_request_image`]：路径 → 原路径校验 →
//!    解码/缩放/编码 → 字节 + 真实 MIME + hints，由调用方（命令层）决定经二进制 blob
//!    通道交付 Node；本模块不实现 IPC。
//! 2. **read 工具** —— [`request::process_read_image`]：字节 + Pi 探测的 mime 入口，
//!    走同一管线（Pi 的 `ReadImageProcessor` 形状保留，base64 由调用方用标准编码完成）。
//! 3. **截图** —— [`screenshot::encode_screenshot`]：长边 1280 / PNG / 编码 ≤8 MiB。
//! 4. **查看器预览** —— [`preview::PreviewManager`]：owner + viewGeneration 生命周期、
//!    打开即解码首帧（动画 GIF/WebP 只显示首帧，2026-10-04 用户指令）、关闭/替换即释放。
//! 5. **聊天内联预览** —— [`inline::InlinePreviewManager`]：自动预览开关
//!    （`appearance.chatImagePreview`，默认关）下的可见消息按需加载；关闭零预读、
//!    离开视口/切会话/关开关立即释放、晚到结果按 owner/viewGeneration 丢弃。
//!    与查看器不共享状态，只共用本模块的准入/解码基础件。
//! 6. **剪贴板粘贴转码** —— [`decode::decode_transcode_source`]：剪贴板常见的
//!    TIFF（与补好容器头的 DIB→BMP）解码后由调用方编码为 PNG（不缩放）。
//!    只服务 `ui/chat/paste.rs`，**不放宽**聊天准入集合（[`format::sniff`] 仍拒 TIFF）。
//!
//! 边界与不变量：
//! - 准入值（格式 PNG/JPEG/GIF/WebP/BMP、每消息最多 4 张、每图 15 MiB）不在本模块另立：
//!   单源是 `src/services/images/limits.json`（见 [`limits`]）。
//! - **原图绝不改写**；不复制用户原图到新持久目录；不写任何图片文件。
//! - 本模块没有永久缓存：预览与模型请求互不复用解码/编码结果（契约 §5.3/§5.4）；
//!   请求侧的同路径去重仍由 Node 的一次性请求视图负责。
//! - 缩放口径全仓只有一份（[`decode::fit_dimensions`] + [`encode::resize_rgba`]）：
//!   请求/read 用 1568（[`request::REQUEST_IMAGE_EDGE`]），截图用 1280
//!   （[`screenshot::SCREENSHOT_MAX_EDGE`]），GIF/WebP（含动画文件）与静态图共用同一
//!   静态/首帧解码路径。
//! - 线程模型：本模块不绑定任何运行时；[`preview::PreviewManager`] 是 `Send + Sync`
//!   （编译期断言在 `preview` 模块内），解码可在调用方工作线程上执行。
//!
//! 解码保护说明（不是准入限制）：`image` crate 默认 `Limits`（max_alloc 512 MiB）是
//! 解码器自身的保护阈值，超限以明确诊断返回；它不改变上面的准入边界，也不允许被当成
//! 「原有功能等价」的替代品。

pub mod decode;
pub mod encode;
pub mod format;
pub mod inline;
pub mod limits;
pub mod preview;
pub mod request;
pub mod screenshot;
pub mod validate;

#[cfg(test)]
pub(crate) mod fixtures;

pub use decode::{fit_dimensions, DecodedFrame};
pub use format::{is_supported, mime_of, sniff, SUPPORTED_FORMATS_LABEL};
pub use inline::{InlineOutcome, InlinePreviewManager, InlinePreviewState, InlineTicket};
pub use preview::{CloseOutcome, PreviewHandle, PreviewManager, PreviewOwner};
pub use request::{
    prepare_request_image, process_read_image, PreparedRequestImage, ProcessedReadImage,
    REQUEST_IMAGE_EDGE,
};
pub use screenshot::encode_screenshot;
pub use validate::ValidatedImagePath;
