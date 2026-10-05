//! 更新域（W10b）：Native `UpdatePort`、`update.json` 契约与安装 helper。
//!
//! 执行契约 §4.5 的落位（docs/history/implementation/原生宿主轻量化执行契约-2026-10-04基线.md）：
//!
//! - **不用 `cargo-packager-updater` 的名字相近实现**：它没有可直接依赖的 macOS
//!   `.app` 整包替换路径，不是已闭合的双平台安装器。这里自己做可注入的 Native
//!   `UpdatePort`（本文件）：下载/校验/staging 在**主宿主**完成，应用照常使用；
//!   关闭整套进程后由**独立可执行**的 helper（`helper.rs`）替换并重启。
//! - 更新源是 `update.json`（单一 schemaVersion），签名 envelope 覆盖 version、
//!   platform/arch、制品 SHA256/size、URL 与应用标识；制品哈希另行逐字节复核。
//!   校验链与拒绝分支见 `manifest.rs`。
//! - Native 版本之间保留「应用内确认 → 下载 → 安装 → 重启」；**旧 Tauri 到 Native
//!   的首次跨宿主升级是手动安装**（不新增桥接版本/兼容 feed/旧 manifest 读取或双写）。
//!   自动入口（启动延迟，`ui::settings::updates::schedule_startup`）与手动入口
//!   （设置页）都经同一 `UpdatePort` 语义。
//! - 数据根不在替换目录内：staging 与安装状态都在 `{data_root}/updates/`。
//!
//! 可注入设计：
//! - [`UpdatePort`] 是命令面/退出序列消费的唯一抽象；`UpdateRuntime` 是生产实现，
//!   单测用假 port 替代（`handle_command_with`）。
//! - 取字节（[`http::HttpClient`]）与验签（[`verify::EnvelopeVerifier`]）各自成端口，
//!   单测不碰网络、不碰真实密钥。
//! - 进程级唯一实例由 `main.rs` 启动时经 [`init`] 装配（幂等）；未装配时命令面
//!   如实报错，不静默降级。
//!
//! 命令面（Rust 唯一实现；TS 侧 `src/ui/update.ts` 的默认工厂经 HostBridge 调用，
//! HostCommandMap 的集中登记由协调者收口）：
//!
//! | method | args | result |
//! |---|---|---|
//! | `update_check` | `{}` | `{ version, notes? } \| null`（已是最新 = null） |
//! | `update_download_and_install` | `{}` | `{ version }`（下载校验后落 staging；重启走宿主退出路径） |
//!
//! `app_restart` 仍是应用生命周期命令（HostCommandMap 既有条目）：更新场景下的
//! 语义是"退出宿主 → helper 替换 → 自动重启"，其原生接线属 W9/W10c 收口项，
//! 本包不另造同义命令。

pub mod helper;
pub mod http;
pub mod manifest;
pub mod stage;
pub mod verify;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use crate::error::AppResult;
use crate::paths::AppPaths;
use crate::rust_debug;
use crate::rust_error;
use crate::rust_info;

use http::{read_capped, HttpClient, UreqHttp};
use manifest::{
    select_release, update_error, UpdateConfig, VerifiedRelease, E_NO_PENDING, E_STATE,
};
use stage::{HostLayout, InstallPhase, InstallState};
use verify::{EnvelopeVerifier, MinisignVerifier};

/// 编译期嵌入的客户端更新元数据（唯一真相源：`packaging/update.json`）。
const EMBEDDED_UPDATE_CONFIG: &str = include_str!("../../../../packaging/update.json");

/// 编译期嵌入的打包元数据：仅用于核对 `appIdentifier` 与打包标识一致
/// （`packaging/desktop.json` 的 identifier 是打包身份的真相源）。
const EMBEDDED_DESKTOP_CONFIG: &str = include_str!("../../../../packaging/desktop.json");

/// 解析嵌入的客户端更新元数据。helper 侧也走这里（同一份配置、同一个校验）。
pub(crate) fn embedded_config() -> AppResult<UpdateConfig> {
    let desktop: Value = serde_json::from_str(EMBEDDED_DESKTOP_CONFIG)
        .map_err(|e| update_error(E_STATE, format!("packaging/desktop.json 解析失败: {e}")))?;
    let identifier = desktop
        .get("identifier")
        .and_then(Value::as_str)
        .ok_or_else(|| update_error(E_STATE, "packaging/desktop.json 缺少 identifier"))?;
    manifest::parse_config(EMBEDDED_UPDATE_CONFIG, identifier)
}

