//! 主窗角色舞台（W9a）：把 W6a 的 [`Renderer`] 接进产品主窗，并与聊天区同窗共存。
//!
//! 分工：
//! - **平台**（`ui/platform/{macos,windows}.rs` 的主窗路径）负责「表面挂哪里、视图多大」：
//!   macOS 是主窗内容视图里的舞台子视图（`MacLayerSurface`），Windows 是主窗客户区内的
//!   舞台子窗口（`WinLayerSurface`）。两侧都只给本模块一个已经建好的 [`RenderSurface`]。
//! - **本模块**负责：保存 Node 推送的舞台快照（层列表 + 灵动参数）、把窗口可见性与
//!   几何翻译成 [`Renderer`] 输入、在显示/隐藏边沿启动/停止帧循环。
//! - **光标输入有两个来源**（见 [`Stage::set_cursor`]）：事件出口直投的推送值
//!   （[`StageNativeEvents`] ← `spawn_cursor_tracker` 的 16ms 事件，原生宿主迁移过程记录 §9.4 第 1 条的
//!   直连路径）与平台跟踪计时器的轮询值（可见期 60Hz，事件缺席时兜底）。两者读数
//!   同源，汇到同一个 [`Renderer::set_cursor`]。
//!
//! 不变量（执行契约 §6.1/§6.2）：
//! - 隐藏期零帧：`set_visible(false)` 停止帧循环；隐藏期到达的 `render_now`（编辑器拖动
//!   预览的兜底调用）被拒绝，不产帧；
//! - 层列表与几何语义只有 W6 一份：舞台与编辑器预览各自构造 `Renderer`，参数都来自
//!   同一 `LayerSpec`，不重建第二份数学。

use std::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::host::events::NativeEventSink;
use crate::render::geometry::WindowGeometry;
use crate::render::surface::RenderSurface;
use crate::render::{LayerSpec, Renderer, RendererStats};
use crate::{rust_debug, rust_info, rust_warn};

/// 事件出口直投的光标（进程内唯一主窗舞台；[`push_cursor`] 写入、[`Stage::set_cursor`] 消费）。
///
/// 事件推送与平台轮询是同一 OS 光标的两个读数（见 [`Stage::set_cursor`] 的说明）；
/// 槽位只保最新一帧，消费即清空，轮询值随即兜底。
static PUSHED_CURSOR: Mutex<Option<crate::render::geometry::CursorPosition>> = Mutex::new(None);

/// 事件出口的直投入口：把 `HostEvent::CursorMoved` 的坐标放到舞台的下一拍消费。
pub fn push_cursor(cursor: crate::render::geometry::CursorPosition) {
    *PUSHED_CURSOR
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(cursor);
}

fn take_pushed_cursor() -> Option<crate::render::geometry::CursorPosition> {
    PUSHED_CURSOR
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
}

/// 原生 UI 的事件消费口实现（`EventSink` 出口按 原生宿主迁移过程记录 §9.4 第 1/2 条路由到这里）。
pub struct StageNativeEvents;

impl NativeEventSink for StageNativeEvents {
    fn cursor_moved(&self, cursor: crate::host::CursorPosition) {
        // 与平台 track 同一坐标翻译（web 坐标系，i32 → f64）。
        push_cursor(crate::render::geometry::CursorPosition {
            x: f64::from(cursor.x),
            y: f64::from(cursor.y),
        });
    }

    fn window_observed(&self, observation: &crate::host::WindowObservation) {
        // 原生 UI 当前没有 `window-observed` 消费者（观察/行为域在 Node 侧消费；原生宿主迁移过程记录 §9.4
        // 第 2 条的「原生 UI 也可能要」为后续接入预留）。不静默：留痕后按无消费者丢弃。
        rust_debug!(
            "原生 UI 暂无 window-observed 消费者（state={} generation={} sequence={}）",
            observation.observation_state,
            observation.monitor_generation,
            observation.sequence
        );
    }
}

/// Node 推送的舞台快照（`appearance` 与当前 Profile 的显示投影）。
///
/// 值一律由 Node 从 CONFIG / Profile 读取后推来；Rust 不读配置、不复制默认值 ——
/// 各字段都是「推来什么用什么」。
#[derive(Debug, Clone, PartialEq)]
pub struct StageProfile {
    /// 五层列表（顺序即 z 序）。空列表 = 尚未收到推送 / Profile 无层。
    pub layers: Vec<LayerSpec>,
    /// 灵动总开关（`appearance.effectMode`：`parallax` → true、`off` → false）。
    pub effect_enabled: bool,
    /// 灵动强度（`appearance.parallaxIntensity`）。
    pub intensity: f64,
    /// 位移归一化基准宽（`general.popup.defaultSize.w`）；0/NaN 由几何核回落默认值。
    pub popup_width: f64,
}

