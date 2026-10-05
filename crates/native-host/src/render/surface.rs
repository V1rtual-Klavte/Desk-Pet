//! 平台表面（[`RenderSurface`]）契约 —— 渲染编排与窗口系统之间的唯一接缝。
//!
//! 几何、纹理账目与帧循环状态全部在平台无关的 [`crate::render::Renderer`] 里；
//! 本 trait 只保留「平台真的必须亲自做的事」：纹理上传/释放、逐帧合成提交、
//! 帧计时器的真实启停。两平台实现：
//!
//! - macOS：`render::mac::MacLayerSurface`（CALayer + NSTimer）；
//! - Windows：`render::win::WinLayerSurface`（WS_EX_LAYERED + UpdateLayeredWindow + SetTimer）。
//!
//! 合同（实现方必须满足，调用方依赖）：
//! - [`RenderSurface::upload`] 取走解码缓冲的所有权：实现可以把它移进平台对象
//!   （macOS 交给 CGImage 的 data provider，Windows 填进 DIB），不必在 Rust 侧再留副本。
//!   返回 `Err` 时不得留下任何已登记状态（渲染账目不会记录该 id）。
//! - [`RenderSurface::release`] 释放指定纹理；未登记的 id 直接忽略（幂等）。
//! - [`RenderSurface::present`] 的 `plan.draws` 已按 z 序排列（**先画 = 最底层**，
//!   与输入层列表顺序一致）；表面不得重排。窗口尺寸由 `plan.window`（逻辑像素）给出。
//!   `LayerDraw::slot` 是绘制实例的身份（输入层下标），`LayerDraw::texture` 只是素材：
//!   同一纹理可以被多个槽引用（同一素材出现在多个层时只上传一次），
//!   所以**按槽建绘制实例**，不要把槽和纹理设成一一对应。
//! - [`RenderSurface::start_ticks`] 之后，平台以约 60Hz 调用 sink；调用前不得已有
//!   运行中的计时器（`Renderer` 保证），失败时不得留下已启动的计时器。
//! - [`RenderSurface::stop_ticks`] 返回后不得再调用 sink —— **包括已经入队的回调**：
//!   这是「隐藏后零帧回调」在渲染侧的硬保证。

use crate::error::AppResult;

use super::compose::FramePlan;
use super::texture::{DecodedTexture, TextureId};

/// 计时器回调槽。两平台都通过裸指针把槽交给平台回调（ObjC ivar / HWND user data），
/// 由 [`crate::render::Renderer::start_frames`] 填入一个只持 `Weak` 的闭包。
pub(crate) struct TickSlot {
    pub sink: Box<dyn FnMut() + Send>,
}

pub trait RenderSurface: Send {
    /// 上传一张纹理（见模块级合同：取走缓冲所有权；失败不留半登记状态）。
    fn upload(&mut self, id: TextureId, texture: DecodedTexture) -> AppResult<()>;

    /// 释放纹理；不存在的 id 忽略。
    fn release(&mut self, id: TextureId);

    /// 应用一帧（`plan.draws` 已按 z 序，先画 = 最底层）。
    fn present(&mut self, plan: &FramePlan) -> AppResult<()>;

    /// 启动平台帧计时器；之后约 60Hz 调用 `sink`。
    fn start_ticks(&mut self, sink: Box<dyn FnMut() + Send>) -> AppResult<()>;

    /// 停止平台帧计时器；返回后不得再调用 sink（含已入队的回调）。
    fn stop_ticks(&mut self) -> AppResult<()>;
}
