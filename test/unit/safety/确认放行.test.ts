// ==========================================
// 确认放行 —— 从 test/e2e/scenes/safety/确认通道.scene.ts（确认放行）迁到 L2（W3）
// ==========================================
//
// 归属（按 import + 实测）：只 import `@/services/safety` 与宿主确认通道，
// 不 import L2 禁入清单里的任何模块，不驱动 agent loop、不撞 Rust 专属命令 ——
// 在 L2 实测跑通。
//
// 审视结论：照搬（含 `approved` 断言 —— 契约 W2 safety 登记里明确保留的唯一 approve 例外：
// 该场景声称的就是「声明 approve 后确认通道放行」本身，记录由宿主按场景策略写入，
// 是这条声称的直接证据而不是自证；`allow_session` 则是产品 `resolveConfirm(true)` 的
// 应答形状，子代理授权场景复用的正是它，sf-23/sf-20 靠这条钉住形状）。
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { requestPermissionConfirm } from "@/services/safety"
import { confirmRecords, resetConfirmChannel } from "../../host/confirm-channel"

beforeEach(() => {
  resetConfirmChannel("approve")
})

/** 还原成宿主默认的 deny：watcher 是模块级单例，不还原会把放行策略泄给同文件的后续用例。 */
afterEach(() => {
  resetConfirmChannel("deny")
})

describe("确认放行", () => {
  it("场景声明 approve 后确认通道立即放行 [safety-confirm-approved]", async () => {
    // 直接走生产入口（PermissionKernel 同一函数）：探针请求必须被宿主按场景策略应答。
    const decision = await requestPermissionConfirm({
      requestId: "channel-probe", sessionId: "probe-session", runGeneration: 0,
      toolCallId: "probe_tool", toolName: "probe_tool", inputHash: "probe", policyHash: "probe",
      expiresAt: Date.now() + 60_000, message: "通道自检", parameterSummary: "", effectClass: "external_side_effect",
    })
    // 应答形状也要钉住：宿主 approve 走的是 `resolveConfirm(true)` → `allow_session`，
    // 正是子代理授权场景要复用的那种授权（sf-20）。
    expect(decision, "approve 策略下的应答不是 allow_session").toBe("allow_session")
    const records = confirmRecords().filter(record => record.toolName === "probe_tool")
    expect(records, "确认记录缺失或未标记放行").toHaveLength(1)
    expect(records[0]?.approved, "确认记录未标记放行").toBe(true)
  })
})
