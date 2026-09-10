---
document_type: active_plan
status: proposed
created_at: 2026-09-10
scope: pi_runtime_provider_tool_ui_context
parent_plan: pi-agent-迁移设计.md
---

# Pi Agent 能力替换与运行链路设计

> 本文承接《[Pi Agent 内核迁移设计](pi-agent-迁移设计.md)》和
> `docs/current/1.md` 的补充意见，专门讨论队列、Provider、工具、UI 事件、
> 上下文压缩和 Memory 的下一步边界。
>
> 本文是待实施方案，不代表当前代码已经完成这些改动。当前已经完成的是主
> 多轮 Loop 迁移；本文描述的是下一阶段的目标架构和实施顺序。

## 1. 决策摘要

本轮讨论形成以下方向：

1. 普通聊天消息使用 Pi Agent 的 `followUp` 队列，连续输入不再被
   `isAIGenerating()` 拒绝。队列后台逐条处理，默认不在 UI 中展示。
2. 所有模型请求统一切换到 `pi-ai`。删除 Desk-Pet 自己的旧
   `OpenAICompatibleProvider`、旧请求类型和仅服务旧 Provider 的解析链路。
3. 工具全面采用 Pi Agent 的工具协议、Schema 校验、生命周期事件和取消语义。
   `read`、`write`、`edit`、`bash` 四个基础工具同时暴露给轻量和助手模式，
   通过执行策略区分能力，不再把轻量模式设计成残缺的只读模式。
4. 不删除 Desk-Pet 的桌面能力、安全策略、Tauri/MCP/Skill 和变量能力；Pi
   工具通过 Desk-Pet 的 `ExecutionEnv` 和 Capability Adapter 执行。
5. 回复流式、工具状态、工具详情和队列状态全部变成独立 UI 配置；开发阶段
   可以全开，生产默认关闭回复增量和队列详情。
6. 上下文压缩与 Memory 在同一阶段设计，但保持两个独立 Module：压缩处理
   Pi 的热 transcript，Memory 处理 Markdown 长期事实。
7. 在引入长生命周期 Agent 和队列前，必须先建立最小 `ContextKernel`，避免
   Pi transcript 无限增长。
8. `pi-coding-agent`、Pi Harness 的 JSONL/SQLite Session 和 Node 执行环境
   不进入桌宠主链路。

核心原则是：

```text
Pi 负责通用 Agent 机制
Desk-Pet 负责产品状态、能力、安全、存储和桌宠表现
```

## 2. 产品边界

Desk-Pet 已经从 VTuber 模拟转为可自定义的桌宠容器。Profile、Card、灵动图层、
变量和音效是产品本体，不属于 Pi 的职责。

| Module | Pi 可以替代的部分 | 必须继续由 Desk-Pet 负责的部分 |
|---|---|---|
| Agent Runtime | 多轮模型请求、工具回注、取消、队列、事件 | 产品编排、模式、会话绑定 |
| Model Runtime | Provider、模型请求、流式、usage、错误语义 | 配置界面、密钥来源、模型用途策略 |
| Capability | 参数校验、工具调用生命周期、工具事件、基础 read/write/edit/bash | Tauri、MCP、Skill、剪贴板、应用启动、桌面能力 |
| Safety | `beforeToolCall` / `afterToolCall` 接入点 | 风险分级、确认、会话信任、路径边界 |
| Context | transcript 转换和请求前变换 | Card、VariablePool、MemoryContext、压缩策略 |
| Response | 事件和最终消息生命周期 | `RUNTIME_DATA`、表情、音效、Card 变量持久化 |
| Session | 当前运行时 transcript | Desk-Pet Markdown/LocalStorage 会话真源 |

Pi 是一个深 Module。调用方只应该依赖 Desk-Pet 自己的 `AgentRuntime`、
`ModelRuntime` 和 `Capability` Interface，不应把 Pi 的消息类型和内部状态
扩散到 Vue、Card、Memory 或 Rust 模块。

## 3. 目标总链路

