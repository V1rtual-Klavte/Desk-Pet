# 当前系统地图

用途：定位模块、入口和状态所有者。行为协议见[运行时契约](runtime-contract.md)，产品体验见[DES](../DES.md)。本文不维护阶段进度或测试结果。

## 进程与入口

应用由两个进程组成：**原生宿主**（Rust，唯一常驻进程，不含 Tauri/WebView/Wry）与**唯一 Node Harness**（由宿主拉起）。两者经私有 IPC 互通：控制通道与二进制通道分开，协议字节布局的唯一规范在 [ipc/mod.rs](../../crates/native-host/src/ipc/mod.rs)，Node 侧客户端在 [src/services/host/](../../src/services/host/)。

| 入口 | 职责 | 首先查看 |
|---|---|---|
| 原生宿主可执行 | 窗口/托盘/全局快捷键/五层渲染、屏幕与窗口观测、SQLite（记忆与主动链）、子进程监督（Node/Bash/MCP）、图片解码缩放编码、应用内更新与安装 helper、全部最终路径与命令裁决 | [main.rs](../../crates/native-host/src/main.rs)、[lib.rs](../../crates/native-host/src/lib.rs) |
| Node Harness（唯一 Node bootstrap） | 全部业务与模型侧：会话、上下文、Pi Agent 回合、工具/MCP/Skill、记忆、主动陪伴、人格；`pnpm run build:harness` 把 [src/harness/main.ts](../../src/harness/main.ts) 打成 `packaging/dist/harness/main.mjs`，由随包 Node 运行 | [harness/main.ts](../../src/harness/main.ts) |
| 开发入口 | `pnpm dev` = `dev:prepare`（暂存随包 Node、构建 harness 产物、建 defaults 链接）+ `dev-run.mjs`（`cargo build` → `target/debug/native-host`，追加参数与退出码原样透传） | [scripts/dev-prepare.mjs](../../scripts/dev-prepare.mjs)、[scripts/dev-run.mjs](../../scripts/dev-run.mjs) |
| 打包 | cargo-packager（`packaging/desktop.json`）：`native-host` + `deskpet-update-helper` 两个可执行 + `node/`、`harness/`、`defaults/` 三件随包资源；随包 Node 版本锁定在 [packaging/node-runtime.json](../../packaging/node-runtime.json)（22.22.3） | [packaging/desktop.json](../../packaging/desktop.json)、[node-runtime.json](../../packaging/node-runtime.json) |

Node 的端点与一次性握手值只经环境变量 `DESKPET_HOST_LAUNCH` 传入；Node 的 stdout/stderr 只作日志采集，RPC 不经过标准流（[supervisor.rs](../../crates/native-host/src/host/supervisor.rs)）。

## 原生宿主模块

