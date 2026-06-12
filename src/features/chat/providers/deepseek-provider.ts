import type { AIProvider } from "../types/ai";
import type { Message } from "../types/message";
import { getAIConfig } from "../config/ai-config";

/**
 * DeepSeek Provider —— 通过 OpenAI 兼容格式调用 DeepSeek API
 */
export class DeepSeekProvider implements AIProvider {
  readonly name = "deepseek";

  async generateReply(
    messages: Message[],
    systemPrompt: string,
  ): Promise<string> {
    const config = getAIConfig();

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
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