```text
Vue ChatPanel
  -> ConversationRuntime
      -> Session binding / input preprocessing
      -> ContextKernel
          -> Card + Profile
          -> VariablePool
          -> Session transcript
          -> Compaction Summary
          -> MemoryContext
      -> PiAgentAdapter
          -> Pi Agent Core
              -> followUp queue
              -> Pi Schema validation
              -> beforeToolCall / afterToolCall
              -> Pi lifecycle events
          -> PiAI ModelRuntime
              -> createModels / createProvider
              -> lazy OpenAI-compatible API
      -> CapabilityKernel
          -> SafetyPolicy
          -> ConfirmationBridge
          -> ToolRouter / Capability adapters
          -> Local / Tauri / MCP / Skill
      -> ResponseKernel
          -> final text
          -> RUNTIME_DATA
          -> Card variables / expression / sound
          -> Session persistence / async Memory capture
  -> RuntimeEvent -> Vue / desktop pet UI
```

目标链路中只有 Pi Agent 负责真实的多轮工具循环。Planner、Compactor、Memory
consolidate、阶段文案等一次性任务使用同一个 `ModelRuntime`，但不必创建完整
的 Agent。

## 4. 队列设计

### 4.1 当前问题

当前 `sendMessage()` 在 Agent 忙时直接返回“正在思考”，而 `runPiAgentTurn()`
每次都会新建 `Agent`。因此 Pi 已有的 `followUp()`、`steer()` 和队列模式尚未
真正生效。

### 4.2 目标行为

```text
用户消息 A -> 当前 Agent 执行
用户消息 B -> Agent.followUp(B)
用户消息 C -> Agent.followUp(C)
           -> A 完成
           -> B 完成
           -> C 完成
```

默认设置：

```ts
followUpMode: "one-at-a-time"
toolExecution: "sequential"
```

- 普通聊天使用 `followUp`，不打断当前模型轮次或工具确认。
- `steer` 保留给未来的“打断当前任务/紧急纠正”能力，首期不作为普通输入。
- 队列调度只能由 Pi 负责，Desk-Pet 不再实现第二套执行队列。
- UI 可以维护一个轻量展示计数，但它只能反映状态，不能决定执行顺序。

### 4.3 Agent 生命周期

不要为所有历史会话永久保留 Agent。建议：

1. 只为当前活动会话保留一个长生命周期 Agent。
2. 切换会话时保存 Desk-Pet 会话状态，销毁旧 Agent 和订阅。
3. 切回会话时由 Markdown/LocalStorage 消息、摘要和当前 Prompt 重建 Agent。
4. Pi transcript 只作为运行时缓存，不作为持久化事实源。

Pi 普通 Agent 的队列只在内存中存在。如果未来需要崩溃恢复，可以把待处理用户
消息写入 Desk-Pet 会话文件，但不引入 Pi Harness 的完整持久化 Session。

### 4.4 队列 UI

默认不显式展示队列。建议配置：

```yaml
ui:
  showQueueStatus: false
```

打开后只展示简洁状态，例如“还有 2 条消息”，不展示 Coding Agent 风格的任务
列表、计划树或操作面板。

## 5. Provider 全面迁移到 Pi AI

### 5.1 当前 Provider 分裂

主对话已经使用 `pi-ai`，但 Planner、Compactor、Memory consolidate 和
`stages-cache` 仍有 7 个旧 `OpenAICompatibleProvider` 实例：

| Module | 旧调用数 |
|---|---:|
| Planner | 2 |
| Compactor | 2 |
| Memory consolidate | 2 |
| Personality stages-cache | 1 |
| 合计 | 7 |

两套链路会造成请求格式、thinking、错误、工具参数和 usage 统计不一致。

### 5.2 删除范围

完成迁移后删除或清理：

- `src/services/agent/provider.ts`
- 旧 `AIProvider` Interface
- `GenerateRequest` / `GenerateResponse` / `APIMessage`
- 仅服务旧 Provider 的 `parseAIResponse` 路径
- `agent/index.ts` 中对应的旧导出
- 旧 Provider 专用测试和文档描述

保留 Desk-Pet 的产品消息类型，例如 `Message`、`ToolCallRequest` 和会话持久化
格式；它们不是 Provider 兼容层。

### 5.3 ModelRuntime Adapter

新增一个窄 Interface，避免让调用方直接操作 Pi AI 细节：

```ts
interface ModelRuntime {
  streamChat(input: ModelRequest, signal?: AbortSignal): ModelStream
  complete(input: ModelRequest, signal?: AbortSignal): Promise<ModelResult>
  getModel(kind: ModelKind): ModelDescriptor
}
```

