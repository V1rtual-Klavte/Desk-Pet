// ==========================================
// 会话标签 / 历史面板的宿主请求承接（A2）—— Node 侧应答
// ==========================================
//
// 方向：**原生 UI 发起、Node 应答**。复用既有 host-request 通道（事件
// `deskpet-host-request` + 回执命令 `host_request_result`；方法名与 args 形状登记在
// `src/services/host/types.ts` 的 `HostRequestMap` 的 `chat_*` 五条）。不新增第二套
// 上行协议 —— 与 `host-requests.ts` 文件头同一裁定。
//
// 与 A1（Rust `crates/native-host/src/ui/chat/intents.rs` 的「A1 增补」）逐项对应：
//   - `chat_new_session`     → `createNewSession()` + 欢迎语；
//   - `chat_close_session`   → `closeSession(id)`（移除标签、**保留会话文件**）+
//     收口：「列表空了 → 建新会话」「关的是活跃会话 → 切到首个剩余会话」；
//   - `chat_delete_session`  → `deleteSession(id)`（删文件+列表）+ 删除收口（同 chat_close_session）；
//   - `chat_restore_session` → 按 id 查仓库 → `openSession(meta)` + `switchToSession(id)`
//     （UI 只传 id，meta 由 Node 侧查仓库）；
//   - `chat_request_session_history` → `refreshSessionHistory()`；结果经投影
//     `sessionHistory` 回推（`session-projection` 的推送），**回执之后**才推。
//
// 顺序语义（`chat_request_session_history`）：宿主侧「读取中」只在请求确实送出后登记，
// 且只在收到带 `sessionHistory` 的投影帧时清除。因此回执必须先于投影帧发出，
// 否则「读取中」会残留到下一次推送。实现：`runChatAfterReplyPush()` 由
// `host-requests.ts` 的 `handleEnvelope` 在回执之后调用（只对本类方法动作，其余 no-op）。
//
// 标签列表不经本通道增删：UI 不本地增删（标签条只随投影整表覆盖），
// 本模块只执行领域操作，显示变化由 `session-projection` 的回推完成。
//
// 本包增补（核心聊天链路；方法登记见 `HostRequestMap` 的「本包：核心聊天链路」组）：
//   - `chat_send`           → `sendMessage(text, { imagePaths })`（用户 ingress；
//     「先落盘再投递」由该入口内部的 lane 持久 inbox 完成，本层不另建投递通道；
//     忙碌时的投递意图由 ingress 按 CONFIG `ai.conversation.defaultDelivery` 决定）；
//   - `chat_slash_command`  → 同一条 `sendMessage`（`/` 文本在忙碌时按既有语义 nextRun
//     排队，执行/透传由 ingress preProcess 决定）；
//   - `chat_stop`           → `stopActiveRun(sessionId)`（在跑计划经它一并终止）；
//   - `chat_switch_session` → `switchToSession(id)`（与其他会话操作同为有界请求）。
// `sessionId` 是宿主 UI 的快照：Node 活跃会话是唯一所有者，快照不可能领先于投影，
// 不一致 = 切换在途，按活跃会话处理并留痕（只有 send/slash 是会话内动作，需要这一
// 说明；stop/switch 接收显式 id，领域入口本就按 id 工作）。
//
// 同包另四条增补（消息行动作与抽屉三个 CONFIG 写；方法登记见 `HostRequestMap` 的
// 「本包」组与调试条组）：
//   - `chat_remember_message` → 可信来源复核（`resolveCurrentTrustedMemorySource`）
//     + `applyMemoryChange(add, actor:user_ui)` + `publishMemoryRevision`，回执带
//     `{ revision }`；不可信/不存在由记忆域如实抛错、本层原样透传（裸 `Error`
//     无 `code`，回执由宿主侧统一归一为 `OTHER`，原因在 message 里）；
//   - `chat_set_default_delivery` / `chat_set_thinking_effort` / `chat_set_safety_mode`
//     → 与设置页同键的 CONFIG 写（`setOverride` + `flushConfig` 的同一条写盘路径；
//     2026-10-06 用户裁决：抽屉三个下拉就是设置页对应项的快捷入口，不是单条/会话级
//     覆盖）；显示收敛由回执后的投影重推承担（见下）。

