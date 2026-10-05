// ==========================================
// 安装 helper：独立可执行文件（W10b）
// ==========================================
//
// 为什么必须是**独立可执行**（契约 §4.5）：替换 `.app` 整目录 / 走 Windows 安装器
// 都要求"整套宿主进程已退出"——主宿主自己的镜像就在被替换的目录里，不能自杀式替换。
//
// 生命周期：
//   随包分发：Cargo `[[bin]] deskpet-update-helper` → 与主可执行文件同目录
//             （macOS `Contents/MacOS/`、Windows 安装根；packaging/desktop.json 的
//             binaries 清单负责进包）。
//   被拉起：  主宿主**退出序列**末尾（`update::on_host_exit`，在 MCP/Bash/Node 全部
//             回收之后）调用 [`spawn_helper`]：把 helper 复制到 staging 目录再拉起
//             （绝不从安装目录里运行自己——否则 Windows 上安装目录被占用无法整体替换，
//             macOS 上也是"替换掉正在执行的镜像"的歧义），然后常驻持有子进程 stdin
//             写端；主宿主进程结束 → OS 关闭句柄 → helper 读到 EOF → 开始替换。
//   不混装：  安装前重走**完整校验链**（envelope 验签 → staging 逐文件重算哈希 →
//             包内 version-set.json 与签名声明逐项对照 → 低版本闸门），任何一项不过
//             都不碰安装目录；替换用"整目录改名换位"而不是逐文件覆盖。
//   回滚：    每一步先落盘相位再动作；失败把备份改名换回（回到上一完整版本），
//             并标记 rolled-back（需要重新下载才能再试，避免坏更新在每次退出重试）。
//
// 退出码（对启动器/日志的人类读者）：
//   0 = 已替换并重启；1 = 失败且已回滚；2 = 没有可执行的 staged 状态；
//   3 = 失败且回滚未完成（需要人工检查，现场原样保留）。

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use crate::error::AppResult;
use crate::logger;
use crate::rust_error;
use crate::rust_info;
use crate::rust_warn;

use super::manifest::{
    update_error, BundleVersionSet, E_COMPONENTS, E_INSTALL_LAYOUT, E_STATE, E_VERSION_SET,
    KIND_APP, PLATFORM_MACOS, PLATFORM_WINDOWS, VERSION_SET_FILE_NAME,
};
use super::stage::{
    read_state, verify_staged_files, write_state, HostLayout, InstallPhase, InstallState,
};
use super::verify::EnvelopeVerifier;

/// helper 等宿主的时限：超时按失败退出、不半途替换（staged 状态原样保留可重试）。
const WAIT_PARENT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 主宿主侧：进程退出前拉起的 helper 子进程。
///
/// 放进 static 是为了**持有 stdin 写端直到进程结束**：Child 一被 drop，写端就关，
/// helper 会误以为宿主已退出。static 在进程退出时随 OS 回收，不需要显式 join。
static HELPER_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

// ==========================================
// 主宿主侧：拉起 helper
// ==========================================

