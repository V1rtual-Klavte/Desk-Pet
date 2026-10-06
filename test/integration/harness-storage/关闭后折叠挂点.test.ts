// ==========================================
// 关闭后折叠挂点 —— `releasePiSession` 的真实 release 路径触发折叠与失败兜底
//
// 被测挂点（`src/services/session/repo.ts` 的 `releasePiSession`，T5.04 的回收主路径）：
//   句柄 close → 冲帧缓冲（T-6）→ **整体之后**折叠（T5.04）。顺序不可反：折叠的读写会命中
//   帧缓冲装饰器的「同路径先 flush」规则，先 flush 填满文件、再折叠回收；失败只留痕，
//   绝不让释放抛出。挂点与 hs-07 描述里「未由本点场景断言」的两处之一对应 —— 本文件是
//   它的直接出口（现有折叠用例直接驱动 `repo.foldSession`，或只在 open 前兜底里撞到它）。
//
// 两条用例：
//   ① [harness-session-fold-close-path] 真折叠：会话层创建 + 真帧写入（缓冲里还有尾巴）
//      + list/delete 造出可回收量，**只**调 `releasePiSession` —— 不手动 flush、不手动
//      foldSession。断言：释放后全部帧行（含最后写进缓冲的那批）都被回收、真实条目逐字保留、
//      文件变小、重新打开重放读回一致。丢挂点（不调折叠）或闸门/回收规则被改坏时帧行都会
//      留在盘上，断言即红；`await release` 之后才读盘，顺带钉住「释放等待折叠收口」
//      （提前返回的异步折叠在读取时刻往往还没改写完，同样是帧行仍在）。「先 flush 再折叠」
//      的顺序证据由 帧写缓冲.test.ts 的 ④（受控 Promise 卡住 foldSession、断言 release 未完成）
//      承担，这里只要求可观察结果：连缓冲尾巴也必须被回收。
//   ② [harness-session-fold-close-failure] 失败兜底：注入 rename（发布点）失败 —— 折叠
//      返回结构化 skipped、释放照常完成、原文件**逐字未变**、统一留痕带出「原文件逐字完好」；
//      故障解除后会话照常打开、追加、读回，且下一次真实入口（open 前兜底）把死行回收掉。
//
// 注入设施与折叠链既有用例同型（FileSystem 故障注入，生产代码一行不动）：① 的夹具把
// 「写入者退场」交给 release 自己完成，不手动 flush；② 用 `vi.spyOn(NativeExecutionEnv
// .prototype, "renameFile")` 注入（会话层的仓库单例在 `getPiSessionRepo()` 内自建
// FileSystem，没有构造注入缝；原型级注入与折叠链的子类注入等价，其余 I/O 全走真实命令）。
//
// L3：IPC 由 test/host/node-ipc.ts 顶替（真实 Rust 命令的 Node 等价实现）；会话/折叠路径
// 同一份产品代码。**未运行**：按实施期纪律只写不跑，断言对错留验收环节。
// ==========================================

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT, err, FileError } from "@earendil-works/pi-agent-core"
import type { Context, Result } from "@earendil-works/pi-agent-core"
import { pendingAssistantFrames } from "@earendil-works/pi-agent-core/harness/session"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { NodeHostBridge } from "../../host/node-host-bridge"
import { setTestDataRoot } from "../../host/node-ipc"
import { initConfig } from "@/services/config"
import { setHostBridge } from "@/services/host"
import { FOLD_POLICY } from "@/services/engine/harness"
import { initPaths } from "@/services/paths"
import {
  PI_LANE,
  acquirePiSession,
  createPiSession,
  initSessions,
  persistPiSessionName,
  readPiSessionEntriesOnce,
  releasePiSession,
  resetPiSessionLayerForTest,
} from "@/services/session"
import { NativeExecutionEnv } from "@/services/tool/pi/native-execution-env"

/** 最小合法 CONFIG（四根齐全）：与 会话活动时间.test.ts 同款，只影响本文件要走的路径。 */
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

const BRANCH = "fold-release"
const CUSTOM_TYPE = "deskpet.fold_release.entry"
const OP = "op-fold-release"
const RESP = "resp-fold-release"

/**
 * 单帧填充长度：夹具形状参数（不是阈值副本）。8 KiB 让夹具只写约 80 帧就跨过闸门 1；
 * 帧缓冲的 16 KiB 阈值会把同键 delta 两两合并成行，缓冲尾巴里最多留一帧。
 */
