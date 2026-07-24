# Plan 模块设计规格

> 日期: 2026-07-21 | 状态: 设计定稿
> 助手模式复杂任务编排器 — 自动检测复杂度 → LLM 拆解步骤 → 子代理逐步执行

---

## 一、整体架构

### 数据流

```
用户消息
  │
  ▼
PreProcessor（现有，不变）
  │
  ▼
复杂度检测 (新: planner.ts)
  ├── LLM 自判断（主要）: 额外轻量 prompt → 评分 1-5
  ├── 关键词兜底: "分析/整理/重构/修复/审查/合并/..."
  └── 强制触发: 用户输入以 --plan 开头
  │
  ├── 低复杂度 (< threshold) → 跳过 Plan → 直接 runToolLoop（当前行为）
  │
  └── 高复杂度 (>= threshold) → Plan 流程:
       │
       ├─ 1️⃣ Plan 生成
       │    transition("PLANNING")
       │    middleware.wrap("planning") → 表情 "business" + 文案
       │    一次 LLM 调用 (thinkingEffort = plan.thinkingEffort)
       │    → 拆解为 PlanStep[]
       │
       ├─ 2️⃣ Plan 展示 + 确认（尊重安全模式）
       │    just_do_it  → 跳过确认，直接全部执行
       │    let_me_tk   → 强制逐步确认，不显示"全部执行"
       │    tell_me     → 展示计划，用户选 [全部执行]/[逐步确认]/[取消]
       │
       ├─ 3️⃣ 逐步执行
       │    for each step:
       │      emit("plan:progress", {step:N, total:M, desc:"..."})
       │      runForkAgent/runSubLoop({ task, tools, thinkingEffort: plan.stepThinkingEffort })
       │      → SubLoopOutput { reply, success }
       │      逐步确认模式: 每步完成暂停等用户确认
       │      失败处理: 按 onStepFailure 策略 (continue/abort/ask)
       │
       └─ 4️⃣ 汇总
            transition("GENERATING")
            注入步骤结果到主 loop prompt
            runToolLoop 汇总所有步骤结果
            → generateReply → 返回
```

### 与子代理的关系

| 步骤类型 | 执行方式 | 场景 |
|---------|---------|------|
| 简单步骤 | `runForkAgent({ task, role })` | 单一任务，无需特殊工具限制 |
| 可并行步骤 | `runTeamAgent({ task, memberCount })` | 多视角分析，独立子任务 |
| 自定义步骤 | `runSubLoop({ tools, systemPrompt, ... })` | 需要限制/扩展特定工具集 |

### 工具层访问

- Plan **仅在助手模式启用**，子代理默认有全部 assistant 工具（local + local-extra + skill + mcp）
- **变量工具（var_read/write/list/delete）始终暴露**，不受模式限制
- Plan 可通过 `step.allowedTools: string[]` 限制每步可用工具

---

## 二、状态机 + 配置

### 状态机 (`engine/session.ts`)

```
WAITING → PRE ──┬── GENERATING → EXECUTING  (简单任务，当前路径)
                │
                └── PLANNING → GENERATING    (复杂任务，Plan 路径)
                       │
                       └── WAITING           (用户取消计划)
```

**变更：** `PLANNING` 重新加入 `AgentState` 类型（有实际转换，非死代码）。

| 从 | 到 | 触发 |
|---|---|------|
| PRE | PLANNING | 复杂度检测 >= 阈值 |
| PLANNING | GENERATING | Plan 确认通过，开始执行步骤 |
| PLANNING | WAITING | 用户取消 Plan / 生成失败降级 |

### 配置项 (`CONFIG.yaml`)

```yaml
ai:
  plan:
    enabled: true              # 助手模式下启用 Plan
    complexityThreshold: 3     # LLM 复杂度评分 >= 此值触发 (1-5)
    maxSteps: 8                # 最大步骤数
    stepTimeoutMs: 90000       # 单步超时 (ms)
    stepMaxRounds: 5           # 单步最大工具轮次
    thinkingEffort: "medium"   # Plan 生成时的思考强度
    stepThinkingEffort: "low"  # 每步子代理执行的思考强度
    onStepFailure: "continue"  # continue | abort | ask
    keywords:                  # 兜底关键词
      - 分析
      - 整理
      - 重构
      - 修复
      - 审查
      - 合并
      - 总结
      - 生成
      - 创建项目
```

- `thinkingEffort` 和 `stepThinkingEffort` 分开配置，各自独立在设置页面调整
- 所有配置项支持 localStorage override（遵循 config.ts 现有机制）

### 核心类型

```typescript
interface PlanStep {
  id: number
  description: string          // LLM 生成的步骤描述
  role?: string                // 子代理角色 (如 "代码分析员")
  allowedTools?: string[]      // 限制可用工具名，默认全部 assistant 工具
  dependsOn?: number[]         // 依赖的步骤 ID
  parallel?: boolean           // 可与其他无依赖步骤并行
}

interface PlanResult {
  steps: PlanStep[]
  summary: string              // LLM 生成的计划摘要
  estimatedComplexity: number  // 1-5
}

interface ComplexityResult {
  score: number                // 1-5
  reason: string               // LLM 判定理由
  triggeredBy: "llm" | "keyword" | "force"
}

interface PlanExecutionResult {
  stepResults: {
    step: PlanStep
    output: SubLoopOutput
    durationMs: number
  }[]
  overallSuccess: boolean
  totalDurationMs: number
}
```

