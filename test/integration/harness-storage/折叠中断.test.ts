// ==========================================
// 折叠中断（T5.08 / 源方案 S-5）—— 从 test/e2e/scenes/harness-storage/折叠中断.scene.ts 迁到 L3（W2）
//
// 故障注入：折叠在「发布点」失败不得损坏文件、不得丢状态。
//
// 被测实现：`engine/pi/session-fold.ts` 的 `foldSessionFile`（经 `PiSessionRepo.foldSession`）。
// 它的替换顺序是写死的：闸门 1（stat）→ 尺寸守卫 → 读全文 → 白名单判定 → 闸门 2（回收量）
// → S-1 两侧重放摘要比对 → **写同目录临时文件** → `renameFile` 覆盖。任何一步失败都保留原文件、
// 返回结构化 `skipped`，绝不抛错。
//
// 注入的两步（本用例的全部注入点都在**测试内**，生产代码一行不动）：
//   ① `renameFile` 恒失败（`RenameFailsEnv`）—— 「发布点」失败；
//   ② 临时文件的 `writeFile` 恒失败（`TempWriteFailsEnv`）—— 发布前的最后一次写盘失败。
//
// 为什么这两步才是「会坏文件」的关键点（而不是读失败、判定失败）：
//   · 在发布点之前失败，盘上**什么都没发生**——原文件没被碰过，最坏结论只是「这次没折叠」。
//   · `rename` 是全程**唯一**的发布动作（FileSystem 契约：replace destination when it exists），
//     没有第三种中间态 —— 因此「进程在折叠中途死亡」在可确定性复现的意义上等价于「rename 失败」。
//
// 断言口径：原文件**逐字未变**（重新读盘比 UTF-8 字节相等，不是比长度）、折叠返回
// **结构化 skipped/write-failed**（不是抛错）、其后仍能**正常 open 并读回**（条目、会话名）。
//
// 迁移时的审视修正（对应契约「审计线索」的复核结论）：
//   · :373（D3）原 check 2 只调 `repo.open()`，没有复核兜底折叠是否真的发生 —— 「open 前
//     不再兜底折叠」的实现照样全绿。迁移后断言 `renameAttempts` 在 open 期间 +1，证明
//     `maybeFoldBeforeOpen` 真的撞上了注入点。
//   · :336（D10）原 check 1 在「原文件逐字未变」之后又调了一次 `assertFoldableFixture(after)`：
//     after === pristine 已断言、pristine 的可折叠性也已断言，这一条不可能独立失败 —— 删除。
//   · :351（D4）原摘要比对两侧都过同一对函数，且 `folded.kind === "folded"` 已蕴含折叠器
//     内部做过同样的比对。迁移后保留比对并补一条有区分力的交叉证据：驱动报告给调用方的
//     `digest` 必须等于测试从**盘上字节**重算的摘要（写盘内容 ≠ 被校验内容时才会红）。
//
// 不调用任何定时器 API。**未覆盖（登记）**：进程死在「临时文件已写、rename 未执行」之间留下的
// `.tmp-*` 残留不参与会话列举、也不阻断 open —— 当前实现没有残留回收，只钉后果。
// L3：IPC 由 test/host/node-ipc.ts 顶替（真实 Rust 命令的 Node 等价实现）；仓库/折叠路径同一份产品代码。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT, err, FileError } from "@earendil-works/pi-agent-core"
import type { Context, JsonlSessionMetadata, Result, Session } from "@earendil-works/pi-agent-core"
import { pendingAssistantFrames } from "@earendil-works/pi-agent-core/harness/session"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { formatError } from "@/services/error"
import {
  createPiSessionRepo,
  FOLD_POLICY,
  flushSessionFrameWrites,
  logStateDigest,
  prepareFold,
  readFoldLog,
} from "@/services/engine/pi"
import type { FoldOutcome, PiSessionRepo } from "@/services/engine/pi"
import { initPaths, runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"

type JsonlSession = Session<JsonlSessionMetadata>

const BRANCH = "fold-crash"
const CUSTOM_TYPE = "deskpet.fold_crash.entry"
const SESSION_NAME = "折叠中断夹具"
const OP_ID = "op-fold-crash"
const RESP_ID = "resp-fold-crash"

/** 折叠临时文件名的标记（`session-fold.ts` 的 `tempPathFor`：`${path}.tmp-<base36 时间>-<随机>`）。 */
const TEMP_MARK = ".tmp-"

/** 单帧填充长度：夹具形状参数（不是阈值副本）。8 KiB 让 600 KiB 量级的夹具只需约 80 次提交。 */
const FRAME_PAD = 8 * 1024

/**
 * 帧条数由闸门 1 推导：帧总量取 `minFileBytes` 的 1.25 倍 —— 文件必然过闸门 1，且可回收量
 * （≈ 全部帧行）远高于 `minReclaimBytes` 与 `minReclaimRatio`。策略常量上调时夹具随之变大。
 */
const FRAME_COUNT = Math.ceil((FOLD_POLICY.minFileBytes * 1.25) / FRAME_PAD)

/** 真实提交写入的自定义条目数（折叠一行都不动的那部分状态）。 */
const ENTRY_COUNT = 4

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-harness-foldcrash-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 解包 Result（夹具解码器，不是断言）：失败时先经 expect 记一条带错误码的失败，再中止本用例。 */
function expectOk<T>(result: Result<T, FileError>, label: string): T {
  expect(result.ok, `${label}: ${result.ok ? "" : `${result.error.code}: ${result.error.message}`}`).toBe(true)
  if (!result.ok) throw new Error(`${label}: ${result.error.message}`)
  return result.value
}

function frameDelta(index: number): string {
  return `帧-${index}-${"x".repeat(FRAME_PAD)}`
}

// ── 故障注入（只在测试内定义；生产代码不加注入点、不加开关）──

/**
 * 注入点 ①：`renameFile` 恒失败 —— 折叠的**发布点**失败，是「崩溃」的可确定性等价形态。
 *
 * 覆盖的是 `TauriExecutionEnv` 的普通原型方法：其余读写全部照旧走真实 IPC，
 * 所以「原文件逐字未变」的结论仍然是关于真实磁盘的结论。注入实例经
 * `createPiSessionRepo({ fileSystem })` 传入 ⇒ 会被帧缓冲装饰器包住
 * （装饰器的 renameFile 是「先冲同路径缓冲再转发」，注入照常触发）。
 */
class RenameFailsEnv extends TauriExecutionEnv {
  renameAttempts = 0
  lastDestination: string | undefined

  override async renameFile(sourcePath: string, destinationPath: string, _context: Context): Promise<Result<void, FileError>> {
    this.renameAttempts += 1
    this.lastDestination = destinationPath
    return err(new FileError("unknown", "注入故障：rename 失败", sourcePath))
  }
}

/**
 * 注入点 ②：临时文件（`.tmp-` 前缀）的 `writeFile` 恒失败 —— 发布前的最后一次写盘失败。
 * 同时记下每一次 `writeFile` 的目标路径：用来断言失败路径上没有任何一次写落在会话文件本身。
 */
class TempWriteFailsEnv extends TauriExecutionEnv {
  tempWriteAttempts = 0
  readonly writePaths: string[] = []

  override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    this.writePaths.push(path)
    if (path.includes(TEMP_MARK)) {
      this.tempWriteAttempts += 1
      return err(new FileError("unknown", "注入故障：临时文件写入失败", path))
    }
    return super.writeFile(path, content, context)
  }
}

