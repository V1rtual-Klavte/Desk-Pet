# Live Test Framework — AI 自驱动端到端测试框架

> 状态: 设计完成 | 日期: 2026-07-24 | 项目: Desk-Pet

## 1. 概述

### 1.1 目标

用真实 LLM 模拟用户与桌宠对话，检查**输出**和**内部状态**是否全部符合预期。全部必须通过，任一检查失败 = 测试失败。

### 1.2 核心理念

- **AI 自驱动**: AI 分析源码 → 生成覆盖契约 → 生成测试场景 → 执行 → 审计
- **Contract 约束**: 每个模块一份契约文件，锁定"必须测什么"，防止 AI 偷懒
- **真 LLM 对话**: 不用 mock，直接调 `runAgentLoop()` + 真实 Provider
- **全部必须检查**: 没有 warn，只有 pass/fail

### 1.3 旧测试全部移除

旧的 8 个单元测试文件 + helpers/ 全部删除，由新框架完全取代：

```
src/services/__tests__/
├── ❌ config.test.ts
├── ❌ memory.test.ts
├── ❌ planner.test.ts
├── ❌ safety.test.ts
├── ❌ session.test.ts
├── ❌ tool-execution.test.ts
├── ❌ variable-pool.test.ts
├── ❌ when-engine.test.ts
├── ❌ helpers/ (全部)
└── ✅ live/  (全新)
```

vitest.config.ts 删除，vitest.live.config.ts 重命名为 vitest.config.ts 作为唯一入口。

---

## 2. 架构

### 2.1 目录结构

```
src/services/__tests__/live/
├── SKILL.md                         # 项目专属 Skill (Claude Code 可调用)
├── cli.ts                           # CLI 入口 (运行场景) + vitest 桥接
├── index.live.test.ts               # vitest 入口

├── engine/                          # 核心引擎
│   ├── contract-analyzer.ts         # AI 读源码 → 生成 coverage contract
│   ├── contract-checker.ts          # 源码 hash 对比 + 完整性校验 + audit
│   ├── scene-generator.ts           # AI 读 contract → 生成测试场景
│   ├── scene-runner.ts              # 场景执行引擎 (调 runAgentLoop + 断言)
│   └── reporter.ts                  # 测试报告 (terminal / json / markdown)

├── contracts/                       # AI 生成 + 人 review
│   ├── variable-pool.contract.ts
│   ├── when-engine.contract.ts
│   ├── emotion.contract.ts
│   ├── safety.contract.ts
│   ├── memory.contract.ts
│   ├── planner.contract.ts
│   ├── tool-execution.contract.ts
│   └── personality-card.contract.ts

└── scenes/                          # AI 根据 contract 生成
    ├── variable-pool/
    ├── when-engine/
    ├── emotion/
    ├── safety/
    ├── memory/
    ├── planner/
    └── tool-execution/
```

### 2.2 组件关系 + 运行模式

**两阶段分离：**

| 阶段 | 触发方式 | 需要 AI? | 说明 |
|------|----------|----------|------|
| Contract/Scene 生成 | Claude Code Skill (`--analyze` / `--generate` / `--audit`) | ✅ 需要 | AI 分析源码+生成内容 |
| 场景执行 | `pnpm test:live` (vitest) | ❌ 不需要 AI | 纯 runner，调 runAgentLoop + 断言 |

```
Claude Code 对话 (AI 驱动)
├── /analyze  → contract-analyzer  → 写 contracts/*.contract.ts
├── /generate → scene-generator    → 写 scenes/**/*.scene.ts
└── /audit    → contract-checker   → AI 审视报告

pnpm test:live (vitest, 无需 AI)
└── 执行所有 Scene → scene-runner → reporter
```

### 2.3 数据流

