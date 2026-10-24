import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }), releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4, permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {}, retryBorrowerAttachIfPending: async () => {}, failNextReleasesForTest: () => {},
}))

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { confirmRecords, resetConfirmChannel } from "../../host/confirm-channel"
import { runPiSubAgent, resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import type { PiSubAgentInput, PiSubAgentOwner } from "@/services/engine/harness"
import { runTeamAgent } from "@/services/agent/sub-agent"
import { setPermissionPromptAvailable } from "@/services/safety"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { TaskToolAuthorization, ToolDef, ToolHandler } from "@/services/tool"
import { setOverrides } from "@/services/config"

let root = ""
const registered: string[] = []

beforeEach(() => {
  const directory = join(process.cwd(), "test/.tmp")
  mkdirSync(directory, { recursive: true })
  root = mkdtempSync(join(directory, "child-run-"))
  setTestDataRoot(root)
  setOverrides({ "ai.auxModel": "", "ai.safety.mode": "tell_me" })
  resetConfirmChannel("approve")
})

afterEach(() => {
  for (const id of registered.splice(0)) unregister(id)
  resetPiRuntimeProviderForTest()
  resetConfirmChannel("deny")
  rmSync(root, { recursive: true, force: true })
})

function conversation(signal?: AbortSignal): Extract<PiSubAgentOwner, { kind: "conversation" }> {
  return { kind: "conversation", runId: crypto.randomUUID(), sessionId: "child-protocol", runGeneration: 3, isCurrent: () => true, signal }
}
function scheduled(authorize: TaskToolAuthorization["authorize"]): Extract<PiSubAgentOwner, { kind: "scheduled" }> {
  return { kind: "scheduled", runId: crypto.randomUUID(), sessionId: "task-session", cardId: "task-card", taskId: "task-1", taskVersion: 5, occurrenceId: "occurrence-1", isCurrent: () => true,
    authorization: { reference: "grant-1", taskId: "task-1", taskVersion: 5, authorize } }
}
function input(owner: PiSubAgentOwner = conversation()): PiSubAgentInput {
  return { owner, task: "完成测试任务", systemPrompt: "测试子运行", tools: [], timeoutMs: 10_000 }
}
function probe(name: string, handler: ToolHandler, safetyLevel: ToolDef["safetyLevel"] = "SAFE"): ToolDef {
  const tool = defineTool({
    id: `child-probe-${name}`, name, description: "子运行协议探针", parameters: { type: "object", properties: {} },
    safetyLevel, source: "local", sourceId: "", actionCategory: "os.info",
    policy: { version: TOOL_POLICY_VERSION, permission: { defaultDecision: "passthrough" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" }, context: { resultProjection: "reference", historyCompaction: "summarize" } },
  }, handler)
  register(tool)
  registered.push(tool.id)
  return tool
}
/** 请求消息里的文本正文（成员按角度拿到的任务在这里核对）。 */
function requestText(messages: readonly unknown[]): string {
  return messages.map(raw => {
    const content = (raw as { content?: unknown }).content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content.map(part => {
      const block = part as { type?: string; text?: string }
      return block.type === "text" ? String(block.text ?? "") : ""
    }).join("")
  }).join("\n")
}

describe("统一子运行结果与 owner", () => {
  it("空正文和不合法产物都不能成为业务成功 [subrun-output-acceptance]", async () => {
    installFakeProvider([fakeText("")])
    const empty = await runPiSubAgent(input())
    expect(empty.status).toBe("completed")
    expect(empty.success).toBe(false)
    expect(empty.reply).toBe("")
    expect(empty.error).toBe("子运行没有返回结果")

    installFakeProvider([fakeText("不是 JSON")])
    const invalid = await runPiSubAgent({ ...input(), outputContract: { kind: "json" } })
    expect(invalid.status).toBe("completed")
    expect(invalid.success).toBe(false)
    expect(invalid.error).toBe("子运行结果不符合 JSON 产物契约")
  })

  it("已取消与到期 owner 在发 Provider 前明确终止 [subrun-owner-preflight]", async () => {
    const provider = installFakeProvider([fakeText("不应该请求")])
    const controller = new AbortController()
    controller.abort()
    const cancelled = await runPiSubAgent(input(conversation(controller.signal)))
    const expired = await runPiSubAgent({ ...input(), deadlineAt: Date.now() - 1 })
    expect(cancelled.status).toBe("cancelled")
    expect(expired.status).toBe("timed_out")
    expect(cancelled.success).toBe(false)
    expect(expired.success).toBe(false)
    expect(provider.payloads).toHaveLength(0)
  })

  it("必需工具缺失时不开工，模型能力不支持明确档位时不冒充满足 [subrun-required-capabilities]", async () => {
    const provider = installFakeProvider([fakeText("不应该请求")], { id: "no-thinking", reasoning: false })
    const missing = await runPiSubAgent({ ...input(), capabilities: { requiredToolNames: ["missing_required"] } })
    expect(missing.status).toBe("failed")
    expect(missing.error).toBe("指定的工具不存在或不可用: missing_required")
    const unsupported = await runPiSubAgent({ ...input(scheduled(async () => true)), thinkingEffort: "high" })
    expect(unsupported.status).toBe("failed")
    expect(unsupported.resolved?.thinkingAdaptation).toBe("unsupported")
    expect(unsupported.resolved?.requestedThinkingEffort).toBe("high")
    expect(provider.payloads).toHaveLength(0)
  })

  it("工具证据只取成功回执中的安全链接，保留审计 run 身份 [subrun-tool-source-evidence]", async () => {
    const tool = probe("source_probe", async () => ({ success: true, content: JSON.stringify({ results: [{ url: "https://source.invalid/news", published_at: "2026-10-18T08:00:00+08:00" }, { url: "https://private.invalid/?api_key=secret-value" }] }) }))
    installFakeProvider([fakeToolCall(tool.name, {}, "source-call"), fakeText("模型自报 https://invented.invalid/news")])
    const owner = conversation()
    const result = await runPiSubAgent({ ...input(owner), tools: [tool] })
    expect(result.success).toBe(true)
    const receipt = result.evidence.tools.find(item => item.toolCallId === "source-call")
    expect(receipt?.status).toBe("done")
    expect(receipt?.sourceUrls).toEqual(["https://source.invalid/news"])
    expect(receipt?.sources).toEqual([{ url: "https://source.invalid/news", publishedAt: "2026-10-18T00:00:00.000Z" }])
    expect(receipt?.completedAt).toBeTypeOf("number")
    expect(result.audit.runId).toBe(owner.runId)
    expect(result.resolved?.toolNames).toEqual(["source_probe"])
  })

  it("定时授权拒绝返回 needs_input，不打开交互确认或执行工具 [subrun-background-authorization]", async () => {
    let executions = 0
    const tool = probe("grant_probe", async () => { executions++; return { success: true, content: "执行了" } }, "DANGER")
    const calls: Array<{ tool: string; params: Record<string, unknown>; inputHash: string; policyHash: string }> = []
    const owner = scheduled(async (definition, params, proof) => {
      calls.push({ tool: definition.name, params, inputHash: proof.inputHash, policyHash: proof.policyHash })
      return false
    })
    const provider = installFakeProvider([fakeToolCall(tool.name, { target: "outside-grant" }, "grant-call"), fakeText("不可到达")], { id: "thinking", reasoning: true })
    const result = await runPiSubAgent({ ...input(owner), tools: [tool] })
    expect(result.status).toBe("needs_input")
    expect(result.success).toBe(false)
    expect(executions).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.params).toEqual({ target: "outside-grant" })
    expect(calls[0]?.inputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(calls[0]?.policyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(provider.payloads).toHaveLength(1)
    expect(confirmRecords()).toHaveLength(0)
  })

  it("有确认面板时定时任务弹出权限确认并继续执行 [subrun-scheduled-permission-prompt]", async () => {
    setPermissionPromptAvailable(true)
    try {
      let executions = 0
      const tool = probe("prompt_probe", async () => { executions++; return { success: true, content: "已获准执行" } }, "DANGER")
      installFakeProvider([fakeToolCall(tool.name, {}, "prompt-call"), fakeText("完成")], { id: "thinking", reasoning: true })
      const owner = scheduled(async () => false)
      const result = await runPiSubAgent({ ...input(owner), tools: [tool], permissionMode: "interactive" })
      expect(result.status).toBe("completed")
      expect(result.success).toBe(true)
      expect(executions).toBe(1)
      expect(confirmRecords().length).toBeGreaterThan(0)
    } finally {
      setPermissionPromptAvailable(false)
      resetConfirmChannel("deny")
    }
  })

  it("父取消中止正在执行的工具，记录取消而不消费后续收尾 [subrun-inflight-cancel]", async () => {
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    let toolCancelled = false
    const tool = probe("cancel_probe", async (_args, ctx) => {
      ready()
      await new Promise<void>(resolve => {
        const cancelled = () => { toolCancelled = true; resolve() }
        if (ctx.signal?.aborted) cancelled()
        else ctx.signal?.addEventListener("abort", cancelled, { once: true })
      })
      return { success: false, content: "", error: "已取消" }
    })
    const controller = new AbortController()
    const provider = installFakeProvider([fakeToolCall(tool.name, {}, "cancel-call"), fakeText("不可到达")])
    const pending = runPiSubAgent({ ...input(conversation(controller.signal)), tools: [tool] })
    await started
    controller.abort()
    const result = await pending
    expect(result.status).toBe("cancelled")
    expect(result.success).toBe(false)
    expect(toolCancelled).toBe(true)
    expect(provider.payloads).toHaveLength(1)
  })

  it("team 成员完成也不能掩盖 lead 空结果 [subrun-team-lead-failure]", async () => {
    const respond = (context: { systemPrompt?: string }) => fakeText(context.systemPrompt?.includes("团队负责人") ? "" : "成员工作完成")
    installFakeProvider([respond, respond, respond])
    const result = await runTeamAgent({ task: "多角度整理", owner: conversation() })
    expect(result.members).toHaveLength(2)
    expect(result.members?.map(member => member.output.success)).toEqual([true, true])
    expect(result.success).toBe(false)
    expect(result.reply).toBe("")
    expect(result.error).toBe("子运行没有返回结果")
  })

  it("自定义 angles 按顺序分派给不同成员 [subrun-team-custom-angles]", async () => {
    const provider = installFakeProvider([fakeText("角度一完成"), fakeText("角度二完成"), fakeText("汇总完成")])
    const angles = ["检查许可边界", "追踪数据流"]
    const result = await runTeamAgent({ task: "审查改造", angles, owner: conversation() })

    expect(result.success, `团队没有成功: ${result.error ?? "<无原因>"}`).toBe(true)
    expect(result.members?.map(member => member.role)).toEqual(["角度 1", "角度 2"])
    expect(result.members?.map(member => member.output.success)).toEqual([true, true])

    // 每个成员请求只拿到自己的角度 prompt，并都带上原始任务。
    const memberPayloads = provider.payloads.filter(payload => /角色: 角度 [12]/.test(payload.systemPrompt ?? ""))
    expect(memberPayloads, "没有捕获到两个成员的请求").toHaveLength(2)
    for (const [index, angle] of angles.entries()) {
      const payload = memberPayloads.find(item => (item.systemPrompt ?? "").includes(`角色: 角度 ${index + 1}`))
      expect(payload, `缺少角度 ${index + 1} 的成员请求`).toBeDefined()
      const text = requestText(payload!.messages)
      expect(text, `角度 ${index + 1} 没有拿到自己的 prompt`).toContain(angle)
      expect(text, `角度 ${index + 1} 没有带上原始任务`).toContain("任务: 审查改造")
      expect(text, `角度 ${index + 1} 串到了其他角度的 prompt`).not.toContain(angles[1 - index]!)
    }
  })

  it("单个角度失败时 lead 成功即整体成功，并记录未完成角度 [subrun-team-partial]", async () => {
    const respond = (context: { systemPrompt?: string }) => fakeText(
      context.systemPrompt?.includes("团队负责人")
        ? "已按角度汇总"
        : context.systemPrompt?.includes("约束与风险") ? "" : "事实角度完成",
    )
    installFakeProvider([respond, respond, respond])
    const result = await runTeamAgent({ task: "多角度整理", owner: conversation() })

    expect(result.success, `部分角度失败不应拖垮整体: ${result.error ?? "<无原因>"}`).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.reply).toBe("已按角度汇总")
    expect(result.members?.map(member => member.output.success)).toEqual([false, true])
    expect(result.evidence.incomplete).toEqual(["约束与风险"])
  })

  it("团队角度必须是 2–3 个非空且不重复的描述 [subrun-team-angle-validation]", async () => {
    const owner = conversation()
    for (const angles of [["只有一个"], ["一", "二", "三", "四"], ["同一", "同一"], ["一", "  "]]) {
      await expect(runTeamAgent({ task: "多角度整理", angles, owner }))
        .rejects.toThrow("团队角度需要 2–3 个非空且不重复的描述")
    }
  })
})
