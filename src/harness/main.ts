// ==========================================
// 唯一 Node Harness bootstrap（W2 骨架 + W4 激活）
// ==========================================
//
// 执行契约 §2.2：整个应用只有一个 Harness Node，入口就是本文件。启动顺序
// （§4.3 第 2 条）：连原生宿主（HostBridge hello/welcome）→ 经 `get_runtime_paths`
// 取路径 → 初始化日志/错误 → 初始化人格/会话/工具/主动观察调度。
//
// W4 阻塞已由解除包清除（原生宿主迁移过程记录 §9.4 第 35 条）：领域模块图的 @tauri-apps 值导入改为环境端口
// （@/services/host 的 ports/ui-events，Node 实现随 connectHostBridge 装配），CONFIG.yaml
// 统一为文本装载（esbuild `--loader:.yaml=text`），`initDomainBootstrap` 已静态接线。
// - 不 import 任何 `@tauri-apps/*`，不使用 `import.meta.env`，不嗅探 `navigator`；
// - 平台与运行模式**只从 ServerWelcome 取**（`bridge.platform` / `bridge.runtimeMode`），
//   不用 cwd / NODE_ENV / 用户目录推算；
// - 进程被宿主关停时：先 flush，再把**真实结果**经 shutdownFlush 报回宿主；
//   宿主连接断开（宿主死亡）即退出，绝不留下来历不明的孤儿 Node。
//
// 构建参数里的 `--define:navigator=undefined --define:globalThis.navigator=undefined`
// （见 package.json 的 build:harness）是 **Node 目标的语义声明，不是守卫规避**：bundle 里
// 仅有的 navigator 引用来自 openai SDK 的浏览器探测（detect-platform.mjs 的
// getBrowserInfo、core/streaming.mjs 的 ReactNative 分支），两者在 Node 上都取「无浏览器」
// 分支（与 Node 22 的真实结果一致：探测仍返回 null）；define 让这些分支在构建期常量折叠，
// 产物守卫（无 @tauri-apps / 无 import.meta.env / 无 navigator.）才能对整包成立。
//
// 另两个构建参数：`--loader:.yaml=text --loader:.md=text`（CONFIG.yaml 与 stages-prompt.md
// 的文本装载，与 Vite 侧同形）与 `--banner:js=...createRequire...`（CJS 依赖 yaml@2 里
// `require("process")` 在 ESM 产物下需要真实 require；不注入会以
// 「Dynamic require of "process" is not supported」在加载期崩）。
//
// 退出码语义（宿主据此记录，不用于业务分支）：
//   0   正常（宿主关停且 flush 完成）
//   70  引导失败（启动信息缺失、握手失败、宿主不可达……）
//   71  宿主连接断开（宿主死亡或非预期断开）
//   72  宿主关停但 flush 未完成（如实上报）
//   73  运行期未捕获异常/未处理拒绝（单一出口留痕后退出，不吞、不留半死进程）

import { pathToFileURL } from "node:url"

// 经唯一取用口（@/services/host 桶）取 W2 实现并注入：桶的静态依赖保持 Node 可加载
// （不引入任何浏览器依赖），因此 Node 进程可以安全 import 桶；
// 本文件的 import 图里不含任何浏览器专用包。
import {
  connectHostBridge,
  setHostBridge,
  type FlushReport,
  type HostBridgeRuntime,
  type HostCommandMap,
} from "@/services/host"
import { initDomainBootstrap } from "@/services/init"
import { disposePlanConfirmationReceipts, initPlanConfirmationReceipts } from "@/services/engine/plan-confirmation"
import { disposeChoiceConfirmationReceipts, initChoiceConfirmationReceipts } from "@/services/engine/choice-confirmation"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { flushSessionFrameWrites, harnessSlots } from "@/services/engine/harness"
import { flushLogs } from "@/services/logger"
import { flushPendingReleases, retryBorrowerAttachIfPending } from "@/services/tool"
import { disconnectAllMcpServers } from "@/services/tool/mcp"
import { stopIdleDreamingSchedulerAndWait } from "@/services/agent/memory"
import { stop as stopProactive } from "@/services/proactive"
import { stopSilentUnderstanding } from "@/services/observation"
import { disconnectWindowObservation, setMonitorEnabled } from "@/services/window"
import { drainHostRequestHandlers, stopHostRequestHandlers, stopNativeUiBridge } from "@/services/native-ui"
import { flushConfig } from "@/services/config"
import { errorDetail, formatError } from "@/services/error"

const EXIT_OK = 0
const EXIT_BOOTSTRAP_FAILED = 70
const EXIT_HOST_GONE = 71
const EXIT_FLUSH_INCOMPLETE = 72
const EXIT_RUNTIME_CRASH = 73

/** `get_runtime_paths` 的结果形状（权威定义在 HostCommandMap，不在此重抄）。 */
export type RuntimePathsPayload = HostCommandMap["get_runtime_paths"]["result"]

