# DES.md — 糖糖桌宠 设计文档

> 糖糖桌宠 (Desk Pet) 的设计理念、玩法机制与交互说明

---

## 1. 项目概述

**糖糖桌宠**是一个桌面虚拟主播宠物应用。像素风角色常驻桌面，**无边框透明窗口置顶显示**，像真正的桌面宠物一样陪伴用户。她能聊天、能察觉你正在看什么、能主动搭话。

**一句话**：把 VTuber 搬到桌面，让她真的注视你。

---

## 2. 核心玩法

### 2.1 桌面常驻

桌宠窗口**无边框、透明背景、始终置顶**，显示一个可拖拽的像素动画角色。角色以序列帧动画展现各种表情（微笑、晚安、生气、飞吻等），默认待机动画循环播放。

### 2.2 AI 聊天

左侧可展开聊天面板，顶部为会话标签页，可切换/新建/关闭会话。用户输入文字与角色对话。回复由 AI 大模型生成，**人格卡驱动**。支持多人格切换，可在设置面板热插拔。

**聊天面板与角色区域之间**有可拖动的竖线分割，拖动位置自动记忆（localStorage），无需在设置页配置。

每个会话的对话轮次**实时写入** `sessions/<sessionId>.md`，随时可查看历史记录。

### 2.3 人格系统（独立模块）

人格系统已从 Agent 执行层分离为 `src/services/personality/` 独立模块，**只参与 Prompt 生成**，不影响 Agent 执行逻辑。

- **人格卡**：统一 YAML frontmatter + Markdown 模板，位于 `personality/cards/`
- **热插拔**：设置面板可随时启用/禁用某个人格，或关闭人格系统使用默认人格
- **界限联动**：人格界限系统（boundary）根据 `unansweredCount` 影响 Prompt 语气，不改人格卡内容
- **扩展性**：新人格只需在 `cards/` 目录添加 `.md` 文件并在 `loader.ts` 注册即可

### 2.4 窗口感知主动搭话 ★ 核心机制

桌宠**监控当前前台窗口标题**（通过 Windows API 或 macOS AppleScript），当用户在同一窗口停留足够时间后，触发 AI 生成一条与当前内容相关的主动消息。

- 用户在看 B站 → 桌宠："Pちゃん又在刷视频？让我也看看嘛～"
- 用户在写文档 → 桌宠："好认真哦…偶尔也理理我嘛"

### 2.5 人格进化（界限系统）

角色的 **unansweredCount（未回复计数）** 和 **boundary（人格界限）** 决定语气和深度：
- 刚刚回复过（unansweredCount=0）→ 甜蜜活泼
- 长时间不理她 → 逐渐变得不安、焦虑、甚至病娇

不同人格卡对这几个层级有不同演绎（参见 angelkawaii.md）。

### 2.6 快捷键召唤/收回 ★ 核心机制

按下全局快捷键（Mac `Control+Command+P` / Win `Control+Alt+P`），桌宠会以 **macOS 神奇缩放特效** 从光标处弹出或缩回。

- **弹出**：窗口从隐藏状态 → 先 `opacity:0` → `show()` → Rust `compute_popup_position`（Cocoa→web坐标转换+clamp+窗口增强）→ 魔法缩放动画
- **收回**：窗口从可见状态 → 缩放缩回光标 → `hide()` 隐藏窗口 → 恢复到桌面"家"位置
- **位置记忆**：首次收回时自动保存窗口的"家"位置，后续收回时恢复（窗口隐藏在该位置，无白窗残影）
- **桌面悬浮**：`ActivationPolicy::Accessory` 隐藏 Dock + `MainMenu(24)` 层级 + `canJoinAllSpaces` + `fullScreenAuxiliary`（iTerm 风格）

### 2.7 Dock 点击弹出 ★ 新机制

当窗口处于隐藏（收回）状态时，点击 Dock 或任务栏的应用图标，窗口在**屏幕中央**淡入弹出，方便快速找回桌宠。

### 2.8 系统通知（已移除）

