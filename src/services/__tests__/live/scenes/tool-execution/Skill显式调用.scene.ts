import type { SceneDef } from "../../types"
import type { Entry } from "@earendil-works/pi-agent-core"
import { fakeText, installFakeProvider } from "../../fake-provider"
import { initChat } from "@/services/agent/runner"
import { getCommandReply } from "@/services/personality"
import { deleteSkill, upsertSkill } from "@/services/skill"
import { errorCode } from "@/services/error"
import { DESKPET_SYSTEM_MESSAGE_ENTRY } from "@/services/engine/runtime"
import { entryMessageText, sessionEntries } from "../../session-entries"

/**
 * `/skill <技能名> [额外指示]` 的整链（te-19，生产入口）。
 *
 * 命令层只判定「这次调用能不能启动」，四条终态互相可辨（空参数 / 未知名 / 正文为空 / 被关闭）；
 * 命中时出参是 `{name, additionalInstructions?}`，经预处理转成 `{handled:false, skillAdmission}` ——
 * 不是「已处理的文本」。那条 `role:"user"` 正文由 Pi 在 `accept` 内按技能文件构造并提交
 * （`formatSkillInvocation`：`<skill name=… location=…>` 包头 + 正文 + 附加指示），命令层与宿主
 * 都不写第二条正文，所以本场景以「会话里恰好一条技能正文、且逐字带着技能文件绝对路径」取证。
 *
 * 场景读写真实 `data_root/skills/`，跑前请备份运行时数据。
 */

const INVOKED = "live-skill-invoke"
const EMPTY_BODY = "live-skill-void"
const DISABLED = "live-skill-paused"
/** 只用于「未知名」这一态：刻意不落盘。 */
const ABSENT = "live-skill-absent"

const BODY_MARKER = "SKILL_BODY_MARKER_GOES_INTO_CONVERSATION"
const BODY = `${BODY_MARKER}\n${"这一段是技能正文，模型必须逐字看到它。".repeat(40)}`
const EXTRA = "先执行第一步，再汇报结论。"
/** 未知名那轮专用：与 EXTRA 不同串，才能用「正文里不该出现它」当判据。 */
const EXTRA_MISSING = "第二轮的附加说明不该成为会话正文。"
const SKILL_REPLY = "技能正文已按指示执行完毕。"
const LAST_REPLY = "结论已核对。"