| 模块 | 职责 | 首先查看 |
|---|---|---|
| host | 宿主能力端口 trait（WindowPort / FileDialogPort / AssetScopePort / LifecyclePort / EventSink）、唯一事件出口组合路由、完整命令分派器、Node 监督器（拉起/握手校验/崩溃代际轮换/关停序列）、端口实现 | [host/mod.rs](../../crates/native-host/src/host/mod.rs)、[host/dispatch.rs](../../crates/native-host/src/host/dispatch.rs)、[host/supervisor.rs](../../crates/native-host/src/host/supervisor.rs)、[host/native_ports.rs](../../crates/native-host/src/host/native_ports.rs)、[host/events.rs](../../crates/native-host/src/host/events.rs) |
| ipc | 私有 IPC：端点（macOS Unix socket / Windows named pipe）、角色与魔数握手、控制帧与二进制帧、blob 注册表与信用背压、请求配对、事件广播 | [ipc/mod.rs](../../crates/native-host/src/ipc/mod.rs)、[ipc/bridge.rs](../../crates/native-host/src/ipc/bridge.rs)、[ipc/transport.rs](../../crates/native-host/src/ipc/transport.rs) |
| ui | 原生 UI 域：主窗/设置窗/图层编辑器/图片查看器、聊天域（受控富文本、输入 IME、面板、读模型投影）、托盘、呼出收回状态机、全局快捷键、字体快照、顶栏状态位、**界面主题**（三套预设的 token 表 + 纹理生成 + 平台绘制适配） | [ui/mod.rs](../../crates/native-host/src/ui/mod.rs)、[ui/chat/](../../crates/native-host/src/ui/chat/)、[ui/settings/](../../crates/native-host/src/ui/settings/)、[ui/editor/](../../crates/native-host/src/ui/editor/)、[ui/titlebar.rs](../../crates/native-host/src/ui/titlebar.rs)、[ui/theme/](../../crates/native-host/src/ui/theme/) |
| ui/theme | 主题域：`tokens.rs`（55 项设计稿变量 → 45 个语义槽位 × 三套预设，编译期常量）、`noise.rs`（可平铺 fBm）、`texture.rs`（配方 + 只留当前主题的驻留）、`paint.rs`/`paint_win.rs`（平台绘制适配） | 设计基准见 [theme-candidates.html](../../docs/history/design/theme-candidates.html)；取值真相只在 `tokens.rs`，Node 只传主题 id |
| render | 五层角色舞台：几何核（渲染器与编辑器共用）、纹理生命周期、帧循环与平台表面（CALayer / Layered Window） | [render/mod.rs](../../crates/native-host/src/render/mod.rs) |
| images | 图片域唯一实现（解码/缩放/编码）与受控预览生命周期：截图落盘与编码、查看器预览、聊天内联预览（`appearance.chatImagePreview`）、模型请求附件的图片处理入口 | [images/mod.rs](../../crates/native-host/src/images/mod.rs)、[images/inline.rs](../../crates/native-host/src/images/inline.rs) |
| monitor / window | 事件驱动的窗口观察（前台切换/锁屏/睡眠唤醒触发采样）；窗口几何常量、创建后增强与层级 | [monitor/mod.rs](../../crates/native-host/src/monitor/mod.rs)、[window/mod.rs](../../crates/native-host/src/window/mod.rs) |
| memory | 长期记忆 SQLite：唯一建表点、存储核心（单写者）、治理命令；**惰性打开**（第一条记忆命令才打库） | [memory/schema.rs](../../crates/native-host/src/memory/schema.rs)、[memory/store.rs](../../crates/native-host/src/memory/store.rs)、[memory/commands.rs](../../crates/native-host/src/memory/commands.rs) |
| proactive | 主动链状态（与记忆同库同连接）：schema、store 与宏生成的命令面 | [proactive/schema.rs](../../crates/native-host/src/proactive/schema.rs)、[proactive/commands.rs](../../crates/native-host/src/proactive/commands.rs) |
| commands | transport 无关的命令域：Bash 策略与执行池、文件/进程/桌面/系统工具、工具许可、MCP 进程桥、会话文件、人格/Profile/资源/Skill 文件、聊天图片准入、截图与观察、字体、日志、光标 | [commands/](../../crates/native-host/src/commands/) |
| paths | AppPaths（数据根与各域目录的唯一决定点）、路径安全（允许根/凭据/记忆库保护）、种子与恢复 | [paths/mod.rs](../../crates/native-host/src/paths/mod.rs)、[paths/security.rs](../../crates/native-host/src/paths/security.rs)、[paths/seeding.rs](../../crates/native-host/src/paths/seeding.rs) |
| update | 应用内更新：`update.json` 校验链（验签/平台架构/完整组件集/版本更高）、staging、独立 helper 替换安装 | [update/mod.rs](../../crates/native-host/src/update/mod.rs) |
| audio | 宿主音效接口（`AudioPort` 与平台实现位）；当前未接线，`None` 时只记日志、不伪造播放成功 | [audio/mod.rs](../../crates/native-host/src/audio/mod.rs) |
| e2e_trace | 测试专用 trace 落盘（仅 debug + `is_e2e()`） | [e2e_trace.rs](../../crates/native-host/src/e2e_trace.rs) |

## Node 领域（src/services/**）

该目录的开发约束由 [services AGENTS](../../src/services/AGENTS.md) 维护，本节只列职责与源码入口。

