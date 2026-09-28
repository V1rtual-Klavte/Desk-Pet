// ==========================================
// Skill 的落盘与披露
//
// 清单状态（`Skill[]` / 指纹 / 告警 / 每技能开关）在 store.ts，那是唯一所有者；
// 本模块只做两件事：技能文件的写入口（上传 / 删除 / 每技能开关），以及 system prompt 披露块。
// 合法性判定与清单来源都是 Pi 的 `loadSkills`（经 store 的指纹核对入口）。
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import {
  BACKGROUND_CONTEXT,
  formatSkillsForSystemPrompt,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-agent-core"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import { runtimePath } from "@/services/paths"
import { createLogger } from "@/services/logger"
import {
  SKILL_FILE,
  SKILLS_DIR,
  applyEnabledFlag,
  listEnabledSkills,
  listSkills,
  readFrontmatterField,
  syncSkillCatalog,
  type ManagedSkill,
} from "./store"

const log = createLogger("Skill")
const MAX_SKILL_BYTES = 512 * 1024
const MAX_PROMPT_CHARS = 8 * 1024

/**
 * 上传一份 SKILL.md 全文。
 *
 * 校验的真相源是 Pi loader，且**先校验后落盘**：不合法的上传不写进技能目录。
 * 先写再回滚会把用户已有的同名技能一起删掉（回滚删的是整个技能目录），所以校验必须发生在
 * 目标文件被覆盖之前。
 * 返回 Pi 收录后的技能对象；被拒绝或写入后仍未收录时返回 null。
 */
export async function upsertSkill(raw: string): Promise<ManagedSkill | null> {
  if (new TextEncoder().encode(raw).byteLength > MAX_SKILL_BYTES) {
    log.warn(`Skill 写入被拒绝：超过 ${MAX_SKILL_BYTES} bytes`)
    return null
  }
  const name = declaredName(raw)
  if (!name) {
    // 落盘坐标需要 frontmatter `name`：Pi 的规则是「缺省取父目录名」，而上传对象还没有父目录。
    // 名字里的路径分隔符（`..`、`/`、`\`）会让写入逃出 skills 根，同样拒绝。
    log.warn("Skill 上传被拒绝：frontmatter name 缺失或不是单个路径段")
    return null
  }
  const rejection = await validateAsSkill(raw)
  if (rejection) {
    log.warn("Skill 上传未通过 Pi loader 校验，未写入:", name, rejection)
    return null
  }
  const filePath = await runtimePath("data", SKILLS_DIR, name, SKILL_FILE)
  // host 服务写入不纳入许可域（借用者身份是页面实例，host 没有该生命周期），
  // 但用原子替换写入消除半写窗口：读者要么看到旧正文，要么看到完整新正文。
  await invoke("file_write_atomic", { path: filePath, content: raw, maxBytes: MAX_SKILL_BYTES })
  await syncSkillCatalog()
  const saved = listSkills().find(skill => skill.relativePath === name)
  if (!saved) {
    // 校验通过、写入成功，Pi 却仍没收录（例如 skills 根的忽略文件排除了它）：
    // 如实报错，不猜原因，也不谎报保存成功。
    log.error("Skill 已写入但未被 Pi loader 收录:", filePath)
    return null
  }
  log.info("Skill 已保存:", saved.name)
  return saved
}

/**
 * 用 Pi 自己的 loader 校验全文：在系统临时目录里按真实布局放一份 `SKILL.md` 再加载。
 *
 * 校验在临时目录进行意味着「name 与父目录名一致」的告警必然出现，那是位置差异不是失败 ——
 * 只以「Pi 是否收录」为判据。临时目录用后即删，残留由系统临时目录回收。
 */
async function validateAsSkill(raw: string): Promise<string | null> {
  const env = new TauriExecutionEnv(await TauriExecutionEnv.defaultCwd())
  const dir = await env.createTempDir("deskpet-skill-", BACKGROUND_CONTEXT)
  if (!dir.ok) return `校验用临时目录创建失败: ${dir.error.message}`
  try {
    const file = await env.joinPath([dir.value, SKILL_FILE], BACKGROUND_CONTEXT)
    if (!file.ok) return `校验文件路径拼装失败: ${file.error.message}`
    const written = await env.writeFile(file.value, raw, BACKGROUND_CONTEXT)
    if (!written.ok) return `校验文件写入失败: ${written.error.message}`
    const loaded = await loadSkills(env, [dir.value], BACKGROUND_CONTEXT)
    if (loaded.skills.length) return null
    return loaded.diagnostics.find(diagnostic => diagnostic.path === file.value)?.message
      ?? "loader 没收录这份 SKILL.md（缺 description 或 frontmatter 无法解析）"
  } finally {
    const cleaned = await env.remove(dir.value, { recursive: true, force: true }, BACKGROUND_CONTEXT)
    if (!cleaned.ok) {
      log.debug("校验用临时目录清理失败（系统临时目录会自行回收）:", dir.value, cleaned.error.message)
    }
  }
}

/**
 * 删除一个 Skill 条目。
 *
 * 入参是**域内相对路径**（相对 skills 根：`foo`、`foo/bar`、`foo.md`），不是 frontmatter 的
 * `name` —— Pi loader 递归遍历、根级 `.md` 也算技能、`name` 可与目录名不一致甚至同名，
 * 按 `name` 索引会删错对象。坐标由 store 的 `relativePath` 给出。
 */
export async function deleteSkill(relativePath: string): Promise<void> {
  await invoke("skill_delete", { relativePath })
  await syncSkillCatalog()
  log.info("Skill 已删除:", relativePath)
}

/**
 * 每技能开关：读原文 → 只改 `enabled` 行 → 原子替换写回。
 *
 * 不能从 Pi 的 `Skill` 重建文件：它只有解析后的 `content` 与 `filePath`，没有原始 frontmatter
 * 文本，重建会丢掉未声明的字段与注释。写入后经指纹核对入口重载，开关立即生效。
 */
export async function setSkillEnabled(relativePath: string, enabled: boolean): Promise<boolean> {
  const filePath = await skillFilePath(relativePath)
  const result = await invoke<{ content: string }>("file_read", { path: filePath, maxBytes: MAX_SKILL_BYTES })
  const updated = applyEnabledFlag(result.content, enabled)
  if (updated === null) {
    log.warn("Skill 开关未写入：文件里没有可用的 frontmatter 块:", filePath)
    return false
  }
  await invoke("file_write_atomic", { path: filePath, content: updated, maxBytes: MAX_SKILL_BYTES })
  await syncSkillCatalog()
  log.info(`Skill 已${enabled ? "启用" : "关闭"}:`, relativePath)
  return true
}

/** 开关坐标优先取 Pi 的 `filePath`（真相源）；快照里还没有该条目时按域内相对路径形态回推。 */
async function skillFilePath(relativePath: string): Promise<string> {
  const known = listSkills().find(skill => skill.relativePath === relativePath)
  if (known) return known.filePath
  const segments = relativePath.split("/").filter(Boolean)
  const last = segments[segments.length - 1] ?? ""
  return last.endsWith(".md")
    ? runtimePath("data", SKILLS_DIR, ...segments)
    : runtimePath("data", SKILLS_DIR, ...segments, SKILL_FILE)
}

/** frontmatter `name`：单个路径段才可用于落盘；缺省不猜目录名（上传对象还没有目录）。 */
function declaredName(raw: string): string | null {
  const declared = readFrontmatterField(raw, "name")
  if (typeof declared !== "string") return null
  const name = declared.trim()
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return null
  return name
}

/**
 * 模型可见的技能清单：Pi 的 `formatSkillsForSystemPrompt` 输出（只含 name/description/location），
 * 外面套一层字符预算。
 *
 * 清单取自 store 的生效快照（`enabled` 过滤后、`disable-model-invocation` 由 Pi 自己排除），本函数
 * 不触发任何 I/O：调用方须在冻结 run snapshot 前先 `await syncSkillCatalog()`。
 */
export function getSkillsPromptBlock(options: { maxChars?: number } = {}): string {
  const skills = listEnabledSkills()
  if (!skills.length) return ""
  const limit = Math.min(Math.max(options.maxChars ?? MAX_PROMPT_CHARS, 0), MAX_PROMPT_CHARS)
  const block = formatSkillsForSystemPrompt(skills)
  if (block.length <= limit) return block
  // 超限时丢**整条**技能（不截断单条，否则模型拿到的是半条指令）。
  const kept = largestFittingPrefix(skills, limit)
  const dropped = skills.length - kept
  // 8KB 预算装得下约 48 条（Pi 五行格式每条固定 97 字符 + 自身的 name/description/location；
  // 条目越大装得越少）；以前超限静默丢弃，现在把「丢了几条」报出来。
  log.warn(
    `Skill 披露块超出 ${limit} 字符预算：保留 ${kept} 条、丢弃末尾 ${dropped} 条`,
    "（可在设置页关闭不常用的 Skill，或提高预算）",
  )
  return formatSkillsForSystemPrompt(skills.slice(0, kept))
}

/**
 * 能塞进预算的最长前缀。
 *
 * 二分而不是逐条试：块长度对条数单调不减（每条只追加自己的五行），而本函数在每次构建请求时都会
 * 被调用，线性重排会把超限场景变成 O(n²) 的字符串拼接。
 */
function largestFittingPrefix(skills: Skill[], limit: number): number {
  let low = 0
  let high = skills.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (formatSkillsForSystemPrompt(skills.slice(0, mid)).length <= limit) low = mid
    else high = mid - 1
  }
  return low
}
