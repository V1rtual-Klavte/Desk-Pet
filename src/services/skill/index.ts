// ==========================================
// Skill —— 统一导出
//
// Skill 不是工具：它不注册 ToolDef、不占工具声明槽，而是把 name / description / location 注入
// system prompt，正文只在显式调用（`accept({kind:"skill"})`，T8）或模型主动 read 时进入对话。
//
// 真相源是 data_root/skills/ 下的 `SKILL.md`（Pi `loadSkills` 递归遍历，根级 `.md` 也算技能，
// `name` 可缺省取目录名）；随包种子只在首次启动复制一次。
// 清单状态唯一所有者在 store.ts，`syncSkillCatalog()` 是唯一的刷新入口（指纹核对）。
// ==========================================

export {
  getSkillCatalogError,
  getSkillCatalogFingerprint,
  listEnabledSkills,
  listSkillDiagnostics,
  listSkills,
  syncSkillCatalog,
} from "./store"
export type { ManagedSkill, SkillCatalogFingerprint } from "./store"

export { deleteSkill, getSkillsPromptBlock, setSkillEnabled, upsertSkill } from "./loader"
