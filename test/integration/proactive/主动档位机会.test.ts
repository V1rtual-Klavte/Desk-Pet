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

const observed = vi.hoisted(() => ({
  /** scanner 真正下发到机会构造器的 variable_change 槽位（`变量名:档位下标:当地日`）。 */
  variableSlots: [] as string[],
  /** tick 进入扫描流程的次数：作为「变量提交回调已跑完」的同步信号（回调末尾会 enqueueTick）。 */
  reconcileCalls: 0,
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

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { initPaths } from "@/services/paths"
import { getCard, initCards } from "@/services/personality/loader"
import { getActiveCard } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { batchWriteVars, savePoolToDisk } from "@/services/personality/variable-pool"
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
  await initCards()
  const card = getCard("default")
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
  await standardSetup()
})

afterEach(async () => {
  await stop()
})

describe("主动档位机会", () => {
  // 单测预算大于两个 waitFor 窗口之和：红色路径（档位没活）要走到 waitFor 报错，
  // 给出「拿不到 variable_change 机会」的可读证据，而不是被 vitest 默认 5s 超时截断。
  // 本用例暂不带 caseId 标记：登记 caseId / coverage point 属于契约修订，
  // 需按 test/SKILL 的 analyze → generate 流程走（本轮不改 test/contracts/）。
  it("默认卡数值跨过档位形成变量机会", async () => {
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    if (!card) return

    configureProactive({
      expression: {
        // sessionId 故意不匹配当前会话：tick 走完 reconcile 后即因 owner 失效返回，
        // 不触达 ipc.scan（Node 适配层没有 proactive 命令面）。
        captureOwner: async () => ({ sessionId: "proactive-band-session", cardId: card.id, cardHash: card.hash, runGeneration: 1 }),
        express: async () => mustNotBeCalled("主动表达"),
      },
      runPlanner: async () => mustNotBeCalled("主动规划"),
      cancelExpression: async () => {},
      reconcileSession: async () => { observed.reconcileCalls++ },
    })
    start()

    // 同一档位内 0 → 5：不形成机会（变量机会只在跨档时产生，不是任何写入都触发）
    batchWriteVars({ 好感度: "5" })
    await savePoolToDisk()
    await vi.waitFor(() => expect(observed.reconcileCalls).toBeGreaterThanOrEqual(2), { timeout: 5000 })
    expect(observed.variableSlots).toEqual([])

    // 跨过第一个档位 5 → 15：形成机会，槽位带跨档后的档位下标 1
    batchWriteVars({ 好感度: "15" })
    await savePoolToDisk()
    await vi.waitFor(() => expect(observed.variableSlots).toHaveLength(1), { timeout: 5000 })
    expect(observed.variableSlots[0]).toMatch(/^好感度:1:/)
  }, 20_000)
})
