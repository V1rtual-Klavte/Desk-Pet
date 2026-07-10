# 变量池重构设计 v2

> 日期: 2026-07-09 | 状态: 设计定案 | 范围: `src/services/personality/cards/_template.md`、内置 Card、`loader.ts`、`variable-pool.ts`、`stages-cache.ts`、`context/builder.ts`、`tool/local/var.ts`、会话 markdown frontmatter

---

## 1. 结论

变量系统不再设计成一个“大 KV 池”。它拆成四类，只在 Prompt 中汇合：

| 类型 | 中文名 | 真相源 | 是否可写 | 作用域 | 典型变量 |
|------|--------|--------|----------|--------|----------|
| `system` | 系统变量 | 运行时计算；`vars.json` 只是展示快照 | 否 | 全局运行时 | `hour`、`minute`、`isNightTime`、`activeCardId` |
| `card` | Card 变量 / 角色长期状态 | `stages/{cardId}.json:variables.card` | 是，仅限注册且 `updateBy=llm` 的变量 | 单个 Card，默认跨会话共享 | `亲密度`、`心情`、`称呼` |
| `interaction` | Card 互动状态 | `stages/{cardId}.json:variables.interaction` | 否，系统内部更新 | 单个 Card，默认跨会话共享 | `unansweredCount`、`lastActiveAt` |
| `session` | 会话变量 / 会话状态 | `sessions/*.md` frontmatter + 会话内存状态 | 否，归会话系统维护 | 单个会话 | `topic`、`turnCount`、`tokenCount`、`activeSessionId` |

核心原则：

1. **Card 契约先行**：必须先重写 Card 模板/开发指引和内置 Card，才能开始 runtime 改造。
2. **系统变量只读、自动计算**，不由 LLM 更新。
3. **Card 变量由 Card 注册表约束**，LLM 只能写注册过、允许 LLM 写的变量。
4. **Interaction 变量也由 Card 注册表声明**，但只允许系统更新，用于承载 `unansweredCount` 这类人格互动状态。
5. **Session 变量不进入变量池**，继续由会话 markdown 元数据管理，第一版只作为只读上下文注入 Prompt，不给 When 读取。
6. **变量池只负责人格变量视图**，不负责整个应用状态管理。
7. Prompt 可以同时看到四类变量，但工具只允许修改 `card` 变量。

---

## 2. 当前问题

当前 `variable-pool.ts` 可以初始化变量、刷新系统变量、把变量写到 `personality/vars.json`，但严格说**还没有形成完整更新逻辑**：

1. **系统变量、Card 变量、会话状态混在一起**
   - `messageCount`、`sessionMinutes`、`unansweredCount` 被放进 system。
   - 这些值本质是会话/互动状态，切换会话或切换 Card 时会污染全局变量池。

2. **Card 变量只是初始值 KV，不是注册表驱动**
   - Card `#变量定义` 当前只解析 `name: initial`。
   - 没有 `type` / `min` / `max` / `enum` / `updateBy` / `reset` 等约束。
   - `var_write` 可以创建新变量，缺少“只允许写注册变量”的边界。

3. **Card 模板/开发指引仍是旧契约**
   - 现有 `_template.md` 引导作者写旧格式变量。
   - 如果不先重写模板和内置 Card，runtime 无法获得稳定 schema。
   - 新 Card 会继续产生无约束 KV，变量池 v2 会再次退化。

4. **持久化位置不对**
   - 当前 `vars.json` 同时保存 system 与 character。
   - Card / interaction 都是 per-card runtime state，更适合跟 stages 一起保存到 `stages/{cardId}.json`。

5. **更新链路不完整**
   - `refreshVariablePool()` 只刷新 system。
   - `var_write()` 只改内存并标记 `savePending`。
   - 没有按 Card 注册表校验，也没有立即同步写回 `stages/{cardId}.json:variables.card`。
   - Agent Loop 每轮开始/结束没有清晰的“计算 system → 恢复/重置 card/interaction → 注入 prompt → 工具/系统更新 → 落盘”的闭环。

