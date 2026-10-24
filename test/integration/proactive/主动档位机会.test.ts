// ==========================================
// 主动档位机会 —— 默认卡数值跨过 proactiveBands 档位时，scanner 的变量提交分支真的形成机会。
// ==========================================
//
// 归属 L3（不是 L2）的理由：被测对象是 `@/services/proactive/scanner` 的变量提交回调，
// 它经 session/registry 与真实 stages 落盘（变量池提交事件）工作，属运行时接线而非纯逻辑；
// 本用例不驱动 Provider 与回合，fake / 真实模型都不参与。
//
// 这道回归的由来：Card 行内数组曾一律解析成字符串数组，buildVarDef 以
// `typeof value === "number"` 拒绝并把 proactiveBands 整条丢掉，scanner 的
// `!proactiveBands?.length` 于是恒真 —— 修复前本用例拿不到任何 variable_change 机会。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"
import { internalScheduler } from "@/services/scheduler"

const observed = vi.hoisted(() => ({
  /** scanner 真正下发到机会构造器的 variable_change 槽位（`变量名:档位下标:当地日`）。 */
  variableSlots: [] as string[],
  /** tick 进入扫描流程的次数：作为「变量提交回调已跑完」的同步信号（回调末尾会 enqueueTick）。 */
  reconcileCalls: 0,
  /** scanner 注册到变量池的提交观察者：用于注入 system/跨 Card 等真实写路径难以构造的事件。 */
  commitListeners: [] as Array<(event: never) => void>,
}))

// 观测点：scanner 内部调用 `opportunity()` 构造机会。替身记录参数后委托真实实现，
// 不改变产品行为 —— 机会对象仍由真实构造器产出。
vi.mock("@/services/proactive/opportunities", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/proactive/opportunities")>()
  return {
    ...actual,
    opportunity: (...args: Parameters<typeof actual.opportunity>) => {
      if (args[1] === "variable_change") observed.variableSlots.push(args[2])
      return actual.opportunity(...args)
    },
  }
})

// 捕获 scanner 的提交订阅：真实提交照常穿过（委托 actual），另外允许用例注入
// system 重置与跨 Card 的事件 —— 这两类没有一条只走公开写入口的等价路径。
vi.mock("@/services/personality/variable-pool", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/personality/variable-pool")>()
  return {
    ...actual,
    subscribeVariableCommits: (listener: Parameters<typeof actual.subscribeVariableCommits>[0]) => {
      observed.commitListeners.push(listener as (event: never) => void)
      return actual.subscribeVariableCommits(listener)
    },
  }
})

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { initPaths } from "@/services/paths"
import { loadCard } from "@/services/personality/loader"
import { getActiveCard } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { batchWriteVars, getVariableRegistry, savePoolToDisk } from "@/services/personality/variable-pool"
import { configureProactive, start, stop } from "@/services/proactive"

let root = ""

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-proactive-band-"))
  setTestDataRoot(root)
  await initPaths()

  // 与其它真实链路 L3 用例同形：把仓库里的默认卡种进临时数据根并预写 stages，
  // 让 registry 激活的是产品出厂卡本身（档位声明 [0, 10, 30, 60, 85]）。
  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(
    join(cardsDir, "default.md"),
    readFileSync(join(process.cwd(), "resources/defaults/personality/cards/default.md"), "utf8"),
    "utf8",
  )
  const card = await loadCard("default")
  if (!card) throw new Error("默认卡未从临时数据根加载")
  await updateStagesFile(card.id, {
    stages: {
      cardId: card.id,
      cardVersion: card.version,
      sourceHash: await stageSourceHash(card),
      generatedAt: Date.now(),
      isFallback: false,
      stages: FALLBACK_STAGES,
    },
  })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  observed.variableSlots.length = 0
  observed.reconcileCalls = 0
  observed.commitListeners.length = 0
  await standardSetup()
})

afterEach(async () => {
  await stop()
})

/**
 * sessionId 故意不匹配当前会话：tick 走完 reconcile 后即因 owner 失效返回，
 * 不触达 ipc.scan（Node 适配层没有 proactive 命令面）。
 */
function configureBandScanner(card: NonNullable<ReturnType<typeof getActiveCard>>): void {
  configureProactive({
    expression: {
      captureOwner: async () => ({ sessionId: "proactive-band-session", cardId: card.id, cardHash: card.hash, runGeneration: 1 }),
      express: async () => mustNotBeCalled("主动表达"),
    },
    runPlanner: async () => mustNotBeCalled("主动规划"),
    cancelExpression: async () => {},
    reconcileSession: async () => { observed.reconcileCalls++ },
  })
}

