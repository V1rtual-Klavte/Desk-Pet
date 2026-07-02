<script setup lang="ts">
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getUiUrl } from "@/services/profile";

defineProps<{ height: number; title: string }>();
const emit = defineEmits<{ "toggle-chat": []; "toggle-settings": [] }>();

const win = getCurrentWebviewWindow();
</script>

<template>
  <div id="bar" :style="{ height: height + 'px' }" data-tauri-drag-region>
    <div class="left" data-tauri-drag-region>
      <img class="win-icon" :src="getUiUrl('windows/icon_desktop_yapoo.png')" alt="" data-tauri-drag-region draggable="false" />
      <span class="title" data-tauri-drag-region>{{ title }}</span>
      <span class="dots"><span class="d1"></span><span class="d2"></span><span class="d3"></span></span>
    </div>
    <div class="right">
      <button class="btn-chat" @click="$emit('toggle-chat')" title="chat">
        <img class="ic-default" :src="getUiUrl('windows/icon_status_follower.png')" alt="" />
        <img class="ic-hover" :src="getUiUrl('windows/icon_status_love.png')" alt="" />
      </button>
      <button class="btn" @click="$emit('toggle-settings')" title="settings">
        <svg class="pixel-gear" width="14" height="14" viewBox="0 0 7 7" shape-rendering="crispEdges">
          <rect x="3" y="0" width="1" height="2" fill="#3355aa"/>
          <rect x="3" y="5" width="1" height="2" fill="#3355aa"/>
          <rect x="0" y="3" width="2" height="1" fill="#3355aa"/>
          <rect x="5" y="3" width="2" height="1" fill="#3355aa"/>
          <rect x="1" y="1" width="1" height="1" fill="#3355aa" opacity="0.5"/>
          <rect x="5" y="1" width="1" height="1" fill="#3355aa" opacity="0.5"/>
          <rect x="1" y="5" width="1" height="1" fill="#3355aa" opacity="0.5"/>
          <rect x="5" y="5" width="1" height="1" fill="#3355aa" opacity="0.5"/>
        </svg>
      </button>
      <button class="btn close" @click="win.hide()" title="hide to tray">
        <img :src="getUiUrl('windows/button_close.png')" alt="" />
      </button>
    </div>
  </div>
</template>

<style scoped>
#bar {
  width: 100%; display: flex; align-items: center;
  justify-content: space-between;
  background: linear-gradient(90deg, var(--color-titlebar-gradient-start), var(--color-titlebar-gradient-end));
  border-top: 2px solid var(--color-titlebar-border-top);
  border-bottom: 2px solid var(--color-titlebar-border-bottom);
  flex-shrink: 0; user-select: none; z-index: 10;
}
.left { display: flex; align-items: center; gap: 6px; padding-left: 8px; height: 100%; }
.win-icon { height: 22px; image-rendering: pixelated; }
.title { color: var(--color-titlebar-text); font-size: 14px; font-weight: bold; margin-left: 6px; text-shadow: 1px 1px 1px rgba(0,0,0,0.3); overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.dots { display: inline-flex; gap: 3px; align-items: center; margin-top: 12px; margin-left: -4px; }
.dots span {
  display: inline-block;
  width: 4px; height: 4px;
  border-radius: 50%;
  background: var(--color-titlebar-text);
  animation: bounce 2s infinite;
}
.dots .d1 { animation-delay: 0s; }
.dots .d2 { animation-delay: 0.3s; }
.dots .d3 { animation-delay: 0.6s; }
@keyframes bounce {
  0%, 80%, 100% { opacity: 0; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-2px); }
}
.right { display: flex; align-items: center; gap: 2px; height: 100%; padding-right: 2px; }
.btn-win {
  width: 28px; height: 28px;
  border: 1px solid var(--color-titlebar-btn-border);
  background: var(--color-titlebar-btn-bg);
  border-radius: 3px;
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.btn-win img { width: 18px; height: 18px; image-rendering: pixelated; }
.btn-win:hover { background: var(--color-titlebar-btn-hover-bg); border-color: var(--color-titlebar-btn-hover-border); }
.btn-chat {
  width: 28px; height: 28px;
  border: none; background: none;
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  position: relative;
}
.btn-chat img {
  position: absolute;
  height: 20px; width: auto;
  image-rendering: pixelated;
  object-fit: contain;
}
.btn-chat .ic-default { display: block; }
.btn-chat .ic-hover { display: none; }
.btn-chat:hover .ic-default { display: none; }
.btn-chat:hover .ic-hover { display: block; }
.btn {
  width: 24px; height: 22px;
  border: 1px solid var(--color-titlebar-btn-border);
  background: var(--color-titlebar-btn-bg);
  border-radius: 3px;
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.btn img { width: 14px; height: 14px; image-rendering: pixelated; }
.btn:hover { background: var(--color-titlebar-btn-hover-bg); border-color: var(--color-titlebar-btn-hover-border); }
.btn.close:hover { background: var(--color-titlebar-close-hover); border-color: var(--color-titlebar-close-hover); }
.pixel-gear {
  image-rendering: pixelated;
  display: block;
}
</style>
