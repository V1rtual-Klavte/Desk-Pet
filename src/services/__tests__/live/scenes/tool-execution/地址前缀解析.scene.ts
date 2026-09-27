import type { SceneDef } from "../../types"
import type { Entry } from "@earendil-works/pi-agent-core"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { MIN_ADDRESS_PREFIX, estimateContextTokens, isUniqueAddressRef, resolveAddressRef, shortenAddresses, toolResultTokenBudget } from "@/services/context"
import { TOOL_POLICY_VERSION, createTranscriptTool, defineTool, executeToolDefinition, register, unregister } from "@/services/tool"
import { harnessSlots, resolvePiTurnModel } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session"
import { sessionEntries } from "../../session-entries"

/**
 * 地址前缀唯一性解析（te-25；A-3 / A-4 / A-5 的本波验证面）。
 *
 * 三个探针在**同一回合**里被真实驱动，结果都短于 L0 阈值（顺带覆盖短结果面）：
 * 地址解析的对象因此是生产链写出的真实条目 id，而不是场景捏造的一串字符。
 *
 * 断言分四组：
 * - A-3 唯一：槽上 `addressRefs()` 给出的前缀（是 id 的真前缀、不短于 `MIN_ADDRESS_PREFIX`）
 *   经 `read_session_event` 能读回同一条结果的中部标记，且请求视图里发出去的正是这个前缀
 *   （不是完整 36 位 id —— 地址是「最短唯一前缀」这件事只有模型侧可见才算落地）；
 * - A-3 歧义：用真实 id 全集里**最短的不唯一前缀**作引用时，读取端判 `ambiguous`（候选 ≥ 2）
 *   并且**绝不任选** —— 槽侧不出 `entryId`、工具侧 `success=false` + `errorCode="ambiguous"`
 *   且正文为空，错误文案只列候选 id、不含任何一条结果的内容；
 * - A-4 完整 id 恒可读：完整条目 id 判 `exact`（精确命中优先于前缀扫描），并读回全文；
 *   同时钉住下界是**含** `MIN_ADDRESS_PREFIX` 的闭区间（恰达下界且唯一 → `unique`，
 *   短于下界 → `none`，不参与前缀匹配）；
 * - A-5 本波面：前缀计算只吃 id 字符串集合 —— 顺序反转、重复给出都得到逐字相同的结果，
 *   槽上的目录与纯函数结果一致（地址是 id 集合的函数，不是行布局/序号的函数），
 *   并且真实会话 `close()` → `ensure()`/`open()` 重开后地址目录逐字不变。
 *
 * 边界与归宿：A-5 的最终归宿是 W5 的 X-1（折叠实施之后的整链断言），本点只证明
 * 「前缀计算对折叠不敏感」这一半 —— 折叠只删已 delete key 的行、不改 id/seq，而地址函数
 * 的输入里本来就只有 id。歧义用例按真实数据取最短不唯一前缀（uuidv7 同回合批量创建时
 * 公共前缀远长于下界）；若真实数据里连一条达到下界的不唯一前缀都找不到，直接判失败而不是
 * 退化成合成集合，避免「场景悄悄不再覆盖歧义」。
 *
 * 本点不覆盖：歧义文案的候选截断（最多 3 条 + 「等 N 条」收口）需要 4 条以上同前缀候选，
 * 真实会话里造不出，由 T2.04 的直接探针举证。
 */

const REPLY = "三份探针结果都回来了。"

/** 探针工具名 / 调用 id / 各自独有的中部标记（正文很短，远低于任何窗口的 L0 阈值）。 */
const PROBES = [
  { tool: "address_probe_alpha", call: "address-probe-alpha", marker: "甲号探针中段标记" },
  { tool: "address_probe_beta", call: "address-probe-beta", marker: "乙号探针中段标记" },
  { tool: "address_probe_gamma", call: "address-probe-gamma", marker: "丙号探针中段标记" },
]

function probeBody(marker: string): string {
  return `探针正文开头。${marker}。探针正文结尾。`
}

function toolResultText(entry: Entry): string {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return ""
  return entry.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n")
}

function payloadToolTexts(messages: readonly unknown[]): Map<string, string> {
  const texts = new Map<string, string>()
  for (const raw of messages) {
    const message = raw as { role?: string; toolName?: string; content?: unknown }
    if (message.role !== "toolResult" || typeof message.toolName !== "string") continue
    const content = Array.isArray(message.content)
      ? message.content.map(part => {
        const block = part as { type?: string; text?: string }
        return block?.type === "text" ? String(block.text ?? "") : ""
      }).join("\n")
      : String(message.content ?? "")
    texts.set(message.toolName, content)
  }
  return texts
}

