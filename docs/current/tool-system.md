# 当前工具系统

本文维护工具能力、权限和 Skill/MCP 生命周期。Pi hook 的整体接线、请求快照与会话代际见[运行时契约](runtime-contract.md)。

## 执行链

```text
Pi Harness Tool → harness-tool-adapter → ToolRouter → 执行许可借用 → NativeExecutionEnv → HostBridge（私有 IPC）→ 原生宿主 commands/tool_exec
                        ↑ beforeToolCall / PermissionKernel 先完成门禁
```

文件与命令工具来自 Pi 的 ExecutionEnv 抽象，通过 [harness-adapter](../../src/services/tool/pi/harness-adapter.ts) 和 [NativeExecutionEnv](../../src/services/tool/pi/native-execution-env.ts) 走 HostBridge 接入原生宿主；路径运算经 `ExecutionPathKit` 端口（Node 实现走 `node:path`/`node:os`）。宿主命令 `file_read`/`file_write`/`file_write_atomic`/`file_append`/`bash_exec` 同样被 Node 域服务（Skill 保存、V1RTUAL.md 写入等）直接使用；这类域内写入不纳入工具许可域（许可借用者是 Node 模块实例、只覆盖模型工具执行），但走 `file_write_atomic` 的同目录 rename 原子替换，消除半写可观测窗口。它们不是另一个模型工具集。

