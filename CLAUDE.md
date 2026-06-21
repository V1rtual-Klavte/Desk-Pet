# CLAUDE.md

> 糖糖桌宠 (Desk Pet) — Tauri v2 桌面虚拟主播助手

---

## 技术栈

- **桌面框架**: Tauri v2 (Rust 后端 + WebView 前端)
- **前端**: Vue 3 + TypeScript + Vite
- **Rust 包管理**: Cargo
- **前端包管理**: pnpm
- **AI 后端**: 统一 OpenAI 兼容 Provider (DeepSeek / OpenAI / Ollama / LM Studio)
- **YAML 解析**: js-yaml (devDependency, Vite 插件编译时转换)
- **目标平台**: Windows + macOS

---

## 构建 & 运行

```bash
pnpm install          # 安装前端依赖
pnpm tauri dev        # 开发模式 (Vite + Rust 编译 + 桌面窗口)
pnpm dev              # 仅前端 dev server (端口 1420)
pnpm tauri build      # 生产构建
cd src-tauri && cargo check   # Rust 编译检查
```

---

## 项目结构

```
Desk-Pet/
├── CONFIG.yaml                  # 全局默认配置
├── CONFIG-DEV.yaml              # 本地开发配置 (不入 git)
├── DES.md                       # 设计文档
├── 架构方案.md                   # v2 架构方案
├── .gitignore
├── index.html / notification.html / settings.html
├── vite.config.ts               # Vite + YAML 插件 + @ 别名
├── package.json / pnpm-lock.yaml
│
├── memory/                      # ★ 长期记忆（文件注册表）
│   ├── MEMORY.md                # ★ 长期记忆索引 → 指向各 .md 文件或独立条目
│   ├── SESSION_MEMORY.md        # 当前会话工作记忆
│   ├── CANDY.md                 # 用户系统指令
│   ├── User.md                  # 用户画像 (imp≥7 自动同步)
│   ├── Outside.md               # 外部知识指针
│   └── Project.md               # ★ 会话归档指针 → sessions/
│
├── sessions/                    # ★ 历史会话归档
│   └── session-YYYY-MM-DD-HH-mm-ss.md
│
├── skills/                      # ★ Skill 文件目录 (Phase 4)
│
├── src/                         # Vue 前端
│   ├── main.ts / notification-main.ts / settings-main.ts / App.vue
│   ├── components/              # UI 组件
│   │   ├── TitleBar.vue / StreamView.vue / ChatPanel.vue / SessionTabs.vue / SettingsPanel.vue / NotificationCard.vue
│   │   ├── DebugBar.vue          # Debug 状态栏（嵌入 ChatPanel 底部）
│   │   └── winsim/              # Windows 模拟器彩蛋
│   ├── services/
│   │   ├── engine/              # ★ 核心引擎 (Phase 2)
│   │   │   ├── index.ts         # 统一导出
│   │   │   ├── agent-loop.ts    # ★ Agent Loop — 多轮工具调用核心循环 + 上下文压缩
│   │   │   ├── preprocessor.ts  # Slash命令 + 空/重复消息过滤
│   │   │   ├── parser.ts        # AI输出解析 (function_call/纯文本/思考)
│   │   │   ├── session.ts       # 会话状态机 (WAITING→PRE→GENERATING→EXECUTING)
│   │   │   ├── thinking.ts      # ★ 思考强度决策 (auto/low/medium/high)
│   │   │   └── plan.ts          # ★ Plan 步骤 (助手模式复杂任务预判拆解)
│   │   ├── personality/         # ★ 人格模块
│   │   │   ├── index.ts
│   │   │   ├── types.ts / loader.ts / registry.ts / boundary.ts
│   │   │   ├── middleware.ts    # ★ 人格中间件（包裹所有Agent阶段）
│   │   │   └── cards/           # 人格卡 .md
│   │   ├── tool/                # ★ 工具系统 (Phase 2)
│   │   │   ├── index.ts / types.ts / registry.ts / router.ts
│   │   │   ├── local/           # 轻量模式工具 (file/bash/system/http)
│   │   │   ├── local-extra/     # 助手模式工具 (file-write/bash-full/app/clipboard/agent/file-delete)
│   │   │   ├── skill/           # Skill 系统 (loader/registry/runner)
│   │   │   └── mcp/             # MCP 集成 (manager/client)
│   │   ├── safety/              # ★ 安全控制 (Phase 2)
│   │   │   ├── index.ts
│   │   │   └── checker.ts       # 统一安全 + 危险模式库 (BASH/FILE patterns)
│   │   ├── context/             # ★ 上下文引擎 (Phase 2)
│   │   │   └── builder.ts       # SystemPrompt 动态组装 + 消息压缩
│   │   ├── reply/               # ★ 回复生成器 (Phase 2)
│   │   │   └── generator.ts     # 后处理: kaomoji/截断/HTML转义
│   │   ├── agent/               # Agent 模块
│   │   │   ├── index.ts
│   │   │   ├── types.ts         # Message / ToolCall / GenerateRequest 类型
│   │   │   ├── runner.ts        # sendMessage() — 接入 AgentLoop
│   │   │   ├── provider.ts      # OpenAICompatibleProvider — 支持工具调用+思考强度
│   │   │   ├── service.ts / chat.ts / memory.ts / active.ts
│   │   ├── window/ / audio/ / config.ts / logger.ts / cooldown.ts
│   │   └── ...
│   └── styles/
│
├── src-tauri/                   # Rust 后端
│   ├── Cargo.toml               # windows-sys [Win], objc [Mac], num_cpus
│   └── src/
│       ├── lib.rs / main.rs
│       ├── macros/ / monitor/ / window/
│       └── commands/
│           ├── cursor.rs / monitor_ctl.rs / sim.rs / logging.rs
│           ├── tool_exec.rs     # ★ Bash/文件/系统/剪贴板/应用
│           └── mcp_bridge.rs    # ★ MCP stdio 桥接 (Phase 4 桩)
│
└── public/assets/               # 静态资源
```

