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
      <button class="btn" @click="$emit('toggle-layer-editor')" title="图层编辑器">
        <svg class="pixel-layers" width="14" height="14" viewBox="0 0 7 7" shape-rendering="crispEdges" aria-hidden="true">
          <rect x="2" y="0" width="5" height="1" fill="#3355aa"/>
          <rect x="2" y="1" width="1" height="3" fill="#3355aa"/>
          <rect x="6" y="1" width="1" height="3" fill="#3355aa"/>
          <rect x="2" y="4" width="5" height="1" fill="#3355aa"/>
          <rect x="0" y="2" width="5" height="1" fill="#3355aa"/>
          <rect x="0" y="3" width="1" height="3" fill="#3355aa"/>
          <rect x="4" y="3" width="1" height="3" fill="#3355aa"/>
          <rect x="0" y="6" width="5" height="1" fill="#3355aa"/>
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
/* 品牌字样：固定不可自定义（参考网站 header 的 Bodoni 大字）。
   字号刻意大于顶栏高度：字形下沿压出边框、上沿贴住窗口顶，
   溢出部分由 #bar 的 z-index 盖在内容之上，只允许字体超出。 */
.brand {
  font-family: "Libre Bodoni", "Bodoni 72", "Didot", Georgia, serif;
  font-size: 44px;
  font-weight: 400;
  line-height: 0.72;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  -webkit-text-stroke: 0.8px currentColor;
  transform: scaleX(0.85);
  transform-origin: left center;
  color: var(--color-titlebar-text);
  white-space: nowrap;
  margin-top: 6px;
  /* 补偿 scaleX 缩放后留下的布局空白，让「配信中」贴近字形 */
  margin-right: -14px;
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
}
.btn img { width: 14px; height: 14px; image-rendering: pixelated; }
.btn:hover { background: var(--color-titlebar-btn-hover-bg); border-color: var(--color-titlebar-btn-hover-border); }
.btn.close:hover { background: var(--color-titlebar-close-hover); border-color: var(--color-titlebar-close-hover); }
.pixel-gear, .pixel-layers {
  image-rendering: pixelated;
  display: block;
}
</style>
