// ==========================================
// Skill —— 统一导出
//
// Skill 不是工具：它不注册 ToolDef、不占工具声明槽，
// 而是把 name / description / location 注入 system prompt，
// 由模型用 read 工具按需加载正文（Pi 原生渐进披露）。
// ==========================================

export {
  loadSkills,
  refreshSkills,
  listSkills,
  isUserSkill,
  getSkillsPromptBlock,
  parseSkillSource,
  upsertUserSkill,
  removeUserSkill,
} from "./loader"
export type { SkillSource } from "./loader"
