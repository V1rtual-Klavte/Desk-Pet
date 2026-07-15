// ==========================================
// 窗口监听 —— 接收 Rust 事件，触发 AI / 表情响应
// ==========================================

import { type Ref } from "vue"
import { listen } from "@tauri-apps/api/event"
import { pushAssistantMessage, incrementUnanswered } from "@/services/agent"
import { checkWindowTiming } from "./monitor"
import { generateActiveMessage } from "@/services/agent"
import { playNotificationByBoundary } from "@/services/audio/registry"
import { windowMonitorConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import type { StreamViewRef } from "@/services/command-handler"

const log = createLogger("WinLis")

interface WindowChangePayload {
  title: string
  content: string
  is_pet_visible: boolean
}

export async function initWindowListener(
  streamRef: Ref<StreamViewRef | null>,
  winSize: Ref<{ w: number; h: number }>,
): Promise<() => void> {
  const cleanups: (() => void)[] = []

  try {
    const unlisten = await listen<WindowChangePayload>("window-changed", (event) => {
      if (!windowMonitorConfig.enabled) return
      const { title, content, is_pet_visible } = event.payload
      log.debug("窗口:", (title || "(空)").substring(0, 60))
      if (!checkWindowTiming(title)) return

      generateActiveMessage({ title, content: content || title, timestamp: Date.now() }).then((reply) => {
        if (reply) {
          pushAssistantMessage(reply)
          incrementUnanswered()
          streamRef.value?.setExpression("smile")
          playNotificationByBoundary()
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
