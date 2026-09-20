import type { Context, Model } from "@earendil-works/pi-ai"
import { isRecoverableLength } from "@earendil-works/pi-ai"
import { ContextBudgetError } from "@/services/context"
import { classifyTurnFailure, createHarnessModels, turnFailureReply } from "@/services/engine/pi"
import type { TurnFailure } from "@/services/engine/pi"
import type { SceneDef } from "../../types"

// ── 判定口径：硬预算拒绝必须以「上游认得出」的响应上报 ──
//
// 上游只在响应上判溢出（pi-agent-core harness/runtime/drive/response.js:115-118：
// isContextOverflow(...) || isRecoverableLength(...)），本地拒绝先于请求发生，没有真实
// provider 文案可以命中前者的正则，因此本仓用后者的结构化判据上报：length 停止 + 输出 0。
// 这条耦合是本场景存在的唯一理由 —— 上游改判据时这里必须先红，而不是悄悄退回到
// 「硬预算超限直接终止回合」。成功路径与提交顺序由 预算溢出恢复 场景覆盖。
const FAKE_MODEL = {
  id: "deskpet-fake", name: "Desk-Pet Fake", api: "faux", provider: "deskpet-fake",
  baseUrl: "http://fake.invalid", contextWindow: 131_072, maxTokens: 4096,
} as unknown as Model<any>

const REQUEST: Context = { messages: [{ role: "user" as const, content: "核对预算判定。", timestamp: Date.now() }] }

export const 预算溢出判定: SceneDef = {
  meta: {
    caseId: "memory-budget-overflow-classification",
    module: "memory",
    contractId: "mm-22",
    description: "硬预算拒绝按上游溢出判据上报（length 停止 + 输出 0），普通投影错误不上报为溢出；失败分类只看语义，不随本地判定文案里估算数字的形态变化",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "budget", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "核对判定：预算拒绝命中溢出恢复判据，其余错误保持普通失败",
    userText: "核对预算判定。",
    checks: [{ type: "expectBudgetOverflowClassification", run: async () => {
      const taken: Error[] = []
      const budgetModels = createHarnessModels({
        model: FAKE_MODEL,
        takeBlockedError: () => { const error = new ContextBudgetError(130_000, 124_354); taken.push(error); return error },
      })
      const blocked = await budgetModels.streamSimple(FAKE_MODEL, REQUEST).result()

      // 1) 上游恢复入口只认 isRecoverableLength/isContextOverflow：本地拒绝必须命中前者，
      //    否则 Harness 不会压缩重试，回合会直接终止。
      if (!isRecoverableLength(blocked, FAKE_MODEL.maxTokens)) {
        throw new Error(`硬预算拒绝没有命中上游溢出判据: stopReason=${blocked.stopReason}, usage.output=${blocked.usage.output}`)
      }
      // 2) 文案保持本仓判定：恢复用尽时用户看到的仍是可解释的上下文不足。
      if (!blocked.errorMessage?.includes("上下文需要约")) throw new Error(`溢出响应丢失了预算判定文案: ${blocked.errorMessage ?? "<空>"}`)
      if (blocked.stopReason !== "length") throw new Error(`溢出响应不是 length 停止: ${blocked.stopReason}`)
      // 3) 判定按次请求取走（网关回调每次请求都读一次），不粘住整条运行。
      if (taken.length !== 1) throw new Error(`判定没有被取走: ${taken.length}`)

      // 4) 普通投影错误不冒充溢出：否则任何错误都会被当成上下文超限去压缩重试。
      const otherModels = createHarnessModels({ model: FAKE_MODEL, takeBlockedError: () => new Error("工具结果投影失败") })
      const other = await otherModels.streamSimple(FAKE_MODEL, REQUEST).result()
      if (other.stopReason !== "error") throw new Error(`普通投影错误不是 error 停止: ${other.stopReason}`)
      if (isRecoverableLength(other, FAKE_MODEL.maxTokens)) throw new Error("普通投影错误被上报成溢出，Harness 会拿它去压缩重试")

      // 5) 失败回合的展示文案：判定原样透出，declined 后回落到判定；无关故障不被旧判定顶替。
      const verdict = new ContextBudgetError(130_000, 124_354).message
      if (turnFailureReply(verdict, { overflowRecoveryDeclined: false }) !== verdict) {
        throw new Error("溢出恢复用尽的失败没有原样透出预算判定")
      }
      if (turnFailureReply("Overflow compaction was declined", { overflowRecoveryDeclined: true, lastBudgetError: verdict }) !== verdict) {
        throw new Error("declined 后没有回落到本回合的预算判定")
      }
      if (turnFailureReply("网络不可达", { overflowRecoveryDeclined: false, lastBudgetError: verdict }).includes("上下文需要约")) {
        throw new Error("无关故障被旧预算判定顶替了文案")
      }
    } }] },
  {
    index: 2,
    description: "失败分类只看语义：本地预算判定的分类不随估算数字的形态变化，真正的状态码仍命中对应分桶",
    userText: "核对失败分类。",
    checks: [{ type: "expectFailureKindDigitInvariance", run: async () => {
      /**
       * 失败分类只能从文案反推（Harness 把运行失败降维成一条 message），因此状态码必须是
       * **独立数字** —— 本仓预算判定带的是估算 token 数那样的长数字串，里面的 `523` /
       * `403` / `429` 片段不是状态码。
       *
       * 两个方向都写进样本：只有「长数字串不改变分类」会让「全部返回 unknown」的写法蒙混过关，
       * 只有「状态码命中」又证明不了本地判定不被数字形态污染。
       */
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
        const kind = classifyTurnFailure(text)
        if (kind !== expected) {
          throw new Error(`失败分类随数字形态变化: 期望 ${expected}，实得 ${kind}（文案：${text}）`)
        }
      }
    } }],
  }],
}

export default 预算溢出判定
