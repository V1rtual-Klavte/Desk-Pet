<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from "vue"
import { listen } from "@tauri-apps/api/event"
import type { PlanStep, PlanStepState, RecoveredPlanView } from "@/services/engine"
import { abortRunningPlan, discardPlan, listRecoveredPlans, planConfirmState, resolvePlanConfirm, resolvePlanStepDecision, resumePlan } from "@/services/engine"
import { planCheckpointStore } from "@/services/agent/memory"
import { getActiveSessionId } from "@/services/session/store"
import { reportError } from "@/services/error"
import { createLogger } from "@/services/logger"

const log = createLogger("PlanConfirm")

interface StepStatus {
  step: PlanStep
  status: "pending" | "running" | "done" | "failed"
}

/** 四个计划事件的公共身份段（PLAN-04）：面板只消费当前活跃会话的载荷。 */
interface PlanEventIdentity { sessionId: string; planId: string }

/** 待处置计划的步骤展示（恢复视图）：`unknown_side_effect` 是唯一需要用户逐个处置的状态。 */
const RECOVERED_STEP_VIEW: Record<PlanStepState, { icon: string; label: string }> = {
  pending: { icon: "--", label: "待执行" },
  running: { icon: "..", label: "待重跑" },
  done: { icon: "OK", label: "已完成" },
  failed: { icon: "XX", label: "失败" },
  skipped: { icon: "--", label: "已跳过" },
  interrupted: { icon: "..", label: "已中断" },
  unknown_side_effect: { icon: "??", label: "未知副作用" },
}

const visible = ref(false)
const forceStepByStep = ref(false)
const steps = ref<StepStatus[]>([])
const complexity = ref(0)
const executing = ref(false)
const currentStep = ref(0)
/** 进度分母取事件里的 `total`（执行列表截断后的步数），不按面板收到的步骤数自算。 */
const total = ref(0)
/** 面板当前展示的计划身份：确认与终止都按它转发，不跨会话误操作。 */
const planId = ref("")
const sessionId = ref("")
/** 待处置计划（paused / interrupted）：只读视图，真相源在 planCheckpointStore。 */
const recovered = ref<RecoveredPlanView[]>([])
/** 处置请求在飞时按钮禁用：重复点「继续/丢弃」不产生第二次执行。 */
const recoverBusy = ref(false)

const activeId = computed(() => getActiveSessionId())
/** 该计划是否仍有待确认的确认（渲染门）：会话切换会取消旧确认，取消后按钮不得再出现。 */
const pendingHere = computed(() => planConfirmState.pending?.planId === planId.value)
/** 待裁决的步骤门（逐步门/失败询问）：会话与计划都对上才呈现；真相源在确认域，面板不另存一份。 */
const gateHere = computed(() => {
  const gate = planConfirmState.stepGate
  if (!gate || gate.sessionId !== activeId.value || gate.planId !== planId.value) return null
  return gate
})
/** 确认态需要活着的确认；执行态只需要面板自己知道在跑（plan-confirm 域的执行期登记在模块里）。 */
const showPanel = computed(() => visible.value && sessionId.value === activeId.value && (executing.value || pendingHere.value))
/** 恢复条上的动作在飞或该会话的计划正在执行时一律禁用。 */
const recoverDisabled = computed(() => recoverBusy.value || executing.value)

let unlistens: (() => void)[] = []

/** 读当前会话的待处置计划：面板只渲染这份只读视图，不另存计划状态。 */
function refreshRecovered(): void {
  const activeSession = getActiveSessionId()
  try {
    // 没有活跃会话就没有可处置的对象（也不该把别的会话的计划摆出来）
    recovered.value = activeSession ? listRecoveredPlans(activeSession) : []
  } catch (error) {
    // 读不到清单不该拖垮面板：报告后按空清单收起，不摆出按不了或按错的按钮
    reportError("PlanConfirm", error, { kind: "待处置计划读取失败", overlay: false })
    recovered.value = []
  }
}