/// 把随包 helper 复制到 staging 后以分离进程拉起。
///
/// 返回值是 helper 实际运行副本的路径（日志用）。
pub fn spawn_helper(layout: &HostLayout, state: &InstallState) -> AppResult<PathBuf> {
    if !layout.helper_source.is_file() {
        return Err(update_error(
            E_INSTALL_LAYOUT,
            format!(
                "随包更新 helper 缺失：{}（打包 binaries 清单应含 {HELPER_NAME}）",
                layout.helper_source.display()
            ),
        ));
    }
    if !state.staging_root.is_dir() {
        return Err(update_error(
            E_STATE,
            format!("staging 目录不存在：{}", state.staging_root.display()),
        ));
    }

    let helper_name = helper_file_name();
    let run_path = state.staging_root.join(&helper_name);
    fs::copy(&layout.helper_source, &run_path).map_err(|e| {
        update_error(
            E_INSTALL_LAYOUT,
            format!(
                "复制 helper 到 staging 失败 {} → {}: {e}",
                layout.helper_source.display(),
                run_path.display()
            ),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&run_path, fs::Permissions::from_mode(0o755)).map_err(|e| {
            update_error(
                E_INSTALL_LAYOUT,
                format!("helper 授权失败 {}: {e}", run_path.display()),
            )
        })?;
    }

    let mut command = std::process::Command::new(&run_path);
    command
        .arg("--apply")
        .arg("--state")
        .arg(layout.state_path())
        // stdout/stderr 与宿主解耦：helper 写自己的日志文件（state.log_dir）。
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 新进程组：终端 Ctrl-C 的 SIGINT 只发给前台进程组，不会连坐 helper。
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS：不继承控制台；CREATE_NEW_PROCESS_GROUP：Ctrl-C 事件不传播。
        // 不用 CREATE_BREAKAWAY_FROM_JOB：宿主进程通常不在作业对象里；若被 CI/IDE 放进
        // 不允许逃逸的作业，带该标志会直接 CreateProcess 失败。失败路径如实报错，
        // staged 状态保留，用户下次退出可再试。
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    let child = command.spawn().map_err(|e| {
        update_error(
            E_INSTALL_LAYOUT,
            format!("拉起更新 helper 失败 {}: {e}", run_path.display()),
        )
    })?;
    let pid = child.id();
    let mut slot = HELPER_CHILD.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        rust_warn!("本次进程已拉起过更新 helper，覆盖旧句柄（旧 stdin 写端将关闭）");
    }
    // 不 wait：句柄常驻到进程结束，OS 关掉 stdin 写端时 helper 才开始替换。
    *slot = Some(child);
    rust_info!(
        "更新 helper 已拉起: pid={pid} run={} state={}",
        run_path.display(),
        layout.state_path().display()
    );
    Ok(run_path)
}

fn helper_file_name() -> String {
    if cfg!(windows) {
        format!("{HELPER_NAME}.exe")
    } else {
        HELPER_NAME.to_string()
    }
}

/// 与 Cargo `[[bin]] name`、packaging/desktop.json 一致（stage.rs 的常量转出）。
const HELPER_NAME: &str = super::stage::HELPER_BIN_NAME;

// ==========================================
// helper 侧：等待、重验、替换、回滚、重启
// ==========================================

/// helper 进程入口（`src/update/helper_main.rs` 调用）。返回进程退出码。
///
/// 参数：`--apply --state <install-state.json> [--wait-ms <n>]`（内部/测试用）。
pub fn run_helper_main() -> i32 {
    logger::init_from_env();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut state_path: Option<PathBuf> = None;
    let mut wait = WAIT_PARENT_TIMEOUT;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--apply" => {}
            "--state" => {
                index += 1;
                match args.get(index) {
                    Some(path) => state_path = Some(PathBuf::from(path)),
                    None => {
                        eprintln!("--state 缺少参数");
                        return 2;
                    }
                }
            }
            "--wait-ms" => {
                index += 1;
                if let Some(raw) = args.get(index).and_then(|v| v.parse::<u64>().ok()) {
                    wait = Duration::from_millis(raw);
                }
            }
            other => {
                eprintln!("未知参数: {other}");
                return 2;
            }
        }
        index += 1;
    }
    let Some(state_path) = state_path else {
        eprintln!("用法: deskpet-update-helper --apply --state <install-state.json>");
        return 2;
    };

    let state = match read_state(&state_path) {
        Ok(Some(state)) => state,
        Ok(None) => {
            // 日志 sink 依赖状态文件里的 log_dir，建立之前只能用 stderr 如实告知；
            // 生产路径 stderr 被宿主置空，这里主要服务手动运行与开发排查。
            eprintln!("没有安装状态文件：{state_path:?}");
            return 2;
        }
        Err(error) => {
            eprintln!("安装状态不可读: {error}");
            return 3;
        }
    };
    logger::init_file_sink(&state.log_dir);
    rust_info!(
        "更新 helper 启动: {} → {}（phase={}）",
        state.from_version,
        state.to_version,
        state.phase.as_str()
    );

    if state.phase != InstallPhase::Staged {
        // 已被其他路径处理过（或恢复流程改变了相位）：什么都不做，不覆盖结论。
        rust_warn!(
            "安装状态 phase={} 不是 staged，helper 退出",
            state.phase.as_str()
        );
        return 2;
    }

    if !wait_for_host_exit(wait) {
        rust_error!(
            "等待宿主退出超时（{:?}）：不执行替换，staged 状态保留",
            wait
        );
        return 1;
    }

    match apply_staged_update(&state_path, &state) {
        Ok(()) => {
            restart_app(&state);
            0
        }
        Err(error) => {
            rust_error!("更新安装失败: {error}");
            if current_phase(&state_path) == Some(InstallPhase::RolledBack) {
                1
            } else {
                rust_error!("回滚未完成，现场保留等待人工检查");
                3
            }
        }
    }
}