---

## 配置系统

```
CONFIG.yaml                    ← 默认配置 (跟 git)
    │
    ├── CONFIG-DEV.yaml 存在 && enabled: true  → 完全替换，CONFIG 不加载
    ├── CONFIG-DEV.yaml 存在 && enabled: false → 忽略 DEV，走 CONFIG
    └── CONFIG-DEV.yaml 不存在                 → 走 CONFIG
         │
         ▼ Vite YAML Plugin (js-yaml 编译时转换)
         │
    src/services/config.ts     ← 类型化 getter + userConfig (localStorage 持久化覆盖)
         │
         ├── modeConfig           → 助手模式开关
         ├── aiConfig             → services/agent/ (provider, runner)
         ├── thinkingConfig       → services/engine/thinking.ts
         ├── loopConfig           → services/engine/agent-loop.ts
         ├── toolsConfig          → services/tool/ (bash白名单/文件/MCP/Skill)
         ├── safetyConfig         → services/safety/
         ├── personalityConfig    → services/personality/ (registry, loader)
         ├── windowMonitorConfig  → services/window/ (monitor, listener)
         ├── aiLockConfig         → services/cooldown.ts
         ├── memoryConfig         → services/agent/memory.ts
         ├── desktopConfig        → App.vue → invoke("set_monitor_config") → Rust
         ├── shortcutConfig       → App.vue → 全局快捷键注册 (global-shortcut 插件)
         ├── loggingConfig        → services/logger.ts (日志级别)
         └── userConfig           → App.vue / SettingsPanel → 弹窗位置/大小/快捷键/音效分配 (localStorage)
```

**所有模块通过 `@/services/config` 读取配置，不在模块内定义常量。**
本地调参只改 `CONFIG-DEV.yaml`，不用动代码。

---

## 日志系统

所有日志统一输出到 **运行 `pnpm tauri dev` 的终端**，同时保留 DevTools Console。

```ts
import { createLogger } from "@/services/logger";
const log = createLogger("模块前缀");

log.debug("调试信息...");
log.info("重要节点");
log.warn("警告");
log.error("错误", err);
```

输出格式：`[HH:MM:SS.mmm] LEVEL [前缀] 消息`

Rust 端用 `rust_info!` / `rust_debug!` / `rust_warn!` 宏，格式一致。

---

## 数据流

