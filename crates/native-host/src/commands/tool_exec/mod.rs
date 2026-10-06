// Rust 工具执行域的命令面：transport 无关的普通函数，宿主 IPC 层与测试共用。
// 命令名与参数收窄在调用侧保持稳定；本模块只保留稳定导出，不依赖 UI 框架。
//
// 线程语义：Bash 的 `run_bash` 同步阻塞调用线程，非阻塞命令入口负责把它放进
// 工作线程（不得让调度线程被阻塞等待）。

mod bash;
mod desktop;
mod fs;
mod system;

pub use bash::{cancel_in_pool, run_bash, BashPool, BashResult};
pub use desktop::{
    app_open, clipboard_read, clipboard_write, AppOpenResult, ClipboardResult, ClipboardWriteResult,
};
pub use fs::{
    dir_create, file_append, file_canonical_path, file_exists, file_info, file_list, file_read,
    file_read_binary, file_remove, file_rename, file_write, file_write_atomic, FileEntry,
    FileInfoResult, FileListResult, FileReadResult, FileWriteResult,
};
pub use system::{system_info, SystemInfoResult};

#[cfg(test)]
pub(crate) use bash::{
    combine_windows, stats_of, truncate_output, BashSlot, CapturedOutput, TailWindow,
    DEFAULT_BASH_TIMEOUT_MS,
};
#[cfg(test)]
pub(crate) use fs::read_file_entries;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// 改成尾部窗口读取之前的实现：对全量文本直接截断。
    /// 新实现必须只在「内存占用」上与它不同，结果必须逐字段一致。
    fn reference_truncate(text: &str, max_bytes: usize, max_lines: usize) -> CapturedOutput {
        let total_bytes = text.len();
        let total_lines = if text.is_empty() {
            0
        } else {
            text.lines().count()
        };
        let mut start = 0;
        let mut truncated_by = None;
        if total_lines > max_lines {
            start = text
                .match_indices('\n')
                .rev()
                .nth(max_lines.saturating_sub(1))
                .map(|(index, _)| index + 1)
                .unwrap_or(0);
            truncated_by = Some("lines".to_string());
        }
        if text.len().saturating_sub(start) > max_bytes {
            start = text.len().saturating_sub(max_bytes);
            while start < text.len() && !text.is_char_boundary(start) {
                start += 1;
            }
            truncated_by = Some("bytes".to_string());
        }
        let output = text[start..].to_string();
        let last_line_partial =
            start > 0 && text.as_bytes().get(start.saturating_sub(1)) != Some(&b'\n');
        CapturedOutput {
            output_bytes: output.len(),
            output_lines: output.lines().count(),
            truncated: start > 0,
            output,
            total_bytes,
            total_lines,
            truncated_by,
            last_line_partial,
        }
    }

    /// 复刻 `read_tail_window` 的窗口语义，不碰文件系统。
    fn window_of(full: &str, max_bytes: usize) -> TailWindow {
        let bytes = full.as_bytes();
        if bytes.len() <= max_bytes {
            return TailWindow {
                text: full.to_string(),
                stats: stats_of(bytes),
                starts_at_line_start: true,
                clipped: false,
            };
        }
        let start = bytes.len() - max_bytes - 1;
        let body = &bytes[start + 1..];
        let mut skip = 0;
        while skip < body.len().min(3) && body[skip] & 0xC0 == 0x80 {
            skip += 1;
        }
        TailWindow {
            text: String::from_utf8_lossy(&body[skip..]).into_owned(),
            stats: stats_of(bytes),
            starts_at_line_start: bytes[start] == b'\n',
            clipped: true,
        }
    }

    /// `compare_reason=false` 用于窗口被裁剪的场景：那里 `truncated_by` 允许与参考实现不同。
    ///
    /// 参考实现总能在全量文本里定位到行截断点；窗口化实现只看得到尾部，
    /// 当行截断点正好落在窗口起点时，尾窗里已经没有换行符可定位，标签便由「行」退化为「字节」。
    /// 两种标签都描述了真实发生过的截断，只有这个纯展示字段不同。
    /// 此时改断言更强的不变量：`truncated_by` 与 `truncated` 必须同进同退。
    fn assert_same(
        actual: &CapturedOutput,
        expected: &CapturedOutput,
        case: &str,
        compare_reason: bool,
    ) {
        assert_eq!(actual.output, expected.output, "{case}: output 不一致");
        assert_eq!(
            actual.truncated, expected.truncated,
            "{case}: truncated 不一致"
        );
        if compare_reason {
            assert_eq!(
                actual.truncated_by, expected.truncated_by,
                "{case}: truncated_by 不一致"
            );
        } else {
            assert_eq!(
                actual.truncated_by.is_some(),
                actual.truncated,
                "{case}: truncated 与 truncated_by 必须同时有值"
            );
        }
        assert_eq!(
            actual.total_bytes, expected.total_bytes,
            "{case}: total_bytes 不一致"
        );
        assert_eq!(
            actual.total_lines, expected.total_lines,
            "{case}: total_lines 不一致"
        );
        assert_eq!(
            actual.output_bytes, expected.output_bytes,
            "{case}: output_bytes 不一致"
        );
        assert_eq!(
            actual.output_lines, expected.output_lines,
            "{case}: output_lines 不一致"
        );
        assert_eq!(
            actual.last_line_partial, expected.last_line_partial,
            "{case}: last_line_partial 不一致"
        );
    }

    #[test]
    fn stats_lines_matches_str_lines() {
        for text in [
            "", "a", "a\n", "a\nb", "a\n\n", "\n", "\n\n", "a\nb\n", "\n\n\n",
        ] {
            assert_eq!(
                stats_of(text.as_bytes()).lines(),
                text.lines().count(),
                "文本 {text:?} 的行数统计与 str::lines 不一致"
            );
        }
    }

    /// 窗口不小于原文时，新实现必须与参考实现（reference_truncate）完全一致。
    #[test]
    fn window_not_clipped_matches_reference() {
        let cases = [
            "",
            "short",
            "no trailing newline",
            "trailing newline\n",
            "line1\nline2\nline3\nline4\nline5\n",
            "中文多字节内容\n第二行内容\n第三行内容\n",
        ];
        for text in cases {
            for (max_bytes, max_lines) in [(50 * 1024, 2000), (8, 2000), (1024, 2), (4, 1), (0, 0)]
            {
                let stats = stats_of(text.as_bytes());
                let actual = truncate_output(text, &stats, true, false, max_bytes, max_lines);
                let expected = reference_truncate(text, max_bytes, max_lines);
                assert_same(
                    &actual,
                    &expected,
                    &format!("{text:?} @ {max_bytes}/{max_lines}"),
                    true,
                );
            }
        }
    }

    /// 窗口被裁剪时（原文超过 max_bytes），端到端的截断结果仍要与整读原文一致。
    #[test]
    fn clipped_window_matches_reference() {
        let long = "x".repeat(300) + "\n" + &"y".repeat(300) + "\n" + &"z".repeat(300);
        // 单字节字符：窗口起点可能落在任意偏移，覆盖到与没覆盖到换行两种情形
        for max_bytes in [1, 7, 64, 300, 301, 599, 600, 601, 900] {
            for max_lines in [1, 2, 3, 2000] {
                let stdout = window_of(&long, max_bytes);
                let empty = window_of("", max_bytes);
                let (text, stats, starts_at_line_start, clipped) = combine_windows(stdout, empty);
                let actual = truncate_output(
                    &text,
                    &stats,
                    starts_at_line_start,
                    clipped,
                    max_bytes,
                    max_lines,
                );
                let expected = reference_truncate(&long, max_bytes, max_lines);
                assert_same(
                    &actual,
                    &expected,
                    &format!("裁剪窗口 @ {max_bytes}/{max_lines}"),
                    false,
                );
            }
        }
    }

    /// 多字节字符被窗口从中间切开时，既不能产出非法 UTF-8，也不能丢掉尾部。
    /// `max_bytes` 小于单个字符宽度（3 字节）时结果为空的空串本就是正确行为 ——
    /// 末尾窗口装不下一个完整字符，参考实现在同一输入下同样返回空串。
    #[test]
    fn clipped_window_aligns_multibyte_boundary() {
        let long = "字".repeat(500); // 每个字符 3 字节
        for max_bytes in [1, 2, 3, 4, 5, 6, 7, 100, 101] {
            let stdout = window_of(&long, max_bytes);
            let empty = window_of("", max_bytes);
            let (text, stats, starts_at_line_start, clipped) = combine_windows(stdout, empty);
            let actual = truncate_output(
                &text,
                &stats,
                starts_at_line_start,
                clipped,
                max_bytes,
                2000,
            );
            let expected = reference_truncate(&long, max_bytes, 2000);
            assert_same(
                &actual,
                &expected,
                &format!("多字节窗口 @ {max_bytes}"),
                true,
            );
            assert!(
                long.ends_with(&actual.output),
                "{max_bytes}: 输出不是原文的后缀"
            );
        }
    }

    /// 两路输出合并后的统计与直接拼接全量文本一致。
    #[test]
    fn combined_stats_match_concatenation() {
        let pairs = [
            ("", ""),
            ("out\n", ""),
            ("", "err\n"),
            ("out\n", "err\n"),
            ("out", "err"),
            ("out\n", "err"),
            ("out", "err\n"),
        ];
        for (a, b) in pairs {
            let full = if b.is_empty() {
                a.to_string()
            } else if a.is_empty() {
                b.to_string()
            } else {
                format!("{a}\n{b}")
            };
            let (text, stats, _, clipped) = combine_windows(window_of(a, 1024), window_of(b, 1024));
            assert_eq!(text, full, "{a:?}+{b:?}: 合并文本不一致");
            assert!(!clipped, "{a:?}+{b:?}: 不该被裁剪");
            assert_eq!(stats.bytes, full.len(), "{a:?}+{b:?}: total_bytes 不一致");
            assert_eq!(
                stats.lines(),
                full.lines().count(),
                "{a:?}+{b:?}: total_lines 不一致"
            );
        }
    }

    /// `system_info` 曾因漏掉 `rename_all = "camelCase"` 让前端数值字段全读到 undefined，
    /// 界面上显示成 `NaNGB / NaNGB`。类型检查两边都发现不了，只能钉住线上载荷的字段名。
    #[test]
    fn system_info_payload_uses_camel_case() {
        let payload = serde_json::to_value(SystemInfoResult {
            os: "macos".into(),
            arch: "aarch64".into(),
            cpu_count: 8,
            mem_total: 16 * 1024 * 1024 * 1024,
            mem_used: 8 * 1024 * 1024 * 1024,
            mem_available: 6 * 1024 * 1024 * 1024,
        })
        .unwrap();
        for field in ["cpuCount", "memTotal", "memUsed", "memAvailable"] {
            assert!(
                payload.get(field).is_some(),
                "载荷缺少 {field}（前端按 camelCase 读取）: {payload}"
            );
        }
        assert_eq!(payload["cpuCount"], 8);
    }

    /// `file_list` 只回 name/kind(dir/file)/size 的短形态曾由前端 file_info 回填补全；
    /// 现在 Rust 直接给出 FileSystem 契约的完整字段（绝对 path、三值 kind、mtimeMs），
    /// 且符号链接不跟随 —— 回填桥删除后这条契约只能在这里钉住。
    #[test]
    fn file_list_returns_full_file_info_without_following_symlinks() {
        let root = std::env::temp_dir().join(format!(
            "deskpet-file-list-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("subdir")).unwrap();
        std::fs::write(root.join("file.txt"), b"hello").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("file.txt"), root.join("link.txt")).unwrap();
            // 悬空链接同样按链接自身报告，不因目标缺失而消失。
            std::os::unix::fs::symlink(root.join("missing-target"), root.join("dangling.txt"))
                .unwrap();
        }

        let entries = read_file_entries(&root).unwrap().entries;
        let by_name = |name: &str| {
            entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("缺少条目 {name}"))
        };

        let dir = by_name("subdir");
        assert_eq!(dir.kind, "directory");
        assert_eq!(dir.path, root.join("subdir").to_string_lossy().to_string());
        assert!(Path::new(&dir.path).is_absolute(), "path 必须是绝对路径");

        let file = by_name("file.txt");
        assert_eq!(file.kind, "file");
        assert_eq!(file.size, 5);
        assert!(file.mtime_ms > 0, "文件应有 mtime");

        #[cfg(unix)]
        {
            assert_eq!(
                by_name("link.txt").kind,
                "symlink",
                "符号链接必须报 symlink"
            );
            assert_eq!(
                by_name("dangling.txt").kind,
                "symlink",
                "悬空链接同样按 symlink 报告"
            );
        }

        // kind 有序：directory < file < symlink
        let kinds: Vec<&str> = entries.iter().map(|entry| entry.kind.as_str()).collect();
        let mut sorted = kinds.clone();
        sorted.sort();
        assert_eq!(kinds, sorted, "kind 应有序（directory < file < symlink）");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 无界 I/O 的源头消除（TOOL-06a / FIX-60）──
    //
    // 许可额度没有 TTL（tool_permit.rs 明确不加：超时释放会放开在飞的独占效果），
    // 所以「handler 永不结算」= 额度永久泄漏。能让 handler 卡住不结算的入口，是让文件命令
    // 去打开一个不是常规文件的文件系统对象：FIFO 的 open 会一直等到对端，设备/套接字同理。
    // 这组用例钉两件事：拒绝（`AppError::Tool`）与**不阻塞**（耗时上界）——
    // 少了时长断言，「无界 I/O 已消除」这个安全修复不可证。

    // 本模块用例的临时目录统一走下面的 `probe_dir`（跨平台）；FIFO 相关的**用例**才按
    // unix 收窄（`make_fifo` 与各 `#[cfg(unix)]` 测试），临时目录本身不是平台专有物。

    /// 建一个 FIFO。`mkfifo(1)` 不可用时返回 false 由调用方跳过，与 `paths.rs` 里
    /// `symlink_file` 的跳过分支同构：环境缺能力时跳过，而不是把跳过当失败。
    #[cfg(unix)]
    fn make_fifo(path: &Path) -> bool {
        matches!(
            Command::new("mkfifo")
                .arg(path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
            Ok(status) if status.success()
        )
    }

    #[cfg(unix)]
    #[test]
    fn file_read_rejects_fifo_without_blocking() {
        let dir = probe_dir("read");
        let fifo = dir.join("probe.fifo");
        if !make_fifo(&fifo) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let started = Instant::now();
        let result = file_read(fifo.to_string_lossy().to_string(), None);
        let elapsed = started.elapsed();

        assert!(
            matches!(result, Err(AppError::Tool(_))),
            "读 FIFO 必须被拒：放行等于让 read_to_string 一直等对端，额度永不结算"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "拒绝 FIFO 不能阻塞：耗时 {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn file_read_binary_rejects_fifo() {
        let dir = probe_dir("read-binary");
        let fifo = dir.join("probe.fifo");
        if !make_fifo(&fifo) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let started = Instant::now();
        let result = file_read_binary(fifo.to_string_lossy().to_string(), None);
        let elapsed = started.elapsed();

        assert!(
            matches!(result, Err(AppError::Tool(_))),
            "二进制读同样必须拒绝 FIFO"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "拒绝 FIFO 不能阻塞：耗时 {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn file_write_rejects_existing_fifo() {
        let dir = probe_dir("write");
        let fifo = dir.join("probe.fifo");
        if !make_fifo(&fifo) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let started = Instant::now();
        let result = file_write(fifo.to_string_lossy().to_string(), "x".to_string(), None);
        let elapsed = started.elapsed();

        // 放行的话 `fs::write` 会一直等有读者打开这个 FIFO，测试套件就此挂住。
        assert!(
            matches!(result, Err(AppError::Tool(_))),
            "写已存在的 FIFO 必须被拒"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "拒绝 FIFO 不能阻塞：耗时 {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 原子替换写入：覆盖已有正文，且不留临时文件。
    #[test]
    fn file_write_atomic_replaces_content_without_leftovers() {
        let dir = probe_dir("atomic");
        let target = dir.join("probe.txt");
        std::fs::write(&target, "旧正文").unwrap();

        let result = file_write_atomic(
            target.to_string_lossy().to_string(),
            "新正文".to_string(),
            None,
        );

        assert!(result.is_ok(), "原子写入应当成功");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "新正文");
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "原子写入不得留下临时文件: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 上限校验与 `file_write` 同口径：超限拒绝且不动目标。
    #[test]
    fn file_write_atomic_enforces_max_bytes() {
        let dir = probe_dir("atomic-limit");
        let target = dir.join("probe.txt");
        std::fs::write(&target, "旧正文").unwrap();

        let result = file_write_atomic(
            target.to_string_lossy().to_string(),
            "0123456789".to_string(),
            Some(4),
        );

        assert!(result.is_err(), "超过 max_bytes 必须被拒");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "旧正文");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn file_write_atomic_rejects_existing_fifo() {
        let dir = probe_dir("atomic-fifo");
        let fifo = dir.join("probe.fifo");
        if !make_fifo(&fifo) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let started = Instant::now();
        let result = file_write_atomic(fifo.to_string_lossy().to_string(), "x".to_string(), None);
        let elapsed = started.elapsed();

        // 放行的话 `fs::write`（写临时文件前的目标类型判定缺失）会一直等读者打开这个 FIFO。
        assert!(
            matches!(result, Err(AppError::Tool(_))),
            "写已存在的 FIFO 必须被拒"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "拒绝 FIFO 不能阻塞：耗时 {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn file_append_rejects_existing_fifo() {
        let dir = probe_dir("append");
        let fifo = dir.join("probe.fifo");
        if !make_fifo(&fifo) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let started = Instant::now();
        let result = file_append(fifo.to_string_lossy().to_string(), "x".to_string(), 1024);
        let elapsed = started.elapsed();

        assert!(
            matches!(result, Err(AppError::Tool(_))),
            "追加到已存在的 FIFO 必须被拒"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "拒绝 FIFO 不能阻塞：耗时 {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 二进制输出不该让整段结果退化成空串。
    #[test]
    fn invalid_utf8_degrades_to_lossy_not_empty() {
        let raw = b"prefix\xFF\xFEtail\n";
        let stats = stats_of(raw);
        let text = String::from_utf8_lossy(raw).into_owned();
        let actual = truncate_output(&text, &stats, true, false, 1024, 2000);
        assert!(!actual.output.is_empty());
        assert!(actual.output.contains("tail"));
    }

    // ── bash 取消与 spawn 的竞态（TOOL-07）──
    //
    // 覆盖边界：`run_bash` 的每一条提前返回都必须把池条目交回守卫，漏一条就是残条 ——
    // 后续同 id 的 `bash_exec` 会读到 `child: None` 的旧槽，被误判成「已取消」。
    //
    // 唯一无法在单测里确定性构造的提前返回是 `spawn` 失败（`/bin/sh` 与 `cmd` 恒存在，
    // 要造失败得先破坏 PATH 或句柄表，代价与收益不成比例）：它与其它提前返回走的是
    // 同一个 `_guard`，由 `bash_invalid_cwd_leaves_no_pool_entry` 等价覆盖。

    /// 本模块用例的临时目录（跨平台）：同一条用例的文件都落在这里，结束时整体删除。
    /// 放在系统 temp 下：它本就在允许根（home/temp）内，用例才有机会走到类型判定，
    /// 而不是被 `PATH_ESCAPE` 提前拦下。FIFO 用例同样用它 —— 平台专有的是 FIFO 本身，
    /// 不是临时目录。
    fn probe_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "deskpet-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 池条目的直接视图。锁中毒也恢复出来：断言不该因为别的用例 panic 而误报。
    fn slots(pool: &BashPool) -> std::sync::MutexGuard<'_, HashMap<String, BashSlot>> {
        pool.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 「先等一段时间、再留下探针文件」的命令：给「spawn 后立即终止」留出可判定的窗口。
    ///
    /// 直接用 `touch` 会与 kill 抢时序 —— 子进程完全可能在 kill 生效前就写完文件，
    /// 断言变成抛硬币。把副作用推到延迟之后，结论只剩两种：子进程活着 → 文件出现；
    /// 子进程被终止 → 文件永远不出现。Windows 没有 `sleep`/`touch`，用 `ping`/`type` 同义形态。
    ///
    /// 探针用**裸文件名**、靠 `run_bash` 的 `cwd` 落在用例目录里：`cmd /C` 不认 Rust 为参数
    /// 做的 `\"` 转义（cmd 只认 `""`/`^"`），命令里带引号的绝对路径会被拆坏 —— 重定向目标
    /// 变成 `\C:\…` 这种不存在的路径，探针根本写不出来（CI windows-latest 实测）。
    /// 零引号的命令同时躲开「用户名带空格」的机器。
    fn delayed_probe(seconds: u32, file: &str) -> String {
        if cfg!(windows) {
            format!(
                "ping -n {} 127.0.0.1 > nul && type nul > {file}",
                seconds + 1
            )
        } else {
            format!("sleep {seconds}; touch {file}")
        }
    }

    /// TOOL-07 的核心用例：取消在登记之后、spawn 之前到达（槽已立案、句柄尚未回填）。
    #[test]
    fn bash_cancel_lands_before_spawn() {
        let dir = probe_dir("cancel-before-spawn");
        let pool = BashPool::default();

        // 正对照：同一条命令不加取消时必须跑完并留下探针。缺了它，下面的「文件不存在」
        // 可能只是因为命令或路径根本走不通，而不是因为取消生效。
        let control = dir.join("control.sentinel");
        let control_result = run_bash(
            pool.clone(),
            delayed_probe(0, "control.sentinel"),
            Some(dir.to_string_lossy().to_string()),
            Some("control-probe".into()),
            None,
            None,
            None,
            None,
        );
        assert!(control_result.is_ok(), "正对照命令没有跑通");
        assert!(
            control.exists(),
            "正对照没有留下探针，后续断言会退化成空断言"
        );
        assert!(slots(&pool).is_empty(), "正常返回后池里不该有条目");

        let sentinel = dir.join("sentinel");
        let id = "cancel-before-spawn".to_string();
        slots(&pool).insert(
            id.clone(),
            BashSlot {
                child: None,
                cancel_requested: true,
            },
        );

        let result = run_bash(
            pool.clone(),
            delayed_probe(1, "sentinel"),
            Some(dir.to_string_lossy().to_string()),
            Some(id),
            None,
            None,
            None,
            None,
        );
        match result {
            Err(AppError::Cancelled) => {}
            Err(other) => panic!("取消立案后应返回 Cancelled，实际 {other:?}"),
            Ok(_) => panic!("取消立案后不该正常返回"),
        }
        assert!(slots(&pool).is_empty(), "提前返回在池里留下了残条");
        // 宽限窗口：探针推到 1s 之后。子进程真被终止则文件永不出现；
        // 若 kill 只是「返回了」而没生效，这里就会看到文件。
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!sentinel.exists(), "取消后子进程仍在运行：探针文件出现了");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 策略拒绝发生在登记之前：这条路径不该在池里留下任何东西。
    #[test]
    fn bash_policy_reject_leaves_no_pool_entry() {
        let pool = BashPool::default();
        let result = run_bash(
            pool.clone(),
            "rm -rf /".into(),
            None,
            Some("policy-reject".into()),
            None,
            None,
            None,
            None,
        );
        match result {
            Err(AppError::Tool(message)) => assert!(!message.is_empty(), "策略拒绝应带原因"),
            Err(other) => panic!("策略拒绝应是 Tool 错误，实际 {other:?}"),
            Ok(_) => panic!("硬禁止命令不该被执行"),
        }
        assert!(slots(&pool).is_empty(), "策略拒绝在池里留下了残条");
    }

    /// cwd 校验在登记之后、spawn 之前 —— 这条 `?` 路径必须由守卫收尾。
    #[test]
    fn bash_invalid_cwd_leaves_no_pool_entry() {
        let dir = probe_dir("invalid-cwd");
        let plain = dir.join("plain.txt");
        std::fs::write(&plain, b"not a directory").unwrap();

        let pool = BashPool::default();
        let result = run_bash(
            pool.clone(),
            "echo probe".into(),
            Some(plain.to_string_lossy().into_owned()),
            Some("invalid-cwd".into()),
            None,
            None,
            None,
            None,
        );
        match result {
            Err(AppError::Other(message)) => {
                assert!(message.contains("目录"), "cwd 拒绝文案不符: {message}")
            }
            Err(other) => panic!("cwd 不是目录应是 Other 错误，实际 {other:?}"),
            Ok(_) => panic!("cwd 不是目录时不该执行命令"),
        }
        assert!(slots(&pool).is_empty(), "cwd 校验失败在池里留下了残条");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 未命中的取消要有明确结论：`Ok(false)`（外加一条 debug 日志），不是静默成功。
    #[test]
    fn bash_cancel_unknown_id_returns_false() {
        let pool = BashPool::default();
        assert!(
            !cancel_in_pool(&pool, "not-registered").unwrap(),
            "未命中的取消应返回 false"
        );
        assert!(slots(&pool).is_empty(), "未命中不该顺手创建条目");
    }

    /// 空槽（已登记、尚未 spawn）上的取消必须立案 —— 这是 spawn 后立即终止的唯一依据。
    #[test]
    fn bash_cancel_latches_slot_without_child() {
        let pool = BashPool::default();
        let id = "pending-spawn".to_string();
        slots(&pool).insert(
            id.clone(),
            BashSlot {
                child: None,
                cancel_requested: false,
            },
        );

        assert!(
            cancel_in_pool(&pool, &id).unwrap(),
            "命中空槽的取消应返回 true"
        );
        assert!(
            slots(&pool)
                .get(&id)
                .is_some_and(|slot| slot.cancel_requested && slot.child.is_none()),
            "取消没有在空槽上立案"
        );
    }

    // ── bash 进程组回收 / stdin 关死 / 超时档位对齐（2026-10-06 批次）──
    //
    // 三处回收路径（超时 / 取消 / 宿主退出）共用 `kill_process_group`，各自被下面一条用例
    // 直接驱动；探针形态统一为「后台子壳延迟 touch 文件」：命令活着 → 文件出现，
    // 组回收生效 → 文件永不出现（只杀直接子进程的旧实现会留下这个孙进程，用例即红）。

    /// 后台子壳延迟写探针 + 前台长睡：杀直接子进程会留下写探针的孙进程。
    ///
    /// 与 `delayed_probe` 同款跨平台收窄：Windows 无 `sleep`/`touch`，用 `ping`/`type` 同义形态。
    fn descendant_probe(seconds: u32, file: &str) -> String {
        if cfg!(windows) {
            format!(
                "start /b cmd /C \"ping -n {} 127.0.0.1 > nul & type nul > {file}\" & ping -n 31 127.0.0.1 > nul",
                seconds + 1
            )
        } else {
            format!("(sleep {seconds}; touch {file}) & sleep 30")
        }
    }

    /// 探针形态的正对照：同一条命令不加任何终止时必须跑完并留下探针。
    /// 缺了它，「文件不存在」可能只是因为命令/路径根本走不通，而不是因为回收生效。
    #[test]
    fn bash_descendant_probe_control_writes_sentinel() {
        let dir = probe_dir("descendant-control");
        let pool = BashPool::default();
        let control = if cfg!(windows) {
            "start /b cmd /C \"ping -n 2 127.0.0.1 > nul & type nul > control.sentinel\" & ping -n 3 127.0.0.1 > nul"
        } else {
            "(sleep 1; touch control.sentinel) & sleep 2"
        };
        let result = run_bash(
            pool.clone(),
            control.into(),
            Some(dir.to_string_lossy().to_string()),
            Some("descendant-control".into()),
            None,
            None,
            None,
            None,
        );
        assert!(
            result.is_ok(),
            "正对照命令没有跑通: {:?}",
            result.as_ref().err()
        );
        assert!(
            dir.join("control.sentinel").exists(),
            "正对照没有留下探针，后续「探针不存在」的断言会退化成空断言"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 超时回收必须杀整组：直接子进程（sh）与后台孙进程一起结束。
    /// 只 `Child::kill` 主进程的旧实现会留下孙进程 —— 它对应用户实测的孤儿 osascript 弹窗。
    #[test]
    fn bash_timeout_kills_descendants() {
        let dir = probe_dir("timeout-descendants");
        let pool = BashPool::default();
        let result = run_bash(
            pool.clone(),
            descendant_probe(1, "sentinel"),
            Some(dir.to_string_lossy().to_string()),
            Some("timeout-descendants".into()),
            Some(300),
            None,
            None,
            None,
        );
        match result {
            Err(AppError::Timeout) => {}
            Err(other) => panic!("超时应返回 Timeout，实际 {other:?}"),
            Ok(_) => panic!("超时不应正常返回"),
        }
        assert!(slots(&pool).is_empty(), "超时返回在池里留下了残条");
        // 宽限窗口：探针排在 1s 之后。孙进程真被回收则文件永不出现；
        // 只杀了直接子进程的话，这里就会看到它。
        std::thread::sleep(Duration::from_millis(1500));
        assert!(
            !dir.join("sentinel").exists(),
            "超时后孙进程仍在运行：探针文件出现了（进程组回收未生效）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 取消在跑的命令同样按组回收（与超时共用 kill_process_group，但触发路径独立）。
    #[test]
    fn bash_cancel_kills_descendants() {
        let dir = probe_dir("cancel-descendants");
        let pool = BashPool::default();
        let id = "cancel-descendants";
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = {
            let pool = pool.clone();
            let dir_string = dir.to_string_lossy().to_string();
            let id_string = id.to_string();
            std::thread::spawn(move || {
                let result = run_bash(
                    pool,
                    descendant_probe(1, "sentinel"),
                    Some(dir_string),
                    Some(id_string),
                    Some(600_000),
                    None,
                    None,
                    None,
                );
                let _ = tx.send(());
                result
            })
        };

        // 等子进程真的 spawn（槽位拿到句柄）再取消 —— 与 spawn 前立案那条用例互补。
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if slots(&pool).get(id).is_some_and(|slot| slot.child.is_some()) {
                break;
            }
            assert!(Instant::now() < deadline, "等待 bash 子进程 spawn 超时");
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(cancel_in_pool(&pool, id).unwrap(), "取消应命中在跑的槽位");
        // 取消没生效的话命令会跑满 10 分钟自然时长；用窗口把失败拦成「红」而不是挂死。
        rx.recv_timeout(Duration::from_secs(10))
            .expect("取消未生效：命令没有在 10s 窗口内结束");
        let result = handle.join().expect("run_bash 线程不应 panic");
        // 被组杀的命令以信号收场（`status.code()` 为 None → -1），正常结算而非 panic。
        assert!(
            result.is_ok(),
            "取消后 run_bash 应正常结算: {:?}",
            result.as_ref().err()
        );
        std::thread::sleep(Duration::from_millis(1500));
        assert!(
            !dir.join("sentinel").exists(),
            "取消后孙进程仍在运行：探针文件出现了（进程组回收未生效）"
        );
        assert!(slots(&pool).is_empty(), "取消收尾后池里不该有条目");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 宿主退出回收（`kill_all` → `kill_slot_child`）同样按组回收。
    #[test]
    fn bash_kill_all_kills_descendants() {
        let dir = probe_dir("kill-all-descendants");
        let pool = BashPool::default();
        let id = "kill-all-descendants";
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = {
            let pool = pool.clone();
            let dir_string = dir.to_string_lossy().to_string();
            let id_string = id.to_string();
            std::thread::spawn(move || {
                let result = run_bash(
                    pool,
                    descendant_probe(1, "sentinel"),
                    Some(dir_string),
                    Some(id_string),
                    Some(600_000),
                    None,
                    None,
                    None,
                );
                let _ = tx.send(());
                result
            })
        };

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if slots(&pool).get(id).is_some_and(|slot| slot.child.is_some()) {
                break;
            }
            assert!(Instant::now() < deadline, "等待 bash 子进程 spawn 超时");
            std::thread::sleep(Duration::from_millis(25));
        }
        pool.kill_all();
        rx.recv_timeout(Duration::from_secs(10))
            .expect("kill_all 未生效：命令没有在 10s 窗口内结束");
        let result = handle.join().expect("run_bash 线程不应 panic");
        assert!(
            result.is_ok(),
            "回收后 run_bash 应正常结算: {:?}",
            result.as_ref().err()
        );
        std::thread::sleep(Duration::from_millis(1500));
        assert!(
            !dir.join("sentinel").exists(),
            "宿主退出回收后孙进程仍在运行：探针文件出现了（进程组回收未生效）"
        );
        assert!(slots(&pool).is_empty(), "回收后池里不该有条目");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 命令自成进程组（组长 = 自身 pid）：这是 killpg 的前提，也保证组杀**不会打到宿主/测试
    /// 进程自己所在的组**（进程组不对，killpg 就是自杀）。`process_group(0)` 被删即红。
    #[cfg(unix)]
    #[test]
    fn bash_spawn_creates_own_process_group() {
        let dir = probe_dir("process-group");
        let pool = BashPool::default();
        let result = run_bash(
            pool.clone(),
            "ps -o pgid= -p $$".into(),
            Some(dir.to_string_lossy().to_string()),
            Some("pgid-probe".into()),
            None,
            None,
            None,
            None,
        )
        .expect("pgid 探针应正常结束");
        let child_pgid: i64 = result
            .output
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("ps 输出应为进程组号: {:?}", result.output));
        // SAFETY: getpgid 只传本进程 pid 与常量，不涉及内存访问。
        let own_pgid = unsafe { libc::getpgid(0) } as i64;
        assert!(child_pgid > 0, "子进程组号必须为正: {child_pgid}");
        assert_ne!(
            child_pgid, own_pgid,
            "命令没有自成进程组：killpg 会打到宿主/测试进程所在的组"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// stdin 关死（`Stdio::null()`）：读 stdin 的命令立即 EOF 失败而不是挂住。
    /// 回归形态（不关死）：dev 模式继承宿主 stdin，本机跑测试时命令会阻塞到超时。
    #[test]
    fn bash_command_stdin_is_closed() {
        let dir = probe_dir("stdin-null");
        let pool = BashPool::default();
        let command = if cfg!(windows) {
            "findstr . & echo stdin-probe-done"
        } else {
            // read 在 EOF 上返回 1；-t 0 为假（不是 tty）。两个标记都要求 stdin 被关死。
            "read line; echo read_exit=$?; test -t 0; echo tty=$?"
        };
        let result = run_bash(
            pool.clone(),
            command.into(),
            Some(dir.to_string_lossy().to_string()),
            Some("stdin-probe".into()),
            // 熔断：若 stdin 未关死且继承了交互终端，命令会挂住，用 5s 把它变成可判定的失败。
            Some(5_000),
            None,
            None,
            None,
        );
        match result {
            Ok(result) => {
                if cfg!(windows) {
                    assert!(
                        result.output.contains("stdin-probe-done"),
                        "stdin 探针没有走完（可能挂在读 stdin 上）: {}",
                        result.output
                    );
                } else {
                    assert!(
                        result.output.contains("read_exit=1"),
                        "read 没有在 stdin 上立即读到 EOF（stdin 未关死）: {}",
                        result.output
                    );
                    assert!(
                        result.output.contains("tty=1"),
                        "stdin 仍是交互终端（stdin 未关死）: {}",
                        result.output
                    );
                }
            }
            Err(other) => panic!("读 stdin 的命令应被 EOF 结束，实际 {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rust 兜底与 TS 侧 bash 档位（tool/local/bash-timeout.ts 的 BASH_TOOL_TIMEOUT_MS）
    /// **必须同值**：两侧一旦不同，就复现「策略 5 分钟被 Rust 隐藏天花板掐死」的旧故障。
    /// 跨语言无法在测试里直接比对，钉住本侧字面值供对账（TS 侧由 L2/L3 用例钉）。
    #[test]
    fn default_bash_timeout_matches_tool_band() {
        assert_eq!(
            DEFAULT_BASH_TIMEOUT_MS, 300_000,
            "Rust 兜底与 TS 的 bash 档位不同值（TS 侧见 src/services/tool/local/bash-timeout.ts）"
        );
    }
}
