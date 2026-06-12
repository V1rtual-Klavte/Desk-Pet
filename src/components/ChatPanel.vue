<script setup lang="ts">
import { ref, nextTick, onMounted, watch } from "vue";
import { chatHistory, sendMessage } from "@/features/chat";

const emit = defineEmits<{ send: [text: string] }>();
const input = ref("");
const msgContainer = ref<HTMLElement | null>(null);
const thumb = ref<HTMLElement | null>(null);

// 是否在底部、是否有新消息在下方
const isAtBottom = ref(true);
const hasNewBelow = ref(false);

// ==========================================
// 滚动逻辑
// ==========================================
function checkBottom() {
  const el = msgContainer.value;
  if (!el) return;
  // 底部判断：允许 4px 误差
  isAtBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  if (isAtBottom.value) hasNewBelow.value = false;
  updateThumb();
}

function scrollToBottom() {
  const el = msgContainer.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  hasNewBelow.value = false;
  nextTick(updateThumb);
}

// 监听 chatHistory 变化 → 新消息来了
watch(
  () => chatHistory.length,
  () => {
    nextTick(() => {
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

// ==========================================
// 发送消息
// ==========================================
async function send() {
  const t = input.value.trim();
  if (!t) return;
  input.value = "";
  emit("send", t);
  await sendMessage(t);
  scrollToBottom();
}
function key(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
}

onMounted(() => {
  scrollToBottom();
  checkBottom();
});
</script>

<template>
  <div id="chat">
    <img class="cbg" src="/assets/windows/tinder_match.png" alt="" />
    <div id="ch-head">Live Chat</div>

    <!-- 消息区 + 滚动条容器 -->
    <div id="ch-body">
      <div id="ch-msgs" ref="msgContainer" @scroll="checkBottom">
        <div v-for="(m, i) in chatHistory" :key="i" class="cm" :class="m.role">
          <span class="cn">{{ m.role === "assistant" ? "糖糖" : "你" }}</span>
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

    <div id="ch-foot">
      <input v-model="input" placeholder="消息..." @keydown="key" />
      <button @click="send" :disabled="!input.trim()">发送</button>
    </div>
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
#ch-head {
  font-family: "pixel-mplus-bold", "zpix", "pixel-mplus", sans-serif;
  position: relative;
  z-index: 1;
  padding: 6px 8px;
  font-size: 11px;
  color: #f0a0c0;
  background: #4a2540;
  border-bottom: 1px solid #5a3050;
  flex-shrink: 0;
  text-align: center;
  letter-spacing: 2px;
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
}
/* 隐藏原生滚动条 */
#ch-msgs::-webkit-scrollbar { display: none; }
#ch-msgs { scrollbar-width: none; }

/* 自定义滚动条轨道 */
#ch-scrollbar {
  width: 6px;
  flex-shrink: 0;
  background: rgba(0,0,0,0.15);
  position: relative;
  cursor: pointer;
}
/* 滚动条滑块 */
#ch-thumb {
  position: absolute;
  width: 100%;
  border-radius: 3px;
  background: rgba(240,160,192,0.3);
  transition: background 0.15s;
}
#ch-thumb:hover { background: rgba(240,160,192,0.55); }
#ch-thumb.dragging { background: rgba(240,160,192,0.7); }

/* 跳到底部按钮 */
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
.cm { display: flex; flex-direction: column; gap: 1px; font-size: 10px; line-height: 1.4; }
.cm.user { align-items: flex-end; }
.cm.assistant { align-items: flex-start; }
.cn { font-size: 9px; color: #f0a0c0; }
.cm.user .cn { color: #90d0ff; }
.ct { color: #f0e0f0; word-break: break-word; padding: 4px 8px; border-radius: 12px; max-width: 95%; font-size: 10px; }
.cm.user .ct { background: #6a3050; }
.cm.assistant .ct { background: #4a2540; }

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
#ch-foot input {
  flex: 1;
  background: #3e1a2e;
  border: 1px solid #6a4060;
  border-radius: 16px;
  padding: 5px 10px;
  color: #f0e0f0;
  font-size: 10px;
  font-family: inherit;
  outline: none;
}
#ch-foot input:focus { border-color: #c4276f; }
#ch-foot input::placeholder { color: #8a6080; }
#ch-foot button {
  padding: 5px 12px;
  background: #c4276f;
  color: #fff;
  border: none;
  border-radius: 16px;
  cursor: pointer;
  font-size: 10px;
  font-family: inherit;
  flex-shrink: 0;
}
#ch-foot button:hover { background: #e84a8a; }
#ch-foot button:disabled { background: #5a3050; color: #8a6080; cursor: default; }
</style>
