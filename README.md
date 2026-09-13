# 🍬 糖糖桌宠 (Desk Pet)

> 像素风桌面虚拟主播 — 常驻桌面，能聊天、能看你窗口、能主动搭话。
>
> ⚠️ **当前状态：早期开发框架**（v0.8.x）。核心流程已跑通，但大量功能尚待完善。

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/Klavte/Desk-Pet)
[![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4fc08d)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-🦀-dea584)](https://www.rust-lang.org)

---

## ✨ 已有功能

- **桌面常驻** — 无边框透明窗口，角色在所有桌面/全屏 Space 悬浮
- **AI 聊天** — 人格卡驱动，兼容 OpenAI / DeepSeek / Ollama 等
- **窗口感知** — 监控前台窗口标题，停留一定时间后 AI 主动搭话
- **快捷键召唤** — 全局快捷键弹出/收回，缩放动画
- **人格进化** — 不理她太久会从甜蜜女友逐渐变成病娇（unansweredCount + boundary 系统）
- **音效系统** — 29 个内置音效，Web Audio 合成无需外部文件
- **设置面板** — 独立窗口，AI / 监控 / 弹窗 / 快捷键 / 音效可配置
- **Windows 模拟器** — 彩蛋：像素风 Win7 桌面（输入 `open win` 触发）
- **系统托盘** — 关闭隐藏到托盘，单击恢复
- **鼠标追踪** — 全屏视差跟随：背景/人物水平位移比例不同，垂直完全同步（单一 rAF 同帧提交，与序列帧动画解耦）

---

## ⚠️ 待开发 / 已知限制

| 项目 | 状态 | 说明 |
|------|------|------|
| 系统通知 | ❌ 已移除 | macOS 未签名构建下无法实现（tauri-plugin 需签名，osascript 沙箱受限），留有注释占位 |
| 自动弹出 | ⚠️ 基础可用 | 收到消息自动弹出逻辑已实现，但偶有 DPI/坐标不一致问题 |
| 多角色切换 | ⚠️ 骨架 | 人格卡文件已准备，切换入口待做 |
| 窗口感知精度 | ⚠️ 基础可用 | macOS 依赖 osascript 取前台 app 名，无法获取浏览器标签页标题 |
| 长期记忆 | ⚠️ 骨架 | localStorage 存取逻辑已有，未接入 AI prompt |
| 角色动画 | ⚠️ 基础 | 序列帧播放 + 关键词触发表情切换，缺少更多动画资源 |

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
# 编辑 CONFIG-DEV.yaml：填入 API 端点与 Key
# 本地 Ollama/LM Studio 可将 requireApiKey 设为 false（无需 Key）
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
│
├── src/                     # Vue 3 + TypeScript 前端
│   ├── App.vue              # 根组件（窗口生命周期/快捷键/托盘）
│   ├── components/          # UI 组件
│   │   ├── TitleBar.vue / StreamView.vue / ChatPanel.vue
│   │   ├── SettingsPanel.vue
│   │   └── winsim/          # 模拟器彩蛋
│   └── services/
│       ├── ai/              # AI 模块（provider / chat / character / memory）
│       ├── window/          # 窗口监控（listener / monitor / active-context）
│       ├── audio/           # 音效注册中心 + 人格界限
│       ├── config.ts        # 配置加载器（YAML → 类型化 getter）
│       ├── mouse-tracking.ts # 鼠标追踪（轻量视觉跟随）
│       ├── cooldown.ts      # 全局冷却 + AI 并发锁
│       └── ...
│
├── src-tauri/               # Rust 后端
│   └── src/
│       ├── lib.rs           # run() 入口 + 系统托盘
│       ├── macros/          # 日志宏
│       ├── monitor/         # MonitorState / capture / visibility / thread
│       ├── window/          # 主窗口 + iTerm 增强 + 设置窗口
│       └── commands/        # cursor / monitor_ctl / sim / logging
│
└── public/assets/           # 静态资源（序列帧等）
```

---

## ⌨ 快捷键

| 操作 | 快捷键 |
|------|--------|
| 召唤/收回桌宠 | `Ctrl+Cmd+P` (Mac) / `Ctrl+Alt+P` (Win) |
| 发送消息 | `Enter` |
| 换行 | `Shift+Enter` |

聊天命令：输入 `smile` `sleep` `gaoo` `chu` `superchat` `open win` 等触发特殊表情/WinSim。

---

## 🎛 设置面板

独立窗口，标题栏齿轮按钮打开：

| 类别 | 配置项 | 生效 |
|------|--------|------|
| AI 接口 | 端点/密钥/模型/上下文/人格 | 即时 |
| 窗口监控 | 开关/停留秒数/防抖/冷却 | 即时 |
| 弹窗 | 位置模式/大小/自动弹出 | 即时 |
| 快捷键 | 录制自定义组合键 | 即时 |
| 音效 | 29 个音效，每事件独立选择 | 即时 |
| 日志 | debug/info/warn/error | 即时 |

保存后窗口不关闭，显示"已保存"提示 3 秒。

---

## 📋 macOS 兼容

| 功能 | 状态 | 说明 |
|------|------|------|
| AI 聊天 / 表情 / 动画 | ✅ | 全平台 |
| 窗口标题监控 | ✅ | osascript（需辅助功能权限） |
| 系统通知 | ❌ | 未签名构建无法实现（已移除，留占位） |
| 全局快捷键 | ✅ | global-shortcut 插件 |
| 桌面悬浮 | ✅ | canJoinAllSpaces + fullScreenAux |
| 输入框聚焦 | ✅ | 弹出后可直接打字 |
| Windows 平台 | ❌ 未测 | 有 cfg 守卫但未实机验证 |

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Tauri v2 |
| 前端 | Vue 3 + TypeScript + Vite |
| AI | OpenAI 兼容接口 |
| 配置 | YAML（js-yaml，编译时转换） |
| 音效 | Web Audio API（OscillatorNode 合成） |
| 包管理 | pnpm（前端）+ Cargo（Rust） |

---

## 📖 文档

- [DES.md](DES.md) — 设计文档，完整玩法/机制说明
- [CLAUDE.md](CLAUDE.md) — AI 开发指引，代码规范/构建/调试

---

## 📝 License

MIT
