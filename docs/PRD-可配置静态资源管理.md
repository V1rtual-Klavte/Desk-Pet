# PRD — 可配置静态资源管理系统 v2

> 状态: P1-P5 ✅ 全部完成 (2026-07-02) | 日期: 2026-07-01

---

## 零、核心原则

> **Profile 即闭包，拖入即用**
> 1. 主题、角色素材、音效映射**全部打包在 Profile 文件夹内**，零外部引用
> 2. 每个 Profile 是一个自包含文件夹，结构统一，`profile.yaml` + `character.yaml` + `body.png` + `frames/`
> 3. CONFIG.yaml 只保留**功能配置**（general / ai / tools），外观配置缩为一行 `activeProfile`
> 4. 内置 Profile 随包发布于 `public/profiles/`，用户 Profile 存放于 `{AppData}/desk-pet/profiles/`
> 5. 导入/导出 = 打包/解压整个 Profile 文件夹

---

## 一、架构总览

```
CONFIG.yaml (功能配置)            Profile 文件夹 (外观闭包)
┌──────────────────────┐          ┌─────────────────────────┐
│ general              │          │ sugar-pink/             │
│   mode / popup       │          │ ├── profile.yaml        │ ← 主题色+音效+字体
│   shortcut / logging │          │ ├── character.yaml      │ ← 角色动画+表情
│   desktop            │          │ ├── body.png            │ ← 立绘
│                       │          │ └── frames/             │ ← 109帧自包含
│ ai                   │          │     ├── idle_000.png    │
│   provider / model   │          │     └── ...             │
│   thinking / loop    │          ├─────────────────────────┤
│   personality        │          │ dark-purple/            │
│   windowMonitor      │          │ └── ... (同上，配色不同) │
│   safety             │          └─────────────────────────┘
│                       │
│ tools                │          设置页:
│   bash / file        │          ┌──────────────────┐
│   mcp / skill        │          │ 🏠 通用          │ → general.*
│                       │          │ 🤖 AI            │ → ai.*
│ appearance           │          │ 🔧 工具          │ → tools.*
│   activeProfile ─────┼────────→ │ 🎨 外观 Profile  │ → 主题+角色+音效 合一
└──────────────────────┘          └──────────────────┘
```

---

## 二、CONFIG.yaml — 功能配置（极简）

只保留 4 个功能域，主题/角色/音效全部移除：

```yaml
# ══════════════════════════════════════════
# 1. 通用设置 (General)
# ══════════════════════════════════════════
general:
  mode: { assistant: false }
  popup: { mode: cursor, autoPopupOnMessage: false, defaultSize: { w: 730, h: 450 } }
  shortcut: { key: "P", macModifiers: ["Control", "Command"], winModifiers: ["Control", "Alt"] }
  logging: { level: info }
  desktop: { pollingIntervalMs: 3000, pauseExtraMs: 5000, waitTimeoutMs: 5000 }

# ══════════════════════════════════════════
# 2. AI 设置 (AI)
# ══════════════════════════════════════════
ai:
  provider: deepseek
  endpoint: https://api.deepseek.com
  apiKey: ""
  requireApiKey: true
  model: deepseek-chat
  contextMaxTokens: 16000
  defaultSystemPrompt: "你叫糖糖..."
  fallbackReplies: [...]
  thinking: { effort: auto, budget: { low: 1000, medium: 4000, high: 16000 } }
  personality:
    enabled: true
    active: angelkawaii
    cards: [...]
  loop: { maxRetry: 3, maxToolCallsPerTurn: 5, toolTimeoutMs: 30000, turnTimeoutMs: 120000, streamEnabled: false, contextCompactAt: 0.95 }
  memory: { maxEntries: 200 }
  lock: { safetyTimeoutMs: 30000 }
  windowMonitor: { enabled: true, staySeconds: 60, settleMs: 2000, ... }
  safety: { mode: tell_me, sessionTrustEnabled: true }

# ══════════════════════════════════════════
# 3. 工具配置 (Tools)
# ══════════════════════════════════════════
tools:
  bash: { enabled: true, whitelist: [...] }
  file: { enabled: true, writeEnabled: false }
  mcp: { enabled: false, servers: [], builtin: { filesystem: {...}, playwright: {...}, ... } }
  skill: { enabled: false, skills: [] }

# ══════════════════════════════════════════
# 4. 外观 — Profile 系统
# ══════════════════════════════════════════
appearance:
  activeProfile: "sugar-pink"     # 当前激活的 Profile ID
```

