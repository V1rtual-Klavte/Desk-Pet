// ==========================================
// 核心引擎 —— Plan 步骤（助手模式复杂任务预判拆解）
// Phase 3: 当前为桩实现，拆解为步骤列表注入上下文
// 后续 Phase 4 完善：模型预判 + 步骤追踪 + 动态调整
// ==========================================

import type { ThinkingEffort } from "@/services/agent/types"
import { modeConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Plan")

/** 复杂任务关键词（触发 Plan 拆解） */
const COMPLEX_KEYWORDS = [
  "整理", "分析", "重构", "优化", "总结", "部署", "迁移",
  "帮我整理", "帮我分析", "帮我重构", "全部", "所有",
  "批量", "递归", "遍历",
]

/** Plan 步骤结果 */
export interface PlanResult {
  /** 是否触发 Plan */
  triggered: boolean
  /** 拆解后的步骤列表 */
  steps: string[]
  /** 追加到 SystemPrompt 的 Plan 提示 */
  hint: string
}

/**
 * 判断是否应触发 Plan，并生成简单步骤拆解。
 * 助手模式 + 高思考强度 + 复杂关键词 → 触发。
 */
export function planStep(
  userText: string,
  thinkingEffort: ThinkingEffort,
  availableTools: string[],
): PlanResult {
  // 仅助手模式生效
  if (!modeConfig.assistant) {
    return { triggered: false, steps: [], hint: "" }
  }

  // 仅 high 强度触发
  if (thinkingEffort !== "high") {
    return { triggered: false, steps: [], hint: "" }
  }

  // 检测复杂关键词
  const hasComplex = COMPLEX_KEYWORDS.some(kw => userText.includes(kw))
  if (!hasComplex) {
    return { triggered: false, steps: [], hint: "" }
  }

  // ── 拆解为步骤（桩：基于关键词简单拆解）──
  const steps: string[] = []

  if (userText.includes("文件") || userText.includes("文件夹") || userText.includes("目录")) {
    steps.push("1. 列出目标目录内容 (file_list)")
  }
  if (userText.includes("分析") || userText.includes("看看") || userText.includes("检查")) {
    steps.push("2. 读取关键文件内容 (file_read)")
  }
  if (userText.includes("整理") || userText.includes("移动") || userText.includes("归类")) {
    steps.push("3. 规划整理方案")
  }
  if (userText.includes("搜索") || userText.includes("找")) {
    steps.push("4. 执行搜索 (file_search)")
  }
  if (steps.length === 0) {
    steps.push("1. 分析需求")
    steps.push("2. 调用必要工具")
    steps.push("3. 组织结果回复")
  }

  const hint = `\n\n[任务规划]\n请按以下步骤执行:\n${steps.join("\n")}\n\n完成每步后根据结果决定下一步。`

  log.info("Plan 触发:", steps.length, "步", "| userText:", userText.substring(0, 40))
  return { triggered: true, steps, hint }
}