Implementation 使用：

- `createModels()`；
- `createProvider()`；
- `openai-completions.lazy`；
- Pi AI 的 `completeSimple` / `streamSimple`；
- `onPayload` / `onResponse` 诊断；
- 统一 usage、错误和取消语义。

不同任务可以选择不同模型用途：

```text
chat / planner / compaction / memory / stage
```

Planner 和 Compactor 这类一次性请求使用 `completeSimple`，不创建完整 Agent；
只有主聊天、子代理和需要工具回注的任务使用 Pi Agent Core。

### 5.4 轻量化约束

- 不引入 `pi-ai/providers/all`。
- 只注册当前配置需要的 Provider。
- 使用 lazy API 入口。
- Pi Agent 和非必要 Provider 在首次使用时动态加载。
- 基础工具只导入 `read/write/edit/bash` 所需工厂、Schema 和执行工具，不实例化
  `AgentHarness`，不引入 Harness Session/Storage/队列实现。
- 生产构建必须检查 chunk 和依赖树，确认仅使用四个工具不会把 JSONL、SQLite、
  NodeExecutionEnv 或 Coding Agent 代码打入 WebView。
- 不能把“动态 import”当作已证明的内存回收，最终仍需在 Tauri 中实测。

## 6. 工具协议与能力边界

### 6.1 当前与 Pi 的重叠

Desk-Pet 当前有 13 个静态内置工具：

```text
轻量：file_read / file_list / file_search / bash_exec / system_info / http_get
助手：file_write / bash_exec_full / app_open / clipboard_read /
      clipboard_write / agent_spawn / file_delete
```

Pi Agent 仓库中的 Harness 通用工具主要是：

```text
read / write / edit / bash
```

Pi Harness 的四个工具可以覆盖当前基础文件工作流，但不能覆盖所有 Desk-Pet
能力。Pi 的工具工厂依赖 `ExecutionEnv`，且不了解桌面权限、Card、MCP、Skill、
剪贴板和 Rust 路径规则，因此必须通过 Desk-Pet Adapter 执行。

### 6.2 四个基础工具的替换决定

结论不是“直接替换 4/4”，而是：

| 维度 | 结果 | 原因 |
|---|---:|---|
| 能力覆盖 | 4/4 | read、write、edit、bash 覆盖基础文件与命令工作流 |
| 当前接口直接兼容 | 0/4 | 工厂返回 `AgentHarnessTool`，桌宠运行时接收 `AgentTool` |
| 完成 Adapter 后可替换 | 4/4 | 通过 TauriExecutionEnv、CapabilityPolicy 和低层工具适配落地 |

| 当前实现 | Pi 工具 | 轻量模式 | 助手模式 | 决定 |
|---|---|---|---|---|
| `file_read` | `read` | 暴露 | 暴露 | 删除旧 TS 工具，使用 Pi Schema/分段输出；另补大文件输入限制 |
| `file_write` | `write` | 暴露，但受路径和写入策略限制 | 暴露，按确认策略执行 | 删除旧 TS 工具，保留 Desk-Pet Safety |
| 无稳定对应实现 | `edit` | 暴露 | 暴露 | 新增精确文本编辑，替代整文件覆盖式修改 |
| `bash_exec` + `bash_exec_full` | `bash` | 暴露，白名单/受限 cwd/危险模式 | 暴露，确认/策略模式决定权限 | 合并为一个工具名，删除两个旧 Bash 工具 |

这四个工具在两个模式中都存在，模式差异不再通过工具是否存在表达，而通过
`CapabilityPolicy` 表达：

```text
轻量：read/write/edit + 受限 bash
助手：read/write/edit + 可确认的扩展 bash
```

轻量模式的“轻量”指低依赖、低权限、低并发和小工具集，不指功能残缺。

这里有一个必须保留的接口事实：`createReadTool()`、`createWriteTool()`、
`createEditTool()`、`createBashTool()` 当前返回的是 `AgentHarnessTool`，其
`execute()` 参数包含 `toolContext`、持久化 `invocation` 和 Harness `Context`；
桌宠当前 `Agent` 接受的是低层 `AgentTool`，执行参数是
`(toolCallId, params, signal, onUpdate)`。因此四个工厂不能原样导入到
`Agent.tools`，也不能为了绕过差异而引入完整 `AgentHarness`。

