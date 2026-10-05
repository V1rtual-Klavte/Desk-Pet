use crate::error::{AppError, AppResult};
use crate::rust_debug;
use std::path::{Component, Path, PathBuf};

pub(crate) fn allowed_file_roots() -> AppResult<Vec<PathBuf>> {
    let home = home_dir().ok_or(AppError::NoHomeDir)?;
    let temp = std::env::temp_dir();
    let mut candidates = vec![home, temp];

    // 开发构建下再把项目根纳入：dev 的数据根是 `{project}/data/desk-pet`，
    // 仓库若不在 $HOME 之内（外置卷、/opt、Windows 的 D:\），所有会话写入
    // 都会直接撞 PATH_ESCAPE，而错误只给出 code，很难看出是根目录的问题。
    // 生产构建不受影响：那时数据根本来就在用户目录下。
    if cfg!(debug_assertions) {
        // 工作区根由 `AppPaths::init` 从 `HostEnvironment` 注入（进程级 OnceLock）。
        // 单元测试直接构造 AppPaths、不经过 init，此时读到 None 便跳过该候选 ——
        // 这不影响测试：现有测试走 `validate_path`（只做 base 前缀比较），不经过
        // allowed_file_roots；例如 session_fs 的用例建在仓库 `test/.tmp` 下，
        // 也不依赖这里补的项目根候选。真实启动必然已注入。
        if let Some(root) = super::project_root() {
            candidates.push(root);
        }
    }

    let mut roots = Vec::with_capacity(candidates.len() * 2);
    for root in candidates {
        let normalized = normalize_absolute(&root)?;
        if !roots.contains(&normalized) {
            roots.push(normalized);
        }
    }
    // canonicalize 后的形态也各留一份：macOS 的 /var → /private/var、Windows 的短名都走这条
    for root in roots.clone() {
        match root.canonicalize() {
            Ok(canonical) => {
                if !roots.contains(&canonical) {
                    roots.push(canonical);
                }
            }
            // 解析失败只是少一个候选根，语义与之前一致；但路径被拒时报的是 PATH_ESCAPE，
            // 没有这条日志就无法区分「真的越权」与「根没解析出来」。
            // [保留已登记 §4.2]
            Err(error) => rust_debug!(
                "允许根 canonicalize 失败，跳过候选: root={} error={error}",
                root.display()
            ),
        }
    }
    Ok(roots)
}

pub(crate) fn is_allowed_file_path(path: &Path) -> AppResult<bool> {
    Ok(allowed_file_roots()?
        .iter()
        .any(|root| path.starts_with(root)))
}

/// 凭据路径规则（与 TS `checker.ts` 的 `FILE_NOWAY_PATTERNS` 同一规则族）：
/// 路径中出现 `.ssh` 目录组件，或后缀为 `.pem` / `.key`。只看路径文本，不查磁盘。
///
/// 先做词法归一（`\` → `/`、整体小写）：macOS/Windows 文件系统本身不区分大小写，
/// `.SSH`/`.PEM` 与 `C:\Users\me\.ssh\id_rsa` 必须与 POSIX 写法同判 —— TS 侧靠正则
/// 的 `i` 标志达到同一效果。归一只用于判定形态，权威结论在本函数。
///
/// 规则文本的任何改动都必须与 `src/services/safety/checker.ts` 同时进行。
pub fn is_credential_path(path: &Path) -> bool {
    let lowered = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if lowered.ends_with(".pem") || lowered.ends_with(".key") {
        return true;
    }
    // 按 `/` 切组件：`.sshnotes` 是普通目录名，只有整段等于 `.ssh` 才算目录组件
    lowered.split('/').any(|segment| segment == ".ssh")
}

/// SQLite 的主库与 WAL/SHM 同属 Rust 记忆边界，通用文件工具不能绕过 MemoryStore 直接改写。
/// V1RTUAL、只读导出和备份仍可通过各自的显式入口访问。
pub fn is_managed_memory_path(path: &Path) -> bool {
    let lowered = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let db = super::MEMORY_DB_FILE;
    lowered.ends_with(&format!("/memory/{db}"))
        || lowered.ends_with(&format!("/memory/{db}-wal"))
        || lowered.ends_with(&format!("/memory/{db}-shm"))
        || lowered.ends_with(&format!("/memory/{db}-journal"))
}

pub(crate) fn normalize_absolute(path: &Path) -> AppResult<PathBuf> {
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

/// 跨 crate 消费方（`commands/observation_cmd`）需要该入口，故为 `pub`；
/// 判定逻辑逐字稳定。
pub fn home_dir() -> Option<PathBuf> {
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
