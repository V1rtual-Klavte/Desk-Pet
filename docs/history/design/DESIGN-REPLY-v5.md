---
document_type: historical_design
status: archived
current_reference: ../../current/system-design.md
---

# 回复生成器 v5 — 一步生成 + 统一 Card + 兜底卡片化

> 日期: 2026-07-14 | 状态: 已实现 (2026-07)
> 取代: DESIGN-REPLY-v4.md

---

## 目录

1. 设计动机
2. 核心架构变化
3. 数据流
4. 各模块改动清单
5. 硬编码兜底 → 卡片化
6. 配置变更
7. UI 变更
8. 完整文件清单
9. 实现顺序

---

## 1. 设计动机

### v4 两步生成的问题

```
Phase1 (零身份) → rawReply → Phase2 (角色化) → 最终回复
```

- **Phase1 看不见角色上下文**，工具调用和回复都是"桌面助手"视角，和角色语境割裂
- **2 次 LLM 调用** = 双倍延迟 + 双倍 token
- **Phase2 的 user message 要塞 rawReply 原文**，信息重复传输
- **流式体验割裂**：Phase1 非流式干等 → Phase2 流式才看到 token

### v5 核心决策

1. **一步替代两步**：Phase2 的所有角色内容上移到 system prompt，一次 LLM 调用直接出角色化回复
2. **统一 Card 设计**：人格开关移除，用中性 `neutral` Card 替代"禁用人格"
3. **移除流式**：永远非流式，简化 provider 接口
4. **兜底卡片化**：所有硬编码中文回复移入 Card stages，LLM 为每个角色生成符合语气的版本

---

## 2. 核心架构变化

### 2.1 旧 vs 新

```
v4:
  用户消息 → Phase1 LLM (非流式, 零身份) → Phase2 LLM (可选流式, 角色化) → 最终回复

v5:
  用户消息 → 单次 LLM 调用 (非流式, 角色已内建) → generator 后处理 → 最终回复
```

### 2.2 Prompt 结构变化

```
v4 Phase1 system prompt:
  "你是一个桌面助手" + 变量池 + 工具规则 + 记忆 + 工具

v4 Phase2 system prompt:
  角色设定 + 语言风格 + 输出规则 + 情绪表达 + When语气 + 行为准则 + 变量池

v5 统一 system prompt:
  ① 角色设定 (WHO)          ← 旧 Phase2
  ② 语言风格 (HOW)           ← 旧 Phase2
  ③ 输出规则 (FORMAT)        ← 旧 Phase2（含 [emo:key] 要求）
  ④ [当前状态] When语气     ← 旧 Phase2
  ⑤ [行为准则] 必须遵守全部  ← 旧 Phase2
  ⑥ [变量池] 只读快照        ← 保留
  ⑦ 变量操作规则             ← 保留
  ⑧ 工具声明                 ← 保留
  ⑨ 记忆注入                 ← 保留
  ⑩ 能力约束                 ← 保留（去掉"不扮演角色"）
```

### 2.3 LLM 调用次数

| 场景 | v4 | v5 |
|------|----|----|
| 用户消息（有角色） | 2 | 1 |
| 用户消息（无角色） | 1 | 1 |
| 主动搭话 | 2 | 1 |
| stages 生成 | 1/card | 1/card |

### 2.4 情绪标签处理

```
v4: Phase2 回复开头 → agent-loop 内剥离 [emo:key]
v5: 单次 LLM 回复开头 → generator.ts 剥离 [emo:key] → 返回 { text, emotionKey, expression, sound }
```

LLM 在 system prompt 中已收到情绪表达规则，知道要在回复开头加 `[emo:key]`。

### 2.5 统一 Card 设计

```
v4: personality.enabled=true  → Card 激活 → Phase1 + Phase2
    personality.enabled=false → 无 Card   → Phase1 only

v5: 始终有一个 Card 激活
    ├─ 用户选的角色 Card（angelkawaii / ame / pchan...）
    └─ neutral Card（默认"桌面助手"）← 替代旧的人格开关
```

**人格开关不再存在**。用户选中性 Card = 旧"禁用人格"。getActiveCard() 永远返回非 null。

---

## 3. 数据流

```
用户消息
  │
  ├─ 变量池刷新 + When 引擎求值
  │
  └─ 单次 LLM 调用（永远非流式）
      SystemPrompt = Card 全量:
        角色设定 / 语言风格 / 输出规则 / 情绪表达 / When语气
        / 行为准则 / 变量池 / 工具 + 记忆
      
      → 工具循环（不变）
      → 直接输出 [emo:key] + 角色化回复
      
  └─ Generator 后处理:
      ├─ 剥离 [emo:key]
      ├─ 查 card.sections.emotionMappings → expression + sound
      ├─ trim + 长度截断
      └─ 返回 { text, emotionKey, expression, sound }
```

---

## 4. 各模块改动清单

### `builder.ts` — 合并为单 Prompt