替换实施时必须选择一个明确的 Adapter seam：

```text
Pi Harness create*Tool()
  -> HarnessToolAdapter (Desk-Pet)
      -> AgentTool (当前 Pi Agent)
          -> CapabilityPolicy / TauriExecutionEnv
```

`HarnessToolAdapter` 负责提供短生命周期的工具上下文、把 `AbortSignal` 注入
Harness `Context`、转发 `onUpdate`，并拒绝使用 Harness 的 JSONL/SQLite 持久会话。
若 Pi 版本不提供稳定的低层适配接口，优先在 Pi Agent 包增加无持久化的
`AgentTool` 工厂；其次才是在 Desk-Pet 中复用四个工具的实现逻辑。不得直接复制
Node `ExecutionEnv`，也不得让 Node 文件或进程 API 进入 WebView。

Desk-Pet 需要实现 `TauriExecutionEnv`，将 `FileSystem` 和 `Shell` 接口映射到
Rust 命令，并把 `AbortSignal` 继续传递到可取消的 Tauri、HTTP、MCP 和子代理操作。

轻量模式的策略不是禁用写入，而是将能力和授权分开：

- `read`：只允许配置的工作区、用户数据目录和临时目录，默认无需确认；
- `write` / `edit`：两个模式都可用。轻量模式按路径范围和每次操作确认执行，
  可选会话级范围授权；助手模式可在用户授权后扩大范围；
- `bash`：两个模式使用同一个工具名。轻量模式限制 cwd、命令结构和资源，
  纯读取命令可直接执行，修改命令需确认；助手模式允许更宽的范围但仍经过
  Rust 策略和危险操作确认；硬禁止命令在两种模式都拒绝。

这些规则由 `CapabilityPolicy` 动态计算，不能继续用“轻量拒绝所有 NORMAL/DANGER”
这种只看工具静态等级的旧规则，否则 `write` 和 `edit` 虽然出现在工具列表中仍
会变成不可用的假能力。

Pi `read` 提供 offset/limit 和返回值截断，Pi `edit` 提供精确替换、冲突检查、
BOM/换行保持和 diff，Pi `bash` 提供有界输出、spill 和 `onUpdate`。但当前
`read` 仍先通过 `readBinaryFile()` 读完整文件再切片，`edit` 也要读完整文本；
它们只限制模型返回量，不能直接消除大文件的内存峰值。落地时需增加文件大小
前置检查，并评估给 Pi `FileSystem` 增加范围读取；当前 Tauri Bash 命令也需改成
可取消、可增量回传的执行桥，才能兑现 `bash` 的流式输出能力。

### 6.3 应删除的冗余

四个基础工具迁移完成后删除：

- `src/services/tool/local/file.ts` 中的 `file_read` 定义；
- `src/services/tool/local-extra/file-write.ts`；
- `src/services/tool/local/bash.ts`；
- `src/services/tool/local-extra/bash-full.ts`；
- `bash_exec`、`bash_exec_full`、`file_read`、`file_write` 作为模型工具名的旧兼容声明；
- 只服务上述旧工具的重复截断、参数转换和 TS 白名单执行代码。

不删除：

- Tauri/Rust 的文件、Shell 底层命令，它们会成为 `TauriExecutionEnv` 的实现；
- `file_list`、`file_search`，因为 Pi Agent Core 没有对应工具；
- `system_info`、`http_get`、`app_open`、剪贴板、`agent_spawn`；
- MCP、Skill、变量池、RUNTIME_DATA 和 Desk-Pet Safety。

### 6.4 Desk-Pet 工具总表

