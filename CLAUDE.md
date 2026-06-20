# CLAUDE.md

> 糖糖桌宠 (Desk Pet) — Tauri v2 桌面虚拟主播

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
├── CONFIG.yaml                  # 全局默认配置 (AI / 窗口 / 锁 / 记忆 / 通知 / 桌面后端 / 日志)
├── CONFIG-DEV.yaml              # 本地开发配置 (不入 git, enabled: true 替换 CONFIG)
├── .gitignore                   # CONFIG-DEV.yaml 已忽略
├── index.html / notification.html
├── vite.config.ts               # Vite + YAML 插件 + @ 别名
├── package.json / pnpm-lock.yaml
│
├── src/                         # Vue 前端
│   ├── main.ts / notification-main.ts / App.vue
│   ├── components/              # UI 组件
│   │   ├── TitleBar.vue / StreamView.vue / ChatPanel.vue / NotificationCard.vue
│   │   └── winsim/              # Windows 模拟器彩蛋
│   ├── services/
│   │   ├── ai/                  # AI 模块 (独立)
│   │   │   ├── index.ts         # 统一导出 + sendMessage() / initChat()
│   │   │   ├── config.ts        # AI 配置桥接 → 从 @/services/config 读取
│   │   │   ├── types.ts         # Message / AIProvider / Character / AIConfig
│   │   │   ├── provider.ts      # 统一 OpenAICompatibleProvider
│   │   │   ├── service.ts       # AIService + 离线 fallback
│   │   │   ├── chat.ts          # 对话历史 + 未回复追踪
│   │   │   ├── character.ts     # 多角色人格 (.md 热更新)
│   │   │   ├── memory.ts        # 长期记忆 (localStorage)
│   │   │   └── characters/      # 角色人格卡 (.md)
│   │   ├── window/              # 窗口监控模块
│   │   │   ├── index.ts / listener.ts / monitor.ts / active-context.ts
│   │   ├── config.ts            # 全局配置加载器 (CONFIG.yaml → 类型化 getter)
│   │   ├── logger.ts            # 统一日志工具 (createLogger → invoke → Rust println)
│   │   ├── env.ts               # 平台检测 (isWindows / isMacOS / windowMonitorAvailable)
│   │   ├── cooldown.ts          # 全局冷却 + AI 并发锁
│   │   ├── command-handler.ts   # 聊天命令 → 表情 / 窗口操作
│   │   ├── expressions.ts       # 关键词 → 表情映射
│   │   ├── animation.ts         # 动画帧定义
│   │   └── audio/               # boundary.ts + notificationSound.ts
│   └── styles/                  # global.css + fonts.css
│
├── src-tauri/                   # Rust 后端
│   ├── Cargo.toml               # windows-sys 仅 [target.'cfg(windows)'.dependencies]
│   ├── tauri.conf.json          # 透明/无边框/置顶窗口
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs              # cfg_attr 条件 windows_subsystem
│       └── lib.rs               # 后台线程轮询 → emit("window-changed")
│           ├── capture_window_title()   Win32 GetForegroundWindow | osascript
│           ├── check_cross_monitor()    MonitorFromWindow | 鼠标位置启发式
│           ├── log_message()            接收前端日志 → println 到终端
│           └── set_monitor_config() 等 7 个 Tauri Commands
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
    src/services/config.ts     ← 类型化 getter
         │
         ├── aiConfig           → services/ai/ (config, character, service, chat, provider)
         ├── windowMonitorConfig → services/window/ (monitor, listener)
         ├── aiLockConfig       → services/cooldown.ts
         ├── memoryConfig       → services/ai/memory.ts
         ├── notificationConfig → components/NotificationCard.vue
         ├── desktopConfig      → App.vue → invoke("set_monitor_config") → Rust
         └── loggingConfig      → services/logger.ts (日志级别)
```

**所有模块通过 `@/services/config` 读取配置，不在模块内定义常量。**
本地调参只改 `CONFIG-DEV.yaml`，不用动代码。

---

## 日志系统

所有日志统一输出到 **运行 `pnpm tauri dev` 的终端**，同时保留 DevTools Console。

```ts
import { createLogger } from "@/services/logger";
const log = createLogger("模块前缀");

log.debug("调试信息...");      // 仅 logging.level = debug
log.info("重要节点");          // logging.level = debug|info
log.warn("警告");              // logging.level = debug|info|warn
log.error("错误", err);       // 永远输出
```

输出格式：`[HH:MM:SS.mmm] LEVEL [前缀] 消息`

Rust 端用 `rust_info!` / `rust_debug!` / `rust_warn!` 宏，格式一致。

日志级别在 `CONFIG.yaml` → `logging.level` 控制。DEV 配置默认 `debug`，生产默认 `info`。

---

## 数据流

```
Rust 后台线程(轮询间隔来自 desktopConfig) → emit("window-changed") → window/listener.ts
    Windows: GetForegroundWindow    macOS: osascript
                                                      │
                                          ┌───────────┴──────────┐
                                    停留≥CONFIG秒?           关键词匹配?
                                          │                       │
                                    window/active-context    expressions.ts
                                    (AI 主动搭话)          (切换角色表情)
                                          │
                                    ai/pushAssistantMessage()
                                          │
                                    ChatPanel 显示 → 跨屏/最小化 → 系统通知
```

---

## 编码约定

- **优先复用已有代码**，不过度设计、不过度抽象
- **任何操作必须同步做 Windows + macOS 双端适配**
- Rust 平台代码用 `#[cfg(target_os = "windows")]` / `#[cfg(target_os = "macos")]` 守卫
- Windows 专有依赖用 `[target.'cfg(windows)'.dependencies]`
- Vue 组件用 `<script setup lang="ts">` 语法
- 新增表情在 `animation.ts` 加一条即可
- AI 模块通过 `@/services/ai` 统一导入
- 全局冷却/并发锁走 `cooldown.ts`
- 平台检测走 `@/services/env`
- **配置走 `@/services/config`**，不在模块里写死常量

---

## macOS 兼容状态

| 功能 | macOS | 实现 |
|---|---|---|
| AI 聊天 / 角色表情 / 动画 | ✅ | 全平台 |
| Windows 模拟器 | ✅ | 全平台 |
| 窗口标题监控 | ✅ | osascript (需辅助功能权限) |
| 跨显示器检测 | ✅ | 鼠标位置启发式 |
| AI 主动搭话 | ✅ | 依赖窗口监控 |
| 系统通知 | ✅ | Tauri Notification Plugin |

---

## 要求 ##
优先复用已有代码 不要过度设计和抽象
不要乱加 任何操作一定同步做win和mac双端适配


## 必要操作 ##
每次回复的最后加："宝"
每轮修改结束必须同步更新说明.md和CLAUDE.md
有配置项修改的地方一定统一写在相应配置文件，并同步CONFIG.yaml和CONFIG-DEV.yaml
