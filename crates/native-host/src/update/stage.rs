// ==========================================
// 下载 → 校验 → staging / 安装状态 / 回滚状态机（W10b）
// ==========================================
//
// 分工（契约 §4.5）：
// - **主宿主**：check 之后的下载、逐字节校验、落 staging、写安装状态。应用仍在使用中，
//   不碰安装目录一个字节。
// - **helper**（独立可执行，见 helper.rs）：主宿主退出后替换/重启。它只做"把已经
//   校验过的整套东西原子换上"，并且**再验一遍**（签名 → 哈希 → 包内版本集合）。
//
// 目录/文件布局（全部在应用数据根内，**数据根不在替换目录内**）：
//
//   {data_root}/updates/install-state.json        安装状态（可恢复状态机，见下）
//   {data_root}/updates/{version}/{制品文件名}     staging（helper 重验对象）
//   {install_root}.deskpet-backup                  helper 替换前备份的上一完整版本
//
// 回滚状态机（helper 与启动恢复共用同一套相位；每一步落盘后才做下一步）：
//
//   staged ──(helper 开始)──▶ applying-backup ──(备份改名完成)──▶ applying-replace
//      ▲                                                        │ (替换改名完成)
//      │                                                        ▼
//      └──────────(失败：备份改名换回)──── rolled-back ◀──── installed
//
// 启动恢复只看「相位 + 磁盘现场」三元组（install/backup/staged 是否存在），
// 逐条判定见 [`plan_recovery`]；**任何含糊现场都不自动猜**（AwaitManual）。

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::http::HttpClient;
use super::manifest::{
    ensure_newer, update_error, Component, E_HASH_MISMATCH, E_INSTALL_LAYOUT, E_SIZE_MISMATCH,
    E_STATE,
};
use super::verify::Sha256Hex;

/// 安装状态文件 schemaVersion（本地状态；与 feed 的 schemaVersion 各自独立演进）。
pub const STATE_SCHEMA_VERSION: u32 = 1;

/// 状态文件名（`{data_root}/updates/install-state.json`）。
pub const INSTALL_STATE_FILE_NAME: &str = "install-state.json";

/// 备份目录后缀：`{install_root}.deskpet-backup`。
pub const BACKUP_SUFFIX: &str = ".deskpet-backup";

/// 随包 helper 可执行文件名（与 Cargo.toml 的 [[bin]] name、packaging/desktop.json 一致）。
pub const HELPER_BIN_NAME: &str = "deskpet-update-helper";

// ==========================================
// 宿主安装布局
// ==========================================

/// 宿主进程所在的安装布局。全部从 `current_exe()` 推导，不读 CONFIG、不额外配置路径。
#[derive(Debug, Clone)]
pub struct HostLayout {
    /// 被替换的目录：macOS 是 `.app` 整目录，Windows 是安装目录。
    pub install_root: PathBuf,
    /// 随包 helper 的**源**可执行文件（与主可执行文件同目录）。
    pub helper_source: PathBuf,
    /// staging 根：`{data_root}/updates`。
    pub staging_base: PathBuf,
    /// 应用数据根（helper 日志、状态文件都在这下面）。
    pub data_root: PathBuf,
    /// 当前形态是否允许替换安装（开发构建 / 非 `.app` 形态明确不可安装）。
    pub installable: bool,
    /// 不可安装的原因（日志与错误文案用）。
    pub installable_reason: Option<String>,
}

impl HostLayout {
    pub fn detect(data_root: &Path, exe: &Path) -> AppResult<Self> {
        let exe_dir = exe
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| update_error(E_INSTALL_LAYOUT, "可执行文件没有父目录"))?;
        let helper_name = if cfg!(windows) {
            format!("{HELPER_BIN_NAME}.exe")
        } else {
            HELPER_BIN_NAME.to_string()
        };
        let helper_source = exe_dir.join(helper_name);