| 能力 | 新归属 | 是否两个模式暴露 | 说明 |
|---|---|---:|---|
| `read` | Pi + TauriExecutionEnv | 是 | 替代 `file_read`；增加大小限制/范围读取 |
| `write` | Pi + TauriExecutionEnv | 是 | 替代 `file_write`，轻量仍需受限 |
| `edit` | Pi + TauriExecutionEnv | 是 | 新增精确编辑 |
| `bash` | Pi + Policy + TauriExecutionEnv | 是 | 合并两个旧 Bash |
| `file_list` | Desk-Pet Capability | 是 | Pi Core 不提供 |
| `file_search` | Desk-Pet Capability | 是 | Pi Core 不提供 |
| `system_info` | Desk-Pet/Tauri | 是 | 桌面专属 |
| `http_get` | Desk-Pet Capability | 是 | 需独立 SSRF/资源限制 |
| `app_open` | Desk-Pet/Tauri | 否/助手 | 桌面副作用 |
| `clipboard_read` | Desk-Pet/Tauri | 否/助手 | 隐私能力 |
| `clipboard_write` | Desk-Pet/Tauri | 否/助手 | 外部副作用 |
| `agent_spawn` | Desk-Pet + Pi Runtime | 否/助手 | 产品级子代理编排 |
| `file_delete` | Desk-Pet Policy | 否 | 当前 NOWAY，默认不提供 |
| MCP tools | Desk-Pet Adapter | 否/助手 | 动态外部能力 |
| Skill tools | Desk-Pet Adapter | 否/助手 | Markdown 编排能力 |

### 6.5 正确替换方式

工具系统改为三层：

```text
Pi AgentTool 协议
  -> Desk-Pet Capability Adapter
      -> Safety / Confirmation / ToolRouter
          -> Local / Tauri / MCP / Skill / Rust
```

Pi 负责：

- 工具 Schema 校验；
- 工具调用循环；
- 顺序或并行策略；
- abort signal；
- 工具生命周期事件；
- 统一工具结果回注。

Desk-Pet 继续负责：

- 文件、Shell、HTTP、系统信息等具体能力；
- App、剪贴板和桌面集成；
- MCP/Skill 动态注册；
- Safety、路径校验和确认；
- 变量池和 `RUNTIME_DATA`。

文件读写和 Bash 可以逐步适配 Pi 的 `read`、`write`、`edit`、`bash` 工厂，
但必须通过 Desk-Pet 的执行环境和安全策略。不要让 Pi 工具直接绕过 Tauri
路径校验或 `ToolRouter`。

### 6.6 CapabilitySnapshot

当前 `buildPrompt()` 和 `runPiLoop()` 分别调用工具注册表，可能造成 Prompt
声明和实际 Agent 工具不一致。应建立单一快照：

```ts
interface CapabilitySnapshot {
  definitions: CapabilityDef[]
  promptTools: ToolDeclaration[]
  piTools: AgentTool[]
}
```

同一轮请求的 Prompt、Pi Agent 和 Safety 必须使用同一份快照。

### 6.7 Schema 迁移

当前 `toPiTool()` 使用 `parameters as any`，削弱了 Pi 的参数校验。后续工具
Schema 应逐步迁移到 TypeBox：

- TypeBox 作为参数定义的单一来源；
- 从 Schema 生成模型可见声明；
- 由 Pi 进行参数校验；
- Safety 元数据放在 Capability 描述中，不放进模型参数 Schema。

### 6.8 Safety 不迁移给 Pi

Pi 没有 Desk-Pet 的风险分级和权限模型。工具执行链必须保持：

```text
Pi beforeToolCall
  -> SafetyPolicy
  -> session trust
  -> confirmation
  -> CapabilityRouter
  -> Tauri / MCP / Skill
```

当前 Runtime 传入 `sessionTrusted: false` 的问题必须在这次工具协议迁移时修复，
否则 `trustToolInSession()` 的语义不会真正生效。

### 6.9 当前健壮性问题与修复要求

当前工具体系可以作为迁移基础，但还不能视为生产级。以下问题必须纳入
Capability Adapter 的实施验收：

