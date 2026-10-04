import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event"
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("MemoryRevision")
const CHANGED_EVENT = "deskpet-memory-revision-changed"
const APPLIED_EVENT = "deskpet-memory-revision-applied"
const APPLY_TIMEOUT_MS = 5000
/** 跨窗口通道只在真实 Tauri WebView 存在；Node/L3 宿主没有 `window.__TAURI_INTERNALS__`，直接跳过。 */
function isTauriHost(): boolean {
  return typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}
// These are the two mutually exclusive windows that own conversation runs.
const RUNTIME_WINDOWS = new Set(["main", "e2e"])
type Change = { revision: number; requestId: string; sender: string }
type Applied = { requestId: string; receiver: string; okay: boolean }
const consumers = new Set<(revision: number) => void | Promise<void>>()
let subscription: Promise<UnlistenFn> | undefined

export function subscribeMemoryRevision(consumer: (revision: number) => void | Promise<void>): () => void {
  consumers.add(consumer)
  return () => consumers.delete(consumer)
}

/** Revision only: neither facts nor UI state travel through this channel. */
export async function initMemoryRevisionSync(): Promise<void> {
  if (!isTauriHost()) return
  subscription ??= listen<Change>(CHANGED_EVENT, event => {
    const change = event.payload
    if (!Number.isInteger(change.revision) || change.revision < 0 || !change.requestId || !change.sender) return
    void (async () => {
      const results = await Promise.allSettled([...consumers].map(consumer => Promise.resolve().then(() => consumer(change.revision))))
      for (const result of results) if (result.status === "rejected") log.error("记忆revision应用失败:", formatError(result.reason))
      await emitTo(change.sender, APPLIED_EVENT, {
        requestId: change.requestId, receiver: getCurrentWebviewWindow().label,
        okay: results.every(result => result.status === "fulfilled"),
      } satisfies Applied)
    })().catch(error => log.error("记忆revision回执发送失败:", formatError(error)))
  }).catch(error => { subscription = undefined; throw error })
  await subscription
}

/** UI commits wait until runtime owners have cancelled consumers of the old projection. */
export async function publishMemoryRevision(revision: number): Promise<void> {
  if (!isTauriHost()) {
    await Promise.all([...consumers].map(consumer => consumer(revision)))
    return
  }
  await initMemoryRevisionSync()
  const sender = getCurrentWebviewWindow().label
  const expected = new Set((await getAllWebviewWindows()).map(window => window.label).filter(label => RUNTIME_WINDOWS.has(label)))
  const requestId = crypto.randomUUID()
  let stop: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      void listen<Applied>(APPLIED_EVENT, event => {
        const applied = event.payload
        if (applied.requestId !== requestId || !expected.has(applied.receiver)) return
        if (!applied.okay) { reject(new Error("记忆已提交，但运行失效同步失败")); return }
        expected.delete(applied.receiver)
        if (!expected.size) resolve()
      }).then(unlisten => {
        stop = unlisten
        timer = setTimeout(() => reject(new Error("记忆已提交，但运行失效同步超时")), APPLY_TIMEOUT_MS)
        return emit(CHANGED_EVENT, { revision, requestId, sender } satisfies Change)
      }).then(() => { if (!expected.size) resolve() }).catch(reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
    stop?.()
  }
}
