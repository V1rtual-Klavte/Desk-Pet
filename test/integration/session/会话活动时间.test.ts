// ==========================================
// 会话活动时间（列表排序口径）—— L3（真临时数据根 + 真 JSONL 落盘）
// ==========================================
//
// 归属 L3 的依据：`@/services/session` 是规则 6 的 IPC 域（真会话文件读写经宿主命令），
// 而本用例要证的是**盘上正文**与活动时间读取的一致性 —— 必须真 JSONL 落盘。fake 只有
// Node 测试宿主的命令面（`test/host/node-ipc.ts` 的 session_read_text / tailBytes 等价实现）。
//
// 口径（2026-10-06 用户拍板）：会话列表按**用户活动时间**排序 —— 正文最后一条
// `role:"user"` 条目（message.timestamp 优先，回退条目级 timestamp；与读模型的展示时间
// 同口径）；助手的主动消息/自定义条目不算；没有用户消息回退 createdAt。
// **维护类写入不改变它**：折叠保留行逐字不变、重命名只追加 value 行，两条都在这里验证。
//
// 诚实边界：tailBytes 的路径边界（PathEscape/canonical）与真 Rust 的字节裁剪由
// `crates/native-host/src/commands/session_fs.rs` 的单测与 L4 覆盖；这里证的是 Node 侧
// 语义一致（活动时间数值、排序、不变式）。
//
// 2026-10-06 验收已运行（6 用例全绿，含首跑逮住的「回退态 null 不缓存」实现修复）。

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { NodeHostBridge } from "../../host/node-host-bridge"
import { setTestDataRoot } from "../../host/node-ipc"
import { initConfig } from "@/services/config"
import { setHostBridge } from "@/services/host"
import { initPaths } from "@/services/paths"
import {
  PI_LANE,
  acquirePiSession,
  createPiSession,
  initSessions,
  lastUserEntryTimestamp,
  listPiSessionMetadata,
  persistPiSessionName,
  readPiSessionSummary,
  readSessionActivityAt,
  refreshSessionHistory,
  releasePiSession,
  resetPiSessionLayerForTest,
  sessionHistory,
} from "@/services/session"
import type { PiSessionSummary } from "@/services/session"

/** 最小合法 CONFIG（四根齐全；值只影响本文件要走的路径，照会话图片用例）。 */
const CONFIG_YAML = `
general:
  popup:
    mode: cursor
    autoPopupOnMessage: false
    defaultSize: { w: 730, h: 450 }
    chatWidth: 220
  shortcut:
    key: P
    macModifiers: [Control, Command]
    winModifiers: [Control, Alt]
  logging: { level: info }
  errors: { overlay: auto }
ai:
  provider: test
  endpoint: http://127.0.0.1:0
  apiKey: ""
  requireApiKey: false
  model: test-model
  auxModel: ""
  contextMaxTokens: 131072
  thinking: { effort: auto }
  conversation: { defaultDelivery: steer, steeringMode: all, followUpMode: all }
  loop: { maxRetry: 3, subAgentRounds: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  plan: { enabled: false }
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { frequency: "off" }
tools:
  bash: { whitelist: [ls, cat] }
  mcp: { servers: [] }
appearance:
  activeProfile: ""
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: "", size: 15 }
  chatImagePreview: false
`

/** 折叠闸门的前置下界（`FOLD_POLICY.minFileBytes` = 512 KiB）：夹具必须真跨过它。 */
const FOLD_GATE_BYTES = 512 * 1024

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-session-activity-"))
  setTestDataRoot(root)
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  await initPaths()
  await initConfig()
  setHostBridge(new NodeHostBridge())
  await initSessions()
}, 30_000)

afterEach(async () => {
  await resetPiSessionLayerForTest()
})

afterAll(() => {
  setHostBridge(null)
  if (root) rmSync(root, { recursive: true, force: true })
})

// ── 夹具 ──

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp }
}

