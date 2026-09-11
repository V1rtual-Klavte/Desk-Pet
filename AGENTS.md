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

## 项目结构

```text
src/
├── main.ts                     # 主窗口入口
├── settings-main.ts            # 设置窗口入口
├── layer-editor-main.ts        # 图层编辑窗口入口
├── notification-main.ts        # 通知窗口入口
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
│   ├── tool/                   # 工具注册、路由、Pi 基础工具、Skill、MCP
│   ├── safety/                 # 风险等级、策略和确认桥接
│   ├── session/                # 会话响应式状态与切换归档
│   ├── profile/                # Profile 选择、加载、导入导出
│   ├── window/                 # 前台窗口监控与主动搭话
│   ├── audio/                  # 音效注册与播放
│   ├── animation.ts            # 从 Profile 加载的动画系统
│   ├── command-handler.ts      # 聊天文本中的表情切换与窗口命令
│   ├── cooldown.ts             # 统一全局冷却控制器
│   ├── config.ts               # YAML 运行时配置与类型化 getter
│   ├── debug.ts                # token 消耗、上下文利用率与工具注册数追踪
│   ├── env.ts                  # 平台检测与运行时环境
│   ├── init.ts                 # 统一启动初始化
│   ├── logger.ts               # 统一日志
│   └── paths.ts                # 前端 BaseDirs 与统一路径初始化
└── styles/                     # 全局样式与字体

src-tauri/src/
├── main.rs                     # 入口
├── lib.rs                      # AppPaths、命令注册和应用启动
├── paths.rs                    # data_root、内置资源和路径校验
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
  -> Pi Agent Core + pi-ai 流 + ToolRouter（read/write/edit/bash）+ Safety 检查
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

内置 Card/Profile 只读，运行时数据只写入 `data_root`。路径统一由 Rust `AppPaths` 和 TS `BaseDirs` 管理。

### Rust 约束

```rust
#[tauri::command]
pub fn my_command(paths: tauri::State<AppPaths>) -> Result<(), String> {
    AppPaths::validate_path(&file_path, &paths.personality)?;
    Ok(())
}
```

- 路径相关命令必须注入 `tauri::State<AppPaths>`。
- 写入前必须使用 `validate_path()`；不存在的文件要校验父目录。
- 禁止手写 `dirs_next()`、`find_project_root()` 或 `env!("CARGO_MANIFEST_DIR")` 解析业务路径。
- 禁止使用 `canonicalize().unwrap_or()` 静默回退。
- 内置 Profile/Card 是只读打包资源；Profile 素材读取可由同 ID 用户目录按相对路径覆盖，写操作只走运行时目录。
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
- 使用模块 barrel：`@/services/engine`、`personality`、`tool`、`agent`、`context`、`reply`。
- 全局冷却和 AI 并发锁走现有模块，平台检测走 `@/services/env`。
- 配置走 `@/services/config`。

## 日志

日志输出到运行 `pnpm tauri dev` 的终端，并保留 DevTools Console。

```typescript
import { createLogger } from "@/services/logger"
const log = createLogger("模块前缀")
log.debug("调试信息")
log.info("重要节点")
log.warn("警告")
log.error("错误", error)
```

Rust 使用现有日志宏。格式为 `[HH:MM:SS.mmm] LEVEL [前缀] 消息`，级别由配置控制。


## 修改后的同步规则

| 改动类型 | 需要同步 |
|---|---|
| 普通代码修改 | `README.md`、`AGENTS.md`、`docs/DES.md`，按影响补充 `docs/current/` |
| 架构或模块变更 | `README.md`、`AGENTS.md`、`docs/DES.md`、对应当前模块文档 |
| 配置项变更 | `CONFIG.yaml`、`CONFIG-DEV.yaml`、示例配置、设置页面、README 和相关文档 |
| 新增或删除模块 | AGENTS 结构、README 结构、DES 总览和当前模块文档 |
| 实施计划完成 | 保留正文，补充状态元数据后移入 `docs/history/` |

历史文档只保存当时的设计细节，不为了追踪当前代码而改写正文。

## 用户规则

- 任何修改必须先给思路，用户同意后才能编码。
- 不自作主张扩大范围，疑问先探索代码并基于事实判断。
- 配置项必须统一维护，不能只改某一个消费者。
- 每轮修改结束同步 `README.md`、`AGENTS.md`、`docs/DES.md`；有影响时同步当前文档。

## 核心方针

轻量化、低内存占用、高性能、token 消耗少、功能完整。
