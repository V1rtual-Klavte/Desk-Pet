import { reactive } from "vue";
import type { Message } from "../types/message";
import { createUserMessage, createAssistantMessage } from "../types/message";

// ==========================================
// 上下文管理常量
// ==========================================

/** 发送给模型的最大上下文消息条数 */
const MAX_CONTEXT_MESSAGES = 20;

// ==========================================
// 响应式聊天记录
// ==========================================
export const chatHistory = reactive<Message[]>([]);

/** 初始化欢迎消息 */
export function initWelcome(text: string): void {
  if (chatHistory.length === 0) {
    chatHistory.push(createAssistantMessage(text));
  }
}

// ==========================================
// 消息管理
// ==========================================

/** 添加用户消息 */
export function pushUserMessage(text: string): Message {
  const msg = createUserMessage(text);
  chatHistory.push(msg);
  return msg;
}

/** 添加 AI 消息 */
export function pushAssistantMessage(text: string): Message {
  const msg = createAssistantMessage(text);
  chatHistory.push(msg);
  return msg;
}

/** 获取用于发送给模型的裁剪上下文（最近 N 条） */
export function getContextMessages(): Message[] {
  return chatHistory.slice(-MAX_CONTEXT_MESSAGES);
}

/** 获取完整聊天记录 */
export function getFullHistory(): Message[] {
  return [...chatHistory];
}

/** 清空聊天记录 */
export function clearHistory(): void {
  chatHistory.splice(0, chatHistory.length);
}

/** 删除指定消息 */
export function deleteMessage(id: string): boolean {
  const idx = chatHistory.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  chatHistory.splice(idx, 1);
  return true;
}
