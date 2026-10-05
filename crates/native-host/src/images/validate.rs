//! 图片原文件路径校验（路径规则、常规文件、字节上限、格式头）。
//!
//! 这是请求附件与查看器预览共用的「原路径复核」：只读不写、不复制文件、不改写原图。
//! 校验结论只代表创建/复核时刻的磁盘状态；点击打开查看器时必须重新复核
//! （[`ValidatedImagePath::revalidate`]），不缓存旧结论。

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;

use super::format;

/// 已按 Rust 路径规则复核通过的图片原文件路径。
///
/// 准入口径与 `validate_chat_images` 一致（绝对/允许根/凭据/记忆保护/格式头/大小），
/// 但**不做 asset 授权**：授权是命令层经 [`crate::host::AssetScopePort`] 的独立动作。
#[derive(Debug, Clone)]
pub struct ValidatedImagePath {
    path: PathBuf,
    max_bytes: Option<u64>,
}

impl ValidatedImagePath {
    /// 校验请求路径。`max_bytes` 为 `None` 时只要求常规文件；`Some(limit)` 时与
    /// 聊天图片准入同文案（「图片须为常规文件且不超过 X MiB」）。
    pub fn validate(requested: &str, max_bytes: Option<u64>) -> AppResult<Self> {
        let canonical = AppPaths::validate_file_path(Path::new(requested))?;
        let metadata = std::fs::metadata(&canonical)
            .map_err(|e| AppError::Io(format!("读取图片元数据失败: {e}")))?;
        match max_bytes {
            Some(limit) => {
                if !metadata.is_file() || metadata.len() > limit {
                    return Err(AppError::Tool(format!(
                        "图片须为常规文件且不超过 {} MiB",
                        limit / 1024 / 1024
                    )));
                }
            }
            None => {
                if !metadata.is_file() {
                    return Err(AppError::Tool("图片须为常规文件".into()));
                }
            }
        }
        let mut file =
            File::open(&canonical).map_err(|e| AppError::Io(format!("打开图片失败: {e}")))?;
        format::sniff_reader(&mut file)?;
        Ok(Self {
            path: canonical,
            max_bytes,
        })
    }

    /// 点击/打开时刻的复核：对同一路径重新跑完整校验（路径规则 + 磁盘状态 + 格式头），
    /// 不信任创建时的旧结论。失效原因按 [`AppError`] 变体如实返回，不静默降级。
    pub fn revalidate(&self) -> AppResult<Self> {
        Self::validate(&self.path.to_string_lossy(), self.max_bytes)
    }

    pub fn as_path(&self) -> &Path {
        &self.path
    }
}

/// 有界读取：最多读 `limit` 字节。返回 `Ok(None)` 表示内容超出上限（校验与读取之间
/// 文件被替换/追加的竞态），由调用方按各自口径报错——绝不先读全量再判断。
pub(crate) fn read_within(path: &Path, limit: u64) -> AppResult<Option<Vec<u8>>> {
    let file = File::open(path).map_err(|e| AppError::Io(format!("读取图片失败: {e}")))?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::Io(format!("读取图片失败: {e}")))?;
    if bytes.len() as u64 > limit {
        return Ok(None);
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::fixtures;
    use std::io::Write;

    fn temp_image(tag: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
        let dir = fixtures::temp_dir(tag);
        let path = dir.join("input.bin");
        let mut file = File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn accepts_supported_regular_file_and_reports_canonical_path() {
        let (dir, path) = temp_image("validate-ok", &fixtures::png_1x1());
        let validated =
            ValidatedImagePath::validate(&path.to_string_lossy(), Some(15 * 1024 * 1024))
                .expect("合法 PNG 必须通过");
        assert!(validated.as_path().is_absolute());
        assert_eq!(validated.as_path(), path.canonicalize().unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_missing_path_with_explicit_reason() {
        let dir = fixtures::temp_dir("validate-missing");
        let missing = dir.join("missing.png");
        let error = ValidatedImagePath::validate(&missing.to_string_lossy(), None).unwrap_err();
        assert_eq!(error.code(), "PATH_NOT_FOUND");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_directory_and_credential_and_unsupported_format() {
        let dir = fixtures::temp_dir("validate-reject");
        let as_dir = ValidatedImagePath::validate(&dir.to_string_lossy(), None).unwrap_err();
        assert!(as_dir.to_string().contains("常规文件"), "文案：{as_dir}");

        // 凭据形态优先于磁盘状态：不存在的 .ssh 路径也必须报凭据拒绝。
        let ssh = dir.join(".ssh/id_rsa");
        let credential = ValidatedImagePath::validate(&ssh.to_string_lossy(), None).unwrap_err();
        assert_eq!(credential.code(), "SENSITIVE_PATH");

        let text = dir.join("notes.txt");
        std::fs::write(&text, b"just text").unwrap();
        let unsupported = ValidatedImagePath::validate(&text.to_string_lossy(), None).unwrap_err();
        assert!(
            unsupported.to_string().contains("PNG/JPEG/GIF/WebP/BMP"),
            "文案：{unsupported}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_files_over_byte_limit_with_admission_message() {
        let (dir, path) = temp_image("validate-size", &fixtures::png_1x1());
        let limit = 16u64; // 比 1x1 PNG 更小，用极小的测试上限驱动同一分支
        let error = ValidatedImagePath::validate(&path.to_string_lossy(), Some(limit)).unwrap_err();
        assert!(error.to_string().contains("不超过"), "文案：{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bounded_read_refuses_content_grown_past_the_limit() {
        let (dir, path) = temp_image("validate-bounded", &[7u8; 64]);
        assert_eq!(
            read_within(&path, 64).unwrap().map(|bytes| bytes.len()),
            Some(64)
        );
        // 上限比实际内容小：必须如实拒绝，而不是先读全量再报错。
        assert!(read_within(&path, 63).unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn revalidate_detects_file_removed_after_first_check() {
        let (dir, path) = temp_image("validate-revalidate", &fixtures::png_1x1());
        let validated = ValidatedImagePath::validate(&path.to_string_lossy(), None).unwrap();
        std::fs::remove_file(&path).unwrap();
        let error = validated.revalidate().unwrap_err();
        assert_eq!(error.code(), "PATH_NOT_FOUND");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
