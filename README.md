# 🍬 糖糖桌宠 (Desk Pet)

> 像素风桌面虚拟主播助手：常驻桌面，能聊天、能用工具、能看你窗口、能主动搭话。
>
> Card 负责角色表达，Profile 负责外观呈现，会话和运行时数据独立持久化。

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/Klavte/Desk-Pet)
[![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4fc08d)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-🦀-dea584)](https://www.rust-lang.org)

---

## ✨ 功能

- **桌面常驻** — 无边框透明窗口，角色在所有桌面和全屏 Space 悬浮
- **AI 聊天** — Card 驱动人格，兼容 OpenAI、DeepSeek、Ollama 等 OpenAI 兼容接口
- **会话管理** — 多会话切换、新建、关闭、归档、恢复和会话文件持久化
- **会话运行槽与队列化入口** — 聊天消息先将 queued 事实事件原子写入 sessions，再进入 Pi；Agent、运行阶段、上下文和异步写回均绑定 sessionId；steer/followUp 在 Agent 消费结束后才进入 accepted/done，结构化失败不会因存在兜底文案而记为成功
- **可恢复 Plan** — 助手模式的 Plan、step、子代理工具开始/结束均写入 session checkpoint；重启后只读步骤可回到 pending，缺少完成凭证的外部副作用进入 unknown_side_effect
- **分层上下文** — ContextKernel 固定 `static → dynamic → profile → memory → transcript → ephemeral` 顺序，并记录预算裁剪原因
- **Prompt 审计** — Runtime 在上下文变换和 Provider payload 两个阶段保存脱敏 Prompt 快照，并以请求、回合和运行代际关联
- **工具系统** — 文件读写、Bash、系统信息、剪贴板、子代理、Skill、MCP（联网能力由 MCP 服务器提供）
- **助手模式** — 解锁更完整的文件、命令、应用、剪贴板和任务编排能力，并经过安全策略控制
- **Pi Agent Core** — 统一管理模型请求、顺序工具循环、超时和可选的复杂任务计划；产品状态仍由 Desk-Pet 管理
- **人格系统** — Card 热切换，支持 neutral、angelkawaii、ame、pchan 和用户导入 Card
- **Card 运行时状态** — 通过回复末尾的 `RUNTIME_DATA` 更新已注册的角色变量
- **窗口感知** — 监控前台窗口，停留超时后 AI 主动搭话
- **安全控制** — SAFE / NORMAL / DANGER / NOWAY 风险等级与确认策略；动态风险等级先于会话信任解析（deny-first）；会话信任的粒度是「工具 + 本次参数」，确认过的参数才免重复询问；文件工具另有路径分级，私钥与凭据类路径直接 NOWAY
- **Bash 硬基线** — Rust 侧两层 token 策略：层 1 硬基线（破坏性目标、`-delete`/`-exec` 类参数、系统路径重定向）在任何模式下都执行且调用方无法关闭，层 2 才按模式叠加白名单或扩展命令规则
- **工具门禁与审计** — 工具前后置门禁走 Pi 原生 `beforeToolCall` / `afterToolCall`；每次工具调用记录 operationId、policyHash 与取消/超时的稳定错误码
- **记忆系统** — CANDY、User、MEMORY、sessions 和压缩摘要；正文只写一份会话记录，压缩由 LLM 生成结构化摘要写回会话文件；User.md 以只读画像 projection 注入，长期记忆 provider 当前为空，自动提取与召回仍在规划
- **Profile 主题** — 糖糖粉、暗夜紫、透明玻璃、yuki 雨夜蓝等随应用提供的默认主题，支持编辑、复制、删除、导入导出
- **角色展示效果** — 灵动图层（五层视差）与景深（单图背景虚化 + 焦点区）二选一，都由图层编辑器所见即所得地调参
- **音效系统** — Web Audio 合成音效与人格边界映射
- **设置面板** — 独立窗口配置 AI、外观、人格、监控、安全、工具、MCP、Skill 和快捷键
- **系统托盘** — 关闭后隐藏到托盘，单击恢复；Dock/任务栏点击可弹出
- **Windows 模拟器** — 彩蛋：像素风 Win7 桌面（输入 `open win`）

---

## 🔄 双模式

| 能力 | 轻量模式 | 助手模式 |
|------|:---:|:---:|
| AI 聊天 + 人格系统 | ✅ | ✅ |
| Card 状态与 RUNTIME_DATA 处理 | ✅ | ✅ |
| 窗口感知主动搭话 | ✅ | ✅ |
| 文件读写 + 系统信息 + Bash 白名单 | ✅ | ✅ |
| 计划编排与步骤进度 | ❌ | ✅ |
| 文件写/编辑 + Bash（硬基线常开，白名单/扩展命令按风险确认） | ✅（确认） | ✅（按安全策略） |
| 文件删除 | ❌（无模型工具） | ❌（硬禁止） |
| MCP 服务器 | ❌ | ✅ |
| Skill（渐进披露，模型用 read 加载正文） | ❌ | ✅ |
| 子代理 agent.spawn（fork/team） | ❌ | ✅ |
| 安全确认策略 | SAFE/NORMAL 自动；写入和扩展 Bash 可确认 | 四级风险 + 三策略 + 按调用粒度的会话信任 |

---

## 🚀 快速开始

### 前置

- Node.js ≥ 18 + pnpm 11（具体版本由 `package.json` 的 `packageManager` 字段裁定）
- Rust toolchain
- macOS：Xcode Command Line Tools

### 安装

```bash
git clone https://github.com/Klavte/Desk-Pet.git
cd Desk-Pet
pnpm install
pnpm tauri dev
```

仅启动前端开发服务：

```bash
pnpm dev
```

### 配置

```bash
cp CONFIG-DEV.yaml.example CONFIG-DEV.yaml
# 编辑 CONFIG-DEV.yaml，填入 API Key
```

开发构建直接使用工作区的完整 `CONFIG-DEV.yaml`；文件不存在时使用 `CONFIG.yaml`。生产构建首次启动会把默认 `CONFIG.yaml` 写入应用数据目录的 `settings/CONFIG.yaml`，之后设置页和导入导出都回写该文件。macOS 窗口监控需要在系统设置的“隐私与安全性 → 辅助功能”中允许终端或 Tauri。

默认 Profile 随安装包作为首次初始化种子发布；首次启动复制到运行时 `profiles/` 目录后，
与用户导入的 Profile 一样可编辑、复制、删除和导出。灵动图层与景深各自的素材和参数保存在
各自 Profile 的 `profile.yaml`，CONFIG 只保存效果模式与全局强度。运行时数据路径和会话恢复规则见
[运行时数据](docs/current/runtime-data.md)。

---

## 🏗 架构

```text
Desk-Pet/
├── CONFIG.yaml / CONFIG-DEV.yaml     # 全局配置
├── .github/workflows/ci.yml          # CI：macOS + Windows 双平台 test:types
├── AGENTS.md                         # Agent 开发约束
├── CLAUDE.md                         # 兼容入口，规则指向 AGENTS.md
├── docs/
│   ├── DES.md                        # 项目总览、玩法和整体机制
│   ├── current/                      # 当前实现说明
│   ├── plans/active/                 # 待实施计划
│   └── history/                      # 历史设计、计划、分析和原始文档
├── src/                              # Vue 3 + TypeScript 前端
│   ├── App.vue                       # 根组件
│   ├── components/                   # 聊天、角色、设置、会话和窗口 UI
│   ├── composables/                  # 视差与编辑器状态
│   └── services/
│       ├── engine/                   # Pi Runtime、输入预处理、Plan、Slash、会话状态和压缩工具
│       │   └── runtime/              # 运行时协议类型、PromptSnapshot 与脱敏 hash
│       ├── personality/              # Card、阶段文案、变量状态、情绪映射
│       ├── reply/                    # RUNTIME_DATA 解析与回复后处理
│       ├── agent/                    # Provider、Runner、子代理、Memory、Active
│       ├── tool/                     # 工具注册、路由、MCP
│       ├── skill/                    # Skill 加载与 Prompt 注入
│       ├── safety/                   # 风险检查与确认
│       ├── session/                  # 多会话持久化管理
│       ├── profile/                  # Profile 主题与导入导出
│       ├── audio/                    # Web Audio 音效
│       ├── context/                  # ContextKernel 分层、预算与兼容 Prompt 构建
│       └── paths.ts                  # 统一路径管理
├── src-tauri/                        # Rust 后端
│   └── src/
│       ├── lib.rs                    # 应用入口和命令注册
│       ├── paths.rs                  # AppPaths 路径管理与校验
│       ├── window/                   # 主窗口与设置窗口
│       ├── monitor/                  # 前台窗口监控
│       └── commands/                 # 文件、记忆、Profile、系统命令
├── src-tauri/resources/defaults/     # 首次启动复制的种子：profiles / personality/cards / skills
└── data/desk-pet/                    # 开发环境运行时数据（生产使用应用专属目录）
```

---

## 📐 核心数据流

```text
用户消息
  → PreProcessor / Session 状态
  → refreshVariablePool() + reset 策略
  → ContextKernel 六层组装与预算裁剪（兼容 buildPrompt）
  → 助手模式可选 Plan：复杂度检测 → 拆解 → 步骤执行
  → Pi Agent Core + pi-ai Provider/Models 工厂 + ToolRouter 工具循环
  → Safety 检查与确认
  → generateReply(raw, card)
       ├─ 解析并移除 <RUNTIME_DATA>
       ├─ emotion → expression / sound
       ├─ 合法 Card 变量 → batchWriteVars → savePoolToDisk
       └─ trim / 截断 → ReplyResult
  → 通过 session_file_write_atomic 原子写入 sessions/*.md（完整正文）与上下文摘要；sessions/index.json 仅保存 UI 状态
  → ChatPanel / StreamView 展示
```

`RUNTIME_DATA` 是内部元数据，不显示给用户。主链路和 Planner 都不依赖旧的变量工具或情绪前缀；旧接口仅保留在历史归档中。

---

## 🎛 设置面板

独立窗口，标题栏按钮打开：

| 类别 | 配置项 |
|------|--------|
| 外观 | Profile、预设、颜色、字体、角色展示效果（灵动图层/景深）、导入导出 |
| AI | Provider、端点、密钥、模型、上下文、思考强度、Plan |
| 人格 | Card 选择、变量状态查看、阶段文案 |
| 监控 | 开关、停留秒数、防抖、冷却 |
| 安全 | 风险模式、确认策略 |
| 弹窗 | 位置、大小、自动弹出 |
| 快捷键 | 自定义组合键 |
| 工具 | Bash 白名单、文件写入开关 |
| MCP | 服务器增删改、JSON 导入导出 |
| Skill | 上传、启用、删除 Skill |
| 配置 | YAML 导入导出 |

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Tauri v2 |
| 前端 | Vue 3 + TypeScript + Vite |
| 后端 | Rust + Cargo |
| AI | Pi Agent Core + pi-ai OpenAI-compatible 接口（tool calls / reasoning effort） |
| 配置 | YAML（js-yaml + Rust 运行时配置文件） |
| 音效 | Web Audio API（OscillatorNode 合成） |
| 包管理 | pnpm（前端）+ Cargo（后端） |
| 测试 | Live Test（Contract + Scene + 真实 Provider） |

---

## 🧪 测试

```bash
pnpm test
pnpm test -- --module variable-pool
```

Live Test 位于 `src/services/__tests__/live/`，通过独立 Tauri WebView 使用真实 IPC、临时文件系统和真实 Provider 运行；需要确定性响应的基础场景可注入 `fake-provider.ts`，但仍执行真实 Agent/Tool loop。测试完成后自动清理临时数据。Scene 带稳定 `caseId`、测试套件和最低 trial 数，`--repeat 3` 只会提高试验次数；`--strict` 将实际 Scene 关联、边界/错误 tag 与 Contract 缺口作为门禁。Contract `sourceHash` 会在启动前校验，过期会直接阻断执行。JSON 报告记录数据集版本、环境种子、指标、错误分类和 `pass@k`/`pass^k`。测试通过只代表已覆盖场景通过。

Provider 请求统一由 Pi 的 `createProvider()` / `createModels()` 构造并执行；主回合和一次性文本请求共享认证、配置快照、增量响应上限与取消语义。Harness 关闭 SDK 内层重试，由回合层在同一个总 deadline 内决定是否重试。

### CI

`.github/workflows/ci.yml` 在 push、pull request 和手动触发时，于 `macos-latest` 与 `windows-latest` 各跑一次 `pnpm run test:types`（`vue-tsc --noEmit && cargo check`）；Live Test 需要真实 Provider，不在 CI 内执行。

pnpm 版本由 `package.json` 的 `packageManager` 字段裁定，CI 不单独指定。pnpm 11 的 `strictDepBuilds` 默认为 `true`：依赖若带构建脚本而没在 `pnpm-workspace.yaml` 的 `allowBuilds` 里显式声明 `true`/`false`，**全新** `pnpm install` 会以 `ERR_PNPM_IGNORED_BUILDS` 失败 —— 本地 `node_modules` 已存在时 install 会 `Already up to date` 直接跳过，这个错误只在干净安装时暴露。新增带 `postinstall`/`prepare` 的依赖时需要同步该字段。

目标平台是 Windows + macOS，但本机（macOS）永远看不到 `#[cfg(target_os = "windows")]` 分支，本机交叉 check 又会卡在 tauri-build 的 embed-resource（需要 `llvm-rc`）且不编译 deskpet 自身。因此 **Windows 分支的编译级验证只能靠 CI**，改动 `cfg(windows)` 代码或 Windows 依赖 feature 后必须看 Windows job 结果。

---

## 📋 平台兼容

| 功能 | macOS | Windows |
|------|:---:|:---:|
| AI 聊天 / Agent Loop / 工具调用 | ✅ | ✅ |
| 桌面悬浮（无边框透明置顶） | ✅ | ✅ |
| 窗口标题监控 + 主动搭话 | ✅ osascript | ✅ Win32 API |
| 全局快捷键召唤 | ✅ | ✅ |
| 系统托盘 | ✅ | ✅ |
| Dock/任务栏点击弹出 | ✅ | ✅ |
| 剪贴板操作 | ✅ pbpaste/pbcopy | ✅ PowerShell |
| 系统通知 | ❌ 未签名构建不支持 | 依赖平台配置 |
| 编译级验证（`test:types`） | ✅ 本机 + CI | ✅ 仅 CI |

---

## 📖 文档

- [项目总览与玩法](docs/DES.md)
- [当前系统设计](docs/current/system-design.md)
- [当前工具系统](docs/current/tool-system.md)
- [当前记忆系统](docs/current/memory.md)
- [记忆系统运行时契约](docs/plans/active/记忆系统运行时契约.md)
- [记忆系统重构执行手册（新会话接力入口）](docs/plans/active/记忆系统重构执行手册.md)
- [当前测试说明](docs/current/testing.md)
- [阶段现状（2026-08-06）](docs/history/analysis/阶段现状-2026.8.6.md)
- [完整文档索引](docs/INDEX.md)
- [开发约束](AGENTS.md)
- [Claude 兼容入口](CLAUDE.md)

历史设计、实施计划和阶段分析保存在 [docs/history/](docs/history/)，正文仅增加归档元数据，不作为当前实现契约。

---

## 📝 License

MIT