- 🗑️ 删 `Phase2Input` / `Phase2Output` 类型
- 🗑️ 删 `buildStylePrompt()` 整个函数
- 🗑️ 删 `summarizeToolCalls()` 整个函数
- ✏️ `buildCapabilityPrompt()` → `buildPrompt()`
  - Card 存在：注入全部角色内容
  - Card 不存在（不应发生，neutral 兜底）：回退纯能力 prompt
- ✏️ 去掉旧 L61-62 "Phase2人格化过/不需要人格化" 提示词
- ✏️ 从 `formatToolRules` + `formatAllRules` → 只用 `formatAllRules`

### `agent-loop.ts` — 砍掉 Phase2

- 🗑️ 删 `buildStylePrompt, summarizeToolCalls` import
- 🗑️ 删 `replyConfig` import
- 🗑️ 删 `personalityEnabled` 判断 + 无角色分支
- 🗑️ 删 Phase2 整块（~80行）：styleCtx 构建 + 流式/非流式调用 + 情绪剥离 + 重试
- ✏️ 工具循环结束后 → 直接调 `generateReply(raw, card)` → 拿 `processed.text/expression/sound`
- ✏️ 情绪剥离逻辑移到 generator.ts
- ✏️ `runPhase1Loop` → 改名 `runToolLoop`
- ✏️ 用户可见硬编码 → `getFallbackReply(key)`
- ✏️ LLM 上下文硬编码 → stages 字段（`getStagePrompt("blocked", cat)`、`getSimpleStage("error")`）

### `generator.ts` — 接管后处理

- ✨ 新接口 `ReplyResult { text, emotionKey, expression, sound }`
- ✏️ `generateReply(raw, card, options?)` → 剥离标签 + 映射情绪 + trim + 截断
- ✨ import `stripEmotionTag`, `resolveEmotion` from emotion.ts
- ✨ import `PersonalityCard` from types.ts

### `provider.ts` — 删流式

- 🗑️ 删 `generateReplyStream()` 整方法
- 🗑️ 删 `thinkingEffort === "low"` 追加提示词的逻辑

### `types.ts` — 删流式类型

- 🗑️ 删 `streamEnabled?` from `GenerateRequest`
- 🗑️ 删 `generateReplyStream?()` from `AIProvider`

### `registry.ts` — 删 enabled

- 🗑️ 删 `let enabled` 状态
- 🗑️ 删 `isPersonalityEnabled()` + `setPersonalityEnabled()`
- ✏️ `initRegistry()` — 去掉 enabled 分支，始终激活 Card。无配置则 fallback 到 neutral
- ✏️ `getActiveCard()` — 去掉 `if (!enabled)` 检查，始终返回 card
- ✏️ `window.__personality` — 去掉 enabled/setEnabled

### `must-rules.ts` — 简化

- 🗑️ 删 `formatToolRules()` — 不再需要 Phase1/Phase2 分离注入
- ✏️ `formatAllRules()` — 唯一注入方式

### `middleware.ts` — 删 retry stage

- 🗑️ 删 `"retry"` from `AgentStage`
- 🗑️ 删 `"retry"` from `DEFAULT_EXPRESSIONS`
- 🗑️ 删 `case "retry":` 分支
- retry 只在 Phase2 重试时使用，Phase2 没了就不需要了。

### 导出更新

| 文件 | 动作 |
|------|------|
| `personality/index.ts` | 🗑️ 删 `isPersonalityEnabled, setPersonalityEnabled, formatToolRules` |
| `engine/index.ts` | ✏️ `buildCapabilityPrompt, buildStylePrompt, summarizeToolCalls` → 只导出 `buildPrompt` |

### `config.ts` — 删 reply 配置

- 🗑️ 删 `reply` 接口定义
- 🗑️ 删 `replyConfig` 整块（streamEnabled, phase2Retry, phase2ThinkingEffort）
- 🗑️ 删 `personalityConfig.enabled` getter
- 🗑️ 删迁移映射中的 `personality.enabled` + `loop.streamEnabled`
- 🗑️ 删 `fallbackReplies` 配置项

### `runner.ts` — 适配

- ✏️ `initChat()` — 去掉 `if (card)` 判断，始终取 card
- ✏️ `sendMessage()` — `generateReply(result.reply, card, options)` 用新接口
- ✏️ 硬编码兜底 → `getFallbackReply(key)`

### `sub-loop.ts` — 适配

- ✏️ 用户可见硬编码 → `getFallbackReply(key)`
- ✏️ LLM 上下文硬编码 → stages 字段

### `slash/commands/compact.ts` — 适配

- ✏️ 硬编码兜底 → `getFallbackReply("compactionFailed")`

---

## 5. 硬编码兜底 → 卡片化

### 5.1 硬编码分类

硬编码消息分两类，走不同解决方案：

- **用户可见的最终回复** → stages `fallbacks` 字段（LLM 生成，每个 Card 不同）
- **LLM 上下文的 tool result** → stages 现有字段 `error` / `blocked`（已有 card 化文案）

