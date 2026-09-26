import type { SceneDef } from "../../types"
import { deleteSkill, getSkillCatalogError, getSkillCatalogFingerprint, getSkillsPromptBlock, listSkills, syncSkillCatalog, upsertSkill } from "@/services/skill"
import { errorCode } from "@/services/error"

/**
 * Skill 的渐进披露（te-11）与清单刷新（te-12）。
 *
 * 合法性与清单来源都是 Pi 的 `loadSkills`：`syncSkillCatalog()` 每次恰好一次 Rust 指纹核对，
 * 指纹变了才重载，返回**生效清单**（`enabled !== false` 过滤后）。条目就是 Pi 的 `Skill`
 * 加上我们自有的 `enabled` / `relativePath` —— `content` 是正文全文，「catalog 只留元数据」
 * 的旧前提已反转。
 *
 * 进模型视野的只有披露块：Pi `formatSkillsForSystemPrompt` 的形状
 * （`<skill>` / `<name>` / `<description>` / `<location>`），正文不在里面 —— 模型要读正文
 * 得按 location 自己 read，这正是「渐进披露」的载荷。
 *
 * 场景读写真实 `data_root/skills/`，跑前请备份运行时数据。
 */

/** 两条探针技能：frontmatter `name` 同时也是落盘目录名（upsert 的写入坐标）。 */
const ALPHA = "live-skill-alpha"
const BETA = "live-skill-beta"
/** 长正文：够长才说明「正文不在披露块里」不是因为它本来就短。 */
const LONG_BODY = `FULL_SKILL_BODY_MUST_STAY_OUT_OF_PROMPT_${"正文只允许按需 read。".repeat(12_000)}`

/** 技能原文：只声明 Pi 认的字段（name / description），描述与正文都逐字可辨。 */
function source(name: string, description: string, body = "按需读取这份 Skill 的正文。"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
}

/**
 * 清理是幂等的尽力而为：条目本来就不存在时 Rust 如实返回 PATH_NOT_FOUND
 * （`remove_skill_entry` 刻意不再静默成功），只有这一种情况可以容忍，其余照旧抛出。
 */
async function clean(): Promise<void> {
  for (const relativePath of [ALPHA, BETA]) {
    try {
      await deleteSkill(relativePath)
    } catch (error) {
      if (errorCode(error) !== "PATH_NOT_FOUND") throw error
    }
  }
}

const skillNames = (block: string): string[] => [...block.matchAll(/<name>(.*?)<\/name>/g)].map(match => match[1] ?? "")
const entryCount = (block: string): number => (block.match(/<skill>/g) ?? []).length

export const Skill披露块与预算截断: SceneDef = {
  meta: {
    caseId: "tool-skill-metadata-progressive",
    module: "tool-execution",
    contractId: "te-11",
    description: "披露块只含 name/description/location（正文按需 read），超预算时丢整条",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["tool-execution", "skill", "boundary"],
  },
  turns: [{
    index: 1,
    description: "清单来自 Pi loader 且带正文，披露块只出元数据；预算收紧时整条丢弃",
    userText: "校验 Skill 披露块与预算截断。",
    checks: [{
      type: "expectSkillDisclosureBlock",
      run: async () => {
        await clean()
        try {
          if (!await upsertSkill(source(ALPHA, "预算探针 alpha", LONG_BODY))) throw new Error("alpha 技能没有被 Pi loader 收录")
          if (!await upsertSkill(source(BETA, "预算探针 beta"))) throw new Error("beta 技能没有被 Pi loader 收录")

          // ① 清单是 Pi loader 的产物：name / description / content（正文全文）/ 落盘坐标。
          const enabled = await syncSkillCatalog()
          const alpha = listSkills().find(skill => skill.name === ALPHA)
          const beta = listSkills().find(skill => skill.name === BETA)
          if (!alpha || !beta || !enabled.some(skill => skill.name === ALPHA)) {
            throw new Error(`生效清单缺少探针技能: ${enabled.map(skill => skill.name).join(",")}`)
          }
          if (alpha.description !== "预算探针 alpha") throw new Error(`清单里的描述不是磁盘上的值: ${alpha.description}`)
          if (!alpha.content.includes("FULL_SKILL_BODY_MUST_STAY_OUT_OF_PROMPT")) {
            throw new Error("清单条目没有带上正文（Pi 的 Skill.content 就是正文）")
          }
          if (alpha.relativePath !== ALPHA || !alpha.filePath.endsWith("SKILL.md")) {
            throw new Error(`清单条目缺少落盘坐标: ${JSON.stringify({ filePath: alpha.filePath, relativePath: alpha.relativePath })}`)
          }
          if (alpha.filePath === beta.filePath) throw new Error("两个探针技能指向同一份文件")

          // ② 披露块是 Pi formatter 的形状：只有 name / description / location。
          const block = getSkillsPromptBlock()
          for (const [name, skill] of [[ALPHA, alpha], [BETA, beta]] as const) {
            if (!block.includes(`<name>${name}</name>`)) throw new Error(`披露块缺少技能名: ${name}`)
            if (!block.includes(`<location>${skill.filePath}</location>`)) {
              throw new Error(`披露块缺少 location（模型据此按需 read）: ${name}`)
            }
          }
          if (!block.includes("<description>预算探针 alpha</description>")) throw new Error("披露块缺少描述")
          // 渐进披露的载荷：正文不在块里，模型必须按 location 自己去读。
          if (block.includes("FULL_SKILL_BODY_MUST_STAY_OUT_OF_PROMPT")) throw new Error("披露块注入了技能正文")
          if (block.length >= LONG_BODY.length) throw new Error(`披露块比正文还长: ${block.length}`)
          // 没有 mode / invocationPolicy 过滤：生效的技能全在同一份块里。
          const fullNames = skillNames(block)
          if (!fullNames.includes(ALPHA) || !fullNames.includes(BETA)) {
            throw new Error(`披露块没有列出全部生效技能: ${fullNames.join(",")}`)
          }

          // ③ 预算截断丢整条，不截断单条：收紧一个字符 → 恰好少末尾一条，且结构完整。
          const fullCount = entryCount(block)
          if (fullCount < 2) throw new Error(`披露块里生效技能不足两条（${fullCount}），预算断言不成立`)
          const slim = getSkillsPromptBlock({ maxChars: block.length - 1 })
          const kept = entryCount(slim)
          if (kept !== entryCount(block) - 1) {
            throw new Error(`预算收紧一个字符后保留 ${kept} 条（应只丢末尾一条，共 ${entryCount(block)} 条）`)
          }
          if ((slim.match(/<\/skill>/g) ?? []).length !== kept || !slim.trimEnd().endsWith("</available_skills>")) {
            throw new Error("截断后的披露块结构不完整（出现了半条技能）")
          }
          // 丢的是末尾：保留的名单是完整块名单的前缀。
          const keptNames = skillNames(slim)
          if (!keptNames.every((name, index) => name === fullNames[index])) {
            throw new Error(`截断没有保留前缀: ${keptNames.join(",")} vs ${fullNames.join(",")}`)
          }
        } finally {
          await clean()
        }
      },
    }],
  }],
}

