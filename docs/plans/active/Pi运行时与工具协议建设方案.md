---
document_type: implementation_plan
status: pending_implementation
updated_at: 2026-09-17
code_baseline: a7fd393
dependency_baseline: pi-agent-core@0.85.1 / pi-ai@0.85.1
scope: conversation_delivery_tool_policy_pi_hooks_context_harness_migration
---

# Pi 运行时与工具协议建设方案

本文落实 Pi 能力审查与用户补充：**steer 是聊天感的核心，follow-up 同时保留；只读工具可以并行，写入等有顺序要求的工具串行；每个工具明确声明权限、输出压缩与执行策略。** §8 另行按用户决策确定用 AgentHarness 替换宿主运行内核：存储走 JsonlSessionRepo，旧会话数据按测试数据弃用。本轮仅形成文档，下面的新增字段、UI、调度、迁移和验收均未实现，旧测试记录不能证明这些目标已通过。

当前事实分别维护在[运行时契约](../../current/runtime-contract.md)、[工具系统](../../current/tool-system.md)、[记忆与压缩](../../current/memory.md)。本文是目标协议的主要维护位置，执行进度只记录在[执行手册](记忆系统重构执行手册.md#当前检查点)。不要求每次任务通读本文：插话读 §3，工具读 §4–5，Pi 接线读 §6，压缩读 §7，Harness 迁移读 §8，实施与配置读 §9–10。

## 1. 范围与架构决策

1. 先改善陪伴聊天的插话可靠性、响应反馈、成本与上下文连续性；不要求先完成长期 MemoryStore。
2. `steer`、`followup` 是显式输入意图，不再由 AgentSlot 的 streaming/settling 阶段替用户选择。阶段只决定能否交给当前运行，不能改变原始投递意图。
3. 复用 Pi Agent 的队列、事件、工具执行与原生 hook；宿主负责持久化、输入身份、权限、Card 与 UI。事件存储和 Pi 内存队列不是两份同等权威的 Store。
4. 在现有 `ToolDef` 上统一策略，提供薄 `BaseTool` 与注册工厂；不另建平行的 ToolSpec 注册表、权限内核或 Agent Loop。
5. 首轮开放 Pi 原生只读批次并行，明确其混合批次限制。执行限流/互斥由现有工具入口收敛，不重新实现 Pi 的调用排序与消息生成。
6. 工具“允许压缩”分成请求结果投影与历史摘要两个维度；不表示允许删除持久原文、拆散调用配对或丢弃副作用证据。
7. 继续用现有模型网关和 ContextKernel。采用 Pi 的估算/切分思路前，先验证协议映射；不因依赖有 `compact()` 就绕过网关和 checkpoint。
8. 采用 AgentHarness 替换宿主运行状态机（§8）：存储走 JsonlSessionRepo，只补全 TauriExecutionEnv 的 FileSystem 能力；旧会话数据按测试数据弃用，不迁移、不双写。宿主自建的队列、确认与压缩调度由 Harness 承接；PI-2 工具策略保持独立实施。

## 2. 已核对能力与现状

### 2.1 当前缺口

| 位置 | 已有实现 | 本方案处理的缺口 |
|---|---|---|
| [AgentSlot](../../../src/services/engine/runtime/agent-slot.ts) | streaming 调 steer，settling 调 followUp | 无显式用户投递选择；收尾阶段仍可能向已停止消费的 Pi 队列投递 |
| [Runner](../../../src/services/agent/runner.ts) | 先落盘，忙碌消息记 steered/followup | `settleDeliveredEntries()` 按父回合结果批量确认，缺逐条消费/请求/回复关联 |
| [ChatPanel](../../../src/components/ChatPanel.vue)、[Preprocessor](../../../src/services/engine/preprocessor.ts) | 忙碌时仍能输入，均存在 Slash 执行入口 | Slash 可绕过统一运行策略；尚无双模式发送与排队状态展示 |
| [Pi runtime](../../../src/services/engine/pi/runtime.ts) | 原生权限 hook、上下文转换、事件写队列 | 全局固定 sequential；未接下一轮准备/停止 hook；usage 主要取最后一个 assistant |
| [ToolDef](../../../src/services/tool/types.ts)、[Router](../../../src/services/tool/router.ts) | 统一注册，已有风险/权限函数/效果分类 | 并行由 actionCategory 推导，未统一声明结果投影/摘要/replay 策略 |
| [L0 投影](../../../src/services/context/tool-output.ts) | 工具长结果缩短并保留 eventId | 未按工具策略区分；分页恢复结果也可能再次被缩短 |
| [compactor](../../../src/services/engine/compactor.ts) | 陪伴/助手摘要、完整轮、来源校验与 CAS | 最新长工具轮难以压缩；估算未按每次真实请求 usage 校准 |

上述竞态是静态审查发现的风险，须通过 §10 场景验证；不能写成已复现、已修复或已通过。

### 2.2 Pi 0.85.1 公共能力清单

| 能力组 | 公共能力 | 本项目取舍 |
|---|---|---|
| Agent / 底层 loop | prompt、continue、agentLoop、直接 event sink；消息/模型/工具状态 | 保留 Agent，不下沉重写循环 |
| 队列与取消 | steer、followUp、all/one-at-a-time、清队列、abort、waitForIdle、reset | 接双模式与逐条持久化确认 |
| 消息与事件 | 自定义消息转换，Agent/turn/message/tool 开始、更新、结束；文本/工具增量 | 内部身份不进模型；UI 用正文增量；关键落盘用可等待事件 |
| 原生 hook | transformContext、convertToLlm、before/afterToolCall、shouldStopAfterTurn、prepareNextTurn(WithContext)、onPayload/onResponse | 按 §6 单一职责接线 |
| 工具协议 | 参数预处理/校验、串并行、部分结果、错误、批次终止提示 | 元数据适配到 Pi；权限与资源边界留宿主 |
| 执行环境与基础工具 | ExecutionEnv、read/write/edit/bash、截断与输出捕获 | 已通过 TauriExecutionEnv 复用，继续使用 |
| 压缩与分支摘要 | shouldCompact、estimateContextTokens、prepareCompaction、findCutPoint、compact、generateSummary、branch summary | §7 渐进复用，保留项目提交协议 |
| Skill / Prompt 模板 | 加载、来源、诊断、格式化；位置参数模板 | 保留有界元数据发现；正文按需读，不启动全量加载 |
| 系统提示辅助 | 工具/资源相关提示构建 | 不覆盖 Card 协议，不引入第二个 Prompt builder |
| Session / Storage | MemorySessionRepo、JsonlSessionRepo、StorageBackedSession、分支/fork、条目与 usage | 采用 JsonlSessionRepo 作为会话存储（§8.1）；旧 sessions/*.md 按测试数据弃用 |
| AgentHarness | lane、accept/drive/resume/abort、steer/followUp/nextRun/cancelQueued、watch、重试/deferred、自动压缩、导航 | 迁移为运行内核（§8）；分支导航不启用 |
| 观测与代理 | telemetry/span、内存/空观测实现、streamProxy、Provider cache hint | 复用关联身份；不增加常驻代理或原始 Prompt 日志 |
| 搜索扩展 | SessionSearchService 接口 | 不提供内置中文检索、向量库或长期记忆引擎 |

`MemorySessionRepo` 是内存会话仓库，不是长期记忆；基础 Agent 的 `sessionId` 不等于持久化；`streamProxy` 不自带服务端。Provider/模型目录、流协议、usage、缓存与 reasoning 主要属于 pi-ai。权限四态、MCP 生命周期、Card、长期事实提取仍由 Desk-Pet 管理。

核对以安装包 public exports、类型与固定 tag 实现为准，设计文档或示例的签名不一致时不能直接照抄：

- [官方导出](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/index.ts)、[Agent README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/README.md)、[Agent API](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent.ts)、[类型与 hooks](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts)。
- [循环与工具批次](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts)、[Harness 公共接口](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/agent-harness.ts)、[Session 协议](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/types.ts)。
- [压缩算法](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/compaction/compaction.ts)、[阈值调度](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/checkpoint.ts)、[溢出恢复](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/response.ts)、[工具恢复](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/tools.ts)。

## 3. Steer 与 follow-up 双模式

### 3.1 用户可感知语义

| 操作 | 忙碌时的行为 | 界面表达 |
|---|---|---|
| 插话（默认） | 当前响应及其工具批次完成后，进入下一次请求 | 已排队插话；真正进入请求后显示“已加入本次对话” |
| 稍后继续 | 当前运行自然准备结束时，继续处理 | 等当前任务结束后继续 |
| 停止 | 取消当前 session/run，等待请求与工具收尾 | 正在停止；不暗示已经撤销写入 |

输入框和发送按钮保持可用；发送按钮附轻量选择入口，不把 Pi 函数名放进普通用户文案。空闲时两种发送都直接开启正常回合，并保留原始投递意图。提供排队项查看与取消；已被 Pi 接管的队列项只有在消费前可确认撤回时才报告撤回成功，否则提示已经开始处理。

宿主只对自己仍持有、未投递的消息提供单项取消；已投递项由 Harness 的 cancelQueued 按 cancelled / already_consumed / not_found 精确回应（§8.5），不靠 clearAllQueues() 假装精准取消。

建议初始策略：steeringMode=`all`，让同一安全边界前积压的补充一起进入下一次请求；followUpMode=`one-at-a-time`，保留后续话题的逐项边界。设置可切换，但一条消息身份不因批量而合并消失。一个 batch 可关联一个回复，不能伪称每条输入都有独立回复。忙碌输入的 now/next/later 不会自动重排 Pi 内存队列；外层优先级不能覆盖用户选择的 steer/followup 语义。

steer 不打断当前网络请求，不跳过当前响应里剩余工具，也不回滚已执行的副作用。改善体感靠及时显示、短而有界的工具批次、只读并行和流式正文；不能承诺“发送后立刻取消原回复”。

### 3.2 一条输入的证据链

复用 QueueEntry、TurnRecord 与 session event，按稳定 requestId/user eventId 关联，不再新建独立 delivery 文件。下面是事件阶段，不要求把每个阶段都扩成一套新的全局枚举：

| 阶段 | 可验证证据 | 不能据此声称 |
|---|---|---|
| queued | 原始输入、意图、session、幂等身份已持久化 | Pi 已消费 |
| offered | 调用了当前代际的 steer/followUp；记录现有 steered/followup 回执 | 已进入模型请求 |
| context_committed | Pi 的 user message_end 与 deskpetEventId 对应，宿主事件已落盘 | Provider 已收到，或任务已完成 |
| request_prepared | 最终请求投影确实包含该输入；关联 apiRoundId、contextEpoch、snapshotId/hash | 远端已经接收；onPayload 只证明 payload 构造 |
| request_started | 模型网关开始执行该次请求，写入请求关联 | 服务端确认接收或 exactly-once 执行 |
| responded | 关联请求产生的有效 assistant 响应已落盘 | 工具链和后续任务全部结束 |
| settled | 所属处理链正常终态，所有已开始工具有结果记录，输入有响应归属 | 模型一定满足用户意图；这是执行结论而非质量判断 |

最少复用/补充 sessionId、requestId、turnId、userEventId、runGeneration、deliveryMode，以及消费 apiRoundId、请求关联、responseEventIds/batchId、失败原因。已有键足够时不新增重复 deliveryId。Provider payload 不发送 deskpetEventId，关联留在宿主请求记录。

`accepted/done` 只能由该输入的关联终态推出；禁止因同 session 父 run 成功批量确认所有 offered 项。assistant 带工具调用的 message_end 不是最终处理完成。`all` 模式使用 batch → 多输入映射；日志和 UI 不虚构一对一回答。

### 3.3 收尾竞态、取消与恢复

1. AgentSlot 增加明确的接收窗口，绑定 session/generation；在 Pi 原生 `agent.subscribe` 的 agent_end 回调中先同步关闭向当前 Agent 的新投递，再 await 落盘或观测。异常兜底在 finally 按同代际幂等关闭。不能用 RuntimeTrace 的同名事件代替：当前订阅和 finally 都发布该 trace，且遥测监听非阻塞，不是生命周期门。关闭窗口与 reconciliation 不能等待长耗时快照结束后才执行。
2. 关闭后新输入只进入持久外层队列。入队路径再次检查 slot，若已空闲主动触发同 session drain；不能只依赖父 run finally 中的一次 peek。
3. 对每个 offered 项按持久事件核对：未消费的回到 deferred；已落盘但未开始请求的按原 eventId 重建下一次上下文，禁止重复追加用户正文。
4. request_started 后缺少终态先记 interrupted/待核对。只有能证明请求未执行工具且重试不重复副作用时才走现有受限重试；工具开始但结果未知必须 unknown_side_effect，不自动重放。基础阶段宁可保留待处理状态，不能假定网络失败等于远端没执行。
5. 用户显式停止不会自动把未处理输入继续执行；剩余输入暂停，用户选择继续或丢弃。自然结束的末端竞态才自动 deferred/drain，避免“停止后马上又回复”。
6. 取消后仍保存已经发生的工具结果与完成凭证；未确认进程退出的 timeout 不能当成工具已经停止。切换 session 不串写、不取消另一会话，旧代际不能关闭新运行的接收窗口。
7. 恢复读取真实事件阶段，不依赖卸载前的 Vue 状态或 Pi 队列。保证输入不重复追加，不宣称网络/外部服务具有 exactly-once 语义。

### 3.4 Slash 与入口归一

ChatPanel 只负责提交输入，Slash 执行收敛到 ingress。命令声明 busy policy：只读查询可立即执行；`/compact` 等变更请求视图的命令由同会话安全边界协调；清空会话、切换 Card 等先停止并完成收尾，或明确排队/拒绝。不得在 UI 和 preProcess 各保留一条执行路径。

空文本、输入归一化、去重属于 ingress，只执行一次；不搬到每轮模型 hook。来自主动搭话或系统的输入保持原 origin/taint，不能借队列映射成用户事实。

## 4. 统一工具声明与薄抽象类

### 4.1 单一描述与目标类型

`ToolDef` 仍是注册、权限、调度、上下文与设置说明共同读取的契约。`ToolSpec` 仅表示它去掉 handler 的描述部分，不是第二份注册模型。简单工具经 defineTool 注册，复杂工具可继承 BaseTool；Pi/MCP 适配器最终都产出同一 ToolDef。

以下为目标形态，尚不是现有源码 API；原有 name/id/schema、风险判断、来源、模式和 actionCategory 保留：

```typescript
interface ToolPolicy {
  version: number
  permission: {
    defaultDecision: "allow" | "ask" | "deny" | "passthrough"
    check?: (args: Record<string, unknown>, ctx: ToolContext) =>
      ToolCheckResult | Promise<ToolCheckResult>
  }
  execution: {
    effect: "read" | "local_mutation" | "process" | "external_side_effect"
    mode: "parallel" | "sequential"
    isolation: "shared_read" | "exclusive_effect" | "delegate"
    replay: "never" | "safe"
    timeoutMs?: number // 未声明时统一取现有 loopConfig.toolTimeoutMs
  }
  context: {
    resultProjection: "preserve" | "reference"
    historyCompaction: "summarize" | "retain"
  }
}

// ExistingToolDef 仅指改造前类型，示意迁移时移除旧策略字段。
type ToolSpec = Omit<ExistingToolDef,
  "handler" | "permissionCheck" | "effectClass" | "timeoutMs"
> & { policy: ToolPolicy }
type ToolDef = ToolSpec & {
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

abstract class BaseTool {
  abstract readonly spec: ToolSpec
  abstract execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>

  toDefinition(): ToolDef {
    return defineTool(this.spec, this.execute.bind(this))
  }
}
```

defineTool/注册入口统一校验并冻结描述；BaseTool 不保存会话、授权和全局锁，不为每个工具再创建 Provider/MCP 连接。已有 permissionCheck/effectClass/timeoutMs 迁入相应 policy 时一次性改完消费者；仅在迁移入口接受旧形态，不能同时维护新旧字段默认值。

约束：parallel 必须是经宿主确认的只读能力；exclusive_effect 必须 sequential；delegate 只用于宿主编排工具且 sequential。普通工具不得通过模型参数改变这些声明。新内置工具缺策略视为注册错误；旧事件和外部 MCP 采用显式保守适配，不能缺省成可并行/可重放。

### 4.2 权限、配置与来源

- defaultDecision 是工具侧意见，动态 check 是本次参数附加约束，PermissionKernel 才是终裁。deny 优先，ask 不被 allow 抹掉；passthrough 表示继续框架策略，不能流到执行器。
- write/edit 建议工具侧 ask；read 可为 allow，但敏感路径、禁用开关、模式和 Rust 安全基线仍能提高为 ask/deny。Bash 用 passthrough 加现有参数级风险规则，不能仅凭工具名放行。
- MCP 一律声明 passthrough，保持助手模式按需连接；pet 不注册，绕过注册直接调用也由模式规则拒绝。未知能力以 external_side_effect、sequential、never 处理，助手模式的框架初始意见至少 ask，只有当前精确范围的有效授权才能继续。当前 MCP 已有 assistant 模式限制，不能把 NORMAL 等级误报成 pet 可直接执行的漏洞。MCP annotations 只能作提示，不能直接授予只读并行、重试资格或执行许可。
- 工具策略、已验证来源与规则版本进入回合快照和 policyHash。函数不能靠 JSON 序列化形成身份；用明确规则版本/实现标识关联，策略变更后旧授权失效。
- 展示的脱敏参数摘要不是授权参数；授权仍绑定精确 args hash、session/generation、toolCallId、策略和到期时间。等待执行许可后重新核对，避免确认有效但排队后已经取消/过期。
- actionCategory 继续负责人格阶段文案，不再偷偷决定并行、权限或压缩。风险等级和权限意见是不同维度，不用一个枚举兼任。
- 完整 policy 供宿主与设置页读取，不整块注入模型工具 schema；模型只看到完成调用所需的名称、说明和参数，保持 token 成本可控。

### 4.3 工具策略矩阵

以下是目标声明，不代表本轮已改变安全配置。allow/ask 均为工具侧意见，实际结果仍受 PermissionKernel 限制；`reference` 只允许对已持久化且可定位的文本结果做 L0 投影。

| 工具 | 权限意见 | 执行/隔离 | 请求结果投影 | 历史摘要 | 恢复重放 |
|---|---|---|---|---|---|
| read | allow + 敏感路径检查 | parallel / shared_read | 文本 reference；图片保留结构 | summarize 完整旧轮 | 首轮 never |
| system_info | allow | parallel / shared_read | reference | summarize | never |
| read_session_event | allow + 固定会话/eventId | parallel / shared_read | preserve；源头有界分页 | summarize | never；未来可验证稳定视图 |
| clipboard_read | passthrough + 现有隐私策略 | parallel / shared_read | reference | summarize | never，读取对象易变 |
| write / edit | ask + 路径/开关检查 | sequential / exclusive_effect | preserve 成败/路径/错误；长附属 diff 可显式引用 | summarize，保留副作用结论 | never |
| bash | passthrough + 参数风险 | sequential / exclusive_effect | reference；保留 exit/取消/错误元数据 | summarize | never |
| clipboard_write / app_open | passthrough + 现有风险策略 | sequential / exclusive_effect | preserve | summarize | never |
| agent_spawn | passthrough + 子代理策略 | sequential / delegate | reference，保留子运行身份 | summarize 完成的子运行 | never |
| MCP 未知能力 | passthrough | sequential / exclusive_effect | reference 仅可存档文本；其他内容保留类型 | summarize 完整旧轮 | never |
| 宿主验证的只读 MCP | passthrough | parallel / shared_read | 同上 | summarize | never；不能靠 readOnlyHint 自动升级 |

工具下线或被配置禁止时有效结果为 deny，不必另造一个“禁止工具”类。若新增必须原样保留的特殊工具，用 historyCompaction=retain 显式声明，并遵守 §5.2 的预算后果。

replay 字段只表达工具是否可能满足安全恢复条件，不自动启用重试。首轮全部设 never；未来有实际恢复消费者时，只有无副作用、输入和读取视图可验证稳定的工具才可启用 safe，且仍受运行记录检查。不要把“只读”当成“重复执行返回相同结果”。

## 5. 并行与压缩的执行约束

### 5.1 原生调度与并发边界

Pi Agent 全局改为 `toolExecution: parallel`，每个工具的 executionMode 来自 policy，而非 actionCategory 白名单。Pi 0.85.1 先顺序执行 preflight；**批次内任一工具 sequential，整个批次都会串行**。因此 read+read 可以并行，read+write 仍串行。本阶段不承诺混合批次中任意只读子集并行，也不通过 Promise.all 二次调度 Pi 工具。

并行还需要统一的有界执行许可，接在现有 ToolRouter/执行入口。目标所有者是 Rust AppState 中应用级 permit 服务，前端工具执行前借用、完成后释放；它只管理额度与互斥，不重建 Pi 的队列和 toolResult 调度。许可带 window/session/runGeneration/operationId，获取等待可取消，取消/失联按实际进程或调用状态收尾；不能用超时自动释放仍在运行的写任务。Live Test 使用隔离的测试许可域，不干扰用户运行。

- shared_read 共用可取消的并发上限；exclusive_effect 与受管理的其他读写执行互斥。排队不持有确认弹窗，等待期间能取消；有写入等待时不允许无限新增读任务造成饥饿。
- 互斥范围覆盖同应用的会话和子代理，不能只锁一个 Agent 的 batch。初期采用保守的全局效果互斥，不提前实现路径锁/远端资源锁。它只约束 Desk-Pet 托管的调用，不承诺阻止外部进程改文件。
- 多个 WebView 通过同一 Rust 所有者获取许可，不能每个窗口各建互不相知的锁；最终进程执行与退出状态由 Rust 对应命令确认。
- agent_spawn 等 delegate 只串行父批次，本身不获取全局工具执行 permit；把父运行/取消身份传给子运行，子工具以各自 operationId 单独取许可。编排入口不得自行执行文件写入等效果，否则必须走受管理工具边界。回合/子代理数量继续受现有预算约束。
- 获得许可后重新验证授权、generation、取消、参数和策略；确认后排队不能成为绕过检查的通道。许可在真实执行结束后释放，不能仅因 Promise.race 超时就让仍运行的写进程与下一次调用并发。
- tool_execution_end 可按完成顺序用于 UI，Provider toolResult 保持 Pi 的源调用顺序；落盘保留 callId/apiRoundId/appendSequence，不按 UI 到达顺序猜配对。全部结果持久化后才发下一请求。

### 5.2 “允许压缩”的精确定义

| 策略 | 允许什么 | 禁止什么 |
|---|---|---|
| resultProjection=reference | 请求中用有界片段、长度、eventId/内容引用代替大文本 | 删除存档；省掉工具身份、成败与必要错误；把未存档结果换成无法读取的占位符 |
| resultProjection=preserve | 当前请求使用完整的已返回结果；源工具先负责分页/限量 | L0 再次任意截字；绕过硬输入上限 |
| historyCompaction=summarize | 完成的旧调用与结果随完整轮进入 L1 摘要 | 拆散 toolCall/toolResult、覆盖在飞调用或把结果当授权 |
| historyCompaction=retain | 该调用配对继续以原文保留 | 让整个轮被摘要覆盖后只剩无来源的“已处理” |

`preserve` 只限制 L0，不代表永不参加历史摘要；`retain` 不代表永远绕过预算。第一阶段继续使用连续完整轮 checkpoint：遇到 retain 的轮次就不能把压缩覆盖边界推进越过它。无法达到预算时明确提示，不悄悄改成非连续 coveredEventIds。若未来需要从中间抽出 pin，须单独升级 checkpoint 协议。

只对确有需要且有界的内容使用 retain，常规读/写工具默认都允许完整旧轮摘要。控制事件、授权证据、call/result 身份、取消与未知副作用记录本身不由文本摘要替代。

工具返回结果先保存，后投影；策略版本及可序列化决策快照随事件保存，恢复不能只查询“今天的注册表”解释旧调用。历史事件缺策略时采用保守读取兼容：不新增不可恢复的结果投影，仍按既有完整轮规则摘要。

read_session_event 返回的页不再套用同一 L0 缩短，页大小由统一预算限制；禁止“引用 → 读取 → 再变成引用”的循环。图片/结构化内容保留类型与可用引用，不按普通文本字符切割。

preserve 的源工具必须按本轮预算产生有界输出。分页工具在请求前预留页预算，返回 offset/nextOffset/总量；剩余空间不足以放最小有效页时，返回明确的 budget error，不先返回超大页再截字。多个并行读取共享总结果预算，不能各自独占一份“剩余预算”。若工具执行期间插话增加了输入，下一请求仍须重新核对：可先摘要允许压缩的旧轮，仍不够则报告上下文不足，不能悄悄降级 preserve。

“保留原文”指工具实际返回并被接收的内容。Bash 在工具层已经截断的输出与会淘汰的 spill 不承诺永久完整；如要永久保留，必须另行采用有明确生命周期的 artifact，而不是把临时 spill 当事实存储。

## 6. 原生 hook、流式输出与 usage

| 位置 | 单一职责 | 注意事项 |
|---|---|---|
| 宿主 ingress / 首次 preflight | 输入、Slash、冻结 Card/配置/能力、构建首请求 | Pi prepareNextTurn 不覆盖首请求 |
| prepareNextTurnWithContext | 已完成工具轮后的重建/压缩准备；返回下一轮 context | 保留输入与事件映射，移除 requestSystemPrompt 的第二份旁路覆写；不得静默切 Card/模型 |
| transformContext | 最终消息投影、ToolPolicy 的 L0 与预算核对 | 只由 committed checkpoint 授权移除历史；遵守不 reject 的契约，错误交网关阻断 |
| convertToLlm | 过滤宿主控制消息与 deskpetEventId，转 Provider 消息 | 不在此处落盘、执行 Slash 或运行摘要 |
| beforeToolCall | 调用先落盘、参数验证后权限/次数检查 | 许可等待后的有效性由执行入口再查 |
| afterToolCall | 结果来源/taint、错误、策略结果元数据 | 不伪造成功；不删除持久原文 |
| shouldStopAfterTurn | 已完成批次后按 API 轮数/成本/停止请求收束 | 在队列消费前停止，须回收未处理输入；不是硬取消在飞工具 |
| subscribe | message_end 分类落盘、队列证据、流式 UI、原生 agent_end 关闭投递 | 先关接收窗口再 await；不订阅 RuntimeTrace 来控制执行；delta 不做逐 token 磁盘写入 |
| onPayload / onResponse | payload hash/最终投影，响应状态与响应头观测 | payload 构造不等于网络成功；onResponse 不是完整 usage 回调 |
| 网关 / assistant message_end | 请求开始与每次响应 usage/失败记录 | 失败响应有 usage 也计成本；不能只计最后一条 assistant |

Pi Agent.subscribe 的异步监听器按序等待，属于运行收尾；低层异步事件流的外部消费者不能自动获得同样的阻塞保证。整理现有 transcriptWrites 时保留已验证的持久化顺序，不能为了删 flush 而让工具先执行。

usage 逐 apiRound 记录模型、输入/输出、cacheRead/cacheWrite、可用成本与 contextEpoch，再汇总为 run。压缩/规划等一次性调用按 purpose 单列，并提供总消耗视图；不能冒充主回复统计，也不能从总成本中消失。Provider 未报告的数据标 unknown，不能填零当准确值；是否计费以 Provider 元数据为准，不重复相加已经包含缓存的 total。

流式 UI 仅展示正文，不展示 thinking；跨分片识别 `<RUNTIME_DATA>` 的起止，缓冲可能的标签前缀。delta 只更新 transient 展示，不直接提交正文或副作用。message_end 按 user/assistant/toolResult 分类：user 关联输入消费，toolResult 保存工具结果，assistant 只结束对应消息的流式缓冲并记录 usage。带 toolCall 的 assistant 在工具执行前就会 message_end，只作过程展示/审计，不能结算输入、触发变量或效果。

只有 turn_end 已确定该轮工具状态、且该 assistant 是有效的终态回复时，才交 reply/generator 校验后提交最终正文、RUNTIME_DATA、变量和效果；以 message identity 保证只提交一次，失败/截断响应不伪装正常终态。follow-up 的前一条完成回复仍需展示，不只保留整个 Agent run 的最后一条；steering 中间响应按身份更新，不重复插入。最终回复处理继续校验 session/generation 和 Card 快照。

## 7. 压缩算法的渐进复用

Pi 0.85.1 根入口已经提供压缩；基础 Agent 不自动调度，Harness 才集成阈值与一次溢出恢复。默认 reserveTokens=16,384、keepRecentTokens=20,000，其中后者是保留原文，不是本项目压缩余量。当前默认窗口仅 16,000，不能直接套用 Pi 默认值。

实施顺序：

1. 先保存逐请求 usage，以最近有效 usage + 新增消息估算作校准参考；本项目现有估算和 Pi 字符估算都不是精确 tokenizer。
2. 校准记录绑定 model、system/tool schema fingerprint、contextEpoch 和请求投影。压缩、模式或工具 schema 变化后旧基线失效；从磁盘恢复时不能用 EMPTY_USAGE 冒充有效测量。避免在已经含 system/schema 的 usage 上重复加一遍。
3. 保留 ContextKernel 的静态前缀、全请求预算、输出与压缩余量。策略复用只替换选择/估算环节，不取代已有结构化陪伴摘要和来源校验。
4. 为单个过长工具任务评估 Pi 的安全切点与 turn-prefix summary。Harness 迁移（§8）后由 prepareCompaction 原生提供该切分；迁移前继续不拆最新完整轮，retain 工具仍不能被覆盖。
5. Harness 迁移（§8）后压缩调度由 Harness 执行；陪伴摘要在 before_compaction 钩子内用现有网关（completePiText）生成并以自定义 CompactResult 返回，认证、取消、deadline、响应上限与审计保持在同一网关内；不需要 compactWithRequest，也不深引私有 dist 文件。
6. 不以默认编码任务摘要取代称呼、纠正、未完成话题与关系连续性；摘要不产生记忆写入或工具授权。比较摘要质量、请求次数、token、失败率与延迟后再扩大复用。

以上是会话上下文工作，可以在 P6 之前完成。长期事实抽取、SQLite、中文检索、纠正/遗忘仍按[P6 契约](记忆系统运行时契约.md)实施，不因压缩算法改变而合并成一个模块。

## 8. AgentHarness 迁移（运行内核替换）

原「只做可选验证」的结论已由用户决策取代：**采用 AgentHarness 作为运行内核，存储走 JsonlSessionRepo（format-4 JSONL）；现有会话数据是测试数据，不迁移、不做双格式。** 本节是迁移协议、适配面与批次的主要维护位置；实现前不得对外声称已具备这些能力。核对以安装包 `dist/harness/` 的类型与实现为准（`agent-harness.d.ts`、`runtime/lane.js`、`runtime/drive/*`、`session/jsonl/*`、`session/testing/*`）。

### 8.1 存储与范围

- `JsonlSessionRepo({ fileSystem, sessionsRoot, now? })` 直接产出 `Session`，不实现自定义 `Storage`；`StorageBackedSession` 仅在未来需要自持 metadata 时再考虑。
- 会话布局为 `<sessionsRoot>/--<cwd>--/<时间戳>_<id>.jsonl`，每会话一个文件；`cwd` 统一取数据根，不用它区分业务。`sessionsRoot` 取数据根下的 `pi-sessions/`，与旧 `sessions/*.md` 分开，避免混读。
- `TauriExecutionEnv` 必须补齐 JSONL 用到的 `FileSystem` 方法：`appendFile`、`renameFile`、`createDir`、`remove`（已核对 dist 调用集：exists/remove/listDir/readTextLines/joinPath/fileInfo/absolutePath/writeFile/renameFile/readTextFile/createDir/appendFile）；`createTempDir` 视内置工具需要补。必要时在 Rust 侧增加对应命令并沿用现有路径边界校验与大小上限。
- 一个会话一个 lane（`"main"`）；不启用树导航与 fork 的 UI 入口，`before_navigation` 不注册业务。
- 落地时 `sessions/*.md` 停止产生新数据，旧文件按测试数据弃用；禁止长期双写两套权威状态。
- H-1 实现期发现（2026-09-17）：`file_list` 只回 `name/kind(dir/file)/size`，与 FileSystem 契约的 `path/mtimeMs/"directory"` 不符，当前由 TauriExecutionEnv 用 `file_info` 回填；Rust 侧补齐字段后可删除回填桥。官方一致性套件 `fork destination reservation` 组第二 case 在官方 NodeExecutionEnv + node:fs 上同样稳定失败（16/17），根因在 `JsonlSessionRepo.fork` 的占位时序；场景如实排除该组并留证，不改写上游语义。

### 8.2 替换映射

| 现有 | 去向 | Harness 承接物 |
|---|---|---|
| [RuntimeQueue](../../../src/services/engine/runtime/queue.ts) | 删除 | Lane 持久 inbox：`LaneState.inbox`（`entryId` + `kind: steer/followUp/nextRun/write`），随 commit 落盘，消费即移出 |
| [AgentSlotRegistry](../../../src/services/engine/runtime/agent-slot.ts) | 删除 | Lane + 持久操作协议；代际由 `operationId` 与 `Control.cancel_requested` 表达 |
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

## 9. 分批实施与配置同步

| 批次 | 内容与主要落点 | 完成条件 |
|---|---|---|
| PI-1 | ChatPanel/Runner 的输入意图选择与排队状态展示；宿主队列/确认/AgentSlot 由 §8 迁移承接 | 输入意图可显式选择、状态不虚构；不再新写宿主队列 |
| PI-2 | ToolDef/注册/适配器、PermissionKernel、Router、L0、设置说明 | 每个工具策略完整，纯读并行/写互斥、分页不反复压缩；不存在双套字段消费者 |
| PI-3 | model-gateway、reply/UI：按 §8.4 接原生 hook、逐请求 usage、流式正文 | 无第二份 Prompt 真相源；元数据不泄漏，所有请求成本可追溯 |
| PI-4 | 陪伴摘要内核（结构、来源校验）接入 before_compaction 与 usage 校准 | 摘要确实释放预算；来源/配对/取消语义由 Harness 协议承接 |
| H-1–H-4 | AgentHarness 迁移批次（§8.9） | 官方一致性套件通过；无重复状态机残留 |

PI-2 独立实施；H-1 先行验证存储与控制面，H-2–H-4 再接 UI、压缩与旧内核删除。各批次实现及 Contract/Scene 完整后集中验证；失败修复后按受影响范围重验。批次可先落代码再统一跑门禁，不在每个文案/小改动后重复启动 Live Test。P6 的会话读取源随 H 批次切换后的格式实施。

### 拟新增配置与设置入口

以下键仅为待实施提案，本轮不向 YAML 或设置页写入尚无消费者的字段：

| 提案字段 | 初始值/含义 | 用户入口与生效边界 |
|---|---|---|
| ai.conversation.defaultDelivery | steer | 聊天默认发送方式；单条显式选择优先，空闲时正常开始 |
| ai.conversation.steeringMode | all | AI 高级设置“集中处理补充/逐条处理”；按运行冻结 |
| ai.conversation.followUpMode | one-at-a-time | AI 高级设置“后续消息逐条/集中处理”；按运行冻结 |
| ai.loop.maxParallelTools | 4，范围 1–8 | 工具页“同时执行的只读工具数”；更新 Rust 应用级许可所有者，1 是保守回退 |

工具页从同一 ToolDef 显示权限意见、当前模式可用性、读并行/副作用串行、结果是否缩短、历史是否摘要。静态展示注明“声明/默认策略”，不能在没有参数时伪称本次有效授权。权限确认仍显示本次参数与裁决。

工具固有 effect、parallel 安全资格、replay 与原文策略来自代码/可信适配器，不全部变成任意可编辑 YAML。首轮沿用现有安全模式、写入开关与授权入口，不额外引入第二套每工具权限覆盖配置；若后续需要批量改权限，必须通过同一 Kernel 且只能在硬边界内生效。

maxParallelTools 是全局资源上限，不是每个 Agent 各自一份额度。设置降低时不撤销在飞许可，暂停新获准执行直到占用低于新上限；提高时可唤醒有序等待项。更新由共享所有者原子处理并返回生效值，所有窗口读取同一值；run 内工具安全策略仍按快照冻结。这一资源上限例外不得扩展为在飞修改 Card、权限或模型。

实现每个新字段时同批同步 CONFIG.yaml、CONFIG-DEV.yaml.example、Config/getter、AITab/ToolsTab 的读取/ref/defineExpose、SettingsPanel 保存映射、serialize/刷新消费者及说明。真实 CONFIG-DEV.yaml/用户 CONFIG 依既有授权规则单独处理，不因模板新增就改用户数据。旧配置缺字段要有单一默认值，导入/保存/重启应一致，不能把新选项只画在界面上。

README 提供方案入口；DES 区分当前行为和目标体验；current 只有实现后才升级目标为当前能力；AGENTS 只保留阅读路由和跨模块约束，不能复制整份能力表。已完成内容按既有文档治理归档，执行手册记录新验证基线而非覆盖旧证据。

## 10. 集中验收与未验证项

验收设计先随代码补 Contract/Scene，以下不是本轮已执行的测试：

| 范围 | 必须覆盖的场景与证据 |
|---|---|
| 双模式 | 生产 sendMessage 入口在工具阻塞时 steer；follow-up 保证原任务先结束；空闲两种方式均正常；UI 显示每条真实状态 |
| 队列竞态 | Pi 最后一次 poll 后/agent_end 前、slot 关闭后/父 finally 前后入队；逐项落盘、重新 drain，恰好一次用户正文，无虚假 accepted |
| 批量与失败 | all 与 one-at-a-time，多个 follow-up，某次请求失败/取消；batch 回复关联不伪装逐条完成；onPayload 后请求未成功不能报告远端收到 |
| 取消恢复 | queued/offered/context_committed/request_started/tool_started/result 后分别取消或重启；停止后不自动继续，未知副作用不重放，已发生结果不丢 |
| 会话与入口 | A/B 会话并行、切标签、关闭/清空、Card 切换、忙碌 Slash；身份/回复/取消不串会话 |
| 工具调度 | read+read 有实际重叠且受上限；read+write 按 Pi 整批串行；跨会话读写互斥；取消排队、写等待公平性、delegate 不死锁 |
| 权限 | deny-first、ask 不被 allow 覆盖、MCP passthrough、等待后授权过期、旧代际、策略版本变化、参数变化、Rust 硬拒绝 |
| 结果与压缩 | preserve/reference/retain，分页读取不循环裁剪；图片/错误/工具配对；临时 spill 失效有明确边界，源事件与策略可回读 |
| hook 与流式 | 首次 preflight、长准备期间 steering、shouldStop 后队列处理；分片标签、thinking 不显示，RUNTIME_DATA 只提交一次 |
| usage 与预算 | 多轮工具/插话、失败响应、摘要调用、缓存 token、usage 缺失、重启 EMPTY_USAGE、epoch/schema 变化失效，小窗口/超长单轮 |
| 配置与资源 | 设置保存重启/旧配置导入/切换安全边界，纯文档提案不冒充 UI；冷启动、空闲内存/CPU、首字/完整回复延迟与 token 对比 |

fake Provider 用于可重复竞态和回合顺序，仍执行实际 Agent/工具入口；真实 Provider 验证摘要质量、流式协议和陪伴连续性。最终执行类型/编译、受影响模块及跨模块 Live 门禁；改动 Windows 路径须看 CI，UI 与取消进程需相应平台验证。所有结果注明代码基线、环境、范围和未验证项，不预先承诺固定耗时或内存收益。
