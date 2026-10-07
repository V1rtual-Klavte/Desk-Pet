// crates/native-host/src/logger.rs
// ==========================================
// Rust 日志内核 —— 级别过滤 + 本地时间戳 + 终端/文件双输出
// 宏定义在 macros.rs，本模块只负责机制，不做语法糖。
// ==========================================

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

pub const LEVEL_DEBUG: u8 = 0;
pub const LEVEL_INFO: u8 = 1;
pub const LEVEL_WARN: u8 = 2;
pub const LEVEL_ERROR: u8 = 3;

const LEVEL_TAG: [&str; 4] = ["DEBUG", "INFO ", "WARN ", "ERROR"];

/// 默认级别：debug 构建全量打印（对齐前端「dev 一律 debug」），release 只留 info 以上。
const DEFAULT_LEVEL: u8 = if cfg!(debug_assertions) {
    LEVEL_DEBUG
} else {
    LEVEL_INFO
};

/// 进程级日志级别。
///
/// 用 static 而非 `app.manage()`：日志宏会在拿不到 AppHandle 的位置展开
/// （monitor/capture.rs 的后台线程、monitor_ctl 里 spawn 的闭包等）。
/// 它只是一个标量开关，没有生命周期与并发语义，正是 atomic 的用途。
static LOG_LEVEL: AtomicU8 = AtomicU8::new(DEFAULT_LEVEL);

/// 日志文件 sink。None = 尚未初始化，此时只输出终端。
static SINK: Mutex<Option<FileSink>> = Mutex::new(None);

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_BACKUPS: u32 = 2;
/// 日志文件名；轮转备份是 `deskpet.log.1`、`deskpet.log.2`（见 `backup_path`）。
const LOG_FILE_NAME: &str = "deskpet.log";

// ── 级别 ──

#[inline]
pub fn set_level(level: u8) {
    LOG_LEVEL.store(level.min(LEVEL_ERROR), Ordering::Relaxed);
}

#[inline]
pub fn level() -> u8 {
    LOG_LEVEL.load(Ordering::Relaxed)
}

#[inline]
pub fn level_enabled(level: u8) -> bool {
    level >= LOG_LEVEL.load(Ordering::Relaxed)
}

pub fn level_name(level: u8) -> &'static str {
    LEVEL_TAG.get(level as usize).copied().unwrap_or("INFO ")
}

pub fn parse_level(text: &str) -> Option<u8> {
    match text.trim().to_ascii_lowercase().as_str() {
        "debug" => Some(LEVEL_DEBUG),
        "info" => Some(LEVEL_INFO),
        "warn" | "warning" => Some(LEVEL_WARN),
        "error" => Some(LEVEL_ERROR),
        _ => None,
    }
}

/// 启动时读 `DESKPET_LOG_LEVEL` 覆写默认级别。
/// debug 构建默认全量，没有这个环境变量就无法验证 release 的过滤行为。
pub fn init_from_env() {
    if let Ok(value) = std::env::var("DESKPET_LOG_LEVEL") {
        if let Some(parsed) = parse_level(&value) {
            set_level(parsed);
        }
    }
}

// ── 输出 ──

/// Rust 自身日志出口
pub fn emit(level: u8, args: std::fmt::Arguments) {
    write_line(&format!(
        "[{}] {} [Rust] {}",
        local_hms(),
        level_name(level),
        args
    ));
}

/// 前端转发日志：前端已在转发前完成级别过滤（services/logger/index.ts 的 enabled()），
/// 这里只落盘，不做二次判定 —— 整行自带时间戳/级别/前缀，原样保留
pub fn emit_frontend(msg: &str) {
    write_line(msg);
}

/// 本地时间 HH:MM:SS.mmm —— 与前端 `new Date()` 同源，保证两种日志可对时序
fn local_hms() -> String {
    chrono::Local::now().format("%H:%M:%S%.3f").to_string()
}

/// 唯一输出出口：终端 + 文件。Rust 日志与前端日志在此汇合成同一条时间线。
fn write_line(line: &str) {
    // 用 writeln! + let _ 而非 println!：Windows release（windows_subsystem="windows"）
    // 没有控制台，println! 写 stdout 失败会 panic。
    let _ = writeln!(std::io::stdout(), "{line}");
    write_file(line);
}

/// 崩溃兜底文件（落在系统临时目录，Windows 上即 `%TEMP%`）。
///
/// 刻意不走数据根：早期的失败（路径解析、种子）发生时数据根可能还没建、甚至建不起来，
/// 而那正是最需要留痕的时候。
const CRASH_FILE_NAME: &str = "v1rtual-desk-pet-crash.log";

/// 崩溃兜底文件的完整路径（给「去哪看」的提示与测试用）。
pub fn crash_log_path() -> PathBuf {
    std::env::temp_dir().join(CRASH_FILE_NAME)
}

