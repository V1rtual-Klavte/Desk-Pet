use crate::error::{err, AppError, AppResult};
use crate::rust_debug;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

// ── 文件操作 ──

/// 操作对象必须是常规文件：FIFO/设备/套接字会让读写无限阻塞或写到设备，
/// 而许可额度要等 handler 结算才释放（tool_permit.rs 明确不加 TTL）→ 从源头拒绝。
///
/// `/dev/null` 类设备目标不豁免（决策 §7 #13）：设备路径本就不在允许根（home/temp）内，
/// 到不了这里；拒绝没有例外分支，避免「按路径文本网开一面」绕过类型判定。
/// `metadata` 必须描述**解析后的叶子**：读路径用跟随符号链接的 `fs::metadata`；
/// 写路径的 `safe_path` 已由 `validate_new_file_path` 解析掉链接叶子，那里取
/// `symlink_metadata` 只是为了与「叶子是什么就是什么」的语义对齐。链接名可以无害，
/// 指向 FIFO 时只有真实类型能说明接下来会打开什么。
fn ensure_regular_file(metadata: &std::fs::Metadata, path: &str) -> AppResult<()> {
    let file_type = metadata.file_type();
    if file_type.is_file() {
        return Ok(());
    }
    Err(AppError::Tool(format!(
        "只允许操作常规文件，目标是{}: {path}",
        describe_file_type(file_type)
    )))
}

/// 非常规文件类型的可读名称，只用于错误文案。
#[cfg(unix)]
fn describe_file_type(file_type: std::fs::FileType) -> &'static str {
    use std::os::unix::fs::FileTypeExt;
    if file_type.is_fifo() {
        "命名管道（FIFO）"
    } else if file_type.is_socket() {
        "套接字"
    } else if file_type.is_char_device() {
        "字符设备"
    } else if file_type.is_block_device() {
        "块设备"
    } else if file_type.is_dir() {
        "目录"
    } else {
        "非常规文件"
    }
}

/// Windows 的 `FileType` 不区分 FIFO/设备/套接字（那些类型在 Windows 上要么不存在、
/// 要么只以句柄形式存在），统一按「非常规文件」报告；拒绝与否不受文案影响。
#[cfg(not(unix))]
fn describe_file_type(_file_type: std::fs::FileType) -> &'static str {
    "非常规文件"
}

pub fn file_read(path: String, max_bytes: Option<usize>) -> AppResult<FileReadResult> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let metadata = std::fs::metadata(&safe_path).map_err(|e| format!("读取元数据失败: {e}"))?;
    // 大小判定之前先判类型：FIFO 的 len 通常是 0，过得了 max_bytes 却过不了 open。
    ensure_regular_file(&metadata, &path)?;
    if max_bytes.is_some_and(|limit| metadata.len() as usize > limit) {
        return err(format!(
            "文件过大，最多读取 {} bytes",
            max_bytes.unwrap_or(0)
        ));
    }
    let content = std::fs::read_to_string(&safe_path).map_err(|e| format!("读取失败: {}", e))?;
    let size = content.len() as u64;
    Ok(FileReadResult { content, size })
}

#[derive(serde::Serialize)]
pub struct FileReadResult {
    pub(crate) content: String,
    pub(crate) size: u64,
}

pub fn file_write(
    path: String,
    content: String,
    max_bytes: Option<usize>,
) -> AppResult<FileWriteResult> {
    use crate::paths::AppPaths;
    if max_bytes.is_some_and(|limit| content.len() > limit) {
        return err(format!(
            "写入内容过大，最多 {} bytes",
            max_bytes.unwrap_or(0)
        ));
    }
    let safe_path = AppPaths::validate_new_file_path(Path::new(&path))?;
    // 已存在的目标可能是 FIFO/设备/套接字：`fs::write` 的 open 会等到对端或写到设备，
    // handler 因此永不结算、许可额度也不释放。不存在才按新建处理。
    // 这里用 `symlink_metadata` 与 `validate_new_file_path` 的叶子语义一致：该函数已把
    // 符号链接叶子解析成真实目标，返回的 `safe_path` 要么不存在，要么就是最终对象本身。
    if let Ok(metadata) = std::fs::symlink_metadata(&safe_path) {
        ensure_regular_file(&metadata, &path)?;
    }
    let parent = safe_path.parent().ok_or("无效的文件路径")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    // 建目录之后再确认一次父目录的去向：校验通过到真正写入之间，
    // 中间目录可能刚被换成指向允许根外的符号链接。
    AppPaths::revalidate_existing_parent(&safe_path)?;
    std::fs::write(&safe_path, &content).map_err(|e| format!("写入失败: {}", e))?;
    Ok(FileWriteResult { success: true })
}

