import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import type { ProactiveControl } from "@/services/agent/memory/protocol"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const REQUEST_EVENT = "deskpet-proactive-control-request"
const RESPONSE_EVENT = "deskpet-proactive-control-response"
const STATE_EVENT = "deskpet-proactive-control-state"
const REQUEST_TIMEOUT_MS = 5_000
const log = createLogger("ProactiveControlBridge")
type Request = { requestId: string; sender: string; enabled?: boolean }
type Response = { requestId: string; control?: ProactiveControl; error?: string }
type ControlHandler = (enabled?: boolean) => Promise<ProactiveControl>

function isTauriHost(): boolean {
  return typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

/** Main-window owner handles settings requests, so an auxiliary settings window never invents a session owner. */
export async function initProactiveControlBridge(handler: ControlHandler): Promise<UnlistenFn | undefined> {
  if (!isTauriHost()) return undefined
  return listen<Request>(REQUEST_EVENT, event => {
    const request = event.payload
    if (!request?.requestId || request.sender === getCurrentWebviewWindow().label) return
    void handler(request.enabled).then(async control => {
      await publishProactiveControl(control)
      await emitTo(request.sender, RESPONSE_EVENT, { requestId: request.requestId, control } satisfies Response)
    }).catch(async error => {
      log.warn("跨窗口主动控制失败:", formatError(error))
      try {
        await emitTo(request.sender, RESPONSE_EVENT, { requestId: request.requestId, error: formatError(error) } satisfies Response)
      } catch (deliveryError) {
        // The requesting window may close while SQLite arbitration is in flight; the timeout belongs to its caller.
        log.info("主动控制失败回执无法送达:", formatError(deliveryError))
      }
    })
  }).catch(error => { log.warn("主动控制跨窗口监听安装失败:", formatError(error)); throw error })
}

export async function requestProactiveControl(enabled?: boolean): Promise<ProactiveControl> {
  if (!isTauriHost()) throw new Error("主动控制仅在桌面应用可用")
  const sender = getCurrentWebviewWindow().label
  const requestId = crypto.randomUUID()
  let unlisten: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<ProactiveControl>((resolve, reject) => {
      void listen<Response>(RESPONSE_EVENT, event => {
        const response = event.payload
        if (response.requestId !== requestId) return
        if (response.error) { reject(new Error(response.error)); return }
        if (response.control) resolve(response.control)
        else reject(new Error("主动控制未返回状态"))
      }).then(stop => {
        unlisten = stop
        timer = setTimeout(() => reject(new Error("主窗口主动控制请求超时")), REQUEST_TIMEOUT_MS)
        return emit(REQUEST_EVENT, { requestId, sender, enabled } satisfies Request)
      }).catch(reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
    unlisten?.()
  }
}

export async function subscribeProactiveControl(listener: (control: ProactiveControl) => void): Promise<UnlistenFn> {
  return listen<ProactiveControl>(STATE_EVENT, event => listener(event.payload))
}

export async function publishProactiveControl(control: ProactiveControl): Promise<void> {
  if (isTauriHost()) await emit(STATE_EVENT, control)
}