const FRAME_PAD = 8 * 1024
/** 帧条数由闸门 1 推导（同 折叠中断.test.ts 的口径）：文件必然过 minFileBytes 且可回收量充足。 */
const FRAME_COUNT = Math.ceil((FOLD_POLICY.minFileBytes * 1.25) / FRAME_PAD)

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-fold-release-"))
  setTestDataRoot(root)
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  await initPaths()
  await initConfig()
  setHostBridge(new NodeHostBridge())
  await initSessions()
}, 30_000)

afterEach(async () => {
  await resetPiSessionLayerForTest()
  vi.restoreAllMocks()
})

afterAll(() => {
  setHostBridge(null)
  if (root) rmSync(root, { recursive: true, force: true })
})

function frameDelta(index: number): string {
  return `帧-${index}-${"x".repeat(FRAME_PAD)}`
}

/** 造一份「帧 + 真条目」的可折叠夹具：写入者（会话句柄）保持打开，交还给 release 关闭。 */
async function buildFramedFixture(): Promise<{ sessionId: string; path: string; entryIds: string[] }> {
  const created = await createPiSession("关闭后折叠挂点")
  const session = await acquirePiSession(created.id)
  await session.createBranch(BRANCH, null, BACKGROUND_CONTEXT)
  const branch = await session.branch(BRANCH, BACKGROUND_CONTEXT)
  expect(branch, `夹具分支创建后取不到: ${BRANCH}`).toBeDefined()
  const entryIds = [
    await branch!.appendCustomEntry(CUSTOM_TYPE, { index: 0 }, BACKGROUND_CONTEXT),
    await branch!.appendCustomEntry(CUSTOM_TYPE, { index: 1 }, BACKGROUND_CONTEXT),
  ]
  const frames = pendingAssistantFrames(OP, RESP)
  for (let index = 0; index < FRAME_COUNT; index++) {
    await session.appendList(frames, { type: "thinking_delta", contentIndex: 0, delta: frameDelta(index) }, BACKGROUND_CONTEXT)
  }
  // 最后一次 delete：上面全部 append 因此成为「确定可丢」的行，折叠的回收量就来自它们。
  await session.deleteList(frames, BACKGROUND_CONTEXT)
  return { sessionId: created.id, path: created.path, entryIds }
}

