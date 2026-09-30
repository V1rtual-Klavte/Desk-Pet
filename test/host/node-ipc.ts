// ==========================================
// Node IPC 适配层 —— 顶替 @tauri-apps/api/core 的 invoke
// ==========================================
//
// 只实现**机制**：把命令分发到 Node 等价实现，数据根指向 setTestDataRoot 给的临时目录。
// 不实现**策略**：不做路径裁决（允许根 / 凭据拦截 / 符号链接去向）、不做 Bash 基线、
// 不做许可配额 —— 那些属于 Rust，命中即抛 UnsupportedInNodeError（见 unsupported.ts），
// 让场景明确留在 L4，而不是在假适配下「假装通过」。
//
// 两条硬规则：
//   1. 未登记命令一律抛错，**任何分支都不返回 null 冒充成功**；
//   2. 参数名按 Rust 侧 `#[tauri::command]` 的 camelCase 键逐个抄写（Tauri 默认
//      ArgumentCase::Camel，见 tauri-macros command/wrapper.rs），取不到就抛错 ——
//      参数名写错时静默拿到 undefined，只会读写错路径，是最难查的一类假通过。
//
// 签名以 src-tauri/src/commands/ 下的源文件为准，每条 handler 上注明出处。
// [保留已登记 §4.2] 本文件在 Node 侧运行，不能 import @/services/logger|error（会拖进 Tauri IPC
// 与浏览器全局）；需要留痕时写 stderr，不污染 stdout（vitest 用它输出报告）。
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"

import { RUST_ONLY_COMMANDS, UnsupportedInNodeError } from "./unsupported"

type Args = Record<string, unknown>

// ── 测试数据根 ──

let testDataRoot: string | undefined

/**
 * 把数据根指向一个临时目录（通常是 `mkdtempSync(join(tmpdir(), "deskpet-"))`）。
 * 每个测试文件开头必须调用一次。
 *
 * 与 Rust `AppPaths::init` 等价：这里一并建出标准子目录。不这么做的话，
 * `write_session_ui_state` 之类「Rust 侧依赖启动时已建目录」的命令会以不同的方式失败，
 * 场景看到的就不是产品行为。**随包种子（默认 Card / Profile / Skill）不复现** ——
 * 那是 Tauri 构建里的资源目录，测试需要什么自己写。
 */
export function setTestDataRoot(dir: string): void {
  // 只接受绝对路径：Rust 的 data_root 恒为绝对路径，相对路径会让写入落在进程 CWD
  // （也就是仓库里），既不是产品行为，也可能污染工作区。
  if (dir === "" || !isAbsolute(dir)) {
    throw new Error(`测试数据根必须是绝对路径（Rust data_root 同口径）: ${JSON.stringify(dir)}`)
  }
  testDataRoot = dir
  const p = paths()
  for (const path of [
    p.memory,
    p.sessions,
    p.personality,
    p.profiles,
    p.skills,
    p.settings,
    p.logs,
  ]) {
    mkdirSync(path, { recursive: true })
  }
}

export function getTestDataRoot(): string {
  if (!testDataRoot) throw new Error("测试数据根未初始化：请先调用 setTestDataRoot(临时目录)")
  return testDataRoot
}

/**
 * 由数据根派生的路径表，字段与 Rust `AppPaths` 对应（`skills` / `logs` 不在
 * `get_runtime_paths` 的返回体里，但命令内部要用）。
 *
 * `configFile` 是**有意偏离**：Rust 开发构建把配置放 `{仓库根}/CONFIG-DEV.yaml`，
 * 照搬会让测试读写真实开发配置（Live 配置污染坑）。适配层的契约是「根指向临时目录」，
 * 因此取生产布局 `{settings}/CONFIG.yaml`，读写都在可弃根内；runtimeMode 仍报 development
 * ——Node 测试不是生产构建。未复现的只是「开发布局」这一处，已登记在交付报告里。
 */
function paths() {
  const root = getTestDataRoot()
  return {
    dataRoot: root,
    memory: join(root, "memory"),
    sessions: join(root, "sessions"),
    personality: join(root, "personality"),
    profiles: join(root, "profiles"),
    skills: join(root, "skills"),
    settings: join(root, "settings"),
    logs: join(root, "logs"),
    configFile: join(root, "settings", "CONFIG.yaml"),
    runtimeMode: "development" as const,
  }
}

// ── 错误归一 ──

/** Rust `AppError` 的序列化形态：`{ code, message }`（src-tauri/src/error.rs）。 */
interface AppErrorPayload {
  code: string
  message: string
}

