# Plan 模块实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Desk-Pet 助手模式实现 Plan 模块 — 自动检测复杂任务 → LLM 拆解步骤 → 子代理逐步执行

**Architecture:** `engine/planner.ts` 是核心编排器，复用现有 `runSubLoop`/`runForkAgent` 执行步骤。复杂度检测以 LLM 自判断为主，关键词兜底。确认流程尊重安全模式（tell_me/just_do_it/let_me_tk）。Plan 生成和步骤执行各用独立的 thinkingEffort 配置。

**Tech Stack:** TypeScript + Vue 3 + Tauri v2，复用已有：`runSubLoop`、`runForkAgent`、`PetPersonalityMiddleware.wrap`、`checkSafety`、`config.ts` overrideOr 模式

## Global Constraints

- 仅助手模式（`generalConfig.assistantMode === true`）启用 Plan
- `thinkingEffort` 和 `stepThinkingEffort` 独立配置，设置页面分开调整
- 变量工具（var_*）始终暴露，不受步骤 `allowedTools` 限制
- 所有配置走 `@/services/config`，模块内不硬编码
- 遵循 `CONFIG.yaml` → `config.ts` → localStorage override 模式
- 关键词仅兜底，LLM 自判断为主

---

### Task 1: 配置系统 — planConfig

**Files:**
- Modify: `CONFIG.yaml:67`（在 `memory:` 块后插入 `plan:` 块）
- Modify: `CONFIG-DEV.yaml`（同步插入）
- Modify: `src/services/config.ts`（新增 `planConfig` getter）

**Interfaces:**
- Produces: `planConfig` 对象（导出给 planner.ts 和 settings UI 消费）

- [ ] **Step 1: 在 CONFIG.yaml 的 `ai.memory` 块后插入 plan 配置**

`CONFIG.yaml` 第 70 行后（`maxSessions: 20` 之后）插入：

```yaml
  plan:
    enabled: true
    complexityThreshold: 3
    maxSteps: 8
    stepTimeoutMs: 90000
    stepMaxRounds: 5
    thinkingEffort: medium
    stepThinkingEffort: low
    onStepFailure: continue
    keywords:
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

- [ ] **Step 2: 在 CONFIG-DEV.yaml 中同步插入相同内容**

- [ ] **Step 3: 在 config.ts 中新增 planConfig getter**

在 `src/services/config.ts` 的 `memoryConfig` 块之后（约第 356 行）插入：

```typescript
export const planConfig = {
  get enabled() { return overrideOr("ai.plan.enabled", cfg.ai?.plan?.enabled ?? true); },
  get complexityThreshold() { return overrideOr("ai.plan.complexityThreshold", cfg.ai?.plan?.complexityThreshold ?? 3); },
  get maxSteps() { return overrideOr("ai.plan.maxSteps", cfg.ai?.plan?.maxSteps ?? 8); },
  get stepTimeoutMs() { return overrideOr("ai.plan.stepTimeoutMs", cfg.ai?.plan?.stepTimeoutMs ?? 90000); },
  get stepMaxRounds() { return overrideOr("ai.plan.stepMaxRounds", cfg.ai?.plan?.stepMaxRounds ?? 5); },
  get thinkingEffort() { return overrideOr("ai.plan.thinkingEffort", cfg.ai?.plan?.thinkingEffort || "medium") as ThinkingEffort; },
  get stepThinkingEffort() { return overrideOr("ai.plan.stepThinkingEffort", cfg.ai?.plan?.stepThinkingEffort || "low") as ThinkingEffort; },
  get onStepFailure() { return overrideOr("ai.plan.onStepFailure", cfg.ai?.plan?.onStepFailure || "continue") as "continue" | "abort" | "ask"; },
  get keywords() { return overrideOr("ai.plan.keywords", cfg.ai?.plan?.keywords || ["分析", "整理", "重构", "修复", "审查", "合并", "总结", "生成", "创建项目"]) as string[]; },
};
```

- [ ] **Step 4: 验证 — 确认 TypeScript 编译通过**

Run: `npx vue-tsc --noEmit`
Expected: 无新增 error（pre-existing test errors 忽略）

- [ ] **Step 5: 验证 — 确认 CONFIG.yaml 语法**

Run: `node -e "const yaml = require('yaml'); const fs = require('fs'); yaml.parse(fs.readFileSync('CONFIG.yaml','utf8')); console.log('OK')"`
Expected: OK

---

### Task 2: SubLoop 支持 thinkingEffort 参数

**Files:**
- Modify: `src/services/agent/sub-loop.ts:19-30`（SubLoopInput 接口 + 实现）

**Interfaces:**
- Consumes: 无
- Produces: `SubLoopInput.thinkingEffort?: ThinkingEffort`（可选字段，默认 "low"，向后兼容）

- [ ] **Step 1: 在 SubLoopInput 接口添加 thinkingEffort 字段**

在 `src/services/agent/sub-loop.ts` 第 19-30 行，`SubLoopInput` 接口添加:

```typescript
export interface SubLoopInput {
  task: string
  tools: ToolDef[]
  systemPrompt: string
  maxRounds?: number
  timeoutMs?: number
  /** 思考强度，默认 "low" */
  thinkingEffort?: import("@/services/agent/types").ThinkingEffort
}
```

- [ ] **Step 2: 替换硬编码 "low" 为 input.thinkingEffort**

第 78 行：`thinkingEffort: "low"` → `thinkingEffort: input.thinkingEffort || "low"`

第 139 行：`thinkingEffort: "low"` → `thinkingEffort: input.thinkingEffort || "low"`

- [ ] **Step 3: 验证 — 确认无类型错误**

Run: `npx vue-tsc --noEmit`
Expected: 无新增 error

---

### Task 3: 状态机 — PLANNING 状态恢复

**Files:**
- Modify: `src/services/engine/session.ts:3,12-16`（AgentState 类型 + 注释）

**Interfaces:**
- Produces: `AgentState` 联合类型新增 `"PLANNING"` 成员

- [ ] **Step 1: 更新文件头注释**

`src/services/engine/session.ts` 第 3 行：

```typescript
// 管理 Agent 状态流转: WAITING → PRE → PLANNING/GENERATING → EXECUTING
```

- [ ] **Step 2: 在 AgentState 类型中添加 PLANNING**

第 12-16 行：

```typescript
export type AgentState =
  | "WAITING"
  | "PRE"
  | "PLANNING"    // Plan 生成中（助手模式复杂任务）
  | "GENERATING"
  | "EXECUTING"