// ── 夹具 ──

interface FoldCrashFixture {
  /** 未包装的 env：直读磁盘，绕过装饰器（也就绕过读前 flush）。 */
  plain: TauriExecutionEnv
  root: string
  path: string
  sessionDir: string
  metadata: JsonlSessionMetadata
  /** 夹具的原始正文：每个 check 开头写回它，让各 check 互不影响。 */
  pristine: string
  /** 真实提交写入的自定义条目 id，按写入顺序。 */
  entryIds: string[]
}

/**
 * 夹具：临时根 + 真实仓库/会话提交（自定义条目 + 若干真实帧 append + 一条帧 list/delete）。
 *
 * 为什么帧走 `session.appendList(pendingAssistantFrames(...))` 而不是手拼 JSON 行：`seq` 由
 * 提交时分配、open 时校验，手拼会绕过分配与校验，落盘字节与真实帧不同形。帧的 `list/delete`
 * 让前面全部 append 变成「确定可丢」的行 —— 折叠的回收量就来自它们，而真实条目行一个都不该被动。
 * 夹具的**作者**是正常 env（建会话本身要走 write+rename 发布），注入只发生在折叠那一次调用上。
 */
async function buildFixture(): Promise<FoldCrashFixture> {
  const context = BACKGROUND_CONTEXT
  const plain = new TauriExecutionEnv(await runtimePath("data"))
  const root = expectOk(await plain.createTempDir("deskpet-live-foldcrash-", context), "createTempDir")
  const repo = await createPiSessionRepo({ sessionsRoot: root, cwd: root })
  const session: JsonlSession = await repo.create({ id: "fold-crash" }, context)
  const entryIds: string[] = []
  let metadata: JsonlSessionMetadata | undefined
  try {
    await session.createBranch(BRANCH, null, context)
    const branch = await session.branch(BRANCH, context)
    expect(branch, `夹具分支创建后取不到: ${BRANCH}`).toBeDefined()
    for (let index = 0; index < ENTRY_COUNT; index++) {
      // 走 Branch 的公开入口（内部是真实提交：entry 行 + branch.tip 的 value/set 行）。
      entryIds.push(await branch!.appendCustomEntry(CUSTOM_TYPE, { index }, context))
    }
    const frames = pendingAssistantFrames(OP_ID, RESP_ID)
    for (let index = 0; index < FRAME_COUNT; index++) {
      await session.appendList(frames, { type: "thinking_delta", contentIndex: 0, delta: frameDelta(index) }, context)
    }
    // 最后一次 delete：上面全部 append 因此成为「确定可丢」的行（只丢最后一次 delete 之前的写）。
    await session.deleteList(frames, context)
    await session.setName(SESSION_NAME, context)
    metadata = session.metadata
  } finally {
    await session.close(context)
    // 句柄关闭不主动排水：帧还在装饰器缓冲里时直接读盘只会读到半截文件。
    await flushSessionFrameWrites(context)
    await repo.close(context)
  }
  expect(metadata, "夹具会话没有 metadata").toBeDefined()
  const path = metadata!.path
  // 原始正文在所有写入者退场之后取：它是每个 check「逐字未变」的比对基准。
  const pristine = expectOk(await plain.readTextFile(path, context), "readTextFile(pristine)")
  return {
    plain,
    root,
    path,
    sessionDir: path.slice(0, path.lastIndexOf("/")),
    metadata: metadata!,
    pristine,
    entryIds,
  }
}

