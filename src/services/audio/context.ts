// ==========================================
// 音效系统 — 共享 AudioContext
// ==========================================

import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Audio")

let sharedCtx: AudioContext | null = null
let ctxResumePromise: Promise<void> | null = null
let suspendedReported = false

/**
 * 音效节点构建失败的一次性出口。
 *
 * effects 里 30+ 处 `catch` 是有意静默（单个音效失败不该影响交互），但 try 体内
 * 抛出的不都是 ctx 问题：`osc.start()` 二次调用抛 `InvalidStateError`、
 * `exponentialRampToValueAtTime` 非法值抛 `RangeError` 是程序 bug，根因不在 getCtx
 * 的留痕范围里 —— 由本函数统一补一次可查证据，同类失败不重复刷屏。
 */
let buildFailureReported = false
export function reportEffectFailure(error: unknown): void {
  if (buildFailureReported) return
  buildFailureReported = true
  log.warn("音效节点构建失败，该音效已跳过（后续同类失败不再重复报告）", formatError(error))
}

/** 自动播放策略挂起的一次性出口：两条 getCtx 分支共用。 */
export function reportSuspendedOnce(): void {
  if (suspendedReported) return
  suspendedReported = true
  log.warn("AudioContext 处于 suspended（自动播放策略拦截），音效已静默跳过")
}

/**
 * 获取共享 AudioContext。
 *
 * 返回 null 表示音频不可用。各 effects 文件里大量的 `catch` 是**有意静默**的：
 * 单个音效节点构建失败不该影响交互，根因留痕分两处：ctx 拿不到或一直被自动播放
 * 策略挂起在 `getCtx`（`reportSuspendedOnce`）；**节点构建失败**由
 * `reportEffectFailure` 一次性留痕，避免 30+ 处重复打日志。
 */
export async function getCtx(): Promise<AudioContext | null> {
  if (sharedCtx && sharedCtx.state !== "closed") {
    if (sharedCtx.state === "suspended") {
      if (!ctxResumePromise) ctxResumePromise = sharedCtx.resume().then(() => {}).catch(() => {})
      await ctxResumePromise
      ctxResumePromise = null
      if (sharedCtx.state === "suspended") reportSuspendedOnce()
    }
    return sharedCtx
  }
  try {
    sharedCtx = new AudioContext()
    if (sharedCtx.state === "suspended") {
      ctxResumePromise = sharedCtx.resume().then(() => {}).catch(() => {})
      await ctxResumePromise
      ctxResumePromise = null
      // 只播一次音效的会话同样要能看见「被自动播放策略拦截」：新 ctx 走同一出口。
      if (sharedCtx.state === "suspended") reportSuspendedOnce()
    } else {
      // 健康的 ctx 之后可能再次被策略挂起：允许下一次挂起再报告一次。
      suspendedReported = false
    }
    return sharedCtx
  } catch (e) {
    log.warn("AudioContext 创建失败，音效不可用", formatError(e))
    return null
  }
}