/**
 * Tauri 把 `Err(AppError)` 作为**值**（不是 Error 实例）抛给 JS，`@/services/error` 的
 * `errorCode` / `formatError` 正是按这个形状读的，所以适配层也抛同形状对象，不包 Error。
 */
function appError(code: string, message: string): AppErrorPayload {
  return { code, message }
}

function pathEscape(): AppErrorPayload {
  return appError("PATH_ESCAPE", "路径越权")
}

function pathNotFound(path: string): AppErrorPayload {
  return appError("PATH_NOT_FOUND", `路径不存在: ${path}`)
}

function ioError(action: string, cause: unknown): AppErrorPayload {
  return appError("IO", `${action}: ${cause instanceof Error ? cause.message : String(cause)}`)
}

/**
 * Node 的 fs 错误按 Rust 口径归一：`ENOENT`/`ENOTDIR` 等价于 Rust 侧 `canonicalize` 失败
 * （`validate_file_path` → PATH_NOT_FOUND），其余归 IO。只做错误码翻译，不做路径裁决。
 */
function fromFsError(path: string, action: string, cause: unknown): never {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  if (code === "ENOENT" || code === "ENOTDIR") throw pathNotFound(path)
  throw ioError(action, cause)
}

/** Rust 侧只给 `AppError::Io` / 自定义文案的分支：不把 ENOENT 翻译成 PATH_NOT_FOUND。 */
function ioFromFsError(action: string, cause: unknown): never {
  throw ioError(action, cause)
}

// ── 参数读取 ──

/**
 * 取一个**必填**参数。取不到就抛 —— Tauri 侧反序列化失败同样会报错，
 * 而放过 undefined 会让命令静默读写错路径。
 */
function arg<T>(args: Args, key: string): T {
  const value = args[key]
  if (value === undefined) {
    throw new Error(
      `IPC 参数缺失: ${key}。参数名按 Rust #[tauri::command] 的 camelCase 逐个对照 ` +
        `（src-tauri/src/commands/）后抄写，写错时 Tauri 会反序列化失败，这里同样直接报错。`,
    )
  }
  return value as T
}

/** 可选参数：Rust 侧是 `Option<T>` 的那些键。 */
function optionalArg<T>(args: Args, key: string): T | undefined {
  return args[key] as T | undefined
}

// ── 文件类型与路径解析（只复现解析语义，不复现允许根裁决）──

/** Rust `modified().as_millis()`：毫秒整数（Node 22 的 mtimeMs 可能是 bigint）。 */
function mtimeMsOf(stat: Stats): number {
  return Math.trunc(Number(stat.mtimeMs))
}

/** 与 Rust `describe_file_type` 同口径，只用于错误文案。 */
function describeFileType(stat: Stats): string {
  if (stat.isDirectory()) return "目录"
  if (stat.isFIFO()) return "命名管道（FIFO）"
  if (stat.isSocket()) return "套接字"
  if (stat.isCharacterDevice()) return "字符设备"
  if (stat.isBlockDevice()) return "块设备"
  return "非常规文件"
}

/**
 * 与 Rust `ensure_regular_file` 同口径：FIFO / 设备 / 套接字会让读写无限阻塞
 * （tool_permit 的额度要等 handler 结算才释放），从源头拒绝。
 */
function ensureRegularFile(path: string, requested: string): void {
  const stat = statSync(path)
  if (!stat.isFile()) {
    throw appError("TOOL", `只允许操作常规文件，目标是${describeFileType(stat)}: ${requested}`)
  }
}

/** 读路径的前置判定：不存在报 PATH_NOT_FOUND（等价 Rust 的 canonicalize 失败），再判类型。 */
function ensureReadable(path: string): void {
  if (!existsSync(path)) throw pathNotFound(path)
  ensureRegularFile(path, path)
}

/**
 * 域内相对路径 → 段数组。与 Rust `Component::Normal` 同口径：拒绝绝对路径、前导 `./`、
 * 任意位置的 `..`、Windows 盘符前缀；空段与中间的 `.` 被折叠掉（Rust 的 components() 同样折叠）。
 *
 * 这是**解析语义**（相对段怎么拼），不是路径裁决：允许根、凭据拦截、符号链接去向
 * 这些策略一概不复现。
 */