fn current_phase(path: &std::path::Path) -> Option<InstallPhase> {
    read_state(path).ok().flatten().map(|state| state.phase)
}

/// 等宿主进程退出。宿主把子进程 stdin 写端持到进程结束，这里读 EOF 即"整套进程已退"。
fn wait_for_host_exit(timeout: Duration) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut sink);
        let _ = tx.send(());
    });
    rx.recv_timeout(timeout).is_ok()
}

/// 安装主流程：重验一切 → 换目录 → 每步落盘相位。失败时尝试回滚。
pub fn apply_staged_update(state_path: &std::path::Path, state: &InstallState) -> AppResult<()> {
    // 1. 重走校验链：状态文件可能很旧，且 staged 与 helper 之间隔着一次进程退出。
    let config = super::embedded_config()?;
    let verifier = super::verify::MinisignVerifier::new(&config.release_public_key)?;
    let envelope = verify_state_envelope(state, &verifier, &config)?;
    verify_staged_files(state)?;

    // 2. 平台各自的替换路径。
    #[cfg(target_os = "macos")]
    {
        apply_macos(state_path, state, &envelope)?;
    }
    #[cfg(windows)]
    {
        apply_windows(state_path, state, &envelope)?;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = envelope;
        return Err(update_error(
            E_INSTALL_LAYOUT,
            "原生宿主只支持 macOS 与 Windows",
        ));
    }
    Ok(())
}

/// 复验状态文件里保存的 envelope：验签 → 解析 → 安装候选硬校验（与 check 同一链）。
fn verify_state_envelope(
    state: &InstallState,
    verifier: &dyn EnvelopeVerifier,
    config: &super::manifest::UpdateConfig,
) -> AppResult<super::manifest::ReleaseEnvelope> {
    verifier
        .verify(state.envelope.as_bytes(), &state.signature)
        .map_err(|e| {
            update_error(
                super::manifest::E_BAD_SIGNATURE,
                format!("staging envelope 复验失败: {e}"),
            )
        })?;
    let envelope: super::manifest::ReleaseEnvelope = serde_json::from_str(&state.envelope)
        .map_err(|e| {
            update_error(
                super::manifest::E_SCHEMA,
                format!("staging envelope 解析失败: {e}"),
            )
        })?;
    let target = super::manifest::Target::current()?;
    // 与「check 选中」同一条硬校验链；低版本闸门另对 from_version 再走一次（见 verify_staged_files）。
    super::manifest::validate_install_candidate(&envelope, config, target)?;
    Ok(envelope)
}

// ==========================================
// 平台：macOS（.app 整目录改名换位）
// ==========================================

