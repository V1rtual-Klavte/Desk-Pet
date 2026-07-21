// ==========================================
// 全局测试 Setup — Mock Tauri + Config
// ==========================================

import { vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation(async (cmd: string) => {
    if (cmd === "personality_file_read") return null
    if (cmd === "personality_file_write") return "/mock/path"
    if (cmd === "personality_file_list") return []
    return null
  }),
}))

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
}))

vi.mock("@/services/config", () => ({
  loggingConfig: { level: "info" as const, maxEntries: 100 },
  aiConfig: {
    provider: "deepseek",
    endpoint: "http://ai.onetwo2023.com/v1",
    apiKey: "sk-placeholder",
    requireApiKey: true,
    model: "deepseek-v4-pro",
    contextMaxTokens: 16000,
    thinking: { effort: "auto" as const, budget: { low: 1000, medium: 4000, high: 16000 } },
  },
  generalConfig: { assistantMode: false },
  loopConfig: {
    maxRetry: 3, maxToolCallsPerTurn: 5,
    toolTimeoutMs: 30000, turnTimeoutMs: 120000,
    contextCompactAt: 0.95, dedupWindowMs: 30000, maxVisibleMessages: 200,
  },
  toolsConfig: {
    bash: { enabled: true, whitelist: ["ls", "cat", "head", "tail", "grep", "find", "echo", "pwd", "date", "which",
      "ps", "df", "du", "ifconfig", "system_profiler", "tasklist", "whoami", "uname"] },
    file: { enabled: true, writeEnabled: false },
    mcp: { enabled: false }, skill: { enabled: false },
  },
  safetyConfig: { mode: "tell_me" as const, sessionTrustEnabled: true },
  personalityConfig: {
    active: "angelkawaii",
    cards: [
      { id: "angelkawaii", name: "KAngel", path: "cards/angelkawaii.md", description: "甜蜜活泼女友+病娇" },
      { id: "ame", name: "Ame", path: "cards/ame.md", description: "冷静管家型" },
      { id: "pchan", name: "P酱", path: "cards/pchan.md", description: "慵懒电竞少女" },
    ],
  },
  windowMonitorConfig: { enabled: false },
  memoryConfig: { maxEntries: 200, maxSessions: 20 },
  appearanceConfig: { activeProfile: "sugar-pink" },
}))
