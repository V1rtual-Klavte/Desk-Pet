//! Windows 平台表面：`WS_EX_LAYERED` + `UpdateLayeredWindow` 五层合成 + `SetTimer` 帧循环。
//!
//! 做法照搬 W0 探针的 Windows 渲染原型（`crates/ui-probe`，已随迁移完成删除）：
//! 每帧用 GDI `AlphaBlend`
//! （AC_SRC_ALPHA，预乘 BGRA）把五层素材按帧计划合成到一块 32bpp DIB，再
//! `UpdateLayeredWindow` 整帧提交。几何来自同一冻结几何核，不另写数学。
//!
//! 帧计时器挂在本模块自己的消息窗（`HWND_MESSAGE`）上，和 W0 探针把 timer 挂主窗
//! 不同：这样 W5 的消息循环照常 `DispatchMessage` 即可，不需要认识本模块的定时器 id；
//! 停止 = `KillTimer` + 运行标志置假，**即使队列里残留一条 WM_TIMER 也不会回调**
//! （「隐藏后零帧回调」的硬保证）。
//!
//! **未在 Windows 实机验证**：本机（macOS）只做类型检查；W0 探针的 Windows 侧同样
//! 只有类型检查，没有实机运行记录。交付按未验证处理。
//!
//! 线程约束：目标窗口句柄、消息窗与 DIB 都只在创建线程（W5 的 UI 线程）使用；本类型的
//! 构造、所有方法调用与 Drop 都必须在同一线程。`unsafe impl Send` 的依据同 macOS 侧：
//! `Renderer` 的互斥锁只在计时器消息窗所在线程获取。

use std::collections::HashMap;
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    AlphaBlend, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION,
    DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
    GetWindowRect, KillTimer, RegisterClassW, SetTimer, SetWindowLongPtrW, UpdateLayeredWindow,
    GWLP_USERDATA, HWND_MESSAGE, ULW_ALPHA, WM_TIMER, WNDCLASSW,
};

use crate::error::{AppError, AppResult};

use super::compose::FramePlan;
use super::surface::{RenderSurface, TickSlot};
use super::texture::{DecodedTexture, TextureId};

/// 本模块消息窗的类名与帧计时器 id（id 在消息窗内唯一，不与 W5 的窗口冲突）。
const SURFACE_CLASS: &str = "DeskPetLayerSurfaceW";
const FRAME_TIMER_ID: usize = 1;
/// 16ms ≈ 60Hz，与 W0 探针的帧计时器同口径。
const FRAME_INTERVAL_MS: u32 = 16;

// ── DIB：32bpp 顶朝下、BGRA（预乘），AlphaBlend 与 UpdateLayeredWindow 共用 ──

struct Dib {
    hdc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    bits: *mut u8,
    width: i32,
    height: i32,
    byte_len: usize,
}

impl Dib {
    fn new(width: i32, height: i32) -> Option<Dib> {
        if width <= 0 || height <= 0 {
            return None;
        }
        unsafe {
            let hdc = CreateCompatibleDC(0);
            if hdc == 0 {
                return None;
            }
            // windows-sys 0.52 的 BITMAPINFO/BITMAPINFOHEADER 没有 Default：用 zeroed 起手。
            let mut header: BITMAPINFO = std::mem::zeroed();
            header.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // 负数 = 顶朝下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let mut bits: *mut std::ffi::c_void = ptr::null_mut();
            let bitmap = CreateDIBSection(hdc, &mut header, DIB_RGB_COLORS, &mut bits, 0, 0);
            if bitmap == 0 || bits.is_null() {
                DeleteDC(hdc);
                return None;
            }
            let old = SelectObject(hdc, bitmap);
            let byte_len = width as usize * height as usize * 4;
            // 清零 = 全透明黑
            ptr::write_bytes(bits as *mut u8, 0, byte_len);
            Some(Dib {
                hdc,
                bitmap,
                old,
                bits: bits as *mut u8,
                width,
                height,
                byte_len,
            })
        }
    }

    /// 从预乘 BGRA 缓冲填充（长度必须匹配调用方保证；这里取最小长度防御）。
    fn fill(&mut self, bgra: &[u8]) {
        let n = self.byte_len.min(bgra.len());
        unsafe {
            ptr::copy_nonoverlapping(bgra.as_ptr(), self.bits, n);
        }
    }

    fn clear(&mut self) {
        unsafe {
            ptr::write_bytes(self.bits, 0, self.byte_len);
        }
    }
}

impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.hdc, self.old);
            DeleteObject(self.bitmap);
            DeleteDC(self.hdc);
        }
    }
}

// ── 表面 ──

pub struct WinLayerSurface {
    /// W5 的透明主窗（必须已设置 WS_EX_LAYERED）。
    target: HWND,
    /// 本模块的消息窗（只收 WM_TIMER；由 W5 的消息循环 DispatchMessage 派发）。
    message_window: HWND,
    /// 整帧合成 DIB；窗口客户区尺寸变化时重建。
    frame: Option<Dib>,
    textures: HashMap<TextureId, Dib>,
    slot: Option<Box<TickSlot>>,
    slot_ptr: *mut TickSlot,
    ticks_running: bool,
}

// 句柄与 DIB 像素指针只在创建线程（W5 UI 线程）使用；见模块头线程约束。
unsafe impl Send for WinLayerSurface {}

unsafe extern "system" fn surface_wndproc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_TIMER && wparam == FRAME_TIMER_ID {
        // 只把裸指针读成局部值，不在 sink 调用期间持有表面的引用：
        // sink 会经 Renderer 的锁重新可变访问同一表面（present），重叠借用是别名冲突。
        // 目标对象释放前会把 GWLP_USERDATA 清零，残留消息只会命中空指针。
        let surface = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WinLayerSurface;
        if !surface.is_null() {
            let running = (*surface).ticks_running;
            let slot = (*surface).slot_ptr;
            if running && !slot.is_null() {
                ((*slot).sink)();
            }
        }
        return 0;
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    unsafe {
        GetClientRect(hwnd, &mut rect);
    }
    (rect.right - rect.left, rect.bottom - rect.top)
}

impl WinLayerSurface {
    /// 为给定的分层窗口建表面与帧计时器消息窗。
    ///
    /// # Safety
    /// `target_window` 必须是调用线程上有效、已设置 `WS_EX_LAYERED` 的顶层窗口句柄。
    pub unsafe fn new(target_window: HWND) -> AppResult<Box<Self>> {
        if target_window == 0 {
            return Err(AppError::Other("渲染表面需要有效的窗口句柄".into()));
        }
        let mut surface = Box::new(Self {
            target: target_window,
            message_window: 0,
            frame: None,
            textures: HashMap::new(),
            slot: None,
            slot_ptr: ptr::null_mut(),
            ticks_running: false,
        });

        let module = GetModuleHandleW(ptr::null());
        let class_name: Vec<u16> = SURFACE_CLASS
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(surface_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: module,
            hIcon: 0,
            hCursor: 0,
            hbrBackground: 0,
            lpszMenuName: ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        // 类已存在时 RegisterClassW 也返回 0；真实结论由 CreateWindowExW 给出。
        RegisterClassW(&window_class);
        let message_window = CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            0,
            module,
            ptr::null(),
        );
        if message_window == 0 {
            return Err(AppError::Other("渲染消息窗创建失败".into()));
        }
        SetWindowLongPtrW(
            message_window,
            GWLP_USERDATA,
            &mut *surface as *mut WinLayerSurface as isize,
        );
        surface.message_window = message_window;
        Ok(surface)
    }
}

impl RenderSurface for WinLayerSurface {
    fn upload(&mut self, id: TextureId, texture: DecodedTexture) -> AppResult<()> {
        // 账本从不复用 id：重复上传是调用方/账本的错误，直接拒绝而不是悄悄替换。
        if self.textures.contains_key(&id) {
            return Err(AppError::Other(
                "纹理 id 重复上传（账本不应复用 id）".into(),
            ));
        }
        let dib = Dib::new(texture.width as i32, texture.height as i32)
            .ok_or_else(|| AppError::Other("纹理 DIB 创建失败".into()))?;
        let mut dib = dib;
        dib.fill(&texture.bgra);
        // texture.bgra 在本函数结束随 DecodedTexture 释放：平台纹理（DIB）已是唯一副本。
        self.textures.insert(id, dib);
        Ok(())
    }

    fn release(&mut self, id: TextureId) {
        // Dib 的 Drop 归还 GDI 对象。
        self.textures.remove(&id);
    }