/** 助手条目夹具：只构造读侧关心的字段（存储层只校验 stopReason ≠ "pending"）。 */
function assistantMessage(text: string, timestamp: number): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp } as never
}

/** 真实事务追加一条 message 条目（entryId/seq 由仓库生成）。 */
async function appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
  const session = await acquirePiSession(sessionId)
  const branch =
    (await session.branch(PI_LANE, BACKGROUND_CONTEXT)) ??
    (await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT))
  await branch.appendMessage(message, BACKGROUND_CONTEXT)
}

/** 从仓库列举取新鲜 metadata 再读展示摘要（与历史面板同一条读路径）。 */
async function summaryOf(sessionId: string): Promise<PiSessionSummary | null> {
  const metadata = (await listPiSessionMetadata()).find((item) => item.id === sessionId)
  expect(metadata, `会话 ${sessionId} 不在仓库列举里`).toBeDefined()
  return await readPiSessionSummary(metadata!)
}

describe("会话活动时间（列表排序口径）", () => {
  it("活动时间取最后一条用户消息：其后的助手条目不顶 [harness-session-activity-tail-read]", async () => {
    const created = await createPiSession("活动探针-末条用户")
    const t1 = 1_700_000_100_000
    const t2 = 1_700_000_200_000
    const t3 = 1_700_000_300_000
    const t4 = 1_700_000_400_000
    await appendMessage(created.id, userMessage("第一句", t1))
    await appendMessage(created.id, assistantMessage("回复一", t2))
    await appendMessage(created.id, userMessage("第二句", t3))
    await appendMessage(created.id, assistantMessage("回复二", t4))

    const summary = await summaryOf(created.id)
    expect(summary?.activityAt, "最后一条 user 条目是 t3；t4 的助手条目不得顶上").toBe(t3)
  })

  it("没有用户消息的会话活动时间为 null，按创建时间回退；有活动的旧会话排到最前", async () => {
    const older = await createPiSession("无活动-旧")
    const newer = await createPiSession("无活动-新")
    const activityAt = Date.now() + 60_000
    await appendMessage(older.id, userMessage("刚聊过", activityAt))

    await refreshSessionHistory()

    const newerItem = sessionHistory.value.find((item) => item.id === newer.id)
    expect(newerItem, "新会话应在历史列表里").toBeDefined()
    expect(newerItem?.activityAt, "没有用户消息时活动时间为 null（回退 createdAt）").toBeNull()
    const olderItem = sessionHistory.value.find((item) => item.id === older.id)
    expect(olderItem?.activityAt).toBe(activityAt)

    const ids = sessionHistory.value.map((item) => item.id)
    expect(ids.indexOf(older.id), "聊过的旧会话应排在没有活动的新会话之前").toBeLessThan(
      ids.indexOf(newer.id),
    )
  })

  it("活动时间相同的会话按 id 升序稳定排列，重复刷新不换位", async () => {
    const a = await createPiSession("并列-甲")
    const b = await createPiSession("并列-乙")
    const sameAt = Date.now()
    await appendMessage(a.id, userMessage("并列", sameAt))
    await appendMessage(b.id, userMessage("并列", sameAt))

    await refreshSessionHistory()
    const first = sessionHistory.value
      .filter((item) => item.id === a.id || item.id === b.id)
      .map((item) => item.id)
    await refreshSessionHistory()
    const second = sessionHistory.value
      .filter((item) => item.id === a.id || item.id === b.id)
      .map((item) => item.id)

    // 规则即「同值按 id 升序」；期望值由规则算出，不调用被测比较器。
    const expected = [a.id, b.id].sort((left, right) => left.localeCompare(right))
    expect(first).toEqual(expected)
    expect(second, "重复刷新结果必须一致（稳定）").toEqual(first)
  })

  it("重命名不改变活动时间（维护类写入不动正文）", async () => {
    const created = await createPiSession("重命名探针")
    const userAt = 1_700_002_000_000
    await appendMessage(created.id, userMessage("聊过一句", userAt))
    await appendMessage(created.id, assistantMessage("回复", userAt + 1000))
    expect((await summaryOf(created.id))?.activityAt).toBe(userAt)

    const renamed = await persistPiSessionName(created.id, "改过的名字")
    expect(renamed, "重命名应落盘成功（否则证明不了不变式）").toBe(true)

    expect((await summaryOf(created.id))?.activityAt, "重命名后活动时间必须不变").toBe(userAt)
    // 换一个缓存键强制真实重扫（历史写入推进了 mtime）：证明不是缓存把旧值兜住了。
    expect(await readSessionActivityAt(created.path, 0)).toBe(userAt)
  })

  it("关闭会话触发的折叠不改变活动时间", async () => {
    const created = await createPiSession("折叠探针")
    const userAt = 1_700_003_000_000
    await appendMessage(created.id, userMessage("折叠前聊过", userAt))

    // 造可回收体积：超大门牌名（value/set）随后删除（value/delete）—— 折叠的纯删除式重写
    // 会回收 set 行；夹具因此真跨过 minFileBytes / minReclaimBytes / minReclaimRatio 三条闸门。
    const bigName = "折".repeat(300_000) // UTF-8 900 KB
    await persistPiSessionName(created.id, bigName)
    const session = await acquirePiSession(created.id)
    await session.setName(undefined, BACKGROUND_CONTEXT)

    const sizeBefore = statSync(created.path).size
    expect(sizeBefore, "夹具必须跨过折叠的 512 KiB 文件闸门").toBeGreaterThan(FOLD_GATE_BYTES)

    await releasePiSession(created.id) // 关闭 + 折叠（releasePiSession 的既有主路径）

    const afterText = readFileSync(created.path, "utf8")
    expect(afterText.includes("折折折"), "死 key 的 set 行应已被折叠回收（夹具必须真折叠）").toBe(false)
    expect(statSync(created.path).size).toBeLessThan(sizeBefore)
    expect((await summaryOf(created.id))?.activityAt, "折叠后活动时间必须不变").toBe(userAt)
  })

  it("尾部解析：数组行与撕裂行不误判，时间戳 message 优先、条目级回退，助手不顶", () => {
    const userLine = JSON.stringify({
      kind: "entry",
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: 111,
      message: { role: "user", content: "你好" },
      seq: 1,
    })
    const assistantLine = JSON.stringify({
      kind: "entry",
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: 222,
      message: { role: "assistant", content: [] },
      seq: 2,
    })

    // 最后一条完整用户条目之后还有助手条目：取用户条目的时间戳。
    expect(lastUserEntryTimestamp(`${userLine}\n${assistantLine}\n`)).toBe(111)
    // 多写事务（数组行）：user 条目在数组里同样识别；message 无时间戳时回退条目级。
    const arrayLine = JSON.stringify([
      { kind: "value", op: "set", seq: 3, namespace: "n", key: "k", value: 1 },
      { kind: "entry", type: "message", timestamp: 333, message: { role: "user" }, seq: 4 },
    ])
    expect(lastUserEntryTimestamp(arrayLine)).toBe(333)
    // 撕裂的最后一行（半行 JSON）按跳过处理，继续用前一条完整行。
    expect(lastUserEntryTimestamp(`${userLine}\n{"kind":"entry","type":"mess`)).toBe(111)
    // 只有助手条目：不算用户消息。
    expect(lastUserEntryTimestamp(assistantLine)).toBeNull()
    // message.timestamp 优先于条目级 commit 时间戳（与读模型展示时间同口径）。
    const both = JSON.stringify({
      kind: "entry",
      type: "message",
      timestamp: 999,
      message: { role: "user", content: "x", timestamp: 555 },
      seq: 5,
    })
    expect(lastUserEntryTimestamp(both)).toBe(555)
  })
})
