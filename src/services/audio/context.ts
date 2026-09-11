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
 * 获取共享 AudioContext。
 *
 * 返回 null 表示音频不可用。各 effects 文件里大量的 `catch {}` 是**有意静默**的：
 * 单个音效节点构建失败不该影响交互，根因（context 拿不到 / 一直被自动播放策略
 * 挂起）在这里统一留痕，避免 30+ 处重复打日志。
 */
export async function getCtx(): Promise<AudioContext | null> {
  if (sharedCtx && sharedCtx.state !== "closed") {
    if (sharedCtx.state === "suspended") {
      if (!ctxResumePromise) ctxResumePromise = sharedCtx.resume().then(() => {}).catch(() => {})
      await ctxResumePromise
      ctxResumePromise = null
      // 只报一次：挂起态会持续命中，逐次打日志会淹没终端
      if (sharedCtx.state === "suspended" && !suspendedReported) {
        suspendedReported = true
        log.warn("AudioContext 处于 suspended（自动播放策略拦截），音效已静默跳过")
      }
    }
    return sharedCtx
  }
  try {
    sharedCtx = new AudioContext()
    if (sharedCtx.state === "suspended") {
      ctxResumePromise = sharedCtx.resume().then(() => {}).catch(() => {})
      await ctxResumePromise
      ctxResumePromise = null
    }
    suspendedReported = false
    return sharedCtx
  } catch (e) {
    log.warn("AudioContext 创建失败，音效不可用", formatError(e))
    return null
  }
}