```
┌── 会话管理 ──────────────────────────────────────────────┐
│ SessionTabs (右侧聊天面板顶部) ←→ chat.ts                 │
│   ├── localStorage "deskpet_sessions"    会话列表          │
│   ├── localStorage "deskpet_active_session" 活跃ID        │
│   ├── localStorage "deskpet_chat_<id>"  每会话消息         │
│   ├── localStorage "deskpet_divider_pos" 分割线位置        │
│   ├── 每轮 recordTurn → appendTurnToSessionFile()         │
│   │   └── 实时写入 sessions/<sessionId>.md                │
│   └── /clear → MemoryService.archiveSession() → Project.md│
└──────────────────────────────────────────────────────────┘

Rust 后台线程 → emit("window-changed") → window/listener.ts
    Windows: GetForegroundWindow    macOS: osascript
                                                      │
                                          ┌───────────┴──────────┐
                                    停留≥CONFIG秒?           关键词匹配?
                                          │                       │
                                    agent/active.ts         expressions.ts
                                    → sendActiveMessage()   (切换角色表情)
                                    → runAgentLoop()
                                          │
                                    → personality.getSystemPrompt()
                                    → ContextEngine.build()
                                    → [Plan] 助手+复杂任务预判拆解
                                    → AgentLoop (多轮工具调用)
                                         │
                                         ├─ thinking 阶段 → 表情事件
                                         ├─ executing 阶段 → 角色化文案
                                         ├─ blocked 阶段 → 拒绝提示
                                         ├─ done 阶段 → 音效事件
                                         └─ 上下文利用率>95% → 自动压缩
                                    → ReplyGenerator
                                          │
                                    pushAssistantMessage + incrementUnanswered
                                    → ChatPanel 显示

用户聊天 agent/runner.sendMessage() → PreProcessor → ContextEngine.build() → AgentLoop
  → [循环] AI ↔ ToolExec → 安全校验(统一模式库) → 人格中间件.wrap → ReplyGenerator
  → pushAssistantMessage + expression/sound 事件驱动 UI

全局快捷键 → handleShortcutToggle()
    ├── 收回: 缩放动画 1→0 + 收回音效 → hide() → 恢复家位置
    └── 弹出: setPosition → 缩放动画 0→1 + 弹出音效 → focusInput()

启动: ActivationPolicy::Accessory → create_main_window
  → initRegistry() + registerDefaultTools() + skill/MCP Mock 工具
  → initChat() + startMemoryConsolidationTimer() (每60min检查>24h自动整理)
  → initDebug()

Dock点击 → onFocusChanged → handleDockPopup() → 屏幕中央淡入
设置页 → SettingsPanel → AI/人格/监控/模式/弹窗/快捷键/音效 + 工具/MCP/Skill预览
```

---

## 编码约定

- **优先复用已有代码**，不过度设计、不过度抽象
- **任何操作必须同步做 Windows + macOS 双端适配**
- Rust 平台代码用 `#[cfg(target_os = "windows")]` / `#[cfg(target_os = "macos")]` 守卫
- Windows 专有依赖用 `[target.'cfg(windows)'.dependencies]`
- Vue 组件用 `<script setup lang="ts">` 语法
- 新增表情在 `animation.ts` 加一条即可
- **AI 模块通过 `@/services/agent` 统一导入**
- **人格模块通过 `@/services/personality` 统一导入**
- **工具模块通过 `@/services/tool` 统一导入**
- **引擎模块通过 `@/services/engine` 统一导入**
- 全局冷却/并发锁走 `cooldown.ts`
- 平台检测走 `@/services/env`
- **配置走 `@/services/config`**，不在模块里写死常量

---

## macOS 兼容状态

| 功能 | macOS | 实现 |
|---|---|---|
| AI 聊天 / Agent Loop / 工具调用 | ✅ | 全平台 |
| 文件/系统/HTTP 工具 | ✅ | 全平台 |
| Windows 模拟器 | ✅ | 全平台 |
| 窗口标题监控 | ✅ | osascript (需辅助功能权限) |
| AI 主动搭话 | ✅ | 依赖窗口监控 |
| 系统通知 | ❌ 已移除 | macOS 未签名构建无法实现 |
| 全局快捷键召唤 | ✅ | global-shortcut 插件 |
| 所有桌面悬浮 | ✅ | visibleOnAllWorkspaces + alwaysOnTop |
| Dock 点击弹出 | ✅ | onFocusChanged → 屏幕中央淡入 |
| 系统托盘 | ✅ | TrayIconBuilder |
| 设置页面 | ✅ | SettingsPanel — 含模式切换 |

---

## 要求 ##
优先复用已有代码 不要过度设计和抽象
不要乱加 任何操作一定同步做win和mac双端适配


## 必要操作 ##
每次回复的最后加："宝"
每轮修改结束必须同步更新：README.md；CLAUDE.md；DES.md
有配置项修改的地方一定统一写在相应配置文件，并同步CONFIG.yaml和CONFIG-DEV.yaml及其example，以及设置页面、README.md
当我输入1时，默认从"要求.md"里获取需求
一定要先给我思路，不要直接改代码，我同意后方可开始编码
改动必须确认改动后调用链正常，同步更新test.ts测试脚本

## 核心方针 ##
轻量化，低内存占用，高性能，token消耗少，功能强
我的架构设计的md只是大方向，仿照claude code及其他的东西来写的，最终还是要你写的时候自觉地不断补充，自觉完善逻辑来实现