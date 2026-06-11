// ==========================================
// 聊天命令处理器
// 从 App.vue 抽离，处理聊天文本中的表情切换和窗口命令
// ==========================================

import { invoke } from "@tauri-apps/api/core";
import { matchExpression } from "./expressions";

export interface StreamViewRef {
  setExpression(name: string): void;
}

/**
 * 处理聊天发送的文本命令。
 * - 匹配表情关键词 → 切换 StreamView 表情
 * - 匹配 "open win" / "close win" → 调用 Tauri 命令
 *
 * @param text  用户发送的原始文本
 * @param streamRef  StreamView 组件引用，用于切换表情
 */
export function handleCommand(text: string, streamRef: StreamViewRef | null): void {
  if (!streamRef) return;

  // 表情匹配：取第一个命中规则，防止多个 if 连续覆盖
  const expr = matchExpression(text);
  if (expr) {
    streamRef.setExpression(expr);
  }

  // 窗口模拟器控制命令
  const lower = text.toLowerCase();
  if (lower.includes("open win")) {
    invoke("open_windows_sim").catch(() => {});
  }
  if (lower.includes("close win")) {
    invoke("close_windows_sim").catch(() => {});
  }
}
