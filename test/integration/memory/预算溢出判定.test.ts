// ==========================================
// 预算溢出判定 —— 从 test/e2e/scenes/memory/预算溢出判定.scene.ts 迁到 L3
// ==========================================
//
// ── 判定口径：硬预算拒绝必须以「上游认得出」的响应上报 ──
//
// 上游只在响应上判溢出（pi-agent-core harness/runtime/drive/response.js：
// isContextOverflow(...) || isRecoverableLength(...)），本地拒绝先于请求发生，没有真实
// provider 文案可以命中前者的正则，因此本仓用后者的结构化判据上报：length 停止 + 输出 0。
// 这条耦合是本测试存在的唯一理由 —— 上游改判据时这里必须先红，而不是悄悄退回到
// 「硬预算超限直接终止回合」。成功路径与提交顺序由 `预算溢出恢复` 场景覆盖（L4）。
//
// 归 L3 的理由：判定入口 `createHarnessModels` / `turnFailureReply` 住在 `@/services/engine/harness`。
import type { Context, Model } from "@earendil-works/pi-ai"
import { isRecoverableLength } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"

import { ContextBudgetError } from "@/services/context"
import { classifyTurnFailure, createHarnessModels, turnFailureReply } from "@/services/engine/harness"
import type { TurnFailure } from "@/services/engine/harness"

const FAKE_MODEL = {
  id: "deskpet-fake", name: "Desk-Pet Fake", api: "faux", provider: "deskpet-fake",
  baseUrl: "http://fake.invalid", contextWindow: 131_072, maxTokens: 4096,
} as unknown as Model<any>

const REQUEST: Context = { messages: [{ role: "user" as const, content: "核对预算判定。", timestamp: Date.now() }] }

describe("预算溢出判定", () => {
  it("硬预算拒绝按上游溢出判据上报，普通投影错误不算溢出；失败分类只看语义 [memory-budget-overflow-classification]", async () => {
    const taken: Error[] = []
    const budgetModels = createHarnessModels({
      model: FAKE_MODEL,
      takeBlockedError: () => { const error = new ContextBudgetError(130_000, 124_354); taken.push(error); return error },
    })
    const blocked = await budgetModels.streamSimple(FAKE_MODEL, REQUEST).result()

    // 1) 上游恢复入口只认 isRecoverableLength/isContextOverflow：本地拒绝必须命中前者，
    //    否则 Harness 不会压缩重试，回合会直接终止。
    expect(isRecoverableLength(blocked, FAKE_MODEL.maxTokens), `硬预算拒绝没有命中上游溢出判据: stopReason=${blocked.stopReason}, usage.output=${blocked.usage.output}`)
      .toBe(true)
    // 2) 文案保持本仓判定：恢复用尽时用户看到的仍是可解释的上下文不足。
    expect(blocked.errorMessage, `溢出响应丢失了预算判定文案: ${blocked.errorMessage ?? "<空>"}`).toContain("上下文需要约")
    expect(blocked.stopReason, `溢出响应不是 length 停止: ${blocked.stopReason}`).toBe("length")
    // 3) 判定按次请求取走（网关回调每次请求都读一次），不粘住整条运行。
    expect(taken.length, `判定没有被取走: ${taken.length}`).toBe(1)

    // 4) 普通投影错误不冒充溢出：否则任何错误都会被当成上下文超限去压缩重试。
    const otherModels = createHarnessModels({ model: FAKE_MODEL, takeBlockedError: () => new Error("工具结果投影失败") })
    const other = await otherModels.streamSimple(FAKE_MODEL, REQUEST).result()
    expect(other.stopReason, `普通投影错误不是 error 停止: ${other.stopReason}`).toBe("error")
    expect(isRecoverableLength(other, FAKE_MODEL.maxTokens), "普通投影错误被上报成溢出，Harness 会拿它去压缩重试").toBe(false)

    // 5) 失败回合的展示文案：判定原样透出，declined 后回落到判定；无关故障不被旧判定顶替。
    const verdict = new ContextBudgetError(130_000, 124_354).message
    expect(turnFailureReply(verdict, { overflowRecoveryDeclined: false }),
      "溢出恢复用尽的失败没有原样透出预算判定").toBe(verdict)
    expect(turnFailureReply("Overflow compaction was declined", { overflowRecoveryDeclined: true, lastBudgetError: verdict }),
      "declined 后没有回落到本回合的预算判定").toBe(verdict)
    expect(turnFailureReply("网络不可达", { overflowRecoveryDeclined: false, lastBudgetError: verdict }),
      "无关故障被旧预算判定顶替了文案").not.toContain("上下文需要约")

    // ── 失败分类只看语义：本地预算判定的分类不随估算数字的形态变化，真正的状态码仍命中对应分桶 ──
    //
    // 失败分类只能从文案反推（Harness 把运行失败降维成一条 message），因此状态码必须是
    // **独立数字** —— 本仓预算判定带的是估算 token 数那样的长数字串，里面的 `523` /
    // `403` / `429` 片段不是状态码。
    //
    // 两个方向都写进样本：只有「长数字串不改变分类」会让「全部返回 unknown」的写法蒙混过关，
    // 只有「状态码命中」又证明不了本地判定不被数字形态污染。
    const samples: readonly (readonly [string, TurnFailure["kind"]])[] = [
      // 本地预算判定换数字形态（含 5xx / 401 / 429 形态的片段），分类必须都是 unknown
      [new ContextBudgetError(130_243, 124_354).message, "unknown"],
      [new ContextBudgetError(130_523, 124_354).message, "unknown"],
      [new ContextBudgetError(104_031, 124_354).message, "unknown"],
      [new ContextBudgetError(142_900, 124_354).message, "unknown"],
      // 长数字串里的片段同样不是状态码：没有状态码语义的文案保持 unknown
      ["上下文预算已用 15000 tokens，仍不可用", "unknown"],
      // 真正的状态码仍然是状态码：这三条除了状态码没有任何分桶关键词
      ["服务返回 503，请求被上游拒绝", "provider"],
      ["（429）请求过于频繁", "rate_limit"],
      ["认证失败 (401)", "auth"],
    ]
    for (const [text, expected] of samples) {
      expect(classifyTurnFailure(text), `失败分类随数字形态变化: 期望 ${expected}（文案：${text}）`).toBe(expected)
    }
  })
})
