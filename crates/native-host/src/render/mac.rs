//! macOS 平台表面：CALayer 五层合成 + NSTimer 帧循环。
//!
//! 做法照搬 W0 探针的 macOS 渲染原型（**实机跑通**的五层合成，五层几何与 golden
//! 逐位一致；探针 `crates/ui-probe` 已随迁移完成删除，过程记录见
//! `docs/history/implementation/原生宿主迁移过程记录-2026-10-04基线.md`）：
//! - 内容视图 layer-backing 后，每个绘制槽一层，`contents` 直接放 CGImage；
//! - **CALayer 属性写入默认带隐式动画**：逐帧更新必须包在 `CATransaction` 里并
//!   `setDisableActions:`，否则每帧都会叠一层 0.25s 的位置/尺寸动画（原型 A 的实测教训）；
//! - 帧循环是主线程 run loop 上的 60Hz `NSTimer`；停止 = `invalidate`，隐藏后零回调。
//!
//! 纹理与槽是两层身份：同一素材（同一 `TextureId`）可以被多个绘制槽引用 ——
//! CGImage 只建一张，每个槽的 CALayer 各自 retain 它作为 `contents`；槽才是位置/尺寸
//! 的载体（一个 CALayer 实例只能出现在一个位置）。
//!
//! 纹理像素来自 Rust 解码链（`xcap::image` → 预乘 BGRA），用
//! `kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little` 直接建 CGImage，
//! 交给 CGImage 的 data provider 持有；解码缓冲移进 provider 后不在 Rust 侧留副本。
//!
//! 线程约束：AppKit/CoreAnimation 只能在主线程调用 —— 本类型的构造、所有方法调用与
//! Drop 都必须在主线程（`Renderer` 的互斥锁也只在主线程获取，帧计时器同样在主线程触发）。
//! `unsafe impl Send` 的依据就来自这条约定：句柄只可能被搬到同一线程的持有者里。

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr;

use objc::declare::ClassDecl;
use objc::rc::StrongPtr;
use objc::runtime::{Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};

use crate::error::{AppError, AppResult};
use crate::rust_warn;

use super::compose::FramePlan;
use super::surface::{RenderSurface, TickSlot};
use super::texture::{DecodedTexture, TextureId};
use super::FRAME_INTERVAL_SECS;

// ── CoreGraphics 结构类型（与 CoreGraphics 的 C 定义同布局；msg_send 按值传参）──

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

/// `kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little`：预乘 BGRA。
const CG_IMAGE_BITMAP_INFO: u32 = 2 | (2 << 12);

#[link(name = "Foundation", kind = "framework")]
extern "C" {}

#[link(name = "QuartzCore", kind = "framework")]
extern "C" {
    static kCAGravityResize: *const Object;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGImageCreate(
        width: usize,
        height: usize,
        bits_per_component: usize,
        bits_per_pixel: usize,
        bytes_per_row: usize,
        space: *mut c_void,
        bitmap_info: u32,
        provider: *mut c_void,
        decode: *const f64,
        should_interpolate: bool,
        intent: i32,
    ) -> *mut c_void;
    fn CGImageRelease(image: *mut c_void);
    fn CGDataProviderCreateWithData(
        info: *mut c_void,
        data: *const c_void,
        size: usize,
        release_data: Option<extern "C" fn(*mut c_void, *const c_void, usize)>,
    ) -> *mut c_void;
    fn CGDataProviderRelease(provider: *mut c_void);
    fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
    fn CGColorSpaceRelease(space: *mut c_void);
}

/// data provider 的数据释放回调：`info` 是 `Box<Vec<u8>>` 的原始指针。
/// 注意释放必须经 `info` 反推 Box —— 回调收到的 `data` 是 Vec 的缓冲地址，不是 Box 地址。
extern "C" fn release_pixel_buffer(info: *mut c_void, _data: *const c_void, _size: usize) {
    if info.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(info as *mut Vec<u8>));
    }
}

