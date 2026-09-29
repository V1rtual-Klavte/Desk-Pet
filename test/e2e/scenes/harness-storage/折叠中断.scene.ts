// ==========================================
// 折叠中断场景（T5.08 / 源方案 S-5）—— 故障注入：折叠在「发布点」失败不得损坏文件、不得丢状态
//
// 被测实现：`engine/pi/session-fold.ts` 的 `foldSessionFile`（经 `PiSessionRepo.foldSession`）。
// 它的替换顺序是写死的：闸门 1（stat）→ 尺寸守卫 → 读全文 → 白名单判定 → 闸门 2（回收量）
// → S-1 两侧重放摘要比对 → **写同目录临时文件** → `renameFile` 覆盖。任何一步失败都保留原文件、
// 返回结构化 `skipped`，绝不抛错。
//
// 注入的两步（本场景的全部注入点都在**场景内**，生产代码一行不动）：
//   ① `renameFile` 恒失败（`RenameFailsEnv`）—— 「发布点」失败；
//   ② 临时文件的 `writeFile` 恒失败（`TempWriteFailsEnv`）—— 发布前的最后一次写盘失败。
//
// 为什么这两步才是「会坏文件」的关键点（而不是读失败、判定失败）：
//   · 在发布点之前失败，盘上**什么都没发生**——原文件没被碰过，最坏结论只是「这次没折叠」。
//     所以真正的风险区只在「新正文已经写到盘上（临时文件）→ 还没换上去（rename）」这一段。
//   · `rename` 是全程**唯一**的发布动作（`FileSystem.renameFile` 契约原文：Atomically rename a
//     file, replacing the destination when it exists；Rust 侧 `fs::rename` / `MoveFileExW` +
//     MOVEFILE_REPLACE_EXISTING）。rename 之前原文件的 inode 内容未被触碰；rename 成功后新正文
//     已完整发布。**没有第三种中间态** —— 因此「进程在折叠中途死亡」在可确定性复现的意义上，
//     就等价于「rename 失败」，而「临时文件写成功但 rename 失败」正是唯一一种「盘上真的多出了
//     一份没换上去的新正文」的形态：此刻若实现是直接覆盖目标文件而不是 rename，原文件已经被
//     新内容毁掉了，后续任何失败都无法恢复。
//   · ② 逆着看：临时文件写失败时，若实现改写成「直接覆盖原文件」，原文件必然已被截断 ——
//     所以这条注入同时钉住「失败路径不碰目标文件」。
//
// 断言口径：原文件**逐字未变**（重新读盘比 UTF-8 字节相等，不是比长度）、折叠返回
// **结构化 skipped/write-failed**（不是抛错）、其后仍能**正常 open 并读回**（条目、会话名）。
// 另有一条正面证据：中断之后同一个文件必须仍能被**正常折叠**，且折叠前后重放摘要一致。
//
// 夹具的规模与闸门由 `FOLD_POLICY` 常量推导（`assertFoldableFixture`）：夹具必须真的过闸门 1/2、
// 且可回收量正好等于全部帧行 —— 否则注入的失败可能只是「文件太小，折叠根本没开工」，断言会假通过。
//
// 本场景不调用任何定时器 API（验收按「定时器标识符 0 命中」核对）：缓冲与折叠的触发都不靠时间。
//
// **未覆盖（登记）**：进程若在「临时文件已写、rename 未执行」之间死亡，会留下
// `<会话>.jsonl.tmp-*` 残留；当前实现**没有**残留回收（`session-fold.ts` 只在失败路径清掉
// 本次自己写的临时文件），`expectStaleTempResidueDoesNotBreakSession` 因此只钉「残留不被当作
// 会话、也不阻断 open」，不断言「下一次折叠会清掉它」。等实现补上回收后，本场景再补该断言。
//
// `entry: "unit"`：只走真实 Rust IPC 与真实仓库/折叠路径，不跑模型。
// ==========================================