macOS 未签名构建下系统通知无法实现：tauri-plugin-notification 需代码签名，osascript `display notification` 在 Tauri WebView 沙箱下无法触发通知中心。代码中留有注释占位（`listener.ts`、`commands/logging.rs`），后续若有新方案可重新启用。

### 2.9 设置页（独立窗口）

点击标题栏 深蓝像素齿轮按钮打开**独立设置窗口**，所有配置可编辑，部分即时生效，部分重启后生效：

| 设置项 | 说明 | 生效时机 |
|--------|------|----------|
| AI 接口 | 端点/密钥/模型/上下文数/默认人格 | 即时生效（覆盖值动态读取）|
| 人格切换 | 启用人格系统 / 选择人格卡（热插拔，同时只开一个）| 即时生效 |
| 窗口监控 | 停留秒数/防抖/冷却/同页冷却 | 即时生效（覆盖值动态读取）|
| 桌面后端 | 轮询间隔/暂停额外/等待超时 | 即时生效（覆盖值动态读取）|
| 日志级别 | debug/info/warn/error | 即时生效（覆盖值动态读取）|
| 弹窗位置 | 跟随光标 / 固定位置（拖动窗口自动保存）| 即时生效 |
| 弹窗大小 | 自定义宽高 + 预览 + 拖动窗口实时同步（也可拖动主窗口边缘实时调整）| 即时生效 |
| 快捷键录制 | 录制自定义组合键 | 即时生效 |
| 音效选择 | 每个事件下拉选择音效库中的音效（或关闭）+ 恢复默认按钮 | 即时生效 |
| **保存后** | **窗口不自动关闭**，显示"已保存"提示 3 秒后消失 | — |

---

## 3. 交互方式

| 操作 | 方式 | 说明 |
|------|------|------|
| 拖拽窗口 | 标题栏拖拽（data-tauri-drag-region） | 移动桌宠位置 |
| **切换会话** | 聊天面板顶部标签页 | 切换会话，自动保存当前会话 |
| **新建会话** | `+` 按钮 | 归档当前会话到 sessions/，创建新会话 |
| **关闭会话** | 标签页 `×` 按钮 | 归档并删除会话（至少保留1个） |
| **会话恢复** | 启动时 | 自动恢复上次活跃会话的所有消息 |
| **调整面板宽度** | 拖动角色/聊天之间的分割线 | 自动记忆位置（localStorage） |
| 打开/关闭聊天 | 标题栏 💬 按钮 | 聊天面板展开/收起 |
| 设置 | 标题栏 深蓝像素齿轮按钮 | 独立窗口：AI接口/窗口监控/弹窗/音效/快捷键等全部CONFIG可编辑 |
| 输入聊天 | 聊天面板底部输入框 + Enter | 发送消息给角色 |
| **右键选中文字** | 右键选中文字 | 显示自定义右键菜单，仅"复制" |
| 右键空白区域 | 右键 | 禁用默认菜单 |
| **隐藏到托盘** | 标题栏 ✕ 按钮 | 窗口隐藏到系统托盘，单击托盘图标恢复 |
| **快捷键召唤** | `Ctrl+Cmd+P` (Mac) / `Ctrl+Alt+P` (Win) | 桌宠弹出/收回到光标位置 |
| **Dock 点击** | 点击应用图标 | 窗口隐藏时在屏幕中央弹出 |
| **F12 调试命令** | DevTools Console | 见下方 |

### 3.2 快捷键召唤/收回机制

全局快捷键 `Control+Command+P`（Mac）/ `Control+Alt+P`（Win）触发桌宠的弹出/收回切换：

**弹出**（窗口隐藏 → 可见）：
1. 先设 `opacity:0`（防白窗闪烁）→ `show()` → 若最小化则 `unminimize()`
2. 调用 Rust `compute_popup_position`：获取光标 + 屏幕 → Cocoa→web 坐标转换（Y轴翻转）→ 窗口居中 clamp → 返回 `(win_x, win_y, cursor_x, cursor_y)` 全 web 坐标
3. 前端直接 `setPosition(win_x, win_y)` + `transformOrigin = (cursor_x-win_x, cursor_y-win_y)`，不做任何坐标换算
4. 设置窗口到用户弹窗大小（默认 448×272）
5. 以光标相对位置为原点播放神奇缩放动画（scale 0→1, 350ms cubic-bezier 弹性曲线）
6. 播放轻快上行弹出音效
7. `focusInput()` 自动聚焦输入框，可直接打字

