// scope-normalize.mjs 的类型声明（bench 夹具的 session→user 归一规划）。

import type { MemoryDraft } from "@/services/agent/memory"

export interface ScopeNormalizationAdd {
  action: "add"
  itemId: string
  draft: MemoryDraft
}

export interface ScopeNormalizationForget {
  action: "forget"
  itemId: string
}

export type ScopeNormalizationOp = ScopeNormalizationAdd | ScopeNormalizationForget

export function planScopeNormalization(
  items: ReadonlyArray<{ id: string; status?: string; draft?: MemoryDraft }>,
): ScopeNormalizationOp[]