6. **设置页跨 WebView hydrate 不稳定**
   - 设置页独立 WebView 不能依赖主窗口内存变量池。
   - 必须从磁盘分别读取 `vars.json:system`、`stages/{cardId}.json:variables`、当前 session frontmatter。

---

## 3. 阻塞前置：Phase 0 Card 契约重写

变量池 v2 的第一步不是改 runtime，而是重写 Card 输入契约。

```text
Phase 0: Card 契约重写（阻塞项）
  → 重写 src/services/personality/cards/_template.md
  → 重写全部内置 Card
  → 将 #变量定义 改为结构化 YAML block
  → 明确 card / interaction 的变量 schema
  → 明确 When 可读变量范围
  → 之后才能开始 loader / runtime / tools 改造
```

原因：

```text
没有 Card 变量注册表
  → var_write 无法校验
  → 旧 vars.json.character 无法安全迁移
  → 设置页无法展示 schema
  → reset/updateBy/persistent 没有依据
  → 变量更新闭环无法闭合
```

Phase 0 交付物：

1. `src/services/personality/cards/_template.md`：Card 作者完整开发指引 v2。
2. 内置 Card：`angelkawaii.md`、`ame.md`、`pchan.md` 使用新结构化变量 schema。
3. 设计文档：本文件作为 runtime 实现依据。
4. 兼容策略：loader 可短期兼容旧 `name: initial`，但新模板不再推荐旧格式。

---

## 4. Card 结构化变量定义

### 4.1 Card 文件结构

```md
---
id: angelkawaii
name: KAngel
description: 甜蜜活泼女友 + 深层病娇
version: 2
---

# 角色设定
...

# 语言风格
...

# 输出规则
...

# 情绪表达
...

# 行为进阶
...

# 必须遵守
...

# 变量定义
...
```

### 4.2 新 `# 变量定义` 格式

第一版采用结构化块，不再推荐单行注释格式。

````md
# 变量定义

## card

```yaml
亲密度:
  type: number
  initial: 3
  min: 0
  max: 10
  persistent: true
  updateBy: llm
  reset: never
  description: 用户与角色的亲密程度；当用户表达喜欢、信任、长期陪伴时可上升，发生拒绝或伤害时可下降。

心情:
  type: string
  initial: 平静
  enum: [开心, 平静, 失落, 生气, 害羞]
  persistent: true
  updateBy: llm
  reset: never
  description: 角色当前主观心情；当用户明确安慰、夸奖、冷落、冒犯时更新。
```

## interaction

```yaml
unansweredCount:
  type: number
  initial: 0
  min: 0
  persistent: true
  updateBy: system
  reset: never
  description: 用户连续未回应角色主动消息的次数；由系统维护，LLM 不可写。
```
````

### 4.3 变量 schema

```ts
type VariablePrimitive = number | string | boolean

type VariableScope = "card" | "interaction"
type VariableType = "number" | "string" | "boolean"
type VariableUpdateBy = "llm" | "manual" | "system"
type VariableResetPolicy = "never" | "daily" | "session"

interface CardVariableDef {
  scope: VariableScope
  name: string
  type: VariableType
  initial: VariablePrimitive
  description: string
  updateBy: VariableUpdateBy
  persistent: boolean
  min?: number
  max?: number
  enum?: string[]
  reset: VariableResetPolicy
}

interface VariableState {
  value: VariablePrimitive
  type: VariableType
  updatedAt: number
  updatedBy: "llm" | "manual" | "system" | "migration"
  lastResetAt?: number
}
```

默认值：

| 字段 | 默认值 |
|------|--------|
| `type` | 必填；旧格式兼容时可从 initial 推断 |
| `persistent` | `true` |
| `updateBy` | `card` 默认为 `llm`；`interaction` 默认为 `system` |
| `reset` | `never` |

### 4.4 updateBy 语义

| updateBy | 含义 | 第一版工具行为 |
|----------|------|----------------|
| `llm` | LLM 可通过 `var_write` 更新 | 允许写，需校验 schema |
| `manual` | 预留给设置页人工编辑 | 第一版设置页只读，不允许写 |
| `system` | 系统内部更新 | LLM 和设置页都不可写 |

