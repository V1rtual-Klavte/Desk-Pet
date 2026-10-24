// ==========================================
// agent_spawn 的超时对齐与取消级联（2026-10-06 后台化批次，体检报告 R3）
// ==========================================
//
// ① 声明值对齐：`policy.execution.timeoutMs` 取 team 模式的最坏内部耗时（两段
//    `SUB_AGENT_RUN_TIMEOUT_MS`）+ 编排余量。旧值 `loopConfig.toolTimeoutMs × 4`
//    （120s）小于 team 的 ~180s，router 会把仍在跑的团队判成超时。
// ② 取消级联：handler 把工具上下文的取消域（sessionId / 代际 / signal）传给
//    runForkAgent / runTeamAgent —— 旧实现签名不接 ctx，父回合停止 / 切会话都级联不到
//    子运行，子代理会跑满自己的 90s 上限。
// ③ angles 契约：仅 team 可用、2–3 个非空且不重复，非法时在派发前失败；
//    team 部分完成保留可用结论并标注未完成角度，fork 不加标注。
//
// 归属 L3（不是 L2）：import `@/services/tool`（工具 barrel 会带出执行许可）。
// ②③用 `vi.mock("@/services/agent/sub-agent")` 观测动态 import 到的执行入口参数，
// 不真跑子代理（真跑要 fake Provider 与整套 harness，收益只有「参数对不对」这一点）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setTestDataRoot } from "../../host/node-ipc"
import { AGENT_SPAWN_TOOL_TIMEOUT_MS, SUB_AGENT_RUN_TIMEOUT_MS } from "@/services/agent/timeouts"
import { getToolByName, registerDefaultTools } from "@/services/tool"
import { getToolHandler } from "@/services/tool/policy"

const HOISTED = vi.hoisted(() => ({
  forkInputs: [] as Array<Record<string, unknown>>,
  teamInputs: [] as Array<Record<string, unknown>>,
  teamSuccess: true,
  teamIncomplete: [] as string[],
  forkIncomplete: [] as string[],
  teamFailedAngles: [] as string[],
}))

