<script setup lang="ts">
import { reactive, ref, computed, onMounted } from "vue";

// ── Session meta ──
export interface SessionMeta {
  id: string;
  name: string;       // 自动取第一条用户消息前20字，或"新会话"
  createdAt: number;
  messageCount: number;
}

const SESSIONS_KEY = "deskpet_sessions";
const ACTIVE_KEY = "deskpet_active_session";

const sessions = reactive<SessionMeta[]>([]);
const activeId = ref("");

const emit = defineEmits<{
  "switch": [session: SessionMeta];
  "new": [];
  "archive": [id: string];
}>();

// ── 加载会话列表 ──
function loadSessions(): void {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        sessions.splice(0, sessions.length, ...arr);
      }
    }
  } catch { /* ignore */ }
}

function saveSessions(): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([...sessions]));
  } catch { /* ignore */ }
}

// ── 获取/创建 ──
function getActiveId(): string {
  return activeId.value || (sessions.length > 0 ? sessions[0].id : "");
}

/** 确保至少有一个会话 */
function ensureSession(): void {
  if (sessions.length === 0) {
    createSession();
  }
  if (!activeId.value || !sessions.find(s => s.id === activeId.value)) {
    activeId.value = sessions[0]?.id ?? "";
    localStorage.setItem(ACTIVE_KEY, activeId.value);
  }
}

function createSession(): SessionMeta {
  const now = new Date();
  const id = `session-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  const s: SessionMeta = {
    id,
    name: "新会话",
    createdAt: now.getTime(),
    messageCount: 0,
  };
  sessions.unshift(s);
  saveSessions();
  return s;
}

function updateSessionName(id: string, firstUserMsg: string): void {
  const s = sessions.find(x => x.id === id);
  if (s && s.name === "新会话" && firstUserMsg) {
    s.name = firstUserMsg.replace(/\n/g, " ").substring(0, 20);
    saveSessions();
  }
}

function updateMessageCount(id: string, count: number): void {
  const s = sessions.find(x => x.id === id);
  if (s) {
    s.messageCount = count;
    saveSessions();
  }
}

// ── 操作 ──
function switchTo(id: string): void {
  if (!id || id === activeId.value) return;
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  activeId.value = id;
  localStorage.setItem(ACTIVE_KEY, id);
  emit("switch", s);
}

function newSession(): void {
  const s = createSession();
  activeId.value = s.id;
  localStorage.setItem(ACTIVE_KEY, s.id);
  emit("new");
}

function closeSession(id: string): void {
  if (sessions.length <= 1) return; // 至少保留1个
  const idx = sessions.findIndex(x => x.id === id);
  if (idx === -1) return;

  const removed = sessions.splice(idx, 1)[0];
  saveSessions();
  emit("archive", removed.id);

  // 如果关闭的是当前活跃的，切换到第一个
  if (activeId.value === id) {
    activeId.value = sessions[0]?.id ?? "";
    localStorage.setItem(ACTIVE_KEY, activeId.value);
    if (activeId.value) {
      const s = sessions.find(x => x.id === activeId.value);
      if (s) emit("switch", s);
    }
  }
}

// ── 暴露给父组件 ──
defineExpose({
  createSession,
  updateSessionName,
  updateMessageCount,
  getActiveId,
  ensureSession,
  loadSessions,
});

onMounted(() => {
  loadSessions();
  // 恢复上次活跃会话
  try {
    const lastId = localStorage.getItem(ACTIVE_KEY);
    if (lastId && sessions.find(s => s.id === lastId)) {
      activeId.value = lastId;
    }
  } catch { /* ignore */ }
  ensureSession();
});
</script>

<template>
  <div id="session-tabs">
    <div id="st-row">
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

      <!-- 新建按钮 -->
      <button id="st-new" @click="newSession" title="新建会话">+</button>
    </div>
  </div>
</template>

<style scoped>
#session-tabs {
  flex-shrink: 0;
  background: #3e1a2e;
  border-bottom: 1px solid #5a3050;
  padding: 4px 4px 0 4px;
}
#st-row {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
#st-row::-webkit-scrollbar { display: none; }

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
  position: relative;
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
  margin: 0 2px 4px 4px;
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
</style>
