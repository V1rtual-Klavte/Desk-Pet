// Pi AgentHarness 的会话存储工厂（H-1）。
// JsonlSessionRepo 直接产出 Session；会话根目录取运行时路径域 `sessions`（数据根下），
// 与 UI 状态文件 index.json 同根存放。

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core"
import type {
  Context,
  FileSystem,
  ForkOptions,
  JsonlSessionListOptions,
  JsonlSessionMetadata,
  Session,
  SessionCreateOptions,
} from "@earendil-works/pi-agent-core"
import { runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { FrameBufferingFileSystem } from "./session-frame-buffer"
import { FOLD_POLICY, foldSessionFile } from "./session-fold"
import type { FoldOutcome } from "./session-fold"

const log = createLogger("PiSessionRepo")

/**
 * Desk-Pet 的会话仓库门面。
 *
 * 与 `JsonlSessionRepo` 的差别只有一处：会话 `cwd` 统一取数据根（§8.1），
 * 不再由每次调用传参决定 —— 官方一致性套件的 `create` 就不带 cwd，
 * 调用方（会话管理、Harness 注入）也都不该各自挑一个 cwd。
 */
export interface PiSessionRepo {
  readonly sessionsRoot: string
  readonly cwd: string
  create(options: SessionCreateOptions, context: Context): Promise<Session<JsonlSessionMetadata>>
  open(metadata: JsonlSessionMetadata, context: Context): Promise<Session<JsonlSessionMetadata>>
  list(options: JsonlSessionListOptions | undefined, context: Context): Promise<JsonlSessionMetadata[]>
  delete(metadata: JsonlSessionMetadata, context: Context): Promise<void>
  fork(source: JsonlSessionMetadata, options: ForkOptions, context: Context): Promise<Session<JsonlSessionMetadata>>
  close(context: Context): Promise<void>
  /**
   * 按需折叠一个会话文件。前置条件：该会话当前没有打开的写入者。
   * 无收益、格式未知、摘要不一致、写入失败时返回 skipped —— 一律不影响会话功能。
   */
  foldSession(metadata: JsonlSessionMetadata, context: Context): Promise<FoldOutcome>
}

export interface PiSessionRepoOptions {
  /** 注入文件系统能力；默认 TauriExecutionEnv（真实 Rust IPC）。 */
  fileSystem?: FileSystem
  /** 会话根目录；默认数据根下 `sessions/`（运行时路径域 sessions）。 */
  sessionsRoot?: string
  /** 会话 cwd；默认数据根（§8.1）。注入 fileSystem 时一并注入，避免依赖路径模块。 */
  cwd?: string
  /** 帧写入合并（O-9）：缺省开启。**仅供测试与诊断**显式关闭；生产路径不传。 */
  frameThrottle?: boolean
}

class DataRootSessionRepo implements PiSessionRepo {
  constructor(private readonly repo: JsonlSessionRepo, readonly sessionsRoot: string, readonly cwd: string) {}

  /**
   * `JsonlSessionRepo` 实际持有的那个 `FileSystem`，也就是 W1 装饰后的实例（O-9 的帧缓冲只包在
   * 它外面）。上游把该字段声明为 `private`（`jsonl/repo.d.ts:6`），但 TS 的 private 只是编译期
   * 可见性：npm 版 0.85.1（`package.json` 精确锁版）的产物里它是普通实例字段，构造函数里
   * `this.fileSystem = options.fileSystem`。
   *
   * 为什么不另存一份引用（例如加构造参数）：那样就有了同一个实例的两个定义点 —— 将来任一处
   * 被换掉都不会有人发现，而折叠**必须**用被装饰的那一个（未装饰的读写会让折叠重写与缓冲里的
   * 帧互相盖掉）。
   */
  private get repoFileSystem(): FileSystem {
    return (this.repo as unknown as { readonly fileSystem: FileSystem }).fileSystem
  }

  create(options: SessionCreateOptions, context: Context): Promise<Session<JsonlSessionMetadata>> {
    return this.repo.create({ ...options, cwd: this.cwd }, context)
  }

  /**
   * 按需折叠一个会话文件（唯一入口：`open` 前的兜底与 `releasePiSession` 的回收主路径共用）。
   *
   * 全程经 `repoFileSystem`（W1 装饰后的实例）：同路径的 `readTextFile` / `writeFile` /
   * `renameFile` 都会先 flush 该路径的帧缓冲，因此「读全文 + 原子重写」天然发生在帧已落盘之后。
   * 失败一律以 `skipped` 结论返回（`foldSessionFile` 的契约），不抛错、不影响会话功能。
   */
  foldSession(metadata: JsonlSessionMetadata, context: Context): Promise<FoldOutcome> {
    return foldSessionFile(this.repoFileSystem, metadata.path, context)
  }

  async open(metadata: JsonlSessionMetadata, context: Context): Promise<Session<JsonlSessionMetadata>> {
    // 惰性回收：只有「没被干净关闭」的会话（崩溃 / 强杀 / 进程退出）才会走到真正读文件这一步 ——
    // 正常关闭的会话已由 releasePiSession 折到闸门以下，fileInfo 的 size 判定会直接跳过。
    await this.maybeFoldBeforeOpen(metadata, context)
    return this.repo.open(metadata, context)
  }

  /**
   * `open` 前的兜底折叠（O-7 的「open 前按需」）。闸门 1 在这里只花一次 `fileInfo`（常态就是
   * 这一次 stat，不读正文）；闸门 2（可回收量的两个下界）在 `foldSessionFile` 内部，只有文件
   * 超过阈值才会多读一次全文。
   */
  private async maybeFoldBeforeOpen(metadata: JsonlSessionMetadata, context: Context): Promise<void> {
    try {
      const info = await this.repoFileSystem.fileInfo(metadata.path, context)
      // stat 失败（文件不存在 / IPC 错误）不在这里报：紧接着的 this.repo.open 会以同一条路径
      // 失败并把根因抛给调用方，留痕点就是 open 的失败路径，折叠不重复报一次。
      if (!info.ok || info.value.size <= FOLD_POLICY.minFileBytes) return
      await foldSessionFile(this.repoFileSystem, metadata.path, context)
    } catch (error) {
      // 折叠是优化，不得成为 open 的前置条件；根因留痕在 foldSessionFile（logger "SessionFold"）。
      // FileSystem 契约要求方法不 throw，但折叠链路上还有解析、哈希、crypto 等本仓代码。
      log.warn("打开前折叠失败，按原文件继续打开:", metadata.path, formatError(error))
    }
  }

  /**
   * 列举会话元数据。**不默认按当前 cwd 过滤**：数据根变更（或 `--<cwd>--` 目录编码碰撞）后，
   * 旧会话仍会被如实列出，由调用方显式处理 —— 不允许出现「index.json 里有 id、仓库列表里静默消失」。
   */
  list(options: JsonlSessionListOptions | undefined, context: Context): Promise<JsonlSessionMetadata[]> {
    return this.repo.list(options, context)
  }

  delete(metadata: JsonlSessionMetadata, context: Context): Promise<void> {
    return this.repo.delete(metadata, context)
  }

  fork(source: JsonlSessionMetadata, options: ForkOptions, context: Context): Promise<Session<JsonlSessionMetadata>> {
    return this.repo.fork(source, options, context)
  }

  close(context: Context): Promise<void> {
    return this.repo.close(context)
  }
}

/**
 * 创建会话仓库（方案 §8.1）。
 *
 * - `sessionsRoot` 取数据根下的 `sessions/`（运行时路径域 `sessions`）；UI 状态
 *   index.json 同根存放，但它不是 .jsonl 会话条目，仓库读写互不涉及。
 * - 会话布局为 `<sessionsRoot>/--<cwd>--/<时间戳>_<id>.jsonl`；cwd 固定数据根，
 *   只用于会话归属与相对路径解析，不拿它区分业务。
 * - 目录不在这里预建：repo 首次 `create` 会按需对会话目录 `createDir`（recursive）。
 * - `fileSystem.cwd` 也取数据根（FileSystem 只拿它解析相对路径）；工厂只经文件系统
 *   能力读写，`exec` 走不到，将来复用也不会放宽。
 * - 注入与默认的 `fileSystem` 都再包一层帧写入缓冲装饰器（O-9，默认开）：只合并
 *   `pi.pending.assistant_frame` 的帧 append，其余读写逐字节透传（见 session-frame-buffer.ts）。
 */
export async function createPiSessionRepo(options: PiSessionRepoOptions = {}): Promise<PiSessionRepo> {
  const cwd = options.cwd ?? (await runtimePath("data"))
  const base = options.fileSystem ?? new TauriExecutionEnv(cwd)
  // O-9 裁定：帧写入合并是全局开关、默认开，`=== false` 是本文件唯一的旁路点。
  //   · 不做按会话粒度 —— 缓冲本身已按文件路径分桶，「按会话开关」只会多一个状态点而没有
  //     消费者；排查真正需要的是「整体关掉看现象」。
  //   · 不新增 CONFIG.yaml 字段 —— 它会牵出 YAML → 模板 → getter → 设置 Tab → 保存映射的
  //     整条链（AGENTS.md 配置同步清单），而这一项没有用户可见语义。
  //   · 默认与注入两条路都包：否则注入路径的测试与生产走两套行为（装饰器只认 FileSystem
  //     接口，包在谁外面不影响其余语义）。
  const fileSystem = options.frameThrottle === false ? base : new FrameBufferingFileSystem(base)
  const sessionsRoot = options.sessionsRoot ?? (await runtimePath("sessions"))
  log.info("JsonlSessionRepo 就绪:", sessionsRoot)
  return new DataRootSessionRepo(new JsonlSessionRepo({ fileSystem, sessionsRoot }), sessionsRoot, cwd)
}
