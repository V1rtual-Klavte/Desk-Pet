// ==========================================
// 聊天图片准入：transport 无关的普通函数，本地资源授权经 [`AssetScopePort`]、
// 原生文件对话框经 [`FileDialogPort`] 显式注入。
//
// 准入（数量/大小/格式头/路径规则）的唯一实现是统一图片域：数值单源
// `src/services/images/limits.json`（经 `images::limits`），路径与格式复核走
// `images::validate::ValidatedImagePath`；本文件不保留第二份解析或嗅探。
// ==========================================

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::screenshot_cmd::managed_chat_image_dirs;
use crate::error::{AppError, AppResult};
use crate::host::{AssetScopePort, FileDialogPort};
use crate::images::{limits, validate::ValidatedImagePath};
use crate::paths::AppPaths;
use crate::{rust_debug, rust_warn};

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

/// 删会话连带清理的结果（与 TS `HostCommandMap.chat_delete_session_images` 逐字对齐）。
#[derive(Serialize)]
pub struct ChatSessionImageDeletion {
    deleted: usize,
    skipped: usize,
}

/// 删除一组**托管聊天图片**（AI 截图 `screenshots/`、粘贴 `pasted/`；由 Node 在删会话
/// 成功后带入该会话条目里收集到的全部图片路径）。
///
/// 边界判定（硬要求，路径终裁归 Rust，TS 侧不复制第二份目录清单）：
/// - 只有落在托管根之内的**常规文件**会被删除；
/// - 根外路径（用户自己的原图就在那里）、目录、符号链接（含指向根内的）与不存在的
///   文件一律计入 `skipped`，绝不删除 —— 用户原图永不经过本命令删除；
/// - 单条删除失败只留痕并计入 `skipped`，不影响其它条目。
///
/// 命令本身只在参数形状非法时报错（参数收窄在分派层，本函数不做第二份解析）。
pub fn chat_delete_session_images(
    paths: &AppPaths,
    candidates: Vec<String>,
) -> AppResult<ChatSessionImageDeletion> {
    let roots = managed_chat_image_dirs(&paths.data_root);
    let mut deleted = 0usize;
    let mut skipped = 0usize;
    for candidate in candidates {
        match delete_managed_image(Path::new(&candidate), &roots) {
            Ok(true) => deleted += 1,
            Ok(false) => skipped += 1,
            Err(error) => {
                skipped += 1;
                rust_warn!("会话图片清理失败，跳过 {}: {error}", candidate);
            }
        }
    }
    Ok(ChatSessionImageDeletion { deleted, skipped })
}