function splitNormalSegments(value: string): string[] {
  const separators = process.platform === "win32" ? /[\\/]+/ : /\//
  if (isAbsolute(value)) throw pathEscape()
  const parts = value.split(separators)
  if (parts[0] === "." || parts[0] === "..") throw pathEscape()
  // Windows 盘符前缀（`C:` 与 `C:foo` 都是 Prefix 分量，Rust 一律拒绝）。
  if (process.platform === "win32" && /^[A-Za-z]:/.test(parts[0])) throw pathEscape()
  const kept = parts.filter((part) => part !== "" && part !== ".")
  if (kept.includes("..")) throw pathEscape()
  return kept
}

/**
 * personality 域：**拒绝域前缀**。Rust `resolve_personality_path` 显式拒绝
 * `personality/xxx` —— 容忍它会拼成 `personality/personality/xxx`，读是静默找不到、
 * 写则悄悄建出错误的嵌套目录。这条拒绝属于解析语义，照抄。
 */
function personalityPath(relative: string): string {
  if (relative.startsWith("personality/") || relative.startsWith("personality\\")) {
    throw appError("OTHER", `不要传域前缀，请传域内相对路径（如 stages/x.json）: ${relative}`)
  }
  return join(paths().personality, ...splitNormalSegments(relative))
}

// ── 日志 sink（commands/logging.rs + logger.rs）──

const LOG_LEVEL_NAMES = ["DEBUG", "INFO ", "WARN ", "ERROR"] as const
let nodeLogLevel = 0

/** Node 侧没有 rust_*! 宏，级别只记录，供场景回读自己设过的生效级别（未复现的是宏过滤）。 */
export function getNodeLogLevel(): number {
  return nodeLogLevel
}

/** 与 Rust `local_hms()` 同口径的本地时间 HH:MM:SS.mmm。 */
function localHms(): string {
  const now = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
    now.getMilliseconds(),
    3,
  )}`
}

/** 与 Rust `logger::write_line` 一致：追加到 `{logs}/deskpet.log`（行尾自带换行）。 */
function appendLogLine(line: string): void {
  const logs = paths().logs
  mkdirSync(logs, { recursive: true })
  appendFileSync(join(logs, "deskpet.log"), `${line}\n`, "utf8")
}

// ── Skill 目录指纹（commands/skill_cmd.rs）──

const SKILL_FILE = "SKILL.md"
/** `count` 的上报上限；超过它截断计数并置 truncated，指纹仍覆盖全部候选。 */
const MAX_CATALOG_ENTRIES = 128
/** 单次扫描检查的 readdir 条目总数上限。 */
const MAX_SCAN_ENTRIES = 4096

const UINT64_MASK = (1n << 64n) - 1n

/** Rust `hash_hex` 同口径：FNV-1a，每段之后额外异或一次 0xff。 */
function hashHex(parts: Uint8Array[]): string {
  let hash = 0xcbf29ce484222325n
  for (const part of parts) {
    for (const byte of part) {
      hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & UINT64_MASK
    }
    hash = ((hash ^ 0xffn) * 0x100000001b3n) & UINT64_MASK
  }
  return hash.toString(16).padStart(16, "0")
}

function u64le(value: number): Uint8Array {
  const buffer = new Uint8Array(8)
  new DataView(buffer.buffer).setBigUint64(0, BigInt(value), true)
  return buffer
}

interface SkillCandidate {
  relativePath: string
  mtimeMs: number
  size: number
}

interface PendingDir {
  dir: string
  relative: string
  isRoot: boolean
}

/**
 * 与 Rust `scan_skills` 同口径的显式队列遍历：跳过 `.` 前缀与 `node_modules`，
 * 跟随符号链接判类型（悬空链接跳过），根层 `.md` 与任意层的 `SKILL.md` 是候选。
 * 目录不存在不算错（调用方先判），单条读失败只跳过并留痕到 stderr。
 */
function scanSkills(skillsRoot: string): { candidates: SkillCandidate[]; truncated: boolean } {
  const candidates: SkillCandidate[] = []
  let truncated = false
  let budget = MAX_SCAN_ENTRIES
  const queue: PendingDir[] = [{ dir: skillsRoot, relative: "", isRoot: true }]

  walk: while (queue.length > 0) {
    const current = queue.shift() as PendingDir
    let dirents: Dirent[]
    try {
      dirents = readdirSync(current.dir, { withFileTypes: true })
    } catch (cause) {
      if (current.isRoot) throw ioError("读取 Skill 目录失败", cause)
      // 子目录可能在扫描期间被删除或不可读：单条失败不该让整次指纹核对失败（Rust 同分支）。
      process.stderr.write(`[node-ipc] Skill 扫描跳过不可读目录 ${current.dir}: ${String(cause)}\n`)
      continue
    }

    const entries: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }> = []
    for (const dirent of dirents) {
      if (budget === 0) {
        truncated = true
        break walk
      }
      budget -= 1
      const name = dirent.name
      if (name.startsWith(".") || name === "node_modules") continue
      const target = join(current.dir, name)
      // 跟随符号链接取类型（Rust 用 fs::metadata）：悬空链接取不到即跳过。
      let stat
      try {
        stat = statSync(target)
      } catch (cause) {
        process.stderr.write(`[node-ipc] Skill 扫描跳过不可读条目 ${target}: ${String(cause)}\n`)
        continue
      }
      entries.push({ name, path: target, isDirectory: stat.isDirectory(), isFile: stat.isFile() })
    }
    // 按名字字节序排序（与 Pi 的递归分支一致）：扫描预算被打满时截断点也由磁盘状态决定。
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))

    for (const entry of entries) {
      const relative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`
      if (entry.isDirectory) {
        queue.push({ dir: entry.path, relative, isRoot: false })
        continue
      }
      if (!entry.isFile) continue
      // 根级 `.md` 也算技能；下钻层级里只有 SKILL.md 是候选。
      if (entry.name !== SKILL_FILE && !(current.isRoot && entry.name.endsWith(".md"))) continue
      const stat = statSync(entry.path)
      candidates.push({
        relativePath: relative,
        mtimeMs: mtimeMsOf(stat),
        size: Number(stat.size),
      })
    }
  }

  return { candidates, truncated }
}