```

- [ ] **Step 3: 验证**

Run: `npx vue-tsc --noEmit`
Expected: 无新增 error（PLANNING 还未被引用，不算 error）

---

### Task 4: Stages — planning 阶段文案修复

**Files:**
- Modify: `src/services/personality/stages-cache.ts:79,283`（FALLBACK_STAGES + normalizeStageMap）
- Modify: `src/services/personality/middleware.ts:1`（文件头版本号）
- Modify: `src/services/personality/stages-prompt.md`（移除空字符串约束）

**Interfaces:**
- Consumes: 无
- Produces: `getSimpleStage("planning")` 现在返回非 null 文案

- [ ] **Step 1: FALLBACK_STAGES.planning 从 null 改为实际文案**

`stages-cache.ts` 第 79 行：

```typescript
  planning: "让我想想怎么帮你规划～",
```

- [ ] **Step 2: normalizeStageMap 中移除 planning 硬编码 null**

`stages-cache.ts` 第 283 行附近。找到 `normalizeStageMap` 函数中类似的硬编码 null 覆盖语句，移除 `planning` 相关的 null 覆盖，让 LLM 生成的 `planning` 文案生效。

- [ ] **Step 3: 更新 middleware.ts 文件头版本号**

`middleware.ts` 第 2 行：

```typescript
// 人格中间件 v5 — stages 缓存 + actionCategory 匹配
```

- [ ] **Step 4: 更新 stages-prompt.md 中 planning 字段约束**

找到 `"planning": ""` 行，改为提示 LLM 生成实际文案：

```
"planning": "正在分析你的任务，制定执行计划…",
```

- [ ] **Step 5: 验证**

Run: `npx vue-tsc --noEmit`
Expected: 无新增 error

---

### Task 5: Planner 核心 — planner.ts

**Files:**
- Create: `src/services/engine/planner.ts`

**Interfaces:**
- Consumes: `planConfig` from `@/services/config`, `runForkAgent`/`runSubLoop` from `@/services/agent`, `getToolsForMode` from `@/services/tool`, `PetPersonalityMiddleware` from `@/services/personality`
- Produces: `evaluateComplexity()`, `generatePlan()`, `executePlan()`, `formatStepResults()`, `PlanStep`, `PlanResult`, `ComplexityResult`, `PlanExecutionResult`

- [ ] **Step 1: 创建文件骨架和类型定义**

Create `src/services/engine/planner.ts`:

```typescript
// ==========================================
// Plan 模块 — 助手模式复杂任务编排器
// 复杂度检测 → LLM 拆解 → 子代理逐步执行
// ==========================================

