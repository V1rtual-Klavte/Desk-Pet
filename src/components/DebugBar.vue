<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { debug, getEffectiveThinkingEffort, setSessionThinkingEffort, resetSessionThinkingEffort, getEffectiveSafetyMode, setSessionSafetyMode, resetSessionSafetyMode } from "@/services/debug"

const showTools = ref(false)
const showDetail = ref(false)

const ctxColor = computed(() => {
  if (debug.lastContextUsage >= 80) return "#ff6b6b"
  if (debug.lastContextUsage >= 50) return "#ffd93d"
  return "#6bcf7f"
})

const toolsLabel = computed(() => {
  const n = debug.lastToolCount
  if (n === 0) return "无工具"
  if (n <= 3) return debug.lastToolNames.join(", ")
  return `${debug.lastToolNames.slice(0, 3).join(", ")} +${n - 3}`
})

const lastTokens = computed(() =>
  debug.lastPromptTokens > 0
    ? `${(debug.lastPromptTokens / 1000).toFixed(1)}k`
    : "—"
)

// ── 会话思考强度 ──
const sessionEffort = ref<string>(getEffectiveThinkingEffort() || "_default")
watch(sessionEffort, (v) => {
  if (v === "_default") {
    resetSessionThinkingEffort()
  } else {
    setSessionThinkingEffort(v as any)
  }
})

// ── 会话安全策略 ──
const sessionSafety = ref<string>(getEffectiveSafetyMode() || "_default")
watch(sessionSafety, (v) => {
  if (v === "_default") {
    resetSessionSafetyMode()
  } else {
    setSessionSafetyMode(v as any)
  }
})
</script>

<template>
  <div class="debug-bar">
    <div class="db-row">
      <select
        class="db-thinking-select"
        v-model="sessionEffort"
        title="会话思考强度（覆盖全局默认）"
      >
        <option value="_default">🗂 默认</option>
        <option value="auto">🧠 auto</option>
        <option value="low">🧠 low</option>
        <option value="medium">🧠 medium</option>
        <option value="high">🧠 high</option>
      </select>
      <select
        class="db-thinking-select"
        v-model="sessionSafety"
        title="会话安全策略（覆盖全局默认）"
      >
        <option value="_default">🛡 默认</option>
        <option value="just_do_it">⚡ 全放行</option>
        <option value="tell_me">📋 告知</option>
        <option value="let_me_tk">🔒 全确认</option>
      </select>
      <span class="db-item" :style="{ color: ctxColor }">
        📐 {{ debug.lastContextUsage }}%
      </span>
      <span class="db-item">🔤 {{ lastTokens }}</span>
      <span
        class="db-item db-tools"
        @click="showTools = !showTools"
      >
        🔧 {{ toolsLabel }}
      </span>
    </div>
    <div v-if="showTools" class="db-tool-list">
      <div v-if="debug.lastToolNames.length === 0" class="db-tool-empty">
        本次请求未携带工具
      </div>
      <div v-for="t in debug.lastToolNames" :key="t" class="db-tool-item">
        {{ t }}
      </div>
    </div>
    <div class="db-row db-row-sub">
      <span class="db-item db-dim" @click="showDetail = !showDetail">
        📦 工具注册: {{ debug.registeredToolCount }}
        (技能:{{ debug.registeredSkillCount }} MCP:{{ debug.registeredMcpCount }})
      </span>
    </div>
    <div v-if="showDetail" class="db-tool-list">
      <div
        v-for="t in debug.registeredTools"
        :key="t.name"
        class="db-tool-item"
        :class="'src-' + t.source"
      >
        <span class="db-tool-src">{{ t.source }}</span>
        <span>{{ t.name }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug-bar {
  position: relative;
  z-index: 10;
  background: var(--color-surface-deep);
  border-top: 1px solid var(--color-surface-dark);
  padding: 2px 6px;
  font-size: 10px;
  font-family: var(--font-ui), monospace;
  color: var(--color-debug-text);
  user-select: none;
  flex-shrink: 0;
}
.db-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.db-row-sub {
  margin-top: 1px;
  font-size: 9px;
}
.db-item {
  cursor: default;
  white-space: nowrap;
}
.db-tools {
  cursor: pointer;
  color: var(--color-debug-tool-text);
}
.db-tools:hover {
  color: var(--color-debug-tool-hover-text);
  text-decoration: underline;
}
.db-dim {
  color: var(--color-debug-dim-text);
  cursor: pointer;
}
.db-dim:hover {
  color: var(--color-debug-dim-hover-text);
}
.db-tool-list {
  margin-top: 2px;
  padding: 2px 4px;
  background: var(--color-surface-deepest);
  border-radius: 4px;
  max-height: 120px;
  overflow-y: auto;
}
.db-tool-item {
  padding: 1px 4px;
  color: var(--color-debug-tool-text);
  font-size: 9px;
  display: flex;
  gap: 6px;
}
.db-tool-item.src-mcp { color: var(--color-debug-mcp); }
.db-tool-item.src-skill { color: var(--color-debug-skill); }
.db-tool-empty {
  color: var(--color-debug-empty);
  padding: 2px 4px;
}
.db-tool-src {
  color: var(--color-debug-dim-text);
  font-size: 8px;
  min-width: 24px;
}
.db-thinking-select {
  background: var(--color-surface-deepest);
  border: 1px solid var(--color-surface-dark);
  border-radius: 4px;
  color: var(--color-debug-text);
  font-size: 9px;
  font-family: inherit;
  padding: 1px 3px;
  cursor: pointer;
}
.db-thinking-select:focus { outline: none; border-color: var(--color-accent); }
</style>
