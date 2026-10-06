// ==========================================
// 工具超时审计 —— 归属字段与下游超时归类（2026-10-06 后台化批次）
// ==========================================
//
// 体检报告 §5 的结论之一：超时后「真超时还是别的」答不上来，因为审计与 trace 只有结局名。
// 本文件钉 router 侧的两件事：
// ① 审计带 `timeoutMs`（本次生效预算，null = 本计时器不管）与 `elapsedMs`（实际耗时）；
// ② 执行端自带的超时（bash 转后台：执行端返回的 ExecutionError code=timeout 经 Pi 工具
//    以 `cause` 挂在抛出的 Error 上）也归类为 timeout —— 不再是普通 failed。
//
// 归属 L3（不是 L2）：import `@/services/tool`（工具 barrel 会带出执行许可）。
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setTestDataRoot } from "../../host/node-ipc"
import { getHostBridge, setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { defineTool, register, TOOL_POLICY_VERSION, unregister } from "@/services/tool"
import { executeToolDefinition } from "@/services/tool/router"

interface AuditFields {
  outcome?: unknown
  timeoutMs?: unknown
  elapsedMs?: unknown
}

function auditOf(result: { details?: unknown }): AuditFields {
  const details = result.details
  if (!details || typeof details !== "object" || !("audit" in details)) throw new Error("工具结果缺少审计账")
  return (details as { audit: AuditFields }).audit
}

let root = ""
let realBridge: HostBridge | undefined

const TIMEOUT_ID = "audit-timeout-probe"
const DOWNSTREAM_ID = "audit-downstream-probe"

const timeoutProbe = defineTool({
  id: TIMEOUT_ID, name: "audit_timeout_probe", description: "审计超时探针",
  parameters: { type: "object", properties: {} },
  safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "os.info",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "process", isolation: "exclusive_effect", replay: "never", timeoutMs: 60 },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async (_params, ctx) => {
  // 等自身被 abort（router 超时会 abort）：结算在超时后落定，但不改账。
  await new Promise<void>(resolve => {
    if (ctx.signal?.aborted) resolve()
    else ctx.signal?.addEventListener("abort", () => resolve(), { once: true })
  })
  return { success: false, content: "", error: "超时", errorCode: "timeout" }
})

const downstreamProbe = defineTool({
  id: DOWNSTREAM_ID, name: "audit_downstream_probe", description: "执行端超时探针",
  parameters: { type: "object", properties: {} },
  safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "os.info",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "process", isolation: "exclusive_effect", replay: "never", timeoutMs: 60_000 },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async () => {
  // 模拟 pi-bash 转后台的形状：抛出的 Error 带 ExecutionError(cause.code=timeout)，
  // 且先于 router 计时器（60s）结算 —— 账必须记 timeout，不是 error。
  const cause = Object.assign(new Error("命令已转入后台"), { code: "timeout" })
  // 与 pi 的 bash 工具同形：抛出的 Error 用 `cause` 挂住 ExecutionError（本项目 TS lib 的
  // Error 构造签名不含 cause 选项，用 Object.assign 表达同一形状）。
  throw Object.assign(new Error("命令运行 300 秒仍未结束，已转入后台继续执行"), { cause })
})

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-timeout-audit-"))
  setTestDataRoot(root)
  // 许可内核是 Rust 专属命令（test/host/unsupported.ts）：本用例的断言面不是许可，
  // 用桥包装把 acquire/release 换成恒通过，其余命令照旧委托测试宿主（与既有 L3 同款手法）。
  realBridge = getHostBridge()
  const delegate = realBridge
  setHostBridge({
    ...delegate,
    request: (method: string, args: unknown, options?: unknown) => {
      if (method === "tool_permit_acquire") return Promise.resolve(true)
      if (method === "tool_permit_release") return Promise.resolve(null)
      return delegate.request(method as never, args as never, options as never)
    },
  } as unknown as HostBridge)
  register(timeoutProbe)
  register(downstreamProbe)
})

afterAll(() => {
  unregister(TIMEOUT_ID)
  unregister(DOWNSTREAM_ID)
  if (realBridge) setHostBridge(realBridge)
  rmSync(root, { recursive: true, force: true })
})

describe("工具超时审计字段", () => {
  it("审计带生效预算与实际耗时；下游超时也归类为 timeout [tool-timeout-audit-fields]", async () => {
    // ① router 计时器到点：outcome=timeout，账里有预算与耗时。
    const timedOut = await executeToolDefinition(timeoutProbe, {}, { toolCallId: "audit-timeout" })
    expect(timedOut.success).toBe(false)
    const timeoutAudit = auditOf(timedOut)
    expect(timeoutAudit.outcome, "定时器到点没有记 timeout").toBe("timeout")
    expect(timeoutAudit.timeoutMs, "审计缺少生效预算（无法归因是谁掐的）").toBe(60)
    expect(timeoutAudit.elapsedMs as number, "审计缺少实际耗时").toBeGreaterThanOrEqual(50)

    // ② 执行端自带超时（bash 转后台）：outcome 也是 timeout，而不是 failed。
    const downstream = await executeToolDefinition(downstreamProbe, {}, { toolCallId: "audit-downstream" })
    expect(downstream.success).toBe(false)
    const downstreamAudit = auditOf(downstream)
    expect(downstreamAudit.outcome, "执行端超时被记成了普通失败").toBe("timeout")
    expect(downstream.errorCode).toBe("timeout")
    expect(downstreamAudit.timeoutMs).toBe(60_000)
  })
})
