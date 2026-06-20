// ==========================================
// 聊天记录 & 未回复追踪
// ==========================================

import { reactive, ref } from "vue";
import type { Message } from "./types";
import { createUserMessage, createAssistantMessage } from "./types";
import { aiConfig } from "@/services/config";

const MAX_CONTEXT_MESSAGES = aiConfig.maxContextMessages;

export const chatHistory = reactive<Message[]>([]);

export function initWelcome(text: string): void {
  if (chatHistory.length === 0) {
    chatHistory.push(createAssistantMessage(text));
  }
}

// ── 未回复追踪 ──
const UNANSWERED_KEY = "deskpet_unanswered";

function loadUnanswered(): number {
  try {
    const raw = localStorage.getItem(UNANSWERED_KEY);
    const val = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(val) && val >= 0 ? val : 0;
  } catch { return 0; }
}
function saveUnanswered(count: number): void {
  try { localStorage.setItem(UNANSWERED_KEY, String(count)); } catch {}
}

export const unansweredCount = ref(loadUnanswered());

export function incrementUnanswered(): void {
  unansweredCount.value += 1;
  saveUnanswered(unansweredCount.value);
}
export function resetUnanswered(): void {
  if (unansweredCount.value !== 0) {
    unansweredCount.value = 0;
    saveUnanswered(0);
  }
}

// ── 消息管理 ──
export function pushUserMessage(text: string): Message {
  const msg = createUserMessage(text);
  chatHistory.push(msg);
  return msg;
}
export function pushAssistantMessage(text: string): Message {
  const msg = createAssistantMessage(text);
  chatHistory.push(msg);
  return msg;
}
export function getContextMessages(): Message[] {
  return chatHistory.slice(-MAX_CONTEXT_MESSAGES);
}
export function getFullHistory(): Message[] {
  return [...chatHistory];
}
export function clearHistory(): void {
  chatHistory.splice(0, chatHistory.length);
}
export function deleteMessage(id: string): boolean {
  const idx = chatHistory.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  chatHistory.splice(idx, 1);
  return true;
}
