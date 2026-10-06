// ==========================================
// 上下文占用重启恢复 —— 面板「上下文 X%」从会话快照读回（L3）
// ==========================================
//
// 被测语义（2026-10-06 用户报告「重启后 上下文 0%」：面板看起来像当前会话的
// 上下文是空的）：
// ① `restoreLastRequestStats` 从会话 JSONL 的 provider_usage 快照恢复「最近一次
//    对话请求」的真实输入量（`readLastConversationPromptTokens`）：恢复值与**实时链路**
//    （provider usage 事件 → updateRequestStats 的 lastPromptTokens / lastContextUsage）
//    一致，并且同一读数确实已落进会话文件（测试侧独立解析 JSONL 取证 —— 恢复的读数
//    必须能跨重启推导，而不是只在进程内存里对得上）；
// ② 恢复取**最后一次对话请求**，不是第一条；
// ③ 非对话请求的三类落盘形态都不参与：主动表达回合（origin 全为 "active"）、
//    计划步骤子运行（requestId 前缀 sub-agent-）、一次性文本调用（request purpose
//    one_shot）—— 各追加一条哨兵快照，恢复值必须仍是最后一次对话请求的真实读数；
// ④ 读不到真实读数（会话没有过对话请求）时保持 null —— 面板显示「—」，
//    不得回落成 0（0 会谎报「上下文是空的」）。
//
// 归 L3 的理由：跑真实 agent loop、真实 JSONL 落盘，且 import
// `@/services/engine/harness` 与 `@/services/session`（规则 6 的 L2 禁入清单）。
// 只替换 Provider（fake），工具/权限链照走真实路径；本文件不用工具，无
// execution-permit 替身。
//
// 「重启」在本文件的口径：读数只活在进程内存，重置内存读数 + 让缓冲帧落盘 +
// 走与真实重启相同的读取入口（`acquirePiSession` → `findEntries`）。

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { runRuntimeTurn } from "./_runtime-turn"
import { debug, restoreLastRequestStats } from "@/services/debug"
import { PROMPT_SNAPSHOT_ENTRY, flushSessionFrameWrites, resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import { initPaths } from "@/services/paths"
import { appendPiSessionCustomEntry, createNewSession, getActiveSessionId, listPiSessionMetadata } from "@/services/session"

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-context-restore-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
  // 冷启动形态：把进程内读数复位（这是唯一「重启后会丢」的部分）。
  debug.lastContextUsage = null
  debug.lastPromptTokens = 0
})

afterEach(() => {
  resetPiRuntimeProviderForTest()
})

/**
 * 会话 JSONL 里全部 provider_usage 快照的 actualInputTokens（测试侧最小解析）。
 *
 * 独立见证：不复用产品的读取器/快照构造，只按线上行格式取证「读数确实在盘上」。
 * 行必须可解析 —— 解析失败就是证据面被破坏，让用例如实红（不吞错误）。
 */
async function persistedActuals(sessionId: string): Promise<number[]> {
  const metadata = (await listPiSessionMetadata()).find(item => item.id === sessionId)
  if (!metadata) return []
  const actuals: number[] = []
  for (const line of readFileSync(metadata.path, "utf8").split("\n")) {
    if (!line) continue
    const parsed: unknown = JSON.parse(line)
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const record = item as {
        kind?: unknown
        customType?: unknown
        data?: { captureStage?: unknown; actualInputTokens?: unknown }
      }
      if (record?.kind !== "entry" || record.customType !== PROMPT_SNAPSHOT_ENTRY) continue
      const actual = record.data?.captureStage === "provider_usage" ? record.data.actualInputTokens : undefined
      if (typeof actual === "number" && actual > 0) actuals.push(actual)
    }
  }
  return actuals
}

