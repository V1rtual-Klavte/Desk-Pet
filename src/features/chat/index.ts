/**
 * features/chat —— AI 聊天模块统一导出入口
 */

// ── 类型 ──
export type { Message } from "./types/message";
export type { AIProvider } from "./types/ai";
export type { Character, CharacterState } from "./types/character";

// ── 配置 ──
export { setAIConfig, getAIConfig, isAIConfigured, getSystemPrompt } from "./config/ai-config";
export type { AIConfig } from "./config/ai-config";

// ── Provider ──
export { DeepSeekProvider } from "./providers/deepseek-provider";
export { OpenAIProvider } from "./providers/openai-provider";

// ── 服务 ──
export {
  chatHistory,
  pushUserMessage,
  pushAssistantMessage,
  getContextMessages,
  getFullHistory,
  clearHistory,
  deleteMessage,
  initWelcome,
} from "./services/chat-service";

export { AIService } from "./services/ai-service";
export { CharacterService } from "./services/character-service";
export { MemoryService } from "./services/memory-service";
export type { MemoryEntry } from "./services/memory-service";

// ── 工具 ──
export { createMessageId, createUserMessage, createAssistantMessage } from "./types/message";

// ==========================================
// 本地 import（sendMessage / initChat 内部使用）
// ==========================================
import { getSystemPrompt } from "./config/ai-config";
import { DeepSeekProvider } from "./providers/deepseek-provider";
import { AIService } from "./services/ai-service";
import {
  chatHistory,
  pushUserMessage,
  pushAssistantMessage,
  getContextMessages,
  initWelcome,
} from "./services/chat-service";
import { CharacterService } from "./services/character-service";

let aiServiceInstance: AIService | null = null;

function getAIService(): AIService {
  if (!aiServiceInstance) {
    aiServiceInstance = new AIService(new DeepSeekProvider());
  }
  return aiServiceInstance;
}

export async function initChat(welcomeText?: string): Promise<void> {
  // 触发 CharacterService 加载（注册 prompt getter）
  console.log("[Chat] 当前人格:", CharacterService.current().name);
  if (welcomeText) initWelcome(welcomeText);
}

export async function sendMessage(text: string): Promise<string> {
  pushUserMessage(text);

  const context = getContextMessages();
  const systemPrompt = getSystemPrompt();
  const aiService = getAIService();
  const reply = await aiService.generateReply(context, systemPrompt, text);

  pushAssistantMessage(reply);
  return reply;
}

// ==========================================
// HMR 热更新
// ==========================================
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.log("[Chat] 聊天模块热更新完成，人格:", CharacterService.current().name);
  });
}
