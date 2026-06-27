# DES.md — 糖糖桌宠 设计文档

> 糖糖桌宠 (Desk Pet) 的设计理念、玩法机制、交互说明与架构实现进度
> 面向开发者：记录当前架构进度、各模块实现方式、待完成目标

---

## 1. 项目概述

**糖糖桌宠**是一个桌面虚拟主播宠物应用。像素风角色常驻桌面，**无边框透明窗口置顶显示**，像真正的桌面宠物一样陪伴用户。她能聊天、能察觉你正在看什么、能主动搭话、能用工具完成任务。

**一句话**：把 VTuber 搬到桌面，让她真的注视你。

---

## 2. 核心玩法

### 2.1 桌面常驻

桌宠窗口**无边框、透明背景、始终置顶**，显示一个可拖拽的像素动画角色。角色以序列帧动画展现各种表情（微笑、晚安、生气、飞吻等），默认待机动画循环播放。

### 2.2 AI 聊天

左侧可展开聊天面板，顶部为会话标签页，可切换/新建/关闭会话。用户输入文字与角色对话。回复由 AI 大模型生成，**人格卡驱动**。支持多人格切换，可在设置面板热插拔。

**聊天面板与角色区域之间**有可拖动的竖线分割，拖动位置自动记忆（localStorage），无需在设置页配置。

每个会话的对话轮次**实时写入** `sessions/session-YYYYMMDD-HHmmss-主题.md`，首次用户消息后自动提取主题并重命名文件。**累计 token 消耗、上下文占比同步持久化到 .md 元数据**，重启后自动恢复。随时可查看历史记录。

#### Agent Loop 机制

用户消息不是简单的"发→回"，而是经过完整的 **Agent Loop** 多轮工具调用循环：

```
用户消息 → PreProcessor(slash/去重) → 人格中间件(thinking)
  → 思考强度决策(auto/low/medium/high)
  → ContextEngine.build(人格+记忆+工具+约束)
  → [Plan] 助手模式+复杂任务拆解
  → AI Provider (HTTP, 含工具调用+thinking参数)
  → 解析输出 → 有工具调用?
    → 人格中间件(executing) → 安全检查 → 执行工具 → 结果回注 → 循环
  → 上下文利用率>95% → 自动压缩
  → 人格中间件(done) → ReplyGenerator 后处理 → UI 展示
```

### 2.3 人格系统（独立模块）

人格系统已从 Agent 执行层分离为 `src/services/personality/` 独立模块，**只参与 Prompt 生成**，不影响 Agent 执行逻辑。

- **人格卡**：统一 YAML frontmatter + Markdown 模板，位于 `personality/cards/`
- **热插拔**：设置面板可随时启用/禁用某个人格，或关闭人格系统使用默认人格
- **界限联动**：人格界限系统（boundary）根据 `unansweredCount` 影响 Prompt 语气，不改人格卡内容
- **扩展性**：新人格只需在 `cards/` 目录添加 `.md` 文件并在 `loader.ts` 注册即可

#### 人格中间件（横切所有 Agent 阶段）

人格不只是 Prompt 生成器，而是包裹整个 Agent 循环的横切中间件。8 个阶段各有不同的表情、音效、角色化文案：

| 阶段 | 表情 | 用户看到 | 音效 |
|------|------|----------|------|
| thinking | smile | 无 (除非超长) | — |
| planning | business | "嗯...让我想想怎么帮你～" | — |
| generating | smile | 流式文本 | — |
| executing | business | 工具→角色化文案映射 | — |
| blocked | gaoo | "唔...这个我不能做呢～" | — |
| error | sleepy | "啊...信号不太好～" | — |
| done | chu | 工具完成文案 | reply |
| idle | idle | 主动搭话(按boundary) | — |

