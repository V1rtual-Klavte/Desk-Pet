// ==========================================
// 全局异常体系 —— 拦截 + 可见
//
// 刻意只用原生 DOM，不依赖 Vue / config / paths：
// 它必须在 mount() 之前就装好，并且能在 initPaths() / initConfig() 失败时
// 照常弹出 —— 「启动失败白屏」正是它要覆盖的首要场景。
// ==========================================

import type { App } from "vue"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { errorsConfig } from "@/services/config"
import { errorDetail, formatError } from "./format"

const log = createLogger("Error")

const MAX_ENTRIES = 20
/** 压过现有最大层级 9999（App.vue 的右键菜单） */
const OVERLAY_Z = "2147483647"

export interface ReportOptions {
  kind?: string
  fatal?: boolean
}

interface Entry {
  time: string
  source: string
  kind: string
  message: string
  detail: string
}

const entries: Entry[] = []
/** 显式覆写（如 live-test 传 `overlay: false`）；null = 走配置 */
let overlayOverride: boolean | null = null
let overlayEl: HTMLElement | null = null

/**
 * 是否弹覆盖层。
 *
 * 在**报错时**惰性求值，而非安装时：拦截器必须在 initConfig() 之前就装好
 * （否则启动失败就没人接），那时读配置只能拿到内置默认值。等到真正报错时，
 * 配置通常已就绪；即便 initConfig() 失败，cfg 仍持有内置 CONFIG.yaml 的值，不会崩。
 */
function shouldShowOverlay(): boolean {
  if (overlayOverride !== null) return overlayOverride
  const mode = errorsConfig.overlay
  if (mode === "always") return true
  if (mode === "never") return false
  return import.meta.env.DEV
}

/** 唯一错误出口：写日志 + 通知 Rust 落盘 + 按需展示 */
export function reportError(source: string, value: unknown, options: ReportOptions = {}): void {
  try {
    const kind = options.kind ?? "error"
    const message = formatError(value)
    const detail = errorDetail(value)

    log.error(`[${source}] ${kind}${options.fatal ? " (fatal)" : ""}:`, detail)

    // Rust 侧再记一份：即使界面全挂，终端与日志文件里也有完整记录
    invoke("report_frontend_error", {
      source: `${source}/${kind}`,
      message,
      stack: detail,
    }).catch(() => {
      // Tauri 未注入（例如纯浏览器调试）时忽略，console 已有记录
    })

    if (shouldShowOverlay()) pushEntry({ time: hms(), source, kind, message, detail })
  } catch {
    // 上报自身失败不能再抛，否则递归
  }
}

/** 安装 window 级拦截。4 个窗口入口都应最先调用。 */
export function installGlobalHandlers(
  source: string,
  options: { overlay?: boolean } = {},
): void {
  overlayOverride = typeof options.overlay === "boolean" ? options.overlay : null

  // capture=true：资源加载失败（img/script/link）不会冒泡，只能靠捕获阶段拿到
  window.addEventListener(
    "error",
    (event: ErrorEvent) => {
      const target = event.target
      if (target && target !== (window as unknown as EventTarget) && !event.error) {
        const el = target as HTMLElement
        const url = (el as HTMLImageElement).src || (el as HTMLScriptElement).src || ""
        reportError(source, new Error(`资源加载失败: <${el.tagName.toLowerCase()}> ${url}`), {
          kind: "resource",
        })
        return
      }
      reportError(source, event.error ?? event.message, { kind: "window.onerror" })
    },
    true,
  )

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    reportError(source, event.reason, { kind: "unhandledrejection" })
  })
}

/**
 * 挂 Vue 组件级错误处理。
 * 注意它接不住 onMounted(async () => {...}) 里 reject 的 Promise，
 * 那类要靠上面的 unhandledrejection 兜底 —— 两者缺一不可。
 */
