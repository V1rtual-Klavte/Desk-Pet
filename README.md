# 🍬 糖糖桌宠 (Desk Pet)

> 像素风桌面虚拟主播 — 常驻桌面，能聊天、能用工具、能看你窗口、能主动搭话。
>
> **v5: 单次 LLM 回复，Card 永远激活（neutral 兜底），变量池统一 VariableState 格式**

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/Klavte/Desk-Pet)
[![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4fc08d)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-🦀-dea584)](https://www.rust-lang.org)

---

## ✨ 功能

- **桌面常驻** — 无边框透明窗口，角色在所有桌面/全屏 Space 悬浮
- **AI 聊天** — 人格卡驱动，Agent Loop 多轮工具调用，兼容 OpenAI / DeepSeek / Ollama
- **会话管理** — 多会话标签页，切换/新建/关闭，拖动调整面板，自动归档，启动恢复
- **工具系统** — AI 可调用：文件读写/搜索、Bash、系统信息、HTTP、剪贴板、变量读写、子代理
- **助手模式** — 解锁写文件/全量Bash/打开应用/剪贴板/MCP/Skill/子代理(fork/team)
- **Agent Loop v5** — 单次 LLM 调用 + 工具循环，思考强度可选，上下文自动压缩
- **人格系统** — Card 驱动，内置 4 张（neutral/angelkawaii/ame/pchan），支持用户导入，事务式热切换
- **变量池 v2** — 四类变量（system/card/interaction/session），运行时=持久化同格式（VariableState）
- **When 引擎** — 条件规则驱动角色行为进化（不理她太久会从甜蜜变病娇）
- **窗口感知** — 监控前台窗口，停留超时后 AI 主动搭话
- **安全控制** — 四级安全（SAFE/NORMAL/DANGER/NOWAY）+ 三策略 + 确认弹窗
- **记忆系统** — MEMORY.md 结构化注册表 + sessions/ 实时写入 + LLM 整理
- **Profile 主题** — 3 套内置预设（糖糖粉/暗夜紫/透明玻璃），一键切换，CSS 变量自动派生
- **灵动图层** — 五层景深视差，60fps 光标追踪，CSS 3D 增强，设置页逐层配置
- **音效系统** — 33 个内置音效（8 类），Web Audio 合成无需外部文件
- **设置面板** — 独立窗口，外观/AI/安全/监控/人格/工具/MCP/Skill/快捷键全可配
- **MCP 支持** — 内置 MCP Server（Filesystem/BraveSearch/Playwright/Git/GitHub），stdio 传输
- **Skill 编排** — 3 个内置 Skill（summarize-code/organize-files/check-weather），子循环执行
- **系统托盘** — 关闭隐藏到托盘，单击恢复；Dock/任务栏点击屏幕中央弹出
- **Windows 模拟器** — 彩蛋：像素风 Win7 桌面（输入 `open win`）

---

## 🔄 双模式

| 能力 | 轻量模式 | 助手模式 |
|------|:---:|:---:|
| AI 聊天 + 人格系统 | ✅ | ✅ |
| 窗口感知主动搭话 | ✅ | ✅ |
| 文件读/列/搜 + 系统信息 + Bash白名单 + HTTP | ✅ | ✅ |
| 变量读写（var_read/write/list/delete） | ✅ | ✅ |
| 文件写/删 + 全量Bash + 打开应用 + 剪贴板 | ❌ | ✅ |
| MCP 服务器（内置5个+自定义） | ❌ | ✅ |
| Skill 编排 | ❌ | ✅ |
| 子代理 agent.spawn（fork/team） | ❌ | ✅ |
| 安全确认弹窗 | ❌ | ✅ |

---

## 🚀 快速开始

### 前置

- Node.js ≥ 18 + pnpm
- Rust toolchain
- macOS: Xcode Command Line Tools

### 安装

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
├── CONFIG.yaml / CONFIG-DEV.yaml     # 全局配置（YAML → Vite Plugin → config.ts）
├── CLAUDE.md                         # AI 开发指引
├── docs/                             # 设计文档
│   ├── DES.md                        # 核心设计（玩法/机制）
│   ├── 架构方案.md                     # v2 架构方案
│   ├── 架构设计文档.docx               # 原始架构设计
│   ├── DESIGN_ORIGIN.md              # 原始设计记录
│   ├── DESIGN-REPLY-v4.md            # v4 回复生成设计
│   ├── DESIGN-REPLY-v5.md            # v5 回复生成设计
│   ├── DESIGN-VARIABLE-POOL-v2.md    # 变量池 v2 设计
│   ├── FIX-AGENTLOOP-v5.md           # Agent Loop v5 修复记录
│   ├── PRD-可配置静态资源管理.md        # 静态资源管理 PRD
│   ├── 灵动图层设计.md                 # 灵动图层设计文档
│   ├── 阶段现状-2026.7.17.md           # 阶段现状记录
│   ├── 阶段现状-2026.7.21.md           # 阶段现状记录
│   └── superpowers/                  # Superpowers 计划
│
├── src/                              # Vue 3 + TypeScript 前端
│   ├── App.vue                       # 根组件
│   ├── components/
│   │   ├── ChatPanel.vue             # 聊天面板
│   │   ├── StreamView.vue            # 灵动图层渲染
│   │   ├── SessionTabs.vue           # 会话标签页
│   │   ├── SettingsPanel.vue         # 设置面板（独立窗口）
│   │   ├── DebugBar.vue              # 底部状态栏
│   │   ├── settings/                 # 设置页各 Tab（AI/外观/工具/通用）
│   │   └── winsim/                   # Windows 模拟器彩蛋
│   ├── composables/
│   │   ├── useParallax.ts            # 灵动图层 60fps 视差
│   │   └── useLayerEditor.ts         # 图层编辑器状态
│   └── services/
│       ├── engine/                   # Agent Loop v5 + 会话 + compactor 压缩 + Slash命令
│       ├── personality/              # 人格模块（Card/Stages/变量池/When引擎/Middleware）
│       │   ├── cards/                # 内置 Card .md（4张）
│       │   └── stages/               # 内置 Stages JSON（LLM 生成）
│       ├── agent/                    # Provider + Runner + Sub-agent(fork/team) + Sub-loop + Memory + Active
│       │   └── memory/               # 记忆 IO + 整理 + 条目 + 解析 + 会话文件(7 files)
│       ├── tool/                     # 工具注册表 + 路由（local/extra/skill/mcp）
│       ├── safety/                   # 四级安全 + 确认弹窗
│       ├── context/                  # System Prompt 构建
│       ├── reply/                    # 回复后处理（emo标签+表情+音效）
│       ├── session/                  # 多会话持久化管理
│       ├── profile/                  # Profile 主题系统
│       ├── audio/                    # 33音效 Web Audio 合成
│       ├── window/                   # 前台窗口监控
│       ├── init.ts                   # 服务初始化入口
│       └── paths.ts                  # 统一路径管理
│
├── src-tauri/                        # Rust 后端
│   └── src/
│       ├── lib.rs                    # 入口 + 注册所有 commands
│       ├── paths.rs                  # AppPaths 路径管理
│       ├── window/                   # 主窗口 + 设置窗口
│       ├── monitor/                  # 窗口监控 + 光标追踪
│       └── commands/                 # 10 Tauri commands（工具/记忆/人格/Profile/光标/日志/MCP桥/监控/模拟器）
│
├── skills/                           # Skill 定义（3个内置 .md）
├── public/profiles/                  # Profile 主题素材
│   ├── sugar-pink/ dark-purple/ glass/
└── data/desk-pet/                    # 运行时数据（开发环境）
    ├── memory/                       # 长期记忆文件
    ├── sessions/                     # 会话归档
    └── personality/
        ├── stages/{cardId}.json      # 阶段文案 + 变量状态
        └── vars.json                 # 系统变量快照
```

---

## 📐 核心数据流 (v5)

```
用户消息 → PreProcessor → refreshVariablePool() + When引擎
  → buildPrompt(card全量: 角色/风格/情绪/When语气/行为准则/变量池/记忆)
  → 单次LLM(永远非流式) → runToolLoop(安全→执行)
  → generateReply(raw, card) → 剥离[emo:key] + 表情/音效映射
  → ReplyResult {text, emotionKey, expression, sound}
  → var_write即时落盘 stages/{cardId}.json
```

---

## 🎛 设置面板

独立窗口，标题栏按钮打开：

| 类别 | 配置项 |
|------|--------|
| 外观 | Profile 选择 / 预设切换 / 18色配色 / 字体 / 灵动图层逐层配置 / 导入导出 |
| AI | 端点 / 密钥 / 模型 / 上下文 tokens / 思考强度 |
| 人格 | 选择人格卡（热切换） / 查看变量池 / 编辑阶段文案 |
| 监控 | 窗口监控开关 / 停留秒数 / 防抖 / 冷却 |
| 安全 | 四级安全策略选择 |
| 弹窗 | 位置模式 / 大小 / 自动弹出 |
| 快捷键 | 录制自定义组合键 |
| 工具 | Bash 白名单 / 文件写开关 |
| MCP | 服务器列表增删改 / JSON 导入导出 |
| Skill | 已配置列表 / 上传 .md 添加 / 删除 |
| CONFIG | 导入导出 YAML |

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Tauri v2 |
| 前端 | Vue 3 + TypeScript + Vite |
| AI | OpenAI 兼容接口（支持 reasoning_effort / tool_calls） |
| 配置 | YAML（js-yaml，Vite 编译时转换） |
| 音效 | Web Audio API（OscillatorNode 合成） |
| 包管理 | pnpm（前端）+ Cargo（Rust） |

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
| 内存信息 | ✅ vm_stat | ✅ GlobalMemoryStatusEx |
| 系统通知 | ❌ 未签名构建不支持 | — |

---

## 📖 文档

- [CLAUDE.md](CLAUDE.md) — AI 开发指引（规范/构建/调试/标准格式）
- [docs/DES.md](docs/DES.md) — 设计文档（玩法/机制）
- [docs/架构方案.md](docs/架构方案.md) — v2 完整架构方案
- [docs/架构设计文档.docx](docs/架构设计文档.docx) — 原始架构设计
- [docs/DESIGN_ORIGIN.md](docs/DESIGN_ORIGIN.md) — 原始设计记录
- [docs/DESIGN-REPLY-v4.md](docs/DESIGN-REPLY-v4.md) — v4 回复生成设计
- [docs/DESIGN-REPLY-v5.md](docs/DESIGN-REPLY-v5.md) — v5 回复生成设计
- [docs/DESIGN-VARIABLE-POOL-v2.md](docs/DESIGN-VARIABLE-POOL-v2.md) — 变量池 v2 设计
- [docs/FIX-AGENTLOOP-v5.md](docs/FIX-AGENTLOOP-v5.md) — Agent Loop v5 修复记录
- [docs/PRD-可配置静态资源管理.md](docs/PRD-可配置静态资源管理.md) — 静态资源管理 PRD
- [docs/灵动图层设计.md](docs/灵动图层设计.md) — 灵动图层设计文档
- [docs/阶段现状-2026.7.17.md](docs/阶段现状-2026.7.17.md) — 阶段现状记录
- [docs/阶段现状-2026.7.21.md](docs/阶段现状-2026.7.21.md) — 阶段现状记录
- [docs/superpowers/](docs/superpowers/) — Superpowers 计划

---

## 📝 License

MIT