工具调用翻译为角色化语言（`TOOL_PERSONALITY_MAP`），例如 `file_read` → "让我读读这个文件..." → "读完啦～"。

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
| 工具配置 | Bash 白名单编辑(逐行) / 文件写开关 | 即时生效 |
| MCP 配置 | 启用开关 / 服务器列表(添加/编辑/删除, stdio/sse) / JSON 导入导出 | 需重启 |
| Skill 配置 | 启用开关 / 已加载列表 / 上传 .md 添加 / 删除 | 需重启 |
| CONFIG 导入导出 | 导出当前覆盖值为 YAML 文件 / 上传 YAML 导入覆盖层 | 导入后刷新 |
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
| 设置 | 标题栏 深蓝像素齿轮按钮 | 独立窗口：AI接口/窗口监控/弹窗/音效/快捷键/工具/MCP/Skill等全部CONFIG可编辑 + 导入导出 |
| 输入聊天 | 聊天面板底部输入框 + Enter | 发送消息给角色 |
| **右键选中文字** | 右键选中文字 | 显示自定义右键菜单，仅"复制" |
| 右键空白区域 | 右键 | 禁用默认菜单 |
| **隐藏到托盘** | 标题栏 ✕ 按钮 | 窗口隐藏到系统托盘，单击托盘图标恢复 |
| **快捷键召唤** | `Ctrl+Cmd+P` (Mac) / `Ctrl+Alt+P` (Win) | 桌宠弹出/收回到光标位置 |
| **Dock 点击** | 点击应用图标 | 窗口隐藏时在屏幕中央弹出 |
| **F12 调试命令** | DevTools Console | 见下方 |

### 3.1 快捷键召唤/收回机制

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
- `enhance_to_iterm_style` — iTerm 风格增强：`MainMenu(24)` 层级 + `canJoinAllSpaces | fullScreenAuxiliary | stationary | ignoresCycle | transient` + `orderFrontRegardless` + `activateIgnoringOtherApps`
- 每次 `compute_popup_position` 调用都重新增强一次，确保全屏 Space 可靠性
- `canJoinAllSpaces` — 跟随到所有 macOS 桌面/Spaces
- `visibleOnAllWorkspaces` + `alwaysOnTop` — Tauri 配置层面兜底

**动画特性**：
- `transform-origin` 动态设定为光标相对于窗口的坐标，实现"从光标处生长/缩回"效果
- 弹出使用 `cubic-bezier(0.34, 1.56, 0.64, 1)` 弹性缓出（macOS 神奇效果）
- 收回使用 `cubic-bezier(0.36, 0, 0.66, -0.56)` 加速缩入
- 动画期间设 `isAnimating` 锁，防止重复触发

### 3.2 聊天命令（统一 Slash 系统）

在聊天框输入 `/` 会弹出下拉框，显示所有可用命令及简介。支持键盘导航（↑↓选择 + Enter确认 + Esc关闭）和鼠标点击。

所有命令统一通过 `src/services/engine/slash/` 系统注册和执行：

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有可用命令 |
| `/clear` | 归档当前会话并清空对话 |
| `/memory clean` | 清理所有长期记忆 |
| `/smile` | 切换表情为 😊 微笑 |
| `/sleep` | 切换表情为 😴 困倦 |
| `/gaoo` | 切换表情为 😠 生气 |
| `/chu` | 切换表情为 💋 飞吻 |
| `/superchat` | 切换表情为 💰 SC感谢 |
| `/business` | 切换表情为 💼 业务洽谈 |
| `/you` | 切换表情为 😏 毒舌 |
| `/win open` | 打开 Windows 模拟器彩蛋 |
| `/win close` | 关闭 Windows 模拟器 |

**命令执行流程**：
```
用户输入 / → ChatPanel 下拉框出现 → 继续输入过滤 → 选中确认
  → SlashCommand.execute() → 表情切换(emit事件) / 文本回复(pushAssistantMessage)
  → 不调 AI，纯本地执行
```

**未注册的 / 开头文本**（如 `/etc`）会透传给 AI 正常对话。

### 3.3 F12 控制台调试命令

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
__thinking.decide("帮我看看桌面有什么")      // 思考强度决策
__thinking.count()                         // 工具调用计数
__memory.list()                            // 记忆列表
__memory.search("关键词")                   // 搜索记忆
__memory.consolidate()                     // 手动触发记忆整理
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
                    sendActiveMessage()       (无冷却限制)
                          │
                    → runAgentLoop(isActiveMessage: true)
                    → 思考强度: auto→low (主动搭话无需深度推理)
                    → 上下文不带工具声明 (纯闲聊)
                    → AI 生成简短口语化回复
                          │
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

全部配置集中于 `CONFIG.yaml` / `CONFIG-DEV.yaml`，12 个配置段：

