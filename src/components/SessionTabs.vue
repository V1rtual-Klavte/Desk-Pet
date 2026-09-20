<script setup lang="ts">
import { computed, ref } from "vue";
import {
  getActiveSessionId, sessions,
  sessionHistory, sessionHistoryError, sessionHistoryLoading,
  refreshSessionHistory,
} from "@/services/session";
import type { PiSessionSummary, SessionMeta } from "@/services/session";

/** 标签列表与活跃指针都直接消费会话读模型：组件不再维护本地副本，也不再需要父组件补刷。 */
const activeId = computed(() => getActiveSessionId());

// ★ 会话历史面板（sessions/ 仓库中的全部会话，含未打开标签的归档）
const showHistory = ref(false);

const emit = defineEmits<{
  "switch": [session: SessionMeta];
  "new": [];
  "close-tab": [id: string];
  "delete-session": [id: string];
  "restore-session": [session: PiSessionSummary];
}>();

// ── 操作 ──
function switchTo(id: string): void {
  if (!id || id === activeId.value) return;
  const target = sessions.find(item => item.id === id);
  if (!target) return;
  emit("switch", target);
}

/** ★ "+" 按钮: 只触发父组件创建，不在此创建 */
function newSession(): void {
  emit("new");
}

/** 关闭会话标签：列表由会话读模型移除，不在此就地过滤；后续切到哪个会话由父组件裁定 */
function closeSession(id: string): void {
  if (sessions.length <= 1) return;
  emit("close-tab", id);
}

// ★ 会话历史（读取、错误态与增删改都由会话读模型负责）
async function toggleHistory(): Promise<void> {
  showHistory.value = !showHistory.value;
  if (showHistory.value) await refreshSessionHistory();
}

/** 删除交给父组件：失败要能在面板里留错误态，不在这里做乐观过滤 */
function deleteHistorySession(id: string): void {
  emit("delete-session", id);
}

/** 恢复只发意图；标签栏与历史列表都由会话读模型更新 */
function restoreHistorySession(item: PiSessionSummary): void {
  emit("restore-session", item);
}

function formatDate(timestamp: number): string {
  if (!timestamp) return ""
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

// ★ 滚轮横向滚动（macOS 隐藏滚动条后滚轮不会自动转横向）
function onWheel(e: WheelEvent) {
  const row = e.currentTarget as HTMLElement
  row.scrollLeft += e.deltaY
}
</script>

<template>
  <div id="session-tabs">
    <div id="st-row">
      <div id="st-tabs-wrap" @wheel.prevent="onWheel">
        <!-- 会话标签 -->
        <div
          v-for="s in sessions"
          :key="s.id"
          class="st-tab"
          :class="{ active: s.id === activeId }"
          @click="switchTo(s.id)"
        >
          <span class="st-name">{{ s.name }}</span>
          <!-- 上次运行中断提示（H-2 扩展点：内核恢复扫描后经 setSessionInterrupted 写入） -->
          <span v-if="s.interrupted" class="st-interrupted" title="上次运行中断，等待恢复">!</span>
          <button
            v-if="sessions.length > 1"
            class="st-close"
            @click.stop="closeSession(s.id)"
            title="关闭会话"
          >×</button>
        </div>
      </div>

      <!-- ★ 按钮区 —— 常驻右侧 -->
      <div id="st-actions">
        <button id="st-new" @click="newSession" title="新建会话">+</button>
        <button id="st-history" @click="toggleHistory" title="会话历史" :class="{ active: showHistory }">
          📋
        </button>
      </div>
    </div>

    <!-- ★ 会话历史下拉面板 -->
    <div v-if="showHistory" id="history-panel">
      <div id="history-header">
        <span>会话历史</span>
        <button id="history-close" @click="showHistory = false">×</button>
      </div>
      <div id="history-list">
        <div v-if="sessionHistoryLoading" class="history-status">加载中...</div>
        <div v-else-if="sessionHistoryError" class="history-status">历史会话读取失败，请查看日志</div>
        <div v-else-if="sessionHistory.length === 0" class="history-status">暂无历史会话</div>
        <div
          v-for="item in sessionHistory"
          :key="item.id"
          class="history-item"
          @click="restoreHistorySession(item)"
        >
          <div class="history-info">
            <span class="history-topic">{{ item.name || "新会话" }}</span>
            <span class="history-meta">{{ formatDate(item.createdAt) }} · {{ item.messageCount }} 条</span>
          </div>
          <button
            class="history-delete"
            @click.stop="deleteHistorySession(item.id)"
            title="删除此会话"
          >🗑</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
#session-tabs {
  flex-shrink: 0;
  background: var(--color-tab-bar-bg);
  border-bottom: 1px solid var(--color-tab-bar-border);
  padding: 4px 4px 0 4px;
  position: relative;
}
#st-row {
  display: flex;
  align-items: flex-end;
  gap: 0;
}
#st-tabs-wrap {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  flex: 1;
  min-width: 0;
  padding-bottom: 2px;
}
#st-tabs-wrap::-webkit-scrollbar { display: none; }

