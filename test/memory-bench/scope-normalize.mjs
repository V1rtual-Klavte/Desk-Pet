// ==========================================
// bench 夹具的 session-scope → user scope 归一规划（纯函数，L2 单测覆盖）
//
// 为什么要归一：外部集的提问发生在新会话，session-scope 候选按 scope_id 过滤会整体
// 漏召回；Rust 又禁止 update/supersede 跨范围改归属，所以夹具用「同内容/同来源 add
// user 副本 + forget 原条目」表达这次显式治理操作（不改产品代码）。
//
// 为什么必须两段式（先全部 add、再全部 forget）：Rust 的遗忘按来源事件
// （session+entry+content_hash）写 block_extraction 墓碑；墓碑不只拦重建与补扫，
// 也会让之后任何引用该来源的 add 判「来源未登记」。逐条 add→forget 时，只要同一
// 来源被两个 session 条目共享，第二条 add 就会撞上第一条留下的墓碑，整题记
// infrastructure 失败（2026-10-03 LongMemEval oracle lme-oracle-e01b8e2f 的真实故障）。
// ==========================================

/**
 * 规划归一操作序列：只挑 active 且 scope=session 的条目，draft 改写为 user 范围副本。
 * 返回**有序**操作表（先全部 add、再全部 forget），调用方按序执行即可 —— 顺序本身
 * 就是契约，不能由调用方自行交错，否则共享来源的条目会撞墓碑。
 * @param {ReadonlyArray<{ id: string, status?: string, draft?: unknown }>} items
 * @returns {Array<{ action: "add", itemId: string, draft: object } | { action: "forget", itemId: string }>}
 */
export function planScopeNormalization(items) {
  const copies = []
  const forgets = []
  for (const item of items) {
    const draft = item?.draft
    if (item?.status !== "active" || !draft || typeof draft !== "object" || draft.scope !== "session") continue
    copies.push({ itemId: item.id, draft: { ...draft, scope: "user", scopeId: undefined } })
    forgets.push(item.id)
  }
  return [
    ...copies.map(copy => ({ action: "add", itemId: copy.itemId, draft: copy.draft })),
    ...forgets.map(itemId => ({ action: "forget", itemId })),
  ]
}