/**
 * 在真实 id 全集里找**最短的不唯一前缀**：从 `MIN_ADDRESS_PREFIX` 起逐字符加长，直到
 * `resolveAddressRef` 判歧义。不另写一份前缀比较（那会让场景与实现各有一套语义），
 * 也保证找到的引用天然满足下界（下界以内的前缀在读取端一律按 `none` 处理）。
 */
function shortestAmbiguousRef(ids: readonly string[]): string {
  for (const id of ids) {
    for (let length = MIN_ADDRESS_PREFIX; length < id.length; length += 1) {
      const ref = id.slice(0, length)
      if (resolveAddressRef(ref, ids).kind === "ambiguous") return ref
    }
  }
  throw new Error(`真实会话的 ${ids.length} 条工具结果 id 之间找不到达到下界的不唯一前缀，歧义面无从断言`)
}

let provider: ReturnType<typeof installFakeProvider> | undefined
const registeredIds: string[] = []

/** 带该工具结果的最后一次请求：尾随的一次性调用不参与判定。 */
function lastPayloadText(toolName: string): string | undefined {
  const payloads = provider?.payloads ?? []
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const texts = payloadToolTexts(payloads[index]!.messages)
    if (texts.has(toolName)) return texts.get(toolName)
  }
  return undefined
}