/// 预乘 BGRA 缓冲 → CGImage（像素所有权移交给 provider；调用方负责 CGImageRelease）。
fn cg_image_from_bgra(width: u32, height: u32, bgra: Vec<u8>) -> AppResult<*mut c_void> {
    let expected = width as usize * height as usize * 4;
    if bgra.len() != expected {
        return Err(AppError::Other(format!(
            "纹理缓冲长度不符: {} != {expected}",
            bgra.len()
        )));
    }
    let pixels = Box::into_raw(Box::new(bgra));
    let len = unsafe { (*pixels).len() };
    let data = unsafe { (*pixels).as_ptr() } as *const c_void;
    unsafe {
        let provider = CGDataProviderCreateWithData(
            pixels as *mut c_void,
            data,
            len,
            Some(release_pixel_buffer),
        );
        if provider.is_null() {
            // provider 未创建：释放回调不会发生，这里自己归还缓冲。
            drop(Box::from_raw(pixels));
            return Err(AppError::Other("CGDataProvider 创建失败".into()));
        }
        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() {
            // 释放 provider 会经回调归还像素缓冲。
            CGDataProviderRelease(provider);
            return Err(AppError::Other("CGColorSpace 创建失败".into()));
        }
        let image = CGImageCreate(
            width as usize,
            height as usize,
            8,
            32,
            width as usize * 4,
            space,
            CG_IMAGE_BITMAP_INFO,
            provider,
            ptr::null(),
            true,
            0,
        );
        // CGImageCreate 已 retain colorspace 与 provider；创建的失败路径也一样，
        // 直接释放我们这两个引用：成功时 image 持有 provider，失败时归还像素缓冲。
        CGColorSpaceRelease(space);
        CGDataProviderRelease(provider);
        if image.is_null() {
            return Err(AppError::Other("CGImage 创建失败".into()));
        }
        Ok(image)
    }
}

/// 持有 +1 引用的 CGImageRef（CF 类型，不能用 StrongPtr 管：那不是 ObjC 对象的 release）。
struct CgImage(*mut c_void);

impl Drop for CgImage {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CGImageRelease(self.0) };
        }
    }
}

// ── 帧计时器：NSTimer 需要一个 ObjC target 对象，槽经 ivar 以裸指针暴露 ──

const TICK_TARGET_CLASS: &str = "DeskPetLayerTickTarget";

extern "C" fn tick_fired(this: &Object, _cmd: Sel, _timer: *mut Object) {
    unsafe {
        let slot = *this.get_ivar::<*mut c_void>("slot") as *mut TickSlot;
        if !slot.is_null() {
            ((*slot).sink)();
        }
    }
}

fn ensure_tick_target_class() -> Option<&'static Class> {
    if Class::get(TICK_TARGET_CLASS).is_none() {
        let mut declaration = ClassDecl::new(TICK_TARGET_CLASS, class!(NSObject))?;
        declaration.add_ivar::<*mut c_void>("slot");
        unsafe {
            declaration.add_method(
                sel!(deskpetTick:),
                tick_fired as extern "C" fn(&Object, Sel, *mut Object),
            );
        }
        declaration.register();
    }
    Class::get(TICK_TARGET_CLASS)
}

/// 把回调槽指针写进 target 的 ivar。`Object::set_ivar` 是方法，
/// 而 Rust 的方法解析不会自动穿透裸指针，这里显式取 `&mut Object`。
///
/// # Safety
/// `target` 必须是本模块声明、带 `slot` ivar 的目标对象。
unsafe fn set_target_slot(target: &StrongPtr, slot: *mut c_void) {
    let raw: *mut Object = **target;
    (&mut *raw).set_ivar("slot", slot);
}

// ── 表面 ──

/// 一个绘制槽 = 输入层列表中的一个位置（下标）。层可以被禁用/换素材，槽的位置语义不变。
struct MacSlot {
    layer: StrongPtr,
    texture: TextureId,
}