| 优先级 | 问题 | 影响 | 修复方向 |
|---|---|---|---|
| P0 | Rust `bash_exec` 信任前端白名单 | 任意 `invoke` 可绕过 TS 检查执行命令 | Rust/Capability 层重复执行策略校验 |
| P0 | Rust `file_list` 没有路径校验 | 可读取允许范围外目录元数据 | 使用统一 `AppPaths` 校验 |
| P0 | Router 超时不取消 handler | 超时后 Shell、fetch、MCP 仍继续执行 | 全链路传递 `AbortSignal` |
| P0 | MCP 请求 ID 固定为 `1` | 并发/多请求响应无法可靠匹配 | 每个请求唯一 ID + pending map |
| P0 | MCP `read_line()` 无真实超时 | 子进程不响应时线程长期阻塞 | Rust I/O 超时、kill 和取消联动 |
| P1 | `file_write` 创建父目录后才校验 | 非法路径可能先产生目录副作用 | 先解析/校验，后创建和写入 |
| P1 | 工具只校验 id，不校验 name | 工具名碰撞后路由到错误实现 | 注册时同时保证 id/name 唯一 |
| P1 | Prompt 与 Agent 分别取工具列表 | 动态工具变化时声明和实际工具漂移 | 单一 `CapabilitySnapshot` |
| P1 | `parameters as any` 绕过 Schema 类型 | 复杂参数约束缺失 | TypeBox 单一 Schema 来源 |
| P1 | 工具配置开关未完全控制注册 | 设置关闭后工具仍可能暴露 | 注册、快照和 UI 使用同一策略 |
| P1 | MCP 工具全部映射为 NORMAL | 真实风险被抹平，读取与执行无法区别授权 | 根据服务/工具策略声明动态风险 |
| P1 | MCP 参数 Schema 被拍平成浅层 properties | 嵌套对象、数组和约束丢失 | 保留完整 JSON Schema 并转换到 TypeBox |
| P1 | MCP 调用时把子进程临时移出连接表 | 同服务并发调用被误判为未连接，异常路径还可能遗失进程句柄 | 每连接独立请求队列/pending map，不转移所有权 |
| P1 | MCP 服务 `env` 未传到实际进程，配置同步还会丢字段 | 依赖环境变量的服务无法运行或重载后失效 | 配置、客户端和 Rust spawn 端到端保留 env |
| P1 | MCP 更新/删除服务只注销工具，未可靠关闭进程 | 残留子进程与旧连接占用资源 | 注册生命周期绑定 connect/disconnect/dispose |
| P1 | MCP JSON 导入未等待异步设置完成 | 导入完成提示早于真实注册，错误可能丢失 | await 设置和重连结果，返回逐项报告 |
| P1 | Skill `danger` 会回退成 SAFE | 高风险 Skill 可能被错误放行 | 显式支持完整安全等级 |
| P1 | Skill 工具名与内置工具名不一致 | 找不到声明工具后退回全部轻量工具 | 统一 canonical name，禁止静默回退 |
| P1 | Skill frontmatter 使用临时解析规则 | 数组、转义和复杂 YAML 容易误读 | 使用已有 YAML 解析器和 Schema 校验 |
| P1 | 内置 Skill 依赖旧点号工具名及白名单外命令 | 例如文件整理流程声明了不存在的工具或不可执行的 `mv` | 随 canonical name/统一 bash 策略重写并做启动校验 |
| P1 | HTTP 仅拦截少量 localhost 字符串 | SSRF、重定向、私网 DNS 和大响应风险 | IP 分类、重定向复检、大小/取消限制 |
| P1 | Bash 只匹配首个命令 token | Shell 语法可能绕过简单白名单 | 结构化解析或 Rust 策略执行 |
| P1 | Runtime 固定传入 `sessionTrusted: false` | 用户的会话信任选择无法生效 | 从同一请求上下文传递真实信任状态 |
| P1 | Pi 传入的 signal 在当前 `toPiTool()` 中被忽略 | Agent abort 后底层副作用仍可能继续 | Capability Interface 强制接收并下传 signal |
| P2 | `file_delete` 暴露但只返回 NOWAY 错误 | 消耗 Prompt token，形成永远不可用的假能力 | 从模型工具集中删除，未来有真实策略再恢复 |
| P2 | 文件与 HTTP 先完整读入再截断；Pi `read/edit` 也会整文件读入 | 大输入造成峰值内存和延迟 | 文件大小前置限制/范围读取，HTTP 流式上限 |
| P2 | 当前 Tauri Bash 不能增量回传 | Pi `bash` 的 `onUpdate`、有界捕获和取消无法完整落地 | Rust 流式 stdout/stderr + spill + cancel handle |
| P2 | SSE 配置存在但未实现 | 用户配置与实际能力不一致 | 明确禁用或单独实现 SSE Adapter |

这些问题不能通过“直接换成 Pi 工具”自动消失。Pi 只能提供更强的工具协议、
参数校验、取消和输出捕获；系统权限和外部副作用仍必须在 Desk-Pet/Rust
边界上强制执行。