        #[cfg(target_os = "macos")]
        let (install_root, layout_ok, layout_reason) = {
            if exe_dir.file_name().and_then(|n| n.to_str()) == Some("MacOS") {
                match exe_dir.parent().and_then(|c| c.parent()) {
                    Some(app) if app.extension().and_then(|e| e.to_str()) == Some("app") => {
                        (app.to_path_buf(), true, None)
                    }
                    _ => (
                        exe_dir.clone(),
                        false,
                        Some("可执行文件不在 .app 包内".to_string()),
                    ),
                }
            } else {
                (
                    exe_dir.clone(),
                    false,
                    Some("开发构建（非 .app 布局）不参与安装替换".to_string()),
                )
            }
        };
        #[cfg(not(target_os = "macos"))]
        let (install_root, layout_ok, layout_reason) = {
            #[cfg(windows)]
            {
                (exe_dir.clone(), true, None)
            }
            #[cfg(not(windows))]
            {
                (
                    exe_dir.clone(),
                    false,
                    Some("原生宿主只支持 macOS 与 Windows".to_string()),
                )
            }
        };

        let installable = !cfg!(debug_assertions) && layout_ok;
        let installable_reason = if cfg!(debug_assertions) {
            Some("debug 构建不参与自更新替换".to_string())
        } else {
            layout_reason
        };

        Ok(Self {
            install_root,
            helper_source,
            staging_base: data_root.join("updates"),
            data_root: data_root.to_path_buf(),
            installable,
            installable_reason,
        })
    }

    pub fn state_path(&self) -> PathBuf {
        self.staging_base.join(INSTALL_STATE_FILE_NAME)
    }

    /// 备份目录：与安装目录同卷（改名才可能是原子的）。
    pub fn backup_root(&self) -> PathBuf {
        let name = self
            .install_root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "install".to_string());
        self.install_root
            .with_file_name(format!("{name}{BACKUP_SUFFIX}"))
    }
}

// ==========================================
// 安装状态
// ==========================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallPhase {
    /// 制品已下载校验完，等用户退出后由 helper 替换。
    Staged,
    /// helper 已开始：即将/正在把安装目录改名为备份。
    ApplyingBackup,
    /// 备份完成，正在把 staging 换上。
    ApplyingReplace,
    /// 替换完成（备份保留到下一次启动清理）。
    Installed,
    /// 替换失败，已回到上一完整版本（需要重新下载才能再试）。
    RolledBack,
}

impl InstallPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::ApplyingBackup => "applying-backup",
            Self::ApplyingReplace => "applying-replace",
            Self::Installed => "installed",
            Self::RolledBack => "rolled-back",
        }
    }
}

/// staging 里的一个已校验制品。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedComponentRecord {
    pub kind: String,
    pub name: String,
    /// staging 中的绝对路径。
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

/// 可恢复的安装状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallState {
    pub schema_version: u32,
    pub phase: InstallPhase,
    /// 发起更新时的当前版本（低版本闸门的基准，helper 复核用）。
    pub from_version: String,
    pub to_version: String,
    /// 本地时间（记录性质）。
    pub updated_at: String,
    pub install_root: PathBuf,
    pub backup_root: PathBuf,
    pub staging_root: PathBuf,
    /// helper 日志目录（`{data_root}/logs`；显式落盘，不靠目录推导）。
    pub log_dir: PathBuf,
    /// 被签名的 envelope 原始字节 + 签名块：helper 复验签名后才相信里面的哈希。
    pub envelope: String,
    pub signature: String,
    pub components: Vec<StagedComponentRecord>,
    /// 用户确认的更新：helper 完成后要重启应用。
    pub restart: bool,
}

pub fn read_state(path: &Path) -> AppResult<Option<InstallState>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)
        .map_err(|e| update_error(E_STATE, format!("读取安装状态失败 {path:?}: {e}")))?;
    let state: InstallState = serde_json::from_str(&text)
        .map_err(|e| update_error(E_STATE, format!("安装状态解析失败 {path:?}: {e}")))?;
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(update_error(
            E_STATE,
            format!(
                "安装状态 schemaVersion={} 不受支持（期望 {}）",
                state.schema_version, STATE_SCHEMA_VERSION
            ),
        ));
    }
    Ok(Some(state))
}

