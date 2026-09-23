import type { SceneDef } from "../../types"
import { actionCategoryOf } from "@/services/tool"
import { getStagePrompt, loadStages, restoreStagesCache, snapshotStagesCache } from "@/services/personality"
import type { StageMap } from "@/services/personality"

/** 探针 Card 的阶段文案：故意与 FALLBACK_STAGES 不同，且 blocked 缺 fs.read 类别。 */
const PROBE_STAGES: StageMap = {
  thinking: null,
  planning: "探针规划",
  idle: null,
  executing: { "fs.read": "探针读取中", _default: "探针执行中" },
  done: { "fs.write": "探针写入完成", _default: "探针完成" },
  blocked: { _default: "探针已拦截" },
  error: "探针错误",
  timeout: "探针超时",
  retry: "探针重试",
  fallbacks: {
    concurrentRejected: "探针忙", maxRetriesExhausted: "探针重试失败", turnTimeout: "探针超时",
    toolLoopMaxRounds: "探针轮数用尽", llmUnavailable: ["探针不可用"], subAgentDone: "探针子代理完成",
    subAgentFailed: "探针子代理失败", subAgentNoResult: "探针子代理无结果", compactionFailed: "探针压缩失败",
  },
  greetings: ["探针问候"],
}

export const 阶段文案链路: SceneDef = {
  meta: {
    caseId: "stage-prompt-link", module: "personality-card", contractId: "pc-09",
    description: "工具类别由 ToolDef.actionCategory 解析，Card 阶段文案到达 UI 取用点",
    depth: "shallow", suite: "capability", entry: "unit", tags: ["personality", "card", "tool"],
  },
  turns: [{
    index: 1,
    description: "解析工具类别并按 Card 文案取自 getStagePrompt",
    userText: "检查阶段文案链路。",
    checks: [{
      type: "expectStagePromptLink",
      run: async () => {
        // 1) 类别解析：已注册工具按声明取类别；未知名字回 _default（MCP/Skill/已释放工具同形）
        if (actionCategoryOf("read") !== "fs.read") throw new Error(`read 类别解析错误: ${actionCategoryOf("read")}`)
        if (actionCategoryOf("write") !== "fs.write") throw new Error(`write 类别解析错误: ${actionCategoryOf("write")}`)
        if (actionCategoryOf("__not_a_tool__") !== "_default") throw new Error("未知工具未回退 _default")
        // 2) Card 文案到达 UI 取用点：装上探针 Card，断言取到 Card 文本而非兜底
        const saved = snapshotStagesCache()
        try {
          loadStages({ cardId: "probe-card", cardVersion: 1, sourceHash: "probe", generatedAt: Date.now(), isFallback: false, stages: PROBE_STAGES })
          if (getStagePrompt("executing", actionCategoryOf("read")) !== "探针读取中") throw new Error("executing 未取到 Card 文案")
          if (getStagePrompt("done", actionCategoryOf("write")) !== "探针写入完成") throw new Error("done 未按类别取到 Card 文案")
          // 3) 类别缺失时的回退：blocked 没有 fs.read 类别 → Card 的 _default；再缺则 FALLBACK_STAGES，绝不是空串
          if (getStagePrompt("blocked", actionCategoryOf("read")) !== "探针已拦截") throw new Error("blocked 未回退到 Card 的 _default")
        } finally { restoreStagesCache(saved) }
        // 4) 兜底也非空（UI 取用点永不显示空串）
        if (!getStagePrompt("executing", "_default")) throw new Error("getStagePrompt 返回空串")
      },
    }],
  }],
}

export default 阶段文案链路