export function installVueErrorHandler(app: App, source: string): void {
  app.config.errorHandler = (err, _instance, info) => {
    reportError(source, err, { kind: `vue:${info}` })
  }
}

// ── 覆盖层渲染 ──

function hms(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function pushEntry(entry: Entry): void {
  try {
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries.shift()
    renderOverlay()
  } catch {
    // 渲染失败不能再抛
  }
}

function ensureOverlay(): HTMLElement {
  if (overlayEl) return overlayEl

  const root = document.createElement("div")
  root.id = "global-error-overlay"
  root.style.cssText = [
    "position:fixed",
    "inset:0",
    `z-index:${OVERLAY_Z}`,
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:16px",
    "background:var(--color-overlay-bg,rgba(30,8,16,.72))",
    "font-family:var(--font-ui,monospace)",
  ].join(";")

  const card = document.createElement("div")
  card.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "max-width:100%",
    "max-height:100%",
    "min-width:320px",
    "padding:14px",
    "border-radius:8px",
    "border:1px solid var(--color-confirm-border,#4a2540)",
    "background:var(--color-confirm-bg,#2a1020)",
    "color:var(--color-confirm-text,#f0e0f0)",
    "font-size:12px",
    "line-height:1.6",
  ].join(";")

  const head = document.createElement("div")
  head.style.cssText =
    "display:flex;align-items:center;gap:8px;margin-bottom:8px;font-weight:700;flex-shrink:0;"

  const title = document.createElement("span")
  title.textContent = "⚠️ 运行时异常"

  const count = document.createElement("span")
  count.id = "global-error-count"
  count.style.cssText = "opacity:.6;font-weight:400;"

  const spacer = document.createElement("span")
  spacer.style.cssText = "flex:1"

  const copyBtn = button("复制详情", () => {
    const text = entries
      .map((e) => `[${e.time}] ${e.source} · ${e.kind}\n${e.detail}`)
      .join("\n\n")
    void navigator.clipboard?.writeText(text).catch(() => {})
  })

  const closeBtn = button("关闭", () => hideOverlay())

  head.append(title, count, spacer, copyBtn, closeBtn)

  const body = document.createElement("div")
  body.id = "global-error-entries"
  body.style.cssText = "overflow:auto;white-space:pre-wrap;word-break:break-all;"

  card.append(head, body)
  root.appendChild(card)
  document.body.appendChild(root)

  overlayEl = root
  return root
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button")
  el.textContent = label
  el.style.cssText = [
    "padding:3px 10px",
    "border-radius:4px",
    "cursor:pointer",
    "border:1px solid var(--color-confirm-border,#4a2540)",
    "background:transparent",
    "color:inherit",
    "font:inherit",
  ].join(";")
  el.addEventListener("click", onClick)
  return el
}

function renderOverlay(): void {
  const root = ensureOverlay()
  const body = root.querySelector<HTMLElement>("#global-error-entries")
  const counter = root.querySelector<HTMLElement>("#global-error-count")
  if (!body) return

  body.textContent = ""
  for (const e of entries) {
    const item = document.createElement("div")
    item.style.cssText = "padding:8px 0;border-top:1px solid rgba(255,255,255,.12);"

    const head = document.createElement("div")
    head.style.cssText = "opacity:.7;margin-bottom:4px;"
    head.textContent = `[${e.time}] ${e.source} · ${e.kind}`

    const text = document.createElement("div")
    // dev 给完整 stack；生产只给 message，用户可点「复制详情」发给开发者
    text.textContent = import.meta.env.DEV ? e.detail : e.message

    item.append(head, text)
    body.appendChild(item)
  }

  if (counter) counter.textContent = entries.length > 1 ? `共 ${entries.length} 条` : ""
}

/** 关闭覆盖层（条目保留：下次异常会带着历史一起重新弹出） */
export function dismissErrors(): void {
  hideOverlay()
}

function hideOverlay(): void {
  overlayEl?.remove()
  overlayEl = null
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideOverlay()
  })
}
