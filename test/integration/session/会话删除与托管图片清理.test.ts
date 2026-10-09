// ==========================================
// 删会话 → 清理该会话的托管聊天图片 —— L3（真临时数据根 + 真 JSONL 会话文件）
// ==========================================
//
// 归属 L3 的依据：`deleteSession` 在 `@/services/session`（规则 6），要真 JSONL 会话
// 文件才能证明「从条目收集图片路径」这一环。
//
// 诚实边界：`chat_delete_session_images` 是 Rust 专属命令 —— 「只删托管根（screenshots/
// 与 pasted/）内的常规文件、根外路径（用户原图）一律 skipped」是 Rust 侧的路径裁决，
// Node 适配层不复现（见 test/host/node-ipc.ts 文件头）。本文件用 `vi.mock` 只观测
// Node 边界：命令被调用、收到的路径集合正确、空集不调用、命令失败不改变返回值。
// 真正的包含判定（根内删除 / 根外不删除 / 目录与符号链接跳过）由 Rust 单测覆盖
// （crates/native-host/src/commands/chat_images.rs）。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { NodeHostBridge } from "../../host/node-host-bridge"
import { setTestDataRoot } from "../../host/node-ipc"
import { initConfig } from "@/services/config"
import { setHostBridge } from "@/services/host"
import type { HostBridge, HostCommandMap } from "@/services/host"
import { initPaths } from "@/services/paths"
import { PI_LANE, acquirePiSession, createPiSession, deleteSession, initSessions, readPiSessionEntries, resetPiSessionLayerForTest } from "@/services/session"
import { appendTopicEvidence, hasTopicSource } from "@/services/observation/store"

const HOISTED = vi.hoisted(() => ({
  calls: [] as Array<{ paths: string[] }>,
  failNext: false,
}))

vi.mock("@/services/host", async importOriginal => {
  // 只替换 Rust 专属命令 `chat_delete_session_images`（观测调用参数 + 失败注入），
  // 其余命令原样委托 setupFiles 注入的 NodeHostBridge（照截图工具用例的手法）。
  const actual = await importOriginal<typeof import("@/services/host")>()
  return {
    ...actual,
    getHostBridge: () => {
      const bridge = actual.getHostBridge()
      const wrapped = {
        ...bridge,
        request: async <K extends keyof HostCommandMap>(
          method: K,
          args: HostCommandMap[K]["args"],
          options?: { signal?: AbortSignal; scope?: import("@/services/host").RunScope },
        ) => {
          if (method === "chat_delete_session_images") {
            if (HOISTED.failNext) {
              throw Object.assign(new Error("宿主清理失败"), { code: "IO" })
            }
            HOISTED.calls.push(args as { paths: string[] })
            return { deleted: 0, skipped: 0 } as HostCommandMap[K]["result"]
          }
          return bridge.request(method, args, options)
        },
      }
      return wrapped as HostBridge
    },
  }
})

/** 最小合法 CONFIG（四根齐全；值只影响本文件要走的路径，照 native-ui 会话用例）。 */
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

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-session-images-"))
  setTestDataRoot(root)
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  await initPaths()
  await initConfig()
  setHostBridge(new NodeHostBridge())
  await initSessions()
}, 30_000)

beforeEach(() => {
  HOISTED.calls = []
  HOISTED.failNext = false
})

afterEach(async () => {
  await resetPiSessionLayerForTest()
})

afterAll(() => {
  setHostBridge(null)
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 写一个会话图片 fixture（目录不存在时创建）。 */
function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, "utf8")
}

/**
 * 新建会话并写入 message 条目（与生产投递同形：图片只存路径，字段名
 * `deskpetImagePaths` 与 `engine/runtime/input-identity.ts::userInputMessage` 一致）。
 */
async function seedSession(name: string, entryImagePaths: string[][]): Promise<string> {
  const summary = await createPiSession(name)
  const session = await acquirePiSession(summary.id)
  const branch =
    (await session.branch(PI_LANE, BACKGROUND_CONTEXT)) ??
    (await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT))
  for (const [index, imagePaths] of entryImagePaths.entries()) {
    const role = index % 2 === 0 ? "user" : "assistant"
    await branch.appendMessage(
      {
        role,
        content: `第 ${index + 1} 条`,
        timestamp: Date.now(),
        ...(imagePaths.length ? { deskpetImagePaths: [...imagePaths] } : {}),
      } as never,
      BACKGROUND_CONTEXT,
    )
  }
  return summary.id
}

