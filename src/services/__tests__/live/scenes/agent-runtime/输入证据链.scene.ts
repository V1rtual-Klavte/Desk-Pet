import { describeInputDelivery, PROMPT_SNAPSHOT_ENTRY } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { sessionEntries, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const STEER_TEXT = "把方向改成先检查配置。"
const REQUEST_ID = "runtime-delivery-evidence"
const INPUT_EVENT_ID = `${REQUEST_ID}:user`
const TOOL_NAME = "live_p1_evidence_wait"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let queuedStage: string | undefined
let finalStage: string | undefined
let finalEvidenceId: string | undefined
let snapshotStages: string[] = []
let snapshotIds: string[] = []
let transcriptCount = 0

/** 读一次阶段；读取失败（`ok:false`）在本场景按「读不到」处理（等待循环会重试）。 */
async function readStage(sessionId: string): Promise<string | undefined> {
  const lookup = await describeInputDelivery(sessionId, REQUEST_ID)
  return lookup.ok ? lookup.evidence?.stage : undefined
}

/** 快照在回合收尾后异步落盘：等一小会儿再核对，不把写入时序当成能力缺失。 */
async function waitForStage(sessionId: string, expected: (stage: string | undefined) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (expected(await readStage(sessionId))) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export const 输入证据链: SceneDef = {
  meta: {
    caseId: "runtime-delivery-evidence",
    module: "agent-runtime",
    contractId: "ar-10",
    description: "忙碌投递（steer 路径）的输入身份进入请求快照：阶段查询按既有产物给出 queued → request_prepared（拿到回执则为 responded），不凭空升级；空闲路径的身份见 runtime-idle-input-identity",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "delivery-intent", "persistence", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText("已按插话调整"),
      fakeText("确认完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始执行一个长任务。")
    await blocking.started
    await sendMessage(STEER_TEXT, { requestId: REQUEST_ID, delivery: "steer" })

    // 还在 inbox 里：这一档只能说「已排队」，不能说已进入请求。
    queuedStage = await readStage(sessionId)

    blocking.release()
    await firstTurn
    // 输入被消费并进入请求后，阶段与快照证据都应可核对。
    await waitForStage(sessionId, stage => stage === "request_prepared" || stage === "responded")
    const final = await describeInputDelivery(sessionId, REQUEST_ID)
    finalStage = final.ok ? final.evidence?.stage : undefined
    finalEvidenceId = final.ok ? final.evidence?.evidenceId : undefined

    // 原始证据：落盘的请求快照里确实有这条输入的身份。
    const entries = await sessionEntries(sessionId)
    const snapshots = entries.flatMap(entry => {
      if (entry.type !== "custom" || entry.customType !== PROMPT_SNAPSHOT_ENTRY) return []
      const data = entry.data as { snapshotId?: unknown; captureStage?: unknown; agentMessages?: unknown } | undefined
      const messages = Array.isArray(data?.agentMessages) ? data.agentMessages : []
      if (!messages.some(item => (item as { id?: unknown } | null)?.id === INPUT_EVENT_ID)) return []
      return [{
        snapshotId: typeof data?.snapshotId === "string" ? data.snapshotId : entry.id,
        captureStage: typeof data?.captureStage === "string" ? data.captureStage : "unknown",
      }]
    })
    snapshotIds = snapshots.map(item => item.snapshotId)
    snapshotStages = snapshots.map(item => item.captureStage)
  },
  turns: [{
    index: 1,
    description: "核对该输入在请求快照里的身份与阶段结论",
    userText: "确认一下刚才的处理。",
    checks: [{
      type: "expectDeliveryEvidenceFromPersistedSnapshot",
      run: async () => {
        blocking?.dispose()
        if (queuedStage !== "queued") throw new Error(`投递后未消费时应为 queued，实际 ${String(queuedStage)}`)
        if (snapshotIds.length === 0) throw new Error("没有任何请求快照包含该输入的身份（request_prepared 证不出来）")
        if (finalStage !== "request_prepared" && finalStage !== "responded") {
          throw new Error(`消费后的阶段应至少为 request_prepared，实际 ${String(finalStage)}`)
        }
        if (!finalEvidenceId || !snapshotIds.includes(finalEvidenceId)) {
          throw new Error(`阶段结论的证据 ${String(finalEvidenceId)} 不在落盘快照里: ${JSON.stringify(snapshotIds)}`)
        }
        // 「已拿到回执」只能由 provider_usage 快照支撑，不允许凭空升级。
        if (finalStage === "responded" && !snapshotStages.includes("provider_usage")) {
          throw new Error(`responded 缺少 provider_usage 快照证据: ${JSON.stringify(snapshotStages)}`)
        }
        const users = userTexts(await sessionMessages())
        transcriptCount = users.filter(text => text === STEER_TEXT).length
        if (transcriptCount !== 1) throw new Error(`投递正文未恰好出现一次: ${JSON.stringify(users)}`)
      },
    }],
  }],
}

export default 输入证据链