pub struct MacLayerSurface {
    /// 目标视图（主窗 contentView 或编辑器预览视图）；持有引用保证生命周期。
    _view: StrongPtr,
    root: StrongPtr,
    /// 驻留纹理：同一素材只建一张 CGImage，多个槽共享。
    textures: HashMap<TextureId, CgImage>,
    /// 绘制槽 → CALayer。
    slots: HashMap<u32, MacSlot>,
    /// 当前子层顺序（上一帧的槽顺序），与目标顺序不同才重排。
    order: Vec<u32>,
    timer: Option<StrongPtr>,
    target: Option<StrongPtr>,
    slot: Option<Box<TickSlot>>,
}

// 只允许在主线程访问（AppKit 约定）；见模块头的线程约束。
unsafe impl Send for MacLayerSurface {}

impl MacLayerSurface {
    /// 在一个 layer-backed NSView 上建根层（窗口 contentView 或编辑器预览视图）。
    /// 视图会被 retain，release 前必须保持有效。
    ///
    /// # Safety
    /// `ns_view` 必须是主线程上仍有效的 NSView 指针。
    pub unsafe fn new(ns_view: *mut c_void) -> AppResult<Box<Self>> {
        if ns_view.is_null() {
            return Err(AppError::Other("渲染表面需要有效的 NSView".into()));
        }
        let view = StrongPtr::retain(ns_view as *mut Object);
        // 开工门：**渲染表面必须挂在翻转视图上**（isFlipped=true）。`layer_draw`
        // 的 center_y 是左上原点（y 向下）算式，而普通 NSView 的 backing layer
        // 是 y 向上 —— 挂普通视图会让整页合成垂直镜像，且静默（2026-10-05 实机
        // 确证的「主窗只见背景、角色不可见」根因；对视图托管的 layer，
        // `setGeometryFlipped` 不生效，AppKit 按 isFlipped 决定）。这里 fail-fast，
        // 把这类静默镜像变成启动即报错。
        let flipped: bool = msg_send![*view, isFlipped];
        ensure_flipped_view(flipped)?;
        let _: () = msg_send![*view, setWantsLayer: true];
        let root: *mut Object = msg_send![*view, layer];
        if root.is_null() {
            return Err(AppError::Other(
                "视图 layer-backing 失败（layer 为空）".into(),
            ));
        }
        let root = StrongPtr::retain(root);
        // y 向下，与几何核的窗口坐标系一致（翻转视图下与 AppKit 的设定同向）。
        let _: () = msg_send![*root, setGeometryFlipped: true];
        let _: () = msg_send![*root, setMasksToBounds: true];
        Ok(Box::new(Self {
            _view: view,
            root,
            textures: HashMap::new(),
            slots: HashMap::new(),
            order: Vec::new(),
            timer: None,
            target: None,
            slot: None,
        }))
    }

    /// 移除一个槽（若存在）：从层树摘下，随后随 StrongPtr drop 释放。
    fn detach_slot(&mut self, slot: u32) {
        if let Some(instance) = self.slots.remove(&slot) {
            unsafe {
                let _: () = msg_send![*instance.layer, removeFromSuperlayer];
            }
            self.order.retain(|existing| *existing != slot);
        }
    }
}

impl RenderSurface for MacLayerSurface {
    fn upload(&mut self, id: TextureId, texture: DecodedTexture) -> AppResult<()> {
        // 账本从不复用 id：重复上传是调用方/账本的错误，直接拒绝而不是悄悄替换。
        if self.textures.contains_key(&id) {
            return Err(AppError::Other(
                "纹理 id 重复上传（账本不应复用 id）".into(),
            ));
        }
        let image = cg_image_from_bgra(texture.width, texture.height, texture.bgra)?;
        self.textures.insert(id, CgImage(image));
        Ok(())
    }