// ==========================================
// UpdatePort：命令面与退出序列消费的唯一抽象
// ==========================================

/// 更新端口。生产实现是 [`UpdateRuntime`]；测试注入假实现验证调用编排。
pub trait UpdatePort: Send + Sync {
    /// 拉 feed、验签、选当前平台最高可用版本；已是最新返回 `Ok(None)`。
    /// 成功时实现会记住这个候选，供随后的 `download_and_stage` 使用。
    fn check(&self) -> AppResult<Option<VerifiedRelease>>;

    /// 下载并校验候选（必须来自同一次 `check` 或先前保存的候选），
    /// 落 staging 并写安装状态（phase=staged）。不触碰安装目录。
    fn download_and_stage(&self) -> AppResult<InstallState>;

    /// 读取当前安装状态（可恢复状态机的一手依据）。
    fn install_state(&self) -> AppResult<Option<InstallState>>;

    /// 退出序列调用：有 staged 更新时拉起 helper（独立进程；等宿主退出后替换/重启）。
    fn launch_staged_helper(&self) -> AppResult<Option<PathBuf>>;

    /// 启动时恢复：把上次中断的 apply 收口（回滚到上一完整版本 / 补记完成 / 清场）。
    fn recover_on_startup(&self) -> AppResult<String>;
}

// ==========================================
// 生产实现
// ==========================================

pub struct UpdateRuntime {
    config: UpdateConfig,
    layout: HostLayout,
    target: manifest::Target,
    current: manifest::Version,
    http: Arc<dyn HttpClient>,
    verifier: Arc<dyn EnvelopeVerifier>,
    /// 最近一次 `check` 选出的候选；`download_and_stage` 只安装这个（避免 check 与
    /// 安装之间 feed 变化导致"给用户看的版本"和"实际装的版本"不一致）。
    pending: Mutex<Option<VerifiedRelease>>,
}

impl UpdateRuntime {
    /// 可注入构造：单测与将来的宿主替身从这里装配。
    pub fn new(
        config: UpdateConfig,
        layout: HostLayout,
        current: manifest::Version,
        http: Arc<dyn HttpClient>,
        verifier: Arc<dyn EnvelopeVerifier>,
    ) -> AppResult<Self> {
        let target = manifest::Target::current()?;
        Ok(Self {
            config,
            layout,
            target,
            current,
            http,
            verifier,
            pending: Mutex::new(None),
        })
    }

    /// 生产装配：配置来自编译期嵌入，布局从可执行文件推导，网络/验签用真实实现。
    fn for_process(paths: &AppPaths) -> AppResult<Self> {
        let config = embedded_config()?;
        let exe = std::env::current_exe()
            .map_err(|e| update_error(E_STATE, format!("解析可执行文件路径失败: {e}")))?;
        let layout = HostLayout::detect(&paths.data_root, &exe)?;
        let current = manifest::Version::parse(env!("CARGO_PKG_VERSION"))?;
        let verifier = MinisignVerifier::new(&config.release_public_key)?;
        Self::new(
            config,
            layout,
            current,
            Arc::new(UreqHttp::new()),
            Arc::new(verifier),
        )
    }

    pub fn config(&self) -> &UpdateConfig {
        &self.config
    }

    pub fn layout(&self) -> &HostLayout {
        &self.layout
    }

    fn fetch_feed(&self) -> AppResult<Vec<u8>> {
        let mut reader = self.http.get(&self.config.feed_url)?;
        read_capped(
            &mut reader,
            self.config.limits.max_feed_bytes,
            "update.json",
        )
    }
}