```
源码修改
  ↓
(Claude Code) --analyze:  Claude 读源码 → 分析所有可测点 → 生成 Contract + hash 锁定
  ↓
(Claude Code) --generate: Claude 读 Contract → 生成具体对话场景 (DSL 格式)
  ↓
(pnpm test:live): contract-checker 验证 hash → scene-runner 调 runAgentLoop(真LLM) → 断言 → 报告
  ↓
(Claude Code) --audit:   Claude 审视覆盖完整性 (深度/边界/遗漏)
```

**关键区分：**
- `--analyze` / `--generate` / `--audit` 必须通过 Claude Code Skill 触发（需要 AI 分析+生成能力）
- `pnpm test:live` 是纯 vitest 执行，Scene runner 内部调 `runAgentLoop()` 走项目配置的真 LLM Provider

---

## 3. Coverage Contract (覆盖契约)

### 3.1 数据结构

```typescript
interface ModuleContract {
  module: string
  sourceFiles: string[]
  generatedAt: string          // ISO timestamp
  sourceHash: string           // sha256 of all sourceFiles

  coverage: CoveragePoint[]

  rules: {
    minScenarios: number
    minDeepScenarios: number
    requireBoundary: boolean
    requireErrorPath: boolean
  }
}

interface CoveragePoint {
  id: string                   // "vp-01"
  feature: string              // "Card变量 LLM写入"
  description: string          // "用户夸奖/批评 → LLM 调 var_write 更新亲密度和心情"
  why: string                  // "核心更新闭环"
  depth: "shallow" | "deep"    // shallow=单轮, deep=多轮+边界
  scenarios: string[]          // 关联的 scene 文件名，AI --generate 填充
}
```

### 3.2 AI 生成 Contract 的逻辑

AI 读源码 → 分析：

- **导出函数/方法**: 每个公开 API 作为可测点
- **分支路径**: if/switch/try-catch，每个分支一个测点
- **边界值**: min/max/enum/范围校验 → 边界测试点
- **错误路径**: 返回 false/error 的路径 → 错误测试点
- **深度判定**: 有状态变化的 → deep；纯计算/查询的 → shallow

### 3.3 防偷懒机制 (contract-checker)

| 检查 | 条件 | 行为 |
|------|------|------|
| STALE | sourceHash ≠ 当前源码 hash | 报错退出，要求 --analyze |
| MISSING | coverage point 无对应 scene | 报 [MISSING] 警告 |
| COUNT | 场景数 < rules.minScenarios | 报 [GAP] |
| DEPTH | deep 场景数 < rules.minDeepScenarios | 报 [GAP] |
| BOUNDARY | requireBoundary=true 但没有边界场景 | 报 [GAP] |
| ERROR | requireErrorPath=true 但没有错误路径场景 | 报 [GAP] |

---

## 4. Scene DSL (测试场景定义)

### 4.1 场景结构

```typescript
interface SceneDef {
  meta: {
    module: string
    contractId: string
    description: string
    depth: "shallow" | "deep"
    tags?: string[]
    timeout?: number           // 默认 120000ms
  }
  setup?: () => Promise<void>
  turns: TurnDef[]
}

interface TurnDef {
  index: number
  description: string
  userText: string
  checks: AssertCheck[]
}
```

### 4.2 断言类型

| 断言 | 参数 | 检查内容 |
|------|------|----------|
| `expectReply` | `fn(r: ReplyResult)` | 回复输出: text, emotionKey, expression, sound |
| `expectText` | `fn(t: string)` | 纯文本内容 |
| `expectEmotion` | `string \| RegExp` | emotionKey 精确/正则匹配 |
| `expectExpression` | `string \| RegExp` | expression 精确/正则匹配 |
| `expectVar` | `name, fn(v: VariableState)` | 单个变量值/类型/updatedBy |
| `expectVars` | `names[], fn(v: Record)` | 多个变量一起检查 |
| `expectAnyVarWritten` | — | 至少一个变量被 LLM 更新 |
| `expectNoVarWritten` | — | 不应该有任何变量更新 |
| `expectSessionState` | `string` | 会话状态: WAITING/GENERATING/EXECUTING |
| `expectToolCalled` | `string` | 期望调用了指定工具 |
| `expectToolBlocked` | `string` | 期望工具被安全拦截 |
| `expectEffect` | `fn(e: Effect[])` | effects 数组检查 |
| `expectMemory` | `fn(m: MemorySnapshot)` | 记忆系统状态 |