impl Default for StageProfile {
    fn default() -> Self {
        Self {
            layers: Vec::new(),
            effect_enabled: true,
            intensity: 1.0,
            popup_width: 0.0,
        }
    }
}

/// 主窗角色舞台。平台持有它（与窗口同生命周期），Node 推送经 `UiHandle` 进来。
pub struct Stage {
    renderer: Renderer,
    /// Node 最后一次推送的权威快照（编辑器预览结束后回滚到这里）。
    pushed: StageProfile,
    /// 当前实际应用的层（渲染器不暴露层列表，这里记录一份用于预览提升）。
    applied_layers: Vec<LayerSpec>,
    /// 当前实际应用的强度。
    applied_intensity: f64,
    /// 是否处于编辑器预览覆盖态。
    previewing: bool,
    /// 窗口当前是否可见（W5 状态机翻译而来）。
    visible: bool,
    /// 舞台视图是否已挂到主窗（平台在窗口建好时置 true）。
    attached: bool,
}

impl Stage {
    /// 用平台表面新建舞台（表面已挂在主窗的舞台视图/子窗口上）。
    pub fn new(surface: Box<dyn RenderSurface>) -> Self {
        Self {
            renderer: Renderer::new(surface),
            pushed: StageProfile::default(),
            applied_layers: Vec::new(),
            applied_intensity: 1.0,
            previewing: false,
            visible: false,
            attached: true,
        }
    }

    /// 应用 Node 推送的舞台快照（层收敛 + 参数生效）。推送是权威值：
    /// 编辑器预览未在进行时，它就是主窗的最终状态。
    ///
    /// 层解码失败按 W6 语义只影响该层（如实留痕），不阻塞其它层。
    pub fn apply_profile(&mut self, profile: StageProfile) {
        self.sync_profile(&profile);
        rust_info!(
            "舞台快照已应用（层={}，effect={}，intensity={:.2}）",
            profile.layers.len(),
            profile.effect_enabled,
            profile.intensity
        );
        self.pushed = profile;
        self.previewing = false;
    }

    fn sync_profile(&mut self, profile: &StageProfile) {
        self.renderer.set_enabled(profile.effect_enabled);
        self.renderer.set_intensity(profile.intensity);
        self.renderer.set_popup_width(profile.popup_width);
        let report = self.renderer.set_layers(profile.layers.clone());
        if !report.failures.is_empty() {
            rust_warn!(
                "舞台层收敛有 {} 个失败项（本轮不绘制这些层）",
                report.failures.len()
            );
        }
        self.applied_layers = profile.layers.clone();
        self.applied_intensity = profile.intensity;
    }

    /// 编辑器预览：用草稿层列表与强度覆盖显示（内存态，不写盘、不改权威快照）。
    ///
    /// `layers` 是草稿的**原 specs**（不透明度全为缺省）：预览透明度线索只喂编辑器
    /// 自己的渲染器（`ui::editor::cue_specs`），主窗舞台不参与。
    pub fn apply_preview(&mut self, layers: Vec<LayerSpec>, intensity: f64) {
        let mut profile = self.pushed.clone();
        profile.layers = layers;
        profile.intensity = intensity;
        self.sync_profile(&profile);
        self.previewing = true;
        self.refresh();
    }

    /// 结束预览：回到 Node 推送的权威快照（编辑器关闭/丢弃时调用）。
    pub fn clear_preview(&mut self) {
        if !self.previewing {
            return;
        }
        let pushed = self.pushed.clone();
        self.sync_profile(&pushed);
        self.previewing = false;
        self.refresh();
        rust_debug!("舞台预览结束，已回到最后一次推送的 Profile");
    }

    /// 保存成功：当前预览值成为新的权威基线（Node 尚未重推时也保持与磁盘一致）。
    pub fn promote_preview(&mut self) {
        if !self.previewing {
            return;
        }
        let mut promoted = self.pushed.clone();
        promoted.layers = self.applied_layers.clone();
        promoted.intensity = self.applied_intensity;
        self.pushed = promoted;
        self.previewing = false;
    }

    /// 当前实际应用的层（供测试与「主窗/预览一致」核对；顺序即 z 序）。
    pub fn applied_layers(&self) -> &[LayerSpec] {
        &self.applied_layers
    }