impl UpdatePort for UpdateRuntime {
    fn check(&self) -> AppResult<Option<VerifiedRelease>> {
        let feed = self.fetch_feed()?;
        let selected = select_release(
            &feed,
            &self.config,
            self.target,
            &self.current,
            self.verifier.as_ref(),
        )?;
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        *pending = selected.clone();
        match &selected {
            Some(release) => rust_info!(
                "发现更新 {}（当前 {}，目标 {}；notes={}）",
                release.version,
                self.current,
                self.target.key(),
                release.notes.as_deref().unwrap_or("无")
            ),
            None => rust_info!(
                "已是最新版本（当前 {}，目标 {}）",
                self.current,
                self.target.key()
            ),
        }
        Ok(selected)
    }

    fn download_and_stage(&self) -> AppResult<InstallState> {
        let release = {
            let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.clone().ok_or_else(|| {
                update_error(E_NO_PENDING, "没有待安装的候选版本：请先执行一次更新检查")
            })?
        };
        let state = stage::stage_release(
            self.http.as_ref(),
            &self.layout,
            &release,
            &self.current.to_string(),
        )?;
        rust_info!(
            "更新已 staging: {} → {}（{} 个组件在 {}，宿主退出后由 helper 替换）",
            state.from_version,
            state.to_version,
            state.components.len(),
            state.staging_root.display()
        );
        Ok(state)
    }

    fn install_state(&self) -> AppResult<Option<InstallState>> {
        stage::read_state(&self.layout.state_path())
    }

    fn launch_staged_helper(&self) -> AppResult<Option<PathBuf>> {
        let Some(state) = self.install_state()? else {
            return Ok(None);
        };
        if state.phase != InstallPhase::Staged {
            return Ok(None);
        }
        let run_path = helper::spawn_helper(&self.layout, &state)?;
        Ok(Some(run_path))
    }

    fn recover_on_startup(&self) -> AppResult<String> {
        stage::recover_install_state(&self.layout)
    }
}

// ==========================================
// 进程级唯一实例（main.rs 启动时装配）
// ==========================================

static RUNTIME: OnceLock<UpdateRuntime> = OnceLock::new();

/// 启动装配（幂等）。失败**不阻断宿主启动**：更新功能不可用，但错误必须留痕
/// （命令面随后如实报"未初始化"，不静默降级）。
pub fn init(paths: &AppPaths) {
    if RUNTIME.get().is_some() {
        return;
    }
    let runtime = match UpdateRuntime::for_process(paths) {
        Ok(runtime) => runtime,
        Err(error) => {
            rust_error!("更新域初始化失败（应用内更新不可用）: {error}");
            return;
        }
    };
    // 启动恢复：把上次中断的安装收口。失败只留痕，不清现场（现场是恢复的一手依据）。
    match runtime.recover_on_startup() {
        Ok(outcome) => rust_info!("更新启动恢复: {outcome}"),
        Err(error) => rust_error!("更新启动恢复失败（保持现场，等待人工检查）: {error}"),
    }
    rust_info!(
        "更新域就绪: app={} 目标={} feed={}；代码签名状态（如实记录）: {}",
        runtime.config.app_identifier,
        runtime.target.key(),
        runtime.config.feed_url,
        runtime.config.code_signing.summary()
    );
    let _ = RUNTIME.set(runtime);
}

/// 取进程级实例；未装配时如实报错（宿主启动序列必须调用 [`init`]）。
pub fn runtime() -> AppResult<&'static UpdateRuntime> {
    RUNTIME.get().ok_or_else(|| {
        update_error(
            E_STATE,
            "更新运行时未初始化（main.rs 启动序列未调用 update::init）",
        )
    })
}

// ==========================================
// 启动延迟的自动检查（§4.5「自动入口」）
// ==========================================
//
// 自动入口的唯一实现在 `ui/settings/updates.rs::schedule_startup`（`main.rs` 启动序列
// 调用），它跑的是**完整**链路（检查 → 确认 → 下载校验 → 重启）。这里曾有一份只检查
// 不留交互的同名调度（`spawn_startup_check`），被上面那份取代后**没有任何调用方**，
// 按「不留废弃代码」删除；不要再在这里重建第二份自动入口。

