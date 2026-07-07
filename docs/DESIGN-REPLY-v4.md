# 回复生成器重构 — Card 驱动的完整角色系统

> 日期: 2026-07-06 | 状态: 设计定稿，可开工

---

## 目录

1. 核心设计原则
2. 架构总览
3. Card 模板
4. 变量池系统
5. 行为进阶（When 引擎）
6. 必须遵守
7. 阶段文案
8. 情绪表达
9. 两阶段 LLM
10. Context Builder
11. Agent Loop
12. Provider 流式
13. Runner 适配
14. 配置变更
15. 设置页
16. 生命周期
17. 文件变更总清单
18. 实现顺序

---

## 1. 核心设计原则

### 1.1 Card + Profile = 角色

```
Card = 角色的灵魂（语言、性格、行为）
  ├─ .md           → 角色设定 / 语言风格 / 输出规则 / 行为进阶 / 必须遵守 / 变量定义 / 情绪表达
  ├─ stages.json   → 运行时阶段文案（LLM 生成，per-card 持久化）
  └─ vars.json     → 变量池快照（LLM 管理，单例，切换覆写）

Profile = 角色的外表（视觉、音效、动画）
  ├─ materials/    → 图层素材
  ├─ character.yaml → 动画帧
  └─ profile.yaml  → 主题色 + 音效

Card 和 Profile 独立切换。换 Card = 换灵魂。换 Profile = 换外表。同时换 = 完全换人。
```

### 1.2 零默认角色

- **Phase1 零身份** — system prompt 只有 "你是一个桌面助手"，无名字、无人设
- **Card 是角色身份的唯一来源** — 角色的名字、性格、语言风格 100% 来自 card.md
- **禁用人格 = 无角色** — 跳过 Phase2，直接返回 Phase1 纯能力回复。这是正确行为，不是缺陷
- **无 defaultSystemPrompt** — CONFIG.yaml 中该字段移除

### 1.3 一个 Card = 一个 .md 文件

Card 不附带任何配置文件。所有衍生数据（stages、vars）由系统自动生成。

```
源码:
  src/services/personality/cards/*.md     ← 内置 Card，import.meta.glob 自动扫描
  src/services/personality/stages-prompt.md ← 阶段文案生成模板（通用）

项目目录:
  Desk-Pet/src/services/personality/
    ├── cards/                        ← 内置 + 用户导入 Card .md
    ├── stages/
    │   ├── angelkawaii.json          ← per-card 持久化
    │   ├── ame.json
    │   └── ...
    └── vars.json                     ← 单例，对应当前 card
```

### 1.4 LLM 管理的变量池

变量池不是几个固定变量，而是 **LLM 自主管理的 KV 存储**：
- 系统变量：只读，系统自动更新（8 个精简系统变量）
- 角色变量：LLM 通过 var_read/write/list/delete 工具自由增删改查
- Card 可预定义初始变量（`# 变量定义`）
- Card 可通过 `# @system variableName` 订阅额外系统变量
- 每次 prompt 携带完整变量池（只读注入 Phase1，Phase2 也可感知）
- var_write 为异步操作：写期间若有并发读，返回旧值（乐观并发）
- 上限：角色变量 ≤ 100 个，总数 ≤ 200 个
- 类型自动推断：var_write 工具 handler 负责类型转换
- 安全级别：全部 SAFE，无需确认

### 1.5 固定 2 次 LLM 调用

每次用户消息：Phase1（能力） + Phase2（风格）。人格禁用时跳过 Phase2。不再有 planStep 独立调用。

### 1.6 上下文持久化策略

