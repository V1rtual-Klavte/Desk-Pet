---
document_type: active_plan
status: draft_pending_poc
created_at: 2026-09-07
scope: agent_runtime
parent_plan: 愿景驱动整体重构方案.md
---

# Pi Agent 内核迁移设计

> 本文是《[愿景驱动整体重构方案](愿景驱动整体重构方案.md)》中的 Agent 技术专题。
> 整体架构、MemoryKernel 与全项目迁移顺序以总方案为准。

## 1. 结论摘要

本方案研究将 Desk-Pet 当前的 Agent 执行内核迁移到
`@earendil-works/pi-agent-core` 的可行性。目标不是把 Desk-Pet 改造成 Pi
Coding Agent 的桌面壳，而是在不改变桌宠产品主体的前提下，用 Pi 的通用
Agent Loop 替代现有的 Provider 请求和多轮工具循环。

截至本文档，是否最终采用 Pi、是否让轻量和助手模式都使用 Pi Loop，均未
决策。推荐先做一个独立 PoC，以实际打包与 Tauri 运行数据决定。当前唯一
已确认的方向如下：

1. Profile 与 Card 可自由组合，是产品的用户自定义能力，不属于 Agent
   框架的职责。
2. 若采用 Pi，最终目标是两种模式共用同一个 Pi Core Loop，以工具集和
   安全策略区分能力；不把轻量模式固化为另一套长期 Loop。
3. `pi-coding-agent` 不直接进入 Tauri WebView。Coding 能力优先以 Pi Core
   驱动 Desk-Pet 现有工具实现，完整 Coding Agent 仅作为将来按任务启动的
   Node/Bun 侧车候选。
4. Profile、Card、变量池、`RUNTIME_DATA`、工具安全、会话 Markdown
   持久化和 Rust 平台桥接继续由 Desk-Pet 负责。

## 2. 产品定位与不可变约束

Desk-Pet 已由最初的 VTuber 模拟演变为可自定义的桌面角色容器。用户可以
为同一个桌宠自由搭配 Profile 和 Card：

| 领域 Module | 用户可见职责 | Agent 迁移后的归属 |
|---|---|---|
| Profile | 主题、角色帧、字体、音效、遮罩、灵动图层和逐层视差 | 保持 Desk-Pet 独立 Module |
| Card | 角色设定、语气、阶段文案、情绪映射、变量定义和运行时状态 | 保持 Desk-Pet 独立 Module |
| Agent Runtime | 模型调用、多轮工具、取消、上下文转换和事件 | 候选由 Pi Core 实现 |
| Rust 平台桥接 | 窗口、前台监控、文件、进程、MCP stdio、路径校验 | 保持 Desk-Pet 实现 |

因此，产品仍然遵循“桌宠是界面，Agent 是透明引擎”。迁移不得导致以下
行为退化：

- Profile 启动时只加载当前项，其他 Profile 按需发现和加载。
- Card 永远可热切换，`neutral` 是兜底；Card 状态和用户记忆不可混写。
- 最终回复只能由 `reply/generator.ts` 解析和剥离 `RUNTIME_DATA`，再经过
  已注册变量校验、情绪映射和持久化。
- 所有副作用工具仍必须经过 Desk-Pet 的 Safety、确认 UI、ToolRouter 与 Rust
  路径校验。Pi 的工具钩子是接入点，不是新的授权体系。
- Windows 和 macOS 都必须保持可用；WebView 内不可依赖 Node 内置模块。

历史的轻量预算 `50-80 MB` 作为 PoC 的比较基线，不是已经重新确认的验收
阈值。用户尚未确定最终预算，本文不以该数字直接否决 Pi。

## 3. 现状与迁移 Seam

当前 `runAgentLoop()` 负责的事情过多：变量刷新、Prompt 构建、可选 Plan、
Provider 调用、工具迭代、人格阶段事件、回复后处理、会话记录和压缩都在
同一调用链上。代码图显示它有 5 个直接调用方、两层范围内 65 个被调用
符号，因此不应整块替换。

迁移的 Seam 放在“已经完成 Desk-Pet 上下文构建，尚未进入最终回复处理”的
执行区间。新建的 `AgentRuntime` Module 应是一个深 Module：调用方只提交
一次执行请求并订阅事件，Pi 的消息格式、流、工具调用顺序和异常细节都
隐藏在内部。

```text
runner / preprocessor / session state
  -> Card variables + ContextEngine.build() + optional Planner
  -> AgentRuntime.execute()                         <- Seam
       -> PiAgentAdapter
          -> Pi model stream
          -> Pi tool loop
          -> Desk-Pet safety and ToolRouter adapters
  -> raw final reply
  -> reply/generator.ts (`RUNTIME_DATA`)
  -> Card persistence + session persistence + UI
```

