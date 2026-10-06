import type { SceneDef } from "../../../e2e/types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../../host/fake-provider"
import { defineTool, register, createTranscriptTool, executeToolDefinition, transcriptPageTokens, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolResultEntryReader } from "@/services/tool"
import { DEFAULT_CONTEXT_WINDOW, MIN_ADDRESS_PREFIX, MIN_CONTEXT_WINDOW, estimateContextTokens, resolveAddressRef, sliceByTokenBudget } from "@/services/context"
import { getActiveSessionId } from "@/services/session"
import { harnessSlots, resolvePiTurnModel } from "@/services/engine/harness"
import { sessionEntries } from "../../../host/session-entries"
import type { Entry } from "@earendil-works/pi-agent-core"

const BODY = "结果正文需保持可恢复0123456789。".repeat(1000)
let resultEntryId = ""

function toolResultText(entry: Entry): string {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return ""
  return entry.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n")
}

/** 页正文：去掉首行 `[start-end/total]` 头部后的部分 —— 页预算只约束正文，头部是定位信息（不入预算）。 */
function pageBody(content: string): string {
  const breakIndex = content.indexOf("\n")
  if (breakIndex < 0) throw new Error(`分页结果缺少头部行: ${JSON.stringify(content.slice(0, 40))}`)
  return content.slice(breakIndex + 1)
}