### 4.5 reset 语义

| reset | 含义 |
|-------|------|
| `never` | 永不自动重置 |
| `daily` | 本地日期变化后重置为 initial |
| `session` | 新会话开始或当前会话首次使用时重置为 initial |

---

## 5. 四类变量边界

### 5.1 System：runtime-derived，只读

系统变量表示当前运行环境，不表示某个会话或某个角色的长期状态。

首批系统变量：

| 变量 | 类型 | 来源 |
|------|------|------|
| `hour` | number | 当前本地时间 |
| `minute` | number | 当前本地时间 |
| `dayOfWeek` | number | 当前本地时间，`0..6` |
| `isNightTime` | boolean | `hour >= 22 || hour <= 5` |
| `isWeekend` | boolean | `dayOfWeek === 0 || dayOfWeek === 6` |
| `activeCardId` | string | 当前启用 Card |

明确不放入 system 的内容：

| 变量 | 应属类型 | 原因 |
|------|----------|------|
| `messageCount` | session | 多会话切换会污染全局变量池 |
| `sessionMinutes` | session | 单会话生命周期，不是全局运行时 |
| `activeSessionId` | session | 工程状态，不是人格变量 |
| `topic` | session | 会话元数据已在 markdown frontmatter 中维护 |
| `unansweredCount` | interaction | 影响人格表现，但不是纯系统变量 |

`vars.json` 只保存 system 快照，主要服务设置页展示和调试：

```jsonc
{
  "schemaVersion": 2,
  "system": {
    "hour": 14,
    "minute": 20,
    "dayOfWeek": 2,
    "isNightTime": false,
    "isWeekend": false,
    "activeCardId": "angelkawaii"
  },
  "updatedAt": 1783403917788
}
```

运行时每轮重新计算 system；不得把 `vars.json` 当成 system 真相源。

### 5.2 Card：角色长期状态，可控可写

Card 变量表示角色与用户关系、角色当前状态、跨会话共享的长期人格状态。

写入规则：

1. `var_write` 只能写 `scope=card` 且注册表里存在的变量。
2. 只有 `updateBy=llm` 的变量允许 LLM 写。
3. 类型必须匹配，number 支持 parse 后校验。
4. number 超出 `min/max` 时第一版拒绝并返回错误。
5. enum 不匹配时拒绝。
6. 未注册变量不创建，第一版不支持动态变量。

### 5.3 Interaction：系统维护的互动状态

Interaction 变量承载“影响人格但由系统维护”的状态。

第一版明确：`unansweredCount` 放入 `interaction`。

原则：

1. 在 Card `#变量定义 > ## interaction` 中声明 schema。
2. 持久化到 `stages/{cardId}.json:variables.interaction`。
3. 可进入 Prompt。
4. 可进入 When。
5. 不允许 `var_write` 修改。
6. 由系统事件更新，例如主动搭话未回复 +1、用户发消息重置为 0。

### 5.4 Session：会话元数据，只读注入

会话变量继续保存在 `sessions/session-*.md` frontmatter 和会话内存状态中。

示例：

```yaml
---
sessionId: "20260709-153000"
topic: "变量池设计"
createdAt: "2026-07-09T15:30:00+08:00"
updatedAt: "2026-07-09T16:10:00+08:00"
turnCount: 12
tokenCount: 34800
contextRatio: 0.31
---
```

Session 变量使用原则：

1. 不保存到 `personality/vars.json`。
2. 不保存到 `stages/{cardId}.json`。
3. 不允许 `var_write` 修改。
4. 第一版只由 ContextEngine 以只读 `[会话状态]` 注入 Prompt。
5. 第一版不进入 When 引擎。
6. 如果未来需要 LLM 查询完整会话元数据，应单独设计 `session_read`，不要扩展 `var_*` 的职责。

---

## 6. 文件布局