    fn release(&mut self, id: TextureId) {
        self.textures.remove(&id);
        // 引用该纹理的槽一并移除：像素随最后一个引用一起归还，不留半引用状态。
        let stale: Vec<u32> = self
            .slots
            .iter()
            .filter(|(_, instance)| instance.texture == id)
            .map(|(slot, _)| *slot)
            .collect();
        for slot in stale {
            self.detach_slot(slot);
        }
    }

    fn present(&mut self, plan: &FramePlan) -> AppResult<()> {
        let plan_slots: Vec<u32> = plan.draws.iter().map(|draw| draw.slot).collect();
        unsafe {
            // 逐帧属性写入必须关掉隐式动画，否则 CALayer 会给每次变化插值。
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: true];

            // 1. 每个绘制槽一个层；素材换了就换 contents，没有就新建。
            for draw in &plan.draws {
                let Some(image) = self.textures.get(&draw.texture) else {
                    continue;
                };
                match self.slots.get(&draw.slot).map(|instance| instance.texture) {
                    Some(texture) if texture == draw.texture => {}
                    Some(_) => {
                        // 同一个槽换了素材：只换 contents，保持层实例（位置/尺寸本帧照写）。
                        if let Some(instance) = self.slots.get_mut(&draw.slot) {
                            let _: () = msg_send![*instance.layer, setContents: image.0];
                            instance.texture = draw.texture;
                        }
                    }
                    None => {
                        let layer: *mut Object = msg_send![class!(CALayer), alloc];
                        let layer: *mut Object = msg_send![layer, init];
                        if layer.is_null() {
                            continue;
                        }
                        let _: () = msg_send![layer, setContentsGravity: kCAGravityResize];
                        let _: () = msg_send![layer, setAnchorPoint: CGPoint { x: 0.5, y: 0.5 }];
                        let _: () = msg_send![layer, setContents: image.0];
                        let _: () = msg_send![*self.root, addSublayer: layer];
                        self.slots.insert(
                            draw.slot,
                            MacSlot {
                                layer: StrongPtr::new(layer),
                                texture: draw.texture,
                            },
                        );
                        if !self.order.contains(&draw.slot) {
                            self.order.push(draw.slot);
                        }
                    }
                }
            }

            // 2. 本帧没有的槽（层被禁用/移除）直接摘掉。
            let stale: Vec<u32> = self
                .slots
                .keys()
                .filter(|slot| !plan_slots.contains(slot))
                .copied()
                .collect();
            for slot in stale {
                self.detach_slot(slot);
            }

            // 3. 子层顺序 = z 序：全部摘下再按目标顺序挂回（确定性，不依赖移动语义）。
            if plan_slots != self.order {
                for instance in self.slots.values() {
                    let _: () = msg_send![*instance.layer, removeFromSuperlayer];
                }
                for slot in &plan_slots {
                    if let Some(instance) = self.slots.get(slot) {
                        let _: () = msg_send![*self.root, addSublayer: *instance.layer];
                    }
                }
            }

            // 4. 几何：bounds + 锚点居中的 position。
            for draw in &plan.draws {
                if !(draw.width.is_finite() && draw.height.is_finite())
                    || draw.width <= 0.0
                    || draw.height <= 0.0
                {
                    continue;
                }
                if let Some(instance) = self.slots.get(&draw.slot) {
                    let bounds = CGRect {
                        origin: CGPoint { x: 0.0, y: 0.0 },
                        size: CGSize {
                            width: draw.width,
                            height: draw.height,
                        },
                    };
                    let position = CGPoint {
                        x: draw.center_x,
                        y: draw.center_y,
                    };
                    let _: () = msg_send![*instance.layer, setBounds: bounds];
                    let _: () = msg_send![*instance.layer, setPosition: position];
                }
            }

            let _: () = msg_send![class!(CATransaction), commit];
        }
        self.order = plan_slots;
        Ok(())
    }

    fn start_ticks(&mut self, sink: Box<dyn FnMut() + Send>) -> AppResult<()> {
        // 防御性幂等：重复启动时先真的停掉旧计时器。
        let _ = self.stop_ticks();
        let Some(target_class) = ensure_tick_target_class() else {
            return Err(AppError::Other("帧计时器目标类声明失败".into()));
        };
        let slot = Box::new(TickSlot { sink });
        let target: *mut Object = unsafe { msg_send![target_class, alloc] };
        let target: *mut Object = unsafe { msg_send![target, init] };
        if target.is_null() {
            return Err(AppError::Other("帧计时器目标对象创建失败".into()));
        }
        let target = unsafe { StrongPtr::new(target) };
        unsafe {
            set_target_slot(&target, slot.as_ref() as *const TickSlot as *mut c_void);
        }
        // 注意：objc 0.2 的 msg_send! 参数不带逗号（`name: value name: value`）。
        let timer: *mut Object = unsafe {
            msg_send![
                class!(NSTimer),
                scheduledTimerWithTimeInterval: FRAME_INTERVAL_SECS
                target: *target
                selector: sel!(deskpetTick:)
                userInfo: ptr::null_mut::<Object>()
                repeats: true
            ]
        };
        if timer.is_null() {
            unsafe {
                set_target_slot(&target, ptr::null_mut::<c_void>());
            }
            return Err(AppError::Other("NSTimer 创建失败".into()));
        }
        self.timer = Some(unsafe { StrongPtr::retain(timer) });
        self.target = Some(target);
        self.slot = Some(slot);
        Ok(())
    }

    fn stop_ticks(&mut self) -> AppResult<()> {
        if let Some(timer) = self.timer.take() {
            unsafe {
                let _: () = msg_send![*timer, invalidate];
            }
            // run loop 持有计时器的引用随 invalidate 归还；我们的引用随 StrongPtr drop 归还。
        }
        // 先解除回调槽的 ivar 引用（同一线程内 invalidate 后不会再有回调，
        // 这里再兜一层：任何迟到回调读到的都是空槽），再释放目标对象与槽。
        if let Some(target) = self.target.take() {
            unsafe {
                set_target_slot(&target, ptr::null_mut::<c_void>());
            }
        }
        self.slot = None;
        Ok(())
    }
}

