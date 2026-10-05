//! 宿主会话读取：复用 Pi 的解析器，不借用模型文件工具的单次大小上限。
//! 同步阻塞 IO；async 包装（spawn_blocking）由 IPC 分派层负责。

use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path};

pub fn read_session_text(
    base: &Path,
    relative: &str,
    max_lines: Option<usize>,
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
            read_session_text(&fixture.0, "large.jsonl", None).unwrap(),
            content
        );
        assert_eq!(
            read_session_text(&fixture.0, "large.jsonl", Some(1)).unwrap(),
            "{\"header\":true}\n"
        );
        // 尾部不是 UTF-8：请求头必须不解码尾部，否则证明仍在整文件读取。
        let mut file = File::create(fixture.0.join("header.jsonl")).unwrap();
        file.write_all(b"header\n\xff\xfe").unwrap();
        assert_eq!(
            read_session_text(&fixture.0, "header.jsonl", Some(1)).unwrap(),
            "header\n"
        );
        assert!(read_session_text(&fixture.0, "header.jsonl", None).is_err());
    }

    #[test]
    fn refuses_parent_and_absolute_paths() {
        let fixture = Fixture::new();
        assert!(matches!(
            read_session_text(&fixture.0, "../outside", None),
            Err(AppError::PathEscape)
        ));
        assert!(matches!(
            read_session_text(&fixture.0, &fixture.0.to_string_lossy(), None),
            Err(AppError::PathEscape)
        ));
    }
}