async function disposeFixture(target: FoldCrashFixture): Promise<void> {
  const context = BACKGROUND_CONTEXT
  await flushSessionFrameWrites(context)
  // remove 的失败不抛（FileSystem 契约以 Result 返回）：收尾失败不改断言结论，最坏只是系统 temp
  // 下留一份垃圾，不在这里另起一层错误处理。
  await target.plain.remove(target.root, { recursive: true, force: true }, context)
}

/** 还原夹具正文：每个 check 从同一份原始字节开始，注入结论不依赖 check 的执行顺序。 */
async function restorePristine(target: FoldCrashFixture, label: string): Promise<void> {
  expectOk(await target.plain.writeFile(target.path, target.pristine, BACKGROUND_CONTEXT), `${label}: 还原夹具正文`)
  expect(await readSessionText(target), `${label}: 夹具正文还原失败，后续断言不可信`).toBe(target.pristine)
}

async function readSessionText(target: FoldCrashFixture): Promise<string> {
  return expectOk(await target.plain.readTextFile(target.path, BACKGROUND_CONTEXT), "readTextFile")
}

/**
 * 前置断言：夹具必须真的会走到发布点 —— 用生产纯函数与生产策略常量复核闸门 1/2 都会放行，
 * 且可丢写入数正好等于帧数（可回收量全部来自帧行，真实条目一行不动）。
 * 少了这条，「文件太小根本没折叠」会让注入的失败假通过。
 */
