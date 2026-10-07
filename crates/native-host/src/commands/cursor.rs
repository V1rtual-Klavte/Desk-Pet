// ==========================================
// 光标位置 & 弹窗位置计算 & 光标追踪
// 共享光标/屏幕检测辅助函数
//
// transport 无关的普通函数：事件出口经 [`EventSink`]、窗口增强与聚焦经
// [`WindowPort`] 显式注入；几何常量与平台增强在 `crate::window`（单一真相源），
// 本文件不复制第二份。
// ==========================================

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::error::{err, AppResult};
use crate::host::{CursorPosition, EventSink, HostEvent, WindowId, WindowPort};
use crate::rust_debug;
use crate::rust_info;
use crate::ui::state::{clamp_window_origin, ScreenRect};
#[cfg(target_os = "windows")]
use crate::window::{DPI_BASELINE, FALLBACK_SCREEN_HEIGHT, FALLBACK_SCREEN_WIDTH};
use crate::window::{MAIN_WINDOW_HEIGHT, MAIN_WINDOW_WIDTH};

/// 获取光标位置和所在屏幕信息（返回原始平台坐标，不做 Y 轴翻转）
/// Windows: (cx, cy, sx, sy, sw, sh) 全部 web 坐标系（左上原点）
/// macOS:   (cx, cy, sx, sy, sw, sh) Cocoa 坐标系（原点左下），调用方需做 Y 轴翻转
type CursorScreen = (i32, i32, i32, i32, i32, i32, f64, f64);

#[cfg(target_os = "windows")]
thread_local! {
    /// 显示器几何 + DPI 缓存（键 = `MonitorFromPoint` 的句柄）。理由见
    /// [`get_cursor_and_screen`]：每拍重算 `GetMonitorInfoW` / `GetDpiForMonitor`
    /// 会把光标推送频率压到 ~38Hz，灵动图层的跟随因此掉帧。
    static MONITOR_METRICS: std::cell::RefCell<Option<(isize, (f64, f64, i32, i32, i32, i32))>> =
        const { std::cell::RefCell::new(None) };
}

fn get_cursor_and_screen() -> AppResult<CursorScreen> {
    #[cfg(target_os = "windows")]
    // SAFETY: SetCursorPos is an atomic syscall with no memory side effects.
    // Coordinates are plain integers — no pointer or handle involved.
    unsafe {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromPoint, MONITORINFOEXW,
        };
        use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return err("无法获取光标位置");
        }
        let monitor = MonitorFromPoint(pt, 2); // MONITOR_DEFAULTTONEAREST
        // 显示器几何 + DPI **按句柄缓存**：`GetMonitorInfoW` / `GetDpiForMonitor`
        // 在本机实测每次约 10ms，16ms 的光标轮询里每拍都调会把推送频率压到 ~38Hz
        // （2026-10-07 实机：灵动图层跟随因此一顿一顿，而同帧率是 62fps）。
        // 句柄不变就复用上次结果；跨显示器时句柄变化，自然重算。
        let cached = MONITOR_METRICS.with(|cell| {
            cell.borrow()
                .filter(|(handle, _)| *handle == monitor as isize)
                .map(|(_, metrics)| metrics)
        });
        let (scale_x, scale_y, lsx, lsy, lsw, lsh) = match cached {
            Some(metrics) => metrics,
            None => {
                let mut info: MONITORINFOEXW = std::mem::zeroed();
                info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
                let (mut sx, mut sy, mut sw, mut sh) =
                    (0i32, 0i32, FALLBACK_SCREEN_WIDTH, FALLBACK_SCREEN_HEIGHT);
                if GetMonitorInfoW(monitor, &mut info as *mut _ as *mut _) != 0 {
                    let r = info.monitorInfo.rcMonitor;
                    sx = r.left;
                    sy = r.top;
                    sw = r.right - r.left;
                    sh = r.bottom - r.top;
                }
                // 获取显示器 DPI，物理像素转逻辑（web）坐标
                let mut dpi_x: u32 = DPI_BASELINE;
                let mut dpi_y: u32 = DPI_BASELINE;
                GetDpiForMonitor(monitor, 0, &mut dpi_x, &mut dpi_y);
                let scale_x = f64::from(dpi_x) / f64::from(DPI_BASELINE);
                let scale_y = f64::from(dpi_y) / f64::from(DPI_BASELINE);
                let metrics = (
                    scale_x,
                    scale_y,
                    physical_to_logical(sx, scale_x),
                    physical_to_logical(sy, scale_y),
                    physical_to_logical(sw, scale_x),
                    physical_to_logical(sh, scale_y),
                );
                MONITOR_METRICS.with(|cell| *cell.borrow_mut() = Some((monitor as isize, metrics)));
                metrics
            }
        };
        let lx = physical_to_logical(pt.x, scale_x);
        let ly = physical_to_logical(pt.y, scale_y);
        return Ok((lx, ly, lsx, lsy, lsw, lsh, scale_x, scale_y));
    }

    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        #[repr(C)]
        struct NSPoint {
            x: f64,
            y: f64,
        }
        #[repr(C)]
        struct NSSize {
            width: f64,
            height: f64,
        }
        #[repr(C)]
        struct NSRect {
            origin: NSPoint,
            size: NSSize,
        }

        let pt: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };

        // 遍历所有屏幕，找到包含光标的那个
        let screens: *mut Object = unsafe { msg_send![class!(NSScreen), screens] };
        let count: u64 = unsafe { msg_send![screens, count] };
        let mut sf: NSRect = unsafe { std::mem::zeroed() };
        for i in 0..count {
            let screen: *mut Object = unsafe { msg_send![screens, objectAtIndex: i] };
            let f: NSRect = unsafe { msg_send![screen, frame] };
            if pt.x >= f.origin.x
                && pt.x < f.origin.x + f.size.width
                && pt.y >= f.origin.y
                && pt.y < f.origin.y + f.size.height
            {
                sf = f;
                break;
            }
        }
        // fallback: 主屏幕
        if sf.size.width == 0.0 {
            let screen: *mut Object = unsafe { msg_send![class!(NSScreen), mainScreen] };
            sf = unsafe { msg_send![screen, frame] };
        }

        return Ok((
            pt.x as i32,
            pt.y as i32,
            sf.origin.x as i32,
            sf.origin.y as i32,
            sf.size.width as i32,
            sf.size.height as i32,
            1.0,
            1.0,
        ));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    compile_error!("get_cursor_and_screen: 不支持的平台");

    #[allow(unreachable_code)]
    err("无法获取光标位置")
}

