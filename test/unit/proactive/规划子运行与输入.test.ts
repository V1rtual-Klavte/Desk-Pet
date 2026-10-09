// ==========================================
// 规划子运行 —— 白名单工具装配、有界参数与规划输入补齐
// ==========================================
//
// 归属 L2：被测对象是 planner.ts 的装配与序列化逻辑（工具按注册名检索并复核等级、
// 注入 run 的入参封顶、task JSON 的字段与预算），不启真 loop、不落盘、不连 Provider。
// `plan()` 的 run/beforeProvider 本来就是注入参数（scanner 的 adapters.runPlanner 是生产注入点），
// 这里用同一注入点捕获入参。
//
// caseId 归 proactive/pr-12（test/contracts/proactive.contract.ts）。
import { afterEach, describe, expect, it, vi } from "vitest"
import { plan, plannerTools, planningInput } from "@/services/proactive/planner"
import { PLANNING_OUTPUT_RESERVE, PLANNING_PERSONA_BUDGET, PLANNING_TIMEOUT_MS, PLANNING_VARIABLE_BUDGET } from "@/services/proactive/config"
import { estimateContextTokens } from "@/services/context"
import { opportunity } from "@/services/proactive/opportunities"
import { register, unregister } from "@/services/tool/registry"
import { defineTool } from "@/services/tool/policy"
import { TOOL_POLICY_VERSION } from "@/services/tool/types"
import type { EffectClass, SafetyLevel, ToolDef, ToolIsolation } from "@/services/tool/types"
import type { SchedulerAdapters } from "@/services/proactive/scanner"
import type { ProactiveOwner } from "@/services/proactive/types"

/** module 级替换数据：工厂在 import 之前被提升，状态经 vi.hoisted 共享。 */
const mocks = vi.hoisted(() => ({
  card: null as unknown,
  pool: { system: {}, card: {}, interaction: {} } as unknown,
  presence: { state: "idle", reason: "default", changedAt: 0, expiresAt: null } as unknown,
  behavior: null as unknown,
  memoryEnabled: true,
  recallMemory: vi.fn(async (_request: { sessionId: string; cardId: string; targets: unknown }) => [] as unknown[]),
}))

vi.mock("@/services/personality", () => ({
  getActiveCard: () => mocks.card,
  getPoolSnapshot: () => mocks.pool,
}))
vi.mock("@/services/behavior", () => ({ getBehaviorSnapshot: () => mocks.behavior }))
vi.mock("@/services/proactive/presence", () => ({ getPresence: () => mocks.presence }))
// 记忆总闸可翻转，且不落到真实 provider：recallMemory 只经替身计数。
vi.mock("@/services/config", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/config")>()
  return {
    ...actual,
    memoryConfig: { ...actual.memoryConfig, get enabled() { return mocks.memoryEnabled } },
  }
})
vi.mock("@/services/agent/memory", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/agent/memory")>()
  return { ...actual, recallMemory: mocks.recallMemory }
})

type PlannerRun = SchedulerAdapters["runPlanner"]
type PlannerRunInput = Parameters<PlannerRun>[0]
type PlannerRunOutput = Awaited<ReturnType<PlannerRun>>

const owner: ProactiveOwner = { sessionId: "session-plan", cardId: "card-plan", cardHash: "hash-plan", runGeneration: 9 }
const stubInput = { task: '{"now":1}', projections: [] } as Awaited<ReturnType<typeof planningInput>>

const registeredIds: string[] = []