#[derive(serde::Serialize)]
pub struct FileWriteResult {
    success: bool,
}

/// 原子替换写入：与 `file_write` 同校验，但正文先写同目录临时文件再 `rename` 覆盖目标。
///
/// host 服务（Skill 保存、记忆写入）不纳入 ExecutionEnv 的许可域 —— 借用者身份是页面实例，
/// host 没有那个生命周期 —— 但半写窗口同样不该被读者观察到：同目录 rename 是原子的，
/// 读者看到的要么是旧正文，要么是完整新正文。
pub fn file_write_atomic(
    path: String,
    content: String,
    max_bytes: Option<usize>,
) -> AppResult<FileWriteResult> {
    use crate::paths::AppPaths;
    if max_bytes.is_some_and(|limit| content.len() > limit) {
        return err(format!(
            "写入内容过大，最多 {} bytes",
            max_bytes.unwrap_or(0)
        ));
    }
    let safe_path = AppPaths::validate_new_file_path(Path::new(&path))?;
    // 与 file_write 同口径：已存在的目标可能是 FIFO/设备/套接字，`fs::write` 的 open
    // 会等到对端或写到设备，handler 永不结算。不存在才按新建处理。
    if let Ok(metadata) = std::fs::symlink_metadata(&safe_path) {
        ensure_regular_file(&metadata, &path)?;
    }
    let parent = safe_path.parent().ok_or("无效的文件路径")?;
    std::fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
    // 建目录之后再确认一次父目录的去向：校验通过到真正写入之间，
    // 中间目录可能刚被换成指向允许根外的符号链接。
    AppPaths::revalidate_existing_parent(&safe_path)?;

    // 临时文件必须与目标同目录：跨文件系统的 rename 会被内核拒绝（EXDEV）。
    let file_name = safe_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无效的文件名")?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temp_path = parent.join(format!("{file_name}.tmp-{}-{nanos}", std::process::id()));

    if let Err(e) = std::fs::write(&temp_path, &content) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(AppError::Io(format!("写入失败: {e}")));
    }
    // rename 之前再确认一次目标的父目录去向：临时文件已经落盘，失败要清掉。
    if let Err(e) = AppPaths::revalidate_existing_parent(&safe_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&temp_path, &safe_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(AppError::Io(format!("写入失败: {e}")));
    }
    Ok(FileWriteResult { success: true })
}

/// 追加写入：文件不存在则创建，存在则追加到末尾（UTF-8）。
///
/// `max_bytes` 与 `file_write` 同口径，约束本次写入的 `content` 字节数，
/// 而不是追加后的文件总大小 —— 会话存储按行追加，单次上限即调用方的写入节流。
/// 大小上限只在这条命令内校验；文件历史大小属于调用方的存储协议，不在路径守卫的职责内。
pub fn file_append(path: String, content: String, max_bytes: u64) -> AppResult<()> {
    use crate::paths::AppPaths;
    if content.len() as u64 > max_bytes {
        return err(format!("追加内容过大，最多 {max_bytes} bytes"));
    }
    let safe_path = AppPaths::validate_new_file_path(Path::new(&path))?;
    // 与 file_write 同口径：已存在的目标必须是常规文件，FIFO 的 open 会无限等下去。
    if let Ok(metadata) = std::fs::symlink_metadata(&safe_path) {
        ensure_regular_file(&metadata, &path)?;
    }
    let parent = safe_path.parent().ok_or("无效的文件路径")?;
    // 与 file_write 一致：父目录缺失时补齐（FileSystem 契约的 creating parent directories）。
    std::fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
    // 建目录之后再确认一次父目录的去向：校验通过到真正写入之间，
    // 中间目录可能刚被换成指向允许根外的符号链接。
    AppPaths::revalidate_existing_parent(&safe_path)?;
    // append 打开：`create` 覆盖「不存在则创建」，写只在末尾发生。
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&safe_path)
        .map_err(|e| AppError::Io(format!("打开文件失败: {e}")))?;
    file.write_all(content.as_bytes())
        .map_err(|e| AppError::Io(format!("追加失败: {e}")))?;
    Ok(())
}

