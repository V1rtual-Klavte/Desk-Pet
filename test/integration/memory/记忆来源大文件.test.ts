// ==========================================
// 记忆来源收集 · 超过 5 MiB 的真实会话 JSONL —— L3
// ==========================================
//
// 5 MiB（`MAX_TOOL_FILE_BYTES`）是**工具面**单次读写的上限，也是会话 JSONL 单次追加的上限；
// 它不是会话文件与读路径的上限 —— 一条聊得足够久的会话由多次追加堆到 5 MiB 以上完全正常。
// 本用例用真仓库把一条真实会话（多次追加，每条在单次上限内）写到 5 MiB 以上，
// 再跑生产收集链（`collectMemorySources` → `readPiSessionEntriesOnce` →
// `trustedSourcesFromEntries` → 全文 sha256），钉住三件事：
//   · 越过 5 MiB 的尾部消息同样登记（按 5 MiB 截断读路径会让它整条消失）；
//   · 登记的证据有界（4000 字符），`sourceLength` 是全文长度而不是证据长度；
//   · `contentHash` 对全文计算 —— 前 4000 字符相同、尾部不同的两条消息必须是两个来源，
//     否则「证据截断参与 hash」会把它们并成同一版本。
//
// 边界替换只有 memory ipc 的登记（Rust 命令）；宿主桥、会话仓库、JSONL 落盘与哈希都是真的。

import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const register = vi.hoisted(() => vi.fn(async (_sources: unknown[]): Promise<number> => 0))
vi.mock("@/services/agent/memory/ipc", () => ({ registerMemorySources: register }))

import { setTestDataRoot } from "../../host/node-ipc"
import { collectMemorySources } from "@/services/agent/memory/sources"
import { inputSourceMark, userInputMessage } from "@/services/engine/runtime"
import type { IngressEnvelope } from "@/services/engine/runtime"
import { initPaths } from "@/services/paths"
import { PI_LANE, acquirePiSession, createPiSession, listPiSessionMetadata, releasePiSession } from "@/services/session/repo"
import { MAX_TOOL_FILE_BYTES } from "@/services/tool/pi/native-execution-env"

/**
 * 单条消息的字符数（中文，UTF-8 约 3.6 MB）：五次追加各自在单次 5 MiB 上限内，
 * 合计的会话文件越过 5 MiB 边界。
 */
const MESSAGE_CHARS = 1_200_000
const MESSAGE_COUNT = 5
/** 证据片段上限（与 sources.ts 的 EVIDENCE_CHARS 同值）：登记证据不得超出它。 */
const EVIDENCE_CHARS = 4_000

let root = ""

beforeAll(async () => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "memory-large-source-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  register.mockClear()
})

function ingress(requestId: string, sessionId: string): IngressEnvelope {
  return {
    schemaVersion: 1,
    requestId,
    sessionId,
    rawText: "",
    normalizedText: "",
    origin: "user",
    querySource: "chat",
    priority: "now",
    taint: "trusted_user",
    receivedAt: 1_700_000_000_000,
  }
}

/**
 * 两条同前缀消息的正文：前 4000 字符逐字相同，只有证据窗口之后的内容不同。
 * 前 4000 字符恰好等于证据上限，因此「证据片段逐字相同」可直接断言。
 */
function twinText(tail: "甲" | "乙"): string {
  const prefix = "甲".repeat(EVIDENCE_CHARS)
  return `${prefix}${tail.repeat(MESSAGE_CHARS - EVIDENCE_CHARS)}`
}

describe("记忆来源收集（超过 5 MiB 的真实会话）", () => {
  it("越过 5 MiB 的尾部消息仍登记全文：证据有界、哈希对全文计算 [memory-source-large-session-jsonl]", async () => {
    const session = await createPiSession("超过 5 MiB 的来源会话")
    const texts = [
      twinText("甲"),
      twinText("乙"),
      ...Array.from({ length: MESSAGE_COUNT - 2 }, (_value, index) => `第 ${index + 2} 条陈述：${"乙".repeat(MESSAGE_CHARS)}`),
    ]
    const eventIds: string[] = []
    try {
      const handle = await acquirePiSession(session.id)
      const branch = (await handle.branch(PI_LANE, BACKGROUND_CONTEXT))
        ?? (await handle.createBranch(PI_LANE, null, BACKGROUND_CONTEXT))
      for (let index = 0; index < texts.length; index += 1) {
        const eventId = `large-${session.id}:${index}:user`
        eventIds.push(eventId)
        await branch.appendMessage(
          userInputMessage(texts[index]!, eventId, inputSourceMark(ingress(`large-${index}`, session.id), "v1rtual")),
          BACKGROUND_CONTEXT,
        )
      }
    } finally {
      await releasePiSession(session.id)
    }

    // 夹具自检：会话文件必须真的越过工具面写上限，否则本用例失去区分力。
    const metadata = (await listPiSessionMetadata()).find(item => item.id === session.id)
    expect(metadata, "真实会话的元数据缺失").toBeDefined()
    const fileBytes = statSync(metadata!.path).size
    expect(
      fileBytes,
      `会话文件 ${fileBytes} B 未超过 MAX_TOOL_FILE_BYTES（${MAX_TOOL_FILE_BYTES} B）：本用例失去区分力`,
    ).toBeGreaterThan(MAX_TOOL_FILE_BYTES)

    const sources = await collectMemorySources(session.id)

    // 越过大文件边界的尾部消息也在结果里：按 5 MiB 截断读路径会让它整条消失。
    expect(sources.map(source => source.eventId), "登记来源与投递身份/顺序不一致").toEqual(eventIds)
    expect(sources.map(source => source.sourceLength), "来源全文长度不是完整正文长度").toEqual(texts.map(text => text.length))
    expect(sources[sources.length - 1]!.sourceLength, "尾部消息的全文长度被截断").toBeGreaterThan(MESSAGE_CHARS)

    // 证据有界：登记片段最多 4000 字符，且逐字取自正文开头。
    for (let index = 0; index < sources.length; index += 1) {
      expect(sources[index]!.evidence, `第 ${index} 条证据片段与正文开头不一致`).toBe(texts[index]!.slice(0, EVIDENCE_CHARS))
      expect(sources[index]!.evidence!.length, `第 ${index} 条证据片段超过 ${EVIDENCE_CHARS} 字符`).toBe(EVIDENCE_CHARS)
    }

    // 全文哈希：前 4000 字符相同的两条消息证据逐字相同，但必须是两个来源版本。
    expect(sources[0]!.evidence, "同前缀夹具本身失效：证据片段不同").toBe(sources[1]!.evidence)
    expect(
      sources[0]!.contentHash,
      "内容 hash 对截断证据计算：证据窗口之外的差异被吞掉，两条消息并成了同一来源",
    ).not.toBe(sources[1]!.contentHash)

    // 收集结果原样送进登记边界（Rust 侧只收这两类准入来源）。
    expect(register, "收集结果没有送进登记边界").toHaveBeenCalledTimes(1)
    const registered = register.mock.calls[0]![0] as Array<{ sourceId: string; sourceLength?: number }>
    expect(registered.map(source => source.sourceId), "登记边界收到的来源与收集结果不一致").toEqual(sources.map(source => source.sourceId))
    expect(registered[registered.length - 1]!.sourceLength, "登记边界收到的尾部来源长度被截断").toBe(texts[texts.length - 1]!.length)
  })
})
