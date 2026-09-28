import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import {
  L0_CLEARED_TAG, L0_NO_ADDRESS_NOTICE, L0_SHORTENED_TAG, LADDER_PROTECTION_TURNS, MIN_ADDRESS_PREFIX,
  annotateToolResultText, contextBudget, estimateContextTokens, estimateMessageTokens, estimateRequestTokens,
  isUniqueAddressRef, planToolResultLadder, projectToolResultText, protectedMessageIndexes,
  toolResultNotice, toolResultTokenBudget,
} from "@/services/context"
import type { ToolResultLadderEntry, ToolResultLadderPlan, ToolResultLevelMeasure } from "@/services/context"
import { aiConfig, loopConfig } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import {
  SESSION_TRANSCRIPT_TOOL, TOOL_POLICY_VERSION, defineTool, listAll, preservedToolNames, register, unregister,
} from "@/services/tool"
import type { ToolDef, ToolHandler } from "@/services/tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { compactionEntries, sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：工具结果阶梯在主请求视图里的「形态」 ──
//
// 阶梯按**激进度**排、不按成本排：级 0 不动 → 级 1 缩短 → 级 2 清空 → 级 3 摘要。
// 顺序的理由是每升一级的信息损失都更大（级 1 保住头尾与回读地址、级 2 正文只剩占位串、
// 级 3 才真的花一次 LLM 摘要），所以规划器只在「上一级压完仍超目标」时才升档；
// 「装得下」的唯一判据是请求视图估算 ≤ `contextBudget(window).normalInputTarget`，
// 单条上限唯一取 `toolResultTokenBudget(window)`（级 1/级 2 共用同一份候选集）。
//
// **级 2（清空）的硬前提是有地址**（源方案 §3.2）：正文被换成占位串后，回读地址是模型回到
// 原文的唯一通道；无地址的结果被清空即不可恢复，因此投影永远把它停在级 1 ——
// `projectToolResultText(raw, undefined, window, TOOL, 2)` 与级 1 的输出**逐字相等**，
// 本场景直接断言这条等式（不是「断言它没有出现」——那种写法认不出防御性降级）。
//
// 本场景证的是**投影形态**：同一个请求视图里每条结果落在哪一档、正文与地址行长什么样。
// 「级 1/2 压完装得下就不花摘要调用」那道级 3 闸门由 `memory-ladder-gate`（阶梯闸门）证；
// 两者共用同一份判定与同一份投影，但断言面不同，不能互相顶替。
//
// 保护区（W3-D1 口径 B）：最近 `LADDER_PROTECTION_TURNS` 轮只挡级 2/级 3，不挡级 1。
// 本场景在第 4 轮的同一个视图里同时摆出「保护区外 + 有地址 ⇒ 被清空」与
// 「保护区内 + 有地址 ⇒ 只缩短」，两者的唯一变量就是保护区。
//
// 载荷口径（**运行期口径**，与 `runtime.ts` 的投影 hook 同一份）：
// - 窗口取 `min(配置窗口, 注入模型窗口)`；判据取 `contextBudget(WINDOW)`，**不传 `maxOutput`**
//   （`contextBudget(w, 16384)` 那套在运行路径不可达）；单条上限取 `toolResultTokenBudget`。
// - 探针正文按单条上限的 1.1 倍造（超阈即候选），单块保持在上游 50KB 内联上限以下 ——
//   存档条目必须是全文，不能是「被内联规则换掉的指针」。
// - 级 2 只在「级 1 之后的合计 > target」时出现，而保护区让级 2 清不动保护区内的一条 ——
//   所以**越线必须发生在第 4 轮**：第 3 轮结束前按**实测请求视图**把「校准载荷」补到
//   `target + MARGIN`（越线量必须小于「清空保护区外那几条能腾出的量」，否则级 2 之后仍超
//   target、闸门会接管，那条不等式由断言 `tokensAfterLevel2 <= target` 当场把关）。
//   校准载荷按块加载（单块 ≤ 上游 50KB 内联上限），块数受单轮工具调用上限约束 ——
//   超出即报「载荷不足/无法越线」，不静默判过。
// - 校准的判据是**重放**：用导入的 `estimateRequestTokens` + `projectToolResultText`
//   在观测到的请求视图上重建 `planToolResultLadder` 的输入，直接读它的两次读数与 levels，
//   而不是拿估算常数去近似（原方案的「用单条上限夹住每条」只是这套重放的近似写法）。
//   **重建的正文取存档原文**：观测面本身已经是投影后的形态（第 4 轮那笔请求里三条地址探针
//   已被级 2 清空、其余也各自落档），拿它当输入等于「对投影结果再投影一次」——清空形态再走
//   级 1 只会得到「清空 + 地址尾行」（约 62 token），再也回不到全量，级 1 读数因此被系统性
//   低估（128k 口径下三条探针差 ≈31k，见 `replayPlan` 的 measure）。
//
// 探针（真注册、真执行、真过权限链路，唯一变量是投影声明、地址有无与所在轮次）：
// - `ladder_address_probe` ×3（第 1 轮，`reference`，成功 ⇒ 有地址）：第 4 轮在保护区外 ⇒ 级 2；
// - `ladder_error_probe`（第 1 轮，`reference`，抛错 ⇒ 无地址）：同级 1，永不进级 2（C-2）；
// - `ladder_preserve_probe`（第 1 轮，`preserve`）：不缩短、不清空、但同样带地址（D-W2-5）；
// - `ladder_protected_probe`（第 3 轮，`reference`，有地址）：第 4 轮仍在保护区 ⇒ 只缩短；
// - `ladder_short_probe`（第 3 轮，`reference`，短结果）：未超阈 ⇒ 级 0 不动；
// - `ladder_load_probe`（第 4 轮，`preserve`，尺寸由第 3 轮的实测读数决定）：只提供越线载荷。
//
// 每轮的工具调用都在 `loopConfig.maxToolCallsPerTurn` 之内（第 1 轮 5 次、第 3 轮 2 次、
// 第 4 轮按校准块数，超出即报「载荷不足」而不是静默判过）。
const ADDRESS_TOOL_ID = "ladder-address-probe"
const ADDRESS_TOOL_NAME = "ladder_address_probe"
const ERROR_TOOL_ID = "ladder-error-probe"
const ERROR_TOOL_NAME = "ladder_error_probe"
const PRESERVE_TOOL_ID = "ladder-preserve-probe"
const PRESERVE_TOOL_NAME = "ladder_preserve_probe"
const PROTECTED_TOOL_ID = "ladder-protected-probe"
const PROTECTED_TOOL_NAME = "ladder_protected_probe"
const SHORT_TOOL_ID = "ladder-short-probe"
const SHORT_TOOL_NAME = "ladder_short_probe"
const LOAD_TOOL_ID = "ladder-load-probe"
const LOAD_TOOL_NAME = "ladder_load_probe"
/** 三个地址探针的调用标号：同一条工具三次调用，各自的结果带自己的中部标记。 */
const ADDRESS_CALL_TAGS = ["1", "2", "3"] as const
const ADDRESS_CORE = "-address-core-marker-"
const ERROR_CORE = "-error-core-marker-"
const PRESERVE_CORE = "-preserve-core-marker-"
const PROTECTED_CORE = "-protected-core-marker-"
const SHORT_CORE = "-short-core-marker-"
/** 校准载荷的前缀：纯 ASCII，只用来在请求正文里认出这块载荷。 */
const LOAD_PREFIX = "[ladder-load]"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
/** 运行期预算口径：不传 maxOutput（与投影 hook 的 target / 硬预算判定同一份）。 */
const BUDGET = contextBudget(WINDOW_TOKENS)
const TARGET_TOKENS = BUDGET.normalInputTarget
const SINGLE_ENTRY_TOKENS = toolResultTokenBudget(WINDOW_TOKENS)
/**
 * 第 4 轮的越线量（校准目标 = `target + MARGIN`）：取自预算自己的压缩余量的一半，
 * 不写死数字。量级理由：级 2 能腾出的是「保护区外每条候选的级 1 形态」≈ 若干倍单条上限
 * （`L0_TOOL_RESULT_SHARE = 10%` 的 target），远大于这个余量；而余量本身又足以吸收
 * 估算漂移与系统提示词的分钟级变化。两条边都由第 4 轮的断言当场把关。
 */
