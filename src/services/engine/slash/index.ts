// ==========================================
// Slash 命令系统 —— 统一导出
// ==========================================

export type { SlashCommand, SlashCommandResult, SlashInvocation, SlashMatch, SlashSkillAdmission } from "./types"
export { register, registerAll, find, search, listAll } from "./registry"
export { initSlashCommands } from "./commands"
