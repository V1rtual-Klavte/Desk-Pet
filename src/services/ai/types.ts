// ==========================================
// AI 模块类型定义
// ==========================================

/** 消息类型 —— 聊天记录的基本单元 */
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

/** AI 提供商抽象接口 */
export interface AIProvider {
  readonly name: string;
  generateReply(messages: Message[], systemPrompt: string): Promise<string>;
}

/** 角色/人格定义 */
export interface Character {
  id: string;
  name: string;
  promptPath: string;
}

/** 当前激活的角色状态 */
export interface CharacterState {
  currentId: string;
  characters: Character[];
}

/** AI 配置 */
export interface AIConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

// ==========================================
// 工具函数
// ==========================================

export function createMessageId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createUserMessage(text: string): Message {
  return { id: createMessageId(), role: "user", text, timestamp: Date.now() };
}

export function createAssistantMessage(text: string): Message {
  return { id: createMessageId(), role: "assistant", text, timestamp: Date.now() };
}
