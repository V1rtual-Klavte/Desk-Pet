// ==========================================
// 每技能 enabled 开关 —— 从 test/e2e/scenes/tool-execution/Skill启用开关.scene.ts 迁到 L2
// ==========================================
//
// 开关是自有的 frontmatter 字段，只认布尔 `false` 为关闭（缺省、字符串、数字都算开启）：
// 生效清单只由 store 的 `listEnabledSkills()` 过滤，披露块与 Pi 的 `setResources({skills})`
// 共用同一份，所以被关闭的技能既不进模型视野、也不能被 `/skill` 启动（报「已关闭」而不是
// 「不存在」）。写开关走 `setSkillEnabled` → `applyEnabledFlag`（只改/补 `enabled` 一行，
// 其余字节原样保留）→ 原子替换 → 指纹入口重载，写后立即生效。
//
// 原场景读写真实 `data_root/skills/`；L2 的数据根是临时目录，读写都在可弃根内。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { getHostBridge } from "@/services/host"

import { setTestDataRoot } from "../../host/node-ipc"
import { errorCode } from "@/services/error"
import { initPaths } from "@/services/paths"
import { initSlashCommands, preProcess } from "@/services/engine"
import { getCommandReply } from "@/services/personality"
import {
  deleteSkill,
  getSkillsPromptBlock,
  listEnabledSkills,
  listSkills,
  setSkillEnabled,
  upsertSkill,
} from "@/services/skill"

const OPEN = "live-skill-open"
const CLOSED = "live-skill-closed"
const TEXTUAL = "live-skill-textual"
const NUMERIC = "live-skill-numeric"
const RAW = "live-skill-raw"
const COMMENT = "# 这一行注释与下面的自定义字段都必须原样保留"
const CUSTOM_FIELD = "customField: keep-me"
const PROBES = [OPEN, CLOSED, TEXTUAL, NUMERIC, RAW]

