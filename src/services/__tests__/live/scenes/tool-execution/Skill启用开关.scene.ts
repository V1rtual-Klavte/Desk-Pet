import type { SceneDef } from "../../types"
import { invoke } from "@tauri-apps/api/core"
import { getSkillsPromptBlock, deleteSkill, listEnabledSkills, listSkills, setSkillEnabled, syncSkillCatalog, upsertSkill } from "@/services/skill"
import { preProcess } from "@/services/engine"
import { getCommandReply } from "@/services/personality"
import { errorCode } from "@/services/error"

/**
 * 每技能 `enabled` 开关（te-20）。
 *
 * 开关是我们自有的 frontmatter 字段，只认布尔 `false` 为关闭（缺省、字符串、数字都算开启）：
 * 生效清单只由 store 的 `listEnabledSkills()` 过滤，披露块与 Pi 的 `setResources({skills})`
 * 共用同一份，所以被关闭的技能既不进模型视野、也不能被 `/skill` 启动（报「已关闭」而不是
 * 「不存在」）。写开关走 `setSkillEnabled` → `applyEnabledFlag`（只改/补 `enabled` 一行，
 * 其余字节原样保留）→ 原子替换 → 指纹入口重载，写后立即生效。
 *
 * 场景读写真实 `data_root/skills/`，跑前请备份运行时数据。
 */

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
  const result = await invoke<{ content: string }>("file_read", { path: filePath, maxBytes: 512 * 1024 })
  return result.content
}