---

## 三、文件结构 + 关键接口

### 文件变更清单

```
新建:
  src/services/engine/planner.ts      ← Plan 核心逻辑
  src/components/PlanConfirm.vue      ← 计划展示 + 确认 UI

修改:
  src/services/engine/agent-loop.ts   ← 插入 Plan 阶段（buildPrompt 后、runToolLoop 前）
  src/services/engine/session.ts      ← 添加 PLANNING 状态 + 转换
  src/services/personality/middleware.ts    ← planning case 返回实际文案
  src/services/personality/stages-cache.ts  ← 移除 planning 硬编码 null
  src/services/personality/stages-prompt.md ← 移除 "planning": "" 约束
  src/components/ChatPanel.vue        ← 集成 PlanConfirm 组件
  CONFIG.yaml + CONFIG-DEV.yaml       ← 新增 plan 配置节
  src/services/config.ts              ← 新增 planConfig getter
```

### `planner.ts` 核心接口

```typescript
// ── 复杂度检测 ──
async function evaluateComplexity(
  userText: string,
  context: { card: CardDef; pool: VariablePool }
): Promise<ComplexityResult>

// ── Plan 生成 ──
async function generatePlan(
  userText: string,
  context: {
    card: CardDef
    pool: VariablePool
    availableTools: ToolDef[]
    thinkingEffort: ThinkingEffort
  }
): Promise<PlanResult>

// ── Plan 执行 ──
async function executePlan(
  plan: PlanResult,
  mode: "auto" | "stepByStep",
  callbacks: {
    onStepStart(step: PlanStep): void
    onStepDone(step: PlanStep, result: SubLoopOutput): void
    onStepFailed(step: PlanStep, error: string): Promise<"continue"|"abort">
    onProgress(step: number, total: number, desc: string): void
  },
  config: {
    stepTimeoutMs: number
    stepMaxRounds: number
    stepThinkingEffort: ThinkingEffort
  }
): Promise<PlanExecutionResult>
```

### Plan 生成 System Prompt 要点

- 注入当前 card 角色设定
- 注入所有可用工具清单（名称 + 描述 + 安全级别）
- 明确变量工具始终可用
- 指令：拆解为 1-N 步，每步标注角色、建议工具、依赖关系、是否可并行
- 输出格式：JSON `{ steps: PlanStep[], summary, estimatedComplexity }`

### 步骤执行实现

```typescript
async function executeStep(
  step: PlanStep,
  config: PlanConfig,
  onProgress: (msg: string) => void
): Promise<SubLoopOutput> {
  const stepPrompt = `
你是糖糖桌宠的子代理，角色: ${step.role || "执行员"}。
正在执行计划第 ${step.id} 步: ${step.description}

可用工具: ${getStepToolDeclarations(step.allowedTools).join("\n")}
变量工具始终可用 (var_read, var_write, var_list, var_delete)。

请完成此步骤并返回结果。如果需要多步工具调用，请自行判断。
  `.trim()

  const tools = step.allowedTools
    ? resolveToolsByName(step.allowedTools)
    : getToolsForMode("assistant")
  tools.push(...getVarTools())  // 变量工具始终追加

  return runSubLoop({
    task: step.description,
    tools,
    systemPrompt: stepPrompt,
    maxRounds: config.stepMaxRounds,
    timeoutMs: config.stepTimeoutMs,
    thinkingEffort: config.stepThinkingEffort,
  })
}
```

---

## 四、UI 交互

### PlanConfirm.vue — 确认阶段

```
┌────────────────────────────────────────┐
│  🔍 任务分析                           │
│                                        │
│  复杂度: ★★★★☆ (4/5)                  │
│  计划共 4 步，预计需要文件读写、bash    │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ 1. 📂 列出项目目录结构            │  │
│  │    角色: 文件分析员               │  │
│  │    工具: file_list, file_search   │  │
│  │                                  │  │
│  │ 2. 🔍 搜索所有 .vue 文件         │  │
│  │    角色: 代码搜索员               │  │
│  │                                  │  │
│  │ 3. 📊 分析组件引用关系  ⚡可并行  │  │
│  │    角色: 代码分析员               │  │
│  │                                  │  │
│  │ 4. 📝 生成依赖关系报告           │  │
│  │    依赖: 步骤 1,2,3              │  │
│  └──────────────────────────────────┘  │
│                                        │
│  [全部执行]  [逐步确认]  [取消]        │
└────────────────────────────────────────┘
```

### PlanConfirm.vue — 执行中

