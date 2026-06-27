<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch } from "vue";
import { chatHistory, sendMessage } from "@/services/agent";
import { playEventSound } from "@/services/audio/registry";
import { userConfig } from "@/services/config";
import { createLogger } from "@/services/logger";
import { listen } from "@tauri-apps/api/event";
import { searchSlashCommands, findSlashCommand, initSlashCommands } from "@/services/engine";
import type { SlashMatch } from "@/services/engine";
import DebugBar from "./DebugBar.vue";
import { confirmState, resolveConfirm } from "@/services/safety/confirm";

// ★ 同步初始化 Slash 命令注册表（模块加载时即完成，保证后续即时可用）
initSlashCommands();

const log = createLogger("ChatPanel");

const emit = defineEmits<{ send: [text: string]; "request-popup": [] }>();
const input = ref("");
const inputRef = ref<HTMLTextAreaElement | null>(null);
const msgContainer = ref<HTMLElement | null>(null);
const thumb = ref<HTMLElement | null>(null);

/** 工具执行状态提示（agent-loop 事件驱动） */
const toolStatus = ref<{ text: string; visible: boolean }>({ text: "", visible: false });
let cleanupToolExec: (() => void) | null = null;
let cleanupToolDone: (() => void) | null = null;

// ==========================================
// Slash 命令下拉框
// ==========================================
const slashResults = ref<SlashMatch[]>([]);
const slashSelectedIndex = ref(0);
const slashVisible = ref(false);
const slashDropdownRef = ref<HTMLElement | null>(null);
const slashSuppress = ref(false);  // 补全后抑制一次下拉弹出

// ★ 选中项变化时自动逐项滚动到可见区域
watch(slashSelectedIndex, () => {
  nextTick(() => {
    const dropdown = slashDropdownRef.value;
    if (!dropdown) return;
    const activeItem = dropdown.querySelector("li.active") as HTMLElement | null;
    if (!activeItem) return;
    const listTop = dropdown.scrollTop;
    const listBottom = listTop + dropdown.clientHeight;
    const itemTop = activeItem.offsetTop;
    const itemBottom = itemTop + activeItem.offsetHeight;
    if (itemTop < listTop) {
      dropdown.scrollTo({ top: itemTop, behavior: "smooth" });
    } else if (itemBottom > listBottom) {
      dropdown.scrollTo({ top: itemBottom - dropdown.clientHeight, behavior: "smooth" });
    }
  });
});

function updateSlashDropdown() {
  const text = input.value;
  // ★ 补全后抑制重新弹出，让用户能直接回车发送
  if (slashSuppress.value) {
    slashSuppress.value = false;
    return;
  }
  if (text.startsWith("/")) {
    const partial = text.slice(1);
    slashResults.value = searchSlashCommands(partial);
    slashVisible.value = slashResults.value.length > 0;
    slashSelectedIndex.value = 0;
    // ★ 重置滚动位置到顶部（默认选中第一项）
    nextTick(() => {
      const dropdown = slashDropdownRef.value;
      if (dropdown) dropdown.scrollTop = 0;
    });
  } else {
    slashVisible.value = false;
    slashResults.value = [];
  }
}

// ★ watch 监听输入变化（v-model 更新后触发，保证读到最新值）
watch(input, updateSlashDropdown);

/** 自动补全：将当前选中命令填入输入框（不执行，用户可再按 Enter 执行） */
function autofillSlashCommand(match: SlashMatch) {
  slashVisible.value = false;
  slashSuppress.value = true;  // ★ 抑制 watch 重新弹出下拉
  input.value = "/" + match.command.name;
  // 光标移到末尾
  nextTick(() => {
    const el = inputRef.value;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  });
}

/** 供父组件调用：弹出时聚焦输入框 */
function focusInput() {
  nextTick(() => {
    inputRef.value?.focus();
  });
}
defineExpose({ focusInput });

// 是否在底部、是否有新消息在下方
const isAtBottom = ref(true);
const hasNewBelow = ref(false);

