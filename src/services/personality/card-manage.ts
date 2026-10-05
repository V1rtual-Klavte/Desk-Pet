// ==========================================
// Card 管理 — 新建 / 重命名 / 编辑保存 / 删除 / 导出 / 导入
//
// 与 Profile 管理（services/profile/io.ts）同构：所有操作返回统一的
// CardOpResult，由调用方（原生设置页）决定怎么提示，服务层不弹窗。
// 文件落盘一律经宿主桥的 personality 域命令（域内相对路径由 Rust AppPaths
// 解析），本模块不碰文件系统、不拼数据根。
// ==========================================

import type { PersonalityCard } from "./types"
import { getCard, importUserCard, initCards, safeCardFileName, saveUserCard } from "./loader"
import { getActiveCard, getActivePersonalityId } from "./registry"
import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { errorCode, formatError } from "@/services/error"

const log = createLogger("Persona")

/** 管理操作统一结果：ok=false 时 message 是给用户看的中文原因 */
export interface CardOpResult { ok: boolean; message: string; newId?: string }

function ok(message: string, newId?: string): CardOpResult {
  // 不写 `newId: undefined`：让「没有新 id」的返回体保持无该字段，调用方用 in/判空区分
  return newId === undefined ? { ok: true, message } : { ok: true, message, newId }
}
function fail(message: string): CardOpResult { return { ok: false, message } }

// ── 内部工具 ──

/** 由显示名推导新 id：清洗走 loader 的同一条命名规则；清洗后为空回落 `card`。 */
function deriveCardId(displayName: string, existingIds: string[]): string {
  const base = safeCardFileName(displayName).replace(/^_+|_+$/g, "") || "card"
  const taken = new Set(existingIds)
  if (!taken.has(base)) return base
  // 撞名加序号后缀而不是覆盖：已有卡的文件与内存注册表都不能被动到
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * 只在 frontmatter 块内替换某个键的值，正文（含正文里以同名键开头的行）一字不动。
 * 返回 null 表示文本没有 frontmatter 块或没有该键行 —— 调用方如实失败，
 * 不在正文里瞎找同名行顶替。
 */
function replaceFrontmatterKey(raw: string, key: "id" | "name", value: string): string | null {
  const head = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!head) return null
  const block = head[0]!
  const line = new RegExp(`^(${key}:)[ \\t]*.*$`, "m")
  if (!line.test(block)) return null
  // 用函数形式替换：显示名里的 `$&` / `$'` 一类序列不能被当成替换模式展开
  const next = block.replace(line, (_match, prefix: string) => `${prefix} ${value}`)
  return next + raw.slice(block.length)
}

/**
 * 调用 `personality_file_delete` 删除 personality 域内文件。
 *
 * 该命令（args: `{ path: 域内相对路径 }`，result: void）由并行的宿主改动落地，
 * 尚未收录进 HostCommandMap；这里按已冻结的命令形状直接调用。收录之后本函数
 * 可退化为普通 `request("personality_file_delete", …)`，调用方无感。
 */
async function deletePersonalityFile(path: string): Promise<void> {
  const request = getHostBridge().request as unknown as (
    method: "personality_file_delete",
    args: { path: string },
  ) => Promise<void>
  await request("personality_file_delete", { path })
}

/** 显示名的公共校验：空白与换行都会破坏 frontmatter，就地拒绝 */
function invalidNameMessage(name: string): string | null {
  if (!name) return "Card 名字不能为空"
  if (/[\r\n]/.test(name)) return "Card 名字不能包含换行"
  return null
}

// ── 新建与模板 ──

/**
 * 读取新建 Card 的模板全文（运行时 `cards/_template.md`）。
 * 读不到如实抛错（错误文案带上找回入口）—— 新建与「恢复模板」两个入口共用这一份，
 * 不做硬编码兜底骨架。
 */
export async function readCardTemplate(): Promise<string> {
  try {
    const bytes = await getHostBridge().request("personality_file_read", { path: "cards/_template.md" })
    return new TextDecoder().decode(bytes)
  } catch (e) {
    log.error("读不到 Card 模板 cards/_template.md", formatError(e))
    throw new Error(`读不到新建 Card 的模板：${formatError(e)}；可用设置页的「恢复默认资源」找回模板后重试`)
  }
}