建议的 Interface 如下。它刻意不暴露 Pi 的 `Agent`、`Model`、消息类型或工具
类型，以保留替换和测试空间。

```ts
interface AgentRuntime {
  execute(input: RuntimeInput, sink: RuntimeEventSink, signal: AbortSignal): Promise<RuntimeOutcome>
  abort(sessionId: string): void
  dispose(sessionId: string): Promise<void>
}
```

`RuntimeInput` 包含 Desk-Pet session id、已构建的 system prompt、会话消息、
已筛选的工具、思考强度、总轮数/超时限制和消息来源（用户或主动搭话）。
`RuntimeEvent` 只包含 UI 所需的生命周期事件，例如 generation、tool-start、
tool-end、blocked、error 和 final-text。`RuntimeOutcome` 返回原始最终文本、
工具历史、usage 和可诊断错误。

迁移早期同时存在 `LegacyRuntimeAdapter` 与 `PiAgentAdapter`，使这个 Seam 是
真实的。最终若 Pi 同时通过轻量和助手 PoC，才移除 Legacy Adapter；不能在
未验证前声称已经有“同一套 Loop”。

## 4. Pi 可替代和不可替代的部分

本次核对的 Pi 主分支为 `0.85.1`。源码体量约为：Pi Core 24,295 行 TypeScript，
Pi AI 24,311 行，Pi Coding Agent 69,951 行。代码量不等于发布包体积或运行时
内存，资源结论必须以 PoC 测量为准。

| Pi 能力 | 可替代的当前职责 | Desk-Pet 接入方式 | 不能替代的职责 |
|---|---|---|---|
| `Agent` 多轮循环 | `runToolLoop` 的请求/工具回注循环 | `PiAgentAdapter` 管理每个会话的 Agent | Card、Profile、最终回复处理 |
| 事件订阅 | 生成、工具执行状态通知 | 映射成 UI 与人格阶段事件 | 具体阶段文案和音效选择 |
| `abort()`、steer、follow-up | 当前取消与排队能力不足 | 由 runner 转调 Runtime | Vue 会话切换的业务规则 |
| `transformContext` | 上下文裁剪时机 | 调用既有 compactor，避免双重压缩 | Markdown 摘要和长期记忆策略 |
| `beforeToolCall` / `afterToolCall` | 工具前后拦截 | 前者强制 Safety，后者审计/事件 | Safety 分级、确认和路径校验本身 |
| `pi-ai` Provider 体系 | Provider/模型流调用 | 做独立 Model Adapter | Desk-Pet 配置、密钥与 Provider UX |

Pi 默认允许并行工具执行。Desk-Pet 的工具、确认 UI、会话信任和人格事件目前
依赖顺序，因此首个 Pi Adapter 必须显式设置 `toolExecution: "sequential"`。
并行工具不是迁移第一阶段的优化目标。

### 4.1 Pi 状态与 Desk-Pet 会话

Pi `Agent` 维护包含工具结果的内存 transcript；Desk-Pet 会话则以 UI 消息和
Markdown 文件为权威记录。两者不能各自独立持久化，否则切换会话或重启后会
出现上下文分叉。

第一阶段的策略：

1. Desk-Pet session 继续是持久化真源。
2. 每个活动 session 在内存中维护一个 Pi Agent；切换或关闭时调用
   `dispose(sessionId)` 并释放订阅。
3. 重启或重新打开历史会话时，用 Desk-Pet 的已持久化聊天记录、摘要和当前
   Prompt 重建 Pi 上下文，不采用 Pi Harness 的 JSONL session。
4. 若重建丢失的工具 transcript 会降低后续任务正确性，PoC 必须给出证据；
   通过前不得引入第二套未受控的持久化格式。

Pi Harness、Node execution environment 和 JSONL session 体系不在首期依赖
范围。它们面向 Pi 自己的运行环境，直接引入会削弱本项目的存储、路径和
平台约束。

## 5. 双模式与同一套 Loop 的候选方案

| 方案 | 轻量模式 | 助手模式 | 优点 | 主要问题 |
|---|---|---|---|---|
| A. 保留现有 Loop | Legacy | Pi Core | 初期资源风险最低 | 长期存在两套真实 Loop，不符合目标 |
| B. Pi Core 统一 Loop | Pi Core + 轻量工具集 | Pi Core + 完整工具集 | 统一事件、取消和工具语义，符合原始双模式原则 | Pi Core 成为轻量聊天路径常驻依赖，资源须实测 |
| C. 直接嵌入 Pi Coding Agent | Coding Agent | Coding Agent | 获得完整编码体验 | Node/TUI/原生依赖和产品职责过重，不适合 WebView |
| D. Coding Agent 侧车 | Pi Core 或 Legacy | Pi Core + 按任务启动侧车 | 编码能力隔离，可回收进程 | IPC、安全、会话映射和资源管理复杂 |