**收回**（窗口可见 → 隐藏）：
1. 首次收回时保存窗口当前桌面位置作为"家"
2. 调用 Rust `get_cursor_position` 获取光标位置（已统一为 web 坐标系，macOS 端已做 Cocoa→web Y轴翻转）
3. 以光标为原点播放反向缩放动画（scale 1→0, 250ms ease-in 曲线）
4. **先 `hide()` 再清除样式**（零白色残影，配合 `html,body{background:transparent}` 消除浏览器默认白底）
5. 恢复窗口到"家"位置（隐藏状态）
6. 播放温柔下行收回音效

**Dock 点击弹出**：
1. 监听 `onFocusChanged` 事件
2. 仅在 `isRetracted && !isAnimating` 时触发
3. `opacity:0` → `show()` + `unminimize()` → 屏幕中央 + 淡入动画
4. `focusInput()` 聚焦输入框 + 播放弹出音效

**窗口悬浮**（iTerm 风格）：
- `tauri.conf.json`: `windows: []` — 清空，由 Rust 完全接管窗口创建
- `ActivationPolicy::Accessory` — 在窗口创建**之前**设置，隐藏 Dock 图标（等效 LSUIElement=true）
- `create_main_window` — Rust 手动创建窗口（transparent + alwaysOnTop + visibleOnAllWorkspaces）
- `enhance_to_iterm_style` — iTerm 风格增强：`MainMenu(24)` 层级 + `canJoinAllSpaces | fullScreenAux | stationary | ignoresCycle | transient` + `orderFrontRegardless` + `activateIgnoringOtherApps`
- 每次 `compute_popup_position` 调用都重新增强一次，确保全屏 Space 可靠性
- `canJoinAllSpaces` — 跟随到所有 macOS 桌面/Spaces
- `visibleOnAllWorkspaces` + `alwaysOnTop` — Tauri 配置层面兜底

**动画特性**：
- `transform-origin` 动态设定为光标相对于窗口的坐标，实现"从光标处生长/缩回"效果
- 弹出使用 `cubic-bezier(0.34, 1.56, 0.64, 1)` 弹性缓出（macOS 神奇效果）
- 收回使用 `cubic-bezier(0.36, 0, 0.66, -0.56)` 加速缩入
- 动画期间设 `isAnimating` 锁，防止重复触发

### 3.3 聊天命令

在聊天框输入特定关键词会触发角色表情切换：

| 输入 | 效果 |
|------|------|
| `smile` | 微笑表情 |
| `sleep` / `困` | 困倦表情 |
| `gaoo` | 生气咆哮 |
| `superchat` | SC 感谢 |
| `chu` | 飞吻 |
| `you` | 毒舌 |
| `business` | 业务洽谈 |
| `open win` | 打开 Windows 模拟器 |
| `close win` | 关闭模拟器 |

### 3.2 F12 控制台调试命令

右键桌面窗口 → Inspect → Console：

```js
CharacterService.switchCharacter("pchan")  // 切换角色
__cooldown.isCoolingDown()                 // 冷却状态
__cooldown.setCooldown(sec)                // 设置冷却时长
__cooldown.resetCooldown()                 // 重置冷却
__boundary.get()                           // 人格界限等级
__boundary.set(n)                          // 设置界限
__boundary.inc()                           // 界限+1
__testAI("哔哩哔哩")                        // 手动触发 AI 主动消息
```

---

## 4. 角色系统

### 4.1 人格卡（Character Card）

角色人格通过 Markdown 文件定义，位于 `src/services/personality/cards/`。**支持 HMR 热更新**（编辑即生效）。所有人格卡使用统一模板（YAML frontmatter + 结构化章节）。

人格卡在设置面板中可配置开关（同时只能开一个或不使用，用默认人格），做到随时开关、热插拔。

