/**
 * 消息类型 —— 聊天记录的基本单元
 */
export interface Message {
  /** 唯一标识，用于排序/删除/存档 */
  id: string;
  /** 发送者角色 */
  role: "user" | "assistant";
  /** 消息文本内容 */
  text: string;
  /** Unix 毫秒时间戳 */
  timestamp: number;
}

/** 生成唯一 ID */
export function createMessageId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 创建用户消息 */
export function createUserMessage(text: string): Message {
  return {
    id: createMessageId(),
    role: "user",
    text,
    timestamp: Date.now(),
  };
}

/** 创建 AI 消息 */
export function createAssistantMessage(text: string): Message {
  return {
    id: createMessageId(),
    role: "assistant",
    text,
    timestamp: Date.now(),
  };
}