/// 重命名/移动文件，替换已存在的目标（FileSystem 契约的 replace 语义）。
///
/// 不复制跨文件系统：Unix 走 `rename(2)`；Windows 上 Rust std 的 `fs::rename`
/// 走 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`（标准库 sys/windows/fs.rs），
/// 两端都用原生原子替换，跨卷/盘符时同样直接报错而不是退化为复制。
/// 目标的父目录不在这里创建：会话存储的 publish 流程先 write 临时文件（write 会创建父目录）再 rename。
pub fn file_rename(source_path: String, destination_path: String) -> AppResult<()> {
    use crate::paths::AppPaths;
    let source = AppPaths::validate_file_path(Path::new(&source_path))?;
    // 源只拒绝 FIFO/设备/套接字，**允许目录**：`fs::rename` 是元数据操作，不打开内容、
    // 不会无限阻塞，而「重命名目录」是合法用法（源方案写「source 同理」，
    // 这里按实际阻塞面收窄，避免把目录改名一并禁掉）。
    let source_type = std::fs::symlink_metadata(&source)
        .map_err(|e| AppError::Io(format!("读取元数据失败: {e}")))?
        .file_type();
    if !source_type.is_file() && !source_type.is_dir() {
        return Err(AppError::Tool(format!(
            "只允许重命名常规文件或目录，源是{}: {}",
            describe_file_type(source_type),
            source.display()
        )));
    }
    let target = Path::new(&destination_path);
    // 目标已存在按替换处理：canonicalize 后必须仍在允许根内；
    // 目标不存在则走与 file_write 相同的新文件校验（词法路径 + 最近的已存在祖先）。
    let destination = if target.exists() {
        AppPaths::validate_file_path(target)?
    } else {
        AppPaths::validate_new_file_path(target)?
    };
    rust_debug!(
        "file_rename: {} -> {}",
        source.display(),
        destination.display()
    );
    std::fs::rename(&source, &destination).map_err(|e| AppError::Io(format!("重命名失败: {e}")))?;
    Ok(())
}

/// 删除文件或目录。
///
/// `force = true` 时目标不存在视为成功（仍要过路径守卫，不把根外请求当作幂等成功）；
/// `force = false` 时不存在返回 `PathNotFound`，对应 FileSystem 的 not_found。
/// `recursive = false` 时目标是目录则报错、不删，与 FileSystem 契约的默认值一致。
pub fn file_remove(path: String, recursive: bool, force: bool) -> AppResult<()> {
    use crate::paths::AppPaths;
    let target = Path::new(&path);
    // 存在性判定与 file_exists 一致：exists() 跟随符号链接，悬空链接视为不存在。
    if !target.exists() {
        AppPaths::validate_new_file_path(target)?;
        if force {
            return Ok(());
        }
        return Err(AppError::PathNotFound(path));
    }
    let safe_path = AppPaths::validate_file_path(target)?;
    rust_debug!(
        "file_remove: {} (recursive={recursive})",
        safe_path.display()
    );
    let metadata =
        std::fs::metadata(&safe_path).map_err(|e| AppError::Io(format!("读取元数据失败: {e}")))?;
    if metadata.is_dir() {
        if !recursive {
            return err(format!(
                "目标是目录，需要 recursive = true 才能删除: {}",
                safe_path.display()
            ));
        }
        std::fs::remove_dir_all(&safe_path)
            .map_err(|e| AppError::Io(format!("删除目录失败: {e}")))?;
    } else {
        std::fs::remove_file(&safe_path).map_err(|e| AppError::Io(format!("删除文件失败: {e}")))?;
    }
    Ok(())
}