export const Skill清单刷新: SceneDef = {
  meta: {
    caseId: "tool-skill-catalog-invalidation",
    module: "tool-execution",
    contractId: "te-12",
    description: "清单刷新只由指纹入口驱动：保存与删除立即生效、稳态复用缓存、成功后不留错误",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["tool-execution", "skill", "error"],
  },
  turns: [{
    index: 1,
    description: "保存覆盖、稳态复用与删除都经 syncSkillCatalog 收敛",
    userText: "校验 Skill 清单刷新。",
    checks: [{
      type: "expectSkillCatalogRefresh",
      run: async () => {
        await clean()
        try {
          const saved = await upsertSkill(source(ALPHA, "更新前描述"))
          if (!saved) throw new Error("技能没有被 Pi loader 收录")
          // 删除坐标是 skills 根内的域内相对路径，不是 frontmatter 的 name（按 name 索引会删错对象）。
          const coordinate = saved.relativePath
          if (!coordinate || coordinate !== ALPHA) throw new Error(`删除坐标不是域内相对路径: ${saved.relativePath}`)
          const before = getSkillCatalogFingerprint()
          if (!before) throw new Error("保存后仍没有指纹（从未核对成功）")

          // 保存覆盖立即生效：写入经唯一刷新入口，没有 TTL、不需要重启。
          await upsertSkill(source(ALPHA, "更新后描述更长"))
          const updated = listSkills().find(skill => skill.name === ALPHA)
          if (!updated || updated.description !== "更新后描述更长") {
            throw new Error(`保存覆盖后清单仍是旧元数据: ${updated?.description}`)
          }
          if (getSkillCatalogFingerprint() === before) throw new Error("内容变化后指纹没有变化")

          // 稳态：指纹没变时复用同一份快照（条目对象身份不变，说明没有重载）。
          const cached = await syncSkillCatalog()
          if (listSkills().find(skill => skill.name === ALPHA) !== updated) throw new Error("指纹未变却重载了清单")
          if (!cached.some(skill => skill.name === ALPHA)) throw new Error("生效清单缺少技能")

          // 任何一次成功核对（含命中缓存的早退）都清空上次的失败原因，不留错误残留。
          if (getSkillCatalogError() !== null) throw new Error(`成功核对后仍记录着错误: ${getSkillCatalogError()}`)

          // 用清单给出的坐标删除：条目真的从清单里消失。
          await deleteSkill(coordinate)
          if (listSkills().some(skill => skill.name === ALPHA)) throw new Error("删除后清单仍保留旧条目")
        } finally {
          await clean()
        }
      },
    }],
  }],
}

export default Skill披露块与预算截断