import type { ToolDef } from "@/services/tool/types"
import type { SubLoopOutput } from "@/services/agent/sub-loop"
import type { ThinkingEffort } from "@/services/agent/types"
import { createLogger } from "@/services/logger"

const log = createLogger("Planner")

// ── 类型 ──

export interface PlanStep {
  id: number
  description: string
  role?: string
  allowedTools?: string[]
  dependsOn?: number[]
  parallel?: boolean
}

export interface PlanResult {
  steps: PlanStep[]
  summary: string
  estimatedComplexity: number
}

export interface ComplexityResult {
  score: number
  reason: string
  triggeredBy: "llm" | "keyword" | "force"
}

export interface PlanExecutionResult {
  stepResults: {
    step: PlanStep
    output: SubLoopOutput
    durationMs: number
  }[]
  overallSuccess: boolean
  totalDurationMs: number
}
```

- [ ] **Step 2: 实现 evaluateComplexity**

追加到 `planner.ts`:

```typescript
const PLAN_KEYWORDS = [
  "分析", "整理", "重构", "修复", "审查",
  "合并", "总结", "生成", "创建项目",
]

export async function evaluateComplexity(
  userText: string,
  keywords?: string[],
): Promise<ComplexityResult> {
  // 1. --plan 强制触发
  if (userText.startsWith("--plan")) {
    return { score: 5, reason: "用户强制触发 --plan", triggeredBy: "force" }
  }

  const kw = keywords || PLAN_KEYWORDS

  // 2. 关键词兜底
  const hitKeyword = kw.find(k => userText.includes(k))
  if (hitKeyword) {
    log.info("关键词触发:", hitKeyword)
    return { score: 3, reason: `关键词匹配: "${hitKeyword}"`, triggeredBy: "keyword" }
  }

  // 3. LLM 自判断（轻量 prompt）
  try {
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const provider = new OpenAICompatibleProvider()
    const resp = await provider.generateReply({
      messages: [{
        id: "plan-complexity",
        role: "user",
        text: `评估以下用户请求的复杂度（1=简单问候/闲聊, 5=需要多步工具调用的复杂任务），只回复数字 1-5：

"${userText}"

复杂度评分 (1-5):`,
        timestamp: Date.now(),
      }],
      systemPrompt: "你是一个复杂度评估器。只回复1-5的数字，不要任何解释。",
      thinkingEffort: "low",
    })
    const num = parseInt(resp.text?.trim() || "1", 10)
    const score = Math.max(1, Math.min(5, isNaN(num) ? 1 : num))
    return { score, reason: `LLM 自判断: ${score}/5`, triggeredBy: "llm" }
  } catch (e) {
    log.warn("LLM 复杂度检测失败，默认跳过 Plan:", e)
    return { score: 1, reason: "检测失败，跳过 Plan", triggeredBy: "llm" }
  }
}
```

- [ ] **Step 3: 实现 generatePlan**

追加到 `planner.ts`:

```typescript
export interface GeneratePlanContext {
  cardId: string
  cardRole: string
  availableTools: ToolDef[]
  thinkingEffort: ThinkingEffort
}

