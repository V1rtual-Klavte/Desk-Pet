// ==========================================
// 「记住这条」的可信来源核验与 V1RTUAL 指令落盘 —— L3（真临时数据根）
// ==========================================
//
// 归属 L3 的依据：`chat_remember_message` 的可信来源解析要**真 JSONL 会话文件**
// （`resolveCurrentTrustedMemorySource` 从会话仓库重读条目核验身份）；V1RTUAL
// 往返要**真文件落盘**（`file_write_atomic` → 磁盘回读）。fake 只替换宿主桥的
// 记录面（回执命令），其余命令原样委托 Node 测试宿主；不使用真实 Provider。
// 记忆库本身是 Rust 专属（`memory_*` 在 Node 适配层如实抛 UnsupportedInNodeError）：
// 可信来源的**提交**链路留在 L4，这里只证明 Node 侧不伪造成功。
//
// 被测行为：
//   · chat_remember_message 缺 sessionId/eventId 以结构化 CONFIG 拒绝；
//   · 来源不存在 / 不可信（会话里没有可信标记的原文）时如实拒绝，不静默也不假报
//     `{revision}`；
//   · 可信来源存在时进入登记链路（Rust 专属，Node 边界如实抛出，不假装提交成功）；
//   · v1rtual 写入 → 磁盘回读 → v1rtual_read 往返；空指令是「清空」这个真实意图。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { NodeHostBridge } from "../../host/node-host-bridge"
import { setTestDataRoot } from "../../host/node-ipc"
import { initConfig } from "@/services/config"
import { setHostBridge } from "@/services/host"
import { dispatchHostRequest } from "@/services/native-ui"
import { initPaths } from "@/services/paths"
import {
  PI_LANE,
  acquirePiSession,
  createPiSession,
  getActiveSessionId,
  initSessions,
  openSession,
  switchToSession,
} from "@/services/session"

/** 最小合法 CONFIG（四根齐全；值只影响本文件要走的路径）。 */
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
  loop: { maxRetry: 3, maxToolCallsPerTurn: 5, maxParallelTools: 2 }
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

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-native-ui-remember-"))
  setTestDataRoot(root)
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  await initPaths()
  await initConfig()
  // 真文件 I/O 全部交给 Node 测试宿主；本文件不需要事件通道（无记录面）。
  setHostBridge(new NodeHostBridge())
  await initSessions()
  if (!getActiveSessionId()) {
    const summary = await createPiSession("记忆探针")
    openSession({
      id: summary.id,
      name: summary.name || "记忆探针",
      createdAt: summary.createdAt,
      path: summary.path,
    })
    await switchToSession(summary.id)
  }
}, 30_000)

afterAll(() => {
  setHostBridge(null)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("chat_remember_message（记住这条）", () => {
  it("缺 sessionId / eventId 以结构化 CONFIG 拒绝", async () => {
    await expect(
      dispatchHostRequest("chat_remember_message", { eventId: "ev-1" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("chat_remember_message", { sessionId: getActiveSessionId() }),
    ).rejects.toMatchObject({ code: "CONFIG" })
  })

  it("来源不存在时如实拒绝（不静默、不假报 revision）", async () => {
    const sessionId = getActiveSessionId()
    // 会话没有任何可信标记的用户原文：核验必须失败，且不是空回执。
    await expect(
      dispatchHostRequest("chat_remember_message", { sessionId, eventId: "not-a-real-event" }),
    ).rejects.toThrowError(/可信用户来源缺失或不唯一/)
  })

  it("可信来源存在时进入登记链路：Node 不伪造提交，Rust 专属边界如实抛出", async () => {
    // 经真实会话 lane 追加一条带可信标记的用户原文（真 JSONL 落盘）：
    // 只有 origin=user + taint=trusted_user + eligibleForMemory=true（且事件身份带
    // `:user` 后缀）的原文才有候选资格 —— 与生产投递 `userInputMessage` 同形。
    const sessionId = getActiveSessionId()
    const session = await acquirePiSession(sessionId)
    const branch =
      (await session.branch(PI_LANE, BACKGROUND_CONTEXT)) ??
      (await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT))
    await branch.appendMessage(
      {
        role: "user",
        content: "我住在杭州",
        timestamp: Date.now(),
        deskpetEventId: "req-trusted-1:user",
        deskpetSource: {
          origin: "user",
          querySource: "user",
          priority: "normal",
          taint: "trusted_user",
          eligibleForMemory: true,
        },
      } as never,
      BACKGROUND_CONTEXT,
    )

    // 可信来源会被登记（`memory_register_sources` 是 Rust 专属命令）：Node 边界如实
    // 抛出 UnsupportedInNodeError —— 证明处理器（a）识别出了这条可信来源而不误判为
    // 「不是可信原文」，(b) 没有在 Node 侧伪造「已记住」；提交与门禁的验证属于 L4。
    await expect(
      dispatchHostRequest("chat_remember_message", { sessionId, eventId: "req-trusted-1:user" }),
    ).rejects.toMatchObject({ name: "UnsupportedInNodeError", command: "memory_register_sources" })
  })
})

describe("V1RTUAL 指令落盘往返", () => {
  const v1rtualPath = () => join(root, "memory", "V1RTUAL.md")

  it("写入后磁盘上真出现指令小节，读取返回刚写下的文本", async () => {
    await dispatchHostRequest("v1rtual_write", { content: "只喝美式，不加糖" })

    const onDisk = readFileSync(v1rtualPath(), "utf8")
    expect(onDisk, "写入必须真落盘（不是只进内存缓存）").toContain("## 指令")
    expect(onDisk).toContain("只喝美式，不加糖")

    expect(await dispatchHostRequest("v1rtual_read", {})).toEqual({ content: "只喝美式，不加糖" })
  })

  it("空串是「清空指令」这个真实意图：文件仍保留模板外壳，读取返回空", async () => {
    await dispatchHostRequest("v1rtual_write", { content: "" })

    const onDisk = readFileSync(v1rtualPath(), "utf8")
    expect(onDisk).toContain("# V1RTUAL.md")
    expect(onDisk, "清空后的正文里不应再出现旧指令").not.toContain("只喝美式")
    expect(await dispatchHostRequest("v1rtual_read", {})).toEqual({ content: "" })
  })

  it("缺 content 字段以 CONFIG 拒绝（不把 undefined 写成文本）", async () => {
    await expect(dispatchHostRequest("v1rtual_write", {})).rejects.toMatchObject({ code: "CONFIG" })
  })
})
