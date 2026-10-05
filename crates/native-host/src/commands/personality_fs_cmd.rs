// ==========================================
// 人格系统文件命令 — 通用文件 IO
// 目录结构:
//   {data}/personality/
//     cards/                   ← 用户导入 Card .md
//     stages/{cardId}.json      ← per-card 阶段文案 + 变量状态（stages 段 / variables 段）
//
// 所有 Card 和人格运行时文件都位于 AppPaths.personality。
// ==========================================

use crate::error::{err, AppError, AppResult};
use crate::paths::AppPaths;
use crate::rust_info;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 读取 personality/ 或 cards/ 下的文件
/// 从运行时人格目录读取文件
pub fn personality_file_read(path: String, paths: &AppPaths) -> AppResult<Vec<u8>> {
    let file_path = resolve_personality_path(&path, "read", paths)?;
    if !file_path.exists() {
        return Err(AppError::PathNotFound(format!("文件不存在: {}", path)));
    }
    let file_path = AppPaths::validate_path(&file_path, &paths.personality)?;
    fs::read(&file_path).map_err(|e| AppError::Io(format!("读取失败: {e}")))
}

/// 写入 personality/ 或 cards/ 下的文件（仅 runtime，自动创建父目录）
pub fn personality_file_write(
    path: String,
    content: Vec<u8>,
    paths: &AppPaths,
) -> AppResult<String> {
    let file_path = resolve_personality_path(&path, "write", paths)?;
    fs::write(&file_path, &content).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(file_path.to_string_lossy().to_string())
}

/// 列出 personality/ 或 cards/ 下指定目录的文件
/// 列出运行时人格目录
pub fn personality_file_list(dir_path: String, paths: &AppPaths) -> AppResult<Vec<String>> {
    let dir = resolve_personality_path(&dir_path, "read", paths)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let dir = AppPaths::validate_path(&dir, &paths.personality)?;
    if !dir.is_dir() {
        return err(format!("不是目录: {}", dir_path));
    }

    let mut files: Vec<String> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
        if let Some(name) = entry.file_name().to_str() {
            files.push(name.to_string());
        }
    }
    files.sort();
    Ok(files)
}

/// 删除 personality/ 或 cards/ 下的文件（仅 runtime，只删普通文件，不删目录）
///
/// 叶子符号链接一律拒绝：`exists()` 会跟随链接 —— 悬空链接因此被判成「不存在」，
/// 指向域内的链接则会让后续校验拿规范化后的目标路径去删，删掉链接之外的对象。
/// personality 域内都是 data_root 下的普通数据文件，链接叶子没有正当用途。
pub fn personality_file_delete(path: String, paths: &AppPaths) -> AppResult<()> {
    // 只需路径拼接、不能带任何建目录副作用（写入模式的 prepare 会替调用方建父目录）。
    let file_path = resolve_personality_path(&path, "read", paths)?;

    // 链接检查必须在 exists() 之前：悬空链接的 exists() 是 false，先查存在性会把它
    // 错判成 PathNotFound，检查形同虚设。
    if fs::symlink_metadata(&file_path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(AppError::PathEscape);
    }

    // 单文件删除不静默成功：名字打错与删除成功必须能区分（口径同 validate_path 失败）。
    if !file_path.exists() {
        return Err(AppError::PathNotFound(format!("文件不存在: {}", path)));
    }

    // 只删普通文件：目录必须由调用方显式走目录语义，删除命令不隐含 remove_dir_all。
    if !file_path.is_file() {
        return err(format!("不是文件: {}", path));
    }

    let target = AppPaths::validate_path(&file_path, &paths.personality)?;
    fs::remove_file(&target).map_err(|e| AppError::Io(format!("删除文件失败: {e}")))?;
    rust_info!("人格文件已删除: {path}");
    Ok(())
}

// ==========================================
// 路径解析（内部）
// ==========================================

/// 将**域内相对路径**（如 `stages/x.json`、`cards/x.md`）解析为绝对路径。
///
/// base 目录由本模块持有，调用方不得带 `personality/` 前缀 —— 见下方显式拒绝。
///
/// mode:
///   "read"  — 解析到 personality (runtime)
///   "write" — 解析到 personality (runtime)，自动创建父目录并校验路径安全
fn resolve_personality_path(relative: &str, mode: &str, paths: &AppPaths) -> AppResult<PathBuf> {
    // 明确拒绝域前缀：base 目录由本模块持有，前端只该传域内相对路径。
    // 若容忍 "personality/xxx"，它会拼成 personality/personality/xxx —— 读是静默找不到，
    // 写则会悄悄建出错误的嵌套目录。这里直接报错，不给兼容空间。
    if relative.starts_with("personality/") || relative.starts_with("personality\\") {
        return err(format!(
            "不要传域前缀，请传域内相对路径（如 stages/x.json）: {relative}"
        ));
    }

    // 只接受域内的普通路径段。不能通过过滤 `..` 修正非法输入：绝对路径在
    // PathBuf::join 时会替换 base，必须整体拒绝。
    let safe = safe_relative_path(relative)?;

    match mode {
        "read" => Ok(paths.personality.join(&safe)),
        "write" => {
            let target = paths.personality.join(&safe);

            prepare_personality_write_path(&target, &paths.personality)?;

            Ok(target)
        }
        _ => err("未知路径解析模式"),
    }
}