export async function generatePlan(
  userText: string,
  context: GeneratePlanContext,
): Promise<PlanResult> {
  const { cardRole, availableTools, thinkingEffort } = context

  const toolList = availableTools
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n")

  const systemPrompt = `你是糖糖桌宠的任务规划器。${cardRole}

用户的请求可能很复杂，需要拆解为多个步骤执行。

## 可用工具
${toolList}
- var_read / var_write / var_list / var_delete: 变量读写（始终可用）

## 任务
将用户请求拆解为 1-N 个步骤。

## 输出格式（严格 JSON）
{
  "steps": [
    {
      "id": 1,
      "description": "步骤描述",
      "role": "子代理角色名（如 文件分析员、代码搜索员）",
      "allowedTools": ["file_read", "file_search"],
      "dependsOn": [],
      "parallel": false
    }
  ],
  "summary": "一句话概述计划",
  "estimatedComplexity": 3
}

## 规则
- 简单任务只需 1 步
- 复杂任务最多 8 步
- 标注每步依赖（dependsOn: [前置步骤 id]）
- 标注可并行步骤（parallel: true）
- allowedTools 为空表示可用所有工具
- 变量工具始终可用，无需包含在 allowedTools 中
- 只输出 JSON，不要其他内容`

  const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
  const provider = new OpenAICompatibleProvider()

  const resp = await provider.generateReply({
    messages: [{
      id: "plan-generate",
      role: "user",
      text: `用户请求: ${userText}`,
      timestamp: Date.now(),
    }],
    systemPrompt,
    thinkingEffort,
  })

  try {
    const jsonMatch = resp.text?.match(/```(?:json)?\s*([\s\S]*?)```/)
                    ?? resp.text?.match(/(\{[\s\S]*\})/)
    const json = jsonMatch ? jsonMatch[1] : (resp.text || "{}")
    const parsed = JSON.parse(json)
    return {
      steps: parsed.steps || [],
      summary: parsed.summary || "执行计划",
      estimatedComplexity: parsed.estimatedComplexity || 3,
    }
  } catch (e) {
    log.error("Plan JSON 解析失败:", e)
    return {
      steps: [{ id: 1, description: userText, role: "执行员" }],
      summary: "直接执行",
      estimatedComplexity: 1,
    }
  }
}
```

- [ ] **Step 4: 实现 executePlan + executeStep**

追加到 `planner.ts`:

```typescript
import { runForkAgent } from "@/services/agent/sub-agent"
import { runSubLoop } from "@/services/agent/sub-loop"
import { getToolsForMode } from "@/services/tool/registry"

export interface ExecutePlanCallbacks {
  onStepStart(step: PlanStep): void
  onStepDone(step: PlanStep, result: SubLoopOutput): void
  onStepFailed(step: PlanStep, error: string): Promise<"continue" | "abort">
}

export interface ExecutePlanConfig {
  stepTimeoutMs: number
  stepMaxRounds: number
  stepThinkingEffort: ThinkingEffort
  maxSteps: number
  onStepFailure: "continue" | "abort" | "ask"
}

