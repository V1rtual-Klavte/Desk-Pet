// ==========================================
// 安全控制 —— 风险模式库与路径/命令分级
//
// 四级安全（等级词汇由 `SAFETY_ORDER` 定义；判定与放行在 `permission.ts`）:
//   SAFE    — 路径与命令都不额外提级
//   NORMAL  — 常规系统操作
//   DANGER  — 危险命令或敏感路径，按安全模式裁决（确认后放行）
//   NOWAY   — 凭据路径与硬禁止命令，永不放行
//
// 会话信任与安全裁决的唯一实现是 `permission.ts`；本文件只保留风险模式与
// 路径/命令分级（`tool/local/pi-tools.ts` 的三个调用点）。
// ==========================================

import type { SafetyLevel } from "@/services/tool/types"

// ═══════════════════════════════════════════════════════════════
// 统一危险模式库 —— 所有工具共享，避免散落各处
// ═══════════════════════════════════════════════════════════════

/** Bash 命令危险模式 — NORMAL 级别拦截 */
export const BASH_DANGEROUS_PATTERNS: RegExp[] = [
  // rm 的递归删除：短选项可合并（-rf、-fr）也可分开（-r -f），并接受长选项 --recursive
  /\brm\s+(?:--?[a-zA-Z-]+\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
  /\bsudo\b/, /\bchmod\s+777\b/,
  />\s*\/dev\//, /\bcurl\b.*\|\s*(ba)?sh\b/,
  /\bmkfs\b/, /\bdd\s+if=/,
]

/** Bash 命令硬禁止模式 — 永不放行 */
export const BASH_NOWAY_PATTERNS: RegExp[] = [
  // 递归删除根目录：目标必须是 "/" 本身（后接空白或行尾）才算硬禁止，避免误杀 "rm -rf /home"。
  // 旧写法把 \b 放在 "/" 之后，而 "/" 与行尾之间不存在单词边界，断言恒为假 ——
  // 结果是 "rm -rf /" 只落到 DANGER，多空格写法（"rm  -rf  /"）同样不命中。
  /\brm\s+(?:--?[a-zA-Z-]+\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s+-{1,2}[a-zA-Z-]+)*\s+\/(?:\s|$)/,
  /\bsudo\s+rm\b/, /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//, /\bcurl\b.*\|\s*(ba)?sh\b/,
  />\s*\/etc\//,
]

/** 私钥与凭据类路径 — 连读取都不允许，内容一旦进模型上下文就等于泄露。
 *  规则文本（与 Rust `paths.rs::is_credential_path` 同一规则族）：路径中出现 `.ssh` 目录组件，
 *  或以 `.pem` / `.key` 结尾。首条 `(^|\/)` 覆盖不带前导斜杠的相对形式（`.ssh/id_rsa`）。
 *  三条都带 `i` 标志：macOS/Windows 文件系统大小写不敏感，`.SSH`/`.PEM` 必须同判（Rust 侧用
 *  `to_ascii_lowercase()` 达到同一效果）；**不要**改成把整条路径 lower 后再匹配 ——
 *  `FILE_SENSITIVE_PATTERNS` 里的 `/System/`、`/Windows/` 依赖大写，整体 lower 会让它们失效。
 *  这里只是同一规则族的分级副本；权威判定在 Rust（`paths.rs` / `bash_policy.rs`）。 */
export const FILE_NOWAY_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/i, /\.pem$/i, /\.key$/i,
]

/** 敏感但可由用户确认的路径 — 环境变量文件与系统目录 */
export const FILE_SENSITIVE_PATTERNS: RegExp[] = [
  /\/etc\/passwd/, /\/etc\/shadow/,
  /\/System\//, /\/Windows\//,
  /\.env$/,
]

/** 全部敏感路径模式。按子集并入，语义与拆分前一致，粗粒度断言仍然成立。 */
export const FILE_DANGEROUS_PATTERNS: RegExp[] = [
  ...FILE_NOWAY_PATTERNS,
  ...FILE_SENSITIVE_PATTERNS,
]

/** 检测文本是否匹配任一危险模式 */
export function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text))
}

/** 安全级别由低到高，用于合并「工具固有等级」与「本次调用的路径风险」。 */
const SAFETY_ORDER: SafetyLevel[] = ["SAFE", "NORMAL", "DANGER", "NOWAY"]

/** 取两个安全级别中更严的那个。 */
export function maxSafetyLevel(a: SafetyLevel, b: SafetyLevel): SafetyLevel {
  return SAFETY_ORDER.indexOf(a) >= SAFETY_ORDER.indexOf(b) ? a : b
}

/** 供分级使用的词法归一：`\` → `/`、`$HOME`/`${HOME}`/`~` 视为 home 根、去 `./`、折叠 `..`。
 *  不解析符号链接、不查磁盘；只为了让相对形式与绝对形式进同一套模式。 */
function normalizeForGrading(path: string): string {
  let p = path.replace(/\\/g, "/").replace(/^\$\{HOME\}/, "~").replace(/^\$HOME/, "~")
  const out: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") { if (out.length === 0) out.push(""); continue }
    if (seg === "..") { if (out.length > 1) out.pop(); continue }
    out.push(seg)
  }
  return out.join("/")
}

/**
 * 按本次调用的路径解析文件风险等级。
 *
 * 这里是 `FILE_*_PATTERNS` 的生产接入点。此前它们只有测试消费者，
 * 于是 `pi-read` 以 SAFE 放行一切路径 —— `~/.ssh/id_rsa` 会被原样送进模型上下文。
 *
 * 返回 `SAFE` 表示「路径本身不额外提级」，由调用方与工具固有等级合并，
 * 因此这个函数可以单独用作只读工具的 `resolveSafetyLevel`。
 *
 * 匹配前先做词法归一（反斜杠、`~`/`$HOME`/`${HOME}`、`./`、`..`）：
 * 上游 `read` 工具的 schema 明示路径可为相对而 cwd 是 home，只认绝对形式的模式
 * 会让 `.ssh/id_rsa` 完全不命中。
 *
 * 归一仅用于**分级**；权威判定在 Rust（`paths.rs` / `bash_policy.rs`），
 * 这里不看符号链接也不查磁盘，更不是 OS 沙箱。
 */
export function resolveFilePathLevel(path: unknown): SafetyLevel {
  if (typeof path !== "string" || path.length === 0) return "SAFE"
  const normalized = normalizeForGrading(path)
  if (matchesAnyPattern(normalized, FILE_NOWAY_PATTERNS)) return "NOWAY"
  if (matchesAnyPattern(normalized, FILE_SENSITIVE_PATTERNS)) return "DANGER"
  return "SAFE"
}
