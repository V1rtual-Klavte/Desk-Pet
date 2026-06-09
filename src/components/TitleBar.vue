<script setup lang="ts">
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

defineProps<{ height: number; title: string }>();

const win = getCurrentWebviewWindow();
function close() { win.close(); }
</script>

<template>
  <div id="bar" :style="{ height: height + 'px' }" data-tauri-drag-region>
    <div class="left" data-tauri-drag-region>
      <img class="win-icon" src="/assets/windows/icon_desktop_yapoo.png" alt="" data-tauri-drag-region />
      <span class="title" data-tauri-drag-region>{{ title }}</span>
    </div>
    <div class="right">
      <button class="btn" @click="win.minimize()" title="min">
        <img src="/assets/windows/button_minimize.png" alt="" />
      </button>
      <button class="btn" @click="win.maximize()" title="max">
        <img src="/assets/windows/button_maximize.png" alt="" />
      </button>
      <button class="btn close" @click="close" title="close">
        <img src="/assets/windows/button_close.png" alt="" />
      </button>
    </div>
  </div>
</template>

<style scoped>
#bar {
  width: 100%; display: flex; align-items: center;
  justify-content: space-between;
  background: linear-gradient(90deg, #f7a8c4, #c4276f);
  border-top: 2px solid #fccdd9;
  border-bottom: 2px solid #a01a5a;
  flex-shrink: 0; user-select: none; z-index: 10;
}
.left { display: flex; align-items: center; gap: 6px; padding-left: 8px; height: 100%; }
.win-icon { height: 22px; image-rendering: pixelated; }
.title { color: #fff; font-size: 14px; font-weight: bold; margin-left: 6px; text-shadow: 1px 1px 1px rgba(0,0,0,0.3); }
.right { display: flex; align-items: center; gap: 2px; height: 100%; padding-right: 2px; }
.btn {
  width: 24px; height: 22px;
  border: 1px solid rgba(255,180,200,0.4);
  background: rgba(255,200,220,0.25);
  border-radius: 3px;
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.btn img { width: 14px; height: 14px; image-rendering: pixelated; }
.btn:hover { background: rgba(255,220,235,0.5); border-color: rgba(255,200,220,0.6); }
.btn.close:hover { background: #c42b1c; border-color: #c42b1c; }
</style>