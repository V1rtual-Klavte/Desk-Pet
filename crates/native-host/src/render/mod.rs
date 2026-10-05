//! 角色舞台的绘制域：几何核（W0 冻结）+ 纹理生命周期 + 帧循环 + 平台表面。
//!
//! 分工（执行契约 §6.1/§6.2）：
//! - [`geometry`] 是 W0 冻结的纯函数几何核，渲染器与图层编辑器**共用**，不得另写一份；
//! - [`Renderer`] 是平台无关的编排层：接收「层列表 + 窗口几何 + 光标」三样输入，
//!   算出帧计划（[`compose`]），驱动纹理账目（[`texture`]）与帧循环（[`frame_loop`]）；
//! - [`surface::RenderSurface`] 是平台唯一接缝：[`mac`]（CALayer + NSTimer）与
//!   [`win`]（WS_EX_LAYERED + UpdateLayeredWindow + SetTimer）各自实现它。
//!
//! 与 W5 状态机（`visible -> retracting -> hidden -> revealing -> visible`）的边界：
//! W5 决定动画时序，仅调用 [`Renderer::start_frames`] / [`Renderer::stop_frames`]；
//! 「隐藏后零帧回调」由渲染侧保证 —— 停止 = 真的取消平台计时器，且停止后到达的
//! 任何 tick 都会被 [`frame_loop::FrameLoop`] 拒绝（计入 `rejected_ticks`，应为 0）。
//!
//! 角色舞台与编辑器预览共用本模块：两者各自构造一个 [`Renderer`] + 平台表面，
//! 走同一几何、同一纹理语义；编辑器由 W9 实现，不需要在这里写死主窗路径。
//!
//! 本模块**不实现**景深与滤镜（`shadow` / `brightness` / `contrast` / `saturate`），
//! 也不为它们保留参数位。

pub mod compose;
pub mod frame_loop;
pub mod geometry;
#[cfg(target_os = "macos")]
pub mod mac;
pub mod surface;
pub mod texture;
#[cfg(windows)]
pub mod win;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::AppResult;
use crate::{rust_debug, rust_warn};

use compose::FramePlan;
use frame_loop::{FrameLoop, LoopTransition};
use geometry::{CursorPosition, LayerGeometryInput, WindowGeometry};
use surface::RenderSurface;
use texture::TextureLedger;

/// 帧循环频率：60Hz（与 W0 探针、基线 60fps 一致）。
pub const FRAME_INTERVAL_SECS: f64 = 1.0 / 60.0;

/// 单层输入。顺序即 z 序（索引 0 最先绘制 = 最底层，与几何核的输入顺序约定一致）。
#[derive(Debug, Clone, PartialEq)]
pub struct LayerSpec {
    /// 素材文件路径。由调用方（Profile loader / 编辑器）提供；渲染器解码前仍会过
    /// [`crate::paths::AppPaths::validate_file_path`] 的既有校验，不自建第二份路径规则。
    pub path: PathBuf,
    pub enabled: bool,
    pub sensitivity: f64,
    pub scale: f64,
    pub offset_x_percent: f64,
    pub offset_y_percent: f64,
}

impl LayerSpec {
    /// 几何核输入（渲染器每帧用它跑 `scene_transforms`）。
    pub fn geometry_input(&self) -> LayerGeometryInput {
        LayerGeometryInput {
            enabled: self.enabled,
            sensitivity: self.sensitivity,
            scale: self.scale,
            offset_x_percent: self.offset_x_percent,
            offset_y_percent: self.offset_y_percent,
        }
    }
}

/// 渲染计数快照（诊断与测试用；数字口径见各字段注释）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RendererStats {
    /// 帧循环运行期被接受的 tick 数（= 按帧循环呈现的帧数）。
    pub frames: u64,
    /// [`Renderer::render_now`] 呈现的帧数（编辑器拖动预览等非循环路径）。
    pub forced_frames: u64,
    /// 停止状态下到达的 tick 数。正确集成（计时器真的停）时必须为 0。
    pub rejected_ticks: u64,
    /// 成功启动帧循环的次数。
    pub starts: u64,
    /// 成功停止帧循环的次数。
    pub stops: u64,
    /// 平台 present 失败次数（网络/窗口未就绪等由调用方排查）。
    pub present_errors: u64,
    /// 当前驻留纹理数（释放后归零）。
    pub resident_textures: usize,
    /// 当前驻留像素字节（账目口径）。
    pub resident_bytes: usize,
    /// 帧循环当前是否运行。
    pub running: bool,
}