```text
src/services/personality/
  cards/
    _template.md                # Card 作者开发指引 v2
    angelkawaii.md
    ame.md
    pchan.md
  stages/
    angelkawaii.json            # stages + variables(card/interaction)
    ame.json
    pchan.json
  vars.json                     # system snapshot only
  stages-prompt.md
  stages-cache.ts
  variable-pool.ts
  when-engine.ts

sessions/
  session-YYYYMMDD-HHmmss-topic.md  # session frontmatter + turns
```

`stages/{cardId}.json` 同时保存阶段文案和 Card runtime variables：

```jsonc
{
  "cardId": "angelkawaii",
  "cardVersion": 2,
  "cardHash": "sha256...",
  "generatedAt": 1783403754321,
  "isFallback": false,
  "stages": {
    "thinking": null,
    "planning": null,
    "executing": {},
    "done": {},
    "blocked": {},
    "error": "出了点问题，请重试",
    "timeout": "操作超时",
    "retry": "正在重试..."
  },
  "variables": {
    "schemaVersion": 2,
    "updatedAt": 1783403917788,
    "card": {
      "亲密度": {
        "value": 3,
        "type": "number",
        "updatedAt": 1783403917788,
        "updatedBy": "llm"
      },
      "心情": {
        "value": "平静",
        "type": "string",
        "updatedAt": 1783403917788,
        "updatedBy": "llm"
      }
    },
    "interaction": {
      "unansweredCount": {
        "value": 0,
        "type": "number",
        "updatedAt": 1783403917788,
        "updatedBy": "system"
      }
    }
  }
}
```

---

## 7. 运行时生命周期

### 7.1 Card 激活

```text
激活 Card
  → 解析 Card frontmatter + sections
  → 解析 #变量定义 得到 CardVariableDef[]
  → load stages/{cardId}.json
      ├─ Card version/hash 变化 → 重生成 stages
      ├─ variables.card → 按注册表迁移并保留合法值
      ├─ variables.interaction → 按注册表迁移并保留合法值
      └─ 无 variables → 按 initial 初始化
  → computeSystemVariables()
  → write vars.json:system snapshot
  → 组装 VariablePoolSnapshot(system + card + interaction + session readonly)
```

恢复/迁移规则：

1. 只恢复当前 Card 注册表里存在的变量。
2. 类型不匹配时严格回退 initial，并标记 `updatedBy=migration`。
3. number 超出 min/max 时严格回退 initial。
4. enum 不匹配时严格回退 initial。
5. Card 删除的旧变量不进入运行时；落盘时清理。
6. 新增变量使用 initial 初始化。
7. Card version/hash 变化时：**重生成 stages，variables 按注册表迁移并保留合法值**。

### 7.2 每轮 Agent Loop 开始

```text
runAgentLoop start
  → computeSystemVariables(now, activeCardId)
  → write vars.json:system snapshot
  → load/refresh current card + interaction state from memory
  → applyResetPolicies(now)
      ├─ reset=daily: 本地日期变化则回 initial
      └─ reset=session: 新会话或当前会话首次使用则回 initial
  → read active session metadata as readonly snapshot
  → ContextEngine 注入 system/card/interaction/session 四段说明
```

注意：

- system 每轮重新计算。
- card 变量以内存为主，工具写入后同步到 stages JSON。
- interaction 由系统事件更新后同步到 stages JSON。
- session 变量由会话系统提供快照，不进入 variable-pool 的持久化。

### 7.3 LLM 更新 Card 变量

```text
LLM 调 var_write(name, value)
  → 找 scope=card 的 CardVariableDef
  → 不存在：拒绝
  → updateBy 不是 llm：拒绝
  → 校验类型 / enum / min / max
  → 更新内存 VariableState
  → 读 stages/{cardId}.json
  → 保留 stages，只覆盖 variables.card[name]
  → 写回 stages/{cardId}.json
```

`var_write` 不允许写 system、interaction、session。

### 7.4 系统更新 Interaction

```text
系统事件触发
  → 找 scope=interaction 的 CardVariableDef
  → 校验 type/min/max/enum
  → 更新内存 VariableState(updatedBy=system)
  → 保留 stages，只覆盖 variables.interaction[name]
  → 写回 stages/{cardId}.json
```

