// ==========================================
// 聊天图片准入：transport 无关的普通函数，本地资源授权经 [`AssetScopePort`]、
// 原生文件对话框经 [`FileDialogPort`] 显式注入。
//
// 准入（数量/大小/格式头/路径规则）的唯一实现是统一图片域：数值单源
// `src/services/images/limits.json`（经 `images::limits`），路径与格式复核走
// `images::validate::ValidatedImagePath`；本文件不保留第二份解析或嗅探。
// ==========================================

use crate::error::{AppError, AppResult};
use crate::host::{AssetScopePort, FileDialogPort};
use crate::images::{limits, validate::ValidatedImagePath};

/// 只校验并授权原路径预览，不复制、不写图片文件。
///
/// 每消息最多 `maxImages` 张、每图不超过 `maxBytes`（图片域统一入口），
/// 格式集合为 PNG/JPEG/GIF/WebP/BMP（字节头判定）；任一路径被拒时整批返回该错误。
pub fn validate_chat_images(
    assets: &dyn AssetScopePort,
    paths: Vec<String>,
) -> AppResult<Vec<String>> {
    let limits = limits::image_limits()?;
    if paths.len() > limits.max_images {
        return Err(AppError::Tool(format!(
            "每条消息最多 {} 张图片",
            limits.max_images
        )));
    }
    let mut accepted = Vec::new();
    for path in paths {
        // 准入复核在统一图片域；授权是命令层的独立动作，校验通过后经 AssetScopePort 完成。
        let validated = ValidatedImagePath::validate(&path, Some(limits.max_bytes))?;
        assets.allow_file(validated.as_path())?;
        let path = validated.as_path().to_string_lossy().into_owned();
        if !accepted.contains(&path) {
            accepted.push(path);
        }
    }
    Ok(accepted)
}

/// 原生多选图片对话框；用户取消是**正常结果**（端口返回空数组），不是错误。
/// 选取结果复用 [`validate_chat_images`] 的准入校验，不复制第二份规则。
/// 同步阻塞（对话框本身阻塞），async 包装（spawn_blocking）由 IPC 分派层负责。
pub fn pick_chat_images(
    dialogs: &dyn FileDialogPort,
    assets: &dyn AssetScopePort,
) -> AppResult<Vec<String>> {
    let paths = dialogs.pick_images()?;
    validate_chat_images(assets, paths)
}