struct SceneState {
    /// 灵动总开关（`appearance.effectMode` 门控；关闭时位移归零、缩放照旧）。
    enabled: bool,
    /// 窗口是否可见（隐藏期由 W5 置 false；收起动画结束后 W5 应停止帧循环）。
    visible: bool,
    intensity: f64,
    popup_width: f64,
    window: WindowGeometry,
    cursor: Option<CursorPosition>,
}

impl Default for SceneState {
    fn default() -> Self {
        Self {
            enabled: true,
            visible: true,
            intensity: 1.0,
            popup_width: geometry::DEFAULT_POPUP_WIDTH,
            window: WindowGeometry {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            cursor: None,
        }
    }
}

/// 平台无关的渲染核心。计时器闭包通过 `Weak<Mutex<RendererCore>>` 到达它 ——
/// 不持有指向 `Renderer` 自身的指针，因此 `Renderer` 可以自由移动/装箱。
struct RendererCore {
    surface: Box<dyn RenderSurface>,
    ledger: TextureLedger,
    layers: Vec<LayerSpec>,
    scene: SceneState,
    frames: FrameLoop,
    stats: PresentStats,
}

#[derive(Default)]
struct PresentStats {
    forced_frames: u64,
    starts: u64,
    stops: u64,
    present_errors: u64,
}

impl RendererCore {
    /// 一次 tick：帧循环未运行时**不产生任何帧**（第二道防线；第一道是平台计时器已取消）。
    fn tick(&mut self) {
        if !self.frames.accept_tick() {
            return;
        }
        if let Err(error) = self.present(false) {
            self.report_present_error(&error);
        }
    }

    /// 按当前输入组装帧计划：层顺序 = z 序；禁用层与解码失败的层不在计划里。
    fn build_plan(&self) -> FramePlan {
        let scene = geometry::SceneInput {
            enabled: self.scene.enabled,
            visible: self.scene.visible,
            intensity: self.scene.intensity,
            window: self.scene.window,
            popup_width: self.scene.popup_width,
            cursor: self.scene.cursor,
        };
        let inputs: Vec<LayerGeometryInput> =
            self.layers.iter().map(LayerSpec::geometry_input).collect();
        let transforms = geometry::scene_transforms(&scene, &inputs);
        compose::frame_plan(
            &scene.window,
            self.layers.iter().zip(transforms.iter()).enumerate().map(
                |(slot, (layer, transform))| {
                    let texture = if layer.enabled {
                        let key = texture::texture_key(&layer.path);
                        self.ledger
                            .lookup(&key)
                            .map(|entry| (entry.id, entry.width, entry.height))
                    } else {
                        None
                    };
                    (slot as u32, transform, texture)
                },
            ),
        )
    }

    fn present(&mut self, forced: bool) -> AppResult<()> {
        let plan = self.build_plan();
        match self.surface.present(&plan) {
            Ok(()) => {
                if forced {
                    self.stats.forced_frames += 1;
                }
                Ok(())
            }
            Err(error) => {
                self.stats.present_errors += 1;
                Err(error)
            }
        }
    }

