# AGENTS.md · services（TypeScript 业务层）

本文件适用于 `src/services/**`，补充[根 AGENTS](../../AGENTS.md) 的全局规则。
这里维护 Agent Loop、Provider、工具与权限、MCP/Skills、Prompt/Persona、会话与状态，
并通过 HostBridge 连接 Rust 宿主。`src/harness/main.ts` 是唯一 Node 引导入口；
涉及该入口的接线改动也需核对本文件，文件所在目录的规则作用域不因此扩展。
Rust 实现细则见 [native-host AGENTS](../../crates/native-host/AGENTS.md)，
测试选层、契约与门禁见 [test AGENTS](../../test/AGENTS.md)，不在这里重复。

## 按任务读取

只读目标领域源码与对应 current 文档；模块地图由[系统地图](../../docs/current/system-design.md)维护。

| 任务 | 文档入口 |
|---|---|
| 回合、队列、取消、恢复、Prompt/压缩 | [运行时契约](../../docs/current/runtime-contract.md) |
| 会话与长期记忆边界 | [当前记忆](../../docs/current/memory.md)、[数据库](../../docs/current/database.md) |
| 工具、权限、MCP、Skill | [工具系统](../../docs/current/tool-system.md) |
| 配置、路径、Card/Profile 与种子 | [运行时数据](../../docs/current/runtime-data.md) |
| 变量、阶段提示、回复元数据 | [人格与回复](../../docs/current/personality.md) |
| 主动陪伴、观察、画像与回执 | [主动陪伴](../../docs/current/proactive.md)、[行为画像](../../docs/current/behavior.md) |
| IPC、引导、异常与构建 | [工程参考](../../docs/current/development.md) |
| 迁移剩余工作 | [未完成总表](../../docs/plans/active/未完成工作与已知缺口.md) §10、§11 |

## 模块与配置取用

- 单文件服务可平铺；≥3 文件或有内部结构时放 `src/services/<领域>/` 并提供 `index.ts`。
  跨领域使用公开 barrel，不深入业务内部文件；零依赖叶子保持独立，避免循环引用。