/// 退出序列钩子（`ServiceExitHook` 在 MCP/Bash/Node 全部回收之后调用）：
/// 有 staged 更新 → 拉起 helper；没有 → 静默（debug 级留痕）。
pub fn on_host_exit() {
    let Ok(runtime) = runtime() else {
        rust_debug!("退出序列：更新运行时未初始化，跳过 helper 检查");
        return;
    };
    match runtime.launch_staged_helper() {
        Ok(Some(helper)) => rust_info!(
            "更新 helper 已在退出序列拉起（宿主退出后替换并重启）: {}",
            helper.display()
        ),
        Ok(None) => rust_debug!("退出序列：没有 staged 更新，无需 helper"),
        Err(error) => rust_error!(
            "拉起更新 helper 失败（更新保持 staged，未替换任何文件；下次退出可重试）: {error}"
        ),
    }
}

// ==========================================
// 命令面（唯一实现；TS 侧经 HostBridge 调用同名前缀的窄接口）
// ==========================================

/// `main.rs` 的最小分派器据此把更新命令委托进来（非更新命令返回 false 走原逻辑）。
pub fn is_update_command(method: &str) -> bool {
    matches!(method, "update_check" | "update_download_and_install")
}

/// 命令分派（进程级运行时）。
pub fn handle_command(method: &str, args: &Value) -> AppResult<Value> {
    handle_command_with(runtime()?, method, args)
}

/// 可注入版本：测试用假 [`UpdatePort`] 驱动命令编排。
pub fn handle_command_with(port: &dyn UpdatePort, method: &str, args: &Value) -> AppResult<Value> {
    // 两条命令都是无参命令；多出来的参数说明调用方版本与宿主不一致，如实拒绝。
    let empty = args.is_null() || args.as_object().is_some_and(|o| o.is_empty());
    if !empty {
        return Err(update_error(
            E_STATE,
            format!("{method} 不接受参数（收到 {args}）"),
        ));
    }
    match method {
        "update_check" => match port.check()? {
            Some(release) => Ok(json!({
                "version": release.version.to_string(),
                "notes": release.notes,
            })),
            None => Ok(Value::Null),
        },
        "update_download_and_install" => {
            let state = port.download_and_stage()?;
            Ok(json!({ "version": state.to_version }))
        }
        other => Err(update_error(E_STATE, format!("未知更新命令: {other}"))),
    }
}

// ==========================================
// 供 main.rs/helper 的小工具
// ==========================================

