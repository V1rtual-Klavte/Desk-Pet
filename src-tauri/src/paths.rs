// src-tauri/src/paths.rs
// ==========================================
// 统一路径管理 — base dirs + 路径校验
// ==========================================

use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

use crate::error::{AppError, AppResult};

pub struct AppPaths {
    pub data_root:    PathBuf,  // 统一读写根
    pub memory:       PathBuf,  // {data_root}/memory/
    pub sessions:     PathBuf,  // {data_root}/sessions/
    pub personality:  PathBuf,  // {data_root}/personality/
    pub profiles:     PathBuf,  // {data_root}/profiles/
    pub settings:     PathBuf,  // {data_root}/settings/
    pub logs:         PathBuf,  // {data_root}/logs/ —— 日志落盘
    pub config_file:  PathBuf,  // 开发 CONFIG-DEV.yaml / 生产 settings/CONFIG.yaml
    pub runtime_mode: &'static str,

    pub builtin_personality: PathBuf,  // {resource}/personality/  (只读)
    pub builtin_profiles:    PathBuf,  // {resource}/profiles/     (只读)
}

impl AppPaths {
    pub fn init(app: &tauri::AppHandle) -> AppResult<Self> {
        let resource = resolve_resource_dir(app)?;

        // 唯一环境判断：开发→项目工作区，生产→Tauri 应用专属数据目录。
        let data_root = if cfg!(debug_assertions) {
            if let Ok(test_root) = std::env::var("DESKPET_LIVE_TEST_DATA_ROOT") {
                PathBuf::from(test_root)
            } else {
                project_root().join("data").join("desk-pet")
            }
        } else {
            // app_local_data_dir 已包含 bundle identifier，不能再次拼 desk-pet。
            app.path().app_local_data_dir()
                .map_err(|e| AppError::Config(format!("app_local_data_dir: {e}")))?
        };

        let settings = data_root.join("settings");
        let config_file = if cfg!(debug_assertions) {
            let dev = project_root().join("CONFIG-DEV.yaml");
            if dev.exists() { dev } else { project_root().join("CONFIG.yaml") }
        } else {
            settings.join("CONFIG.yaml")
        };

        let paths = Self {
            memory:       data_root.join("memory"),
            sessions:     data_root.join("sessions"),
            personality:  data_root.join("personality"),
            profiles:     data_root.join("profiles"),
            settings,
            logs: data_root.join("logs"),
            config_file,
            runtime_mode: if cfg!(debug_assertions) { "development" } else { "production" },
            builtin_personality: resource.join("personality"),
            builtin_profiles:    resource.join("profiles"),
            data_root,
        };

        for dir in [&paths.memory, &paths.sessions, &paths.personality, &paths.profiles, &paths.settings, &paths.logs] {
            fs::create_dir_all(dir).map_err(|e| AppError::Io(format!("创建目录失败: {dir:?}: {e}")))?;
        }

        if !cfg!(debug_assertions) && !paths.config_file.exists() {
            fs::write(&paths.config_file, include_str!("../../CONFIG.yaml"))
                .map_err(|e| AppError::Config(format!("初始化生产配置失败: {:?}: {e}", paths.config_file)))?;
        }

        Ok(paths)
    }

    // ── 路径穿越防护 ──

    /// 校验路径在 base 内（用于 personality/memory/profile 读写）
    pub fn validate_path(path: &Path, base: &Path) -> AppResult<PathBuf> {
        let resolved = path.canonicalize()
            .map_err(|_| AppError::PathNotFound(path.to_string_lossy().to_string()))?;
        if !resolved.starts_with(base) {
            return Err(AppError::PathEscape);
        }
        Ok(resolved)
    }

    /// 校验文件路径在 home / temp 内（用于 tool_exec file_read/write）
    pub fn validate_file_path(path: &Path) -> AppResult<PathBuf> {
        let resolved = path.canonicalize()
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

        let mut ancestor = normalized.parent()
            .ok_or_else(|| AppError::PathNotFound(format!("无效的文件路径: {}", path.to_string_lossy())))?
            .to_path_buf();
        while !ancestor.exists() {
            ancestor = ancestor.parent()
                .ok_or_else(|| AppError::PathNotFound(format!("路径没有可校验的父目录: {}", path.to_string_lossy())))?
                .to_path_buf();
        }
        let canonical_ancestor = ancestor.canonicalize()
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
    Ok(allowed_file_roots()?.iter().any(|root| path.starts_with(root)))
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
        let p = project_root().join("public");
        if p.exists() {
            return Ok(p);
        }
    }
    app.path().resource_dir()
        .map_err(|e| AppError::Config(format!("resource_dir: {e}")))
}

fn project_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // 不 panic：拿不到父目录就退回 manifest 自身（仅构建期异常路径）
    manifest.parent().map(Path::to_path_buf).unwrap_or(manifest)
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    { std::env::var("HOME").ok().map(PathBuf::from) }
    #[cfg(target_os = "windows")]
    { std::env::var("USERPROFILE").ok().map(PathBuf::from) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { std::env::var("HOME").ok().map(PathBuf::from) }
}
