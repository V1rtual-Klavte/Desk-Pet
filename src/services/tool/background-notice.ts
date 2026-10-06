// ==========================================
// 后台命令完成通知 —— 载荷类型、结构校验与中性文案（零依赖叶子）
// ==========================================
//
// 数据流（单向，无回执）：
//   Rust `commands/tool_exec/bash.rs` 超时转后台（不杀进程）→ 等待线程在进程结束
//   或到点回收后 emit `HostEvent::BackgroundCommandFinished` → `HostEventRouter`
//   只投 Node → 桥事件 `bash-background-finished` → `./background.ts` 订阅 →
//   聊天系统消息（`session/messages.ts` 的 `pushSystemMessage`，唯一既有展示通道）。
//
// 本叶子零 import：纯函数（校验 + 文案）在 L2 直测，不经工具 barrel 与宿主桥；
// 订阅与投递（带 IPC）在 `./background.ts`。
//
// 语义边界（与 docs/current/tool-system.md 同一口径）：
// - 后台命令不持有 AI 锁、不占回合墙钟；停止回合与删会话都不会杀它（当前无 TaskStop）。
// - 宿主退出由 `kill_all` 兜底回收（不发完成事件）；Node 崩溃轮换窗口内的事件丢弃不重放。
// - 完整输出只在溢出时留 spill 文件；系统消息只带输出尾窗与取回地址。

/**
 * 宿主事件 `bash-background-finished` 的载荷。
 *
 * 逐字镜像 Rust `crates/native-host/src/host/mod.rs` 的 `BackgroundCommandFinished`
 * （serde camelCase）：字段增删必须两侧同一改动里对齐。
 */
export interface BashBackgroundFinishedPayload {
  executionId: string
  /** 发起该命令的会话；null = 调用方未归属会话（无展示位，消费端如实留痕跳过）。 */
  sessionId: string | null
  /** 命令预览（Rust 侧截断到固定上限），只用于展示。 */
  commandPreview: string
  /** 退出码；被信号终止（含后台时限回收）时为 null。 */
  exitCode: number | null
  durationMs: number
  reason: "exited" | "capReached"
  /** 结束前最后一次输出增长距今的静默时长（L1 证据，只用于展示）。 */
  silentMs: number
  /** 两路输出的原始总字节数。 */
  producedBytes: number
  /** 输出尾部窗口（与前台路径同一上限）。 */
  outputTail: string
  /** 输出被截断时保留的全量输出文件路径；未截断为 null。 */
  spillPath: string | null
}

/** 完成通知正文里回显的输出尾部上限：系统消息是聊天视图的一行，不整段倾倒输出。 */
const NOTICE_TAIL_CHARS = 1200
/** 静默时长达到该阈值才写进通知（不到就不提；「无输出」本身不是异常）。 */
const NOTICE_SILENCE_THRESHOLD_MS = 60_000

/** 结构校验：不猜字段、不给兜底值；结构不符即丢弃并留痕（同 window listener 口径）。 */
export function parseBackgroundFinishedPayload(value: unknown): BashBackgroundFinishedPayload | null {
  if (!value || typeof value !== "object") return null
  const item = value as Partial<BashBackgroundFinishedPayload>
  const reasonOk = item.reason === "exited" || item.reason === "capReached"
  const optionalsOk =
    (item.sessionId === null || typeof item.sessionId === "string")
    && (item.exitCode === null || typeof item.exitCode === "number")
    && (item.spillPath === null || typeof item.spillPath === "string")
  if (
    !reasonOk || !optionalsOk
    || typeof item.executionId !== "string"
    || typeof item.commandPreview !== "string"
    || typeof item.durationMs !== "number"
    || typeof item.silentMs !== "number"
    || typeof item.producedBytes !== "number"
    || typeof item.outputTail !== "string"
  ) {
    return null
  }
  return item as BashBackgroundFinishedPayload
}

/** 中性系统消息正文（不是角色台词）：结论 + 为什么 + 输出在哪。 */
export function formatBackgroundFinishedNotice(finished: BashBackgroundFinishedPayload): string {
  const command = finished.commandPreview.length > 0 ? `：\`${finished.commandPreview}\`` : ""
  const duration = formatDuration(finished.durationMs)
  const head = finished.reason === "capReached"
    ? `后台命令超过时限已被终止（运行 ${duration}）${command}`
    : finished.exitCode === null
      ? `后台命令已结束（被终止，运行 ${duration}）${command}`
      : `后台命令已完成（退出码 ${finished.exitCode}，运行 ${duration}）${command}`
  const lines = [head]
  if (finished.reason === "capReached") {
    lines.push("命令未在后台时限（30 分钟）内结束，已按进程组回收；长任务请拆分为多条较短命令。")
  } else if (finished.silentMs >= NOTICE_SILENCE_THRESHOLD_MS) {
    // L1 证据：结束前长时间无输出 —— 供用户判读「是不是卡死过」。
    lines.push(`结束前已 ${formatDuration(finished.silentMs)} 无输出。`)
  }
  const tail = finished.outputTail.trimEnd()
  if (tail) {
    lines.push(tail.length > NOTICE_TAIL_CHARS
      ? `（共 ${formatBytes(finished.producedBytes)} 输出，以下是末尾片段）\n${tail.slice(-NOTICE_TAIL_CHARS)}`
      : tail)
  } else if (finished.producedBytes === 0) {
    lines.push("（命令没有产生输出）")
  }
  if (finished.spillPath) lines.push(`完整输出: ${finished.spillPath}`)
  return lines.join("\n")
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m${rest}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