fn safe_relative_path(relative: &str) -> AppResult<PathBuf> {
    let path = Path::new(relative);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::PathEscape);
    }
    Ok(path.to_path_buf())
}

/// 在创建目录前先校验最近的已存在祖先，避免已有符号链接把创建操作导向 data_root 外。
fn prepare_personality_write_path(target: &Path, base: &Path) -> AppResult<()> {
    // 叶子是符号链接时必须单独判：`exists()` 会跟随链接，悬空链接因此返回 false，
    // 于是走到下面的「创建」分支并原样放行，随后 fs::write 顺着链接在域外建出文件。
    // personality 域内的文件都是 data_root 下的普通数据文件，链接叶子没有正当用途，直接拒绝。
    if fs::symlink_metadata(target).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(AppError::PathEscape);
    }

    if target.exists() {
        AppPaths::validate_path(target, base)?;
        return Ok(());
    }

    let parent = target.parent().ok_or(AppError::PathEscape)?;
    let mut ancestor = parent;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or(AppError::PathEscape)?;
    }
    AppPaths::validate_path(ancestor, base)?;

    fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
    AppPaths::validate_path(parent, base)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 测试用 AppPaths：只填本模块消费的字段（personality 根；其余字段不参与读写）。
    /// 夹具落在仓库 `test/.tmp`（测试产物不落仓库外）：`CARGO_MANIFEST_DIR` 只用于定位该
    /// 临时目录，业务路径仍全部来自 AppPaths（crate 在 `crates/native-host`，所以要 `../../`）。
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
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/.tmp");
        let root = base.join(format!(
            "deskpet-personality-fs-{tag}-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// 创建文件符号链接。unix 与 windows 的 API 不同，两端都要能编译。
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
                "当前平台不支持符号链接",
            ))
        }
    }

    #[test]
    fn accepts_only_normal_relative_components() {
        assert_eq!(
            safe_relative_path("stages/card.json").unwrap(),
            PathBuf::from("stages").join("card.json")
        );
        assert!(safe_relative_path("../outside.json").is_err());
        assert!(safe_relative_path("./stages/card.json").is_err());
        assert!(safe_relative_path("/tmp/outside.json").is_err());
    }

    #[test]
    fn deletes_file_inside_personality_domain() {
        let root = temp_root("delete");
        let paths = test_paths(&root);
        fs::create_dir_all(paths.personality.join("cards")).unwrap();
        fs::write(paths.personality.join("cards/x.md"), "你好").unwrap();

        personality_file_delete("cards/x.md".into(), &paths).unwrap();
        assert!(
            fs::symlink_metadata(paths.personality.join("cards/x.md")).is_err(),
            "文件必须真的被删掉"
        );
        assert!(paths.personality.join("cards").is_dir(), "父目录不受影响");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_escape_relative_path() {
        let root = temp_root("escape");
        let paths = test_paths(&root);
        fs::create_dir_all(paths.personality.join("cards")).unwrap();
        let outside = root.join("secret.md");
        fs::write(&outside, "x").unwrap();

        assert!(matches!(
            personality_file_delete("cards/../../secret.md".into(), &paths),
            Err(AppError::PathEscape)
        ));
        assert!(outside.exists(), "域外文件不能被删");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_directory_target() {
        let root = temp_root("dir");
        let paths = test_paths(&root);
        fs::create_dir_all(paths.personality.join("cards/sub")).unwrap();

        assert!(
            matches!(
                personality_file_delete("cards/sub".into(), &paths),
                Err(AppError::Other(_))
            ),
            "目录必须被拒绝，不能走 remove_dir_all 语义"
        );
        assert!(paths.personality.join("cards/sub").is_dir(), "目录必须保留");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_target_is_an_error_not_a_silent_success() {
        let root = temp_root("missing");
        let paths = test_paths(&root);
        fs::create_dir_all(paths.personality.join("cards")).unwrap();

        assert!(matches!(
            personality_file_delete("cards/ghost.md".into(), &paths),
            Err(AppError::PathNotFound(_))
        ));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_symlink_leaf_even_when_dangling() {
        let root = temp_root("symlink");
        let paths = test_paths(&root);
        fs::create_dir_all(paths.personality.join("cards")).unwrap();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.md"), "x").unwrap();

        let alias = paths.personality.join("cards/alias.md");
        if symlink_file(&outside.join("keep.md"), &alias).is_err() {
            // Windows 未开开发者模式时创建符号链接需要管理员权限，跳过而不是误报失败
            fs::remove_dir_all(&root).unwrap();
            return;
        }
        assert!(matches!(
            personality_file_delete("cards/alias.md".into(), &paths),
            Err(AppError::PathEscape)
        ));
        assert!(outside.join("keep.md").exists(), "链接目标不能被删");
        assert!(fs::symlink_metadata(&alias).is_ok(), "链接本身也不该被删");

        // 悬空链接：exists() 返回 false，只有 symlink_metadata 能拦住（否则错报 PathNotFound）。
        let dangling = paths.personality.join("cards/dangling.md");
        if symlink_file(&outside.join("ghost.md"), &dangling).is_err() {
            fs::remove_dir_all(&root).unwrap();
            return;
        }
        assert!(matches!(
            personality_file_delete("cards/dangling.md".into(), &paths),
            Err(AppError::PathEscape)
        ));

        fs::remove_dir_all(&root).unwrap();
    }
}
