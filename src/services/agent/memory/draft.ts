// ==========================================
// 记忆草稿 summary 字符上限 —— 唯一定义点（零依赖叶子）
// ==========================================
//
// 值 120 是行为口径：所有「把记忆正文压成草稿摘要」的路径共用同一截断长度，改值 = 改行为。
// 取用点（都从这里引用，不写第二份字面量）：
//   · dreaming 候选缺 summary 的回退与派生候选沉淀（`./dreaming`）；
//   · 「记住这条」提交（`native-ui/chat-intents.ts` 的 chat_remember_message）；
//   · 治理纠正同步摘要（`native-ui/management-intents.ts` 的 memory_item_change）；
//   · 记忆工具写入（`tool/local-extra/memory.ts` 的 memory_change）。
// 本文件刻意没有 import（零依赖叶子）：跨模块消费方（native-ui / tool）直接 import 本文件 ——
// 经 `@/services/agent/memory` barrel 会带出 IPC 与宿主依赖（native-ui 刻意只在调用时
// 动态 import 记忆域），同 `reply/protocol.ts` 的先例。

/** 记忆草稿 summary 的字符上限（摘要按正文前缀截断时的长度）。 */
export const DRAFT_SUMMARY_CHARS = 120