/** Rust `catalog_fingerprint`：按相对路径排序后逐条哈希，再哈希整体。 */
function catalogFingerprint(candidates: SkillCandidate[], truncated: boolean): string {
  const sorted = [...candidates].sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)),
  )
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = [new Uint8Array([truncated ? 1 : 0])]
  for (const candidate of sorted) {
    parts.push(
      encoder.encode(
        hashHex([encoder.encode(candidate.relativePath), u64le(candidate.mtimeMs), u64le(candidate.size)]),
      ),
    )
  }
  return hashHex(parts)
}

// 记忆主路径已经是 Rust SQLite；Node 适配层不伪造 SQLite，Rust-only 命令会明确抛错。

// ── 辅助 ──

/**
 * 严格 UTF-8 解码。Rust `read_to_string` 遇非法 UTF-8 报错，Node 默认会静默替换成 U+FFFD；
 * `ignoreBOM: true` 与 Rust 一致地保留 BOM（TextDecoder 默认会吃掉它）。
 */
function decodeUtf8Strict(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer)
}

/** 不跟随链接的存在性判定（悬空链接也算存在）。 */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * 不跟随链接的（size, mtime）数字对。取不到元数据时返回 0/0 —— 这是 Rust
 * `metadata.map(|m| m.len()).unwrap_or(0)` 的同口径兜底：单条读失败不丢掉整次列表。
 */
function lstatNumbers(path: string): { size: number; mtimeMs: number } {
  try {
    const stat = lstatSync(path)
    return { size: Number(stat.size), mtimeMs: mtimeMsOf(stat) }
  } catch {
    return { size: 0, mtimeMs: 0 }
  }
}

/** 字节序字符串比较，对齐 Rust 的 `as_bytes().cmp()`。 */
function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

// ── 命令实现表 ──