```
┌────────────────────────────────────────┐
│  🔄 执行中...  (2/4)                   │
│                                        │
│  ✅ 1. 列出项目目录结构   (1.2s)       │
│  ⏳ 2. 搜索所有 .vue 文件...           │
│  ⏸️ 3. 分析组件引用关系                │
│  ⏸️ 4. 生成依赖关系报告                │
│                                        │
│  [终止执行]                            │
└────────────────────────────────────────┘
```

### 安全模式对 UI 的影响

| 安全模式 | 是否显示确认 UI | 按钮 |
|---------|:---:|------|
| `tell_me` | ✅ | [全部执行] [逐步确认] [取消] |
| `just_do_it` | ❌ 跳过 | — |
| `let_me_tk` | ✅ | [逐步确认] [取消]（无"全部执行"） |

---

## 五、安全模式 + Edge Cases + 对接

### 安全模式映射

```typescript
function resolvePlanMode(safetyMode: SafetyMode): {
  showConfirm: boolean
  allowAutoAll: boolean
  forceStepByStep: boolean
} {
  switch (safetyMode) {
    case "just_do_it": return { showConfirm: false, allowAutoAll: true,  forceStepByStep: false }
    case "let_me_tk":  return { showConfirm: true,  allowAutoAll: false, forceStepByStep: true  }
    default:           return { showConfirm: true,  allowAutoAll: true,  forceStepByStep: false }
  }
}
```

### Edge Cases

| 场景 | 处理 |
|------|------|
| Plan 生成时 LLM 返回空步骤 | 降级为普通 runToolLoop，记录 `plan:empty` |
| 单步执行超时 | `onStepFailed` → 按 `onStepFailure` 策略 |
| 子代理安全拒绝 | 同超时处理，`output.success = false` |
| 逐步确认中用户取消 | `transition("WAITING")`，返回已完成步骤汇总 + 取消说明 |
| 全部执行中途失败 | `continue` → 继续；`abort` → 终止；`ask` → 暂停弹窗 |
| MCP 工具不可用 | 子代理 LLM 收到 undefined tool error → 自行适配 |
| 子代理调用危险工具 | `checkSafety()` 处理，无确认 UI 则被拒返回 error |
| Plan 生成时 token 不足 | 先 `shouldCompact()` → 再生成 Plan |
| `--plan` 强制但请求简单 | Plan LLM 返回 1 步 "直接回答" → 执行 → 汇总 |

### 对接 `agent-loop.ts`

```
runAgentLoop() 流程变更:
  refreshVariablePool()           ← 不变
  getActiveCard()                 ← 不变
  buildPrompt()                   ← 不变
  ┌─ Plan 阶段 (新增) ───────────────────┐
  │ evaluateComplexity(userText, ctx)     │
  │ if (score >= threshold):             │
  │   transition("PLANNING")             │
  │   plan = await generatePlan(...)      │
  │   planMode = resolvePlanMode(safety) │
  │   if planMode.showConfirm:           │
  │     confirmed = await requestPlanConfirm(plan.steps)
  │   if confirmed or !showConfirm:       │
  │     stepContext = await executePlan(plan, mode, callbacks, config)
  │     将 stepContext 注入后续 prompt     │
  │   else:                               │
  │     transition("WAITING")             │
  │     return cancelReply                │
  └───────────────────────────────────────┘
  runToolLoop(enhancedPrompt)      ← 收到步骤结果上下文
  generateReply(raw, card)         ← 不变
```

### 步骤结果注入格式

```
[计划执行结果]
✅ 步骤 1 "列出项目目录结构" - 完成 (1.2s)
   结果: 发现 45 个文件，3 个目录...
✅ 步骤 2 "搜索所有 .vue 文件" - 完成 (0.8s)
   结果: 找到 12 个 .vue 文件...
❌ 步骤 4 "生成报告" - 失败
   错误: 文件写入权限不足

请基于以上结果生成最终回复。
```

### 进度事件

```typescript
emit("deskpet-plan-start",    { steps: PlanStep[], complexity: number })
emit("deskpet-plan-progress", { step: number, total: number, desc: string, status: "running"|"done"|"failed" })
emit("deskpet-plan-done",     { result: PlanExecutionResult })
emit("deskpet-plan-cancel",   { completedSteps: number, totalSteps: number })
```

---

## 六、自审清单

- [x] **无 TBD/TODO** — 所有接口、配置、流程已明确
- [x] **内部一致** — 状态机、配置、接口、UI 相互对应
- [x] **范围适中** — 单一模块 (Plan)，不涉及 Memory/变量池/其他重构
- [x] **无歧义** — 复杂度检测机制、确认流程、失败策略均已明确
- [x] **复用现有机制** — runForkAgent、runSubLoop、checkSafety、middleware.wrap、getEffectiveThinkingEffort 全部复用
- [x] **配置可调** — thinkingEffort/stepThinkingEffort 独立配置，所有参数可 localStorage override
- [x] **安全模式兼容** — tell_me/just_do_it/let_me_tk 三种模式完整映射
- [x] **变量工具始终暴露** — 和主 loop 一致
- [x] **关键词仅兜底** — LLM 自判断为主，关键词为辅助
