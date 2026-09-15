# 当前记忆系统

## 已接通的能力

| 范围 | 真相源 | 当前用途 |
|---|---|---|
| 用户自定义指令 | `memory/CANDY.md` | 注入 System Prompt。 |
| 用户画像 | `memory/User.md` | 注入 System Prompt；由高重要性用户条目同步。 |
| 当前会话 | `sessions/*.md` | 会话正文唯一真相源；内存中的 `SessionMemory` 是当前会话缓存，用于生成与摘要。 |
| 会话 UI 状态 | `sessions/index.json` | 打开标签、活跃标签与未回复数；损坏或丢失不会影响 Markdown 会话恢复。 |
| 长期记忆注册表 | `memory/MEMORY.md` | 保存结构化条目，提供 CRUD、关键词搜索与整理。 |
| 会话归档索引 | `memory/Project.md` | 指向 sessions 目录中的历史会话。 |

会话每轮实时写入文件。正文只写一份 `deskpet-turn` 记录（可读预览行 + HTML 注释中的 URI 编码完整 JSON），事件视图由 `events.ts` 在读取时从 turn 记录投影；`deskpet-event` 只用于不进 transcript 的消息（当前只有主动搭话的 active 上下文）。读取时优先还原完整正文并兼容旧预览格式：预览行紧跟任意 deskpet 注释时跳过，避免同一条记录被按预览和注释重放两次；未知标签保守按 user 处理。上下文接近阈值时，压缩器调用 LLM 生成结构化摘要并写回会话文件。启动时会从 Markdown 重建会话，再恢复可丢弃的 UI 标签状态。

## 运行时基础（已落地）

`src/services/engine/runtime/` 与 `src/services/agent/memory/` 已提供会话事件协议、`SessionTurnStore`、`PlanCheckpointStore`、RuntimeQueue、AgentSlot 和 PromptSnapshot：

- 每条用户输入先写 `queued` 事件再调用 Pi；turn 状态按 `queued → dispatching → running → done/failed` 走版本/CAS，队列投递写 `persisted`/`steered`/`followup`/`deferred`/`accepted` 回执。
- 启动扫描会话事件：`persisted`/`requeued`/`deferred` 重新入队，进行中的 queue/turn 写 recovery 并隔离为未知副作用；Plan 运行中的只读步骤回到 `pending`，未知外部副作用进入 `unknown_side_effect` 并暂停计划。
- 主动搭话写 `origin=active`、`eligibleForMemory=false`、`querySource=active_monitor`，不产生用户事实事件。
- 上下文由 ContextKernel 按 `static → dynamic → profile → memory → transcript → ephemeral` 固定层级裁剪；`User.md` 以只读 profile projection 进入 profile 层。
- PromptSnapshot 在 `transformContext` 和 `provider_payload` 两阶段发布，只保存 hash、层级、工具策略和关联 ID，原始 Prompt 不落盘。
- 压缩由 `compactOnHighUsage()` 在上下文接近阈值时调用 LLM 生成结构化摘要并写回会话文件，不做消息切片；`compactMessages()` / `groupMessageUnits()` 的「保留最近 40%」截断没有生产调用点。API round 分级摘要、compaction 版本与 lock 仍未实施。

## 当前限制

- Prompt 当前只直接注入 CANDY、User 和当前会话摘要；长期记忆的关键词搜索尚未接入 Prompt 构建。
- `forkMemorySupplement()` 已有实现，但尚未接入正常对话结束链路，因此不能视为自动长期记忆提取能力。
- 恢复历史会话时，需要把摘要恢复与会话恢复作为后续可靠性改进项验证。
- 记忆整理能处理既有条目的去重、过期和重要性调整；它不是长期记忆提取闭环的替代品。

## 后续路线

1. 按[记忆系统运行时契约](../plans/active/记忆系统运行时契约.md)推进 P6：候选记忆提取、来源门禁、画像写入候选和 dreaming；阶段进度见[执行手册](../plans/active/记忆系统重构执行手册.md)。
2. 补齐 P4/P5 遗留：API round 分级压缩、compaction 版本与 lock、Provider 网络的重定向与私网 IP 防护。
3. 以关键词检索、重要性排序和固定 token 预算实现最小召回闭环。
4. 补充纠正、删除、冲突和过期处理；只有关键词检索不足时再评估向量检索。

运行时契约是实施目标，不是当前能力清单。长期记忆自动召回、画像写入和 dreaming 在通过对应 eval 门禁前仍视为未接通。

Card 变量用于人格状态，不承担长期记忆职责。
