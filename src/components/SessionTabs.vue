<script setup lang="ts">
import { reactive, ref, onMounted } from "vue";
import { MemoryService } from "@/services/agent/memory";
import type { SessionFileMeta } from "@/services/agent/memory";
import { getSessions, getActiveSessionId, saveActiveId, loadActiveId } from "@/services/session";

// ── Session meta ──
export interface SessionMeta {
  id: string;
  name: string;
  createdAt: number;
  messageCount: number;
}

const sessions = reactive<SessionMeta[]>([]);
const activeId = ref("");

// ★ 会话历史面板
const showHistory = ref(false);
const historyFiles = ref<SessionFileMeta[]>([]);
const historyLoading = ref(false);

const emit = defineEmits<{
  "switch": [session: SessionMeta];
  "new": [];
  "close-tab": [id: string];
  "delete-file": [filename: string];
  "restore-session": [sf: SessionFileMeta];
}>();

// ── 加载会话列表（从 session store 同步，不走 localStorage）──
function loadSessions(): void {
  const list = getSessions();
  sessions.splice(0, sessions.length, ...list);
  activeId.value = getActiveSessionId();
}

// ── 获取/创建 ──
function getActiveId(): string {
  return activeId.value || (sessions.length > 0 ? sessions[0].id : "");
}

function ensureSession(): void {
  if (sessions.length === 0) {
    // 不在此创建，由父组件 initChat 负责
  }
  if (!activeId.value || !sessions.find(s => s.id === activeId.value)) {
    activeId.value = sessions[0]?.id ?? "";
    saveActiveId(activeId.value);
  }
}

// ── 操作 ──
function switchTo(id: string): void {
  if (!id || id === activeId.value) return;
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  activeId.value = id;
  saveActiveId(id);
  emit("switch", s);
}

/** ★ "+" 按钮: 只触发父组件创建，不在此创建 */
function newSession(): void {
  emit("new");
}

/** 关闭会话标签 */
function closeSession(id: string): void {
  if (sessions.length <= 1) return;
  const idx = sessions.findIndex(x => x.id === id);
  if (idx === -1) return;

  const removed = sessions.splice(idx, 1)[0];
  emit("close-tab", removed.id);

  if (activeId.value === id) {
    activeId.value = sessions[0]?.id ?? "";
    saveActiveId(activeId.value);
    if (activeId.value) {
      const s = sessions.find(x => x.id === activeId.value);
      if (s) emit("switch", s);
    }
  }
}

// ★ 会话历史
async function toggleHistory() {
  showHistory.value = !showHistory.value;
  if (showHistory.value) {
    await loadHistoryFiles();
  }
}

async function loadHistoryFiles(): Promise<void> {
  historyLoading.value = true;
  try {
    historyFiles.value = await MemoryService.listSessionFiles();
  } catch {
    historyFiles.value = [];
  } finally {
    historyLoading.value = false;
  }
}

async function deleteHistoryFile(filename: string): Promise<void> {
  console.log("[SessionTabs] deleteHistoryFile 点击:", filename)
  emit("delete-file", filename)
  // ★ 不在此立即过滤 UI，由父组件 finally 中调用 refreshHistory 统一刷新
}

/** ★ 刷新历史面板（父组件在会话操作完成后调用） */
async function refreshHistory(): Promise<void> {
  if (showHistory.value) {
    await loadHistoryFiles()
  }
}

async function restoreHistorySession(sf: SessionFileMeta): Promise<void> {
  emit("restore-session", sf)
  // 即时刷新标签栏（父组件会同步）
  setTimeout(() => loadSessions(), 300)
}

function formatDate(isoStr: string): string {
  if (!isoStr) return ""
  try {
    const d = new Date(isoStr)
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  } catch { return isoStr.substring(0, 10) }
}

// ★ 滚轮横向滚动（macOS 隐藏滚动条后滚轮不会自动转横向）
function onWheel(e: WheelEvent) {
  const row = e.currentTarget as HTMLElement
  row.scrollLeft += e.deltaY
}

// ── 暴露给父组件 ──
defineExpose({
  loadSessions,       // 父组件在 createNewSession 后调用刷新
  getActiveId,
  ensureSession,
  refreshHistory,     // ★ 父组件在会话操作完成后刷新历史面板
});

onMounted(() => {
  loadSessions();
});
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
        <span>会话历史 (sessions/)</span>
        <button id="history-close" @click="showHistory = false">×</button>
      </div>
      <div id="history-list">
        <div v-if="historyLoading" class="history-status">加载中...</div>
        <div v-else-if="historyFiles.length === 0" class="history-status">暂无归档会话</div>
        <div
          v-for="f in historyFiles"
          :key="f.filename"
          class="history-item"
          @click="restoreHistorySession(f)"
        >
          <div class="history-info">
            <span class="history-topic">{{ f.topic }}</span>
            <span class="history-meta">{{ formatDate(f.createdAt) }} · {{ f.rounds }}轮 · {{ f.mode }}</span>
          </div>
          <button
            class="history-delete"
            @click.stop="deleteHistoryFile(f.filename)"
            title="删除此会话文件"
          >🗑</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
#session-tabs {
  flex-shrink: 0;
  background: #3e1a2e;
  border-bottom: 1px solid #5a3050;
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
  background: #4a2540;
  border: 1px solid #5a3050;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  font-size: clamp(8px, 2vw, 11px);
  color: #8a6080;
  flex-shrink: 0;
  max-width: 100px;
  transition: background 0.15s, color 0.15s;
}
.st-tab:hover {
  background: #5a3050;
  color: #c0a0b0;
}
.st-tab.active {
  background: #c4276f;
  color: #fff;
  border-color: #c4276f;
}

.st-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
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
  border: 1px solid #6a4060;
  border-radius: 50%;
  background: #4a2540;
  color: #8a6080;
  font-size: 14px;
  line-height: 20px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
#st-new:hover {
  background: #c4276f;
  color: #fff;
  border-color: #c4276f;
}

/* ★ 会话历史按钮 */
#st-history {
  flex-shrink: 0;
  width: 22px; height: 22px;
  padding: 0;
  border: 1px solid #6a4060;
  border-radius: 50%;
  background: #4a2540;
  color: #8a6080;
  font-size: 11px;
  line-height: 20px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
#st-history:hover, #st-history.active {
  background: #c4276f;
  color: #fff;
  border-color: #c4276f;
}

/* ★ 会话历史下拉面板 */
#history-panel {
  position: absolute;
  top: 100%;
  left: 4px;
  right: 4px;
  max-height: 240px;
  background: #2d1525;
  border: 1px solid #5a3050;
  border-top: none;
  border-radius: 0 0 6px 6px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

#history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  font-size: 11px;
  color: #8a6080;
  border-bottom: 1px solid #4a2540;
}

#history-close {
  background: none;
  border: none;
  color: #8a6080;
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
}
#history-close:hover { color: #c4276f; }

#history-list {
  overflow-y: auto;
  flex: 1;
}

.history-status {
  padding: 16px;
  text-align: center;
  color: #6a5060;
  font-size: 11px;
}

.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid #3a1a2e;
  cursor: pointer;
  transition: background 0.1s;
}
.history-item:hover {
  background: #3a1a2e;
}

.history-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
}

.history-topic {
  font-size: 11px;
  color: #c0a0b0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-meta {
  font-size: 9px;
  color: #6a5060;
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
