<script setup lang="ts">
import { ref, onErrorCaptured } from "vue";
import BootBios from "./BootBios.vue";
import BootLogo from "./BootLogo.vue";
import LoginScreen from "./LoginScreen.vue";
import DesktopScreen from "./DesktopScreen.vue";
import { createLogger } from "@/services/logger";

const log = createLogger("WinSim");

type Phase = "bios" | "boot" | "login" | "desktop";
const phase = ref<Phase>("bios");
const errorMsg = ref("");

onErrorCaptured((err, _instance, _info) => {
  errorMsg.value = "[WinSim] " + String(err);
  log.error("渲染错误", err instanceof Error ? err : String(err));
  return false;
});
</script>

<template>
  <div v-if="errorMsg" class="err">{{ errorMsg }}</div>
  <div v-else class="root">
    <Transition name="cross" mode="out-in">
      <BootBios      v-if="phase === 'bios'"    key="bios"    @done="phase = 'boot'" />
      <BootLogo      v-else-if="phase === 'boot'"   key="boot"    @done="phase = 'login'" />
      <LoginScreen   v-else-if="phase === 'login'"  key="login"   @done="phase = 'desktop'" />
      <DesktopScreen v-else                         key="desktop" />
    </Transition>
  </div>
</template>

<style scoped>
.root {
  width: 100vw; height: 100vh;
  overflow: hidden; background: var(--color-winsim-bg, #000);
}
.err {
  width: 100%; height: 100%;
  background: #300; color: #f88;
  padding: 24px; font-family: monospace;
  font-size: 13px; white-space: pre-wrap;
}
.cross-enter-active { transition: opacity 0.45s ease; }
.cross-leave-active { transition: opacity 0.3s ease; }
.cross-enter-from,
.cross-leave-to { opacity: 0; }
</style>
