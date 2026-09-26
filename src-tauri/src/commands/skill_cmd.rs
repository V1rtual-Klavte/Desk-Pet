// ==========================================
// Skill 目录指纹
//
// 每回合只做一次 mtime/size 扫描，不回读 SKILL.md 正文：技能目录有没有变化由指纹判定，
// 技能元数据与合法性的真相源是 Pi 的 loadSkills（TS 侧）。
// ==========================================

use std::collections::VecDeque;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use crate::rust_warn;

const SKILL_FILE: &str = "SKILL.md";
/// `count` 的上报上限：候选数超过它时截断计数并置 `truncated`，指纹仍覆盖全部候选。
const MAX_CATALOG_ENTRIES: usize = 128;
/// 单次扫描检查的 readdir 条目总数上限，防止异常膨胀的目录把每回合扫描变成无界 I/O。
const MAX_SCAN_ENTRIES: usize = 4096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogResult {
    /// 由全部候选条目的（域内相对路径, mtime, size）排序后哈希得到；目录不存在时为空串。
    fingerprint: String,
    /// 扫描到的候选条目数；超过 [`MAX_CATALOG_ENTRIES`] 时截到该值。
    count: usize,
    /// 计数被截断，或扫描在 [`MAX_SCAN_ENTRIES`] 条 readdir 条目处提前停止。
    truncated: bool,
}

/// 候选条目：域内相对路径（`/` 分隔）+ mtime/size。不读正文，也不读 frontmatter。
struct SkillCandidate {
    relative_path: String,
    mtime_ms: u64,
    size: u64,
}

struct SkillScan {
    candidates: Vec<SkillCandidate>,
    truncated: bool,
}

/// 扫描 data_root/skills/，返回目录指纹。
///
/// 返回体只有 `{fingerprint, count, truncated}`：调用方拿指纹比对，变了才重新加载技能目录。
///
/// 扫描口径按 Pi `loadSkills`（`@earendil-works/pi-agent-core/dist/harness/skills.js`）的实际遍历定义：
///
/// - 递归下钻子目录，收集其中的 `SKILL.md`；
/// - 只有 `skills/` 根这一层的 `.md` 文件也算技能 —— Pi 只在根调用时传 `includeRootFiles = true`
///   （`:38`），下钻时固定传 `false`（`:119`）；
/// - 跳过 `.` 前缀条目与 `node_modules`（`:108`）；
/// - 类型判定跟随符号链接（Pi 的 `resolveKind` 会把链接解析到目标再判类型，`:281-309`）；
///   悬空链接或扫描期间被删除的条目取不到元数据即跳过，与 Pi「解析不出 kind 就不处理」一致。
///
/// 与 Pi 的两处已知差异都只会「多扫」不会「漏扫」（指纹失效的唯一危险方向是漏扫）：
///
/// - Pi 在目录里一旦找到 `SKILL.md` 就提前返回、不再下钻也不再处理同级条目（`:105`），本扫描不剪枝。
///   理由是 Pi 的忽略文件（`.gitignore`/`.ignore`/`.fdignore`，`:99`/`:133-174`）可以让它越过被忽略的
///   `SKILL.md` 继续下钻，而 Rust 侧不解析忽略规则 —— 不剪枝才能保证「Pi 可能读到的文件一定是候选」；
///   代价是嵌套场景多记一条，最多多触发一次重载。
/// - 忽略规则（含忽略文件自身的变化）不参与扫描，因此被忽略子树的变化同样只会多报。
fn catalog_snapshot(skills_root: &Path, data_root: &Path) -> AppResult<SkillCatalogResult> {
    if !skills_root.exists() {
        // 目录不存在是合法状态（用户可以把技能全删掉），指纹留空串以便与「存在但为空」区分开。
        return Ok(SkillCatalogResult {
            fingerprint: String::new(),
            count: 0,
            truncated: false,
        });
    }
    AppPaths::validate_path(skills_root, data_root)?;

    let scan = scan_skills(skills_root)?;
    let count = scan.candidates.len().min(MAX_CATALOG_ENTRIES);
    Ok(SkillCatalogResult {
        fingerprint: catalog_fingerprint(&scan.candidates, scan.truncated),
        count,
        truncated: scan.truncated || scan.candidates.len() > MAX_CATALOG_ENTRIES,
    })
}

