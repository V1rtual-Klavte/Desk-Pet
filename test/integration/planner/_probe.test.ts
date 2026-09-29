// 临时探针：验证 L3（Node 适配层）能否跑通 planner 的执行闭环。跑完即删。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTestDataRoot } from "../../host/node-ipc"
import { installFakeProvider, fakeText } from "../../host/fake-provider"
import { registerDefaultTools } from "@/services/tool/registry"
import { listAll } from "@/services/tool"
import { executePlan, evaluateComplexity, generatePlan } from "@/services/engine/planner"

let root = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-planner-probe-"))
  setTestDataRoot(root)
  await registerDefaultTools()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("probe", () => {
  it("listAll 有工具", () => {
    expect(listAll().length).toBeGreaterThan(0)
  })

  it("evaluateComplexity 关键词路径", async () => {
    const hit = await evaluateComplexity("帮我重构这个模块", ["重构"])
    expect(hit.triggeredBy).toBe("keyword")
  })

  it("generatePlan 跑通", async () => {
    installFakeProvider([fakeText('```json\n{"summary":"两步","steps":[{"id":1,"description":"读取配置"}]}\n```')])
    const plan = await generatePlan("改配置", {
      cardId: "c",
      cardRole: "助手",
      availableTools: listAll(),
      thinkingEffort: "low",
      maxSteps: 8,
    })
    expect(plan.steps).toHaveLength(1)
  })

  it("executePlan 跑通", async () => {
    const provider = installFakeProvider([fakeText("完成")])
    const r = await executePlan(
      { steps: [{ id: 1, description: "一步" }], summary: "s", estimatedComplexity: 1 },
      { stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "abort" },
      { onStepStart() { /* noop */ }, onStepDone() { /* noop */ }, onStepFailed: async () => "abort" as const },
    )
    expect(provider.payloads).toHaveLength(1)
    expect(r.overallSuccess).toBe(true)
  })
})