export const Skill启用开关: SceneDef = {
  meta: {
    caseId: "tool-skill-enabled-toggle",
    module: "tool-execution",
    contractId: "te-20",
    description: "enabled:false 的技能既不披露也不能显式调用；只认布尔 false；开关写后立即生效且不损坏原文其它字节",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["tool-execution", "skill", "boundary"],
  },
  turns: [{
    index: 1,
    description: "生效清单、披露块与显式调用三处同时受同一个开关约束",
    userText: "校验 Skill 的每技能开关。",
    checks: [
      {
        type: "expectEnabledFlagDefaultsToOn",
        run: async () => {
          await clean()
          try {
            // 四个探针只差 enabled 的形态：缺省 / 布尔 false / 字符串 / 数字。
            const closed = await upsertSkill(source(CLOSED, "关闭探针", `enabled: false\n${COMMENT}\n${CUSTOM_FIELD}\n`))
            if (!closed) throw new Error("关闭探针没有被收录")
            if (!await upsertSkill(source(OPEN, "缺省探针"))) throw new Error("缺省探针没有被收录")
            if (!await upsertSkill(source(TEXTUAL, "字符串探针", 'enabled: "false"\n'))) throw new Error("字符串探针没有被收录")
            if (!await upsertSkill(source(NUMERIC, "数字探针", "enabled: 0\n"))) throw new Error("数字探针没有被收录")
            await syncSkillCatalog()

            if (flagOf(CLOSED) !== false) throw new Error(`enabled: false 没有被读成关闭: ${flagOf(CLOSED)}`)
            for (const name of [OPEN, TEXTUAL, NUMERIC]) {
              if (flagOf(name) !== true) throw new Error(`非布尔 false 的取值没有被当成开启: ${name}=${flagOf(name)}`)
            }

            // 两个消费点共用同一份生效清单：披露块（模型视野）与 setResources 用的清单。
            const names = enabledNames()
            for (const name of [OPEN, TEXTUAL, NUMERIC]) {
              if (!names.includes(name)) throw new Error(`生效清单缺少开启的技能: ${name}`)
              if (!blockHas(name)) throw new Error(`披露块缺少开启的技能: ${name}`)
            }
            if (names.includes(CLOSED)) throw new Error("被关闭的技能仍留在生效清单里（会被 setResources 下发给 Pi）")
            if (blockHas(CLOSED)) throw new Error("被关闭的技能仍出现在披露块里（模型仍能看到它）")

            // 关闭的技能不能被显式调用，且报的是「已关闭」而不是「不存在」。
            const refused = await invokeSkill(CLOSED)
            if (refused.admitted) throw new Error("被关闭的技能仍然给出了准入意图")
            if (!refused.response.includes(getCommandReply("skillDisabled"))) {
              throw new Error(`被关闭的技能没有报「已关闭」: ${JSON.stringify(refused.response)}`)
            }
            if (refused.response.includes(getCommandReply("skillUnknown"))) throw new Error("被关闭的技能被报成了「不存在」")
            const admitted = await invokeSkill(OPEN)
            if (!admitted.admitted) throw new Error(`开启的技能没有给出准入意图: ${JSON.stringify(admitted.response)}`)
          } finally {
            await clean()
          }
        },
      },
      {
        type: "expectToggleTakesEffectImmediately",
        run: async () => {
          await clean()
          try {
            const saved = await upsertSkill(source(CLOSED, "关闭探针", `enabled: false\n${COMMENT}\n${CUSTOM_FIELD}\n`))
            if (!saved) throw new Error("关闭探针没有被收录")
            if (blockHas(CLOSED)) throw new Error("关闭的技能出现在披露块里，开关断言不成立")
            const before = await rawFile(saved.filePath)

            if (!await setSkillEnabled(CLOSED, true)) throw new Error("开启开关没有写入")
            // 写后立即生效：没有重启、没有 TTL，指纹入口重载后两处消费点同时看到它。
            if (flagOf(CLOSED) !== true) throw new Error("开启后清单条目仍是关闭")
            if (!enabledNames().includes(CLOSED)) throw new Error("开启后生效清单仍缺少它")
            if (!blockHas(CLOSED)) throw new Error("开启后披露块仍看不到它")
            const admitted = await invokeSkill(CLOSED)
            if (!admitted.admitted) throw new Error(`开启后仍不能显式调用: ${JSON.stringify(admitted.response)}`)

            // 只改 enabled 一行：其余字节（注释、自定义字段、描述）原样保留。
            const after = await rawFile(saved.filePath)
            for (const kept of [COMMENT, CUSTOM_FIELD, "description: 关闭探针", "这份正文只在探针里出现"]) {
              if (!after.includes(kept)) throw new Error(`写开关损坏了原文其它字节: 缺少 ${JSON.stringify(kept)}`)
            }
            if (!after.includes("enabled: true")) throw new Error("写开关没有把 enabled 行改成 true")
            if (after.includes("enabled: false")) throw new Error("写开关留下了旧的 enabled: false 行")
            if (after.replace("enabled: true", "enabled: false") !== before) {
              throw new Error("写开关改动了 enabled 行之外的字节")
            }

            // 关回去同样立即生效：披露与显式调用两条路径一起收回。
            if (!await setSkillEnabled(CLOSED, false)) throw new Error("关闭开关没有写入")
            if (flagOf(CLOSED) !== false) throw new Error("关闭后清单条目仍是开启")
            if (enabledNames().includes(CLOSED) || blockHas(CLOSED)) throw new Error("关闭后技能仍在生效清单或披露块里")
            const refused = await invokeSkill(CLOSED)
            if (refused.admitted) throw new Error("关闭后仍能显式调用")
          } finally {
            await clean()
          }
        },
      },
      {
        type: "expectMissingFrontmatterRefused",
        run: async () => {
          await clean()
          try {
            // 先按正常技能落盘拿到坐标，再把文件内容换成没有可用 frontmatter 块的正文：
            // `applyEnabledFlag` 找不到块时必须拒绝写入，而不是造一份只有 enabled 的文件。
            const saved = await upsertSkill(source(RAW, "无 frontmatter 探针"))
            if (!saved) throw new Error("无 frontmatter 探针没有被收录（前置不成立）")
            const body = "这份文件没有 frontmatter 块，也没有技能元数据。"
            await invoke("file_write_atomic", { path: saved.filePath, content: body, maxBytes: 512 * 1024 })

            if (await setSkillEnabled(RAW, false)) throw new Error("没有 frontmatter 块时开关却报告写入成功")
            if (await rawFile(saved.filePath) !== body) throw new Error("没有 frontmatter 块时开关改动了文件")
          } finally {
            await clean()
          }
        },
      },
    ],
  }],
}

export default Skill启用开关