describe("上下文占用重启恢复", () => {
  it("重启后从会话快照恢复：与实时口径同值，且读数确实落在会话文件里 [context-usage-restore]", async () => {
    installFakeProvider([fakeText("收到。")])
    await runRuntimeTurn("上一句随便说点什么。")

    const sessionId = getActiveSessionId()
    const liveTokens = debug.lastPromptTokens
    const liveUsage = debug.lastContextUsage
    // 前置不变量：实时口径确有读数（前置不成立时恢复断言没有区分力）。
    expect(liveTokens, "回合结束后实时口径没有真实输入量读数").toBeGreaterThan(0)
    expect(liveUsage, "回合结束后实时口径没有上下文占用读数").not.toBeNull()

    // 「重启」：缓冲帧落盘 + 内存读数复位；恢复只能从盘上的证据得来。
    await flushSessionFrameWrites(BACKGROUND_CONTEXT)
    debug.lastContextUsage = null
    debug.lastPromptTokens = 0
    await restoreLastRequestStats()

    // 判据一：恢复值 == 实时链路读到的最后一笔真实输入量（两条链路互证）。
    expect(debug.lastPromptTokens, "重启恢复的输入量与实时口径不一致").toBe(liveTokens)
    expect(debug.lastContextUsage, "重启恢复的上下文占比与实时口径不一致").toBe(liveUsage)
    // 判据二（独立见证）：该读数确实以 provider_usage 快照落在会话文件里。
    const actuals = await persistedActuals(sessionId)
    expect(actuals, "会话文件里没有与实时读数一致的 provider_usage 证据").toContain(liveTokens)
  })

  it("恢复取最后一次对话请求；主动/子运行/一次性形态的快照都不参与 [context-usage-restore-picks-last-formal]", async () => {
    installFakeProvider([fakeText("第一回合。"), fakeText("第二回合。")])
    await runRuntimeTurn("第一句话。")
    const firstTokens = debug.lastPromptTokens
    await runRuntimeTurn("第二句话更长一些，把两次请求的真实输入量明确拉开，别让前置判别失效。")
    const sessionId = getActiveSessionId()
    const lastTokens = debug.lastPromptTokens
    // 前置不变量：两回合读数不同（相同则「取最后一条」与「取第一条」测不开）。
    expect(lastTokens, "两回合的真实输入量相同，本用例失去区分力").not.toBe(firstTokens)

    // 三类同形落盘的 provider_usage 快照（形态与真实生产者逐字段对齐；哨兵值与真实
    // 读数拉开量级 —— 恢复若选错任意一类都会拿到对应哨兵）：
    const probe = (extra: Record<string, unknown>) => ({
      schemaVersion: 1,
      sessionId,
      captureStage: "provider_usage",
      agentMessages: [{ id: "probe:0", role: "user", contentHash: "probe" }],
      estimatedInputTokens: 1,
      cache: {},
      redactions: [],
      createdAt: Date.now(),
      ...extra,
    })
    // ① 主动表达回合：purpose 仍是 "turn"（runPiAgentTurn 的缺省），origin 全为 "active"
    //    （dev 数据根里的真实主动快照就是这一形）→ 只有 origin 判据拦得住它。
    await appendPiSessionCustomEntry(sessionId, PROMPT_SNAPSHOT_ENTRY, probe({
      snapshotId: "active-probe", requestId: "active-probe", turnId: "active-probe", runId: "active-probe",
      request: { purpose: "turn", step: "assistant", attempt: 1 },
      agentMessages: [{ id: "active:1", role: "user", contentHash: "probe", origin: "active" }],
      actualInputTokens: 999_999,
    }))
    // ② 计划步骤子运行：requestId 前缀 sub-agent-（runPiSubAgent 的唯一生产形态），
    //    origin 是常规的 user/assistant/tool，purpose 也是 "turn" —— 只有前缀判据拦得住它。
    await appendPiSessionCustomEntry(sessionId, PROMPT_SNAPSHOT_ENTRY, probe({
      snapshotId: "sub-agent-probe:provider_usage:1", requestId: "sub-agent-probe",
      turnId: "sub-agent-probe", runId: "sub-agent-probe",
      request: { purpose: "turn", step: "assistant", attempt: 1 },
      agentMessages: [{ id: "agent:0", role: "user", contentHash: "probe", origin: "user" }],
      actualInputTokens: 888_888,
    }))
    // ③ 一次性文本调用：purpose "one_shot"（completePiText 的 OneShot 构造）。
    await appendPiSessionCustomEntry(sessionId, PROMPT_SNAPSHOT_ENTRY, probe({
      snapshotId: "one-shot:stages:probe:provider_usage", requestId: "one-shot-probe",
      turnId: "one-shot-probe", runId: "one-shot-probe",
      request: { purpose: "one_shot" },
      actualInputTokens: 777_777,
    }))

    await flushSessionFrameWrites(BACKGROUND_CONTEXT)
    debug.lastContextUsage = null
    debug.lastPromptTokens = 0
    await restoreLastRequestStats()

    expect(debug.lastPromptTokens, "恢复取了主动/子运行/一次性快照（哨兵值）或第一条对话请求").toBe(lastTokens)
  })

  it("没有可恢复的对话请求证据时保持未知（null），不回落成 0 [context-usage-unknown-stays-null]", async () => {
    // 新会话（尚无任何请求）：如实留 null（面板显示「—」），不写 0。
    await createNewSession()
    await restoreLastRequestStats()
    expect(
      debug.lastContextUsage,
      "没有证据时回落成了数字 —— 0 会谎报「上下文是空的」（用户报告的重启形态）",
    ).toBeNull()

    // 反面对照：同一条恢复函数在有证据的会话上确实会写入真实读数
    //（否则上面的 null 断言可能来自「恢复恒不写入」这一坏实现）。
    installFakeProvider([fakeText("有读数了。")])
    await runRuntimeTurn("随便说一句。")
    debug.lastContextUsage = null
    debug.lastPromptTokens = 0
    await restoreLastRequestStats()
    expect(debug.lastPromptTokens, "有证据的会话上恢复没有写入真实输入量（恒 null 的坏实现）").toBeGreaterThan(0)
    expect(debug.lastContextUsage, "有证据的会话上恢复没有写入上下文占用").not.toBeNull()
  })
})
