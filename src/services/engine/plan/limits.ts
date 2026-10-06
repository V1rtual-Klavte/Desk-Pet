// ==========================================
// 计划机制的时限常量 —— 零跨域依赖的叶子
//
// 为什么单独成文件：`propose_plan` 工具（工具域）的静态策略需要计划确认等待上限来
// 折算自己的工具超时预算。工具域直接从引擎 barrel 取值会形成
// `engine barrel → harness → tool barrel → local-extra/plan → engine barrel` 的静态循环；
// 这里的定义点没有业务依赖（只读配置 getter），工具域可以直接引用它。
// ==========================================

import { planConfig } from "@/services/config"

/** 确认/步骤门的等待上限（PLAN-07）：与权限确认 TTL 同量级但**不引用它** —— 两个域各自的生命周期。 */
export const PLAN_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

/**
 * `propose_plan` 工具单次调用的超时预算（`policy.execution.timeoutMs`）：
 * 确认等待上限 + 计划时限（`stepTimeoutMs × maxSteps`）+ 一个在跑步骤的超时
 * （时限只在步骤边界检查）+ 1 分钟余量。
 *
 * Router 的超时只结束请求视图、**不会**停住仍在等待确认/执行的 handler（见 router.ts），
 * 所以预算必须覆盖整个相位的最坏时长，否则模型先收到「工具超时」而计划仍在跑。
 * 与 agent_spawn 同一取舍：配置在模块加载时读一次，随注册表冻结（改动需重启生效）。
 */
export const PROPOSE_PLAN_TOOL_TIMEOUT_MS =
  PLAN_CONFIRM_TIMEOUT_MS + planConfig.stepTimeoutMs * (planConfig.maxSteps + 1) + 60_000