import { sendMessage, stopActiveRun } from "@/services/agent"
// 记忆草稿 summary 上限取零依赖叶子（不加载记忆域：barrel 仍只在调用时动态 import）。
import { DRAFT_SUMMARY_CHARS } from "@/services/agent/memory/draft"
import { playEventSound } from "@/services/audio"
import { flushConfig, setOverride } from "@/services/config"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import {
  closeSession,
  createNewSession,
  deleteSession,
  getActiveSessionId,
  getSessions,
  initWelcome,
  listPiSessionMetadata,
  openSession,
  readPiSessionSummary,
  refreshSessionHistory,
  switchToSession,
} from "@/services/session"
import { markSessionHistoryResolved, pushSessionProjection } from "./session-projection"
import { harnessSlots } from "@/services/engine/harness/harness-slot"

const log = createLogger("NativeUi")

/** 入参形状失败：结构化 CONFIG（与 host-requests 的入参校验同口径）。 */
function requireSessionId(args: unknown, method: string): string {
  const sessionId = (args as { sessionId?: unknown } | null)?.sessionId
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw Object.assign(new Error(`${method} 缺少有效的 sessionId`), { code: "CONFIG" })
  }
  return sessionId
}

/** 新会话的欢迎语：文案只经激活 Card 的既有取用口。 */
async function greetActiveSession(): Promise<void> {
  const { pickActiveGreeting } = await import("@/services/personality")
  const greeting = pickActiveGreeting()
  if (greeting) await initWelcome(greeting, getActiveSessionId())
}

/** 新建会话 + 欢迎语（A1 的 `NewSession`）。 */
export async function chatNewSession(): Promise<void> {
  await createNewSession()
  // 新建会话即为其建槽：欢迎语是宿主生成的条目，落盘经该会话的 harness lane；
  // 没有 run 的新会话不 ensure 时会以「lane 尚未就绪」静默落盘失败（台词进视图
  // 但磁盘没有 —— 与「欢迎语恰好落盘一条」的契约相反）。槽的空闲回收由既有
  // releaseWhenIdle / dispose 路径负责，这里只建不额外持有。
  const active = getActiveSessionId()
  if (active) harnessSlots.ensure(active)
  await greetActiveSession()
}

/**
 * 关闭标签、保留会话文件（A1 的 `CloseSession`）。
 *
 * 收口规则：`|| getActiveSessionId() === ""` 一支不可达
 * （列表非空时 getActiveSessionId 已回落首个会话），不搬死分支。
 */
export async function chatCloseSession(args: unknown): Promise<void> {
  const sessionId = requireSessionId(args, "chat_close_session")
  closeSession(sessionId)
  const remaining = getSessions()
  if (remaining.length === 0) {
    await createNewSession()
    await greetActiveSession()
  } else if (getActiveSessionId() === sessionId) {
    await switchToSession(remaining[0].id)
  }
}

/**
 * 删除会话：磁盘文件 + 列表 + UI 状态（A1 的 `DeleteSession`）。
 *
 * 收口：`wasActive` 必须在删除前捕获
 * （deleteSession 会把活跃指针清空）。删除失败（`deleteSession` 返回 false）由域内
 * 留痕（warn/error），本层不把它改写成新的失败语义。
 */
export async function chatDeleteSession(args: unknown): Promise<void> {
  const sessionId = requireSessionId(args, "chat_delete_session")
  const wasActive = getActiveSessionId() === sessionId
  await deleteSession(sessionId)
  if (getSessions().length === 0) {
    await createNewSession()
    await greetActiveSession()
  } else if (wasActive) {
    await switchToSession(getSessions()[0].id)
  }
}

/**
 * 从历史重新打开并切换到该会话（A1 的 `RestoreSession`）。
 *
 * UI 只传 id（A1 的约定）：meta 由 Node 侧查仓库（`listPiSessionMetadata` +
 * `readPiSessionSummary`，与历史面板刷新同一读路径）；查不到/读失败如实抛结构化错误。
 */
export async function chatRestoreSession(args: unknown): Promise<void> {
  const sessionId = requireSessionId(args, "chat_restore_session")
  const metadata = (await listPiSessionMetadata()).find((item) => item.id === sessionId)
  if (!metadata) {
    throw Object.assign(new Error(`会话不存在，无法恢复: ${sessionId}`), { code: "PATH_NOT_FOUND" })
  }
  const summary = await readPiSessionSummary(metadata)
  if (!summary) {
    throw Object.assign(new Error(`会话元数据读取失败，无法恢复: ${sessionId}`), { code: "IO" })
  }
  openSession({
    id: summary.id,
    name: summary.name || "新会话",
    createdAt: summary.createdAt,
    activityAt: summary.activityAt,
    path: summary.path,
  })
  await switchToSession(summary.id)
}

