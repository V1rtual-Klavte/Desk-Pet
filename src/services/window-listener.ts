// ==========================================
// 窗口监听器
// 从 App.vue 抽离：窗口切换检测 + 窗口尺寸监听
// 返回 cleanup 函数供 onUnmounted 释放资源
// ==========================================

import { type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { chatHistory } from "./chat";
import { checkWindow } from "./window-monitor";
import type { StreamViewRef } from "./command-handler";

/**
 * 初始化窗口事件监听和 ResizeObserver。
 * 返回一个清理函数，调用后会释放所有资源。
 *
 * @param streamRef  StreamView 组件引用，用于切换表情
 * @param winSize    窗口尺寸响应式引用，由 ResizeObserver 更新
 * @returns          清理函数（在 onUnmounted 中调用）
 */
export async function initWindowListener(
  streamRef: Ref<StreamViewRef | null>,
  winSize: Ref<{ w: number; h: number }>,
): Promise<() => void> {
  const cleanups: (() => void)[] = [];

  // 1) 窗口标题变化监听
  try {
    const unlisten = await listen<string>("window-changed", (event) => {
      const reply = checkWindow(event.payload);
      if (reply) {
        chatHistory.push({ role: "assistant", text: reply });
        streamRef.value?.setExpression("smile");
      }
    });
    cleanups.push(unlisten);
  } catch {
    // 监听失败不阻塞应用
  }

  // 2) 窗口尺寸变化监听
  const observer = new ResizeObserver(() => {
    winSize.value = { w: window.innerWidth, h: window.innerHeight };
  });
  observer.observe(document.body);
  cleanups.push(() => observer.disconnect());

  // 返回清理函数
  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* 忽略清理异常 */ }
    }
  };
}
