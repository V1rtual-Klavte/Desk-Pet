<script setup lang="ts">
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getUiUrl } from "@/services/profile";
import { titlebarLogo } from "@/services/titlebar";

defineProps<{ height: number }>();
const emit = defineEmits<{ "toggle-chat": []; "toggle-settings": []; "toggle-layer-editor": [] }>();

const win = getCurrentWebviewWindow();
</script>

<template>
  <div id="bar" :style="{ height: height + 'px' }" data-tauri-drag-region>
    <div class="left" data-tauri-drag-region>
      <span class="brand" data-tauri-drag-region>V1rtual</span>
      <span class="title" :style="{ color: titlebarLogo.color || undefined }" data-tauri-drag-region>{{ titlebarLogo.text }}</span>
      <span class="dots"><span class="d1"></span><span class="d2"></span><span class="d3"></span></span>
    </div>
    <div class="right">
      <!-- 暂时注掉：头像按钮（聊天面板的开合入口）。恢复时同时启用下方 .btn-chat 样式，
           emit 声明与 App.vue 的 toggle-chat 绑定保留，icon_status_* 资源留在 Profile 里。
      <button class="btn-chat" @click="$emit('toggle-chat')" title="chat">
        <img class="ic-default" :src="getUiUrl('windows/icon_status_follower.png')" alt="" />
        <img class="ic-hover" :src="getUiUrl('windows/icon_status_love.png')" alt="" />
      </button>
      -->
      <button class="btn" @click="$emit('toggle-settings')" title="settings">
        <svg class="ic" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
          <line x1="2.2" y1="4.5" x2="13.8" y2="4.5"/><circle cx="6.4" cy="4.5" r="1.7"/>
          <line x1="2.2" y1="8" x2="13.8" y2="8"/><circle cx="10.4" cy="8" r="1.7"/>
          <line x1="2.2" y1="11.5" x2="13.8" y2="11.5"/><circle cx="5" cy="11.5" r="1.7"/>
        </svg>
      </button>
      <button class="btn" @click="$emit('toggle-layer-editor')" title="图层编辑器">
        <svg class="ic" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 2 13.6 5 8 8 2.4 5Z"/>
          <path d="M2.4 8.6 8 11.6 13.6 8.6"/>
          <path d="M2.4 11.6 8 14.6 13.6 11.6"/>
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
/* 品牌字样：固定不可自定义。规规矩矩地待在顶栏里：
   与顶栏同高的衬线小字、垂直居中、完整显示（此前大字号会顶出边框并被窗口裁切） */
.brand {
  font-family: "Libre Bodoni", "Bodoni 72", "Didot", Georgia, serif;
  font-size: 20px;
  font-weight: 400;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-titlebar-text);
  white-space: nowrap;
}
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
/* 暂时注掉：头像按钮样式（与模板中的按钮一起恢复）
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
*/
.btn {
  width: 24px; height: 22px;
  border: 1px solid var(--color-titlebar-btn-border);
  background: var(--color-titlebar-btn-bg);
  border-radius: 3px;
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  /* 图标走 currentColor，跟随主题的顶栏文字色 */
  color: var(--color-titlebar-text);
}
.btn img { width: 14px; height: 14px; image-rendering: pixelated; }
.btn:hover { background: var(--color-titlebar-btn-hover-bg); border-color: var(--color-titlebar-btn-hover-border); }
.btn.close:hover { background: var(--color-titlebar-close-hover); border-color: var(--color-titlebar-close-hover); }
.ic {
  display: block;
  /* 细线图标在浅色按钮底上会失对比（如糖糖粉的实心白按钮底），
     加一圈极淡的轮廓投影兜底；深色顶栏下几乎不可见，无副作用 */
  filter: drop-shadow(0 0 0.6px rgba(0, 0, 0, 0.55));
}
</style>
