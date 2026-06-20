// ==========================================
// AI 主动消息引擎（统一冷却）
// ==========================================

import { AIService, OpenAICompatibleProvider, getSystemPrompt, unansweredCount } from "@/services/ai";
import { isCoolingDown, isAIGenerating, setAIGenerating } from "@/services/cooldown";
import { processTrigger, SAME_PAGE_COOLDOWN_SECONDS } from "./monitor";
import { createLogger } from "@/services/logger";
import type { Message } from "@/services/ai";

const log = createLogger("Active");

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
  if (isCoolingDown()) { log.debug("全局冷却中，跳过"); return null; }

  const contentHash = hash(ctx.title + ctx.content.substring(0, 200));
  if (contentHash === lastContentHash && Date.now() - lastTriggerTime < SAME_PAGE_COOLDOWN_SECONDS * 1000) {
    log.debug("同页面冷却中");
    return null;
  }
  if (isAIGenerating()) { log.debug("已有 AI 请求进行中"); return null; }

  setAIGenerating(true);
  lastContentHash = contentHash;
  lastTriggerTime = Date.now();

  try {
    log.info("调用 AI...");
    const ai = new AIService(new OpenAICompatibleProvider());
    const fullPersona = getSystemPrompt();
    const userMsg: Message = {
      id: "active-" + Date.now(),
      role: "user",
      text: `主人正在使用: ${ctx.title}\n当前状态：\nunansweredCount: ${unansweredCount.value}`,
      timestamp: Date.now(),
    };
    const reply = await ai.generateReply([userMsg], fullPersona, "");
    log.info("AI 回复:", reply);
    processTrigger({ source: "ai", message: reply });
    return reply.trim();
  } catch (e) {
    log.error("AI 失败", e instanceof Error ? e : undefined);
    return null;
  } finally {
    setAIGenerating(false);
  }
}

if (typeof window !== "undefined") {
  (window as any).__testAI = async (title?: string) => {
    const msg = await generateActiveMessage({ title: title || "哔哩哔哩", content: title || "", timestamp: Date.now() });
    if (msg) (await import("@/services/ai")).pushAssistantMessage(msg);
    return msg;
  };
  log.info("__testAI('标题') 就绪");
}
