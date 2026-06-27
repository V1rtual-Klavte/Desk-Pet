// ==========================================
// Skill Runner —— 执行 Skill 编排
// 解析 steps → 构建 Skill 上下文 → 子循环调用工具 → 拼结果
// ==========================================

import type { SkillDef } from "./loader"
import type { ToolDef } from "@/services/tool/types"
import { runSubLoop } from "@/services/agent/sub-loop"
import { createLogger } from "@/services/logger"

const log = createLogger("SkillRunner")

/**
 * 执行 Skill。
 * 将 Skill 的 systemPrompt + steps 注入子代理上下文，
 * 子代理在 Skill 的工具集范围内执行任务，最多 3 轮。
 */
export async function runSkill(
  skill: SkillDef,
  params: Record<string, unknown>,
): Promise<{ success: boolean; content: string }> {
  log.debug("执行 Skill:", skill.meta.id, "| 工具:", (skill.meta.tools_needed ?? []).join(",") || "无")

  const query = String(params.query ?? "")

  // ── 构建 Skill 专用上下文 ──
  const systemPrompt = [
    `你正在使用"${skill.meta.name}"技能。`,
    skill.systemPrompt,
    "",
    "执行步骤:",
    skill.steps,
    "",
    "请严格按照步骤执行，使用可用工具获取信息后给出最终结果。用简短中文回复。",
  ].join("\n")

  // ── 获取 Skill 声明的工具 ──
  const { getToolByName } = await import("@/services/tool/registry")
  const tools: ToolDef[] = []
  const neededNames = skill.meta.tools_needed ?? []
  for (const name of neededNames) {
    const t = getToolByName(name)
    if (t) {
      tools.push(t)
    } else {
      log.warn("Skill 声明的工具未注册:", name)
    }
  }

  // 如果没有声明工具，给只读工具集
  if (tools.length === 0) {
    const allPet = (await import("@/services/tool/registry")).getToolsForMode("pet")
    tools.push(...allPet)
  }

  // ── 子循环执行 ──
  const result = await runSubLoop({
    task: query,
    tools,
    systemPrompt,
    maxRounds: 3,
    timeoutMs: 60000,
  })

  if (result.success) {
    return { success: true, content: `[${skill.meta.name}] ${result.reply}` }
  }
  return {
    success: false,
    content: result.error ?? "Skill 执行未返回结果",
  }
}
