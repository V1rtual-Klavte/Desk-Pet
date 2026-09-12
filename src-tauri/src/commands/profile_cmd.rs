// ==========================================
// Profile 文件系统命令
// Profile 存储于 AppPaths.profiles。随包种子仅在启动时复制缺失文件，
// 此模块不读取或写入任何打包资源。
// ==========================================

use crate::error::{err, AppError, AppResult};
use crate::paths::AppPaths;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

/// 写入 profile 文件（自动创建父目录）
#[tauri::command]
pub fn profile_file_write(
    profile_id: String,
    relative_path: String,
    content: Vec<u8>,
    paths: tauri::State<AppPaths>,
) -> AppResult<()> {
    validate_profile_id(&profile_id)?;
    let file_path = safe_profile_path(&paths.profiles, &profile_id, &relative_path)?;

    ensure_profile_parent(&file_path, &paths.profiles)?;
    fs::write(&file_path, &content).map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(())
}

/// 读取运行时 profile 文件
#[tauri::command]
pub fn profile_file_read(
    profile_id: String,
    relative_path: String,
    paths: tauri::State<AppPaths>,
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
#[tauri::command]
pub fn profile_delete(profile_id: String, paths: tauri::State<AppPaths>) -> AppResult<()> {
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

/// 将 Profile 完整复制到新的运行时目录。
#[tauri::command]
pub fn profile_clone(
    source_profile_id: String,
    target_profile_id: String,
    paths: tauri::State<AppPaths>,
) -> AppResult<()> {
    validate_profile_id(&source_profile_id)?;
    validate_profile_id(&target_profile_id)?;
    if source_profile_id == target_profile_id {
        return err("源 Profile 和目标 Profile 不能相同");
    }

    let target = paths.profiles.join(&target_profile_id);
    if target.exists() {
        return err("目标 Profile 已存在");
    }

    let user_source = paths.profiles.join(&source_profile_id);
    if !user_source.is_dir() {
        return err(format!("源 Profile 不存在: {source_profile_id}"));
    }
    let user_source = AppPaths::validate_path(&user_source, &paths.profiles)?;

    fs::create_dir_all(&target).map_err(|e| AppError::Io(format!("创建目标目录失败: {e}")))?;
    let target = AppPaths::validate_path(&target, &paths.profiles)?;
    copy_profile_tree(&user_source, &target)?;
    Ok(())
}

fn copy_profile_tree(source: &Path, target: &Path) -> AppResult<()> {
    for entry in
        fs::read_dir(source).map_err(|e| AppError::Io(format!("读取 Profile 失败: {e}")))?
    {
        let entry = entry.map_err(|e| AppError::Io(format!("读取 Profile 条目失败: {e}")))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::Io(format!("读取文件类型失败: {e}")))?;
        if file_type.is_dir() {
            fs::create_dir_all(&target_path)
                .map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
            copy_profile_tree(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|e| AppError::Io(format!("复制文件失败: {e}")))?;
        }
    }
    Ok(())
}

/// 返回 Profile 素材目录。
#[tauri::command]
pub fn profile_asset_base(profile_id: String, paths: tauri::State<AppPaths>) -> AppResult<String> {
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
#[tauri::command]
pub fn list_profiles(paths: tauri::State<AppPaths>) -> AppResult<Vec<String>> {
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
#[tauri::command]
pub fn list_profile_files(
    profile_id: String,
    subdir: Option<String>,
    paths: tauri::State<AppPaths>,
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
/// 为什么在 Rust 侧打包而不是前端 JSZip：Profile 实测 28MB / 229 个文件，
/// 经 Tauri IPC 传字节会序列化成上百 MB 的 JSON 数组；而且目录遍历天然不需要
/// 前端维护一份文件清单（那种清单一定会随素材变动而漂移）。
///
/// 返回 `Ok(None)` 表示用户取消了保存 —— 那是正常操作，不是错误。
#[tauri::command]
pub async fn export_profile_zip(
    app: tauri::AppHandle,
    profile_id: String,
    paths: tauri::State<'_, AppPaths>,
) -> AppResult<Option<String>> {
    validate_profile_id(&profile_id)?;

    let source = paths.profiles.join(&profile_id);
    if !source.is_dir() {
        return err(format!("Profile 不存在: {profile_id}"));
    }
    let source = AppPaths::validate_path(&source, &paths.profiles)?;

    let picked = app
        .dialog()
        .file()
        .set_file_name(format!("{profile_id}.zip"))
        .add_filter("Zip 压缩包", &["zip"])
        .blocking_save_file();
    let Some(file_path) = picked else {
        return Ok(None); // 用户取消
    };
    let target = file_path
        .into_path()
        .map_err(|e| AppError::Io(format!("无效的保存路径: {e}")))?;

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