function expectFoldableFixture(text: string, label: string): void {
  const plan = prepareFold(readFoldLog(text))
  expect(plan.kind, `${label}: 夹具不可折叠（${plan.kind === "skip" ? plan.reason : "?"}），注入点无从触达`).toBe("fold")
  if (plan.kind !== "fold") throw new Error(`${label}: 夹具不可折叠`)
  expect(plan.bytesBefore, `${label}: 夹具未过闸门 1`).toBeGreaterThan(FOLD_POLICY.minFileBytes)
  const reclaimed = plan.bytesBefore - plan.bytesAfter
  expect(reclaimed, `${label}: 可回收量未过闸门 2（绝对值）`).toBeGreaterThanOrEqual(FOLD_POLICY.minReclaimBytes)
  expect(reclaimed, `${label}: 可回收量未过闸门 2b（比例）`).toBeGreaterThanOrEqual(plan.bytesBefore * FOLD_POLICY.minReclaimRatio)
  expect(plan.droppedWrites, `${label}: 可丢写入数应等于帧数（夹具形状变了）`).toBe(FRAME_COUNT)
}

/**
 * 折叠失败面的执行契约：不抛错、返回结构化 `skipped/write-failed`。
 * 抛错会被单独指名（调用方不得把「抛错」当成失败路径的合法形态）。
 */
async function foldExpectingWriteFailed(
  repo: PiSessionRepo,
  metadata: JsonlSessionMetadata,
  label: string,
): Promise<void> {
  const settled = await repo.foldSession(metadata, BACKGROUND_CONTEXT).then(
    (value: FoldOutcome) => ({ thrown: false as const, value }),
    (error: unknown) => ({ thrown: true as const, error }),
  )
  expect(
    settled.thrown,
    `${label}: 折叠失败路径抛错了（契约要求返回 skipped，不抛）: ${settled.thrown ? formatError(settled.error) : ""}`,
  ).toBe(false)
  if (settled.thrown) throw new Error(`${label}: 折叠失败路径抛错`)
  expect(settled.value.kind, `${label}: 期望结构化 skipped，实际 ${settled.value.kind}`).toBe("skipped")
  if (settled.value.kind !== "skipped") throw new Error(`${label}: 期望结构化 skipped`)
  expect(settled.value.reason, `${label}: 期望 skipped/write-failed`).toBe("write-failed")
}

/** 失败路径必须清掉本次自己写的临时文件（`discardTempFile`）：给下一次折叠留个干净的同目录。 */
async function assertNoTempResidue(target: FoldCrashFixture, label: string): Promise<void> {
  const listing = expectOk(await target.plain.listDir(target.sessionDir, BACKGROUND_CONTEXT), "listDir(sessionDir)")
  const residue = listing.filter(item => item.name.includes(TEMP_MARK))
  expect(residue.map(item => item.path), `${label}: 失败路径留下了临时文件`).toEqual([])
}