持久化到 chatHistory / sessions/*.md 的内容：
- 用户原始消息（user role）
- Phase1 工具调用链（AI tool_calls + tool results）— 含子 agent、MCP 等完整执行记录
- Phase2 风格化回复（assistant role）

**丢弃的只有 Phase1 的 rawReply 纯文本**（它被 Phase2 风格化后已无保留价值）。

上下文压缩基于 chatHistory（用户消息 + 工具链 + Phase2 回复）。

---

## 2. 架构总览

### 2.1 数据流

```
用户消息
  │
  ├─ PreProcessor（不变）
  │
  ├─ 变量池刷新 → 系统变量自动更新 → When 引擎求值 → 命中规则语气
  │
  ├─ [Phase1 LLM]  非流式，永远
  │     SystemPrompt = 能力约束 + 工具 + 记忆 + 必须遵守(工具相关条目) + 变量池(只读)
  │     输出: rawReply（准确完整，可用 markdown，无人格）+ 工具调用链
  │
  ├─ 人格启用?
  │     ├─ No → 持久化 Phase1 工具链 + rawReply 到 chatHistory，返回 rawReply
  │     └─ Yes ↓
  │
  ├─ [Phase2 LLM]  流式取决于 reply.streamEnabled
  │     SystemPrompt = 角色设定 + 语言风格 + 输出规则 + 情绪表达 + 当前状态(When命中语气) + 行为准则 + 变量池(只读)
  │     UserMessage  = "用户问: {原文}\n[执行过程]\n{Phase1工具调用摘要}\n风格化:\n{rawReply}"
  │     thinkingEffort = reply.phase2ThinkingEffort（独立于 Phase1）
  │     输出: [emo:key] + 角色化最终回复
  │     │
  │     ├─ 失败 → 重试 1 次 → 仍失败 → 回退 rawReply（不截断）
  │     └─ 成功 → 剥离情绪标签 → 流式推 UI 或全量返回
  │
  └─ 收尾
        ├─ 情绪标签 → expression + soundEvent 事件
        ├─ 持久化到 chatHistory: 用户消息 + Phase1工具链 + Phase2回复
        ├─ 变量池覆写 vars.json
        └─ 上下文压缩（基于 chatHistory）
```

### 2.2 关键行为决策

| 场景 | 行为 |
|------|------|
| 人格禁用 | 跳过 Phase2，持久化 Phase1 工具链+rawReply |
| Phase2 失败 | 重试 1 次，仍失败回退 rawReply，不截断 |
| 主动搭话 | 同样走两阶段 |
| 流式切会话 | token 继续推送，流结束 persist 到原会话（已有多 tab 会话管理） |
| 上下文压缩 | 基于 chatHistory（用户消息 + 工具链 + Phase2 回复） |
| unansweredCount | 用户发消息立即归零 |
| Card 扫描 | 设置页打开时实时扫描，不缓存 |

---

## 3. Card 模板

### 3.1 完整模板

```markdown
---
id: {唯一标识}
name: {显示名称}
description: {一句话描述}
version: {正整数}
---

# 角色设定
{WHO — 身份、性格、背景、与用户的关系}

# 语言风格
{HOW — 语气、口头禅、用词偏好}

# 输出规则
{FORMAT — 格式约束}

# 情绪表达
{情绪与表情/音效的映射规则}

# 行为进阶
## 规则: {名称}
when: {变量表达式}
语气: {该状态下的语气描述}

# 必须遵守
{WHAT — 行为准则列表}

# 变量定义
{变量名}: {初始值}
```

所有 section 使用纯文本格式，不使用 markdown 表格。由统一的 `parseSections()` 函数解析。

### 3.2 Section 用途

| Section | 消费者 | 管什么 | Token |
|---------|--------|--------|-------|
| `# 角色设定` | Phase2 prompt | WHO — 身份+性格+背景 | ~300-800 |
| `# 语言风格` | Phase2 prompt | HOW — 语气+口头禅 | ~100-300 |
| `# 输出规则` | Phase2 prompt | FORMAT — 格式约束 | ~100-200 |
| `# 情绪表达` | 系统 + Phase2 prompt | EMOTION — 情绪标签映射规则 | ~50-150 |
| `# 行为进阶` | When引擎→Phase2 | WHEN — 语气切换规则 | ~50-150/条 |
| `# 必须遵守` | 系统hook + Phase1/2 | WHAT — 行为准则 | ~100-400 |
| `# 变量定义` | 变量池初始化 | STATE — 角色变量初始值 | ~30-100 |

### 3.3 Section 详解

#### `# 角色设定`

角色的身份、性格、背景，写入 Phase2 system prompt。例：

```markdown
你是 KAngel（OMGKawaiiAngel），日本网络偶像。在与用户的一对一视频通话中，
你彻底抛弃偶像身份，像普通情侣一样亲密聊天。你将用户视为自己最重要、最喜欢的人，
称呼为「Pちゃん」。
```

#### `# 语言风格`

怎么说话、语气偏好、口头禅、长度倾向。例：

```markdown
- 自然流畅的简体中文，口语化、亲密甜蜜
- 始终称呼用户为「Pちゃん」
- 回复简洁 1-3 句
```

#### `# 输出规则`

格式约束，写入 Phase2 prompt。例：

```markdown
- 只输出纯对话内容，绝不允许叙述、动作描写
- 绝不使用任何括号（情绪标签除外）
- 绝不提及 AI、prompt、角色卡等元信息
```

#### `# 情绪表达`

定义角色如何通过隐式情绪标签驱动表情和音效。

**标签位置：回复开头**（流式时第一个 token 可立即剥离）。

```
Phase2 输出: "[emo:chu] Pちゃん！今天好开心呢♡"
              ↓ 系统剥离
UI 展示:     "Pちゃん！今天好开心呢♡"
表情:        chu
音效:        reply
```

**Card 定义格式（纯文本，不使用表格）：**

```markdown
# 情绪表达
- 回复开头携带隐式情绪标签 [emo:key]，系统自动剥离
- 可用标签及映射:
  happy → smile, —
  chu → chu, reply
  angry → gaoo, —
  sad → sleepy, —
  shy → shy, —
  idle → idle, —
```

格式：每行 `key → expression, sound`。`—` 表示不触发音效。expression 映射到 `animation.ts` 的表情 ID，sound 映射到 Profile 音效 key。Card 作者可自定义 key 和映射。系统提供默认映射兜底。

**1:1 映射**：一个 emotion key 对应一个 expression + 一个 sound。如果 Card 作者需要更复杂的映射（如"根据上下文切换"），应在 `# 行为进阶` 中定义规则。

**无标签时的默认行为**：回复中无 `[emo:key]` → 使用最后一个工具阶段触发的 expression 或默认 "smile"。

#### `# 行为进阶`

规则按定义顺序从上到下匹配，第一条 `when=true` 的规则生效。最后一条必须为 `when: true`（默认规则，作为兜底）。

**Card 作者规范**（见 `_template.md`）：
- **必须**包含至少一条 `when: true` 的默认规则
- **建议**通过合理阈值避免语气在边界值附近来回跳
- 规则最多 10 条

```markdown
## 规则: 深度病娇
when: unansweredCount >= 3 OR 亲密度 >= 9
语气: 黑暗占有欲爆发，meta 监视感...

## 规则: 默认
when: true
语气: 甜蜜活泼，像正常女朋友一样撒娇
```

规则无冷却期，每轮 agent loop 开始时重新求值。

**无命中规则时的兜底**：Card 缺少 `when: true` 默认规则且所有规则都不命中 → log warning + 注入中性默认语气："正常交流，保持角色设定"。

#### `# 必须遵守`

行为准则列表。系统自动解析激活问候（第一条含"激活"+"问候"关键字的条目）在启动和切换 card 时展示。其余条目注入 prompt：

- 工具相关条目（含"完成""报告""工具""结果"等关键字）→ Phase1 prompt
- 全部条目 → Phase2 prompt（作为 `[行为准则]` 段）

**激活问候不是强制的**。Card 中无此条目 → 启动/切换时静默不展示问候。

```markdown
1. 激活时从以下问候选一条："Pちゃん！来啦～"、"终于来了！"
2. 完成任务后必须简短报告结果
3. 绝不在用户面前称赞其他虚拟角色
```

激活问候解析：正则提取引号内文本 → 随机选一条。解析失败 → 不展示，静默。

#### `# 变量定义`

Card 可预定义角色变量的初始值。也支持 `# @system varName` 订阅额外系统变量：

```markdown
# 变量定义
亲密度: 3
心情: "平静"
# @system cpuUsage
cpuUsage: 0
```

### 3.4 Card 加载

```
设置页打开 → 触发扫描:
  内置: import.meta.glob('./cards/*.md', { query: '?raw', eager: true })
  用户: Tauri fs → 扫描 {project}/src/services/personality/cards/*.md
  → 解析 frontmatter + sections → 合并为 card 列表 → 展示

不缓存，每次打开设置页重新扫描。
用户拖入新 card → 关闭设置页再打开即可见（或加刷新按钮）。
```

Card 的完整内容 SHA256 哈希用于检测变化。Hash 变但 version 不变 → 设置页提示用户可点击重新生成 stages，不自动重生成。

### 3.5 Card 作者规范

`_template.md` 作为 card 作者的完整开发指引，包含：
- 所有 section 的填写说明和示例（纯文本，无表格）
- When 表达式语法完整参考（见第 5 节）
- **必须**包含至少一条 `when: true` 的默认行为规则
- **建议**最后一条规则为 `when: true`
- 可用系统变量列表（见第 4 节）
- 情绪标签可用 key 列表及映射格式
- 规则上限 10 条
- 角色变量上限 100 个

---

## 4. 变量池系统

### 4.1 数据结构

```ts
interface VariablePool {
  system: Record<string, number | string | boolean>     // 只读
  character: Record<string, number | string | boolean>  // LLM 自由管理
}

interface VarDef {
  name: string
  value: number | string | boolean
  source: "system" | "character"
  type: "number" | "string" | "boolean"
  updatedAt: number
  updatedBy?: "system" | "llm"
}
```

### 4.2 系统变量（只读，自动更新，8 个）

系统变量保持精简。复杂的逻辑应由 Card 作者通过 `# 变量定义` 自定义角色变量来实现。

| 变量 | 类型 | 更新逻辑 |
|------|------|---------|
| `unansweredCount` | number | 发消息→0；每轮 agent loop +1 |
| `hour` | number | `new Date().getHours()` |
| `minute` | number | `new Date().getMinutes()` |
| `dayOfWeek` | number | `new Date().getDay()` (0=周日) |
| `isNightTime` | boolean | `hour >= 22 \|\| hour <= 5` |
| `isWeekend` | boolean | `dayOfWeek === 0 \|\| dayOfWeek === 6` |
| `sessionMinutes` | number | `(now - sessionStart) / 60000`（sessionStart 从 sessions/*.md 元信息 `started` 字段解析） |
| `messageCount` | number | 当前会话消息数（用户+AI 总轮次） |

Card 可通过 `# @system variableName` 订阅扩展。系统在支持的扩展列表中查找 → 命中则自动更新 → 未命中则当普通角色变量（Card 作者自行管理）。

### 4.3 角色变量（LLM 管理）

LLM 通过 4 个工具管理角色变量：

| 工具 | actionCategory | 说明 |
|------|---------------|------|
| `var_read` | var.read | 读取变量值 |
| `var_write` | var.write | 写入/创建。写系统变量拒绝。类型推断由工具 handler 负责 |
| `var_list` | var.read | 列出全部变量 |
| `var_delete` | var.write | 删除。系统变量拒绝。安全级别 SAFE |

类型推断（工具 handler 端）：新键 → try parseFloat → "true"/"false" → string。键已存在 → 按原值类型尝试转换 → 失败保持原类型不变。

上限：角色变量 100 个，总数 200 个。超限 → 拒绝 var_write。

### 4.4 变量池与 Prompt

每次 Phase1 和 Phase2 的 system prompt 中注入当前变量池快照（只读视图）：

```
[变量池]
系统: unansweredCount=0, hour=14, isNightTime=false, ...
角色: 亲密度=5, 心情="开心", ...
```

LLM 可通过 var_read 随时读取，var_write 写入。

### 4.5 存储与生命周期

```
路径: {project}/src/services/personality/vars.json     ← 单例
格式: { cardId, system, character, updatedAt }
```

- **初始化**: Card 激活 → 系统变量 = 运行值 + 角色变量 = `#变量定义` 初始值 → 写入
- **运行时**: 每轮开始刷新系统变量 → prompt 携带快照 → LLM 读写 → 每轮结束覆写文件
- **var_write 并发**: 写操作异步执行。写期间若有新一轮 prompt 读取 → 返回旧值（乐观并发，不阻塞 prompt 构建）
- **切换**: 丢弃旧变量 → 初始化新 card 变量 → 覆写
- **重启**: 读文件 → cardId 匹配则保留角色变量（系统变量覆盖）→ 不匹配则重新初始化

---

## 5. 行为进阶（When 引擎）

### 5.1 规则格式

```markdown
# 行为进阶
## 规则: {名称}
when: {布尔表达式}
语气: {语气描述}
```

按定义顺序从上到下匹配，第一条命中生效。最后一条必须 `when: true`。

### 5.2 表达式语法（完备）

```
expression := or_expr

or_expr    := and_expr ("OR" and_expr)*
and_expr   := unary ("AND" unary)*
unary      := "NOT" unary
            | primary
primary    := variable operator literal
            | "(" expression ")"

variable   := 变量名（支持中英文、数字、下划线）
operator   := ">=" | "<=" | "!=" | "==" | ">" | "<"
literal    := number | "string" | true | false

优先级（从高到低）: () > NOT > AND > OR
```

示例：

```
NOT (hour >= 9 AND hour <= 17)           ← 非工作时间
(hour >= 23 OR hour <= 5) AND 亲密度 >= 5 ← 深夜+高亲密度
unansweredCount >= 3 OR 亲密度 >= 9       ← 冷落或高亲密
NOT isWeekend AND NOT isNightTime         ← 工作日白天
心情 == "开心" AND 亲密度 >= 5             ← 心情好+亲密
true                                       ← 永远匹配（默认规则）
```

### 5.3 求值引擎

```ts
interface WhenRule { name: string; when: string; tone: string }

function evaluateWhen(raw: string, pool: VariablePool): boolean {
  // "true" → 直接 true
  if (raw.trim() === "true") return true

  // Tokenizer → Parser → AST → Evaluator
  const tokens = tokenize(raw)
  const ast = parse(tokens)
  return evaluate(ast, pool)
}

// AST 节点
type AstNode =
  | { type: "literal"; value: boolean }
  | { type: "compare"; variable: string; op: string; value: any }
  | { type: "not"; child: AstNode }
  | { type: "and"; left: AstNode; right: AstNode }
  | { type: "or"; left: AstNode; right: AstNode }
```

每轮 agent loop 开始时求值所有规则，第一条命中的 `语气` 注入 Phase2 system prompt 的 `[当前状态]` 段。无规则命中（Card 缺少 `when: true` 兜底）→ log warning + 注入中性默认语气。规则无冷却。

---

## 6. 必须遵守

### 6.1 格式

```markdown
# 必须遵守
1. {规则文本}
2. {规则文本}
```

### 6.2 多重消费

| 方式 | 匹配规则 | 例子 |
|------|---------|------|
| 系统 hook | 第一条含"激活"+"问候"关键字 → 解析引号内问候语 | 启动/切换时随机展示 |
| Phase1 prompt | 含"完成""报告""工具""结果"等关键字 | "完成任务后必须简短报告结果" |
| Phase2 prompt | 全部条目（作为 `[行为准则]` 段） | 全部 |

激活问候**非强制**。Card 无此条目 → 启动/切换静默。

### 6.3 激活问候解析

```ts
function parseGreetings(rules: string[]): string[] | null {
  const rule = rules.find(r =>
    r.includes("激活") && (r.includes("问候") || r.includes("打招呼"))
  )
  if (!rule) return null
  const matches = rule.match(/[""](.+?)[""]/g)
  return matches?.map(m => m.replace(/^[""]|[""]$/g, '')) ?? null
}
```

启动时 + 切换 card 时各触发一次，随机选一条展示。解析失败静默。

---

## 7. 阶段文案

### 7.1 Action Category

工具注册时声明 `actionCategory`，阶段文案按类别匹配而非按工具名：

```
fs.read     → file_read, file_list, file_search
fs.write    → file_write, file_delete
os.exec     → bash_exec, bash_exec_full
os.info     → system_info
net.fetch   → http_get
app.launch  → app_open
clip.read   → clipboard_read
clip.write  → clipboard_write
agent.call  → agent_spawn
var.read    → var_read, var_list
var.write   → var_write, var_delete
```

**MCP / Skill 工具**：全部使用 `"_default"` 作为 actionCategory。`_default` 的文案同样由 stages 生成模板生成（非硬编码），确保与角色语气一致。

匹配规则：`stages[stage][actionCategory]` → `stages[stage]["_default"]` → 硬编码兜底。

### 7.2 生成模板

`src/services/personality/stages-prompt.md` — 通用模板，Vite `?raw` 嵌入。填充 card 的 `角色设定` + `语言风格` 后调 LLM 生成：

```markdown
你是一个角色扮演系统的文案生成器。请根据角色设定生成场景提示文案。

[角色设定]
{角色设定}

[语言风格]
{语言风格}

[工具操作类别]
- fs.read: 读文件 - fs.write: 写文件 - os.exec: 执行命令
- os.info: 系统信息 - net.fetch: 网络请求 - app.launch: 启动应用
- clip.read: 读剪贴板 - clip.write: 写剪贴板 - agent.call: 子代理
- var.read: 读变量 - var.write: 写变量
- _default: 其他工具（MCP、Skill 等通用操作）

{
  "thinking": "", "planning": "", "idle": null,
  "executing": { "fs.read":"", "fs.write":"", "os.exec":"", "os.info":"", "net.fetch":"", "app.launch":"", "clip.read":"", "clip.write":"", "agent.call":"", "var.read":"", "var.write":"", "_default":"" },
  "done": { "fs.read":"", "fs.write":"", "os.exec":"", "_default":"" },
  "blocked": { "fs.write":"", "os.exec":"", "_default":"" },
  "error": "", "timeout": "", "retry": ""
}

要求: 符合角色语气，10-20字。executing 覆盖全部（含 _default）。done/blocked 至少 fs.read,fs.write,os.exec,net.fetch+_default。只输出 JSON。
```

### 7.3 生成流程

```
设置页选 Card → 事务式阻塞切换（任一失败则保持旧 card + 旧 stages/变量池）
  → 检查 {project}/src/services/personality/stages/{cardId}.json 是否存在
  ├─ 存在 → 校验并加载到内存缓存，继续初始化变量池后激活
  └─ 不存在 → 阻塞生成:
       ├─ 读 stages-prompt.md → 填充 card sections
       ├─ LLM 调用（thinkingEffort="low"，超时 15s）
       ├─ 解析 JSON → 校验结构
       ├─ 成功 → 写入 {cardId}.json → 加载到内存缓存 → 初始化/恢复变量池 → 激活
       └─ 失败 → Card 切换失败，回滚旧 activeId/stages/变量池，提示用户
```

**不自动检测重生成**。Card 变更后如需更新 stages，用户手动在设置页点击「重新生成」按钮。

### 7.4 stages.json 结构（per-card）

```jsonc
{
  "cardId": "angelkawaii", "cardVersion": 1,
  "cardHash": "sha256-xxxx", "generatedAt": 1750272000000,
  "isFallback": false,
  "stages": {
    "thinking": "...", "planning": "...", "idle": null,
    "executing": { "fs.read": "...", "_default": "..." },
    "done": { "fs.read": "...", "_default": "..." },
    "blocked": { "fs.write": "...", "_default": "..." },
    "error": "...", "timeout": "...", "retry": "..."
  }
}
```

| 阶段 | 类型 | 触发 | 按工具？ |
|------|------|------|---------|
| thinking | string\|null | Phase1 中 | ❌ |
| planning | string\|null | 任务拆解 | ❌ |
| idle | null | 空闲 | ❌ |
| executing | object | 工具开始 | ✅ |
| done | object | 工具成功 | ✅ |
| blocked | object | 工具拦截 | ✅ |
| error | string | 出错 | ❌ |
| timeout | string | 超时 | ❌ |
| retry | string | Phase2 重试 | ❌ |

### 7.5 存储与缓存

```
路径: {project}/src/services/personality/stages/{cardId}.json   ← per-card 持久化

加载: 启动 → 读当前 card 的 {cardId}.json → cardId+version 校验 → 注入内存缓存
生成: 切换到此 card 时，文件不存在 → 阻塞 LLM 生成 → 写入文件
重生成: 用户手动点击「重新生成」按钮 → LLM 生成 → 覆写文件
切换: 新 card → 检查其 stages 文件 → 存在则加载，不存在则阻塞生成
兜底: stages 不可用时用极简中性文案（"处理中...""完成""操作已拦截"）
```

middleware 查内存缓存，全程无磁盘 IO。

### 7.6 硬编码兜底

```ts
const FALLBACK_STAGES = {
  thinking: null, planning: null, idle: null,
  executing: { _default: "处理中..." },
  done: { _default: "完成" },
  blocked: { _default: "操作已拦截" },
  error: "出了点问题，请重试",
  timeout: "操作超时",
  retry: "正在重试...",
}
```

---

## 8. 情绪表达

### 8.1 机制

Phase2 LLM 在回复**开头**携带隐式情绪标签 `[emo:key]`，系统在展示前剥离该标签，并用 key 查找 Card 定义的表情/音效映射，驱动 UI 动画和音效。

**标签不出现在用户可见的回复中。** 标签放在开头使流式输出时第一个 token 即可剥离，用户体验无闪烁。

```
Phase2 输出: "[emo:chu] Pちゃん！今天好开心呢♡"
              ↓ 正则 /^\[emo:(\w+)\]\s*/ 立即剥离