| 模块 | 职责 | 首先查看 |
|---|---|---|
| host / harness | HostBridge 唯一取用口、命令与事件类型矩阵、环境端口（运行模式、资源 URL、执行路径运算、UI 事件发布与回执）；harness 是唯一 Node bootstrap | [host/](../../src/services/host/)、[types.ts](../../src/services/host/types.ts)、[harness/main.ts](../../src/harness/main.ts) |
| init | Node 侧领域引导的一次性序列与能力准备（借用 MCP、核对 Skill 目录指纹） | [init.ts](../../src/services/init.ts) |
| agent | 用户输入、子代理与主动消息入口（Provider 调用归 `engine/harness/model-gateway.ts`） | [runner.ts](../../src/services/agent/runner.ts) |
| engine | 预处理、Plan、Slash、Harness 运行槽、会话仓库与压缩接线 | [engine/](../../src/services/engine/)、[harness-slot.ts](../../src/services/engine/harness/harness-slot.ts)、[runtime.ts](../../src/services/engine/harness/runtime.ts)、[session-repo.ts](../../src/services/engine/harness/session-repo.ts) |
| engine/runtime | 可选惰性 trace、快照协议与输入事件身份（`deskpetEventId`/`deskpetSource`） | [runtime/](../../src/services/engine/runtime/)、[input-identity.ts](../../src/services/engine/runtime/input-identity.ts) |
| context | 分层构建、共享预算（块排序与整块淘汰）与工具输出请求投影 | [context/](../../src/services/context/) |
| memory | 召回端口、来源收集、dreaming 编排；Rust 记忆库本体在 [crates/native-host/src/memory/](../../crates/native-host/src/memory/)，V1RTUAL 属于 context instructions，Plan checkpoint 属于 engine/plan | [agent/memory/](../../src/services/agent/memory/)、[instructions/](../../src/services/context/instructions/)、[plan/](../../src/services/engine/plan/) |
| proactive | 机会、有限规划、约定任务、预算、消息回执与 presence；治理表共用 MemoryStore 连接（Rust 主动域在 [crates/native-host/src/proactive/](../../crates/native-host/src/proactive/)） | [proactive/](../../src/services/proactive/) |
| behavior | 独立派生域：采集窗口心跳、分段、日聚合、质量与时机指标 | [behavior/](../../src/services/behavior/) |
| evaluation（测试宿主） | trace 缓冲/ACK/证据审阅、真实记忆质量跑批与性能采样；不拥有产品运行状态 | [test/trace/](../../test/trace/)、[test/memory-quality/](../../test/memory-quality/)、[trace-observer.ts](../../test/host/trace-observer.ts)、[e2e_trace.rs](../../crates/native-host/src/e2e_trace.rs)、[memory/benchmark.rs](../../crates/native-host/src/memory/benchmark.rs) |
| session | 会话仓库访问层、会话列表与消息读模型、切换与恢复 | [session/](../../src/services/session/) |
| humanizer | 引擎拟人协议、沉默护栏、提交后逐泡揭示（只存瞬态进度） | [humanizer/](../../src/services/humanizer/) |
| native-ui | Node ↔ 原生宿主数据流：状态推送（快捷键/字体/主题/舞台/聊天列/图片预览/摆位尺寸/自动呼出/音效/顶栏文本/揭示进度/权限确认）、宿主请求应答（设置读写、编辑器 I/O、聊天与会话意图、决策动作、管理面）、会话投影帧组装的唯一入口 | [native-ui/](../../src/services/native-ui/)、[session-projection.ts](../../src/services/native-ui/session-projection.ts)、[host-requests.ts](../../src/services/native-ui/host-requests.ts) |
| images | 原图路径准入、预览与请求投影；聊天图片自动预览开关的 Node 侧消费（默认关，占位零预读、只按可见加载）；read/请求链路的图片处理端口见[工具系统](tool-system.md) | [images/](../../src/services/images/) |
| observation | 截图／手边文件了解、对话主题权重，独立派生域（原生实现见 [observation_cmd.rs](../../crates/native-host/src/commands/observation_cmd.rs)） | [observation/](../../src/services/observation/) |
| personality / reply | Card（加载切换 + 设置页的增删改查、导入导出与作者模版）、变量与阶段文案；回复元数据解析和效果 | [personality/](../../src/services/personality/)、[reply/](../../src/services/reply/) |
| tool / safety | 工具注册和路由、Pi 文件工具、MCP；权限与确认 | [tool/](../../src/services/tool/)、[safety/](../../src/services/safety/) |
| skill | Pi 原生 Skill 清单（目录指纹驱动刷新）与披露块 | [skill/](../../src/services/skill/) |
| profile / audio | 外观资源与导入导出；音效事件/预设与设置分配，Node 将音效图编译为 WAV，通过 HostBridge 交给原生宿主播放 | [profile/](../../src/services/profile/)、[audio/](../../src/services/audio/) |
| window | 窗口观察的 Node 侧订阅与观察总闸（AI 生成锁与主动冷却已不在此域：锁由 engine/harness 的回合状态推导，主动冷却的真相源在 Rust 账本） | [window/](../../src/services/window/) |
| config / paths | 类型化配置（唯一 getter 面）；路径初始化与 `runtimePath` | [config.ts](../../src/services/config.ts)、[paths.ts](../../src/services/paths.ts) |
| logger / error | 统一日志（经桥批量落盘）与异常单一出口；原生交互提示由宿主 UI 承接 | [logger/](../../src/services/logger/)、[error/](../../src/services/error/) |

