import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { MemoryService } from "@/services/agent/memory"

function providerSetup() {
  installFakeProvider([fakeText("记忆基础场景完成")])
}

export const 记忆添加: SceneDef = {
  meta: { caseId: "memory-append", module: "memory", contractId: "mm-01", description: "Memory append 创建条目", depth: "shallow", suite: "capability", tags: ["memory"] },
  setup: async () => { providerSetup(); MemoryService.append("append smoke fact", "general", 5) },
  turns: [{ index: 1, description: "验证新增记忆", userText: "验证记忆添加。", checks: [{ type: "expectAppend", run: async (ctx) => {
    if (!ctx.memory.totalEntries || !MemoryService.search("append smoke fact", 1).length) throw new Error("append 未创建可检索条目")
  } }] }],
}

export const 记忆搜索: SceneDef = {
  meta: { caseId: "memory-search", module: "memory", contractId: "mm-02", description: "Memory search 按内容返回条目", depth: "shallow", suite: "capability", tags: ["memory"] },
  setup: async () => { providerSetup(); MemoryService.append("searchable memory fact", "general", 5) },
  turns: [{ index: 1, description: "验证搜索结果", userText: "验证记忆搜索。", checks: [{ type: "expectSearch", run: async () => {
    if (MemoryService.search("searchable", 1)[0]?.content !== "searchable memory fact") throw new Error("search 未返回匹配条目")
  } }] }],
}

export const 记忆重要性: SceneDef = {
  meta: { caseId: "memory-important", module: "memory", contractId: "mm-03", description: "Memory important 过滤阈值", depth: "shallow", suite: "capability", tags: ["memory", "boundary"] },
  setup: async () => { providerSetup(); MemoryService.append("low importance", "general", 3); MemoryService.append("high importance", "general", 9) },
  turns: [{ index: 1, description: "验证重要性过滤", userText: "验证重要性过滤。", checks: [{ type: "expectImportant", run: async () => {
    const result = MemoryService.important(8)
    if (result.length !== 1 || result[0]?.content !== "high importance") throw new Error("important 阈值过滤错误")
  } }] }],
}

export const 记忆更新删除: SceneDef = {
  meta: { caseId: "memory-update-remove", module: "memory", contractId: "mm-04", description: "Memory update/remove 生命周期", depth: "shallow", suite: "regression", tags: ["memory", "error"] },
  setup: async () => { providerSetup(); const entry = MemoryService.append("before update", "general", 5); if (!MemoryService.update(entry.id, { content: "after update" })) throw new Error("update 返回失败"); if (!MemoryService.remove(entry.id)) throw new Error("remove 返回失败") },
  turns: [{ index: 1, description: "验证更新删除边界", userText: "验证记忆更新删除。", checks: [{ type: "expectUpdateRemove", run: async () => {
    if (MemoryService.search("after update").length || MemoryService.remove("missing-memory-id")) throw new Error("update/remove 生命周期错误")
  } }] }],
}

export const 记忆整理: SceneDef = {
  meta: { caseId: "memory-consolidate", module: "memory", contractId: "mm-06", description: "本地 consolidate 去重", depth: "shallow", suite: "regression", tags: ["memory"] },
  setup: async () => { providerSetup(); MemoryService.append("duplicate fact", "general", 5); MemoryService.append("duplicate fact", "general", 4) },
  turns: [{ index: 1, description: "验证整理去重", userText: "验证记忆整理。", checks: [{ type: "expectConsolidate", run: async () => {
    const result = MemoryService.consolidate()
    if (result.removed < 1 || MemoryService.search("duplicate fact", 10).length !== 1) throw new Error("consolidate 未去重")
  } }] }],
}

export const 记忆系统文件: SceneDef = {
  meta: { caseId: "memory-system-files", module: "memory", contractId: "mm-07", description: "Candy/User 指令可读取", depth: "shallow", suite: "capability", tags: ["memory"] },
  setup: async () => { providerSetup(); await MemoryService.updateCandy("保持简洁"); MemoryService.append("用户喜欢 TypeScript", "user", 9); await MemoryService.syncUserProfile() },
  turns: [{ index: 1, description: "验证系统文件指令", userText: "验证系统文件。", checks: [{ type: "expectSystemFiles", run: async () => {
    if (!MemoryService.getCandyInstructionsSync().includes("保持简洁")) throw new Error("Candy 指令不可读")
    if (!MemoryService.getUserProfileSync().includes("用户喜欢 TypeScript")) throw new Error("User 画像不可读")
  } }] }],
}

export default 记忆添加