/// 遍历 skills 根，收集候选条目。
///
/// 显式队列而不是递归：Pi 的遍历没有深度上限，递归实现会跟着目录深度吃栈。
fn scan_skills(skills_root: &Path) -> AppResult<SkillScan> {
    let mut candidates: Vec<SkillCandidate> = Vec::new();
    let mut truncated = false;
    let mut budget = MAX_SCAN_ENTRIES;
    let mut queue: VecDeque<(PathBuf, bool)> = VecDeque::new();
    queue.push_back((skills_root.to_path_buf(), true));

    'walk: while let Some((dir, is_root)) = queue.pop_front() {
        let read_dir = match fs::read_dir(&dir) {
            Ok(read_dir) => read_dir,
            Err(e) => {
                if dir == skills_root {
                    return Err(AppError::Io(format!("读取 Skill 目录失败: {e}")));
                }
                // 子目录可能在扫描期间被删除或不可读；单条失败不该让整次指纹核对失败，
                // 但根因仍要留痕，本模块统一留痕点是 rust_warn!。
                rust_warn!("Skill 扫描跳过不可读目录 {}: {}", dir.display(), e);
                continue;
            }
        };

        let mut entries: Vec<(String, PathBuf, fs::Metadata)> = Vec::new();
        for entry in read_dir {
            if budget == 0 {
                truncated = true;
                break 'walk;
            }
            budget -= 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    // 条目可能在扫描期间消失或不可读（与上面的目录分支同类）：单条失败不该让
                    // 整次指纹核对失败，但根因仍要留痕，本模块统一留痕点是 rust_warn!。
                    // readdir 条目拿不到出错条目的名字，只能记下所在目录。
                    rust_warn!("Skill 扫描跳过不可读条目（目录 {}）: {}", dir.display(), e);
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            // 跟随符号链接取类型与时间戳；悬空链接/已删除条目取不到元数据（与上面的 readdir
            // 分支同理）：单条失败不该让整次指纹核对失败，但根因仍要留痕，本模块统一留痕点
            // 是 rust_warn!。
            let metadata = match fs::metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(e) => {
                    rust_warn!("Skill 扫描跳过不可读条目 {}: {}", entry.path().display(), e);
                    continue;
                }
            };
            entries.push((name, entry.path(), metadata));
        }
        // 与 Pi 的递归分支一样按名字排序（`:107`）：扫描预算被打满时，截断点也由磁盘状态决定，
        // 同一状态下不会因为 readdir 顺序不同得到不同指纹。
        entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));

        for (name, path, metadata) in entries {
            if metadata.is_dir() {
                queue.push_back((path, false));
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            // 根级 `.md` 也算技能；下钻层级里只有 `SKILL.md` 是候选。
            if name != SKILL_FILE && !(is_root && name.ends_with(".md")) {
                continue;
            }
            let Some(relative_path) = relative_skill_path(skills_root, &path) else {
                continue;
            };
            candidates.push(SkillCandidate {
                relative_path,
                mtime_ms: modified_ms(&metadata),
                size: metadata.len(),
            });
        }
    }

    Ok(SkillScan {
        candidates,
        truncated,
    })
}

/// 域内相对路径一律用 `/` 分隔。
///
/// Pi 的 `relativeEnvPath`（`:317-325`）同样把 `\` 归一成 `/`：两端用同一形态，同一磁盘状态在
/// Windows/macOS 上才得到同一指纹，这个字符串也可以直接回传给 `skill_delete`。
fn relative_skill_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut segments: Vec<String> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(segment) => segments.push(segment.to_string_lossy().into_owned()),
            // 路径都由本模块用「root + 条目名」拼出，`..`/根/盘符前缀不该出现；
            // 真出现即说明假设被打破，丢掉该条目，不把绝对路径或含 `..` 的串塞进指纹。
            _ => return None,
        }
    }
    if segments.is_empty() {
        return None;
    }
    Some(segments.join("/"))
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    // 不支持 mtime 的文件系统上退回 0：该条目仍由 size 参与指纹，指纹本身只做变化检测。
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

/// 候选集指纹：按相对路径排序后逐条哈希，保证同一磁盘状态得到同一指纹。
fn catalog_fingerprint(candidates: &[SkillCandidate], truncated: bool) -> String {
    let mut sorted: Vec<&SkillCandidate> = candidates.iter().collect();
    sorted.sort_by(|left, right| left.relative_path.as_bytes().cmp(right.relative_path.as_bytes()));
    let entry_fingerprints: Vec<String> = sorted
        .iter()
        .map(|candidate| {
            hash_hex(&[
                candidate.relative_path.as_bytes(),
                &candidate.mtime_ms.to_le_bytes(),
                &candidate.size.to_le_bytes(),
            ])
        })
        .collect();
    let truncated_bytes = [u8::from(truncated)];
    let mut parts: Vec<&[u8]> = Vec::with_capacity(entry_fingerprints.len() + 1);
    parts.push(&truncated_bytes);
    for entry in &entry_fingerprints {
        parts.push(entry.as_bytes());
    }
    hash_hex(&parts)
}