/**
 * 新建 Card：骨架取运行时 `cards/_template.md`（用户在设置页可编辑的同一份），
 * 不内置硬编码骨架 —— 读不到模板就如实失败并提示用「恢复默认资源」找回。
 *
 * id 由显示名推导（与 loader 落盘命名同款清洗），撞名加 `-2`、`-3`… 避让；
 * 除 frontmatter 的 id/name 两行外，模板正文原样保留。
 */
export async function createCard(displayName: string, existingIds: string[]): Promise<CardOpResult> {
  const name = displayName.trim()
  const invalid = invalidNameMessage(name)
  if (invalid) return fail(invalid)

  let template: string
  try {
    template = await readCardTemplate()
  } catch (e) {
    // readCardTemplate 已留 error 级证据并带上用户可执行的找回入口，这里只转成结果
    return fail(formatError(e))
  }

  const newId = deriveCardId(name, existingIds)
  const withId = replaceFrontmatterKey(template, "id", newId)
  const raw = withId ? replaceFrontmatterKey(withId, "name", name) : null
  if (!raw) {
    log.error("新建 Card 失败：模板缺少 frontmatter id/name 行")
    return fail("新建 Card 的模板缺少 frontmatter（id/name），无法写入；可用「恢复默认资源」找回模板")
  }

  try {
    await saveUserCard(raw)
  } catch (e) {
    log.error("新建 Card 落盘失败:", newId, formatError(e))
    return fail(`新建 Card 失败：${formatError(e)}`)
  }
  await initCards()
  log.info(`已新建 Card: ${newId}（${name}）`)
  return ok(`已新建「${name}」`, newId)
}

// ── 重命名 ──

/**
 * 改 Card 的显示名：只替换 frontmatter 的 `name` 行。
 * id、文件名、stages、变量一律不动（产品拍板口径：改名不换身份，
 * 因此已有的阶段文案与变量状态全部保留）。落盘仍用**原有**文件名
 * `cards/{safeName(cardId)}.md`，不走「按新名字拼文件名」。
 */
export async function renameCard(cardId: string, displayName: string): Promise<CardOpResult> {
  const name = displayName.trim()
  const invalid = invalidNameMessage(name)
  if (invalid) return fail(invalid)

  const card = getCard(cardId)
  if (!card) return fail(`Card 不存在：${cardId}`)

  const raw = replaceFrontmatterKey(card.rawContent, "name", name)
  if (!raw) return fail(`Card 缺少 frontmatter name 行，无法重命名：${cardId}`)

  try {
    await getHostBridge().request("personality_file_write", {
      path: `cards/${safeCardFileName(cardId)}.md`,
      content: new TextEncoder().encode(raw),
    })
  } catch (e) {
    log.error("重命名 Card 落盘失败:", cardId, formatError(e))
    return fail(`重命名失败：${formatError(e)}`)
  }
  await initCards()
  log.info(`已重命名 Card: ${cardId} → ${name}`)
  return ok(`已重命名为「${name}」`)
}

// ── 编辑保存 ──

/**
 * 保存 Card 本体 markdown（设置页「编辑当前 Card」的写入口）。
 *
 * 校验先行、落盘在后：解析不出有效 id 的内容绝不写入（不写坏磁盘上的卡）；
 * 解析出的 id 必须与目标卡一致 —— id 就是文件名，改 id 等于换了一张卡，
 * 阶段文案与变量状态会按 id 全部错位，因此拒绝并说明原因。
 * `cardId` 为 null 表示当前激活卡。
 */