export const 工具结果恢复: SceneDef = {
  meta: { caseId: "tool-transcript-recovery", module: "tool-execution", contractId: "te-13",
    description: "生产工具回合把完整结果保留为会话条目，read_session_event 按条目 id（或其唯一前缀）分页回读，页预算 = L0 同份额 token", depth: "deep", suite: "regression", entry: "production",
    tags: ["tool-execution", "compaction", "boundary", "error"] },
  setup: async () => {
    register(defineTool({ id: "test-durable-output", name: "durable_test_output", description: "测试完整工具结果", source: "local", sourceId: "",
      safetyLevel: "SAFE", actionCategory: "fs.read", parameters: { type: "object", properties: {} },
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "allow" },
        execution: { effect: "read", isolation: "shared_read", replay: "never" },
        context: { resultProjection: "reference", historyCompaction: "summarize" },
      },
    }, async () => ({ success: true, content: BODY })))
    installFakeProvider([fakeToolCall("durable_test_output", {}, "durable-call"), fakeText("结果已保存，可以继续。"), fakeText("仍能回查完整结果。")])
  },
  turns: [{ index: 1, description: "长结果经过真实工具循环并落成会话条目", userText: "请调用测试工具读取结果。", checks: [{ type: "expectDurableToolRound", run: async ctx => {
    if (ctx.output.failure || !ctx.output.reply.includes("结果已保存")) throw new Error("长工具结果阻断了正常回复")
    const entries = await sessionEntries()
    const resultEntry = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolCallId === "durable-call")
    if (!resultEntry) throw new Error("会话条目缺少工具结果")
    // 条目是真相源：完整正文没有被请求投影缩短。
    if (toolResultText(resultEntry) !== BODY) throw new Error("工具结果条目没有保留完整正文")
    resultEntryId = resultEntry.id

    // P-1 页预算随窗口单调：页宽是 token 口径（L0 单条结果的同一份额），不再是字符常数
    // （旧实现 64k 以上的所有窗口都得到同一个 8000 字符页宽，窗口完全不参与推导）。
    // 第三个窗口随默认值推导（不能写死：DEFAULT_CONTEXT_WINDOW 调大后写死值会低于默认值，
    // 单调断言按构造必假 —— 2026-10-06 默认值 131_072 → 262_144 时就是这样被打破的）。
    const pageBudgets = [MIN_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW + 100_000].map(window => transcriptPageTokens(window))
    if (!(pageBudgets[0]! < pageBudgets[1]! && pageBudgets[1]! < pageBudgets[2]!)) {
      throw new Error(`页预算不随窗口单调: ${pageBudgets.join(" / ")}`)
    }

    // 回读用生产调用链的那一份：reader 是槽上的 readToolResult（runtime.ts 同款）。
    const windowTokens = resolvePiTurnModel().contextWindow
    const pageTokens = transcriptPageTokens(windowTokens)
    const slot = harnessSlots.peek(getActiveSessionId())
    const tool = createTranscriptTool(entryId => slot ? slot.readToolResult(entryId) : Promise.resolve({ kind: "not_found" } as const), { windowTokens })

    // P-3 回读工具对模型声明 preserve：页本身就是有界投影，请求里不再二次缩短。
    // 不走 getToolByName —— 生产把它 frozenTools.push(createTranscriptTool(...)) 直接进冻结表，从不注册。
    // 级 2 清空的保护由 W3/C-5 覆盖，本点只钉声明与现状。
    if (tool.policy.context.resultProjection !== "preserve") {
      throw new Error(`回读工具的请求投影不是 preserve: ${tool.policy.context.resultProjection}`)
    }

    // 场景前提：正文总量超过页预算，首页必然被预算截断，否则「分页」无从观察。
    if (estimateContextTokens(BODY) <= pageTokens) {
      throw new Error(`正文未超过页预算，分页前提不成立: ${estimateContextTokens(BODY)} <= ${pageTokens}`)
    }

    // 首页：页正文用同一份切分实现（sliceByTokenBudget）推导，offset 是字符下标。
    const firstBody = sliceByTokenBudget(BODY, pageTokens, false)
    const first = await executeToolDefinition(tool, { eventId: resultEntryId }, {})
    if (!first.success || !first.content.startsWith("[0-")) throw new Error(`首页回读失败: ${first.error ?? first.errorCode}`)
    const firstPageBody = pageBody(first.content)
    if (firstPageBody !== firstBody) throw new Error(`首页正文与实现切分不一致: ${firstPageBody.length} vs ${firstBody.length} 字符`)
    // P-2 页正文不超预算（切分与估算同源，这条把「页宽」钉在 token 口径上）。
    if (estimateContextTokens(firstPageBody) > pageTokens) {
      throw new Error(`页正文超出页预算: ${estimateContextTokens(firstPageBody)} > ${pageTokens}`)
    }

    // 续读：offset 由首页长度推导（旧的固定字符页宽常数已删），页正文仍是原文切片。
    const offset = firstBody.length
    const expectedTail = sliceByTokenBudget(BODY.slice(offset), pageTokens, false)
    const page = await executeToolDefinition(tool, { eventId: resultEntryId, offset }, {})
    if (!page.success || !page.content.startsWith(`[${offset}-`) || !page.content.endsWith(expectedTail)) {
      throw new Error("分页结果不可恢复")
    }
    if (estimateContextTokens(pageBody(page.content)) > pageTokens) {
      throw new Error(`续读页正文超出页预算: ${estimateContextTokens(pageBody(page.content))} > ${pageTokens}`)
    }

    const denied = await executeToolDefinition(tool, { eventId: "another-session-event" }, {})
    if (denied.success || denied.errorCode !== "not_found") throw new Error("错误 eventId 未被限定在当前会话")

    // 歧义分支（T2.04 的三态判别）：reader 是 createTranscriptTool 的显式注入缝，这里喂一份由真实
    // 条目 id 派生的「同前缀双条目」集合，让读取端唯一的判定实现 resolveAddressRef 自己判出 ambiguous
    // —— 不手写候选，也不给「任选一条」留后门。会话里真实存在两条同前缀结果的情形由 `地址前缀解析`
    // (te-25) 覆盖，本点只钉工具层对歧义的映射（errorCode + 不带正文）。
    const ambiguousIds = [resultEntryId, `${resultEntryId.slice(0, MIN_ADDRESS_PREFIX)}-sibling`]
    const ambiguousReader: ToolResultEntryReader = async ref => {
      const resolution = resolveAddressRef(ref, ambiguousIds)
      return resolution.kind === "ambiguous"
        ? { kind: "ambiguous", matches: resolution.matches }
        : { kind: "not_found" }
    }
    const ambiguous = await executeToolDefinition(
      createTranscriptTool(ambiguousReader, { windowTokens }),
      { eventId: resultEntryId.slice(0, MIN_ADDRESS_PREFIX) }, {})
    if (ambiguous.success || ambiguous.errorCode !== "ambiguous" || ambiguous.content !== "") {
      throw new Error(`歧义地址没有按 ambiguous 收口: ${ambiguous.errorCode ?? "success"}`)
    }
  } }] }, { index: 2, description: "后续回合继续使用完整工具配对", userText: "继续刚才的话题。", checks: [{ type: "expectToolReplay", run: async ctx => {
    if (ctx.output.failure || !ctx.output.reply.includes("回查")) throw new Error("恢复后的上下文无法继续")
    const entries = await sessionEntries()
    const resultEntry = entries.find(entry => entry.id === resultEntryId)
    if (!resultEntry || toolResultText(resultEntry) !== BODY) throw new Error("请求视图裁剪或压缩修改了会话条目原文")
  } }] }],
}
export default 工具结果恢复
