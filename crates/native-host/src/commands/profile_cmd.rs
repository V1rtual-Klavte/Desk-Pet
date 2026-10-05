// ==========================================
// Profile 文件系统命令
// Profile 存储于 AppPaths.profiles。随包种子仅在启动时复制缺失文件，
// 此模块不读取或写入任何打包资源。
// transport 无关的普通函数；原生「另存为」对话框经 [`FileDialogPort`] 显式注入。
// ==========================================

use crate::error::{err, AppError, AppResult};
use crate::host::FileDialogPort;
use crate::paths::AppPaths;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 写入 profile 文件（自动创建父目录）
pub fn profile_file_write(
    profile_id: String,
    relative_path: String,
    content: Vec<u8>,
    paths: &AppPaths,
) -> AppResult<()> {
    validate_profile_id(&profile_id)?;
    let file_path = safe_profile_path(&paths.profiles, &profile_id, &relative_path)?;

    ensure_profile_parent(&file_path, &paths.profiles)?;
    fs::write(&file_path, &content).map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(())
}

/// 读取运行时 profile 文件
pub fn profile_file_read(
    profile_id: String,
    relative_path: String,
    paths: &AppPaths,
) -> AppResult<Vec<u8>> {
    let user_path = safe_profile_path(&paths.profiles, &profile_id, &relative_path)?;
    if user_path.exists() {
        let user_path = AppPaths::validate_path(&user_path, &paths.profiles)?;
        return fs::read(&user_path).map_err(|e| AppError::Io(format!("读取失败: {e}")));
    }
    Err(AppError::PathNotFound(format!(
        "文件不存在: {}/{}",
        profile_id, relative_path
    )))
}

/// 删除 profile 目录
pub fn profile_delete(profile_id: String, paths: &AppPaths) -> AppResult<()> {
    validate_profile_id(&profile_id)?;
    let dir = safe_profile_path(&paths.profiles, &profile_id, "profile.yaml")?
        .parent()
        .ok_or("无效 Profile 目录")?
        .to_path_buf();
    if dir.exists() {
        let dir = AppPaths::validate_path(&dir, &paths.profiles)?;
        fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 返回 Profile 素材目录。
pub fn profile_asset_base(profile_id: String, paths: &AppPaths) -> AppResult<String> {
    validate_profile_id(&profile_id)?;
    let user = paths.profiles.join(&profile_id);
    Ok(if user.join("profile.yaml").is_file() {
        AppPaths::validate_path(&user, &paths.profiles)?
            .to_string_lossy()
            .to_string()
    } else {
        String::new()
    })
}

fn validate_profile_id(profile_id: &str) -> AppResult<()> {
    if profile_id.is_empty()
        || !profile_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::PathEscape);
    }
    Ok(())
}

fn safe_profile_path(base: &Path, profile_id: &str, relative_path: &str) -> AppResult<PathBuf> {
    validate_profile_id(profile_id)?;
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::PathEscape);
    }
    Ok(base.join(profile_id).join(relative))
}

fn ensure_profile_parent(file_path: &Path, base: &Path) -> AppResult<()> {
    let parent = file_path.parent().ok_or("无效的文件路径")?;
    let mut existing = parent;
    while !existing.exists() {
        existing = existing.parent().ok_or("没有可校验的父目录")?;
    }
    AppPaths::validate_path(existing, base)?;
    fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
    AppPaths::validate_path(parent, base)?;
    Ok(())
}

/// 列出全部运行时 profiles（AppPaths.profiles 下）
pub fn list_profiles(paths: &AppPaths) -> AppResult<Vec<String>> {
    let dir = &paths.profiles;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut profiles = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                profiles.push(name.to_string());
            }
        }
    }
    profiles.sort();
    Ok(profiles)
}

/// 递归列出目录中所有图片文件的相对路径
fn list_image_files(dir: &PathBuf) -> AppResult<Vec<String>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files = Vec::new();
    list_files_recursive(dir, dir, &mut files)?;
    files.sort();
    Ok(files)
}

