// ==========================================
// 全局异常体系 —— 单一出口 + 可见性
//
// `reportError` 是 Node 领域的唯一错误出口：写日志 + 通知宿主落盘 + 按需展示。
// 覆盖层是 DOM 投影：只在有 DOM 的宿主里渲染，Node 宿主只留内存条目（见 pushEntry）。
// ==========================================

import { getHostBridge, getHostEnvironment } from "@/services/host"
import { createLogger } from "@/services/logger"
import { errorsConfig } from "@/services/config"
import { errorDetail, formatError } from "./format"

const log = createLogger("Error")

const MAX_ENTRIES = 20
/** 覆盖层层级取 CSS z-index 上界，压过任何页面内层级 */
const OVERLAY_Z = "2147483647"

export interface ReportOptions {
  kind?: string
  fatal?: boolean
  /**
   * 是否允许弹覆盖层，默认允许。
   * 传 false 用于**预期内**的失败（如精简 Profile 缺少可选素材的 404）——
   * 这类情况只该记 warn 留痕，不该拿全屏异常去吓用户。
   */
  overlay?: boolean
}

interface Entry {
  time: string
  source: string
  kind: string
  message: string
  detail: string
}

const entries: Entry[] = []
let overlayEl: HTMLElement | null = null

/**
 * 是否弹覆盖层。
 *
 * 在**报错时**惰性求值，而非安装时：早期报错可能在 initConfig() 之前发生，
 * 那时读配置只能拿到内置默认值；等到真正报错时，配置通常已就绪；即便 initConfig()
 * 失败，cfg 仍持有内置 CONFIG.yaml 的值，不会崩。
 */
function shouldShowOverlay(): boolean {
  const mode = errorsConfig.overlay
  if (mode === "always") return true
  if (mode === "never") return false
  // auto = 开发模式弹：判据来自宿主运行模式端口（ServerWelcome.runtimeMode），
  // 不读 import.meta.env。端口未注入时抛错 —— reportError 的外层 try 会兜住，
  // 覆盖层不弹但日志与上报照走（启动早期的接线错误）。
  return getHostEnvironment().runtimeMode === "development"
}

/** 唯一错误出口：写日志 + 通知 Rust 落盘 + 按需展示 */
export function reportError(source: string, value: unknown, options: ReportOptions = {}): void {
  try {
    const kind = options.kind ?? "error"
    const message = formatError(value)
    const detail = errorDetail(value)
    const allowOverlay = options.overlay !== false

    if (allowOverlay) {
      log.error(`[${source}] ${kind}${options.fatal ? " (fatal)" : ""}:`, detail)
    } else {
      log.warn(`[${source}] ${kind}:`, detail)
    }

    // Rust 侧再记一份：即使界面全挂，终端与日志文件里也有完整记录。
    // 取用口在桥未注入时**同步抛**，fire-and-forget 的 `.catch()` 接不住；就地捕获，
    // 不让「上报通道缺失」连累下面的覆盖层展示 —— 用户可见的异常不能因为一份冗余
    // 记录通道不存在而消失。本次报错已由上面的 log.error/warn 留痕（统一留痕点：
    // reportError 自身已写 logger；本处再报会递归）[保留已登记 §4.2]
    try {
      getHostBridge().request("report_frontend_error", {
        source: `${source}/${kind}`,
        message,
        stack: detail,
      }).catch(() => {
        // Tauri 未注入（例如纯浏览器调试）时忽略：根因已由上面的 log.error/warn 记录
        // （统一留痕点：reportError 自身已写 logger；本处再报会递归）[保留已登记 §4.2]
      })
    } catch {
      // 桥未注入（同步抛）：与上一个分支同因，Rust 副本放弃、覆盖层照走
    }

    if (allowOverlay && shouldShowOverlay()) pushEntry({ time: hms(), source, kind, message, detail })
  } catch {
    // 上报自身失败不能再抛（否则递归）：这里是异常上报链的最后兜底层，
    // 没有更外层的出口可写 [保留已登记 §4.2]
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
    // 无 DOM 的宿主（Node harness）只留内存条目：覆盖层是 UI 投影，日志与宿主上报
    // 已在 reportError 完成。
    if (typeof document !== "undefined") renderOverlay()
  } catch {
    // 渲染失败不能再抛：条目已进 entries、异常原文已留痕，覆盖层只是展示层
    // [保留已登记 §4.2]
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
  title.textContent = "运行时异常"

  const count = document.createElement("span")
  count.id = "global-error-count"
  count.style.cssText = "opacity:.6;font-weight:400;"

  const spacer = document.createElement("span")
  spacer.style.cssText = "flex:1"

  const copyBtn = button("复制详情", () => {
    copyText(entries.map((e) => `[${e.time}] ${e.source} · ${e.kind}\n${e.detail}`).join("\n\n"))
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

/**
 * 覆盖层「复制详情」。不用 `navigator.clipboard`：本文件在 Node 领域图的传递闭包里
 * （error 桶被引导 import），W0/W2 的产物守卫要求闭包中不出现 `navigator.` 字面量。
 * 临时 textarea + `document.execCommand("copy")` 在 WebView 里由用户点击手势触发、无需权限；
 * 失败只留痕（复制是便利功能，不阻断覆盖层）。
 */
function copyText(text: string): void {
  try {
    const area = document.createElement("textarea")
    area.value = text
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    area.remove()
    if (!copied) log.warn("复制异常详情失败: execCommand(copy) 返回 false")
  } catch (error) {
    log.warn("复制异常详情失败:", formatError(error))
  }
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
    text.textContent = getHostEnvironment().runtimeMode === "development" ? e.detail : e.message

    item.append(head, text)
    body.appendChild(item)
  }

  if (counter) counter.textContent = entries.length > 1 ? `共 ${entries.length} 条` : ""
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