import { BACKGROUND_CONTEXT, err, FileError } from "@earendil-works/pi-agent-core"
import type { Context, JsonlSessionMetadata, Result, Session } from "@earendil-works/pi-agent-core"
import { pendingAssistantFrames } from "@earendil-works/pi-agent-core/harness/session"
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
import { runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import type { SceneDef } from "../../../e2e/types"

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

function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

function frameDelta(index: number): string {
  return `帧-${index}-${"x".repeat(FRAME_PAD)}`
}

// ── 故障注入（只在场景内定义；生产代码不加注入点、不加开关）──

/**
 * 注入点 ①：`renameFile` 恒失败 —— 折叠的**发布点**失败，是「崩溃」的可确定性等价形态
 * （见文件头：rename 是全程唯一的发布动作，没有第三种中间态）。
 *
 * 覆盖的是 `TauriExecutionEnv` 的普通原型方法：其余读写全部照旧走真实 Rust IPC，
 * 所以「原文件逐字未变」的结论仍然是关于真实磁盘的结论。注入实例经
 * `createPiSessionRepo({ fileSystem })` 传入 ⇒ 会被 W1 的帧缓冲装饰器包住
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
  /** 夹具的原始正文：每个 check 开头写回它，让各 check 互不影响、可反复重跑。 */
  pristine: string
  /** 真实提交写入的自定义条目 id，按写入顺序。 */
  entryIds: string[]
  /** 夹具所属 trial：模块级变量跨 trial 存活（同页复用），trial 变了必须重建。 */
  trial: number
}

let fixture: FoldCrashFixture | undefined

/**
 * 夹具：临时根 + 真实仓库/会话提交（自定义条目 + 若干真实帧 append + 一条帧 list/delete）。
 *
 * 为什么帧走 `session.appendList(pendingAssistantFrames(...))` 而不是手拼 JSON 行：`seq` 由
 * 提交时分配、open 时校验，手拼会绕过分配与校验，落盘字节与真实帧不同形（先例：帧写缓冲场景）。
 * 帧的 `list/delete` 让前面全部 append 变成「确定可丢」的行 —— 折叠的回收量就来自它们，
 * 而真实条目行一个都不该被动。夹具的**作者**是正常 env（建会话本身要走 write+rename 发布），
 * 注入只发生在折叠那一次调用上。
 */
