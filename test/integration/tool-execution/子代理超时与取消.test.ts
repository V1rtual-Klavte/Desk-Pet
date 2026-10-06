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
//
// 归属 L3（不是 L2）：import `@/services/tool`（工具 barrel 会带出执行许可）。
// ②用 `vi.mock("@/services/agent/sub-agent")` 观测动态 import 到的执行入口参数，
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
}))

vi.mock("@/services/agent/sub-agent", () => ({
  runForkAgent: async (input: Record<string, unknown>) => {
    HOISTED.forkInputs.push(input)
    return { reply: "fork-ok", toolCallsMade: 0, success: true }
  },
  runTeamAgent: async (input: Record<string, unknown>) => {
    HOISTED.teamInputs.push(input)
    return "team-ok"
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

  it("handler 把取消域（signal/会话/代际）传给 fork 与 team；无会话时保持无 scope [agent-spawn-cancel-cascade]", async () => {
    const tool = getToolByName("agent_spawn")!
    const handler = getToolHandler(tool)
    expect(handler, "agent_spawn 的执行体未经 defineTool 构造").toBeDefined()

    const controller = new AbortController()
    const ctx = { sessionId: "session-sub", runGeneration: 7, isCurrent: () => true, signal: controller.signal }

    HOISTED.forkInputs.length = 0
    await handler!({ task: "查一下环境" }, ctx)
    expect(HOISTED.forkInputs, "fork 未执行").toHaveLength(1)
    const forkScope = HOISTED.forkInputs[0]!.scope as { signal?: AbortSignal; sessionId?: string } | undefined
    expect(forkScope, "fork 没有收到取消域（父停止/切会话级联不到子运行）").toBeDefined()
    expect(forkScope!.signal, "取消信号没有传给 fork 子运行").toBe(controller.signal)

    HOISTED.teamInputs.length = 0
    await handler!({ task: "多角度分析", mode: "team" }, ctx)
    expect(HOISTED.teamInputs, "team 未执行").toHaveLength(1)
    const teamScope = HOISTED.teamInputs[0]!.scope as { signal?: AbortSignal } | undefined
    expect(teamScope?.signal, "取消信号没有传给 team 子运行").toBe(controller.signal)

    // 没有会话归属（如测试宿主直调）：不构造 scope，保持旧语义（不猜一个会话）。
    HOISTED.forkInputs.length = 0
    await handler!({ task: "无会话直调" }, {})
    expect(HOISTED.forkInputs[0]!.scope, "无会话时不应凭空构造 scope").toBeUndefined()
  })
})