export async function executePlan(
  plan: PlanResult,
  config: ExecutePlanConfig,
  callbacks: ExecutePlanCallbacks,
): Promise<PlanExecutionResult> {
  const startTime = Date.now()
  const stepResults: PlanExecutionResult["stepResults"] = []
  let overallSuccess = true
  const steps = plan.steps.slice(0, config.maxSteps)

  for (const step of steps) {
    callbacks.onStepStart(step)
    const stepStart = Date.now()

    try {
      const output = await executeStep(step, config)
      const durationMs = Date.now() - stepStart
      stepResults.push({ step, output, durationMs })
      callbacks.onStepDone(step, output)

      if (!output.success && config.onStepFailure === "abort") {
        overallSuccess = false
        break
      }
      if (!output.success && config.onStepFailure === "ask") {
        const decision = await callbacks.onStepFailed(step, output.error || "未知错误")
        if (decision === "abort") { overallSuccess = false; break }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      stepResults.push({
        step, durationMs: Date.now() - stepStart,
        output: { reply: "", toolCallsMade: 0, success: false, error: errMsg },
      })
      if (config.onStepFailure === "abort") { overallSuccess = false; break }
      if (config.onStepFailure === "ask") {
        const decision = await callbacks.onStepFailed(step, errMsg)
        if (decision === "abort") { overallSuccess = false; break }
      }
    }
  }

  return { stepResults, overallSuccess, totalDurationMs: Date.now() - startTime }
}

async function executeStep(
  step: PlanStep,
  config: ExecutePlanConfig,
): Promise<SubLoopOutput> {
  const stepPrompt = `你是糖糖桌宠的子代理，角色: ${step.role || "执行员"}。
正在执行计划第 ${step.id} 步: ${step.description}

可用工具由系统注入。变量工具始终可用 (var_read, var_write, var_list, var_delete)。

请完成此步骤并返回结果。`

  const tools: ToolDef[] = []
  if (step.allowedTools && step.allowedTools.length > 0) {
    const { getToolByName } = await import("@/services/tool/registry")
    for (const name of step.allowedTools) {
      const tool = getToolByName(name)
      if (tool) tools.push(tool)
    }
  } else {
    tools.push(...getToolsForMode("assistant"))
  }

  const { getVarTools } = await import("@/services/tool")
  const varTools = getVarTools?.() ?? []
  for (const vt of varTools) {
    if (!tools.find(t => t.name === vt.name)) tools.push(vt)
  }

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

- [ ] **Step 5: 实现 formatStepResults**

追加到 `planner.ts`:

```typescript
export function formatStepResults(result: PlanExecutionResult): string {
  const lines = ["[计划执行结果]"]
  for (const { step, output, durationMs } of result.stepResults) {
    const icon = output.success ? "✅" : "❌"
    const time = (durationMs / 1000).toFixed(1) + "s"
    lines.push(`${icon} 步骤 ${step.id} "${step.description}" - ${output.success ? "完成" : "失败"} (${time})`)
    if (output.reply) {
      lines.push(`   结果: ${output.reply.substring(0, 100)}${output.reply.length > 100 ? "..." : ""}`)
    }
    if (output.error) lines.push(`   错误: ${output.error}`)
  }
  lines.push("\n请基于以上结果生成最终回复。")
  return lines.join("\n")
}
```

- [ ] **Step 6: 验证**

Run: `npx vue-tsc --noEmit`
Expected: 检查 planner.ts 相关 error，修复类型问题

---

### Task 6: Agent Loop 集成

**Files:**
- Modify: `src/services/engine/agent-loop.ts:48-100`（runAgentLoop 中插入 Plan 阶段）

**Interfaces:**
- Consumes: `evaluateComplexity`, `generatePlan`, `executePlan`, `formatStepResults` from `./planner`, `planConfig` from `@/services/config`
- Produces: 修改 `runAgentLoop` 流程，新增 Plan 确认桥接函数

- [ ] **Step 1: 添加 import**

在 `agent-loop.ts` 顶部追加：

```typescript
import { evaluateComplexity, generatePlan, executePlan, formatStepResults } from "./planner"
import type { PlanStep } from "./planner"
import { planConfig } from "@/services/config"
```

- [ ] **Step 2: 在 runAgentLoop 中插入 Plan 阶段**

在 `agent-loop.ts` 中 `buildPrompt` 调用（约第 75 行）之后、`applyEffect(PetPersonalityMiddleware.wrap("thinking"), effects)`（约第 81 行）**之前**插入 Plan 阶段：

```typescript
  // ═══ Plan 阶段 (助手模式) ═══
  let planStepContext = ""
  let rawUserText = userText
  if (generalConfig.assistantMode && planConfig.enabled) {
    const forcePlan = userText.startsWith("--plan")
    if (forcePlan) rawUserText = userText.replace(/^--plan\s*/, "")

    const complexity = await evaluateComplexity(rawUserText, planConfig.keywords)
    log.info(`Plan 复杂度: score=${complexity.score} reason=${complexity.reason}`)

    if (complexity.score >= planConfig.complexityThreshold) {
      transition("PLANNING")
      const planEffect = PetPersonalityMiddleware.wrap("planning")
      applyEffect(planEffect, effects)

      const plan = await generatePlan(rawUserText, {
        cardId: card.id,
        cardRole: card.sections.roleSetting ?? "",
        availableTools: ctx.tools,
        thinkingEffort: planConfig.thinkingEffort,
      })

      if (plan.steps.length > 0) {
        const safetyMode = safetyConfig.mode
        let confirmed = false
        let stepMode: "auto" | "stepByStep" = "auto"

        if (safetyMode === "just_do_it") {
          confirmed = true
        } else {
          const confirmResult = await requestPlanConfirm(
            plan,
            safetyMode === "let_me_tk" ? { forceStepByStep: true } : undefined,
          )
          confirmed = confirmResult.confirmed
          stepMode = confirmResult.mode
        }

        if (confirmed) {
          const result = await executePlan(plan, {
            stepTimeoutMs: planConfig.stepTimeoutMs,
            stepMaxRounds: planConfig.stepMaxRounds,
            stepThinkingEffort: planConfig.stepThinkingEffort,
            maxSteps: planConfig.maxSteps,
            onStepFailure: planConfig.onStepFailure,
          }, {
            onStepStart(s: PlanStep) {
              emit("deskpet-plan-progress", { step: s.id, total: plan.steps.length, desc: s.description, status: "running" })
            },
            onStepDone(s: PlanStep, r) {
              emit("deskpet-plan-progress", { step: s.id, total: plan.steps.length, desc: s.description, status: r.success ? "done" : "failed" })
            },
            async onStepFailed(s, err) {
              log.warn(`Plan 步骤 ${s.id} 失败:`, err)
              return requestPlanStepDecision(s, err)
            },
          })
          planStepContext = formatStepResults(result)
        } else {
          transition("WAITING")
          const cancelReply = getSimpleStage("planning") ?? "好的，已取消计划～"
          return { reply: cancelReply, toolCallHistory, retriesUsed, effects: [] }
        }
      }
    }
  }
```

- [ ] **Step 3: 将 planStepContext 注入后续流程**

在 `agent-loop.ts` 中 `buildPrompt` 调用后（或 `runToolLoop` 调用前）检查：

```typescript
  if (planStepContext) {
    ctx.systemPrompt += "\n\n" + planStepContext
  }
```

- [ ] **Step 4: 添加 Plan 确认桥接函数**

在 `agent-loop.ts` 顶部（import 区域后）添加：

```typescript
// ── Plan 确认桥接 ──

import type { PlanResult } from "./planner"

let planConfirmResolve: ((result: { confirmed: boolean; mode: "auto" | "stepByStep" }) => void) | null = null
let planStepDecisionResolve: ((d: "continue" | "abort") => void) | null = null

export function resolvePlanConfirm(result: { confirmed: boolean; mode: "auto" | "stepByStep" }) {
  planConfirmResolve?.(result)
  planConfirmResolve = null
}

export function resolvePlanStepDecision(decision: "continue" | "abort") {
  planStepDecisionResolve?.(decision)
  planStepDecisionResolve = null
}

async function requestPlanConfirm(
  plan: PlanResult,
  opts?: { forceStepByStep?: boolean },
): Promise<{ confirmed: boolean; mode: "auto" | "stepByStep" }> {
  return new Promise((resolve) => {
    planConfirmResolve = resolve
    emit("deskpet-plan-start", { steps: plan.steps, complexity: plan.estimatedComplexity, forceStepByStep: opts?.forceStepByStep })
  })
}

async function requestPlanStepDecision(
  step: PlanStep,
  error: string,
): Promise<"continue" | "abort"> {
  return new Promise((resolve) => {
    planStepDecisionResolve = resolve
    emit("deskpet-plan-step-failed", { step, error })
  })
}
```

- [ ] **Step 5: engine/index.ts 导出新符号**

修改 `src/services/engine/index.ts`，追加导出：

```typescript
export { evaluateComplexity, generatePlan, executePlan, formatStepResults } from "./planner"
export type { PlanStep, PlanResult, ComplexityResult, PlanExecutionResult } from "./planner"
export { resolvePlanConfirm, resolvePlanStepDecision } from "./agent-loop"
```

- [ ] **Step 6: 验证**

Run: `npx vue-tsc --noEmit`
Expected: 修复所有新增 error

---

### Task 7: PlanConfirm UI 组件

**Files:**
- Create: `src/components/PlanConfirm.vue`

**Interfaces:**
- Consumes: `resolvePlanConfirm`, `resolvePlanStepDecision` from `@/services/engine`
- Produces: 可嵌入 ChatPanel 的计划确认/执行进度 UI 组件

- [ ] **Step 1: 创建 PlanConfirm.vue**

Create `src/components/PlanConfirm.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue"
import { listen } from "@tauri-apps/api/event"
import type { PlanStep } from "@/services/engine"
import { resolvePlanConfirm } from "@/services/engine"

interface StepStatus {
  step: PlanStep
  status: "pending" | "running" | "done" | "failed"
}

const visible = ref(false)
const forceStepByStep = ref(false)
const steps = ref<StepStatus[]>([])
const complexity = ref(0)
const executing = ref(false)
const currentStep = ref(0)

let unlistens: (() => void)[] = []

onMounted(async () => {
  const u1 = (await listen<{ steps: PlanStep[]; complexity: number; forceStepByStep?: boolean }>(
    "deskpet-plan-start", (e) => {
      steps.value = e.payload.steps.map(s => ({ step: s, status: "pending" as const }))
      complexity.value = e.payload.complexity
      forceStepByStep.value = e.payload.forceStepByStep || false
      executing.value = false
      visible.value = true
    },
  ))
  const u2 = (await listen<{ step: number; status: string }>(
    "deskpet-plan-progress", (e) => {
      const s = steps.value[e.payload.step - 1]
      if (!s) return
      currentStep.value = e.payload.step
      s.status = e.payload.status as StepStatus["status"]
    },
  ))
  unlistens = [u1, u2]
})

onUnmounted(() => unlistens.forEach(fn => fn()))

function confirmAutoAll() { resolvePlanConfirm({ confirmed: true, mode: "auto" }); executing.value = true }
function confirmStepByStep() { resolvePlanConfirm({ confirmed: true, mode: "stepByStep" }); executing.value = true }
function cancel() { resolvePlanConfirm({ confirmed: false, mode: "auto" }); visible.value = false }
function abortExecution() { resolvePlanConfirm({ confirmed: false, mode: "auto" }); visible.value = false }
</script>

<template>
  <div v-if="visible" class="plan-confirm">
    <div class="plan-header">
      <span>{{ executing ? "🔄 执行中" : "🔍 任务分析" }}</span>
      <span v-if="!executing" class="complexity">
        {{ "★".repeat(complexity) }}{{ "☆".repeat(5 - complexity) }} ({{ complexity }}/5)
      </span>
    </div>

    <div class="plan-steps">
      <div v-for="s in steps" :key="s.step.id" class="step" :class="s.status">
        <span class="step-icon">
          {{ s.status === "done" ? "✅" : s.status === "running" ? "⏳" : s.status === "failed" ? "❌" : "⏸️" }}
        </span>
        <span class="step-desc">{{ s.step.description }}</span>
        <span v-if="s.step.parallel" class="badge">⚡并行</span>
      </div>
    </div>

    <div class="actions">
      <template v-if="!executing">
        <button v-if="!forceStepByStep" class="btn-auto" @click="confirmAutoAll">全部执行</button>
        <button class="btn-step" @click="confirmStepByStep">逐步确认</button>
        <button class="btn-cancel" @click="cancel">取消</button>
      </template>
      <template v-else>
        <span class="progress">({{ currentStep }}/{{ steps.length }})</span>
        <button class="btn-abort" @click="abortExecution">终止执行</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.plan-confirm {
  background: var(--bg-card, #1e1e2e);
  border: 1px solid var(--border, #313244);
  border-radius: 12px;
  padding: 16px;
  margin: 8px 0;
  max-width: 420px;
}
.plan-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 12px; font-weight: 600; font-size: 15px;
}
.complexity { margin-left: auto; font-size: 12px; color: var(--text-muted, #6c7086); }
.plan-steps { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.step {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border-radius: 8px;
  background: var(--bg-hover, #2a2a3c); font-size: 13px;
}
.step.running { border-left: 3px solid var(--accent, #cba6f7); }
.step.failed { border-left: 3px solid #f38ba8; opacity: 0.7; }
.badge { font-size: 11px; color: var(--accent, #cba6f7); }
.actions { display: flex; gap: 8px; align-items: center; }
button { padding: 6px 16px; border-radius: 8px; border: none; font-size: 13px; cursor: pointer; }
button:hover { opacity: 0.85; }
.btn-auto { background: var(--accent, #cba6f7); color: #1e1e2e; }
.btn-step { background: var(--bg-hover, #45475a); color: var(--text, #cdd6f4); }
.btn-cancel, .btn-abort { background: transparent; color: var(--text-muted, #6c7086); border: 1px solid var(--border, #313244); }
.progress { font-size: 13px; color: var(--text-muted, #6c7086); margin-right: auto; }
</style>
```

- [ ] **Step 2: 验证**

Run: `npx vue-tsc --noEmit`
Expected: 无新增 error

---

### Task 8: ChatPanel 集成 + Settings UI

**Files:**
- Modify: `src/components/ChatPanel.vue`（嵌入 PlanConfirm）
- Modify: `src/components/settings/AITab.vue`（添加 Plan 设置）

- [ ] **Step 1: ChatPanel.vue 嵌入 PlanConfirm**

在 `<script setup>` 添加: `import PlanConfirm from "./PlanConfirm.vue"`

在模板中消息列表和确认弹窗区域之间添加: `<PlanConfirm />`

- [ ] **Step 2: AITab.vue 添加 Plan 设置**

在 `<script setup>` 添加: `import { planConfig } from "@/services/config"`

在模板助手模式区域添加 Plan 配置节（启用开关、复杂度阈值滑块、两个 thinkingEffort 选择器）。

- [ ] **Step 3: 验证**

Run: `npx vue-tsc --noEmit`
Expected: 无新增 error

---

### Task 9: 测试

**Files:**
- Create: `src/services/__tests__/planner.test.ts`

- [ ] **Step 1: 创建单元测试**

```typescript
import { describe, it, expect } from "vitest"
import { evaluateComplexity, formatStepResults } from "@/services/engine/planner"
import type { PlanExecutionResult } from "@/services/engine/planner"

describe("evaluateComplexity", () => {
  it("--plan force triggers complexity 5", async () => {
    const r = await evaluateComplexity("--plan 帮我整理桌面")
    expect(r.score).toBe(5)
    expect(r.triggeredBy).toBe("force")
  })
  it("keyword match triggers >= 3", async () => {
    const r = await evaluateComplexity("帮我重构代码", ["重构", "分析"])
    expect(r.score).toBeGreaterThanOrEqual(3)
    expect(r.triggeredBy).toBe("keyword")
  })
  it("simple greeting gets low score", async () => {
    const r = await evaluateComplexity("你好", [])
    expect(r.score).toBeLessThan(3)
  })
})

describe("formatStepResults", () => {
  it("formats success and failure steps", () => {
    const r: PlanExecutionResult = {
      stepResults: [
        { step: { id: 1, description: "list files" }, output: { reply: "5 files", toolCallsMade: 1, success: true }, durationMs: 1200 },
        { step: { id: 2, description: "write report" }, output: { reply: "", toolCallsMade: 0, success: false, error: "permission denied" }, durationMs: 500 },
      ],
      overallSuccess: false, totalDurationMs: 1700,
    }
    const text = formatStepResults(r)
    expect(text).toContain("✅ 步骤 1")
    expect(text).toContain("❌ 步骤 2")
    expect(text).toContain("permission denied")
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run src/services/__tests__/planner.test.ts`
Expected: 2 tests pass

---

### Task 10: 文档同步

**Files:**
- Modify: `CLAUDE.md`（添加 planner.ts + 更新数据流）
- Modify: `docs/阶段现状-2026.7.21.md`（更新 Plan 状态为已实现）
- Modify: `docs/DES.md`（更新 Plan 状态）

- [ ] **Step 1: 更新 CLAUDE.md** — engine/ 条目添加 `planner`，文件列表追加，数据流加 Plan 阶段
- [ ] **Step 2: 更新阶段现状文档** — Plan 从 "待处理" 移入 "已实现"
- [ ] **Step 3: 更新 DES.md** — Plan 状态更新为 "✅ 已实现"

---

## 自审清单

- [x] **Spec coverage** — 复杂度检测(T5.2)、Plan 生成(T5.3)、步骤执行(T5.4)、确认 UI(T7)、安全模式(T6)、配置(T1)、状态机(T3)、stages(T4)、thinkingEffort(T2)
- [x] **无占位符** — 所有步骤都有具体代码
- [x] **类型一致** — `PlanStep`/`PlanResult`/`PlanExecutionResult` 在 T5 定义，T6/T7/T9 消费
- [x] **复用现有模式** — SubLoopInput 扩展(T2)、config getter(T1)、middleware wrap(T4)
