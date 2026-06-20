// ==========================================
// 全局配置 —— 从根目录 CONFIG.yaml 加载
// 所有模块都应从此处读取配置，不自行定义常量
// ==========================================

import rawConfig from "../../CONFIG.yaml";

interface Config {
  ai: {
    provider: string;
    endpoint: string;
    apiKey: string;
    model: string;
    maxContextMessages: number;
    defaultSystemPrompt: string;
    fallbackReplies: string[];
  };
  windowMonitor: {
    enabled: boolean;
    staySeconds: number;
    settleMs: number;
    cooldownSeconds: number;
    samePageCooldownSeconds: number;
    defaultCooldownMs: number;
    resumeExtraMs: number;
  };
  aiLock: {
    safetyTimeoutMs: number;
  };
  memory: {
    maxEntries: number;
  };
  notification: {
    autoCloseMs: number;
  };
  desktop: {
    pollingIntervalMs: number;
    pauseExtraMs: number;
    waitTimeoutMs: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
}

const cfg = rawConfig as Config;

// ==========================================
// AI 配置
// ==========================================
export const aiConfig = {
  get provider() { return cfg.ai.provider; },
  get endpoint() { return cfg.ai.endpoint || import.meta.env.VITE_API_ENDPOINT || ""; },
  get apiKey() { return cfg.ai.apiKey || import.meta.env.VITE_API_KEY || ""; },
  get model() { return cfg.ai.model || import.meta.env.VITE_MODEL || "deepseek-chat"; },
  get maxContextMessages() { return cfg.ai.maxContextMessages || 20; },
  get defaultSystemPrompt() { return cfg.ai.defaultSystemPrompt || "你叫糖糖，是一个在直播的虚拟主播。"; },
  get fallbackReplies() { return cfg.ai.fallbackReplies || ["嗯嗯～"]; },
  /** 是否已配置 API */
  get configured() { return Boolean(cfg.ai.endpoint && (cfg.ai.apiKey || import.meta.env.VITE_API_KEY)); },
};

// ==========================================
// 窗口监控配置
// ==========================================
export const windowMonitorConfig = {
  get enabled() { return cfg.windowMonitor.enabled ?? true; },
  get staySeconds() { return cfg.windowMonitor.staySeconds || 60; },
  get settleMs() { return cfg.windowMonitor.settleMs || 2000; },
  get cooldownSeconds() { return cfg.windowMonitor.cooldownSeconds || 5000; },
  get samePageCooldownSeconds() { return cfg.windowMonitor.samePageCooldownSeconds || 7800; },
  get defaultCooldownMs() { return cfg.windowMonitor.defaultCooldownMs || 12000; },
  get resumeExtraMs() { return cfg.windowMonitor.resumeExtraMs || 2000; },
};

// ==========================================
// AI 并发锁配置
// ==========================================
export const aiLockConfig = {
  get safetyTimeoutMs() { return cfg.aiLock.safetyTimeoutMs || 30000; },
};

// ==========================================
// 长期记忆配置
// ==========================================
export const memoryConfig = {
  get maxEntries() { return cfg.memory.maxEntries || 200; },
};

// ==========================================
// 通知弹窗配置
// ==========================================
export const notificationConfig = {
  get autoCloseMs() { return cfg.notification.autoCloseMs || 8000; },
};

// ==========================================
// 桌面后端配置（Rust 轮询参数）
// ==========================================
export const desktopConfig = {
  get pollingIntervalMs() { return cfg.desktop.pollingIntervalMs || 3000; },
  get pauseExtraMs() { return cfg.desktop.pauseExtraMs || 5000; },
  get waitTimeoutMs() { return cfg.desktop.waitTimeoutMs || 5000; },
};

// ==========================================
// 日志配置
// ==========================================
export const loggingConfig = {
  get level(): "debug" | "info" | "warn" | "error" {
    return cfg.logging?.level || (import.meta.env.DEV ? "debug" : "info");
  },
};

// ==========================================
// 开发环境打印
// ==========================================
if (import.meta.env.DEV) {
  console.log("[Config] 已加载 CONFIG.yaml | AI:", aiConfig.provider, "| endpoint:", aiConfig.endpoint);
}