/// 原子写：同目录 `.tmp` → rename。状态文件是恢复的唯一依据，不能写半截。
pub fn write_state(path: &Path, state: &InstallState) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| update_error(E_STATE, "安装状态文件没有父目录"))?;
    fs::create_dir_all(parent)
        .map_err(|e| update_error(E_STATE, format!("创建状态目录失败 {parent:?}: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(state)
        .map_err(|e| update_error(E_STATE, format!("安装状态序列化失败: {e}")))?;
    fs::write(&tmp, text)
        .map_err(|e| update_error(E_STATE, format!("写安装状态失败 {tmp:?}: {e}")))?;
    fs::rename(&tmp, path)
        .map_err(|e| update_error(E_STATE, format!("提交安装状态失败 {path:?}: {e}")))?;
    Ok(())
}

// ==========================================
// 下载 → 校验 → staging
// ==========================================

/// 下载并 staging 一个 release 的全部组件；任一组件失败即整体失败（不留下半个版本）。
pub fn stage_release(
    http: &dyn HttpClient,
    layout: &HostLayout,
    release: &super::manifest::VerifiedRelease,
    from_version: &str,
) -> AppResult<InstallState> {
    if !layout.installable {
        return Err(update_error(
            E_INSTALL_LAYOUT,
            format!(
                "当前构建形态不可安装更新：{}",
                layout.installable_reason.as_deref().unwrap_or("未知原因")
            ),
        ));
    }
    let staging_root = layout.staging_base.join(release.version.to_string());
    if staging_root.exists() {
        fs::remove_dir_all(&staging_root).map_err(|e| {
            update_error(
                E_STATE,
                format!("清理旧 staging 失败 {staging_root:?}: {e}"),
            )
        })?;
    }
    fs::create_dir_all(&staging_root)
        .map_err(|e| update_error(E_STATE, format!("创建 staging 失败 {staging_root:?}: {e}")))?;

    let mut records = Vec::new();
    for component in &release.envelope.components {
        // 组件的声明 size 就是下载硬上限（组件校验已保证 size ≤ limits.maxArtifactBytes）。
        let record = download_component(http, component, &staging_root)?;
        records.push(record);
    }

    let now = chrono::Local::now().to_rfc3339();
    let state = InstallState {
        schema_version: STATE_SCHEMA_VERSION,
        phase: InstallPhase::Staged,
        from_version: from_version.to_string(),
        to_version: release.version.to_string(),
        updated_at: now,
        install_root: layout.install_root.clone(),
        backup_root: layout.backup_root(),
        staging_root: staging_root.clone(),
        log_dir: layout.data_root.join("logs"),
        envelope: release.envelope_bytes.clone(),
        signature: release.signature.clone(),
        components: records,
        restart: true,
    };
    write_state(&layout.state_path(), &state)?;
    Ok(state)
}

/// 单组件下载：边读边写边哈希；size/hash 不符即删除 `.part` 并报错（不静默）。
fn download_component(
    http: &dyn HttpClient,
    component: &Component,
    dest_dir: &Path,
) -> AppResult<StagedComponentRecord> {
    let final_path = dest_dir.join(&component.name);
    let part_path = dest_dir.join(format!("{}.part", component.name));
    let remove_part = |error: AppError| -> AppError {
        let _ = fs::remove_file(&part_path);
        error
    };

    let mut reader = http.get(&component.url)?;
    let mut file = File::create(&part_path).map_err(|e| {
        remove_part(update_error(
            E_STATE,
            format!("创建 {part_path:?} 失败: {e}"),
        ))
    })?;
    let mut hasher = Sha256Hex::new();
    let mut total: u64 = 0;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut chunk).map_err(|e| {
            remove_part(update_error(
                super::manifest::E_NETWORK,
                format!("下载 {} 失败: {e}", component.name),
            ))
        })?;
        if read == 0 {
            break;
        }
        total += read as u64;
        // 声明大小是硬闸：多一个字节就拒绝（边下载边判，不让落盘失控）。
        if total > component.size {
            return Err(remove_part(update_error(
                E_SIZE_MISMATCH,
                format!(
                    "{} 实际大小超出声明 {} 字节（下载中止）",
                    component.name, component.size
                ),
            )));
        }
        hasher.update(&chunk[..read]);
        file.write_all(&chunk[..read]).map_err(|e| {
            remove_part(update_error(
                E_STATE,
                format!("写 {} 失败: {e}", component.name),
            ))
        })?;
    }
    file.flush().map_err(|e| {
        remove_part(update_error(
            E_STATE,
            format!("刷盘 {} 失败: {e}", component.name),
        ))
    })?;
    drop(file);

    if total != component.size {
        return Err(remove_part(update_error(
            E_SIZE_MISMATCH,
            format!(
                "{} 大小不符：声明 {}，实际 {}",
                component.name, component.size, total
            ),
        )));
    }
    let digest = hasher.finish();
    if digest != component.sha256 {
        return Err(remove_part(update_error(
            E_HASH_MISMATCH,
            format!(
                "{} SHA-256 不符：声明 {}，实际 {}",
                component.name, component.sha256, digest
            ),
        )));
    }
    fs::rename(&part_path, &final_path).map_err(|e| {
        remove_part(update_error(
            E_STATE,
            format!("提交 {final_path:?} 失败: {e}"),
        ))
    })?;

    Ok(StagedComponentRecord {
        kind: component.kind.clone(),
        name: component.name.clone(),
        path: final_path,
        size: component.size,
        sha256: component.sha256.clone(),
    })
}