const handlers: Record<string, (args: Args) => unknown> = {
  // ── 文件操作（tool_exec.rs）──

  /** file_read(path: String, max_bytes: Option<usize>) -> { content, size } */
  file_read: (args) => {
    const path = arg<string>(args, "path")
    const maxBytes = optionalArg<number>(args, "maxBytes")
    ensureReadable(path)
    if (maxBytes !== undefined && statSync(path).size > maxBytes) {
      throw appError("OTHER", `文件过大，最多读取 ${maxBytes} bytes`)
    }
    let raw: Buffer
    try {
      raw = readFileSync(path)
    } catch (cause) {
      fromFsError(path, "读取失败", cause)
    }
    try {
      return { content: decodeUtf8Strict(raw), size: raw.byteLength }
    } catch (cause) {
      throw ioError("读取失败", cause)
    }
  },

  /** file_write(path: String, content: String, max_bytes: Option<usize>) -> { success: true } */
  file_write: (args) => {
    const path = arg<string>(args, "path")
    const content = arg<string>(args, "content")
    const maxBytes = optionalArg<number>(args, "maxBytes")
    // Rust 比的是 String::len()（UTF-8 字节数），不是 JS 的 UTF-16 码元数。
    if (maxBytes !== undefined && Buffer.byteLength(content, "utf8") > maxBytes) {
      throw appError("OTHER", `写入内容过大，最多 ${maxBytes} bytes`)
    }
    // 已存在的目标只允许是常规文件（FIFO 的 open 会等到对端，handler 永不结算）。
    if (existsSync(path)) ensureRegularFile(path, path)
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, "utf8")
    } catch (cause) {
      fromFsError(path, "写入失败", cause)
    }
    return { success: true }
  },

  /** file_write_atomic(path: String, content: String, max_bytes: Option<usize>) -> { success: true } */
  file_write_atomic: (args) => {
    const path = arg<string>(args, "path")
    const content = arg<string>(args, "content")
    const maxBytes = optionalArg<number>(args, "maxBytes")
    if (maxBytes !== undefined && Buffer.byteLength(content, "utf8") > maxBytes) {
      throw appError("OTHER", `写入内容过大，最多 ${maxBytes} bytes`)
    }
    if (existsSync(path)) ensureRegularFile(path, path)
    const parent = dirname(path)
    // 临时文件必须与目标同目录：跨文件系统的 rename 会被内核拒绝（EXDEV）。
    const temp = join(parent, `${basename(path)}.tmp-${process.pid}-${process.hrtime.bigint()}`)
    try {
      mkdirSync(parent, { recursive: true })
      writeFileSync(temp, content, "utf8")
      renameSync(temp, path)
    } catch (cause) {
      rmSync(temp, { force: true })
      fromFsError(path, "写入失败", cause)
    }
    return { success: true }
  },

  /** file_append(path: String, content: String, max_bytes: u64) -> () —— maxBytes 是必填 */
  file_append: (args) => {
    const path = arg<string>(args, "path")
    const content = arg<string>(args, "content")
    const maxBytes = arg<number>(args, "maxBytes")
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw appError("OTHER", `追加内容过大，最多 ${maxBytes} bytes`)
    }
    if (existsSync(path)) ensureRegularFile(path, path)
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, content, "utf8")
    } catch (cause) {
      fromFsError(path, "打开文件失败", cause)
    }
  },

  /** file_rename(source_path: String, destination_path: String) -> () */
  file_rename: (args) => {
    const source = arg<string>(args, "sourcePath")
    const destination = arg<string>(args, "destinationPath")
    // 源不存在：Rust 侧 validate_file_path 的 canonicalize 失败 → PATH_NOT_FOUND。
    if (!existsSync(source)) throw pathNotFound(source)
    // 目标的父目录**不创建**（Rust 注释写明：会话存储先 write 临时文件再 rename）。
    try {
      renameSync(source, destination)
    } catch (cause) {
      ioFromFsError("重命名失败", cause)
    }
  },

  /** file_remove(path: String, recursive: bool, force: bool) -> () */
  file_remove: (args) => {
    const path = arg<string>(args, "path")
    const recursive = arg<boolean>(args, "recursive")
    const force = arg<boolean>(args, "force")
    // 存在性判定与 file_exists 一致：exists() 跟随符号链接，悬空链接视为不存在。
    if (!existsSync(path)) {
      if (force) return
      throw pathNotFound(path)
    }
    const isDirectory = statSync(path).isDirectory()
    if (isDirectory && !recursive) {
      throw appError("OTHER", `目标是目录，需要 recursive = true 才能删除: ${path}`)
    }
    try {
      rmSync(path, { recursive, force: false })
    } catch (cause) {
      fromFsError(path, isDirectory ? "删除目录失败" : "删除文件失败", cause)
    }
  },

  /** dir_create(path: String, recursive: bool) -> () */
  dir_create: (args) => {
    const path = arg<string>(args, "path")
    const recursive = arg<boolean>(args, "recursive")
    try {
      mkdirSync(path, { recursive })
    } catch (cause) {
      fromFsError(path, "创建目录失败", cause)
    }
  },

  /** file_list(path: String) -> { entries: [{ name, path, kind, size, mtimeMs }] } */
  file_list: (args) => {
    const path = arg<string>(args, "path")
    if (!existsSync(path)) throw pathNotFound(path)
    let dirents: Dirent[]
    try {
      dirents = readdirSync(path, { withFileTypes: true })
    } catch (cause) {
      fromFsError(path, "读取目录失败", cause)
    }
    const entries = dirents.map((dirent) => {
      const entryPath = join(path, dirent.name)
      // 符号链接不跟随（Rust 的 DirEntry::metadata 取链接自身）：悬空链接也能列出。
      const { size, mtimeMs } = lstatNumbers(entryPath)
      const kind = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "directory" : "file"
      return { name: dirent.name, path: entryPath, kind, size, mtimeMs }
    })
    // 目录优先、symlink 排在 file 之后：kind 的字节序即 directory < file < symlink。
    entries.sort(
      (left, right) =>
        compareBytes(left.kind, right.kind) || compareBytes(left.name.toLowerCase(), right.name.toLowerCase()),
    )
    return { entries }
  },

  /** file_read_binary(path: String, max_bytes: Option<usize>) -> Vec<u8>（JSON 里是 number[]） */
  file_read_binary: (args) => {
    const path = arg<string>(args, "path")
    const maxBytes = optionalArg<number>(args, "maxBytes")
    ensureReadable(path)
    const limit = maxBytes ?? 5 * 1024 * 1024
    if (statSync(path).size > limit) {
      throw appError("OTHER", `文件过大，最多读取 ${limit} bytes`)
    }
    try {
      return Array.from(readFileSync(path))
    } catch (cause) {
      fromFsError(path, "读取失败", cause)
    }
  },

  /** file_info(path: String) -> { name, path, kind, size, mtimeMs } */
  file_info: (args) => {
    const path = arg<string>(args, "path")
    // Rust 用 symlink_metadata（不跟随）：链接自身报 symlink，size/mtime 也是链接的。
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) throw pathNotFound(path)
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file"
    return {
      name: basename(path),
      path,
      kind,
      size: Number(stat.size),
      mtimeMs: mtimeMsOf(stat),
    }
  },

  /** file_exists(path: String) -> bool */
  file_exists: (args) => existsSync(arg<string>(args, "path")),

  /** file_canonical_path(path: String) -> String */
  file_canonical_path: (args) => {
    const path = arg<string>(args, "path")
    try {
      return realpathSync(path)
    } catch (cause) {
      fromFsError(path, "读取元数据失败", cause)
    }
  },

  // ── 运行时路径与配置（lib.rs）──

  /** get_runtime_paths() -> { data, memory, sessions, personality, profiles, settings, configFile, runtimeMode } */
  get_runtime_paths: () => {
    const p = paths()
    return {
      data: p.dataRoot,
      memory: p.memory,
      sessions: p.sessions,
      personality: p.personality,
      profiles: p.profiles,
      settings: p.settings,
      configFile: p.configFile,
      runtimeMode: p.runtimeMode,
    }
  },

  /** resolve_runtime_path(scope: String, segments: Vec<String>) -> String */
  resolve_runtime_path: (args) => {
    const scope = arg<string>(args, "scope")
    const segments = arg<string[]>(args, "segments")
    const p = paths()
    const scopes: Record<string, string> = {
      data: p.dataRoot,
      memory: p.memory,
      sessions: p.sessions,
      personality: p.personality,
      profiles: p.profiles,
      settings: p.settings,
    }
    const base = scopes[scope]
    if (!base) throw appError("OTHER", `未知运行时路径域: ${scope}`)
    const parts: string[] = []
    for (const segment of segments) parts.push(...splitNormalSegments(segment))
    return join(base, ...parts)
  },

  /** read_runtime_config() -> String —— Rust 只给 AppError::Io，不是 PATH_NOT_FOUND */
  read_runtime_config: () => {
    const file = paths().configFile
    try {
      return readFileSync(file, "utf8")
    } catch (cause) {
      ioFromFsError(`读取配置失败 ${file}`, cause)
    }
  },

  /** write_runtime_config(content: String) -> () */
  write_runtime_config: (args) => {
    const content = arg<string>(args, "content")
    const file = paths().configFile
    try {
      mkdirSync(paths().settings, { recursive: true })
      writeFileSync(file, content, "utf8")
    } catch (cause) {
      ioFromFsError("写入配置失败", cause)
    }
  },

  /** read_session_ui_state() -> Option<String> */
  read_session_ui_state: () => {
    const file = join(paths().sessions, "index.json")
    // 这个 null 是 Rust `Option::None` 的真实结果（「确实没有 UI 状态」），不是
    // 「适配层不知道怎么处理」的兜底 —— 后者一律抛错，不返回空值冒充成功。
    return existsSync(file) ? readFileSync(file, "utf8") : null
  },

  /** write_session_ui_state(content: String) -> () —— 父目录不创建，与 Rust 一致 */
  write_session_ui_state: (args) => {
    const content = arg<string>(args, "content")
    const file = join(paths().sessions, "index.json")
    try {
      writeFileSync(file, content, "utf8")
    } catch (cause) {
      ioFromFsError("写入会话 UI 状态失败", cause)
    }
  },

  // ── Skill（skill_cmd.rs / resources_cmd.rs）──

  /** skill_catalog_fingerprint() -> { fingerprint, count, truncated } */
  skill_catalog_fingerprint: () => {
    const skillsRoot = paths().skills
    // 目录不存在是合法状态（用户可以把技能全删掉），指纹留空串以与「存在但为空」区分开。
    if (!existsSync(skillsRoot)) return { fingerprint: "", count: 0, truncated: false }
    const scan = scanSkills(skillsRoot)
    return {
      fingerprint: catalogFingerprint(scan.candidates, scan.truncated),
      count: Math.min(scan.candidates.length, MAX_CATALOG_ENTRIES),
      truncated: scan.truncated || scan.candidates.length > MAX_CATALOG_ENTRIES,
    }
  },

  /** skill_delete(relative_path: String) -> () —— 入参是域内相对路径，不是 frontmatter 的 name */
  skill_delete: (args) => {
    const relative = arg<string>(args, "relativePath")
    const segments = splitNormalSegments(relative)
    if (segments.length === 0) throw pathEscape()
    const target = join(paths().skills, ...segments)
    // 不存在不再是静默成功：删错名字看起来也成功是最糟的假通过。
    if (!lstatExists(target)) throw pathNotFound(relative)
    try {
      // 真目录递归删除；符号链接只删链接本身（rmSync 不跟随链接）。
      rmSync(target, { recursive: true, force: false })
    } catch (cause) {
      fromFsError(target, "删除 Skill 失败", cause)
    }
  },

  // ── Profile（profile_cmd.rs）──

  /** profile_file_write(profile_id: String, relative_path: String, content: Vec<u8>) -> () */
  profile_file_write: (args) => {
    const profileId = arg<string>(args, "profileId")
    const relativePath = arg<string>(args, "relativePath")
    const content = arg<number[]>(args, "content")
    assertProfileId(profileId)
    const target = join(paths().profiles, profileId, ...splitNormalSegments(relativePath))
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(content))
    } catch (cause) {
      fromFsError(target, "写入文件失败", cause)
    }
  },

  /** profile_file_read(profile_id: String, relative_path: String) -> Vec<u8> */
  profile_file_read: (args) => {
    const profileId = arg<string>(args, "profileId")
    const relativePath = arg<string>(args, "relativePath")
    const target = join(paths().profiles, profileId, ...splitNormalSegments(relativePath))
    if (!existsSync(target)) {
      throw appError("PATH_NOT_FOUND", `文件不存在: ${profileId}/${relativePath}`)
    }
    try {
      return Array.from(readFileSync(target))
    } catch (cause) {
      fromFsError(target, "读取失败", cause)
    }
  },

  /** profile_asset_base(profile_id: String) -> String —— 无 profile.yaml 时返回空串 */
  profile_asset_base: (args) => {
    const profileId = arg<string>(args, "profileId")
    assertProfileId(profileId)
    const dir = join(paths().profiles, profileId)
    return existsSync(join(dir, "profile.yaml")) ? dir : ""
  },

  /** list_profiles() -> Vec<String> —— 只列目录，字节序升序 */
  list_profiles: () => {
    const root = paths().profiles
    if (!existsSync(root)) return []
    const names: string[] = []
    for (const dirent of readdirSync(root, { withFileTypes: true })) {
      if (dirent.isDirectory()) names.push(dirent.name)
    }
    return names.sort(compareBytes)
  },

  // ── 人格文件（personality_fs_cmd.rs）──

  /** personality_file_read(path: String) -> Vec<u8> */
  personality_file_read: (args) => {
    const relative = arg<string>(args, "path")
    const target = personalityPath(relative)
    if (!existsSync(target)) throw appError("PATH_NOT_FOUND", `文件不存在: ${relative}`)
    try {
      return Array.from(readFileSync(target))
    } catch (cause) {
      fromFsError(target, "读取失败", cause)
    }
  },

  /** personality_file_write(path: String, content: Vec<u8>) -> String（写入后的绝对路径） */
  personality_file_write: (args) => {
    const relative = arg<string>(args, "path")
    const content = arg<number[]>(args, "content")
    const target = personalityPath(relative)
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(content))
    } catch (cause) {
      fromFsError(target, "写入文件失败", cause)
    }
    return target
  },

  /** personality_file_list(dir_path: String) -> Vec<String> —— 目录不存在返回空数组 */
  personality_file_list: (args) => {
    const relative = arg<string>(args, "dirPath")
    const dir = personalityPath(relative)
    if (!existsSync(dir)) return []
    if (!statSync(dir).isDirectory()) throw appError("OTHER", `不是目录: ${relative}`)
    return readdirSync(dir).sort(compareBytes)
  },

  /** session_fs.rs: Node 只等价读文件，Rust 路径与有界读取由 Rust/L4 验证。 */
  session_read_text: (args) => {
    const relative = arg<string>(args, "path")
    const content = readFileSync(join(paths().sessions, relative), "utf8")
    const maxLines = args.maxLines as number | undefined
    return maxLines === undefined ? content : content.split(/(?<=\n)/).slice(0, maxLines).join("")
  },

  // ── 记忆与日志（memory_cmd.rs / logging.rs）──

  /** init_memory_files() -> String（memory 目录绝对路径） */
  init_memory_files: () => {
    const p = paths()
    mkdirSync(p.sessions, { recursive: true })
    mkdirSync(p.memory, { recursive: true })
    // CANDY 是人工指令的文件入口，保持 Node/L4 初始化的唯一共享文件。
    const candy = join(p.memory, "CANDY.md")
    if (!existsSync(candy)) writeFileSync(candy, "# CANDY.md — 用户系统指令\n\n## 指令\n", "utf8")
    // 开发构建才写 .gitkeep（L4 跑的是 dev 构建，这里同口径）。
    const gitkeep = join(p.sessions, ".gitkeep")
    if (!existsSync(gitkeep)) writeFileSync(gitkeep, "")
    return p.memory
  },

  /** log_messages(msgs: Vec<String>) -> () —— 前端已按生效级别过滤，这里原样落盘 */
  log_messages: (args) => {
    const msgs = arg<string[]>(args, "msgs")
    for (const msg of msgs) appendLogLine(msg)
  },

  /** set_log_config(level: u8) -> () */
  set_log_config: (args) => {
    nodeLogLevel = Math.min(arg<number>(args, "level"), LOG_LEVEL_NAMES.length - 1)
  },

  /** report_frontend_error(source: String, message: String, stack: String) -> () */
  report_frontend_error: (args) => {
    const source = arg<string>(args, "source")
    const message = arg<string>(args, "message")
    const stack = arg<string>(args, "stack")
    appendLogLine(
      `[${localHms()}] ${LOG_LEVEL_NAMES[3]} [Rust] [前端异常][${source}] ${message}\n${stack}`,
    )
  },
}

