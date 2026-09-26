import type { Entry } from "@earendil-works/pi-agent-core"
import type { SceneDef } from "../../types"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { runPiAgentTurn } from "@/services/engine/pi"
import { DESKPET_SYSTEM_MESSAGE_ENTRY, messageEventId } from "@/services/engine/runtime"
import { preProcess } from "@/services/engine"
import { getCommandReply, getFallbackReply } from "@/services/personality"
import { deleteSkill, upsertSkill } from "@/services/skill"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { entryMessageText, sessionEntries } from "../../session-entries"

/**
 * 技能准入回合（ar-21）：`/skill <技能名> [额外指示]` 走同一条生产入口（`sendMessage`）。
 *
 * 运行侧的不变量逐条钉住：
 * ① 命令层只交出**准入意图**（`handled:false` + `skillAdmission`），不当成「已处理的文本」短路；
 * ② 那条 `role:"user"` 正文由 Pi 在 `accept` 内按技能文件构造（含技能文件的绝对路径）——
 *    它不是宿主正文，也不带 `deskpetEventId`（套一份身份只会造出查不到的假投递证据）；
 * ③ `skillStarted` 是「提交成立之后」才报的系统消息：它的条目 seq 必须晚于技能输入条目；
 * ④ 忙碌期（lane 上还有未结算操作）启动不了技能：按并发拒绝如实回复、不落技能输入条目、
 *    不把字面 `/skill …` 当普通文本投进 lane（会话里只多一条并发拒绝的系统消息）；
 * ⑤ 准入在边界上失败（清单在启动瞬间变化 → UnknownSkill）按 admission 结算 + 兜底文案落盘，
 *    且**不落**技能输入条目 —— 这条只有直接驱动运行入口才能构造（命令层在外面先把未知名拦掉了）。
 *
 * 用 `entry: "production"`：③④ 都在运行入口那一层（runner 的忙碌分支、`onInputAdmitted`），
 * 直连 `runPiAgentTurn` 走不到（它既没有忙碌分支，也不会推用户气泡与终态系统消息）。
 * 命令层的参数解析与三种终态句（未知名 / 被关闭 / 无正文）不在这里，那是 te-19 的场景。
 */
const SKILL_NAME = "live-skill-admission"
const BODY_MARKER = "技能正文探针：读到这行就说明技能文件被读过了。"
const EXTRA = "先读配置再回答"
const MISSING_SKILL = "live-skill-admission-missing"
const BUSY_TEXT = "开始一个会让会话忙碌的长任务。"
const BUSY_DONE = "长任务完成"
const SKILL_REPLY = "技能回合完成"
const TURN_REPLY = "核对完成"
const BLOCKING_TOOL = "live_skill_admission_hold"

/** 探针技能的 SKILL.md 全文。frontmatter 只留 Pi 收录要求的两个字段。 */
function skillSource(): string {
  return `---\nname: ${SKILL_NAME}\ndescription: 技能准入探针\n---\n\n${BODY_MARKER}\n`
}

type CustomEntry = Extract<Entry, { type: "custom" }>

/** `Entry` 的联合不会因 filter 收窄，这里显式收。 */
function customEntries(entries: Entry[], customType: string): CustomEntry[] {
  return entries.filter((entry): entry is CustomEntry =>
    entry.type === "custom" && entry.customType === customType)
}

/** 用户消息条目的正文。逐个收窄（`entry.message` 的联合里有不带正文的成员）。 */
function userTexts(entries: Entry[]): string[] {
  const texts: string[] = []
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue
    texts.push(entryMessageText(entry.message))
  }
  return texts
}

/** Pi 按技能文件构造的那条用户消息读回的几项：正文、落盘顺序、投递身份。 */
interface SkillInputEntry {
  text: string
  seq: number
  eventId: string | undefined
}

function skillInputEntry(entries: Entry[], name: string): SkillInputEntry | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue
    const text = entryMessageText(entry.message)
    if (!text.startsWith(`<skill name="${name}"`)) continue
    return { text, seq: entry.seq, eventId: messageEventId(entry.message as { deskpetEventId?: unknown }) }
  }
  return undefined
}

/** 技能输入条目数量（「忙碌期没有多落一条」与「未获准入不落条目」的判据）。 */
function countSkillInputs(entries: Entry[], name: string): number {
  return entries.filter(entry =>
    entry.type === "message" && entry.message.role === "user"
    && entryMessageText(entry.message).startsWith(`<skill name="${name}"`)).length
}

/** 助手正文是否出现过某段文本（兜底回复的落盘判据）。 */
function assistantTextLanded(entries: Entry[], text: string): boolean {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue
    if (entryMessageText(entry.message) === text) return true
  }
  return false
}

function systemMessageText(entry: CustomEntry): string {
  return String((entry.data as { text?: unknown } | undefined)?.text ?? "")
}