export interface HarnessContext {
  bridge: HostBridgeRuntime
  paths: RuntimePathsPayload
  /** 只来自 ServerWelcome（唯一真相源）。 */
  runtimeMode: "development" | "production"
  platform: "windows" | "macos"
}

let domainInitialization: Promise<void> | null = null

/**
 * 整个进程的唯一引导入口。
 *
 * 返回后进程由事件循环维持（两条 socket 与后续领域任务）；宿主断开或关停时由
 * 生命周期钩子退出。
 */
export async function runHostHarness(): Promise<HarnessContext> {
  const bridge = await connectHostBridge()
  // 注入进程级唯一取用口：领域模块只认 getHostBridge()，不感知 transport 实现。
  setHostBridge(bridge)
  const context = await bootstrapHarnessContext(bridge)
  domainInitialization = initDomainServices(context)
  await domainInitialization
  return context
}

async function bootstrapHarnessContext(bridge: HostBridgeRuntime): Promise<HarnessContext> {
  const paths = await bridge.request("get_runtime_paths", {})
  // 运行模式以 ServerWelcome 为准；paths 里的同名字段是旧投影，口径不一致要留痕。
  const runtimeMode = bridge.runtimeMode
  if (paths.runtimeMode !== runtimeMode) {
    bootstrapWrite(
      `[harness] 运行模式口径不一致：welcome=${runtimeMode} paths=${paths.runtimeMode}（以 welcome 为准）`,
    )
  }
  const context: HarnessContext = {
    bridge,
    paths,
    runtimeMode,
    platform: bridge.platform,
  }
  initLoggingAndErrors(context)
  installLifecycleHooks(context)
  return context
}

/**
 * 日志/错误初始化。
 *
 * 引导期仍用本文件的 bootstrapWrite 出口：`@/services/logger` / `@/services/error`
 * 现已去 DOM（端口化，见解除包），但它们进 harness 的**统一接入**（写 paths.logs、
 * 关停 flush、reportError 单一出口叠加桥上报告）是 W3 的剩余项，本轮不动运行期行为。
 * 这里做该接入点**现在就能负责的事**：校验宿主返回的路径都有值（引导数据坏掉必须
 * 当场失败，否则后续领域初始化会落到错误位置），并装好 Node 侧的错误出口。
 */
function initLoggingAndErrors(context: HarnessContext): void {
  const required: Array<keyof RuntimePathsPayload> = [
    "data",
    "memory",
    "sessions",
    "personality",
    "profiles",
    "settings",
    "configFile",
  ]
  for (const key of required) {
    const value = context.paths[key]
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`get_runtime_paths 返回的字段缺失或为空: ${key}`)
    }
  }
  // Node 侧未捕获异常/未处理拒绝走单一 stderr 出口（宿主采集进统一日志）后以 73 退出；
  // 不在未知运行状态下尝试继续或 flush。
  installNodeErrorExit()
}

/**
 * 运行期崩溃出口：写 stderr 后以 73 退出。
 *
 * 与 isDirectRun() 的引导失败（70）分开：这里是「引导之后进程仍在运行时」的异常，
 * 退出码让宿主能区分两类死亡。不做 flush —— uncaughtException 后进程状态未知，
 * 等已准入写队列不是可靠动作；如实留痕、立即退出。
 */
function installNodeErrorExit(): void {
  process.on("uncaughtException", (error) => {
    writeRuntimeFailure("uncaughtException", error)
    process.exit(EXIT_RUNTIME_CRASH)
  })
  process.on("unhandledRejection", (reason) => {
    writeRuntimeFailure("unhandledRejection", reason)
    process.exit(EXIT_RUNTIME_CRASH)
  })
}

function writeRuntimeFailure(kind: string, error: unknown): void {
  bootstrapWrite(`[harness] 运行期未捕获异常 (${kind}) ${errorDetail(error)}`)
}

/**
 * 进程生命周期钩子：宿主关停 → flush 并如实回报；宿主断开 → 立即退出。
 */
function installLifecycleHooks(context: HarnessContext): void {
  let shutdownFlush: FlushReport | null = null
  context.bridge.onShutdown(async () => {
    shutdownFlush = await flushForShutdown(context)
    return shutdownFlush
  })
  context.bridge.onDisconnect((reason) => {
    if (shutdownFlush) {
      bootstrapWrite(
        `[harness] 宿主关停完成: flushed=${shutdownFlush.flushed} pending=${shutdownFlush.pending}（${reason}）`,
      )
      process.exit(shutdownFlush.flushed ? EXIT_OK : EXIT_FLUSH_INCOMPLETE)
    }
    bootstrapWrite(`[harness] 宿主连接断开，Node 退出: ${reason}`)
    process.exit(EXIT_HOST_GONE)
  })
  // 运行期全局错误出口已在 initLoggingAndErrors() 的 installNodeErrorExit() 装好
  // （先于领域初始化）；此处只管进程生命周期：关停 flush 与宿主断开。
}

