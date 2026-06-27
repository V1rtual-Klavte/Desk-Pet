# 🍬 糖糖桌宠 (Desk Pet)

> 像素风桌面虚拟主播 — 常驻桌面，能聊天、能用工具、能看你窗口、能主动搭话。
>
> ⚠️ **当前状态：Phase 1+2+3 完成（安全确认 UI 已实现），Phase 4 大部分完成（仅 Plan 模型预判/SSE 待实现）**。

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/Klavte/Desk-Pet)
[![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4fc08d)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-🦀-dea584)](https://www.rust-lang.org)

---

## ✨ 已有功能

- **桌面常驻** — 无边框透明窗口，角色在所有桌面/全屏 Space 悬浮
- **会话管理** — 多会话标签页，可切换/新建/关闭，拖动分割线调整面板宽度，自动归档，启动恢复
- **AI 聊天** — 人格卡驱动，Ageng Loop 多轮工具调用，兼容 OpenAI / DeepSeek / Ollama 等
- **工具系统** — AI 可调用工具：读文件/列目录/搜索文件/系统信息/Bash/HTTP GET
- **助手模式** — 解锁写文件/全量Bash/打开应用/剪贴板/MCP 服务器/Skill 编排/子代理
- **Agent Loop** — 多轮工具调用循环（每轮携带完整工具集），思考强度手动选择（全局默认+会话覆盖），上下文自动压缩
- **人格中间件** — 横切所有 Agent 阶段的角色化表达（表情/音效/角色话术）
- **窗口感知** — 监控前台窗口标题，停留一定时间后 AI 主动搭话
- **快捷键召唤** — 全局快捷键弹出/收回，弹性缩放动画
- **人格系统** — 独立人格模块，支持热插拔切换/开关，在设置面板配置
- **人格进化** — 不理她太久会从甜蜜女友逐渐变成病娇（unansweredCount + boundary 系统）
- **安全控制** — 四级安全（SAFE/NORMAL/DANGER/NOWAY）+ 三策略（全放行/告知确认/全部确认），确认弹窗 UI，全局默认+会话覆盖，统一危险模式库
- **记忆系统** — MEMORY.md 双块结构化注册表 + sessions/ 实时写入 + 会话历史面板 + LLM 整理 + Fork 补记忆
- **音效系统** — 29 个内置音效，Web Audio 合成无需外部文件
- **设置面板** — 独立窗口，AI / 安全 / 监控 / 人格 / 模式 / 弹窗 / 快捷键 / 音效 / 工具 / MCP / Skill 可配置，支持 CONFIG 导入/导出
- **仪表盘** — 底部状态栏，实时显示上下文占比/token消耗/工具注册数，**会话级**思考强度+安全策略覆盖下拉
- **MCP 支持** — 内置 5 个 MCP Server (Filesystem/BraveSearch/Playwright/Git/GitHub) + 自定义 MCP，stdio 传输，JSON-RPC 协议
- **Windows 模拟器** — 彩蛋：像素风 Win7 桌面（输入 `open win` 触发）
- **系统托盘** — 关闭隐藏到托盘，单击恢复
- **Dock 点击弹出** — 窗口隐藏时点击 Dock/任务栏图标，屏幕中央淡入弹出

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
| MCP (Mock) | ❌ | ✅ (内置5个 + 自定义) |
| Skill (基础) | ❌ | ✅ (子循环执行) |
| 子代理 (agent.spawn) | ❌ | ✅ (fork/team 双模式) |
| 安全确认弹窗 | ❌ | ✅ (四级+三策略) |

---

## ⚠️ 待开发 / 已知限制

| 项目 | 状态 | 说明 |
|------|------|------|
| 助手模式完整安全 | ✅ Phase 3 | 四级安全+三策略(全放行/告知/全确认)+确认弹窗UI+会话覆盖 |
| agent.spawn 子代理 | ✅ Phase 3 | fork/team 双模式，子循环最多 3 轮，90s 超时 |
| MCP 真实连接 | ✅ Phase 4 | stdio 传输 + JSON-RPC + Rust 桥接 + 工具发现注册 + 内置5个MCP |
| Skill 编排执行 | ✅ Phase 4 | Runner 子循环调用 Local/MCP 工具 + import.meta.glob 加载 |
| Plan AI 模型预判 | ⚠️ Phase 4 | 模型预判拆解步骤（当前为关键词桩） |
| 流式输出 | ❌ 未实现 | Provider 非流式 fetch，UI 无 SSE 处理 |
| MCP SSE 传输 | ❌ 未实现 | 仅 stdio，SSE 远程连接待实现 |
| 系统通知 | ❌ 已移除 | macOS 未签名构建下无法实现 |
| ⚠️ 工具/Skill/安全 测试 | ⚠️ 未充分 | 功能已实现，集成测试尚未覆盖全路径 |

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
│   ├── CANDY.md / User.md / Outside.md
│   └── Project.md           # ★ 会话归档指针 (→ sessions/)
├── sessions/                # 历史会话归档
│   └── session-xxx.md
├── skills/                  # Skill 文件 (3个内置Skill: summarize-code/organize-files/check-weather)
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
│       │   ├── thinking.ts      # 思考强度决策
│       │   └── plan.ts          # Plan 步骤 (助手模式)
│       ├── personality/     # 人格模块
│       │   ├── middleware.ts # ★ 人格中间件 (横切所有阶段)
│       │   ├── registry.ts / loader.ts / boundary.ts
│       │   └── cards/
│       ├── tool/            # ★ 工具系统
│       │   ├── registry.ts  # 统一注册表 (按模式)
│       │   ├── router.ts    # 工具路由
│       │   ├── local/       # 轻量6工具 (始终加载)
│       │   ├── local-extra/ # 助手模式工具 (动态加载)
│       │   ├── skill/       # Skill 系统
│       │   └── mcp/         # MCP 集成 (Mock)
│       ├── safety/          # ★ 安全控制
│       │   └── checker.ts   # 统一安全 + 危险模式库
│       ├── context/         # ★ 上下文引擎
│       │   ├── builder.ts   # SystemPrompt组装
│       │   └── index.ts
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
│       ├── audio/           # 音效注册中心 + 界限联动
│       ├── config.ts        # 配置加载器
│       ├── cooldown.ts      # 全局冷却+AI并发锁
│       ├── debug.ts         # Debug 状态数据
│       ├── animation.ts / expressions.ts / command-handler.ts
│       └── ...
│
├── src-tauri/               # Rust 后端
│   └── src/
│       ├── lib.rs           # run() 入口 + 注册所有 commands
│       ├── macros/ / monitor/ / window/
│       └── commands/
│           ├── cursor.rs / monitor_ctl.rs / sim.rs / logging.rs
│           ├── tool_exec.rs  # ★ Bash/文件/系统/剪贴板/应用
│           ├── memory_cmd.rs # ★ 文件系统操作 (init/list/delete sessions)
│           └── mcp_bridge.rs # ★ MCP stdio 桥接 (Phase 4 桩)
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

聊天命令：输入 `/` 弹出下拉框查看所有命令（`/help` `/clear` `/smile` `/sleep` `/win open` 等）。

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
| 工具配置 | Bash 白名单编辑 / 文件写开关 | 即时 |
| MCP 配置 | 启用开关 / 服务器列表增删改（stdio/sse）/ JSON 导入导出 / 已配置 vs 已激活区分 | 需重启 |
| Skill 配置 | 启用开关 / 已配置列表 / 上传 .md 添加 / 删除 / 已配置 vs 已激活区分 | 需重启 |
| CONFIG 导入导出 | 上传 YAML 导入覆盖层 / 导出当前覆盖值为 YAML | 导入后刷新 |

保存后显示"已保存"提示 3 秒。

---

## 📋 macOS 兼容

| 功能 | 状态 | 说明 |
|------|------|------|
| AI 聊天 / Agent Loop / 工具调用 | ✅ | 全平台 |
| 文件/系统/HTTP 工具 | ✅ | 全平台 |
| Windows 模拟器 | ✅ | 全平台 |
| 窗口标题监控 | ✅ | osascript（需辅助功能权限） |
| AI 主动搭话 | ✅ | 依赖窗口监控 |
| 系统通知 | ❌ | 未签名构建无法实现 |
| 全局快捷键召唤 | ✅ | global-shortcut 插件 |
| 桌面悬浮 | ✅ | canJoinAllSpaces + alwaysOnTop |
| 系统托盘 | ✅ | TrayIconBuilder |
| Dock 点击弹出 | ✅ | onFocusChanged → 屏幕中央淡入 |
| 设置页面 | ✅ | SettingsPanel |
| 人格热插拔 | ✅ | 设置面板即时切换 |

---

## 🪟 Windows 兼容

| 功能 | 状态 | 说明 |
|------|------|------|
| AI 聊天 / Agent Loop / 工具调用 | ✅ | 全平台 |
| 文件/系统/HTTP 工具 | ✅ | 全平台 |
| Windows 模拟器 | ✅ | 全平台 |
| 窗口标题监控 | ✅ | GetForegroundWindow（无需额外权限） |
| AI 主动搭话 | ✅ | 依赖窗口监控 |
| 全局快捷键召唤 | ✅ | global-shortcut 插件 |
| 桌面悬浮 | ✅ | alwaysOnTop |
| 系统托盘 | ✅ | TrayIconBuilder |
| 任务栏点击弹出 | ✅ | 窗口隐藏时点击任务栏图标弹出 |
| 设置页面 | ✅ | SettingsPanel |
| 人格热插拔 | ✅ | 设置面板即时切换 |
| 系统通知 | ⚠️ | 待验证（需签名构建测试） |

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