| 配置段 | 控制内容 |
|--------|---------|
| `mode` | 助手模式开关 (assistant: true/false) |
| `ai` | API 端点/Key/模型/上下文数/思考强度/thinkingBudget/默认人格/fallback语录 |
| `personality` | 人格系统开关/激活人格ID/可用人格卡列表 |
| `windowMonitor` | 停留秒数/防抖/冷却/同页冷却/额外延迟 |
| `aiLock` | 生成锁安全超时 |
| `memory` | 长期记忆最大条数 |
| `desktop` | Rust 轮询间隔/暂停参数 |
| `shortcut` | 全局快捷键键值 + macOS/Windows 分别的修饰键 |
| `logging` | 日志级别 |
| `loop` | maxRetry/maxToolCallsPerTurn/toolTimeoutMs/turnTimeoutMs/streamEnabled/contextCompactAt |
| `tools` | bash白名单/file开关/mcp开关+servers/skill开关 |
| `safety` | 安全模式(tell_me/just_do_it/let_me_tk)/sessionTrust |

> `notification` 配置段已移除（macOS 系统通知无法实现，见 2.8 节）。

DEV 配置 `enabled: true` 时完全替换生产配置，本地调试无需改代码。

---

## 9. 技术架构

### 9.1 系统分层

```
┌──────────────────────────────────────────────────────────┐
│  UI 层 (Vue 3)                                            │
│  StreamView(角色动画) / ChatPanel(对话) / TitleBar         │
│  SessionTabs(会话标签) / SettingsPanel(设置) / DebugBar    │
│  NotificationCard / winsim(Windows模拟器彩蛋)               │
├──────────────────────────────────────────────────────────┤
│  人格中间件 (PetPersonalityMiddleware)                      │
│  ┌──────────────────────────────────────────────────┐    │
│  │ 思考中→表情  │ 调工具→角色化语言  │ 结果→自然解读    │    │
│  │ 被拦截→撒娇抱怨 │ 出错→傲娇吐槽  │ 完成→开心表情   │    │
│  └──────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────┤
│  核心引擎 (CoreEngine)                                     │
│  PreProcessor → SessionEngine → AgentLoop                │
│  + Plan(助手模式复杂任务) + Thinking(思考强度决策)          │
├──────────────────────────────────────────────────────────┤
│  上下文引擎                    │  工具系统                  │
│  SystemPrompt + Memory         │  Skill → MCP/Local       │
│  + 工具声明 + 摘要压缩          │  统一 ToolRegistry        │
│  + 思考强度提示                 │  按模式动态注册            │
├──────────────────────────────────────────────────────────┤
│  安全控制 (SafetyControl) —— 所有工具调用强制经过            │
│  四级安全(SAFE/NORMAL/DANGER/NOWAY) + 三策略 + 确认弹窗       │
│  全局默认(设置页) + 会话覆盖(仪表盘)  【✅ 已实现】           │
├──────────────────────────────────────────────────────────┤
│  平台桥接 (Rust) —— 窗口/系统调用/后台轮询                  │
│  bash_exec / file_read / file_write / file_list            │
│  system_info / app_open / clipboard / mcp_bridge【已实现】   │
└──────────────────────────────────────────────────────────┘
```

### 9.2 模块目录结构

