import type { ModuleContract } from "../types"

export const memoryContract: ModuleContract = {
  module: "memory",
  sourceFiles: [
    "src/services/agent/memory/index.ts",
    "src/services/agent/memory/io.ts",
    "src/services/agent/memory/memory-entries.ts",
    "src/services/agent/memory/session-files.ts",
    "src/services/agent/memory/parsers.ts",
    "src/services/agent/memory/events.ts",
    "src/services/agent/memory/queue-events.ts",
    "src/services/engine/runtime/snapshot.ts",
  ],
  generatedAt: "2026-09-15",
  sourceHash: "c308328e82d81cc1c7a309461c659876e30d3ad6c629f1d3855668c6b3a7da78",
  coverage: [
    { id: "mm-01", feature: "Memory 添加条目", description: "MemoryService.append() 创建记忆", why: "记忆系统基础 CRUD", depth: "shallow", scenarios: ["memory-append"] },
    { id: "mm-02", feature: "Memory 搜索", description: "MemoryService.search(query, limit) 按内容搜索", why: "LLM 需检索相关记忆", depth: "shallow", scenarios: ["memory-search"] },
    { id: "mm-03", feature: "Memory 重要性过滤", description: "MemoryService.important(threshold) 过滤", why: "prompt 注入按重要性裁剪", depth: "shallow", scenarios: ["memory-important"] },
    { id: "mm-04", feature: "Memory 更新/删除", description: "MemoryService.update/remove 生命周期", why: "记忆管理", depth: "shallow", scenarios: ["memory-update-remove"] },
    { id: "mm-05", feature: "对话轮次记录", description: "MemoryService.recordTurn(role, text) 记录轮次", why: "session turn count 递增", depth: "deep", scenarios: ["memory-record-turn"] },
    { id: "mm-06", feature: "整理 Consolidate", description: "MemoryService.checkAndConsolidate() 定期整理", why: "防止记忆膨胀", depth: "shallow", scenarios: ["memory-consolidate"] },
    { id: "mm-07", feature: "Candy/User 指令", description: "getCandyInstructionsSync/getUserProfileSync 返回指令", why: "prompt 注入的记忆内容", depth: "shallow", scenarios: ["memory-system-files"] },
    { id: "mm-08", feature: "多轮会话 Markdown 持久化", description: "真实多轮对话后可从 sessions/*.md 重新读取完整原始正文", why: "文件是会话真相源，预览行不能替代原文", depth: "deep", scenarios: ["memory-multi-turn"] },
    { id: "mm-09", feature: "会话事件序列化", description: "serializeSessionEvent() 生成可读预览和无损 deskpet-event JSON", why: "新事件协议必须保留可读性与完整字段", depth: "shallow", scenarios: ["memory-event-serialization"] },
    { id: "mm-10", feature: "旧会话事件兼容解析", description: "parseSessionEventsFromRaw() 兼容 deskpet-turn 与纯预览并报告损坏记录", why: "迁移期间不能丢失历史会话或静默吞掉损坏数据", depth: "deep", scenarios: ["memory-old-session-compat"] },
    { id: "mm-11", feature: "PromptSnapshot", description: "快照保留 block 顺序、内容 hash 和 usage 区分并脱敏", why: "上下文审计不能泄露原始 prompt 或把估算 token 当成实际 usage", depth: "deep", scenarios: ["memory-prompt-snapshot"] },
    { id: "mm-12", feature: "主动消息来源", description: "主动搭话保持 active 来源，不写入 user 事实", why: "系统上下文不能污染用户事实和长期记忆", depth: "deep", scenarios: ["memory-active-origin"] },
    { id: "mm-13", feature: "工具成对观测", description: "工具调用与结果均可从 trace 和 runtime history 观察", why: "后续压缩和恢复需要完整 tool pair 基线", depth: "deep", scenarios: ["memory-tool-pair-baseline"] },
    { id: "mm-14", feature: "队列恢复与幂等", description: "queued 事件重启后可 requeue，requestId 不重复投递", why: "输入不能因进程中断丢失或重复执行", depth: "deep", scenarios: ["queued-recovery"] },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 2, requireBoundary: true, requireErrorPath: true },
}