方案 B 是待验证的主方案。它不等于“启动时加载完整 Pi”：可以在用户第一次
聊天时动态导入 Pi Core 和所选 Provider，且轻量模式始终只暴露轻量工具集。
但一旦首次加载，浏览器的 ES Module 缓存通常不能保证切回轻量模式后立即
回收代码和所有依赖；动态导入只能降低冷启动负担，不能作为严格内存回收的
证明。

若 B 的实际资源或行为不达标，才考虑 A 作为过渡，而不是悄然把它变成最终
架构。D 只在“项目级 Coding Agent”被确认是助手模式核心能力时另立设计。

## 6. Coding 能力路线

Pi Core 提供 Agent 通用机制，不提供完整 Desk-Pet 需要的编码工作台。真正的
Coding 能力仍需项目读取、搜索、编辑、命令、Git、错误恢复、计划展示和安全
确认。

第一选择是“Pi Core + Desk-Pet ToolRegistry”：

- Assistant 模式继续注册现有 file、bash、MCP、Skill 和子代理工具。
- 先修复并验证现有工具的路径、会话信任和删除安全问题，再扩大 coding 工具
  的可用范围。
- Planner 是 Pi Runtime 之外的 Desk-Pet 编排 Module；首期不把 Plan 的依赖、
  并行或逐步确认语义交给 Pi 自动推断。

`@earendil-works/pi-coding-agent` 带有 CLI/TUI、Node 文件与进程访问、扩展
加载、交互主题和 `photon-node` 等依赖。它不应被打包进前端 WebView，也不应
通过只删除几处 UI 代码来“瘦身”。可行的瘦身顺序是：

1. 只安装 `pi-agent-core`，由其传递使用 `pi-ai`；不安装 Coding Agent。
2. 对 `pi-ai` 使用具体 Provider 入口，验证 Vite 是否只保留当前 Provider。
3. 不使用 Pi 的 Node/Harness/CLI 导出，不引入它的文件工具和 session 存储。
4. 仅当侧车 PoC 证明有不可替代收益时，再以独立 Node/Bun 进程按任务启动，
   通过受限 IPC 调用；退出任务即终止进程。
5. 不在首期维护 Pi 私有源码的删改 fork。只有 bundle 分析证明公开入口无法
   排除的依赖是主要成本时，才评估 fork 的长期维护代价。

## 7. PoC 设计与通过门槛

实验分支为 `experiment/pi-agent-runtime`，但在完成本设计稿时尚未向应用加入
Pi 依赖或代码。PoC 分两个阶段，先得到数据，再决定是否进入迁移。

### 7.1 阶段 P0：依赖、打包和内存基准

固定相同的 macOS/Windows 机器、Provider、模型、Profile、Card 与会话夹具，
分别测量当前实现和 Pi Core 试验实现：

| 指标 | 场景 | 记录方式 |
|---|---|---|
| 安装影响 | 仅 `pi-agent-core` 的生产依赖树和磁盘占用 | 锁文件、`pnpm why`、安装后文件大小 |
| 前端产物 | 初始主 chunk、Pi lazy chunk、gzip 后大小 | `vite build` 的产物清单 |
| 冷启动资源 | 启动后 30 秒、未发送消息 | Tauri/Rust 和 WebView 进程 RSS，JS heap |
| 首次聊天成本 | 第一次轻量闲聊后峰值和稳定值 | 同上，记录动态导入耗时 |
| 工具任务成本 | 轻量只读工具、助手写入/MCP 各一轮 | RSS、heap、耗时、工具轮数 |
| 模式切换 | 助手回轻量后 60 秒 | 资源是否回落；不以 GC 假设代替数据 |
| token 成本 | 闲聊、读文件、三步编码任务 | system prompt token、请求数、完成轮数 |

Node 进程 RSS 只能辅助定位依赖，不可作为 Tauri WebView 的内存结论。结论必须
来自真实桌宠进程。当前没有由用户确认的硬性阈值，因此 P0 输出是对比报告，
而不是预设的通过/失败。

### 7.2 阶段 P1：行为兼容

P1 用相同 Provider 固定夹具和 Live Test 场景覆盖以下合同：

1. 纯聊天、Card 切换、主动搭话都产生相同的最终 `ReplyResult` 结构。
2. `RUNTIME_DATA` 不能展示给用户，非法变量不能写入，Card 与交互变量的重置
   策略不变。