/// macOS Cocoa → web Y 轴翻转
fn cocoa_to_web_y(cocoa_y: i32, screen_origin_y: i32, screen_height: i32) -> i32 {
    (screen_origin_y + screen_height) - cocoa_y
}

/// Windows 物理像素 → 逻辑（web）坐标：`物理 ÷ 缩放`，四舍五入。
///
/// 单独提取成纯函数是为了让这段换算在 macOS 上也能被单测直接盯住（Windows 分支
/// 本机编不到；`cfg(test)` 让测试目标编译它，正常 macOS 构建不产生未使用告警）。
#[cfg(any(target_os = "windows", test))]
fn physical_to_logical(value: i32, scale: f64) -> i32 {
    (f64::from(value) / scale).round() as i32
}

/// 获取光标位置和所在屏幕信息（web 坐标系：左上原点）。
///
/// 返回形状固定为 `x/y/screen_x/screen_y/screen_w/screen_h`（消费方按字段名解析），
/// 类型复用 [`CursorPosition`]，不再另立一份同字段结构。
pub fn get_cursor_position() -> AppResult<CursorPosition> {
    let (cx, cy, sx, sy, sw, sh, _scale_x, _scale_y) = get_cursor_and_screen()?;

    // Windows 已是 web 坐标，macOS 需要 Y 轴翻转
    #[cfg(target_os = "macos")]
    let web_y = cocoa_to_web_y(cy, sy, sh);
    #[cfg(target_os = "windows")]
    let web_y = cy;

    Ok(CursorPosition {
        x: cx,
        y: web_y,
        screen_x: sx,
        screen_y: sy,
        screen_w: sw,
        screen_h: sh,
    })
}

// ==========================================
// PopupPosition (用于快捷键弹出位置计算)
// ==========================================

#[derive(Clone, Serialize)]
pub struct PopupPosition {
    pub win_x: i32,
    pub win_y: i32,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub scale_x: f64,
    pub scale_y: f64,
}

/// 计算快捷键弹窗的落点（光标居中，clamp 到屏幕边缘）。
///
/// 计算前先把主窗口增强回 iTerm 风格并聚焦：主窗口不存在（E2E 宿主只有 e2e 窗口）
/// 时保持跳过语义 —— 位置照常计算，失败留痕在 debug 级别。
pub fn compute_popup_position(
    port: &dyn WindowPort,
    win_w: i32,
    win_h: i32,
) -> AppResult<PopupPosition> {
    let (win_w, win_h) = popup_window_size(win_w, win_h);

    // ── iTerm 风格增强 + 显示窗口 ──
    if let Err(error) = crate::window::main_win::enhance_to_iterm_style(port) {
        rust_debug!("快捷键弹出前主窗口增强跳过: {error}");
    }
    if let Err(error) = port.focus(WindowId::Main) {
        rust_debug!("快捷键弹出前主窗口聚焦跳过: {error}");
    }

    popup_position_at_cursor(win_w, win_h)
}

