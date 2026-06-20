// ==========================================
// 统一 OpenAI 兼容 Provider
// 支持 DeepSeek / OpenAI / Ollama / LM Studio 等所有 OpenAI 兼容 API
// ==========================================

import type { AIProvider, Message } from "./types";
import { getAIConfig } from "./config";
import { createLogger } from "@/services/logger";

const log = createLogger("AI");

export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai-compatible";

  async generateReply(messages: Message[], systemPrompt: string): Promise<string> {
    const config = getAIConfig();

    // 自动处理 endpoint 末尾有无 /v1，避免 /v1/v1 重复拼接
    let base = config.endpoint.replace(/\/+$/, "");
    const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.text,
      })),
    ];

    const body = JSON.stringify({ model: config.model, messages: apiMessages });
    log.debug("请求 →", url, "| model:", config.model);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + config.apiKey,
        },
        body,
      });
    } catch (e) {
      const msg = e instanceof TypeError ? `网络不可达 (${e.message})，请检查 endpoint 是否在线: ${url}` : String(e);
      throw new Error(msg);
    }

    if (!res.ok) {
      let detail = "";
      try { const err = await res.json(); detail = JSON.stringify(err); } catch {}
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? " " + detail : ""}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      log.warn("API 返回无内容", JSON.stringify(data).substring(0, 200));
      return "（唔…不知道怎么回…）";
    }
    return content;
  }
}
