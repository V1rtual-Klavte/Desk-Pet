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
├── CONFIG.yaml                  # 全局默认配置 (AI / 窗口 / 锁 / 记忆 / 通知 / 桌面 / 快捷键 / 用户 / 日志)
├── CONFIG-DEV.yaml              # 本地开发配置 (不入 git, enabled: true 替换 CONFIG)
├── DES.md                       # 设计文档 (玩法/机制/交互说明)
├── .gitignore                   # CONFIG-DEV.yaml 已忽略
├── index.html / notification.html / settings.html
├── vite.config.ts               # Vite + YAML 插件 + @ 别名
├── package.json / pnpm-lock.yaml
│
├── src/                         # Vue 前端
│   ├── main.ts / notification-main.ts / settings-main.ts / App.vue
│   ├── components/              # UI 组件
│   │   ├── TitleBar.vue / StreamView.vue / ChatPanel.vue / SettingsPanel.vue / NotificationCard.vue
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
│   │   ├── config.ts            # 全局配置加载器 (CONFIG.yaml → 类型化 getter + 运行时 userConfig localStorage 覆盖)
│   │   ├── logger.ts            # 统一日志工具 (createLogger → invoke → Rust println)
│   │   ├── env.ts               # 平台检测 (isWindows / isMacOS / windowMonitorAvailable)
│   │   ├── cooldown.ts          # 全局冷却 + AI 并发锁
│   │   ├── command-handler.ts   # 聊天命令
│   │   ├── expressions.ts       # 关键词
│   │   ├── animation.ts         # 动画帧定义
│   │   └── audio/               # registry.ts (统一音效注册中心) + boundary.ts (人格界限)
│   └── styles/                  # global.css + fonts.css
│
├── src-tauri/                   # Rust 后端
│   ├── Cargo.toml               # windows-sys [Win], objc [Mac] 平台依赖
│   ├── tauri.conf.json          # macOSPrivateApi, windows=[] (Rust 手动创建)
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs              # cfg_attr 条件 windows_subsystem
│       └── lib.rs               # 后台线程轮询 → emit("window-changed")
│           ├── capture_window_title()   Win32 GetForegroundWindow | osascript
│           ├── check_cross_monitor()    MonitorFromWindow | 鼠标位置启发式
│           ├── create_main_window()          Rust 手动创建窗口（ActivationPolicy 之后）
│           ├── enhance_to_iterm_style()       iTerm 风格增强：MainMenu(24) + canJoinAllSpaces + fullScreenAux + stationary + ignoresCycle + transient
│           ├── log_message()            接收前端日志 → println 到终端
│           ├── enhance_settings_window()       设置窗口层级提升：macOS level 100 + orderFrontRegardless（浮在主窗口之上）
│           ├── set_monitor_config() 等 10 个 Tauri Commands
│           └── 系统托盘 (TrayIconBuilder)  关闭按钮 → 隐藏到托盘，左键单击恢复
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
         ├── aiConfig           → services/ai/ (config, character, service, chat, provider)
         ├── windowMonitorConfig → services/window/ (monitor, listener)
         ├── aiLockConfig       → services/cooldown.ts
         ├── memoryConfig       → services/ai/memory.ts
         ├── notificationConfig → components/NotificationCard.vue
         ├── desktopConfig      → App.vue → invoke("set_monitor_config") → Rust
         ├── shortcutConfig     → App.vue → 全局快捷键注册 (global-shortcut 插件)
         ├── loggingConfig      → services/logger.ts (日志级别)
         └── userConfig         → App.vue / SettingsPanel → 弹窗位置/大小/快捷键/音效分配 (localStorage)
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

全局快捷键 (tauri-plugin-global-shortcut) → handleShortcutToggle()
    │
    ├── 收回(窗口可见): get_cursor_position(统一web坐标,macOS已Y轴翻转) → 缩放动画 1→0 + 收回音效 → hide()(先隐藏再清样式,零白窗闪烁) → 恢复家位置
    └── 弹出(窗口隐藏): compute_popup_position(Rust: enhance_to_iterm_style+show+set_focus+光标web坐标计算) → 先设 opacity:0 → setPosition(Rust算好的web坐标) → 缩放动画 0→1 + 弹出音效 → focusInput()
             │  isAnimating 延迟 500ms 清除 + ignoreResizeUntil 时间基准防 DPI 尺寸漂移

启动: ActivationPolicy::Accessory → create_main_window(index.html) → 窗口默认显示(居中) → 快捷键切换显示/隐藏

Dock/任务栏 点击 → onFocusChanged → handleDockPopup() → 屏幕中央淡入 + 聚焦输入框

窗口配置: alwaysOnTop + visibleOnAllWorkspaces + NSStatusWindowLevel(100) + fullScreenAuxiliary → 所有桌面/全屏悬浮

窗口拖动 → onMoved → 追踪 lastMovedPos（和 setPosition 同一坐标系）→ 仅 emit("deskpet-moved") 通知设置面板
                  → mouseup 检测用户手动拖动结束 → 用 lastMovedPos 保存 userConfig.fixedPosition

窗口缩放 → onResized → toLogicalSize() 除以 devicePixelRatio 转逻辑坐标 → 与 expectedSize 对比(±5px+时间窗口)区分程序化/用户缩放
                     → setWindowPos() 显式设 lastMovedPos（逻辑坐标），不依赖异步 onMoved 时序
                     → 仅用户手动拖边缩放时保存 userConfig.popupSize（上限 4000 安全校验）

右键选中文字 → 自定义右键菜单 (仅复制)

全局禁选/禁拖 → global.css: #root { user-select: none } + img { -webkit-user-drag: none } + draggable="false"
  仅聊天消息区 (#ch-msgs) 可选中文字

设置页 → TitleBar 齿轮按钮 → openSettings() → 创建独立 WebviewWindow(settings.html, alwaysOnTop) → setTimeout 300ms 延迟 → invoke("enhance_settings_window")(Rust: level 100 + orderFrontRegardless + makeKeyAndOrderFront) → SettingsPanel 独立渲染
  ├── 保存后窗口不自动关闭，显示"已保存"提示 3 秒后消失
  ├── AI/监控/锁/记忆/通知/桌面/日志 → 可编辑，保存到 localStorage 覆盖，getter 动态读取 overrideOr() → 即时生效
  ├── 弹窗模式/大小/快捷键/音效选择（下拉指定音效库音效 + 恢复默认按钮）→ 即时生效
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
| 全局快捷键召唤 | ✅ | global-shortcut 插件 + NSEvent.mouseLocation (objc, 无需权限) + Cocoa→web Y轴翻转 |
| 所有桌面悬浮 | ✅ | visibleOnAllWorkspaces + alwaysOnTop |
| Dock 点击弹出 | ✅ | onFocusChanged → 屏幕中央淡入 |
| 系统托盘 | ✅ | TrayIconBuilder — 关闭隐藏到托盘，单击恢复 |
| 设置页面 | ✅ | SettingsPanel — 配置/音效/快捷键/弹窗位置/大小 |

---

## 要求 ##
优先复用已有代码 不要过度设计和抽象
不要乱加 任何操作一定同步做win和mac双端适配


## 必要操作 ##
每次回复的最后加："宝"
每轮修改结束必须同步更新：说明.md；CLAUDE.md；DES.md
有配置项修改的地方一定统一写在相应配置文件，并同步CONFIG.yaml和CONFIG-DEV.yaml及其example，以及设置页面
