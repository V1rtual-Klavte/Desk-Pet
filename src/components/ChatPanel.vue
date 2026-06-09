<script setup lang="ts">
import { ref, nextTick, onMounted } from "vue";
import { chatHistory, sendMessage } from "../services/chat";

const input = ref("");
const el = ref<HTMLElement | null>(null);

function scroll() {
  nextTick(() => {
    if (el.value) el.value.scrollTop = el.value.scrollHeight;
  });
}
async function send() {
  const t = input.value.trim();
  if (!t) return;
  input.value = "";
  await sendMessage(t);
  scroll();
}
function key(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
}
onMounted(scroll);
</script>

<template>
  <div id="chat">
    <img class="cbg" src="/assets/windows/tinder_match.png" alt="" />
    <div id="ch-head">ライブチャット</div>
    <div id="ch-msgs" ref="el">
      <div v-for="(m, i) in chatHistory" :key="i" class="cm" :class="m.role">
        <span class="cn">{{ m.role === "assistant" ? "糖糖" : "あなた" }}</span>
        <span class="ct">{{ m.text }}</span>
      </div>
    </div>
    <div id="ch-foot">
      <input v-model="input" placeholder="チャット..." @keydown="key" />
      <button @click="send" :disabled="!input.trim()">送信</button>
    </div>
  </div>
</template>

<style scoped>
#chat {
  width: 220px;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  background: #1a0a20;
}
.cbg {
  position: absolute;
  width: 100%; height: 100%;
  object-fit: cover;
  pointer-events: none;
  z-index: 0;
  opacity: 0.1;
}
#ch-head {
  position: relative;
  z-index: 1;
  padding: 6px 8px;
  font-size: 10px;
  color: #f0a0c0;
  background: #2a1035;
  border-bottom: 1px solid #3a1a4a;
  flex-shrink: 0;
  text-align: center;
  letter-spacing: 2px;
}
#ch-msgs {
  position: relative;
  z-index: 1;
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cm { display: flex; flex-direction: column; gap: 1px; font-size: 10px; line-height: 1.4; }
.cm.user { align-items: flex-end; }
.cm.assistant { align-items: flex-start; }
.cn { font-size: 9px; color: #f0a0c0; }
.cm.user .cn { color: #90d0ff; }
.ct { color: #f0e0f0; word-break: break-word; padding: 4px 8px; border-radius: 12px; max-width: 95%; font-size: 10px; }
.cm.user .ct { background: #3a1a5a; }
.cm.assistant .ct { background: #2a1035; }
#ch-foot {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  background: #2a1035;
  border-top: 1px solid #3a1a4a;
  flex-shrink: 0;
}
#ch-foot input {
  flex: 1;
  background: #1a0a20;
  border: 1px solid #4a2a5a;
  border-radius: 16px;
  padding: 5px 10px;
  color: #f0e0f0;
  font-size: 10px;
  font-family: inherit;
  outline: none;
}
#ch-foot input:focus { border-color: #c4276f; }
#ch-foot input::placeholder { color: #6a4a7a; }
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
#ch-foot button:disabled { background: #3a2050; color: #7a5a8a; cursor: default; }
#ch-msgs::-webkit-scrollbar { width: 4px; }
#ch-msgs::-webkit-scrollbar-thumb { background: #4a2a5a; border-radius: 2px; }
</style>