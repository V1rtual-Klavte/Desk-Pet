use tauri::command;

#[command]
pub fn system_info() -> SystemInfoResult {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let cpu_count = num_cpus::get() as u32;

    // 内存信息（跨平台）
    let (mem_total, mem_used, mem_available) = get_memory_info();

    SystemInfoResult {
        os,
        arch,
        cpu_count,
        mem_total,
        mem_used,
        mem_available,
    }
}

// 前端按 camelCase 读取（cpuCount / memTotal / memUsed / memAvailable）。
// 漏掉这行属性不会报错，只会让数值字段在 TS 侧全是 undefined —— 显示成 NaNGB。
//
// `mem_available` 是「不用换页就能分配出去的量」，与 `mem_used` 不是互补关系：
// 两个口径来自各平台不同的计数（见 get_memory_info），前端不要把 used + available 当成总量。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfoResult {
    pub(crate) os: String,
    pub(crate) arch: String,
    pub(crate) cpu_count: u32,
    pub(crate) mem_total: u64,
    pub(crate) mem_used: u64,
    pub(crate) mem_available: u64,
}

/// 返回 `(总内存, 已用内存, 可用内存)`，单位字节；取不到时该位为 0。
fn get_memory_info() -> (u64, u64, u64) {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        // 总内存: sysctl hw.memsize
        let total = Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);

        // 已用与可用都从同一次 vm_stat 读数里算（页大小经 hw.pagesize 取得）
        let page_size = Command::new("sysctl")
            .args(["-n", "hw.pagesize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(16384);

        let vm_stat = Command::new("vm_stat")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();

        let mut active = 0u64;
        let mut wired = 0u64;
        let mut compressed = 0u64;
        let mut free = 0u64;
        let mut inactive = 0u64;
        let mut speculative = 0u64;
        for line in vm_stat.lines() {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() < 2 {
                continue;
            }
            let key = parts[0].trim().trim_matches('"');
            let val = parts[1].trim().trim_end_matches('.');
            match key {
                "Pages active" => active = val.parse().unwrap_or(0),
                "Pages wired down" => wired = val.parse().unwrap_or(0),
                "Pages occupied by compressor" => compressed = val.parse().unwrap_or(0),
                "Pages free" => free = val.parse().unwrap_or(0),
                "Pages inactive" => inactive = val.parse().unwrap_or(0),
                "Pages speculative" => speculative = val.parse().unwrap_or(0),
                _ => {}
            }
        }

        // 已用内存: page size * (active + wired + compressed)，沿用原有口径
        let used = (active + wired + compressed) * page_size;

        // 可用内存: macOS 没有 Linux 的 MemAvailable；用「空闲 + 非活跃 + speculative(可回收)」
        // 页近似「不用换页即可分配」的页集（reclaimed-without-paging）。
        // 刻意不按 Activity Monitor 的 Cached Files 口径：它还含 `Pages purgeable`，而 purgeable
        // 是 active/inactive 的子集，再加一遍会重复计。
        // 这三类与 used 的三类在 vm_stat 里互斥，所以它是独立口径而不是 total - used。
        let available = (free + inactive + speculative) * page_size;

        (total, used, available)
    }

    #[cfg(target_os = "windows")]
    {
        // SAFETY: GlobalMemoryStatusEx reads a caller-allocated MEMORYSTATUSEX struct.
        // The struct is stack-allocated with correct dwLength. No pointer aliasing or concurrent writes.
        unsafe {
            use windows_sys::Win32::System::SystemInformation::{
                GlobalMemoryStatusEx, MEMORYSTATUSEX,
            };
            let mut mem = MEMORYSTATUSEX {
                dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
                dwMemoryLoad: 0,
                ullTotalPhys: 0,
                ullAvailPhys: 0,
                ullTotalPageFile: 0,
                ullAvailPageFile: 0,
                ullTotalVirtual: 0,
                ullAvailVirtual: 0,
                ullAvailExtendedVirtual: 0,
            };
            if GlobalMemoryStatusEx(&mut mem) != 0 {
                // ullAvailPhys 直接就是「可用」；已用由总量减可用推得（同一次读数，不再调 API）
                (mem.ullTotalPhys, mem.ullTotalPhys - mem.ullAvailPhys, mem.ullAvailPhys)
            } else {
                (0, 0, 0)
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: /proc/meminfo
        let read_mem = |key: &str| -> Option<u64> {
            std::fs::read_to_string("/proc/meminfo")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|l| l.starts_with(key))
                        .and_then(|l| l.split_whitespace().nth(1))
                        .and_then(|v| v.parse::<u64>().ok())
                })
                .map(|kb| kb * 1024)
        };
        let total = read_mem("MemTotal:").unwrap_or(0);
        let available = read_mem("MemAvailable:").unwrap_or(0);
        (total, total.saturating_sub(available), available)
    }
}

// ── 打开应用 ──

/// `ShellExecuteW` 需要的 NUL 结尾宽字符串。
#[cfg(target_os = "windows")]
fn to_wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