/** 技能原文：只声明 Pi 认的字段（name / description），可另加我们自有的 frontmatter 行。 */
function source(name: string, description: string, body: string, extraFrontmatter = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n${body}`
}

/** 清理是幂等的尽力而为：条目本来就不存在时 `skill_delete` 如实返回 PATH_NOT_FOUND。 */
async function clean(): Promise<void> {
  for (const relativePath of [INVOKED, EMPTY_BODY, DISABLED]) {
    try {
      await deleteSkill(relativePath)
    } catch (error) {
      if (errorCode(error) !== "PATH_NOT_FOUND") throw error
    }
  }
}

function userEntryTexts(entries: readonly Entry[]): string[] {
  const texts: string[] = []
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue
    texts.push(entryMessageText(entry.message))
  }
  return texts
}

function systemMessageTexts(entries: readonly Entry[]): string[] {
  return entries
    .filter((entry): entry is Extract<Entry, { type: "custom" }> =>
      entry.type === "custom" && entry.customType === DESKPET_SYSTEM_MESSAGE_ENTRY)
    .map(entry => String((entry.data as { text?: unknown } | undefined)?.text ?? ""))
}

/** 请求里 role:"user" 的正文（只取文本块；技能正文没有图片块）。 */
function payloadUserTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = []
  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown }
    if (message.role !== "user") continue
    const content = message.content
    if (typeof content === "string") { texts.push(content); continue }
    if (!Array.isArray(content)) continue
    texts.push(content.map(part => {
      const block = part as { type?: string; text?: string }
      return block?.type === "text" ? String(block.text ?? "") : ""
    }).join(""))
  }
  return texts
}

let provider: ReturnType<typeof installFakeProvider> | undefined
/** 技能文件的绝对路径（Pi 构造正文时逐字带进条目，用来证明正文不是宿主编的）。 */
let skillFilePath = ""
/** 上一回合结束时的模型请求数：命令终态不得产生请求。 */
let modelCalls = 0
/** 命中技能那一轮结束后的用户条目数：命令终态不得新增用户正文。 */
let userEntryCount = 0

function currentModelCalls(): number {
  return provider?.payloads.length ?? 0
}

/** 带该标记的最后一次请求里的用户正文；尾随的一次性调用不参与判定。 */
function lastPayloadUserText(marker: string): string | undefined {
  const payloads = provider?.payloads ?? []
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const hit = payloadUserTexts(payloads[index]!.messages).find(text => text.includes(marker))
    if (hit !== undefined) return hit
  }
  return undefined
}

export const Skill显式调用: SceneDef = {
  meta: {
    caseId: "tool-skill-explicit-invocation",
    module: "tool-execution",
    contractId: "te-19",
    description: "/skill 命中时条目由 Pi 按技能文件提交（命令层不写第二条正文），四态终态互相可辨且都不进模型请求",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["tool-execution", "skill", "production-entry", "error"],
  },
  setup: async () => {
    await clean()
    const invoked = await upsertSkill(source(INVOKED, "显式调用探针（正文可辨）", BODY))
    if (!invoked) throw new Error("探针技能没有被 Pi loader 收录")
    skillFilePath = invoked.filePath
    if (!await upsertSkill(source(EMPTY_BODY, "空正文探针", ""))) throw new Error("空正文探针没有被收录")
    if (!await upsertSkill(source(DISABLED, "关闭探针", "这份正文不该被启动。", "enabled: false\n"))) {
      throw new Error("关闭探针没有被收录")
    }
    await initChat()
    provider = installFakeProvider([
      fakeText(SKILL_REPLY),
      fakeText(LAST_REPLY),
    ])
  },
  turns: [
    {
      index: 1,
      description: "命中技能：Pi 按技能文件提交的唯一一条用户正文进入会话与请求",
      userText: `/skill ${INVOKED} ${EXTRA}`,
      checks: [{
        type: "expectSkillEntryCommittedByAccept",
        run: async ctx => {
          if (ctx.output.failure) throw new Error(`命中技能的回合失败: ${JSON.stringify(ctx.output.failure)}`)
          if (!ctx.output.reply.includes(SKILL_REPLY)) {
            throw new Error(`回合没有被真实驱动到脚本回复（fake provider 脚本错位）: ${JSON.stringify(ctx.output.reply)}`)
          }
          modelCalls = currentModelCalls()

          const entries = await sessionEntries()
          const userTexts = userEntryTexts(entries)
          userEntryCount = userTexts.length
          const withBody = userTexts.filter(text => text.includes(BODY_MARKER))
          if (withBody.length !== 1) {
            throw new Error(`技能正文在会话里出现了 ${withBody.length} 次（应恰好一条：命令层不写第二份）`)
          }
          const text = withBody[0]!
          // 条目由 Pi 的 `formatSkillInvocation` 构造：包头带技能名与**技能文件绝对路径**，
          // 宿主根本不知道这个形状，所以这段文本就是「落盘由 accept 完成」的直接证据。
          if (!text.startsWith(`<skill name="${INVOKED}" location="${skillFilePath}">`)) {
            throw new Error(`技能条目不是 Pi 构造的包头: ${JSON.stringify(text.slice(0, 160))}`)
          }
          if (!text.trimEnd().endsWith(EXTRA)) {
            throw new Error(`附加指示没有跟在技能正文之后: ${JSON.stringify(text.slice(-80))}`)
          }
          if (!text.includes(BODY)) throw new Error("技能条目缺少正文全文")
          // 用户敲的命令行本身不得成为正文（那会把命令行当技能内容投给模型）。
          if (userTexts.some(item => item.includes(`/skill ${INVOKED}`))) {
            throw new Error("字面命令行被当成了会话正文")
          }
          // 条目提交成立后按当前 Card 报一次 skillStarted 系统消息。
          const notices = systemMessageTexts(entries).filter(item => item === getCommandReply("skillStarted"))
          if (notices.length !== 1) {
            throw new Error(`skillStarted 系统消息不是恰好一条: ${JSON.stringify(systemMessageTexts(entries))}`)
          }
          // 正文进请求且**不做投影**：请求里的用户正文与落盘条目逐字一致（含正文全文与附加指示）。
          const sent = lastPayloadUserText(BODY_MARKER)
          if (sent === undefined) throw new Error("请求里没有技能正文（这条回合没有被驱动）")
          if (sent !== text) throw new Error(`请求里的技能正文与条目不一致（被投影过？）: ${sent.length} vs ${text.length} 字符`)
        },
      }],
    },
    {
      index: 2,
      description: "未知名：报「未找到」并回显解析出的技能名，不产生会话正文与模型请求",
      userText: `/skill ${ABSENT} ${EXTRA_MISSING}`,
      checks: [{
        type: "expectUnknownSkillRefused",
        run: async ctx => {
          if (currentModelCalls() !== modelCalls) throw new Error("未知名技能产生了模型请求")
          if (!ctx.output.reply.includes(getCommandReply("skillUnknown"))) {
            throw new Error(`未知名没有报「未找到」: ${JSON.stringify(ctx.output.reply)}`)
          }
          if (!ctx.output.reply.includes(`技能名：${ABSENT}`)) {
            throw new Error(`未知名没有回显解析出的名字（参数切分错？）: ${JSON.stringify(ctx.output.reply)}`)
          }
          // 参数按第一处空白切分：余下文本是附加指示，不是名字的一部分。
          if (ctx.output.reply.includes(`技能名：${ABSENT} ${EXTRA_MISSING}`)) throw new Error("附加指示被并进了技能名")
          const userTexts = userEntryTexts(await sessionEntries())
          if (userTexts.length !== userEntryCount) throw new Error("未知名技能新增了用户正文条目")
          if (userTexts.some(text => text.includes(ABSENT) || text.includes(EXTRA_MISSING))) {
            throw new Error("未知名技能在会话里留下了用户正文")
          }
        },
      }],
    },
    {
      index: 3,
      description: "正文为空：报「没有可用正文」，与「不存在」可辨",
      userText: `/skill ${EMPTY_BODY}`,
      checks: [{
        type: "expectEmptySkillRefused",
        run: async ctx => {
          if (currentModelCalls() !== modelCalls) throw new Error("空正文技能产生了模型请求")
          if (!ctx.output.reply.includes(getCommandReply("skillEmpty"))) {
            throw new Error(`空正文没有报「没有可用正文」: ${JSON.stringify(ctx.output.reply)}`)
          }
          if (ctx.output.reply.includes(getCommandReply("skillUnknown"))) {
            throw new Error("空正文被报成了「技能不存在」（两态不可辨）")
          }
          if (!ctx.output.reply.includes(`技能名：${EMPTY_BODY}`)) throw new Error("空正文没有回显技能名")
          const userTexts = userEntryTexts(await sessionEntries())
          if (userTexts.some(text => text.includes(EMPTY_BODY))) throw new Error("空正文技能在会话里留下了用户正文")
        },
      }],
    },
    {
      index: 4,
      description: "被 enabled:false 关闭：报「已被关闭」，与「不存在」「没有正文」都可辨",
      userText: `/skill ${DISABLED}`,
      checks: [{
        type: "expectDisabledSkillRefused",
        run: async ctx => {
          if (currentModelCalls() !== modelCalls) throw new Error("被关闭的技能产生了模型请求")
          if (!ctx.output.reply.includes(getCommandReply("skillDisabled"))) {
            throw new Error(`被关闭的技能没有报「已被关闭」: ${JSON.stringify(ctx.output.reply)}`)
          }
          if (ctx.output.reply.includes(getCommandReply("skillUnknown")) || ctx.output.reply.includes(getCommandReply("skillEmpty"))) {
            throw new Error("被关闭的技能被报成了「不存在」或「没有正文」（三态不可辨）")
          }
          const userTexts = userEntryTexts(await sessionEntries())
          if (userTexts.some(text => text.includes("这份正文不该被启动"))) {
            throw new Error("被关闭的技能的正文进了会话")
          }
        },
      }],
    },
    {
      index: 5,
      description: "空参数：说清用法，不当成「技能不存在」",
      userText: "/skill",
      checks: [{
        type: "expectSkillUsageReply",
        run: async ctx => {
          if (currentModelCalls() !== modelCalls) throw new Error("空参数命令产生了模型请求")
          if (!ctx.output.reply.includes("未给出技能名")) {
            throw new Error(`空参数没有说清用法: ${JSON.stringify(ctx.output.reply)}`)
          }
          // 与「未知名」的差别：没有名字可回显，所以不该出现回显标记。
          if (ctx.output.reply.includes("技能名：")) throw new Error("空参数被当成了「名字查不到」处理")
        },
      }],
    },
    {
      index: 6,
      description: "一次普通回合收尾（审计队列在 run 结束时落盘），四条终态都留下系统消息条目",
      userText: "把上面的结论核对一遍。",
      checks: [{
        type: "expectFourStatesPersistedAsSystemMessages",
        run: async ctx => {
          if (ctx.output.failure) throw new Error(`收尾回合失败: ${JSON.stringify(ctx.output.failure)}`)
          if (!ctx.output.reply.includes(LAST_REPLY)) throw new Error("收尾回合没有被真实驱动")
          if (currentModelCalls() <= modelCalls) throw new Error("收尾回合没有产生模型请求")

          const texts = systemMessageTexts(await sessionEntries())
          const wanted: Array<[string, string]> = [
            ["未知名", `${getCommandReply("skillUnknown")}\n技能名：${ABSENT}`],
            ["空正文", `${getCommandReply("skillEmpty")}\n技能名：${EMPTY_BODY}`],
            ["被关闭", `${getCommandReply("skillDisabled")}\n技能名：${DISABLED}`],
            ["空参数", `${getCommandReply("skillUnknown")}\n未给出技能名（用法：/skill <技能名> [额外指示]）`],
          ]
          for (const [label, expected] of wanted) {
            const hits = texts.filter(text => text === expected)
            if (hits.length !== 1) {
              throw new Error(`${label}的终态句不是恰好一条系统消息条目: ${hits.length}（已落盘: ${JSON.stringify(texts)}）`)
            }
          }
          // 四态互相可辨：三条终态句两两不同（Card 文案若把它们写成同一句，这条先失败）。
          const distinct = new Set(wanted.map(([, text]) => text))
          if (distinct.size !== wanted.length) throw new Error("四条终态句在落盘面上不可辨（当前 Card 的 commands 文案有重复）")
        },
      }],
    },
  ],
}

export default Skill显式调用
