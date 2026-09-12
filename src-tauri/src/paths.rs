// src-tauri/src/paths.rs
// ==========================================
// 统一路径管理 — base dirs + 路径校验
// ==========================================

use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

use crate::error::{AppError, AppResult};

pub struct AppPaths {
    pub data_root: PathBuf,   // 统一读写根
    pub memory: PathBuf,      // {data_root}/memory/
    pub sessions: PathBuf,    // {data_root}/sessions/
    pub personality: PathBuf, // {data_root}/personality/
    pub profiles: PathBuf,    // {data_root}/profiles/
    pub settings: PathBuf,    // {data_root}/settings/
    pub logs: PathBuf,        // {data_root}/logs/ —— 日志落盘
    pub config_file: PathBuf, // 开发 CONFIG-DEV.yaml / 生产 settings/CONFIG.yaml
    pub runtime_mode: &'static str,

    // 仅用于首次初始化的随包种子；业务读取和写入始终只使用上面的运行时目录。
    pub seed_personality_cards: PathBuf,
    pub seed_profiles: PathBuf,
}

impl AppPaths {
    pub fn init(app: &tauri::AppHandle) -> AppResult<Self> {
        let resource = resolve_resource_dir(app)?;

        // 唯一环境判断：开发→项目工作区，生产→Tauri 应用专属数据目录。
        let data_root = if cfg!(debug_assertions) {
            // 临时根只允许由 Live Test runner 启用，普通 `tauri dev` 不受遗留环境变量影响。
            if is_live_test() {
                std::env::var("DESKPET_LIVE_TEST_DATA_ROOT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| development_data_root())
            } else {
                development_data_root()
            }
        } else {
            // app_local_data_dir 已包含 bundle identifier，不能再次拼 desk-pet。
            app.path()
                .app_local_data_dir()
                .map_err(|e| AppError::Config(format!("app_local_data_dir: {e}")))?
        };

        let settings = data_root.join("settings");
        let config_file = if cfg!(debug_assertions) {
            let dev = project_root().join("CONFIG-DEV.yaml");
            if dev.exists() {
                dev
            } else {
                project_root().join("CONFIG.yaml")
            }
        } else {
            settings.join("CONFIG.yaml")
        };

        let paths = Self {
            memory: data_root.join("memory"),
            sessions: data_root.join("sessions"),
            personality: data_root.join("personality"),
            profiles: data_root.join("profiles"),
            settings,
            logs: data_root.join("logs"),
            config_file,
            runtime_mode: if cfg!(debug_assertions) {
                "development"
            } else {
                "production"
            },
            seed_personality_cards: resource.join("defaults").join("personality").join("cards"),
            seed_profiles: resource.join("defaults").join("profiles"),
            data_root,
        };

        for dir in [
            &paths.memory,
            &paths.sessions,
            &paths.personality,
            &paths.profiles,
            &paths.settings,
            &paths.logs,
        ] {
            fs::create_dir_all(dir)
                .map_err(|e| AppError::Io(format!("创建目录失败: {dir:?}: {e}")))?;
        }

        seed_default_resources(&paths)?;

        if cfg!(debug_assertions) && is_live_test() {
            seed_live_test_stages(&paths)?;
        }

        if !cfg!(debug_assertions) && !paths.config_file.exists() {
            fs::write(&paths.config_file, include_str!("../../CONFIG.yaml")).map_err(|e| {
                AppError::Config(format!("初始化生产配置失败: {:?}: {e}", paths.config_file))
            })?;
        }

        Ok(paths)
    }

    // ── 路径穿越防护 ──

    /// 校验路径在 base 内（用于 personality/memory/profile 读写）
    pub fn validate_path(path: &Path, base: &Path) -> AppResult<PathBuf> {
        let resolved = path
            .canonicalize()
            .map_err(|_| AppError::PathNotFound(path.to_string_lossy().to_string()))?;
        let resolved_base = base
            .canonicalize()
            .map_err(|_| AppError::PathNotFound(base.to_string_lossy().to_string()))?;
        if !resolved.starts_with(&resolved_base) {
            return Err(AppError::PathEscape);
        }
        Ok(resolved)
    }

    /// 校验文件路径在 home / temp 内（用于 tool_exec file_read/write）
    pub fn validate_file_path(path: &Path) -> AppResult<PathBuf> {
        let resolved = path
            .canonicalize()
            .map_err(|_| AppError::PathNotFound(path.to_string_lossy().to_string()))?;
        if !is_allowed_file_path(&resolved)? {
            return Err(AppError::PathEscape);
        }
        Ok(resolved)
    }

    /// 校验尚不存在的文件路径。返回规范化绝对路径，不创建任何目录。
    pub fn validate_new_file_path(path: &Path) -> AppResult<PathBuf> {
        let normalized = normalize_absolute(path)?;
        if !is_allowed_file_path(&normalized)? {
            return Err(AppError::PathEscape);
        }

        let mut ancestor = normalized
            .parent()
            .ok_or_else(|| {
                AppError::PathNotFound(format!("无效的文件路径: {}", path.to_string_lossy()))
            })?
            .to_path_buf();
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| {
                    AppError::PathNotFound(format!(
                        "路径没有可校验的父目录: {}",
                        path.to_string_lossy()
                    ))
                })?
                .to_path_buf();
        }
        let canonical_ancestor = ancestor
            .canonicalize()
            .map_err(|_| AppError::PathNotFound(ancestor.to_string_lossy().to_string()))?;
        if !is_allowed_file_path(&canonical_ancestor)? {
            return Err(AppError::PathEscape);
        }
        Ok(normalized)
    }
}