const MARGIN_TOKENS = Math.ceil(BUDGET.compactionHeadroom / 2)
/**
 * 校准载荷的单块字符上限：上游内联上限 50KB（`地址完整性` 场景同一条口径），
 * 单块留出余量；ASCII 4 字符 ≈ 1 token。
 */
const LOAD_CHUNK_CHARS = 48_000

/** 探针载荷 token 目标：1.1 倍单条上限（超阈即候选），字符数按 ASCII 4 字符 1 token 反推。 */
const PROBE_TOKENS = Math.ceil(SINGLE_ENTRY_TOKENS * 1.1)
const PROBE_SIDE_CHARS = Math.ceil(PROBE_TOKENS * 4 / 2)
/** 短结果单段长度：约 200 字符，远低于单条上限（万级 token），走未缩短形态（级 0）。 */
const SHORT_SIDE_CHARS = 90

/** 三段式探针正文：前后两段等长填充 + 中部标记（标记只在未缩短/未清空的形态里看得见）。 */
function probeBody(fill: string, marker: string, tail: string): string {
  return fill.repeat(PROBE_SIDE_CHARS) + marker + tail.repeat(PROBE_SIDE_CHARS)
}
const addressResultFor = (tag: string): string => probeBody("a", `${ADDRESS_CORE}${tag}-`, "b")
const ERROR_TEXT = probeBody("e", ERROR_CORE, "f")
const PRESERVE_RESULT = probeBody("p", PRESERVE_CORE, "q")
const PROTECTED_RESULT = probeBody("g", PROTECTED_CORE, "h")
const SHORT_RESULT = "s".repeat(SHORT_SIDE_CHARS) + SHORT_CORE + "t".repeat(SHORT_SIDE_CHARS)

const ROUND1_TEXT = "第一轮：依次调用三个阶梯地址探针、一个错误探针与一个 preserve 探针，再回复我。"
const ROUND1_REPLY_TEXT = "第一轮回复完成。"
const ROUND2_TEXT = "第二轮：只回复一句，不要调用工具。"
const ROUND2_REPLY_TEXT = "第二轮回复完成。"
const ROUND3_TEXT = "第三轮：先调用受保护地址探针与短结果探针，再回复我。"
const ROUND3_REPLY_TEXT = "第三轮回复完成。"
const ROUND4_TEXT = "第四轮：调用校准载荷探针，再回复我。"
const ROUND4_REPLY_TEXT = "第四轮回复完成。"

// ── 请求观测与校准状态 ──

/** 一笔真实请求的观测面：阶梯的 target / 保护区 / 投影形态都在这份视图上复算。 */
interface RecordedRequest {
  systemPrompt: string
  messages: Context["messages"]
  tools: Context["tools"] | undefined
}
const requests: RecordedRequest[] = []
/** 第 4 轮的校准载荷块（按调用顺序出队）；尺寸在场景准备阶段由实测读数决定。 */
let loadChunks: string[] = []
/**
 * 校准载荷的快照：`loadChunks` 会被校准探针的 handler 逐次 `shift()` 抽空（出队即消费），
 * 断言期只能靠这份副本回答「校准了几块、每块是什么」—— 拿 `loadChunks.length` 当块数会恒为 0，
 * 让「载荷一块都没进请求」也判过（空数组的 `.every()` 恒真）。
 */
let calibratedChunks: readonly string[] = []
let calibratedFrame = 0
let calibratedNeeded = 0

/** 断言失败时带上真实口径，别让人从「形态对不上」反推载荷问题。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、目标 ${TARGET_TOKENS}、硬上限 ${BUDGET.hardInputLimit}、单条上限 ${SINGLE_ENTRY_TOKENS}`
    + `、保护区 ${LADDER_PROTECTION_TURNS} 轮；探针 ${PROBE_SIDE_CHARS}×2 字符、短结果 ${SHORT_RESULT.length} 字符`
    + `；第 3 轮实测视图 ${calibratedFrame}、校准载荷 ${calibratedNeeded} tokens / ${calibratedChunks.length} 块`
    + `、越线量 ±${MARGIN_TOKENS}`
}

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return textOfContent(last?.content)
}

/** 请求观测：记录状态后按脚本作答；`expect` 用于就地把「脚本错位」暴露成场景失败。 */
function step(inner: FauxResponseStep, expect?: (context: Context) => void): FauxResponseStep {
  return (context, options, state, model) => {
    expect?.(context)
    requests.push({ systemPrompt: context.systemPrompt ?? "", messages: context.messages, tools: context.tools })
    return typeof inner === "function" ? inner(context, options, state, model) : inner
  }
}

/** 回合判别器：脚本错位时立即报错，而不是让后面的断言去猜哪一轮被吃掉了。 */
function expectRoundText(marker: string): (context: Context) => void {
  return context => {
    const texts = context.messages.map(message => textOfContent(message.content))
    if (!texts.some(text => text.includes(marker))) {
      throw new Error(`脚本错位：这笔请求里没有「${marker}」｜${sizing()}`)
    }
  }
}

/** 请求正文里的消息文本（字符串或块数组两种形态）。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => {
    const block = part as { type?: unknown; text?: unknown } | null
    return block?.type === "text" && typeof block.text === "string" ? block.text : ""
  }).filter(Boolean).join("\n")
}

/** 逐 text 块复算投影（`applyLevels` 的同形实现）：字符串正文直接投影，其它块原样留在原位。 */
function projectTextBlocks(content: unknown, project: (text: string) => string): unknown {
  if (typeof content === "string") return project(content)
  if (!Array.isArray(content)) return content
  return content.map(part => {
    const block = part as { type?: unknown; text?: unknown } | null
    return block?.type === "text" && typeof block.text === "string" ? { ...block, text: project(block.text) } : part
  })
}