/** 与 Rust `validate_profile_id` 同口径：非空且只含 [A-Za-z0-9_-]。 */
function assertProfileId(profileId: string): void {
  if (profileId === "" || !/^[A-Za-z0-9_-]+$/.test(profileId)) throw pathEscape()
}

// ── 出口 ──

const rustOnly = new Set<string>(RUST_ONLY_COMMANDS)

/**
 * 与 `@tauri-apps/api/core` 同签名：`invoke<T>(cmd, args?) => Promise<T>`。
 *
 * 三个分支都是显式的：Rust 专用命令抛 UnsupportedInNodeError；未登记命令同样抛错
 * （**绝不返回 null 冒充成功**）；已登记命令返回真实结果。唯一会让 JS 看到 `null` 的地方
 * 是 `()` 返回类型的归一 —— Tauri 把 Rust 的 unit 序列化成 null，那是协议事实，
 * 不是「不知道就返回空」的兜底。
 */
export async function invoke<T>(cmd: string, args: Args = {}): Promise<T> {
  if (rustOnly.has(cmd)) throw new UnsupportedInNodeError(cmd)
  const handler = handlers[cmd]
  if (!handler) throw new UnsupportedInNodeError(cmd)
  const result = await handler(args)
  return (result === undefined ? null : result) as T
}

/**
 * 与 `@tauri-apps/api/core` 的 `convertFileSrc` 同实现（tauri-2.11.2 scripts/core.js）：
 * macOS / Linux 是 `${protocol}://localhost/<encodeURIComponent(path)>`，
 * Windows / Android 是 `http://${protocol}.localhost/...`。只做 URL 拼装，不校验路径。
 */
export function convertFileSrc(filePath: string, protocol = "asset"): string {
  const encoded = encodeURIComponent(filePath)
  return process.platform === "win32"
    ? `http://${protocol}.localhost/${encoded}`
    : `${protocol}://localhost/${encoded}`
}