/** 重新读取会话历史（A1 的 `RequestSessionHistory`；结果经投影 `sessionHistory` 回推）。 */
export async function chatRequestSessionHistory(): Promise<void> {
  await refreshSessionHistory()
  markSessionHistoryResolved()
}

// ── 本包：核心聊天链路（send / slash / stop / switch）──

/** 可选 sessionId：缺省/null = 无快照；其余形状按协议违规拒绝（不静默丢弃）。 */
function optionalSessionId(value: unknown, method: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`${method} 的 sessionId 形状无效`), { code: "CONFIG" })
  }
  return value
}

/** 宿主会话快照与 Node 活跃会话不一致时的留痕（切换在途；按活跃会话处理）。 */
function noteSessionSnapshot(sessionId: string | undefined, method: string): void {
  if (!sessionId) return
  const active = getActiveSessionId()
  if (active && active !== sessionId) {
    log.warn(`${method} 的会话快照与当前活跃会话不一致（切换在途），按活跃会话处理`)
  }
}

/** `chat_send` 的 text：必填字符串（空文本 + 有图合法，两种都空在下一层拒绝）。 */
function requireSendText(value: unknown): string {
  if (typeof value !== "string") {
    throw Object.assign(new Error("chat_send 缺少有效的 text"), { code: "CONFIG" })
  }
  return value
}

/** `chat_send` 的 imagePaths：缺省/null = 空数组；非字符串项按协议违规拒绝。 */
function parseImagePaths(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw Object.assign(new Error("chat_send 的 imagePaths 必须是不含非字符串项的数组"), {
      code: "CONFIG",
    })
  }
  return value as string[]
}

/**
 * 发送一条普通消息（`Send`；用户 ingress 的唯一领域入口）。
 *
 * 形状守卫按 `HostRequestMap`：text 必填字符串；文本与图片同时为空是协议违规
 * （宿主侧 `dispatch_send_text` 已拦过，这里不替它放行空消息）。投递（含忙碌路径的
 * lane 持久 inbox、图片准入）全在 `sendMessage` 内部完成，本层不复制默认值、不
 * 另建通道；忙碌时的投递意图由 ingress 按 CONFIG `ai.conversation.defaultDelivery`
 * 决定（单条显式投递意图已随 2026-10-06 用户裁决整链删除）。
 */
export async function chatSend(args: unknown): Promise<void> {
  const payload = (args ?? {}) as {
    sessionId?: unknown
    text?: unknown
    imagePaths?: unknown
  }
  const text = requireSendText(payload.text)
  const imagePaths = parseImagePaths(payload.imagePaths)
  if (text.trim().length === 0 && imagePaths.length === 0) {
    throw Object.assign(new Error("chat_send 的文本与图片不能同时为空"), { code: "CONFIG" })
  }
  noteSessionSnapshot(optionalSessionId(payload.sessionId, "chat_send"), "chat_send")
  const sending = sendMessage(text, { imagePaths })
  void playEventSound("send").catch((error) => {
    log.warn("发送音效触发失败:", formatError(error))
  })
  await sending
}

/**
 * 发送 `/` 开头的命令文本（`SlashCommand`；与今天同一条 `sendMessage`）。
 *
 * 执行/透传由 ingress preProcess 决定，忙碌时按既有语义（`/` 文本 → nextRun）排队。
 * 非 `/` 前缀的文本按协议违规拒绝（该入口只承载 slash）。
 */
export async function chatSlashCommand(args: unknown): Promise<void> {
  const payload = (args ?? {}) as { sessionId?: unknown; command?: unknown }
  if (typeof payload.command !== "string" || !payload.command.trim().startsWith("/")) {
    throw Object.assign(new Error("chat_slash_command 的 command 必须是以 / 开头的字符串"), {
      code: "CONFIG",
    })
  }
  noteSessionSnapshot(optionalSessionId(payload.sessionId, "chat_slash_command"), "chat_slash_command")
  const sending = sendMessage(payload.command)
  void playEventSound("send").catch((error) => {
    log.warn("发送音效触发失败:", formatError(error))
  })
  await sending
}