/// 原生窗口过程已经持有主窗状态时，只采样并计算几何。
/// 窗口增强由该调用方使用已持有的句柄完成，避免回到 WindowPort 再借 UI。
pub(crate) fn popup_position_at_cursor(win_w: i32, win_h: i32) -> AppResult<PopupPosition> {
    let (win_w, win_h) = popup_window_size(win_w, win_h);

    let (cx, cy, sx, sy, sw, sh, scale_x, scale_y) = get_cursor_and_screen()?;

    // ── Cocoa → web 坐标转换（Y 轴翻转） ──
    #[cfg(target_os = "macos")]
    let web_cy = cocoa_to_web_y(cy, sy, sh);
    #[cfg(target_os = "windows")]
    let web_cy = cy;

    // ── 窗口位置：光标居中，clamp 到屏幕边缘 ──
    let web_cx = cx;
    let (win_x, win_y) = popup_origin(
        web_cx,
        web_cy,
        win_w,
        win_h,
        ScreenRect {
            x: f64::from(sx),
            y: f64::from(sy),
            w: f64::from(sw),
            h: f64::from(sh),
        },
    );

    Ok(PopupPosition {
        win_x,
        win_y,
        cursor_x: web_cx,
        cursor_y: web_cy,
        scale_x,
        scale_y,
    })
}

/// 弹窗窗口尺寸：非正值回落到主窗口默认内尺寸（常量与窗口创建同源）。
fn popup_window_size(win_w: i32, win_h: i32) -> (i32, i32) {
    (
        if win_w > 0 {
            win_w
        } else {
            MAIN_WINDOW_WIDTH as i32
        },
        if win_h > 0 {
            win_h
        } else {
            MAIN_WINDOW_HEIGHT as i32
        },
    )
}

/// 光标居中的弹窗左上角，clamp 到所在屏幕。
///
/// clamp 段唯一定义点是 `ui::state::clamp_window_origin`（含 min>max 兜底与跨屏边界
/// 测试）；这里只产生「光标居中」的起点。整数输入转 f64 是精确转换，结果与旧公式逐值
/// 相同；窗口大于屏幕的退化情形由兜底返回屏幕原点（旧 std clamp 在该情形会 panic）。
/// 屏幕原点可以是负数（台面左侧/上方显示器），clamp 仍以该屏矩形为界、不跨屏。
fn popup_origin(
    web_cx: i32,
    web_cy: i32,
    win_w: i32,
    win_h: i32,
    screen: ScreenRect,
) -> (i32, i32) {
    let (x, y) = clamp_window_origin(
        ((web_cx - win_w / 2) as f64, (web_cy - win_h / 2) as f64),
        (f64::from(win_w), f64::from(win_h)),
        screen,
    );
    (x as i32, y as i32)
}

// ==========================================
// 光标追踪 — 后台线程 ~60fps 推送光标坐标
// ==========================================

/// 轮询间隔：光标静止时也按这个节奏醒来，用来发现「开始移动」。
///
/// 2026-09-20 实测空闲成本（macOS，release，复刻程序 90s × 2 轮）：
/// 线程总 CPU ≈ 0.13% 单核（~1.2 ms/s、52 次唤醒/秒）；其中循环体（取光标 + 枚举屏幕）
/// 线程 CPU ~11 µs/tick，纯 sleep 对照 13.5 µs/次 —— 成本主要是唤醒节奏本身，
/// 而热态背靠背微基准整次取用仅 175 ns，乘法/取值本身可以忽略。
/// 60s 运行 RSS 持平（线程无 autorelease pool 也不累积），光标静止时不 emit（零前端流量）。
/// 结论：维持 16ms —— 降频等于按比例砍跟随刷新率（useParallax 零惯性直接映射，会看出台阶），
/// 换 0.1% 单核不划算；条件启停需在 Rust 侧新增 effectMode / 可见性门控与唤醒路径，
/// 漏唤醒会让跟随失效到重启，风险大于收益。
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(16);