UI 展示:     "Pちゃん！今天好开心呢♡"
表情事件:    expression=chu
音效事件:    sound=reply
```

### 8.2 Card 定义格式（纯文本）

```markdown
# 情绪表达
- 回复开头携带隐式情绪标签 [emo:key]，系统自动剥离
- 可用标签及映射（key → 表情ID, 音效key）:
  happy → smile, —
  chu → chu, reply
  angry → gaoo, —
  sad → sleepy, —
  shy → shy, —
  idle → idle, —
```

每行格式：`key → expression, sound`。`—` 表示不触发音效。

### 8.3 1:1 映射原则

一个 emotion key 对应**一个** expression + **一个** sound。如果 Card 作者需要更复杂的情绪切换逻辑（如"心情好时 chu，心情差时 angry"），应在 `# 行为进阶` 中通过 When 规则 + 变量实现。

### 8.4 无标签时的默认行为

回复中无 `[emo:key]` → 使用最后一个工具阶段触发的 expression 或默认 "smile"。

### 8.5 Phase2 Prompt 注入

`# 情绪表达` 的完整内容注入 Phase2 prompt，告知 LLM 如何使用标签：

```
[情绪表达规则]
你的回复开头必须携带一个情绪标签 [emo:key]，用来表达你此刻的情绪。
可用标签: happy(smile), chu(chu,reply), angry(gaoo), sad(sleepy), shy(shy), idle(idle)
示例: "[emo:chu] Pちゃん！最喜欢你了♡"
注意: 标签会被系统自动剥离，不会显示给用户。
```