示例：

```text
主动搭话发出且用户未回复 → unansweredCount + 1
用户发送任意消息 → unansweredCount = 0
```

### 7.5 每轮 Agent Loop 结束

```text
runAgentLoop end
  → 若 system 已变化：刷新 vars.json snapshot
  → 若 card variables dirty：确保 stages/{cardId}.json:variables.card 已落盘
  → 若 interaction variables dirty：确保 stages/{cardId}.json:variables.interaction 已落盘
  → session turn/token 元数据由 session 模块更新到 sessions/*.md frontmatter
  → 上下文压缩
```

第一版可以在 `var_write` / system interaction update 时立即落盘，Loop end 只做兜底 flush。

---

## 8. Prompt 注入

变量注入分四段，避免来源混淆：

```text
[系统变量 - 只读]
hour=14, minute=20, dayOfWeek=2, isNightTime=false, activeCardId="angelkawaii"

[Card变量 - 可通过 var_write 更新]
亲密度=3 (number, 0..10, updateBy=llm): 用户与角色的亲密程度
心情="平静" (enum: 开心/平静/失落/生气/害羞, updateBy=llm): 角色当前心情

[互动状态 - 系统维护，只读]
unansweredCount=0 (number, updateBy=system): 用户连续未回应角色主动消息的次数

[会话状态 - 只读]
topic="变量池设计", turnCount=12, tokenCount=34800, contextRatio=0.31
```

Phase1 额外注入变量更新规则：

```text
[变量更新规则]
- 系统变量只读，不可写。
- 互动状态只读，不可写。
- 会话状态只读，不可写。
- 只有 Card 变量注册表中 updateBy=llm 的变量可以通过 var_write 更新。
- 如果用户本轮消息明确影响某个 Card 变量，请调用 var_write 更新。
- 不要为了更新而更新；没有明确变化时不要写变量。
- 写入必须符合变量类型、范围、枚举和 updateBy 约束。
```

---

## 9. 工具策略

人格启用时，变量工具应始终暴露给 Phase1：

| 工具 | 规则 |
|------|------|
| `var_read` | 可读 system + card + interaction；默认不读 session |
| `var_list` | 返回 system 快照 + card/interaction 注册表/value |
| `var_write` | 只能写已注册且 `scope=card`、`updateBy=llm` 的 Card 变量 |
| `var_delete` | 第一版改为 reset，不做真实删除 |

`var_delete` 语义调整为：

```text
var_delete(name) → reset registered card variable to initial
```

原因：注册变量是 Card schema 的一部分，真正删除会让运行时状态和注册表不一致。

---

## 10. 与 When 引擎的关系

When 引擎读取的是变量快照，不拥有变量状态。

第一版：

```text
When input = system vars + card vars + interaction vars
```

规则：

1. `#行为进阶` 可以读取 system + card + interaction。
2. `session` 第一版不进入 When，只进入 Prompt。
3. Card 作者仍可在 When 中使用裸变量名，例如 `unansweredCount >= 3 OR 亲密度 >= 9`。
4. 若出现重名，优先级为 `card > interaction > system`；模板应提醒作者避免重名。
5. 未来如开放 session 给 When，必须使用 `session.*` 命名空间。

---

## 11. 设置页展示

第一版设置页变量区域**只读展示**，不允许手动编辑。

设置页从磁盘 hydrate，不依赖主窗口内存：

```text
系统变量（personality/vars.json，只读快照）
  hour=14
  activeCardId=angelkawaii
  updatedAt=...

Card变量（personality/stages/angelkawaii.json:variables.card）
  亲密度=3      number 0..10 updateBy=llm
  心情=平静      enum[开心,平静,失落,生气,害羞]

互动状态（personality/stages/angelkawaii.json:variables.interaction）
  unansweredCount=0 number updateBy=system

会话状态（sessions/*.md frontmatter，只读）
  topic=变量池设计
  turnCount=12
  tokenCount=34800
```

展示文案需要明确：

