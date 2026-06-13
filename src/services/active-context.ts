// ==========================================
// AI 主动消息引擎
// ==========================================

import { AIService, CharacterService, pushAssistantMessage, getSystemPrompt } from "@/features/chat";
import { DeepSeekProvider } from "@/features/chat/providers/deepseek-provider";
import type { Message } from "@/features/chat/types/message";

interface PageContext {
  title: string;
  content: string;
  timestamp: number;
}

const ACTIVE_COOLDOWN = 120;
let lastActiveTime = 0;
let lastContentHash = "";

function hash(str: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 500); i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

export async function generateActiveMessage(ctx: PageContext): Promise<string | null> {
  const now = Date.now();
  console.log("[Active] 收到:", ctx.title.substring(0, 40));

  if (now - lastActiveTime < ACTIVE_COOLDOWN * 1000) {
    console.log("[Active] 冷却中，剩余:", Math.ceil((ACTIVE_COOLDOWN * 1000 - (now - lastActiveTime)) / 1000) + "s");
    return null;
  }

  const contentHash = hash(ctx.title + ctx.content.substring(0, 200));
  if (contentHash === lastContentHash) {
    console.log("[Active] 内容未变化，跳过");
    return null;
  }

  try {
    console.log("[Active] 调用 AI...");
    const ai = new AIService(new DeepSeekProvider());
    const persona = CharacterService.current();

    // 使用完整人格文件作为 system prompt
    const fullPersona = getSystemPrompt();
    const windowPrompt = `\n\n[当前窗口] 主人正在使用: ${ctx.title}\n请根据以上信息，以${persona.name}的身份说一句简短的话（20字以内），表达你的反应、好奇或关心。只输出对话内容，不要加引号、前缀或解释。`;

    const userMsg: Message = {
      id: "active-" + now,
      role: "user",
      text: windowPrompt,
      timestamp: now,
    };

    const reply = await ai.generateReply([userMsg], fullPersona, "");
    console.log("[Active] AI 回复:", reply);
    lastActiveTime = now;
    lastContentHash = contentHash;

    return reply.trim();
  } catch (e) {
    console.error("[Active] AI 失败:", e);
    lastActiveTime = now;
    return null;
  }
}

if (typeof window !== "undefined") {
  (window as any).__testAI = async (title?: string) => {
    const msg = await generateActiveMessage({
      title: title || "哔哩哔哩 - 有趣视频",
      content: title || "",
      timestamp: Date.now(),
    });
    if (msg) { pushAssistantMessage(msg); }
    return msg;
  };
  console.log("[Active] __testAI('标题') 就绪");
}
