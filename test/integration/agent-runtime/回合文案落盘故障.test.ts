// ==========================================
// 回合文案落盘故障注入 —— persistFailed 消费链（结算文案的持久写入失败）
//
// 被测链（runtime.ts 的三条落盘出口共用同一形状 + runner.ts 的透传与提示）：
//   · settleMainTurn.failTurn：失败兜底回复 `appendAssistantMessage` 失败 → persistFailed=true；
//   · runner.pushTurnOutcome：persistFailed 时补系统消息「这条回复没能写进会话文件…」，
//     并把事实透传为 `SendMessageResult.persistFailed`（界面与持久正文不一致的可断言事实）；
//   · 恢复路径：失败只影响这一条文案 —— 下一代运行（新 generation）的写入照常落盘，
//     失败的那条不被重放、不顶掉新状态（旧代际不覆盖新状态）。
//     注意恢复的第 0 步：会话写入失败会把整条 Harness 打成故障态（Pi 的 lane 提交失败 =
//     harness fault，密封整个 harness），按设计「fault 后该会话停止驱动，需宿主显式处理，
//     不静默重建」（harness-slot.ts §8.7.4）。因此用例先钉住故障前提、由宿主显式放掉故障槽，
//     下一次运行再从盘上重新打开会话 —— 恢复不是同一槽的无处理续跑。
//
// 故障注入点（测试内定义，生产代码一行不动）：`NativeExecutionEnv.prototype.appendFile`。
// 会话 JSONL 的每次提交都是「appendFile 一行事务」（jsonl/storage 的 applyCommit），它就是
// 持久写入的**唯一物理边界**；只在内容命中「结算兜底文案」这一条提交时返回结构化
// FileError，其余写入（准入正文、审计条目、第二次回合）全部真实走宿主命令。刻意不
// mock/stub `appendAssistantMessage` 这类方法边界 —— 那会伪造助手结果、跳过真实持久边界，
// 与本用例要证的「界面看到了、会话文件里没有」正好错位。
//
// 归 L3 的理由：本用例要跑真 agent loop（真 JSONL 落盘 + 真运行槽 + 真结算）并从生产入口
// `sendMessage()` 驱动；Provider 由 fake 交付（规则 6：L2 不得 import engine/harness）。
// 回合失败路径由 fake Provider 的 `stopReason: "error"` 如实结算，不是测试侧抛错。
//
// 未运行声明：按实施期纪律，本文件只写不跑，断言对错留验收环节（首跑见红时先对质问
// 「断言写错 vs 实现缺陷」）。
// ==========================================

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { err, FileError } from "@earendil-works/pi-agent-core"
import type { Context, Result } from "@earendil-works/pi-agent-core"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { assistantTexts, countTexts, sessionMessages, userTexts } from "../../host/session-entries"
import { standardSetup } from "../../host/standard-setup"
import { initChat, sendMessage } from "@/services/agent/runner"
import { harnessSlots, turnFailureReply } from "@/services/engine/harness"
import { DESKPET_SYSTEM_MESSAGE_ENTRY } from "@/services/engine/runtime"
import { initPaths } from "@/services/paths"
import { getFallbackReply } from "@/services/personality"
import { chatHistory, listPiSessionMetadata, readPiSessionEntriesOnce, releasePiSession } from "@/services/session"
import { getActiveSessionId } from "@/services/session/store"
import { NativeExecutionEnv } from "@/services/tool/pi/native-execution-env"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
const TURN1_TEXT = "落盘故障注入：这一轮 Provider 以错误终止。"
/** 不得含可重试特征（503/timeout/…）：否则启用退避重试，脚本与断言都会错位。 */
const PROVIDER_ERROR = "落盘故障注入：回合以错误终止"
const TURN2_TEXT = "落盘故障注入：故障注入之后的新一轮。"
const TURN2_REPLY = "落盘故障注入：新一轮正常落盘的回复"
/** runner.pushTurnOutcome 的既定语料；断言只取可区分的最短片段。 */
const NOTICE_FRAGMENT = "没能写进会话文件"

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-persist-failed-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * 注入设施：命中「结算兜底文案」这一条会话提交时返回结构化失败。
 *
 * - 命中判据是**内容**（兜底文案 = `turnFailureReply` 的产出，测试用生产函数同源推导），
 *   因此注入与「哪一次 appendFile 是结算写入」解耦，不数调用次数、不依赖写入顺序；
 * - 注入不开任何旁路开关、不改产品代码；计数用于断言「只打掉了一条、且没有被重试重放」。
 */