export const 地址前缀解析: SceneDef = {
  meta: {
    caseId: "tool-address-prefix-resolution",
    module: "tool-execution",
    contractId: "te-25",
    description: "三份短结果留下真实条目：唯一前缀可回读、不唯一前缀报歧义且绝不任选、完整 id 恒可读，地址对身份集合之外的形态（顺序、重数、行布局）不敏感",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["tool-execution", "boundary", "error"],
  },
  setup: async () => {
    for (const probe of PROBES) {
      const tool = defineTool({
        id: `live-${probe.call}`,
        name: probe.tool,
        description: `地址前缀探针：${probe.marker}`,
        parameters: { type: "object", properties: {} },
        source: "local",
        sourceId: "",
        safetyLevel: "SAFE",
        actionCategory: "fs.read",
        policy: {
          version: TOOL_POLICY_VERSION,
          permission: { defaultDecision: "allow" },
          execution: { effect: "read", isolation: "shared_read", replay: "never" },
          // 与 T2.07 的短结果探针同口径（`reference` + 远低于 L0 阈值的正文）：未超阈值时
          // 投影只加地址尾行、不改正文，地址面因此不掺缩短行为。
          context: { resultProjection: "reference", historyCompaction: "summarize" },
        },
      }, async () => ({ success: true, content: probeBody(probe.marker) }))
      register(tool)
      registeredIds.push(tool.id)
    }
    provider = installFakeProvider([
      ...PROBES.map(probe => fakeToolCall(probe.tool, {}, probe.call)),
      fakeText(REPLY),
    ])
  },
  turns: [{
    index: 1,
    description: "三份短结果落成真实条目后，用前缀、歧义前缀与完整 id 分别回读",
    userText: "把三个地址探针都跑一遍。",
    checks: [{
      type: "expectAddressPrefixResolution",
      run: async ctx => {
        try {
          if (ctx.output.failure) throw new Error(`回合失败: ${JSON.stringify(ctx.output.failure)}`)
          if (!ctx.output.reply.includes(REPLY)) throw new Error("回合没有被真实驱动到脚本回复")

          // 探针真的执行过：地址解析的对象必须是生产链写出的真实结果条目。
          for (const probe of PROBES) {
            const call = ctx.toolHistory.find(item => item.toolName === probe.tool)
            if (!call || call.status !== "done") throw new Error(`探针没有被执行: ${probe.tool}`)
          }

          const entries = await sessionEntries()
          const probes = PROBES.map(probe => {
            const entry = entries.find(item => item.type === "message" && item.message.role === "toolResult"
              && item.message.toolCallId === probe.call)
            if (!entry || entry.type !== "message") throw new Error(`会话条目缺少探针结果: ${probe.tool}`)
            const text = toolResultText(entry)
            if (!text.includes(probe.marker)) throw new Error(`条目正文缺少中部标记: ${probe.tool}`)
            return { ...probe, entryId: entry.id, text }
          })
          const probeIds = probes.map(probe => probe.entryId)
          if (new Set(probeIds).size !== probeIds.length) throw new Error("探针条目 id 有重复，前缀场景的前提不成立")

          const sessionId = getActiveSessionId()
          const slot = harnessSlots.peek(sessionId)
          if (!slot) throw new Error("当前会话没有运行槽，地址读取端不可用")
          const windowTokens = resolvePiTurnModel().contextWindow
          // 回读走生产调用链的那一份：reader 是槽上的 readToolResult（runtime.ts 同款）。
          const tool = createTranscriptTool(ref => slot.readToolResult(ref), { windowTokens })

          // 场景前提：三份结果都短于 L0 阈值（本点不测缩短，只测地址）。
          for (const probe of probes) {
            const body = probeBody(probe.marker)
            if (estimateContextTokens(body) > toolResultTokenBudget(windowTokens)) {
              throw new Error(`探针结果超过 L0 阈值，短结果前提不成立: ${probe.tool}`)
            }
          }

          // ① A-3 唯一：槽上的前缀是 id 的真前缀、不短于下界，且能读回同一条结果。
          const refs = await slot.addressRefs()
          const allIds = [...refs.keys()]
          for (const probe of probeIds) {
            if (!allIds.includes(probe)) throw new Error(`地址目录缺少条目: ${probe}`)
          }
          const pure = shortenAddresses(allIds)
          for (const probe of probes) {
            const ref = refs.get(probe.entryId)
            if (ref === undefined) throw new Error(`地址目录缺少前缀: ${probe.entryId}`)
            if (!probe.entryId.startsWith(ref)) throw new Error(`地址不是条目 id 的前缀: ${ref}`)
            if (ref.length < MIN_ADDRESS_PREFIX) throw new Error(`地址短于下界 ${MIN_ADDRESS_PREFIX}: ${ref}`)
            if (!isUniqueAddressRef(ref, probe.entryId, allIds)) throw new Error(`地址在当次 id 全集里不唯一: ${ref}`)
          }
          const alpha = probes[0]!
          const alphaRef = refs.get(alpha.entryId)!
          const uniquePage = await executeToolDefinition(tool, { eventId: alphaRef }, {})
          if (!uniquePage.success) throw new Error(`唯一前缀没能回读: ${uniquePage.error ?? uniquePage.errorCode}`)
          if (!uniquePage.content.includes(alpha.marker)) throw new Error(`唯一前缀读回的不是这条结果: ${alphaRef}`)
          // 发出的地址就是模型侧看到的形态：请求里是前缀而不是完整条目 id（旧口径已被前缀取代）。
          const view = lastPayloadText(alpha.tool)
          if (view === undefined) throw new Error(`请求视图缺少探针结果: ${alpha.tool}`)
          if (!view.includes(alphaRef)) throw new Error(`请求视图没有带出这个前缀地址: ${alphaRef}`)
          if (view.includes(alpha.entryId)) throw new Error(`请求视图里发出的是完整条目 id，不是最短唯一前缀: ${alpha.entryId}`)

          // ② A-3 歧义：最短的不唯一前缀必须明确报错，且任何一侧都不许任选一条当结果。
          const ambiguousRef = shortestAmbiguousRef(allIds)
          if (ambiguousRef.length < MIN_ADDRESS_PREFIX) throw new Error(`歧义引用短于下界: ${ambiguousRef}`)
          const resolution = resolveAddressRef(ambiguousRef, allIds)
          if (resolution.kind !== "ambiguous") throw new Error(`前缀不唯一却没有判歧义: ${ambiguousRef}`)
          if (resolution.matches.length < 2) throw new Error(`歧义候选不足两条: ${JSON.stringify(resolution.matches)}`)
          for (const match of resolution.matches) {
            if (!allIds.includes(match)) throw new Error(`歧义候选不是当次全集里的条目: ${match}`)
          }
          const ambiguousLookup = await slot.readToolResult(ambiguousRef)
          if (ambiguousLookup.kind !== "ambiguous") throw new Error(`槽侧没有按歧义处理: ${ambiguousRef}`)
          if (ambiguousLookup.matches.length < 2) throw new Error("槽侧歧义没有给出候选")
          const ambiguousPage = await executeToolDefinition(tool, { eventId: ambiguousRef }, {})
          if (ambiguousPage.success) throw new Error(`歧义引用竟然读出了结果: ${ambiguousRef}`)
          if (ambiguousPage.errorCode !== "ambiguous") throw new Error(`歧义错误码不是 ambiguous: ${ambiguousPage.errorCode}`)
          if (ambiguousPage.content !== "") throw new Error("歧义路径带回了正文（任意选了一条候选的迹象）")
          const errorText = ambiguousPage.error ?? ""
          for (const match of resolution.matches.slice(0, 2)) {
            if (!errorText.includes(match)) throw new Error(`歧义文案没有列全候选: ${errorText}`)
          }
          for (const probe of probes) {
            if (errorText.includes(probe.marker)) throw new Error(`歧义文案里出现了结果内容: ${errorText}`)
          }

          // ③ A-4 完整 id 恒可读：精确命中优先，且按 id 原样读回该条正文。
          const exact = resolveAddressRef(alpha.entryId, allIds)
          if (exact.kind !== "exact" || exact.id !== alpha.entryId) throw new Error(`完整 id 没有精确命中: ${alphaRef}`)
          const exactLookup = await slot.readToolResult(alpha.entryId)
          if (exactLookup.kind !== "found" || exactLookup.entryId !== alpha.entryId) throw new Error("完整 id 没有按原 id 读回")
          if (!exactLookup.text.includes(alpha.marker)) throw new Error("完整 id 读回的不是这条结果")
          const exactPage = await executeToolDefinition(tool, { eventId: alpha.entryId }, {})
          if (!exactPage.success || !exactPage.content.includes(alpha.marker)) throw new Error("完整 id 经工具读回失败")
          // 「精确优先于前缀扫描」需要一条能把 id 变成别条 id 前缀的输入才可辨，真实 uuid 里造不出，
          // 故用合成 id 集合直接喂纯函数（不碰会话、不依赖 id 形态）：完整 id 仍判 exact。
          const synthetic = [alpha.entryId, `${alpha.entryId}-x`]
          const syntheticExact = resolveAddressRef(alpha.entryId, synthetic)
          if (syntheticExact.kind !== "exact") throw new Error("完整 id 被前缀扫描抢走了精确判定")

          // ④ 前缀下界：短于下界不参与匹配（槽侧与工具侧都不能偶然命中）；恰达下界且唯一则受理。
          const belowBound = alpha.entryId.slice(0, MIN_ADDRESS_PREFIX - 1)
          if (resolveAddressRef(belowBound, allIds).kind !== "none") throw new Error(`短于下界的引用被受理: ${belowBound}`)
          const shortLookup = await slot.readToolResult(belowBound)
          if (shortLookup.kind !== "not_found") throw new Error(`短于下界的引用在槽侧没有判未命中: ${belowBound}`)
          const shortPage = await executeToolDefinition(tool, { eventId: belowBound }, {})
          if (shortPage.success || shortPage.errorCode !== "not_found") throw new Error("短于下界的引用经工具读回不成立")
          const emptyPage = await executeToolDefinition(tool, { eventId: "" }, {})
          if (emptyPage.success || emptyPage.errorCode !== "not_found") throw new Error("空引用没有被判未命中")
          const atBound = alpha.entryId.slice(0, MIN_ADDRESS_PREFIX)
          const atBoundResolution = resolveAddressRef(atBound, [alpha.entryId])
          if (atBoundResolution.kind !== "unique" || atBoundResolution.id !== alpha.entryId) {
            throw new Error(`下界 ${MIN_ADDRESS_PREFIX} 是闭区间，恰达下界且唯一时应收: ${atBound}`)
          }

          // ⑤ A-5 本波面：前缀只是 id 集合的函数 —— 顺序、重数、以及「目录缓存」都不改变它。
          const reversed = shortenAddresses([...allIds].reverse())
          const doubled = shortenAddresses([...allIds, ...allIds])
          for (const id of allIds) {
            if (reversed.get(id) !== pure.get(id)) throw new Error(`地址随 id 输入顺序变化: ${id}`)
            if (doubled.get(id) !== pure.get(id)) throw new Error(`地址随 id 重数变化: ${id}`)
            if (refs.get(id) !== pure.get(id)) throw new Error(`槽上目录与纯函数结果不一致: ${id}`)
          }

          // 会话关闭重开：条目从盘上重读，地址仍逐字相同（折叠只删行、不改 id）。
          const before = new Map(refs)
          await slot.close()
          await harnessSlots.ensure(sessionId).open()
          const after = await harnessSlots.ensure(sessionId).addressRefs()
          if (after.size !== before.size) throw new Error(`重开后地址目录规模变化: ${after.size} vs ${before.size}`)
          for (const [id, ref] of before) {
            if (after.get(id) !== ref) throw new Error(`重开后地址变化: ${id} ${ref} → ${after.get(id)}`)
          }
        } finally {
          for (const id of registeredIds.splice(0)) unregister(id)
        }
      },
    }],
  }],
}

export default 地址前缀解析
