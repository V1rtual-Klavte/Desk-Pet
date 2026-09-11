# AGENTS.md

> 糖糖桌宠 (Desk Pet) — Tauri v2 桌面虚拟主播助手
> 项目总览、玩法和整体机制见 [docs/DES.md](docs/DES.md)。

## 技术栈

- 桌面框架：Tauri v2（Rust 后端 + WebView 前端）
- 前端：Vue 3 + TypeScript + Vite
- 包管理：pnpm + Cargo
- AI：Pi Agent Core + pi-ai OpenAI-compatible Adapter（DeepSeek / OpenAI / Ollama / LM Studio）
- 目标平台：Windows + macOS

## 构建与运行

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm tauri build
cd src-tauri && cargo check
```

`pnpm dev` 仅启动前端开发服务；完整桌面运行使用 `pnpm tauri dev`。

## 测试

Live Test 框架位于 `src/services/__tests__/live/`，由 Contract、Scene、Runner 和 Reporter 组成，可调用真实 Provider 验证跨模块链路。

```bash
pnpm test
pnpm test -- --module variable-pool
pnpm run test:types
pnpm run test:smoke
pnpm run test:release
```

| 命令 | 作用 |
|---|---|
| `pnpm test` | 执行场景并断言运行时状态 |
| `pnpm run test:types` | Vue 类型与 Rust 编译门禁，不替代 Live Test |
| `pnpm run test:smoke` | `sendMessage()` 真实入口的严格双 trial smoke |
| `pnpm run test:release` | 编译 + 严格 Contract + 三次真实 trial 的发布门禁 |

源码修改后，受影响模块的 Contract 需要重新分析；Contract hash 过期时不得把旧测试结果当作当前验证。

## 测试架构

```text
src/services/__tests__/live/
├── contracts/                 # 模块行为契约（输入、输出、持久化和边界）
├── scenes/                    # 多轮真实链路场景
├── cli.ts                     # 命令行参数解析（--module/--scene/--repeat/--strict 等）
├── contract-checker.ts        # 契约断言和覆盖检查
├── dataset.ts                 # 数据集版本与场景/契约校验
├── live-test-main.ts          # Tauri WebView 内的真实 Live Test 入口
├── reporter.ts                # 控制台/JSON 测试报告
├── scene-runner.ts            # 场景执行与步骤编排
├── standard-setup.ts          # 标准配置和运行时状态隔离
├── types.ts                   # 框架核心类型定义
├── SKILL.md                   # Contract 分析、Scene 生成与覆盖审查工作流
└── README.md                  # Live Test 使用说明
```

测试分为两层：Contract 描述单模块的可验证行为，Scene 描述 Agent Loop、工具、安全、人格、变量和记忆之间的真实调用链。Contract 的 `scenarios` 必须解析到已发现、同模块且同 `contractId` 的 Scene；边界和错误规则只统计带 `boundary`/`error` tag 的实际场景。Scene 具有稳定 `caseId` 和 `regression`/`capability`/`safety`/`stress` 套件归属；`entry: "production"` 必须经过 `sendMessage()`。Live Test 在独立 Tauri WebView 中调用真实 Provider 和 Rust IPC，使用临时数据根和 `deskpet_live_test_*` 浏览器缓存 keyspace；每个 trial 都重置测试状态而不删除正常用户缓存，`meta.repetitions` 是最低试验次数。JSON 报告记录数据集版本、环境种子、轨迹指标、错误分类与 `pass@k`/`pass^k`；因此需要本地开发配置和可用的 API，不能把没有 Provider 的静态检查结果当作运行时通过。

- 代码或数据契约变更后，按 `live/SKILL.md` 的 analyze → generate 工作流重新分析源码生成覆盖契约，再补充对应场景；这三个触发词是 AI 工作流约定，不是 shell 命令。
- 使用 `pnpm test -- --module <module>` 做模块范围验证；跨模块修改再运行完整 `pnpm test`。发布前运行 `pnpm test -- --strict --repeat 3 --report json`，严格 Contract 缺口和不稳定 trial 不能作为通过结论。
- `npx vue-tsc --noEmit` 和 `cargo check` 只证明类型/编译，不替代 Live Test。
- Contract 的 `sourceHash` 不能为空；启动前发现空 hash 或源码变更会直接阻断 Live Test。

## 文档职责

- `docs/DES.md`：项目总览、概述、玩法、交互和整体机制，面向项目负责人阅读。
- `docs/current/`：根据当前代码核对过的模块契约和现状。
- `docs/plans/active/`：尚未实施的方案；完成后移入历史目录。
- `docs/history/`：阶段设计、实施计划、修复记录和分析报告，只保存当时细节，不作为当前契约。
- `README.md`：安装、运行、能力概览和文档入口。

不使用内部版本号描述当前实现。发布版本以 GitHub tag 为准。

### 规则文件本身

- 本文件是**唯一的规则来源**。`CLAUDE.md` 只有一行 `@AGENTS.md` **导入指令** ——
  Claude Code 只读 `CLAUDE.md`，不读 `AGENTS.md`，靠这行 import 把本文件注入上下文。
- ⚠️ 不要把 `@AGENTS.md` 改成 Markdown 链接：链接形式**不会加载**，只等于建议 agent 自己去读。
  也不要把本文件内容复制进 `CLAUDE.md`，那会制造两份需要同步的规则。
- **不建立子目录 AGENTS.md**。本文件的规则（配置 SSOT、路径、日志、异常、模块落位）都是
  **跨模块横向生效**的，按模块拆开只会得到 N 份需要同步的副本 —— 正是本节要防的漂移。
  触发拆分的条件是：某模块有 ≥15 行只属于它且与全局无关的约定，
  或本文件涨到 800 行 / 12k token，或某模块需要**局部覆盖**全局规则（后者应先修全局）。
  模块特有的细节优先写进**模块自身的代码注释或 barrel 头部**，而不是新建规则文件。

## 项目结构

```text
src/
├── main.ts                     # 主窗口入口
├── settings-main.ts            # 设置窗口入口
├── layer-editor-main.ts        # 图层编辑窗口入口
├── App.vue                     # 主窗口根组件
├── vite-env.d.ts               # Vite 环境与 *.vue / *.yaml 模块声明
├── components/                 # Vue 界面、角色展示、聊天、设置、会话
│   └── winsim/                 # WinSim 开机模拟（BIOS、Logo、登录、桌面）
├── composables/                # useParallax、useLayerEditor 组合式逻辑
├── services/
│   ├── engine/                 # Pi Runtime、输入预处理、Plan、Slash、会话状态与上下文压缩工具
│   ├── personality/            # Card、人格注册、阶段文案、变量状态、情绪映射
│   ├── reply/                  # RUNTIME_DATA 解析与回复后处理
│   ├── agent/                  # Provider、Runner、子代理、记忆与主动搭话
│   ├── context/                # System Prompt 构建
│   ├── tool/                   # 工具注册、路由、Pi 基础工具、MCP
│   ├── skill/                  # Skill 加载与 Prompt 注入（Pi 渐进披露，非工具）
│   ├── safety/                 # 风险等级、策略和确认桥接
│   ├── session/                # 会话响应式状态与切换归档
│   ├── profile/                # Profile 选择、加载、导入导出
│   ├── window/                 # 前台窗口监控与主动搭话
│   ├── audio/                  # 音效注册与播放
│   ├── dialog/                 # 通用提示 Dialog（服务层单例 + 确认模式）
│   ├── error/                  # 异常体系（归一化、全局拦截、DOM 覆盖层）
│   ├── logger/                 # 统一日志（级别、批量转发、落盘）
│   ├── animation.ts            # 从 Profile 加载的动画系统
│   ├── boot.ts                 # 窗口启动引导（4 个入口共用）
│   ├── command-handler.ts      # 聊天命令与表情切换（待接入）
│   ├── cooldown.ts             # 统一全局冷却控制器
│   ├── config.ts               # YAML 运行时配置与类型化 getter
│   ├── debug.ts                # token 消耗、上下文利用率与工具注册数追踪
│   ├── env.ts                  # 平台检测与运行时环境
│   ├── init.ts                 # 统一启动初始化
│   └── paths.ts                # 前端 BaseDirs 与统一路径初始化
└── styles/                     # 全局样式与字体

