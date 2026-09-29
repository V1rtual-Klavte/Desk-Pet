// ==========================================
// Skill 渐进披露与清单刷新 —— 从 test/e2e/scenes/tool-execution/Skill渐进加载.scene.ts 迁到 L2
// ==========================================
//
// 原场景读写真实 `data_root/skills/`；L2 把数据根指向临时目录（`setTestDataRoot`），
// 读写都在可弃根内。清单来源与合法性判定都是 Pi loader（经 `syncSkillCatalog` 的指纹核对）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { errorCode } from "@/services/error"
import { initPaths } from "@/services/paths"
import {
  deleteSkill,
  getSkillCatalogError,
  getSkillCatalogFingerprint,
  getSkillsPromptBlock,
  listSkills,
  syncSkillCatalog,
  upsertSkill,
} from "@/services/skill"

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

let root = ""

// 路径模块只认第一次初始化时的数据根（`initPaths` 幂等）：整份文件共用同一个临时根，
// 用例之间的隔离靠清掉探针技能，不靠换根。
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-skill-"))
  setTestDataRoot(root)
  await initPaths()
})

beforeEach(clean)
afterEach(clean)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Skill 渐进加载", () => {
  it("披露块只含 name/description/location（正文按需 read），超预算时丢整条 [tool-skill-metadata-progressive]", async () => {
    await clean()
    try {
      expect(await upsertSkill(source(ALPHA, "预算探针 alpha", LONG_BODY))).not.toBeNull()
      expect(await upsertSkill(source(BETA, "预算探针 beta"))).not.toBeNull()

      // ① 清单是 Pi loader 的产物：name / description / content（正文全文）/ 落盘坐标。
      const enabled = await syncSkillCatalog()
      const alpha = listSkills().find(skill => skill.name === ALPHA)
      const beta = listSkills().find(skill => skill.name === BETA)
      expect(alpha, "生效清单缺少 alpha").toBeDefined()
      expect(beta, "生效清单缺少 beta").toBeDefined()
      expect(enabled.map(skill => skill.name)).toContain(ALPHA)
      expect(alpha?.description).toBe("预算探针 alpha")
      // 清单条目带正文全文（Pi 的 Skill.content 就是正文）
      expect(alpha?.content).toContain("FULL_SKILL_BODY_MUST_STAY_OUT_OF_PROMPT")
      expect(alpha?.relativePath).toBe(ALPHA)
      expect(alpha?.filePath.endsWith("SKILL.md")).toBe(true)
      expect(alpha?.filePath).not.toBe(beta?.filePath)

      // ② 披露块是 Pi formatter 的形状：只有 name / description / location。
      const block = getSkillsPromptBlock()
      for (const [name, skill] of [[ALPHA, alpha], [BETA, beta]] as const) {
        expect(block).toContain(`<name>${name}</name>`)
        expect(block, `披露块缺少 location（模型据此按需 read）: ${name}`).toContain(
          `<location>${skill?.filePath}</location>`,
        )
      }
      expect(block).toContain("<description>预算探针 alpha</description>")
      // 渐进披露的载荷：正文不在块里，模型必须按 location 自己去读。
      // 头尾各查一段（只查开头的标记时，注入「后半段正文」的坏实现照样绿）；
      // 前提是正文比整块的字符预算还长，否则「没进块」可以被「正文本来就短」解释。
      expect(LONG_BODY.length).toBeGreaterThan(8 * 1024)
      expect(block).not.toContain(LONG_BODY.slice(0, 256))
      expect(block).not.toContain(LONG_BODY.slice(-256))
      // 没有 mode / invocationPolicy 过滤：生效的技能全在同一份块里。
      const fullNames = skillNames(block)
      expect(fullNames).toContain(ALPHA)
      expect(fullNames).toContain(BETA)

      // ③ 预算截断丢整条，不截断单条：收紧一个字符 → 恰好少末尾一条，且结构完整。
      const fullCount = entryCount(block)
      expect(fullCount, "披露块里生效技能不足两条，预算断言不成立").toBeGreaterThanOrEqual(2)
      const slim = getSkillsPromptBlock({ maxChars: block.length - 1 })
      const kept = entryCount(slim)
      expect(kept, `预算收紧一个字符后保留 ${kept} 条（应丢末尾一条，共 ${entryCount(block)} 条）`).toBe(fullCount - 1)
      expect((slim.match(/<\/skill>/g) ?? []).length).toBe(kept)
      expect(slim.trimEnd().endsWith("</available_skills>")).toBe(true)
      // 丢的是末尾：保留的名单是完整块名单的前缀。
      expect(skillNames(slim)).toEqual(fullNames.slice(0, kept))
    } finally {
      await clean()
    }
  })

  it("清单刷新只由指纹入口驱动：保存与删除立即生效、稳态复用缓存、成功后不留错误 [tool-skill-catalog-invalidation]", async () => {
    await clean()
    try {
      const saved = await upsertSkill(source(ALPHA, "更新前描述"))
      expect(saved, "技能没有被 Pi loader 收录").not.toBeNull()
      // 删除坐标是 skills 根内的域内相对路径，不是 frontmatter 的 name（按 name 索引会删错对象）。
      const coordinate = saved?.relativePath
      expect(coordinate).toBe(ALPHA)
      const before = getSkillCatalogFingerprint()
      expect(before, "保存后仍没有指纹（从未核对成功）").toBeTruthy()

      // 保存覆盖立即生效：写入经唯一刷新入口，没有 TTL、不需要重启。
      await upsertSkill(source(ALPHA, "更新后描述更长"))
      const updated = listSkills().find(skill => skill.name === ALPHA)
      expect(updated?.description).toBe("更新后描述更长")
      expect(getSkillCatalogFingerprint()).not.toBe(before)

      // 稳态：指纹没变时复用同一份快照（条目对象身份不变，说明没有重载）。
      const cached = await syncSkillCatalog()
      expect(listSkills().find(skill => skill.name === ALPHA)).toBe(updated)
      expect(cached.some(skill => skill.name === ALPHA)).toBe(true)

      // 任何一次成功核对（含命中缓存的早退）都清空上次的失败原因，不留错误残留。
      expect(getSkillCatalogError()).toBeNull()

      // 用清单给出的坐标删除：条目真的从清单里消失。
      await deleteSkill(coordinate!)
      expect(listSkills().some(skill => skill.name === ALPHA)).toBe(false)
    } finally {
      await clean()
    }
  })
})