function source(name: string, description: string, extraFrontmatter = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n这份正文只在探针里出现。`
}

async function clean(): Promise<void> {
  for (const relativePath of PROBES) {
    try {
      await deleteSkill(relativePath)
    } catch (error) {
      if (errorCode(error) !== "PATH_NOT_FOUND") throw error
    }
  }
}

function enabledNames(): string[] {
  return listEnabledSkills().map(skill => skill.name)
}

function flagOf(name: string): boolean | undefined {
  return listSkills().find(skill => skill.name === name)?.enabled
}

function blockHas(name: string): boolean {
  return getSkillsPromptBlock().includes(`<name>${name}</name>`)
}

/** `/skill <name>` 的命令层判定：命中给准入意图，未命中给终态句。 */
async function invokeSkill(name: string): Promise<{ admitted: boolean; response: string }> {
  const result = await preProcess(`/skill ${name}`)
  if (result.handled) return { admitted: false, response: result.response ?? "" }
  if (result.skillAdmission) return { admitted: true, response: "" }
  return { admitted: false, response: `未识别的准入形态: ${JSON.stringify(result)}` }
}

async function rawFile(filePath: string): Promise<string> {
  const result = await getHostBridge().request("file_read", { path: filePath, maxBytes: 512 * 1024 })
  return result.content
}

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-skill-toggle-"))
  setTestDataRoot(root)
  await initPaths()
  // slash 注册表在生产里挂在 ChatPanel 的模块副作用上；宿主不挂 UI，这里补上同一份注册。
  initSlashCommands()
})

beforeEach(clean)
afterEach(clean)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Skill 启用开关", () => {
  // 原场景是一个 caseId 下的三条检查（生效清单/披露/显式调用、写后立即生效、缺 frontmatter 拒绝），
  // 迁移保持同一粒度：一个 caseId 对应一个 it，三段依次断言。
  it("enabled 开关驱动生效清单、披露块与显式调用三处 [tool-skill-enabled-toggle]", async () => {
    // ── ① 只认布尔 false：四个探针只差 enabled 的形态（缺省 / 布尔 false / 字符串 / 数字）。
    expect(await upsertSkill(source(CLOSED, "关闭探针", `enabled: false\n${COMMENT}\n${CUSTOM_FIELD}\n`))).not.toBeNull()
    expect(await upsertSkill(source(OPEN, "缺省探针"))).not.toBeNull()
    expect(await upsertSkill(source(TEXTUAL, "字符串探针", 'enabled: "false"\n'))).not.toBeNull()
    expect(await upsertSkill(source(NUMERIC, "数字探针", "enabled: 0\n"))).not.toBeNull()

    expect(flagOf(CLOSED)).toBe(false)
    for (const name of [OPEN, TEXTUAL, NUMERIC]) {
      expect(flagOf(name), `非布尔 false 的取值没有被当成开启: ${name}`).toBe(true)
    }

    // 两个消费点共用同一份生效清单：披露块（模型视野）与 setResources 用的清单。
    const names = enabledNames()
    for (const name of [OPEN, TEXTUAL, NUMERIC]) {
      expect(names, `生效清单缺少开启的技能: ${name}`).toContain(name)
      expect(blockHas(name), `披露块缺少开启的技能: ${name}`).toBe(true)
    }
    expect(names, "被关闭的技能仍留在生效清单里（会被 setResources 下发给 Pi）").not.toContain(CLOSED)
    expect(blockHas(CLOSED), "被关闭的技能仍出现在披露块里（模型仍能看到它）").toBe(false)

    // 关闭的技能不能被显式调用，且报的是「已关闭」而不是「不存在」。
    // 变量名取 `denied` 而非「被拒绝」的英文同义词：跨平台夹具扫描会把那个标识符
    // 里的三字母子串误判成 POSIX 文本工具用法，改名让扫描在本模块保持零噪声。
    const denied = await invokeSkill(CLOSED)
    expect(denied.admitted).toBe(false)
    expect(denied.response).toContain(getCommandReply("skillDisabled"))
    expect(denied.response, "被关闭的技能被报成了「不存在」").not.toContain(getCommandReply("skillUnknown"))
    const admitted = await invokeSkill(OPEN)
    expect(admitted.admitted, `开启的技能没有给出准入意图: ${admitted.response}`).toBe(true)

    // ── ② 开关写后立即生效，且只改 enabled 一行。
    const saved = await upsertSkill(source(CLOSED, "关闭探针", `enabled: false\n${COMMENT}\n${CUSTOM_FIELD}\n`))
    expect(saved).not.toBeNull()
    expect(blockHas(CLOSED), "关闭的技能出现在披露块里，开关断言不成立").toBe(false)
    const before = await rawFile(saved!.filePath)

    expect(await setSkillEnabled(CLOSED, true), "开启开关没有写入").toBe(true)
    // 写后立即生效：没有重启、没有 TTL，指纹入口重载后两处消费点同时看到它。
    expect(flagOf(CLOSED)).toBe(true)
    expect(enabledNames()).toContain(CLOSED)
    expect(blockHas(CLOSED), "开启后披露块仍看不到它").toBe(true)
    expect((await invokeSkill(CLOSED)).admitted).toBe(true)

    // 只改 enabled 一行：其余字节（注释、自定义字段、描述）原样保留。
    const after = await rawFile(saved!.filePath)
    for (const kept of [COMMENT, CUSTOM_FIELD, "description: 关闭探针", "这份正文只在探针里出现"]) {
      expect(after, `写开关损坏了原文其它字节: 缺少 ${JSON.stringify(kept)}`).toContain(kept)
    }
    expect(after).toContain("enabled: true")
    expect(after, "写开关留下了旧的 enabled: false 行").not.toContain("enabled: false")
    expect(after.replace("enabled: true", "enabled: false"), "写开关改动了 enabled 行之外的字节").toBe(before)

    // 关回去同样立即生效：披露与显式调用两条路径一起收回。
    expect(await setSkillEnabled(CLOSED, false), "关闭开关没有写入").toBe(true)
    expect(flagOf(CLOSED)).toBe(false)
    expect(enabledNames().includes(CLOSED) || blockHas(CLOSED), "关闭后技能仍在生效清单或披露块里").toBe(false)
    expect((await invokeSkill(CLOSED)).admitted, "关闭后仍能显式调用").toBe(false)

    // ── ③ 没有 frontmatter 块时拒绝写入且不改动文件。
    // 先按正常技能落盘拿到坐标，再把文件内容换成没有可用 frontmatter 块的正文：
    // `applyEnabledFlag` 找不到块时必须拒绝写入，而不是造一份只有 enabled 的文件。
    const raw = await upsertSkill(source(RAW, "无 frontmatter 探针"))
    expect(raw, "无 frontmatter 探针没有被收录（前置不成立）").not.toBeNull()
    const body = "这份文件没有 frontmatter 块，也没有技能元数据。"
    await getHostBridge().request("file_write_atomic", { path: raw!.filePath, content: body, maxBytes: 512 * 1024 })

    expect(await setSkillEnabled(RAW, false), "没有 frontmatter 块时开关却报告写入成功").toBe(false)
    expect(await rawFile(raw!.filePath), "没有 frontmatter 块时开关改动了文件").toBe(body)
  })
})
