// ==========================================
// 聊天评测隔离运行根（仅开发构建实际启用）
// ==========================================
//
// 评测执行器要用真实的产品链路跑一场聊天，但不能碰用户/开发数据根，也不能和
// 正在运行的开发实例抢同一把单实例锁。做法与 E2E 同构，只是入口和就绪协议不同：
//
//   DESKPET_SIM_EVAL=1
//   DESKPET_SIM_EVAL_RUN_DIR=<workspace>/test/.tmp/sim-eval-<id>
//
// - 运行根必须是工作区 `test/.tmp` 的直接子目录且带 `sim-eval-` 前缀，否则
//   PATH_ESCAPE；不再回退到开发数据根。
// - 数据根固定为 `<run>/data`，配置固定为 `<run>/data/settings/CONFIG.yaml`
//   （启动器合成写入；缺失即失败 —— 绝不回退到 CONFIG-DEV.yaml）。
// - 单实例锁按该数据根持有；拿到锁后原子写 `ready.json`，作为「这个进程确实
//   拥有这个运行根」的宿主侧证据。Node 侧只信这份文件，不自行推断。
// - 退出由 `stop.request` 触发宿主既有退出序列；运行根内的清理由启动器负责。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{AppError, AppResult};

pub const SIM_EVAL_ENV: &str = "DESKPET_SIM_EVAL";
pub const SIM_EVAL_RUN_DIR_ENV: &str = "DESKPET_SIM_EVAL_RUN_DIR";
pub const READY_FILE: &str = "ready.json";
pub const STOP_FILE: &str = "stop.request";
pub const SEED_FILE: &str = "seed.json";
pub const READY_SCHEMA_VERSION: u32 = 1;

/// 运行根目录名前缀。与 `test/.tmp/e2e-` 同层但互不认领。
const RUN_DIR_PREFIX: &str = "sim-eval-";
/// `stop.request` 轮询间隔：只影响评测收尾延迟，不影响产品路径。
const STOP_POLL: Duration = Duration::from_millis(200);

/// 是否处于评测隔离模式。release 构建恒为 false —— 环境变量不能改变产品数据根。
pub fn is_sim_eval() -> bool {
    cfg!(debug_assertions) && std::env::var(SIM_EVAL_ENV).ok().as_deref() == Some("1")
}

/// 校验并规范化运行根：必须是 `<workspace>/test/.tmp/sim-eval-*` 的直接子目录。
pub fn validate_run_dir(requested: &Path, workspace_root: &Path) -> AppResult<PathBuf> {
    let run = requested
        .canonicalize()
        .map_err(|error| AppError::Config(format!("sim-eval 运行根不存在: {error}")))?;
    let base = workspace_root
        .join("test/.tmp")
        .canonicalize()
        .map_err(|error| AppError::Config(format!("sim-eval 基目录不存在: {error}")))?;
    if run.parent() != Some(base.as_path())
        || !run
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(RUN_DIR_PREFIX))
    {
        return Err(AppError::PathEscape);
    }
    Ok(run)
}

/// 从环境读取并校验运行根。缺失或非法都直接失败。
pub fn run_dir(workspace_root: &Path) -> AppResult<PathBuf> {
    let requested = std::env::var(SIM_EVAL_RUN_DIR_ENV)
        .map(PathBuf::from)
        .map_err(|_| AppError::Config(format!("sim-eval 缺少运行根（{SIM_EVAL_RUN_DIR_ENV}）")))?;
    validate_run_dir(&requested, workspace_root)
}

pub fn data_root(run_dir: &Path) -> PathBuf {
    run_dir.join("data")
}

/// Node 聊天控制通道目录（chat-bridge 的 `runtimePath("data","logs","sim","control")`）。
pub fn control_dir(data_root: &Path) -> PathBuf {
    data_root.join("logs").join("sim").join("control")
}

pub fn ready_path(run_dir: &Path) -> PathBuf {
    run_dir.join(READY_FILE)
}

pub fn stop_path(run_dir: &Path) -> PathBuf {
    run_dir.join(STOP_FILE)
}

pub fn seed_path(run_dir: &Path) -> PathBuf {
    run_dir.join(SEED_FILE)
}

/// `ready.json` 的字段形状：启动器（读取方）与 Node 运行上下文共用 camelCase。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimEvalReady {
    pub schema_version: u32,
    pub generation: String,
    pub pid: u32,
    pub run_dir: PathBuf,
    pub data_root: PathBuf,
    pub control_dir: PathBuf,
    pub runtime_mode: String,
    pub started_at: String,
}