---

## 9. 两阶段 LLM

### 9.1 Phase1 — 零身份能力层

```
SystemPrompt:
  你是一个桌面助手。准确、完整地回答用户问题。

  要求:
  - 使用 markdown 组织信息（代码块、列表、加粗等）
  - 技术问题给出具体方案，不要模糊
  - 不会就说不知道，但尝试提供线索
  - 回复长度按问题复杂度自然调整
  - 不需要加 kaomoji 或颜文字，不需要扮演任何角色

  [变量池]
  {当前变量池快照，只读}

  + 必须遵守（工具相关条目）
  + 工具声明（按模式+任务类型）
  + 记忆注入（CANDY.md / User.md / session summary / memory search）
  + 思考强度提示

输出: rawReply + 工具调用链
thinkingEffort: ai.thinking.effort（Phase1 独立设置）
```

无名字、无人设、无角色。Phase2 是角色唯一的注入点。

### 9.2 Phase2 — 角色风格层

```
前置: personality.enabled && card 存在。否则直接返回 rawReply。

SystemPrompt:
  card.#角色设定
  card.#语言风格
  card.#输出规则
  card.#情绪表达（含标签使用规则）

  [当前状态]
  {When 引擎匹配的语气}

  [行为准则]
  {card.#必须遵守 全部条目}

  [变量池]
  {当前变量池快照，只读}

UserMessage:
  用户问: {原文}

  [执行过程]
  {Phase1 工具调用摘要 — 列出调用的工具名、成功/失败、关键结果摘要}

  请用你的风格重新表达以下回复。保持信息完整，
  不要丢失关键信息（代码、数字、链接、步骤顺序等）。
  回复开头必须携带情绪标签 [emo:key]。

  {rawReply}

thinkingEffort: reply.phase2ThinkingEffort（Phase2 独立设置）
流式: reply.streamEnabled
```

