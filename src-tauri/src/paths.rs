// src-tauri/src/paths.rs
// ==========================================
// 统一路径管理 — base dirs + 路径校验
// ==========================================

use std::path::{Path, PathBuf};
use std::fs;
use tauri::Manager;

pub struct AppPaths {
    pub data_root:    PathBuf,  // 统一读写根
    pub memory:       PathBuf,  // {data_root}/memory/
    pub sessions:     PathBuf,  // {data_root}/sessions/
    pub personality:  PathBuf,  // {data_root}/personality/
    pub profiles:     PathBuf,  // {data_root}/profiles/

    pub builtin_personality: PathBuf,  // {resource}/personality/  (只读)
    pub builtin_profiles:    PathBuf,  // {resource}/profiles/     (只读)
}

impl AppPaths {
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let resource = resolve_resource_dir(app)?;

        // 唯一环境判断：开发→项目下，生产→AppData
        let data_root = if cfg!(debug_assertions) {
            // 开发: {project}/data/desk-pet/
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest.parent().unwrap().join("data").join("desk-pet")
        } else {
            // 生产: {AppData}/desk-pet/
            app.path().app_local_data_dir()
                .map_err(|e| format!("app_local_data_dir: {e}"))?
                .join("desk-pet")
        };

        let paths = Self {
            memory:       data_root.join("memory"),
            sessions:     data_root.join("sessions"),
            personality:  data_root.join("personality"),
            profiles:     data_root.join("profiles"),
            builtin_personality: resource.join("personality"),
            builtin_profiles:    resource.join("profiles"),
            data_root,
        };

        for dir in [&paths.memory, &paths.sessions, &paths.personality, &paths.profiles] {
            fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {dir:?}: {e}"))?;
        }

        Ok(paths)
    }

    // ── Phase F 路径穿越防护 ──

    /// 校验路径在 base 内（用于 personality/memory/profile 读写）
    pub fn validate_path(path: &Path, base: &Path) -> Result<PathBuf, String> {
        let resolved = path.canonicalize()
            .map_err(|_| "路径不存在".to_string())?;
        if !resolved.starts_with(base) {
            return Err("路径越权".to_string());
        }
        Ok(resolved)
    }

    /// 校验文件路径在 home / temp 内（用于 tool_exec file_read/write）
    pub fn validate_file_path(path: &Path) -> Result<PathBuf, String> {
        let resolved = path.canonicalize()
            .map_err(|_| "路径不存在".to_string())?;

        let home = home_dir().ok_or("无法获取 home 目录")?;
        let temp = std::env::temp_dir();

        if !resolved.starts_with(&home) && !resolved.starts_with(&temp) {
            return Err("路径不在允许范围".to_string());
        }
        Ok(resolved)
    }
}

fn resolve_resource_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let p = PathBuf::from(&manifest).parent().unwrap().join("public");
        if p.exists() {
            return Ok(p);
        }
    }
    app.path().resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    { std::env::var("HOME").ok().map(PathBuf::from) }
    #[cfg(target_os = "windows")]
    { std::env::var("USERPROFILE").ok().map(PathBuf::from) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { std::env::var("HOME").ok().map(PathBuf::from) }
}