## 通信面

- **Node → 宿主命令**：`HostCommandMap`（135 条 = 107 冻结 + 28 条有意扩展；冻结件已删 `profile_clone`（改「新建 Profile」）与 `mcp_send`（裸行收发改 `mcp_write` / `mcp_read`）；有意扩展如界面主题下发 `apply_theme`（只传预设 id、色值真相在宿主 `ui/theme`）、记忆整理的前置查询 `memory_pending_source_count`（水位之后有无待处理来源，开作业前查；只读、不带副作用）、MCP 凭据读写 `mcp_credential_set` / `_delete` / `_status` / `_get`（值存记忆库同库的 `mcp_credentials` 表、不写 CONFIG；唯一的值出口是 `_get`，供 MCP 连接期注入）与删会话清理托管聊天图片 `chat_delete_session_images`（只删 `screenshots/` / `pasted/` 两个托管根内的常规文件，根外路径、目录与符号链接一律不删））逐条对应 Rust `NativeDispatcher` 分派；失败以结构化 `HostError` reject（错误码与 `AppError::code()` 同表），不降级为字符串。超过控制帧上限的字段自动编码为 blob，经二进制通道物化，应用层结果类型不缩水。
- **宿主 → Node 请求**：`HostRequestMap`（设置读写、弹窗几何写回、人格卡/Profile 列表、编辑器 I/O、会话标签与历史意图、核心聊天链路、决策类面板动作、设置页管理面）。传输复用两条既有通道：宿主投事件 `deskpet-host-request`，Node 用 `host_request_result` 命令回执；发送/停止等热路径用非阻塞提交，有界等待只用于用户尺度低频动作。
- **事件（宿主/Node → 原生 UI）**：`HostEventMap`。宿主生产两类——`deskpet-cursor-move` **只直投原生 UI**（60fps 不经 Node），`window-observed` **双投**原生 UI 与当前代际 Node；Node 生产聊天流式、运行状态、阶段提示、计划、权限确认与揭示进度等事件，经桥按当前代际路由进 `ChatUi`。UI → Node 的回执（计划确认、步骤裁决、权限确认）走 `UiReceiptMap`，不进 `HostEventMap`。
- **纯 UI 的窗口间协调不经 Node**（设置窗↔主窗、编辑器↔主窗、revision 同步、主动控制、观察治理），由原生 UI 内部承接（[types.ts](../../src/services/host/types.ts) 末尾的 (b) 类清单）。

## 主消息链路

```text
原生 UI 输入 → HostRequestMap.chat_send（Node 处理体在 native-ui/chat-intents.ts）
  → sendMessage → preprocessor / Slash
  → 空闲 slot.admitInput() → driveAdmitted()（先 lane.accept 落盘再驱动，不走上游 lane.prompt）/ 忙碌 lane 持久 inbox（steer / followUp）
  → runPiAgentTurn：捕获会话与运行身份、Card/变量/模型快照（preflight）
      → 准备本轮工具与 Skill 清单（每回合核对目录指纹）
      → 按 `ai.plan.enabled` 执行可选 Plan（复杂度评估决定是否触发），取得步骤结果
      → recallMemory（默认空）→ Harness Lane：transform_context 投影 → Provider → before_tool 权限与执行
      → 条目提交、逐请求 usage、流式正文事件
      → ReplyGenerator：RUNTIME_DATA、变量与显示文本
  → 固定 session 的条目/状态完成 → 投影帧（apply_chat_projection）与事件（deskpet-*）回推原生 UI
```