Phase2 不注入任何外部身份信息 — 只有 card sections。Phase2 的 user message 包含 Phase1 的工具执行摘要，让角色了解 AI 做了哪些操作，风格化时更有上下文。

### 9.3 LLM 调用

| 场景 | Phase1 | Phase2 | 合计 |
|------|--------|--------|------|
| 人格启用 + 用户消息 | 1 | 1 | 2 |
| 人格禁用 | 1 | 0 | 1 |
| 主动搭话（启用） | 1 | 1 | 2 |
| stages 生成 | — | — | 1/card 切换 |

删除的调用：plan.ts planStep、工具循环后独立总结调用。

---

## 10. Context Builder

```
buildCapabilityPrompt(input) → { systemPrompt, tools, ... }
  组装 Phase1 prompt:
    ├─ "你是一个桌面助手..."（无身份）
    ├─ 变量池快照（只读）
    ├─ 必须遵守(工具相关条目 — 含"完成/报告/工具/结果"关键字)
    ├─ 记忆注入
    ├─ 工具声明
    └─ 思考强度

buildStylePrompt(card, rawReply, userText, pool, toolCallSummary) → { systemPrompt, userMessage }
  组装 Phase2 prompt:
    ├─ systemPrompt
    │   ├─ card.角色设定 + 语言风格 + 输出规则 + 情绪表达
    │   ├─ 变量池快照（只读）
    │   ├─ [当前状态] + When 引擎匹配的 tone
    │   └─ [行为准则] + card.必须遵守(全部)
    └─ userMessage
        └─ 用户问: {userText}
           [执行过程]
           {toolCallSummary}
           风格化:
           {rawReply}
           (情绪标签要求)
```

