---
document_type: current_contract
status: code_checked
updated_at: 2026-09-17
scope: runtime-foundation-before-memory-kernel
---

# 当前运行时契约

本文记录已经落地的横向运行时边界；记忆与会话的存储、checkpoint 和预算细节由[当前记忆与会话基础](./memory.md)维护，长期记忆的后续目标见[记忆系统运行时契约](../plans/active/记忆系统运行时契约.md)。

## 会话、来源与恢复

- 普通输入先落盘再投递：空闲走 `lane.prompt`，忙碌进入 lane 持久 inbox（steer / followUp），消费证据由条目与运行关联给出。主动输入以 `deskpet.active_message` 自定义消息记录，其回复带 `active` 来源，不能成为用户事实。[`runPiAgentTurn`](../../src/services/engine/pi/runtime.ts) 与 [`harness-slot.ts`](../../src/services/engine/pi/harness-slot.ts)
- 运行槽按 `sessionId` 与注册表级单调代际约束投递与释放；停止/中断把未消费 inbox 项以 `nextRun` 归还、等待下一次运行接受，不自动继续。计划恢复只重试可证明安全的步骤，未知外部副作用保持待处理状态（Plan checkpoint 以 `deskpet.plan_checkpoint` 自定义条目落盘）。[`harness-slot.ts`](../../src/services/engine/pi/harness-slot.ts) 与 [`PlanCheckpointStore`](../../src/services/agent/memory/plan-checkpoint-store.ts)

忙碌输入的持久状态由 lane inbox 承担：投递即 commit 进会话文件；被消费即移出并进入正文；未消费项在停止/中断后归还，不会虚假 accepted。单项撤回经 `cancelQueued` 返回 `cancelled / already_consumed / not_found`；排队项另有只读视图（`listQueuedInputs`）供 UI/场景使用，UI 不再自建队列状态。显式投递意图选择、排队视图与单项撤回已落地（PI-1 的 UI 范围，协议见 [Pi 方案基线](../history/implementation/Pi运行时与工具协议建设方案-2026-09-20基线.md#3-steer-与-follow-up-双模式)）；更细的逐项证据状态（request_prepared 等）与停止入口尚未实施，见[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md#1-pi-协议剩余批次)。

投递意图由单条显式选择决定，未选择时取配置 `ai.conversation.defaultDelivery`；运行阶段只决定能否投递，不再替用户选择 steer/followUp。队列批量策略 `ai.conversation.steeringMode` / `followUpMode` 在每次运行开始前与配置对齐（按运行冻结）。steer 等当前响应及整个工具批次结束，followUp 等运行准备自然结束，均不硬中断工具。Slash 执行只有 ingress 一条路径（ChatPanel 只提交输入），命令按声明的 `busyPolicy` 准入：只读查询与独立窗口动作可立即执行，`/compact` 由运行边界报 busy/pending，改会话状态的命令在忙碌时明确拒绝而不是丢弃。

启动恢复隔离未知副作用。Plan 的运行中只读步骤可回 pending，没有完成凭证的外部副作用进入 unknown_side_effect，Plan 暂停，不能自动重试。Harness 重启后以 open 操作暴露中断运行，默认暂停并提示继续/丢弃，不自动重放。

## 请求生命周期

- 宿主 preflight（`runPiAgentTurn`）冻结 Card/变量/配置/能力并构建首个 systemPrompt；此后每个请求由 Harness 从已提交条目重建，宿主在 `transform_context` 只做 L0 工具结果投影与硬预算核对；硬预算超限不直接终止回合，判定经网关按上游溢出判据（length 停止、输出 0）上报，由 Harness 压缩后重试一次。压缩由 Harness 阈值/手动/溢出调度，摘要内核与提交语义见[当前记忆与会话基础](./memory.md#压缩提交与恢复)。
- 主回合与一次性文本请求经 [model-gateway.ts](../../src/services/engine/pi/model-gateway.ts)（createProvider/createModels + Harness Models 薄包装）。配置、认证、取消与增量响应上限共用；SDK 内层重试关闭，生成级重试由 Harness RetryPolicy 承担，有工具执行后的失败不自动重放整个回合。
- 请求循环由 AgentHarness Lane 承担：`transform_context` 投影、`before_tool` 承担权限/次数门禁、`after_tool` 标注来源与错误、`after_response` 剥离 RUNTIME_DATA 并记录状态/响应头、`before_payload` 采集脱敏快照；主回合逐请求 usage 进入 `main` 分项，压缩/规划等一次性调用经同一模型网关按 purpose 单列（[debug.ts](../../src/services/debug.ts)），总量由分项相加得到。具体权限见[工具系统](tool-system.md#权限终裁)。
- 项目没有通用 HookBus；宿主 preflight 与观测通道不构成可阻断的 Pi hook，队列驱动由 Lane 持久 inbox 承担。流式正文经 `message_update` 增量事件走 UI 通道，只展示正文、不展示思考内容，`<RUNTIME_DATA>` 跨分片被缓冲。

0.85.1 的 AgentHarness、JsonlSessionRepo 与压缩调度已接入为运行内核（§8 迁移已实施并通过 2026-09-18 集中验证，协议正文见[归档基线](../history/implementation/AgentHarness迁移方案-2026-09-18基线.md)）；插话双模式的输入意图选择、排队视图与单项撤回（PI-1 的 UI 范围）、工具策略与只读并行（PI-2）及 usage purpose 单列均已落地，当前验证证据与剩余批次见[未完成工作与已知缺口](../plans/active/未完成工作与已知缺口.md)。

## Pi、权限与网络

- [`PermissionKernel`](../../src/services/safety/permission.ts) 收敛 `allow / ask / deny`；MCP `passthrough` 必须在内核终裁。会话授权绑定 session、generation、工具、参数、策略与过期时间，取消或旧代际失效。
- Provider 请求固定在用户配置的 origin，禁用重定向；显式配置的 localhost/private provider 可以使用。该 WebView 边界不提供 DNS pinning、通用 SSRF 防护或 shell 网络沙箱。[`createProviderFetchGuard`](../../src/services/engine/pi/net-guard.ts)

## 快照与人格状态

- [`PromptSnapshot`](../../src/services/engine/runtime/snapshot.ts) 在 `transform_context`、`provider_payload` 和 `provider_usage` 阶段记录关联 ID、预算、分配、hash 与 usage。system block、消息和工具 schema 不持久化原始正文；快照只保留脱敏 hash。
- Card 和变量在回合开始冻结。回复中的 `RUNTIME_DATA` 只在当前 Card 的 id、hash、version 仍一致时写回；写入仍由变量注册表验证。[`generateReply`](../../src/services/reply/generator.ts) 与 [`batchWriteVars`](../../src/services/personality/variable-pool.ts)

## 尚未形成当前能力

默认 `MemoryProvider` 为空。没有 SQLite `MemoryStore`、自动长期事实提取、每轮长期召回、画像写入、dreaming 或 Memory Eval；这些属于 P6。