/** 工具结果条目（存档侧）：正文与 details 一起取，回读地址从 details 里读。 */
interface StoredResult { id: string; toolName: string; text: string; address?: string }
async function resultEntries(): Promise<StoredResult[]> {
  const entries = await sessionEntries(getActiveSessionId())
  return entries.flatMap(entry => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") return []
    const address = entryAddress(entry.message.details)
    return [{
      id: entry.id,
      toolName: entry.message.toolName ?? "",
      text: textOfContent(entry.message.content),
      ...(address === undefined ? {} : { address }),
    }]
  })
}

/** 条目里的回读地址（宿主写入的 details.deskpetEntryId）；没有就是 undefined。 */
function entryAddress(details: unknown): string | undefined {
  const fields = (details && typeof details === "object" ? details : {}) as Record<string, unknown>
  return typeof fields.deskpetEntryId === "string" ? fields.deskpetEntryId : undefined
}

/**
 * 地址通知模板的两端：模板本身由唯一实现（`toolResultNotice`）给出，场景不复制这类字面量 ——
 * 未处理形态是 `[回读地址 eventId=<前缀>，可用 read_session_event 分页读取]`，缩短形态是
 * `[上下文缩短；原结果 eventId=<前缀>，…]`，清空形态是 `[上下文清空；原结果 eventId=<前缀>，…]`。
 * 传入受理下界长度的占位地址后，它的左右两侧就是「地址值的边界」：模板一改，
 * 从它推导的边界跟着改，断言不会因为「抄的模板过期」而假绿。
 */
function noticeBounds(disposition?: "shortened" | "cleared"): { head: string; tail: string } {
  const probeRef = "0".repeat(MIN_ADDRESS_PREFIX)
  const notice = toolResultNotice(probeRef, SESSION_TRANSCRIPT_TOOL, disposition)
  const at = notice.indexOf(probeRef)
  if (at < 0) throw new Error(`地址通知模板不再回显传入的地址：${notice}（场景自身的断言前提被破坏）`)
  return { head: notice.slice(0, at), tail: notice.slice(at + probeRef.length) }
}

/** 从若干段投影正文里抽出该形态的全部回读地址（模板对不上就是空数组）。 */
function addressesIn(texts: readonly string[], disposition?: "shortened" | "cleared"): string[] {
  const { head, tail } = noticeBounds(disposition)
  const found: string[] = []
  for (const text of texts) {
    let from = 0
    for (;;) {
      const start = text.indexOf(head, from)
      if (start < 0) break
      const rest = text.slice(start + head.length)
      const end = rest.indexOf(tail)
      if (end < 0) break
      found.push(rest.slice(0, end))
      from = start + head.length
    }
  }
  return found
}