```
src/services/
├── engine/                # ★ 核心引擎
│   ├── agent-loop.ts      # Agent Loop — 多轮工具调用核心循环 + 上下文压缩
│   ├── preprocessor.ts    # Slash命令 + 空/重复消息过滤
│   ├── parser.ts          # AI输出解析 (function_call/纯文本/思考)
│   ├── session.ts         # 会话状态机 (WAITING→PRE→GENERATING→EXECUTING)
│   ├── thinking.ts        # ★ 思考强度决策 (auto/low/medium/high)
│   ├── plan.ts            # ★ Plan 步骤 (助手模式复杂任务预判拆解)【关键词桩】
│   └── slash/             # ★ Slash 命令系统
│       ├── index.ts / types.ts / registry.ts
│       └── commands/      # help/clear/memory/expression/win
│
├── personality/           # ★ 人格模块
│   ├── middleware.ts      # ★ 人格中间件（包裹所有Agent阶段）
│   ├── types.ts           # 人格类型定义
│   ├── registry.ts        # 人格注册表 + getSystemPrompt
│   ├── loader.ts          # 人格卡 YAML 加载
│   ├── boundary.ts        # 界限系统 (unansweredCount驱动)
│   └── cards/             # 人格卡 .md (angelkawaii/ame/pchan)
│
├── tool/                  # ★ 工具系统
│   ├── index.ts           # 统一导出
│   ├── types.ts           # ToolDef / ToolResult / SafetyLevel
│   ├── registry.ts        # ★ 统一注册表 (按mode注册/查询/注销)
│   ├── router.ts          # 工具路由 + 超时控制 + 结果截断
│   ├── local/             # 轻量模式工具 (始终加载, mode: "pet")
│   │   ├── file.ts        # file.read / file.list / file.search
│   │   ├── bash.ts        # bash_exec (白名单)
│   │   ├── system.ts      # system_info
│   │   └── http.ts        # http_get
│   ├── local-extra/       # 助手模式工具 (动态加载, mode: "assistant")
│   │   ├── file-write.ts  # file_write (DANGER)
│   │   ├── bash-full.ts   # bash_exec_full (DANGER)
│   │   ├── app.ts         # app_open (NORMAL)
│   │   ├── clipboard.ts   # clipboard_read/write (NORMAL/DANGER)
│   │   ├── agent-tool.ts  # agent_spawn (NORMAL)【已实现 fork/team】
│   │   └── file-delete.ts # file_delete (NOWAY)
│   ├── skill/             # Skill 系统 (助手模式)
│   │   ├── loader.ts      # YAML frontmatter解析 + ToolDef转换 + 动态增删 + 上传.md注册
│   │   ├── registry.ts    # Skill 注册/查询/关键词匹配
│   │   └── runner.ts      # Skill 子循环编排【已实现】
│   └── mcp/               # MCP 集成 (助手模式)
│       ├── manager.ts     # MCP Manager + 真实连接 + Mock工具 + 服务器管理【已实现】
│       ├── client.ts      # MCP Client JSON-RPC协议栈 + ToolDef转换【已实现】
│       ├── stdio.ts       # MCP stdio 传输层 (Tauri invoke桥接)【已实现】
│       └── sse.ts         # SSE 传输【占位】
│
├── safety/                # 安全控制
│   ├── checker.ts         # 四级安全 + 三策略 + 会话信任 + 危险模式库
│   └── confirm.ts         # 确认弹窗 Promise 桥接 (AgentLoop ↔ ChatPanel)
│                          # 【待补: 确认UI弹窗】
│
├── context/               # ★ 上下文引擎
│   └── builder.ts         # SystemPrompt 动态组装 (6层拼合)
│                          # 工具声明策略 (轻量始终带/助手L0-L2)
│                          # compactMessages 上下文压缩
│
├── reply/                 # 回复生成器
│   └── generator.ts       # 后处理: kaomoji/截断/HTML转义
│
├── agent/                 # Agent 模块
│   ├── index.ts           # 统一导出
│   ├── types.ts           # Message / ToolCall / GenerateRequest 类型
│   ├── runner.ts          # sendMessage() — 接入 AgentLoop
│   ├── provider.ts        # OpenAICompatibleProvider — 支持工具调用+思考强度
│   ├── service.ts         # AI 调用封装
│   ├── chat.ts            # 聊天记录 + 会话管理
│   ├── memory.ts          # ★ 长期记忆（文件注册表 + LLM整理 + Fork补记忆）
│   └── active.ts          # 窗口监控 → 主动搭话
│
├── window/                # 窗口监控
│   ├── monitor.ts         # 前后台检测
│   ├── listener.ts        # Tauri事件监听 + 冷却
│   └── active-context.ts  # 窗口上下文
│
├── audio/                 # 音效系统
│   ├── registry.ts        # Web Audio 合成 + 29音效 + 事件映射
│   └── boundary.ts        # 人格界限 ↔ 音效联动
│
├── config.ts              # 配置加载 (YAML → 类型化getter)
├── cooldown.ts            # 全局冷却 + AI并发锁
├── logger.ts              # 统一日志 (createLogger)
├── debug.ts               # Debug状态栏数据
├── env.ts                 # 平台检测
├── animation.ts           # 角色动画表情映射
├── expressions.ts         # 表情关键词匹配
├── command-handler.ts     # 角色表情命令处理
└── test.ts                # AI 测试入口
```

### 9.3 完整数据流

