import type { SceneDef } from "../../types"
import { executeToolDefinition, getToolByName } from "@/services/tool"
import { getLastWindowChange } from "@/services/window"
import { getOverride, setOverride } from "@/services/config"

/**
 * window_info 的三态（te-22）。
 *
 * 工具只读 `window/listener.ts` 缓存的最近一次 window-changed，三态都如实返回 success: true 的行式文本：
 * `ai.windowMonitor.enabled=false` → 「未开启」；已开启但尚未收到事件 → 「尚未收到窗口变化事件」；
 * 有快照 → 三行（标题 / 内容 / 观测时间）。
 *
 * **可验证性边界（§8.10）**：`initWindowListener` 只在 `App.vue` 被调用，Live 宿主不挂 listener，
 * 因此模块内的快照恒为 null —— 本场景只能覆盖前两态，第三态（三行快照）没有任何入口能在宿主里造出来。
 * 这里不假装覆盖它，而是把「没有编造窗口信息」作为反向断言：不开启时正文不得出现三行形状的任何一行。
 *
 * 快照恒为 null 这件事本身也要先断言（见下）：将来宿主挂了 listener，这条前置会失败，
 * 提示场景作者重写，而不是让「未观测到」一侧悄悄变成一条永远不成立的断言。
 */
const TOOL_NAME = "window_info"
const DISABLED_MARK = "窗口监控未开启"
const NOT_OBSERVED_MARK = "尚未收到窗口变化事件"
/** 三行快照的任意一行；它不该出现在前两态里。 */
const SNAPSHOT_MARKS = ["窗口标题:", "窗口内容:", "观测时间:"]

/** 场景自己改的配置：按「原始覆盖值」（未必存在）还原，不把开发配置的当前值当默认值。 */
let originalEnabled: boolean | undefined

export const 窗口信息三态: SceneDef = {
  meta: {
    caseId: "tool-window-info-states", module: "tool-execution", contractId: "te-22",
    description: "window_info 未开启与未观测到两态都如实返回 success: true 的行式文本，不编造窗口快照",
    depth: "shallow", suite: "regression", entry: "unit", tags: ["tool-execution", "boundary"],
  },
  setup: async () => {
    originalEnabled = getOverride<boolean>("ai.windowMonitor.enabled")
  },
  turns: [{
    index: 1,
    description: "核对未开启与未观测到两态的可辨文本与注册声明",
    userText: "检查窗口信息工具的两态。",
    checks: [{
      type: "expectWindowInfoStates",
      run: async () => {
        try {
          // ① 注册声明：SAFE / os.info 的只读工具，不新增 ActionCategory、不自己挂监听（后者无法在宿主里观测）。
          const tool = getToolByName(TOOL_NAME)
          if (!tool) throw new Error(`窗口信息工具未注册: ${TOOL_NAME}`)
          if (tool.id !== "local-window-info") throw new Error(`窗口信息工具的 id 变了: ${tool.id}`)
          if (tool.safetyLevel !== "SAFE") throw new Error(`窗口信息工具不是 SAFE: ${tool.safetyLevel}`)
          if (tool.actionCategory !== "os.info") throw new Error(`窗口信息工具新增了 ActionCategory: ${tool.actionCategory}`)
          if (tool.source !== "local" || tool.sourceId !== "") throw new Error("窗口信息工具的来源不是内置 local")
          if (tool.policy.execution.effect !== "read" || tool.policy.execution.isolation !== "shared_read") {
            throw new Error(`窗口信息工具不是共享只读: ${tool.policy.execution.effect}/${tool.policy.execution.isolation}`)
          }
          if (tool.policy.permission.defaultDecision !== "allow") {
            throw new Error(`窗口信息工具的权限意见不是 allow: ${tool.policy.permission.defaultDecision}`)
          }

          // ② 关闭监控：如实说「未开启」，不得给出任何窗口快照。
          setOverride("ai.windowMonitor.enabled", false)
          const disabled = await executeToolDefinition(tool, {}, { toolCallId: "window-info-disabled" })
          if (!disabled.success) throw new Error(`未开启态没有如实成功返回: ${disabled.error ?? ""}`)
          if (!disabled.content.includes(DISABLED_MARK)) {
            throw new Error(`未开启态正文没有说明监控未开启: ${JSON.stringify(disabled.content)}`)
          }
          assertNoSnapshot("未开启", disabled.content)

          // ③ 开启但宿主没有挂 listener：缓存恒为 null，如实说「尚未收到事件」。
          // 这条前置不成立说明宿主已经挂了 listener（或别处写入了快照），本场景的断言需要重写。
          if (getLastWindowChange() !== null) {
            throw new Error("宿主已存在窗口快照：本场景的「未观测到」一侧不再成立，需重写")
          }
          setOverride("ai.windowMonitor.enabled", true)
          const unobserved = await executeToolDefinition(tool, {}, { toolCallId: "window-info-unobserved" })
          if (!unobserved.success) throw new Error(`未观测到态没有如实成功返回: ${unobserved.error ?? ""}`)
          if (!unobserved.content.includes(NOT_OBSERVED_MARK)) {
            throw new Error(`未观测到态正文没有说明尚未收到事件: ${JSON.stringify(unobserved.content)}`)
          }
          if (unobserved.content.includes(DISABLED_MARK)) throw new Error("已开启时的正文仍说监控未开启")
          assertNoSnapshot("未观测到", unobserved.content)
        } finally {
          // 还原开发配置里的原值；跨场景兜底由 standard-setup 的配置基线承担。
          setOverride("ai.windowMonitor.enabled", originalEnabled)
        }
      },
    }],
  }],
}

/** 前两态都不得出现三行快照的任何一行（「没有快照就不编造」的反向断言）。 */
function assertNoSnapshot(state: string, content: string): void {
  for (const mark of SNAPSHOT_MARKS) {
    if (content.includes(mark)) throw new Error(`${state}态正文编造了窗口快照字段「${mark}」: ${JSON.stringify(content)}`)
  }
}

export default 窗口信息三态