/** 视图正文里的回读地址（三种形态的模板都取自唯一实现）；没有就是 undefined。 */
function referenceIn(text: string): string | undefined {
  for (const disposition of [undefined, "shortened", "cleared"] as const) {
    const [found] = addressesIn([text], disposition)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 该视图正文是这条存档结果的哪一档形态：0 = 未处理（`preserve` / 未超阈），1 = 缩短，2 = 清空。
 * 逐字比对由**投影的唯一实现**产出，场景只从正文里抽回读地址（形态里的地址是当次发出的前缀，
 * 不是存档里的完整条目 id）。无地址的条目在级 1 与级 2 下同形（硬前提），因此返回 1 而不报歧义。
 *
 * **只比形态不构成身份**：判据里的地址取自候选正文，所以正文相同或「裁掉的部分不同、剩下的
 * 部分相同」的兄弟条目会互相满足（清空形态更是与正文无关）。跨条目身份由 `addressBelongsTo`
 * 单独判，两个判据都成立才算一条视图正文属于这条存档结果。
 */
function projectionLevelOf(entry: StoredResult, viewText: string): 0 | 1 | 2 | undefined {
  const address = referenceIn(viewText)
  const annotated = annotateToolResultText(entry.text, address, SESSION_TRANSCRIPT_TOOL)
  if (viewText === annotated) return 0
  for (const level of [1, 2] as const) {
    if (viewText === projectToolResultText(entry.text, address, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL, level)) return level
  }
  return undefined
}

/**
 * 该视图正文里的回读地址是否**属于这条存档结果**：是它的条目 id 前缀，且在当次 id 全集里唯一
 * 命中（`isUniqueAddressRef`）；无地址的条目（错误分支）只认「这段正文里也没有地址行」。
 *
 * 为什么识别必须带这一步：三条地址探针是同一工具的兄弟调用，正文只在中段的调用标记上不同，
 * 而级 1 恰好把中段裁掉 —— 只比形态时，`projectionLevelOf` 会用**候选正文里的地址**重建期望值
 * （地址取自正文是必须的：运行期发的是前缀），于是任一兄弟的形态都能被另一条的正文满足；
 * 级 2 更彻底（清空形态与正文无关，任何带地址的条目都会被三条清空正文同时满足）。
 * 跨条目身份的唯一凭据就是地址行，识别必须把它算进去。
 */
function addressBelongsTo(entry: StoredResult, viewText: string, ids: readonly string[]): boolean {
  const ref = referenceIn(viewText)
  if (ref === undefined) return entry.address === undefined
  return isUniqueAddressRef(ref, entry.id, ids)
}

/** 该条在这一笔请求视图里的正文：形态由投影的唯一实现逐字判定、身份由地址行判定，命中数必须恰好 1。 */
function viewTextFor(request: RecordedRequest, entry: StoredResult, ids: readonly string[]): string {
  const matched = request.messages
    .filter(message => message.role === "toolResult")
    .map(message => textOfContent(message.content))
    .filter(text => projectionLevelOf(entry, text) !== undefined && addressBelongsTo(entry, text, ids))
  if (matched.length !== 1) {
    throw new Error(`${entry.toolName} 在请求视图里有 ${matched.length} 段正文能被认成它的形态（应恰好 1 段）｜${sizing()}`)
  }
  return matched[0]!
}

/**
 * 断言某条存档结果在视图里的形态就是 `expectedLevel`，并检查形态里的回读地址仍是**真地址**：
 * 是完整条目 id 的前缀、不短于受理下界、且在当次 id 全集里唯一命中（`isUniqueAddressRef`）。
 * 不钉前缀长度：已发出的前缀只要仍唯一就照旧复用（D-W2-8）。
 */
function expectLevel(
  request: RecordedRequest, entry: StoredResult, expectedLevel: 0 | 1 | 2, ids: readonly string[], label: string,
): void {
  const viewText = viewTextFor(request, entry, ids)
  const actual = projectionLevelOf(entry, viewText)
  if (actual !== expectedLevel) {
    throw new Error(`${label} 的形态应为级 ${expectedLevel}，实际为 ${actual ?? "对不上任何形态"}｜${sizing()}`)
  }
  const ref = referenceIn(viewText)
  if (ref === undefined) {
    if (entry.address !== undefined) throw new Error(`${label} 的形态里没有回读地址（条目有 details.deskpetEntryId）｜${sizing()}`)
    return
  }
  if (!entry.id.startsWith(ref) || ref.length < MIN_ADDRESS_PREFIX || !isUniqueAddressRef(ref, entry.id, ids)) {
    throw new Error(`${label} 的地址 ${ref} 不是 ${entry.id} 的唯一前缀（或短于受理下界）｜${sizing()}`)
  }
  // 升到级 2 的那条不能同时又以级 1 形态出现：两种形态并存说明投影出了两份口径。
  if (expectedLevel === 2 && viewText.includes(L0_SHORTENED_TAG)) {
    throw new Error(`${label} 的级 2 形态里带着级 1 的标记 ${L0_SHORTENED_TAG}｜${sizing()}`)
  }
  if (expectedLevel === 0 && (viewText.includes(L0_SHORTENED_TAG) || viewText.includes(L0_CLEARED_TAG))) {
    throw new Error(`${label} 被处理过（正文里带占位串标记），级 0 应逐字原样｜${sizing()}`)
  }
}

/** 期望形态的字面产出：级 2 的正文只剩占位串，中部标记必须消失。 */
function expectClearedBody(entry: StoredResult, viewText: string, label: string): void {
  if (viewText.includes(ADDRESS_CORE) || viewText.includes(ERROR_CORE) || viewText.includes(PRESERVE_CORE)
    || viewText.includes(PROTECTED_CORE) || viewText.includes(SHORT_CORE)) {
    throw new Error(`${label} 被清空后仍带着正文标记｜${sizing()}`)
  }
}

/**
 * 判定侧重放：把观测到的请求视图 + 存档原文重建成 `planToolResultLadder` 的输入。
 *
 * - entries 的下标 = 该条在**请求视图数组**里的下标（`protectedMessageIndexes` 的下标基数同此）；
 * - measure 用导入的 `estimateRequestTokens` / `projectToolResultText` / `annotateToolResultText`
 *   在**存档原文**上复算每一档的视图估算 —— 与 runtime 的 `createLadderMeasure` / `applyLevels`
 *   同一份口径（那两处拿到的都是投影前的视图；观测面是投影后的形态，只能用来定消息骨架）；
 *   形态里的地址用完整条目 id（运行期发的是它的前缀，只差几十 token，落在校准余量内）。
 *
 * 这是「保护区、preserve、无地址」三条过滤在真实视图上的重放：plan 的 levels 应与投影出来的
 * 正文形态一一对上（判定断言与形态断言互为对照）。
 */
function replayPlan(request: RecordedRequest, stored: readonly StoredResult[]): ToolResultLadderPlan {
  const view = request.messages
  const ids = stored.map(entry => entry.id)
  const viewIndexes = view.flatMap((message, index) => (message.role === "toolResult" ? [index] : []))
  if (viewIndexes.length !== stored.length) {
    throw new Error(`请求视图里的工具结果 ${viewIndexes.length} 条与存档 ${stored.length} 条对不上（发生压缩？）｜${sizing()}`)
  }
  const entries: ToolResultLadderEntry[] = []
  const storedByIndex = new Map<number, StoredResult>()
  viewIndexes.forEach((index, at) => {
    const entry = stored[at]!
    // 配对自检：视图里的这段正文必须能被认成这条存档结果的某一档形态（认错就报，不静默错配）。
    const viewText = textOfContent(view[index]!.content)
    if (projectionLevelOf(entry, viewText) === undefined || !addressBelongsTo(entry, viewText, ids)) {
      throw new Error(`视图第 ${index} 条与存档第 ${at} 条（${entry.toolName}）对不上：${viewText.slice(0, 40)}…｜${sizing()}`)
    }
    if (entry.toolName.length === 0) throw new Error(`存档第 ${at} 条没有工具名，preserve 名单会判错｜${sizing()}`)
    storedByIndex.set(index, entry)
    entries.push({
      index,
      toolName: entry.toolName,
      text: entry.text,
      ...(entry.address === undefined ? {} : { address: entry.address }),
    })
  })
  const measure: ToolResultLevelMeasure = levels => estimateRequestTokens(
    request.systemPrompt,
    view.map((message, index) => {
      const entry = storedByIndex.get(index)
      if (entry === undefined) return message
      const level = levels.get(index) ?? 0
      // 与 `applyLevels` 同形：逐 text 块处理（工具结果是单 text 块，上面的配对自检已确认
      // 每条视图正文都能被认成这条存档结果的某一档形态）。**投影的输入取存档原文**
      // （`entry.text`），不取观测面的正文：观测到的请求视图本身已经是投影后的形态，
      // 拿它当输入等于「对投影结果再投影一次」——第 4 轮那笔里三条地址探针已是级 2 清空形态，
      // 再走级 1 只会得到「清空 + 地址尾行」（约 62 token），全量回不来，级 1 读数因此被
      // 系统性低估（实跑把 114,5xx 的量级读成 83,466）。运行期 `createLadderMeasure` 拿到的
      // 是投影前的视图，这里补上的就是同一个前提。
      const project = (): string => level === 0
        ? annotateToolResultText(entry.text, entry.address, SESSION_TRANSCRIPT_TOOL)
        : projectToolResultText(entry.text, entry.address, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL, level)
      return { ...message, content: projectTextBlocks(message.content, project) }
    }),
    request.tools ?? [],
  )
  return planToolResultLadder({
    entries,
    measure,
    window: WINDOW_TOKENS,
    preserveToolNames: preservedToolNames(listAll()),
    protectedIndexes: protectedMessageIndexes(view),
  })
}

/** 声明 `resultProjection` 的探针：链路真实，唯一变量是投影声明与结果里有没有回读地址。 */
const probe = (id: string, name: string, projection: "reference" | "preserve", handler: ToolHandler): ToolDef =>
  defineTool({
    id, name,
    description: `阶梯投影探针 ${name}：请求视图里的投影形态（${projection}）`,
    parameters: { type: "object", properties: { tag: { type: "string" } } },
    safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: projection, historyCompaction: "summarize" },
    },
  }, handler)

const addressProbe = probe(ADDRESS_TOOL_ID, ADDRESS_TOOL_NAME, "reference",
  async args => ({ success: true, content: addressResultFor(String(args.tag ?? "?")) }))
const errorProbe = probe(ERROR_TOOL_ID, ERROR_TOOL_NAME, "reference",
  async () => { throw new Error(ERROR_TEXT) })
const preserveProbe = probe(PRESERVE_TOOL_ID, PRESERVE_TOOL_NAME, "preserve",
  async () => ({ success: true, content: PRESERVE_RESULT }))