describe("折叠中断", () => {
  it("折叠在 rename / 临时文件写入失败时中止：原文件逐字完好、临时文件被清理、会话仍可打开；残留的 .tmp 文件不参与会话列举 [harness-session-log-fold-crash]", async () => {
    const context = BACKGROUND_CONTEXT
    const target = await buildFixture()
    try {
      // ── ① S-5 主形态：发布点（rename）失败 ──
      await restorePristine(target, "rename 注入")
      expectFoldableFixture(target.pristine, "rename 注入")

      {
        const env = new RenameFailsEnv(await runtimePath("data"))
        const repo = await createPiSessionRepo({ sessionsRoot: target.root, cwd: target.root, fileSystem: env })
        try {
          await foldExpectingWriteFailed(repo, target.metadata, "rename 注入")
          // rename 是唯一的发布动作：恰好一次，且目标就是这个会话文件。
          expect(env.renameAttempts, "rename 是唯一发布点，应恰好调用 1 次").toBe(1)
          expect(env.lastDestination, "rename 的目标应是会话文件").toBe(target.path)

          expect(await readSessionText(target), "折叠中断（rename 失败）后原文件被改动了").toBe(target.pristine)
          await assertNoTempResidue(target, "rename 注入")
        } finally {
          await repo.close(BACKGROUND_CONTEXT)
        }
      }

      // 正面证据（不丢状态）：中断之后同一个文件仍必须能被正常折叠，且折叠前后重放摘要一致。
      {
        const healthy = await createPiSessionRepo({
          sessionsRoot: target.root,
          cwd: target.root,
          fileSystem: new TauriExecutionEnv(await runtimePath("data")),
        })
        try {
          const folded = await healthy.foldSession(target.metadata, BACKGROUND_CONTEXT)
          expect(folded.kind, `中断之后同一个文件无法再被折叠: ${folded.kind === "skipped" ? folded.reason : ""}`).toBe("folded")
          const digestBefore = await logStateDigest(readFoldLog(target.pristine))
          const digestAfter = await logStateDigest(readFoldLog(await readSessionText(target)))
          expect(digestAfter, "中断后再折叠改变了逻辑状态").toBe(digestBefore)
          // 交叉证据（迁移时补，见文件头的 :351 复核结论）：驱动报告给调用方的摘要必须等于测试
          // 从**盘上字节**独立重算的摘要 —— 写盘内容与被校验内容不一致时才会红。
          if (folded.kind === "folded") expect(folded.digest, "驱动报告的摘要与盘上重算的不一致").toBe(digestAfter)
        } finally {
          await healthy.close(BACKGROUND_CONTEXT)
        }
      }

      // ── ② S-5 的「会话仍可正常打开」：open 前的兜底折叠同样撞上注入点 ──
      await restorePristine(target, "open 读回")
      {
        const env = new RenameFailsEnv(await runtimePath("data"))
        const repo = await createPiSessionRepo({ sessionsRoot: target.root, cwd: target.root, fileSystem: env })
        try {
          await foldExpectingWriteFailed(repo, target.metadata, "open 读回")
          expect(env.renameAttempts, "显式折叠恰好触发一次 rename 尝试").toBe(1)
          const session = await repo.open(target.metadata, BACKGROUND_CONTEXT)
          // 兜底折叠（maybeFoldBeforeOpen：文件仍 > minFileBytes）必须真的发生并撞上注入点：
          // 只断言 open 成功与读回一致的话，「open 前不再兜底折叠」的实现照样全绿（原 :373 的 D3）。
          expect(env.renameAttempts, "open 的兜底折叠应再撞一次注入点（renameAttempts 1 → 2）").toBe(2)
          try {
            const entries = await session.findEntries({ customType: CUSTOM_TYPE }, context)
            const ids = entries.map(entry => entry.id)
            // findEntries 不保证顺序（默认 newestFirst）—— 判的是「一条不少、一条不多」的集合相等。
            expect(
              [...ids].sort(),
              `折叠中断后条目读回不一致: 期望 ${JSON.stringify(target.entryIds)}，实际 ${JSON.stringify(ids)}`,
            ).toEqual([...target.entryIds].sort())
            expect(await session.getName(context), "折叠中断后会话名丢失").toBe(SESSION_NAME)
          } finally {
            await session.close(context)
          }
          expect(await readSessionText(target), "打开会话的过程中原文件被改动了").toBe(target.pristine)
        } finally {
          await repo.close(BACKGROUND_CONTEXT)
        }
      }

      // ── ③ S-5 第二形态：临时文件写入失败（发布前的最后一次写盘失败）──
      await restorePristine(target, "临时文件写入注入")
      expectFoldableFixture(target.pristine, "临时文件写入注入")
      {
        const env = new TempWriteFailsEnv(await runtimePath("data"))
        const repo = await createPiSessionRepo({ sessionsRoot: target.root, cwd: target.root, fileSystem: env })
        try {
          await foldExpectingWriteFailed(repo, target.metadata, "临时文件写入注入")
          expect(env.tempWriteAttempts, "临时文件只应写一次").toBe(1)
          // 结构证据：失败路径上没有任何一次写入落在会话文件本身 —— 不存在「直接覆盖原文件」的写法。
          expect(env.writePaths.includes(target.path), `折叠在失败路径上写了会话文件本身: ${JSON.stringify(env.writePaths)}`).toBe(false)
          expect(await readSessionText(target), "折叠中断（临时文件写入失败）后原文件被改动了").toBe(target.pristine)
          await assertNoTempResidue(target, "临时文件写入注入")
        } finally {
          await repo.close(BACKGROUND_CONTEXT)
        }
      }

      // ── ④ 崩溃残留：`.tmp-*` 残留不参与会话列举、也不阻断 open（回收缺口见文件头登记）──
      {
        const env = new TauriExecutionEnv(await runtimePath("data"))
        const root = expectOk(await env.createTempDir("deskpet-live-foldcrash-residue-", context), "createTempDir")
        const repo = await createPiSessionRepo({ sessionsRoot: root, cwd: root, fileSystem: env })
        try {
          const session = await repo.create({ id: "fold-crash-residue" }, context)
          let metadata: JsonlSessionMetadata | undefined
          try {
            await session.createBranch(BRANCH, null, context)
            const branch = await session.branch(BRANCH, context)
            expect(branch, `残留夹具分支取不到: ${BRANCH}`).toBeDefined()
            await branch!.appendCustomEntry(CUSTOM_TYPE, { index: 0 }, context)
            metadata = session.metadata
          } finally {
            await session.close(context)
          }
          expect(metadata, "残留夹具会话没有 metadata").toBeDefined()
          const resolved = metadata as JsonlSessionMetadata
          // 手工造一条崩溃残留：名字与折叠的临时路径同形，但绝不是会话文件。
          expectOk(await env.writeFile(`${resolved.path}${TEMP_MARK}1234567890`, "崩溃残留", context), "writeFile(残留)")

          const listed = await repo.list(undefined, context)
          const ids = listed.map(item => item.id)
          expect(ids, `残留存在时正常会话从列表里消失: ${JSON.stringify(ids)}`).toContain("fold-crash-residue")
          expect(listed.some(item => item.path.includes(TEMP_MARK)), `残留文件被当成了会话: ${JSON.stringify(listed.map(item => item.path))}`).toBe(false)

          const reopened = await repo.open(resolved, context)
          try {
            const entries = await reopened.findEntries({ customType: CUSTOM_TYPE }, context)
            expect(entries.length, "残留存在时 open 读不回条目").toBe(1)
          } finally {
            await reopened.close(context)
          }
        } finally {
          await repo.close(context)
          await env.remove(root, { recursive: true, force: true }, context)
        }
      }
    } finally {
      await disposeFixture(target)
    }
  })
})
