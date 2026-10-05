// ==========================================
// 记忆 revision —— 进程内分发总线（Node 领域侧）
// ==========================================
//
// 拆分（执行契约 §4.1、原生宿主迁移过程记录 §9.4 第 7/35 条）：
// - 本文件只做**本进程**的 revision 分发：runtime 订阅它，在记忆被改动时中止陈旧投影
//   （已发出的输入不可召回，`engine/harness/runtime.ts`）。
// - 跨窗口同步（`deskpet-memory-revision-changed/-applied`）属于 **纯 UI 的窗口间协调**，
//   判据 (b) 不进 Node 图。单 Node 架构下所有提交都发生在
//   本进程，不需要事件回环；若原生 UI 仍需要跨窗口通知，由原生 UI 内部承接。
//
// 数据真相源仍在 Node/Rust 命令（memory_*），revision 只是「已提交」的通知值，
// 不承载事实内容（facts/UI state 都不走这条通道）。

import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("MemoryRevision")

const consumers = new Set<(revision: number) => void | Promise<void>>()

export function subscribeMemoryRevision(consumer: (revision: number) => void | Promise<void>): () => void {
  consumers.add(consumer)
  return () => consumers.delete(consumer)
}

/**
 * 把已提交的 revision 分发给本进程消费者，并等待全部处置完成再返回 ——
 * 「提交等待运行失效同步」的语义在单 Node 进程里就是本地 await。
 */
export async function publishMemoryRevision(revision: number): Promise<void> {
  const results = await Promise.allSettled(
    [...consumers].map(consumer => Promise.resolve().then(() => consumer(revision))),
  )
  for (const result of results) {
    if (result.status === "rejected") log.error("记忆revision应用失败:", formatError(result.reason))
  }
}