- 跨领域共享纯函数放零依赖叶子；全局冷却与并发所有权复用既有模块，平台检测走 `@/services/env`。
- 配置只经 `@/services/config` 的类型化 getter 读取；不复制默认值，不直读内部 cfg。
  设置读写值与运行期派生值分开，例如 `generalConfig.loggingLevel` 与 `computeLogLevel()`。
  字段变更遵守[全局配置同步链](../../AGENTS.md#单一真相源与模块落位)，不只改 getter 或设置 UI。

## Node 与 HostBridge

- 业务模块与公开 barrel 必须在标准 Node 中可加载：不引入 `@tauri-apps/*`、WebView 或 DOM 依赖，
  不用 `window` / `document` / `navigator` / `import.meta.env` 判断运行环境。
  保留标准 Node/npm、`node:*` 与原生扩展生态；不为轻量化换成不兼容的 JS 运行时。
- 宿主能力只通过 `@/services/host` 的公开接口取用；领域代码不自行创建 transport、连接 socket，
  不回落全局 Node、空实现或过期缓存。唯一 bootstrap 握手成功后注入 HostBridge 与环境端口，
  再取路径、初始化日志/错误、启动领域服务；未注入或断线必须显式失败。
- `HostCommandMap`、`HostEventMap`、`HostRequestMap` 的 TS 形状集中在 `host/types.ts`；
  Rust 签名、错误码与线协议分别以宿主分派、`AppError::code()`、`ipc/` 为准。
  业务消费者通过 `getHostBridge().request()` 调用，不重复定义命令签名或线协议。
  跨侧同步义务见[全局 IPC](../../AGENTS.md#跨层-ipc)。
- `request` 失败以结构化错误 reject，不返回空值冒充成功；Rust `Option<T>` 结果映射为 `T | null`，
  `()` 为 `void`，可选参数为 `?: T | null`；二进制成功值保留 `Uint8Array`。
  64 KiB 控制帧是流控单位，超长内容由 bridge 经 blob 传输后物化完整原值，业务不得截断。
- 请求、晚到回执与推送按 `RunScope` 校验 Node epoch、session/run generation 与 owner。
  取消、shutdown、owner 失效走控制优先队列；`subscribe` 的退订函数随所有者释放。
  `readBlob` 只读宿主签发句柄，路径不等于授权；关闭、取消或断线归还句柄并清理订阅/等待者。
- Node 交付业务状态与意图，窗口显隐、层级、绘制与系统 API 归原生宿主；具体 UI 边界见
  [native-host AGENTS](../../crates/native-host/AGENTS.md#51-ui-的硬约束)。UI 不另建 run owner 或持久化 Store。
- 关停先停止调度并取消活动任务，再刷写已准入持久化/审计/日志并释放 MCP、订阅与 blob。
  `shutdownFlush` 必须报告实际完成/失败结果；宿主断开后不得留下孤儿 Harness。

## 路径、配置与资源

- 数据根由 Rust `AppPaths` 决定；开发/生产依据 Rust 构建模式（`cfg!(debug_assertions)`），
  TS 侧经 `@/services/paths` 的 `getRuntimeMode()` 消费同一事实（运行模式由宿主引导交付，
  不自行另判）。不用进程环境（`NODE_ENV`、cwd）或 `import.meta.env` 推导路径环境。
- TS 先初始化路径；`BaseDirs` 只表示目录，完整文件路径通过 `runtimePath(scope, ...segments)` 取得。
- 默认 Card/Profile/Skill 仅作首次初始化种子；完成后所有读取和编辑走运行时资源。
  初始化标记存在后删除不自动恢复；恢复默认资源是明确的覆盖操作。
- `appearance.effectMode` 单字段裁定 off/parallax；逐层素材与参数属于当前 Profile，
  全局 CONFIG 不覆盖 Profile 的效果参数。非法枚举按读取期规则收拢为 off（不写盘、不建旧值兼容映射）。
- Profile 是自包含闭包：图层素材只从 Profile 自身目录读取，导入即用，
  不跨 Profile 回退（图层素材在 `materials/L{n}/`）；主题是产品级预设
  （CONFIG `appearance.theme`），不随 Profile。
  内存只保留激活 Profile；设置页列 Profile 用 `readProfileMeta()` 轻量读 meta，不进缓存。
- 主题下发只传 `appearance.theme` 的预设 id；颜色、纹理与设计稿同步约束由
  [native-host AGENTS](../../crates/native-host/AGENTS.md#52-主题与设计稿)维护。
- 字体是全局设置（`appearance.font`），不随 Profile：取值为用户系统已安装的字体名
  （Rust `list_system_fonts` 枚举），Profile 不携带字体资源；消费点统一走 `@/services/font` 注入。
- 顶栏文案（缺省「就绪」——无 owner = 空闲的中性文案，不得用「配信中」这类在线口吻
  谎报在线）是窗口运行时状态，唯一真值点在 `@/services/titlebar`：
  不随 Profile、不持久化，重启回到缺省；原生 UI 的文本只由 `@/services/native-ui/titlebar-status`
  推送（`apply_titlebar_status`），宿主持文本快照、不落盘；暂未开放界面编辑，保留接口供联动功能改写。
  **运行过程状态（阶段提示 + 工具过程文案，Card 文案）也走这个 owner**（priority 20，
  首条揭示 / 回合收尾释放）：过程文案的唯一显示位是顶栏，聊天窗底部只显示中性通知
  （用户规则 2026-10-05）。
- 配置、会话正文与 Profile 编辑状态不保存到任何浏览器存储（Node 侧没有 localStorage）；
  设置修改直接写回 CONFIG 文件。

## 运行时不变量

- 会话正文以数据根 `sessions/` 的 JSONL 为真相源（JsonlSessionRepo，commit 事务写入）；
  写入以追加为主，已删除或被更晚写入覆盖的 key 的旧写入行可被折叠清理，逻辑状态不变；
  `sessions/index.json` 仅保存可丢弃 UI 状态。
- 正文条目保存稳定 entryId/seq 与运行关联；用户 ingress 先落盘再投递（lane 持久 inbox）；
  工具调用先落盘再执行，结果落盘后才进入下一次 Provider 请求。
- 所有异步读取、写回、确认、取消都绑定 session 与 run generation；旧运行不能改写新所有者状态。
  未知外部副作用不自动重放；UI 和 Pi 内存消息不成为第二份持久化 Store。
- 压缩只改变请求视图，完整正文保留；compaction 条目由 Harness 单事务提交，提交成功前不报告完成。
  摘要失败或无可覆盖时 decline/报错，禁止默默丢弃未覆盖历史；已提交的写入不因取消回滚。
- 预算共用 ContextKernel 规则，包含完整 schema、输出预留及压缩余量；静态协议与当前输入不截字。
  每轮冻结 Card/变量/配置/能力；PromptSnapshot 只保存 hash 与审计元数据，不落盘原始 Prompt。
- Card、互动状态、用户长期事实分开。RUNTIME_DATA 由回复模块剥离、验证、持久化，不能重新塞回 Loop。
  card/interaction 保存 VariableState；system/session 使用原始只读值。LLM 只写注册且允许更新的 card 变量。
- `whenText` 是自然语言指引；不恢复旧变量工具、情绪前缀或可执行 When DSL。
- 用户可见的阶段提示、过程提示与兜底台词一律由当前 Card 生成，源码不留硬编码文案：
  取用只经 `getStagePrompt` / `getSimpleStage` / `getCommandReply` / `getFallbackReply`，
  引擎按语义 key 发事件、界面取文案，两边都不各存一份台词。
  新增一个用户可见场景时，先在 `StageMap` / `FallbackReplies` / `CommandReplies` 加 key，
  同步 `stages-prompt.md` 与 `validateStages`（旧缓存必须判过期重生成，否则新 key 永远取不到
  Card 文案），再接消费点；`FALLBACK_*` 常量只是 Card 完全不可用时的中性兜底。
  系统消息与错误诊断保持中性：角色台词会掩盖故障，用户要能分清「角色在说话」和「出问题了」。
- 主请求与一次性文本请求统一走模型网关，共享配置、认证、取消和 deadline；不叠加 SDK 内层重试。
- 长期记忆只经 MemoryProvider 进入 Runtime（核心画像也走它）；事实与治理决定归 Rust 侧 SQLite
  （`数据根/memory/`），JSONL 只是会话证据源。
- 只有 `origin=user` + `taint=trusted_user` +
  `eligibleForMemory=true` 的已提交条目能成为候选：不得把压缩摘要、工具结果、主动消息、助手台词
  或已召回的记忆晋升为用户事实。直接记忆工具绑定本轮可信用户事件；dreaming 候选在 job 边界经
  来源 hash、版本、失效代和租约复核后整批自动提交，不恢复批准路径。
- 遗忘要覆盖正文、索引、候选与
  补扫回灌，且不把「忘记记忆」说成删除了聊天原文或外部备份。

## 工具与权限

- 使用 Pi AgentHarness 原生 hook（`before_tool` / `after_tool` / `transform_context` / `before_compaction` 等）；不重建无消费者的 HookBus。
- PermissionKernel 终裁 allow/ask/deny；passthrough 只能继续策略链，不能直接执行。MCP 走 passthrough。
- deny-first；确认与授权绑定会话、代际、精确参数与策略，变更后重审（「会话内允许」的授权保鲜期另计，等待确认本身没有超时）；摘要不能恢复授权。
- 执行端的路径与 Bash 基线不得由 TS 绕过；取用端口与边界见
  [native-host AGENTS](../../crates/native-host/AGENTS.md#4-路径与安全边界)。
- Skill 清单由 Pi loader 维护：每回合核对一次目录指纹（不读正文），指纹变了才重载（重载时读入
  正文）；进请求的只有 name/description/location 披露块，正文在 `/skill` 显式调用或模型 read
  时才进入对话；Skill 不提升权限。
- MCP 按运行借用并释放；末位释放后连接在空闲宽限内复用，到点回收；启动不连接 MCP。

## 主动陪伴与整理

- 记忆整理只按档位钟点表与持久预算运行（到点即跑，不再要求系统空闲）。
- 主动规划为带只读工具的有界子运行（工具面按 SAFE 白名单装配、轮数/超时/token 封顶）；
  主动表达 `tools=[]`；来源和 owner 失效时取消；送达只认原生已提交助手条目与
  SQLite 精确回执，未知外部副作用不重放。
- 派生 behavior 与长期事实分域；清除画像同时撤销相关来源资格。系统可消费已提交 Card 变量，
  主动回复的变量写回不能自激出新机会。

## 日志与错误

- 日志走 `@/services/logger`，错误走 `@/services/error`；禁止直接 `console.*` 或 `String(e)`。
- 错误判断使用 `formatError()` / `errorCode()`；持久化错误使用脱敏的 `summarizeError()`。
- Node 侧全局异常在唯一引导（`src/harness/main.ts`）装进程级出口：未捕获异常/未处理拒绝
  单一出口留痕并以 73 退出，不留半死进程；`reportError()` 是统一错误出口，不自行再建覆盖层。
- 静默捕获的理由与统一留痕点遵守[全局错误留痕](../../AGENTS.md#错误留痕)；这里不另建保留项清单。

## 维护义务

全局配置/IPC 同步与文档维护遵守根 AGENTS；服务域内额外核对以下消费者。

| 改动 | 必须核对 |
|---|---|
| public barrel / 共享接口 / 模块路径 | 全部 import 与动态引用、Harness bundle、相关 Contract sourceFiles |
| HostBridge 请求 / 事件 / 回执 / scope / blob | `host/event-names.ts`（事件名单点）、`host/types.ts`、bridge 消费者、`native-ui` 接线与 Rust 对应实现 |
| 会话提交、取消、恢复或压缩 | generation 所有权、JSONL 事务、请求视图、相关行为契约与 current |
| Card 变量、阶段 key 或回复元数据 | 类型、解析/验证、Prompt 模板、缓存过期判定与全部消费点 |
| 权限、MCP/Skill 或主动来源资格 | 终裁/租约、释放/取消、来源验证与工具/主动 current |
| 配置刷新、Profile/字体/顶栏状态 | 唯一状态源、Node 推送、原生消费者与运行时数据说明 |

契约变更按 [test/SKILL](../../test/SKILL.md) 分析与生成，不能只改 hash；
验证命令与是否运行遵守测试域规则及本轮用户授权。