#### 用户可见硬编码（→ fallbacks）

| 文件 | 行 | 内容 | fallback key |
|------|-----|------|------|
| `agent-loop.ts` | L121 | `"（唔…试了好几次都失败了…）"` | `maxRetriesExhausted` |
| `agent-loop.ts` | L243 | `"（处理时间太长了…）"` | `turnTimeout` |
| `agent-loop.ts` | L352 | `"（处理完成，但结果太复杂了…）"` | `toolLoopMaxRounds` |
| `runner.ts` | L72 | `"（糖糖正在想事情，等一下再发哦～）"` | `concurrentRejected` |
| `runner.ts` | L161 | `"（唔…信号不太好，等会儿再试试？）"` | `llmUnavailable` |
| `sub-loop.ts` | L136 | `"（完成）"` | `subAgentDone` |
| `sub-loop.ts` | L138 | `"（工具执行完成，但生成总结失败）"` | `subAgentFailed` |
| `sub-loop.ts` | L147 | `"（无结果）"` | `subAgentNoResult` |
| `compact.ts` | L39 | `"压缩失败，请稍后重试～"` | `compactionFailed` |
| `config.ts` | L336 | `["嗯嗯～"]` | `llmUnavailable`（合并） |

#### LLM 上下文硬编码（→ stages 现有字段）

这些消息不直接展示给用户，但 LLM 在工具循环中会读到它们作为 tool result。如果 LLM 读到中性中文 `"被拦截"`，可能顺着中性语气回复，破坏角色一致性。

| 文件 | 行 | 内容 | 改用 stages 字段 |
|------|-----|------|------|
| `agent-loop.ts` | L302 | `"工具不存在: ${name}"` | `getSimpleStage("error")` 替换 `"工具不存在"` |
| `agent-loop.ts` | L315 | `safetyMsg ?? "被拦截"` | `getStagePrompt("blocked", cat) ?? "操作被拦截"` |
| `agent-loop.ts` | L324 | `"用户取消"` | `getStagePrompt("blocked", cat) ?? "操作被拦截"` |
| `agent-loop.ts` | L340 | `"未知错误"`（日志 fallback） | `getSimpleStage("error")` |
| `agent-loop.ts` | L345 | `` `Error: ${result.error}` `` | `getSimpleStage("error")` 替换 `"Error"` |
| `agent-loop.ts` | L346 | 同上（持久化副本） | 同上 |
| `sub-loop.ts` | L107 | `` `工具未注册: ${tc.name}` `` | `getSimpleStage("error")` 替换 `"工具未注册"` |
| `sub-loop.ts` | L115 | `safetyMsg ?? "操作被拦截"` | `getStagePrompt("blocked", cat) ?? "操作被拦截"` |
| `sub-loop.ts` | L123 | `` `Error: ${result.error}` `` | `getSimpleStage("error")` 替换 `"Error"` |

> **设计要点**：stages JSON 早已为每个 Card 生成了 `error`、`timeout`、`blocked` 字段（含 per-category 文案）。这些原本只被 middleware 用来给用户看阶段提示。现在也在 tool result context 中复用，确保 LLM **始终**在角色语境中思考。

示例 — angelkawaii Card 的 stages.error = `"出了一点小问题呢，稍等一下下哦～"`：
```
旧 tool result: {"error": "工具不存在: bash_exec"}
新 tool result: {"error": "出了一点小问题呢，稍等一下下哦～: 工具 bash_exec 不可用"}
```
LLM 读到后者，回复风格不会被中性中文带偏。

### 5.2 解决方案

#### stages JSON 新增 `fallbacks` 字段

```jsonc
{
  "stages": {
    // ... 现有字段不变 ...
    "fallbacks": {
      "concurrentRejected": "",
      "maxRetriesExhausted": "",
      "turnTimeout": "",
      "toolLoopMaxRounds": "",
      "llmUnavailable": [],
      "subAgentDone": "",
      "subAgentFailed": "",
      "subAgentNoResult": "",
      "compactionFailed": ""
    }
  }
}
```

注意 `llmUnavailable` 为 `string[]`，支持多条随机选择。

#### StageMap 类型扩展

```ts
// stages-cache.ts
export interface FallbackReplies {
  concurrentRejected: string
  maxRetriesExhausted: string
  turnTimeout: string
  toolLoopMaxRounds: string
  llmUnavailable: string[]        // 数组，运行时随机选一条
  subAgentDone: string
  subAgentFailed: string
  subAgentNoResult: string
  compactionFailed: string
}

export interface StageMap {
  // ... 现有字段不变 ...
  fallbacks: FallbackReplies
}
```

#### 新增读取函数