/// 当前进程安装布局（诊断/日志用；真实装配走 [`UpdateRuntime::layout`]）。
pub fn detect_layout(data_root: &Path) -> AppResult<HostLayout> {
    let exe = std::env::current_exe()
        .map_err(|e| update_error(E_STATE, format!("解析可执行文件路径失败: {e}")))?;
    HostLayout::detect(data_root, &exe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppResult;
    use crate::update::manifest::{Version, E_LOW_VERSION};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn release(version: &str) -> VerifiedRelease {
        let envelope: manifest::ReleaseEnvelope = serde_json::from_value(json!({
            "appIdentifier": "com.v1rtual.deskpet",
            "version": version,
            "platform": manifest::PLATFORM_MACOS,
            "arch": manifest::ARCH_AARCH64,
            "versionSet": { "app": version, "node": "22.22.3" },
            "components": [{
                "kind": "app",
                "name": "a.app.tar.gz",
                "url": "https://example.com/a.app.tar.gz",
                "size": 1,
                "sha256": "a".repeat(64),
            }],
        }))
        .unwrap();
        VerifiedRelease {
            version: Version::parse(version).unwrap(),
            notes: Some("测试".to_string()),
            envelope,
            envelope_bytes: "{}".to_string(),
            signature: "sig".to_string(),
        }
    }

    /// 假 port：不碰网络、不碰磁盘；记录调用顺序。
    struct FakePort {
        checks: AtomicUsize,
        stages: AtomicUsize,
    }

    impl UpdatePort for FakePort {
        fn check(&self) -> AppResult<Option<VerifiedRelease>> {
            self.checks.fetch_add(1, Ordering::SeqCst);
            Ok(Some(release("0.17.0")))
        }
        fn download_and_stage(&self) -> AppResult<InstallState> {
            self.stages.fetch_add(1, Ordering::SeqCst);
            Ok(InstallState {
                schema_version: stage::STATE_SCHEMA_VERSION,
                phase: InstallPhase::Staged,
                from_version: "0.16.0".to_string(),
                to_version: "0.17.0".to_string(),
                updated_at: "now".to_string(),
                install_root: PathBuf::from("/install"),
                backup_root: PathBuf::from("/backup"),
                staging_root: PathBuf::from("/staging"),
                log_dir: PathBuf::from("/logs"),
                envelope: "{}".to_string(),
                signature: "sig".to_string(),
                components: vec![],
                restart: true,
            })
        }
        fn install_state(&self) -> AppResult<Option<InstallState>> {
            Ok(None)
        }
        fn launch_staged_helper(&self) -> AppResult<Option<PathBuf>> {
            Ok(None)
        }
        fn recover_on_startup(&self) -> AppResult<String> {
            Ok("test".to_string())
        }
    }

    #[test]
    fn 命令面_检查返回版本或_null() {
        struct NoUpdate;
        impl UpdatePort for NoUpdate {
            fn check(&self) -> AppResult<Option<VerifiedRelease>> {
                Ok(None)
            }
            fn download_and_stage(&self) -> AppResult<InstallState> {
                Err(update_error(E_NO_PENDING, "无候选"))
            }
            fn install_state(&self) -> AppResult<Option<InstallState>> {
                Ok(None)
            }
            fn launch_staged_helper(&self) -> AppResult<Option<PathBuf>> {
                Ok(None)
            }
            fn recover_on_startup(&self) -> AppResult<String> {
                Ok("test".to_string())
            }
        }
        assert_eq!(
            handle_command_with(&NoUpdate, "update_check", &json!({})).unwrap(),
            Value::Null
        );

        let port = FakePort {
            checks: AtomicUsize::new(0),
            stages: AtomicUsize::new(0),
        };
        let payload = handle_command_with(&port, "update_check", &json!({})).unwrap();
        assert_eq!(payload["version"], "0.17.0");
        assert_eq!(payload["notes"], "测试");
        assert_eq!(port.checks.load(Ordering::SeqCst), 1);

        let staged = handle_command_with(&port, "update_download_and_install", &json!({})).unwrap();
        assert_eq!(staged["version"], "0.17.0");
        assert_eq!(port.stages.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn 命令面_拒绝未知命令与多余参数() {
        let port = FakePort {
            checks: AtomicUsize::new(0),
            stages: AtomicUsize::new(0),
        };
        assert!(handle_command_with(&port, "update_unknown", &json!({})).is_err());
        assert!(handle_command_with(&port, "update_check", &json!({ "surprise": 1 })).is_err());
        assert_eq!(
            port.checks.load(Ordering::SeqCst),
            0,
            "校验失败不应触达 port"
        );
    }

    #[test]
    fn 命令注册表与_dispatch_判定一致() {
        assert!(is_update_command("update_check"));
        assert!(is_update_command("update_download_and_install"));
        assert!(!is_update_command("get_runtime_paths"));
        assert!(
            !is_update_command("app_restart"),
            "app_restart 属生命周期命令，不由更新域分派"
        );
    }

    #[test]
    fn 低版本闸门错误码可辨识() {
        let err = manifest::ensure_newer(
            &Version::parse("0.16.0").unwrap(),
            &Version::parse("0.17.0").unwrap(),
        )
        .unwrap_err();
        assert_eq!(err.code(), E_LOW_VERSION);
    }

    #[test]
    fn 嵌入配置可解析且与打包标识一致() {
        // 编译期嵌入的两个文件必须自洽：配置漂移在打包/启动时会当场暴露，
        // 这条测试把它提前到测试层（config 与 desktop.json 的 identifier 对账）。
        let config = embedded_config().expect("packaging/update.json 必须可解析");
        assert_eq!(config.app_identifier, "com.v1rtual.deskpet");
        assert_eq!(config.schema_version, manifest::UPDATE_SCHEMA_VERSION);
        assert!(config.feed_url.starts_with("https://"));
        // 公钥可用性（MinisignVerifier::new 内已校验长度/算法标记，这里再钉一次可构造）
        assert!(verify::MinisignVerifier::new(&config.release_public_key).is_ok());
        // 尺寸上限必须为正且 feed 上限明显小于制品上限（防呆：别把两者写反）
        assert!(config.limits.max_feed_bytes > 0);
        assert!(config.limits.max_artifact_bytes > config.limits.max_feed_bytes);
    }
}