/**
 * 停止当前运行（`Stop`）。
 *
 * 领域结果是异步收尾的事实（归还清单/系统提示由运行内核与 `deskpet-run-state`
 * 事件呈现）；`stopActiveRun` 的「没有在进行的回复」是既有语义的如实归宿，本层
 * 不把它改写成失败（宿主侧也是非阻塞提交）。
 */
export async function chatStop(args: unknown): Promise<void> {
  await stopActiveRun(requireSessionId(args, "chat_stop"))
}

/**
 * 切换活跃会话（`SwitchSession`）。
 *
 * 复用既有领域入口；未知 id 的归宿是领域语义（留痕 + no-op），显示变化经
 * `session-signal` 的投影回推，不在这里做本地切换。
 */
export async function chatSwitchSession(args: unknown): Promise<void> {
  await switchToSession(requireSessionId(args, "chat_switch_session"))
}

// ── 本包：消息行动作与抽屉三个 CONFIG 写（记住这条 / 投递 / 思考 / 安全）──

/** `chat_remember_message` 的 eventId：必填非空字符串（消息的可信事件身份）。 */
function requireEventId(args: unknown, method: string): string {
  const eventId = (args as { eventId?: unknown } | null)?.eventId
  if (typeof eventId !== "string" || eventId.trim().length === 0) {
    throw Object.assign(new Error(`${method} 缺少有效的 eventId`), { code: "CONFIG" })
  }
  return eventId
}

/**
 * 「记住这条」：把一条已提交的用户原文显式写成长期记忆（旧壳
 * `ChatPanel.vue` 的 `rememberUserMessage` 同一条链路）。
 *
 * 可信来源解析与候选资格判定是记忆域的既有职责，本层只做形状守卫并如实透传：
 * `resolveCurrentTrustedMemorySource` 经 `trustedSourcesFromEntries` 只产出
 * origin=user + taint=trusted_user + eligibleForMemory 且 evidence 非空的来源
 * （提交时 Rust 记忆库还会按「user_ui_current」再做一道门禁：精确原话、唯一来源、
 * 会话归属；调用窗口是主宿主且 add + 可信会话时自动升档）。
 *
 * 因此本层不复刻三条件与 evidence 检查：它们对解析器的返回恒真，留下就是会随域内
 * 判据漂移的第二定义点——曾经的两个 `code:"MEMORY"` 分支即按此删除；改由解析器抛
 * 结构化错误也不改变这一点（只会替所有调用方换错误码，分支依旧不可达）。来源缺失、
 * 不唯一或已被遗忘时，解析器如实抛裸 `Error`（无 code），本层原样透传，回执由宿主
 * 侧统一归一为 `OTHER` + 原始 message（中性呈现，不静默、不伪码）。
 */
export async function chatRememberMessage(args: unknown): Promise<{ revision: number }> {
  const sessionId = requireSessionId(args, "chat_remember_message")
  const eventId = requireEventId(args, "chat_remember_message")
  const memory = await import("@/services/agent/memory")
  await memory.MemoryService.init()
  const source = await memory.resolveCurrentTrustedMemorySource(sessionId, eventId)
  // 解析器契约保证 evidence 非空（见上）；这里的断言只是把该契约带进类型，
  // 不是第二道门禁。
  const evidence = source.evidence as string
  const current = await memory.memoryStatus()
  const revision = await memory.applyMemoryChange({
    operationId: `remember-${crypto.randomUUID()}`,
    baseRevision: current.revision,
    action: "add",
    actor: "user_ui",
    trustedSessionId: sessionId,
    trustedUserEventId: eventId,
    draft: {
      content: evidence,
      summary: evidence.trim().slice(0, DRAFT_SUMMARY_CHARS),
      kind: "episode",
      scope: "user",
      aliases: [],
      pinned: false,
      importance: 5,
      confidence: 1,
      observedAt: source.observedAt,
      sourceIds: [source.sourceId],
    },
  })
  // 提交成功才同步运行期记忆（失败已由 applyMemoryChange 抛出，不谎报成功）。
  await memory.publishMemoryRevision(revision)
  log.info(`「记住这条」已提交: revision ${revision}`)
  return { revision }
}

/**
 * 抽屉三个下拉的统一写盘：`setOverride`（写内存 cfg + 入写队列）→ `flushConfig()`
 * 原子写盘，与设置页保存**同一条写盘路径**（`settings_commit` 的 ②/③ 步），
 * 不另建第二条 CONFIG 写路径。写盘失败如实抛出（配置未落盘），由宿主侧以结构化
 * 回执呈现（界面不做乐观变更）。
 */