| 工具 | 当前边界 |
|---|---|
| read | 文本或图片读取；图片经 Pi 的 `ReadImageProcessor` 端口（[images/processor.ts](../../src/services/images/processor.ts)）：有画布/解码能力时长边超 1568 等比缩放、BMP 转 PNG，任何处理失败回退原图（只留痕，不把图片从结果里丢掉）；长边阈值与 BMP 判定的唯一定义点都在该文件。**Node 进程没有画布/`createImageBitmap` 能力，这条处理链当前对图片一律回退原图并留痕**；宿主图片域（[crates/native-host/src/images/](../../crates/native-host/src/images/)）另有完整解码/缩放/编码实现，当前由截图、查看器与聊天内联预览消费。敏感路径仍会提高风险或被拒绝；私钥/凭据路径（含相对形式与 `~`/`$HOME`/`${HOME}`/反斜杠/`..` 归一）硬拒绝，Rust 侧 `is_credential_path` 是不可关闭的最终判定（规则文本 = 「`.ssh` 目录组件或 `.pem`/`.key` 后缀」） |
| write / edit | DANGER（凭据路径升 NOWAY 硬拒绝）；写能力恒暴露、不做配置开关，风险与确认只由安全模式裁决 |
| bash | 动态风险：首词命中白名单、无 shell 组合符且未命中危险/硬禁止模式为 NORMAL（免确认通道），其余为 DANGER；Rust 侧层 1 硬基线与系统路径保护不可关闭；命令里的凭据路径 token 硬拒绝 |
| system_info | 只读运行环境：操作系统、架构、CPU 核心数、内存（总量 / 已用 / 可用）与 bash 默认工作目录 |
| window_info | 只读最新原生窗口观测（应用、标题、采样时间和状态）；监控关闭、无观测或过期时如实说明 |
| screenshot | 截取画面：前台窗口，桌宠自己是前台时退到主显示器整屏（避免截到桌宠自己的窗口）；缩放与静默了解同口径（长边 ≤1280、PNG），不套它的 idle 门槛；隐私总闸是静默了解档位 `ai.silentAccess.frequency`（`off` 时返回中性说明而不是报错），Rust `capture_screenshot` 复检同一总闸（`set_monitor_enabled` 下发的观察许可）；结果同时带图片块给模型（她自己也看得见）；**只有展示型截图（`show_to_user=true`）才落盘**：PNG 经 `save_screenshot` 写入数据根 `screenshots/`（原子写），路径并入本回合提交的助手条目（`deskpetImagePaths`）在聊天里展示；私有截图（缺省/false）不落盘、磁盘不产生文件（模型仍通过结果里的图片块查看）；托管图片不再有数量/时间上限（2026-10-06 取消 200 上限），回收只有删会话连带清理与粘贴草稿丢弃回滚 |
| read_session_event | 按 `eventId` 回读地址分页读取当前会话保存的完整工具结果（被 L0 缩短或清空的结果由此恢复）：地址是完整 36 位条目 id 或**会话内最短唯一前缀**，前缀命中多条返回明确错误（`errorCode: "ambiguous"`，提示用更长前缀）而不任选；页大小按 token 预算推导、随窗口单调；`offset` 是字符下标；前缀解析只由条目 id 集合决定，折叠不改条目 id，地址因此对折叠不敏感 |
| app_open / clipboard_read / clipboard_write / agent_spawn | 恒暴露，受各自策略约束；四者都是 DANGER，`agent_spawn` 另声明 `delegate` 隔离，运行入口（`runPiSubAgent`）按这一判定把派生型工具从子代理工具面里剥离 |
| enable_tools | 按需启用本回合未激活的工具（SAFE、allow；机制见「回合激活面与渐进披露」）：空参返回可启用清单、`query` 关键词查找并启用、`names` 精确启用；只在确有未激活工具时挂进对话回合的工具面，取用经 `addedToolNames` 回合内生效、不跨 run 保留 |
| MCP 工具 | 仅启用且成功借用的 server；借用期间**全量**进入此后每个回合的冻结工具集（`setTools` 持全量），对话回合的默认激活集只含基础工具（MCP 工具默认不在其中），其余由 `enable_tools` 回合内按需加入（见「回合激活面与渐进披露」）；计划步骤的未限定工具面拿得到全量（子运行不收窄），`agent_spawn` 的 fork/team 子代理按固定白名单收窄 —— 只有 read / system_info / bash，不在其列；受工具发现过滤与权限终裁 |
| memory_query / memory_change | 同一长期记忆库的查询与治理；change 为 NORMAL、passthrough，继续由 PermissionKernel 终裁，绑定本轮已提交可信用户事件和目标版本。支持 remember/correct/complete/cancel/forget，patch 保留未提供字段，事项时间使用 day/minute TemporalAnchor。只读查询同样绑定本轮可信用户事件，范围固定为 user＋当前 Card＋当前 session（管理界面的跨 scope 浏览不进入模型入口）。模型不能执行 dreaming job 提交或 SQL |
| proactive_query / proactive_change | 当前范围内的约定与事项；query 只读，change 为 NORMAL、passthrough、exclusive_effect、replay:never。创建、完成、取消、改期、延后和控制必须绑定当前 owner；任务写入绑定本轮用户事件，周期可先经 `propose` 记录提议、只有本轮明确同意并引用 `proposalId` 才能建立，歧义先澄清；改期必须同时给出事项时间锚，延后只改下次提醒并保留原有效期。控制只保留暂停（`muteUntil`）与清除行为来源；**开关主动陪伴不在此工具**（归设置页 `ai.proactive.frequency` 档位），传入 `enabled` 会被宿主如实拒绝（不静默吞掉） |
| propose_plan | 模型提议多步计划并请求用户确认（NORMAL、passthrough、`external_side_effect` + `delegate` 隔离、replay:never、执行超时 null）：确认走既有计划面板 `requestPlanConfirm`，与自动计划入口共用同一策略点（`just_do_it` 跳过面板、`let_me_tk` 强制逐步）；用户点「开始」后由 `executePlan` 逐步执行（步骤超时 / 计划时限 / 失败裁决 / 逐步门都在既有执行器内），每步产出落 `plan_step_result` 条目，结果按 `formatStepResults` 格式作为工具结果返回；用户取消 / 会话切换 / 面板不可用一律不执行任何步骤并如实返回（模型不会误以为执行过）。参数准入在工具入口：步骤数 ≤ `ai.plan.maxSteps`（超出不静默截断）、每步至少一个文本、`allowedTools` 给就得全部可解析且非派生型。执行相位在 [engine/plan/proposal.ts](../../src/services/engine/plan/proposal.ts)（与自动入口同一条记录/恢复链，崩溃后经既有「继续/丢弃」面板处置）；`delegate` 声明使它不进 fork/team 白名单、也到不了计划步骤（需要用户在场的确认面板对无人值守子运行没有意义） |
| ask_user | 向用户提问并给出 2–6 个选项（NORMAL、passthrough、`read` + `delegate` 隔离、replay:never、执行超时 null）：面板显示问题与选项，用户点选后结果作为工具结果返回**所选项原文**；面板另有固定「其它」（用户用自己的话回答 —— 结果说明用户会在下一条消息里说明，不截留、不冒充）与「取消」两个按钮；用户取消 / 会话切换 / 提问未能送达界面一律如实返回，不假装用户选了任何一项。等待**没有超时**（2026-10-06 用户裁决：选择类弹窗不留超时），等待期回合墙钟与工具超时停表；「面板没送到」由发射失败立即结算承接。参数准入在工具入口：问题非空、选项 2–6 个且非空、不得重复（拒绝理由点名到项）。通道在 [engine/choice-confirmation.ts](../../src/services/engine/choice-confirmation.ts)（按 requestId 键控、可并发多条）；`delegate` 声明使它不进子代理与计划步骤（需要用户在场的交互对无人值守子运行没有意义，「其它」的自由回答也只会到达主回合） |

实际清单由 [registry.ts](../../src/services/tool/registry.ts)、[pi-tools.ts](../../src/services/tool/local/pi-tools.ts) 和回合冻结快照决定；每回合请求里下发的还会再经默认激活集收窄（见「回合激活面与渐进披露」）。目录列举使用 bash ls；不注册独立 ls/file_search/http_get。Pi CLI 的 Node 工具不直接搬进业务代码，一律经现有 ExecutionEnv 边界接入。

## 回合激活面与渐进披露

工具按「注册面 / 冻结面 / 激活面」三层落地，三者不合并：

- **注册面**：MCP 发现经 includeTools/excludeTools 过滤后注册进注册表（自定义服务器可在配置里预置 includeTools 白名单）；注册即拥有完整 ToolDef。
- **冻结面**：对话回合装配时 `[...listAll()]` 全量交给 Pi `setTools`（名字可解析；Pi 在每次请求前校验激活集 ⊆ 全量）。
- **激活面**：真正进请求 schema 的只有默认激活集 —— 非 MCP 工具全部（MCP 工具默认不在激活面；唯一判定是 [activation.ts](../../src/services/tool/activation.ts) 的 `defaultActiveToolNames`）。默认激活集在每回合装配时经 `lane.setActiveTools` 重设：只有主对话回合（主回合与恢复续跑）收窄，子代理 / 计划步骤省略即全量，保持既有行为。

