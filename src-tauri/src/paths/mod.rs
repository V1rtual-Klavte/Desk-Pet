mod security;
mod seeding;

use security::{is_allowed_file_path, normalize_absolute};
pub use security::{is_credential_path, is_managed_memory_path};
use seeding::{seed_default_resources, seed_e2e_stages};
pub use seeding::{restore_default_resources, SeedSummary};

// src-tauri/src/paths.rs
// ==========================================
// 统一路径管理 — base dirs + 路径校验
// ==========================================

use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::error::{AppError, AppResult};

pub struct AppPaths {
    pub data_root: PathBuf,   // 统一读写根
    pub memory: PathBuf,      // {data_root}/memory/
    pub sessions: PathBuf,    // {data_root}/sessions/
    pub personality: PathBuf, // {data_root}/personality/
    pub profiles: PathBuf,    // {data_root}/profiles/
    pub skills: PathBuf,      // {data_root}/skills/
    pub settings: PathBuf,    // {data_root}/settings/
    pub logs: PathBuf,        // {data_root}/logs/ —— 日志落盘
    pub config_file: PathBuf, // 开发 CONFIG-DEV.yaml / 生产 settings/CONFIG.yaml
    pub runtime_mode: &'static str,

    // 仅用于首次初始化的随包种子；业务读取和写入始终只使用上面的运行时目录。
    pub seed_personality_cards: PathBuf,
    pub seed_profiles: PathBuf,
    pub seed_skills: PathBuf,
}