    /// 最近一次 Node 推送的权威快照。
    pub fn profile(&self) -> &StageProfile {
        &self.pushed
    }

    /// 窗口几何（屏幕坐标，逻辑像素，左上原点与光标同坐标系）。
    pub fn set_window_geometry(&mut self, window: WindowGeometry) {
        self.renderer.set_window_geometry(window);
    }

    /// 全局光标（`None` = 未知/隐藏）。
    ///
    /// 两个来源汇到同一调用：事件出口直投的推送值（[`push_cursor`]，
    /// `spawn_cursor_tracker` 的 16ms 事件）优先消费，平台跟踪计时器的轮询值兜底。
    /// 两者读的是同一个 OS 光标，取值只差一个采样间隔（≤16ms）；推送链未启动或
    /// 中断时轮询照常供值，跟随不会失效。
    pub fn set_cursor(&mut self, cursor: Option<crate::render::geometry::CursorPosition>) {
        self.renderer.set_cursor(take_pushed_cursor().or(cursor));
    }

    /// 可见性边沿：可见 → 启动帧循环；隐藏 → 停止（隐藏期零帧）。
    ///
    /// 与 W5 状态机的衔接：`reveal()` 一开始就置可见，收起动画**结束时**才置隐藏，
    /// 保证动画期间舞台随内容视图一起缩放。
    pub fn set_visible(&mut self, visible: bool) {
        if self.visible == visible {
            return;
        }
        self.visible = visible;
        self.renderer.set_visible(visible);
        if visible {
            if let Err(error) = self.renderer.start_frames() {
                rust_warn!("舞台帧循环启动失败: {error}");
            }
        } else if let Err(error) = self.renderer.stop_frames() {
            rust_warn!("舞台帧循环停止失败: {error}");
        }
    }

    /// 显示中重新取一帧（Profile 应用/尺寸变化后立即刷新，不等下一个 tick）。
    pub fn refresh(&mut self) {
        if !self.visible {
            return;
        }
        if let Err(error) = self.renderer.render_now() {
            rust_warn!("舞台立即呈现失败: {error}");
        }
    }

    /// 隐藏期不得调用的立即呈现（编辑器拖动预览路径经此，隐藏时如实拒绝）。
    pub fn render_now_visible_only(&mut self) -> AppResult<()> {
        if !self.visible {
            return Err(AppError::Other(
                "舞台不可见（隐藏期禁止调用 render_now，执行契约 §6.2）".into(),
            ));
        }
        self.renderer.render_now()
    }

    pub fn frames_running(&self) -> bool {
        self.renderer.frames_running()
    }

    pub fn stats(&self) -> RendererStats {
        self.renderer.stats()
    }

    pub fn attached(&self) -> bool {
        self.attached
    }

    /// 脱离主窗（窗口重建/退出时）：停帧并标记未挂载。
    pub fn detach(&mut self) {
        if self.visible {
            self.set_visible(false);
        }
        self.attached = false;
        rust_debug!("舞台已脱离主窗");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::compose::FramePlan;
    use crate::render::texture::{DecodedTexture, TextureId};
    use std::sync::{Arc, Mutex, MutexGuard};

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }

    #[test]
    fn 事件推送的光标优先消费_之后回落平台轮询值() {
        let pushed = crate::render::geometry::CursorPosition { x: 10.0, y: 20.0 };
        push_cursor(pushed);
        // `Stage::set_cursor` 的消费点：推送存在时优先，消费一次后清空。
        assert_eq!(take_pushed_cursor(), Some(pushed));
        assert_eq!(take_pushed_cursor(), None, "消费一次后回落平台轮询值");
    }

    const FIXTURE_PNG: &[u8] =
        include_bytes!("../../../../resources/defaults/profiles/sugar-pink/materials/L2/body.png");