/** 系统提示经 `persistSystemMessage` 异步落盘：按状态有界等待（不用固定 sleep 代替状态等待）。 */
async function waitSystemMessage(sessionId: string, needle: string): Promise<CustomEntry> {
  const deadline = Date.now() + 3000
  let seen: string[] = []
  while (Date.now() < deadline) {
    const messages = customEntries(await sessionEntries(sessionId), DESKPET_SYSTEM_MESSAGE_ENTRY)
    seen = messages.map(systemMessageText)
    const hit = messages.find(entry => systemMessageText(entry).includes(needle))
    if (hit) return hit
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：系统提示「${needle}」未落盘，实际 ${JSON.stringify(seen)}`)
}

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let sessionId = ""
let skillFilePath = ""
/** 删除坐标是域内相对路径，取 Pi loader 给出的那一份，不按名字反推。 */
let skillRelativePath = ""
let busyAttempt: Awaited<ReturnType<typeof sendMessage>> | undefined
let skillTurnFailure: unknown

export const 技能准入: SceneDef = {
  meta: {
    caseId: "runtime-skill-admission", module: "agent-runtime", contractId: "ar-21",
    description: "技能显式调用走生产入口准入：条目由 Pi 构造且无投递身份、skillStarted 在提交之后、忙碌期拒绝且不落技能条目、UnknownSkill 按准入失败结算",
    depth: "deep", suite: "regression", entry: "production",
    tags: ["production-entry", "skill", "session", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(BLOCKING_TOOL),
      fakeText(BUSY_DONE),
      fakeText(SKILL_REPLY),
      fakeText(TURN_REPLY),
    ])
    await initChat()
    sessionId = getActiveSessionId()
    const saved = await upsertSkill(skillSource())
    if (!saved?.filePath || !saved.relativePath) throw new Error("探针 Skill 没有被 Pi loader 收录，技能准入断言没有前提")
    skillFilePath = saved.filePath
    skillRelativePath = saved.relativePath

    // 忙碌窗口：一个阻塞工具把会话占住，期间的 `/skill` 只能被并发拒绝。
    blocking = registerBlockingTool(BLOCKING_TOOL)
    const busyTurn = sendMessage(BUSY_TEXT)
    await blocking.started
    busyAttempt = await sendMessage(`/skill ${SKILL_NAME} 这条不该启动`)
    blocking.release()
    const busyResult = await busyTurn
    if (busyResult.failure) throw new Error(`被技能打断的长任务失败: ${busyResult.failure.kind}: ${busyResult.failure.message}`)

    // 空闲期：正常启动一次技能。
    skillTurnFailure = (await sendMessage(`/skill ${SKILL_NAME} ${EXTRA}`)).failure
  },
  turns: [{
    index: 1,
    description: "核对技能准入的出口形态、落盘身份、终态消息与两条拒绝路径",
    userText: "核对刚才的技能启动。",
    checks: [
      {
        type: "expectSkillAdmissionIntent",
        run: async () => {
          try {
            // ① 命令层的出口形态：准入意图（不是「已处理的文本」）。参数解析与三种终态句属 te-19。
            const pre = await preProcess(`/skill ${SKILL_NAME} ${EXTRA}`)
            if (pre.handled !== false) throw new Error("技能调用被当成「已处理的文本」短路了")
            if (pre.response !== undefined) throw new Error("技能准入同时给出了文本回复：命令层会与运行入口各写一次")
            if (pre.skillAdmission?.name !== SKILL_NAME) {
              throw new Error(`准入意图的技能名不对: ${String(pre.skillAdmission?.name)}`)
            }
            if (pre.skillAdmission.additionalInstructions !== EXTRA) {
              throw new Error(`准入意图丢掉了额外指示: ${String(pre.skillAdmission.additionalInstructions)}`)
            }
          } finally {
            // 探针造在真实运行时数据根里。断言已不依赖磁盘上的技能文件（后续只读会话条目），
            // 尽早清掉，别让它在后面的 Skill 场景里继续占披露预算。
            blocking?.dispose()
            await deleteSkill(skillRelativePath)
          }
        },
      },
      {
        type: "expectSkillEntryCommittedByPi",
        run: async () => {
          const entries = await sessionEntries(sessionId)
          const skill = skillInputEntry(entries, SKILL_NAME)
          if (!skill) throw new Error("会话里没有 Pi 构造的技能输入条目")
          if (countSkillInputs(entries, SKILL_NAME) !== 1) {
            throw new Error(`技能输入条目不是恰好一条: ${countSkillInputs(entries, SKILL_NAME)}`)
          }
          // 正文来自技能文件（绝对路径 + 正文标记 + 追加的额外指示），不是宿主拼出来的文本。
          if (!skill.text.includes(`location="${skillFilePath}"`)) {
            throw new Error(`技能条目缺少技能文件的绝对路径: ${JSON.stringify(skill.text.slice(0, 160))}`)
          }
          if (!skill.text.includes(BODY_MARKER)) throw new Error("技能条目里没有技能正文")
          if (!skill.text.endsWith(`</skill>\n\n${EXTRA}`)) {
            throw new Error(`额外指示没有按 Pi 的形态追加: ${JSON.stringify(skill.text.slice(-80))}`)
          }
          // ② 这条条目不是宿主构造的：没有投递身份，也没有第二份宿主正文 / 用户气泡。
          if (skill.eventId !== undefined) {
            throw new Error("技能输入条目被套上了投递身份：证据链会出现查不到的 deskpetEventId")
          }
          const users = userTexts(entries)
          if (users.some(text => text.includes(`/skill ${SKILL_NAME}`))) {
            throw new Error("字面 `/skill …` 被当成普通文本落进了对话")
          }
          if (users.filter(text => text.includes(SKILL_NAME)).length !== 1) {
            throw new Error(`技能相关用户条目不是恰好一条（宿主可能又投了一份正文）: ${JSON.stringify(users)}`)
          }
        },
      },
      {
        type: "expectSkillStartedAfterCommit",
        run: async () => {
          // ③ 提交成立后才报：系统消息条目的 seq 必须晚于那条技能输入条目。
          const entries = await sessionEntries(sessionId)
          const skill = skillInputEntry(entries, SKILL_NAME)
          if (!skill) throw new Error("会话里没有技能输入条目")
          const started = await waitSystemMessage(sessionId, getCommandReply("skillStarted"))
          if (!(skill.seq < started.seq)) {
            throw new Error(`skillStarted 早于技能条目提交: skill seq=${skill.seq} ≥ started seq=${started.seq}`)
          }
        },
      },
      {
        type: "expectBusySkillRefused",
        run: async () => {
          // ④ 忙碌期：按并发拒绝如实回复，不谎称启动，也不追加技能条目。
          if (!busyAttempt) throw new Error("场景前置缺失：忙碌期的技能尝试没有发生")
          const notice = getFallbackReply("concurrentRejected")
          if (busyAttempt.reply !== notice) {
            throw new Error(`忙碌期的技能回复不是并发拒绝文案: ${JSON.stringify(busyAttempt.reply)}`)
          }
          if (busyAttempt.failure) {
            throw new Error(`忙碌期的技能尝试按失败结算了: ${busyAttempt.failure.kind}: ${busyAttempt.failure.message}`)
          }

          const entries = await sessionEntries(sessionId)
          if (countSkillInputs(entries, SKILL_NAME) !== 1) {
            throw new Error(`忙碌期的技能尝试落了技能输入条目（应只有空闲那一次）: ${countSkillInputs(entries, SKILL_NAME)}`)
          }
          const notices = customEntries(entries, DESKPET_SYSTEM_MESSAGE_ENTRY)
            .filter(entry => systemMessageText(entry).includes(notice))
          if (notices.length !== 1) throw new Error(`并发拒绝的系统消息不是恰好一条: ${notices.length}`)
        },
      },
      {
        type: "expectUnknownSkillAdmissionSettled",
        run: async () => {
          // ⑤ 边界失败：名字在启动瞬间从生效清单里消失（这里用不存在的名字驱动同一条准入入口）。
          if (skillTurnFailure) throw new Error(`空闲期的技能回合失败: ${String(skillTurnFailure)}`)
          const before = await sessionEntries(sessionId)
          const denied = await runPiAgentTurn({
            sessionId,
            userText: `/skill ${MISSING_SKILL}`,
            unansweredCount: 0,
            skillAdmission: { name: MISSING_SKILL },
          })
          if (!denied.failure) throw new Error("未知技能没有被拒绝")
          if (denied.failure.kind !== "admission") {
            throw new Error(`未知技能的失败分类不是准入失败: ${denied.failure.kind}`)
          }
          if (!denied.failure.message.includes("UnknownSkill")) {
            throw new Error(`未知技能的失败正文没有带原始 tag: ${denied.failure.message}`)
          }
          if (denied.reply !== getFallbackReply("llmUnavailable")) {
            throw new Error(`未获准入时没有交出兜底文案: ${JSON.stringify(denied.reply)}`)
          }
          // 兜底文案必须有内容：空串会让下面的落盘断言变成「找一个空正文条目」。
          if (!denied.reply.trim()) throw new Error("未获准入的兜底文案是空的，断言判据失效")
          // 未获准入 = 输入没有进会话：用户条目数不变；兜底回复作为结算落到会话里。
          const after = await sessionEntries(sessionId)
          if (userTexts(after).length !== userTexts(before).length) {
            throw new Error("未获准入的技能输入落了用户条目：先落盘语义被破坏")
          }
          if (!assistantTextLanded(after, denied.reply)) throw new Error("未获准入的兜底回复没有落盘")
        },
      },
    ],
  }],
}

export default 技能准入
