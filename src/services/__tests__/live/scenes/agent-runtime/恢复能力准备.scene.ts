import { continueInterruptedRun, harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { deleteSkill, getSkillsPromptBlock, upsertSkill } from "@/services/skill"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

/**
 * 恢复路径重新准备能力（TOOL-13 / FIX-61 的 pet 侧代理）。
 *
 * 继续中断运行与主回合必须走同一个能力准备入口：中断期间模式可能切换、MCP 服务器可能不可用、
 * Skill 目录可能已失效 —— 恢复路径自己准备一次，才能让「本次运行的能力面」是真实的。
 *
 * 证明手段是「冷目录」：场景先把 Skill 探针写入运行时目录并让 catalog 失效，再继续中断运行；
 * 恢复返回后目录里必须能列出该 Skill —— 只有走恢复路径的能力准备才会重新加载它。
 * 同时核对不落上游的「Tool … is unavailable」通用文案（能力不足由本条路径显式判定）。
 */
const TOOL_NAME = "live_resume_capability"
const RECOVERED_TEXT = "恢复后完成"
const SKILL_NAME = "live-resume-capability-skill"
const UNAVAILABLE_MARKER = "is unavailable"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let resumedReply: string | undefined
let resumedFailure: unknown
let skillBlockAfterResume = ""

export const 恢复能力准备: SceneDef = {
  meta: {
    caseId: "runtime-resume-capability-prep", module: "agent-runtime", contractId: "ar-11",
    description: "恢复路径复用能力准备（MCP 借用 + Skill 目录预热）；能力不可用时以显式原因失败，不落上游通用文案",
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
    // 决策 8 删掉了 tools.skill.enabled 总闸，这里原本的开关切换已是空动作，随 getter 一并去掉
    // （只做编译面收敛；本场景的语义重写归 T19，见下方「冷目录前置已移除」）。
    await upsertSkill(`---\nname: ${SKILL_NAME}\ndescription: 恢复路径能力准备探针\ninvocationPolicy: pet\ncapabilityTags: [memory, test]\n---\n\n按需读取这份 Skill 的正文。`)

    // 模拟进程被杀：不 abort，直接关闭运行槽 —— 会话文件里留下未完成的操作。
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始一个会被中断的任务。")
    await blocking.started
    await harnessSlots.reset()
    await firstTurn.catch(() => undefined)
    blocking.release()

    // 冷目录前置已移除：原本靠「主回合预热过 catalog、这里再显式失效」使「恢复返回后仍能列出
    // Skill」只可能来自恢复路径自己的准备。Task 7 删除 invalidateSkillCatalog、改每回合指纹核对，
    // 没有对应的「再失效一次」入口，本场景当前无法再证明该语义（语义重写归 T19，方案 §6 :439）。
    const resumed = await continueInterruptedRun(sessionId)
    resumedReply = resumed?.reply
    resumedFailure = resumed?.failure
    skillBlockAfterResume = getSkillsPromptBlock()
  },
  turns: [{
    index: 1,
    description: "核对恢复路径确实重新准备了能力，且没有落上游通用不可用文案",
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
          if (!skillBlockAfterResume.includes(`name="${SKILL_NAME}"`)) {
            throw new Error("恢复路径没有重新准备 Skill 目录：能力准备没有走恢复入口")
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