---

## 三、Profile 文件夹规范

### 3.1 目录结构

```
profile-folder/
├── profile.yaml          # ★ 入口：元数据 + 主题色 + 音效映射 + 字体
├── character.yaml        # ★ 角色：动画帧列表 + 表情关键词 + 内置动画
├── preview.png           # [可选] 设置页预览图
├── body.png              # 角色立绘
├── frames/               # 序列帧 PNG（自包含，零外部引用）
│   ├── idle_000.png
│   ├── idle_001.png
│   └── ...
└── sounds/               # [可选] 自定义音效文件
    └── my-sound.wav
```

### 3.2 profile.yaml — 主题+音效+字体

```yaml
meta:
  name: "糖糖粉"
  description: "默认粉色主题 + 糖糖角色"
  version: 1
  builtin: true

theme:
  colors:
    bg: "#fce4ec"
    border: "#a01a5a"
    borderGradient: ["#fccdd9", "#f7a8c4", "#c4276f", "#a01a5a"]
    text: "#333333"
    accent: "#c4276f"
    chatBg: "#fce4ec"
    divider: "#e8a0b0"
    settingsBg: "#3e1a2e"
    settingsCard: "#2a1020"
  fonts:
    ui: "zpix"
    chat: "zpix"
    size: 14
    lineHeight: 1.6
  shield:
    enabled: false
    image: ""

sound:
  volume: 0.8
  events:
    welcome: "welcome_chord"
    send: "send_short"
    reply: "reply_ding"
    popup: "popup_up"
    retract: "retract_down"
    surface: "surface_light"
    middle: "middle_tremolo"
    deep: "deep_noise"
```

### 3.3 character.yaml — 角色动画+表情

```yaml
character:
  id: "cho"
  name: "糖糖"
  scale: 1.0
  scaleMode: pixelated

animations:
  idle:
    loop: true
    frames:
      - { f: "frames/stream_cho_idle_000.png", d: 5000 }
      - { f: "frames/stream_cho_idle_001.png", d: 250 }
  smile:
    loop: false
    frames:
      - { f: "frames/stream_cho_smile_001.png", d: 100 }
      # ...
  # 共 20 个动画，128 帧引用

expressions:
  - { kw: ["smile", "开心", "哈哈"], anim: "smile" }
  - { kw: ["sleep", "困", "晚安"], anim: "sleepy" }
  - { kw: ["angry", "生气", "滚"], anim: "angry" }
  - { kw: ["love", "喜欢", "chu", "亲"], anim: "chu" }
  - { kw: ["superchat", "sc"], anim: "superchat" }
  - { kw: ["gaoo", "嗷呜"], anim: "gaoo" }
  - { kw: ["business", "办公"], anim: "business1" }
  - { kw: ["you", "你"], anim: "you" }

builtinAnimations:
  - breathing
  - bounce
  - shake
  - wave
  - float
  - tilt
```

---

## 四、加载机制

```
启动 (init.ts)
  │
  ├─ 1. MemoryService.init()
  ├─ 2. initProfiles()
  │      ├── 扫描 public/profiles/ → 发现 ["sugar-pink", "dark-purple"]
  │      ├── 逐个加载: fetch profile.yaml + character.yaml → 解析 → 注册
  │      └── 激活 CONFIG.yaml appearance.activeProfile 指定的 profile
  │
  ├─ 3~7. 人格 / 工具 / 会话 / 欢迎语 / Debug
  │
  └─ 运行时:
       animation.ts → Proxy → getActiveProfile().animations
       expressions.ts → getActiveProfile().expressions
       StreamView.vue → getBodyUrl() + scaleMode
       CSS变量注入 → Active Profile → theme.colors
```

### 4.1 Profile 加载器

`src/services/profile/loader.ts`：

| API | 说明 |
|-----|------|
| `initProfiles()` | 发现 + 加载所有 profile，激活 CONFIG 指定项 |
| `activateProfile(id)` | 运行时切换 profile |
| `getActiveProfile()` | 获取当前激活的完整 ProfileData |
| `listProfiles()` | 列出所有可用 profile 的 id + meta |
| `getBodyUrl()` | 返回 `{basePath}/body.png` |
| `getCharacterScale()` / `getCharacterScaleMode()` | 角色缩放参数 |