## 7. UI、流式和桌宠表现

### 7.1 RuntimeEvent

Pi 类型不能直接扩散到 Vue。新增 Desk-Pet 自有事件：

```text
generation-start
generation-update
generation-end
tool-start
tool-update
tool-end
blocked
error
queue-update
final-text
```

适配关系：

```text
Pi message_update          -> generation-update
Pi tool_execution_start    -> tool-start
Pi tool_execution_update   -> tool-update
Pi tool_execution_end      -> tool-end
Pi agent_end               -> generation-end
```

### 7.2 UI 配置

```yaml
ui:
  streamReply: false
  showToolActivity: true
  showToolDetails: false
  showQueueStatus: false
```

- `streamReply=false`：模型仍可使用流式传输，但 UI 等最终消息后一次性显示。
- `streamReply=true`：展示 assistant 文本增量。
- `showToolActivity=true`：展示简短工具状态。
- `showToolDetails=false`：不展示原始参数和完整工具结果。
- `showQueueStatus=false`：隐藏后台队列。

当前 ChatPanel 只有工具开始/结束提示，还不是真正的工具进度流。若需要 Bash
输出等实时内容，`Capability` 执行 Interface 还需要加入 `onUpdate` 和
`AbortSignal`，再映射到 `tool-update`。

### 7.3 桌宠表现

Pi 事件不直接修改 Card、变量或 Vue 组件。由人格和表现层决定：

```text
generation-start -> thinking
tool-start       -> executing
tool-update      -> focused / busy
tool-end         -> recovering
final-text       -> speaking
generation-end   -> idle
blocked          -> warning
error            -> error
```

Profile、灵动图层、音效和表达仍通过现有 Card/Profile/Personality Module 组合。

## 8. 上下文压缩与 Memory

### 8.1 两者的职责不同

| Module | 解决的问题 | 数据范围 |
|---|---|---|
| Context Compaction | 当前请求 transcript 太长 | 热上下文、当前 Agent |
| Memory | 哪些事实值得长期保留和召回 | Markdown 文件、长期事实 |

压缩不是 Memory，Memory 也不能替代热上下文压缩。

### 8.2 当前缺口

当前 `transformContext` 仍是 no-op。已有 `compactOnHighUsage()` 在回复后异步
调用，且旧实现仍依赖旧 Provider；它没有真正更新 Pi transcript，也没有形成
长期记忆自动召回闭环。

### 8.3 推荐顺序

本阶段先完成：

1. Compactor 改用 `ModelRuntime.complete()`。
2. 保留现有 Markdown MemoryService 和文件事实源。
3. 建立 `ContextKernel` Interface。
4. 让 Pi `transformContext` 支持最小的裁剪/摘要投影。
5. 在引入长生命周期 Agent 前建立 transcript 上限和压缩触发点。

下一阶段再做：

```text
MemoryKernel
  -> Markdown facts / topic files
  -> index
  -> retrieval
  -> MemoryContext
  -> ContextKernel
  -> Pi transformContext
```

规则：

- 压缩在下一次模型请求前执行；
- 长期记忆提取在回复完成后异步执行；
- Memory 写入不阻塞下一条队列消息；
- Desk-Pet Markdown 是长期记忆真源；
- 不使用 Pi 私有 Session Storage；
- Card 状态、Memory 事实和 Pi transcript 不混为一类数据。

## 9. 不替换的部分

以下内容不应被 Pi 替换：

- Profile 加载、组合和资源解析；
- Card 角色、情绪、阶段和变量池；
- `RUNTIME_DATA` 解析、变量校验和持久化；
- Safety、确认 UI、会话信任和路径校验；
- Tauri AppPaths、Rust 命令和平台桥接；
- MCP/Skill 注册和生命周期；
- Desk-Pet Session Markdown/LocalStorage；
- MemoryKernel 的文件事实源；
- 桌宠 UI、灵动图层、音效和表现策略。

## 10. 实施顺序与验收门槛

### Phase 1：统一 ModelRuntime

- 迁移 7 个旧 Provider 调用点；
- 删除旧 Provider、旧请求类型和无用解析器；
- 保持 Planner、Compactor、Memory、Stage 的业务行为不变；
- 增加 Pi AI payload、响应和 usage 诊断；
- 通过类型检查、生产构建和 Live Test。

