<script setup lang="ts">
import { computed, ref } from "vue"
import { debug } from "@/services/debug"

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
</script>

<template>
  <div class="debug-bar">
    <div class="db-row">
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
  background: #2a1020;
  border-top: 1px solid #4a2540;
  padding: 2px 6px;
  font-size: 10px;
  font-family: "pixel-mplus", "zpix", monospace;
  color: #c0a0b0;
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
  color: #a0c0f0;
}
.db-tools:hover {
  color: #c0e0ff;
  text-decoration: underline;
}
.db-dim {
  color: #706070;
  cursor: pointer;
}
.db-dim:hover {
  color: #908090;
}
.db-tool-list {
  margin-top: 2px;
  padding: 2px 4px;
  background: #1a0810;
  border-radius: 4px;
  max-height: 120px;
  overflow-y: auto;
}
.db-tool-item {
  padding: 1px 4px;
  color: #a0c0f0;
  font-size: 9px;
  display: flex;
  gap: 6px;
}
.db-tool-item.src-mcp { color: #f0c060; }
.db-tool-item.src-skill { color: #60f0a0; }
.db-tool-empty {
  color: #605060;
  padding: 2px 4px;
}
.db-tool-src {
  color: #706070;
  font-size: 8px;
  min-width: 24px;
}
</style>
