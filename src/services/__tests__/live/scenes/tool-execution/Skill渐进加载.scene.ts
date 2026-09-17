import type { SceneDef } from "../../types"
import { deleteSkill, ensureSkillCatalog, getSkillsPromptBlock, getSkillCatalogFingerprint, listSkills, upsertSkill } from "@/services/skill"
import { setOverride, toolsConfig } from "@/services/config"

const PET = "live-skill-pet"
const ASSISTANT = "live-skill-assistant"
const LONG_BODY = `FULL_SKILL_BODY_MUST_NOT_ENTER_CATALOG_${"正文只允许按需 read。".repeat(12_000)}`

function source(name: string, description: string, invocationPolicy: "pet" | "assistant" | "both", body = "按需读取这份 Skill 的正文。"): string {
  return `---\nname: ${name}\ndescription: ${description}\ninvocationPolicy: ${invocationPolicy}\ncapabilityTags: [memory, test]\nprivateInstruction: ${LONG_BODY.slice(0, 80)}\n---\n\n${body}`
}

async function clean(): Promise<void> {
  await Promise.allSettled([deleteSkill(PET), deleteSkill(ASSISTANT)])
}

export const Skill元数据渐进加载: SceneDef = {
  meta: {
    caseId: "tool-skill-metadata-progressive",
    module: "tool-execution",
    contractId: "te-11",
    description: "Skill catalog 只缓存 frontmatter 元数据，按模式列出 location",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["tool-execution", "skill", "boundary"],
  },
  turns: [{
    index: 1,
    description: "长正文不进入 catalog 或 prompt，pet/assistant 只看到各自 policy",
    userText: "校验 Skill 渐进加载。",
    checks: [{
      type: "expectMetadataOnlySkillCatalog",
      run: async () => {
        const previousEnabled = toolsConfig.skillEnabled
        try {
          await clean()
          setOverride("tools.skill.enabled", true)
          await upsertSkill(source(PET, "轻量陪伴用 Skill", "pet", LONG_BODY))
          await upsertSkill(source(ASSISTANT, "助手专用 Skill", "assistant"))
          const entries = await ensureSkillCatalog()
          const pet = entries.find(skill => skill.name === PET)
          if (!pet || Object.prototype.hasOwnProperty.call(pet, "body") || Object.prototype.hasOwnProperty.call(pet, "raw")) {
            throw new Error("catalog 保存了 Skill 正文或缺少 pet 元数据")
          }
          if (JSON.stringify(pet).includes("FULL_SKILL_BODY_MUST_NOT_ENTER_CATALOG")) {
            throw new Error("Skill 正文进入了 metadata catalog")
          }
          const petPrompt = getSkillsPromptBlock({ mode: "pet" })
          const assistantPrompt = getSkillsPromptBlock({ mode: "assistant" })
          if (!petPrompt.includes(`name=\"${PET}\"`) || petPrompt.includes(`name=\"${ASSISTANT}\"`)) {
            throw new Error("pet Skill policy 筛选错误")
          }
          if (!assistantPrompt.includes(`name=\"${ASSISTANT}\"`) || assistantPrompt.includes(`name=\"${PET}\"`)) {
            throw new Error("assistant Skill policy 筛选错误")
          }
          if (petPrompt.includes("FULL_SKILL_BODY_MUST_NOT_ENTER_CATALOG") || petPrompt.includes("privateInstruction")) {
            throw new Error("Skill prompt 注入了正文或未声明的 frontmatter")
          }
        } finally {
          setOverride("tools.skill.enabled", previousEnabled)
          await clean()
        }
      },
    }],
  }],
}

export const Skill目录更新失效: SceneDef = {
  meta: {
    caseId: "tool-skill-catalog-invalidation",
    module: "tool-execution",
    contractId: "te-12",
    description: "Skill 更新和删除必须让 metadata catalog 重新读取真相源",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["tool-execution", "skill", "error"],
  },
  turns: [{
    index: 1,
    description: "保存覆盖和删除后 catalog 不保留旧条目",
    userText: "校验 Skill catalog 失效。",
    checks: [{
      type: "expectSkillCatalogInvalidation",
      run: async () => {
        try {
          await clean()
          await upsertSkill(source(PET, "更新前描述", "both"))
          const before = getSkillCatalogFingerprint()
          await upsertSkill(source(PET, "更新后描述更长", "both"))
          const updated = listSkills().find(skill => skill.name === PET)
          if (!updated || updated.description !== "更新后描述更长") throw new Error("保存覆盖后仍返回旧 Skill 元数据")
          if (getSkillCatalogFingerprint() === before) throw new Error("Skill 内容变化后 catalog fingerprint 未失效")
          await deleteSkill(PET)
          if (listSkills().some(skill => skill.name === PET)) throw new Error("删除 Skill 后 catalog 仍保留旧条目")
        } finally {
          await clean()
        }
      },
    }],
  }],
}

export default Skill元数据渐进加载
