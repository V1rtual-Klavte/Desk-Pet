<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { getUiUrl } from "@/services/profile";

const emit = defineEmits<{ done: [] }>();
const progress = ref(0);
const showLogo = ref(true);
let timer: ReturnType<typeof setInterval>|null=null;

onMounted(()=>{
  const total=2800;const interval=40;let elapsed=0;
  timer=setInterval(()=>{
    elapsed+=interval;
    progress.value=Math.min(100,(elapsed/total)*100);
    if(elapsed>=total){clearInterval(timer!);setTimeout(()=>emit("done"),500)}
  },interval);
});

onUnmounted(()=>{if(timer)clearInterval(timer)});
</script>

<template>
  <div class="boot" data-tauri-drag-region>
    <Transition name="fi">
      <img v-if="showLogo" class="logo" :src="getUiUrl('Fromtemd/boot_logo.png')" alt="" />
    </Transition>
    <div class="bar-wrap">
      <div class="bar-track">
        <div class="bar-fill" :style="{ width: progress + '%' }"></div>
        <div class="bar-glow"></div>
      </div>
    </div>
    <p class="ver">Version 5.1 (Build 2600.xpsp.080413-2111 : Service Pack 3)</p>
    <p class="cp">© 2006 Microsoft Corporation</p>
  </div>
</template>

<style scoped>
.boot {
  width:100%;height:100%;background:#000;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  gap:26px;font-family:"zpix",sans-serif;
  cursor:move;
}
.logo {image-rendering:pixelated;max-width:420px;width:70%;height:auto;pointer-events:none}
.bar-wrap {
  width: 320px; height: 22px;
  background: #0a0a0a;
  border: 2px solid #555;
  border-radius: 4px;
  overflow: hidden;
  padding: 2px;
  box-shadow: inset 0 1px 4px rgba(0,0,0,0.8);
}
.bar-track {
  width: 100%; height: 100%;
  background: #111;
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}
.bar-fill {
  height: 100%;
  background-image: repeating-linear-gradient(
    90deg,
    var(--color-winsim-accent, #e07090) 0px,
    var(--color-winsim-accent, #e07090) 14px,
    #111 14px,
    #111 16px
  );
  background-size: 16px 100%;
  transition: width 0.04s linear;
  position: relative; z-index: 1;
}
.bar-glow {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(180deg, rgba(255,255,255,0.08) 0%, transparent 50%, rgba(0,0,0,0.2) 100%);
  z-index: 2; pointer-events: none;
}
.bar-block {
  width: 14px; height: 100%; flex-shrink: 0;
  background: linear-gradient(180deg, #e07090 0%, #c04070 50%, #a02050 100%);
  border-radius: 1px;
}
.ver {color:#777;font-size:10px;margin-top:8px;pointer-events:none}
.cp  {color:#444;font-size:11px;position:absolute;bottom:26px;pointer-events:none}
.fi-enter-active{transition:opacity .7s ease}
.fi-enter-from{opacity:0}
</style>