export async function saveCardText(cardId: string | null, text: string): Promise<CardOpResult> {
  const target = cardId === null ? getActiveCard() : getCard(cardId) ?? null
  if (!target) {
    return fail(cardId === null ? "当前没有激活的 Card，无法保存" : `Card 不存在：${cardId}`)
  }

  let parsed: PersonalityCard
  try {
    parsed = await importUserCard(text)
  } catch (e) {
    log.error("保存 Card 失败：内容解析异常:", target.id, formatError(e))
    return fail(`保存失败：${formatError(e)}`)
  }

  const parsedId = parsed.id.trim()
  if (!parsedId || parsedId === "unknown") {
    return fail("保存失败：内容缺少有效 id，未写入磁盘（id 是 Card 的身份与文件名）")
  }
  if (parsed.id !== target.id) {
    return fail(
      `保存失败：不能把 Card 的 id 从「${target.id}」改成「${parsedId}」——` +
      "id 是文件名，改了等于换卡，阶段文案与变量状态会全部错位。如需换 id，请新建一张 Card",
    )
  }

  try {
    await getHostBridge().request("personality_file_write", {
      path: `cards/${safeCardFileName(target.id)}.md`,
      content: new TextEncoder().encode(text),
    })
  } catch (e) {
    log.error("保存 Card 失败：落盘异常:", target.id, formatError(e))
    return fail(`保存失败：${formatError(e)}`)
  }
  await initCards()
  log.info(`已保存 Card: ${target.id}`)
  // 运行中的回合已冻结当轮 Card，改动从下一轮装配起生效；文案中性，不假装即时重载
  return ok("已保存（下一个回合生效）")
}

// ── 删除 ──

/**
 * 删除 Card：卡文件与 stages 文件两份一起删。
 *
 * 激活卡拒删 —— 注册表要求始终有一张可用卡，删掉正在使用的那张会让
 * activeId 悬空，用户须先切走。stages 文件不存在（从未激活过的卡没有它）
 * 等同于已清理，不算失败；其余任何失败如实返回，不把「没删干净」报成成功。
 * 先删 stages 再删卡文件：stages 可再生成，这个顺序下最坏残留是
 * 「卡还在但文案缓存没了」，不会出现「卡没了却报失败」的不可逆中间态。
 */
export async function deleteCard(cardId: string): Promise<CardOpResult> {
  const label = getCard(cardId)?.name || cardId

  if (getActivePersonalityId() === cardId) {
    return fail(`「${label}」是当前正在使用的 Card，请先切换到别的 Card 再删除`)
  }

  try {
    await deletePersonalityFile(`stages/${cardId}.json`)
  } catch (e) {
    if (errorCode(e) !== "PATH_NOT_FOUND") {
      log.error("删除 Card 的 stages 文件失败:", cardId, formatError(e))
      return fail(`删除阶段文案文件失败：${formatError(e)}`)
    }
    log.debug("stages 文件不存在，视为已清理:", cardId)
  }

  try {
    await deletePersonalityFile(`cards/${safeCardFileName(cardId)}.md`)
  } catch (e) {
    log.error("删除 Card 文件失败:", cardId, formatError(e))
    return fail(`删除 Card 文件失败：${formatError(e)}`)
  }

  await initCards()
  log.info(`已删除 Card: ${cardId}`)
  return ok(`已删除「${label}」`)
}

// ── 导出 ──

/** 返回 Card 的 markdown 原文（导出用；落盘到用户选的位置由 UI 层负责）。
 *  未注册的 id 返回 null，不抛错 —— 「卡不存在」是调用方要处理的正常分支。 */
export async function exportCardText(cardId: string): Promise<string | null> {
  const card = getCard(cardId)
  return card ? card.rawContent : null
}

// ── 导入 ──

/**
 * 导入 Card：先经 `importUserCard` 纯解析，解析不出有效 id（空串 / `unknown`）
 * 就拒绝；合法则按 saveUserCard 的口径写入 `cards/{safeName(id)}.md`
 * （同名覆盖允许 —— 导入的语义就是「以这份内容为准」）。回执里说清是
 * 覆盖还是新增，UI 不需要自己比对。
 */
export async function importCardText(raw: string, existingIds: string[]): Promise<CardOpResult> {
  let card: PersonalityCard
  try {
    card = await importUserCard(raw)
  } catch (e) {
    log.error("导入 Card 解析失败:", formatError(e))
    return fail(`导入失败：${formatError(e)}`)
  }

  const id = card.id.trim()
  if (!id || id === "unknown") {
    return fail("导入内容不是有效的 Card：frontmatter 缺少 id")
  }

  const existed = existingIds.includes(card.id)
  try {
    await saveUserCard(raw)
  } catch (e) {
    log.error("导入 Card 落盘失败:", id, formatError(e))
    return fail(`导入失败：${formatError(e)}`)
  }
  await initCards()

  const label = card.name || id
  log.info(`已导入 Card: ${id}${existed ? "（覆盖同名）" : ""}`)
  return ok(existed ? `已导入「${label}」，覆盖了同名 Card` : `已导入「${label}」`, id)
}
