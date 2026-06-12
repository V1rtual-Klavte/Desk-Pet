import type { Message } from "./message";

/**
 * AI 提供商抽象接口（策略模式）
 * 后续添加 OpenAI、Ollama、LM Studio 只需实现此接口
 */
export interface AIProvider {
  /** 提供商名称，用于日志和切换 */
  readonly name: string;

  /**
   * 生成 AI 回复
   * @param messages   对话历史（已格式化为 provider 需要的结构）
   * @param systemPrompt  系统提示词
   * @returns AI 生成的回复文本
   */
  generateReply(
    messages: Message[],
    systemPrompt: string,
  ): Promise<string>;
}