// ==========================================
// 滚动逻辑
// ==========================================
function checkBottom() {
  const el = msgContainer.value;
  if (!el) return;
  isAtBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  if (isAtBottom.value) hasNewBelow.value = false;
  updateThumb();
}

function scrollToBottom() {
  const el = msgContainer.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  isAtBottom.value = true;
  hasNewBelow.value = false;
  nextTick(updateThumb);
}

// 监听 chatHistory 变化 → 新消息来了
watch(
  () => chatHistory.length,
  (newLen, oldLen) => {
    nextTick(() => {
      if (newLen > (oldLen ?? 0) && chatHistory[chatHistory.length - 1]?.role === "assistant") {
        const isFirst = (oldLen ?? 0) === 0;
        if (!isFirst) playEventSound("reply");
        if (!isFirst && userConfig.autoPopupOnMessage) {
          emit("request-popup");
        }
      }
      if (isAtBottom.value) {
        scrollToBottom();
      } else {
        hasNewBelow.value = true;
        updateThumb();
      }
    });
  }
);

// ==========================================
// 自定义滚动条
// ==========================================
const thumbTop = ref(0);
const thumbHeight = ref(20);
const dragging = ref(false);
let dragStartY = 0;
let dragStartScroll = 0;

function updateThumb() {
  const el = msgContainer.value;
  if (!el) return;
  const ratio = el.clientHeight / el.scrollHeight;
  thumbHeight.value = Math.max(ratio * el.clientHeight, 20);
  const maxTop = el.clientHeight - thumbHeight.value;
  const scrollRatio = el.scrollTop / (el.scrollHeight - el.clientHeight || 1);
  thumbTop.value = scrollRatio * maxTop;
}

function onTrackClick(e: MouseEvent) {
  const el = msgContainer.value;
  const track = e.currentTarget as HTMLElement;
  if (!el) return;
  const rect = track.getBoundingClientRect();
  const y = e.clientY - rect.top - thumbHeight.value / 2;
  const ratio = y / (track.clientHeight - thumbHeight.value);
  el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
}

function onThumbDown(e: MouseEvent) {
  dragging.value = true;
  dragStartY = e.clientY;
  dragStartScroll = msgContainer.value?.scrollTop ?? 0;
  document.addEventListener("mousemove", onThumbMove);
  document.addEventListener("mouseup", onThumbUp);
}

function onThumbMove(e: MouseEvent) {
  const el = msgContainer.value;
  const track = thumb.value?.parentElement;
  if (!el || !track) return;
  const deltaY = e.clientY - dragStartY;
  const trackH = track.clientHeight - thumbHeight.value;
  const scrollH = el.scrollHeight - el.clientHeight;
  if (trackH <= 0 || scrollH <= 0) return;
  const ratio = deltaY / trackH;
  el.scrollTop = Math.max(0, Math.min(dragStartScroll + ratio * scrollH, scrollH));
}

function onThumbUp() {
  dragging.value = false;
  document.removeEventListener("mousemove", onThumbMove);
  document.removeEventListener("mouseup", onThumbUp);
}

// ── IME 输入法状态追踪 ──
const composing = ref(false);
function onCompositionStart() { composing.value = true; }
function onCompositionEnd() { composing.value = false; }

// ==========================================
// 发送消息
// ==========================================
async function send() {
  const t = input.value.trim();
  if (!t) return;

  // 如果以 / 开头，尝试作为 slash 命令执行
  if (t.startsWith("/")) {
    const cmdText = t.slice(1);
    const cmd = findSlashCommand(cmdText);
    if (cmd) {
      input.value = "";
      slashVisible.value = false;
      const result = await cmd.execute();
      if (result !== null) {
        const { pushSystemMessage } = await import("@/services/session/messages");
        pushSystemMessage(result);
      }
      return;
    }
    // 未注册的 / 开头的文本 → 透传给 AI
  }

  input.value = "";
  slashVisible.value = false;
  emit("send", t);
  playEventSound("send");
  const result = await sendMessage(t);
  if (result.personalityEffect.soundEvent) {
    playEventSound(result.personalityEffect.soundEvent as Parameters<typeof playEventSound>[0])
  }
  scrollToBottom();
}

