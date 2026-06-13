// ==========================================
// Window Listener（仅 AI 识别）
// ==========================================

import { type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { pushAssistantMessage } from "@/features/chat";
import { checkWindowTiming } from "./window-monitor";
import { generateActiveMessage } from "./active-context";
import type { StreamViewRef } from "./command-handler";

interface WindowChangePayload {
  title: string;
  content: string;
  cross_monitor: boolean;
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
      const { title, content, cross_monitor } = event.payload;
      if (!checkWindowTiming(title)) return;

      generateActiveMessage({ title, content: content || title, timestamp: Date.now() }).then((reply) => {
        if (reply) {
          pushAssistantMessage(reply);
          streamRef.value?.setExpression("smile");
          if (cross_monitor) sendToastNotification(reply);
        }
      });
    });
    cleanups.push(unlisten);
    console.log("[监听] AI 窗口监控已启动");
  } catch (e) { console.error("[监听] 失败:", e); }

  const observer = new ResizeObserver(() => { winSize.value = { w: window.innerWidth, h: window.innerHeight }; });
  observer.observe(document.body);
  cleanups.push(() => observer.disconnect());

  return () => { for (const c of cleanups) try { c(); } catch {} };
}
