// ==========================================
// Window Listener
// App.vue event listening: window focus + resize
// Returns cleanup function for onUnmounted
// ==========================================

import { type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { pushAssistantMessage } from "@/features/chat";
import { checkWindow } from "./window-monitor";
import type { StreamViewRef } from "./command-handler";

/**
 * Initialize window event listeners and ResizeObserver.
 * Returns a cleanup function for resource release.
 *
 * @param streamRef  StreamView component ref for expression switching
 * @param winSize    Reactive window size ref, updated by ResizeObserver
 * @returns          Cleanup function (call in onUnmounted)
 */
export async function initWindowListener(
  streamRef: Ref<StreamViewRef | null>,
  winSize: Ref<{ w: number; h: number }>,
): Promise<() => void> {
  const cleanups: (() => void)[] = [];

  // 1) Window focus change listener
  try {
    const unlisten = await listen<string>("window-changed", (event) => {
      const reply = checkWindow(event.payload);
      if (reply) {
        pushAssistantMessage(reply);
        streamRef.value?.setExpression("smile");
      }
    });
    cleanups.push(unlisten);
  } catch {
    // Listener failure does not block the app
  }

  // 2) Window resize observer
  const observer = new ResizeObserver(() => {
    winSize.value = { w: window.innerWidth, h: window.innerHeight };
  });
  observer.observe(document.body);
  cleanups.push(() => observer.disconnect());

  // Return cleanup function
  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* ignore cleanup errors */ }
    }
  };
}
