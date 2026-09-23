import type { SceneDef } from "../../types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import {
  defineTool, register, unregister, permitSnapshot, failNextReleasesForTest, TOOL_POLICY_VERSION,
} from "@/services/tool"

/**
 * 许可释放失败的补偿（TOOL-06b/TOOL-10）。
 *
 * 释放是一条 IPC：失败时额度留在所有者手里 —— 后续独占效果会一直排队，而工具结果本身
 * 看起来是成功的。所以释放失败不允许只留一行日志，必须入队并在下一次 run 开始前重放；
 * requestId 是确定量（会话+代际+调用+工具），Rust 对未知 id 返回 Ok，重放因此是幂等的。
 *
 * 场景用注入钩子制造一次真实释放失败（注入点在 invoke 之前，走与真实失败同一条 catch 路径）：
 * ① 第 1 回合结束后额度确实留在所有者手里（释放失败没有被静默吞掉）；
 * ② 第 2 回合（run 开始前的补偿重放）结束时额度已归还。
 */
const ID = "live-permit-compensation"
const TOOL_NAME = "permit_compensation_probe"

const probe = defineTool({
  id: ID, name: TOOL_NAME, description: "许可补偿探针：独占效果，一次调用即结算",
  parameters: { type: "object", properties: {} },
  safetyLevel: "SAFE", source: "local", sourceId: "", mode: "pet", actionCategory: "os.info",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async () => ({ success: true, content: "补偿探针执行完成" }))

export const 许可释放补偿: SceneDef = {
  meta: {
    caseId: "tool-permit-release-compensation", module: "tool-execution", contractId: "te-16",
    description: "释放工具许可失败时额度入队补偿，并在下一次 run 开始前重放归还",
    depth: "deep", suite: "regression", entry: "runtime",
    tags: ["tool-execution", "boundary", "error"],
  },
  setup: async () => {
    register(probe)
    installFakeProvider([
      fakeToolCall(TOOL_NAME, {}, "permit-compensation-call"),
      fakeText("第一次：探针执行完了。"),
      fakeText("第二次：补偿已经重放过了。"),
    ])
    // 注入必须在第 1 回合的探针结算之前：下一次 releaseToolPermit 会失败并入队。
    failNextReleasesForTest(1)
  },
  turns: [
    {
      index: 1,
      description: "释放失败后额度留在所有者手里，补偿欠账已入队",
      userText: "先执行一次独占效果的探针工具。",
      checks: [{
        type: "expectPermitLeakAfterReleaseFailure",
        run: async ctx => {
          if (ctx.output.failure) throw new Error(`回合失败: ${JSON.stringify(ctx.output.failure)}`)
          if (!ctx.toolHistory.some(item => item.toolName === TOOL_NAME)) {
            throw new Error("探针工具没有被调用：泄漏断言会退化成空断言")
          }
          const leaked = await permitSnapshot()
          if (leaked.exclusiveActive !== true) {
            throw new Error(`释放失败后额度没有留在所有者手里: exclusiveActive=${leaked.exclusiveActive}`)
          }
        },
      }],
    },
    {
      index: 2,
      description: "下一个 run 开始前的补偿重放把额度归还",
      userText: "再说一句，检查补偿是否已重放。",
      checks: [{
        type: "expectPermitReleaseCompensated",
        run: async () => {
          try {
            const compensated = await permitSnapshot()
            if (compensated.exclusiveActive !== false) {
              throw new Error(`run 开始前没有补偿释放: exclusiveActive=${compensated.exclusiveActive}`)
            }
            if (compensated.sharedActive !== 0 || compensated.queued !== 0) {
              throw new Error(`补偿后额度没有回空闲: shared=${compensated.sharedActive} queued=${compensated.queued}`)
            }
          } finally {
            unregister(ID)
          }
        },
      }],
    },
  ],
}

export default 许可释放补偿