模型取用入口是 `enable_tools`（[enable-tools.ts](../../src/services/tool/enable-tools.ts)）：传 `names` 精确启用、传 `query` 按关键词查找并启用、空参返回可启用清单；只在确有未激活工具时挂进对话回合的工具面（没有 MCP 工具时它无事可做，不占 schema）。启用经 Pi 原生 `addedToolNames` 在**本回合**后续请求生效（工具批次落盘时并入激活集），不跨 run 保留；[harness-tool-adapter.ts](../../src/services/tool/pi/harness-tool-adapter.ts) 把结果里本回合工具集之外的名字过滤掉并留痕（Pi 对名单外的名字会直接 configuration_failure，不能放进去）。

渐进披露只改变「进不进请求」：披露面 ≠ 执行面 —— MCP 的 passthrough、PermissionKernel 终裁与 Rust 路径裁决一律不变；`setTools` 仍持全量，计划步骤 allowedTools、fork/team 白名单与恒暴露工具不受影响。恢复续跑会把中断操作里 running 的工具名并回本回合激活集（Pi 执行工具批次同样按激活集过滤，否则重放会变成「unavailable」），这是恢复语义、不是取用持久化。

## 工具策略

`ToolDef` 携带身份、schema 与风险等级，策略集中在 `policy`（[types.ts](../../src/services/tool/types.ts)）；执行函数**不是公开字段**，经 `defineTool` 进入 [policy.ts](../../src/services/tool/policy.ts) 的模块内 WeakMap（`getToolHandler` 只给 router / registry，不从 barrel 导出）：

- `safetyLevel`（`SAFE` / `NORMAL` / `DANGER` / `NOWAY`，可用 `resolveSafetyLevel(params, ctx)` 按调用动态解析）留在 ToolDef 顶层：它是风险维度而不是权限意见，供 PermissionKernel 定风险。等级到裁决的映射只有 [permission.ts](../../src/services/safety/permission.ts) 的 `standardDecision` 一处：`NOWAY` 一律 deny，`SAFE` / `NORMAL` 一律 allow，`DANGER` 交给安全模式（`just_do_it` 放行，`let_me_tk` 与默认档都要确认）。工具没有各自的权限开关（回合激活面收窄的是「进不进请求」，不是授权），`validateRiskDeclaration` 只守未经类型检查的 `safetyLevel` 声明。
- `permission.defaultDecision` 是工具侧唯一的权限意见（`allow` / `ask` / `deny` / `passthrough`），`passthrough` 不是执行许可，必须由 PermissionKernel 收敛。
- `execution.effect / isolation / replay / timeoutMs`：效果分类、隔离级别、恢复重放资格与超时；未声明超时时统一取 `loop.toolTimeoutMs`。**`null` 是显式声明的「本计时器不设执行超时」**，只给两类工具：① 等用户做决定的交互工具（`ask_user`、`propose_plan`）—— 它们的 handler 相位由用户停留时长决定，没有有限预算可覆盖；② 执行死线由执行端承载的工具（`pi-bash`：档位下传 Rust、到点转后台而非取消，见「文件、命令与取消」；MCP 工具声明的是**大于传输层**的兜底预算 `MCP_TOOL_TIMEOUT_MS`，让传输层先以结构化错误结束）。任一工具的等待期都不被计时器打断：等确认 / 裁决 / 权限 / 提问期间，该会话的**回合墙钟与工具超时一起停表**，结算后按剩余预算续算（[user-wait.ts](../../src/services/engine/user-wait.ts)，唯一登记点）。并发语义只由 `effect` / `isolation` 表达（`shared_read` 必须同时是 `read` 效果；反向不设约束，独占读是合法的保守声明）。
- `context.resultProjection`：`preserve` 是**禁止二次处理**，不缩短、不清空（地址标注不在此列，照旧带），避免「引用 → 读取 → 又变引用」的循环 —— 回读工具 `read_session_event` 自身即声明 `preserve`；`reference` 的结果可被 L0 缩短或清空，且**无条件带地址**（不论是否超阈值）。两者都只改请求视图，会话条目存档始终保留全文。Router 的 L1 内联截断已删除：会话条目与请求视图共用同一份工具返回全文，请求视图里工具结果的改动只发生在 L0（[context/tool-output.ts](../../src/services/context/tool-output.ts)）且提示带 eventId 回读地址。
- `context.historyCompaction`：`retain` 的调用配对必须保留原文，压缩覆盖边界不得越过（连续完整轮下命中即 decline，由预算守卫报告上下文不足）；该取值维持保留：生产无消费者（全部生产工具声明 `summarize`），由 `memory-retain-guard` 场景驱动，不删。

[defineTool](../../src/services/tool/policy.ts) 是唯一构造入口（手写、Pi 适配、MCP 都经它产出 ToolDef），注册入口再次校验：缺策略、`shared_read` 搭配非只读效果、未知策略版本、非法权限意见都是注册错误，不做缺省猜测；未经它构造的定义在注册时直接抛错（结构上没有执行体），不会进入注册表。`actionCategory` 由 ToolDef 唯一声明，经 `actionCategoryOf`（[registry.ts](../../src/services/tool/registry.ts)）解析后驱动人格阶段文案（`getStagePrompt`）；不再决定并行、权限或压缩。`replay` 由 Harness 恢复路径消费：只有持久化调用与当前工具都声明 `safe` 才会重放效果，当前全部工具为 `never`。

