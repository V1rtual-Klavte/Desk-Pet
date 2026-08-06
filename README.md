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
- **工具系统** — 文件读写/搜索、Bash、系统信息、HTTP、剪贴板、子代理、Skill、MCP
- **助手模式** — 解锁更完整的文件、命令、应用、剪贴板和任务编排能力，并经过安全策略控制
- **Agent Loop** — 模型请求、工具循环、上下文压缩和可选的复杂任务计划
- **人格系统** — Card 热切换，支持 neutral、angelkawaii、ame、pchan 和用户导入 Card
- **Card 运行时状态** — 通过回复末尾的 `RUNTIME_DATA` 更新已注册的角色变量
- **窗口感知** — 监控前台窗口，停留超时后 AI 主动搭话
- **安全控制** — SAFE / NORMAL / DANGER / NOWAY 风险等级与确认策略
- **记忆系统** — CANDY、User、MEMORY、sessions 和压缩摘要；长期记忆自动提取与召回仍在规划
- **Profile 主题** — 糖糖粉、暗夜紫、透明玻璃等内置预设，支持导入导出
- **灵动图层** — 五层景深视差、全局光标追踪、CSS 3D 增强和逐层设置
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
| 文件读/列/搜 + 系统信息 + Bash 白名单 + HTTP | ✅ | ✅ |
| 计划编排与步骤进度 | ❌ | ✅ |
| 文件写/删 + 全量 Bash + 打开应用 + 剪贴板 | ❌ | ✅ |
| MCP 服务器 | ❌ | ✅ |
| Skill 编排 | ❌ | ✅ |
| 子代理 agent.spawn（fork/team） | ❌ | ✅ |
| 安全确认策略 | 基础限制 | ✅ |

---

## 🚀 快速开始

### 前置

- Node.js ≥ 18 + pnpm
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

当 `CONFIG-DEV.yaml` 的 `enabled: true` 时，它会完全替换默认配置。macOS 窗口监控需要在系统设置的“隐私与安全性 → 辅助功能”中允许终端或 Tauri。

---

## 🏗 架构

```text
Desk-Pet/
├── CONFIG.yaml / CONFIG-DEV.yaml     # 全局配置
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
│       ├── engine/                   # 输入、Agent Loop、Plan、Slash、压缩
│       ├── personality/              # Card、阶段文案、变量状态、情绪映射
│       ├── reply/                    # RUNTIME_DATA 解析与回复后处理
│       ├── agent/                    # Provider、Runner、子代理、Memory、Active
│       ├── tool/                     # 工具注册、路由、Skill、MCP
│       ├── safety/                   # 风险检查与确认
│       ├── session/                  # 多会话持久化管理
│       ├── profile/                  # Profile 主题与导入导出
│       ├── audio/                    # Web Audio 音效
│       ├── context/                  # System Prompt 构建
│       └── paths.ts                  # 统一路径管理
├── src-tauri/                        # Rust 后端
│   └── src/
│       ├── lib.rs                    # 应用入口和命令注册
│       ├── paths.rs                  # AppPaths 路径管理与校验
│       ├── window/                   # 主窗口与设置窗口
│       ├── monitor/                  # 前台窗口监控
│       └── commands/                 # 文件、记忆、Profile、系统命令
├── skills/                           # 内置 Skill 定义
├── public/profiles/                  # 内置 Profile 素材
└── data/desk-pet/                    # 开发环境运行时数据
```

---

## 📐 核心数据流

```text
用户消息
  → PreProcessor / Session 状态
  → refreshVariablePool() + reset 策略
  → buildPrompt(Card / 语气 / 规则 / 变量 / 记忆 / 工具)
  → 助手模式可选 Plan：复杂度检测 → 拆解 → 步骤执行
  → OpenAI 兼容 Provider + ToolRouter 工具循环
  → Safety 检查与确认
  → generateReply(raw, card)
       ├─ 解析并移除 <RUNTIME_DATA>
       ├─ emotion → expression / sound
       ├─ 合法 Card 变量 → batchWriteVars → savePoolToDisk
       └─ trim / 截断 → ReplyResult
  → 写入 sessions/*.md 与上下文摘要
  → ChatPanel / StreamView 展示
```

`RUNTIME_DATA` 是内部元数据，不显示给用户。主链路和 Planner 都不依赖旧的变量工具或情绪前缀；旧接口仅保留在历史归档中。

---

## 🎛 设置面板

独立窗口，标题栏按钮打开：

| 类别 | 配置项 |
|------|--------|
| 外观 | Profile、预设、颜色、字体、灵动图层、导入导出 |
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
| AI | OpenAI 兼容接口（tool calls / reasoning effort） |
| 配置 | YAML（js-yaml，Vite 编译时转换） |
| 音效 | Web Audio API（OscillatorNode 合成） |
| 包管理 | pnpm（前端）+ Cargo（后端） |
| 测试 | Live Test（Contract + Scene + 真实 Provider） |

---

## 🧪 测试

```bash
pnpm test
pnpm test -- --module variable-pool
```

Live Test 位于 `src/services/__tests__/live/`。当前部分 Contract 的 `sourceHash` 为空，检查器会跳过源码变更过期保护；测试通过只代表已覆盖场景通过。

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

---

## 📖 文档

- [项目总览与玩法](docs/DES.md)
- [当前系统设计](docs/current/system-design.md)
- [当前记忆系统](docs/current/memory.md)
- [当前测试说明](docs/current/testing.md)
- [阶段现状（2026-08-06）](docs/history/analysis/阶段现状-2026.8.6.md)
- [完整文档索引](docs/INDEX.md)
- [开发约束](AGENTS.md)
- [Claude 兼容入口](CLAUDE.md)

历史设计、实施计划和阶段分析保存在 [docs/history/](docs/history/)，正文仅增加归档元数据，不作为当前实现契约。

---

## 📝 License

MIT