```ts
// stages-cache.ts
export function getFallbackReply(key: keyof FallbackReplies): string {
  const cached = getCachedStages()
  let val = cached?.stages.fallbacks?.[key]
  
  // 数组（llmUnavailable）→ 随机取一条
  if (Array.isArray(val)) {
    return val.length > 0 ? val[Math.floor(Math.random() * val.length)] : FALLBACK_FALLBACKS[key] as string
  }
  
  // 字符串 → 直接用
  if (typeof val === "string" && val.length > 0) return val
  
  // 最后的最后：极简中性兜底
  return FALLBACK_FALLBACKS[key] ?? ""
}
```

#### 极简硬编码最后防线

```ts
const FALLBACK_FALLBACKS: Record<string, string> = {
  concurrentRejected: "请稍后再试",
  maxRetriesExhausted: "重试失败，请稍后再试",
  turnTimeout: "处理超时",
  toolLoopMaxRounds: "处理完成",
  llmUnavailable: "服务暂不可用",
  subAgentDone: "完成",
  subAgentFailed: "执行失败",
  subAgentNoResult: "无结果",
  compactionFailed: "压缩失败",
}
```

中性、简短、不绑定任何角色。只在 Card stages 完全没有时使用。

#### stages-prompt.md 新增生成要求

在 JSON 结构中追加 `fallbacks`，并在说明中加入：

```
- fallbacks 为系统兜底提示语，请在保持角色语气的前提下生成
- concurrentRejected: 用户发送消息太快时的提示
- maxRetriesExhausted: AI 多次重试失败后的提示
- turnTimeout: 处理超时提示
- toolLoopMaxRounds: 工具调用轮数用尽时提示
- llmUnavailable: LLM 完全不可用时的通用回复（2-3条，以 JSON 数组形式）
- subAgentDone/Failed/NoResult: 子代理的状态提示
- compactionFailed: 记忆压缩失败提示
```

#### angelkawaii 生成效果示例

```json
"fallbacks": {
  "concurrentRejected": "Pちゃん等一下下！我还有话没说完呢～",
  "maxRetriesExhausted": "唔…试了好几次都不行…Pちゃん帮帮我？",
  "turnTimeout": "啊咧，想太久了脑袋要冒烟了啦(｡•́︿•̀｡)",
  "toolLoopMaxRounds": "做完啦！但结果有点复杂不太好说清楚…",
  "llmUnavailable": ["信号好像不太好诶…等会儿再找我哦♡", "唔…连接不上了，Pちゃん等等我！"],
  "subAgentDone": "搞定啦～",
  "subAgentFailed": "那边好像出了点问题…",
  "subAgentNoResult": "咦，怎么什么都没有？",
  "compactionFailed": "记忆整理失败了呢…不过没关系！"
}
```

#### neutral Card 生成效果

```json
"fallbacks": {
  "concurrentRejected": "请稍后再试",
  "maxRetriesExhausted": "重试失败，请稍后再试",
  "turnTimeout": "处理超时",
  "toolLoopMaxRounds": "处理完成",
  "llmUnavailable": ["服务暂不可用"],
  "subAgentDone": "完成",
  "subAgentFailed": "执行失败",
  "subAgentNoResult": "无结果",
  "compactionFailed": "压缩失败"
}
```

---

## 6. 配置变更

### CONFIG.yaml / CONFIG-DEV.yaml

```yaml
# ── 删 ──
ai:
  reply:                    # 🗑️ 整块删
    streamEnabled: true
    phase2Retry: 1
    phase2ThinkingEffort: low
  personality:
    enabled: true           # 🗑️ 删这行
    active: angelkawaii     # ✏️ 保留
  fallbackReplies:          # 🗑️ 删（移到 stages fallbacks）
    - "嗯嗯～"

# ── 保留不变 ──
ai:
  personality:
    active: angelkawaii
    cards: [...]
  thinking:
    effort: auto
```

---

## 7. UI 变更

### AITab.vue

- 🗑️ 删 Phase2 思考强度 radio-row
- 🗑️ 删流式输出 checkbox
- 🗑️ 删人格开关 checkbox
- 🗑️ 删 `"已关闭 → 零身份模式"` 提示
- ✏️ Card 网格始终显示（去掉 `v-else`）

### SettingsPanel.vue

- 🗑️ 删 `ai.personality.enabled` 保存
- 🗑️ 删 `ai.reply.*` 保存
- ✏️ `switchPersonality(a.personalityEnabled ? active : null)` → `switchPersonality(active)`

---

## 8. 完整文件清单

### 删

| 函数/类型 | 文件 |
|------|------|
| `buildStylePrompt()` | `builder.ts` |
| `summarizeToolCalls()` | `builder.ts` |
| `Phase2Input` / `Phase2Output` | `builder.ts` |
| `formatToolRules()` | `must-rules.ts` |
| `generateReplyStream()` | `provider.ts` |
| `isPersonalityEnabled()` | `registry.ts` |
| `setPersonalityEnabled()` | `registry.ts` |
| `replyConfig` | `config.ts` |
| `personalityConfig.enabled` | `config.ts` |
| `aiConfig.fallbackReplies` | `config.ts` |
| `AgentStage.retry` | `middleware.ts` |

