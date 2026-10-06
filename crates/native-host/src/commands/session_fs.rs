//! 宿主会话读写：读走 Pi 解析器（`read_session_text`），写走会话根专用路径
//! （`write_session_text`）。
//! 与模型文件工具（`tool_exec`）的分界：这两条命令的边界是**会话根**（base 内相对路径 +
//! canonical 校验），不借用工具面文件命令的 home/temp 允许根；单次大小上限由 Node 侧按
//! 会话口径下发（读路径本无大小上限），Rust 不设第二份默认。
//! 同步阻塞 IO；async 包装（spawn_blocking）由 IPC 分派层负责。

use crate::commands::tool_exec::ensure_regular_file;
use crate::error::{AppError, AppResult, err};
use crate::paths::AppPaths;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path};

pub fn read_session_text(
    base: &Path,
    relative: &str,
    max_lines: Option<usize>,
    tail_bytes: Option<usize>,
) -> AppResult<String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::PathEscape);
    }
    let path = AppPaths::validate_path(&base.join(relative), base)?;
    if let Some(window) = tail_bytes {
        // 两种模式语义不同（从头按行 / 从尾按字节），同时传是调用方错误，不静默选一个。
        if max_lines.is_some() {
            return Err(AppError::Config(
                "session_read_text: maxLines 与 tailBytes 不能同时使用".into(),
            ));
        }
        return read_session_tail(&path, window);
    }
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut text = String::new();
    if let Some(limit) = max_lines {
        for _ in 0..limit {
            if reader.read_line(&mut text)? == 0 {
                break;
            }
        }
    } else {
        reader.read_to_string(&mut text)?;
    }
    Ok(text)
}

/// 尾部读取：返回文件最后 `window` 字节内的**完整行**文本（UTF-8）。
///
/// 窗口起点落在行中间时丢弃截断的半行（含窗口内第一个换行）；起点恰好是行首、或窗口
/// 覆盖整个文件时不丢任何行。窗口内没有换行且起点 > 0（单行比窗口还长的极端）返回空串。
/// 读取侧的消费者是会话活动时间扫描（`src/services/session/activity.ts`）：它按窗口逐次
/// 扩大，并以「响应首行是会话头」判定窗口已到文件起点——**不用「两轮文本相同」那种启发式**
/// （长行窗口起步时两轮可能复现同一文本，会把更早的用户条目误判为不存在）。
fn read_session_tail(path: &Path, window: usize) -> AppResult<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(window as u64);
    let mut bytes = Vec::new();
    if start > 0 {
        // 起点前一字节是换行 ⇒ 起点即行首，整窗口都保留；否则先丢掉截断的半行。
        file.seek(SeekFrom::Start(start - 1))?;
        let mut probe = [0u8; 1];
        file.read_exact(&mut probe)?;
        file.read_to_end(&mut bytes)?;
        if probe[0] != b'\n' {
            match bytes.iter().position(|byte| *byte == b'\n') {
                Some(index) => {
                    bytes.drain(..=index);
                }
                None => return Ok(String::new()),
            }
        }
    } else {
        file.read_to_end(&mut bytes)?;
    }
    String::from_utf8(bytes)
        .map_err(|error| AppError::Other(format!("session_read_text: 尾部不是有效 UTF-8: {error}")))
}