#[cfg(target_os = "macos")]
fn apply_macos(
    state_path: &std::path::Path,
    state: &InstallState,
    envelope: &super::manifest::ReleaseEnvelope,
) -> AppResult<()> {
    let component = state
        .components
        .iter()
        .find(|c| c.kind == KIND_APP)
        .ok_or_else(|| update_error(E_STATE, "状态里没有 app 组件"))?;
    let parent = state
        .install_root
        .parent()
        .ok_or_else(|| update_error(E_INSTALL_LAYOUT, "安装目录没有父目录"))?
        .to_path_buf();
    let staged_dir = parent.join(format!(
        ".{}.staged-{}",
        state
            .install_root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "app".into()),
        state.to_version
    ));

    // 解包到安装目录同级（同卷，后续改名才能原子）。失败不留半棵树。
    if staged_dir.exists() {
        fs::remove_dir_all(&staged_dir).map_err(|e| {
            update_error(E_STATE, format!("清理旧解包目录失败 {:?}: {e}", staged_dir))
        })?;
    }
    fs::create_dir_all(&staged_dir)
        .map_err(|e| update_error(E_STATE, format!("创建解包目录失败 {:?}: {e}", staged_dir)))?;
    let unpack_guard = StagedDirGuard(staged_dir.clone());
    {
        let file = fs::File::open(&component.path)
            .map_err(|e| update_error(E_STATE, format!("打开 {:?} 失败: {e}", component.path)))?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&staged_dir)
            .map_err(|e| update_error(E_STATE, format!("解包 {:?} 失败: {e}", component.path)))?;
    }
    let new_bundle = single_app_entry(&staged_dir)?;
    validate_bundle_tree(&new_bundle, PLATFORM_MACOS, envelope)?;

    // 相位 1：备份改名（先落盘，再动作）。
    let mut phase = state.clone();
    phase.phase = InstallPhase::ApplyingBackup;
    phase.updated_at = chrono::Local::now().to_rfc3339();
    write_state(state_path, &phase)?;
    if state.backup_root.exists() {
        return Err(update_error(
            E_STATE,
            format!("备份目录已存在，拒绝覆盖：{:?}", state.backup_root),
        ));
    }
    fs::rename(&state.install_root, &state.backup_root).map_err(|e| {
        update_error(
            E_INSTALL_LAYOUT,
            format!(
                "备份改名失败 {:?} → {:?}: {e}",
                state.install_root, state.backup_root
            ),
        )
    })?;

    // 相位 2：替换改名。
    phase.phase = InstallPhase::ApplyingReplace;
    if let Err(e) = write_state(state_path, &phase) {
        // 相位落盘失败也要先把目录换回来：不能让宿主停在"安装目录缺失"的现场。
        let _ = rollback(state_path, state);
        return Err(e);
    }
    if let Err(e) = fs::rename(&new_bundle, &state.install_root) {
        // 替换失败：立刻回滚（安装目录此刻不在原位，备份完整）。
        rollback(state_path, state)?;
        return Err(update_error(
            E_INSTALL_LAYOUT,
            format!(
                "替换改名失败 {:?} → {:?}: {e}",
                new_bundle, state.install_root
            ),
        ));
    }

    // 相位 3：完成（备份保留到下一次启动清理）。
    phase.phase = InstallPhase::Installed;
    phase.updated_at = chrono::Local::now().to_rfc3339();
    if let Err(e) = write_state(state_path, &phase) {
        rust_warn!("替换已完成但相位落盘失败（下次启动恢复会补记）: {e}");
    }
    // 解包目录已被改名到安装位；guard 在 Drop 时因目录不存在而不动作。
    drop(unpack_guard);
    rust_info!("macOS 整包替换完成: {}", state.install_root.display());
    Ok(())
}

/// 只有当解包目录还在原位时才清理（改名成功后 guard 被 drop 前 disarm）。
#[cfg(target_os = "macos")]
struct StagedDirGuard(PathBuf);