/// 原子写 ready：先写同目录临时文件再 rename，避免读取方看到半截 JSON。
pub fn write_ready(run_dir: &Path, ready: &SimEvalReady) -> AppResult<PathBuf> {
    let target = ready_path(run_dir);
    let temp = run_dir.join(format!(".{READY_FILE}.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(ready)
        .map_err(|error| AppError::Other(format!("ready.json 序列化失败: {error}")))?;
    fs::write(&temp, text)
        .map_err(|error| AppError::Io(format!("写入 ready.json 失败 {temp:?}: {error}")))?;
    // Windows 的 rename 不覆盖已存在目标；运行根理论上全新，但崩溃重试时要能覆盖。
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&temp, &target)
        .map_err(|error| AppError::Io(format!("落位 ready.json 失败 {target:?}: {error}")))?;
    Ok(target)
}

/// 运行期持有：正常返回时移除 ready；异常终止留下的文件由启动器按进程存活判定。
pub struct ReadyGuard {
    path: PathBuf,
}

impl ReadyGuard {
    pub fn new(run_dir: &Path) -> Self {
        Self {
            path: ready_path(run_dir),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 幂等移除（退出钩子与 Drop 都会调用）。
    pub fn remove(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl Drop for ReadyGuard {
    fn drop(&mut self) {
        self.remove();
    }
}

/// 后台等待 `stop.request`，出现后执行一次调用方提供的退出动作。
///
/// 评测执行器只写文件、从不发信号：进程必须走产品自己的退出序列（回收 MCP/Bash、
/// 等 Node flush），而不是被 SIGTERM/SIGKILL 打断。
pub fn spawn_stop_watcher(run_dir: PathBuf, stop: Box<dyn FnOnce() + Send>) {
    std::thread::spawn(move || {
        let path = stop_path(&run_dir);
        loop {
            if path.exists() {
                stop();
                return;
            }
            std::thread::sleep(STOP_POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_workspace() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "deskpet-sim-eval-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("test/.tmp")).unwrap();
        root
    }

    #[test]
    fn run_dir_must_be_a_direct_child_with_prefix() {
        let workspace = temp_workspace();
        let base = workspace.join("test/.tmp");
        let valid = base.join("sim-eval-abc");
        fs::create_dir_all(&valid).unwrap();
        assert_eq!(
            validate_run_dir(&valid, &workspace).unwrap(),
            valid.canonicalize().unwrap()
        );

        let foreign = base.join("e2e-abc");
        fs::create_dir_all(&foreign).unwrap();
        assert!(matches!(
            validate_run_dir(&foreign, &workspace),
            Err(AppError::PathEscape)
        ));

        let nested = valid.join("nested");
        fs::create_dir_all(&nested).unwrap();
        assert!(matches!(
            validate_run_dir(&nested, &workspace),
            Err(AppError::PathEscape)
        ));

        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn missing_run_dir_fails_instead_of_falling_back() {
        let workspace = temp_workspace();
        let missing = workspace.join("test/.tmp/sim-eval-missing");
        assert!(matches!(
            validate_run_dir(&missing, &workspace),
            Err(AppError::Config(_))
        ));
        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn ready_is_written_atomically_and_removed_by_guard() {
        let workspace = temp_workspace();
        let dir = workspace.join("test/.tmp/sim-eval-ready");
        fs::create_dir_all(&dir).unwrap();
        let run = validate_run_dir(&dir, &workspace).unwrap();
        let ready = SimEvalReady {
            schema_version: READY_SCHEMA_VERSION,
            generation: "abc123".into(),
            pid: std::process::id(),
            run_dir: run.clone(),
            data_root: data_root(&run),
            control_dir: control_dir(&data_root(&run)),
            runtime_mode: "development".into(),
            started_at: "2026-10-25T00:00:00+08:00".into(),
        };
        let path = write_ready(&run, &ready).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["schemaVersion"], 1);
        assert_eq!(parsed["generation"], "abc123");
        assert_eq!(parsed["controlDir"], serde_json::json!(control_dir(&data_root(&run))));
        assert_eq!(
            fs::read_dir(&run)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
                .count(),
            0,
            "临时文件不应残留"
        );

        let guard = ReadyGuard::new(&run);
        guard.remove();
        assert!(!path.exists());
        fs::remove_dir_all(&workspace).unwrap();
    }
}
