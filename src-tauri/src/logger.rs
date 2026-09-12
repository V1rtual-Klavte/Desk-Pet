// src-tauri/src/logger.rs
// ==========================================
// Rust 日志内核 —— 级别过滤 + 本地时间戳 + 终端/文件双输出
// 宏定义在 macros/mod.rs，本模块只负责机制，不做语法糖。
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

/// 前端转发日志：保留前端已排好的整行（自带时间戳/级别/前缀），只做级别过滤后落盘
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
    let path = dir.join("deskpet.log");
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