### 4.3 DSL 只定义格式，不定义内容

AI 根据 Contract 自动填充所有内容：发什么消息、断言什么、用多少轮。DSL 是格式容器，不是硬编码测试用例。人只需要 review 一眼 AI 生成的结果。

### 4.4 场景执行规则

- 每轮全部断言通过 → 下一轮
- 任一断言失败 → 场景立即终止，标记 FAIL
- setup 失败 → 场景标记 SKIP
- 真 LLM 超时 → 场景标记 TIMEOUT

### 4.5 场景间状态隔离 (setup 约定)

每个场景的 `setup()` 必须重置共享状态，确保场景间互不干扰：

```typescript
// 标准 setup 模板
async function standardSetup() {
  // 1. 重置会话
  transition("WAITING")
  resetSession()
  
  // 2. 重置变量池到初始状态
  destroyPool()
  initVariablePool({
    cardId: getActiveCard()!.id,
    variableDefs: getActiveCard()!.sections.variableDefs,
  })
  
  // 3. 清空记忆
  MemoryService.init()
  MemoryService.clear()
  
  // 4. 清空 chatHistory
  clearMessages()
}
```

---

## 5. Scene 生成器

### 5.1 流程

```
--generate 触发
  ↓
对每个 contract 的每个 coverage point:
  ├─ 读 contract: { id, feature, description, why, depth }
  ├─ 读相关源码 (sourceFiles)
  ├─ AI 生成提示词:
  │   - 系统角色: "你是测试场景生成器"
  │   - 输入: contract + 源码
  │   - 约束: depth 要求、边界、错误路径
  │   - 输出: SceneDef 格式
  ├─ AI 输出 → 写入 scenes/{module}/{场景名}.scene.ts
  └─ 回写 contract: coverage.scenarios[] 填充文件名
```

### 5.2 AI 生成的约束 prompt

```
你是 Desk-Pet 的测试场景生成器。为一个互动桌宠生成测试场景。

模块: {module}
功能: {feature}
深度: {depth}  (shallow=1轮, deep≥3轮含边界验证)

源码: {sourceCode}

生成一个 SceneDef，要求:
1. 用户消息自然口语化，像真人聊天
2. deep 场景必须多轮对话，包含对比 (先A后B看变化)
3. 必须断言回复输出 (text/emotionKey/expression)
4. 必须断言内部状态 (变量池/会话/记忆)
5. 如需边界测试，必须构造触发边界的对话

输出格式: TypeScript SceneDef
```

---

## 6. 执行引擎

### 6.1 Scene Runner

```
场景执行
  ├─ 调 setup() (如果有)
  ├─ 逐轮执行:
  │   ├─ 调 runAgentLoop(userText, chatMessages, ...)
  │   ├─ 收集内部状态: pool = getPoolSnapshot(), session = getSession()
  │   ├─ 执行本轮所有断言 checks
  │   └─ 任一失败 → 终止场景
  └─ 返回 SceneResult { passed, turns, duration }
```

### 6.2 报告格式

```
📋 Live Test Report — 2026-07-24 15:30
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ variable-pool / vp-02 / 亲密度提升        2.3s
   ✓ T1 "你今天好可爱呀！" — 5 checks pass
   ✓ T2 "其实也就一般般啦" — 5 checks pass

❌ emotion / em-01 / 情绪标签生成            3.1s
   ✓ T1 "今天好开心" — 5 checks pass
   ✗ T2 "我失恋了" — expectEmotion('sad')
      实际: null  期望: "sad"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Modules:  1/2 pass   Scenes: 2/3 pass   8/9 turns pass
⏱ Total: 12.4s   💰 Tokens: ~8,200
```