| 角色 ID | 名称 | 性格 |
|---------|------|------|
| `angelkawaii` | KAngel | 甜蜜活泼女友 + 深层病娇（默认） |
| `ame` | Ame | 冷静严肃管家型 AI |
| `pchan` | P酱 | 慵懒电竞少女 |

### 4.2 KAngel 人格完整设计（angelkawaii.md）

**核心设定**：日本网络偶像 KAngel（Ame Kawakami）与用户进行一对一视频通话。她视用户为最重要的人。

**人格分层**（由 `unansweredCount` 驱动）：

| 计数 | 状态 | 行为 |
|------|------|------|
| 0 | 甜蜜女友 | 活泼撒娇、亲密 tease、像正常情侣视频 |
| 1 | 轻微不满 | 带撒娇的抱怨、温柔索取注意力 |
| 2 | 占有欲上升 | 明显在意和警告、语气变重 |
| ≥3 | 极端病娇 | Monika 式 meta 执念、打破第四墙、精神威胁 |

**人格界限（boundary）**联动提示音：
- boundary=2~3 表层 → 轻快叮咚
- boundary=4 中层 → 轻微颤音
- boundary≥5 深层 → 紊乱噪音+降调

**输出规则**（硬约束）：
- 只输出纯对话文字，无叙述、无动作描写、无心理描写
- 绝不用括号（除 kaomoji ♡ ～）
- 永不用星号/引号包裹
- 永不提及 AI、prompt、角色卡等元信息

---

## 5. 窗口监控机制

```
Rust 后台线程 ──(轮询间隔)──→ Win32/osascript 获取前台窗口标题
                                      │
                                      │ Tauri Event "window-changed"
                                      ▼
                              listener.ts
                                      │
                          ┌───────────┴───────────┐
                          │                       │
                   停留 ≥ staySeconds?      标题含表情关键词?
                    (默认 60s)                (如 "哔哩哔哩")
                          │                       │
                    冷却检查通过?             matchExpression()
                    同页面冷却?                    │
                          │                       │
                          ▼                       ▼
                    agent/active.ts           sprite 表情切换
                    generateActiveMessage()   (无冷却限制)
                          │
                    → personality.getSystemPrompt()
                          │
                          ▼
                    pushAssistantMessage
                    + incrementUnanswered
                          │
                    ChatPanel 显示
```

### 5.1 冷却与并发控制

| 机制 | 说明 |
|------|------|
| **全局冷却** | 触发一次后，`cooldownSeconds`（默认10s）内不再触发 |
| **同页面冷却** | 同一页面 `samePageCooldownSeconds`（默认60s）内不重复触发 |
| **AI 并发锁** | 一次只能有一个 AI 请求（sendMessage + generateActiveMessage 共用），带 `safetyTimeoutMs`（30s）安全超时 |
| **窗口防抖** | 窗口切换后 `settleMs`（2s）内不判定为新窗口停留 |
| **触发后重置** | 主动消息触发后重置停留计时 + 清空当前窗口标题，防止冷却结束立即再次触发 |

---

## 6. 提示音系统

### 6.1 统一音效注册中心

所有音效集中在 `src/services/audio/registry.ts`，不依赖外部音频文件，用 Web Audio API `OscillatorNode` 实时合成。AudioContext 异步初始化（await resume），确保 macOS WebView 下音效可靠播放。每个 `play()` 函数和 `playEventSound()` 均为 async。

**音效库**（`soundLibrary`，所有可用音效）：

