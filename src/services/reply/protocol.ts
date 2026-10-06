// ==========================================
// RUNTIME_DATA 协议标记 —— 唯一定义点（零依赖叶子）
// ==========================================
//
// 标记的字符串值逐字冻结：模型按它写区块，解析/过滤/提示词必须同源，改值 = 改协议。
// 取用点（都从这里引用，不写第二份字面量）：
//   · 指令注入 `context/builder.ts` 的 `RUNTIME_DATA_INSTRUCTION`（`<TAG>` / `</TAG>`）；
//   · 解析 `reply/generator.ts` 的 `RUNTIME_RE`（从这两个标签拼出）；
//   · 流式过滤 `engine/harness/stream-text.ts` 的起始标签；
//   · 提醒文案 `reply/reminder.ts` 与变量池表头 `personality/variable-pool.ts`。
// 本文件刻意没有 import（零依赖叶子）：`personality/variable-pool.ts` 也要引用它，
// 而 `reply/generator.ts` 反向依赖 variable-pool —— 经 barrel 引用会成环，
// 跨模块消费者直接 import 本文件。

/** 协议块名（模型可见文本里出现的标记名）。 */
export const RUNTIME_DATA_TAG = "RUNTIME_DATA"

/** 起始标签 `<RUNTIME_DATA>`。 */
export const RUNTIME_DATA_OPEN = `<${RUNTIME_DATA_TAG}>`

/** 结束标签 `</RUNTIME_DATA>`。 */
export const RUNTIME_DATA_CLOSE = `</${RUNTIME_DATA_TAG}>`