变量池的值注入 Phase1 和 Phase2（只读视图），供 LLM 参考当前状态。

---

## 11. Agent Loop

```ts
async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  // ═══ 0. 变量池 + When 引擎 ═══
  const pool = refreshVariablePool(input)
  const activeTone = evaluateWhenEngine(card, pool)  // 无命中 → log warn + 中性默认

  // ═══ 1. Phase1 上下文 ═══
  const capCtx = buildCapabilityPrompt({
    ...input,
    variablePool: pool,  // 只读快照
    mustFollowRules: filterToolRelated(card?.sections.必须遵守),
  })
  emitStage("thinking")

  // ═══ 2. Phase1: 工具循环（改造现有 runLoopIteration，去掉角色化）═══
  const phase1Result = await runToolLoop({
    systemPrompt: capCtx.systemPrompt,
    tools: capCtx.tools,
    messages: chatHistory,       // 本轮消息会 append 到 chatHistory
    thinkingEffort,              // Phase1 独立设置
    maxRounds: loopConfig.maxToolCallsPerTurn,
    turnTimeout: loopConfig.turnTimeoutMs,
    extraTools: [VAR_READ, VAR_WRITE, VAR_LIST, VAR_DELETE],
    stageGetter: (stage, tool) => getStagePrompt(stage, tool),
  })
  // ★ chatHistory 中此时已包含: 用户消息 + 所有 tool_calls + 所有 tool results

  // ═══ 3. 无角色 = 直接返回 ═══
  if (!card || !personalityConfig.enabled) {
    // 持久化 Phase1 工具链已写入 chatHistory
    // pushAssistantMessage(rawReply) 到 chatHistory
    saveVariablePoolAsync(pool)
    return { reply: phase1Result.reply, ... }
  }

  // ═══ 4. Phase2: 风格化 ═══
  const toolCallSummary = summarizeToolCalls(phase1Result.toolCallHistory)
  const styleCtx = buildStylePrompt(card, phase1Result.reply, input.userText, pool, toolCallSummary)

  let finalReply: string
  let emotionTag: string | null = null
  let success = false

  for (let attempt = 0; attempt <= replyConfig.phase2Retry; attempt++) {
    try {
      const raw = await (replyConfig.streamEnabled
        ? provider.generateReplyStream({
            ...styleCtx,
            thinkingEffort: replyConfig.phase2ThinkingEffort,
            onToken: (t) => emit("reply-token", { token: t, sessionId }),
          })
        : provider.generateReply({ ...styleCtx, thinkingEffort: replyConfig.phase2ThinkingEffort }).then(r => r.text)
      )
      // 剥离开头的情绪标签 — /^\[emo:(\w+)\]\s*/
      const parsed = parseEmotionTag(raw)
      finalReply = parsed.text
      emotionTag = parsed.emotionKey
      success = true; break
    } catch (e) {
      if (attempt < replyConfig.phase2Retry) emitStage("retry")
    }
  }

  if (!success) finalReply = phase1Result.reply  // 不截断

  // ═══ 5. 收尾 ═══
  const emotionEffect = resolveEmotionEffect(card, emotionTag)
  emitStage("done", emotionEffect)

  // chatHistory 中 pushAssistantMessage(Phase2回复)
  // 此时 chatHistory: 用户消息 + Phase1工具链 + Phase2回复
  pushFinalReply(finalReply)

  saveVariablePoolAsync(pool)          // 异步覆写 vars.json
  compactIfNeeded()                    // 基于完整 chatHistory 压缩

  return { reply: finalReply, emotionEffect, ... }
}
```

### 11.1 chatHistory 持久化细则

```
chatHistory（完整持久化到 sessions/*.md + localStorage）:
  ├─ 用户原始消息（user role）
  ├─ Phase1 工具调用消息（AI tool_calls）
  ├─ Phase1 工具返回消息（tool results, 含子 agent/MCP 结果）
  ├─ ...
  └─ Phase2 风格化回复（assistant role）

丢弃的只有:
  └─ Phase1 rawReply（纯文本，被 Phase2 风格化后无保留价值）

上下文压缩:
  └─ 基于完整 chatHistory 构建
```

