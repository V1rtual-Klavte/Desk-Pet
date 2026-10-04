import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event"
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { applyTopicSourceInvalidation } from "./topics"
import { clearSilentUnderstandingOwned } from "./scheduler"

const log = createLogger("ObservationOwner")
const REQUEST_EVENT = "deskpet-observation-governance-request"
const APPLIED_EVENT = "deskpet-observation-governance-applied"
const APPLY_TIMEOUT_MS = 5_000
const RUNTIME_WINDOWS = new Set(["main", "e2e"])

type Operation = { action: "clear" } | { action: "invalidate_topics"; sessionId: string; entryIds: string[] }
type Request = Operation & { requestId: string; sender: string; target: string }
interface Response { requestId: string; target: string; okay: boolean; error?: string }

let subscription: Promise<UnlistenFn> | undefined

function isTauriHost(): boolean {
  return typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

async function applyOwned(operation: Operation): Promise<void> {
  if (operation.action === "clear") return clearSilentUnderstandingOwned()
  if (operation.sessionId.length === 0 || operation.entryIds.length === 0
    || operation.sessionId.length > 512 || operation.entryIds.length > 10_000
    || operation.entryIds.some(id => typeof id !== "string" || id.length === 0 || id.length > 256)) {
    throw new Error("观察来源失效参数无效")
  }
  await applyTopicSourceInvalidation(operation.sessionId, operation.entryIds)
}

/** Install only in the main/e2e runtime window, independently from the silent-access toggle. */
export async function initObservationGovernance(): Promise<void> {
  if (!isTauriHost() || !RUNTIME_WINDOWS.has(getCurrentWebviewWindow().label)) return
  // 治理入口不依赖可选派生文件加载；坏文件仍可由用户明确清除恢复。
  subscription ??= listen<Request>(REQUEST_EVENT, ({ payload }) => {
    const receiver = getCurrentWebviewWindow().label
    if (payload.target !== receiver || !payload.requestId || !payload.sender) return
    void applyOwned(payload).then(async () => {
      await emitTo(payload.sender, APPLIED_EVENT, { requestId: payload.requestId, target: receiver, okay: true } satisfies Response)
    }).catch(async error => {
      log.error("主窗口应用观察来源治理失败", formatError(error))
      try {
        await emitTo(payload.sender, APPLIED_EVENT, {
          requestId: payload.requestId, target: receiver, okay: false, error: formatError(error),
        } satisfies Response)
      } catch (responseError) {
        log.error("观察治理回执发送失败", formatError(responseError))
      }
    })
  }).catch(error => { subscription = undefined; throw error })
  await subscription
}

export async function stopObservationGovernance(): Promise<void> {
  const current = subscription
  subscription = undefined
  if (current) await (await current)()
}

async function routeToOwner(operation: Operation): Promise<void> {
  if (!isTauriHost()) return applyOwned(operation)
  const current = getCurrentWebviewWindow().label
  if (RUNTIME_WINDOWS.has(current)) return applyOwned(operation)
  const windows = await getAllWebviewWindows()
  const owner = windows.find(item => item.label === "main") ?? windows.find(item => item.label === "e2e")
  if (!owner) throw new Error("主运行窗口暂不可用，观察治理操作未提交")
  const requestId = crypto.randomUUID()
  let unlisten: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const applied = await new Promise<Response>((resolve, reject) => {
      void listen<Response>(APPLIED_EVENT, event => {
        if (event.payload.requestId === requestId && event.payload.target === owner.label) resolve(event.payload)
      }).then(stop => {
        unlisten = stop
        timer = setTimeout(() => reject(new Error("主运行窗口未确认观察治理")), APPLY_TIMEOUT_MS)
        return emitTo(owner.label, REQUEST_EVENT, { ...operation, requestId, sender: current, target: owner.label } satisfies Request)
      }).catch(reject)
    })
    if (!applied.okay) throw new Error(applied.error || "主运行窗口拒绝观察治理")
  } finally {
    if (timer) clearTimeout(timer)
    if (unlisten) unlisten()
  }
}

/** Cross-window commands carry only IDs; source text remains in the runtime window. */
export async function clearSilentUnderstanding(): Promise<void> {
  await routeToOwner({ action: "clear" })
}

export async function invalidateTopicSources(sessionId: string, entryIds: string[]): Promise<void> {
  await routeToOwner({ action: "invalidate_topics", sessionId, entryIds })
}