    fn report_present_error(&self, error: &crate::error::AppError) {
        // 60Hz 失败会刷屏：只记第一次与每 300 次，其余靠 present_errors 计数收敛。
        let count = self.stats.present_errors;
        if count == 1 || count % 300 == 0 {
            rust_warn!("渲染呈现失败（第 {count} 次）: {error}");
        }
    }
}

/// 角色舞台 / 编辑器预览的渲染器。
///
/// 线程约束跟随平台表面（macOS 为 AppKit 主线程）；所有方法内部经一把互斥锁访问核心，
/// 帧计时器回调也走同一把锁 —— 计时器与调用方在同一线程时锁无竞争。
pub struct Renderer {
    core: Arc<Mutex<RendererCore>>,
}

impl Renderer {
    pub fn new(surface: Box<dyn RenderSurface>) -> Self {
        Self {
            core: Arc::new(Mutex::new(RendererCore {
                surface,
                ledger: TextureLedger::new(),
                layers: Vec::new(),
                scene: SceneState::default(),
                frames: FrameLoop::default(),
                stats: PresentStats::default(),
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, RendererCore> {
        self.core.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// 收敛到新的层列表（Profile 切换/编辑器改动都走这里）：
    /// 新素材上传、仍被引用的复用、无人引用的释放。失败项在返回报告里如实列出，
    /// 该层本轮不绘制，但不影响其它层。
    pub fn set_layers(&mut self, layers: Vec<LayerSpec>) -> texture::ReconcileReport {
        let mut core = self.lock();
        let report = {
            let RendererCore {
                ledger, surface, ..
            } = &mut *core;
            let mut decode = texture::decode_asset;
            ledger.reconcile(&layers, surface.as_mut(), &mut decode)
        };
        core.layers = layers;
        for failure in &report.failures {
            rust_warn!(
                "图层素材未加载（本轮不绘制）: {} → {}",
                failure.path.display(),
                failure.error
            );
        }
        rust_debug!(
            "渲染层收敛: uploaded={} reused={} released={} failures={}",
            report.uploaded,
            report.reused,
            report.released,
            report.failures.len()
        );
        report
    }

    /// 灵动总开关（`appearance.effectMode` 门控）。
    pub fn set_enabled(&mut self, enabled: bool) {
        self.lock().scene.enabled = enabled;
    }

    /// 窗口可见性（收起/隐藏期由 W5 置 false）。
    pub fn set_visible(&mut self, visible: bool) {
        self.lock().scene.visible = visible;
    }

    /// 灵动强度（`appearance` 配置项）。
    pub fn set_intensity(&mut self, intensity: f64) {
        self.lock().scene.intensity = intensity;
    }

    /// 位移归一化基准（`appearance.popupSize.w`；0/NaN 由几何核回落到默认值）。
    pub fn set_popup_width(&mut self, popup_width: f64) {
        self.lock().scene.popup_width = popup_width;
    }

    /// 窗口几何（屏幕坐标，逻辑像素，左上原点，与光标同一坐标系）。
    pub fn set_window_geometry(&mut self, window: WindowGeometry) {
        self.lock().scene.window = window;
    }

    /// 全局光标（`None` = 未知/隐藏，位移归零但深度缩放照旧）。
    pub fn set_cursor(&mut self, cursor: Option<CursorPosition>) {
        self.lock().scene.cursor = cursor;
    }

    /// 启动帧循环（W5 在呼出/显示时调用）。真实启动平台计时器，并立即呈现首帧。
    /// 重复调用是边沿触发的 no-op。
    pub fn start_frames(&mut self) -> AppResult<()> {
        let mut core = self.lock();
        if core.frames.set_running(true) != LoopTransition::Started {
            return Ok(());
        }
        // 回调只持 Weak：Renderer 释放后计时器即使还在（不应发生），也不会访问已释放的核心。
        let weak = Arc::downgrade(&self.core);
        let sink: Box<dyn FnMut() + Send> = Box::new(move || {
            let Some(core) = weak.upgrade() else {
                return;
            };
            let mut core = core.lock().unwrap_or_else(|error| error.into_inner());
            core.tick();
        });
        if let Err(error) = core.surface.start_ticks(sink) {
            // 平台启动失败：回退状态机，不留「说在跑但没有计时器」的悬空状态。
            core.frames.set_running(false);
            return Err(error);
        }
        core.stats.starts += 1;
        core.tick();
        Ok(())
    }

    /// 停止帧循环（W5 在收起动画终点/隐藏时调用）。返回后平台不得再投递任何回调。
    /// 重复调用是边沿触发的 no-op。
    pub fn stop_frames(&mut self) -> AppResult<()> {
        let mut core = self.lock();
        if core.frames.set_running(false) != LoopTransition::Stopped {
            return Ok(());
        }
        core.surface.stop_ticks()?;
        core.stats.stops += 1;
        Ok(())
    }

    /// 平台计时器回调入口（平台后端内部使用；也可供外部驱动器手工步进）。
    /// 帧循环未运行时拒绝且不呈现任何帧。
    pub fn tick(&mut self) {
        self.lock().tick();
    }

    /// 立即呈现一帧，与帧循环状态无关。供编辑器拖动预览等事件驱动路径使用；
    /// **隐藏期不得调用**（不得绕过「停止绘制」的约定）。
    pub fn render_now(&mut self) -> AppResult<()> {
        self.lock().present(true)
    }

    pub fn frames_running(&self) -> bool {
        self.lock().frames.is_running()
    }

    pub fn stats(&self) -> RendererStats {
        let core = self.lock();
        RendererStats {
            frames: core.frames.ticks(),
            forced_frames: core.stats.forced_frames,
            rejected_ticks: core.frames.rejected_ticks(),
            starts: core.stats.starts,
            stops: core.stats.stops,
            present_errors: core.stats.present_errors,
            resident_textures: core.ledger.resident_count(),
            resident_bytes: core.ledger.resident_bytes(),
            running: core.frames.is_running(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::texture::TextureId;
    use std::sync::Mutex as StdMutex;

    /// 内联 fixture：仓库现成的小 PNG（随默认 Profile 发布的图层素材）。
    const FIXTURE_PNG: &[u8] =
        include_bytes!("../../../../resources/defaults/profiles/sugar-pink/materials/L2/body.png");

    /// 把 fixture 落成临时文件（路径校验要求文件真实存在）。
    fn temp_png(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "deskpet-render-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("layer.png");
        std::fs::write(&path, FIXTURE_PNG).unwrap();
        path
    }

    fn spec(path: &std::path::Path, enabled: bool) -> LayerSpec {
        LayerSpec {
            path: path.to_path_buf(),
            enabled,
            sensitivity: 0.8,
            scale: 1.0,
            offset_x_percent: 0.0,
            offset_y_percent: 0.0,
        }
    }

    fn window() -> WindowGeometry {
        WindowGeometry {
            x: 100.0,
            y: 200.0,
            width: 730.0,
            height: 450.0,
        }
    }

    #[derive(Default)]
    struct FakeShared {
        uploads: Vec<(TextureId, u32, u32)>,
        releases: Vec<TextureId>,
        presents: Vec<Vec<TextureId>>,
        starts: usize,
        stops: usize,
        sink: Option<Box<dyn FnMut() + Send>>,
    }

    /// 记录调用序列的假表面：验证「Render 核心 → 平台指令」的映射，不碰平台。
    struct FakeSurface {
        shared: Arc<StdMutex<FakeShared>>,
    }

    impl surface::RenderSurface for FakeSurface {
        fn upload(&mut self, id: TextureId, texture: texture::DecodedTexture) -> AppResult<()> {
            self.shared
                .lock()
                .unwrap()
                .uploads
                .push((id, texture.width, texture.height));
            Ok(())
        }

        fn release(&mut self, id: TextureId) {
            self.shared.lock().unwrap().releases.push(id);
        }

        fn present(&mut self, plan: &FramePlan) -> AppResult<()> {
            self.shared
                .lock()
                .unwrap()
                .presents
                .push(plan.draws.iter().map(|draw| draw.texture).collect());
            Ok(())
        }

        fn start_ticks(&mut self, sink: Box<dyn FnMut() + Send>) -> AppResult<()> {
            let mut shared = self.shared.lock().unwrap();
            shared.starts += 1;
            shared.sink = Some(sink);
            Ok(())
        }

        fn stop_ticks(&mut self) -> AppResult<()> {
            let mut shared = self.shared.lock().unwrap();
            shared.stops += 1;
            shared.sink = None;
            Ok(())
        }
    }

    fn renderer() -> (Renderer, Arc<StdMutex<FakeShared>>) {
        let shared = Arc::new(StdMutex::new(FakeShared::default()));
        let surface = FakeSurface {
            shared: Arc::clone(&shared),
        };
        (Renderer::new(Box::new(surface)), shared)
    }

    fn take_sink(shared: &Arc<StdMutex<FakeShared>>) -> Option<Box<dyn FnMut() + Send>> {
        shared.lock().unwrap().sink.take()
    }

    #[test]
    fn 同一路径只上传一次_禁用层不建纹理() {
        let path = temp_png("dedupe");
        let (mut renderer, shared) = renderer();
        let report = renderer.set_layers(vec![
            spec(&path, true),
            spec(&path, true),
            spec(&path, false),
        ]);
        assert_eq!(report.uploaded, 1, "三个层引用同一路径，只上传一次");
        assert_eq!(shared.lock().unwrap().uploads.len(), 1);
        assert_eq!(renderer.stats().resident_textures, 1);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn 帧循环启停计数_停止后tick零帧() {
        let path = temp_png("loop");
        let (mut renderer, shared) = renderer();
        renderer.set_layers(vec![spec(&path, true)]);
        renderer.set_window_geometry(window());

        renderer.start_frames().unwrap();
        renderer.start_frames().unwrap(); // 边沿触发：不重复启动
        let stats = renderer.stats();
        assert!(stats.running);
        assert_eq!(stats.starts, 1);
        assert_eq!(shared.lock().unwrap().starts, 1);
        assert_eq!(stats.frames, 1, "start 立即呈现首帧");
        assert_eq!(shared.lock().unwrap().presents.len(), 1);

        // 平台计时器路径：取出 sink 直接调用（等价一次真实 tick）
        let mut sink = take_sink(&shared).unwrap();
        sink();
        let stats = renderer.stats();
        assert_eq!(stats.frames, 2);
        assert_eq!(shared.lock().unwrap().presents.len(), 2);

        renderer.stop_frames().unwrap();
        renderer.stop_frames().unwrap(); // 边沿触发：不重复停止
        let stats = renderer.stats();
        assert!(!stats.running);
        assert_eq!(stats.stops, 1);
        assert_eq!(shared.lock().unwrap().stops, 1);
        assert!(
            shared.lock().unwrap().sink.is_none(),
            "停止后平台回调被摘除"
        );

        // 停止后即便有残留 tick 到达，也不得产生任何帧
        let presents_before = shared.lock().unwrap().presents.len();
        renderer.tick();
        renderer.tick();
        let stats = renderer.stats();
        assert_eq!(
            shared.lock().unwrap().presents.len(),
            presents_before,
            "隐藏后零帧"
        );
        assert_eq!(stats.rejected_ticks, 2);
        assert_eq!(stats.frames, 2, "被拒绝的 tick 不增加帧数");

        // 可再次启动
        renderer.start_frames().unwrap();
        assert_eq!(renderer.stats().starts, 2);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn 绘制顺序与层顺序一致_即z序() {
        let first = temp_png("z-first");
        let second = temp_png("z-second");
        let (mut renderer, shared) = renderer();
        renderer.set_layers(vec![spec(&first, true), spec(&second, true)]);
        renderer.set_window_geometry(window());
        renderer.render_now().unwrap();

        let shared = shared.lock().unwrap();
        let uploaded: Vec<TextureId> = shared.uploads.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(uploaded.len(), 2);
        assert_eq!(
            shared.presents[0], uploaded,
            "绘制顺序必须跟随输入层顺序（先画 = 底层）"
        );
        std::fs::remove_dir_all(first.parent().unwrap()).unwrap();
        std::fs::remove_dir_all(second.parent().unwrap()).unwrap();
    }

    #[test]
    fn 同一素材两层共享纹理_但各自产生绘制指令() {
        let path = temp_png("shared");
        let (mut renderer, shared) = renderer();
        let report = renderer.set_layers(vec![spec(&path, true), spec(&path, true)]);
        assert_eq!(report.uploaded, 1, "同一素材只上传一次");
        renderer.set_window_geometry(window());
        renderer.render_now().unwrap();
        let shared = shared.lock().unwrap();
        assert_eq!(shared.uploads.len(), 1);
        assert_eq!(shared.presents[0].len(), 2, "两个层各自有绘制指令");
        assert_eq!(
            shared.presents[0][0], shared.presents[0][1],
            "两条指令共享同一纹理"
        );
        drop(shared);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn 层列表收敛后释放纹理_账目归零() {
        let path = temp_png("release");
        let (mut renderer, shared) = renderer();
        renderer.set_layers(vec![spec(&path, true)]);
        assert_eq!(renderer.stats().resident_textures, 1);
        let report = renderer.set_layers(Vec::new());
        assert_eq!(report.released, 1);
        assert_eq!(shared.lock().unwrap().releases.len(), 1);
        let stats = renderer.stats();
        assert_eq!(stats.resident_textures, 0);
        assert_eq!(stats.resident_bytes, 0);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn 强制渲染不依赖帧循环_也不动帧计数() {
        let path = temp_png("forced");
        let (mut renderer, shared) = renderer();
        renderer.set_layers(vec![spec(&path, true)]);
        renderer.set_window_geometry(window());
        renderer.render_now().unwrap();
        let stats = renderer.stats();
        assert_eq!(stats.frames, 0, "帧循环未启动");
        assert_eq!(stats.forced_frames, 1);
        assert!(!stats.running);
        assert_eq!(shared.lock().unwrap().presents.len(), 1);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn 素材解码失败只影响该层_如实上报() {
        let good = temp_png("good");
        let missing = good.parent().unwrap().join("never.png");
        let (mut renderer, shared) = renderer();
        let report = renderer.set_layers(vec![spec(&missing, true), spec(&good, true)]);
        assert_eq!(report.uploaded, 1);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].path, missing);
        assert!(matches!(
            report.failures[0].error,
            crate::error::AppError::PathNotFound(_)
        ));
        assert_eq!(shared.lock().unwrap().uploads.len(), 1);
        assert_eq!(
            renderer.stats().resident_textures,
            1,
            "坏层不驻留、好层照常"
        );
        std::fs::remove_dir_all(good.parent().unwrap()).unwrap();
    }
}
