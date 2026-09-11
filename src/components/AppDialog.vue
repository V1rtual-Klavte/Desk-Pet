<script setup lang="ts">
// ==========================================
// 通用提示 Dialog —— 渲染 services/dialog 的 pending 请求
// 在 SettingsPanel / App 里各挂一次即可
// ==========================================
import { computed, ref, watch, onMounted, onUnmounted } from "vue"
import { dialogState, closeDialog, resolveConfirm } from "@/services/dialog"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Dialog")

const copied = ref(false)

const pending = computed(() => dialogState.pending)
const icon = computed(() => {
  switch (pending.value?.kind) {
    case "success": return "✓"
    case "error": return "⚠"
    default: return "ℹ"
  }
})

// 每次换内容都重置「已复制」状态
watch(() => pending.value?.id, () => { copied.value = false })

async function copyDetail(): Promise<void> {
  const text = pending.value?.copyText
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
  } catch (e) {
    log.warn("复制到剪贴板失败", formatError(e))
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && pending.value) closeDialog()
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onUnmounted(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <Transition name="dlg-fade">
    <div v-if="pending" class="dlg-overlay" @click.self="closeDialog()">
      <div class="dlg-card" :class="`dlg-${pending.kind}`">
        <div class="dlg-head">
          <span class="dlg-icon">{{ icon }}</span>
          <span class="dlg-title">{{ pending.title }}</span>
        </div>

        <div class="dlg-msg">{{ pending.message }}</div>

        <div v-if="pending.detail" class="dlg-detail" @click="copyDetail()">{{ pending.detail }}</div>

        <div class="dlg-actions">
          <template v-if="pending.confirm">
            <button class="dlg-btn" @click="resolveConfirm(false)">取消</button>
            <button
              class="dlg-btn"
              :class="pending.confirm.danger ? 'dlg-btn-danger' : 'dlg-btn-primary'"
              @click="resolveConfirm(true)"
            >{{ pending.confirm.okLabel }}</button>
          </template>
          <template v-else>
            <button v-if="pending.copyText" class="dlg-btn" @click="copyDetail()">
              {{ copied ? "✓ 已复制" : "复制路径" }}
            </button>
            <button class="dlg-btn dlg-btn-primary" @click="closeDialog()">关闭</button>
          </template>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.dlg-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998; /* 低于 ctx-menu 的 9999 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--color-overlay-bg, rgba(30, 8, 16, 0.72));
}
.dlg-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
  max-width: 100%;
  max-height: 100%;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--color-confirm-border, #4a2540);
  background: var(--color-confirm-bg, #2a1020);
  color: var(--color-confirm-text, #f0e0f0);
  font-size: 13px;
  line-height: 1.6;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
.dlg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
}
.dlg-icon { font-size: 15px; }
.dlg-success .dlg-icon { color: #7ee0a0; }
.dlg-error   .dlg-icon { color: #f38ba8; }
.dlg-info    .dlg-icon { color: #8fc4f0; }

.dlg-msg { white-space: pre-wrap; word-break: break-word; }

.dlg-detail {
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.28);
  font-family: var(--font-mono, "Courier New", monospace);
  font-size: 11px;
  line-height: 1.5;
  max-height: 132px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  cursor: pointer;
  user-select: text;
}
.dlg-detail:hover { background: rgba(0, 0, 0, 0.4); }

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}
.dlg-btn {
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--color-confirm-border, #4a2540);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: background 0.15s;
}
.dlg-btn:hover { background: rgba(255, 255, 255, 0.08); }
.dlg-btn-primary { border-color: var(--color-accent, #c4276f); }
.dlg-btn-danger {
  border-color: #f38ba8;
  color: #f38ba8;
}
.dlg-btn-danger:hover { background: rgba(243, 139, 168, 0.16); }

.dlg-fade-enter-active,
.dlg-fade-leave-active { transition: opacity 0.15s; }
.dlg-fade-enter-from,
.dlg-fade-leave-to { opacity: 0; }
</style>
