<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { getUiUrl } from "@/services/profile";

const emit = defineEmits<{ done: [] }>();
const lines = ref<string[]>([]);
const showCursor = ref(true);
const phase = ref<"post"|"done">("post");

const postLines = [
  "American Megatrends Inc.",
  "BIOS Rev. 2.01.06    Date: 2025/08/15 17:30:20",
  "CPU : Angel(R) Love(TM) angel-kawaii  3200 MHz",
  "       Speed : 6.00 GHz",
  "",
  "Press F2 or DEL to run Setup.",
  "Press F11 for BBS POPUP.",
  "",
  "Initializing USB Controllers .. Done.",
  "4096 MB OK",
  "",
  "Auto-Detecting SATA 1 .. IDE Hard Disk",
  "Auto-Detecting SATA 2 .. ATAPI CD-ROM",
  "Auto-Detecting SATA 3 .. IDE Hard Disk",
  "Auto-Detecting SATA 4 .. None",
  "",
  "SATA 1 : ST2000DM008-2FR102       2000 GB",
  "         Ultra DMA Mode-6, S.M.A.R.T. Capable and Status OK",
  "SATA 2 : HL-DT-ST DVDRAM GH24NSD5",
  "SATA 3 : LOVE SSD 999 Plus Unlimited GB",
  "         Ultra DMA Mode-6, S.M.A.R.T. Capable and Status OK",
];

let timer: ReturnType<typeof setInterval>|null=null;
let cursorTimer: ReturnType<typeof setInterval>|null=null;

onMounted(()=>{
  let i=0;
  timer=setInterval(()=>{
    if(i<postLines.length){lines.value.push(postLines[i]);i++}
    else{clearInterval(timer!);phase.value="done";setTimeout(()=>emit("done"),800)}
  },140);
  cursorTimer=setInterval(()=>{showCursor.value=!showCursor.value},500);
});

onUnmounted(()=>{
  if(timer)clearInterval(timer);
  if(cursorTimer)clearInterval(cursorTimer);
});
</script>

<template>
  <div class="bios" data-tauri-drag-region>
    <img class="bios-logo" :src="getUiUrl('Fromtemd/bios_logo.png')" alt="" />
    <div class="txt">
      <p v-for="(line,idx) in lines" :key="idx" class="bl">{{ line||"\u00A0" }}</p>
      <span v-if="phase==='post'" class="cur" :class="{on:showCursor}">_</span>
      <p v-if="phase==='done'" class="bl dim">Press DEL to enter SETUP</p>
    </div>
  </div>
</template>

<style scoped>
.bios {
  width:100%;height:100%;background:#000;
  display:flex;align-items:flex-start;justify-content:flex-start;
  padding:24px 32px;box-sizing:border-box;
  font-family:"zpix",monospace;color:#fff;
  cursor:move;
}
.txt {
  font-size:15px;line-height:1.55;white-space:pre;
  font-weight:bold;letter-spacing:.5px;
  pointer-events:none;
}
.bl{margin:0}
.bl.dim{color:#888;margin-top:8px}
.cur{font-weight:bold}
.cur.on{opacity:1}
.cur:not(.on){opacity:0}
.bios-logo{position:absolute;bottom:20px;right:24px;image-rendering:pixelated;max-width:240px;height:auto;opacity:.7;pointer-events:none}
</style>