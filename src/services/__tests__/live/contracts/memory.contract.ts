import type { ModuleContract } from "../types"

export const memoryContract: ModuleContract = {
  module: "memory",
  sourceFiles: ["src/services/agent/memory/index.ts", "src/services/agent/memory/memory-entries.ts"],
  generatedAt: "2026-07-24T00:00:00Z",
  sourceHash: "",
  coverage: [
    { id: "mm-01", feature: "Memory 添加条目", description: "MemoryService.append() 创建记忆", why: "记忆系统基础 CRUD", depth: "shallow", scenarios: [] },
    { id: "mm-02", feature: "Memory 搜索", description: "MemoryService.search(query, limit) 按内容搜索", why: "LLM 需检索相关记忆", depth: "shallow", scenarios: [] },
    { id: "mm-03", feature: "Memory 重要性过滤", description: "MemoryService.important(threshold) 过滤", why: "prompt 注入按重要性裁剪", depth: "shallow", scenarios: [] },
    { id: "mm-04", feature: "Memory 更新/删除", description: "MemoryService.update/remove 生命周期", why: "记忆管理", depth: "shallow", scenarios: [] },
    { id: "mm-05", feature: "对话轮次记录", description: "MemoryService.recordTurn(role, text) 记录轮次", why: "session turn count 递增", depth: "deep", scenarios: [] },
    { id: "mm-06", feature: "整理 Consolidate", description: "MemoryService.checkAndConsolidate() 定期整理", why: "防止记忆膨胀", depth: "shallow", scenarios: [] },
    { id: "mm-07", feature: "Candy/User 指令", description: "getCandyInstructionsSync/getUserProfileSync 返回指令", why: "prompt 注入的记忆内容", depth: "shallow", scenarios: [] },
    { id: "mm-08", feature: "多轮对话记忆持久化", description: "真实多轮对话后记忆正确存储和检索", why: "端到端验证", depth: "deep", scenarios: [] },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 2, requireBoundary: true, requireErrorPath: true },
}
