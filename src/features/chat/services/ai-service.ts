import type { Message } from "../types/message";
import type { AIProvider } from "../types/ai";
import { isAIConfigured } from "../config/ai-config";

/**
 * AI 服务 —— 构造 Prompt、调用 Provider、返回回复
 * 职责：
 *   - 判断是否可用 AI
 *   - 委托给 AIProvider 生成回复
 *   - 统一错误处理
 */
export class AIService {
  private provider: AIProvider;
  private fallbackReplies: string[];

  constructor(provider: AIProvider, fallbackReplies?: string[]) {
    this.provider = provider;
    this.fallbackReplies = fallbackReplies ?? [
      "嗯嗯，是这样的呢～",
      "诶？真的吗？好厉害！",
      "原来如此～",
      "我知道哦～！",
      "哈哈，谢谢你！",
      "原来是这个样子啊～",
      "不是吧！？这也太夸张了",
      "对对对！",
      "你这么说我好开心～",
      "欸——这样啊，好有趣！",
    ];
  }

  /** 切换 AI Provider（运行时切换模型后端） */
  setProvider(provider: AIProvider): void {
    this.provider = provider;
  }

  /** 生成 AI 回复 */
  async generateReply(
    messages: Message[],
    systemPrompt: string,
    userText: string,
  ): Promise<string> {
    // 未配置 API → 离线回复
    if (!isAIConfigured()) {
      return this.randomFallback(userText);
    }

    try {
      const reply = await this.provider.generateReply(messages, systemPrompt);
      return reply;
    } catch (e) {
      console.error("[AIService] Provider error:", e);
      return `（网络连接异常）${e instanceof Error ? " " + e.message : ""}`;
    }
  }

  /** 获取随机离线回复 */
  randomFallback(_userText: string): string {
    return this.fallbackReplies[
      Math.floor(Math.random() * this.fallbackReplies.length)
    ];
  }
}
