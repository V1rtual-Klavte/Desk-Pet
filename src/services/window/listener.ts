// ==========================================
// 窗口监听 —— 接收 Rust 事件，触发 AI / 表情响应
// ==========================================

import { type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { pushAssistantMessage, incrementUnanswered } from "@/services/ai";
import { checkWindowTiming } from "./monitor";
import { generateActiveMessage } from "./active-context";
import { playNotificationByBoundary } from "@/services/audio/registry";
import { windowMonitorConfig } from "@/services/config";
import { createLogger } from "@/services/logger";
import type { StreamViewRef } from "@/services/command-handler";

const log = createLogger("WinLis");

interface WindowChangePayload {
  title: string;
  content: string;
  cross_monitor: boolean;
  is_pet_minimized: boolean;
}

async function sendToastNotification(body: string): Promise<void> {
  try {
    const { sendNotification, isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) { const r = await requestPermission(); granted = r === "granted"; }
    if (granted) sendNotification({ title: "糖糖", body });
  } catch {}
}

export async function initWindowListener(
  streamRef: Ref<StreamViewRef | null>,
  winSize: Ref<{ w: number; h: number }>,
): Promise<() => void> {
  const cleanups: (() => void)[] = [];

  try {
    const unlisten = await listen<WindowChangePayload>("window-changed", (event) => {
      if (!windowMonitorConfig.enabled) return;
      const { title, content, cross_monitor, is_pet_minimized } = event.payload;
      log.debug("窗口:", (title || "(空)").substring(0, 60));
      if (!checkWindowTiming(title)) return;

      generateActiveMessage({ title, content: content || title, timestamp: Date.now() }).then((reply) => {
        if (reply) {
          pushAssistantMessage(reply);
          incrementUnanswered();
          streamRef.value?.setExpression("smile");
          playNotificationByBoundary();
          if (cross_monitor || is_pet_minimized) sendToastNotification(reply);
        }
      });
    });
    cleanups.push(unlisten);
    log.info("AI 窗口监控已启动");
  } catch (e) { log.error("监听启动失败", e instanceof Error ? e : undefined); }

  const observer = new ResizeObserver(() => { winSize.value = { w: window.innerWidth, h: window.innerHeight }; });
  observer.observe(document.body);
  cleanups.push(() => observer.disconnect());

  return () => { for (const c of cleanups) try { c(); } catch {} };
}
