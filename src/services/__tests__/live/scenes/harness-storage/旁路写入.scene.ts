import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { initChat, sendMessage } from "@/services/agent/runner"
import { acquirePiSession, appendPiSessionCustomEntry, getActiveSessionId, PI_LANE } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

/** 旁路写入用的自定义条目类型（宿主证据条目，不进模型上下文）。 */
const BYPASS_CUSTOM_TYPE = "deskpet.bypass_probe"
const TOOL_NAME = "bypass_probe_blocker"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let bypassEntryId = ""

/**
 * 旁路写入的证据场景（CTX-13⑦）。
 *
 * 问题不是「写入是否落盘」—— `appendPiSessionCustomEntry` 直连仓库，落盘是必然的；
 * 问题是 lane 的 tip 缓存：旁路写入移动了持久 tip 之后，Harness 的下一步提交若按缓存
 * 的旧 tip 续写，就会把这条条目挤到 tip 链之外（条目还在文件里，但不在从 tip 回溯的
 * 证据链上）。所以断言落在「回合结束后从 tip 回溯仍能走到它」。
 */
export const 旁路写入: SceneDef = {
  meta: {
    caseId: "harness-branch-tip-bypass",
    module: "harness-storage",
    contractId: "hs-04",
    description: "阻塞工具期间经 session/repo 的旁路入口写入自定义条目：条目在会话文件中可读，且回合结束后仍在 lane 分支 tip 链上",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["session", "boundary", "storage"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME, {}, "bypass-call"),
      fakeText("旁路写入场景完成"),
      fakeText("旁路写入场景复核完成"),
    ])
    await initChat()
    blocking = registerBlockingTool(TOOL_NAME)
    const turn = sendMessage("跑一次阻塞工具")
    await blocking.started
    // 旁路点：工具仍在阻塞，回合没有结束，这条写入不经 Harness 的审计队列。
    bypassEntryId = await appendPiSessionCustomEntry(getActiveSessionId(), BYPASS_CUSTOM_TYPE, { at: Date.now() })
    blocking.release()
    await turn
  },
  turns: [{
    index: 1,
    description: "回合收尾后读分支：旁路条目可读、仍在 tip 链上、seq 与 tip 自洽",
    userText: "核对旁路写入的条目。",
    checks: [{
      type: "expectBypassEntryStillOnBranchTipChain",
      run: async () => {
        blocking?.dispose()
        const session = await acquirePiSession(getActiveSessionId())
        const branch = await session.branch(PI_LANE, BACKGROUND_CONTEXT)
        if (!branch) throw new Error(`lane 分支不存在: ${PI_LANE}`)

        // ① 旁路写入确实落盘：会话文件的普通读路径能读到它。
        const stored = await session.findEntries({ customType: BYPASS_CUSTOM_TYPE }, BACKGROUND_CONTEXT)
        if (!stored.some(entry => entry.id === bypassEntryId)) {
          throw new Error(`旁路条目在会话文件中读不到: 期望 ${bypassEntryId}，实际 ${JSON.stringify(stored.map(entry => entry.id))}`)
        }

        // ② 它仍在分支 tip 链上：从 tip 回溯必须走得到它（被 tip 缓存挤掉就会消失）。
        const tip = await branch.getTipId(BACKGROUND_CONTEXT)
        if (tip === null) throw new Error("lane 分支没有 tip")
        const chain = await branch.findEntries({ start: tip, order: "newestFirst" }, BACKGROUND_CONTEXT)
        const bypassEntry = chain.find(entry => entry.id === bypassEntryId)
        if (!bypassEntry) {
          throw new Error(`旁路条目不在 tip 链上: tip=${tip}，旁路 id=${bypassEntryId}，链上 id=${JSON.stringify(chain.map(entry => entry.id))}`)
        }

        // ③ 时间序自洽：旁路条目写在回合中途，其 seq 必须早于回合收尾后的 tip。
        const tipEntry = await session.getEntry(tip, BACKGROUND_CONTEXT)
        if (!tipEntry) throw new Error(`tip 条目读不到: ${tip}`)
        if (!(bypassEntry.seq < tipEntry.seq)) {
          throw new Error(`旁路条目 seq 不小于 tip 的 seq: bypass=${bypassEntry.seq}(${bypassEntryId}), tip=${tipEntry.seq}(${tip})`)
        }
      },
    }],
  }],
}

export default 旁路写入