- system 是运行时派生快照，每轮可能覆盖。
- card / interaction 持久化在 stages JSON。
- session 状态来自会话文件，不属于变量池。
- 变量工具只修改 `scope=card` 且 `updateBy=llm` 的 Card 变量。
- 设置页第一版只读；`updateBy=manual` 只是为未来预留。

---

## 12. 迁移计划

### Phase 0：Card 契约重写（必须最先）

- 重写 `src/services/personality/cards/_template.md`。
- 重写所有内置 Card 的 `#变量定义` 为结构化 YAML block。
- 将 `unansweredCount` 从系统变量概念迁移到 `## interaction`。
- 更新 Card 开发指引：变量边界、When 读取范围、updateBy/reset 语义、命名建议。

### Phase A：Loader/Types 支持新 schema

- `CardSections` 新增 `variableDefs`。
- 保留 `initialVars` 作为短期兼容字段。
- loader 解析 `#变量定义 > ## card` 和 `## interaction` 的 fenced YAML block。
- 旧 `name: initial` 格式只作为兼容路径，不再写入模板。

### Phase B：持久化拆分

- 扩展 `StagePrompts`，新增可选 `variables` 字段。
- `vars.json` 改成只保存 `schemaVersion/system/updatedAt`。
- `readPersistedCharacterVars()` 替换为读取 `stages/{cardId}.json:variables.card`。
- 写 stages 时保留 `variables`；写 variables 时保留 `stages`。

### Phase C：旧数据迁移

- 发现旧 `vars.json.character` 时：
  - 按当前 Card 注册表校验。
  - 合法值迁移到 `stages/{cardId}.json:variables.card`。
  - 不合法值严格回 initial，并标记 `updatedBy=migration`。
  - `vars.json` 重写为 system-only v2 格式。

### Phase D：更新逻辑补齐

- `var_write` 接入注册表校验。
- `var_write` 成功后立即同步写 `stages/{cardId}.json:variables.card`。
- `var_delete` 改成 reset 到 initial。
- 新增系统更新 interaction 的内部 API。
- Agent Loop start/end 明确执行 system refresh、reset policy、dirty flush。

### Phase E：Prompt 与工具常驻

- ContextEngine 注入 `[系统变量]`、`[Card变量]`、`[互动状态]`、`[会话状态]` 四段。
- Phase1 注入变量更新规则。
- 人格启用时强制暴露 `var_read` / `var_write` / `var_list` / `var_delete(reset)`。

### Phase F：设置页只读展示

- 设置页分别读取 `vars.json`、`stages/{cardId}.json`、当前 session frontmatter。
- 显示 source、type、value、schema、updatedAt。
- 第一版不做编辑入口。

---

## 13. 已决问题

| 问题 | 结论 |
|------|------|
| 实现范围 | 按 Phase 全做 |
| 是否先改 runtime？ | 否，必须先重写 Card 模板和内置 Card |
| Card schema 格式 | 结构化 YAML block |
| 是否支持动态变量？ | 第一版不支持，只允许注册变量 |
| `var_delete` 是删除还是 reset？ | reset 到 initial |
| Card 变量是否 per-session？ | 第一版跨会话共享；未来另设 session-scoped card state |
| `unansweredCount` 放哪？ | `interaction`，不放 system |
| session 变量是否给 When 读取？ | 第一版不读取，只进 Prompt |
| 设置页是否可编辑？ | 第一版只读展示 |
| Card version/hash 变化怎么处理？ | 重生成 stages，variables 按注册表迁移并保留合法值 |
| 旧值迁移不合法怎么办？ | 严格回 initial，标记 `updatedBy=migration` |
| daily reset 日期边界 | 使用本地日期 |
| 内部命名 | `system` / `card` / `interaction` / `session` |

---

## 14. 最小实现原则

1. 不引入数据库。
2. 不引入复杂 DSL；结构化变量使用 YAML block 即可。
3. 不把会话系统塞进变量池。
4. 不让 LLM 创建任意新变量。
5. 不把 `vars.json` 当运行时真相源。
6. 不在设置页第一版提供变量编辑能力。
7. 优先补齐当前缺失的更新闭环，而不是扩展更多变量类型。
