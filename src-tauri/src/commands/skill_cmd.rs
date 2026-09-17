// ==========================================
// Skill 目录元数据索引
//
// 只读取受上限约束的 YAML frontmatter，不能把 SKILL.md 正文带入启动缓存。
// 正文仍由模型经 read 工具在需要时读取。
// ==========================================

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;

const SKILL_FILE: &str = "SKILL.md";
const MAX_CATALOG_ENTRIES: usize = 128;
const MAX_SCAN_ENTRIES: usize = 4096;
const MAX_FRONTMATTER_BYTES: usize = 16 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogEntry {
    directory_name: String,
    file_path: String,
    frontmatter: String,
    mtime_ms: u64,
    size: u64,
    fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogResult {
    entries: Vec<SkillCatalogEntry>,
    fingerprint: String,
    truncated: bool,
}

/// 列举运行时 Skill 的第一层索引。
///
/// 每个文件只解析有界 frontmatter，不扫描或缓存正文（允许小型 I/O 缓冲预读）；目录个数也受限，
/// 防止用户目录异常膨胀为启动或首回合的无界 I/O。
#[tauri::command]
pub fn skill_list_metadata(paths: State<AppPaths>) -> AppResult<SkillCatalogResult> {
    if !paths.skills.exists() {
        return Ok(SkillCatalogResult {
            entries: Vec::new(),
            fingerprint: "0".to_string(),
            truncated: false,
        });
    }
    AppPaths::validate_path(&paths.skills, &paths.data_root)?;

    // 目录迭代顺序在 Windows/macOS 上都不保证；始终保留字典序最小的 N 个，
    // 同时限制总扫描量，避免恶意目录让索引启动耗时或内存无界增长。
    let mut directories = Vec::with_capacity(MAX_CATALOG_ENTRIES);
    let mut scanned_entries = 0_usize;
    let mut truncated = false;
    let read_dir = fs::read_dir(&paths.skills)
        .map_err(|e| AppError::Io(format!("读取 Skill 目录失败: {e}")))?;
    for entry in read_dir {
        scanned_entries += 1;
        if scanned_entries > MAX_SCAN_ENTRIES {
            truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        directories.push(entry);
        directories.sort_by_key(|candidate| candidate.file_name().to_string_lossy().to_lowercase());
        if directories.len() > MAX_CATALOG_ENTRIES {
            directories.pop();
            truncated = true;
        }
    }
    // `scanned_entries` is capped at MAX_SCAN_ENTRIES + 1; the sentinel keeps
    // cache fingerprints stable without retaining the full directory listing.
    let directory_count = scanned_entries;
    directories.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    let mut entries = Vec::with_capacity(MAX_CATALOG_ENTRIES.min(directories.len()));
    for directory in directories.into_iter().take(MAX_CATALOG_ENTRIES) {
        let directory_name = directory.file_name().to_string_lossy().to_string();
        let file_path = directory.path().join(SKILL_FILE);
        if !file_path.is_file() {
            continue;
        }
        // 单个坏链接/越界文件不能让整个 metadata catalog 失效；隔离该条目并继续扫描。
        if AppPaths::validate_path(&file_path, &paths.skills).is_err() {
            continue;
        }

        let metadata = match fs::metadata(&file_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let frontmatter = match read_frontmatter(&file_path) {
            Ok(Some(frontmatter)) => frontmatter,
            Ok(None) | Err(_) => continue,
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0);
        let fingerprint = hash_hex(&[
            directory_name.as_bytes(),
            &mtime_ms.to_le_bytes(),
            &metadata.len().to_le_bytes(),
            frontmatter.as_bytes(),
        ]);
        entries.push(SkillCatalogEntry {
            directory_name,
            file_path: file_path.to_string_lossy().to_string(),
            frontmatter,
            mtime_ms,
            size: metadata.len(),
            fingerprint,
        });
    }

    let catalog_parts = entries
        .iter()
        .flat_map(|entry| {
            [
                entry.directory_name.as_bytes(),
                entry.fingerprint.as_bytes(),
            ]
        })
        .collect::<Vec<_>>();
    let directory_count_bytes = directory_count.to_le_bytes();
    let truncated_bytes = [u8::from(truncated)];
    let mut fingerprint_parts = Vec::with_capacity(catalog_parts.len() + 2);
    fingerprint_parts.push(directory_count_bytes.as_slice());
    fingerprint_parts.push(truncated_bytes.as_slice());
    fingerprint_parts.extend(catalog_parts);
    let catalog_fingerprint = hash_hex(&fingerprint_parts);
    Ok(SkillCatalogResult {
        entries,
        fingerprint: catalog_fingerprint,
        truncated,
    })
}

fn read_frontmatter(path: &std::path::Path) -> AppResult<Option<String>> {
    let file = fs::File::open(path).map_err(|e| AppError::Io(format!("读取 Skill 失败: {e}")))?;
    let mut reader = BufReader::with_capacity(256, file.take((MAX_FRONTMATTER_BYTES + 1) as u64));
    let mut total = 0_usize;
    let mut line = Vec::with_capacity(256);
    let mut frontmatter = Vec::new();
    let mut started = false;

    // 允许小缓冲预读，但只按行读取 frontmatter；遇到结束分隔线立即停止，正文不会读入缓存。
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| AppError::Io(format!("读取 Skill frontmatter 失败: {e}")))?;
        if read == 0 {
            return Ok(None);
        }
        total = total.saturating_add(read);
        if total > MAX_FRONTMATTER_BYTES {
            return Ok(None);
        }
        let content = if line.ends_with(b"\r\n") {
            &line[..line.len() - 2]
        } else if line.ends_with(b"\n") {
            &line[..line.len() - 1]
        } else {
            line.as_slice()
        };
        if !started {
            if content != b"---" {
                return Ok(None);
            }
            started = true;
        } else if content == b"---" {
            return Ok(Some(String::from_utf8_lossy(&frontmatter).into_owned()));
        } else {
            frontmatter.extend_from_slice(content);
            frontmatter.push(b'\n');
        }
    }
}

/// 稳定的轻量 fingerprint；用于缓存失效，不作安全散列用途。
fn hash_hex(parts: &[&[u8]]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in *part {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