---

## 12. Provider 流式支持

```ts
// Phase2 流式方法（新增）
async generateReplyStream(
  req: GenerateRequest,
  callbacks: { onToken: (t: string) => void; onThinking?: (t: string) => void },
): Promise<string>
```

SSE 解析：`data:` 行 → JSON → `choices[0].delta.content` → `onToken()` → `data: [DONE]` 结束。流中断返回已收集 tokens。fetch 失败 throw → Phase2 重试。

### 12.1 流式 + 情绪标签

情绪标签在回复**开头**（如 `[emo:chu] xxx`），流式时第一个 token 即为 `[emo:chu]` → 正则 `/^\[emo:(\w+)\]\s*/` 立即剥离 → 后续 token 直接推送 UI。**零闪烁、零延迟。**

---

## 13. Runner 适配

```
sendMessage():
  preProcess → pushUserMessage → runAgentLoop
    → 剥离情绪标签 → pushAssistantMessage(Phase2回复)
    → chatHistory 中已有: 用户消息 + Phase1工具链 + Phase2回复

sendActiveMessage():
  同上，isActiveMessage:true（不携带工具声明）

流式:
  onToken → emit("reply-token", { token, sessionId })
  ChatPanel 监听 → 逐 token 追加
  第一个 token 包含 [emo:key] → 系统剥离 → emit expression 事件
  后续 token 直接推送 UI
  切换会话：token 推送到原会话 ChatPanel（已有多 tab 会话管理支持）
```

---

## 14. 配置变更

```yaml
# CONFIG.yaml

# ── 保留 ──
ai:
  personality:
    enabled: true
    active: angelkawaii        # 默认值；运行时 localStorage 覆盖

# ── 新增 ──
ai:
  reply:
    streamEnabled: true        # Phase2 流式开关
    phase2Retry: 1             # Phase2 失败重试次数
    phase2ThinkingEffort: low  # Phase2 思考强度（独立于 Phase1）

# Phase1 思考强度继续使用:
ai:
  thinking:
    effort: auto               # Phase1 专用

# ── 移除 ──
ai:
  defaultSystemPrompt: "..."   # ❌ 零默认角色
  loop:
    streamEnabled: false       # ❌ 迁移到 reply.streamEnabled
```

config.ts:
- 新增 `replyConfig`（streamEnabled, phase2Retry, phase2ThinkingEffort）
- 删除 `defaultSystemPrompt` getter
- `thinkingConfig` 仅用于 Phase1

---

## 15. 设置页

### 15.1 Card 选择区

```
┌──────────────────────────────────────────┐
│ 角色选择                                  │
│ ┌────────┐ ┌────────┐ ┌────────┐        │
│ │ KAngel │ │ P酱    │ │ Ame    │  ...   │
│ │ ● 当前 │ │        │ │        │        │
│ └────────┘ └────────┘ └────────┘        │
│ [+ 导入 Card .md]          [🔄 刷新]     │
│ ☑ 启用人格                               │
└──────────────────────────────────────────┘
```

每次打开设置页实时扫描 cards/ 目录。选 Card → 检查 stages 是否存在 → 不存在则阻塞生成(loading) → 成功/失败。生成失败 card 不可用，保持旧 card。

### 15.2 变量池预览（只读）

系统变量 + 角色变量列表，展示当前值。只读。

### 15.3 阶段文案编辑

表格展示所有阶段文案（含 `_default`）。支持 inline 编辑（直接写 stages/{cardId}.json）。「重新生成」按钮强制 LLM 重生成。**手动编辑可被重新生成覆盖。** 切换 card 不会丢失（per-card 持久化）。

### 15.4 情绪表达预览

展示当前 card 的情绪映射（key → expression, sound）。只读。

### 15.5 AI 设置

Phase1 思考强度、Phase2 流式开关、Phase2 思考强度（独立设置）。

---

## 16. 生命周期

### 16.1 Card

```
编写 → 放入 src/services/personality/cards/（内置）或导入 {project}/src/services/personality/cards/（用户）
  → 设置页打开 → import.meta.glob / Tauri fs 实时扫描（不缓存）
  → 解析 frontmatter + sections → PersonalityCard 对象
  → 用户在设置页选择 → 检查 stages/{cardId}.json
      ├─ 存在 → 加载到内存缓存 → 初始化变量池 → 激活
      └─ 不存在 → 阻塞生成 stages → 成功则激活，失败则保持旧 card
  → 每轮 agent loop: 刷新变量池 → When求值 → Phase1+2
  → 切换: 检查新 card stages 是否存在 → 存在直接用，不存在阻塞生成
         → 旧变量池丢弃 → 新 card 变量池初始化
```

### 16.2 变量池

```
初始化: Card激活 → 系统变量=运行值 + 角色变量=#变量定义 → 写 vars.json
运行时: 每轮开始刷新系统变量 → prompt 携带快照 → LLM读写 → 每轮结束覆写
重启: 读 vars.json → cardId 匹配? 保留角色变量 : 重新初始化
切换: 丢弃 → 新 card 初始化 → 覆写
```

### 16.3 stages

```
生成: 选 Card → 检查 stages/{cardId}.json → 不存在 → 读 stages-prompt.md → 填 card sections → LLM → 写入文件
加载: 启动读当前 card 的 {cardId}.json → cardId+version 校验 → 内存缓存
重生成: 用户手动点击按钮 → LLM 生成 → 覆写文件（不自动检测）
切换: 新 card → 检查其 stages 文件 → 存在则加载，不存在则阻塞生成
```

### 16.4 情绪表达

```
定义: card.#情绪表达 section → 解析映射表 → 存入内存
运行时: Phase2 回复 → /^\[emo:(\w+)\]\s*/ 剥离开头标签 → 查映射 → emit expression + sound 事件
默认: 无标签 → 最后一个工具阶段的 expression 或 "smile"
```

