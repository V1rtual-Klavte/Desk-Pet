// ==========================================
// 计划级核验器（L3）
// ==========================================
//
// 被测：verifyPlanExecution。核验跑真实子代理循环（只替换 Provider），因此归 L3。
// 钉住三件事：没有完成声明就不花请求；核验子代理只拿到只读工具；核验失败/空正文
// 一律收束为 partial，绝不冒充 pass。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import type { PlanExecutionResult, PlanResult } from "@/services/engine/planner"
import { verifyPlanExecution } from "@/services/engine/plan/verifier"
import type { PlanStepOutcome } from "@/services/engine/protocol"
import { initPaths } from "@/services/paths"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import { registerDefaultTools } from "@/services/tool/registry"

let root = ""
const registered: string[] = []
let provider: ReturnType<typeof installFakeProvider> | undefined

const READ_PROBE = "verify_read_probe"
const WRITE_PROBE = "verify_write_probe"

function planVerified(verdict: "pass" | "partial" | "fail", summary = "核验完成"): string {
  return JSON.stringify({ verdict, reasons: [], missing: [], drift: [], summary })
}

function probeTool(name: string, effect: "read" | "local_mutation"): void {
  const tool = defineTool({
    id: `verify-probe-${name}`, name, description: "核验器工具面探针",
    parameters: { type: "object", properties: {} }, safetyLevel: "SAFE",
    source: "local", sourceId: "", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "passthrough" },
      execution: { effect, isolation: effect === "read" ? "shared_read" : "exclusive_effect", replay: "never" },
      context: { resultProjection: "preserve", historyCompaction: "summarize" },
    },
  }, async () => ({ success: true, content: "探针结果" }))
  register(tool)
  registered.push(tool.id)
}

const STEP = {
  id: 1,
  description: "写出配置结论",
  allowedTools: [READ_PROBE],
  inputs: "当前配置",
  deliverable: "配置已修好的说明",
  acceptance: "配置可用",
}

const PLAN: PlanResult = {
  summary: "修好配置",
  estimatedComplexity: 1,
  steps: [STEP],
}

function executionResult(outcome: PlanStepOutcome | undefined): PlanExecutionResult {
  return {
    stepResults: [{
      step: STEP,
      output: {
        status: "completed",
        success: outcome?.status === "complete",
        reply: outcome ? JSON.stringify(outcome) : "步骤失败",
        toolCallsMade: 0,
        evidence: { tools: [], incomplete: [], unconfirmedEffects: false },
        audit: { ownerKind: "plan", runId: "verify-run", requestId: "verify-request" },
      },
      ...(outcome ? { outcome } : {}),
      durationMs: 10,
    }],
    blockedSteps: [],
    overallSuccess: outcome?.status === "complete",
    totalSteps: 1,
    totalDurationMs: 10,
  }
}

async function runVerification(reply: string, result: PlanExecutionResult) {
  provider = installFakeProvider([fakeText(reply)])
  return await verifyPlanExecution({
    sessionId: "verify-test",
    planId: "plan-verify",
    intent: "把配置修好",
    plan: PLAN,
    result,
    scope: { sessionId: "verify-test", runGeneration: 1, isCurrent: () => true },
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-plan-verifier-"))
  setTestDataRoot(root)
  await initPaths()
  await registerDefaultTools()
  probeTool(READ_PROBE, "read")
  probeTool(WRITE_PROBE, "local_mutation")
})

afterEach(() => {
  provider?.restore()
  provider = undefined
  for (const id of registered.splice(0)) unregister(id)
  rmSync(root, { recursive: true, force: true })
})

describe("计划核验器", () => {
  it("没有 complete 声明就跳过核验，不花模型请求 [plan-verify-skip-without-complete]", async () => {
    const verdict = await runVerification(planVerified("pass"), executionResult({ status: "partial", summary: "只做了一半" }))
    expect(verdict, "没有完成声明时不应产出核验结论").toBeUndefined()
    expect(provider?.state.callCount, "跳过的核验仍发出了请求").toBe(0)
  })

  it("有完成声明时发一次只读核验请求，pass 原样返回 [plan-verify-pass]", async () => {
    const verdict = await runVerification(planVerified("pass", "目标已达成"), executionResult({ status: "complete", summary: "配置已修好" }))
    expect(verdict?.verdict).toBe("pass")
    expect(verdict?.summary).toBe("目标已达成")
    expect(provider?.state.callCount).toBe(1)

    const payload = provider?.payloads[0]
    expect(payload?.systemPrompt, "核验提示没有带原始目标").toContain("把配置修好")
    expect(payload?.systemPrompt, "核验提示没有带该步交付物").toContain("配置已修好的说明")
    const tools = payload?.tools?.map(tool => tool.name) ?? []
    expect(tools, "核验请求缺少只读探针").toContain(READ_PROBE)
    expect(tools, "核验请求不应带可写工具").not.toContain(WRITE_PROBE)
    expect(tools, "核验请求不应带派生型工具").not.toContain("agent_spawn")
  })

  it("核验回复不是契约 JSON 时收束为 partial [plan-verify-invalid-reply-is-partial]", async () => {
    const verdict = await runVerification("核验完成了", executionResult({ status: "complete", summary: "配置已修好" }))
    expect(verdict?.verdict).toBe("partial")
    expect(verdict?.reasons[0]).toContain("核验结果不符合输出契约")
    expect(verdict?.missing).toEqual([])
    expect(verdict?.drift).toEqual([])
  })

  it("核验回复为空时收束为 partial，不冒充 pass [plan-verify-empty-reply-is-partial]", async () => {
    const verdict = await runVerification(" ", executionResult({ status: "complete", summary: "配置已修好" }))
    expect(verdict?.verdict).toBe("partial")
    expect(verdict?.reasons[0]).toContain("核验没有返回结果")
  })
})
