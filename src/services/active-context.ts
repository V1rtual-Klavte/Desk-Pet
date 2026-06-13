// ==========================================
// AI 主动消息引擎（统一冷却）
// ==========================================

import { AIService, CharacterService, pushAssistantMessage, getSystemPrompt } from "@/features/chat";
import { DeepSeekProvider } from "@/features/chat/providers/deepseek-provider";
import { isCoolingDown, isAIGenerating, setAIGenerating } from "./cooldown";
import { processTrigger, SAME_PAGE_COOLDOWN_SECONDS } from "./window-monitor";
import type { Message } from "@/features/chat/types/message";

interface PageContext {
  title: string;
  content: string;
  timestamp: number;
}

let lastContentHash = "";
let lastTriggerTime = 0;

function hash(str: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 500); i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

export async function generateActiveMessage(ctx: PageContext): Promise<string | null> {
  if (isCoolingDown()) { console.log("[Active] 全局冷却中，跳过"); return null; }

  const contentHash = hash(ctx.title + ctx.content.substring(0, 200));

  if (contentHash === lastContentHash && Date.now() - lastTriggerTime < SAME_PAGE_COOLDOWN_SECONDS * 1000) {
    console.log("[Active] 同页面冷却中，剩余:", Math.ceil((SAME_PAGE_COOLDOWN_SECONDS * 1000 - (Date.now() - lastTriggerTime)) / 1000) + "s");
    return null;
  }

  if (isAIGenerating()) {
    console.log("[Active] 已有 AI 请求进行中，跳过并发调用");
    return null;
  }

  setAIGenerating(true);
  lastContentHash = contentHash;
  lastTriggerTime = Date.now();

  try {
    console.log("[Active] 调用 AI...");
    const ai = new AIService(new DeepSeekProvider());
    const fullPersona = getSystemPrompt();

    const userMsg: Message = {
      id: "active-" + Date.now(),
      role: "user",
      text: `主人正在使用: ${ctx.title}`,
      timestamp: Date.now(),
    };

    const reply = await ai.generateReply([userMsg], fullPersona, "");
    console.log("[Active] AI:", reply);

    processTrigger({ source: "ai", message: reply });
    return reply.trim();
  } catch (e) {
    console.error("[Active] AI 失败:", e);
    return null;
  } finally {
    setAIGenerating(false);
  }
}

if (typeof window !== "undefined") {
  (window as any).__testAI = async (title?: string) => {
    const msg = await generateActiveMessage({ title: title || "哔哩哔哩", content: title || "", timestamp: Date.now() });
    if (msg) pushAssistantMessage(msg);
    return msg;
  };
  console.log("[Active] __testAI('标题') 就绪");
}
