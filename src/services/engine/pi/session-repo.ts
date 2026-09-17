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
}

export interface PiSessionRepoOptions {
  /** 注入文件系统能力；默认 TauriExecutionEnv（真实 Rust IPC）。 */
  fileSystem?: FileSystem
  /** 会话根目录；默认数据根下 `sessions/`（运行时路径域 sessions）。 */
  sessionsRoot?: string
  /** 会话 cwd；默认数据根（§8.1）。注入 fileSystem 时一并注入，避免依赖路径模块。 */
  cwd?: string
}

class DataRootSessionRepo implements PiSessionRepo {
  constructor(private readonly repo: JsonlSessionRepo, readonly sessionsRoot: string, readonly cwd: string) {}

  create(options: SessionCreateOptions, context: Context): Promise<Session<JsonlSessionMetadata>> {
    return this.repo.create({ ...options, cwd: this.cwd }, context)
  }

  open(metadata: JsonlSessionMetadata, context: Context): Promise<Session<JsonlSessionMetadata>> {
    return this.repo.open(metadata, context)
  }

  /** options 只为满足 SessionRepo 签名；会话固定归属数据根 cwd，这里不再接受别的 cwd。 */
  list(_options: JsonlSessionListOptions | undefined, context: Context): Promise<JsonlSessionMetadata[]> {
    return this.repo.list({ cwd: this.cwd }, context)
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
 *   能力读写，`exec` 走不到，mode 固定 pet 是最小权限基线，将来复用也不会放宽。
 */
export async function createPiSessionRepo(options: PiSessionRepoOptions = {}): Promise<PiSessionRepo> {
  const cwd = options.cwd ?? (await runtimePath("data"))
  const fileSystem = options.fileSystem ?? new TauriExecutionEnv(cwd, "pet")
  const sessionsRoot = options.sessionsRoot ?? (await runtimePath("sessions"))
  log.info("JsonlSessionRepo 就绪:", sessionsRoot)
  return new DataRootSessionRepo(new JsonlSessionRepo({ fileSystem, sessionsRoot }), sessionsRoot, cwd)
}