3. 轻量模式拒绝 NORMAL/DANGER/NOWAY；助手模式的 SAFE/NORMAL/DANGER/NOWAY
   以及确认 UI 顺序不变。
4. Pi 的 tool-start/tool-end 事件只能驱动人格阶段文案，不能绕过 ToolRouter。
5. 取消、超时、Provider 失败、工具失败、会话切换和重试后都恢复到正确状态。
6. 重启和历史会话重建后，不出现重复消息、遗失 summary 或工具结果污染。
7. Pi 事件顺序和现有 Plan、MCP、Skill、子代理链路无竞态；首期顺序执行。

P0 与 P1 都通过后，才可将“Pi Core 统一 Loop”写为正式决策。否则记录失败
证据，并保留当前 Loop，不以重构投入本身作为继续迁移的理由。

## 8. 分阶段迁移

### Phase 0：PoC

- 在试验分支锁定 Pi 版本，构造独立 benchmark entry，不接入生产入口。
- 完成 P0 与 P1 的报告，并由用户确认轻量资源预算和 Coding 能力优先级。

### Phase 1：建立 Runtime Seam

- 从当前 `runAgentLoop()` 中抽出 `AgentRuntime` Module 和 `LegacyRuntimeAdapter`。
- 调用方只经过 Interface；为 Interface 建立合同和场景测试。
- 保持输出、会话格式、Profile/Card 与工具接口不变。

### Phase 2：Pi Core Adapter

- 添加 `PiAgentAdapter`、Model Adapter 和 Tool Adapter，默认 feature flag 关闭。
- 显式顺序工具执行；前置钩子接 Safety，事件订阅接人格阶段和 UI。
- 先覆盖轻量聊天与六类轻量工具，再在同一 Loop 上开启助手工具集。

### Phase 3：助手能力与 Coding PoC

- 接入现有 MCP、Skill、Plan、子代理，逐项补全 Live Test。
- 评估“Pi Core + Desk-Pet 工具”能否满足编码任务。
- 仅在缺口明确时，为 Pi Coding Agent 侧车单独立项，不与 Core Loop 迁移绑在
  一次发布中。

### Phase 4：收敛

- Pi Adapter 覆盖 P0/P1 指标且用户确认后，移除 Legacy Adapter。
- 更新当前系统设计、README、DES 和测试契约；本计划移入历史目录。

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Pi Core 资源超过轻量目标 | 默认体验变重 | 真实 Tauri P0；不通过则停止统一迁移 |
| Pi 默认并行工具 | 确认、信任、状态顺序错乱 | 首期强制 sequential，后续才逐工具评估 |
| Pi transcript 与 Markdown 会话双写 | 重启后上下文分叉 | Desk-Pet 会话为唯一持久化真源，P1 验证重建 |
| Provider 协议差异 | OpenAI 兼容服务不能工作 | 单独 Model Adapter；逐 Provider 真实请求验证 |
| Pi 事件直接触发副作用 | 绕过安全和人格约束 | 事件只映射展示；工具统一经 Safety 和 Router |
| Coding Agent 直接嵌入 | 包体、内存、Node 安全面激增 | 禁止 WebView 直嵌；侧车另案 |
| 迁移掩盖现有安全问题 | 新内核扩大危险工具可达性 | 先修复/验证工具路径、删除和会话信任问题 |
| 上游快速演进 | 适配器维护成本高 | 锁定版本，只依赖公开 Core Interface，升级走 PoC |

## 10. 待用户确认的决策

| 编号 | 决策 | 当前状态 |
|---|---|---|
| D1 | Profile 与 Card 是否可自由搭配 | 已确认：可以 |
| D2 | 最终是否要求轻量/助手均运行 Pi Core | 待 P0/P1 证据决定 |
| D3 | 助手模式是否需要项目级 Coding Agent | 需要评估；先验证 Pi Core + 现有工具 |
| D4 | 轻量模式可接受的冷启动、稳定 RSS 和首次回复延迟 | 待用户确认，P0 先提供对比数据 |
| D5 | Coding Agent 侧车是否值得独立产品模式 | 仅在 Core 方案缺口明确后决策 |

## 11. 本轮不做的事

- 不安装 Pi 依赖，不修改生产入口，不替换现有 Loop。
- 不把 Pi Coding Agent、Node Harness、CLI/TUI 或 Pi session storage 接入应用。
- 不改变 Profile/Card 自由搭配、变量状态、`RUNTIME_DATA`、记忆格式和安全策略。
- 不将历史的内存预算伪装成已经验证的当前指标。