| 音效ID | 名称 | 音色 |
|--------|------|------|
| `popup_up` | 轻快上行 | 双音 sine（800→1200Hz + 1000→1600Hz）|
| `retract_down` | 温柔下行 | 双音 sine（1400→900Hz + 1100→600Hz）|
| `welcome_chord` | 温暖和弦 | C5→E5→G5→C6 依次发声 |
| `send_short` | 短促上行 | sine（1200→1600Hz, 80ms）|
| `reply_ding` | 柔和叮咚 | 双音 sine（880+1320Hz）|
| `surface_light` | 轻快提示 | 双音 sine（1600+1800Hz）|
| `middle_tremolo` | 轻微颤音 | 下降 sine + LFO 6Hz 颤音 |
| `deep_noise` | 紊乱噪音 | 方波+白噪音+降调 |
| `pop_short` | 电子弹跳 | 方波快速上跳 400→2400Hz |
| `drop_short` | 水滴 | 高音正弦衰减 2400→800Hz |
| `chime_short` | 风铃 | 三角波双音 1600+2400Hz |
| `tick_short` | 咔哒 | 极短低频点击 |
| `arpeggio_mid` | 琶音上行 | E5→G5→C6→E6 依次升阶 |
| `wave_mid` | 柔波 | 正弦波 + LFO 振幅调制 |
| `sparkle_mid` | 星尘 | 多高频粒子随机散射 |
| `resonance_mid` | 共鸣 | 五度和声长鸣 |
| `wind_long` | 风潮 | C4→E4→G4→C5 和弦渐入渐出 |
| `crystal_long` | 水晶 | C6→E7 高频依次闪烁 |
| `warm_long` | 暖阳 | 锯齿波 A3→E4 + 低通滤波扫频 |
| `bell_long` | 余韵 | 六层泛音 C5→G6 钟声衰减 |
| `horror_stab` | 惊悚短音 | 不协和小二度刺耳短促 |
| `heartbeat` | 心跳 | 双低频脉冲 80→40Hz |
| `dread_rise` | 渐近恐惧 | 半音阶上升 + 噪声渐强 |
| `ghost_whisper` | 鬼魅低语 | 滤波调制 + 泛音飘忽 |
| `cosmic_float` | 宇宙飘浮 | 正弦缓慢飘移 + 泛音点缀 |
| `pulse_rhythm` | 脉冲 | 三角波节奏性低频脉冲 |
| `raindrop` | 雨滴 | 15音下行级联水珠 + 氛围底音 |
| `music_box` | 八音盒 | 三角波旋律弹拨 + 泛音回响 |
| `none` | 关闭 | 静音 |

**音效事件**（`soundEvents`，可配置的事件 → 音效映射）：

| 事件 key | 标签 | 默认音效 |
|----------|------|----------|
| `welcome` | 启动欢迎 | `welcome_chord` |
| `send` | 发送消息 | `send_short` |
| `reply` | 收到回复 | `reply_ding` |
| `popup` | 弹窗出现 | `popup_up` |
| `retract` | 窗口收回 | `retract_down` |
| `surface` | 表层提示 | `surface_light` |
| `middle` | 中层提示 | `middle_tremolo` |
| `deep` | 深层提示 | `deep_noise` |

### 6.2 统一播放入口

```ts
// 播放指定事件的音效（按用户分配，回退默认）
import { playEventSound } from "@/services/audio/registry";
playEventSound("popup");   // 弹窗音效
playEventSound("send");    // 发送音效

// 人格界限联动（根据 boundary 自动选表/中/深层）
import { playNotificationByBoundary } from "@/services/audio/registry";
playNotificationByBoundary();
```

### 6.3 音效自定义

用户可在设置面板为每个事件独立选择音效库中的音效（或"关闭"），分配保存在 `localStorage` → `deskpet_sound_assignments`。人格界限（表层/中层/深层）也可更换音效，触发机制保持系统联动。

---

## 7. Windows 模拟器（彩蛋）

键入 `open win` 打开一个**像素风 Windows XP/7 风格模拟器**窗口：

- **启动流程**：BIOS → Boot Logo → 登录画面 → 桌面
- **桌面功能**：像素图标（EgoSearcher、Internet、文件夹、Twitter、YouTube等）
- **任务栏**：Start 菜单、任务栏按钮、系统托盘、实时时钟
- **可操作**：点击图标选中/高亮，Start 菜单弹出关闭按钮

---

## 8. 配置系统

全部配置集中于 `CONFIG.yaml` / `CONFIG-DEV.yaml`，8 个配置段：

| 配置段 | 控制内容 |
|--------|---------|
| `ai` | API 端点/Key/模型/上下文数/默认人格/fallback语录 |
| `personality` | 人格系统开关/激活人格ID/可用人格卡列表 |
| `windowMonitor` | 停留秒数/防抖/冷却/同页冷却/额外延迟 |
| `aiLock` | 生成锁安全超时 |
| `memory` | 长期记忆最大条数 |
| `desktop` | Rust 轮询间隔/暂停参数 |
| `shortcut` | 全局快捷键键值 + macOS/Windows 分别的修饰键 |
| `logging` | 日志级别 |

