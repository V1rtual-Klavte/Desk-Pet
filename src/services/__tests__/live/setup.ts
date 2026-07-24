// ==========================================
// Live Test Setup — Mock Tauri, 保留真 Config + 真 LLM
// ==========================================

import { vi } from "vitest"

// Mock Tauri invoke（文件 I/O 操作在测试环境走 mock）
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === "personality_file_read") return null
    if (cmd === "personality_file_write") return "/mock/live-test/path"
    if (cmd === "personality_file_list") return []
    if (cmd === "memory_file_read") return null
    if (cmd === "memory_file_write") return "/mock/live-test/memory"
    if (cmd === "memory_file_list") return []
    if (cmd === "profile_file_read") return null
    if (cmd === "profile_file_write") return "/mock/live-test/profile"
    return null
  }),
}))

// Mock Tauri emit（事件推送在测试环境忽略）
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}))

// 注意：不 mock @/services/config
// 真 config 意味着真 aiConfig.endpoint + apiKey → 真 LLM 调用