impl Drop for MacLayerSurface {
    fn drop(&mut self) {
        // Drop 必须发生在主线程（invalidate 与 CALayer 释放都走 AppKit）。
        if let Err(error) = self.stop_ticks() {
            rust_warn!("渲染表面释放时停表失败: {error}");
        }
        let slots: Vec<u32> = self.slots.keys().copied().collect();
        for slot in slots {
            self.detach_slot(slot);
        }
        self.order.clear();
        // 纹理（CGImage）与 _view / root 的引用由字段析构时归还。
    }
}

/// 渲染表面视图必须是翻转视图（isFlipped=true）的开工门。
///
/// `layer_draw` 的 center_y 是左上原点（y 向下）算式；普通 NSView 的 backing
/// layer 是 y 向上，挂上去会让整页合成垂直镜像且**静默**（2026-10-05 实机根因：
/// 「主窗只见背景、角色不可见」）。错误消息点名「镜像」，便于一眼定位本类问题。
fn ensure_flipped_view(is_flipped: bool) -> AppResult<()> {
    if is_flipped {
        return Ok(());
    }
    Err(AppError::Other(
        "渲染表面必须挂在翻转视图（isFlipped=true）上：非翻转视图的 backing layer 为 y 向上，layer_draw 的左上原点 y 会整页镜像"
            .into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::ensure_flipped_view;

    /// 开工门：非翻转视图即报错，且消息能指向「镜像」这一根因形态。
    #[test]
    fn 渲染表面拒绝非翻转视图() {
        let error = ensure_flipped_view(false).expect_err("非翻转视图必须被拒");
        assert!(
            error.to_string().contains("镜像"),
            "错误消息应点名镜像根因，实际: {error}"
        );
        assert!(ensure_flipped_view(true).is_ok(), "翻转视图放行");
    }
}