const protectedProbe = probe(PROTECTED_TOOL_ID, PROTECTED_TOOL_NAME, "reference",
  async () => ({ success: true, content: PROTECTED_RESULT }))
const shortProbe = probe(SHORT_TOOL_ID, SHORT_TOOL_NAME, "reference",
  async () => ({ success: true, content: SHORT_RESULT }))
/** 校准载荷探针：`preserve` ⇒ 不计入候选集，整份正文按全量计入两次读数。 */
const loadProbe = probe(LOAD_TOOL_ID, LOAD_TOOL_NAME, "preserve",
  async () => ({ success: true, content: loadChunks.shift() ?? "" }))

const PROBE_TOOLS: readonly [string, ToolDef][] = [
  [ADDRESS_TOOL_ID, addressProbe], [ERROR_TOOL_ID, errorProbe], [PRESERVE_TOOL_ID, preserveProbe],
  [PROTECTED_TOOL_ID, protectedProbe], [SHORT_TOOL_ID, shortProbe], [LOAD_TOOL_ID, loadProbe],
]

/** 校准载荷的切块：每块 ≤ 单块上限，总量 ≈ `tokens`（ASCII 4 字符 1 token）。 */
function splitLoad(tokens: number): string[] {
  const chunks: string[] = []
  let remaining = tokens * 4
  while (remaining > 0) {
    const chars = Math.min(remaining, LOAD_CHUNK_CHARS)
    chunks.push(LOAD_PREFIX + "~".repeat(Math.max(0, chars - LOAD_PREFIX.length)))
    remaining -= chars
  }
  return chunks
}

/** 校准用消息形态：估算只看 role/content（`estimateMessageTokens` 不计 id/时间戳）。 */
const userMessage = (text: string): unknown => ({ role: "user", content: text })
const assistantTextMessage = (text: string): unknown => ({ role: "assistant", content: [{ type: "text", text }] })
const assistantToolCallMessage = (name: string): unknown => ({ role: "assistant", content: [{ type: "toolCall", name, arguments: {} }] })

/**
 * 形态断言的整体（第 4 轮）：观测面 = 含校准载荷的那一笔请求，真相源 = 存档原文。
 * 每条探针按「它该落的那一档」逐字比对唯一实现的产出，并检查形态里的地址仍是真地址。
 */