### 改

| 文件 | 改动类型 | 说明 |
|------|------|------|
| `builder.ts` | 🔀 合并 | `buildCapabilityPrompt` → `buildPrompt`，注入全部角色内容 |
| `agent-loop.ts` | ✂️ 砍 Phase2 | 删 Phase2 块，调用新 generator 接口，硬编码→getFallbackReply |
| `generator.ts` | ✨ 扩展 | 接管情绪剥离+映射+截断 |
| `provider.ts` | ✂️ 删流式 | 删 generateReplyStream |
| `agent/types.ts` | ✂️ 删流式 | 删 streamEnabled + generateReplyStream |
| `registry.ts` | ✂️ 删 enabled | initRegistry 始终激活 Card，neutral 兜底 |
| `must-rules.ts` | ✂️ 简化 | 删 formatToolRules |
| `middleware.ts` | ✂️ 删 retry | AgentStage 去 retry + 相关分支 |
| `emotion.ts` | ✏️ 注释 | formatEmotionForPrompt 注释 Phase2→system prompt |
| `config.ts` | ✂️ 删 reply | 删 replyConfig + enabled + fallbackReplies |
| `runner.ts` | ✏️ 适配 | 新 generator 接口 + 硬编码→getFallbackReply |
| `sub-loop.ts` | ✏️ 适配 | 硬编码→getFallbackReply |
| `slash/commands/compact.ts` | ✏️ 适配 | 硬编码→getFallbackReply |
| `personality/index.ts` | ✏️ 导出 | 删 enabled/formatToolRules，加 getFallbackReply |
| `engine/index.ts` | ✏️ 导出 | buildCapabilityPrompt→buildPrompt |
| `stages-cache.ts` | ✨ 新字段 | StageMap 加 fallbacks，新 getFallbackReply() |
| `stages-prompt.md` | ✨ 新字段 | JSON 结构加 fallbacks + 生成要求 |
| `CONFIG.yaml` | ✂️ 删配置 | 删 reply 块 + personality.enabled + fallbackReplies |
| `CONFIG-DEV.yaml` | ✂️ 删配置 | 同上 |
| `AITab.vue` | ✂️ 删 UI | 删 Phase2 思考强度/流式/人格开关 |
| `SettingsPanel.vue` | ✏️ 适配 | 保存逻辑去 enabled |

### 新

| 文件 | 说明 |
|------|------|
| `cards/neutral.md` | 中性默认 Card |
| `getFallbackReply()` | `stages-cache.ts` 新函数 |
| `FallbackReplies` | `stages-cache.ts` 新类型 |

### 需重生成

| 文件 | 原因 |
|------|------|
| `stages/angelkawaii.json` | 新增 fallbacks |
| `stages/ame.json` | 新增 fallbacks |
| `stages/pchan.json` | 新增 fallbacks |

### 测试文件适配

| 文件 | 动作 |
|------|------|
| `__tests__/agent-loop.live.test.ts` | `buildStylePrompt` → `buildPrompt` |
| `__tests__/context-builder.test.ts` | 同上 |
| `__tests__/helpers/setup.ts` | 删 `replyConfig` mock |

### 文档同步

| 文件 | 动作 |
|------|------|
| `docs/DESIGN-REPLY-v4.md` | 更新指向 v5 |
| `docs/DESIGN-REPLY-v5.md` | 本文档（新建） |
| `CLAUDE.md` | 更新架构描述 |
| `DES.md` | 同上 |
| `README.md` | 同上 |

---

## 9. 实现顺序

```
Phase A: 基础设施
  A1. cards/neutral.md — 新建中性默认 Card
  A2. stages-cache.ts — StageMap 加 fallbacks + getFallbackReply()
  A3. stages-prompt.md — 加 fallbacks 字段 + 生成要求
  A4. 重生成 3 个 stages/*.json

Phase B: 核心合并
  B1. generator.ts — 接管后处理（情绪剥离+映射+截断）
  B2. builder.ts — buildCapabilityPrompt → buildPrompt
  B3. agent-loop.ts — 砍 Phase2 + 硬编码→getFallbackReply
  B4. must-rules.ts — 删 formatToolRules

Phase C: 清理
  C1. provider.ts — 删 generateReplyStream
  C2. agent/types.ts — 删流式类型
  C3. registry.ts — 删 enabled 逻辑 + neutral 兜底
  C4. middleware.ts — 删 retry stage
  C5. config.ts — 删 replyConfig/enabled/fallbackReplies
  C6. CONFIG.yaml / CONFIG-DEV.yaml — 删配置

Phase D: 接入层
  D1. runner.ts — 适配新 generator 接口 + 硬编码→getFallbackReply
  D2. sub-loop.ts — 硬编码→getFallbackReply
  D3. slash/commands/compact.ts — 硬编码→getFallbackReply
  D4. personality/index.ts + engine/index.ts — 更新导出

Phase E: UI + 文档
  E1. AITab.vue — 删 Phase2 UI + 人格开关
  E2. SettingsPanel.vue — 适配保存逻辑
  E3. docs/DESIGN-REPLY-v5.md — 本文档
  E4. CLAUDE.md / DES.md / README.md 同步

Phase F: 测试
  F1. 删旧测试（agent-loop.live / agent-loop / context-builder / personality）
  F2. 更新测试 helpers（setup / fixtures / assertions / mock-provider）
  F3. 新单元测试（emotion / must-rules）
  F4. 新集成测试（prompt-building / agent-loop / generator / fallback / card-lifecycle）
  F5. 新运行时测试（e2e-conversation）
  F6. 全量 pnpm test 通过

Phase G: 验证
  G1. 运行 pnpm tauri dev 确认启动正常
  G2. neutral Card 对话测试
  G3. 角色 Card 切换 + 对话测试
  G4. 异常场景：并发锁 / 超时 / 错误兜底
  G5. 日志完整检查
```