vi.mock("@/services/agent/sub-agent", () => ({
  runForkAgent: async (input: Record<string, unknown>) => {
    HOISTED.forkInputs.push(input)
    return { status: "completed", reply: "fork-ok", toolCallsMade: 0, success: true, evidence: { tools: [], incomplete: HOISTED.forkIncomplete, unconfirmedEffects: false }, audit: { runId: "fork", requestId: "fork", ownerKind: "conversation" } }
  },
  runTeamAgent: async (input: Record<string, unknown>) => {
    HOISTED.teamInputs.push(input)
    return {
      status: "completed", reply: HOISTED.teamSuccess ? "team-ok" : "", toolCallsMade: 0, success: HOISTED.teamSuccess,
      error: HOISTED.teamSuccess ? undefined : "lead 执行失败",
      members: HOISTED.teamFailedAngles.map(role => ({ role, output: { success: false } })),
      evidence: { tools: [], incomplete: HOISTED.teamIncomplete, unconfirmedEffects: false },
      audit: { runId: "team", requestId: "team", ownerKind: "conversation" },
    }
  },
}))

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-agent-timeout-"))
  setTestDataRoot(root)
  // L3 没有宿主启动面兜底：生产工具由本文件自己注册（与 Bash 超时档位同款）。
  await registerDefaultTools()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("agent_spawn 超时对齐与取消级联", () => {
  it("声明预算覆盖 team 的内部最坏耗时，而不是配置派生的 120s [agent-spawn-timeout-alignment]", () => {
    const tool = getToolByName("agent_spawn")
    expect(tool, "agent_spawn 工具未注册").toBeDefined()
    expect(tool!.policy.execution.timeoutMs, "声明值不是共用的对齐常量").toBe(AGENT_SPAWN_TOOL_TIMEOUT_MS)
    // 语义钉：team = 成员段 + lead 段两段子运行（各自 ≤SUB_AGENT_RUN_TIMEOUT_MS），
    // 声明值必须 ≥ 两段之和 —— 旧值 120s < 180s 在这里必红。
    expect(tool!.policy.execution.timeoutMs!).toBeGreaterThanOrEqual(2 * SUB_AGENT_RUN_TIMEOUT_MS)
  })

  it("handler 把取消域（signal/会话/代际）传给 fork 与 team；无 owner 时拒绝启动 [agent-spawn-cancel-cascade]", async () => {
    const tool = getToolByName("agent_spawn")!
    const handler = getToolHandler(tool)
    expect(handler, "agent_spawn 的执行体未经 defineTool 构造").toBeDefined()

    const controller = new AbortController()
    const ctx = { sessionId: "session-sub", runGeneration: 7, isCurrent: () => true, signal: controller.signal }

    HOISTED.forkInputs.length = 0
    await handler!({ task: "查一下环境" }, ctx)
    expect(HOISTED.forkInputs, "fork 未执行").toHaveLength(1)
    const forkScope = HOISTED.forkInputs[0]!.owner as { signal?: AbortSignal; sessionId?: string } | undefined
    expect(forkScope, "fork 没有收到取消域（父停止/切会话级联不到子运行）").toBeDefined()
    expect(forkScope!.signal, "取消信号没有传给 fork 子运行").toBe(controller.signal)

    HOISTED.teamInputs.length = 0
    await handler!({ task: "多角度分析", mode: "team" }, ctx)
    expect(HOISTED.teamInputs, "team 未执行").toHaveLength(1)
    const teamScope = HOISTED.teamInputs[0]!.owner as { signal?: AbortSignal } | undefined
    expect(teamScope?.signal, "取消信号没有传给 team 子运行").toBe(controller.signal)

    HOISTED.forkInputs.length = 0
    const rejected = await handler!({ task: "无会话直调" }, {})
    expect(rejected.success).toBe(false)
    expect(HOISTED.forkInputs).toHaveLength(0)

  })
  it("team 汇总失败不会被工具层包装成功 [agent-team-no-false-success]", async () => {
    const handler = getToolHandler(getToolByName("agent_spawn")!)!
    HOISTED.teamSuccess = false
    try {
      const result = await handler({ task: "多角度分析", mode: "team" }, { sessionId: "team-session", runGeneration: 1, isCurrent: () => true })
      expect(result.success).toBe(false)
      expect(result.error).toBe("lead 执行失败")
      expect(result.content).toBe("")
    } finally { HOISTED.teamSuccess = true }
  })

  it("angles 仅 team 可用，数量与内容在派发前校验 [agent-spawn-angles-contract]", async () => {
    const handler = getToolHandler(getToolByName("agent_spawn")!)!
    const ctx = { sessionId: "angles-session", runGeneration: 1, isCurrent: () => true }

    HOISTED.forkInputs.length = 0
    const forkWithAngles = await handler({ task: "单路任务", angles: ["越权角度"] }, ctx)
    expect(forkWithAngles.success, "fork 接受了仅 team 可用的 angles").toBe(false)
    expect(forkWithAngles.error, "拒绝原因没有点明 angles 的使用范围").toContain("team")
    expect(HOISTED.forkInputs, "带 angles 的 fork 仍然启动了子代理").toHaveLength(0)

    const invalidMode = await handler({ task: "模式错误", mode: "solo" }, ctx)
    expect(invalidMode.success, "非法 mode 被当成 fork 放行").toBe(false)
    expect(invalidMode.error, "拒绝原因没有点名非法模式").toContain("solo")
    expect(HOISTED.forkInputs).toHaveLength(0)

    HOISTED.teamInputs.length = 0
    for (const angles of [["只有一个"], ["一", "二", "三", "四"], ["同一", "同一"], ["一", "  "]]) {
      const invalid = await handler({ task: "多角度分析", mode: "team", angles }, ctx)
      expect(invalid.success, `非法 angles 被放行: ${JSON.stringify(angles)}`).toBe(false)
      expect(invalid.error).toBe("团队角度需要 2–3 个非空且不重复的描述")
    }
    expect(HOISTED.teamInputs, "非法 angles 仍然启动了团队").toHaveLength(0)

    const accepted = await handler({ task: "多角度分析", mode: "team", angles: [" 许可边界 ", "数据流"] }, ctx)
    expect(accepted.success).toBe(true)
    expect(HOISTED.teamInputs).toHaveLength(1)
    expect(HOISTED.teamInputs[0]!.angles, "角度没有去掉首尾空白后传给团队").toEqual(["许可边界", "数据流"])
    expect(HOISTED.teamInputs[0]).not.toHaveProperty("memberCount")
  })

  it("team 部分完成保留可用结论并标注未完成角度，fork 不加标注 [agent-team-partial]", async () => {
    const handler = getToolHandler(getToolByName("agent_spawn")!)!
    const ctx = { sessionId: "partial-session", runGeneration: 1, isCurrent: () => true }

    // `evidence.incomplete` 还混有 MCP 等非角度条目：未完成角度必须从成员结果取，不能整段照抄。
    HOISTED.teamIncomplete = ["MCP foo: 连接失败"]
    HOISTED.teamFailedAngles = ["角度 2"]
    try {
      const partial = await handler({ task: "多角度分析", mode: "team" }, ctx)
      expect(partial.success).toBe(true)
      expect(partial.error).toBeUndefined()
      expect(partial.content).toBe("【部分完成：未完成角度 角度 2】\n\nteam-ok")
    } finally {
      HOISTED.teamIncomplete = []
      HOISTED.teamFailedAngles = []
    }

    HOISTED.forkIncomplete = ["残留"]
    try {
      const fork = await handler({ task: "单路任务" }, ctx)
      expect(fork.success).toBe(true)
      expect(fork.content, "fork 不应带上 team 的部分完成标注").toBe("fork-ok")
    } finally { HOISTED.forkIncomplete = [] }
  })

})