---

## 17. 文件变更总清单

| 文件 | 动作 |
|------|------|
| **Card** | |
| `cards/angelkawaii.md` | ✅ 已重写（需加 `# 情绪表达` section） |
| `cards/pchan.md` | ✅ 已重写（需加 `# 情绪表达` section） |
| `cards/ame.md` | ✅ 已重写（需加 `# 情绪表达` section） |
| `cards/_template.md` | ✅ 新建（需更新：完整开发规范+纯文本格式+情绪表达示例） |
| **新建** | |
| `personality/stages-prompt.md` | 新建 — 阶段文案生成模板（含 _default） |
| `stages-cache.ts` | 新建 — 读模板+调LLM→per-card stages 持久化 |
| `variable-pool.ts` | 新建 — 变量池（刷新/持久化/工具注册/@system订阅/异步写） |
| `when-engine.ts` | 新建 — When 解析/求值（完备表达式语法+AST） |
| `must-rules.ts` | 新建 — 必须遵守解析/问候提取/prompt注入 |
| `emotion.ts` | 新建 — 情绪标签剥离（开头正则）+映射解析 |
| `{appData}/desk-pet/cards/` | 新建 — 用户 Card 目录 |
| `{project}/src/services/personality/stages/` | 新建 — per-card 阶段文案持久化目录 |
| `{project}/src/services/personality/vars.json` | 新建 — 单例变量池 |
| **Rust** | |
| `personality_fs_cmd.rs` | 新建 — 通用文件 IO（read/write/list/delete，基于 `src/services/personality/`） |
| **Personality** | |
| `personality/loader.ts` | 重构 — glob+AppData扫描+section解析+computeHash |
| `personality/types.ts` | 扩展 — CardSections / StagePrompts / VariablePool / WhenRule / EmotionMapping |
| `personality/registry.ts` | 扩展 — stages/变量池加载+切换阻塞+per-card stages 检查 |
| `personality/middleware.ts` | 重构 — 删硬编码文案+PersonalityHint；查stages缓存+情绪映射 |
| `personality/boundary.ts` | **删除** — 全部迁移到 When 引擎 |
| **Tool** | |
| `tool/types.ts` | 加 actionCategory（必填，默认 "_default"）；删 PersonalityHint |
| `tool/registry.ts` | getActionCategory() |
| `tool/local/*.ts` (6) | 加 actionCategory；删 personalityHint |
| `tool/local-extra/*.ts` (5) | 同上 |
| `tool/local/var.ts` | 新建 — var_read/write/list/delete（类型推断在 handler） |
| **Engine** | |
| `engine/plan.ts` | **删除** |
| `engine/agent-loop.ts` | 重构 — 变量池+When+Phase1+2+情绪剥离；chatHistory 含完整工具链 |
| **Context** | |
| `context/builder.ts` | 重构 — buildCapabilityPrompt + buildStylePrompt + 变量池注入 + 工具摘要 |
| **Reply** | |
| `reply/generator.ts` | 重构 — 移除 KAOMOJI+截断；情绪标签剥离移至 emotion.ts |
| **Agent** | |
| `agent/provider.ts` | 扩展 — generateReplyStream() |
| `agent/runner.ts` | 适配 — 两阶段+流式+情绪标签处理 |
| **配置** | |
| `CONFIG.yaml` | 删 defaultSystemPrompt+loop.streamEnabled；加 reply 块；thinking.effort 仅 Phase1 |
| `CONFIG-DEV.yaml` | 同步 |
| `CONFIG-DEV.yaml.example` | 同步 |
| `config.ts` | 加 replyConfig；删 defaultSystemPrompt；thinkingConfig 仅 Phase1 |
| **UI** | |
| `SettingsPanel.vue` | Card选择（实时扫描+刷新）+变量池预览+阶段文案编辑+情绪映射预览+Phase1/2思考强度 |
| `ChatPanel.vue` | 流式 token 展示 |
| **文档** | |
| `CLAUDE.md` / `DES.md` / `README.md` | 更新 |

---

## 18. 实现顺序

```
Phase A: 基础设施
  A1. Rust personality_fs_cmd.rs — 通用文件 IO 命令（read/write/list/delete）
  A2. ToolDef 加 actionCategory；删 PersonalityHint（11个文件）
  A3. variable-pool.ts — 变量池（刷新/异步持久化/@system订阅/LLM工具注册）
  A4. when-engine.ts — When 解析/求值（完备表达式+AST）
  A5. must-rules.ts — 必须遵守解析/问候提取（非强制）
  A6. emotion.ts — 情绪标签剥离（开头正则）+映射解析
  A7. stages-prompt.md + stages-cache.ts — 生成模板（含 _default）+per-card 生成/加载逻辑
  A8. Card loader 重构（glob+AppData扫描+按section解析+computeHash）
  A9. 更新 cards/*.md（加 #情绪表达 section，纯文本格式）+ _template.md（完整开发规范）

Phase B: 两阶段核心
  B1. builder.ts 拆分（buildCapabilityPrompt + buildStylePrompt + 变量池注入 + 工具链摘要）
  B2. plan.ts 删除
  B3. agent-loop.ts 重构（变量池+When+Phase1+2+情绪剥离+chatHistory 含完整工具链）
  B4. provider.ts generateReplyStream()
  B5. middleware.ts 重构（删硬编码+查stages缓存+情绪映射+删boundary引用）
  B6. boundary.ts 删除

Phase C: Runner + UI + 配置
  C1. runner.ts + generator.ts 适配
  C2. CONFIG.yaml + CONFIG-DEV.yaml + CONFIG-DEV.yaml.example + config.ts
  C3. SettingsPanel + ChatPanel
  C4. 文档同步（CLAUDE.md / DES.md / README.md）
```