    fn temp_png(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "deskpet-stage-{}-{}-{}",
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

    #[derive(Default)]
    struct FakeShared {
        presents: usize,
        ticks_started: usize,
        ticks_stopped: usize,
    }

    struct FakeSurface(Arc<Mutex<FakeShared>>);

    impl RenderSurface for FakeSurface {
        fn upload(&mut self, _id: TextureId, _texture: DecodedTexture) -> AppResult<()> {
            Ok(())
        }
        fn release(&mut self, _id: TextureId) {}
        fn present(&mut self, _plan: &FramePlan) -> AppResult<()> {
            lock(&self.0).presents += 1;
            Ok(())
        }
        fn start_ticks(&mut self, _sink: Box<dyn FnMut() + Send>) -> AppResult<()> {
            lock(&self.0).ticks_started += 1;
            Ok(())
        }
        fn stop_ticks(&mut self) -> AppResult<()> {
            lock(&self.0).ticks_stopped += 1;
            Ok(())
        }
    }

    fn stage() -> (Stage, Arc<Mutex<FakeShared>>) {
        let shared = Arc::new(Mutex::new(FakeShared::default()));
        (Stage::new(Box::new(FakeSurface(shared.clone()))), shared)
    }

    fn spec(path: &std::path::Path) -> LayerSpec {
        LayerSpec {
            path: path.to_path_buf(),
            enabled: true,
            sensitivity: 0.8,
            scale: 1.0,
            offset_x_percent: 0.0,
            offset_y_percent: 0.0,
            opacity: LayerSpec::DEFAULT_OPACITY,
        }
    }

    #[test]
    fn 应用快照收敛层并记录参数() {
        let path = temp_png("apply");
        let (mut stage, _shared) = stage();
        stage.set_window_geometry(WindowGeometry {
            x: 0.0,
            y: 0.0,
            width: 730.0,
            height: 450.0,
        });
        stage.apply_profile(StageProfile {
            layers: vec![spec(&path)],
            effect_enabled: false,
            intensity: 0.7,
            popup_width: 500.0,
        });
        assert_eq!(stage.profile().layers.len(), 1);
        assert!(!stage.profile().effect_enabled);
        assert_eq!(stage.stats().resident_textures, 1);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn 可见性边沿启停帧循环_隐藏期拒绝立即呈现() {
        let path = temp_png("visible");
        let (mut stage, shared) = stage();
        stage.apply_profile(StageProfile {
            layers: vec![spec(&path)],
            ..StageProfile::default()
        });
        // 隐藏期禁止 render_now（编辑器拖动预览的兜底路径）。
        assert!(stage.render_now_visible_only().is_err());

        stage.set_visible(true);
        assert!(stage.frames_running());
        assert_eq!(lock(&shared).ticks_started, 1);
        let before = lock(&shared).presents;
        stage.refresh();
        assert_eq!(
            lock(&shared).presents,
            before + 1,
            "显示中 refresh 立即产帧"
        );

        stage.set_visible(false);
        assert!(!stage.frames_running());
        assert_eq!(lock(&shared).ticks_stopped, 1);
        let before = lock(&shared).presents;
        stage.refresh();
        assert_eq!(lock(&shared).presents, before, "隐藏后 refresh 不产帧");
        assert!(stage.render_now_visible_only().is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn 重复设置同一可见性不重复启停() {
        let (mut stage, shared) = stage();
        stage.set_visible(true);
        stage.set_visible(true);
        assert_eq!(lock(&shared).ticks_started, 1);
        stage.set_visible(false);
        stage.set_visible(false);
        assert_eq!(lock(&shared).ticks_stopped, 1);
    }

    #[test]
    fn 编辑器预览覆盖与回滚不改权威快照() {
        let pushed_path = temp_png("pushed");
        let draft_path = temp_png("draft");
        let (mut stage, _shared) = stage();
        stage.apply_profile(StageProfile {
            layers: vec![spec(&pushed_path)],
            effect_enabled: true,
            intensity: 1.0,
            popup_width: 730.0,
        });
        assert_eq!(stage.applied_layers().len(), 1);

        let mut draft = spec(&draft_path);
        draft.scale = 1.5;
        stage.apply_preview(vec![draft.clone()], 1.8);
        assert_eq!(stage.applied_layers()[0].path, draft_path);
        assert_eq!(stage.profile().intensity, 1.0, "权威快照不被预览改写");

        stage.clear_preview();
        assert_eq!(
            stage.applied_layers()[0].path,
            pushed_path,
            "回滚到权威快照"
        );

        // 保存成功：预览提升为权威（Node 尚未重推时也不回退）。
        stage.apply_preview(vec![draft.clone()], 1.8);
        stage.promote_preview();
        assert_eq!(stage.applied_layers()[0].path, draft_path);
        assert_eq!(stage.profile().intensity, 1.8);
        stage.clear_preview();
        assert_eq!(
            stage.applied_layers()[0].path,
            draft_path,
            "提升后 clear 不再回退"
        );

        std::fs::remove_dir_all(pushed_path.parent().unwrap()).unwrap();
        std::fs::remove_dir_all(draft_path.parent().unwrap()).unwrap();
    }
}
