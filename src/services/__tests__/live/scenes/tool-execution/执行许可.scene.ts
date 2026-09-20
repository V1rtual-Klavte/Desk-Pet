import type { SceneDef } from "../../types"
import type { ToolDef, ToolPolicy } from "@/services/tool"
import { defineTool, register, unregister, executeToolDefinition, permitSnapshot, TOOL_POLICY_VERSION } from "@/services/tool"
import { loopConfig } from "@/services/config"
import { invoke } from "@tauri-apps/api/core"

/**
 * 执行许可：共享读可以有界并发，效果操作与其它执行互斥。
 *
 * 断言不靠时序猜测：等待是否发生直接读 Rust 许可域的额度快照（queued），
 * 再断言 handler 是否已经开始执行。
 */
const WAIT_BUDGET_MS = 3000

const tool = (id: string, isolation: "shared_read" | "exclusive_effect", effect: "read" | "local_mutation", run: () => Promise<void>): ToolDef =>
  defineTool({
    id, name: id, description: `许可探针 ${id}`, parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE", source: "local", sourceId: "", mode: "pet", actionCategory: "os.info",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect, mode: "sequential", isolation, replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async () => {
    await run()
    return { success: true, content: "ok" }
  })

/** 轮询额度快照：确定性等待「请求已进入许可队列」。 */
async function waitForQueued(min: number): Promise<boolean> {
  const deadline = Date.now() + WAIT_BUDGET_MS
  while (Date.now() < deadline) {
    const snapshot = await permitSnapshot()
    if (snapshot.queued >= min) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

const settle = (promise: Promise<unknown>): Promise<void> => promise.then(() => undefined, () => undefined)

export const 执行许可: SceneDef = {
  meta: {
    caseId: "tool-execution-permit", module: "tool-execution", contractId: "te-16",
    description: "只读共享额度可并发，独占效果与其它执行互斥，执行结束才释放",
    depth: "deep", suite: "safety", entry: "unit", tags: ["tool-execution", "safety", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "校验纯读并行与效果互斥",
    userText: "检查工具执行许可。",
    checks: [{
      type: "expectExecutionPermit",
      run: async () => {
        // ── 1. 两个只读工具共享额度：必须真的重叠 ──
        let readBEntered = false
        let overlapped = false
        const readA = tool("permit-read-a", "shared_read", "read", async () => {
          const deadline = Date.now() + WAIT_BUDGET_MS
          while (!readBEntered && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
          overlapped = readBEntered
        })
        const readB = tool("permit-read-b", "shared_read", "read", async () => { readBEntered = true })
        register(readA)
        register(readB)
        await Promise.all([
          executeToolDefinition(readA, {}, { mode: "pet", toolCallId: "permit-read-a" }),
          executeToolDefinition(readB, {}, { mode: "pet", toolCallId: "permit-read-b" }),
        ])
        if (!overlapped) throw new Error("两个只读工具没有并发执行")

        // ── 2. 独占效果必须等在进行中的读之后 ──
        let readReleased = false
        let writeStarted = false
        let readFinishedAt = 0
        let writeStartedAt = 0
        const holdingRead = tool("permit-read-hold", "shared_read", "read", async () => {
          const deadline = Date.now() + WAIT_BUDGET_MS
          while (!readReleased && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
          readFinishedAt = Date.now()
        })
        const waitingWrite = tool("permit-write-wait", "exclusive_effect", "local_mutation", async () => {
          writeStarted = true
          writeStartedAt = Date.now()
        })
        register(holdingRead)
        register(waitingWrite)
        const readJob = settle(executeToolDefinition(holdingRead, {}, { mode: "pet", toolCallId: "permit-read-hold" }))
        const writeJob = settle(executeToolDefinition(waitingWrite, {}, { mode: "pet", toolCallId: "permit-write-wait" }))
        if (!await waitForQueued(1)) throw new Error("独占效果没有进入许可队列")
        if (writeStarted) throw new Error("独占效果与进行中的读并发执行")
        readReleased = true
        await Promise.all([readJob, writeJob])
        if (!writeStarted) throw new Error("读释放后独占效果仍未执行")
        if (writeStartedAt < readFinishedAt) throw new Error("独占效果早于在读工具结束")

        // ── 3. 独占效果进行中：新的读必须排队，不能在效果期间开读 ──
        let effectReleased = false
        let effectFinishedAt = 0
        let lateReadStarted = false
        let lateReadStartedAt = 0
        const holdingWrite = tool("permit-write-hold", "exclusive_effect", "local_mutation", async () => {
          const deadline = Date.now() + WAIT_BUDGET_MS
          while (!effectReleased && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
          effectFinishedAt = Date.now()
        })
        const lateRead = tool("permit-read-late", "shared_read", "read", async () => {
          lateReadStarted = true
          lateReadStartedAt = Date.now()
        })
        register(holdingWrite)
        register(lateRead)
        const effectJob = settle(executeToolDefinition(holdingWrite, {}, { mode: "pet", toolCallId: "permit-write-hold" }))
        // 先确认独占已经拿到额度，再发起读，避免读抢在效果之前。
        const deadline = Date.now() + WAIT_BUDGET_MS
        while ((await permitSnapshot()).exclusiveActive !== true && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        if ((await permitSnapshot()).exclusiveActive !== true) throw new Error("独占效果没有取得额度")
        const readJob2 = settle(executeToolDefinition(lateRead, {}, { mode: "pet", toolCallId: "permit-read-late" }))
        if (!await waitForQueued(1)) throw new Error("独占期间的读没有进入许可队列")
        if (lateReadStarted) throw new Error("独占效果进行中仍开出了新的读")
        effectReleased = true
        await Promise.all([effectJob, readJob2])
        if (lateReadStartedAt < effectFinishedAt) throw new Error("排队读早于独占效果结束")

        // ── 4. 排队公平与取消等待：队首独占被取消后必须重新 drain ──
        // 直接对许可所有者下指令，构造「读被排在独占之后」的确定顺序。
        const borrow = (requestId: string, kind: "shared" | "exclusive") =>
          invoke<boolean>("tool_permit_acquire", { requestId, kind, sessionId: "permit-probe", runGeneration: 1, operationId: requestId })
        const release = (requestId: string) => invoke("tool_permit_release", { requestId })

        const holder = await borrow("probe-holder", "shared")
        if (!holder) throw new Error("共享占位没有取得额度")
        const queuedWrite = borrow("probe-queued-write", "exclusive")
        const queuedRead = borrow("probe-queued-read", "shared")
        if (!await waitForQueued(2)) throw new Error("等待者没有进入许可队列")
        let readGranted = false
        void queuedRead.then(granted => { readGranted = granted })
        // 读不能插到排队中的独占之前：有写入等待时不允许无限新增读任务造成饥饿。
        await new Promise(resolve => setTimeout(resolve, 200))
        if (readGranted) throw new Error("读抢在排队中的独占之前")

        // 取消排队中的独占：后面的读必须被重新唤醒，而不是永远留在队列里。
        await invoke("tool_permit_cancel", { requestId: "probe-queued-write" })
        if (await queuedWrite) throw new Error("被取消的独占等待仍取得额度")
        if (!await queuedRead) throw new Error("队首独占取消后，后面的读没有被放行")
        await release("probe-holder")
        await release("probe-queued-read")

        // ── 5. 额度归还干净：没有泄漏的借出记录 ──
        for (const probe of [readA, readB, holdingRead, waitingWrite, holdingWrite, lateRead]) unregister(probe.id)
        const idle = await permitSnapshot()
        if (idle.sharedActive !== 0 || idle.exclusiveActive || idle.queued !== 0) {
          throw new Error(`许可额度没有归还: shared=${idle.sharedActive} exclusive=${idle.exclusiveActive} queued=${idle.queued}`)
        }
        if (idle.maxSharedReaders < 2) throw new Error("共享读上限不允许两个只读并发")

        // ── 6. 共享读上限来自配置下发：范围校验、降低不撤销在飞许可、提高唤醒等待项 ──
        // 上限是所有者持有的额度，不是常量：这里直接对所有者下发并观测额度行为。
        const setLimit = (limit: number) => invoke<number>("tool_permit_set_max_shared_readers", { limit })

        await setLimit(1)
        const hold = await borrow("limit-hold", "shared")
        if (!hold) throw new Error("上限 1 时第一个读没有取得额度")
        const limitedRead = borrow("limit-limited", "shared")
        if (!await waitForQueued(1)) throw new Error("上限 1 时第二个读没有排队")
        let limitedGranted = false
        void limitedRead.then(granted => { limitedGranted = granted })
        await new Promise(resolve => setTimeout(resolve, 200))
        if (limitedGranted) throw new Error("上限 1 时第二个读越过了额度")
        if ((await permitSnapshot()).maxSharedReaders !== 1) throw new Error("下发的上限没有生效")

        // 提高上限即唤醒有序等待项；越界下发必须被拒绝且不改变生效值（上限 0 会让读永久排队）。
        await setLimit(2)
        if (!await limitedRead) throw new Error("提高上限后排队的读没有被唤醒")
        await release("limit-hold")
        await release("limit-limited")
        for (const bad of [0, 9]) {
          let rejected = false
          try { await setLimit(bad) } catch { rejected = true }
          if (!rejected) throw new Error(`越界上限 ${bad} 没有被拒绝`)
        }
        if ((await permitSnapshot()).maxSharedReaders !== 2) throw new Error("越界下发改变了生效上限")

        // 降低上限不撤销在飞许可：占用 2 时降到 1，两个在飞读继续持有，新读排队到占用降下来。
        const inflightA = await borrow("inflight-a", "shared")
        const inflightB = await borrow("inflight-b", "shared")
        if (!inflightA || !inflightB) throw new Error("上限 2 时两个读没有同时取得额度")
        await setLimit(1)
        if ((await permitSnapshot()).sharedActive !== 2) throw new Error("降低上限撤销了在飞许可")
        const inflightThird = borrow("inflight-third", "shared")
        if (!await waitForQueued(1)) throw new Error("降低上限后新读没有排队")
        await release("inflight-a")
        await release("inflight-b")
        if (!await inflightThird) throw new Error("占用降到新上限以下后排队读没有被放行")
        await release("inflight-third")

        // 收尾：把上限还给运行期配置值，不把本场景的探针值留给后续场景。
        await setLimit(loopConfig.maxParallelTools)
      },
    }],
  }],
}

export default 执行许可