/** 取消/排空已准入回合，再 flush 会话帧、审计、许可释放与日志并上报真实结果。 */
async function flushForShutdown(_context: HarnessContext): Promise<FlushReport> {
  const failures: string[] = []
  const attempt = async <T>(name: string, action: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      failures.push(`${name}: ${formatError(error)}`)
      return fallback
    }
  }
  // Reject new UI work immediately. Existing handlers drain after producers stop and
  // Harness slots are aborted, so run-bound requests cannot hold shutdown open by themselves.
  await attempt("host request admission", async () => { stopHostRequestHandlers() }, undefined)
  if (domainInitialization) {
    await attempt("domain initialization", () => domainInitialization!, undefined)
  }
  // Stop producers before waiting on Harness slots; then disconnect Native-owned MCP clients.
  await Promise.all([
    attempt("proactive scheduler", stopProactive, undefined),
    attempt("idle memory scheduler", stopIdleDreamingSchedulerAndWait, undefined),
    attempt("silent understanding", stopSilentUnderstanding, undefined),
  ])
  const behaviorFlushed = await attempt("monitor disable", () => setMonitorEnabled(false), true)
  await attempt("window observation unsubscribe", async () => disconnectWindowObservation(), undefined)
  const runtime = await attempt("Harness runs and audit", () => harnessSlots.prepareForShutdown(), { unresolvedRuns: 0, pendingAudit: 0 })
  const hostRequests = await attempt(
    "host request drain",
    drainHostRequestHandlers,
    { completed: 0, failures: ["宿主请求 drain 未完成"] },
  )
  for (const failure of hostRequests.failures) failures.push(`host request: ${failure}`)
  await attempt("CONFIG write queue", flushConfig, undefined)
  await attempt("UI subscriptions", async () => {
    stopNativeUiBridge()
    disposePlanConfirmationReceipts()
    disposeChoiceConfirmationReceipts()
  }, undefined)
  await attempt("MCP disconnect", disconnectAllMcpServers, undefined)
  const frameFailures = await attempt("session frame flush", () => flushSessionFrameWrites(BACKGROUND_CONTEXT), 0)
  const permitAttached = await attempt("tool permit attach", retryBorrowerAttachIfPending, true)
  const permits = await attempt("tool permit release", flushPendingReleases, { attempted: 0, released: 0, pending: 0 })
  // Last: earlier shutdown stages can add log records that also need to be delivered.
  const logsFlushed = await flushLogs()
  if (!logsFlushed) failures.push("logger delivery failed")
  const pending = runtime.unresolvedRuns + runtime.pendingAudit + permits.pending + (permitAttached ? 0 : 1) +
    (behaviorFlushed ? 0 : 1) + frameFailures + failures.length
  const flushed = pending === 0 && logsFlushed && failures.length === 0
  const detail = [
    `unresolvedRuns=${runtime.unresolvedRuns}`,
    `pendingAudit=${runtime.pendingAudit}`,
    `pendingPermitReleases=${permits.pending}`,
    `permitAttached=${permitAttached}`,
    `behaviorFlushed=${behaviorFlushed}`,
    `frameFlushFailures=${frameFailures}`,
    `logsFlushed=${logsFlushed}`,
    ...failures,
  ].join("; ")
  return { flushed, pending, detail }
}

/**
 * 领域初始化接线点（解除包激活，原生宿主迁移过程记录 §9.4 第 35 条）：领域序列在 `@/services/init` 的
 * `initDomainBootstrap()`，此处静态引入即完整承载
 * 会话/人格/工具/主动业务；域模块图不含任何 `@tauri-apps`/`import.meta.env`/`navigator.`
 * （端口化见 `@/services/host` 的 ports/ui-events；构建守卫见 package.json 的 build:harness）。
 *
 * UI 回执（计划确认/步骤裁决/提问选择）在领域引导前订阅：Node 领域永远没有 in-process
 * 面板，回执来自原生 UI（扣在桥的 subscribe 上；HostEventMap 的 deskpet-plan-* 与
 * deskpet-choice-* 是提问方向）。
 */
export async function initDomainServices(context: HarnessContext): Promise<void> {
  // 引导上下文已备好：运行模式与平台只来自握手（领域初始化只准消费它们）。
  void context.runtimeMode
  void context.platform
  initPlanConfirmationReceipts()
  initChoiceConfirmationReceipts()
  await initDomainBootstrap()
}

/**
 * 引导期的裸诊断出口：写 stderr，由宿主的 stdout/stderr 采集进统一日志
 * （那两条标准流永不承载 RPC）。W3 的统一 logger 就绪后，这里只保留引导失败兜底。
 */
function bootstrapWrite(line: string): void {
  process.stderr.write(`${line}\n`)
}

function writeBootstrapFailure(error: unknown): void {
  let code = "OTHER"
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    code = (error as { code: string }).code
  }
  bootstrapWrite(`[harness] 引导失败 [${code}] ${errorDetail(error)}`)
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isDirectRun()) {
  runHostHarness().catch((error: unknown) => {
    writeBootstrapFailure(error)
    process.exit(EXIT_BOOTSTRAP_FAILED)
  })
}