describe("主动档位机会", () => {
  // 单测预算大于两个 waitFor 窗口之和：红色路径（档位没活）要走到 waitFor 报错，
  // 给出「拿不到 variable_change 机会」的可读证据，而不是被 vitest 默认 5s 超时截断。
  // caseId 归 proactive/pr-10（W1-T3 登记；sourceHash 由收口波统一 analyze→generate 刷新）。
  it("默认卡数值跨过档位形成变量机会 [proactive-variable-band-opportunity]", async () => {
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    if (!card) return

    configureBandScanner(card)
    start()

    // 同一档位内 0 → 5：不形成机会（变量机会只在跨档时产生，不是任何写入都触发）
    batchWriteVars({ 好感度: "5" })
    await savePoolToDisk()
    await nextTick()
    await internalScheduler.drain()
    await vi.waitFor(() => expect(observed.reconcileCalls).toBeGreaterThanOrEqual(1), { timeout: 5000 })
    expect(observed.variableSlots).toEqual([])

    // 跨过第一个档位 5 → 15：形成机会，槽位带跨档后的档位下标 1
    batchWriteVars({ 好感度: "15" })
    await savePoolToDisk()
    await nextTick()
    await internalScheduler.drain()
    await vi.waitFor(() => expect(observed.variableSlots).toHaveLength(1), { timeout: 5000 })
    expect(observed.variableSlots[0]).toMatch(/^好感度:1:/)
  }, 20_000)

  it("基线取启动时池值；system 只刷新基线；跨 Card 提交不串卡 [proactive-variable-baseline-reset-card]", async () => {
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    if (!card) return

    // 启动前先写到第 1 档（默认档位 [0,10,30,60,85]）：scanner 的基线必须取这个值，
    // 而不是固定从 Card 初始值 0 起算。
    batchWriteVars({ 好感度: "15" })
    await savePoolToDisk()
    configureBandScanner(card)
    start()
    await nextTick()
    expect(observed.commitListeners, "scanner 没有订阅变量提交").toHaveLength(1)
    const listener = observed.commitListeners[0]!

    // system 重置与跨 Card 事件没有只走公开写入口的等价路径；直接喂给 scanner 的订阅者。
    const definitions = getVariableRegistry()
    const emit = (cardId: string, reason: "llm" | "manual" | "system" | "proactive_response", value: number): void => {
      listener({ cardId, committedAt: Date.now(), reason, values: { 好感度: value }, definitions } as never)
    }

    // 初始化基线 = 15：同一档位内 15 → 25 不产生机会
    batchWriteVars({ 好感度: "25" })
    await savePoolToDisk()
    await nextTick()
    await internalScheduler.drain()
    await vi.waitFor(() => expect(observed.reconcileCalls).toBeGreaterThanOrEqual(1), { timeout: 5000 })
    expect(observed.variableSlots, "基线没有按启动时的池值初始化").toEqual([])

    // 25 → 65 跨到第 3 档：产生机会
    batchWriteVars({ 好感度: "65" })
    await savePoolToDisk()
    await nextTick()
    await internalScheduler.drain()
    await vi.waitFor(() => expect(observed.variableSlots).toHaveLength(1), { timeout: 5000 })
    expect(observed.variableSlots[0]).toMatch(/^好感度:3:/)

    // system 重置（第 3 档 → 第 1 档）只刷新基线，不产生机会
    emit(card.id, "system", 15)
    expect(observed.variableSlots, "system 重置产生了机会").toHaveLength(1)

    // 重置后的同档写入不得按旧基线（65）误判为跨档
    emit(card.id, "llm", 20)
    await nextTick()
    await vi.waitFor(() => expect(observed.reconcileCalls).toBeGreaterThanOrEqual(2), { timeout: 5000 })
    expect(observed.variableSlots, "system 重置没有刷新基线，同档写入被误判为跨档").toHaveLength(1)

    // 其他 Card 真正跨档时也不能借用当前 Card 的 owner 产生机会：
    // 先给它一条基线（system 不产生机会），再跨档；若缺 Card 归属检查，这里会多出一个槽位。
    emit("other-card", "system", 0)
    emit("other-card", "llm", 80)
    emit(card.id, "llm", 15)
    await nextTick()
    await vi.waitFor(() => expect(observed.reconcileCalls).toBeGreaterThanOrEqual(3), { timeout: 5000 })
    expect(observed.variableSlots, "其他 Card 的提交被当成当前 Card 的跨档机会").toHaveLength(1)

    // 正对照：当前 Card 真的跨档（第 1 → 第 3）时机会照常产生
    emit(card.id, "llm", 65)
    await nextTick()
    await vi.waitFor(() => expect(observed.variableSlots).toHaveLength(2), { timeout: 5000 })
    expect(observed.variableSlots[1]).toMatch(/^好感度:3:/)
  }, 30_000)
})
