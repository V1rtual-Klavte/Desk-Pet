// ==========================================
// 音效系统 — 共享 AudioContext
// ==========================================

let sharedCtx: AudioContext | null = null
let ctxResumePromise: Promise<void> | null = null

export async function getCtx(): Promise<AudioContext | null> {
  if (sharedCtx && sharedCtx.state !== "closed") {
    if (sharedCtx.state === "suspended") {
      if (!ctxResumePromise) ctxResumePromise = sharedCtx.resume().then(() => {}).catch(() => {})
      await ctxResumePromise
      ctxResumePromise = null
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
    return sharedCtx
  } catch { return null }
}
