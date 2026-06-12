// ==========================================
// AI 接口配置
//
// 【快速接入】直接修改下方 API_KEY 和 API_ENDPOINT 即可
// ==========================================

// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  在这里粘贴你的 API Key                       ┃
// ┃  例如: "sk-1234567890abcdef"                  ┃
// ┃  留空则使用 .env 文件中的 VITE_API_KEY        ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
const API_KEY = "";

// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  API 地址（默认 DeepSeek）                     ┃
// ┃  其他选项: https://api.openai.com              ┃
// ┃            http://localhost:11434/v1 (Ollama)   ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
const API_ENDPOINT = "https://api.deepseek.com";

// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  模型名称                                       ┃
// ┃  DeepSeek: deepseek-chat                       ┃
// ┃  OpenAI:   gpt-4o-mini                         ┃
// ┃  本地:      见对应模型名称                       ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
const API_MODEL = "deepseek-chat";

// ==========================================
// 以下为配置逻辑，一般不需要修改
// ==========================================

export interface AIConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

/**
 * 配置优先级（高 → 低）：
 * 1. setAIConfig() 运行时设置
 * 2. 当前文件顶部直接粘贴
 * 3. .env 文件中的 VITE_API_KEY / VITE_API_ENDPOINT / VITE_MODEL
 */
const defaultConfig: AIConfig = {
  endpoint: API_ENDPOINT || import.meta.env.VITE_API_ENDPOINT || "",
  apiKey: API_KEY || import.meta.env.VITE_API_KEY || "",
  model: API_MODEL || import.meta.env.VITE_MODEL || "deepseek-chat",
  systemPrompt: "",
};

let currentConfig: AIConfig = { ...defaultConfig };

export function setAIConfig(config: Partial<AIConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

export function getAIConfig(): AIConfig {
  return { ...currentConfig };
}

export function isAIConfigured(): boolean {
  return Boolean(currentConfig.endpoint && currentConfig.apiKey);
}


// ==========================================
// System Prompt —— 动态读取（支持热更新）
// ==========================================
let _promptGetter: (() => string) | null = null;

/** 注册动态 prompt 读取器（由 CharacterService 调用） */
export function registerPromptGetter(fn: () => string): void {
  _promptGetter = fn;
}

/** 获取当前 System Prompt（实时读取，热更新时自动变化） */
export function getSystemPrompt(): string {
  return _promptGetter?.() ?? "";
}