/// 会话根内的整文件写入 —— `SessionFileSystem` 的会话写路径（`session_write_text`）。
///
/// 与 `read_session_text` 同输入口径：`relative` 是**会话根内相对路径**，只接
/// `Component::Normal` 分量（空、绝对路径、`.`、`..`、Windows 盘符前缀一律拒绝），
/// 再做 base 边界的 canonical 校验（`AppPaths::validate_new_path_within`）——
/// 目标**可以尚不存在**：折叠先写同目录 `.tmp-*` 临时文件再 rename，写入点必然是新文件，
/// 走不了按已存在文件 canonicalize 的 `validate_path`。
///
/// `max_bytes` 与 `file_write` 同口径（本次 content 的 UTF-8 字节数），由调用方按**会话
/// 专用上限**下发（TS `SESSION_WRITE_MAX_BYTES`，比工具面 5 MiB 放宽）；本命令只把它当参数
/// 执行，不为工具面上限设第二份默认。放宽只对**会话根内的路径**生效 —— 这是与 `file_write`
/// 的关键差别（那条命令的边界是 home/temp 允许根，调用方若传更大的 maxBytes 不会在这里被
/// 会话根拦住）。
pub fn write_session_text(
    base: &Path,
    relative: &str,
    content: &str,
    max_bytes: u64,
) -> AppResult<()> {
    if content.len() as u64 > max_bytes {
        return err(format!("写入内容过大，最多 {max_bytes} bytes"));
    }
    let relative_path = Path::new(relative);
    if relative_path.as_os_str().is_empty()
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::PathEscape);
    }
    let target = base.join(relative_path);
    let safe_path = AppPaths::validate_new_path_within(&target, base)?;
    // 已存在的目标可能是 FIFO/设备/套接字：与 file_write 同口径拒绝（open 会无限阻塞，
    // handler 因此永不结算、许可额度也不释放）。常规文件或不存在才继续。
    if let Ok(metadata) = std::fs::symlink_metadata(&safe_path) {
        ensure_regular_file(&metadata, relative)?;
    }
    let parent = safe_path.parent().ok_or(AppError::PathEscape)?;
    // 与 FileSystem 契约一致：父目录缺失时补齐（会话目录交换/repo 首次写入都会用到）。
    std::fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建目录失败: {e}")))?;
    // 建目录之后再确认一次去向：校验通过到真正写入之间，中间目录可能刚被换成指向会话根外
    // 的符号链接（与 file_write 的 revalidate_existing_parent 同位）。
    AppPaths::validate_new_path_within(&safe_path, base)?;
    std::fs::write(&safe_path, content.as_bytes())
        .map_err(|e| AppError::Io(format!("写入失败: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            // 编译目录只用于测试产物；业务路径始终来自 AppPaths。
            // 工作区测试临时目录固定在仓库根的 test/.tmp（本 crate 位于 crates/native-host）。
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../test/.tmp")
                .join(format!(
                    "session-read-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::SeqCst)
                ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove fixture");
        }
    }

    #[test]
    fn reads_large_sessions_and_only_requested_header() {
        let fixture = Fixture::new();
        let content = format!("{{\"header\":true}}\n{}", "会话正文".repeat(600_000));
        fs::write(fixture.0.join("large.jsonl"), &content).unwrap();
        assert!(content.len() > 5 * 1024 * 1024);
        assert_eq!(
            read_session_text(&fixture.0, "large.jsonl", None, None).unwrap(),
            content
        );
        assert_eq!(
            read_session_text(&fixture.0, "large.jsonl", Some(1), None).unwrap(),
            "{\"header\":true}\n"
        );
        // 尾部不是 UTF-8：请求头必须不解码尾部，否则证明仍在整文件读取。
        let mut file = File::create(fixture.0.join("header.jsonl")).unwrap();
        file.write_all(b"header\n\xff\xfe").unwrap();
        assert_eq!(
            read_session_text(&fixture.0, "header.jsonl", Some(1), None).unwrap(),
            "header\n"
        );
        assert!(read_session_text(&fixture.0, "header.jsonl", None, None).is_err());
    }

    #[test]
    fn reads_tail_only_complete_lines() {
        let fixture = Fixture::new();
        let content = "line-1\nline-2\nline-3\n";
        fs::write(fixture.0.join("tail.jsonl"), content).unwrap();

        // 窗口覆盖整个文件：起点 = 0，不丢任何行。
        assert_eq!(
            read_session_text(&fixture.0, "tail.jsonl", None, Some(64)).unwrap(),
            content
        );
        // 窗口起点是行首（前 7 行为 line-1）：整窗口保留。
        assert_eq!(
            read_session_text(&fixture.0, "tail.jsonl", None, Some(14)).unwrap(),
            "line-2\nline-3\n"
        );
        // 窗口起点落在行中间（字节 13 = 第 2 行的换行）：丢掉截断的半行。
        assert_eq!(
            read_session_text(&fixture.0, "tail.jsonl", None, Some(8)).unwrap(),
            "line-3\n"
        );

        // 多字节字符边界：窗口从字符中间开始时按字节丢弃到下一个换行（不产生乱码行）。
        fs::write(fixture.0.join("cjk.jsonl"), "标题\n正文\n").unwrap();
        assert_eq!(
            read_session_text(&fixture.0, "cjk.jsonl", None, Some(8)).unwrap(),
            "正文\n"
        );

        // 单行比窗口长且窗口内没有换行：如实返回空串（消费方据此扩大窗口）。
        fs::write(fixture.0.join("oneline.jsonl"), "x".repeat(100)).unwrap();
        assert_eq!(
            read_session_text(&fixture.0, "oneline.jsonl", None, Some(10)).unwrap(),
            ""
        );
        assert_eq!(
            read_session_text(&fixture.0, "oneline.jsonl", None, Some(1000)).unwrap(),
            "x".repeat(100)
        );

        // 两种读取模式同传是调用方错误：结构化 CONFIG 拒绝，不静默选一个。
        assert!(matches!(
            read_session_text(&fixture.0, "tail.jsonl", Some(1), Some(4)),
            Err(AppError::Config(_))
        ));
    }

    #[test]
    fn refuses_parent_and_absolute_paths() {
        let fixture = Fixture::new();
        assert!(matches!(
            read_session_text(&fixture.0, "../outside", None, None),
            Err(AppError::PathEscape)
        ));
        assert!(matches!(
            read_session_text(&fixture.0, &fixture.0.to_string_lossy(), None, None),
            Err(AppError::PathEscape)
        ));
    }

    #[test]
    fn writes_new_session_files_within_root() {
        let fixture = Fixture::new();
        // 目标与中间目录都不存在：写路径必须补齐父目录（折叠先写同目录 .tmp-* 就是这一形态）。
        write_session_text(
            &fixture.0,
            "--cwd--/2026_session.jsonl.tmp-1",
            "会话正文",
            1024,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(fixture.0.join("--cwd--/2026_session.jsonl.tmp-1")).unwrap(),
            "会话正文"
        );
        // 覆盖已存在的常规文件同样放行（发布前的重写与折叠结果覆盖共用这条路径）。
        write_session_text(&fixture.0, "--cwd--/2026_session.jsonl.tmp-1", "下一次", 1024)
            .unwrap();
        assert_eq!(
            fs::read_to_string(fixture.0.join("--cwd--/2026_session.jsonl.tmp-1")).unwrap(),
            "下一次"
        );
    }

    #[test]
    fn write_session_text_rejects_oversize_and_escaped_relative_paths() {
        let fixture = Fixture::new();
        // max_bytes 按 UTF-8 字节数比（与 file_write 的 content.len() 同口径）：
        // 400 个中文 = 1200 字节 > 1024，拒绝且不落任何字节。
        let oversize = "字".repeat(400);
        assert!(matches!(
            write_session_text(&fixture.0, "big.jsonl", &oversize, 1024),
            Err(AppError::Other(_))
        ));
        assert!(!fixture.0.join("big.jsonl").exists());

        // 相对路径白名单：空、`..`、绝对路径都产出非 Normal 分量，一律 PathEscape。
        for relative in ["", "../outside.jsonl", "/tmp/outside.jsonl"] {
            assert!(
                matches!(
                    write_session_text(&fixture.0, relative, "x", 1024),
                    Err(AppError::PathEscape)
                ),
                "相对路径 {relative:?} 未被拒绝"
            );
        }
        // 反向对照：300 个中文 = 900 字节 ≤ 1024，按字节计数时必须放行。
        write_session_text(&fixture.0, "ok.jsonl", &"字".repeat(300), 1024).unwrap();
        assert!(fixture.0.join("ok.jsonl").exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_session_text_refuses_symlink_escape_and_existing_fifo() {
        use std::os::unix::fs::symlink;
        let base = Fixture::new();
        let outside = Fixture::new();

        // 中间目录是指向会话根外的符号链接：链接名无害，写入去向必须被拒。
        symlink(&outside.0, base.0.join("link")).unwrap();
        assert!(matches!(
            write_session_text(&base.0, "link/evil.jsonl", "x", 1024),
            Err(AppError::PathEscape)
        ));
        assert!(!outside.0.join("evil.jsonl").exists());

        // 已存在的 FIFO：与 file_write 同口径拒绝，且不得阻塞（放行会一直等读者打开）。
        let fifo = base.0.join("probe.fifo");
        let made = matches!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status(),
            Ok(status) if status.success()
        );
        if made {
            let started = std::time::Instant::now();
            let result = write_session_text(&base.0, "probe.fifo", "x", 1024);
            assert!(
                matches!(result, Err(AppError::Tool(_))),
                "写已存在的 FIFO 必须被拒"
            );
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "拒绝 FIFO 不能阻塞：耗时 {:?}",
                started.elapsed()
            );
        }
    }
}