#[tauri::command]
pub fn skill_catalog_fingerprint(paths: State<AppPaths>) -> AppResult<SkillCatalogResult> {
    catalog_snapshot(&paths.skills, &paths.data_root)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 建一个「data_root + skills」临时目录，返回两者。
    fn fixture(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "deskpet-skill-{tag}-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let skills = root.join("skills");
        fs::create_dir_all(&skills).unwrap();
        (root, skills)
    }

    fn write_skill(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join(SKILL_FILE),
            "---\nname: demo\ndescription: 演示技能\n---\n正文\n",
        )
        .unwrap();
    }

    fn relative_paths(scan: &SkillScan) -> Vec<String> {
        let mut paths: Vec<String> = scan
            .candidates
            .iter()
            .map(|candidate| candidate.relative_path.clone())
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn collects_nested_skill_files_and_root_markdown() {
        let (root, skills) = fixture("scan");
        write_skill(&skills.join("alpha"));
        write_skill(&skills.join("alpha/reference"));
        write_skill(&skills.join("beta"));
        fs::write(skills.join("loose.md"), "---\ndescription: 单文件技能\n---\n").unwrap();
        fs::write(skills.join("readme.txt"), "x").unwrap();
        fs::create_dir_all(skills.join("alpha/reference/notes")).unwrap();
        fs::write(skills.join("alpha/reference/notes/tips.md"), "x").unwrap();

        let scan = scan_skills(&skills).unwrap();
        assert_eq!(
            relative_paths(&scan),
            vec![
                "alpha/SKILL.md",
                "alpha/reference/SKILL.md",
                "beta/SKILL.md",
                "loose.md"
            ]
        );
        assert!(!scan.truncated);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn skips_hidden_entries_and_node_modules() {
        let (root, skills) = fixture("skip");
        write_skill(&skills.join(".hidden"));
        write_skill(&skills.join("node_modules/pkg"));
        write_skill(&skills.join("visible"));

        assert_eq!(
            relative_paths(&scan_skills(&skills).unwrap()),
            vec!["visible/SKILL.md"]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn fingerprint_is_stable_until_a_candidate_changes() {
        let (root, skills) = fixture("fingerprint");
        write_skill(&skills.join("alpha"));

        let first = catalog_snapshot(&skills, &root).unwrap();
        let second = catalog_snapshot(&skills, &root).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.count, 1);

        // 只动 mtime（长度不变）：指纹也要变，否则「内容改了但清单不重载」会漏。
        let file = fs::File::options()
            .write(true)
            .open(skills.join("alpha").join(SKILL_FILE))
            .unwrap();
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
            .unwrap();
        drop(file);
        let touched = catalog_snapshot(&skills, &root).unwrap();
        assert_ne!(first.fingerprint, touched.fingerprint);

        // 新增候选条目：指纹同样要变。
        write_skill(&skills.join("beta"));
        let added = catalog_snapshot(&skills, &root).unwrap();
        assert_ne!(touched.fingerprint, added.fingerprint);
        assert_eq!(added.count, 2);

        // 非候选条目（下钻层级里的普通 .md）不进指纹，避免无关文件引起整目录重载。
        fs::create_dir_all(skills.join("beta/notes")).unwrap();
        fs::write(skills.join("beta/notes/tips.md"), "x").unwrap();
        assert_eq!(added.fingerprint, catalog_snapshot(&skills, &root).unwrap().fingerprint);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_directory_is_an_empty_catalog_not_an_error() {
        let (root, skills) = fixture("missing");
        fs::remove_dir_all(&skills).unwrap();

        let result = catalog_snapshot(&skills, &root).unwrap();
        assert_eq!(result.count, 0);
        assert!(result.fingerprint.is_empty());
        assert!(!result.truncated);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn skills_root_outside_data_root_is_rejected() {
        let (root, skills) = fixture("escape");
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();

        assert!(matches!(
            catalog_snapshot(&skills, &other),
            Err(AppError::PathEscape)
        ));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn count_is_capped_and_flagged_as_truncated() {
        let (root, skills) = fixture("cap");
        for index in 0..MAX_CATALOG_ENTRIES + 2 {
            write_skill(&skills.join(format!("skill-{index:03}")));
        }

        let result = catalog_snapshot(&skills, &root).unwrap();
        assert_eq!(result.count, MAX_CATALOG_ENTRIES);
        assert!(result.truncated);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn scan_budget_stops_the_walk_and_flags_truncated() {
        let (root, skills) = fixture("budget");
        for index in 0..MAX_SCAN_ENTRIES + 1 {
            fs::create_dir_all(skills.join(format!("d{index:05}"))).unwrap();
        }

        let result = catalog_snapshot(&skills, &root).unwrap();
        assert!(result.truncated);
        assert_eq!(result.count, 0);
        fs::remove_dir_all(&root).unwrap();
    }
}