fn allowed_file_roots() -> AppResult<Vec<PathBuf>> {
    let home = home_dir().ok_or(AppError::NoHomeDir)?;
    let temp = std::env::temp_dir();
    let mut roots = vec![normalize_absolute(&home)?, normalize_absolute(&temp)?];
    for root in [home, temp] {
        if let Ok(canonical) = root.canonicalize() {
            if !roots.contains(&canonical) {
                roots.push(canonical);
            }
        }
    }
    Ok(roots)
}

fn is_allowed_file_path(path: &Path) -> AppResult<bool> {
    Ok(allowed_file_roots()?
        .iter()
        .any(|root| path.starts_with(root)))
}

fn normalize_absolute(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::NotAbsolute(path.to_string_lossy().to_string()));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(AppError::PathEscape);
                }
            }
        }
    }
    Ok(normalized)
}

fn resolve_resource_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        let p = project_root().join("src-tauri").join("resources");
        if p.exists() {
            return Ok(p);
        }
    }
    app.path()
        .resource_dir()
        .map_err(|e| AppError::Config(format!("resource_dir: {e}")))
}

fn project_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // 不 panic：拿不到父目录就退回 manifest 自身（仅构建期异常路径）
    manifest.parent().map(Path::to_path_buf).unwrap_or(manifest)
}

fn development_data_root() -> PathBuf {
    project_root().join("data").join("desk-pet")
}

pub(crate) fn is_live_test() -> bool {
    std::env::var("DESKPET_LIVE_TEST").ok().as_deref() == Some("1")
}

/// Live Test 只从由 AppPaths 定义的开发根复制阶段种子，避免测试脚本另行维护路径布局。
fn seed_live_test_stages(paths: &AppPaths) -> AppResult<()> {
    let source = development_data_root().join("personality").join("stages");
    let target = paths.personality.join("stages");
    if !source.is_dir() || source == target {
        return Ok(());
    }
    copy_directory(&source, &target)
}

fn copy_directory(source: &Path, target: &Path) -> AppResult<()> {
    fs::create_dir_all(target).map_err(|e| AppError::Io(format!("创建测试种子目录失败: {e}")))?;
    for entry in
        fs::read_dir(source).map_err(|e| AppError::Io(format!("读取测试种子目录失败: {e}")))?
    {
        let entry = entry.map_err(|e| AppError::Io(format!("读取测试种子条目失败: {e}")))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::Io(format!("读取测试种子类型失败: {e}")))?;
        if file_type.is_dir() {
            copy_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|e| AppError::Io(format!("复制测试阶段种子失败: {e}")))?;
        }
    }
    Ok(())
}

