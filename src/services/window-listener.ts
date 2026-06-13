// ==========================================
// Window Listener
// ==========================================

import { type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { pushAssistantMessage } from "@/features/chat";
import { generateActiveMessage } from "./active-context";
import type { StreamViewRef } from "./command-handler";

interface WindowChangePayload {
  title: string;
  content: string;
  cross_monitor: boolean;
}

async function sendToastNotification(body: string): Promise<void> {
  try {
    const { sendNotification, isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      const result = await requestPermission();
      granted = result === "granted";
    }
    if (granted) {
      sendNotification({ title: "糖糖", body });
    }
  } catch {}
}

if (typeof window !== "undefined") {
  (window as any).__testToast = async (msg?: string) => {
    const { sendNotification, isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      const result = await requestPermission();
      granted = result === "granted";
    }
    if (granted) {
      sendNotification({ title: "糖糖", body: msg || "测试通知" });
    }
  };
  console.log("[测试] __testToast('msg') / __testAI('标题') 就绪");
}

export async function initWindowListener(
  streamRef: Ref<StreamViewRef | null>,
  winSize: Ref<{ w: number; h: number }>,
): Promise<() => void> {
  const cleanups: (() => void)[] = [];

  try {
    const unlisten = await listen<WindowChangePayload>("window-changed", (event) => {
      const { title, content, cross_monitor } = event.payload;
      console.log("[监听] 窗口:", title.substring(0, 50), "| 跨屏:", cross_monitor);

      generateActiveMessage({ title, content: content || title, timestamp: Date.now() })
        .then((reply) => {
          if (reply) {
            pushAssistantMessage(reply);
            streamRef.value?.setExpression("smile");
            if (cross_monitor) sendToastNotification(reply);
          }
        });
    });
    cleanups.push(unlisten);
    console.log("[监听] 窗口监控已启动");
  } catch (e) {
    console.error("[监听] 启动失败:", e);
  }

  const observer = new ResizeObserver(() => {
    winSize.value = { w: window.innerWidth, h: window.innerHeight };
  });
  observer.observe(document.body);
  cleanups.push(() => observer.disconnect());

  return () => {
    for (const cleanup of cleanups) try { cleanup(); } catch {}
  };
}