async function writeDrawerConfig(key: string, value: string): Promise<void> {
  setOverride(key, value)
  await flushConfig()
}

/** `chat_set_default_delivery` 的 delivery：按 DeliveryIntent 值域拒绝其余形状。 */
function parseDefaultDelivery(value: unknown): "steer" | "followUp" {
  if (value === "steer" || value === "followUp") return value
  throw Object.assign(new Error("chat_set_default_delivery 的 delivery 只接受 steer / followUp"), {
    code: "CONFIG",
  })
}

/**
 * 默认投递方式（抽屉「投递」下拉）：写 CONFIG `ai.conversation.defaultDelivery`
 * （与设置页「默认发送方式（忙碌时）」同键、同值域；没有「默认」项——配置总有值）。
 */
export async function chatSetDefaultDelivery(args: unknown): Promise<void> {
  const delivery = parseDefaultDelivery((args as { delivery?: unknown } | null)?.delivery)
  await writeDrawerConfig("ai.conversation.defaultDelivery", delivery)
}

/** `chat_set_thinking_effort` 的 effort：按 ThinkingEffort 值域拒绝其余形状。 */
function parseThinkingEffort(value: unknown): "auto" | "low" | "medium" | "high" {
  if (value === "auto" || value === "low" || value === "medium" || value === "high") return value
  throw Object.assign(new Error("chat_set_thinking_effort 的 effort 只接受 auto/low/medium/high"), {
    code: "CONFIG",
  })
}

/**
 * 思考强度（抽屉「思考」下拉）：写 CONFIG `ai.thinking.effort`（与设置页同键；
 * 没有「默认」项——配置总有值）。
 *
 * 显示收敛由回执后的投影重推承担（见 `AFTER_REPLY_PUSH_METHODS`）。
 */
export async function chatSetThinkingEffort(args: unknown): Promise<void> {
  const effort = parseThinkingEffort((args as { effort?: unknown } | null)?.effort)
  await writeDrawerConfig("ai.thinking.effort", effort)
}

/** `chat_set_safety_mode` 的 mode：按既有三档值域拒绝其余形状。 */
function parseSafetyMode(value: unknown): "just_do_it" | "tell_me" | "let_me_tk" {
  if (value === "just_do_it" || value === "tell_me" || value === "let_me_tk") return value
  throw Object.assign(
    new Error("chat_set_safety_mode 的 mode 只接受 just_do_it/tell_me/let_me_tk"),
    { code: "CONFIG" },
  )
}

/**
 * 安全策略（抽屉「安全」下拉）：写 CONFIG `ai.safety.mode`（与设置页「确认策略」
 * 同键、同值域）。**「回合开始冻结」纪律不变**：改配置仍从下一回合生效
 * （`safety/permission.ts::freezePermissionPolicy`）。
 */
export async function chatSetSafetyMode(args: unknown): Promise<void> {
  const mode = parseSafetyMode((args as { mode?: unknown } | null)?.mode)
  await writeDrawerConfig("ai.safety.mode", mode)
}

/**
 * 回执之后要补投影推送的方法（顺序语义见文件头；其余方法 no-op）。
 *
 * 抽屉三条 CONFIG 写也在列：写盘本身没有领域推送路径，投影不会自行重推 ——
 * 不补推的话抽屉会停在旧档位（选中态与刚写的配置不符）。
 */
const AFTER_REPLY_PUSH_METHODS: ReadonlySet<string> = new Set([
  "chat_request_session_history",
  "chat_set_default_delivery",
  "chat_set_thinking_effort",
  "chat_set_safety_mode",
])

/**
 * 回执已发出后补一次会话侧投影推送（由 `host-requests.ts` 的 `handleEnvelope` 调用）。
 *
 * 只对 `AFTER_REPLY_PUSH_METHODS` 动作：其余 `chat_*` 方法的状态变化由
 * `session-signal` 在领域写路径内驱动推送，无需在这里补。失败只留痕不抛
 * （请求已受理、回执已发；面板会停在旧值直到下一次重推，原因在日志里）。
 */
export async function runChatAfterReplyPush(method: string): Promise<void> {
  if (!AFTER_REPLY_PUSH_METHODS.has(method)) return
  try {
    await pushSessionProjection()
  } catch (error) {
    log.warn(`回执后的投影重推失败（领域写已完成，回执已回）：${formatError(error)}`)
  }
}
