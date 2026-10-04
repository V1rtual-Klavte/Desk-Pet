use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use serde::Deserialize;
use std::io::Read;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageLimits { max_images: usize, max_bytes: u64 }

fn image_limits() -> AppResult<ImageLimits> {
    serde_json::from_str(include_str!("../../../src/services/images/limits.json"))
        .map_err(|e| AppError::Config(format!("图片限制配置无效: {e}")))
}

/// 只校验并授权原路径预览，不复制、不写图片文件。
#[tauri::command]
pub fn validate_chat_images(app: tauri::AppHandle, paths: Vec<String>) -> AppResult<Vec<String>> {
    let limits = image_limits()?;
    if paths.len() > limits.max_images {
        return Err(AppError::Tool(format!("每条消息最多 {} 张图片", limits.max_images)));
    }
    let mut accepted = Vec::new();
    for path in paths {
        let canonical = AppPaths::validate_file_path(Path::new(&path))?;
        let metadata = std::fs::metadata(&canonical).map_err(|e| AppError::Io(format!("读取图片元数据失败: {e}")))?;
        if !metadata.is_file() || metadata.len() > limits.max_bytes {
            return Err(AppError::Tool(format!("图片须为常规文件且不超过 {} MiB", limits.max_bytes / 1024 / 1024)));
        }
        let mut file = std::fs::File::open(&canonical).map_err(|e| AppError::Io(format!("打开图片失败: {e}")))?;
        let mut header = [0u8; 16];
        let length = file.read(&mut header).map_err(|e| AppError::Io(format!("读取图片失败: {e}")))?;
        let supported = header.starts_with(b"\x89PNG\r\n\x1a\n") || header.starts_with(b"\xff\xd8\xff")
            || header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") || header.starts_with(b"BM")
            || (length >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP");
        if !supported { return Err(AppError::Tool("文件不是受支持的 PNG/JPEG/GIF/WebP/BMP 图片".into())); }
        app.asset_protocol_scope().allow_file(&canonical)
            .map_err(|e| AppError::Io(format!("授权图片预览失败: {e}")))?;
        let path = canonical.to_string_lossy().into_owned();
        if !accepted.contains(&path) { accepted.push(path); }
    }
    Ok(accepted)
}

#[tauri::command]
pub async fn pick_chat_images(app: tauri::AppHandle) -> AppResult<Vec<String>> {
    let picker_app = app.clone();
    let paths = tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<String>> {
        let picked = picker_app.dialog().file().add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
            .blocking_pick_files();
        picked.unwrap_or_default().into_iter().map(|file| {
            file.into_path().map(|path| path.to_string_lossy().into_owned())
                .map_err(|e| AppError::Io(format!("图片路径无效: {e}")))
        }).collect()
    }).await.map_err(|e| AppError::Tool(format!("图片选择任务失败: {e}")))??;
    validate_chat_images(app, paths)
}