/* ★ 按钮区 —— 常驻右侧，不随tab滚动 */
#st-actions {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
  padding-left: 4px;
  padding-bottom: 2px;
}

.st-tab {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 8px;
  background: var(--color-tab-inactive-bg);
  border: 1px solid var(--color-tab-bar-border);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  font-size: clamp(8px, 2vw, 11px);
  color: var(--color-tab-inactive-text);
  flex-shrink: 0;
  max-width: 100px;
  transition: background 0.15s, color 0.15s;
}
.st-tab:hover {
  background: var(--color-tab-hover-bg);
  color: var(--color-tab-hover-text);
}
.st-tab.active {
  background: var(--color-tab-active-bg);
  color: var(--color-tab-active-text);
  border-color: var(--color-tab-active-bg);
}

.st-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* 上次运行中断提示 */
.st-interrupted {
  flex-shrink: 0;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: var(--color-accent);
  color: var(--color-tab-active-text);
  font-size: 9px;
  line-height: 12px;
  text-align: center;
  cursor: help;
}

.st-close {
  flex-shrink: 0;
  width: 14px; height: 14px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 11px;
  line-height: 14px;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.15s, background 0.15s;
}
.st-close:hover {
  opacity: 1;
  background: rgba(255,255,255,0.15);
}
.st-tab.active .st-close:hover {
  background: rgba(0,0,0,0.2);
}

#st-new {
  flex-shrink: 0;
  width: 22px; height: 22px;
  padding: 0;
  border: 1px solid var(--color-border-input);
  border-radius: 50%;
  background: var(--color-tab-inactive-bg);
  color: var(--color-tab-inactive-text);
  font-size: 14px;
  line-height: 20px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
#st-new:hover {
  background: var(--color-tab-active-bg);
  color: var(--color-tab-active-text);
  border-color: var(--color-tab-active-bg);
}

/* ★ 会话历史按钮 */
#st-history {
  flex-shrink: 0;
  width: 22px; height: 22px;
  padding: 0;
  border: 1px solid var(--color-border-input);
  border-radius: 50%;
  background: var(--color-tab-inactive-bg);
  color: var(--color-tab-inactive-text);
  font-size: 11px;
  line-height: 20px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
#st-history:hover, #st-history.active {
  background: var(--color-tab-active-bg);
  color: var(--color-tab-active-text);
  border-color: var(--color-tab-active-bg);
}

/* ★ 会话历史下拉面板 */
#history-panel {
  position: absolute;
  top: 100%;
  left: 4px;
  right: 4px;
  max-height: 240px;
  background: var(--color-history-bg);
  border: 1px solid var(--color-tab-bar-border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px var(--color-dropdown-shadow);
}

#history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--color-tab-inactive-text);
  border-bottom: 1px solid var(--color-tab-inactive-bg);
}

#history-close {
  background: none;
  border: none;
  color: var(--color-tab-inactive-text);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
}
#history-close:hover { color: var(--color-accent); }

#history-list {
  overflow-y: auto;
  flex: 1;
}

.history-status {
  padding: 16px;
  text-align: center;
  color: var(--color-history-meta-text);
  font-size: 11px;
}

.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-history-item-border);
  cursor: pointer;
  transition: background 0.1s;
}
.history-item:hover {
  background: var(--color-history-item-hover-bg);
}

.history-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
}

.history-topic {
  font-size: 11px;
  color: var(--color-history-topic-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-meta {
  font-size: 9px;
  color: var(--color-history-meta-text);
}

.history-delete {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  opacity: 0.5;
  transition: opacity 0.15s;
}
.history-delete:hover {
  opacity: 1;
}
</style>
