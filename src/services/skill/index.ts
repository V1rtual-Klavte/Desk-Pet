// ==========================================
// Skill —— 统一导出
//
// Skill 不是工具：它不注册 ToolDef、不占工具声明槽，
// 而是把 name / description / location 注入 system prompt，
// 由模型用 read 工具按需加载正文（Pi 原生渐进披露）。
//
// 真相源是 data_root/skills/{name}/SKILL.md，随包种子只在首次启动复制一次。
// ==========================================

export {
  loadSkills,
  refreshSkills,
  listSkills,
  getSkillsPromptBlock,
  parseSkillSource,
  upsertSkill,
  deleteSkill,
} from "./loader"
export type { SkillSource } from "./loader"
