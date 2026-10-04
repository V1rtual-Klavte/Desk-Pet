use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use xcap::{image::{imageops::FilterType, DynamicImage, ImageFormat}, Window};

use crate::error::{AppError, AppResult};
use crate::monitor::{self, MonitorState};
use crate::paths::{is_credential_path, AppPaths};
use crate::rust_debug;

const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024;
const MAX_SCREEN_EDGE: u32 = 1280;
const MAX_SCREENSHOT_BYTES: usize = 8 * 1024 * 1024;
const MIN_IDLE_MS: u64 = 30 * 60_000;

/// CONFIG-selected directory, held as a runtime path derivation rather than a second config store.
#[derive(Default)]
pub(crate) struct ObservationState {
    project_root: Mutex<Option<PathBuf>>,
    revision: AtomicU64,
}

#[tauri::command]
pub fn set_observation_project_root(window: tauri::WebviewWindow, root: String, state: State<'_, ObservationState>) -> AppResult<()> {
    if !matches!(window.label(), "main" | "e2e") { return Err(AppError::PathEscape); }
    let mut selected = state.project_root.lock().unwrap_or_else(|error| error.into_inner());
    state.revision.fetch_add(1, Ordering::SeqCst);
    *selected = None;
    if !root.is_empty() { *selected = Some(validate_project_root(Path::new(&root))?); }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCapture {
    data: String,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationTextFile {
    name: String,
    content: String,
}

fn require_enabled(state: &MonitorState) -> AppResult<()> {
    if state.enabled.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err(AppError::Cancelled)
    }
}

fn require_idle_observation(app: &tauri::AppHandle, state: &MonitorState) -> AppResult<()> {
    require_enabled(state)?;
    let current = monitor::runtime_activity(app);
    if current.observation_state != "observed" || current.is_pet_foreground
        || current.idle_for_ms.map_or(true, |idle| idle < MIN_IDLE_MS) {
        return Err(AppError::Cancelled);
    }
    Ok(())
}

fn validate_project_root(path: &Path) -> AppResult<PathBuf> {
    let canonical = AppPaths::validate_file_path(path)?;
    if !canonical.is_dir() || is_credential_path(&canonical) {
        return Err(AppError::PathEscape);
    }
    let has_project_marker = [".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod"]
        .iter()
        .any(|marker| canonical.join(marker).exists());
    if !has_project_marker {
        return Err(AppError::Other("请选择包含项目标记的目录".into()));
    }
    Ok(canonical)
}

/// Open the native folder picker and return only a canonical, allowed project root.
#[tauri::command]
pub async fn pick_observation_project(app: tauri::AppHandle) -> AppResult<Option<String>> {
    let Some(selected) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    let path = selected.into_path().map_err(|_| AppError::Other("所选项目目录路径无效".into()))?;
    let canonical = validate_project_root(&path)?;
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

/// Capture only the foreground window. The encoded bytes exist in memory for the IPC response;
/// this command never creates a screenshot file or returns executable paths/window titles.
#[tauri::command]
pub fn observation_capture_screen(app: tauri::AppHandle, state: State<'_, Arc<MonitorState>>) -> AppResult<ScreenCapture> {
    require_idle_observation(&app, &state)?;
    let windows = Window::all().map_err(|_| AppError::Other("无法枚举前台窗口".into()))?;
    let mut focused = None;
    for window in windows {
        if window.is_focused().map_err(|_| AppError::Other("无法确定前台窗口".into()))? {
            focused = Some(window);
            break;
        }
    }
    let window = focused.ok_or_else(|| AppError::Other("没有可捕获的前台窗口".into()))?;
    let image = window.capture_image().map_err(|_| AppError::Other("截图不可用".into()))?;
    require_idle_observation(&app, &state)?;

    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err(AppError::Other("截图尺寸无效".into()));
    }
    let scale = (MAX_SCREEN_EDGE as f64 / width.max(height) as f64).min(1.0);
    let target_width = ((width as f64 * scale).round() as u32).max(1);
    let target_height = ((height as f64 * scale).round() as u32).max(1);
    let resized = if target_width == width && target_height == height {
        image
    } else {
        xcap::image::imageops::resize(&image, target_width, target_height, FilterType::Triangle)
    };
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(resized)
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| AppError::Other("截图编码失败".into()))?;
    let bytes = png.into_inner();
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err(AppError::Other("截图超过内存传输上限".into()));
    }
    require_idle_observation(&app, &state)?;
    Ok(ScreenCapture { data: STANDARD.encode(bytes), mime_type: "image/png", width: target_width, height: target_height })
}

/// Read the two fixed files below the CONFIG-derived, main-window-owned project root.
/// Callers supply neither a root nor a relative filename. The root generation, project markers,
/// credential boundary and canonical leaf paths are rechecked before returning content.
#[tauri::command]
pub fn observation_read_project_notes(
    app: tauri::AppHandle,
    state: State<'_, Arc<MonitorState>>,
    observation: State<'_, ObservationState>,
) -> AppResult<Vec<ObservationTextFile>> {
    require_idle_observation(&app, &state)?;
    let guard = observation.project_root.lock().unwrap_or_else(|error| error.into_inner());
    let revision = observation.revision.load(Ordering::SeqCst);
    let Some(selected) = guard.clone() else { return Ok(Vec::new()); };
    drop(guard);
    let anchor_path = validate_project_root(&selected)?;
    if anchor_path != selected { return Err(AppError::PathEscape); }

    let mut output = Vec::with_capacity(2);
    for name in ["README.md", "NOTES.md"] {
        if observation.revision.load(Ordering::SeqCst) != revision { return Err(AppError::Cancelled); }
        require_idle_observation(&app, &state)?;
        let candidate: PathBuf = anchor_path.join(name);
        if is_credential_path(&candidate) {
            return Err(AppError::SensitivePath);
        }
        let canonical = match candidate.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // README.md / NOTES.md are optional hand-near sources; absence is an ordinary
                // empty result, while other filesystem failures remain explicit AppErrors.
                rust_debug!("静默观察跳过不存在的可选文件: {name}");
                continue;
            }
            Err(error) => return Err(AppError::Io(format!("解析观察文件路径失败: {error}"))),
        };
        if !canonical.starts_with(&anchor_path) {
            return Err(AppError::PathEscape);
        }
        let metadata = std::fs::symlink_metadata(&candidate)
            .map_err(|error| AppError::Io(format!("读取观察文件元数据失败: {error}")))?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_TEXT_FILE_BYTES {
            rust_debug!("静默观察跳过非普通文件或超限文件: {name}");
            continue;
        }
        let mut content = String::new();
        std::fs::File::open(&canonical)
            .and_then(|file| file.take(MAX_TEXT_FILE_BYTES + 1).read_to_string(&mut content))
            .map_err(|error| AppError::Io(format!("读取观察文件失败: {error}")))?;
        if content.len() as u64 > MAX_TEXT_FILE_BYTES {
            rust_debug!("静默观察跳过读取中增长到上限外的文件: {name}");
            continue;
        }
        require_idle_observation(&app, &state)?;
        if observation.revision.load(Ordering::SeqCst) != revision { return Err(AppError::Cancelled); }
        output.push(ObservationTextFile { name: name.to_string(), content });
    }
    if observation.revision.load(Ordering::SeqCst) != revision { return Err(AppError::Cancelled); }
    Ok(output)
}