impl AppPaths {
    pub fn init(app: &tauri::AppHandle) -> AppResult<Self> {
        let resource = resolve_resource_dir(app)?;

        // 唯一环境判断：开发→项目工作区，生产→Tauri 应用专属数据目录。
        let data_root = if cfg!(debug_assertions) {
            // 临时根只允许由 E2E runner 启用，普通 `tauri dev` 不受遗留环境变量影响。
            if is_e2e() {
                std::env::var("DESKPET_E2E_DATA_ROOT")
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
            skills: data_root.join("skills"),
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
            seed_skills: resource.join("defaults").join("skills"),
            data_root,
        };

        for dir in [
            &paths.memory,
            &paths.sessions,
            &paths.personality,
            &paths.profiles,
            &paths.skills,
            &paths.settings,
            &paths.logs,
        ] {
            fs::create_dir_all(dir)
                .map_err(|e| AppError::Io(format!("创建目录失败: {dir:?}: {e}")))?;
        }

        seed_default_resources(&paths)?;

        if cfg!(debug_assertions) && is_e2e() {
            seed_e2e_stages(&paths)?;
        }

        if !cfg!(debug_assertions) && !paths.config_file.exists() {
            fs::write(&paths.config_file, include_str!("../../../CONFIG.yaml")).map_err(|e| {
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
        // 词法优先：不存在的路径也要先得到凭据结论，而不是 PATH_NOT_FOUND ——
        // 调用方读不存在的私钥与读存在的私钥都是「不该发生」，错误码不该随磁盘状态变。
        if is_credential_path(path) {
            return Err(AppError::SensitivePath);
        }
        if is_managed_memory_path(path) {
            return Err(AppError::MemoryProtectedPath);
        }
        let resolved = path
            .canonicalize()
            .map_err(|_| AppError::PathNotFound(path.to_string_lossy().to_string()))?;
        // canonicalize 之后再判一次：符号链接与 Windows 短名会把 `.ssh`/`.pem` 藏在解析结果里，
        // 只看请求文本会漏掉「链接名无害、指向私钥」这一形态。
        if is_credential_path(&resolved) {
            return Err(AppError::SensitivePath);
        }
        if is_managed_memory_path(&resolved) {
            return Err(AppError::MemoryProtectedPath);
        }
        if !is_allowed_file_path(&resolved)? {
            return Err(AppError::PathEscape);
        }
        Ok(resolved)
    }

    /// 校验尚不存在的文件路径。返回规范化绝对路径，不创建任何目录。
    pub fn validate_new_file_path(path: &Path) -> AppResult<PathBuf> {
        let normalized = normalize_absolute(path)?;
        // 词法优先（在归一化路径上判，`./`、`..` 已被折叠），先于允许根判定
        if is_credential_path(&normalized) {
            return Err(AppError::SensitivePath);
        }
        if is_managed_memory_path(&normalized) {
            return Err(AppError::MemoryProtectedPath);
        }
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
        // 祖先的 canonicalize 结果同样要过凭据判定：目标是新文件，凭据形态只能藏在父目录上
        if is_credential_path(&canonical_ancestor) {
            return Err(AppError::SensitivePath);
        }
        if !is_allowed_file_path(&canonical_ancestor)? {
            return Err(AppError::PathEscape);
        }

        // 上面的前缀检查都建立在不解析符号链接的词法路径上，而写入会跟随叶子。
        // 叶子是指向根外的链接时，前面全是绿灯、实际数据却落在允许根之外。
        if let Ok(meta) = fs::symlink_metadata(&normalized) {
            if meta.file_type().is_symlink() {
                // 悬空链接的 canonicalize() 必然失败，那个失败本身就是结论：
                // 写入会替调用方在根外新建文件，只能拒绝。
                let resolved = normalized
                    .canonicalize()
                    .map_err(|_| AppError::PathEscape)?;
                // 叶子链接解析后的真实目标：链接名可以任意，凭据形态只在这里现形
                if is_credential_path(&resolved) {
                    return Err(AppError::SensitivePath);
                }
                if is_managed_memory_path(&resolved) {
                    return Err(AppError::MemoryProtectedPath);
                }
                if !is_allowed_file_path(&resolved)? {
                    return Err(AppError::PathEscape);
                }
                return Ok(resolved);
            }
        }
        Ok(normalized)
    }

    /// `create_dir_all` 之后重新确认父目录仍解析在允许根内。
    ///
    /// 校验与实际写入之间存在时间窗口，中间某个目录组件可能被换成指向根外的符号链接。
    /// 这里再解析一次，把窗口收窄到「本次调用与 write 之间」。
    pub fn revalidate_existing_parent(path: &Path) -> AppResult<()> {
        let parent = path.parent().ok_or(AppError::PathEscape)?;
        let resolved = parent
            .canonicalize()
            .map_err(|_| AppError::PathNotFound(parent.to_string_lossy().to_string()))?;
        if !is_allowed_file_path(&resolved)? {
            return Err(AppError::PathEscape);
        }
        Ok(())
    }
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

pub(crate) fn is_e2e() -> bool {
    std::env::var("DESKPET_E2E").ok().as_deref() == Some("1")
}

/// E2E 只从由 AppPaths 定义的开发根复制阶段种子，避免测试脚本另行维护路径布局。


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
            skills: root.join("skills"),
            settings: root.join("settings"),
            logs: root.join("logs"),
            config_file: root.join("CONFIG.yaml"),
            runtime_mode: "test",
            seed_personality_cards: seeds.join("personality/cards"),
            seed_profiles: seeds.join("profiles"),
            seed_skills: seeds.join("skills"),
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

    #[test]
    fn restore_overwrites_builtin_resources_but_keeps_user_ones() {
        let suffix = format!(
            "deskpet-restore-{}-{}",
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

        // 内置资源被用户改过；另有一份用户自建的资源
        fs::create_dir_all(paths.profiles.join("default")).unwrap();
        fs::write(
            paths.profiles.join("default/profile.yaml"),
            "meta: {edited: true}\n",
        )
        .unwrap();
        fs::create_dir_all(paths.profiles.join("mine")).unwrap();
        fs::write(paths.profiles.join("mine/profile.yaml"), "meta: {}\n").unwrap();

        let summary = restore_default_resources(&paths).unwrap();
        assert_eq!((summary.profiles, summary.cards, summary.skills), (1, 1, 0));

        assert_eq!(
            fs::read_to_string(paths.profiles.join("default/profile.yaml")).unwrap(),
            "meta: {}\n",
            "内置资源应被种子覆盖"
        );
        assert!(
            paths.profiles.join("mine/profile.yaml").exists(),
            "用户自建的 Profile 不在种子里，不应被删除"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    /// 创建符号链接。unix 与 windows 的 API 不同，两端都要能编译。
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

    fn symlink_test_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "deskpet-{tag}-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn new_file_path_rejects_symlink_leaf() {
        let root = symlink_test_root("symlink");

        // 悬空链接：canonicalize 必然失败，而写入会替调用方在根外新建文件 —— 必须拒绝
        let dangling = root.join("dangling.json");
        if symlink_file(&root.join("never-created.json"), &dangling).is_err() {
            // Windows 未开启开发者模式时创建符号链接需要管理员权限，跳过而不是误报失败
            fs::remove_dir_all(&root).unwrap();
            return;
        }
        assert!(matches!(
            AppPaths::validate_new_file_path(&dangling),
            Err(AppError::PathEscape)
        ));

        // 指向根内真实文件的链接：放行，并返回解析后的真实路径
        let real = root.join("real.json");
        fs::write(&real, "x").unwrap();
        let linked = root.join("linked.json");
        symlink_file(&real, &linked).unwrap();
        assert_eq!(
            AppPaths::validate_new_file_path(&linked).unwrap(),
            real.canonicalize().unwrap()
        );

        // 普通的新文件路径不能被这次加固误伤
        let plain = root.join("nested/plain.json");
        assert_eq!(AppPaths::validate_new_file_path(&plain).unwrap(), plain);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn revalidate_existing_parent_requires_a_real_parent() {
        let root = symlink_test_root("parent");
        assert!(AppPaths::revalidate_existing_parent(&root.join("ok.json")).is_ok());
        assert!(AppPaths::revalidate_existing_parent(&root.join("missing/ok.json")).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    // ── 凭据路径（与 TS `checker.ts` 的共享 fixture 列表）──
    // NOWAY / SAFE 两组逐字对应 `test/integration/safety/安全等级边界.test.ts`
    // 的断言输入（W2 从 L4 场景迁到 L3）；规则文本或列表改动必须两侧同时改。

    /// NOWAY 组：`.ssh` 目录组件或 `.pem`/`.key` 后缀，写成相对/`~`/`$HOME`/带反斜杠/夹 `..` 都不改变结论。
    const CREDENTIAL_PATHS: [&str; 9] = [
        ".ssh/id_rsa",
        "~/.ssh/id_rsa",
        "$HOME/.ssh/id_rsa",
        "${HOME}/.ssh/id_rsa",
        r"C:\Users\me\.ssh\id_rsa",
        "x/../.ssh/id_rsa",
        "./cert.pem",
        "~/server.key",
        "/etc/ssl/private/a.PEM",
    ];

    /// SAFE 组：普通路径；`.sshnotes` 不是 `.ssh` 目录组件，不能连坐。
    /// 末项是 Rust 侧特有的反斜杠归一对照：`\` → `/` 不能把普通 Windows 路径变成命中。
    const ORDINARY_PATHS: [&str; 5] = [
        "notes.md",
        "/tmp/out.txt",
        "",
        "/Users/me/.sshnotes/readme.md",
        "C:\\Users\\me\\notes.md",
    ];

    #[test]
    fn credential_paths_are_rejected_lexically() {
        for raw in CREDENTIAL_PATHS {
            assert!(
                is_credential_path(Path::new(raw)),
                "凭据路径未被识别: {raw}"
            );
        }
        for raw in ORDINARY_PATHS {
            assert!(
                !is_credential_path(Path::new(raw)),
                "普通路径被误判为凭据路径: {raw}"
            );
        }
    }

    /// 词法优先：路径不存在时也必须得到 SENSITIVE_PATH，而不是 PATH_NOT_FOUND。
    /// 判定若只在 canonicalize 之后，这条会拿到 PathNotFound —— 两条断言一起把顺序钉死。
    #[test]
    fn validate_file_path_rejects_credential_path_before_resolving() {
        let root = symlink_test_root("credential-lexical");
        let missing = root.join(".ssh").join("id_rsa");
        assert!(!missing.exists(), "探针路径必须是「不存在」的");
        assert!(matches!(
            AppPaths::validate_file_path(&missing),
            Err(AppError::SensitivePath)
        ));

        // 夹了 `..` 的形态同样在词法阶段就被拦下，不依赖磁盘上是否真有这一层
        let dotted = root.join("x").join("..").join(".ssh").join("id_rsa");
        assert!(matches!(
            AppPaths::validate_file_path(&dotted),
            Err(AppError::SensitivePath)
        ));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn validate_new_file_path_rejects_credential_target() {
        let root = symlink_test_root("credential-new-file");
        let target = root.join("x").join("cert.pem");
        assert!(matches!(
            AppPaths::validate_new_file_path(&target),
            Err(AppError::SensitivePath)
        ));

        // 收尾：整棵探针目录都没有被创建（校验不产生副作用）
        assert!(!root.join("x").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn generic_file_tools_cannot_reach_managed_memory_database() {
        let root = symlink_test_root("memory-protected");
        let database = root.join("memory").join("memory.sqlite3");
        assert!(matches!(
            AppPaths::validate_file_path(&database),
            Err(AppError::MemoryProtectedPath)
        ));
        assert!(matches!(
            AppPaths::validate_new_file_path(&database),
            Err(AppError::MemoryProtectedPath)
        ));
        assert!(is_managed_memory_path(&root.join("memory/memory.sqlite3-wal")));
        assert!(!is_managed_memory_path(&root.join("memory/V1RTUAL.md")));
        fs::remove_dir_all(&root).unwrap();
    }
}