```
用户消息
  │
  ├── agent/runner.sendMessage()
  │     ├── 并发锁检查 (isAIGenerating)
  │     ├── PreProcessor → /slash? → 直接返回
  │     ├── pushUserMessage + resetUnanswered
  │     │
  │     └── runAgentLoop()
  │           │
  │           ├── 思考强度决策 (auto: 闲聊→low / 工具关键词→medium / 复杂关键词→high)
  │           ├── ContextEngine.build()
  │           │     ├── 1. 人格 Prompt (card + boundary)
  │           │     ├── 2. CANDY.md + User.md 注入
  │           │     ├── 3. 会话记忆注入 (压缩摘要)
  │           │     ├── 4. Memory 搜索注入 (topK=3)
  │           │     ├── 5. 工具声明 (轻量始终带 / 助手L0-L3)
  │           │     ├── 6. 输出约束 + 助手能力提示
  │           │     └── 7. 思考强度提示 (low→快速 / high→深入)
  │           │
  │           ├── [Plan] 助手模式+high强度+复杂关键词 → 步骤拆解注入
  │           ├── 人格中间件.wrap("thinking") → expression/sound event
  │           │
  │           ├── ★ Agent Loop 主循环 (最多 maxToolCallsPerTurn 轮)
  │           │     │
  │           │     ├── OpenAICompatibleProvider.generateReply()
  │           │     │     ├── POST { model, messages, tools?, tool_choice?, reasoning_effort? }
  │           │     │     └── 解析 → { text, toolCalls[], thinking?, usage }
  │           │     │
  │           │     ├── 无工具调用 → 退出循环
  │           │     │
  │           │     ├── 有工具调用:
  │           │     │     ├── 人格中间件.wrap("executing") → 角色化文案
  │           │     │     ├── SafetyControl.check(tool, params)
  │           │     │     │     SAFE→放行 / NORMAL+DANGER→拒绝(轻量)
  │           │     │     ├── ToolRouter.execute() → invoke("bash_exec"/"file_read"/..)
  │           │     │     ├── 结果回注 → 下一轮循环
  │           │     │     └── 人格中间件.wrap("done"/"blocked"/"error")
  │           │     │
  │           │     ├── 上下文压缩检测 (usage/contextMaxTokens ≥ 0.95)
  │           │     │     ├── compactMessages (保留40% + 摘要)
  │           │     │     └── writeCompactionSummary → sessions/*.md
  │           │     │
  │           │     └── 达上限 → 强制生成总结回复
  │           │
  │           ├── 人格中间件.wrap("done") → expression: "chu", sound: "reply"
  │           ├── MemoryService.recordTurn("assistant") → sessions/*.md
  │           ├── [助手模式] MemoryService.forkMemorySupplement() → LLM补记忆
  │           └── 返回 { reply, toolCallHistory, effects[] }
  │
  ├── ReplyGenerator 后处理 (kaomoji/截断/HTML转义)
  ├── pushAssistantMessage → chat.ts 状态更新
  └── ChatPanel + StreamView + 音效 展示
```

**窗口主动搭话路径**：
```
Rust monitor → emit("window-changed") → listener.ts
  → 冷却通过 → agent/active.sendActiveMessage()
  → runAgentLoop(isActiveMessage: true)
    → 思考强度: auto→low
    → 上下文: 无工具声明
    → AI 生成简短口语化回复
  → pushAssistantMessage + incrementUnanswered
  → audio.playNotificationByBoundary()
```

### 9.4 Agent Loop 详细说明

#### 循环控制参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxRetry` | 3 | 工具调用/验证失败最大重试次数 |
| `maxToolCallsPerTurn` | 5 | 单轮最多工具调用链长度 |
| `toolTimeoutMs` | 30000 | 单个工具执行超时 |
| `turnTimeoutMs` | 120000 | 整轮总超时 |
| `streamEnabled` | true | 是否流式输出 |
| `contextCompactAt` | 0.95 | 上下文利用率达95%触发摘要压缩 |

#### 状态机

```
WAITING ──(收到消息)──→ PRE ──→ GENERATING
   ▲                       │          │
   │                       │          ├── 纯文本回复 → WAITING
   │                       │          │
   │                       │          └── 工具调用 → EXECUTING
   │                       │               │
   └────(完成)──────────────┴───────────────┘
```

#### 上下文压缩策略

当 `estimatedTokens / contextMaxTokens ≥ 0.95` 时触发：
1. 保留最近 40% 消息
2. 旧消息压缩为一条摘要（用户/助手轮次要点）
3. 生成结构化摘要写入 `sessions/*.md`
4. 日志记录压缩前后消息数

### 9.5 工具系统详细说明

#### 双模式架构

