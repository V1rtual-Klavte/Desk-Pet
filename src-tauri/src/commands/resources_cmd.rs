// ==========================================
// 运行时资源命令
//
// 随包种子 src-tauri/resources/defaults/ 只在首次启动复制一次，之后运行时目录
// 里的资源与用户导入资源所有权相同：用户可以改、可以删，应用不再覆盖。
// 这里提供两个手动的集中入口 —— 找回误删的内置资源，以及按域内相对路径删除一个
// Skill 条目（目录或根级 `.md`；通用 file_delete 只允许 memory/ 与 sessions/）。
// ==========================================

use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths::{self, AppPaths, SeedSummary};
use crate::rust_info;

/// 用随包种子覆盖运行时资源，恢复出厂状态。
#[tauri::command]
pub fn restore_default_resources(paths: State<AppPaths>) -> AppResult<SeedSummary> {
    let summary = paths::restore_default_resources(&paths)?;
    rust_info!(
        "默认资源已恢复: Profile {} 个文件, Card {} 个文件, Skill {} 个文件",
        summary.profiles,
        summary.cards,
        summary.skills
    );
    Ok(summary)
}

/// 删除 `data_root/skills/` 下的一个 Skill 条目。
///
/// 入参是**域内相对路径**（相对 skills 根：`foo`、`foo/bar`、`foo.md`），不是 frontmatter 里的
/// `name`。理由：Pi loader 递归遍历、根级 `.md` 也算技能，`name` 可缺省取父目录名、可与目录名不一致，
/// 两个技能也可以同名；而种子恢复（`paths.rs` 的 `sync_seed_directory`）是按目录名复制的 ——
/// 按 `name` 删除会与种子恢复语义分叉，重名时还会删错对象。
#[tauri::command]
pub fn skill_delete(relative_path: String, paths: State<AppPaths>) -> AppResult<()> {
    remove_skill_entry(&relative_path, &paths.skills)
}

/// 校验并按类型删除：真目录递归删除；符号链接只删链接本身（不跟随、不递归进链接目标）；
/// 其余条目（普通文件等）按文件删除。
fn remove_skill_entry(relative_path: &str, skills_root: &Path) -> AppResult<()> {
    let target = resolve_skill_target(relative_path, skills_root)?;
    // 存在性已在 resolve 里校验过；这里再取一次元数据只为分流。`symlink_metadata` 不跟随链接，
    // 所以指向目录的链接不会被 `is_dir()` 报成目录，一定落到链接分支 —— 只删链接，不连带删目标。
    let metadata = fs::symlink_metadata(&target)
        .map_err(|_| AppError::PathNotFound(relative_path.to_string()))?;
    let file_type = metadata.file_type();
    let removed = if metadata.is_dir() {
        fs::remove_dir_all(&target)
    } else if file_type.is_symlink() {
        remove_symlink_entry(&target, file_type)
    } else {
        fs::remove_file(&target)
    };
    removed.map_err(|e| AppError::Io(format!("删除 Skill 失败: {e}")))?;
    rust_info!("Skill 已删除: {relative_path}");
    Ok(())
}