---

## 10. 测试模块重设计

### 10.1 当前测试问题

| 问题 | 详情 |
|------|------|
| 旧架构残留 | `agent-loop.live.test.ts` 调用 `buildCapabilityPrompt` + `buildStylePrompt` + Phase1/Phase2，打印大量旧格式 Prompt 到终端 |
| `context-builder.test.ts` | 测试 `buildStylePrompt()` + Phase2 逻辑，v5 中该函数已删除 |
| `agent-loop.test.ts` | Mock 模式下仍按两步调用 |
| `setup.ts` mock config | 含 `replyConfig: { streamEnabled, phase2Retry, phase2ThinkingEffort }` |
| 全是接口级测试 | 只测函数输入输出，不测运行时完整链路 |

### 10.2 新测试架构

```
src/services/__tests__/
├── helpers/                        # 共用工具
│   ├── setup.ts                    # Mock Tauri + Config (UPDATE: 删 replyConfig)
│   ├── fixtures.ts                 # 测试数据 (UPDATE: 加 neutral card defs)
│   ├── assertions.ts               # 通用断言 (UPDATE: 加 v5 新断言)
│   ├── mock-ai-controller.ts       # Scripted AI 响应 (KEEP)
│   └── mock-provider.ts            # Mock Provider (UPDATE: 删 stream 引用)
│
├── unit/                           # ★ 纯逻辑，无 IO 无 Tauri
│   ├── when-engine.test.ts         # When 表达式解析/求值/优先级 (KEEP)
│   ├── variable-pool.test.ts       # 变量 CRUD / reset / 校验 (KEEP)
│   ├── emotion.test.ts             # 情绪标签剥离 + 映射解析 (NEW)
│   └── must-rules.test.ts          # 必须遵守解析 + 问候提取 (NEW)
│
├── integration/                    # ★ 多模块联动，Mock AI
│   ├── prompt-building.test.ts     # buildPrompt() 各种 Card + 变量池注入 (NEW)
│   ├── agent-loop.test.ts          # 完整工具循环 + 情绪标签 + generator 后处理 (REWRITE)
│   ├── generator.test.ts           # generateReply() 剥离→映射→截断 (NEW)
│   ├── fallback.test.ts            # getFallbackReply() 各 key + 兜底链 (NEW)
│   └── card-lifecycle.test.ts      # Card 加载→激活→切换，含 neutral (NEW)
│
├── runtime/                        # ★ 真实 AI 调用，跑完整对话
│   └── e2e-conversation.test.ts    # 端到端多轮对话 (NEW)
│
├── safety.test.ts                  # 安全校验 (KEEP)
├── session.test.ts                 # 会话状态机 (KEEP)
├── memory.test.ts                  # 记忆 CRUD (KEEP)
├── tool-execution.test.ts          # 工具注册+执行 (KEEP)
└── config.test.ts                  # 配置完整性 (KEEP)
```

### 10.3 各测试详细设计

#### `unit/emotion.test.ts`（新）

```
describe("stripEmotionTag")
  ✓ "[emo:chu] Pちゃん♡" → text="Pちゃん♡", key="chu"
  ✓ "没有标签的文本" → text="没有标签的文本", key=null
  ✓ "[] " → key=null（空标签不匹配）
  ✓ "[emo:不明标签] 文本" → 正确剥离

describe("parseEmotionMappings")
  ✓ "happy → smile, —" → { key: "happy", expression: "smile", sound: null }
  ✓ "chu → chu, reply" → { key: "chu", expression: "chu", sound: "reply" }
  ✓ 多行解析
  ✓ 空行/无箭头行过滤

describe("resolveEmotion")
  ✓ key=null → 默认 "smile"
  ✓ 已注册 key → 查映射
  ✓ 未注册 key → 查系统默认兜底
  ✓ 完全未知 key → warn + "smile"
```

#### `unit/must-rules.test.ts`（新）