describe("deleteSession 与托管聊天图片清理", () => {
  it("删会话后把条目里去重收集的图片路径交给宿主命令 [session-delete-images-call]", async () => {
    // 托管图片（应用落盘）与用户原图（用户自己的文件）都在条目里只存路径；
    // 区别只在 Rust 的包含判定，Node 侧必须把两类都如实交出去。
    const managedShot = join(root, "screenshots", "1700000000000.png")
    const managedPaste = join(root, "pasted", "1700000000001.png")
    const userOriginal = join(root, "user-photo.png")
    writeFixture(managedShot, "png")
    writeFixture(managedPaste, "png")
    writeFixture(userOriginal, "user")

    const sessionId = await seedSession("带图会话", [
      [managedShot, userOriginal],
      [managedShot, managedPaste], // 跨条目重复引用：交给宿主的必须是去重集合
    ])

    await expect(deleteSession(sessionId)).resolves.toBe(true)

    expect(HOISTED.calls, "恰好调用一次清理命令").toHaveLength(1)
    expect([...HOISTED.calls[0]!.paths].sort()).toEqual(
      [managedShot, managedPaste, userOriginal].sort(),
    )
    // Node 侧不做任何删除动作：文件是否被删由 Rust 按托管根判定（Rust 单测覆盖）。
    expect(existsSync(managedShot)).toBe(true)
    expect(existsSync(userOriginal)).toBe(true)
  })

  it("条目里没有任何图片路径时不调用宿主命令（不产生空请求） [session-delete-images-empty]", async () => {
    const sessionId = await seedSession("纯文本会话", [[], []])

    await expect(deleteSession(sessionId)).resolves.toBe(true)

    expect(HOISTED.calls).toHaveLength(0)
  })

  it("宿主清理失败只留痕，不改变 deleteSession 的返回语义 [session-delete-images-failure]", async () => {
    const managed = join(root, "screenshots", "1700000000002.png")
    writeFixture(managed, "png")
    const sessionId = await seedSession("失败注入会话", [[managed]])
    HOISTED.failNext = true

    await expect(deleteSession(sessionId)).resolves.toBe(true)

    expect(HOISTED.calls).toHaveLength(0)
  })

  it("删会话不再作废该会话产生的话题来源（证据独立存活到 TTL）[session-delete-keeps-topics]", async () => {
    // 2026-10-06 用户裁决：删会话不再触发 invalidateTopicSources —— 话题证据只由显式治理
    // （清除静默了解 / 记忆遗忘）与自身 TTL 决定去留。旧实现的删除路径会把该会话用户条目
    // 派生的话题来源全部作废（实机：删测试会话 → 话题来源全灭），本用例锚定这一行为。
    const sessionId = await seedSession("话题会话", [[]])
    const entries = await readPiSessionEntries(sessionId)
    const userEntry = entries.find(entry => entry.type === "message" && entry.message.role === "user")
    expect(userEntry, "会话里没有可用于话题来源的用户条目").toBeDefined()

    // 与 @/services/observation/topics 的 sourceIdFor 同算法：来源身份 = SHA-256(sessionId 换行 entryId) 前 16 字节。
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sessionId}\n${userEntry!.id}`))
    const sourceId = `topic-${[...new Uint8Array(digest)].slice(0, 16).map(value => value.toString(16).padStart(2, "0")).join("")}`
    await appendTopicEvidence([{ topic: "rust", category: "technology", stance: "neutral", sensitivity: "none", weight: 1, sourceId, observedAt: Date.now() }])
    expect(hasTopicSource(sourceId), "话题证据未写入（夹具失效）").toBe(true)

    await expect(deleteSession(sessionId)).resolves.toBe(true)

    expect(hasTopicSource(sourceId), "删会话把该会话产生的话题来源一并作废了").toBe(true)
  })
})
