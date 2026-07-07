<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import { userConfig, modeConfig, loggingConfig, desktopConfig } from "@/services/config";
import { createLogger } from "@/services/logger";
import { isMacOS } from "@/services/env";

const log = createLogger("Settings");

// ── 模式 ──
const assistantMode = ref(modeConfig.assistant);

// ── 弹窗 ──
const popupMode = ref(userConfig.popupMode);
const autoPopup = ref(userConfig.autoPopupOnMessage);
const popupW = ref(userConfig.popupSize.w);
const popupH = ref(userConfig.popupSize.h);
const popupDefaultSize = { w: 730, h: 450 };

// ── 快捷键 ──
const recording = ref(false);
const recKey = ref(userConfig.shortcutKey);
const recMods = ref([...userConfig.shortcutMacModifiers]);
const shortcutDisplay = computed(() => {
  const modMap: Record<string, string> = isMacOS
    ? { Control: "⌃", Command: "⌘", Alt: "⌥", Shift: "⇧" }
    : { Control: "Ctrl", Command: "Win", Alt: "Alt", Shift: "Shift" };
  const parts = recMods.value.map((m: string) => modMap[m] || m);
  parts.push(recKey.value.toUpperCase());
  return parts.join("+");
});

function startRecording() {
  recording.value = true;
  recKey.value = "";
  recMods.value = [];
}

function onKeyDown(e: KeyboardEvent) {
  if (!recording.value) return;
  e.preventDefault();
  e.stopPropagation();
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;
  recKey.value = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  recMods.value = [];
  if (e.ctrlKey) recMods.value.push("Control");
  if (e.metaKey) recMods.value.push("Command");
  if (e.altKey) recMods.value.push("Alt");
  if (e.shiftKey && e.key !== "Shift") recMods.value.push("Shift");
  recording.value = false;
}

// ── 位置 ──
const displayPos = ref<{ x: number; y: number } | null>(userConfig.fixedPosition);

// ── 日志 ──
const logLevel = ref(loggingConfig.level);

// ── 桌面轮询 ──
const deskPoll = ref(desktopConfig.pollingIntervalMs);
const deskPause = ref(desktopConfig.pauseExtraMs);
const deskWait = ref(desktopConfig.waitTimeoutMs);

// ── 弹窗大小预览 ──
async function previewSize() {
  await emit("deskpet-preview-size", { w: popupW.value, h: popupH.value });
}
async function restoreDefaultSize() {
  popupW.value = popupDefaultSize.w;
  popupH.value = popupDefaultSize.h;
  await emit("deskpet-preview-size", { w: popupDefaultSize.w, h: popupDefaultSize.h });
}

// ── 生命周期 ──
let cleanupResize: (() => void) | null = null;
let cleanupMove: (() => void) | null = null;

onMounted(async () => {
  document.addEventListener("keydown", onKeyDown, true);
  try {
    cleanupResize = await listen<{ w: number; h: number }>(
      "deskpet-resized",
      (e) => {
        popupW.value = e.payload.w;
        popupH.value = e.payload.h;
      }
    );
  } catch {}
  try {
    cleanupMove = await listen<{ x: number; y: number }>(
      "deskpet-moved",
      (e) => {
        displayPos.value = { x: e.payload.x, y: e.payload.y };
      }
    );
  } catch {}
});

onUnmounted(() => {
  document.removeEventListener("keydown", onKeyDown, true);
  if (cleanupResize) cleanupResize();
  if (cleanupMove) cleanupMove();
});

defineExpose({
  assistantMode,
  popupMode,
  autoPopup,
  popupW,
  popupH,
  recKey,
  recMods,
  logLevel,
  deskPoll,
  deskPause,
  deskWait,
});
</script>

<template>
  <div>
  <div class="s-section">
    <div class="s-label">⚙️ 模式 <span class="tag-tip">需重启</span></div>
    <label class="chk"><input type="checkbox" v-model="assistantMode" /><span>助手模式 — 解锁写文件/MCP/Skill等高级能力</span></label>
    <div class="s-hint">当前: {{ assistantMode ? '🔓 助手模式' : '🔒 轻量模式' }}</div>
  </div>

  <div class="s-section">
    <div class="s-label">📍 弹窗</div>
    <div class="radio-row">
      <label class="chk"><input type="radio" v-model="popupMode" value="cursor" /><span>跟随光标</span></label>
      <label class="chk"><input type="radio" v-model="popupMode" value="fixed" /><span>固定位置</span></label>
    </div>
    <div v-if="popupMode === 'fixed'" class="s-hint">拖动主窗口更新位置: <span v-if="displayPos">({{ displayPos.x }}, {{ displayPos.y }})</span><span v-else>未设置</span></div>
    <label class="chk" style="margin-top:4px"><input type="checkbox" v-model="autoPopup" /><span>收到消息自动弹出</span></label>
  </div>

  <div class="s-section">
    <div class="s-label">📐 弹窗大小</div>
    <div class="row-gap">
      <label>宽 <input class="inp-num" type="number" v-model.number="popupW" min="200" /></label>
      <span class="s-muted">×</span>
      <label>高 <input class="inp-num" type="number" v-model.number="popupH" min="150" /></label>
      <button class="btn-s" @click="previewSize">👁 预览</button>
      <button class="btn-s btn-d" @click="restoreDefaultSize">↺ 默认</button>
    </div>
  </div>

  <div class="s-section">
    <div class="s-label">⌨ 快捷键</div>
    <div class="row-gap">
      <span class="shortcut-display">{{ shortcutDisplay }}</span>
      <button class="btn-s" :class="{ recording }" @click="startRecording">{{ recording ? "按下组合键..." : "录制" }}</button>
    </div>
  </div>

  <div class="s-section">
    <div class="s-label">📝 日志</div>
    <div class="radio-row">
      <label v-for="lv in ['debug','info','warn','error']" :key="lv" class="chk"><input type="radio" v-model="logLevel" :value="lv" /><span>{{ lv }}</span></label>
    </div>
  </div>

  <div class="s-section">
    <div class="s-label">🖥 桌面轮询</div>
    <div class="row-gap">
      <label>轮询 <input class="inp-num" type="number" v-model.number="deskPoll" /> ms</label>
      <label>暂停额外 <input class="inp-num" type="number" v-model.number="deskPause" /> ms</label>
      <label>超时 <input class="inp-num" type="number" v-model.number="deskWait" /> ms</label>
    </div>
  </div>
</div>
</template>

<style scoped>
/* 快捷键录制脉冲动画 */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.btn-s.recording {
  background: var(--color-accent, #c4276f);
  color: #fff;
  animation: pulse .8s ease infinite;
}
</style>