#[cfg(target_os = "macos")]
impl Drop for StagedDirGuard {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(target_os = "macos")]
fn single_app_entry(dir: &std::path::Path) -> AppResult<PathBuf> {
    let mut apps = Vec::new();
    for entry in fs::read_dir(dir)
        .map_err(|e| update_error(E_STATE, format!("读取解包目录失败 {:?}: {e}", dir)))?
    {
        let entry = entry.map_err(|e| update_error(E_STATE, format!("遍历解包目录失败: {e}")))?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            && entry.file_name().to_string_lossy().ends_with(".app")
        {
            apps.push(entry.path());
        }
    }
    match apps.len() {
        1 => Ok(apps.remove(0)),
        n => Err(update_error(
            E_COMPONENTS,
            format!("归档里应恰好一个 .app 顶层目录（实际 {n} 个）"),
        )),
    }
}

// ==========================================
// 平台：Windows（备份改名 + 静默安装 + 校验）
// ==========================================

#[cfg(windows)]
fn apply_windows(
    state_path: &std::path::Path,
    state: &InstallState,
    envelope: &super::manifest::ReleaseEnvelope,
) -> AppResult<()> {
    let component = state
        .components
        .iter()
        .find(|c| c.kind == super::manifest::KIND_INSTALLER)
        .ok_or_else(|| update_error(E_STATE, "状态里没有 installer 组件"))?;

    let mut phase = state.clone();
    phase.phase = InstallPhase::ApplyingBackup;
    phase.updated_at = chrono::Local::now().to_rfc3339();
    write_state(state_path, &phase)?;
    if state.backup_root.exists() {
        return Err(update_error(
            E_STATE,
            format!("备份目录已存在，拒绝覆盖：{:?}", state.backup_root),
        ));
    }
    fs::rename(&state.install_root, &state.backup_root).map_err(|e| {
        update_error(
            E_INSTALL_LAYOUT,
            format!(
                "备份改名失败 {:?} → {:?}: {e}",
                state.install_root, state.backup_root
            ),
        )
    })?;

    phase.phase = InstallPhase::ApplyingReplace;
    if let Err(e) = write_state(state_path, &phase) {
        // 相位落盘失败也要先把目录换回来（同 macOS 分支）。
        let _ = rollback(state_path, state);
        return Err(e);
    }

    // NSIS 静默安装：/S + /D=<安装目录>（必须在最后、不加引号——NSIS 规则，含空格也不加）。
    let run = std::process::Command::new(&component.path)
        .arg("/S")
        .arg(format!("/D={}", state.install_root.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let install_ok = match run {
        Ok(status) => status.success(),
        Err(e) => {
            rust_error!("安装器启动失败: {e}");
            false
        }
    };
    // NSIS 静默模式不保证 SetErrorLevel：装完必须读现场（完整版本集合校验）。
    let verify = if install_ok {
        validate_bundle_tree(&state.install_root, PLATFORM_WINDOWS, envelope)
    } else {
        Err(update_error(E_INSTALL_LAYOUT, "安装器返回非零退出码"))
    };
    if let Err(error) = verify {
        // 失败：清掉可能半装的目录，换回上一完整版本。
        let _ = fs::remove_dir_all(&state.install_root);
        return rollback(state_path, state).map(|_| ()).and(Err(error));
    }

    phase.phase = InstallPhase::Installed;
    phase.updated_at = chrono::Local::now().to_rfc3339();
    if let Err(e) = write_state(state_path, &phase) {
        rust_warn!("替换已完成但相位落盘失败（下次启动恢复会补记）: {e}");
    }
    rust_info!("Windows 安装器替换完成: {}", state.install_root.display());
    Ok(())
}

// ==========================================
// 共用：包内完整性 / 回滚 / 重启
// ==========================================

/// 包内必须存在的条目（相对路径）。这是「不混装」的现场检查：Native、Node、JS 与
/// defaults 必须同在一个包里；再叠加 version-set.json 与签名声明的对照。
fn required_bundle_entries(platform: &str) -> Vec<&'static str> {
    match platform {
        PLATFORM_MACOS => vec![
            "Contents/MacOS/native-host",
            "Contents/MacOS/deskpet-update-helper",
            "Contents/Info.plist",
            "Contents/Resources/node/bin/node",
            "Contents/Resources/harness/main.mjs",
            "Contents/Resources/defaults",
            "Contents/Resources/version-set.json",
        ],
        PLATFORM_WINDOWS => vec![
            "native-host.exe",
            "deskpet-update-helper.exe",
            "node/node.exe",
            "harness/main.mjs",
            "defaults",
            "version-set.json",
        ],
        _ => Vec::new(),
    }
}

/// 安装前/安装后的包树校验：必需条目 + 包内版本集合必须与已签名声明一致。
pub fn validate_bundle_tree(
    root: &std::path::Path,
    platform: &str,
    envelope: &super::manifest::ReleaseEnvelope,
) -> AppResult<()> {
    let missing: Vec<&str> = required_bundle_entries(platform)
        .into_iter()
        .filter(|rel| !root.join(rel).exists())
        .collect();
    if !missing.is_empty() {
        return Err(update_error(
            E_COMPONENTS,
            format!("包内组件集不完整（缺 {missing:?}）于 {}", root.display()),
        ));
    }
    let version_set_path = version_set_path(root, platform);
    let text = fs::read_to_string(&version_set_path).map_err(|e| {
        update_error(
            E_VERSION_SET,
            format!("读取 {} 失败: {e}", version_set_path.display()),
        )
    })?;
    let bundle: BundleVersionSet = serde_json::from_str(&text).map_err(|e| {
        update_error(
            E_VERSION_SET,
            format!("解析 {} 失败: {e}", version_set_path.display()),
        )
    })?;
    super::manifest::validate_bundle_version_set(&bundle, envelope)
}

fn version_set_path(root: &std::path::Path, platform: &str) -> PathBuf {
    match platform {
        PLATFORM_MACOS => root.join("Contents/Resources").join(VERSION_SET_FILE_NAME),
        _ => root.join(VERSION_SET_FILE_NAME),
    }
}

/// 回滚：备份改名换回安装目录，并把相位标成 rolled-back（可重试要重新下载）。
fn rollback(state_path: &std::path::Path, state: &InstallState) -> AppResult<()> {
    if state.install_root.exists() {
        return Err(update_error(
            E_STATE,
            format!("回滚条件不足：安装目录仍存在 {:?}", state.install_root),
        ));
    }
    if !state.backup_root.exists() {
        return Err(update_error(
            E_STATE,
            format!("回滚条件不足：备份不存在 {:?}", state.backup_root),
        ));
    }
    fs::rename(&state.backup_root, &state.install_root).map_err(|e| {
        update_error(
            E_STATE,
            format!(
                "回滚失败 {:?} → {:?}: {e}",
                state.backup_root, state.install_root
            ),
        )
    })?;
    let mut updated = state.clone();
    updated.phase = InstallPhase::RolledBack;
    updated.updated_at = chrono::Local::now().to_rfc3339();
    if let Err(e) = write_state(state_path, &updated) {
        rust_error!("回滚已完成但状态落盘失败（下次启动恢复会重新判定）: {e}");
    }
    rust_warn!(
        "更新失败已回滚到上一完整版本: {} → {}",
        state.to_version,
        state.from_version
    );
    Ok(())
}

/// 重启应用（helper 成功后的最后一步）。
fn restart_app(state: &InstallState) {
    let result = restart_app_inner(state);
    if let Err(error) = result {
        // 重启失败不改变"已安装"结论：如实记错误（用户手动打开即用新版本）。
        rust_error!("更新已安装，但自动重启失败: {error}");
    }
}

#[cfg(target_os = "macos")]
fn restart_app_inner(state: &InstallState) -> AppResult<()> {
    // `open -n` 走 LaunchServices 正常启动新包（比直接执行包内二进制更接近用户双击）。
    std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&state.install_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| update_error(E_STATE, format!("open 启动失败: {e}")))?;
    Ok(())
}