function installSettleAppendFault(fallbackText: string) {
  const realAppendFile = NativeExecutionEnv.prototype.appendFile
  const state = { hits: 0, paths: [] as string[] }
  vi.spyOn(NativeExecutionEnv.prototype, "appendFile").mockImplementation(async function (
    this: NativeExecutionEnv, path: string, content: string | Uint8Array, context: Context,
  ): Promise<Result<void, FileError>> {
    if (typeof content === "string" && content.includes(fallbackText)) {
      state.hits += 1
      state.paths.push(path)
      return err(new FileError("unknown", "注入故障：会话写入失败", path))
    }
    return realAppendFile.call(this, path, content, context)
  })
  return state
}

/** 会话文件的原始盘上文本（不经过任何读模型/句柄缓存）。 */
async function rawSessionText(sessionId: string): Promise<string> {
  const metadata = (await listPiSessionMetadata()).find(item => item.id === sessionId)
  expect(metadata, `会话 ${sessionId} 不在仓库列举里（文件不存在？）`).toBeDefined()
  return readFileSync(metadata!.path, "utf8")
}

describe("回合文案落盘故障（persistFailed 消费链）", () => {
  it("结算文案写不进会话文件：失败分类照常结算、界面显示兜底但盘上没有、系统消息如实告知 [runtime-reply-persist-failure]", async () => {
    // 兜底文案用生产取用口推导（与 runtime 的 failTurn 同源）：注入判据与期望值不会各写一份。
    const expectedFallback = turnFailureReply(PROVIDER_ERROR, { overflowRecoveryDeclined: false }, "unknown")
    expect(expectedFallback, "期望的兜底文案为空，注入判据不成立").toBe(getFallbackReply("maxRetriesExhausted"))
    const fault = installSettleAppendFault(expectedFallback)

    const failingStep: FauxResponseStep = context => {
      const text = lastRequestText(context)
      expect(text, `错误脚本被非回合请求取走: ${text.slice(0, 60)}`).toContain(TURN1_TEXT)
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: PROVIDER_ERROR })
    }
    installFakeProvider([failingStep], FAKE_MODEL)
    await initChat()
    const sessionId = getActiveSessionId()
    expect(sessionId, "没有活跃会话，回合无从发生").not.toBe("")

    const result = await sendMessage(TURN1_TEXT)

    // ① 故障确实打在持久边界上：恰好一次、打的是会话文件。
    expect(fault.hits, "结算文案的持久写入没有被注入命中（持久边界没走到？）").toBe(1)
    expect(fault.paths[0]?.endsWith(".jsonl"), `注入命中的不是会话文件提交: ${fault.paths[0]}`).toBe(true)

    // ② 终态：失败照常结算（不是抛错吞回合），persistFailed 如实置位。
    expect(result.outcome, `回合没有按失败结算: ${JSON.stringify(result.failure)}`).toBe("failed")
    expect(result.failure, "回合失败分类缺失").toBeDefined()
    expect(result.persistFailed, "结算文案落盘失败没有置位 persistFailed（消费链断在这里）").toBe(true)
    expect(result.reply, "返回的可见回复应仍是兜底文案").toBe(expectedFallback)

    // ③ 界面看到了：兜底回复进了会话视图（用户不会发现自己「没收到回复」）。
    expect(
      chatHistory.some(message => message.text?.includes(expectedFallback)),
      "兜底回复没有进入会话视图（界面与持久正文的不一致失去可观测性）",
    ).toBe(true)

    // ④ 会话文件里没有：无效写入不得以任何形态落到盘上（含半行）。
    const raw = await rawSessionText(sessionId)
    expect(raw.includes(expectedFallback), "落盘失败后兜底文案仍出现在会话文件里").toBe(false)
    const messages = await sessionMessages(sessionId)
    expect(countTexts(assistantTexts(messages), expectedFallback), "读模型把未落盘的兜底记成了助手条目").toBe(0)
    expect(userTexts(messages).filter(text => text.includes(TURN1_TEXT)), "用户输入应在故障前已落盘（先落盘再投递）").toHaveLength(1)

    // ⑤ 用户提示：系统消息在视图里（队列落盘在下一个运行收口，不在本用例范围）。
    expect(
      chatHistory.some(message => (message as { text?: string }).text?.includes(NOTICE_FRAGMENT)),
      "没有给用户「这条回复没能写进会话文件」的可见提示",
    ).toBe(true)
  }, 60_000)

  it("故障只打掉这一条文案：下一代运行照常落盘、旧失败不重放不覆盖新状态，重开读回一致 [runtime-reply-persist-failure-recovery]", async () => {
    const expectedFallback = turnFailureReply(PROVIDER_ERROR, { overflowRecoveryDeclined: false }, "unknown")
    const fault = installSettleAppendFault(expectedFallback)

    const failingStep: FauxResponseStep = context => {
      const text = lastRequestText(context)
      expect(text, `错误脚本被非回合请求取走: ${text.slice(0, 60)}`).toContain(TURN1_TEXT)
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: PROVIDER_ERROR })
    }
    installFakeProvider([failingStep, fakeText(TURN2_REPLY)], FAKE_MODEL)
    await initChat()
    const sessionId = getActiveSessionId()

    const first = await sendMessage(TURN1_TEXT)
    expect(first.persistFailed, "第一回合的落盘失败没有置位 persistFailed").toBe(true)

    // 恢复的第 0 步（夹具前提）：持久写入失败已把整条 Harness 打成故障态。先钉住它 ——
    // 注入没触发故障时，「恢复回合正常」这条断言会退化成对普通回合的断言（前提不成立）。
    expect(
      harnessSlots.snapshot(sessionId)?.state,
      "注入没有把 Harness 打成故障态：恢复前提不成立",
    ).toBe("faulted")
    // 宿主显式处理故障（§8.7.4）：放掉故障槽（密封的 harness 只能整条重开，不能原地续跑）。
    await harnessSlots.dispose(sessionId)
    expect(harnessSlots.snapshot(sessionId), "故障槽没有被放掉，下一次运行无从重开会话").toBeUndefined()

    // 下一代运行：同一会话、新槽（从盘上重开），故障仍武装（内容判据只命中兜底文案，
    // 正常回复不受影响）——「盘上没有的东西不因重开而复活、新写入照常持久」正是恢复面要证的事。
    const second = await sendMessage(TURN2_TEXT)
    expect(second.failure, `恢复回合失败: ${second.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(second.outcome, "恢复回合没有成功").toBe("succeeded")
    expect(second.persistFailed, "恢复回合被误报为落盘失败").toBeUndefined()
    expect(second.reply, "恢复回合的回复不是脚本内容").toContain(TURN2_REPLY)
    expect(fault.hits, "故障被重试重放（应只命中第一回合那一条结算文案）").toBe(1)

    // 旧代际不覆盖新状态：关掉句柄、从盘上重新重放 —— 失败写入既不出现、也不顶掉后来的写入。
    await releasePiSession(sessionId)
    const entries = await readPiSessionEntriesOnce(sessionId, { order: "asc" })
    const raw = await rawSessionText(sessionId)

    expect(raw.includes(expectedFallback), "失败写入在后续时点被重放/合并进新状态").toBe(false)
    const replayed = await sessionMessages(sessionId)
    expect(countTexts(assistantTexts(replayed), TURN2_REPLY), "重放后恢复回合的助手条目不唯一").toBe(1)
    expect(countTexts(assistantTexts(replayed), expectedFallback), "重放后出现了未落盘的兜底文案").toBe(0)
    const users = userTexts(replayed)
    expect(users.filter(text => text.includes(TURN1_TEXT)).length, "第一回合的输入应仍在").toBe(1)
    expect(users.filter(text => text.includes(TURN2_TEXT)).length, "第二回合的输入应仍在").toBe(1)

    // 用户提示的持久去向：审计条目在下一个运行的收口 flush 时落盘，重开后仍可回读。
    const notices = entries.filter(entry =>
      entry.type === "custom" && entry.customType === DESKPET_SYSTEM_MESSAGE_ENTRY
      && JSON.stringify(entry.data ?? "").includes(NOTICE_FRAGMENT))
    expect(notices.length, "「没能写进会话文件」的提示没有落盘（重开后用户看不到故障事实）").toBeGreaterThan(0)
  }, 60_000)
})
