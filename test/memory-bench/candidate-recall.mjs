// ==========================================
// 候选池 → 数据集证据坐标（纯函数）
// ==========================================
//
// memory_recall_candidates 同时携带两类身份：
//   · memory item：`<itemId>`，经 item.draft.sourceIds 映射回登记来源；
//   · 会话原话：`conversation:<sessionId>:<entryId>:<chunk>`，直接对应 sourceMeta 的 `conversation:<sessionId>:<entryId>`。
// 基准的 candidateRecall 必须在最终装配前测量；把映射留在纯函数里，避免 bench-adapter
// 与 scorer 各写一份、或只统计 memory item 而把会话候选静默丢掉。

/**
 * @param {readonly string[]} candidateIds
 * @param {{ sourceMeta: ReadonlyMap<string, { diaId?: string }>,
 *           itemById: ReadonlyMap<string, { draft?: { sourceIds?: readonly string[] } }> }} context
 * @returns {string[]} 去重后的数据集证据 id（LoCoMo 为 diaId）
 */
export function candidateDiaIds(candidateIds, { sourceMeta, itemById }) {
  const diaIds = new Set()
  for (const candidateId of candidateIds) {
    if (typeof candidateId !== "string" || candidateId.length === 0) continue
    if (candidateId.startsWith("conversation:")) {
      // 尾部 chunk 编号不参与来源身份；entryId 由生产提交保证唯一。
      const [, sessionId, entryId] = candidateId.split(":")
      if (!sessionId || !entryId) continue
      const meta = sourceMeta.get(`conversation:${sessionId}:${entryId}`)
      if (meta?.diaId) diaIds.add(meta.diaId)
      continue
    }
    const item = itemById.get(candidateId.split("@")[0] ?? "")
    for (const sourceId of item?.draft?.sourceIds ?? []) {
      const meta = sourceMeta.get(sourceId)
      if (meta?.diaId) diaIds.add(meta.diaId)
    }
  }
  return [...diaIds]
}