fn list_files_recursive(
    base: &PathBuf,
    current: &PathBuf,
    files: &mut Vec<String>,
) -> AppResult<()> {
    let dir = fs::read_dir(current).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in dir {
        let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            list_files_recursive(base, &path, files)?;
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if matches!(
                    ext_lower.as_str(),
                    "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
                ) {
                    if let Ok(rel) = path.strip_prefix(base) {
                        files.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    Ok(())
}

/// 列出 profile 中所有图片素材
/// subdir: 可选子目录过滤（如 "materials/L2"）
pub fn list_profile_files(
    profile_id: String,
    subdir: Option<String>,
    paths: &AppPaths,
) -> AppResult<Vec<String>> {
    validate_profile_id(&profile_id)?;
    let prefix = subdir
        .as_ref()
        .map(|s| {
            let trimmed = s.trim_matches('/');
            if trimmed.is_empty() {
                None
            } else {
                Some(format!("{}/", trimmed))
            }
        })
        .flatten();

    let mut all_files = Vec::new();

    let user_dir = paths.profiles.join(&profile_id);
    if user_dir.exists() {
        let user_dir = AppPaths::validate_path(&user_dir, &paths.profiles)?;
        if let Ok(ref files) = list_image_files_filtered(&user_dir, &prefix) {
            for f in files {
                if !all_files.contains(f) {
                    all_files.push(f.clone());
                }
            }
        }
    }

    all_files.sort();
    Ok(all_files)
}

fn list_image_files_filtered(dir: &PathBuf, prefix: &Option<String>) -> AppResult<Vec<String>> {
    let all = list_image_files(dir)?;
    match prefix {
        Some(p) => Ok(all
            .into_iter()
            .filter(|f| f.starts_with(p.as_str()))
            .collect()),
        None => Ok(all),
    }
}

// ==========================================
// 导出 Profile（原生「另存为」 + Rust 侧打包）
// ==========================================

/// 把 Profile 目录打包为 zip，写入用户选定的位置。
///
/// 为什么在宿主侧打包而不是把字节交给调用方：Profile 实测 28MB / 229 个文件，
/// 经 IPC 传字节会序列化成上百 MB 的 JSON 数组；而且目录遍历天然不需要
/// 调用方维护一份文件清单（那种清单一定会随素材变动而漂移）。
///
/// 返回 `Ok(None)` 表示用户取消了保存 —— 那是正常操作，不是错误。
///
/// 同步阻塞（原生「另存为」对话框本身阻塞，打包是文件 IO）；async 包装
/// （spawn_blocking）由 IPC 分派层负责。`profiles_root` 即 `AppPaths.profiles`（本函数
/// 不再使用 AppPaths 的其他字段，调用方以字段克隆跨线程传入）。
pub fn export_profile_zip(
    dialogs: &dyn FileDialogPort,
    profiles_root: &Path,
    profile_id: String,
) -> AppResult<Option<String>> {
    validate_profile_id(&profile_id)?;

    let source = profiles_root.join(&profile_id);
    if !source.is_dir() {
        return err(format!("Profile 不存在: {profile_id}"));
    }
    let source = AppPaths::validate_path(&source, profiles_root)?;

    // 过滤器字符串保持逐字不变（契约）；取消返回 None（端口契约：取消不是错误）。
    let Some(picked) = dialogs.save_file(&format!("{profile_id}.zip"), "Zip 压缩包", "zip")?
    else {
        return Ok(None); // 用户取消
    };
    let target = PathBuf::from(picked);

    if let Err(e) = write_profile_zip(&source, &target) {
        // 不留半截压缩包
        let _ = fs::remove_file(&target);
        return Err(e);
    }
    Ok(Some(target.to_string_lossy().to_string()))
}

fn write_profile_zip(source: &Path, target: &Path) -> AppResult<()> {
    let file =
        fs::File::create(target).map_err(|e| AppError::Io(format!("创建压缩包失败: {e}")))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    add_tree_to_zip(&mut writer, source, source, options)?;
    writer
        .finish()
        .map_err(|e| AppError::Io(format!("完成压缩包失败: {e}")))?;
    Ok(())
}

fn add_tree_to_zip(
    writer: &mut zip::ZipWriter<fs::File>,
    root: &Path,
    current: &Path,
    options: zip::write::SimpleFileOptions,
) -> AppResult<()> {
    let entries = fs::read_dir(current).map_err(|e| AppError::Io(format!("读取目录失败: {e}")))?;
    for entry in entries {
        let entry = entry.map_err(|e| AppError::Io(format!("读取目录项失败: {e}")))?;
        let path = entry.path();
        if path.is_dir() {
            add_tree_to_zip(writer, root, &path, options)?;
            continue;
        }
        // zip 内路径统一用正斜杠，Windows 的反斜杠要在归档前归一化
        let name = path
            .strip_prefix(root)
            .map_err(|_| AppError::PathEscape)?
            .to_string_lossy()
            .replace('\\', "/");
        writer
            .start_file(name, options)
            .map_err(|e| AppError::Io(format!("写入压缩包条目失败: {e}")))?;
        let mut input =
            fs::File::open(&path).map_err(|e| AppError::Io(format!("打开 {path:?} 失败: {e}")))?;
        std::io::copy(&mut input, writer)
            .map_err(|e| AppError::Io(format!("写入压缩包失败: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 测试用 AppPaths：只填本模块消费的字段（profiles 根；其余字段不参与写入）。
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
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/.tmp");
        let root = base.join(format!(
            "deskpet-profile-{tag}-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// 素材写入在父目录缺失时自动创建（materials/L{n} 两级都不存在也能直接插图）。
    ///
    /// 新建 Profile 预置的目录只是「提前把落点建好」；这条保证导入/旧 Profile
    /// 没有预置目录时编辑器插入素材依然不失败。越界相对路径仍被拒绝 ——
    /// 自动建目录不放松路径边界。
    #[test]
    fn 写入素材时父目录缺失会自动创建() {
        let root = temp_root("write-parent");
        let paths = test_paths(&root);
        fs::create_dir_all(&paths.profiles).unwrap();

        let image = vec![0x89u8, b'P', b'N', b'G'];
        profile_file_write(
            "probe".into(),
            "materials/L0/bg.png".into(),
            image.clone(),
            &paths,
        )
        .unwrap();
        assert!(paths.profiles.join("probe/materials/L0").is_dir());
        assert_eq!(
            fs::read(paths.profiles.join("probe/materials/L0/bg.png")).unwrap(),
            image
        );

        assert!(
            profile_file_write("probe".into(), "../escape.png".into(), vec![1], &paths).is_err(),
            "越界路径必须被拒绝"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    /// 空目录的素材列表是空表（不是错误）；`materials/L{n}/` 下的非图片文件
    /// （用户放的 .DS_Store / readme 之类）也不进列表。
    /// 与「新建 Profile 预建五层空目录」配套：新 Profile 打开编辑器时是空列表而非报错，
    /// 用户往目录里随手放的非图片文件也不会被当成素材。
    #[test]
    fn 空目录与非图片文件都不进素材列表() {
        let root = temp_root("list-assets");
        let paths = test_paths(&root);
        let layer_dir = paths.profiles.join("probe/materials/L0");
        fs::create_dir_all(&layer_dir).unwrap();
        assert!(list_profile_files("probe".into(), None, &paths)
            .unwrap()
            .is_empty());

        fs::write(layer_dir.join(".DS_Store"), b"junk").unwrap();
        fs::write(layer_dir.join("body.png"), b"x").unwrap();
        assert_eq!(
            list_profile_files("probe".into(), None, &paths).unwrap(),
            vec!["materials/L0/body.png".to_string()]
        );

        fs::remove_dir_all(&root).unwrap();
    }

    /// 递归打包应保留相对路径，且能被打包器自己读回。
    /// 原生「另存为」对话框无法自动化，但打包这一步是导出的全部实质逻辑。
    #[test]
    fn zips_directory_tree_preserving_relative_paths() {
        let tmp = std::env::temp_dir().join(format!("deskpet-zip-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);

        let src = tmp.join("src");
        let nested = src.join("materials").join("L2");
        fs::create_dir_all(&nested).unwrap();
        fs::write(src.join("profile.yaml"), b"meta: {}").unwrap();
        fs::write(nested.join("body.png"), b"fake-png-bytes").unwrap();

        let out = tmp.join("out.zip");
        write_profile_zip(&src, &out).unwrap();

        let mut archive = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["materials/L2/body.png", "profile.yaml"]);

        // 内容也要能原样读回
        let mut body = String::new();
        use std::io::Read;
        archive
            .by_name("materials/L2/body.png")
            .unwrap()
            .read_to_string(&mut body)
            .unwrap();
        assert_eq!(body, "fake-png-bytes");

        let _ = fs::remove_dir_all(&tmp);
    }
}