onMounted(async () => {
  refreshRecovered()
  try {
    // 四个监听要么一起成功要么一起失败：注册失败 = 确认永远等不到答复（§4.1），
    // 由下面的 catch 立即结算，不能让计划段悬挂。
    const [u1, u2, u3, u4] = await Promise.all([
      listen<PlanEventIdentity & { steps: PlanStep[]; complexity: number; forceStepByStep?: boolean }>(
        "deskpet-plan-start", (e) => {
          if (e.payload.sessionId !== getActiveSessionId()) return
          planId.value = e.payload.planId
          sessionId.value = e.payload.sessionId
          steps.value = e.payload.steps.map(s => ({ step: s, status: "pending" as const }))
          complexity.value = e.payload.complexity
          forceStepByStep.value = e.payload.forceStepByStep || false
          executing.value = false
          currentStep.value = 0
          total.value = e.payload.steps.length
          visible.value = true
        },
      ),
      listen<PlanEventIdentity & { stepId: string; total: number; status: string }>(
        "deskpet-plan-progress", (e) => {
          if (e.payload.sessionId !== getActiveSessionId() || e.payload.planId !== planId.value) return
          // 按 stepId 定位：步骤 id 不由 1 起或不连续时（恢复入口只跑剩余步骤），
          // 按下标 `step - 1` 取会指到别的步骤上
          const s = steps.value.find(x => String(x.step.id) === e.payload.stepId)
          if (!s) {
            log.warn("计划进度事件找不到对应步骤", e.payload)
            return
          }
          currentStep.value = steps.value.indexOf(s) + 1
          total.value = e.payload.total
          s.status = e.payload.status as StepStatus["status"]
        },
      ),
      listen<PlanEventIdentity & { kind: "approval" | "failed"; step: PlanStep; error?: string; index: number; total: number }>(
        "deskpet-plan-step-gate", (e) => {
          if (e.payload.sessionId !== getActiveSessionId() || e.payload.planId !== planId.value) return
          const s = steps.value.find(x => x.step.id === e.payload.step.id)
          // 找不到也不能吞掉这道门：裁决按钮按 planConfirmState.stepGate 渲染，面板只记一条线索
          if (!s) log.warn("计划步骤门事件找不到对应步骤", e.payload)
          if (e.payload.kind === "failed" && s) s.status = "failed"
          // 这里不自动应答：逐步门就是要等用户在「继续 / 中止」上落定，
          // 原来在这无条件 `resolvePlanStepDecision("continue")` 的假放行已删（PLAN-05）。
        },
      ),
      listen<{ sessionId: string; reason: string }>("deskpet-plan-end", (e) => {
        // 待处置清单跟着结束事件刷新：被终止的计划重新变成「继续 / 丢弃」的一条
        refreshRecovered()
        // 结束事件不带 planId（notifyPlanEnd 的签名只有 sessionId/reason），按会话身份收：
        // 同一会话同一时刻只有一个计划，属于本会话的结束事件就是本面板该收起的信号 ——
        // 用户切走期间也照收，回来时不会看到已经结束的僵尸面板。
        if (e.payload.sessionId !== sessionId.value) return
        // 计划结束（跑完 / 失败 / 取消）都要收起面板：原先 visible 只在两个按钮里
        // 被置回 false，计划跑完之后面板会一直挂在聊天区。
        visible.value = false
        executing.value = false
      }),
    ])
    unlistens = [u1, u2, u3, u4]
  } catch (error) {
    // fail-safe：监听装不上就如实上报，并立即把待确认计划按 ui_unavailable 结算
    reportError("PlanConfirm", error, { kind: "计划面板监听注册失败", overlay: false })
    const pending = planConfirmState.pending
    if (pending) resolvePlanConfirm(pending.planId, { confirmed: false, reason: "ui_unavailable" })
  }
})

/** 切会话就重读待处置清单：上个会话的计划不能留在这一条的按钮后面。 */
watch(activeId, refreshRecovered)

/** 处置动作的统一包装：禁用重复提交、异常上报、无论成败都重读清单（真相源在 store）。 */
async function withRecoverAction(kind: string, action: () => Promise<unknown>): Promise<void> {
  if (recoverDisabled.value) return
  recoverBusy.value = true
  try {
    await action()
  } catch (error) {
    reportError("PlanConfirm", error, { kind, overlay: false })
  } finally {
    recoverBusy.value = false
    refreshRecovered()
  }
}

/** 继续：只跑剩余步骤（不重新生成、不重新确认）；拒绝与失败的系统消息由恢复入口写出。 */
function continueRecoveredPlan(planIdValue: string): void {
  void withRecoverAction("计划继续失败", () => resumePlan(getActiveSessionId(), planIdValue))
}