function key(e: KeyboardEvent) {
  // IME 输入中不触发
  if (composing.value || e.isComposing || e.keyCode === 229) return;

  // ── 下拉框键盘导航 ──
  if (slashVisible.value && slashResults.value.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashSelectedIndex.value = (slashSelectedIndex.value + 1) % slashResults.value.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashSelectedIndex.value = (slashSelectedIndex.value - 1 + slashResults.value.length) % slashResults.value.length;
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const selected = slashResults.value[slashSelectedIndex.value];
      if (selected) autofillSlashCommand(selected);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      slashVisible.value = false;
      return;
    }
    // Tab 键补全
    if (e.key === "Tab") {
      e.preventDefault();
      const selected = slashResults.value[slashSelectedIndex.value];
      if (selected) autofillSlashCommand(selected);
      return;
    }
  }

  // ── 普通发送 ──
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // 如果下拉框正好打开但无结果，Enter 仍尝试作为 slash 命令执行
    send();
  }
}

onMounted(async () => {
  scrollToBottom();
  checkBottom();

  // ── 工具执行状态监听 ──
  listen<{ toolName: string; personalityHint?: string }>("tool-executing", (event) => {
    const hint = event.payload.personalityHint ?? `正在使用 ${event.payload.toolName}...`
    toolStatus.value = { text: hint, visible: true }
  }).then(fn => { cleanupToolExec = fn }).catch(() => {})
  listen<{ toolName: string; success: boolean; personalityHint?: string }>("tool-completed", (event) => {
    const hint = event.payload.personalityHint ?? (event.payload.success ? "完成啦～" : "出错了…")
    toolStatus.value = { text: hint, visible: true }
    setTimeout(() => { if (toolStatus.value.text === hint) toolStatus.value.visible = false }, 2500)
  }).then(fn => { cleanupToolDone = fn }).catch(() => {})
});

onUnmounted(() => {
  if (cleanupToolExec) cleanupToolExec()
  if (cleanupToolDone) cleanupToolDone()
});
</script>

<template>
  <div id="chat">
    <img class="cbg" src="/assets/windows/tinder_match.png" alt="" draggable="false" />

    <!-- 消息区 + 滚动条容器 -->
    <div id="ch-body">
      <div id="ch-msgs" ref="msgContainer" @scroll="checkBottom">
        <div v-for="(m, i) in chatHistory" :key="i" class="cm" :class="m.role">
          <span class="cn">{{ m.role === "system" ? "📋" : m.role === "assistant" ? "糖糖" : "你" }}</span>
          <span class="ct">{{ m.text }}</span>
        </div>
      </div>

      <!-- 自定义滚动条 -->
      <div
        v-if="thumbHeight < (msgContainer?.clientHeight ?? 0)"
        id="ch-scrollbar"
        @click="onTrackClick"
      >
        <div
          ref="thumb"
          id="ch-thumb"
          :style="{ top: thumbTop + 'px', height: thumbHeight + 'px' }"
          :class="{ dragging: dragging }"
          @mousedown.prevent="onThumbDown"
        />
      </div>

      <!-- 跳到底部按钮 -->
      <button
        v-if="hasNewBelow"
        id="ch-jump"
        @click="scrollToBottom()"
      >
        ↓ 新消息
      </button>
    </div>

    <!-- 工具执行状态提示 -->
    <Transition name="tool-status-fade">
      <div v-if="toolStatus.visible" id="ch-tool-status">
        🔧 {{ toolStatus.text }}
      </div>
    </Transition>

    <div id="ch-foot">
      <!-- 输入框容器（相对定位，供下拉框定位） -->
      <div id="ch-input-wrap">
        <textarea
          ref="inputRef"
          v-model="input"
          placeholder="消息... 输入 / 查看命令"
          @keydown="key"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          rows="1"
        />

        <!-- ★ Slash 命令下拉框 -->
        <Transition name="slash-drop">
          <ul v-if="slashVisible" ref="slashDropdownRef" id="slash-dropdown">
            <li
              v-for="(item, idx) in slashResults"
              :key="item.command.name"
              :class="{ active: idx === slashSelectedIndex }"
              @mouseenter="slashSelectedIndex = idx"
              @mousedown.prevent="autofillSlashCommand(item)"
            >
              <span class="slash-name">/{{ item.command.name }}</span>
              <span class="slash-desc">{{ item.command.description }}</span>
            </li>
          </ul>
        </Transition>
      </div>
      <button @click="send" :disabled="!input.trim()">发送</button>
    </div>

    <!-- 安全确认弹窗 -->
    <Transition name="confirm-fade">
      <div v-if="confirmState.pending" id="ch-confirm-overlay">
        <div id="ch-confirm-box">
          <div id="ch-confirm-msg">{{ confirmState.pending.message }}</div>
          <div id="ch-confirm-btns">
            <button class="ch-confirm-btn ch-confirm-deny" @click="resolveConfirm(false)">✕ 取消</button>
            <button class="ch-confirm-btn ch-confirm-ok" @click="resolveConfirm(true)">✓ 确认执行</button>
          </div>
        </div>
      </div>
    </Transition>

    <DebugBar />
  </div>