async function buildFixture(trial: number): Promise<FoldCrashFixture> {
  const context = BACKGROUND_CONTEXT
  const plain = new TauriExecutionEnv(await runtimePath("data"))
  const root = fileOk(await plain.createTempDir("deskpet-live-foldcrash-", context))
  const repo = await createPiSessionRepo({ sessionsRoot: root, cwd: root })
  const session: JsonlSession = await repo.create({ id: "fold-crash" }, context)
  const entryIds: string[] = []
  let metadata: JsonlSessionMetadata | undefined
  try {
    await session.createBranch(BRANCH, null, context)
    const branch = await session.branch(BRANCH, context)
    if (branch === undefined) throw new Error(`夹具分支创建后取不到: ${BRANCH}`)
    for (let index = 0; index < ENTRY_COUNT; index++) {
      // 走 Branch 的公开入口（内部是真实提交：entry 行 + branch.tip 的 value/set 行）。
      entryIds.push(await branch.appendCustomEntry(CUSTOM_TYPE, { index }, context))
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
    // 句柄关闭不主动排水：帧还在装饰器缓冲里时直接读盘只会读到半截文件（先例：帧写缓冲的 dispose）。
    await flushSessionFrameWrites(context)
    await repo.close(context)
  }
  if (metadata === undefined) throw new Error("夹具会话没有 metadata")
  const path = metadata.path
  // 原始正文在所有写入者退场之后取：它是每个 check「逐字未变」的比对基准。
  const pristine = fileOk(await plain.readTextFile(path, context))
  return {
    plain,
    root,
    path,
    sessionDir: path.slice(0, path.lastIndexOf("/")),
    metadata,
    pristine,
    entryIds,
    trial,
  }
}

async function disposeFixture(target: FoldCrashFixture): Promise<void> {
  const context = BACKGROUND_CONTEXT
  await flushSessionFrameWrites(context)
  // remove 的失败不抛（FileSystem 契约以 Result 返回）：收尾失败不改断言结论，最坏只是系统 temp
  // 下留一份垃圾，不在这里另起一层错误处理（先例：帧写缓冲的 disposeBurst 同样只看删除动作）。
  await target.plain.remove(target.root, { recursive: true, force: true }, context)
}

async function ensureFixture(trial: number): Promise<FoldCrashFixture> {
  if (fixture !== undefined && fixture.trial === trial) return fixture
  if (fixture !== undefined) {
    // 上一 trial 的夹具（例如上一轮中途超时被放弃）：先收尾再重建，否则残留文件会串味。
    const stale = fixture
    fixture = undefined
    await disposeFixture(stale)
  }
  fixture = await buildFixture(trial)
  return fixture
}

/** 场景收尾：把跨 check 的夹具连同临时根一起放掉（下个 trial 会按需重建，不在这里重建）。 */
async function releaseFixture(): Promise<void> {
  const target = fixture
  fixture = undefined
  if (target !== undefined) await disposeFixture(target)
}

/** 还原夹具正文：每个 check 从同一份原始字节开始，注入结论不依赖 check 的执行顺序。 */
async function restorePristine(target: FoldCrashFixture, label: string): Promise<void> {
  fileOk(await target.plain.writeFile(target.path, target.pristine, BACKGROUND_CONTEXT))
  const restored = await readSessionText(target)
  if (restored !== target.pristine) throw new Error(`${label}: 夹具正文还原失败，后续断言不可信`)
}

async function readSessionText(target: FoldCrashFixture): Promise<string> {
  return fileOk(await target.plain.readTextFile(target.path, BACKGROUND_CONTEXT))
}

/**
 * 前置断言：夹具必须真的会走到发布点 —— 用生产纯函数与生产策略常量复核闸门 1/2 都会放行，
 * 且可丢写入数正好等于帧数（可回收量全部来自帧行，真实条目一行不动）。
 * 少了这条，「文件太小根本没折叠」会让注入的失败假通过。
 */
function assertFoldableFixture(text: string, label: string): void {
  const plan = prepareFold(readFoldLog(text))
  if (plan.kind !== "fold") throw new Error(`${label}: 夹具不可折叠（${plan.reason}），注入点无从触达`)
  if (plan.bytesBefore <= FOLD_POLICY.minFileBytes) {
    throw new Error(`${label}: 夹具未过闸门 1（${plan.bytesBefore} ≤ minFileBytes=${FOLD_POLICY.minFileBytes}）`)
  }
  const reclaimed = plan.bytesBefore - plan.bytesAfter
  if (reclaimed < FOLD_POLICY.minReclaimBytes || reclaimed < plan.bytesBefore * FOLD_POLICY.minReclaimRatio) {
    throw new Error(
      `${label}: 夹具可回收量未过闸门 2（${reclaimed} vs minReclaimBytes=${FOLD_POLICY.minReclaimBytes}` +
        ` / minReclaimRatio=${FOLD_POLICY.minReclaimRatio}）`,
    )
  }
  if (plan.droppedWrites !== FRAME_COUNT) {
    throw new Error(`${label}: 可丢写入数 ${plan.droppedWrites} ≠ 帧数 ${FRAME_COUNT}（夹具形状变了）`)
  }
}

/**
 * 折叠失败面的执行契约：不抛错、返回结构化 `skipped/write-failed`。
 * 抛错会被单独指名（调用方不得把「抛错」当成失败路径的合法形态）。
 */
async function foldExpectingWriteFailed(
  repo: PiSessionRepo,
  metadata: JsonlSessionMetadata,
  label: string,
): Promise<FoldOutcome> {
  let outcome: FoldOutcome
  try {
    outcome = await repo.foldSession(metadata, BACKGROUND_CONTEXT)
  } catch (error) {
    throw new Error(`${label}: 折叠失败路径抛错了（契约要求返回 skipped，不抛）: ${formatError(error)}`)
  }
  if (outcome.kind !== "skipped") throw new Error(`${label}: 期望结构化 skipped，实际 ${outcome.kind}`)
  if (outcome.reason !== "write-failed") throw new Error(`${label}: 期望 skipped/write-failed，实际 ${outcome.reason}`)
  return outcome
}

/** 失败路径必须清掉本次自己写的临时文件（`discardTempFile`）：给下一次折叠留个干净的同目录。 */
async function assertNoTempResidue(target: FoldCrashFixture, label: string): Promise<void> {
  const listing = fileOk(await target.plain.listDir(target.sessionDir, BACKGROUND_CONTEXT))
  const residue = listing.filter(item => item.name.includes(TEMP_MARK))
  if (residue.length > 0) {
    throw new Error(`${label}: 失败路径留下了临时文件: ${residue.map(item => item.path).join(", ")}`)
  }
}

export const 折叠中断: SceneDef = {
  meta: {
    caseId: "harness-session-log-fold-crash",
    module: "harness-storage",
    contractId: "hs-08",
    description: "折叠在 rename / 临时文件写入失败时中止：原文件逐字完好、临时文件被清理、会话仍可打开；残留的 .tmp 文件不参与会话列举",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["harness-storage", "session-fold", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "注入 rename 与临时文件写入失败，钉住折叠中断后的原文件、临时文件与会话状态",
    userText: "校验折叠中断（S-5）。",
    checks: [
      {
        // S-5 主形态：发布点（rename）失败。
        type: "expectRenameFailureKeepsOriginalIntact",
        run: async (ctx) => {
          const target = await ensureFixture(ctx.trial)
          await restorePristine(target, "rename 注入")
          assertFoldableFixture(target.pristine, "rename 注入")

          const env = new RenameFailsEnv(await runtimePath("data"))
          const repo = await createPiSessionRepo({ sessionsRoot: target.root, cwd: target.root, fileSystem: env })
          try {
            await foldExpectingWriteFailed(repo, target.metadata, "rename 注入")
            // rename 是唯一的发布动作：恰好一次，且目标就是这个会话文件。
            if (env.renameAttempts !== 1) {
              throw new Error(`rename 是唯一发布点，期望恰好调用 1 次，实际 ${env.renameAttempts} 次`)
            }
            if (env.lastDestination !== target.path) {
              throw new Error(`rename 的目标不是会话文件: ${JSON.stringify(env.lastDestination)}`)
            }

            const after = await readSessionText(target)
            if (after !== target.pristine) {
              throw new Error("折叠中断（rename 失败）后原文件被改动了：前后正文不逐字相等")
            }
            assertFoldableFixture(after, "rename 失败后")
            await assertNoTempResidue(target, "rename 注入")
          } finally {
            await repo.close(BACKGROUND_CONTEXT)
          }

          // 正面证据（不丢状态）：中断之后同一个文件仍必须能被正常折叠，且折叠前后重放摘要一致。
          const healthy = await createPiSessionRepo({
            sessionsRoot: target.root,
            cwd: target.root,
            fileSystem: new TauriExecutionEnv(await runtimePath("data")),
          })
          try {
            const folded = await healthy.foldSession(target.metadata, BACKGROUND_CONTEXT)
            if (folded.kind !== "folded") throw new Error(`中断之后同一个文件无法再被折叠: ${folded.reason}`)
            const digestBefore = await logStateDigest(readFoldLog(target.pristine))
            const digestAfter = await logStateDigest(readFoldLog(await readSessionText(target)))
            if (digestBefore !== digestAfter) {
              throw new Error(`中断后再折叠改变了逻辑状态: ${digestBefore} ≠ ${digestAfter}`)
            }
          } finally {
            await healthy.close(BACKGROUND_CONTEXT)
          }
        },
      },
      {
        // S-5 的「会话仍可正常打开」：open 前的兜底折叠同样撞上注入点（不抛、只 skipped），
        // 随后的 open 与读回必须与中断前一致。
        type: "expectSessionStillOpensAfterFailedFold",
        run: async (ctx) => {
          const target = await ensureFixture(ctx.trial)
          await restorePristine(target, "open 读回")

          const env = new RenameFailsEnv(await runtimePath("data"))
          const repo = await createPiSessionRepo({ sessionsRoot: target.root, cwd: target.root, fileSystem: env })
          try {
            await foldExpectingWriteFailed(repo, target.metadata, "open 读回")
            const session = await repo.open(target.metadata, BACKGROUND_CONTEXT)
            try {
              const entries = await session.findEntries({ customType: CUSTOM_TYPE }, BACKGROUND_CONTEXT)
              const ids = entries.map(entry => entry.id)
              const missing = target.entryIds.filter(id => !ids.includes(id))
              if (missing.length > 0 || ids.length !== target.entryIds.length) {
                throw new Error(`折叠中断后条目读回不一致: 期望 ${JSON.stringify(target.entryIds)}，实际 ${JSON.stringify(ids)}`)
              }
              const name = await session.getName(BACKGROUND_CONTEXT)
              if (name !== SESSION_NAME) throw new Error(`折叠中断后会话名丢失: ${JSON.stringify(name)}`)
            } finally {
              await session.close(BACKGROUND_CONTEXT)
            }

            const after = await readSessionText(target)
            if (after !== target.pristine) {
              throw new Error("打开会话的过程中原文件被改动了：前后正文不逐字相等")
            }
          } finally {
            await repo.close(BACKGROUND_CONTEXT)
          }
        },
      },
      {
        // S-5 第二形态：临时文件写入失败（发布前的最后一次写盘失败）。
        type: "expectTempWriteFailureKeepsOriginalIntact",
        run: async (ctx) => {
          const target = await ensureFixture(ctx.trial)
          await restorePristine(target, "临时文件写入注入")
          assertFoldableFixture(target.pristine, "临时文件写入注入")

          const env = new TempWriteFailsEnv(await runtimePath("data"))
          const repo = await createPiSessionRepo({ sessionsRoot: target.root, cwd: target.root, fileSystem: env })
          try {
            await foldExpectingWriteFailed(repo, target.metadata, "临时文件写入注入")
            if (env.tempWriteAttempts !== 1) {
              throw new Error(`临时文件只应写一次，实际 ${env.tempWriteAttempts} 次`)
            }
            // 结构证据：失败路径上没有任何一次写入落在会话文件本身 —— 不存在「直接覆盖原文件」的写法。
            if (env.writePaths.includes(target.path)) {
              throw new Error(`折叠在失败路径上写了会话文件本身: ${JSON.stringify(env.writePaths)}`)
            }

            const after = await readSessionText(target)
            if (after !== target.pristine) {
              throw new Error("折叠中断（临时文件写入失败）后原文件被改动了：前后正文不逐字相等")
            }
            await assertNoTempResidue(target, "临时文件写入注入")
          } finally {
            await repo.close(BACKGROUND_CONTEXT)
          }
        },
      },
      {
        // 崩溃残留：进程若死在「临时文件已写、rename 未执行」之间，盘上会留下 `<会话>.jsonl.tmp-*`。
        // 这里只钉残留的**后果**：它不参与会话列举、也不阻断 open（回收缺口见文件头登记）。
        type: "expectStaleTempResidueDoesNotBreakSession",
        run: async () => {
          const context = BACKGROUND_CONTEXT
          const env = new TauriExecutionEnv(await runtimePath("data"))
          const root = fileOk(await env.createTempDir("deskpet-live-foldcrash-residue-", context))
          const repo = await createPiSessionRepo({ sessionsRoot: root, cwd: root, fileSystem: env })
          try {
            const session = await repo.create({ id: "fold-crash-residue" }, context)
            let metadata: JsonlSessionMetadata | undefined
            try {
              await session.createBranch(BRANCH, null, context)
              const branch = await session.branch(BRANCH, context)
              if (branch === undefined) throw new Error(`残留夹具分支取不到: ${BRANCH}`)
              await branch.appendCustomEntry(CUSTOM_TYPE, { index: 0 }, context)
              metadata = session.metadata
            } finally {
              await session.close(context)
            }
            if (metadata === undefined) throw new Error("残留夹具会话没有 metadata")
            // 手工造一条崩溃残留：名字与折叠的临时路径同形，但绝不是会话文件。
            fileOk(await env.writeFile(`${metadata.path}${TEMP_MARK}1234567890`, "崩溃残留", context))

            const listed = await repo.list(undefined, context)
            const ids = listed.map(item => item.id)
            if (!ids.includes("fold-crash-residue")) {
              throw new Error(`残留存在时正常会话从列表里消失: ${JSON.stringify(ids)}`)
            }
            if (listed.some(item => item.path.includes(TEMP_MARK))) {
              throw new Error(`残留文件被当成了会话: ${JSON.stringify(listed.map(item => item.path))}`)
            }

            const reopened = await repo.open(metadata, context)
            try {
              const entries = await reopened.findEntries({ customType: CUSTOM_TYPE }, context)
              if (entries.length !== 1) {
                throw new Error(`残留存在时 open 读不回条目: 期望 1 条，实际 ${entries.length} 条`)
              }
            } finally {
              await reopened.close(context)
            }
          } finally {
            await repo.close(context)
            await env.remove(root, { recursive: true, force: true }, context)
            // 本 check 是最后一条：把跨 check 的夹具也一并收掉（失败路径同样会走到这里）。
            await releaseFixture()
          }
        },
      },
    ],
  }],
}

export default 折叠中断