```
同一套 Agent Loop（始终运行）
        │
  ┌─────┴─────────────────────────────┐
  │                                   │
轻量模式 (默认)                   助手模式 (设置中开启)
  │                                   │
ToolRegistry:                      ToolRegistry 额外:
├── file_read (SAFE)               ├── file_write (DANGER)
├── file_list (SAFE)               ├── bash_exec_full (DANGER)
├── file_search (SAFE)             ├── app_open (NORMAL)
├── system_info (SAFE)             ├── clipboard_read (NORMAL)
├── bash_exec (NORMAL, 白名单)     ├── clipboard_write (DANGER)
└── http_get (NORMAL)              ├── file_delete (NOWAY, 硬禁止)
                                   ├── agent_spawn (NORMAL)【已实现 fork/team】
                                   ├── MCP Mock工具 (4个)
                                   └── Skill 工具 (3个)

Safety: SAFE放行/其余拒绝         Safety: 四级+三策略+确认弹窗
Plan: 不启用                       Plan: 复杂任务启用【关键词桩】
MCP/Skill: 不加载                  MCP/Skill: 完整加载 (Mock + 真实)
```

#### 能力对比

| 能力 | 轻量模式 | 助手模式 |
|------|:---:|:---:|
| AI 聊天 + 人格系统 | ✅ | ✅ |
| 窗口感知主动搭话 | ✅ | ✅ |
| 表情/音效/人格中间件 | ✅ | ✅ |
| 记忆系统 (长期+短期+整理) | ✅ | ✅ |
| 读/列/搜文件 | ✅ | ✅ |
| 系统信息 | ✅ | ✅ |
| Bash 白名单命令 | ✅ | ✅ |
| HTTP GET | ✅ | ✅ |
| 写文件 | ❌ | ✅ |
| 全量 Bash | ❌ | ✅ |
| 打开应用 | ❌ | ✅ |
| 剪贴板操作 | ❌ | ✅ |
| MCP Server | ❌ | ✅ (Mock+真实) |
| Skill (编排) | ❌ | ✅ (子循环执行) |
| SubAgent (agent.spawn) | ❌ | ✅ (fork/team) |
| Plan 步骤 | ❌ | ⚠️ (关键词桩) |
| 完整安全确认 UI | ❌ | ✅ (四级+三策略+确认弹窗) |

### 9.6 安全控制

#### 四级安全（已实现）

| 级别 | 标识 | 轻量模式 | 助手模式 |
|------|:---:|------|------|
| SAFE | 🟢 | 自动放行 | 自动放行 |
| NORMAL | 🟡 | 放行(handler二次校验) | 首次确认→会话内信任 |
| DANGER | 🟠 | 拒绝 | 每次确认 (just_do_it 跳过) |
| NOWAY | 🔴 | 硬拒绝 | 硬拒绝 |

#### 三策略 (safety.mode)

| 策略 | 说明 | 设置页 | 仪表盘会话覆盖 |
|------|------|:---:|:---:|
| `just_do_it` | DANGER 直接放行 | ✅ | ✅ |
| `tell_me` | 按规则确认 (默认) | ✅ | ✅ |
| `let_me_tk` | 所有非SAFE都确认 | ✅ | ✅ |

#### 实现文件

- `safety/checker.ts` — 四级安全+三策略+会话信任+危险模式库
- `safety/confirm.ts` — 确认弹窗 Promise 桥接 (AgentLoop ↔ ChatPanel)
- `ChatPanel.vue` — 确认弹窗渲染

#### 统一危险模式库

所有工具共享同一套模式库（`safety/checker.ts`），不分散在各地判断：

```ts
// Bash 危险模式 (NORMAL拦截)
BASH_DANGEROUS_PATTERNS: [rm -rf, sudo, chmod 777, > /dev/, curl|sh, mkfs, dd if=]

// Bash 硬禁止 (即使助手也拦截)
BASH_NOWAY_PATTERNS: [rm -rf /, sudo rm, mkfs, dd ... of=/dev/, curl|sh, > /etc/]

// 文件路径危险
FILE_DANGEROUS_PATTERNS: [/.ssh/, /etc/passwd, /etc/shadow, /System/, /Windows/, .pem, .key, .env]
```

### 9.7 思考强度

与模式正交的独立维度，控制 AI 推理深度：

| 强度 | 说明 | 触发条件 | Token消耗 |
|------|------|----------|:---:|
| `low` | 快速响应 | 闲聊/主动搭话 | 低 |
| `medium` | 均衡 | "帮我/查看/搜索"等工具关键词 | 中 |
| `high` | 深度推理 | "分析/整理/重构"等复杂关键词 / 工具调用≥2轮 / 错误重试 | 高 |
| `auto` | 自动(默认) | 根据上述规则自动切换 | 动态 |

#### auto 模式切换逻辑