    fn present(&mut self, plan: &FramePlan) -> AppResult<()> {
        let (client_w, client_h) = client_size(self.target);
        if client_w <= 0 || client_h <= 0 {
            // 窗口还没就绪：不提交任何内容，也不算失败。
            return Ok(());
        }
        if self.frame.as_ref().map(|dib| (dib.width, dib.height)) != Some((client_w, client_h)) {
            self.frame = Some(
                Dib::new(client_w, client_h)
                    .ok_or_else(|| AppError::Other("合成 DIB 创建失败".into()))?,
            );
        }
        let frame = self.frame.as_mut().expect("上方分支刚保证存在");
        frame.clear();

        // 帧计划是逻辑像素；目标窗口客户区是物理像素，按比值换算（跨 DPI 由 W5 提供
        // 逻辑尺寸；两值未就绪时按 1:1 处理）。
        let sx = if plan.window.width > 0.0 {
            client_w as f64 / plan.window.width
        } else {
            1.0
        };
        let sy = if plan.window.height > 0.0 {
            client_h as f64 / plan.window.height
        } else {
            1.0
        };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        for draw in &plan.draws {
            let Some(texture) = self.textures.get(&draw.texture) else {
                continue;
            };
            let dest_w = (draw.width * sx).round() as i32;
            let dest_h = (draw.height * sy).round() as i32;
            if dest_w <= 0 || dest_h <= 0 {
                continue;
            }
            // 与探针同一个整数化口径：中心取整后按目标尺寸半宽半高回推左上角。
            let dest_x = (draw.center_x * sx).round() as i32 - dest_w / 2;
            let dest_y = (draw.center_y * sy).round() as i32 - dest_h / 2;
            unsafe {
                AlphaBlend(
                    frame.hdc,
                    dest_x,
                    dest_y,
                    dest_w,
                    dest_h,
                    texture.hdc,
                    0,
                    0,
                    texture.width,
                    texture.height,
                    blend,
                );
            }
        }

        let mut window_rect: RECT = unsafe { std::mem::zeroed() };
        unsafe {
            GetWindowRect(self.target, &mut window_rect);
        }
        let screen = unsafe { GetDC(0) };
        let size = SIZE {
            cx: client_w,
            cy: client_h,
        };
        let dst = POINT {
            x: window_rect.left,
            y: window_rect.top,
        };
        let src = POINT { x: 0, y: 0 };
        let updated = unsafe {
            UpdateLayeredWindow(
                self.target,
                screen,
                &dst,
                &size,
                frame.hdc,
                &src,
                0,
                &blend,
                ULW_ALPHA,
            )
        };
        unsafe {
            ReleaseDC(0, screen);
        }
        if updated == 0 {
            return Err(AppError::Other(
                "UpdateLayeredWindow 提交失败（窗口需带 WS_EX_LAYERED）".into(),
            ));
        }
        Ok(())
    }

    fn start_ticks(&mut self, sink: Box<dyn FnMut() + Send>) -> AppResult<()> {
        // 防御性幂等：重复启动时先停掉旧计时器。
        let _ = self.stop_ticks();
        let mut slot = Box::new(TickSlot { sink });
        self.slot_ptr = &mut *slot as *mut TickSlot;
        self.slot = Some(slot);
        let timer =
            unsafe { SetTimer(self.message_window, FRAME_TIMER_ID, FRAME_INTERVAL_MS, None) };
        if timer == 0 {
            self.slot_ptr = ptr::null_mut();
            self.slot = None;
            return Err(AppError::Other("帧计时器创建失败".into()));
        }
        self.ticks_running = true;
        Ok(())
    }

    fn stop_ticks(&mut self) -> AppResult<()> {
        if self.message_window != 0 {
            unsafe {
                KillTimer(self.message_window, FRAME_TIMER_ID);
            }
        }
        // 先灭运行标志再摘槽：即使队列里已有一条 WM_TIMER，wndproc 也会直接跳过。
        self.ticks_running = false;
        self.slot_ptr = ptr::null_mut();
        self.slot = None;
        Ok(())
    }
}

impl Drop for WinLayerSurface {
    fn drop(&mut self) {
        // Drop 必须在创建线程（W5 UI 线程）：DestroyWindow 与 GDI 对象都要求同线程。
        let _ = self.stop_ticks();
        if self.message_window != 0 {
            unsafe {
                // 先断掉 user data，残留消息不会命中即将释放的 surface。
                SetWindowLongPtrW(self.message_window, GWLP_USERDATA, 0);
                DestroyWindow(self.message_window);
            }
            self.message_window = 0;
        }
        self.frame = None;
        self.textures.clear();
    }
}
