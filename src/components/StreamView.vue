<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { animations } from "../services/animation";
import { getBodyUrl, getCharacterScaleMode, getUiUrl } from "@/services/profile";

const bodyUrl = computed(() => getBodyUrl());
const currentSrc = ref(bodyUrl.value);
const scaleMode = computed(() => getCharacterScaleMode() === "smooth" ? "auto" : "pixelated");

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
onMounted(() => {
  if (bodyUrl.value) currentSrc.value = bodyUrl.value;
  playAnim("idle");
});
onUnmounted(() => { if (timer) clearTimeout(timer); });
defineExpose({ setExpression });
</script>

<template>
  <div id="stream">
    <div id="stack">
      <img id="char" :src="currentSrc" alt="" draggable="false" :style="{ imageRendering: scaleMode }" />
      <img id="shield" :src="getUiUrl('windows/bg_stream_shield_gold.png')" alt="" draggable="false" />
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