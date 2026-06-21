// ==========================================
// Skill Runner —— 执行 Skill 编排
// Phase 4 完成完整内循环逻辑
// ==========================================

import type { SkillDef } from "./loader"
import { createLogger } from "@/services/logger"

const log = createLogger("SkillRunner")

/**
 * 执行 Skill。
 * Phase 4 将实现完整编排：解析 steps → 调用 Local/MCP 工具 → 拼结果。
 * 当前做参数透传。
 */
export async function runSkill(
  skill: SkillDef,
  params: Record<string, unknown>,
): Promise<{ success: boolean; content: string }> {
  log.debug("执行 Skill:", skill.meta.id)
  const query = String(params.query ?? "")

  return {
    success: true,
    content: `[Skill: ${skill.meta.name}]\n处理请求: ${query}\n\n需要工具: ${(skill.meta.tools_needed ?? []).join(", ") || "无"}\n\n(完整执行引擎 Phase 4 实现)`,
  }
}
