// ==========================================
// 聊天消息类型
// ==========================================
import { reactive } from "vue";

export interface Message {
  role: "user" | "assistant";
  text: string;
}

// ==========================================
// AI 接口配置（可自由切换后端）
// ==========================================
export interface AIConfig {
  endpoint: string;       // API 地址
  apiKey: string;         // API Key
  model: string;          // 模型名
  systemPrompt: string;   // 系统提示词（角色人格）
}

export const defaultAIConfig: AIConfig = {
  endpoint: "",           // 留空则不启用 AI
  apiKey: "",
  model: "gpt-4o-mini",
  systemPrompt:
    "你叫糖糖，是一个在直播的虚拟主播。性格活泼可爱、偶尔傲娇。" +
    "请用简短的口语化中文回复，像在和朋友聊天一样。可以加表情，但不要用 markdown。",
};

let aiConfig: AIConfig = { ...defaultAIConfig };

// 更新 AI 配置
export function setAIConfig(config: Partial<AIConfig>) {
  aiConfig = { ...aiConfig, ...config };
}

export function getAIConfig(): AIConfig {
  return { ...aiConfig };
}

// ==========================================
// 对话历史（响应式数组，组件直接绑定）
// ==========================================
export const chatHistory = reactive<Message[]>([
  {
    role: "assistant",
    text: "你好呀～！欢迎来看我的直播！今天也要一起加油哦～",
  },
]);

// ==========================================
// 发送消息 → 获取 AI 回复
// ==========================================
export async function sendMessage(text: string): Promise<string> {
  // 保存用户消息
  chatHistory.push({ role: "user", text });

  if (!aiConfig.endpoint) {
    // 未配置 AI → 固定回复
    const reply = getDefaultReply(text);
    chatHistory.push({ role: "assistant", text: reply });
    return reply;
  }

  // AI 接口调用（OpenAI 兼容格式）
  try {
    const res = await fetch(aiConfig.endpoint + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + aiConfig.apiKey,
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [
          { role: "system", content: aiConfig.systemPrompt },
          ...chatHistory.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.text,
          })),
        ],
      }),
    });

    if (!res.ok) throw new Error("API error: " + res.status);

    const data = await res.json();
    const reply: string =
      data.choices?.[0]?.message?.content || "...";

    chatHistory.push({ role: "assistant", text: reply });
    return reply;
  } catch (e) {
    const fallback = "（网络出了点问题...）" + (e instanceof Error ? e.message : "");
    chatHistory.push({ role: "assistant", text: fallback });
    return fallback;
  }
}

// ==========================================
// 未配置 AI 时的默认回复
// ==========================================
function getDefaultReply(text: string): string {
  const replies = [
    "嗯嗯，是这样的呢～",
    "诶？真的吗？好厉害！",
    "原来如此～",
    "我知道哦～！",
    "嘿嘿，谢谢你！",
    "原来是这样啊～",
    "不是吧！？这也太夸张了",
    "对对对！",
    "你这么说我好开心～",
    "欸——这样啊，好有趣！",
    "哇，真的假的！",
    "那就这么说定啦！",
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}