```
describe("parseMustRules")
  ✓ 基本解析
  ✓ 含激活问候时提取 greeting
  ✓ 无激活问候返回 null
  ✓ 工具关键字识别 ("完成", "报告", "工具", "结果"...)

describe("formatAllRules")
  ✓ 格式化全量规则
  ✓ 空规则返回空串

describe("pickGreeting")
  ✓ null → null
  ✓ 空数组 → null
  ✓ 随机选一条
```

#### `integration/prompt-building.test.ts`（新）

```
describe("buildPrompt — neutral Card")
  ✓ 包含 "桌面助手"
  ✓ 不包含任何角色特定内容
  ✓ 变量池注入
  ✓ 工具声明 + 记忆注入
  ✓ 主动搭话时无工具（仅 var_read/list）

describe("buildPrompt — angelkawaii Card")
  ✓ 包含 "KAngel" + "Pちゃん"
  ✓ 包含语言风格描述
  ✓ 包含情绪表达规则
  ✓ 包含 When 命中的语气
  ✓ 包含行为准则（全量）
  ✓ 变量操作规则含 Card 可写变量列表

describe("buildPrompt — 无 Card（回退 neutral）")
  ✓ 无 card 参数时 → 回退纯能力 prompt
```

#### `integration/agent-loop.test.ts`（重写）

```
★ 使用 MockAI 注入预设回复，验证完整流程:
  用户消息 → buildPrompt → 工具循环 → generateReply → 结果

describe("Agent Loop v5 — 基本对话")
  ✓ 单轮闲聊: "你好" → 直接回复 → generator 后处理 → 情绪标签剥离
  ✓ 工具调用: "帮我看看桌面文件" → tool_call → tool_result → 最终回复
  ✓ 多轮工具: 第一轮 tool_call → 继续 → 第二轮 直接回复
  ✓ When 语气命中: 心情="开心" + 亲密度≥5 → prompt 含 "甜腻"

describe("Agent Loop v5 — 异常路径")
  ✓ 重试耗尽 → fallbackReply("maxRetriesExhausted")
  ✓ 工具轮数用完 → fallbackReply("toolLoopMaxRounds")
  ✓ 单次请求超时 → fallbackReply("turnTimeout")

describe("Agent Loop v5 — 情绪+表情")
  ✓ 回复含 [emo:chu] → generator 剥离 → expression=chu, sound=reply
  ✓ 回复无标签 → expression="smile", sound=null
  ✓ effects 数组顺序正确: thinking → executing → done → 情绪
```

#### `integration/generator.test.ts`（新）

```
describe("generateReply — 正常路径")
  ✓ raw="[emo:chu] Pちゃん♡" → text="Pちゃん♡", emotionKey="chu", expression="chu"
  ✓ raw="普通回复无标签" → text="普通回复无标签", emotionKey=null, expression="smile"
  ✓ 超长截断 + "…"
  ✓ 在句子边界截断

describe("generateReply — 边界")
  ✓ 空字符串 → trim 后空
  ✓ 只有标签无正文 → text="", emotionKey 有值
  ✓ maxLength=0 → 空
```

#### `integration/fallback.test.ts`（新）

```
describe("getFallbackReply")
  ✓ stages 加载 → 返回 card 生成的文案
  ✓ stages.fallbacks.llmUnavailable 数组 → 随机取一条
  ✓ stages 不存在 → 降级到 FALLBACK_FALLBACKS
  ✓ 每个 key 都有值（不为空字符串、不为 undefined）
  ✓ neutral Card 返回中性文案
  ✓ angelkawaii Card 返回角色化文案

describe("硬编码消除验证")
  ✓ agent-loop 不含 "（唔…" 字符串
  ✓ agent-loop 不含 "（处理时间" 字符串
  ✓ runner.ts 不含 "糖糖正在" 字符串
  ✓ runner.ts 不含 "信号不好" 字符串
  ✓ compact.ts 不含 "压缩失败"
```

#### `integration/card-lifecycle.test.ts`（新）

```
describe("Card 生命周期")
  ✓ getCards() 返回 ≥4 个 Card（含 neutral）
  ✓ neutral Card 存在且 id="neutral"
  ✓ initRegistry() 无配置 → fallback 到 neutral
  ✓ initRegistry() 指定 angelkawaii → 激活 angelkawaii
  ✓ getActiveCard() 永远非 null（neutral 兜底）
  ✓ switchPersonality("nonexistent") → 失败/保持原 card
  ✓ 切换后变量池重初始化
  ✓ 激活问候：有 greeting → pickGreeting 非 null
  ✓ 激活问候：无 greeting (neutral) → pickGreeting 返回 null

describe("isPersonalityEnabled / setPersonalityEnabled")
  ✓ 函数已从 registry 中删除（import 报错）
```

#### `runtime/e2e-conversation.test.ts`（新）