/// helper 安装前对 staging 的**复验**（重算哈希；staged 与 helper 之间隔着一次进程退出，
/// 不假设期间没有被动过）。
pub fn verify_staged_files(state: &InstallState) -> AppResult<()> {
    for record in &state.components {
        let meta = fs::metadata(&record.path).map_err(|e| {
            update_error(E_STATE, format!("staging 文件缺失 {:?}: {e}", record.path))
        })?;
        if meta.len() != record.size {
            return Err(update_error(
                E_SIZE_MISMATCH,
                format!(
                    "staging 文件大小不符 {:?}：记录 {}，实际 {}",
                    record.path,
                    record.size,
                    meta.len()
                ),
            ));
        }
        let mut file = File::open(&record.path)
            .map_err(|e| update_error(E_STATE, format!("打开 {:?} 失败: {e}", record.path)))?;
        let mut hasher = Sha256Hex::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut chunk)
                .map_err(|e| update_error(E_STATE, format!("读取 {:?} 失败: {e}", record.path)))?;
            if read == 0 {
                break;
            }
            hasher.update(&chunk[..read]);
        }
        let digest = hasher.finish();
        if digest != record.sha256 {
            return Err(update_error(
                E_HASH_MISMATCH,
                format!(
                    "staging 文件 SHA-256 不符 {:?}：记录 {}，实际 {}",
                    record.path, record.sha256, digest
                ),
            ));
        }
    }
    // 低版本闸门在 helper 侧再走一次（状态文件可能很旧）。
    ensure_newer(
        &super::manifest::Version::parse(&state.to_version)?,
        &super::manifest::Version::parse(&state.from_version)?,
    )
}

// ==========================================
// 启动恢复：回滚状态机（纯判定 + 执行）
// ==========================================

/// 磁盘现场事实（由调用方探测；纯判定函数因此可全覆盖测试）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryFacts {
    pub install_exists: bool,
    pub backup_exists: bool,
    pub staged_exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryAction {
    /// 无要处理的状态文件。
    NoState,
    /// staged / 非中断相位：保持现场。
    Nothing,
    /// 收尾清场：删除状态文件与 staging（rolled-back 的后续）。
    ClearState,
    /// 备份改名换回安装目录（回滚到上一完整版本）。
    RestoreBackup,
    /// 未发生替换，把记录退回 staged（清掉可能的 .part 残留）。
    KeepStaged,
    /// 替换已完成：补记 installed（备份留给下一次清理）。
    MarkInstalled,
    /// 安装完成态：删除备份与 staging、清掉状态文件。
    CleanupInstalled,
    /// 现场含糊：不动任何东西，如实报告。
    AwaitManual(String),
}

/// 纯判定：相位 + 现场 → 动作。**任何组合都有确定结果**，含糊现场不猜。
pub fn plan_recovery(phase: InstallPhase, facts: RecoveryFacts) -> RecoveryAction {
    match phase {
        InstallPhase::Staged => RecoveryAction::Nothing,
        InstallPhase::RolledBack => RecoveryAction::ClearState,
        InstallPhase::Installed => RecoveryAction::CleanupInstalled,
        InstallPhase::ApplyingBackup => match (facts.install_exists, facts.backup_exists) {
            // 备份改名已完成、安装目录暂缺：换回来 = 回到上一完整版本
            (false, true) => RecoveryAction::RestoreBackup,
            // 还没动过安装目录：记录退回 staged
            (true, false) => RecoveryAction::KeepStaged,
            // 两个都在 / 两个都不在：不是本状态机产生的现场
            _ => RecoveryAction::AwaitManual(format!(
                "applying-backup 现场不完整（install={} backup={}）",
                facts.install_exists, facts.backup_exists
            )),
        },
        InstallPhase::ApplyingReplace => {
            if facts.install_exists {
                // 替换改名已完成（新版本已就位），只是没来得及落 installed
                RecoveryAction::MarkInstalled
            } else if facts.backup_exists {
                // 替换未完成：保守回滚到上一完整版本；已校验的 staging 保留可重试
                RecoveryAction::RestoreBackup
            } else {
                RecoveryAction::AwaitManual(
                    "applying-replace 既无安装目录也无备份，拒绝自动猜测".to_string(),
                )
            }
        }
    }
}

