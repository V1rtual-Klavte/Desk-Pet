<script setup lang="ts">
import "./styles/fonts.css";
import "./styles/global.css";
import { ref, onMounted, onUnmounted } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import TitleBar from "./components/TitleBar.vue";
import StreamView from "./components/StreamView.vue";
import ChatPanel from "./components/ChatPanel.vue";
import WinSim from "./components/winsim/WinSim.vue";
import { handleCommand } from "./services/command-handler";
import { initWindowListener } from "./services/window";
import { initChat } from "@/services/ai";
import { desktopConfig } from "@/services/config";

const isWinSim = (() => {
  try { return getCurrentWebviewWindow().label === "windows-sim"; }
  catch { return false; }
})();

const showChat = ref(true);
const winSize = ref({ w: 0, h: 0 });
const streamRef = ref<InstanceType<typeof StreamView> | null>(null);

function onChatSend(text: string) {
  handleCommand(text, streamRef.value);
}

let cleanupListener: (() => void) | null = null;

onMounted(async () => {
  if (isWinSim) return;
  // 将桌面端配置传给 Rust 后台线程
  invoke("set_monitor_config", {
    pollingIntervalMs: desktopConfig.pollingIntervalMs,
    pauseExtraMs: desktopConfig.pauseExtraMs,
    waitTimeoutMs: desktopConfig.waitTimeoutMs,
  }).catch(() => {});
  await initChat("Pちゃん！你终于来了！今天也要一直在一起哦～♡");
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