/// 启动光标追踪线程，光标位置**发生变化时**派发 [`HostEvent::CursorMoved`]。
///
/// 早先每 16ms 无条件 emit 一次并逐帧写 debug 日志：日志在 dev 下约 23MB/小时，
/// 而日志轮转上限只有 15MB，大约 12 分钟就把整个有效日志窗口冲掉。
/// 现在去掉了逐帧日志，并且只在坐标真的变了（或首帧）时才发事件 ——
/// 光标不动时前端本来也不需要收到通知。
pub fn spawn_cursor_tracker(sink: Arc<dyn EventSink>) {
    thread::spawn(move || {
        rust_info!("光标追踪线程已启动 (~60fps 轮询，仅变化时派发)");
        let mut last: Option<(i32, i32, i32, i32, i32, i32)> = None;
        loop {
            // 获取光标位置（复用已有逻辑）
            let pos = get_cursor_and_screen();
            if let Ok((cx, cy, _sx, _sy, _sw, _sh, _scx, _scy)) = pos {
                #[cfg(target_os = "macos")]
                let web_y = cocoa_to_web_y(cy, _sy, _sh);
                #[cfg(target_os = "windows")]
                let web_y = cy;

                let current = (cx, web_y, _sx, _sy, _sw, _sh);
                // 首帧必须派发：否则应用启动后光标一直不动，前端永远收不到初始位置
                if last != Some(current) {
                    last = Some(current);
                    sink.emit(HostEvent::CursorMoved(CursorPosition {
                        x: cx,
                        y: web_y,
                        screen_x: _sx,
                        screen_y: _sy,
                        screen_w: _sw,
                        screen_h: _sh,
                    }));
                }
            }
            thread::sleep(CURSOR_POLL_INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: i32, y: i32, w: i32, h: i32) -> ScreenRect {
        ScreenRect {
            x: f64::from(x),
            y: f64::from(y),
            w: f64::from(w),
            h: f64::from(h),
        }
    }

    #[test]
    fn 弹窗尺寸非正值回落主窗口默认() {
        assert_eq!(popup_window_size(0, 0), (730, 450));
        // 单轴非正只回落该轴，另一轴原样透传。
        assert_eq!(popup_window_size(-4, 300), (730, 300));
        assert_eq!(popup_window_size(600, -1), (600, 450));
        assert_eq!(popup_window_size(600, 300), (600, 300));
    }

    #[test]
    fn 弹窗原点光标居中且不越出单屏() {
        // 光标居中：原点 = 光标 - 窗口一半（整数除法向下取整）。
        assert_eq!(
            popup_origin(960, 540, 730, 450, screen(0, 0, 1920, 1080)),
            (595, 315)
        );
        // 右/下边缘：夹回屏内，不把窗口推出屏幕。
        assert_eq!(
            popup_origin(1900, 1070, 730, 450, screen(0, 0, 1920, 1080)),
            (1190, 630)
        );
        // 左/上边缘：夹到屏幕原点。
        assert_eq!(
            popup_origin(10, 5, 730, 450, screen(0, 0, 1920, 1080)),
            (0, 0)
        );
    }

    #[test]
    fn 左侧屏负原点下弹窗夹取不跨屏() {
        // 台面左侧屏（原点 x = -1920）：可用区间是 [-1920, -730]，弹窗必须留在本屏。
        let left = screen(-1920, 0, 1920, 1080);
        assert_eq!(popup_origin(-960, 540, 730, 450, left), (-1325, 315));
        // 靠近本屏右缘（邻近主屏）也不能越过本屏的右边界。
        assert_eq!(popup_origin(-10, 1000, 730, 450, left), (-730, 630));
        // 靠近本屏左缘夹到本屏原点。
        assert_eq!(popup_origin(-1915, 540, 730, 450, left), (-1920, 315));

        // 负 y 原点（主屏下方的显示器）：区间是 [-1080, -450]，夹到该屏上边界。
        let below = screen(0, -1080, 1920, 1080);
        assert_eq!(popup_origin(960, -1000, 730, 450, below), (595, -1080));
    }

    #[test]
    fn 窗口大于屏幕时回落屏幕原点不panic() {
        // 退化情形：clamp 区间 min>max，唯一定义点 `clamp_window_origin` 兜底返回屏幕原点。
        assert_eq!(
            popup_origin(500, 300, 3000, 2000, screen(100, 50, 1920, 1080)),
            (100, 50)
        );
    }

    #[test]
    fn cocoa坐标按屏幕底边翻转为web坐标() {
        // web_y = 屏底（origin + height） - cocoa_y。
        assert_eq!(cocoa_to_web_y(100, 0, 1080), 980);
        assert_eq!(cocoa_to_web_y(1080, 0, 1080), 0);
        // 负原点的屏幕（主屏下方）同样按自身底边翻转。
        assert_eq!(cocoa_to_web_y(50, -1080, 1080), -50);
    }

    #[test]
    fn 物理像素按dpi缩放换算为逻辑坐标() {
        // scale=1.0 原样；scale>1 缩小；结果为四舍五入（不是截断）。
        assert_eq!(physical_to_logical(150, 1.5), 100);
        assert_eq!(physical_to_logical(144, 1.5), 96);
        assert_eq!(physical_to_logical(192, 2.0), 96);
        assert_eq!(
            physical_to_logical(-150, 1.5),
            -100,
            "负坐标（左侧屏）同样按比例换算"
        );
        assert_eq!(physical_to_logical(10, 3.0), 3);
        assert_eq!(physical_to_logical(11, 3.0), 4);
    }
}