/// 创建目录。
///
/// `recursive = true` 时补齐缺失的上级目录，已存在视为成功（FileSystem 契约默认 recursive）；
/// `recursive = false` 时父目录缺失或目标已存在都会报错。
pub fn dir_create(path: String, recursive: bool) -> AppResult<()> {
    use crate::paths::AppPaths;
    let target = Path::new(&path);
    // 与 file_write 相同的两段式校验：先词法路径 + 最近的已存在祖先，创建后再确认最终去向。
    let safe_path = AppPaths::validate_new_file_path(target)?;
    let result = if recursive {
        std::fs::create_dir_all(&safe_path)
    } else {
        std::fs::create_dir(&safe_path)
    };
    result.map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
    // 校验到真正创建之间，中间目录可能刚被换成指向允许根外的符号链接；
    // 创建后 canonicalize 一次，把窗口收窄到「本次调用与创建之间」。
    AppPaths::validate_file_path(target)?;
    Ok(())
}

/// 列出目录条目，字段与 FileSystem 契约的 `FileInfo` 一致。
///
/// 符号链接不跟随：`file_type()`/`DirEntry::metadata()` 都按链接自身取元数据，
/// kind 报 `symlink`、size/mtime 也是链接本身的（契约语义，调用方不再二次回填）。
pub fn file_list(path: String) -> AppResult<FileListResult> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    read_file_entries(&safe_path)
}

pub(crate) fn read_file_entries(dir: &Path) -> AppResult<FileListResult> {
    let entries = std::fs::read_dir(dir).map_err(|e| AppError::Io(format!("读取目录失败: {e}")))?;

    let mut file_entries: Vec<FileEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 元数据取不到时按最小信息保留条目（kind 回退 file、size/mtime 为 0），
        // 单个条目读失败不丢掉整次列表：按最小信息保留（kind 回退 file、size/mtime 为 0）。
        let metadata = entry.metadata().ok();
        let kind = entry
            .file_type()
            .map(|t| {
                if t.is_symlink() {
                    "symlink"
                } else if t.is_dir() {
                    "directory"
                } else {
                    "file"
                }
            })
            .unwrap_or("file");
        let mtime_ms = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        file_entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            kind: kind.to_string(),
            size: metadata.map(|m| m.len()).unwrap_or(0),
            mtime_ms,
        });
    }

    // 按字母排序（目录优先；symlink 排在 file 之后）
    file_entries.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(FileListResult {
        entries: file_entries,
    })
}

pub fn file_read_binary(path: String, max_bytes: Option<usize>) -> AppResult<Vec<u8>> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let metadata = std::fs::metadata(&safe_path).map_err(|e| format!("读取元数据失败: {e}"))?;
    ensure_regular_file(&metadata, &path)?;
    let limit = max_bytes.unwrap_or(5 * 1024 * 1024);
    if metadata.len() as usize > limit {
        return err(format!("文件过大，最多读取 {} bytes", limit));
    }
    std::fs::read(&safe_path).map_err(|e| AppError::Io(format!("读取失败: {e}")))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfoResult {
    pub(crate) name: String,
    path: String,
    pub(crate) kind: String,
    pub(crate) size: u64,
    mtime_ms: u64,
}

pub fn file_info(path: String) -> AppResult<FileInfoResult> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let metadata =
        std::fs::symlink_metadata(&safe_path).map_err(|e| format!("读取元数据失败: {e}"))?;
    let kind = if metadata.file_type().is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    };
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileInfoResult {
        name: safe_path
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: safe_path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        size: metadata.len(),
        mtime_ms,
    })
}

pub fn file_exists(path: String) -> AppResult<bool> {
    use crate::paths::AppPaths;
    let p = Path::new(&path);
    if p.exists() {
        AppPaths::validate_file_path(p)?;
        return Ok(true);
    }
    AppPaths::validate_new_file_path(p)?;
    Ok(false)
}

pub fn file_canonical_path(path: String) -> AppResult<String> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    Ok(safe_path.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
pub struct FileListResult {
    pub(crate) entries: Vec<FileEntry>,
}

/// 目录条目，字段与 FileSystem 契约的 `FileInfo` 逐项对应（TS 侧按 camelCase 读取）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub(crate) name: String,
    /// 绝对路径。
    pub(crate) path: String,
    /// `file` / `directory` / `symlink`；符号链接按链接自身报告，不跟随。
    pub(crate) kind: String,
    pub(crate) size: u64,
    pub(crate) mtime_ms: u64,
}
