---
document_type: archived_plan_section
status: archived
archived_at: 2026-09-18
superseded_by: ../../plans/active/Pi运行时与工具协议建设方案.md
---

> **Archived baseline.** 本文是 [Pi 运行时与工具协议建设方案](../../plans/active/Pi运行时与工具协议建设方案.md) §8 在 2026-09-18 的完整正文。H-1–H-4 已按此协议落地并删除旧内核，且通过当日的集中验证（证据见[执行手册](../../plans/active/记忆系统重构执行手册.md#已有验证证据)）。当前行为契约以 [current/runtime-contract.md](../../current/runtime-contract.md)、[current/memory.md](../../current/memory.md) 与 [current/system-design.md](../../current/system-design.md) 为准；本页只保留迁移协议、替换映射、hook 映射与批次设计，不再作为实现契约。

---
## 8. AgentHarness 迁移（运行内核替换）

原「只做可选验证」的结论已由用户决策取代：**采用 AgentHarness 作为运行内核，存储走 JsonlSessionRepo（format-4 JSONL）；现有会话数据是测试数据，不迁移、不做双格式。** 本节是迁移协议、适配面与批次的主要维护位置；实现前不得对外声称已具备这些能力。核对以安装包 `dist/harness/` 的类型与实现为准（`agent-harness.d.ts`、`runtime/lane.js`、`runtime/drive/*`、`session/jsonl/*`、`session/testing/*`）。

### 8.1 存储与范围

- `JsonlSessionRepo({ fileSystem, sessionsRoot, now? })` 直接产出 `Session`，不实现自定义 `Storage`；`StorageBackedSession` 仅在未来需要自持 metadata 时再考虑。
- 会话布局为 `<sessionsRoot>/--<cwd>--/<时间戳>_<id>.jsonl`，每会话一个文件；`cwd` 统一取数据根，不用它区分业务。`sessionsRoot` 直接取数据根的 `sessions/` 域（最终命名，不区分新旧；`sessions/index.json` 仅为可丢弃 UI 状态，与 JSONL 共存已实测）。
- `TauriExecutionEnv` 必须补齐 JSONL 用到的 `FileSystem` 方法：`appendFile`、`renameFile`、`createDir`、`remove`（已核对 dist 调用集：exists/remove/listDir/readTextLines/joinPath/fileInfo/absolutePath/writeFile/renameFile/readTextFile/createDir/appendFile）；`createTempDir` 视内置工具需要补。必要时在 Rust 侧增加对应命令并沿用现有路径边界校验与大小上限。
- 一个会话一个 lane（`"main"`）；不启用树导航与 fork 的 UI 入口，`before_navigation` 不注册业务。
- 落地时 `sessions/*.md` 停止产生新数据，旧文件按测试数据弃用；禁止长期双写两套权威状态。
- H-1 实现期发现（2026-09-17）：官方一致性套件 `fork destination reservation` 组第二 case 在官方 NodeExecutionEnv + node:fs 上同样稳定失败（16/17），根因在 `JsonlSessionRepo.fork` 的占位时序；场景如实排除该组并留证，不改写上游语义。（`file_list` 已按 FileSystem 契约直接返回全字段，无回填桥。）

### 8.2 替换映射

| 现有 | 去向 | Harness 承接物 |
|---|---|---|
| RuntimeQueue | 已删除（H-4） | Lane 持久 inbox：`LaneState.inbox`（`entryId` + `kind: steer/followUp/nextRun/write`），随 commit 落盘，消费即移出 |
| AgentSlotRegistry | 已删除（H-4） | Lane + 持久操作协议；代际由 `operationId` 与 `Control.cancel_requested` 表达 |
| [runner.ts](../../../src/services/agent/runner.ts) 投递/结算/批量确认 | 大部分删除 | `accept/drive/resume/abort`、`OperationResultRecord`、`cancelQueued` |
| [compactor.ts](../../../src/services/engine/compactor.ts) 调度与切点 | 调度删除、摘要内核保留 | 阈值/手动/溢出调度 + `prepareCompaction` 切点；摘要经 `before_compaction` 注入 |
| [runtime.ts](../../../src/services/engine/pi/runtime.ts) Agent 接线、transcriptWrites/flushTranscript | 重写/删除 | `createAgentHarness`、Hooks 注册表、`session.commit` 单事务、`lane.watch()`/`harness.events` |
| pi-tools.ts + [harness-adapter.ts](../../../src/services/tool/pi/harness-adapter.ts) 桥接 | 反向化 | `AgentHarnessTool`；`executionMode` 逐工具声明，`invocation.getMemo/setMemo` 为恢复位 |

### 8.3 注入点

| 注入点 | 内容 |
|---|---|
| `session` | §8.1 的 JsonlSessionRepo；会话的 create/open/list 由 Desk-Pet 会话管理调用，UI 元数据仍归宿主 |
| `models` | 薄包装现有网关：`streamSimple` 代理到 `piStream`（保留 NetGuard fetch 与 `maxRetries: 0`），其余方法直通。Harness 每次请求传入 `sessionId/abortSignal/telemetryContext`，包装层不得丢弃 signal |
| `tools` | 现有 ToolDef 适配为 `AgentHarnessTool`；权限询问移入 `before_tool` |
| `systemPrompt` / `toolContext` | 回合冻结的 Card/人格快照（回调形态）；首次 preflight 与回合重建职责维持 §6 |
| `toProviderMessages` / `entryProjectors` | 控制事件过滤与自定义 Entry 投影；RUNTIME_DATA 解析与回复提交仍在宿主 |

### 8.4 Hook 映射

| Hook | 职责 | 现有对应 |
|---|---|---|
| `before_run` | 冻结 Card/配置/能力快照 | preflight |
| `transform_context` | 最终投影、预算、L0 工具结果 | transformContext |
| `before_request` | streamOptions patch（超时/请求头） | 网关参数 |
| `before_payload` | payload 审计（脱敏快照） | onPayload |
| `after_response` | 状态码、响应头与 usage 观测 | onResponse + usage 记录 |
| `before_tool` | PermissionKernel 终裁：`block` 或改 args；可 await 交互确认 | beforeToolCall |
| `after_tool` | taint、结果投影、错误元数据 | afterToolCall |
| `before_compaction` | 返回自定义 `CompactResult`（按 `fromHook: true` 持久化）、`decline` 跳过，或留给默认摘要 | 自研压缩器 |
| `before_run_end` | 可选注入 followUp | — |

`before_drive` 为 fail-closed（钩子异常直接 fault 本次驱动），不注册重逻辑；其余钩子异常经 `handler_error` 事件上报，不静默。

### 8.5 原生承接的机制

| 方案目标 | Harness 机制 |
|---|---|
| §3.2 逐条证据链 | inbox 持久项、消费即移出、`OperationMeta.intent.promptEntryIds`、message_end 的 `entryId` |
| §3.1 单项撤回 | `cancelQueued` → `cancelled / already_consumed / not_found` |
| §3.3.5 停止归还 | `abort` 返回未消费的 `steer/followUp` 消息数组 |
| §3.3 取消收尾 | effect gate：取消后已准入的 effect 仍可结算（`settleOperation`），不丢已发生证据 |
| §6 逐请求 usage | `UsageRow` + `usage` 事件 totals + `recordUsage` |
| §7 压缩调度 | 阈值/手动/溢出 reason、一次性溢出恢复、迭代摘要（previousSummary）、长轮切分（turn-prefix） |
| 重试与延迟 | `RetryPolicy` + retry 事件 + `DeferredHandle`/`pollDeferred` |
| 工具恢复 | `invocation.getMemo/setMemo` 持久恢复位；memo 是 invocation 级恢复数据，不是永久缓存，未知副作用不自动 replay |
| UI 桥 | `lane.watch()`/`watchSession()` 快照 + 事件；`message_update` 提供流式帧 |

### 8.6 留在宿主的职责

PermissionKernel 终裁与 Rust 硬边界（经 `before_tool` 接线）、Card/人格、RUNTIME_DATA 解析与回复提交、记忆提取（读取源随 H 批次切换）、Slash/Preprocessor ingress、MCP 生命周期、NetGuard、Skill 渐进披露（`resources.skills` 传空，不引入第二份技能列表进 system prompt）。

### 8.7 风险与不变量

1. 双状态机：迁移期间现有事件/回合记录与 Harness 操作记录只能有一套生效；先切读、再切写、后删旧，禁止双写。
2. 交互确认：`before_tool` 内 await 用户确认时操作保持 running；取消经 gate signal 传导；确认绑定 lane/runId/精确参数，规则同 §4.2。
3. 恢复策略：`createAgentHarness` 只附着运行时、不启动副作用，返回 `open` 操作列表；默认暂停并提示用户继续/丢弃，不自动重放（对齐 §3.3.5）。
4. fault 处理：Harness fault 后该会话停止驱动，需宿主显式处理，不静默重建。
5. 不变量同步：AGENTS.md「sessions/*.md 真相源」与 runtime-contract/memory 的会话格式、压缩检查点章节随实现同批更新；文档不得提前宣称已迁移。
6. 不引入 Node 常驻进程；`NodeExecutionEnv` 与 Node SQLite adapter 不进口 WebView。
7. 回退：H-1/H-2 不通过则保持基础 Agent 与旧格式，不做半迁移；H-4 之前不删除旧链路。

### 8.8 验证

- 官方一致性套件：`createSessionRepoConformance` 及其 fork/lifecycle 变体返回 runner-independent 的 `ConformanceCase[]`，可直接注册进现有测试框架，对 `JsonlSessionRepo + TauriExecutionEnv` 验证存储协议（含重启恢复）。
- fake Provider：经 Models 包装层注入（沿用 `installPiRuntimeProviderForTest` 语义），经 production `sendMessage()` 驱动。
- Live Test：单 lane 接收/steer/followUp/取消/重启恢复/压缩；断言逐条证据、停止归还、未消费项不被错误确认。
- 完成标准维持：协议等价、可删除的宿主代码行数、包体/冷启动/空闲内存/首答延迟实测；不预设收益数字。

### 8.9 迁移批次

| 批次 | 内容 | 完成条件 |
|---|---|---|
| H-1 | 补全 TauriExecutionEnv 的 FileSystem（含 Rust 命令）；接通 JsonlSessionRepo；跑官方 conformance | 一致性套件通过；重启后会话可恢复 |
| H-2 | 单 lane 全链路：accept/drive/steer/followUp/abort/resume + 事件接 UI + fake provider 场景 | 输入不丢、不重复、不错误确认；停止归还未消费项 |
| H-3 | Hook 接线：before_tool 权限、transform_context Card、before_compaction 陪伴摘要、usage/流式正文 | 无第二 Prompt 真相源；成本可逐请求追溯 |
| H-4 | 删除 RuntimeQueue/AgentSlot/旧压缩调度/transcriptWrites；按 §8.7 同步文档不变量 | 无重复状态机残留；门禁与 Live Test 全绿 |