/// 无状态文件时的孤儿清理：`{data_root}/updates/<semver>/` 目录一律视为上次下载的
/// 残留（staged 版本必须伴随状态文件才有效）。
fn clean_orphan_staging(layout: &HostLayout) -> String {
    let Ok(entries) = fs::read_dir(&layout.staging_base) else {
        return "无待恢复的安装状态".to_string();
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if super::manifest::Version::parse(&name).is_err() {
            continue;
        }
        if fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    if removed == 0 {
        "无待恢复的安装状态".to_string()
    } else {
        format!("无安装状态，清理了 {removed} 个孤儿 staging 目录")
    }
}

/// 执行恢复。返回一行可进日志的结论。
pub fn recover_install_state(layout: &HostLayout) -> AppResult<String> {
    let state_path = layout.state_path();
    let Some(state) = read_state(&state_path)? else {
        // 没有状态文件 = 没有占用的 staged 版本：清理孤儿 staging 目录（下载中断后
        // 未写状态就退出的残留）。只删版本号形态的目录，不动 updates/ 下的其他东西。
        return Ok(clean_orphan_staging(layout));
    };
    let facts = RecoveryFacts {
        install_exists: state.install_root.exists(),
        backup_exists: state.backup_root.exists(),
        staged_exists: state.staging_root.exists(),
    };
    let action = plan_recovery(state.phase, facts);
    match action {
        RecoveryAction::NoState | RecoveryAction::Nothing => {
            Ok(format!("安装状态 {} 无需处理", state.phase.as_str()))
        }
        RecoveryAction::ClearState => {
            let _ = fs::remove_dir_all(&state.staging_root);
            let _ = fs::remove_file(&state_path);
            Ok(format!("清理 {} 状态的收尾现场", state.phase.as_str()))
        }
        RecoveryAction::KeepStaged => {
            let mut updated = state.clone();
            updated.phase = InstallPhase::Staged;
            write_state(&state_path, &updated)?;
            Ok("安装目录未被改动，记录退回 staged".to_string())
        }
        RecoveryAction::MarkInstalled => {
            let mut updated = state.clone();
            updated.phase = InstallPhase::Installed;
            write_state(&state_path, &updated)?;
            Ok(format!("补记 installed（{}）", state.to_version))
        }
        RecoveryAction::CleanupInstalled => {
            if state.backup_root.exists() {
                fs::remove_dir_all(&state.backup_root).map_err(|e| {
                    update_error(
                        E_STATE,
                        format!("删除备份目录失败 {:?}: {e}", state.backup_root),
                    )
                })?;
            }
            // staging 删除失败时不删状态文件：下次启动会再清理一遍，不留下没人认领的目录
            // （Windows 上"正在退出"的 helper 镜像可能短暂占用 staging 副本）。
            if state.staging_root.exists() {
                fs::remove_dir_all(&state.staging_root).map_err(|e| {
                    update_error(
                        E_STATE,
                        format!(
                            "删除 staging 目录失败 {:?}（保留状态待下次清理）: {e}",
                            state.staging_root
                        ),
                    )
                })?;
            }
            let _ = fs::remove_file(&state_path);
            Ok(format!("已清理 {} 的备份与 staging", state.to_version))
        }
        RecoveryAction::RestoreBackup => {
            if state.install_root.exists() {
                // 执行前再确认一次；现场在第一判定后被改动过就停下来。
                return Ok(format!(
                    "恢复条件已变化（安装目录已存在 {:?}），保持现状等待人工检查",
                    state.install_root
                ));
            }
            fs::rename(&state.backup_root, &state.install_root).map_err(|e| {
                update_error(
                    E_STATE,
                    format!(
                        "回滚失败：备份 {:?} 换回 {:?} 出错: {e}",
                        state.backup_root, state.install_root
                    ),
                )
            })?;
            // 换回后不再自动重试同一份 staging：标记 rolled-back，用户重新检查更新
            // （否则每次退出都会重新拉起 helper，坏更新会形成循环）。
            let mut updated = state.clone();
            updated.phase = InstallPhase::RolledBack;
            updated.updated_at = chrono::Local::now().to_rfc3339();
            write_state(&state_path, &updated)?;
            Ok(format!(
                "已回滚 {} → {}（staging 保留待重新下载）",
                state.to_version, state.from_version
            ))
        }
        RecoveryAction::AwaitManual(reason) => Ok(format!("需要人工检查：{reason}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::manifest::Component;

    fn facts(install: bool, backup: bool, staged: bool) -> RecoveryFacts {
        RecoveryFacts {
            install_exists: install,
            backup_exists: backup,
            staged_exists: staged,
        }
    }

    #[test]
    fn 恢复判定_staged_与_rolled_back() {
        assert_eq!(
            plan_recovery(InstallPhase::Staged, facts(true, false, true)),
            RecoveryAction::Nothing
        );
        assert_eq!(
            plan_recovery(InstallPhase::RolledBack, facts(true, true, true)),
            RecoveryAction::ClearState
        );
    }

    #[test]
    fn 恢复判定_applying_backup() {
        // 备份改名完成、安装目录暂缺 → 回滚
        assert_eq!(
            plan_recovery(InstallPhase::ApplyingBackup, facts(false, true, true)),
            RecoveryAction::RestoreBackup
        );
        // 还没动过安装目录 → 退回 staged
        assert_eq!(
            plan_recovery(InstallPhase::ApplyingBackup, facts(true, false, true)),
            RecoveryAction::KeepStaged
        );
        // 两个都在 → 不猜
        assert!(matches!(
            plan_recovery(InstallPhase::ApplyingBackup, facts(true, true, true)),
            RecoveryAction::AwaitManual(_)
        ));
        // 两个都不在 → 不猜
        assert!(matches!(
            plan_recovery(InstallPhase::ApplyingBackup, facts(false, false, false)),
            RecoveryAction::AwaitManual(_)
        ));
    }

    #[test]
    fn 恢复判定_applying_replace() {
        // 替换已完成 → 补记 installed
        assert_eq!(
            plan_recovery(InstallPhase::ApplyingReplace, facts(true, true, true)),
            RecoveryAction::MarkInstalled
        );
        // 替换未完成但有备份 → 回滚
        assert_eq!(
            plan_recovery(InstallPhase::ApplyingReplace, facts(false, true, true)),
            RecoveryAction::RestoreBackup
        );
        // 无安装也无备份 → 不猜
        assert!(matches!(
            plan_recovery(InstallPhase::ApplyingReplace, facts(false, false, true)),
            RecoveryAction::AwaitManual(_)
        ));
    }

    #[test]
    fn 恢复判定_installed_进入清理() {
        assert_eq!(
            plan_recovery(InstallPhase::Installed, facts(true, true, true)),
            RecoveryAction::CleanupInstalled
        );
    }

    #[test]
    fn 状态文件往返与相位字符串稳定() {
        let state = InstallState {
            schema_version: STATE_SCHEMA_VERSION,
            phase: InstallPhase::ApplyingReplace,
            from_version: "0.16.0".to_string(),
            to_version: "0.17.0".to_string(),
            updated_at: "2026-10-04T12:00:00+08:00".to_string(),
            install_root: PathBuf::from("/Applications/v1rtual-desk-pet.app"),
            backup_root: PathBuf::from("/Applications/v1rtual-desk-pet.app.deskpet-backup"),
            staging_root: PathBuf::from("/data/updates/0.17.0"),
            log_dir: PathBuf::from("/data/logs"),
            envelope: "{}".to_string(),
            signature: "sig".to_string(),
            components: vec![StagedComponentRecord {
                kind: "app".to_string(),
                name: "a.app.tar.gz".to_string(),
                path: PathBuf::from("/data/updates/0.17.0/a.app.tar.gz"),
                size: 7,
                sha256: "a".repeat(64),
            }],
            restart: true,
        };
        let text = serde_json::to_string(&state).unwrap();
        let back: InstallState = serde_json::from_str(&text).unwrap();
        assert_eq!(state, back);
        // 相位字符串是落盘契约的一部分：改名会让恢复读不懂旧状态
        assert_eq!(InstallPhase::Staged.as_str(), "staged");
        assert_eq!(InstallPhase::ApplyingBackup.as_str(), "applying-backup");
        assert_eq!(InstallPhase::ApplyingReplace.as_str(), "applying-replace");
        assert_eq!(InstallPhase::Installed.as_str(), "installed");
        assert_eq!(InstallPhase::RolledBack.as_str(), "rolled-back");
        assert_eq!(
            serde_json::to_value(InstallPhase::ApplyingReplace).unwrap(),
            serde_json::json!("applying-replace")
        );
    }

    #[test]
    fn 下载校验_尺寸与哈希不符即拒绝并清理_part() {
        // 假 HTTP：字节流与声明不符。staging 目录用临时目录（不触碰任何真实数据）。
        struct StaticHttp(Vec<u8>);
        impl crate::update::http::HttpClient for StaticHttp {
            fn get(&self, _url: &str) -> AppResult<Box<dyn std::io::Read + Send + Sync>> {
                Ok(Box::new(std::io::Cursor::new(self.0.clone())))
            }
        }
        let dir = std::env::temp_dir().join(format!(
            "deskpet-update-stage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let declared = Component {
            kind: "app".to_string(),
            name: "x.app.tar.gz".to_string(),
            url: "https://example.com/x.app.tar.gz".to_string(),
            size: 3,
            sha256: crate::update::verify::sha256_hex(b"abc"),
        };
        // 大小超出声明：中止并删 .part
        let too_long =
            download_component(&StaticHttp(b"abcd".to_vec()), &declared, &dir).unwrap_err();
        assert_eq!(too_long.code(), E_SIZE_MISMATCH);
        assert!(!dir.join("x.app.tar.gz.part").exists());

        // 大小相符但哈希不符：拒绝并删 .part
        let wrong_hash = Component {
            sha256: "b".repeat(64),
            ..declared.clone()
        };
        let err = download_component(&StaticHttp(b"abc".to_vec()), &wrong_hash, &dir).unwrap_err();
        assert_eq!(err.code(), E_HASH_MISMATCH);
        assert!(!dir.join("x.app.tar.gz.part").exists());

        // 正确字节：落下最终文件
        let record = download_component(&StaticHttp(b"abc".to_vec()), &declared, &dir).unwrap();
        assert_eq!(record.size, 3);
        assert!(dir.join("x.app.tar.gz").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn staging_复验重算哈希() {
        let dir = std::env::temp_dir().join(format!(
            "deskpet-update-verify-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("x.app.tar.gz");
        fs::write(&file, b"abc").unwrap();

        let state = InstallState {
            schema_version: STATE_SCHEMA_VERSION,
            phase: InstallPhase::Staged,
            from_version: "0.16.0".to_string(),
            to_version: "0.17.0".to_string(),
            updated_at: "now".to_string(),
            install_root: dir.join("install"),
            backup_root: dir.join("backup"),
            staging_root: dir.clone(),
            log_dir: dir.join("logs"),
            envelope: "{}".to_string(),
            signature: "sig".to_string(),
            components: vec![StagedComponentRecord {
                kind: "app".to_string(),
                name: "x.app.tar.gz".to_string(),
                path: file.clone(),
                size: 3,
                sha256: "b".repeat(64),
            }],
            restart: true,
        };
        let err = verify_staged_files(&state).unwrap_err();
        assert_eq!(err.code(), E_HASH_MISMATCH);

        let mut fixed = state.clone();
        fixed.components[0].sha256 = crate::update::verify::sha256_hex(b"abc");
        assert!(verify_staged_files(&fixed).is_ok());

        // 文件被换掉 → 复验必须抓住
        fs::write(&file, b"abd").unwrap();
        assert_eq!(
            verify_staged_files(&fixed).unwrap_err().code(),
            E_HASH_MISMATCH
        );

        fs::remove_dir_all(&dir).unwrap();
    }
}