### 4.2 动画/表情 — Proxy 动态读取

`animation.ts` 和 `expressions.ts` 不再硬编码数据，改为从 `getActiveProfile()` 动态读取。`animations` 导出使用 ES Proxy，Vue 响应式访问自动路由到当前 profile。

---

## 五、设置页面 Tab 重构

### Tab 内容分配

| Tab | 内容 | 数据来源 |
|-----|------|---------|
| **🏠 通用** | 模式切换、弹窗位置/大小、快捷键、日志级别、桌面轮询 | `general.*` |
| **🤖 AI** | 端点/密钥/模型、思考强度、人格选择、默认人格、记忆、窗口监控、锁、安全 | `ai.*` |
| **🔧 工具** | Bash 白名单、文件写开关、MCP 开关/列表、Skill 开关/列表 | `tools.*` |
| **🎨 外观 Profile** | Profile 选择/切换、主题色预览、音效映射预览、角色预览、**导入/导出/复制/删除** | Profile 系统 |

> 🔊 **声音 Tab 已合并入外观 Profile** — 音效事件映射是 Profile 的一部分，切换 Profile 同时切换主题+角色+音效。

### 🎨 外观 Profile Tab 详情

```
┌─ 🎨 外观 Profile ─────────────────────────────┐
│                                                 │
│  当前 Profile: [糖糖粉 ▼]                        │
│                                                 │
│  ┌─────────┐ ┌─────────┐ ┌──────────────┐      │
│  │ 🎀 糖糖粉 │ │ 🌙 暗夜紫 │ │ ＋ 导入Profile │      │
│  │  内置     │ │  内置     │ │  (拖入.zip)  │      │
│  └─────────┘ └─────────┘ └──────────────┘      │
│                                                 │
│  选中 Profile 详情:                              │
│  ┌─────────────────────────────────────────┐   │
│  │ [preview.png]                           │   │
│  │ 名称: 糖糖粉   角色: 糖糖 (cho)          │   │
│  │ 字体: zpix 14px  缩放: pixelated 1.0×   │   │
│  │                                          │   │
│  │ ── 主题色 ──                             │   │
│  │ ■ 背景  ■ 边框  ■ 文字  ■ 强调          │   │
│  │ ■ 聊天  ■ 分割  ■ 设置  ■ 卡片          │   │
│  │                                          │   │
│  │ ── 音效映射 ──                           │   │
│  │ 启动:welcome_chord  发送:send_short      │   │
│  │ 弹窗:popup_up  收回:retract_down         │   │
│  │ ... [展开全部]                           │   │
│  │                                          │   │
│  │ 素材: 109帧 (~1.7MB)                    │   │
│  │                                          │   │
│  │ [导出Profile] [复制并编辑] [删除]         │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  ⚠️ 内置Profile不可删除，可复制后编辑             │
└─────────────────────────────────────────────────┘
```

---

## 六、Profile 导入/导出流水线

```
导出 Profile:
  选中 Profile → "导出" → 打包文件夹为 .zip
  sugar-pink.zip
  ├── profile.yaml
  ├── character.yaml
  ├── body.png
  ├── preview.png
  └── frames/*.png

导入 Profile:
  拖入 .zip 或文件夹
       │
       ▼
  验证结构（必须有 profile.yaml + body.png）
       │
       ▼
  解压/复制到 {AppData}/desk-pet/profiles/{name}/
       │
       ▼
  刷新 Profile 列表 → 即时可用
```

### 角色导入（轻量模式）

如果用户只有单张/多张图片而没有完整 profile：

```
单张图片 → 创建最小 profile 包
  ├── profile.yaml  (默认糖糖粉主题)
  ├── character.yaml (idle 单帧 + 7 个 builtin 动画)
  ├── body.png ← 用户上传的图
  └── frames/ (只有 body.png)

多张序列帧 → 智能分组识别
  ├── mychar_idle_000.png → 识别为 idle 动画 × 2帧
  ├── mychar_idle_001.png
  ├── mychar_happy_000.png → 识别为 happy 动画 × 2帧
  └── mychar_happy_001.png
  → 自动写入 character.yaml
```

---

## 七、资源目录分层