src-tauri/src/
├── main.rs                     # 入口
├── lib.rs                      # AppPaths、命令注册和应用启动
├── paths.rs                    # data_root、内置资源和路径校验
├── logger.rs                   # 日志内核（级别过滤、本地时间戳、文件 sink）
├── error.rs                    # 统一错误类型 AppError
├── commands/                   # 窗口、文件、工具、记忆、Profile 等命令
├── macros/                     # Rust 端日志宏
├── monitor/                    # Windows/macOS 前台窗口监控
└── window/                     # 主窗口和设置窗口
```

## 当前核心数据流

```text
用户输入
  -> agent/runner + engine/preprocessor
  -> session 状态、Card 变量刷新、重置策略
  -> context/buildPrompt
       Card 角色 / 语气指引 / 必须遵守 / 变量 / 记忆 / 工具
  -> 助手模式下可选 planner
  -> Pi Agent Core + pi-ai 流 + ToolRouter（read/write/edit/bash/…）+ Safety 检查
       Skill 只注入 name/description/location，正文由模型用 read 工具按需加载
  -> reply/generator 解析 <RUNTIME_DATA>
       emotion -> 表情与音效
       合法 card 变量 -> batchWriteVars -> savePoolToDisk
  -> MemoryService 记录会话和必要的压缩摘要
  -> Vue 展示最终文本与效果