async function expectProjectionShapes(): Promise<void> {
  const stored = await resultEntries()
  const last = requests[requests.length - 1]!
  const ids = stored.map(entry => entry.id)
  const addressEntries = stored.filter(entry => entry.toolName === ADDRESS_TOOL_NAME)
  const errorEntry = stored.find(entry => entry.toolName === ERROR_TOOL_NAME)
  const preserveEntry = stored.find(entry => entry.toolName === PRESERVE_TOOL_NAME)
  const protectedEntry = stored.find(entry => entry.toolName === PROTECTED_TOOL_NAME)
  const shortEntry = stored.find(entry => entry.toolName === SHORT_TOOL_NAME)
  const loadEntries = stored.filter(entry => entry.toolName === LOAD_TOOL_NAME)
  if (!errorEntry || !preserveEntry || !protectedEntry || !shortEntry
    || addressEntries.length !== ADDRESS_CALL_TAGS.length || calibratedChunks.length === 0
    || loadEntries.length !== calibratedChunks.length) {
    throw new Error(`第 4 轮的探针条目不齐（地址 ${addressEntries.length} / 载荷 ${loadEntries.length}，`
      + `校准 ${calibratedChunks.length} 块）｜${sizing()}`)
  }
  // 校准载荷的存档必须是原文（X-2）：条数相等只是计数，这条才保证「视图里那块载荷 = 完整一块
  // 校准载荷」。少了它，载荷被上游换成指针/被裁过时，越线量会静默变小、断言面测的是另一件事。
  loadEntries.forEach((entry, at) => {
    const chunk = calibratedChunks[at]!
    if (entry.text !== chunk) {
      throw new Error(`${LOAD_TOOL_NAME} 第 ${at + 1} 块的存档不是校准载荷原文`
        + `（${entry.text.length} ≠ ${chunk.length} 字符）｜${sizing()}`)
    }
  })

  // 级 2 清空 + 地址仍在（C-3）：正文只剩占位串，中部标记必须消失。
  for (const entry of addressEntries) {
    expectLevel(last, entry, 2, ids, `${entry.toolName}（保护区外，第 4 轮）`)
    expectClearedBody(entry, viewTextFor(last, entry, ids), `${entry.toolName}（保护区外，第 4 轮）`)
  }
  // 保护区挡住的是升级，不是缩短：同一条探针的兄弟在保护区内 ⇒ 级 1（C-1 的 W3-D1 对照）。
  expectLevel(last, protectedEntry, 1, ids, `${PROTECTED_TOOL_NAME}（保护区内，第 4 轮）`)
  // 无地址 ⇒ 停在级 1；级 2 的**硬前提**就是这条等式：无地址时两档输出逐字相等（C-2）。
  expectLevel(last, errorEntry, 1, ids, `${ERROR_TOOL_NAME}（无地址，第 4 轮）`)
  const errorText = viewTextFor(last, errorEntry, ids)
  const levelTwoWithoutAddress = projectToolResultText(errorEntry.text, undefined, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL, 2)
  if (levelTwoWithoutAddress !== projectToolResultText(errorEntry.text, undefined, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL, 1)) {
    throw new Error("无地址时级 2 与级 1 不再是同一形态（级 2 的「必须有地址」硬前提被破坏）")
  }
  if (errorText !== levelTwoWithoutAddress) {
    throw new Error(`${ERROR_TOOL_NAME} 的视图正文不等于「无地址的级 2 形态」（= 级 1 形态）｜${sizing()}`)
  }
  if (!errorText.includes(L0_NO_ADDRESS_NOTICE)) throw new Error(`无地址结果没有被标成「不可回读」｜${sizing()}`)
  if (addressesIn([errorText]).length || addressesIn([errorText], "shortened").length) {
    throw new Error("无地址结果被写了假 eventId")
  }
  // preserve：不缩短、不清空、但同样带地址（D-W2-5）；校准载荷（巨量正文）同样保持全量。
  for (const entry of [preserveEntry, ...loadEntries]) {
    expectLevel(last, entry, 0, ids, `${entry.toolName}（preserve，第 4 轮）`)
    if (!viewTextFor(last, entry, ids).startsWith(entry.text)) {
      throw new Error(`${entry.toolName} 的正文没有逐字原样进入请求｜${sizing()}`)
    }
  }
  // 未超阈 ⇒ 级 0 不动（正文逐字 + 地址尾行）。
  expectLevel(last, shortEntry, 0, ids, `${SHORT_TOOL_NAME}（未超阈，第 4 轮）`)
  if (!viewTextFor(last, shortEntry, ids).includes(SHORT_CORE)) throw new Error("短结果的中部标记被裁掉")

  // 存档不变量（X-2）：投影与可能的压缩都不改真相源，每条探针仍是全文。
  for (const marker of [ADDRESS_CORE, ERROR_CORE, PRESERVE_CORE, PROTECTED_CORE, SHORT_CORE]) {
    if (!stored.some(entry => entry.text.includes(marker))) throw new Error(`第 4 轮后存档丢了原文标记 ${marker}`)
  }
}

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 阶梯投影: SceneDef = {
  meta: {
    caseId: "memory-projection-ladder",
    module: "memory",
    contractId: "mm-32",
    description: "主请求投影按局部计划升档的形态：保护区外有地址 ⇒ 级 2 清空（地址仍在）、保护区内 ⇒ 只缩短、无地址 ⇒ 永不进级 2、preserve 与未超阈结果逐字带地址",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "context", "boundary", "ladder"],
    timeout: 180_000,
  },
  setup: async () => {
    requests.length = 0
    loadChunks = []
    calibratedChunks = []
    calibratedFrame = 0
    calibratedNeeded = 0
    // 前置：第 1 轮要一次调完全部长探针（三个地址 + 无地址错误 + preserve），
    // 配置的工具调用上限低到放不下时，这里直接报出来，不让后面的断言去猜缺了哪条。
    const round1Calls = ADDRESS_CALL_TAGS.length + 2
    if (loopConfig.maxToolCallsPerTurn < round1Calls) {
      throw new Error(`第 1 轮需要 ${round1Calls} 次工具调用，ai.loop.maxToolCallsPerTurn=${loopConfig.maxToolCallsPerTurn} 放不下｜${sizing()}`)
    }
    for (const [id] of PROBE_TOOLS) unregister(id)
    for (const [, tool] of PROBE_TOOLS) register(tool)
    provider = installFakeProvider([
      // 第 1 轮：5 次工具调用（每次一笔请求，与 地址完整性 的写法同形），再收尾
      step(fakeToolCall(ADDRESS_TOOL_NAME, { tag: ADDRESS_CALL_TAGS[0] }, "ladder-address-call-1"), expectRoundText(ROUND1_TEXT)),
      step(fakeToolCall(ADDRESS_TOOL_NAME, { tag: ADDRESS_CALL_TAGS[1] }, "ladder-address-call-2"), expectRoundText(ROUND1_TEXT)),
      step(fakeToolCall(ADDRESS_TOOL_NAME, { tag: ADDRESS_CALL_TAGS[2] }, "ladder-address-call-3"), expectRoundText(ROUND1_TEXT)),
      step(fakeToolCall(ERROR_TOOL_NAME, {}, "ladder-error-call"), expectRoundText(ROUND1_TEXT)),
      step(fakeToolCall(PRESERVE_TOOL_NAME, {}, "ladder-preserve-call"), expectRoundText(ROUND1_TEXT)),
      step(fakeText(ROUND1_REPLY_TEXT), expectRoundText(ROUND1_TEXT)),
      // 第 2 轮：只垫一轮（把第 1 轮推出保护区），不调工具
      step(fakeText(ROUND2_REPLY_TEXT), expectRoundText(ROUND2_TEXT)),
      // 第 3 轮：受保护地址探针 + 短结果探针（两条都落在保护区里），再收尾
      step(fakeToolCall(PROTECTED_TOOL_NAME, {}, "ladder-protected-call"), expectRoundText(ROUND3_TEXT)),
      step(fakeToolCall(SHORT_TOOL_NAME, {}, "ladder-short-call"), expectRoundText(ROUND3_TEXT)),
      step(fakeText(ROUND3_REPLY_TEXT), expectRoundText(ROUND3_TEXT)),
      // 第 4 轮的脚本在场景准备阶段按实测读数追加（块数由校准决定，不在 setup 里写死）。
    ], FAKE_MODEL)
    await initChat()
  },
  turns: [
    {
      index: 1,
      description: "五个探针各调一次：存档是全文、成功结果带地址、错误结果无地址，视图仍在目标以内",
      userText: ROUND1_TEXT,
      checks: [{ type: "expectLadderProbesExecuted", run: async context => {
        if (context.output.failure) throw new Error(`第一轮就失败: ${context.output.failure.message}`)
        // 观测面是**第 1 轮**的工具历史（`context.toolHistory` = 该回合的结算记录），所以只要求
        // 第 1 轮脚本里的三个工具：受保护/短结果探针在第 3 轮、校准载荷探针在第 4 轮，它们的
        // 执行证据在各自回合的断言里（第 3 轮要求条目落进会话，第 4 轮逐条比对形态）。
        // 每条探针的合格证据是**它自己的结算状态**：`ladder_error_probe` 的设计就是抛错
        // （见上方口径：抛错 ⇒ 无地址 ⇒ 永停级 1），失败分支只写 `error`
        // （harness-tool-adapter.ts:68 的 `run.history.push`）；工具未注册/未被派发时历史里
        // 根本没有这条，仍会被这里拦下。「真的按设计抛错」由本 check 后半段的存档标记钉住：
        // ERROR_CORE（抛出的正是探针正文）、全文长度 ≥ 两段填充、且没有回读地址 ——
        // 放行的不是「随便一个错误」，是这一条。
        const round1Probes: Array<[string, string]> = [
          [ADDRESS_TOOL_NAME, "done"], [ERROR_TOOL_NAME, "error"], [PRESERVE_TOOL_NAME, "done"],
        ]
        for (const [name, expectedStatus] of round1Probes) {
          if (!context.toolHistory.some(item => item.toolName === name && item.status === expectedStatus)) {
            throw new Error(`探针 ${name} 没有按设计执行（应结算为 ${expectedStatus}）：`
              + context.toolHistory.map(item => `${item.toolName}:${item.status}`).join(","))
          }
        }
        const stored = await resultEntries()
        const markers: Array<[string, string]> = [
          [ADDRESS_TOOL_NAME, ADDRESS_CORE], [ERROR_TOOL_NAME, ERROR_CORE], [PRESERVE_TOOL_NAME, PRESERVE_CORE],
        ]
        for (const [name, marker] of markers) {
          const entries = stored.filter(entry => entry.toolName === name)
          if (entries.length === 0) throw new Error(`会话条目里没有 ${name} 的结果：${stored.map(r => r.toolName).join(",") || "(空)"}`)
          for (const entry of entries) {
            if (!entry.text.includes(marker)) throw new Error(`${name} 的存档丢了中部标记 ${marker}`)
            // 存档条目始终是全文：投影只改请求视图，不能落进磁盘条目。
            if (entry.text.length < PROBE_SIDE_CHARS * 2) {
              throw new Error(`${name} 的存档不是全文（${entry.text.length} < ${PROBE_SIDE_CHARS * 2}）｜${sizing()}`)
            }
            // 非空性：探针必须真的超单条上限，否则它连候选都不是（「用单条上限夹住每条」）。
            if (estimateContextTokens(entry.text) <= SINGLE_ENTRY_TOKENS) {
              throw new Error(`${name} 的结果没有超过单条上限 ${SINGLE_ENTRY_TOKENS}：载荷不足，级 1/级 2 断言不成立｜${sizing()}`)
            }
          }
        }
        if (stored.filter(entry => entry.toolName === ADDRESS_TOOL_NAME).length !== ADDRESS_CALL_TAGS.length) {
          throw new Error(`地址探针应有 ${ADDRESS_CALL_TAGS.length} 条结果，实际 ${stored.filter(e => e.toolName === ADDRESS_TOOL_NAME).length} 条`)
        }
        for (const entry of stored) {
          if (entry.toolName === ERROR_TOOL_NAME && entry.address !== undefined) {
            throw new Error("错误分支不该写回读地址（上游只用 error.message）")
          }
          if (entry.toolName !== ERROR_TOOL_NAME && entry.address === undefined) {
            throw new Error(`${entry.toolName} 的结果没有 details.deskpetEntryId（成功分支必须带地址）`)
          }
        }
        // 越线只能发生在第 4 轮：前 3 轮的候选全在保护区内，级 2 清不动它们 —— 视图必须还在目标以内。
        const last = requests[requests.length - 1]!
        const plan = replayPlan(last, stored)
        if (plan.target !== TARGET_TOKENS) {
          throw new Error(`阶梯判据不是运行期口径：target=${plan.target}，应为 contextBudget(${WINDOW_TOKENS}).normalInputTarget=${TARGET_TOKENS}`)
        }
        if (plan.tokensAfterLevel1 > TARGET_TOKENS) {
          throw new Error(`第 1 轮视图 ${plan.tokensAfterLevel1} 已越过目标 ${TARGET_TOKENS}：载荷超出场景口径｜${sizing()}`)
        }
      } }],
    },
    {
      index: 2,
      description: "垫一轮：第 1 轮的三条探针仍在保护区内，超阈候选只能是级 1 形态（保护区不挡缩短）",
      userText: ROUND2_TEXT,
      checks: [{ type: "expectProtectedZoneKeepsLevelOne", run: async () => {
        const stored = await resultEntries()
        const last = requests[requests.length - 1]!
        const ids = stored.map(entry => entry.id)
        // 保护区（口径 B）：只挡级 2，超阈候选照样缩短。
        const protectedIndexes = protectedMessageIndexes(last.messages)
        const viewIndexes = last.messages.flatMap((message, index) => (message.role === "toolResult" ? [index] : []))
        if (viewIndexes.length !== stored.length) throw new Error(`第 2 轮视图与存档的条目数不一致｜${sizing()}`)
        for (const index of viewIndexes) {
          if (!protectedIndexes.has(index)) {
            throw new Error(`第 2 轮还有 ${LADDER_PROTECTION_TURNS} 轮保护：第 ${index} 条不该在保护区外｜${sizing()}`)
          }
        }
        const plan = replayPlan(last, stored)
        if (plan.level !== 1) throw new Error(`第 2 轮的计划应为级 1（未越线不升档），实际级 ${plan.level}｜${sizing()}`)
        viewIndexes.forEach((index, at) => {
          const entry = stored[at]!
          const level = plan.levels.get(index)
          // 保护区内超阈候选：进 levels 且值恒为 1（口径 A 才会把它们排除在 levels 之外）；preserve 不进 levels。
          if (entry.toolName === PRESERVE_TOOL_NAME) {
            if (level !== undefined) throw new Error(`preserve 的结果 ${index} 不该进 levels｜${sizing()}`)
            return
          }
          if (level !== 1) {
            throw new Error(`保护区内超阈候选 ${index} 的 level 应为 1（进 levels 但恒为 1），实际 ${level ?? "(不在 levels 里)"}｜${sizing()}`)
          }
        })
        // 形态：超阈候选（三条地址 + 无地址错误）在保护区内仍是级 1 形态 —— 保护区只挡升级，
        // 不挡缩短（口径 A 会让它们退回逐字原文，这条断言正是两种口径的分水岭）；
        // preserve 一律级 0（不缩短、不清空，带地址）。
        for (const entry of stored) {
          expectLevel(last, entry, entry.toolName === PRESERVE_TOOL_NAME ? 0 : 1, ids, `${entry.toolName}（第 2 轮）`)
        }
      } }],
    },
    {
      index: 3,
      description: "受保护与未超阈探针入场，并按实测请求视图校准第 4 轮的越线载荷",
      userText: ROUND3_TEXT,
      checks: [{ type: "expectCalibratedLoadInBand", run: async () => {
        const stored = await resultEntries()
        const last = requests[requests.length - 1]!
        const ids = stored.map(entry => entry.id)
        const protectedEntry = stored.find(entry => entry.toolName === PROTECTED_TOOL_NAME)
        const shortEntry = stored.find(entry => entry.toolName === SHORT_TOOL_NAME)
        if (!protectedEntry || !shortEntry) throw new Error("第 3 轮的两个探针没有落进会话条目")
        // 形态前置：受保护候选是级 1 形态、短结果是级 0 逐字形态（第 4 轮要断言它们不变）。
        expectLevel(last, protectedEntry, 1, ids, `${PROTECTED_TOOL_NAME}（第 3 轮）`)
        expectLevel(last, shortEntry, 0, ids, `${SHORT_TOOL_NAME}（第 3 轮）`)
        const plan = replayPlan(last, stored)
        if (plan.tokensAfterLevel1 > TARGET_TOKENS) {
          throw new Error(`第 3 轮视图 ${plan.tokensAfterLevel1} 已越过目标 ${TARGET_TOKENS}：保护区内的候选清不动，越线必须留给第 4 轮｜${sizing()}`)
        }

        // ── 校准：第 3 轮实测视图 + 已知的后续增量，补到「目标 + 越线量」 ──
        const frame = estimateRequestTokens(last.systemPrompt, last.messages, last.tools ?? [])
        const additions = estimateMessageTokens(assistantTextMessage(ROUND3_REPLY_TEXT))
          + estimateMessageTokens(userMessage(ROUND4_TEXT))
          + estimateMessageTokens(assistantToolCallMessage(LOAD_TOOL_NAME))
        calibratedFrame = frame
        calibratedNeeded = TARGET_TOKENS + MARGIN_TOKENS - frame - additions
        if (calibratedNeeded <= 0) {
          throw new Error(`载荷不足：第 3 轮视图已到 ${frame}（越线点 ${TARGET_TOKENS + MARGIN_TOKENS}），无法再由校准载荷越线｜${sizing()}`)
        }
        const chunks = splitLoad(calibratedNeeded)
        if (chunks.length > loopConfig.maxToolCallsPerTurn) {
          throw new Error(`校准载荷需要 ${chunks.length} 次调用，超过单轮上限 ${loopConfig.maxToolCallsPerTurn}：越线量 ${calibratedNeeded} tokens 超出可加载范围｜${sizing()}`)
        }
        loadChunks = chunks
        // 断言期读这份快照：`loadChunks` 会被校准探针的 handler 逐次 `shift()` 消费到空。
        calibratedChunks = [...chunks]
        provider?.appendResponses([
          ...chunks.map((_, at) => step(fakeToolCall(LOAD_TOOL_NAME, {}, `ladder-load-call-${at + 1}`), expectRoundText(ROUND4_TEXT))),
          step(fakeText(ROUND4_REPLY_TEXT), expectRoundText(ROUND4_TEXT)),
        ])
      } }],
    },
    {
      index: 4,
      description: "保护区外有地址 ⇒ 级 2 清空（地址仍在）、保护区内 ⇒ 只缩短、无地址 ⇒ 停在级 1、preserve 与未超阈逐字",
      userText: ROUND4_TEXT,
      checks: [
        { type: "expectLadderPlanEscalated", run: async () => {
          const stored = await resultEntries()
          const last = requests[requests.length - 1]!
          // 观测面必须是含校准载荷的那一笔请求（脚本错位时这里就断）。
          // 载荷的观测面按工具名取：`loadChunks` 已被 handler 抽空，**空数组的 `.every()` 恒真**
          // —— 拿它当守卫，载荷一块都没进这笔请求也会静默放行（第 4 轮实跑正是如此）。
          const loadTexts = last.messages
            .filter(message => message.role === "toolResult" && message.toolName === LOAD_TOOL_NAME)
            .map(message => textOfContent(message.content))
          if (calibratedChunks.length === 0) {
            throw new Error(`第 3 轮没有产出校准载荷块：第 4 轮的越线断言不成立｜${sizing()}`)
          }
          if (loadTexts.length !== calibratedChunks.length) {
            throw new Error(`最后一笔请求里的校准载荷为 ${loadTexts.length} 块，`
              + `与校准结果 ${calibratedChunks.length} 块不符：第 4 轮的脚本没有按校准结果落位｜${sizing()}`)
          }
          const missingChunks = calibratedChunks.filter(chunk => !loadTexts.some(text => text.startsWith(chunk)))
          if (missingChunks.length > 0) {
            throw new Error(`最后一笔请求里少了 ${missingChunks.length}/${calibratedChunks.length} 块校准载荷｜${sizing()}`)
          }
          const plan = replayPlan(last, stored)
          const viewIndexes = last.messages.flatMap((message, index) => (message.role === "toolResult" ? [index] : []))
          if (plan.target !== TARGET_TOKENS) throw new Error(`阶梯判据不是运行期口径：target=${plan.target}｜${sizing()}`)
          // 非空性：级 1 之后的合计必须真的越过目标，否则级 2 断言不成立 —— 报载荷问题，不判通过。
          if (plan.tokensAfterLevel1 <= plan.target) {
            throw new Error(`级 1 之后的合计 ${plan.tokensAfterLevel1} 未越过目标 ${plan.target}：载荷不足，级 2 断言不成立｜${sizing()}`)
          }
          if (plan.tokensAfterLevel1 < plan.target + MARGIN_TOKENS / 2) {
            throw new Error(`级 1 之后的合计 ${plan.tokensAfterLevel1} 只比目标 ${plan.target} 高一点：越线量不足，级 2 的升档条件处在边缘｜${sizing()}`)
          }
          // 越线量必须小于「清空能腾出的量」，否则级 2 之后仍超目标 —— 那是级 3 闸门的地盘，不是本场景。
          if (plan.tokensAfterLevel2 > plan.target) {
            throw new Error(`级 2 之后 ${plan.tokensAfterLevel2} 仍超目标 ${plan.target}：闸门会接管，本场景的形态口径被破坏｜${sizing()}`)
          }
          if (plan.level !== 2) throw new Error(`计划应为级 2（有清空），实际级 ${plan.level}｜${sizing()}`)

          const protectedIndexes = protectedMessageIndexes(last.messages)
          // 视图下标 → 探针身份：配对与 `replayPlan` 同源（视图序 = 存档序，配对自检在那里）。
          const indexOf = (toolName: string): number[] => viewIndexes.filter((_index, at) => stored[at]?.toolName === toolName)
          // 保护区外 + 有地址 ⇒ 级 2；保护区内 + 有地址 ⇒ 级 1（口径 B：保护区只挡级 2）。
          for (const index of indexOf(ADDRESS_TOOL_NAME)) {
            if (protectedIndexes.has(index)) throw new Error(`第 1 轮的地址探针 ${index} 仍在保护区内，场景口径被破坏｜${sizing()}`)
            if (plan.levels.get(index) !== 2) throw new Error(`保护区外的地址探针 ${index} 的 level 应为 2，实际 ${plan.levels.get(index) ?? "(不在 levels 里)"}｜${sizing()}`)
          }
          for (const index of indexOf(PROTECTED_TOOL_NAME)) {
            if (!protectedIndexes.has(index)) throw new Error(`第 3 轮的受保护探针 ${index} 不在保护区内，场景口径被破坏｜${sizing()}`)
            if (plan.levels.get(index) !== 1) throw new Error(`保护区内有地址的候选 ${index} 的 level 应为 1（保护区只挡级 2），实际 ${plan.levels.get(index) ?? "(不在 levels 里)"}｜${sizing()}`)
          }
          // 无地址 ⇒ 永不进级 2。
          for (const index of indexOf(ERROR_TOOL_NAME)) {
            if (plan.levels.get(index) !== 1) throw new Error(`无地址的候选 ${index} 的 level 应为 1，实际 ${plan.levels.get(index) ?? "(不在 levels 里)"}｜${sizing()}`)
          }
          // 未超阈（级 0）与 preserve 不进 levels。
          for (const index of indexOf(SHORT_TOOL_NAME)) {
            if (plan.levels.has(index)) throw new Error(`未超阈的结果 ${index} 不该进 levels（级 0 不动）｜${sizing()}`)
          }
          for (const name of [PRESERVE_TOOL_NAME, LOAD_TOOL_NAME]) {
            for (const index of indexOf(name)) {
              if (plan.levels.has(index)) throw new Error(`preserve 的结果 ${index} 不该进 levels｜${sizing()}`)
            }
          }
          // 级 2 之后装得下 ⇒ 阈值压缩这一轮 decline，不该留下 compaction 条目（闸门由 memory-ladder-gate 证）。
          const compactions = compactionEntries(await sessionEntries())
          if (compactions.length !== 0) {
            throw new Error(`第 4 轮不该发生压缩（级 2 已把视图压到目标以下），实际 ${compactions.length} 条 compaction 条目｜${sizing()}`)
          }
        } },
        { type: "expectLadderProjectionShapes", run: async () => {
          try {
            await expectProjectionShapes()
          } finally {
            // 探针只属于本场景：断言失败也要移出注册表，不给后续场景留阶梯探针。
            for (const [id] of PROBE_TOOLS) unregister(id)
          }
        } },
      ],
    },
  ],
}

export default 阶梯投影