/// 默认资源只在第一次初始化时复制到运行时目录。
///
/// 标记写入后不再补齐缺失文件，用户删除自带 Profile/Card 或素材后不会在下一次
/// 启动时被恢复；运行时目录中的资源与用户导入资源具有完全相同的所有权。
fn seed_default_resources(paths: &AppPaths) -> AppResult<()> {
    let marker = paths.settings.join(".default-resources-seeded");
    if marker.exists() {
        AppPaths::validate_path(&marker, &paths.settings)?;
        return Ok(());
    }

    seed_missing_directory(&paths.seed_profiles, &paths.profiles, "Profile")?;
    seed_missing_directory(
        &paths.seed_personality_cards,
        &paths.personality.join("cards"),
        "Card",
    )?;
    fs::write(&marker, b"1\n")
        .map_err(|e| AppError::Io(format!("写入默认资源初始化标记失败: {marker:?}: {e}")))?;
    Ok(())
}

/// 首次初始化时只补齐缺失的种子文件，绝不覆盖已有运行时编辑结果。
fn seed_missing_directory(source: &Path, target: &Path, label: &str) -> AppResult<()> {
    if !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|e| AppError::Io(format!("创建 {label} 目录失败: {e}")))?;
    for entry in
        fs::read_dir(source).map_err(|e| AppError::Io(format!("读取 {label} 种子失败: {e}")))?
    {
        let entry = entry.map_err(|e| AppError::Io(format!("读取 {label} 种子条目失败: {e}")))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::Io(format!("读取 {label} 种子类型失败: {e}")))?;
        if file_type.is_dir() {
            seed_missing_directory(&source_path, &target_path, label)?;
        } else if file_type.is_file() && !target_path.exists() {
            fs::copy(&source_path, &target_path)
                .map_err(|e| AppError::Io(format!("初始化 {label} 种子失败: {e}")))?;
        }
    }
    Ok(())
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn test_paths(root: &Path, seeds: &Path) -> AppPaths {
        AppPaths {
            data_root: root.to_path_buf(),
            memory: root.join("memory"),
            sessions: root.join("sessions"),
            personality: root.join("personality"),
            profiles: root.join("profiles"),
            settings: root.join("settings"),
            logs: root.join("logs"),
            config_file: root.join("CONFIG.yaml"),
            runtime_mode: "test",
            seed_personality_cards: seeds.join("personality/cards"),
            seed_profiles: seeds.join("profiles"),
        }
    }

    #[test]
    fn default_resources_are_not_restored_after_first_seed() {
        let suffix = format!(
            "deskpet-paths-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let root = std::env::temp_dir().join(&suffix);
        let seeds = root.join("seeds");
        fs::create_dir_all(seeds.join("profiles/default")).unwrap();
        fs::create_dir_all(seeds.join("personality/cards")).unwrap();
        fs::write(seeds.join("profiles/default/profile.yaml"), "meta: {}\n").unwrap();
        fs::write(seeds.join("personality/cards/default.md"), "# default\n").unwrap();

        let paths = test_paths(&root, &seeds);
        for dir in [&paths.profiles, &paths.personality, &paths.settings] {
            fs::create_dir_all(dir).unwrap();
        }
        seed_default_resources(&paths).unwrap();
        let profile = paths.profiles.join("default/profile.yaml");
        assert!(profile.exists());
        assert!(paths.personality.join("cards/default.md").exists());

        fs::remove_file(&profile).unwrap();
        seed_default_resources(&paths).unwrap();
        assert!(
            !profile.exists(),
            "seed marker must preserve a user deletion"
        );

        fs::remove_dir_all(&root).unwrap();
    }
}