---

## 7. CLI + Skill

### 7.1 命令（分两类）

**Claude Code Skill 命令（需要 AI）：**

```bash
# 在 Claude Code 对话中说:
/analyze test                    # AI 分析所有模块源码 → 生成 Contract
/analyze test variable-pool      # 分析单个模块
/generate test                   # AI 读所有 Contract → 生成 Scene
/generate test variable-pool     # 生成单个模块
/audit test                      # AI 审视覆盖完整性
/audit test --strict             # 有 GAP 直接报错
```

**vitest CLI 命令（纯执行，不需要 AI）：**

```bash
pnpm test:live                          # 运行全部场景
pnpm test:live --module variable-pool   # 运行单个模块
pnpm test:live --scene 亲密度提升        # 运行单个场景
pnpm test:live --tag card               # 按 tag 筛选
pnpm test:live --report json            # JSON 输出
pnpm test:live --report markdown        # Markdown 输出
```

### 7.2 Skill

SKILL.md 放在 `src/services/__tests__/live/SKILL.md`，属于 Desk-Pet 项目专属 Skill，不污染全局 `.claude/skills/` 池。

Skill 提供：
- `/analyze test` — 分析源码生成 Contract
- `/generate test` — 根据 Contract 生成 Scene
- `/audit test` — 审视覆盖完整性
- 对话中说 "跑测试" → 调 `pnpm test:live`，用人话解释结果

### 7.3 LLM Provider

场景执行时，runner 直接调 `runAgentLoop()`，使用项目已有的 `aiConfig` provider 配置（与主应用同一个 LLM）。不需要额外配置 API key。

### 7.3 vitest 配置

vitest.config.ts → 删除
vitest.live.config.ts → 重命名为 vitest.config.ts，作为唯一测试配置

```typescript
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/__tests__/live/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
})
```

package.json: `"test": "vitest run"` (指向唯一 config)

---

## 8. 覆盖的模块清单

| 模块 | Contract | 说明 |
|------|----------|------|
| variable-pool | ✅ | 变量池 CRUD + 持久化 + Reset + LLM 写入闭环 |
| when-engine | ✅ | When 引擎求值 + 规则优先级 + 变量池联动 |
| emotion | ✅ | `[emo:key]` 标签生成 + 表情/音效映射 |
| safety | ✅ | 四级安全 + 危险模式匹配 + 确认 + 会话信任 |
| memory | ✅ | 记忆 CRUD + 搜索 + 整理 |
| planner | ✅ | Plan 复杂度评估 + 步骤执行 + 格式化 |
| tool-execution | ✅ | 工具注册 + 执行 + bash 白名单 |
| personality-card | ✅ | Card 加载/切换 + 变量池初始化 |

---

## 9. 错误处理

| 场景 | 行为 |
|------|------|
| API key 未配置 | 启动时报错退出，提示配置环境变量 |
| LLM 超时 | 场景标记 TIMEOUT，继续下一个 |
| Contract hash 过期 | 报 [STALE]，拒绝执行，要求 --analyze |
| Scene 文件缺失 | 报 [MISSING]，建议 --generate |
| 并发锁冲突 | 等待当前 AI 生成完成后自动重试 |
| 网络断开 | 场景标记 FAIL，记录错误信息 |

---

## 10. 约束

- 旧测试全部移除，不保留 mock 基础设施
- 所有断言必须通过，没有 warn 级别
- Contract 文件 AI 生成，可人 review 修改
- Scene 文件 AI 生成，可人 review 修改
- Skill 放在测试模块内部，不污染全局
- 每个场景独立，互不影响（setup 负责重置状态）