/// 删除一个符号链接条目：只删链接本身，绝不进入链接目标。
///
/// Windows 的链接分目录型与文件型，且两端各只认一个原语：目录链接必须用 `fs::remove_dir`
/// （→ `RemoveDirectoryW`，删的是重解析点本身，与链接目标是否为空无关），改用
/// `fs::remove_file`（→ `DeleteFileW`）会得到 `Access is denied. (os error 5)`；文件链接相反。
/// 判据取链接**自身**的类型标记（`is_symlink_dir` 不解析目标，悬空链接也能正确分流）。
#[cfg(windows)]
fn remove_symlink_entry(path: &Path, file_type: fs::FileType) -> std::io::Result<()> {
    use std::os::windows::fs::FileTypeExt;
    if file_type.is_symlink_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

/// 非 Windows：`unlink(2)` 本就不跟随符号链接，删的就是链接本身；
/// 在这里改用 `remove_dir`（`rmdir(2)`）反而会对符号链接报 `ENOTDIR`，所以维持 `remove_file`。
#[cfg(not(windows))]
fn remove_symlink_entry(path: &Path, _file_type: fs::FileType) -> std::io::Result<()> {
    fs::remove_file(path)
}

/// 把域内相对路径解析为 skills 根内的目标路径。
///
/// 校验按**路径安全**判，不再按字符集判（旧实现只放行 `[a-z0-9-]` 且不允许嵌套，于是目录名与服务名
/// 不一致、嵌套目录、根级 `.md`、含大写/下划线/点的目录一律删不掉）：
///
/// 1. 只接受纯 `Normal` 组件的相对路径 —— 空串、绝对路径、盘符前缀、`.` 与 `..` 组件一律拒绝，
///    且不做归一化：归一化会让「入参形态」与「实际目标」变成两份真相；
/// 2. 目标必须存在（不存在不再是静默成功，否则删错名字看起来也成功）；
/// 3. 符号链接解析后仍须落在 skills 根内（复用 `validate_path` 的统一判定，不另写一份前缀比较）。
///    悬空/成环的链接解析失败即拒绝，不写 `canonicalize().unwrap_or(...)` 之类的静默回退。
fn resolve_skill_target(relative_path: &str, skills_root: &Path) -> AppResult<PathBuf> {
    let mut target = skills_root.to_path_buf();
    let mut segments = 0_usize;
    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(segment) => {
                target.push(segment);
                segments += 1;
            }
            _ => return Err(AppError::PathEscape),
        }
    }
    if segments == 0 {
        return Err(AppError::PathEscape);
    }

    fs::symlink_metadata(&target)
        .map_err(|_| AppError::PathNotFound(relative_path.to_string()))?;
    AppPaths::validate_path(&target, skills_root)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 建一个「data_root + skills」临时目录，返回两者。
    fn fixture(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "deskpet-skill-delete-{tag}-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let skills = root.join("skills");
        fs::create_dir_all(&skills).unwrap();
        (root, skills)
    }

    /// 创建目录符号链接。unix 与 windows 的 API 不同，两端都要能编译。
    fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(original, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(original, link)
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
    fn rejects_paths_that_are_not_plain_relative_segments() {
        let (root, skills) = fixture("lexical");
        for bad in ["", "..", "../outside", "foo/../bar", "./foo", "/etc"] {
            assert!(
                matches!(resolve_skill_target(bad, &skills), Err(AppError::PathEscape)),
                "应拒绝的入参: {bad:?}"
            );
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deletes_directories_and_root_level_markdown() {
        let (root, skills) = fixture("delete");
        fs::create_dir_all(skills.join("alpha/nested")).unwrap();
        fs::write(skills.join("alpha/SKILL.md"), "x").unwrap();
        fs::write(skills.join("loose.md"), "x").unwrap();
        fs::write(skills.join("plain.txt"), "x").unwrap();

        remove_skill_entry("alpha/nested", &skills).unwrap();
        assert!(!skills.join("alpha/nested").exists());
        assert!(skills.join("alpha/SKILL.md").exists());

        remove_skill_entry("alpha", &skills).unwrap();
        assert!(!skills.join("alpha").exists());

        remove_skill_entry("loose.md", &skills).unwrap();
        assert!(!skills.join("loose.md").exists());
        assert!(skills.join("plain.txt").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_target_is_an_error_not_a_silent_success() {
        let (root, skills) = fixture("missing");

        assert!(matches!(
            remove_skill_entry("ghost", &skills),
            Err(AppError::PathNotFound(_))
        ));
        assert!(matches!(
            remove_skill_entry("ghost/deep", &skills),
            Err(AppError::PathNotFound(_))
        ));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_symlink_pointing_outside_the_skills_root() {
        let (root, skills) = fixture("escape");
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.md"), "x").unwrap();
        let link = skills.join("escape");
        if symlink_dir(&outside, &link).is_err() {
            // Windows 未开开发者模式时创建符号链接需要管理员权限，跳过而不是误报失败
            fs::remove_dir_all(&root).unwrap();
            return;
        }

        assert!(matches!(
            resolve_skill_target("escape", &skills),
            Err(AppError::PathEscape)
        ));
        assert!(matches!(
            remove_skill_entry("escape", &skills),
            Err(AppError::PathEscape)
        ));
        assert!(outside.join("keep.md").exists(), "根外目标不能被删");
        assert!(
            fs::symlink_metadata(&link).is_ok(),
            "链接本身也不该被删"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn symlink_inside_the_root_is_removed_as_a_link_only() {
        let (root, skills) = fixture("alias");
        fs::create_dir_all(skills.join("real")).unwrap();
        fs::write(skills.join("real/SKILL.md"), "x").unwrap();
        let link = skills.join("alias");
        if symlink_dir(&skills.join("real"), &link).is_err() {
            fs::remove_dir_all(&root).unwrap();
            return;
        }

        remove_skill_entry("alias", &skills).unwrap();
        assert!(fs::symlink_metadata(&link).is_err(), "只删链接本身");
        assert!(skills.join("real/SKILL.md").exists());

        fs::remove_dir_all(&root).unwrap();
    }
}
