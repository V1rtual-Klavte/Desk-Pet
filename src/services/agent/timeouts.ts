// ==========================================
// 子代理的时间预算 —— fork/team 的运行墙钟与 agent_spawn 声明值的唯一定义点
// ==========================================
//
// 零依赖叶子：`sub-agent.ts`（执行侧）与 `tool/local-extra/agent-tool.ts`（声明侧）
// 共用同一组常量。此前声明侧按 `loopConfig.toolTimeoutMs × 4`（=120s）在模块加载时
// 求值一次，而 team 内部最坏 = 成员段（90s 并行）+ lead 段（90s）≈180s —— 声明值
// 小于内部可能耗时，router 会在 120s 把仍在跑的团队判成超时（2026-10-06 体检报告 R3）。
// 静态导入方向：两处消费都直接指向本叶子，不经过任一方的模块图（agent-tool 对
// sub-agent 保持动态 import，避免 tool barrel 的循环）。

/** 单个 fork 子运行的硬墙钟（team 的成员段与 lead 段各跑一次；无人值守，刻意收窄）。 */
export const SUB_AGENT_RUN_TIMEOUT_MS = 90_000

/**
 * `agent_spawn` 工具的声明执行预算。
 *
 * 对齐口径取「工具正常干活需要多久」的最坏值，不是无脑取大值：team = 成员段
 * （≤`SUB_AGENT_RUN_TIMEOUT_MS`，并行）+ lead 段（≤同值）≈180s；再加 30s 编排余量
 * （两段之间的会话装配与返回），声明值不允许反超内部最坏时长。fork 单段远小于它 ——
 * 一个工具声明覆盖 fork/team 两个模式，只能按最坏模式取。
 */
export const AGENT_SPAWN_TOOL_TIMEOUT_MS = SUB_AGENT_RUN_TIMEOUT_MS * 2 + 30_000