```
# ── 内置资源（git 追踪，随包发布）──
public/
├── profiles/                       # ★ Profile 系统（自包含）
│   ├── sugar-pink/                 # 内置 Profile
│   │   ├── profile.yaml
│   │   ├── character.yaml
│   │   ├── body.png
│   │   └── frames/                 # 109 帧
│   └── dark-purple/                # 内置 Profile
│       ├── profile.yaml
│       ├── character.yaml
│       ├── body.png
│       └── frames/                 # 109 帧
│
└── assets/
    ├── fonts/                      # 全局字体
    │   ├── zpix.ttf
    │   ├── PixelMplus10-Regular.ttf
    │   └── PixelMplus10-Bold.ttf
    └── ui/                         # UI chrome
        ├── windows/
        ├── Fromtemd/
        ├── jine/
        └── photo/

# ── 用户资源（Tauri AppData，非 git）──
{AppData}/desk-pet/
├── profiles/                       # 用户导入/创建的 Profile
│   └── my-custom/
│       ├── profile.yaml
│       ├── character.yaml
│       ├── body.png
│       ├── frames/
│       └── sounds/                 # [可选] 自定义音效
└── user-overrides.yaml             # CONFIG 覆盖持久化
```

---

## 八、内置动画引擎（7 种 CSS Transform）

| 动画名 | CSS 实现 | 用途 |
|--------|----------|------|
| `breathing` | `scale(1) → scale(1.03) → scale(1)` | idle 微动 |
| `bounce` | `translateY(0) → translateY(-8px) → translateY(0)` | 高兴 |
| `shake` | `rotate(0) → rotate(3deg) → rotate(-3deg)` | 摇头 |
| `wave` | `rotate` on pseudo-element | 挥手 |
| `blink` | `clip-path`/opacity 切换 | 眨眼 |
| `float` | `translateX+Y` 椭圆轨迹 | 悬浮 |
| `tilt` | `rotate(-5deg)` 单次 | 歪头 |

内置动画**不需要任何素材**，在单张 body PNG 上直接生效。定义在 `character.yaml` 的 `builtinAnimations` 字段。

---

## 九、CSS 变量注入

所有颜色/字体从**当前激活的 Profile** 注入：

```css
#root {
  --color-bg:            #fce4ec;
  --color-border:        #a01a5a;
  --color-border-gradient: #fccdd9, #f7a8c4, #c4276f, #a01a5a;
  --color-text:          #333;
  --color-accent:        #c4276f;
  --color-chat-bg:       #fce4ec;
  --color-divider:       #e8a0b0;
  --color-settings-bg:   #3e1a2e;
  --color-settings-card: #2a1020;
  --font-ui:             "zpix";
  --font-chat:           "zpix";
  --font-size:           14px;
  --font-line-height:    1.6;
}
```

切换 Profile → CSS 变量更新 → 全局换肤即时生效。

---

## 十、实施分期

| Phase | 内容 | 状态 |
|-------|------|------|
| **P1** ✅ | CONFIG.yaml 结构重组 + config.ts 适配 + 资源目录分层 + 路径替换 | 2026-07-02 |
| **P2** ✅ | 设置页 Tab 化重构（4 Tab：通用/AI/工具/外观Profile） | 2026-07-02 |
| **P3** ✅ | Profile 架构落地：动画/表情/UI/字体全部从 profile 加载 | 2026-07-02 |
| **P4** ✅ | CSS 变量主题系统 + global.css 重构 + 字体动态注入 | 2026-07-02 |
| **P5** ✅ | Profile 导入/导出 .zip + 删除 + Rust 后端文件命令 | 2026-07-02 |

---

## 十一、模块清单

| 模块 | 文件 | 说明 |
|------|------|------|
| Profile 加载器 | `src/services/profile/loader.ts` | 发现/加载/激活 profile |
| Profile 导出 | `src/services/profile/index.ts` | 统一导出 + 类型 |
| 动画系统 | `src/services/animation.ts` | Proxy 动态读取 profile.animations |
| 表情匹配 | `src/services/expressions.ts` | 动态读取 profile.expressions |
| 配置 | `src/services/config.ts` | appearance 极简化，仅 activeProfile |
| 角色显示 | `src/components/StreamView.vue` | 动态 bodyUrl + scaleMode |
| 初始化 | `src/services/init.ts` | Step 2: Profile 初始化 |
| 设置页 | `src/components/SettingsPanel.vue` | P2 重构为 4 Tab |
| CSS 变量 | `src/styles/global.css` | P4 替换硬编码颜色为 var(--color-*) |