</template>

<style scoped>
#chat {
  width: 100%; height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  background: #3e1a2e;
}
.cbg {
  position: absolute;
  width: 100%; height: 100%;
  object-fit: cover;
  pointer-events: none;
  z-index: 0;
  opacity: 0.15;
}

/* --- 消息区 + 滚动条 --- */
#ch-body {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  overflow: hidden;
}

#ch-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  user-select: text;
  -webkit-user-select: text;
}
#ch-msgs::-webkit-scrollbar { display: none; }
#ch-msgs { scrollbar-width: none; }

#ch-scrollbar {
  width: 6px;
  flex-shrink: 0;
  background: rgba(0,0,0,0.15);
  position: relative;
  cursor: pointer;
}
#ch-thumb {
  position: absolute;
  width: 100%;
  border-radius: 3px;
  background: rgba(240,160,192,0.3);
  transition: background 0.15s;
}
#ch-thumb:hover { background: rgba(240,160,192,0.55); }
#ch-thumb.dragging { background: rgba(240,160,192,0.7); }

#ch-jump {
  position: absolute;
  bottom: 4px;
  right: 10px;
  z-index: 2;
  padding: 3px 10px;
  font-size: 10px;
  font-family: inherit;
  color: #fff;
  background: #c4276f;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  opacity: 0.9;
  animation: pulse-jump 1.5s ease infinite;
}
#ch-jump:hover { background: #e84a8a; }

@keyframes pulse-jump {
  0%, 100% { box-shadow: 0 0 0 0 rgba(196,39,111,0.4); }
  50% { box-shadow: 0 0 6px 4px rgba(196,39,111,0.2); }
}

