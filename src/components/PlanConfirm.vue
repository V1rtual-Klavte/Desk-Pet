<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue"
import { listen } from "@tauri-apps/api/event"
import type { PlanStep } from "@/services/engine"
import { abortRunningPlan, planConfirmState, resolvePlanConfirm, resolvePlanStepDecision } from "@/services/engine"
import { getActiveSessionId } from "@/services/session/store"
import { reportError } from "@/services/error"

interface StepStatus {
  step: PlanStep
  status: "pending" | "running" | "done" | "failed"
}

/** 四个计划事件的公共身份段（PLAN-04）：面板只消费当前活跃会话的载荷。 */
interface PlanEventIdentity { sessionId: string; planId: string }

const visible = ref(false)
const forceStepByStep = ref(false)
const steps = ref<StepStatus[]>([])
const complexity = ref(0)
const executing = ref(false)
const currentStep = ref(0)
/** 面板当前展示的计划身份：确认与终止都按它转发，不跨会话误操作。 */
const planId = ref("")
const sessionId = ref("")

const activeId = computed(() => getActiveSessionId())
/** 该计划是否仍有待确认的确认（渲染门）：会话切换会取消旧确认，取消后按钮不得再出现。 */
const pendingHere = computed(() => planConfirmState.pending?.planId === planId.value)
/** 确认态需要活着的确认；执行态只需要面板自己知道在跑（plan-confirm 域的执行期登记在模块里）。 */
const showPanel = computed(() => visible.value && sessionId.value === activeId.value && (executing.value || pendingHere.value))

let unlistens: (() => void)[] = []

onMounted(async () => {
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
          visible.value = true
        },
      ),
      listen<PlanEventIdentity & { step: number; status: string }>(
        "deskpet-plan-progress", (e) => {
          if (e.payload.sessionId !== getActiveSessionId() || e.payload.planId !== planId.value) return
          const s = steps.value[e.payload.step - 1]
          if (!s) return
          currentStep.value = e.payload.step
          s.status = e.payload.status as StepStatus["status"]
        },
      ),
      listen<PlanEventIdentity & { step: PlanStep; error: string }>(
        "deskpet-plan-step-failed", (e) => {
          if (e.payload.sessionId !== getActiveSessionId() || e.payload.planId !== planId.value) return
          const s = steps.value.find(x => x.step.id === e.payload.step.id)
          if (s) s.status = "failed"
          // Auto-continue to avoid blocking the loop indefinitely
          resolvePlanStepDecision(e.payload.planId, "continue")
        },
      ),
      listen<{ sessionId: string; reason: string }>("deskpet-plan-end", (e) => {
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

onUnmounted(() => unlistens.forEach(fn => fn()))

function confirmAutoAll() { if (planId.value) resolvePlanConfirm(planId.value, { confirmed: true, mode: "auto" }); executing.value = true }
function confirmStepByStep() { if (planId.value) resolvePlanConfirm(planId.value, { confirmed: true, mode: "stepByStep" }); executing.value = true }
function cancel() { if (planId.value) resolvePlanConfirm(planId.value, { confirmed: false, reason: "user" }); visible.value = false }
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
.actions { display: flex; gap: 6px; align-items: center; }
button { padding: 4px 12px; border-radius: 6px; border: none; font-size: 11px; cursor: pointer; font-family: inherit; }
button:hover { opacity: 0.85; }
.btn-auto { background: var(--color-accent, #cba6f7); color: var(--color-tab-active-text, #1e1e2e); }
.btn-step { background: var(--color-surface-dark, #45475a); color: var(--color-text-bright, #cdd6f4); border: 1px solid var(--color-border-light, #313244); }
.btn-cancel, .btn-abort { background: transparent; color: var(--color-text-muted, #6c7086); border: 1px solid var(--color-border-light, #313244); }
.progress { font-size: 11px; color: var(--color-text-muted, #6c7086); margin-right: auto; }
</style>
