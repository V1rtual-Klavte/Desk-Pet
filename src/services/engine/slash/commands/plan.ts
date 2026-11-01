// ==========================================
// /plan <目标> — 显式计划入口
//
// 命令只判定这次输入能不能走计划：开关打开、目标非空。
// 计划生成、确认、执行与面板事件都在运行入口（`runtime/plan-phase.ts`）。
// 命令层返回一次计划请求，由预处理把它当普通用户输入投递（目标即用户正文），
// 运行入口据标记进入计划相位 —— 命令层不生成计划、不写会话条目。
// ==========================================

import type { SlashCommand, SlashCommandResult } from "../types"
import { planConfig } from "@/services/config"

export const planCommand: SlashCommand<SlashCommandResult> = {
  name: "plan",
  description: "为本次请求生成并执行计划",
  category: "session",
  args: "<目标>",
  // 计划会写会话记录、驱动确认面板并独占一次运行：忙碌期明确拒绝，不在回合中途排队。
  busyPolicy: "exclusive",
  acceptsArgs: true,
  async execute(args) {
    if (!planConfig.enabled) return "计划功能已关闭（设置项 ai.plan.enabled）。"
    const goal = (args ?? "").trim()
    if (!goal) return "用法：/plan <目标>"
    return { kind: "plan", goal }
  },
}
