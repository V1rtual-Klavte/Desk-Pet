// ==========================================
// 压缩拒绝留痕 —— 手动 /compact 被判 declined 时不再一句话都不留
// ==========================================
//
// 事故现场（2026-10-05 实测）：44 条会话上点「压缩」，拿到 Card 的 commands.compactDeclined
//（「没有可摘要的完整旧轮次」），而会话文件里 deskpet.compaction_declined 0 条、三份日志 0 条 ——
// over_cap / oversized_unit / 真的没有可摘要范围三种原因无从区分。
//
// pi 的 declined 终态不带 error（agent-harness 的 CompactionRecord），唯一的原因出口是宿主钩子：
// 本测试钉住「素材为空」这条过去完全静默的路径 —— 钩子必须把结构化原因（kind/trigger/会话 id/
// 关键数字）写进审计槽，槽落成 deskpet.compaction_declined 条目；同时用户文案保持 declined 语义
//（不并进 compactFailed，也不并进 compactNothing —— 三个状态语义不同）。
//
// 判据全部对准「把实现改坏就红」：
// - 钩子不再写 decline 记录（empty_material）→ 条目缺失或字段缺失；
// - 槽不再为 manual decline 落条目 → 条目缺失；
// - trigger/kind/数字写错或写死 → 对应断言红；
// - 把 decline 误写成 failure → data.error 出现，且命令层翻成 compactFailed，两条断言同时红。
//
// 归 L3 的理由：需要真 JSONL 落盘与真 Harness 槽（@/services/engine/harness）；Provider 用 fake。

import type { FauxModelDefinition } from "@earendil-works/pi-ai"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { assistantTexts, compactionEntries, sessionEntries, sessionMessages } from "../../host/session-entries"
import { standardSetup } from "../../host/standard-setup"
import {
  COMPACTION_DECLINED_ENTRY, compactActiveSession, compactionSettingsFor, resolvePiTurnModel,
} from "@/services/engine/harness"
import { compactCommand } from "@/services/engine/slash/commands/compact"
import { getCommandReply } from "@/services/personality"
import { initChat } from "@/services/agent/runner"
import { flushLogs } from "@/services/logger"
import { initPaths } from "@/services/paths"
import { getActiveSessionId } from "@/services/session/store"
import { runRuntimeTurn } from "./回合夹具"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
const USER_TEXT = "压缩拒绝留痕探针。"
const REPLY = "压缩拒绝留痕探针回复完成。"

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-compaction-decline-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
})

/** 会话里的压缩降级审计条目（deskpet.compaction_declined）。 */
function declinedEntries(entries: Awaited<ReturnType<typeof sessionEntries>>) {
  return entries.filter(entry => entry.type === "custom" && entry.customType === COMPACTION_DECLINED_ENTRY)
}

