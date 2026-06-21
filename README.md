# 🍬 糖糖桌宠 (Desk Pet)

> 像素风桌面虚拟主播 — 常驻桌面，能聊天、能用工具、能看你窗口、能主动搭话。
>
> ⚠️ **当前状态：v2.0 架构重构中**。Phase 1+2 已完成（人格中间件 + Agent Loop + 工具系统）。

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/Klavte/Desk-Pet)
[![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4fc08d)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-🦀-dea584)](https://www.rust-lang.org)

---

## ✨ 已有功能

- **桌面常驻** — 无边框透明窗口，角色在所有桌面/全屏 Space 悬浮
- **会话管理** — 多会话标签页，可切换/新建/关闭，拖动分割线调整面板宽度，自动归档，启动恢复
- **AI 聊天** — 人格卡驱动，兼容 OpenAI / DeepSeek / Ollama 等
- **工具系统** — AI 可调用工具（读文件/列目录/搜索/系统信息/Bash/HTTP），轻量模式6个基础工具
- **Agent Loop** — 多轮工具调用循环，思考强度自动调节 (auto/low/medium/high)
- **人格中间件** — 横切所有 Agent 阶段的角色化表达（表情/音效/角色话术）
- **窗口感知** — 监控前台窗口标题，停留一定时间后 AI 主动搭话
- **快捷键召唤** — 全局快捷键弹出/收回，缩放动画
- **人格系统** — 独立人格模块，支持热插拔切换/开关，在设置面板配置
- **人格进化** — 不理她太久会从甜蜜女友逐渐变成病娇（unansweredCount + boundary 系统）
- **安全控制** — 轻量模式统一安全入口（SAFE放行/NORMAL+拒绝），助手模式完整四级
- **记忆系统** — 文件注册表长期记忆 + 会话实时写入 sessions/ + LLM 整理 + Fork 补记忆
- **音效系统** — 29 个内置音效，Web Audio 合成无需外部文件
- **设置面板** — 独立窗口，AI / 监控 / 人格 / 模式 / 弹窗 / 快捷键 / 音效可配置
- **Windows 模拟器** — 彩蛋：像素风 Win7 桌面（输入 `open win` 触发）
- **系统托盘** — 关闭隐藏到托盘，单击恢复

---

## 🔄 双模式架构

| 能力 | 轻量模式 (默认) | 助手模式 |
|------|:---:|:---:|
| AI 聊天 + 人格系统 | ✅ | ✅ |
| 窗口感知主动搭话 | ✅ | ✅ |
| 读文件 (`file.read`) | ✅ | ✅ |
| 列目录 (`file.list`) | ✅ | ✅ |
| 搜索文件 (`file.search`) | ✅ | ✅ |
| 系统信息 (`system.info`) | ✅ | ✅ |
| Bash 白名单 | ✅ | ✅ |
| 网页获取 (`http.get`) | ✅ | ✅ |
| 写文件 (`file.write`) | ❌ | ✅ |
| 全量 Bash | ❌ | ✅ |
| 打开应用 | ❌ | ✅ |
| 剪贴板操作 | ❌ | ✅ |
| MCP / Skill | ❌ | ✅ (Phase 4) |

---

## ⚠️ 待开发 / 已知限制

| 项目 | 状态 | 说明 |
|------|------|------|
| 助手模式完整安全 | ⚠️ Phase 3 | 四级检查+确认UI+参数检测 |
| MCP 集成 | ⚠️ Phase 4 | MCP Manager + Client (stdio/SSE) |
| Skill 系统 | ⚠️ Phase 4 | skills/ 目录加载 + 编排执行 |
| 流式输出 | ⚠️ 骨架 | Provider 接口已支持，UI 层待接 |
| 系统通知 | ❌ 已移除 | macOS 未签名构建下无法实现 |
| 窗口感知精度 | ⚠️ 基础可用 | macOS 依赖 osascript |

---

## 🚀 快速开始

### 前置要求

- Node.js ≥ 18 + pnpm
- Rust toolchain
- macOS: Xcode Command Line Tools

### 安装运行

```bash
git clone https://github.com/Klavte/Desk-Pet.git
cd Desk-Pet
pnpm install
pnpm tauri dev
```

### 配置

```bash
cp CONFIG-DEV.yaml.example CONFIG-DEV.yaml
# 编辑 CONFIG-DEV.yaml，填入 API Key
```

`enabled: true` 时 DEV 配置完全替换 CONFIG.yaml。

**macOS 窗口监控**需辅助功能权限：系统设置 → 隐私与安全性 → 辅助功能 → 允许终端/Tauri。

---

## 🏗 架构

```
Desk-Pet/
├── CONFIG.yaml              # 全局默认配置
├── CONFIG-DEV.yaml          # 本地开发配置 (不入 git)
├── DES.md                   # 设计文档（玩法/机制）
├── CLAUDE.md                # AI 开发指引（规范/构建/调试）
├── 架构方案.md               # v2 架构方案
│
├── memory/                  # 长期记忆（文件注册表）
│   ├── MEMORY.md            # ★ 长期记忆索引 (→ CANDY/User/Outside/独立条目)
│   ├── SESSION_MEMORY.md    # 当前会话工作记忆
│   ├── CANDY.md / User.md / Outside.md
│   └── Project.md           # ★ 会话归档指针 (→ sessions/)
├── sessions/                # 历史会话归档
│   └── session-xxx.md
├── src/                     # Vue 3 + TypeScript 前端
│   ├── App.vue              # 根组件（窗口生命周期/快捷键/托盘/会话管理）
│   ├── components/          # UI 组件
│   │   ├── TitleBar.vue / StreamView.vue / ChatPanel.vue
│   │   ├── SessionTabs.vue  # ★ 会话标签页（切换/新建/关闭）
│   │   ├── DebugBar.vue     # Debug 状态栏
│   │   ├── SettingsPanel.vue
│   │   └── winsim/          # 模拟器彩蛋
│   └── services/
│       ├── engine/          # ★ 核心引擎
│       │   ├── agent-loop.ts    # Agent Loop (多轮工具调用)
│       │   ├── preprocessor.ts  # Slash命令+过滤
│       │   ├── parser.ts        # AI输出解析
│       │   ├── session.ts       # 会话状态机
│       │   └── thinking.ts      # 思考强度决策
│       ├── personality/     # 人格模块
│       │   ├── middleware.ts # ★ 人格中间件 (横切所有阶段)
│       │   ├── registry.ts / loader.ts / boundary.ts
│       │   └── cards/
│       ├── tool/            # ★ 工具系统
│       │   ├── registry.ts  # 统一注册表 (按模式)
│       │   ├── router.ts    # 工具路由
│       │   ├── local/       # 轻量6工具 (始终加载)
│       │   └── local-extra/ # 助手模式工具 (动态加载)
│       ├── safety/          # ★ 安全控制
│       │   └── checker.ts   # 轻量简洁模式
│       ├── context/         # ★ 上下文引擎
│       │   ├── builder.ts   # SystemPrompt组装
│       │   └── tool-selector.ts # 工具声明决策
│       ├── reply/           # 回复生成器
│       ├── agent/           # Agent 模块
│       │   ├── runner.ts    # sendMessage/initChat (接入AgentLoop)
│       │   ├── provider.ts  # OpenAI兼容Provider (支持工具调用)
│       │   ├── service.ts   # AI调用封装
│       │   ├── chat.ts      # 聊天记录
│       │   ├── memory.ts    # 长期记忆 (文件注册表)
│       │   ├── active.ts    # 窗口监控→主动搭话
│       │   └── types.ts
│       ├── window/          # 窗口监控
│       ├── audio/           # 音效注册中心
│       ├── config.ts        # 配置加载器
│       ├── cooldown.ts      # 全局冷却+AI并发锁
│       └── ...
│
├── src-tauri/               # Rust 后端
│   └── src/
│       ├── lib.rs           # run() 入口 + 注册所有 commands
│       ├── macros/ / monitor/ / window/
│       └── commands/
│           ├── cursor.rs / monitor_ctl.rs / sim.rs / logging.rs
│           ├── tool_exec.rs  # ★ Bash/文件/系统/剪贴板/应用
│           └── mcp_bridge.rs # ★ MCP stdio 桥接 (Phase 4)
│
└── public/assets/
```

---

## ⌨ 快捷键

| 操作 | 快捷键 |
|------|--------|
| 召唤/收回桌宠 | `Ctrl+Cmd+P` (Mac) / `Ctrl+Alt+P` (Win) |
| 发送消息 | `Enter` |
| 换行 | `Shift+Enter` |

聊天命令：输入 `smile` `sleep` `gaoo` `chu` `superchat` `open win` `/help` `/clear` 等。

---

## 🎛 设置面板

独立窗口，标题栏齿轮按钮打开：

| 类别 | 配置项 | 生效 |
|------|--------|------|
| 模式切换 | 助手模式开关 | 重启后生效 |
| AI 接口 | 端点/密钥/模型/上下文/默认人格 | 即时 |
| 人格切换 | 启用人格系统 / 选择人格卡（热插拔） | 即时 |
| 窗口监控 | 开关/停留秒数/防抖/冷却 | 即时 |
| 弹窗 | 位置模式/大小/自动弹出 | 即时 |
| 快捷键 | 录制自定义组合键 | 即时 |
| 音效 | 29 个音效，每事件独立选择 | 即时 |
| 日志 | debug/info/warn/error | 即时 |

保存后显示"已保存"提示 3 秒。

---

## 📋 macOS 兼容

| 功能 | 状态 | 说明 |
|------|------|------|
| AI 聊天 / 表情 / 动画 | ✅ | 全平台 |
| 工具系统 (文件/Bash/系统) | ✅ | 全平台 |
| 窗口标题监控 | ✅ | osascript（需辅助功能权限） |
| 系统通知 | ❌ | 未签名构建无法实现 |
| 全局快捷键 | ✅ | global-shortcut 插件 |
| 桌面悬浮 | ✅ | canJoinAllSpaces |
| 人格热插拔 | ✅ | 设置面板即时切换 |

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Tauri v2 |
| 前端 | Vue 3 + TypeScript + Vite |
| AI | OpenAI 兼容接口 (工具调用支持) |
| 配置 | YAML（js-yaml，编译时转换） |
| 音效 | Web Audio API（OscillatorNode 合成） |
| 包管理 | pnpm（前端）+ Cargo（Rust） |

---

## 📖 文档

- [架构方案.md](架构方案.md) — v2 完整架构方案
- [DES.md](DES.md) — 设计文档，完整玩法/机制说明
- [CLAUDE.md](CLAUDE.md) — AI 开发指引，代码规范/构建/调试

---

## 📝 License

MIT