该图描述普通消息主路径。主动消息、Slash、错误和恢复有各自来源与终止路径；不能据此推断每条输入都调用模型或 Planner。停止（`chat_stop` → `stopActiveRun`）与会话切换同样是宿主请求；运行/排队显示读投影与事件，UI 不持有第二份运行状态。

## 状态所有权

| 生命周期 | 所有者 | 边界 |
|---|---|---|
| 跨重启 | 配置文件、Card/Profile 资源、会话 JSONL 条目、记忆与主动链 SQLite（[数据库](database.md)） | 文件原子提交；index 不是正文来源；库走事务提交与 schema 版本校验 |
| 应用（Node） | 配置、Card/Profile 选择、能力目录 | 新 run 读取快照；切换有专用入口 |
| 会话 | Lane 持久 inbox、会话 JSONL 条目 | 身份由 sessionId 与操作代际关联 |
| 单次运行 | 冻结模型/能力/Prompt 来源、AbortSignal、写队列 | 旧运行不能修改新的会话或 Card 所有者 |
| 宿主进程 | 窗口与呼出/收回状态、渲染纹理、快捷键注册、工具执行许可额度、blob 句柄、舞台/字体/顶栏快照 | 只存运行时快照与临时状态；进程退出即失；CONFIG/Profile 真相源仍在 Node |
| 界面（原生 UI） | 标签、消息、进度与表达效果的显示态 | 从领域事实投影（投影帧 + 事件），不重建第二份持久化 Store |

具体模型工厂、重试、取消、Plan 恢复、PromptSnapshot 与工具写入顺序由[运行时契约](runtime-contract.md)维护。

## 启动与资源

**原生宿主**（[main.rs](../../crates/native-host/src/main.rs)）：解析宿主环境与 `AppPaths`（数据根、随包资源根、开发工作区）→ 日志文件 sink → 更新域装配（幂等，失败只留痕）→ 校验随包 Node 与 harness 产物存在（缺失即启动失败，不回落系统 Node）→ 建主窗/托盘/快捷键（`ui::start_service`；Node 未就绪时窗口显隐与快捷键仍由 Rust 本地完成）→ UI 就绪后由后台线程拉起 Node（监督器握手校验协议版本、Node 版本与一次性握手值）→ 常驻观察退出。

**Node**（[harness/main.ts](../../src/harness/main.ts)）：连端点（hello/welcome）→ `get_runtime_paths`（必要时核对与 welcome 的运行模式口径）→ 校验必需路径字段 → 安装错误出口与生命周期钩子（宿主关停先 flush 并如实回报；宿主断开即退出）→ `initDomainBootstrap()`（[init.ts](../../src/services/init.ts)）：路径与运行时 CONFIG → memory/V1RTUAL/idle 整理 → Profile → Card → proactive/session 接线 → 工具与 slash 命令表 → 会话恢复 + Plan checkpoint 恢复 → 欢迎语 → debug → 原生 UI 桥（宿主请求处理器 + 首帧推送）→ 窗口观察接线 → 主动扫描与静默了解调度启动。任一步失败向上抛给 bootstrap（记录并退出），不做「吞掉继续」。

**退出序列**（[生命周期契约](../history/implementation/原生宿主轻量化执行契约-2026-10-04基线.md) §4.3 第 5 条）：托盘「退出」/系统终止/命令侧 `app_restart` 经同一个只跑一次的 `HostExitHook`——先回收 MCP 与 Bash 子进程池，再让监督器封新 admission → 请求 Node flush → 等真实报告 → 停 Node；超时如实记中断，不伪报成功；有 staged 更新时由独立 helper 在整套进程退出后替换并重启。

MCP 不随应用启动连接；按运行 owner 借用，末位释放后空闲宽限内复用。Skill 按目录指纹刷新清单（每回合一次核对，不读正文），披露块只含名称/说明/位置。记忆整理默认由空闲调度器在配置条件和持久预算内触发，手动整理共用同一自动提交协议。Profile 与默认资源的位置见[运行时数据](runtime-data.md)，构建/平台/日志诊断见[工程参考](development.md)。

Node 崩溃由监督器按策略自动重启（换代际、回收旧句柄与 blob；连续失败上限 5 次、退避 2 秒），只把待处置状态交还新 Node，不自动重放有未知副作用的操作。