```

`RUNTIME_DATA` 是内部元数据，不显示给用户。回复生成器负责解析、剥离、验证和持久化；不要把这些工作重新塞回 Agent Loop。

## 人格与变量状态

人格 Card 和用户长期记忆是不同模块。

- `system`：运行时计算，只读。
- `card`：Card 注册的角色长期状态，只有 `updateBy=llm` 的变量可由 RUNTIME_DATA 更新。
- `interaction`：系统维护的互动状态，只读给模型。
- `session`：会话状态，只读注入 Prompt，不进入人格 Card 持久化。

运行时和 `personality/stages/{cardId}.json` 使用同一种 `VariableState` 格式：

```typescript
interface VariableState {
  value: number | string | boolean
  type: "number" | "string" | "boolean"
  updatedAt: number
  updatedBy: "llm" | "manual" | "system"
  lastResetAt?: number
}
```

规则：

- `card` 和 `interaction` 必须存 `VariableState`，禁止退回原始值。
- `system` 和 `session` 使用原始值，不附加 Card 状态元数据。
- Card 变量必须来自 `card.sections.variableDefs` 注册表。
- `batchWriteVars()` 拒绝未注册、不可写、类型错误或越界的变量。
- Card 的 `whenText` 是自然语言语气指引，不是可执行 When DSL。
- 主回复链路不使用旧变量工具链，变量更新统一走 RUNTIME_DATA；旧接口只在历史归档中保留，不作为当前契约。

## 记忆边界

- `CANDY.md`：用户手写的系统指令。
- `User.md`：重要用户事实的系统文件视图。
- `Outside.md`：外部知识指针。
- `MEMORY.md`：长期记忆注册表。
- `sessions/*.md`：会话正文和压缩摘要的唯一真相源。
- `sessions/index.json`：仅保存打开标签、活跃标签和未回复数等可丢弃 UI 状态。
- `Project.md`：会话归档索引。

当前长期记忆的自动提取和 Prompt 检索尚未闭环。不要在代码或文档中声称 `MemoryService.search()` 已经自动注入，或声称 `forkMemorySupplement()` 已经由每轮对话调用。

## 单一真相源（SSOT）

项目高发的四类问题 —— **配置乱飞、魔法值、改动不同步、架构散落** —— 根因相同：
*同一件事存在多个定义点*。动手改任何「会被多处使用」的东西前，过一遍下面四张清单。

### ① 配置不散落

一份配置从定义到生效要经过 5 个位置，**漏掉任何一处都不报错，只是静默失效**：

| # | 位置 | 漏掉会怎样 |
|---|---|---|
| 1 | `CONFIG.yaml` | 生产首次启动没有该字段 |
| 2 | `CONFIG-DEV.yaml.example` + `CONFIG-DEV.yaml` | 开发环境拿不到 |
| 3 | `src/services/config.ts` 的 `Config` 类型 + 类型化 getter | TS 无类型、读不到 |
| 4 | `SettingsPanel.vue` 的 `setOverrides` 映射 + 对应 Tab 的 ref/expose | 设置页存了也不生效 |
| 5 | 本节与 `README.md` | 下一个人不知道它存在 |

- 读取一律走 `@/services/config` 的 getter。模块内不得直读 `cfg.general.xxx`、不得复制常量、不得硬编码默认值。
- **同一字段不得有两个语义**。一个值若既要被设置页读写、又要参与运行期判断，拆成两个导出。
  范例：`generalConfig.loggingLevel`（读写接口）vs `computeLogLevel()`（运行期生效值）——
  在**前者**上做 dev/prod 分支，会让 dev 里保存设置时把 `debug` 静默写回 YAML。

### ② 不写魔法值

- 会被 ≥2 处引用的字面量（阈值、超时、路径片段、命令名、枚举值）**必须是配置项或模块常量**。
- 只在单个函数体内出现一次的字面量可以内联 —— 不为 DRY 抽无复用价值的常量。
- 判定标准：**「改这个值的人会去哪找它？」** 答案不唯一，就该抽出来。
- 常量放**它所属的模块**，不建集中式 `constants.ts`。

### ③ 改动必须全链路同步

动手前先 `rg` 找出全部消费者。`pnpm run test:types` 只抓得住类型与编译，**下面这些它抓不住**：

| 你改了什么 | 必须同时检查 | test:types 能抓吗 |
|---|---|---|
| Rust 命令签名/返回类型 | 前端 `invoke` 调用点、`commands/mod.rs` 的 `pub use`、`lib.rs` 的 `invoke_handler!` | 部分 |
| 前端 `invoke` 的命令名 | Rust 侧 `#[tauri::command]` 函数名 | ❌ 运行期才报 "command not found" |
| 文件/模块移动改名 | 所有 import、`vite.config.ts` 的 `rollupOptions.input`、`capabilities/*.json` 的 `windows` 数组 | 部分 |
| 新增窗口 | 上一条 + `xxx.html` + `src/xxx-main.ts` + Rust 创建代码 + z-order 提层 | ❌ |
| 删除文件 | 全仓 `rg` 确认零引用，再同步结构树与文档 | 仅 import 层面 |

### ④ 架构不散落

- 新模块放进 `src/services/<领域>/`，**必须带 `index.ts` barrel**
  （现有 13 个服务子目录无一例外，`__tests__/` 不计）。外部只从 barrel 导入，不深入内部文件路径。
- 跨领域共享的纯函数放**零依赖叶子模块**，避免循环依赖。
  范例：`services/error/format.ts` 不 import 任何业务模块，所以 `logger` 引用它不会成环。
- 单一文件的服务平铺为 `src/services/<name>.ts`；成组（≥3 文件或有内部结构）时升级为目录。
- 新增或移动文件后，同步本文件的结构树。

## 配置规则

用哪份配置由**构建模式**决定（Rust `cfg!(debug_assertions)`），不由配置文件里的字段控制：

```text
开发（cargo tauri dev）：工作区 CONFIG-DEV.yaml（存在时）或 CONFIG.yaml
生产（cargo tauri build）：data_root/settings/CONFIG.yaml（首次由内置 CONFIG.yaml 初始化）
  -> services/config.ts 类型化 getter
  -> 设置页回写同一份运行时 CONFIG
```

- 生产构建完全忽略工作区的 `CONFIG-DEV.yaml`；该文件在 `.gitignore` 中，首次使用需 `cp CONFIG-DEV.yaml.example CONFIG-DEV.yaml`。
- 所有模块通过 `@/services/config` 读取配置，不在模块内复制常量。
- 开发环境本地调参只改 `CONFIG-DEV.yaml`；它必须是完整配置文件，不是增量覆盖层。
- 设置页回写经 `serializeConfig()` 保留运行时 CONFIG 的文件头部注释块，正文由 `js-yaml` dump 重排。
- `localStorage` 不保存配置、会话正文或 Profile 编辑状态；启动时会清理历史缓存 key。
- 新增配置项必须同步默认配置、开发配置、配置类型 getter、设置页面和相关说明。
- 不主动修改 `.gitignore`、真实配置或用户运行时数据，除非用户明确要求。

## 路径与运行时数据

```text
开发：{project}/data/desk-pet/
生产：Tauri app_local_data_dir（平台和应用标识专属）

data_root/
├── settings/     CONFIG.yaml（仅生产；开发配置留在工作区）
├── memory/       MEMORY.md、CANDY.md、User.md、Outside.md、Project.md
├── sessions/     session-YYYYMMDD-HHmmss-主题.md、index.json
├── personality/ stages/{cardId}.json、vars.json、用户 Card
└── profiles/     用户 Profile 与素材
```

内置 Card/Profile 只读，运行时数据只写入 `data_root`。当前内置 Profile 包括 `sugar-pink`、`dark-purple`、`glass` 和 `yuki`。

### 路径拼接规则

**模块内不得出现任何硬编码路径**（含 `"personality/xxx"` 这类带域前缀的相对路径）。路径一律由路径模块产出：

| 层 | 用什么 | 说明 |
|---|---|---|
| Rust | `AppPaths` 的字段（`paths.personality` 等） | 唯一真相源；`data_root` 由 `cfg!(debug_assertions)` 裁定 |
| TS | `runtimePath(scope, ...segments)` | 交给 Rust 拼接 + 校验，返回绝对路径 |
| TS | `BaseDirs` | **只给目录**；写文件必须走 `runtimePath()` |

- 需要区分 dev/生产时用 `getRuntimeMode()`，**不要**自己判断 `import.meta.env.DEV` ——
  前者是**路径环境**（Rust `cfg!(debug_assertions)` 裁定），后者是**前端构建模式**，两者概念不同。
- 业务文件名由**所属模块**管理（如 memory 模块管 `MEMORY.md`），不集中堆进 `paths.ts`。
- **两种合法模式，按命令设计选**：
  1. **Rust 持有 base 目录**（如 `personality_file_*`）→ 前端只传**域内相对路径**
     （`stages/x.json`、`vars.json`），**绝不带 `personality/` 前缀**。
     Rust 侧 `resolve_personality_path()` 会显式拒绝带前缀的入参（容忍它会让写入静默建错嵌套目录）。
  2. **前端需要绝对路径**（展示、传给通用文件 API）→ 用 `runtimePath(scope, ...segments)`。
- 日志里的**描述性路径**（如 `` `personality/stages/${id}.json` ``）不算违规 —— 它不参与行为决策，
  只是给人看的 `data_root` 相对位置。改动目录布局时一并更新即可。

### Rust 约束

```rust
use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn my_command(paths: tauri::State<AppPaths>) -> AppResult<()> {
    AppPaths::validate_path(&file_path, &paths.personality)?;
    Ok(())
}
```

- 路径相关命令必须注入 `tauri::State<AppPaths>`。
- 写入前必须使用 `validate_path()`；不存在的文件要校验父目录。
- 命令一律返回 `AppResult<T>`，不要退回 `Result<T, String>`（见「异常处理」）。
- 禁止手写 `dirs_next()`、`find_project_root()` 或 `env!("CARGO_MANIFEST_DIR")` 解析业务路径。
- 禁止使用 `canonicalize().unwrap_or()` 静默回退。
- 禁止 `.lock().unwrap()`；用 `.unwrap_or_else(|e| e.into_inner())` 忽略锁中毒。
- 内置 Profile/Card 是只读打包资源；设置页必须提示先“复制为用户 Profile”，复制后的完整资源与导入 Profile 都写入运行时 `profiles/{id}/`，写操作只走该目录。
- 新命令必须在 `lib.rs` 的 `invoke_handler!` 中注册。
- Windows/macOS 专有代码必须使用条件编译和对应平台依赖。

### TypeScript 约束

```typescript
import { initPaths, runtimePath } from "@/services/paths"

await initPaths()
const memoryPath = await runtimePath("memory", "MEMORY.md")
```

`BaseDirs` 只提供目录；需要得到完整路径时调用 `runtimePath()` 交给 Rust 校验和拼接。业务文件名由所属模块管理，不把业务文件名集中硬编码进 `paths.ts`。

## 编码约定

- 先读后写，优先复用已有代码，不为简单逻辑增加抽象。
- 所有操作同时评估 Windows 和 macOS。
- Vue 组件使用 `<script setup lang="ts">`。
- 服务模块一律从 barrel 导入（`@/services/<领域>`），不深入内部文件路径；落位规则见「单一真相源 ④」。
- 全局冷却和 AI 并发锁走现有模块，平台检测走 `@/services/env`。
- 配置走 `@/services/config`（见「单一真相源 ①」）。
- 日志走 `@/services/logger`，异常走 `@/services/error`，禁止直接 `console.*` / `String(e)`。

## 日志

日志同时输出到三处：`pnpm tauri dev` 的终端、`{data_root}/logs/deskpet.log`（超 5MB 轮转，保留 2 份备份）、DevTools Console。

```typescript
import { createLogger } from "@/services/logger"
const log = createLogger("模块前缀")
log.debug("调试信息")
log.info("重要节点")
log.warn("警告")
log.error("错误", error)   // error 不受级别限制
```

Rust 对应 `rust_debug!` / `rust_info!` / `rust_warn!` / `rust_error!`。两端格式统一为
`[HH:MM:SS.mmm] LEVEL [前缀] 消息`，时间戳**同为本地时间**，混在终端与日志文件里可直接对时序。
前端日志经 60ms/32 行批量转发到 Rust，与 Rust 日志汇合进同一个文件。

级别策略（`config.ts` 的 `computeLogLevel()`）：

```text
VITE_LOG_LEVEL 显式覆写  >  dev 一律 debug（忽略配置）  >  生产读 general.logging.level
```

`VITE_LOG_LEVEL` 经项目根的 `.env` 设置（模板见 `.env.example`，`.env` 不入库）。
临时验证可直接 `VITE_LOG_LEVEL=info pnpm tauri dev` —— 这是 dev 下唯一能观察生产过滤行为的手段。

Rust 侧默认值随构建模式：debug 构建全量、release 默认 info；`DESKPET_LOG_LEVEL` 环境变量可覆写。
前端启动后经 `set_log_config` 推送生效级别，两端保持一致。

⚠️ 区分 `generalConfig.loggingLevel`（设置面板的**读写接口**，会回写 YAML）与 `computeLogLevel()`
（**运行期生效值**）。不要在**前者**上做 dev/prod 分支，否则 dev 里保存设置会把 `level: debug`
静默写进 `CONFIG-DEV.yaml`。

## 异常处理

- 全局拦截在 `services/error/global.ts`，4 个窗口入口经 `services/boot.ts` 的 `bootWindow()`
  统一安装，覆盖 `window.onerror`、`unhandledrejection`、Vue `errorHandler` 和 bootstrap 失败。
- 异常走 `reportError()` 单一出口：写日志 → `invoke("report_frontend_error")` 落到 Rust →
  按配置弹全屏 DOM 覆盖层。覆盖层**零 Vue 依赖**，所以在 `mount()` 之前、`initConfig()`
  失败时同样有效（这正是它要覆盖的首要场景）。
- 覆盖层行为由 `general.errors.overlay` 控制：`auto`（默认，dev 弹 / 生产不弹）、
  `always`、`never`。判定在**报错时惰性求值** —— 拦截器必须早于 `initConfig()` 安装，
  那时还读不到配置。
- 判断错误一律用 `@/services/error` 的 `formatError()` / `errorCode()` / `summarizeError()`，
  不要写 `e instanceof Error ? e.message : String(e)` —— Rust 命令返回 `{ code, message }`
  结构化错误，裸 `String(e)` 会退化成 `[object Object]`。
- 会持久化进会话文件的消息必须用 `summarizeError()`（已脱敏，掩掉 `sk-*` 等密钥）。
- Rust 命令统一返回 `AppResult<T>`（`src-tauri/src/error.rs`），错误序列化为 `{ code, message }`。
  新代码用具体的 `AppError::Xxx` 变体，`err(...)` 只作迁移期兜底。
- Rust panic 已接 `std::panic::set_hook`，会带位置写入日志文件。


## 修改后的同步规则

| 改动类型 | 需要同步 |
|---|---|
| 普通代码修改 | `README.md`、`AGENTS.md`、`docs/DES.md`，按影响补充 `docs/current/` |
| 架构或模块变更 | `README.md`、`AGENTS.md`、`docs/DES.md`、对应当前模块文档 |
| 配置项变更 | 按「单一真相源 ①」的五处清单 |
| 新增或删除模块 | AGENTS 结构、README 结构、DES 总览和当前模块文档 |
| 实施计划完成 | 保留正文，补充状态元数据后移入 `docs/history/` |

历史文档只保存当时的设计细节，不为了追踪当前代码而改写正文。
每轮修改结束都要同步 `README.md`、`AGENTS.md`、`docs/DES.md`；有影响时同步 `docs/current/`。

## 提交规范

使用 **Conventional Commits**：

```text
<type>(<scope>): <描述>

[可选正文：说明「为什么」，不是复述 diff]
```

**type**（必填）：`feat` 新功能 / `fix` 修 bug / `refactor` 重构 / `perf` 性能 /
`docs` 只改文档 / `test` 只改测试 / `build` 构建与依赖 / `chore` 杂项 / `revert` 回滚。

**scope**（建议填）：取**模块名**，与结构树保持一致，便于检索——
`config`、`paths`、`log`、`error`、`agent`、`tool`、`memory`、`personality`、`profile`、
`session`、`reply`、`safety`、`window`、`ui`、`livetest`、`tauri`、`deps`、`docs`。
跨模块改动可省略 scope。

规则：

- 描述用**中文**、不加句号、不以大写开头，说清**做了什么**而不是改了哪个文件。
- 破坏性变更在 type 后加 `!`（如 `feat(config)!: ...`），并在正文写 `BREAKING CHANGE: 具体影响`。
- **一次提交只做一件事**；顺手带的格式化、重命名、无关修复拆成独立提交。
- 正文只在需要解释**动机或取舍**时写，用 `-` 列表。

```text
feat(profile): 内置 Profile 改为只读，新增复制为用户 Profile

- 内置 ID 在命令层拒绝写入与删除
- 复制时打包完整资源到 data_root/profiles/{id}

fix(paths): personality 命令拒绝带域前缀的入参

容忍 "personality/xxx" 会拼成 personality/personality/xxx，写入时静默建出错误的嵌套目录。

refactor(log): 时间戳由 UTC 改为本地时间
docs: 补充路径拼接规则
chore(deps): 引入 chrono 与 thiserror
```

## 用户规则

- 任何修改必须先给思路，用户同意后才能编码。
- 不自作主张扩大范围，疑问先探索代码并基于事实判断。

## 核心方针

轻量化、低内存占用、高性能、token 消耗少、功能完整。