```
任务检测:
  闲聊/表情/打招呼/主动搭话 → low
  "帮我"/"查看"/"搜索"/"找" → medium
  "分析"/"整理"/"重构" / 工具调用≥2轮 / Plan触发 / 错误重试 → high
```

#### 实现方式

| Provider | 参数 |
|----------|------|
| DeepSeek | `reasoning_effort` |
| OpenAI (o-series) | `reasoning_effort` |
| 通用 OpenAI 兼容 | SystemPrompt 追加 "请快速简要回答" / "请仔细深入思考后回答" |

### 9.8 上下文引擎

#### SystemPrompt 组装顺序（每次请求动态构建）

```
1. 人格 Prompt (card + boundary)              ~500-2000 tokens
2. CANDY.md + User.md 注入                     ~50-200 tokens
3. 会话记忆注入（压缩摘要）                     ~300-500 tokens
4. Memory 搜索注入 (topK=3)                    ~200-800 tokens
5. 工具声明（轻量始终带/助手按需L0-L2）         ~150-1500 tokens
6. 输出约束 + 助手能力提示                     ~150 tokens
7. 思考强度提示 (low/high)                     ~30 tokens
```

#### 工具声明策略

- **轻量模式**：始终携带 6 个工具声明（~150 tokens），省去决策逻辑
- **助手模式**：L0(闲聊 无工具) / L1+L2(有工具意图 全量)

### 9.9 记忆系统

#### 存储模型

```
memory/                        长期记忆目录
├── MEMORY.md                  ★ 结构化注册表（双块）
│     ## 系统文件               4个系统指针（CANDY/User/Outside/Project）
│     ## 长期记忆               用户记忆条目
├── CANDY.md                   用户手写系统指令
├── User.md                    用户画像（imp≥7 自动同步）
├── Outside.md                 外部知识指针
└── Project.md                 ★ 会话归档指针 → sessions/

sessions/                      会话目录（唯一真相源）
└── session-YYYYMMDD-HHmmss-主题.md
       元信息 → 结构化摘要 → 完整对话记录
```

#### 记忆整理

| 触发条件 | 实现 |
|----------|------|
| 每 5 轮对话自动触发 | `recordTurn()` 计数 → `checkAndConsolidate()` |
| 每 60min 定时器 | `startMemoryConsolidationTimer()` → 60min间隔 |
| 2 个会话结束 | `onSessionEnd()` 计数 → 达到2触发 |
| 手动 `/memory clean` | Slash命令 |

| 模式 | 整理方式 |
|------|---------|
| 轻量模式 | `consolidate()` — 本地去重裁剪（按content前缀去重 + 按importance排序保留maxEntries） |
| 助手模式 | `consolidateWithLLM()` — LLM 分析 merge/conflicts/expired/adjust/newFacts → 回退基础整理 |

#### Fork 记忆补充（助手模式）

每轮对话结束后，后台调用 LLM 提取值得长期记住的信息（不重复已有记忆），自动写入 MEMORY.md。

---

## 10. 实现进度总览

### Phase 1+2: 核心引擎 + 轻量模式 ✅ 已完成

| 模块 | 状态 | 文件 |
|------|:---:|------|
| Agent Loop 多轮循环 | ✅ | `engine/agent-loop.ts` |
| PreProcessor (slash/去重) | ✅ | `engine/preprocessor.ts` |
| 会话状态机 | ✅ | `engine/session.ts` |
| AI 输出解析器 | ✅ | `engine/parser.ts` |
| 思考强度 | ✅ | 全局默认+会话覆盖(仪表盘下拉)，移除自动选择 |
| 人格中间件 (8阶段) | ✅ | `personality/middleware.ts` |
| 人格注册表 + 热插拔 | ✅ | `personality/registry.ts` + `loader.ts` |
| 界限系统 (boundary) | ✅ | `personality/boundary.ts` |
| 3个人格卡 | ✅ | `personality/cards/` |
| 统一 ToolRegistry | ✅ | `tool/registry.ts` |
| ToolRouter (路由+超时) | ✅ | `tool/router.ts` |
| 轻量6工具 | ✅ | `tool/local/` (file/bas/system/http) |
| 助手6额外工具 | ✅ | `tool/local-extra/` (write/full/app/clipboard/delete) |
| 安全控制 (四级+三策略+确认UI) | ✅ | `safety/checker.ts` + `confirm.ts` |
| 上下文引擎 | ✅ | `context/builder.ts` |
| 回复生成器 | ✅ | `reply/generator.ts` |
| OpenAI 兼容 Provider | ✅ | `agent/provider.ts` |
| 记忆系统 (注册表+LLM整理+Fork) | ✅ | `agent/memory.ts` |
| Rust 工具执行 | ✅ | `commands/tool_exec.rs` |
| Debug 状态栏 | ✅ | `DebugBar.vue` + `debug.ts` |