/** 丢弃：剩余待执行步骤作废、计划落失败并收起面板。 */
function discardRecoveredPlan(planIdValue: string): void {
  void withRecoverAction("计划丢弃失败", () => discardPlan(getActiveSessionId(), planIdValue))
}

/**
 * 未知副作用步骤的显式处置：标记为已完成（副作用确已生效）/ 重跑此步（记一次新执行尝试）。
 * 未处置的步骤不会在任何一条出口里自动重跑 —— 这是必须由用户做的选择。
 */
function resolveRecoveredStep(planIdValue: string, stepId: string, resolution: "already_applied" | "retry"): void {
  void withRecoverAction("未知副作用步骤处置失败", () => planCheckpointStore.resolveUnknownSideEffect(planIdValue, stepId, resolution))
}

onUnmounted(() => unlistens.forEach(fn => fn()))

function confirmAutoAll() { if (planId.value) resolvePlanConfirm(planId.value, { confirmed: true, mode: "auto" }); executing.value = true }
function confirmStepByStep() { if (planId.value) resolvePlanConfirm(planId.value, { confirmed: true, mode: "stepByStep" }); executing.value = true }
function cancel() { if (planId.value) resolvePlanConfirm(planId.value, { confirmed: false, reason: "user" }); visible.value = false }
/** 步骤门应答：结算后确认域会清掉 stepGate，按钮随之消失（重复点击是空操作）。 */
function decideStepGate(decision: "continue" | "abort") { if (planId.value) resolvePlanStepDecision(planId.value, decision) }
function abortExecution() {
  // 执行期终止：走真正的中断通道，按活跃会话取身份 —— 会话 A 的面板终止不了会话 B 的计划。
  // 原先这里调 resolvePlanConfirm，而确认早在「全部执行/逐步确认」时就被消费掉了，
  // resolver 已经是 null —— 按钮只把面板藏起来，计划照跑。
  if (abortRunningPlan(getActiveSessionId())) return
  // 还没进入执行（仍在确认阶段）：终止等价于取消这次计划（文案由面板承担）
  if (planId.value) resolvePlanConfirm(planId.value, { confirmed: false, reason: "user" })
  visible.value = false
}
</script>