#[cfg(windows)]
fn restart_app_inner(state: &InstallState) -> AppResult<()> {
    let exe = state.install_root.join("native-host.exe");
    std::process::Command::new(&exe)
        .current_dir(&state.install_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| update_error(E_STATE, format!("重启 {} 失败: {e}", exe.display())))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn restart_app_inner(_state: &InstallState) -> AppResult<()> {
    Err(update_error(E_INSTALL_LAYOUT, "不支持的系统"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::manifest::{Component, ReleaseEnvelope, VersionSet};
    use crate::update::stage::STATE_SCHEMA_VERSION;
    use std::path::Path;

    fn envelope(version: &str, node: &str) -> ReleaseEnvelope {
        ReleaseEnvelope {
            app_identifier: "com.v1rtual.deskpet".to_string(),
            version: version.to_string(),
            platform: crate::update::manifest::PLATFORM_MACOS.to_string(),
            arch: crate::update::manifest::ARCH_AARCH64.to_string(),
            published_at: None,
            notes: None,
            version_set: VersionSet {
                app: version.to_string(),
                node: node.to_string(),
            },
            components: vec![Component {
                kind: KIND_APP.to_string(),
                name: "app.tar.gz".to_string(),
                url: "https://example.com/app.tar.gz".to_string(),
                size: 1,
                sha256: "a".repeat(64),
            }],
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "deskpet-update-helper-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 在临时目录里造一棵"完整 .app"（假文件），供包树校验分支使用。
    fn make_bundle(root: &Path, version: &str, node: &str, entries: &[&str]) {
        for rel in entries {
            let path = root.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, b"x").unwrap();
        }
        fs::write(
            root.join("Contents/Resources/version-set.json"),
            format!(r#"{{"app":"{version}","node":"{node}","harness":"test"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn 包树完整则通过_版本集合不一致则拒绝() {
        let root = temp_root("tree");
        let entries = required_bundle_entries(PLATFORM_MACOS);
        make_bundle(&root, "0.17.0", "22.22.3", &entries);

        let env = envelope("0.17.0", "22.22.3");
        assert!(validate_bundle_tree(&root, PLATFORM_MACOS, &env).is_ok());

        // envelope 声明新 Node、包内还是旧 Node：混装，拒绝
        let mixed = envelope("0.17.0", "22.23.0");
        let err = validate_bundle_tree(&root, PLATFORM_MACOS, &mixed).unwrap_err();
        assert_eq!(err.code(), E_VERSION_SET);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn 包树缺条目则拒绝() {
        let root = temp_root("missing");
        // 故意缺 native-host（Native 缺失 = 不完整组件集）
        let entries: Vec<&str> = required_bundle_entries(PLATFORM_MACOS)
            .into_iter()
            .filter(|rel| *rel != "Contents/MacOS/native-host")
            .collect();
        make_bundle(&root, "0.17.0", "22.22.3", &entries);
        let err = validate_bundle_tree(&root, PLATFORM_MACOS, &envelope("0.17.0", "22.22.3"))
            .unwrap_err();
        assert_eq!(err.code(), E_COMPONENTS);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn 回滚要求安装目录不在原位且备份存在() {
        let root = temp_root("rollback");
        let state = InstallState {
            schema_version: STATE_SCHEMA_VERSION,
            phase: InstallPhase::ApplyingReplace,
            from_version: "0.16.0".to_string(),
            to_version: "0.17.0".to_string(),
            updated_at: "now".to_string(),
            install_root: root.join("install"),
            backup_root: root.join("backup"),
            staging_root: root.join("staging"),
            log_dir: root.join("logs"),
            envelope: "{}".to_string(),
            signature: "sig".to_string(),
            components: vec![],
            restart: true,
        };
        // 安装目录还在：拒绝回滚（不覆盖现场）
        fs::create_dir_all(&state.install_root).unwrap();
        assert!(rollback(&root.join("state.json"), &state).is_err());

        // 备份缺失：拒绝回滚
        fs::remove_dir_all(&state.install_root).unwrap();
        assert!(rollback(&root.join("state.json"), &state).is_err());

        fs::remove_dir_all(&root).unwrap();
    }
}
