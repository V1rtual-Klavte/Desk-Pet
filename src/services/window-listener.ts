// ==========================================
// Window Listener
// ==========================================

import { type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { pushAssistantMessage } from "@/features/chat";
import { checkWindow } from "./window-monitor";
import type { StreamViewRef } from "./command-handler";

interface WindowChangePayload {
  title: string;
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

async function areMonitorsDifferent(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("are_monitors_different");
  } catch {
    return false;
  }
}

// ==========================================
// 测试
// ==========================================
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
      console.log("[测试] Toast 已发送");
    }
  };

  // 跳过停留计时器，直接走匹配+通知链路
  (window as any).__testWindow = async (title?: string, cross?: boolean) => {
    const t = title || "Visual Studio Code";
    // 用 checkWindow 如果已稳定过，否则直接用 known reply
    const reply = checkWindow(t) || `检测到你在使用 ${t}，要一起吗？`;
    console.log("[测试] 模拟窗口:", t, "reply:", reply);
    pushAssistantMessage(reply);
    const isCross = cross ?? await areMonitorsDifferent();
    console.log("[测试] cross_monitor:", isCross);
    if (isCross) {
      await sendToastNotification(reply);
      console.log("[测试] Toast 已发送");
    }
  };

  console.log("[测试] __testWindow('微信', true) / __testToast('msg') 就绪");
}

export async function initWindowListener(
  streamRef: Ref<StreamViewRef | null>,
  winSize: Ref<{ w: number; h: number }>,
): Promise<() => void> {
  const cleanups: (() => void)[] = [];

  try {
    const unlisten = await listen<WindowChangePayload>("window-changed", (event) => {
      const reply = checkWindow(event.payload.title);
      if (reply) {
        pushAssistantMessage(reply);
        streamRef.value?.setExpression("smile");
        if (event.payload.cross_monitor) {
          sendToastNotification(reply);
        }
      }
    });
    cleanups.push(unlisten);
  } catch {}

  const observer = new ResizeObserver(() => {
    winSize.value = { w: window.innerWidth, h: window.innerHeight };
  });
  observer.observe(document.body);
  cleanups.push(() => observer.disconnect());

  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch {}
    }
  };
}
