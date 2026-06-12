import type { AIProvider } from "../types/ai";
import type { Message } from "../types/message";
import { getAIConfig } from "../config/ai-config";

/**
 * OpenAI Provider —— 标准 OpenAI API 调用（预留）
 * 结构与 DeepSeekProvider 类似，这里作为模板保留
 */
export class OpenAIProvider implements AIProvider {
  readonly name = "openai";

  async generateReply(
    messages: Message[],
    systemPrompt: string,
  ): Promise<string> {
    const config = getAIConfig();

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: m.text,
      })),
    ];

    const res = await fetch(config.endpoint + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey,
      },
      body: JSON.stringify({
        model: config.model,
        messages: apiMessages,
      }),
    });

    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "...";
  }
}
