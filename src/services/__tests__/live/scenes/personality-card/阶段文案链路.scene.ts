import type { SceneDef } from "../../types"
import { actionCategoryOf } from "@/services/tool"
import { COMMAND_KEYS, FALLBACK_KEYS, clearStagesCache, getCommandReply, getFallbackReply, getSimpleStage, getStagePrompt, loadStages, restoreStagesCache, snapshotStagesCache } from "@/services/personality"
import type { StageMap } from "@/services/personality"

/** 探针 Card 的阶段文案：故意与 FALLBACK_STAGES 不同，且 blocked 缺 fs.read 类别。 */
const PROBE_STAGES: StageMap = {
  thinking: "探针思考中",
  planning: "探针规划",
  executing: { "fs.read": "探针读取中", _default: "探针执行中" },
  done: { "fs.write": "探针写入完成", _default: "探针完成" },
  blocked: { _default: "探针已拦截" },
  error: "探针错误",
  retry: "探针重试",
  commands: {
    clear: "探针已清空", memoryCleared: "探针记忆已清理",
    compactCompleted: "探针压缩完成", compactDeclined: "探针未压缩", compactNothing: "探针无可压缩",
    compactBusy: "探针压缩忙", compactClosed: "探针会话不可用", compactPending: "探针排队未清空",
    compactFailed: "探针压缩失败",
    skillStarted: "探针技能已加入", skillUnknown: "探针技能不存在", skillEmpty: "探针技能无正文",
    skillDisabled: "探针技能已关闭",
  },
  fallbacks: {
    concurrentRejected: "探针忙", maxRetriesExhausted: "探针重试失败", turnTimeout: "探针超时",
    toolLoopMaxRounds: "探针轮数用尽", llmUnavailable: ["探针不可用"], subAgentDone: "探针子代理完成",
    subAgentFailed: "探针子代理失败", subAgentNoResult: "探针子代理无结果",
    runInterrupted: "探针上次中断", compactionRejected: "探针压缩进行中", pausedReturnFailed: "探针暂停输入未放回",
    planCancelled: "探针计划已取消", planCompleted: "探针计划已完成", planResumeBusy: "探针会话忙",
  },
  greetings: ["探针问候"],
}

export const 阶段文案链路: SceneDef = {
  meta: {
    caseId: "stage-prompt-link", module: "personality-card", contractId: "pc-09",
    description: "工具类别由 ToolDef.actionCategory 解析，四类用户可见文案都到达各自的取用点",
    depth: "shallow", suite: "capability", entry: "unit", tags: ["personality", "card", "tool"],
  },
  turns: [{
    index: 1,
    description: "解析工具类别，并逐 key 核对四个 getter 取到的是 Card 文案而非中性兜底",
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

          // 4) 标量阶段（状态行）也走同一条 Card 链路：thinking/planning/retry 都有 Card 文本
          for (const key of ["thinking", "planning", "error", "retry"] as const) {
            const text = getSimpleStage(key)
            if (text !== PROBE_STAGES[key]) throw new Error(`${key} 未取到 Card 文案: ${JSON.stringify(text)}`)
          }
          // 5) 命令输出：每个 key 都必须来自 Card，不能有 key 落到中性常量
          for (const key of COMMAND_KEYS) {
            if (getCommandReply(key) !== PROBE_STAGES.commands[key]) {
              throw new Error(`commands.${key} 未取到 Card 文案: ${JSON.stringify(getCommandReply(key))}`)
            }
          }
          // 6) 兜底正文同样按 key 取 Card 文本（数组型 llmUnavailable 按元素命中）
          for (const key of FALLBACK_KEYS) {
            const probe = getFallbackReply(key)
            const expected = PROBE_STAGES.fallbacks[key]
            const hit = Array.isArray(expected) ? expected.includes(probe) : probe === expected
            if (!hit) throw new Error(`fallbacks.${key} 未取到 Card 文案: ${JSON.stringify(probe)}`)
          }
        } finally { restoreStagesCache(saved) }
        // 7) 兜底也非空（UI 取用点永不显示空串）
        if (!getStagePrompt("executing", "_default")) throw new Error("getStagePrompt 返回空串")
        // 8) Card 完全不可用时回中性常量：命令输出与标量阶段都不能是空串（空框就是静默失效）
        clearStagesCache()
        if (!getSimpleStage("thinking")) throw new Error("无 Card 时 thinking 回退为空")
        if (!getSimpleStage("retry")) throw new Error("无 Card 时 retry 回退为空")
        for (const key of COMMAND_KEYS) {
          if (!getCommandReply(key)) throw new Error(`无 Card 时 commands.${key} 回退为空`)
        }
        for (const key of FALLBACK_KEYS) {
          if (!getFallbackReply(key)) throw new Error(`无 Card 时 fallbacks.${key} 回退为空`)
        }
      },
    }],
  }],
}

export default 阶段文案链路
