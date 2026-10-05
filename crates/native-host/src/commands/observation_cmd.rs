//! 静默了解的命令面：transport 无关的普通函数。IPC 层只做参数提取后转发；
//! 业务判定不复制到 IPC 层。
//!
//! 入参是全显式依赖：窗口状态经 [`WindowPort`]，许可与空闲资格由 [`MonitorState`]
//! 终裁，路径边界由 [`AppPaths`] 提供。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::Ordering;
use xcap::Window;

use crate::error::{AppError, AppResult};
use crate::host::WindowPort;
use crate::images::screenshot::encode_screenshot;
use crate::monitor::{runtime_activity, MonitorState, RuntimeActivity};
use crate::paths::{home_dir, is_credential_path, AppPaths};
use crate::rust_debug;

/// 静默了解的空闲地板：档位值由 Node 侧强制、只会更严，Rust 终裁不低于 30 分钟。
const MIN_IDLE_MS: u64 = 30 * 60_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCapture {
    data: String,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

/// 决策调用给出的读取目标；路径由模型提出，边界由本命令逐项重校验。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTarget {
    path: String,
    kind: String,
}

/// 逐目标结果：`status` 为 read/listed/skipped，skipped 附带如实原因；
/// 单项失败不终止整批，也不猜测内容。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetReadResult {
    path: String,
    kind: String,
    status: &'static str,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

fn require_enabled(state: &MonitorState) -> AppResult<()> {
    if state.enabled.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err(AppError::Cancelled)
    }
}

/// 静默了解（读取类）资格口径：`screen_state ∈ {observed, locked}` —— 锁屏=用户离开，
/// 读取不依赖屏幕内容；`unavailable`（真不可知）、桌宠前台、空闲未达地板都拒绝。
/// 判定拆成纯函数：资格语义在没有系统采样桩的环境下也能被单测钉住。
fn idle_observation_allowed(current: &RuntimeActivity) -> bool {
    matches!(current.screen_state, "observed" | "locked")
        && !current.is_pet_foreground
        && !current.idle_for_ms.map_or(true, |idle| idle < MIN_IDLE_MS)
}

/// 截图类资格：在读取资格之上追加屏幕维度 —— 锁屏时截图无意义，仅 `observed` 放行。
fn idle_capture_allowed(current: &RuntimeActivity) -> bool {
    idle_observation_allowed(current) && current.screen_state == "observed"
}

fn require_idle_observation(window: &dyn WindowPort, state: &MonitorState) -> AppResult<()> {
    require_enabled(state)?;
    let current = runtime_activity(window);
    if !idle_observation_allowed(&current) {
        return Err(AppError::Cancelled);
    }
    Ok(())
}

/// 截图类终裁：沿用既有拒绝语义（`AppError::Cancelled`，不新增错误变体）。
fn require_idle_capture(window: &dyn WindowPort, state: &MonitorState) -> AppResult<()> {
    require_enabled(state)?;
    let current = runtime_activity(window);
    if !idle_capture_allowed(&current) {
        return Err(AppError::Cancelled);
    }
    Ok(())
}

/// Capture only the foreground window. The encoded bytes exist in memory for the IPC response;
/// this command never creates a screenshot file or returns executable paths/window titles.
/// 截图类资格在读取资格之上要求屏幕 `observed`：锁屏时截图无意义，直接拒绝。
pub fn observation_capture_screen(
    port: &dyn WindowPort,
    state: &MonitorState,
) -> AppResult<ScreenCapture> {
    require_idle_capture(port, state)?;
    let windows = Window::all().map_err(|_| AppError::Other("无法枚举前台窗口".into()))?;
    let mut focused = None;
    for window in windows {
        if window
            .is_focused()
            .map_err(|_| AppError::Other("无法确定前台窗口".into()))?
        {
            focused = Some(window);
            break;
        }
    }
    let window = focused.ok_or_else(|| AppError::Other("没有可捕获的前台窗口".into()))?;
    let image = window
        .capture_image()
        .map_err(|_| AppError::Other("截图不可用".into()))?;
    require_idle_capture(port, state)?;

    // 缩放/编码统一走图片域的 `encode_screenshot`（契约 §2.1/§5.4：解码/缩放/编码集中
    // 到 Rust 图片域，不给截图另建缩放器）。口径逐项固定为：
    // 长边 1280（`fit_dimensions` 与本地公式同为 min(1.0)+round+max(1)）、
    // Triangle 滤波、PNG、8 MiB 传输上限；「尺寸无效 / 编码失败 / 超传输上限」的
    // 错误文案与错误码由该实现给出，调用方可见行为不变。
    let encoded = encode_screenshot(&image)?;
    require_idle_capture(port, state)?;
    Ok(ScreenCapture {
        data: STANDARD.encode(encoded.bytes),
        mime_type: encoded.mime_type,
        width: encoded.width,
        height: encoded.height,
    })
}