/** 测试替身工具：只声明策略需要的字段。effect 固定 read，只让 isolation 变化。 */
function stubTool(name: string, level: SafetyLevel, isolation: ToolIsolation = "shared_read", effect: EffectClass = "read"): ToolDef {
  const id = `test-stub-${name}`
  return defineTool({
    id, name, description: `测试替身 ${name}`,
    parameters: { type: "object", properties: {}, required: [] },
    safetyLevel: level, source: "local", sourceId: "", actionCategory: "os.info",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect, isolation, replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async () => ({ success: true, content: "" }))
}

function useTools(...tools: ToolDef[]): void {
  for (const tool of tools) {
    register(tool)
    registeredIds.push(tool.id)
  }
}

/** 能力探测失败的替身（生产缺省探测在模型/窗口不可解析时走同一抛错路径）。 */
function probeUnavailable(): boolean {
  throw new Error("测试替身：模型不可解析")
}

afterEach(() => {
  for (const id of registeredIds.splice(0)) unregister(id)
  mocks.card = null
  mocks.behavior = null
  mocks.presence = { state: "idle", reason: "default", changedAt: 0, expiresAt: null }
  mocks.pool = { system: {}, card: {}, interaction: {} }
  mocks.memoryEnabled = true
  mocks.recallMemory.mockClear()
})

describe("规划子运行的工具装配", () => {
  it("白名单按注册名取工具且只放行 SAFE；DANGER/派生型/名单外工具不进场 [proactive-planner-tool-whitelist]", () => {
    useTools(
      stubTool("screenshot", "SAFE"),
      stubTool("window_info", "SAFE"),
      stubTool("system_info", "SAFE"),
      // 名单外工具：即便声明 SAFE 也不进（只读白名单是显式名单，不是「所有 SAFE 工具」）。
      stubTool("clipboard_read", "SAFE"),
      // DANGER 与 delegate：无用户回合会等确认、派生型不属于规划子运行。
      stubTool("bash", "DANGER"),
      stubTool("agent_spawn", "SAFE", "delegate"),
    )
    expect(plannerTools(() => true).map(tool => tool.name)).toEqual(["screenshot", "window_info", "system_info"])
  })

  it("白名单工具等级被改成 DANGER 时整件跳过，不把确认等待带进后台子运行 [proactive-planner-tool-level-guard]", () => {
    useTools(
      stubTool("screenshot", "SAFE"),
      stubTool("window_info", "DANGER"),
      stubTool("system_info", "SAFE"),
    )
    expect(plannerTools(() => true).map(tool => tool.name)).toEqual(["screenshot", "system_info"])
  })

  it("截图工具按辅助模型的模态声明装配：文本模型与探测失败都不含，声明图像输入才含 [proactive-planner-screenshot-model-gate]", () => {
    useTools(
      stubTool("screenshot", "SAFE"),
      stubTool("window_info", "SAFE"),
      stubTool("system_info", "SAFE"),
    )
    // 文本模型：截图的结果带图片块，回灌 provider 会失败，整件不发（其余两件照常可用）。
    expect(plannerTools(() => false).map(tool => tool.name), "文本模型下截图工具仍进了白名单").toEqual(["window_info", "system_info"])
    // 能力探测失败（生产缺省在模型/窗口不可解析时抛错）与文本模型同处理：不因探测阻塞规划。
    expect(plannerTools(probeUnavailable).map(tool => tool.name),
      "探测失败时截图工具仍进了白名单").toEqual(["window_info", "system_info"])
    // 声明图像输入：截图工具回到白名单（顺序与白名单常量一致）。
    expect(plannerTools(() => true).map(tool => tool.name), "声明图像输入时截图工具没有进白名单").toEqual(["screenshot", "window_info", "system_info"])
  })
})

describe("规划子运行的运行参数", () => {
  it("注入 run 的调用带白名单工具面与封顶参数；工具预算为 3 次 [proactive-planner-run-bounds]", async () => {
    // 只注册两件无条件工具：截图工具的进出由模型能力闸决定（下一个用例注入断言），
    // 这里钉「装配结果真的进了 run 的入参」，不受本机配置模型影响。
    useTools(stubTool("window_info", "SAFE"), stubTool("system_info", "SAFE"))
    const captured: PlannerRunInput[] = []
    const signal = new AbortController().signal
    const run: PlannerRun = async input => {
      captured.push(input)
      return { reply: JSON.stringify({ kind: "decline", reason: "没有依据", intent: "" }), toolCallsMade: 1, success: true }
    }
    const result = await plan(stubInput, owner, 1_700_000_000_000, signal, () => true, run, async () => true)

    expect(captured).toHaveLength(1)
    const call = captured[0]!
    expect(call.tools.map(tool => tool.name)).toEqual(["window_info", "system_info"])
    expect(call.maxRounds).toBe(3)
    expect(call.timeoutMs).toBe(PLANNING_TIMEOUT_MS)
    expect(call.maxOutputTokens).toBe(PLANNING_OUTPUT_RESERVE)
    expect(call.disableAutomaticCompaction).toBe(true)
    // 取消纪律接线：owner 身份与调用方的取消信号进 scope，owner/来源失效随信号级联。
    expect(call.scope?.sessionId).toBe(owner.sessionId)
    expect(call.scope?.runGeneration).toBe(owner.runGeneration)
    expect(call.scope?.signal).toBe(signal)
    // 文案口径：规划器可用只读工具，但最终只输出同一份 JSON。
    expect(call.systemPrompt).toContain("只读工具")
    expect(call.systemPrompt).toContain("只输出JSON")
    expect(call.systemPrompt).not.toContain("不能执行工具")
    expect(result.kind).toBe("decline")
  })

  it("owner 失效或取消时以 decline 收口，不把无效运行的输出当决策 [proactive-planner-cancel-decline]", async () => {
    const okOutput: PlannerRunOutput = { reply: JSON.stringify({ kind: "speak_now", reason: "有依据", intent: "打个招呼" }), toolCallsMade: 0, success: true }
    const run: PlannerRun = async () => okOutput

    const stale = await plan(stubInput, owner, 1_700_000_000_000, new AbortController().signal, () => false, run, async () => true)
    expect(stale.kind).toBe("decline")
    expect(stale.reason).toBe("planning_cancelled")

    const controller = new AbortController()
    controller.abort(new Error("owner_changed"))
    const aborted = await plan(stubInput, owner, 1_700_000_000_000, controller.signal, () => true, run, async () => true)
    expect(aborted.kind).toBe("decline")
    expect(aborted.reason).toBe("planning_cancelled")
  })

  it("工具用尽后仍未产出合法 JSON 时按既有 planner_invalid_decision decline [proactive-planner-tool-exhausted-decline]", async () => {
    const captured: PlannerRunInput[] = []
    // 模拟内核工具预算用尽后的终态：完成但正文不是决策 JSON（runPiSubAgent 会回落到「无结果」文案）。
    const run: PlannerRun = async input => {
      captured.push(input)
      return { reply: "子代理没有返回结果", toolCallsMade: input.maxRounds ?? 0, success: true }
    }
    const result = await plan(stubInput, owner, 1_700_000_000_000, new AbortController().signal, () => true, run, async () => true)
    expect(captured[0]?.maxRounds).toBe(3)
    expect(result.kind).toBe("decline")
    expect(result.reason).toBe("planner_invalid_decision")
  })
})

describe("规划输入补齐", () => {
  const reliable = {
    measurementVersion: 2, revision: 3, generatedAt: 0,
    quality: { status: "reliable", sampleDays: 5, coverageRatio: 0.9, eligibleCollectionMs: 1000, reasons: [] },
    apps: { categoryShare: {}, commonAppIds: [], unknownRatio: 0, classificationRatio: 1, classifiedMs: 1000, unclassifiedMs: 0 },
    focus: { segments: 0, totalMs: 0, longestMs: 0, meanMs: 0, switchesPerHour: 0, currentContinuousMs: 0, currentCategory: null },
    activity: { byHour: Array(24).fill(0), activeMs: 0, idleMs: 0, unknownMs: 0, unobservedMs: 0, petForegroundMs: 0 },
    rhythm: {
      weekdays: Array.from({ length: 24 }, (_, hour) => 100 + hour),
      weekends: Array.from({ length: 24 }, (_, hour) => 200 + hour),
      days7: 5, days30: 30,
    },
    weekly: {
      days: 5,
      focus: { segments: 0, totalMs: 0, longestMs: 0, meanMs: 0, switchesPerHour: 0, coveredMs: 0 },
      activity: { byHour: Array(24).fill(0), activeMs: 0, idleMs: 0, unknownMs: 0, unobservedMs: 0, petForegroundMs: 0 },
    },
  }

  function fillSources(): void {
    mocks.card = {
      id: "card-1", name: "糖糖", description: "一只桌宠",
      sections: { roleSetting: "角色设定的长文".repeat(200), languageStyle: "语气轻盈，句子短", outputRules: "", whenText: "", mustRules: {}, variableDefs: [] },
    }
    mocks.pool = {
      system: { hour: 14, minute: 30, isWeekend: false },
      card: { favor: { value: 7, type: "number", updatedAt: 1, updatedBy: "llm" } },
      interaction: { mood: { value: "轻快", type: "string", updatedAt: 2, updatedBy: "system" } },
    }
    mocks.presence = { state: "working", reason: "continuous_work_context", changedAt: 123_456_789, expiresAt: null }
    mocks.behavior = reliable
  }

  it("人设/画像/presence/变量/本地时间进 task，且人设与变量摘要按 token 预算截断 [proactive-planner-input-context]", async () => {
    fillSources()
    // 周一本地 14:30（与实现同一时区口径：Date 本地时间与 zonedParts 一致）。
    const weekday = new Date(2026, 9, 5, 14, 30, 0).getTime()
    const input = await planningInput(
      [opportunity(owner, "rhythm", "slot-1", [], weekday - 1000, weekday + 10 * 60_000, 50, "机会上下文")],
      owner, weekday, new AbortController().signal,
    )
    const task = JSON.parse(input.task) as Record<string, never> & {
      localTime: string; card: string; variables: string
      presence: { state: string; changedAt: number }
      behavior: { quality: { status: string }; rhythm: { dayType: string; localHour: number; activeMs: { previous: number; current: number; next: number } } }
      opportunities: unknown[]
    }
    // 可读本地时间：不硬编码机器时区名（随运行环境不同），只钉住可读形态与本地钟点。
    expect(task.localTime).toMatch(/^2026-10-05 周一 14:30 \(.+\)$/)
    expect(task.presence).toMatchObject({ state: "working", changedAt: 123_456_789 })
    expect(task.card).toContain("糖糖")
    expect(task.card.length, "整份 Card 不应进规划输入").toBeLessThan(800)
    expect(estimateContextTokens(task.card), "人设摘要超 token 预算").toBeLessThanOrEqual(PLANNING_PERSONA_BUDGET)
    expect(task.variables).toContain("hour=14")
    expect(task.variables).toContain("favor=7")
    expect(task.variables).toContain('mood="轻快"')
    expect(task.variables, "变量只读摘要不应带写入指令或 VariableState 元数据").not.toContain("updatedBy")
    expect(estimateContextTokens(task.variables), "变量摘要超 token 预算").toBeLessThanOrEqual(PLANNING_VARIABLE_BUDGET)
    expect(task.behavior.quality.status).toBe("reliable")
    // 就近小时取当天类型（工作日）的序列，且只给相邻三格而不是整条数组。
    expect(task.behavior.rhythm).toMatchObject({ dayType: "weekday", localHour: 14, activeMs: { previous: 113, current: 114, next: 115 } })
    expect(task.opportunities).toHaveLength(1)
  })

  it("周末取 weekends 序列；没有激活 Card 时人设为 null 而不是整次输入失败 [proactive-planner-input-weekend]", async () => {
    fillSources()
    mocks.card = null
    const sunday = new Date(2026, 9, 4, 12, 0, 0).getTime()
    const input = await planningInput([], owner, sunday, new AbortController().signal)
    const task = JSON.parse(input.task) as { card: null; behavior: { rhythm: { dayType: string; localHour: number; activeMs: { current: number } } } }
    expect(task.card).toBeNull()
    expect(task.behavior.rhythm.dayType).toBe("weekend")
    expect(task.behavior.rhythm.localHour).toBe(12)
    expect(task.behavior.rhythm.activeMs.current).toBe(212)
  })

  it("画像/Card/变量池/presence 缺失或结构缺字段时整块按空降级，规划输入不因缺件抛错 [proactive-planner-input-degraded]", async () => {
    // 全部来源缺失（无 Card、无画像快照、无变量池、无 presence）：各块为 null，本地时间照常。
    mocks.card = null
    mocks.behavior = null
    mocks.pool = null
    mocks.presence = null
    const now = new Date(2026, 9, 5, 12, 0, 0).getTime()
    const input = await planningInput([], owner, now, new AbortController().signal)
    const task = JSON.parse(input.task) as { card: null; behavior: null; variables: null; presence: null; localTime: string }
    expect(task.card).toBeNull()
    expect(task.behavior).toBeNull()
    expect(task.variables).toBeNull()
    expect(task.presence).toBeNull()
    expect(task.localTime).toMatch(/^2026-10-05 周一 12:00 \(.+\)$/)

    // 有画像但结构缺 rhythm：rhythm 段为 null，quality 仍在，整体仍是可判输入。
    mocks.behavior = { measurementVersion: 2, revision: 1, quality: { status: "insufficient", sampleDays: 0, coverageRatio: 0, eligibleCollectionMs: 0, reasons: ["no_eligible_collection_time"] } }
    const partial = JSON.parse((await planningInput([], owner, now, new AbortController().signal)).task) as
      { behavior: { quality: { status: string }; rhythm: null } }
    expect(partial.behavior.quality.status).toBe("insufficient")
    expect(partial.behavior.rhythm).toBeNull()
  })

  it("记忆总闸关闭时目标记忆不召回、evidence 按空降级而不是报错 [proactive-planner-memory-gate]", async () => {
    const now = new Date(2026, 9, 5, 12, 0, 0).getTime()
    const target = opportunity(owner, "memory_checkin", "slot-mem", [], now - 1000, now + 10 * 60_000, 90, "跟进目标", true, [{ id: "mem-1", version: 2 }])

    mocks.memoryEnabled = false
    const closed = await planningInput([target], owner, now, new AbortController().signal)
    expect(mocks.recallMemory, "记忆总闸关闭时仍发起了目标召回").not.toHaveBeenCalled()
    expect(closed.projections).toEqual([])
    expect((JSON.parse(closed.task) as { opportunities: unknown[] }).opportunities).toHaveLength(1)

    mocks.memoryEnabled = true
    await planningInput([target], owner, now, new AbortController().signal)
    expect(mocks.recallMemory).toHaveBeenCalledTimes(1)
    const request = mocks.recallMemory.mock.calls[0]?.[0] as { sessionId: string; cardId: string; targets: unknown }
    expect(request.sessionId).toBe(owner.sessionId)
    expect(request.cardId).toBe(owner.cardId)
    expect(request.targets).toEqual([{ id: "mem-1", version: 2 }])
  })
})