### Phase 2：Capability Adapter

- 建立 CapabilitySnapshot；
- 统一 Prompt 和 Agent 的工具集合；
- 修复 `sessionTrusted` 传递；
- 接入 TypeBox Schema；
- 将 `read`、`write`、`edit`、`bash` 暴露给轻量和助手模式；
- 用一个受策略控制的 `bash` 替代 `bash_exec` 与 `bash_exec_full`；
- 使用 Pi 的 read/write Schema、精确编辑和增量 Shell 输出替换重复 TS 实现；
- 为文件读取增加大小限制/范围读取，为 Tauri Shell 增加流式回传和取消；
- 实现 `TauriExecutionEnv`，保留 Rust 作为实际执行边界；
- 为工具执行增加 abort/update Interface；
- 修复 6.9 节的 P0/P1 问题；
- 保持 Safety 和 Tauri 路径边界的职责不变，并把静态工具等级重构为动态
  `CapabilityPolicy`。

### Phase 3：持久 Agent 与 Pi 队列

- 当前活动会话使用一个长生命周期 Agent；
- 普通新消息进入 `followUp()`；
- `one-at-a-time` 顺序消费；
- 会话切换时 dispose/rebuild；
- 先完成最小 ContextKernel 和 transcript 上限，再开放队列。

### Phase 4：RuntimeEvent 与 UI 配置

- Pi 事件适配为 Desk-Pet RuntimeEvent；
- 工具状态和工具进度接入 UI；
- 回复流式配置化，默认关闭；
- 队列状态配置化，默认隐藏；
- 桌宠表现只消费产品事件，不读取 Pi 内部状态。

### Phase 5：MemoryKernel

- 按 Claude Code 风格重构 Markdown Memory；
- 增加分层、索引、召回和来源标记；
- 把 MemoryContext 接入 ContextKernel；
- 增加长期记忆正确性、跨会话召回和写入失败测试。

### 必须通过的验收条件

1. 轻量模式不加载助手专属工具和 Coding Agent 依赖，但必须暴露
   `read`、`write`、`edit`、受限 `bash` 四个基础工具。
2. 连续发送多条消息时，消息按提交顺序逐条完成，不能丢失或重复。
3. 队列默认不显示，开启配置后只能显示状态，不改变执行语义。
4. Planner、Compactor、Memory 和主对话使用同一 Pi AI ModelRuntime。
5. 所有工具都经过 Pi Schema 校验、Desk-Pet Safety 和 ToolRouter/Capability。
6. 生产 chunk 不包含 `AgentHarness` Session/Storage、NodeExecutionEnv、SQLite 或
   Coding Agent；四个基础工具的增量必须有构建报告。
7. RUNTIME_DATA、变量池、Card 状态和 Profile 表现行为不回归。
8. 进程重启和会话切换后，Desk-Pet 会话可重建，不依赖 Pi 私有 Session。
9. 长对话触发压缩后，Pi transcript 不无限增长，Markdown Memory 不被误写。
10. Windows 和 macOS 的 Tauri 路径、文件和窗口能力保持一致。

## 11. 资源与风险

Pi Core 和 Pi AI 已经是当前主链路依赖，因此删除旧 Provider 不会删除 Pi 的
安装体积；主要收益是减少重复代码、请求路径和运行时状态。真正的新增风险是：

- 长生命周期 Agent transcript 增加内存；
- 多会话常驻 Agent 造成内存累积；
- `providers/all` 误引入导致包体和启动成本增加；
- Pi 工具直接绕过 Desk-Pet Safety；
- UI 同时维护 Pi 事件和产品状态造成重复副作用；
- 压缩与 Memory 同时写入导致上下文或文件竞争。

对应控制手段：

```text
单活动会话 Agent
  + ContextKernel transcript 上限
  + lazy Provider
  + Capability 单一快照
  + Safety 仍在 Desk-Pet
  + RuntimeEvent 单向映射
  + Memory 异步且原子写入
```

本设计的最大 Leverage 是统一 ModelRuntime、CapabilitySnapshot 和
RuntimeEvent；最大风险是持久 Agent 与上下文压缩的边界。两者必须在同一轮
实现中验证，但不应把 Memory 文件重构、Pi Session 存储和 Coding Agent 一并
引入主链路。
