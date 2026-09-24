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
 * 问题是 lane 的 tip 缓存：旁路写入移动了持久 tip 之后，Harness 的下一步提交若按内存
 * 里的旧 tip 续写，就会把这条条目挤到 tip 链之外（条目还在文件里，但不在从 tip 回溯的
 * 证据链上）。
 *
 * 2026-09-24 W5 两轮实测（caseId `harness-branch-tip-bypass`）：**机制成立，旁路条目
 * 确实被挤掉**（第一轮 tip=`…afac`、旁路=`…af84`，16 条链上没有 af84；第二轮同样不在）。
 *   - Harness 那次提交的 `parentId` 取的是内存里的旧 tip，不是旁路写入移动后的持久
 *     tip，提交又把 `branch.tip` 写回自己那条 —— 两条条目共父，旁路那条成孤立分支。
 * 源码侧核对（安装版本 `@earendil-works/pi-agent-core@0.85.1`）：`StorageBackedSession.appendToBranch`
 * 会原子地把 `branch.tip` 置为新条目（`harness/session/session.js:316-340`），而 Harness 的
 * 提交面只用内存 `state.tipId` 当 `parentId` 并覆盖 `branch.tip`
 * （`harness/runtime/drive/boundary.js:51/76`、`tool-placement.js:98/151`），
 * 持久 tip 只在 lane 恢复路径上读（`harness/runtime/restore.js:41` 的 `readLaneStorage`），
 * 提交面只写不读 —— 回合进行中经旁路入口的写入因此必然落在链外。修法归 session 层。
 *
 * 用户 2026-09-24 裁定：「改断言钉真实现状」。本场景因此断言**当前的**归宿（可读、
 * 在链外），并把它当成回归守卫 —— 会话层修好、旁路条目回到链上时，②会主动失败并
 * 指名要更新的登记（本文件注释、hs-04 描述、《未完成工作与已知缺口》§3）。
 */
export const 旁路写入: SceneDef = {
  meta: {
    caseId: "harness-branch-tip-bypass",
    module: "harness-storage",
    contractId: "hs-04",
    description: "阻塞工具期间经 session/repo 的旁路入口写入自定义条目，实测它回合结束后的归宿：条目在会话文件中可读、seq 早于收尾 tip；tip 链可见性按 2026-09-24 两轮实测钉为**不在**链上（被 Harness 按内存 tip 续写的提交挤成孤立分支，属已登记的会话层限制）",
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
    description: "回合收尾后读分支：旁路条目可读、不在 tip 链上（已登记限制）、seq 与 tip 自洽",
    userText: "核对旁路写入的条目。",
    checks: [{
      type: "expectBypassEntryStoredButOffBranchTipChain",
      run: async () => {
        blocking?.dispose()
        const session = await acquirePiSession(getActiveSessionId())
        const branch = await session.branch(PI_LANE, BACKGROUND_CONTEXT)
        if (!branch) throw new Error(`lane 分支不存在: ${PI_LANE}`)

        // ① 旁路写入确实落盘：会话文件的普通读路径能读到它。
        const stored = await session.findEntries({ customType: BYPASS_CUSTOM_TYPE }, BACKGROUND_CONTEXT)
        const storedBypass = stored.find(entry => entry.id === bypassEntryId)
        if (!storedBypass) {
          throw new Error(`旁路条目在会话文件中读不到: 期望 ${bypassEntryId}，实际 ${JSON.stringify(stored.map(entry => entry.id))}`)
        }

        // ② 它**不在**分支 tip 链上：这是 2026-09-24 实测确认的当前归宿（Harness 提交面
        //    按内存 tip 续写并覆盖 branch.tip，把旁路条目挤成孤立分支）。反转成守卫：
        //    一旦回到链上（说明会话层限制已修复），这里失败并提醒更新登记。
        const tip = await branch.getTipId(BACKGROUND_CONTEXT)
        if (tip === null) throw new Error("lane 分支没有 tip")
        const chain = await branch.findEntries({ start: tip, order: "newestFirst" }, BACKGROUND_CONTEXT)
        if (chain.some(entry => entry.id === bypassEntryId)) {
          throw new Error(
            `旁路条目回到了 tip 链上（会话层限制疑似已修复）: tip=${tip}，旁路 id=${bypassEntryId}。` +
            `请更新：本场景注释、hs-04 覆盖点描述、《未完成工作与已知缺口》§3 的登记。`,
          )
        }

        // ③ 时间序自洽：旁路条目写在回合中途，其 seq 必须早于回合收尾后的 tip。
        const tipEntry = await session.getEntry(tip, BACKGROUND_CONTEXT)
        if (!tipEntry) throw new Error(`tip 条目读不到: ${tip}`)
        if (!(storedBypass.seq < tipEntry.seq)) {
          throw new Error(`旁路条目 seq 不小于 tip 的 seq: bypass=${storedBypass.seq}(${bypassEntryId}), tip=${tipEntry.seq}(${tip})`)
        }
      },
    }],
  }],
}

export default 旁路写入