fn skipped(path: &str, kind: &str, detail: impl Into<String>) -> TargetReadResult {
    TargetReadResult {
        path: path.to_string(),
        kind: kind.to_string(),
        status: "skipped",
        detail: detail.into(),
        names: None,
        content: None,
    }
}

/// 主目录内的系统/应用配置一级目录：macOS `~/Library`、Windows `~/AppData`。
/// 只按相对 home 的顶层组件判定（深层出现同名目录不受影响）；home 本身允许。
fn is_home_system_dir(canonical: &Path, home: &Path) -> bool {
    let Ok(relative) = canonical.strip_prefix(home) else {
        return true;
    };
    let Some(component) = relative.components().next() else {
        return false;
    };
    let name = component.as_os_str().to_string_lossy();
    if cfg!(target_os = "macos") && name.as_ref() == "Library" {
        return true;
    }
    if cfg!(target_os = "windows")
        && (name.eq_ignore_ascii_case("AppData") || name.eq_ignore_ascii_case("Application Data"))
    {
        return true;
    }
    false
}

fn list_directory(requested: &str, canonical: &Path) -> TargetReadResult {
    let metadata = match std::fs::metadata(canonical) {
        Ok(metadata) => metadata,
        Err(error) => return skipped(requested, "dir", format!("读取目录元数据失败（{error}）")),
    };
    if !metadata.is_dir() {
        return skipped(requested, "dir", "目标不是目录");
    }
    let entries = match std::fs::read_dir(canonical) {
        Ok(entries) => entries,
        Err(error) => return skipped(requested, "dir", format!("读取目录失败（{error}）")),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            // 单项读失败不代表目录不可读；根因留痕在 rust_debug，不中断列举。
            Err(error) => {
                rust_debug!("静默观察跳过不可读目录项: {error}");
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || is_credential_path(Path::new(&name)) {
            continue;
        }
        names.push(name);
    }
    names.sort();
    TargetReadResult {
        path: requested.to_string(),
        kind: "dir".to_string(),
        status: "listed",
        detail: String::new(),
        names: Some(names),
        content: None,
    }
}

fn read_text_file(requested: &str, canonical: &Path) -> TargetReadResult {
    let metadata = match std::fs::symlink_metadata(canonical) {
        Ok(metadata) => metadata,
        Err(error) => return skipped(requested, "file", format!("读取文件元数据失败（{error}）")),
    };
    if !metadata.file_type().is_file() {
        return skipped(requested, "file", "目标不是常规文件");
    }
    let mut content = String::new();
    if let Err(error) =
        std::fs::File::open(canonical).and_then(|mut file| file.read_to_string(&mut content))
    {
        // 没有字节上限：整读；UTF-8 失败等 IO 错误按既有 skipped 如实回执。
        return skipped(requested, "file", format!("读取文件失败（{error}）"));
    }
    TargetReadResult {
        path: requested.to_string(),
        kind: "file".to_string(),
        status: "read",
        detail: String::new(),
        names: None,
        content: Some(content),
    }
}

/// 单项校验：绝对路径、canonical 解析（失败如实回执，不退回词法路径）、主目录之内、
/// 数据根之外、非凭据路径、非主目录系统目录；通过后按 kind 读取。
fn read_one_target(target: &ReadTarget, home: &Path, data_root: &Path) -> TargetReadResult {
    let requested = target.path.trim();
    let kind = target.kind.as_str();
    if kind != "dir" && kind != "file" {
        return skipped(requested, kind, "未知的读取类型");
    }
    if !Path::new(requested).is_absolute() {
        return skipped(requested, kind, "路径必须是绝对路径");
    }
    let canonical = match Path::new(requested).canonicalize() {
        Ok(path) => path,
        Err(error) => return skipped(requested, kind, format!("路径无法解析（{error}）")),
    };
    if !canonical.starts_with(home) {
        return skipped(requested, kind, "只允许读取用户主目录内的路径");
    }
    if canonical.starts_with(data_root) {
        return skipped(requested, kind, "应用数据目录不允许读取");
    }
    // 词法名与解析结果都判一次：链接名可以无害，真实指向才现形（与 validate_file_path 同口径）。
    if is_credential_path(Path::new(requested)) || is_credential_path(&canonical) {
        return skipped(requested, kind, "凭据路径不允许读取");
    }
    if is_home_system_dir(&canonical, home) {
        return skipped(requested, kind, "系统目录不允许读取");
    }
    if kind == "dir" {
        list_directory(requested, &canonical)
    } else {
        read_text_file(requested, &canonical)
    }
}

/// 读取静默了解批次里模型判断的本地目标。许可与空闲资格沿用 MonitorState 终裁
/// （关闭/不满足即 CANCELLED 终止整批）；**读什么、读多少由调用方（模型决策）裁断，
/// 边界由本命令终裁**：绝对路径、canonical 解析、主目录之内、数据根之外、非凭据路径、
/// 非 home 系统目录。目录全量列名（仍跳隐藏与凭据项），文件整读（UTF-8 失败按既有
/// skipped 如实回执）；单项边界失败以 skipped 回执，绝不猜测内容或静默回退。
pub fn observation_read_targets(
    port: &dyn WindowPort,
    monitor: &MonitorState,
    paths: &AppPaths,
    targets: Vec<ReadTarget>,
) -> AppResult<Vec<TargetReadResult>> {
    require_idle_observation(port, monitor)?;
    let home = home_dir().ok_or(AppError::NoHomeDir)?;
    let home = home
        .canonicalize()
        .map_err(|error| AppError::Io(format!("无法解析用户主目录: {error}")))?;
    // 数据根必须参与边界判定；解析失败时 fail closed（不放行任何目标），
    // 静默退回「没有数据根」会让会话与记忆目录变成可读。
    let data_root = paths
        .data_root
        .canonicalize()
        .map_err(|error| AppError::Io(format!("无法解析应用数据根: {error}")))?;
    let mut output = Vec::with_capacity(targets.len());
    for target in &targets {
        require_idle_observation(port, monitor)?;
        output.push(read_one_target(target, &home, &data_root));
    }
    require_idle_observation(port, monitor)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 建一个临时「主目录 + 数据根」，并 canonicalize（与命令入口同口径）。
    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "deskpet-observation-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        let home = root.join("home");
        let data_root = home.join("deskpet-data");
        std::fs::create_dir_all(data_root.join("sessions")).unwrap();
        let home = home.canonicalize().unwrap();
        let data_root = data_root.canonicalize().unwrap();
        (home, data_root)
    }

    fn target(path: &Path, kind: &str) -> ReadTarget {
        ReadTarget {
            path: path.to_string_lossy().into_owned(),
            kind: kind.to_string(),
        }
    }

    #[test]
    fn rejects_non_absolute_unknown_kind_and_missing_paths() {
        let (home, data_root) = fixture();
        let relative = read_one_target(
            &ReadTarget {
                path: "notes.txt".into(),
                kind: "file".into(),
            },
            &home,
            &data_root,
        );
        assert_eq!(relative.status, "skipped");
        assert!(relative.detail.contains("绝对路径"));

        let unknown = read_one_target(&target(&home.join("a.txt"), "exe"), &home, &data_root);
        assert_eq!(unknown.status, "skipped");

        let missing = read_one_target(
            &target(&home.join("missing.txt"), "file"),
            &home,
            &data_root,
        );
        assert_eq!(missing.status, "skipped");
        assert!(missing.content.is_none());
    }

    #[test]
    fn rejects_paths_outside_home_and_inside_data_root() {
        let (home, data_root) = fixture();
        let outside = home.parent().unwrap().join("outside.txt");
        std::fs::write(&outside, "outside").unwrap();
        let escaped = read_one_target(&target(&outside, "file"), &home, &data_root);
        assert_eq!(escaped.status, "skipped");
        assert!(escaped.detail.contains("主目录"));

        let session = data_root.join("sessions/s.jsonl");
        std::fs::write(&session, "{}").unwrap();
        let protected = read_one_target(&target(&session, "file"), &home, &data_root);
        assert_eq!(protected.status, "skipped");
        assert!(protected.detail.contains("数据目录"));
    }

    #[test]
    fn rejects_credential_paths_by_name_and_by_canonical_target() {
        let (home, data_root) = fixture();
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(&ssh).unwrap();
        std::fs::write(ssh.join("id_rsa"), "secret").unwrap();
        let credential = read_one_target(&target(&ssh.join("id_rsa"), "file"), &home, &data_root);
        assert_eq!(credential.status, "skipped");
        assert!(credential.content.is_none());

        let pem = home.join("token.pem");
        std::fs::write(&pem, "secret").unwrap();
        let suffix = read_one_target(&target(&pem, "file"), &home, &data_root);
        assert_eq!(suffix.status, "skipped");
    }

    #[test]
    fn lists_directory_names_without_hidden_or_credential_entries() {
        let (home, data_root) = fixture();
        let dir = home.join("work");
        std::fs::create_dir_all(&dir).unwrap();
        for index in 0..45 {
            std::fs::write(dir.join(format!("file-{index:02}.txt")), "x").unwrap();
        }
        std::fs::write(dir.join(".hidden"), "x").unwrap();
        std::fs::write(dir.join("server.pem"), "x").unwrap();

        // 目录全量列举（旧实现 40 条截断已删除）：45 个条目全部回，仍跳隐藏与凭据项。
        let listed = read_one_target(&target(&dir, "dir"), &home, &data_root);
        assert_eq!(listed.status, "listed");
        let names = listed.names.unwrap();
        assert_eq!(names.len(), 45);
        assert_eq!(names.first().map(String::as_str), Some("file-00.txt"));
        assert_eq!(names.last().map(String::as_str), Some("file-44.txt"));
        assert!(!names
            .iter()
            .any(|name| name == ".hidden" || name == "server.pem"));
        assert!(listed.content.is_none());
    }

    #[test]
    fn file_reads_are_whole_and_kind_mismatches_are_skipped() {
        let (home, data_root) = fixture();
        let small = home.join("notes.md");
        std::fs::write(&small, "hello").unwrap();
        let read = read_one_target(&target(&small, "file"), &home, &data_root);
        assert_eq!(read.status, "read");
        assert_eq!(read.content.as_deref(), Some("hello"));

        // 没有字节上限（旧实现 32KB 截断已删除）：大文件整读。
        let big_bytes = 96 * 1024;
        let big = home.join("big.txt");
        std::fs::write(&big, vec![b'a'; big_bytes]).unwrap();
        let whole = read_one_target(&target(&big, "file"), &home, &data_root);
        assert_eq!(whole.status, "read");
        assert_eq!(whole.content.map(|content| content.len()), Some(big_bytes));

        // 非 UTF-8 文件按既有 skipped 如实回执，不猜测内容。
        let binary = home.join("binary.dat");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        let invalid_utf8 = read_one_target(&target(&binary, "file"), &home, &data_root);
        assert_eq!(invalid_utf8.status, "skipped");
        assert!(invalid_utf8.content.is_none());

        let as_dir = read_one_target(&target(&small, "dir"), &home, &data_root);
        assert_eq!(as_dir.status, "skipped");
        let dir = home.join("folder");
        std::fs::create_dir_all(&dir).unwrap();
        let as_file = read_one_target(&target(&dir, "file"), &home, &data_root);
        assert_eq!(as_file.status, "skipped");
    }

    fn activity(
        screen_state: &'static str,
        idle_for_ms: Option<u64>,
        is_pet_foreground: bool,
    ) -> RuntimeActivity {
        RuntimeActivity {
            is_pet_visible: true,
            is_pet_foreground,
            screen_state,
            idle_for_ms,
            observed_at: 0,
        }
    }

    #[test]
    fn locked_gates_reads_in_but_rejects_capture() {
        // 锁屏=用户离开：读取放行（终裁 `screen_state ∈ {observed, locked}`）、截图拒绝。
        let locked = activity("locked", Some(MIN_IDLE_MS), false);
        assert!(idle_observation_allowed(&locked));
        assert!(!idle_capture_allowed(&locked));

        // 未锁屏：读取与截图都放行（空闲正好等于地板也放行）。
        let observed = activity("observed", Some(MIN_IDLE_MS), false);
        assert!(idle_observation_allowed(&observed));
        assert!(idle_capture_allowed(&observed));

        // 真不可知：两者都拒绝。
        let unavailable = activity("unavailable", Some(MIN_IDLE_MS), false);
        assert!(!idle_observation_allowed(&unavailable));
        assert!(!idle_capture_allowed(&unavailable));

        // 既有排除项不变：桌宠前台、空闲不足/未知。
        assert!(!idle_observation_allowed(&activity(
            "observed",
            Some(MIN_IDLE_MS),
            true
        )));
        assert!(!idle_observation_allowed(&activity(
            "locked",
            Some(MIN_IDLE_MS - 1),
            false
        )));
        assert!(!idle_observation_allowed(&activity("locked", None, false)));
    }

    #[test]
    fn home_system_dirs_are_skipped_only_on_their_platform() {
        let (home, data_root) = fixture();
        let library = home.join("Library/Preferences");
        std::fs::create_dir_all(&library).unwrap();
        std::fs::write(library.join("x.plist"), "x").unwrap();
        let result = read_one_target(&target(&library.join("x.plist"), "file"), &home, &data_root);
        if cfg!(target_os = "macos") {
            assert_eq!(result.status, "skipped");
            assert!(result.detail.contains("系统目录"));
        } else {
            assert_eq!(result.status, "read");
        }
    }
}