### Phase 3: 助手模式 ⚠️ 大部分完成

| 模块 | 状态 | 说明 |
|------|:---:|------|
| 助手模式开关 + 设置UI | ✅ | `CONFIG.yaml` mode.assistant |
| 模式切换动态加载 | ✅ | registerAssistantTools/unregisterAssistantTools |
| 助手专属工具 (5个+1个NOWAY) | ✅ | local-extra/ |
| **agent.spawn 子代理** | ✅ 已实现 | fork/team 双模式，子循环最多3轮，90s超时 |
| **助手完整安全 (四级+确认UI)** | ✅ 已实现 | checker.ts + confirm.ts + ChatPanel 弹窗 |
| **安全策略会话覆盖** | ✅ 已实现 | 仪表盘下拉，getEffectiveSafetyMode() |

### Phase 4: MCP + Skill + Plan ⚠️ 大部分完成

| 模块 | 状态 | 说明 |
|------|:---:|------|
| Skill Loader (YAML解析) | ✅ | `tool/skill/loader.ts` |
| Skill Registry (注册/查询) | ✅ | `tool/skill/registry.ts` |
| 3个内置 Skill | ✅ | summarize-code / organize-files / check-weather |
| skills/ 目录 | ✅ | `skills/*.md` — import.meta.glob 编译时加载 |
| **Skill Runner (编排执行)** | ✅ 已实现 | 子循环调用 Local 工具，解析 steps 执行 |
| **Skill 持久化到 CONFIG** | ✅ 已实现 | syncUserSkillsToConfig()，跨 webview 不丢失 |
| **MCP Mock 工具** | ❌ 已移除 | 4个假工具已删除，只留真实连接 |
| **MCP Manager (真实连接)** | ✅ 已实现 | 连接生命周期 + 工具发现 → ToolRegistry |
| **MCP Client (JSON-RPC)** | ✅ 已实现 | connect/initialize/listTools/callTool + ToolDef |
| **MCP stdio 传输** | ✅ 已实现 | Tauri invoke 桥接 Rust 子进程 stdin/stdout |
| **Rust MCP Bridge** | ✅ 已实现 | spawn/kill 子进程 + JSON-RPC 桥接 |
| **内置 5 个 MCP** | ✅ 已实现 | Filesystem/BraveSearch/Playwright/Git/GitHub |
| **Plan (AI模型预判)** | ⚠️ 关键词桩 | 当前做关键词→步骤映射，非AI预判 |

### 待实现目标

| 优先级 | 任务 | 说明 |
|:---:|------|------|
| ~~P0~~ | ~~助手模式完整安全~~ | ✅ 已实现: checker.ts + confirm.ts + ChatPanel 弹窗 |
| P0 | ⚠️ 工具/Skill/安全 集成测试 | 功能已实现，全路径测试未覆盖 |
| P1 | Plan AI模型预判 | 让模型预判任务→拆解步骤（替代关键词桩） |
| P2 | 流式输出 UI 接续 | Provider 接口已支持，UI 层 Streaming 展示 |
| P2 | MCP SSE 传输 | EventSource 连接方式 |
| P3 | Agent Loop 时间本地化 | ✅ 已实现: toISOString → localTime() 全局替换 |

---

## 11. 设计理念

1. **桌面宠物第一**：窗口无边框透明置顶，不遮挡工作流
2. **渐进式人格**：角色不是固定模板，随互动历史演变
3. **被动陪伴 + 主动搭话**：不只在用户主动聊天时才响应
4. **像素美学**：序列帧动画、像素字体、复古 Windows 风格
5. **配置驱动**：所有参数可调，不做硬编码
6. **前后端分离清晰**：UI（Vue）→ 业务（TS Services）→ 平台（Rust）
7. **同一Loop+不同工具集**：轻量/助手模式共用核心引擎，仅工具可见范围不同
8. **工具优先**：MCP/Skill/Local Tool 三者同级注册，模型自行选择
9. **安全内建**：不在各处分散判断，统一入口强制校验
10. **人格中间件**：工具调用、结果、错误全部经人格层转换为角色化表达
