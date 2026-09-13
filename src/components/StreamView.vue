<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { animations } from "../services/animation";

const currentSrc = ref("/assets/ctj/stream_cho_body.png");
const charRef = ref<HTMLImageElement | null>(null);
const shieldRef = ref<HTMLImageElement | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let currentAnim: any = null;
let frameIndex = 0;

function playAnim(name: string) {
  const anim = (animations as any)[name];
  if (!anim || anim.frames.length === 0) return;
  if (timer) { clearTimeout(timer); timer = null; }
  currentAnim = anim;
  frameIndex = 0;
  showFrame();
}
function showFrame() {
  if (!currentAnim) return;
  const frame = currentAnim.frames[frameIndex];
  if (!frame) return;
  currentSrc.value = frame.src;
  timer = setTimeout(() => {
    frameIndex++;
    if (frameIndex >= currentAnim.frames.length) {
      if (currentAnim.loop) { frameIndex = 0; showFrame(); }
      else playAnim("idle");
    } else showFrame();
  }, frame.duration);
}
function setExpression(name: string) { playAnim(name); }
onMounted(() => playAnim("idle"));
onUnmounted(() => { if (timer) clearTimeout(timer); });

/** 供父组件接入鼠标追踪场景：返回两个真实渲染元素（人物帧渲染层 + 金色盾形背景层） */
function getTrackingElements(): { character: HTMLImageElement | null; background: HTMLImageElement | null } {
  return { character: charRef.value, background: shieldRef.value };
}

defineExpose({ setExpression, getTrackingElements });
</script>

<template>
  <div id="stream">
    <div id="stack">
      <img id="char" ref="charRef" :src="currentSrc" alt="" draggable="false" />
      <img id="shield" ref="shieldRef" src="/assets/windows/bg_stream_shield_gold.png" alt="" draggable="false" />
    </div>
  </div>
</template>

<style scoped>
#stream {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
}
#stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  position: relative;
  height: 55vh;
  max-height: 420px;
}
#char {
  max-height: 100%;
  max-width: 100%;
  object-fit: contain;
  image-rendering: pixelated;
  position: relative;
  z-index: 2;
}
#shield {
  position: absolute;
  bottom: 0;
  width: 100%;
  max-width: 348px;
  object-fit: contain;
  pointer-events: none;
  z-index: 1;
}
</style>