> `notification` 配置段已移除（macOS 系统通知无法实现，见 2.7 节）。

DEV 配置 `enabled: true` 时完全替换生产配置，本地调试无需改代码。

---

## 9. 技术架构

```
┌─────────────────────────────────────────┐
│                  前端 (Vue 3 + TS)       │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│  │ StreamView│ │ ChatPanel│ │TitleBar │  │
│  │ 角色动画  │ │ AI 聊天  │ │ 窗口控制│  │
│  └──────────┘ └──────────┘ └─────────┘  │
│  ┌──────────────────────────────────┐    │
│  │         Services 层              │    │
│  │  personality/ — 人格模块(Prompt) │    │
│  │  agent/       — Agent 内核       │    │
│  │  window/      — 窗口监控         │    │
│  │  audio/       — 音效/界限联动    │    │
│  │  表情/命令处理/冷却/日志/环境    │    │
│  │  config.ts ←── CONFIG.yaml      │    │
│  └──────────────────────────────────┘    │
├─────────────────────────────────────────┤
│              Rust 后端 (Tauri v2)        │
│  ┌──────────────────────────────────┐    │
│  │  lib.rs    — 启动入口 + 托盘      │    │
│  │  macros/   — 日志宏              │    │
│  │  monitor/  — MonitorState +      │    │
│  │     capture / visibility / thread      │    │
│  │  window/   — 主窗口 + iTerm      │    │
│  │     main_win / settings           │    │
│  │  commands/ — 13 个 Tauri 命令     │    │
│  │     cursor / monitor_ctl / sim    │    │
│  │     / logging                     │    │
│  └──────────────────────────────────┘    │
├─────────────────────────────────────────┤
│              外部 AI 服务               │
│  OpenAI / DeepSeek / Ollama / 自定义    │
└─────────────────────────────────────────┘

数据流：
  用户消息 → agent/runner.sendMessage() → personality.getSystemPrompt()
           → agent/provider（HTTP）→ agent/chat 记录回复
           → middlewares 各阶段 emit expression/sound 事件 → UI 响应
  窗口监控 → window/listener → agent/active.sendActiveMessage()
           → AgentLoop(isActiveMessage: true) → 无工具声明 → AI 纯闲聊
                                         → pushAssistantMessage + incrementUnanswered
                                         → audio.playNotificationByBoundary()
  
  AgentLoop 内部:
    → PreProcessor(slash/去重) → 人格中间件(thinking) → 思考强度决策
    → ContextEngine.build(人格+记忆+工具+约束) → [Plan] 助手+复杂拆解
    → AI Provider → parseAIResponse → 工具调用? → 安全校验(统一模式库)
    → ToolRouter.execute → 人格中间件(done/blocked/error) → 结果回注
    → 上下文利用率>95% → 自动压缩 → ReplyGenerator → UI 展示
  
  记忆系统:
    memory/MEMORY.md  ← 长期记忆注册表索引 (每个条目 → CANDY/User/Outside 或独立事实)
    memory/Project.md ← 会话归档指针索引 (→ sessions/session-xxx.md)
    每轮对话 → recordTurn → SESSION_MEMORY.md
    /clear → archiveSession → sessions/<id>.md + 更新 Project.md
    → startMemoryConsolidationTimer() → 每60min或每2会话
    → 轻量: consolidate() 去重 | 助手: consolidateWithLLM() 矛盾/合并/过期
```

---

## 10. 设计理念

1. **桌面宠物第一**：窗口无边框透明置顶，不遮挡工作流
2. **渐进式人格**：角色不是固定模板，随互动历史演变
3. **被动陪伴 + 主动搭话**：不只在用户主动聊天时才响应
4. **像素美学**：序列帧动画、像素字体、复古 Windows 风格
5. **配置驱动**：所有参数可调，不做硬编码
6. **前后端分离清晰**：UI（Vue）→ 业务（TS Services）→ 平台（Rust）