describe("关闭后折叠挂点（releasePiSession 的真实 release 路径）", () => {
  it("release 关闭后真折叠：缓冲里的帧先落盘再被回收、真条目逐字保留、重开重放读回一致 [harness-session-fold-close-path]", async () => {
    const fixture = await buildFramedFixture()

    // ── 前置：文件已跨过闸门 1，且仍有帧留在缓冲里（不手动 flush —— 那是 release 的活）──
    const sizeBefore = statSync(fixture.path).size
    expect(sizeBefore, `夹具必须跨过折叠闸门 1（${FOLD_POLICY.minFileBytes} B），实际 ${sizeBefore} B`).toBeGreaterThan(FOLD_POLICY.minFileBytes)
    const beforeText = readFileSync(fixture.path, "utf8")
    expect(beforeText.includes(frameDelta(0)), "前置：帧应已有部分落盘（缓冲只留尾巴）").toBe(true)

    // ── 触发：只调生产释放入口（close → flush → fold 全在 releasePiSession 内）──
    await expect(releasePiSession(fixture.sessionId), "release 不得把折叠失败抛给调用方").resolves.toBeUndefined()

    // ── ① 折叠真的发生：全部帧行（含释放前只在缓冲里的尾巴）都不在了、文件变小 ──
    const afterText = readFileSync(fixture.path, "utf8")
    for (let index = 0; index < FRAME_COUNT; index++) {
      expect(afterText.includes(frameDelta(index)), `可回收帧行仍在折叠结果里（第 ${index} 帧）`).toBe(false)
    }
    const sizeAfter = statSync(fixture.path).size
    expect(sizeAfter, `释放后文件没有变小：${sizeBefore} → ${sizeAfter}`).toBeLessThan(sizeBefore)

    // ── ② 真条目逐字保留（折叠只删整行，entry 行一个不动）──
    for (const entryId of fixture.entryIds) {
      expect(afterText.includes(entryId), `折叠改动了保留条目：${entryId} 的行不在折叠结果里`).toBe(true)
    }

    // ── ③ 重新打开重放读回一致（上游 open 恰好是「折叠后文件仍合法」的正面确认）──
    const entries = await readPiSessionEntriesOnce(fixture.sessionId, { order: "asc" })
    for (const entryId of fixture.entryIds) {
      const entry = entries.find(item => item.id === entryId)
      expect(entry, `重开后读不回条目 ${entryId}（折叠结果不可重放）`).toBeDefined()
      expect(entry?.type, `条目类型在折叠后变化：${entryId}`).toBe("custom")
    }
  }, 60_000)

  it("release 折叠失败只留痕：rename 注入失败后释放照常完成、原文件逐字未变，故障解除后会话照常可用 [harness-session-fold-close-failure]", async () => {
    const created = await createPiSession("关闭后折叠挂点-失败注入")
    // 夹具用非帧写入（value/set 立即落盘，不进缓冲），因此「释放前快照」就是完整盘上内容，
    // 可以逐字比对；大门牌值随后 delete，让最后一次 set 行成为确定可回收的行。
    const bigName = "折".repeat(300_000)
    expect(await persistPiSessionName(created.id, bigName), "大门牌值没有落盘成功（夹具不成立）").toBe(true)
    const session = await acquirePiSession(created.id)
    await session.setName(undefined, BACKGROUND_CONTEXT)

    const sizeBefore = statSync(created.path).size
    expect(sizeBefore, `夹具必须跨过折叠闸门 1（${FOLD_POLICY.minFileBytes} B），实际 ${sizeBefore} B`).toBeGreaterThan(FOLD_POLICY.minFileBytes)
    const snapshot = readFileSync(created.path, "utf8")
    expect(snapshot.includes("折折折"), "前置：死 set 行应在盘上（可回收量来源）").toBe(true)

    // ── 注入发布点失败：只在注入开启期间把 renameFile 换成结构化失败 ──
    const realRenameFile = NativeExecutionEnv.prototype.renameFile
    const renameAttempts: string[] = []
    let armed = true
    vi.spyOn(NativeExecutionEnv.prototype, "renameFile").mockImplementation(async function (
      this: NativeExecutionEnv, sourcePath: string, destinationPath: string, context: Context,
    ): Promise<Result<void, FileError>> {
      renameAttempts.push(destinationPath)
      if (armed) return err(new FileError("unknown", "注入故障：rename 失败", sourcePath))
      return realRenameFile.call(this, sourcePath, destinationPath, context)
    })

    const warnSpy = vi.spyOn(console, "warn")
    try {
      await expect(releasePiSession(created.id), "折叠失败不得破坏释放语义（release 必须 resolve）").resolves.toBeUndefined()
    } finally {
      armed = false
    }

    // ① 折叠确实被触发过，且是在 release 路径上对候选文件发起的发布动作。
    expect(renameAttempts, "release 路径没有触发折叠的发布动作（挂点漏调）").toHaveLength(1)
    expect(renameAttempts[0], "折叠的发布目标应是候选会话文件").toBe(created.path)
    // ② 失败兜底：原文件逐字未变、没有半成品。
    expect(readFileSync(created.path, "utf8"), "折叠失败改动了原文件（原子替换保证被破坏）").toBe(snapshot)
    // ③ 统一留痕：失败事实与「原文件逐字完好」出现在日志（logger 通道 PiSession/Fold）。
    const warnLines = warnSpy.mock.calls.map(args => args.map(String).join(" "))
    expect(
      warnLines.some(line => line.includes("折叠替换失败") && line.includes("原文件逐字完好")),
      `折叠失败没有统一留痕：${warnLines.filter(line => line.includes("折叠")).join(" | ")}`,
    ).toBe(true)
    warnSpy.mockRestore()

    // ④ 恢复路径：故障解除后会话照常打开（open 前兜底完成上次未成的折叠）、还能继续写入。
    const reopened = await acquirePiSession(created.id)
    const afterRecovery = readFileSync(created.path, "utf8")
    expect(afterRecovery.includes("折折折"), "故障解除后的真实入口仍没有回收死行").toBe(false)
    expect(statSync(created.path).size, "恢复折叠后文件没有变小").toBeLessThan(sizeBefore)
    const branch = (await reopened.branch(PI_LANE, BACKGROUND_CONTEXT))
      ?? (await reopened.createBranch(PI_LANE, null, BACKGROUND_CONTEXT))
    const freshEntryId = await branch.appendCustomEntry(CUSTOM_TYPE, { after: "fault" }, BACKGROUND_CONTEXT)
    const entries = await readPiSessionEntriesOnce(created.id, { order: "asc" })
    expect(entries.some(entry => entry.id === freshEntryId), "故障后的会话写入读不回（释放语义被折叠失败污染）").toBe(true)
  }, 60_000)
})