/// 安装 panic 兜底出口。**最先调用**（早于任何可能 panic 的初始化）。
///
/// release 的 Windows 构建是窗口子系统、没有控制台，Rust 默认的 panic 输出（stderr）
/// **无声丢失**；而 panic 一旦发生在 `extern "system"` 回调（窗口过程）里就无法 unwind，
/// Rust 直接 `abort()` —— 进程静默消失，日志停在崩溃前的最后一行，用户端表现为
/// 「闪退且什么都没有」。2026-10-07 的 Windows 启动崩溃（窗口过程重入 `RefCell` →
/// panic → `abort` / `0xC0000409`）就是靠手工重定向 stderr 才查到，代价是一整轮排查。
///
/// 这里把 panic 同时写进固定位置的崩溃文件（不依赖任何初始化）与已挂上的日志 sink；
/// 默认 hook 照常执行，panic 语义（unwind / abort）不变。
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let text = format!("FATAL panic：{info}");
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(crash_log_path())
        {
            let _ = writeln!(file, "[{}] {text}", local_hms());
        }
        write_line(&text);
        previous(info);
    }));
}

// ── 文件 sink ──

struct FileSink {
    path: PathBuf,
    file: File,
    written: u64,
}

/// 初始化文件 sink 到 `{data_root}/logs/`。失败只降级为「不落盘」，不影响终端输出。
pub fn init_file_sink(dir: &Path) {
    if let Err(e) = fs::create_dir_all(dir) {
        warn_to_stderr(&format!("日志目录创建失败: {dir:?}: {e}"));
        return;
    }
    let path = dir.join(LOG_FILE_NAME);
    match open_sink(&path) {
        Ok(sink) => {
            if let Ok(mut guard) = SINK.lock() {
                *guard = Some(sink);
            }
        }
        Err(e) => warn_to_stderr(&format!("日志文件打开失败: {path:?}: {e}")),
    }
}

fn open_sink(path: &Path) -> std::io::Result<FileSink> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let written = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(FileSink {
        path: path.to_path_buf(),
        file,
        written,
    })
}

fn write_file(line: &str) {
    let Ok(mut guard) = SINK.lock() else { return };
    let Some(sink) = guard.as_mut() else { return };
    if sink.written > MAX_FILE_BYTES {
        sink.rotate();
    }
    // 不套 BufWriter：崩溃时日志不丢；最热的写者（光标线程，~60 行/秒）对 io 无压力
    // writeln! 返回 Result<()>，字节数自行按「正文 + 换行」计算
    if writeln!(sink.file, "{line}").is_ok() {
        sink.written += line.len() as u64 + 1;
    }
}

fn backup_path(base: &Path, index: u32) -> PathBuf {
    let mut name = base.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

/// `warn_to_stderr` 是给「日志系统自己出问题」用的，不能走日志系统，否则递归。
fn warn_to_stderr(message: &str) {
    let _ = writeln!(std::io::stderr(), "[Rust] WARN  {message}");
}

impl FileSink {
    /// 按大小轮转：`deskpet.log` → `.1` → `.2`，超出 `MAX_BACKUPS` 的丢弃
    fn rotate(&mut self) {
        let _ = self.file.flush();
        let base = self.path.clone();
        let _ = fs::remove_file(backup_path(&base, MAX_BACKUPS));
        for i in (1..MAX_BACKUPS).rev() {
            let _ = fs::rename(backup_path(&base, i), backup_path(&base, i + 1));
        }
        let _ = fs::rename(&base, backup_path(&base, 1));
        match open_sink(&base) {
            Ok(fresh) => *self = fresh,
            // 重开失败：置零避免每次写入都重试轮转，旧句柄继续写已改名的文件
            Err(_) => self.written = 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 崩溃兜底文件落在系统临时目录() {
        let path = crash_log_path();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(CRASH_FILE_NAME)
        );
        // 刻意不落数据根：早期失败时数据根可能还不存在（见 CRASH_FILE_NAME 注释）。
        assert!(path.starts_with(std::env::temp_dir()));
    }

    /// 装 hook 后 panic：崩溃文件必须留下带源码位置的消息，且 panic 照常向上传播。
    #[test]
    fn panic_兜底留痕可读且不吞掉panic() {
        install_panic_hook();
        let marker = format!("崩溃兜底自检 pid={}", std::process::id());
        let caught = std::panic::catch_unwind(|| panic!("{marker}"));
        assert!(caught.is_err(), "崩溃兜底不得吞掉 panic");
        let text = std::fs::read_to_string(crash_log_path()).unwrap_or_default();
        assert!(text.contains(&marker), "崩溃文件没有记录本次 panic：{text}");
        assert!(text.contains("logger.rs"), "崩溃文件应带源码位置：{text}");
    }
}
