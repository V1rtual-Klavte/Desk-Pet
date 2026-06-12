<script setup lang="ts">
// ==========================================
// Styles: global fonts & layout
// ==========================================
import "./styles/fonts.css";
import "./styles/global.css";

// ==========================================
// Vue core
// ==========================================
import { ref, onMounted, onUnmounted } from "vue";

// ==========================================
// Tauri API
// ==========================================
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// ==========================================
// Components
// ==========================================
import TitleBar from "./components/TitleBar.vue";
import StreamView from "./components/StreamView.vue";
import ChatPanel from "./components/ChatPanel.vue";
import WinSim from "./components/winsim/WinSim.vue";

// ==========================================
// Services
// ==========================================
import { handleCommand } from "./services/command-handler";
import { initWindowListener } from "./services/window-listener";
import { initChat } from "@/features/chat";

// ==========================================
// State
// ==========================================
const isWinSim = (() => {
  try { return getCurrentWebviewWindow().label === "windows-sim"; }
  catch { return false; }
})();

const showChat = ref(true);
const winSize = ref({ w: 0, h: 0 });
const streamRef = ref<InstanceType<typeof StreamView> | null>(null);

// ==========================================
// Chat send handler
// ==========================================
function onChatSend(text: string) {
  handleCommand(text, streamRef.value);
}

// ==========================================
// Lifecycle
// ==========================================
let cleanupListener: (() => void) | null = null;

onMounted(async () => {
  if (isWinSim) return;
  await initChat("你来啦～！今天也要一起加油哦～");
  cleanupListener = await initWindowListener(streamRef, winSize);
});

onUnmounted(() => {
  if (cleanupListener) cleanupListener();
});
</script>

<template>
  <WinSim v-if="isWinSim" />
  <div v-else id="root">
    <TitleBar :height="30" title="配信中" @toggle-chat="showChat = !showChat" />
    <div id="body">
      <div id="stream-col">
        <img id="bg" src="/assets/windows/operation_base.png" alt="" />
        <StreamView ref="streamRef" />
      </div>
      <div id="chat-slot" :class="{ closed: !showChat }">
        <ChatPanel v-if="showChat" @send="onChatSend" />
      </div>
    </div>
  </div>
</template>
