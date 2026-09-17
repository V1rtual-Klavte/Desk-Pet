---
document_type: current_contract
status: code_checked
updated_at: 2026-09-17
scope: runtime-foundation-before-memory-kernel
---

# 当前运行时契约

本文记录已经落地的横向运行时边界；记忆与会话的存储、checkpoint 和预算细节由[当前记忆与会话基础](./memory.md)维护，长期记忆的后续目标见[记忆系统运行时契约](../plans/active/记忆系统运行时契约.md)。

## 会话、来源与恢复

- 普通输入先持久化再进入 Pi；会话事件使用同一会话锁、幂等键与版本/CAS。主动输入记录为 metadata，不进入 transcript；其回复带 `active` 来源，不能成为用户事实。[`runPiAgentTurn`](../../src/services/engine/pi/runtime.ts) 与 [`readContextView`](../../src/services/agent/memory/compaction-store.ts)
- `AgentSlot` 按 `sessionId + generation` 约束投递；忙碌输入走 `steer` 或 `followUp`。计划恢复只重试可证明安全的步骤，未知外部副作用保持待处理状态。[`agentSlots.deliver`](../../src/services/engine/runtime/agent-slot.ts) 与 [`PlanCheckpointStore`](../../src/services/agent/memory/plan-checkpoint-store.ts)

普通输入的持久化状态为 queued → dispatching → running → done/failed，Pi 完成后补 queue accepted/failed ack；忙碌输入先记 steered/followup，不能在 Agent 消费结束前记成成功。启动恢复隔离未知副作用。Plan 的运行中只读步骤可回 pending，没有完成凭证的外部副作用进入 unknown_side_effect，Plan 暂停，不能自动重试。

## 请求生命周期

- [`ContextKernel`](../../src/services/context/kernel.ts) 产生冻结的请求视图；首请求的准备是宿主 preflight，**不是** Pi hook。压缩只消费已提交 checkpoint；完整 round、L0 请求投影、硬预算和恢复语义见[当前记忆与会话基础](./memory.md#压缩提交与恢复)。
- 主回合与一次性文本请求经 [model-gateway.ts](../../src/services/engine/pi/model-gateway.ts) 使用 Pi createProvider/createModels。配置、认证、取消与增量响应上限共用；SDK 内层重试关闭，回合重试共享总 deadline，有工具执行后的失败不自动重放整个回合。
- Pi 负责 Agent loop。transformContext 重建请求视图并等待工具持久化；beforeToolCall 承担权限/次数门禁；afterToolCall 标注来源和错误；subscribe 收敛事件与写队列，onPayload/onResponse 提供请求与 usage 观测。具体权限见[工具系统](tool-system.md#权限终裁)。
- 项目没有通用 HookBus；prepareNextTurnWithContext 和 shouldStopAfterTurn 尚无生产接线，队列 drain 由 AgentSlot 驱动，不能把宿主 preflight 或观测总线称作可阻断 Pi hook。

## Pi、权限与网络

- [`PermissionKernel`](../../src/services/safety/permission.ts) 收敛 `allow / ask / deny`；MCP `passthrough` 必须在内核终裁。会话授权绑定 session、generation、工具、参数、策略与过期时间，取消或旧代际失效。
- Provider 请求固定在用户配置的 origin，禁用重定向；显式配置的 localhost/private provider 可以使用。该 WebView 边界不提供 DNS pinning、通用 SSRF 防护或 shell 网络沙箱。[`createProviderFetchGuard`](../../src/services/engine/pi/net-guard.ts)

## 快照与人格状态

- [`PromptSnapshot`](../../src/services/engine/runtime/snapshot.ts) 在 `transform_context`、`provider_payload` 和 `provider_usage` 阶段记录关联 ID、预算、分配、hash 与 usage。system block、消息和工具 schema 不持久化原始正文；快照只保留脱敏 hash。
- Card 和变量在回合开始冻结。回复中的 `RUNTIME_DATA` 只在当前 Card 的 id、hash、version 仍一致时写回；写入仍由变量注册表验证。[`generateReply`](../../src/services/reply/generator.ts) 与 [`batchWriteVars`](../../src/services/personality/variable-pool.ts)

## 尚未形成当前能力

默认 `MemoryProvider` 为空。没有 SQLite `MemoryStore`、自动长期事实提取、每轮长期召回、画像写入、dreaming 或 Memory Eval；这些属于 P6。