/// 单条删除：`Ok(true)` = 已删除；`Ok(false)` = 不属于托管根 / 不是常规文件（跳过）；
/// 删除本身失败按 `Err` 如实返回（调用方计入 `skipped` 并留痕）。
fn delete_managed_image(path: &Path, roots: &[PathBuf]) -> AppResult<bool> {
    // 类型判定不跟随叶子（symlink_metadata）：目录、符号链接（含指向根内的）与已不存在的
    // 文件都在这里跳过 ——「删链接的目标」不是本命令的语义。
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            rust_debug!("会话图片清理跳过不存在的路径 {}", path.display());
            return Ok(false);
        }
    };
    if metadata.file_type().is_symlink() {
        rust_debug!("会话图片清理跳过符号链接 {}", path.display());
        return Ok(false);
    }
    if !metadata.is_file() {
        rust_debug!("会话图片清理跳过非常规文件 {}", path.display());
        return Ok(false);
    }

    // 包含判定走既有路径工具（不写第二份分隔符归一）：canonicalize 后必须落在某个
    // 托管根之内。根外路径是**正常输入**（同一会话条目里还有用户原图），只留 debug。
    let resolved = roots
        .iter()
        .find_map(|root| AppPaths::validate_path(path, root).ok());
    let Some(resolved) = resolved else {
        rust_debug!("会话图片清理跳过托管根外路径 {}", path.display());
        return Ok(false);
    };

    std::fs::remove_file(&resolved)
        .map_err(|error| AppError::Io(format!("删除图片失败: {error}")))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 测试用 AppPaths：只填数据根（删除边界只消费它）。
    /// 夹具落在仓库 `test/.tmp`（测试产物不落仓库外），用 `CARGO_MANIFEST_DIR` 定位
    /// crate 目录后回到仓库根（crate 在 `crates/native-host`，所以要 `../../`）。
    fn test_paths(root: &Path) -> AppPaths {
        AppPaths {
            data_root: root.to_path_buf(),
            memory: root.join("memory"),
            sessions: root.join("sessions"),
            personality: root.join("personality"),
            profiles: root.join("profiles"),
            skills: root.join("skills"),
            settings: root.join("settings"),
            logs: root.join("logs"),
            config_file: root.join("CONFIG.yaml"),
            runtime_mode: "test",
            seed_personality_cards: root.join("seeds/personality/cards"),
            seed_profiles: root.join("seeds/profiles"),
            seed_skills: root.join("seeds/skills"),
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/.tmp")
            .join(format!(
                "deskpet-chat-images-{tag}-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 删除边界走 canonicalize，夹具根也归一，避免 `..` 组件带来的路径形态差异。
        root.canonicalize().unwrap()
    }

    /// 创建符号链接。unix 与 windows 的 API 不同，两端都要能编译（与 paths 单测同款）。
    fn symlink_file(original: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(original, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(original, link)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (original, link);
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "当前平台不支持符号链接夹具",
            ))
        }
    }

    #[test]
    fn deletes_regular_files_in_both_managed_roots() {
        let root = temp_root("managed");
        let paths = test_paths(&root);
        let shots = root.join("screenshots");
        let pasted = root.join("pasted");
        std::fs::create_dir_all(&shots).unwrap();
        std::fs::create_dir_all(&pasted).unwrap();
        let shot = shots.join("1700000000000.png");
        let paste = pasted.join("1700000000001.png");
        std::fs::write(&shot, b"png").unwrap();
        std::fs::write(&paste, b"png").unwrap();

        let result = chat_delete_session_images(
            &paths,
            vec![
                shot.to_string_lossy().into_owned(),
                paste.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!((result.deleted, result.skipped), (2, 0));
        assert!(!shot.exists() && !paste.exists(), "托管根内文件必须被删除");
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 关键反向断言：根外路径（用户原图 / 前缀相似目录）一律不删。
    #[test]
    fn never_deletes_paths_outside_the_managed_roots() {
        let root = temp_root("outside");
        let paths = test_paths(&root);
        std::fs::create_dir_all(root.join("screenshots")).unwrap();
        // 场景 ①：用户自己的原图（就在数据根里，但不是托管根）。
        let user_photo = root.join("user-photo.png");
        std::fs::write(&user_photo, b"user").unwrap();
        // 场景 ②：前缀相似但不是同一目录（词法前缀比较会在这里放行）。
        let lookalike_dir = root.join("screenshots-backup");
        std::fs::create_dir_all(&lookalike_dir).unwrap();
        let lookalike = lookalike_dir.join("old.png");
        std::fs::write(&lookalike, b"user").unwrap();
        // 场景 ③：数据根之外的路径。
        let outside_dir = std::env::temp_dir().join(format!(
            "deskpet-chat-images-outside-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside = outside_dir.join("shot.png");
        std::fs::write(&outside, b"user").unwrap();
        // 场景 ④：父目录里带 `..` 试图穿进托管根的路径。
        let tricky = root.join("screenshots/../user-photo.png");

        let result = chat_delete_session_images(
            &paths,
            vec![
                user_photo.to_string_lossy().into_owned(),
                lookalike.to_string_lossy().into_owned(),
                outside.to_string_lossy().into_owned(),
                tricky.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!((result.deleted, result.skipped), (0, 4));
        assert!(user_photo.exists(), "用户原图绝不能被删除");
        assert!(lookalike.exists(), "前缀相似目录不是托管根");
        assert!(outside.exists(), "数据根之外绝不能被删除");
        std::fs::remove_dir_all(&outside_dir).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn skips_missing_directories_and_symlinks_inside_the_root() {
        let root = temp_root("types");
        let paths = test_paths(&root);
        let shots = root.join("screenshots");
        std::fs::create_dir_all(&shots).unwrap();

        let missing = shots.join("gone.png");
        let dir = shots.join("subdir");
        std::fs::create_dir_all(&dir).unwrap();
        let target = shots.join("target.png");
        std::fs::write(&target, b"png").unwrap();
        let inner_link = shots.join("inner-link.png");
        if symlink_file(&target, &inner_link).is_err() {
            // Windows 未开启开发者模式时创建符号链接需要管理员权限，跳过而不是误报失败
            // （与 paths 单测同一手法）。
            std::fs::remove_dir_all(&root).unwrap();
            return;
        }
        let user_photo = root.join("user-photo.png");
        std::fs::write(&user_photo, b"user").unwrap();
        let outer_link = shots.join("outer-link.png");
        symlink_file(&user_photo, &outer_link).unwrap();

        let result = chat_delete_session_images(
            &paths,
            vec![
                missing.to_string_lossy().into_owned(),
                dir.to_string_lossy().into_owned(),
                inner_link.to_string_lossy().into_owned(),
                outer_link.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!((result.deleted, result.skipped), (0, 4));
        assert!(dir.is_dir(), "目录不是删除对象");
        assert!(target.exists(), "符号链接的目标（根内）不因链接被删");
        assert!(
            std::fs::symlink_metadata(&inner_link).is_ok(),
            "根内符号链接本身也不删"
        );
        assert!(user_photo.exists(), "指向根外的符号链接不得成为越界跳板");
        assert!(std::fs::symlink_metadata(&outer_link).is_ok());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 单条失败（此处用只读目录制造 EACCES）不影响其它条目，且失败被如实计数。
    #[cfg(unix)]
    #[test]
    fn single_removal_failure_counts_as_skipped_without_blocking_others() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("failure");
        let paths = test_paths(&root);
        let shots = root.join("screenshots");
        let locked_dir = shots.join("locked");
        std::fs::create_dir_all(&locked_dir).unwrap();
        let locked = locked_dir.join("locked.png");
        let ok = shots.join("ok.png");
        std::fs::write(&locked, b"png").unwrap();
        std::fs::write(&ok, b"png").unwrap();
        // 目录去掉写位：unlink 会以 EACCES 失败（用例结束前恢复，保证夹具可清理）。
        std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result = chat_delete_session_images(
            &paths,
            vec![
                locked.to_string_lossy().into_owned(),
                ok.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!((result.deleted, result.skipped), (1, 1));
        assert!(!ok.exists(), "失败项不影响其它条目");
        assert!(locked.exists(), "删除失败的文件必须保留");

        std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}