<template>
  <div v-if="showPanel" class="plan-confirm">
    <div class="plan-header">
      <span>{{ executing ? "执行中" : "任务分析" }}</span>
      <span v-if="!executing" class="complexity">
        {{ "★".repeat(complexity) }}{{ "☆".repeat(5 - complexity) }} ({{ complexity }}/5)
      </span>
    </div>

    <div class="plan-steps">
      <div v-for="s in steps" :key="s.step.id" class="step" :class="s.status">
        <span class="step-icon">
          {{ s.status === "done" ? "OK" : s.status === "running" ? ".." : s.status === "failed" ? "XX" : "--" }}
        </span>
        <span class="step-desc">{{ s.step.description }}</span>
        <span v-if="s.status === 'failed'" class="step-error-msg">失败</span>
      </div>
    </div>

    <div v-if="gateHere" class="gate-hint" :class="gateHere.kind">
      {{ gateHere.kind === "failed" ? `步骤失败：${gateHere.error ?? "未知错误"}` : `下一步：${gateHere.step.description}` }}
    </div>

    <div class="actions">
      <template v-if="!executing">
        <button v-if="!forceStepByStep" class="btn-auto" @click="confirmAutoAll">全部执行</button>
        <button class="btn-step" @click="confirmStepByStep">逐步确认</button>
        <button class="btn-cancel" @click="cancel">取消</button>
      </template>
      <template v-else>
        <span class="progress">({{ currentStep }}/{{ total }})</span>
        <template v-if="gateHere">
          <button class="btn-auto" @click="decideStepGate('continue')">
            {{ gateHere.kind === "failed" ? "继续" : "执行下一步" }}
          </button>
          <button class="btn-abort" @click="decideStepGate('abort')">中止</button>
        </template>
        <button v-else class="btn-abort" @click="abortExecution">终止执行</button>
      </template>
    </div>
  </div>

  <!-- 恢复待处置条（T2.08）：paused / interrupted 计划的两条出口，与 #ch-interrupted 同款决策条 -->
  <div v-if="recovered.length" id="ch-plans" class="plan-recover">
    <div v-for="plan in recovered" :key="plan.planId" class="recover-plan">
      <div class="recover-head">
        上次的计划还没跑完：{{ plan.summary }}。继续只跑剩下的步骤，未知副作用步骤不会自动重跑 —— 需要你先标记或选择重跑。
      </div>

      <div class="plan-steps">
        <div v-for="step in plan.steps" :key="step.stepId" class="step" :class="step.state">
          <span class="step-icon">{{ RECOVERED_STEP_VIEW[step.state].icon }}</span>
          <span class="step-desc">{{ step.title }}</span>
          <span class="step-state">{{ RECOVERED_STEP_VIEW[step.state].label }}</span>
          <template v-if="step.state === 'unknown_side_effect'">
            <button class="btn-step" :disabled="recoverDisabled" @click="resolveRecoveredStep(plan.planId, step.stepId, 'already_applied')">标记为已完成</button>
            <button class="btn-abort" :disabled="recoverDisabled" @click="resolveRecoveredStep(plan.planId, step.stepId, 'retry')">重跑此步</button>
          </template>
        </div>
      </div>

      <div class="actions">
        <button class="btn-auto" :disabled="recoverDisabled" @click="continueRecoveredPlan(plan.planId)">继续</button>
        <button class="btn-cancel" :disabled="recoverDisabled" @click="discardRecoveredPlan(plan.planId)">丢弃</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-confirm {
  background: var(--color-surface-darker, #1e1e2e);
  border: 1px solid var(--color-border-light, #313244);
  border-radius: 12px;
  padding: 12px;
  margin: 6px 8px;
  max-width: 420px;
  font-size: 11px;
}
.plan-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 10px; font-weight: 600; font-size: 13px;
  color: var(--color-text-bright, #cdd6f4);
}
.complexity { margin-left: auto; font-size: 10px; color: var(--color-text-muted, #6c7086); }
.plan-steps { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.step {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: 6px;
  background: var(--color-surface-dark, #2a2a3c); font-size: 11px;
  color: var(--color-text-bright, #cdd6f4);
}
.step.running { border-left: 3px solid var(--color-accent, #cba6f7); }
.step.failed { border-left: 3px solid #f38ba8; opacity: 0.7; }
.step.done { opacity: 0.7; }
.step-icon { font-size: 10px; font-family: var(--font-mono, monospace); min-width: 18px; color: var(--color-text-muted, #6c7086); }
.step-error-msg { font-size: 9px; color: #f38ba8; margin-left: auto; }
.step-desc { flex: 1; }
.gate-hint { margin-bottom: 8px; font-size: 10px; color: var(--color-text-muted, #6c7086); }
.gate-hint.failed { color: #f9e2af; }
.actions { display: flex; gap: 6px; align-items: center; }
button { padding: 4px 12px; border-radius: 6px; border: none; font-size: 11px; cursor: pointer; font-family: inherit; }
button:hover { opacity: 0.85; }
button:disabled { opacity: 0.45; cursor: default; }
.plan-recover {
  background: var(--color-surface-darker, #1e1e2e);
  border: 1px solid var(--color-border-light, #313244);
  border-radius: 12px;
  padding: 12px;
  margin: 6px 8px;
  max-width: 420px;
  font-size: 11px;
}
.recover-plan + .recover-plan { margin-top: 10px; border-top: 1px solid var(--color-border-light, #313244); padding-top: 10px; }
.recover-head { margin-bottom: 10px; font-size: 10px; line-height: 1.5; color: var(--color-text-bright, #cdd6f4); }
.step.unknown_side_effect { border-left: 3px solid #f9e2af; }
.step.interrupted { border-left: 3px solid #f38ba8; opacity: 0.7; }
.step-state { font-size: 9px; color: var(--color-text-muted, #6c7086); flex: 0 0 auto; }
.btn-auto { background: var(--color-accent, #cba6f7); color: var(--color-tab-active-text, #1e1e2e); }
.btn-step { background: var(--color-surface-dark, #45475a); color: var(--color-text-bright, #cdd6f4); border: 1px solid var(--color-border-light, #313244); }
.btn-cancel, .btn-abort { background: transparent; color: var(--color-text-muted, #6c7086); border: 1px solid var(--color-border-light, #313244); }
.progress { font-size: 11px; color: var(--color-text-muted, #6c7086); margin-right: auto; }
</style>
