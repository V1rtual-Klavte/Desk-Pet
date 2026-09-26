import { invoke } from "@tauri-apps/api/core"
import { continueInterruptedRun, harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { deleteSkill, getSkillsPromptBlock, upsertSkill } from "@/services/skill"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

/**
 * 恢复路径重新准备能力（TOOL-13 / FIX-61 的代理）。
 *
 * 继续中断运行与主回合必须走同一个能力准备入口：中断期间 MCP 服务器可能不可用、Skill 目录
 * 可能已变 —— 恢复路径自己准备一次，才能让「本次运行的能力面」是真实的。
 *
 * 证明手段是「冷目录」：探针技能先经 `upsertSkill` 热加载进进程快照（描述 A），首回合在 A 下
 * 被中断；中断后**绕过** `upsertSkill` 的指纹核对，直接把磁盘上的描述改成 B（`file_write_atomic`），
 * 再继续中断运行。恢复返回后披露块必须是 B —— 磁盘上的 B 只有经指纹核对重载才会进快照，
 * 而这段窗口里唯一调用过 `prepareConversationCapabilities` 的就是恢复路径自己。
 *
 * 前置条件本身也被断言（恢复前披露块必须仍是 A）：Task 7 删掉 `invalidateSkillCatalog` 后，
 * 「先写盘再失效」的旧造法没有了入口；不重建这个前置，检查就会退化成永远通过的空断言。
 *
 * 同时核对不落上游的「Tool … is unavailable」通用文案（能力不足由本条路径显式判定）。
 */
const TOOL_NAME = "live_resume_capability"
const RECOVERED_TEXT = "恢复后完成"
const SKILL_NAME = "live-resume-capability-skill"
/** 热加载时的描述（首回合看到的）。 */
const SKILL_DESC_BEFORE = "恢复探针：首回合热加载的描述"
/** 冷写时的描述：长度与 A 不同，Rust 指纹按 (relative_path, mtime, size) 逐条哈希，必然判变。 */
const SKILL_DESC_AFTER = "恢复探针：仅落盘、未经指纹核对的描述，只有恢复路径自己的能力准备会读到它"
const UNAVAILABLE_MARKER = "is unavailable"

/** 探针技能的 SKILL.md 全文。frontmatter 只留 Pi 收录要求的两个字段。 */
function skillSource(description: string): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${description}\n---\n\n按需读取这份 Skill 的正文。`
}

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let resumedReply: string | undefined
let resumedFailure: unknown
/** 冷写落地后、恢复调用前读到的披露块：此时进程快照仍是冷写前的那一份。 */
let skillBlockBeforeResume = ""
/** 恢复返回后的披露块。 */
let skillBlockAfterResume = ""

export const 恢复能力准备: SceneDef = {
  meta: {
    caseId: "runtime-resume-capability-prep", module: "agent-runtime", contractId: "ar-11",
    description: "恢复路径复用能力准备：中断期间落盘的 Skill 变更在恢复时被指纹核对重新加载；能力不可用时以显式原因失败，不落上游通用文案",
    depth: "deep", suite: "regression", entry: "runtime",
    tags: ["recovery", "boundary", "error"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText(RECOVERED_TEXT),
      fakeText("确认完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    const saved = await upsertSkill(skillSource(SKILL_DESC_BEFORE))
    if (!saved?.filePath) throw new Error("探针 Skill 没有被 Pi loader 收录，冷目录前置无法建立")

    // 模拟进程被杀：不 abort，直接关闭运行槽 —— 会话文件里留下未完成的操作。
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始一个会被中断的任务。")
    await blocking.started
    await harnessSlots.reset()
    await firstTurn.catch(() => undefined)
    blocking.release()

    // 冷写：绕开 upsertSkill 的 syncSkillCatalog，直接改盘（同一路径取自 Pi 自己的 filePath）。
    // 写入只落到磁盘与 Rust 指纹上，进程内快照仍旧是描述 A —— 这正是本场景要的「冷目录」。
    await invoke("file_write_atomic", { path: saved.filePath, content: skillSource(SKILL_DESC_AFTER) })
    skillBlockBeforeResume = getSkillsPromptBlock()

    const resumed = await continueInterruptedRun(sessionId)
    resumedReply = resumed?.reply
    resumedFailure = resumed?.failure
    skillBlockAfterResume = getSkillsPromptBlock()
  },
  turns: [{
    index: 1,
    description: "核对恢复路径确实重新准备了能力（冷写落盘的内容被重新加载），且没有落上游通用不可用文案",
    userText: "确认一下刚才的恢复处理。",
    checks: [{
      type: "expectResumeCapabilityPrep",
      run: async () => {
        try {
          if (resumedReply === undefined) throw new Error("继续中断运行没有返回结果")
          if (resumedFailure) throw new Error(`恢复运行以失败结束: ${JSON.stringify(resumedFailure)}`)
          if (!resumedReply.includes(RECOVERED_TEXT)) {
            throw new Error(`续跑没有产出预期回复: ${JSON.stringify(resumedReply)}`)
          }
          // 前置条件成立：冷写只落盘、没有刷新进程快照，所以恢复前披露块仍是描述 A。
          // 这条不成立就说明「恢复后的 B」证明不了任何事（快照可能早就被别处刷新过）。
          if (!skillBlockBeforeResume.includes(SKILL_DESC_BEFORE)) {
            throw new Error(`冷目录前置未成立：恢复前披露块里没有热加载的描述 A：${JSON.stringify(skillBlockBeforeResume)}`)
          }
          if (skillBlockBeforeResume.includes(SKILL_DESC_AFTER)) {
            throw new Error(`冷目录前置未成立：冷写的描述 B 在恢复前已进入披露块：${JSON.stringify(skillBlockBeforeResume)}`)
          }
          // 结论：只有恢复路径自己的能力准备核对过指纹，磁盘上的 B 才会进快照。
          if (!skillBlockAfterResume.includes(`<name>${SKILL_NAME}</name>`)) {
            throw new Error(`恢复后的披露块没有列出探针技能：${JSON.stringify(skillBlockAfterResume)}`)
          }
          if (!skillBlockAfterResume.includes(SKILL_DESC_AFTER)) {
            throw new Error(`恢复路径没有重新准备 Skill 目录（披露块仍是冷写前的内容）：${JSON.stringify(skillBlockAfterResume)}`)
          }
          const texts = assistantTexts(await sessionMessages())
          if (texts.some(text => text.includes(UNAVAILABLE_MARKER))) {
            throw new Error(`会话里落了上游的通用不可用文案: ${JSON.stringify(texts)}`)
          }
        } finally {
          await deleteSkill(SKILL_NAME)
          blocking?.dispose()
        }
      },
    }],
  }],
}

export default 恢复能力准备
