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
  const u1 = await listen<{ steps: PlanStep[]; complexity: number; forceStepByStep?: boolean }>(
    "deskpet-plan-start", (e) => {
      steps.value = e.payload.steps.map(s => ({ step: s, status: "pending" as const }))
      complexity.value = e.payload.complexity
      forceStepByStep.value = e.payload.forceStepByStep || false
      executing.value = false
      visible.value = true
    },
  )
  const u2 = await listen<{ step: number; status: string }>(
    "deskpet-plan-progress", (e) => {
      const s = steps.value[e.payload.step - 1]
      if (!s) return
      currentStep.value = e.payload.step
      s.status = e.payload.status as StepStatus["status"]
    },
  )
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
        <span v-if="s.step.parallel" class="badge">并行</span>
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
.step-desc { flex: 1; }
.badge { font-size: 9px; color: var(--color-accent, #cba6f7); background: var(--color-accent-shadow, rgba(203,166,247,0.15)); padding: 0 4px; border-radius: 3px; }
.actions { display: flex; gap: 6px; align-items: center; }
button { padding: 4px 12px; border-radius: 6px; border: none; font-size: 11px; cursor: pointer; font-family: inherit; }
button:hover { opacity: 0.85; }
.btn-auto { background: var(--color-accent, #cba6f7); color: var(--color-tab-active-text, #1e1e2e); }
.btn-step { background: var(--color-surface-dark, #45475a); color: var(--color-text-bright, #cdd6f4); border: 1px solid var(--color-border-light, #313244); }
.btn-cancel, .btn-abort { background: transparent; color: var(--color-text-muted, #6c7086); border: 1px solid var(--color-border-light, #313244); }
.progress { font-size: 11px; color: var(--color-text-muted, #6c7086); margin-right: auto; }
</style>