```
★ 使用 vitest.live.config.ts，连接真实 AI Provider
★ 只做一轮完整对话验证（不耗 token）

describe("E2E: 多轮对话")
  it("neutral Card 对话", async () => {
    1. initVariablePool + 激活 neutral Card
    2. 发送 "你好" → 获取回复 → 验证不含角色身份
    3. 发送 "1+1等于几" → 验证正确回答
  }, 60000)

  it("angelkawaii 角色对话", async () => {
    1. initVariablePool + 激活 angelkawaii
    2. 发送 "你好呀" → 验证回复含角色风格
    3. 验证情绪标签被正确剥离
    4. 变量池状态正确
  }, 60000)

  it("异常兜底验证", async () => {
    1. 断开 AI → 发送消息 → 验证 getFallbackReply("llmUnavailable") 生效
  })
```

### 10.4 删除清单

| 文件 | 原因 |
|------|------|
| `__tests__/agent-loop.live.test.ts` | 旧 Phase1+Phase2 两步调用，打印旧格式 Prompt 到终端 |
| `__tests__/agent-loop.test.ts` | Mock 模式下仍按两步调用，需完全重写 |
| `__tests__/context-builder.test.ts` | 测试 `buildStylePrompt()`（v5 已删） |
| `__tests__/personality.test.ts` | 功能合并入 `card-lifecycle.test.ts` |

### 10.5 修改清单

| 文件 | 修改 |
|------|------|
| `helpers/setup.ts` | 🗑️ 删 `replyConfig` 行 L45；✏️ `personalityConfig` 去 `enabled`；🗑️ 删 `fallbackReplies` L29 |
| `helpers/fixtures.ts` | ✨ 加 `NEUTRAL_DEFS`（空变量定义） |
| `helpers/assertions.ts` | ✨ 加 `expectEmotionTag()`、`expectFallbackKey()` |
| `helpers/mock-provider.ts` | 🗑️ 删 stream 相关引用 |

### 10.6 保留不变

| 文件 | 说明 |
|------|------|
| `when-engine.test.ts` | When 表达式解析/求值/优先级，纯逻辑，与 v4/v5 无关 |
| `variable-pool.test.ts` | 变量 CRUD/reset/校验，不涉及 Phase1/Phase2 |
| `safety.test.ts` | 安全校验，纯逻辑 |
| `session.test.ts` | 状态机，纯逻辑 |
| `memory.test.ts` | 记忆 CRUD，纯逻辑 |
| `tool-execution.test.ts` | 工具注册+执行 |
| `config.test.ts` | 配置完整性（需检查是否引用 replyConfig → 删） |
| `helpers/mock-ai-controller.ts` | Scripted AI Controller，可复用 |

### 10.7 运行命令

```bash
# 单元测试（纯逻辑，无 IO）
pnpm test -- --project unit

# 集成测试（Mock AI，多模块联动）
pnpm test -- --project integration

# 全量（不含 live）
pnpm test

# 端到端（真实 AI）
pnpm test:live
```

vitest 配置更新为按目录分 project：

```ts
// vitest.config.ts
test: {
  environment: "node",
  include: [
    "src/**/__tests__/unit/**/*.test.ts",
    "src/**/__tests__/integration/**/*.test.ts",
    "src/**/__tests__/*.test.ts",     // 保留的根级测试
  ],
  exclude: [
    "src/**/__tests__/runtime/**/*.test.ts",
  ],
}
```

---

## 附录A: 删代码量统计

| 类别 | 数量 |
|------|------|
| 删函数 | 6 (`buildStylePrompt`, `summarizeToolCalls`, `formatToolRules`, `generateReplyStream`, `isPersonalityEnabled`, `setPersonalityEnabled`) |
| 删类型 | 3 (`Phase2Input`, `Phase2Output`, `AgentStage.retry`) |
| 删配置项 | 5 (`reply` 整块3项 + `personality.enabled` + `fallbackReplies`) |
| 删 UI 控件 | 3 (人格开关 + Phase2思考强度 + 流式开关) |
| 删导出 | 4 (`buildStylePrompt`, `summarizeToolCalls`, `isPersonalityEnabled`, `setPersonalityEnabled`) |
| 删代码行 | ~220 行 |
| 改代码行 | ~120 行 |
| 新文件 | 7 (`neutral.md` + 5 新测试文件) |
| 新函数 | 1 (`getFallbackReply`) |
| 新类型 | 1 (`FallbackReplies`) |
| stages 新字段 | `fallbacks`（8 个 key）+ 现有 `error`/`blocked` 字段复用至 LLM 上下文 |
| 硬编码消除 | 18 处（用户可见 9 + LLM 上下文 9） |
| stages 字段复用 | `error`, `blocked` 现已同时用于 middleware 提示 + LLM 上下文 tool result |
| 删测试文件 | 4 (`agent-loop.live`, `agent-loop`, `context-builder`, `personality`) |
| 新测试文件 | 8 (`emotion`, `must-rules`, `prompt-building`, `agent-loop`, `generator`, `fallback`, `card-lifecycle`, `e2e-conversation`) |
