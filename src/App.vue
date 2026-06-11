<script setup lang="ts">
// ==========================================
// 样式：全局字体 & 布局
// ==========================================
import "./styles/fonts.css";
import "./styles/global.css";

// ==========================================
// Vue 核心
// ==========================================
import { ref, onMounted, onUnmounted } from "vue";

// ==========================================
// Tauri API
// ==========================================
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// ==========================================
// 组件
// ==========================================
import TitleBar from "./components/TitleBar.vue";
import StreamView from "./components/StreamView.vue";
import ChatPanel from "./components/ChatPanel.vue";
import WinSim from "./components/winsim/WinSim.vue";

// ==========================================
// 服务
// ==========================================
import { handleCommand } from "./services/command-handler";
import { initWindowListener } from "./services/window-listener";

// ==========================================
// 状态
// ==========================================
const isWinSim = (() => {
  try { return getCurrentWebviewWindow().label === "windows-sim"; }
  catch { return false; }
})();

const showChat = ref(true);
const winSize = ref({ w: 0, h: 0 });
const streamRef = ref<InstanceType<typeof StreamView> | null>(null);

// ==========================================
// 聊天发送 → 委托给命令处理器
// ==========================================
function onChatSend(text: string) {
  handleCommand(text, streamRef.value);
}

// ==========================================
// 生命周期：窗口监听 & 资源释放
// ==========================================
let cleanupListener: (() => void) | null = null;

onMounted(async () => {
  if (isWinSim) return;
  cleanupListener = await initWindowListener(streamRef, winSize);
});

onUnmounted(() => {
  if (cleanupListener) cleanupListener();
});
</script>

<template>
  <WinSim v-if="isWinSim" />
  <div v-else id="root">
    <TitleBar :height="30" title="配信ちゃん" @toggle-chat="showChat = !showChat" />
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