describe("压缩拒绝留痕", () => {
  it("素材为空的手动压缩被判 declined：审计条目带 kind/trigger/会话 id 与关键数字，文案保持 declined 语义（不并进 failed/nothing）[memory-compaction-decline-audit]", async () => {
    installFakeProvider([fakeText(REPLY)], FAKE_MODEL)
    await initChat()
    const sessionId = getActiveSessionId()
    const turn = await runRuntimeTurn(USER_TEXT)
    expect(turn.failure, "场景前提：探针回合必须正常完成").toBeUndefined()

    // 场景前提：会话素材远小于保留窗口 —— pi 的切点因此把全量留在 retainedTail，素材为空。
    // 以后有人把探针载荷改大到超出保留窗口时，先在这里如实失败，别让后面的断言反推原因。
    const model = resolvePiTurnModel()
    const settings = compactionSettingsFor(model.contextWindow, model.maxTokens)
    const before = await sessionEntries(sessionId)
    expect(
      before.filter(entry => entry.type === "message").length,
      "场景前提：会话里应有一问一答至少两条消息",
    ).toBeGreaterThanOrEqual(2)

    // 用户路径：/compact 命令（与原生 UI 的压缩按钮同一条），必须仍是 declined 的 Card 文案。
    const text = (await compactCommand.execute()) ?? ""
    expect(text, "手动压缩被判 declined 时用户文案必须保持 commands.compactDeclined").toBe(getCommandReply("compactDeclined"))
    expect(
      text,
      "declined 被并进了 compactNothing（语义不同：没有可压缩的历史 vs 有历史但没有可安全摘要的范围）",
    ).not.toBe(getCommandReply("compactNothing"))

    const entries = await sessionEntries(sessionId)
    const declined = declinedEntries(entries)
    expect(declined.length, "declined 没有留下审计条目：会话文件 0 条正是本测试要防的事故症状").toBe(1)
    const data = (declined[0] as { data?: Record<string, unknown> }).data ?? {}
    expect(data.status, "降级条目的终态不是 declined").toBe("declined")
    expect(data.reason, "触发方式必须是 manual（用户点压缩）").toBe("manual")
    expect(data.error, "策略性 decline 被写成了内核失败：会污染失败面并把用户文案翻成 compactFailed").toBeUndefined()
    const record = data.decline as Record<string, unknown> | undefined
    expect(record, "审计条目没有 decline 结构化原因 —— 留痕没有从钩子传到槽").toBeDefined()
    expect(record?.kind, "拒绝分类必须是 empty_material（不是 over_cap/oversized_unit）").toBe("empty_material")
    expect(record?.trigger, "触发方式没有逐字落进结构化原因").toBe("manual")
    expect(record?.sessionId, "结构化原因缺会话 id").toBe(sessionId)
    const material = record?.material as Record<string, number> | undefined
    expect(material, "empty_material 必须带关键数字（素材与保留窗口的现场读数）").toBeDefined()
    expect(material?.messagesToSummarize, "decline 时待摘要素材必须是 0").toBe(0)
    expect(material?.turnPrefixMessages).toBe(0)
    expect(material?.droppedEmptyAssistant, "探针回合没有空助手消息，滤空计数应为 0").toBe(0)
    expect(material?.retainedMessages, "保留区条数应覆盖会话消息（全在保留窗口内是素材为空的直接原因）").toBeGreaterThanOrEqual(2)
    expect(material?.tokensBefore, "压缩前上下文估算必须为正").toBeGreaterThan(0)
    expect(material?.keepRecentTokens, "保留窗口数字必须是这次运行实际生效的设置").toBe(settings.keepRecentTokens)

    // 拒绝只改审计面：没有提交 compaction 条目，助手正文序列不动。
    expect(compactionEntries(entries).length, "declined 提交了 compaction 条目").toBe(0)
    const texts = assistantTexts(await sessionMessages(sessionId))
    expect(texts.filter(item => item.includes(REPLY)).length, "declined 改动了助手正文序列").toBe(1)

    // 第二条路径（运行入口）同语义：返回 declined 且不带 error —— 带 error 会把手动路径翻成 failed。
    const outcome = await compactActiveSession(sessionId)
    expect(outcome.status, "compactActiveSession 不再报 declined").toBe("declined")
    expect(outcome.error, "declined 被翻成了失败（error 非空）").toBeUndefined()
    expect(declinedEntries(await sessionEntries(sessionId)).length, "第二次 declined 没有各留一条审计条目").toBe(2)

    // 统一日志出口：拒绝原因必须真的落进 deskpet.log（「三份日志 0 条」正是事故症状的另一半）。
    await flushLogs()
    const logLines = readFileSync(join(dataRoot, "logs", "deskpet.log"), "utf8").split("\n")
    const logged = logLines.find(line => line.includes("\"kind\":\"empty_material\""))
    expect(logged, "declined 的原因没有进统一日志（没有一条带 empty_material 的原因行）").toBeDefined()
    expect(logged, "日志行没有带触发方式").toContain("\"trigger\":\"manual\"")
    expect(logged, "日志行没有带会话 id").toContain(`"sessionId":"${sessionId}"`)
    expect(logged, "日志行没有带保留窗口读数").toContain(`"keepRecentTokens":${settings.keepRecentTokens}`)
  }, 60_000)
})