/* --- 消息条目 --- */
.cm { display: flex; flex-direction: column; gap: 1px; font-size: clamp(9px, 2.5vw, 15px); line-height: 1.4; }
.cm.user { align-items: flex-end; }
.cm.assistant { align-items: flex-start; }
.cn { font-size: clamp(8px, 2.2vw, 12px); color: #f0a0c0; }
.cm.user .cn { color: #90d0ff; }
.ct { color: #f0e0f0; word-break: break-word; padding: 4px 8px; border-radius: 12px; max-width: 95%; font-size: clamp(9px, 2.5vw, 15px); }
.cm.user .ct { background: #6a3050; }
.cm.assistant .ct { background: #4a2540; }

/* ── 系统消息（斜杠命令输出）── */
.cm.system { align-items: stretch; }
.cm.system .cn { color: #9080a0; font-size: clamp(10px, 2.5vw, 14px); }
.cm.system .ct {
  background: rgba(90, 60, 100, 0.35);
  border: 1px solid rgba(140, 110, 160, 0.25);
  font-family: "Courier New", monospace;
  font-size: clamp(8px, 2vw, 12px);
  white-space: pre-wrap;
  line-height: 1.5;
  max-width: 100%;
}

/* --- 输入区 --- */
#ch-foot {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  background: #4a2540;
  border-top: 1px solid #5a3050;
  flex-shrink: 0;
}

#ch-input-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
}

#ch-foot textarea {
  width: 100%;
  min-width: 0;
  background: #3e1a2e;
  border: 1px solid #6a4060;
  border-radius: 12px;
  padding: 5px 10px;
  color: #f0e0f0;
  font-size: clamp(9px, 2.2vw, 13px);
  font-family: inherit;
  outline: none;
  resize: none;
  box-sizing: border-box;
}
#ch-foot textarea:focus { border-color: #c4276f; }
#ch-foot textarea::placeholder { color: #8a6080; }
#ch-foot button {
  padding: 5px 12px;
  background: #c4276f;
  color: #fff;
  border: none;
  border-radius: 16px;
  cursor: pointer;
  font-size: clamp(9px, 2.2vw, 13px);
  font-family: inherit;
  flex-shrink: 0;
  white-space: nowrap;
}
#ch-foot button:hover { background: #e84a8a; }
#ch-foot button:disabled { background: #5a3050; color: #8a6080; cursor: default; }

/* ── 工具执行状态提示 ── */
#ch-tool-status {
  position: relative;
  z-index: 2;
  padding: 3px 10px;
  font-size: 11px;
  color: #f0a0c0;
  background: rgba(90, 30, 60, 0.85);
  border-top: 1px solid #6a3a5a;
  text-align: center;
  flex-shrink: 0;
}
.tool-status-fade-enter-active { transition: opacity 0.2s ease; }
.tool-status-fade-leave-active { transition: opacity 0.5s ease; }
.tool-status-fade-enter-from, .tool-status-fade-leave-to { opacity: 0; }

/* ── Slash 命令下拉框 ── */
#slash-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 10;
  max-height: 160px;
  overflow-y: auto;
  background: #3a1530;
  border: 1px solid #6a4060;
  border-radius: 8px;
  padding: 4px 0;
  margin: 0;
  list-style: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  scroll-behavior: smooth;
}

#slash-dropdown li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  transition: background 0.1s;
}

#slash-dropdown li.active,
#slash-dropdown li:hover {
  background: #5a2a4a;
}

.slash-name {
  font-size: clamp(9px, 2.2vw, 13px);
  color: #f0a0c0;
  font-weight: bold;
  white-space: nowrap;
  flex-shrink: 0;
}

.slash-desc {
  font-size: clamp(8px, 2vw, 11px);
  color: #a080a0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 下拉框过渡动画 */
.slash-drop-enter-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.slash-drop-leave-active { transition: opacity 0.1s ease; }
.slash-drop-enter-from { opacity: 0; transform: translateY(4px); }
.slash-drop-leave-to { opacity: 0; }

/* ── 安全确认弹窗 ── */
#ch-confirm-overlay {
  position: absolute;
  inset: 0; z-index: 20;
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 12px;
  background: rgba(30, 8, 16, 0.7);
  backdrop-filter: blur(2px);
}
#ch-confirm-box {
  background: #2a1020;
  border: 1px solid #6a3050;
  border-radius: 8px;
  padding: 10px 14px;
  max-width: 90%;
}
#ch-confirm-msg {
  color: #f0c0d0;
  font-size: 11px;
  margin-bottom: 8px;
  text-align: center;
}
#ch-confirm-btns {
  display: flex; gap: 8px; justify-content: center;
}
.ch-confirm-btn {
  padding: 4px 16px; font-size: 11px;
  border-radius: 12px; border: 1px solid #6a4060;
  background: #3e1a2e; color: #f0e0f0;
  cursor: pointer; font-family: inherit;
}
.ch-confirm-btn:hover { background: #5a3050; }
.ch-confirm-btn.ch-confirm-ok {
  background: #c4276f; border-color: #c4276f; color: #fff;
}
.ch-confirm-btn.ch-confirm-ok:hover { background: #e84a8a; }

.confirm-fade-enter-active { transition: opacity 0.15s ease; }
.confirm-fade-leave-active { transition: opacity 0.1s ease; }
.confirm-fade-enter-from, .confirm-fade-leave-to { opacity: 0; }
</style>