工具策略不再声明逐工具调度模式：Harness 的批次调度只看 run 级 `toolExecution`（现为 `parallel`），互斥由 `execution.isolation` 与下面的执行许可保证。

## 执行许可（纯读并行与效果互斥）

Harness 以 `toolExecution: parallel` 派发批次，效果之间的并发由原生宿主侧的应用级许可所有者裁定：[tool_permit.rs](../../crates/native-host/src/commands/tool_permit.rs) 持有额度，Node 在 [router.ts](../../src/services/tool/router.ts) 执行入口借用、真实结算后释放（[execution-permit.ts](../../src/services/tool/execution-permit.ts)）。

- `shared_read` 走有界共享额度（默认 4，由 [`ai.loop.maxParallelTools`](runtime-data.md#工具并行上限字段的语义与生效时机) 配置，范围 1–8），两个只读可真正重叠；`exclusive_effect`（write/edit/bash/app_open/clipboard_write/MCP）与进行中的读写互斥，效果按借用顺序串行。
- `delegate`（agent_spawn / propose_plan / ask_user）不占父批次额度，子运行的工具各自取许可；编排入口不自行执行文件写入。子代理运行随父运行取消（取消域级联：子槽挂到父槽下，父槽停止/关闭/释放都会级联到子运行），许可借用身份绑定父会话 + 代际。
- Harness 的工具 memo 持久位（`invocation.getMemo` / `setMemo`）维持不实现：没有任何 V1rtual-Desk-Pet 工具把中间状态放进 memo（[harness-adapter.ts](../../src/services/tool/pi/harness-adapter.ts) 是空实现），恢复判定只按会话条目与工具结果条目这一份证据；`replay: "never"` 已保证不重放，恢复位无消费者。
- 等待可取消（取消会移出排队项），没有超时自动释放；拿到额度后重新核对取消与代际，排队不能成为绕过检查的通道。
- `tool_permit_release` 与 `tool_permit_cancel` 同样绑定借用者：其它调用方即使拿到 requestId 也不能释放在飞额度或取消他人的排队项，被拒绝的调用不改变额度状态。
- 释放与上线声明的 IPC 失败不再只留日志：失败的释放按 requestId 入队（请求标识是确定量，Rust 对未知 id 返回 Ok，重放幂等），由运行槽在**下一次 run 开始前**补偿重放；上线声明失败同样记欠账并在同一时机重试。补偿失败只留痕、不阻断本次 run。
- **借用者身份 = Node 进程内的模块实例 id**（[execution-permit.ts](../../src/services/tool/execution-permit.ts) 在模块加载时声明上线，存 globalThis 保证同进程内重复求值复用同一身份）；窗口身份由 Rust 按命令来源的 principal 填（产品宿主 = main，E2E 隔离宿主 = e2e），Node 不复制一份。Node 换代（连接重建 / 崩溃重启）后旧实例已无法归还额度，新实例上线时由 `tool_permit_attach` 一次性回收该数据根域内上一实例的在飞额度与排队项，并以回收数量作为证据。回收只由「借用者已经不存在」触发，不看时间：同一实例重复上线是空操作，在飞的 `exclusive_effect` 不受影响。
- 能持额度的进程 = 会启动回合的进程 = 唯一 Node（产品宿主与 E2E 宿主各只有一个，E2E 宿主不建主窗口）。原生设置窗 / 图层编辑器窗不启动回合、也不声明借用者，因此不存在「窗口销毁留下的额度」这一类对象。
- 上限由 Node 在每个 run 开始前下发给所有者并按运行生效（与队列批量策略同一模式）：降低上限不撤销在飞许可，只是暂停新获准执行；提高会唤醒有序等待项。**共享读上限的所有者是 Rust**（[tool_permit.rs](../../crates/native-host/src/commands/tool_permit.rs) 持有默认值与 1–8 范围，是宿主侧唯一的额度定义点）：默认值是**无配置可下发时**的兜底（E2E / 单独启动没有前端），Node 侧 `MIN/MAX/DEFAULT_PARALLEL_TOOLS` 是同值副本，只做设置页校验与 YAML 兜底，不构成第二个所有者；两份范围的一致性由 `tool-execution-permit` 场景的可执行边界钉保证（上限原值被接受、两侧越界被拒绝）。越界值三处处理不同（见[运行时数据](runtime-data.md#工具并行上限字段的语义与生效时机)）。
- 许可域按数据根区分（`domain_key = data_root`），Live Test 的临时根自带隔离域。许可只约束 V1rtual-Desk-Pet 托管的调用，不承诺阻止外部进程改文件（沙箱边界见下节）。
- 额度没有 TTL、也不加看门狗：超时释放会放开在飞的 `exclusive_effect`，与「写互斥不许被时间条件打开」直接冲突。写互斥是工具路径（声明 + 额度层）的性质，不会因为某个 handler 卡住而被绕过，但会因 handler 永不结算而不归还 —— 这个入口已从源头消除：文件读写只接受常规文件，FIFO/设备/套接字在调用前就被拒绝（见下节），不再有「永远打不开的 open 占着额度」这条路径。

原生设置窗工具页的策略声明表从同一 ToolDef 展示权限意见、隔离级别、结果投影与历史摘要，不复制第二份策略定义；PermissionKernel 仍是唯一终裁，声明表只读。

## 宿主侧端口实现

[host/native_ports.rs](../../crates/native-host/src/host/native_ports.rs) 是宿主能力端口在原生宿主里的实现，命令域与退出序列共用，业务侧只经 trait 取用：

- `NativeAssetScope`（受控资源读取授权）：聊天图片、截图与查看器读取本地图片前必须经它放行；授权时逐路径跑 `AppPaths::validate_file_path`（存在性 + 凭据 + 记忆保护 + 允许根）后才进进程内白名单，profiles 根在启动时整目录授权 —— 不是「任意路径可读」，未授权即拒绝、不自动补授权。
- `NativeFileDialog`（原生文件对话框）：macOS 走 `NSOpenPanel`/`NSSavePanel`（AppKit 只能在 UI 主线程，经主线程队列执行并等待），Windows 走系统通用对话框（专用线程，不需消息循环）；用户取消是**正常结果**（空数组 / `None`），不是错误。
- `NativeLifecycle`（退出/重启）：接到只跑一次的 `ExitOnceHook` —— 先回收 MCP/Bash 子进程池，再走统一退出序列；命令侧 `app_restart` 与被杀兜底共用这条路径。

## 权限终裁

[PermissionKernel](../../src/services/safety/permission.ts) 将风险等级与 `allow / ask / deny / passthrough` 分开：前三种表达工具侧意见，passthrough 继续总策略；内核最终只能给出 allow/ask/deny。MCP 明确走 passthrough，不绕过总策略。硬拒绝优先，工具 allow 不能吞掉总策略 ask。

`beforeToolCall` 等待调用事件落盘，再检查次数、权限和确认。确认绑定 session、generation、call ID、完整参数 hash、策略 hash、到期时间；支持仅本次、会话内同参数、拒绝。确认后重新校验，取消、参数/策略变化或旧代际不能继续执行，授权在运行结束释放，不从摘要恢复。确认请求经 `deskpet-permission-confirm` 事件投影到原生 UI（回执走 `UiReceiptMap` 的 `deskpet-permission-confirm-resolved`）；测试宿主由 confirm-channel 确定性应答（见 [confirm.ts](../../src/services/safety/confirm.ts) 与 [native-ui/permission-confirm.ts](../../src/services/native-ui/permission-confirm.ts)）。

`afterToolCall` 标注来源、taint 和错误；工具结果条目由 Harness 事务写入会话文件，宿主的事件订阅只把结果投影进界面读模型——宿主的审计写队列只落 `deskpet.*` 条目，不写正文。观测 trace 不承担阻断语义。Router 的结果 `details.audit` 含 operationId、outcome 和策略元数据；其风险分类 hash 与 PermissionKernel 的完整授权 policyHash 职责不同，不能互相替代。[router.ts](../../src/services/tool/router.ts)

## 文件、命令与取消

- 文件路径通过 AppPaths 校验，允许根为用户 Home、系统临时目录，开发构建还包含项目根；凭据等路径（规则文本 = 「`.ssh` 目录组件或 `.pem`/`.key` 后缀」）由 Rust [paths/mod.rs::is_credential_path](../../crates/native-host/src/paths/mod.rs) 做不可关闭的最终判定（`SENSITIVE_PATH`），接入点是 `validate_file_path`/`validate_new_file_path` 的词法形态**与** canonicalize 结果两侧 —— 不存在的路径也先得凭据结论而不是 `PATH_NOT_FOUND`，符号链接与 Windows 短名解析后仍会被判；记忆库主文件与 `-wal`/`-shm` 同受 `is_managed_memory_path` 保护；TS 侧的 [resolveFilePathLevel](../../src/services/safety/checker.ts) 是同一规则族的分级副本（相对形式与 `~`/`$HOME`/`${HOME}`/反斜杠/`..` 经词法归一后同判），在进入 ToolRouter 前就提为 NOWAY。
- 读写目标只接受**常规文件**（[tool_exec/fs.rs](../../crates/native-host/src/commands/tool_exec/fs.rs) 的 `ensure_regular_file`）：`file_read`/`file_read_binary` 在取元数据后立刻判类型，`file_write`/`file_write_atomic`/`file_append` 对已存在的目标判，`file_rename` 的源拒绝 FIFO/设备/套接字但**允许目录**（重命名目录是合法用法，且 `rename` 是元数据操作、不打开内容）。FIFO/套接字/字符设备/块设备的 open 会一直等对端或直接写到设备，handler 因此永不结算、许可额度也不释放，只能在源头拒绝。`/dev/null` 类设备目标**不豁免**：设备路径本就不在允许根（Home/系统临时目录/开发项目根）内，到不了类型判定这一步。
- 这套路径与命令策略是**同一规则族的两层副本**，不是完备的 OS 沙箱：间接形式（如 `python -c "open('~/.ssh/id_rsa')"`）与「拦实际打开的文件」都不在覆盖内；`.env`、系统目录等可确认路径不受影响 —— 它们按风险等级走确认（DANGER 由安全模式裁决），不再按模式分层。
- Bash 超时档位与三道墙（2026-10-06 后台化批次更新）：bash 工具的执行窗口是**默认 = 上限 = 300 秒**（[bash-timeout.ts](../../src/services/tool/local/bash-timeout.ts) 是档位与模型向文案的唯一档位定义点），模型只能在 `timeout` 参数里**下调**，越界由 `prepareArguments` 统一夹取成 `effective = min(请求值 ?? 300, 300)`；**生效值以毫秒显式下传** Rust（不再有「模型不传 → Rust 吃自己的兜底」的隐藏天花板），Rust `DEFAULT_BASH_TIMEOUT_MS` 与 TS 档位同值，只作「调用方没传」的深防线；`pi-bash` 的策略声明是显式 `timeoutMs: null` —— **router 计时器不承载 bash 死线**，死线由接收了同一生效值的 Rust 执行（若 router 再设同值计时器，它会先到点 abort、取消链把命令杀掉，后台化失效）。**到达超时不终止命令**：命令转入后台继续执行（不持有 AI 锁、不占回合墙钟），工具结果按「未完成」如实结算 —— 模型拿到中性说明（已运行多久、静默多久、产出多少字节的 L1 现场证据）+ 输出尾部；本轮结果不是终局。后台任务的上限是 **30 分钟**：到点按进程组回收并如实告知「超过时限已被终止」；宿主退出由 `kill_all` 兜底回收（不发完成事件）；结束（自行退出或到点回收）时宿主投 `bash-background-finished`，Node 侧 [tool/background.ts](../../src/services/tool/background.ts) 接成发起会话的聊天系统消息（`pushSystemMessage`，输出尾部 ≤1200 字回显、截断时给 spill 取回地址；文案与校验在零依赖叶子 [background-notice.ts](../../src/services/tool/background-notice.ts)）。语义边界：停止回合与删会话**不会**杀后台命令（当前没有 TaskStop；要终止只能自己处理进程），后台输出只留在 spill 文件、不落会话正文。外层两道墙：主回合/恢复 `ai.loop.turnTimeoutMs` 默认 600s（必须 ≥ 300s + 一次模型往返；转后台后本轮不再被该命令占用）、计划步骤 `ai.plan.stepTimeoutMs` 默认 300s（用户在场批准的计划里可能出现长命令）；三个键都不提供设置控件，修改入口是运行时 CONFIG 的 YAML 或 [config.ts](../../src/services/config.ts) 的 getter 缺省值。**无人值守子运行是唯一的有意收窄**：fork/team 与主动规划子运行的 90s 预算即其运行内 bash 的实际上限（`min(300s, 子运行预算)`；转后台只发生在命令自身死线先到的时候，子运行预算先到是取消、走组回收），与主回合刻意不同档（[sub-agent.ts](../../src/services/agent/sub-agent.ts) 头部注释与 [agent/timeouts.ts](../../src/services/agent/timeouts.ts) 同口径）。`agent_spawn` 的声明预算 = 两段子运行墙钟 + 编排余量（team 的成员段 + lead 段 ≈180s 的最坏内部耗时，不再是配置派生的 120s），handler 把工具上下文的取消域传给子运行 —— 父停止 / 切会话立刻级联停止。
- 命令的 stdin 在 spawn 时**关死**（`Stdio::null()`，与 OpenCode/Cline 同款底线）：命令的 stdin 不是交互面，交互式命令立即读到 EOF 失败（暴露快、不占超时）；等待用户点按的弹窗命令（`display dialog` / `display alert`）另在 [safety/checker.ts](../../src/services/safety/checker.ts) 里命中危险模式走确认，模型向描述中明说不要用命令阻塞等用户 —— 确认与选择类操作走桌宠自己的计划确认面板与提问选择面板（`propose_plan` / `ask_user`，等待期不计入回合墙钟）。
- Bash 取消和进程回收由 Rust 管理；Router 为调用叠加取消/超时，区分 cancelled、timeout、not_found、failed。判定顺序唯一：本计时器超时（定时器置位）→ 取消（外部 signal）→ 下游超时（执行端结算，读 Pi 抛出 Error 的 `cause` 码）→ error，不做错误文案匹配，一次调用只有一条审计账（审计含 `timeoutMs` 生效预算与 `elapsedMs` 实际耗时；本计时器超时后底层仍结算时留一条迟结算 warn，成功的晚到结果不被采用）。**取消 / 宿主退出 / 后台时限到点三处共用同一进程组回收**（[bash.rs](../../crates/native-host/src/commands/tool_exec/bash.rs) 的 `kill_process_group`；前台超时不再走这条 —— 它转后台，见上一条）：Unix 命令自成进程组（`process_group(0)`）后 `killpg` 整组回收（孙进程——osascript 弹窗、后台派生命令——不留孤儿；`ESRCH` 视为已死），Windows `taskkill /T /F` 递归结束进程树（本机不可编译验证，靠 CI）。取消可以在子进程 spawn 前到达：`bash_exec` 的登记先于任何阻塞动作，命中在案槽位的取消会立案并在 spawn 后立即终止（稳定码 `CANCELLED`）；池里没有该 execution_id 时 `bash_cancel` 返回 `false` 并留一条 debug 记录，不再是静默成功 —— 调用方据此区分「取消成功」与「取消来晚了（子进程可能已结束，含已转后台的命令）」。转后台后该次调用的取消链即结束：后台任务不接受 `bash_cancel`，只受 30 分钟上限与宿主退出约束。
- 输出上限与 spill 保留数由 [tool_exec/bash.rs](../../crates/native-host/src/commands/tool_exec/bash.rs) 管理（默认 50 KiB / 2000 行；spill 保留最近 10 份、按时间淘汰）。Bash 截断会返回 spill 引用，最近文件会淘汰；不能声称任意长的 shell 输出永久存于会话。生效上限只在 Rust 定义并随结果回传（`maxBytes`/`maxLines`），Node 不复制一份默认值。超时的现场证据（`elapsedMs` / `silentMs` / `producedBytes`）与输出尾部随结果一起回来 —— 转后台是结构化结果（Node 按 `backgrounded` 归类成 `timeout`，不匹配文案）；「慢但在动」与「疑似挂死」的区分只作为诊断信息（静默时长的 L1 证据进模型文本与完成通知），不参与杀 / 不杀的判定：前台不再杀，后台只受 30 分钟硬上限约束（体检报告 §6 的取舍）。
- 会话保存的是**工具实际返回内容**；Context L0 再做请求投影时，原工具结果仍可用 read_session_event 读取。两层截断的范围不能混同。

[bash_policy.rs](../../crates/native-host/src/commands/bash_policy.rs) 是不可关闭的最终门禁，`enforce_bash_policy` 只接收命令本身 —— 没有 scope / whitelist 这类可传弱的旋钮。层 1 硬基线拒绝：删根/家目录、设备破坏（mkfs / dd）、系统电源命令、下载即执行、危险参数（`-delete` / `-exec` 等，按 token 对全体命令生效）、重定向写系统路径、递归 chmod/chown 到根或 777，以及命令里的凭据路径 token（`deny_credential_paths`，与 `deny_destructive_flags` 并列，嵌套脚本按展开后的 token 判）；层 2 只有一条 —— 写/删类命令指向固定系统路径即拒绝。白名单与 shell 组合符属于**分级**问题而不是拒绝问题，归 TS 的 `classifyBashRisk`：白名单只是**免确认通道**，不在白名单只意味着要走确认。策略基于 Shell token，不以简单子串代替（沙箱边界同本节开头的两层副本说明）。

Provider 网络边界独立于 MCP/shell：配置 origin、禁止 redirect、超时和响应上限见[运行时契约](runtime-contract.md#pi权限与网络)。不能把 Provider fetch guard 当作所有联网工具的控制层。

## Skill 渐进披露

Skill 不注册 ToolDef、不占工具声明槽，也不授予权限：它只提供指令文本。清单的唯一所有者是 [skill/store.ts](../../src/services/skill/store.ts)，来源是 Pi 原生 `loadSkills`（递归遍历 `data_root/skills/`，收录 `SKILL.md` 与根级 `.md`，缺 description 的不收录；loader 会读全文，`Skill.content` 是 `/skill` 显式调用与 `setResources` 的素材，不构成请求投影）。披露块由 [loader.ts](../../src/services/skill/loader.ts) 的 `getSkillsPromptBlock()` 给出：用 Pi `formatSkillsForSystemPrompt` 只输出 name/description/location，外面套 `MAX_PROMPT_CHARS`（8192 字符）预算，超限丢**整条**技能并告警（不截断单条）；正文不进请求视图，模型需要时按 `location` 用 read 取。

- 每技能 frontmatter `enabled` 控制披露与 `/skill` 显式调用（缺省与非法取值都算启用，只有显式 `false` 才关闭）；`disable-model-invocation` 由 Pi 自己从披露里排除。
- `/skill <技能名> [额外指示]` 是显式调用入口，正文由 Pi 在 `accept` 内按技能文件构造并落盘（先落盘再投递）；启用清单在 accept 之前经 `setResources` 下发给 Harness。
- 刷新由**每回合一次 Rust 目录指纹核对**驱动（`skill_catalog_fingerprint` 只取 mtime/size，不读正文）：指纹变了才重载，没有 TTL、不需要重启。保存 / 删除 / 逐项开关 / Profile 重种子与每回合能力准备都汇到 `syncSkillCatalog()` 这一个入口；核对或重载失败保留上一份清单并记错误（`getSkillCatalogError()`），与「确实没有技能」不同形。
- `data_root/skills/{name}/SKILL.md` 是运行时资源；随包种子及恢复覆盖语义见[运行时数据](runtime-data.md#默认资源与-profile)。

## MCP 生命周期

[manager.ts](../../src/services/tool/mcp/manager.ts) 按运行 owner 借用连接（owner = 本轮 requestId 或 `resumeOwner(sessionId)`）；应用启动不连接 MCP。并发 acquire 串行化；末位 owner 释放后连接进入空闲宽限（stdio `MCP_IDLE_GRACE_MS` 120s／http `MCP_HTTP_IDLE_GRACE_MS` 30s 模块常量），宽限内再次借用直接复用同一条连接，到点仍未复用才关闭进程并注销工具；配置里撤下的服务器在下一次能力准备时立即断开（`disconnectUnlistedMcpServers`，只处理无 owner 的连接）。includeTools/excludeTools 过滤发现结果（收窄可注册的工具集）；stdio 形态的 npx 命令由宿主托管安装到数据根后直启（安装失败回退 npx）；http 形态（Streamable HTTP）用 url + headers，headers 值支持 `${ENV_VAR}`：**先查该条目 env、未命中再查应用自有存储**（宿主 `mcp_credential_get`，键 = 服务器名 + 变量名，值存记忆库 `mcp_credentials` 表、不写 CONFIG）。连接期取一次、不写回配置、不跨连接缓存；两个来源都取不到时点名变量如实失败（不静默降级为匿名请求）。凭据不落日志，请求强制 `redirect:"error"` 防凭据随重定向外泄。借来的工具进全局注册表、没有模式过滤 —— 借用期间此后每个回合的冻结工具集都含它们（fork/team 子代理按固定白名单（read / system_info / bash）收窄，不在其列）；对话回合实际下发的默认面由「回合激活面与渐进披露」收窄。工具定义在回合内冻结，设置变化不无声杀掉在飞回合的借用。

MCP 结果与内置工具走同一条回读链（[client.ts](../../src/services/tool/mcp/client.ts) 的一次性截断已删）：全文原样落会话条目，请求视图由 L0 投影按 `details.deskpetEntryId` 缩短并标注 eventId 回读地址，模型随后用 `read_session_event` 取回全文。唯一的物理上限在条目写盘链上（[native-execution-env.ts](../../src/services/tool/pi/native-execution-env.ts) 的 `MAX_TOOL_FILE_BYTES`，5 MB）：超过时写盘如实报错，不静默截断。

MCP 工具的取消链与预算（2026-10-06 体检报告 R2 对齐）：`toToolDefs` 的 handler 接工具上下文并把执行信号透传 `callTool` → pi-mcp 的 `request({ signal })` —— 在途请求可取消（客户端发 `notifications/cancelled` 并让 request reject），router 超时 / 用户取消不再留下打不断、晚到结果被静默丢弃的调用；工具声明 `timeoutMs = MCP_TOOL_TIMEOUT_MS`（传输层 `MCP_REQUEST_TIMEOUT_MS` 60s + 15s 余量）—— **必须严格大于传输层超时**，让传输层先以结构化 McpError 结束；旧实现不声明、吃全局 30s 默认，30s < 60s 的错位把 30–60s 内能完成的调用提前斩断。进度通知续期（`onProgress`）刻意未接：接上会让传输层超时永不触发、router 预算成为唯一死线，把「有进度但超过 75s」的调用从可见错误变成静默取消；本仓当前没有已启用的生产 MCP，待有实测的长调用再评估。

协议栈在 Node 侧由 `@earendil-works/pi-mcp`（1.0.2 精确锁）承担：initialize 握手与 `notifications/initialized`、tools/list 分页、通知/进度/取消都归客户端；[transport.ts](../../src/services/tool/mcp/transport.ts) 把它接到宿主桥上（spawn、裸行读写、kill）。Rust [mcp_bridge.rs](../../crates/native-host/src/commands/mcp_bridge.rs) 只做裸行收发：`mcp_write` 写一行、`mcp_read` 等下一行 JSON（默认 30s、上限 120s；非 JSON 行跳过留痕、通知原样上行、断开返回 `closed` 且此后恒真、同一服务器并发读拒绝），整行作为单个字符串走既有 blob 物化——超过 64KiB 控制帧的巨型结果不再受限。应用退出由统一退出序列回收 server（`kill_all`）；Unix 按进程组回收（`process_group` + `killpg`）、Windows 用 `taskkill /T` 递归结束进程树。

原生设置窗的工具页对 MCP 提供服务器列表、逐项开关与连接测试（管理面 `tools_mcp_servers` / `tools_mcp_toggle` / `mcp_test`，占用中的服务器由既有入口拒绝）；条目的编辑面是**表单**（`mcp_server_form` / `mcp_save`，字段控件逐项：name/transport/command/args/url/headers/env/enabled），逐字段校验、`sse` 明确拒绝并点名；**重名保存不覆盖**（新增撞名与改名撞名都结构化报错）。`args` 每行一个参数、`env`/`headers` 是多行 KEY=VALUE 文本（与 `parseEnvText` 同源）。CONFIG 直改的条目与 JSON 导入同样过逐字段 schema 校验（不再 `String()`/默认 true 收拢；导入兼容 `"type":"http"` 与缺省字段是外部格式适配的显式默认）。出厂自带 github 远程条目（`https://api.githubcopilot.com/mcp/`，`enabled: false` 开箱不连接；免 Copilot 席位、默认只读头），面板里附一行「GitHub 令牌」（`action = credential`）：状态经 `mcp_credential_status`（只回变量名、不回值），点击弹原生输入框把值经 `mcp_credential_set` 写进自有存储。env 只透传给子进程，日志不打印 env。MCP 工具一律声明 `passthrough` + `external_side_effect` + `exclusive_effect`，既不能凭发现结果自动获得执行许可，也不能与其它执行并发。

验证规则见[测试边界](testing.md)。
