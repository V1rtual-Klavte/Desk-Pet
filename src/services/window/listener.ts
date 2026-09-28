// ==========================================
// 窗口监听 —— 接收 Rust 事件，触发主动搭话
// ==========================================

import { type Ref } from "vue"
import { listen } from "@tauri-apps/api/event"
import { pushAssistantMessage, incrementUnanswered, getActiveSessionId } from "@/services/agent"
import { checkWindowTiming, processTrigger } from "./monitor"
import { generateActiveMessage } from "@/services/agent"
import { playNotificationByBoundary } from "@/services/audio/registry"
import { windowMonitorConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("WinLis")

interface WindowChangePayload {
  title: string
  content: string
  is_pet_visible: boolean
}

/** 最近一次窗口变化。`observedAt` 由宿主在收到 payload 时打点 —— Rust 的线上载荷不带时间。 */
export interface WindowChangeSnapshot {
  title: string
  content: string
  observedAt: number
}

// 窗口 payload 的唯一缓存点：意图工具（window_info）经 getLastWindowChange 只读取
// 这里，不另建监听或第二份缓存。
let lastWindowChange: WindowChangeSnapshot | null = null

/**
 * 最近一次 `window-changed` 的快照；尚未收到事件时为 `null`。
 *
 * 监控关闭期间缓存保持为上一次的值（不清空），但工具入口会先查 `windowMonitorConfig.enabled`，
 * 关闭时一律如实回「未开启」，所以不会把过期 payload 当成当前窗口。
 */
export function getLastWindowChange(): WindowChangeSnapshot | null {
  return lastWindowChange
}

export async function initWindowListener(
  winSize: Ref<{ w: number; h: number }>,
): Promise<() => void> {
  const cleanups: (() => void)[] = []

  try {
    const unlisten = await listen<WindowChangePayload>("window-changed", (event) => {
      if (!windowMonitorConfig.enabled) return
      const { title, content, is_pet_visible } = event.payload
      // 缓存写在 enabled 早退之后：关闭监控时不得让 window_info 拿到「有效」的窗口状态。
      lastWindowChange = { title, content, observedAt: Date.now() }
      log.debug("窗口:", (title || "(空)").substring(0, 60))
      if (!checkWindowTiming(title)) return

      // 放行之后必须立刻进入冷却并暂停窗口监控：这一步此前只在零调用者的
      // processTrigger 里，于是配置的冷却时长、pause_monitor / resume_monitor
      // 与 pauseExtraMs 全都从未生效过。
      processTrigger({ source: "ai", message: content || title })

      generateActiveMessage({ title, content: content || title, timestamp: Date.now() }).then((reply) => {
        if (reply) {
          pushAssistantMessage(reply, getActiveSessionId())
          // 把递增后的未回复数传进去，否则分级提示音恒为 surface 级。
          playNotificationByBoundary(incrementUnanswered())
        }
      })
    })
    cleanups.push(unlisten)
    log.info("AI 窗口监控已启动")
  } catch (e) { log.error("监听启动失败", e instanceof Error ? e : undefined) }

  const observer = new ResizeObserver(() => { winSize.value = { w: window.innerWidth, h: window.innerHeight } })
  observer.observe(document.body)
  cleanups.push(() => observer.disconnect())

  return () => { for (const c of cleanups) try { c(); } catch (e) { log.debug("ResizeObserver cleanup", e) } }
}
