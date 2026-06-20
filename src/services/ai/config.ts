// ==========================================
// AI 配置桥接 —— 从全局 CONFIG.yaml 读取，支持运行时覆盖
//
// 【修改配置】编辑根目录的 CONFIG.yaml → 热更新生效
// 【运行时覆盖】调用 setAIConfig()    → 仅当前会话有效
// ==========================================

import type { AIConfig } from "./types";
import { aiConfig } from "@/services/config";

let runtimeOverride: Partial<AIConfig> = {};

/** 运行时覆盖全局配置（仅当前会话有效，不写回 CONFIG.yaml） */
export function setAIConfig(config: Partial<AIConfig>): void {
  runtimeOverride = { ...runtimeOverride, ...config };
}

/** 获取当前生效的 AI 配置 */
export function getAIConfig(): AIConfig {
  return {
    endpoint: runtimeOverride.endpoint ?? aiConfig.endpoint,
    apiKey: runtimeOverride.apiKey ?? aiConfig.apiKey,
    model: runtimeOverride.model ?? aiConfig.model,
    systemPrompt: runtimeOverride.systemPrompt ?? "",
  };
}

/** 是否已配置 API Key + Endpoint */
export function isAIConfigured(): boolean {
  const c = getAIConfig();
  return Boolean(c.endpoint && c.apiKey);
}

// ==========================================
// System Prompt —— 动态读取（支持热更新）
// ==========================================
let _promptGetter: (() => string) | null = null;

/** 注册动态 prompt 读取器（由 CharacterService 调用） */
export function registerPromptGetter(fn: () => string): void {
  _promptGetter = fn;
}

/** 获取当前 System Prompt（实时读取人格卡） */
export function getSystemPrompt(): string {
  return _promptGetter?.() ?? "";
}
