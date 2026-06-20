<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  userConfig, aiConfig, windowMonitorConfig, aiLockConfig,
  memoryConfig, notificationConfig, desktopConfig, loggingConfig,
  setOverrides, clearOverrides,
} from "@/services/config";
import {
  getSoundLibrary, getSoundAssignments, saveSoundAssignments,
  soundEvents,
  type SoundDef,
} from "@/services/audio/registry";
import { createLogger } from "@/services/logger";
import { isMacOS } from "@/services/env";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";

const log = createLogger("Settings");
const win = getCurrentWebviewWindow();

// ── 音效库 ──
const soundLibrary = ref<SoundDef[]>(getSoundLibrary());

// ── 音效分配（事件 → 音效ID）──
const assignments = ref<Record<string, string>>(getSoundAssignments());

function previewSound(eventKey: string) {
  const soundId = assignments.value[eventKey];
  if (soundId && soundId !== "none") {
    const s = soundLibrary.value.find(s => s.id === soundId);
    if (s) s.play();
  }
}

function selectSound(eventKey: string, soundId: string) {
  assignments.value[eventKey] = soundId;
}

/** 恢复音效分配为默认值 */
function restoreSoundDefaults() {
  for (const ev of soundEvents) {
    assignments.value[ev.key] = ev.defaultSoundId;
  }
  log.debug("音效已恢复默认");
}

// ── AI 配置字段 ──
const aiEndpoint = ref(aiConfig.endpoint);
const aiApiKey = ref(aiConfig.apiKey);
const aiModel = ref(aiConfig.model);
const aiMaxContext = ref(aiConfig.maxContextMessages);
const aiSystemPrompt = ref(aiConfig.defaultSystemPrompt);
const showApiKey = ref(false);

// ── 窗口监控 ──
const wmStaySeconds = ref(windowMonitorConfig.staySeconds);
const wmSettleMs = ref(windowMonitorConfig.settleMs);
const wmCooldownSec = ref(windowMonitorConfig.cooldownSeconds);
const wmSamePageCool = ref(windowMonitorConfig.samePageCooldownSeconds);

// ── AI 锁 ──
const lockTimeout = ref(aiLockConfig.safetyTimeoutMs);

// ── 记忆 ──
const memMax = ref(memoryConfig.maxEntries);

// ── 通知 ──
const notifClose = ref(notificationConfig.autoCloseMs);

// ── 桌面 ──
const deskPoll = ref(desktopConfig.pollingIntervalMs);
const deskPause = ref(desktopConfig.pauseExtraMs);
const deskWait = ref(desktopConfig.waitTimeoutMs);

// ── 日志 ──
const logLevel = ref(loggingConfig.level);

// ── 用户设置 ──
const popupMode = ref(userConfig.popupMode);
const popupW = ref(userConfig.popupSize.w);
const popupH = ref(userConfig.popupSize.h);
const popupDefaultSize = { w: 448, h: 272 };

// ── 位置显示（仅固定模式，实时同步，不在此保存）──
const displayPos = ref<{ x: number; y: number } | null>(userConfig.fixedPosition);

// ── 快捷键录制 ──
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
  log.debug("快捷键录制开始...");
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
  log.info(`快捷键已录制: ${shortcutDisplay.value}`);
}

// ── 弹窗大小预览 ──
async function previewSize() {
  try {
    // 通过事件通知主窗口设置大小（主窗口会设置 ignoreResizeCount 防止反馈循环）
    await emit("deskpet-preview-size", { w: popupW.value, h: popupH.value });
  } catch (e) { log.error("预览大小失败", e); }
}

/** 恢复弹窗默认大小 */
async function restoreDefaultSize() {
  popupW.value = popupDefaultSize.w;
  popupH.value = popupDefaultSize.h;
  // 仅预览，不持久化——持久化由 doSave 统一负责
  await emit("deskpet-preview-size", { w: popupDefaultSize.w, h: popupDefaultSize.h });
}

// ── 保存 ──
const saved = ref(false);

async function doSave() {
  // 运行时设置（立即生效）
  userConfig.popupMode = popupMode.value;
  userConfig.popupSize = { w: popupW.value, h: popupH.value };
  userConfig.shortcutKey = recKey.value;
  if (isMacOS) userConfig.shortcutMacModifiers = recMods.value;
  else userConfig.shortcutWinModifiers = recMods.value;

  // 音效分配
  saveSoundAssignments(assignments.value);

  // 配置覆盖（编译时值 — 重启后生效）
  setOverrides({
    "ai.endpoint": aiEndpoint.value,
    "ai.apiKey": aiApiKey.value,
    "ai.model": aiModel.value,
    "ai.maxContextMessages": aiMaxContext.value,
    "ai.defaultSystemPrompt": aiSystemPrompt.value,
    "windowMonitor.staySeconds": wmStaySeconds.value,
    "windowMonitor.settleMs": wmSettleMs.value,
    "windowMonitor.cooldownSeconds": wmCooldownSec.value,
    "windowMonitor.samePageCooldownSeconds": wmSamePageCool.value,
    "aiLock.safetyTimeoutMs": lockTimeout.value,
    "memory.maxEntries": memMax.value,
    "notification.autoCloseMs": notifClose.value,
    "desktop.pollingIntervalMs": deskPoll.value,
    "desktop.pauseExtraMs": deskPause.value,
    "desktop.waitTimeoutMs": deskWait.value,
    "logging.level": logLevel.value,
  });

  saved.value = true;
  log.info("设置已保存（所有配置即时生效）");

	emit("deskpet-settings-saved").catch(() => {});
  setTimeout(() => { saved.value = false; }, 3000);
}

function doCancel() {
  win.close().catch(() => {});
}

let cleanupResize: (() => void) | null = null;
let cleanupMove: (() => void) | null = null;

onMounted(async () => {
  document.addEventListener("keydown", onKeyDown, true);

  // 监听主窗口大小变化（跨窗口事件）→ 实时同步数值
  try {
    const unlisten1 = await listen<{ w: number; h: number }>("deskpet-resized", (event) => {
      popupW.value = event.payload.w;
      popupH.value = event.payload.h;
    });
    cleanupResize = unlisten1;
  } catch (e) { log.warn("监听resize事件失败", e); }

  // 监听主窗口位置变化（跨窗口事件）→ 仅更新显示，不在此保存
  try {
    const unlisten2 = await listen<{ x: number; y: number }>("deskpet-moved", (event) => {
      displayPos.value = { x: event.payload.x, y: event.payload.y };
    });
    cleanupMove = unlisten2;
  } catch (e) { log.warn("监听move事件失败", e); }
});

onUnmounted(() => {
  document.removeEventListener("keydown", onKeyDown, true);
  if (cleanupResize) cleanupResize();
  if (cleanupMove) cleanupMove();
});
</script>

<template>
  <div id="s-root">
    <div id="s-head">
      <span>⚙ 设置</span>
      <span class="s-hint">修改后点击保存，部分配置重启应用后生效</span>
      <button class="s-close" @click="doCancel">✕</button>
    </div>

    <div id="s-body">
      <!-- AI 接口 -->
      <div class="s-section">
        <div class="s-label">🤖 AI 接口 <span class="s-tag">即时生效</span></div>
        <div class="s-field">
          <span class="s-fname">端点</span>
          <input class="s-input" v-model="aiEndpoint" />
        </div>
        <div class="s-field">
          <span class="s-fname">密钥</span>
          <input class="s-input" :type="showApiKey ? 'text' : 'password'" v-model="aiApiKey" />
          <button class="s-btn-mini" @click="showApiKey = !showApiKey">{{ showApiKey ? '🙈' : '👁' }}</button>
        </div>
        <div class="s-field">
          <span class="s-fname">模型</span>
          <input class="s-input" v-model="aiModel" />
        </div>
        <div class="s-field">
          <span class="s-fname">上下文数</span>
          <input class="s-input s-input-num" type="number" v-model.number="aiMaxContext" />
        </div>
        <div class="s-field-col">
          <span class="s-fname">默认人格</span>
          <textarea class="s-input s-textarea" v-model="aiSystemPrompt" rows="2"></textarea>
        </div>
      </div>

      <!-- 窗口监控 -->
      <div class="s-section">
        <div class="s-label">👁 窗口监控 <span class="s-tag">即时生效</span></div>
        <div class="s-field-inline">
          <label>停留触发 <input class="s-input-num" type="number" v-model.number="wmStaySeconds" /> 秒</label>
          <label>防抖 <input class="s-input-num" type="number" v-model.number="wmSettleMs" /> ms</label>
        </div>
        <div class="s-field-inline">
          <label>全局冷却 <input class="s-input-num" type="number" v-model.number="wmCooldownSec" /> 秒</label>
          <label>同页冷却 <input class="s-input-num" type="number" v-model.number="wmSamePageCool" /> 秒</label>
        </div>
      </div>

      <!-- AI 并发锁 + 记忆 + 通知 -->
      <div class="s-section">
        <div class="s-label">🔒 AI 锁 / 记忆 / 通知 <span class="s-tag">即时生效</span></div>
        <div class="s-field-inline">
          <label>锁超时 <input class="s-input-num" type="number" v-model.number="lockTimeout" /> ms</label>
          <label>记忆上限 <input class="s-input-num" type="number" v-model.number="memMax" /> 条</label>
          <label>通知关闭 <input class="s-input-num" type="number" v-model.number="notifClose" /> ms</label>
        </div>
      </div>

      <!-- 桌面后端 -->
      <div class="s-section">
        <div class="s-label">🖥 桌面轮询 <span class="s-tag">即时生效</span></div>
        <div class="s-field-inline">
          <label>轮询间隔 <input class="s-input-num" type="number" v-model.number="deskPoll" /> ms</label>
          <label>暂停额外 <input class="s-input-num" type="number" v-model.number="deskPause" /> ms</label>
          <label>等待超时 <input class="s-input-num" type="number" v-model.number="deskWait" /> ms</label>
        </div>
      </div>

      <!-- 日志 -->
      <div class="s-section">
        <div class="s-label">📝 日志级别 <span class="s-tag">即时生效</span></div>
        <div class="s-field-inline">
          <label v-for="lv in ['debug','info','warn','error']" :key="lv" class="radio-item">
            <input type="radio" v-model="logLevel" :value="lv" />
            <span>{{ lv }}</span>
          </label>
        </div>
      </div>

      <!-- 弹窗位置 -->
      <div class="s-section">
        <div class="s-label">📍 弹出位置 <span class="s-tag-save">即时生效</span></div>
        <div class="radio-group">
          <label class="radio-item">
            <input type="radio" v-model="popupMode" value="cursor" />
            <span>跟随光标弹出（每次弹出时动态判断位置）</span>
          </label>
          <label class="radio-item">
            <input type="radio" v-model="popupMode" value="fixed" />
            <span>固定位置弹出（拖动窗口自动保存位置）</span>
          </label>
        </div>
        <div v-if="popupMode === 'fixed'" class="s-hint">
          拖动主窗口即可更新位置，当前: <span v-if="displayPos">({{ displayPos.x }}, {{ displayPos.y }})</span><span v-else>未设置</span>
        </div>
        <div v-if="popupMode === 'cursor'" class="s-hint">
          弹出时以光标为中心自动计算位置，超出屏幕自动贴边
        </div>
      </div>

      <!-- 弹窗大小 -->
      <div class="s-section">
        <div class="s-label">📐 弹窗大小 <span class="s-tag-save">即时生效</span></div>
        <div class="s-hint">也可以直接拖动主窗口边缘实时调整大小，数值自动同步</div>
        <div class="size-row">
          <label>宽 <input type="number" v-model.number="popupW" min="200" class="s-input-num" /></label>
          <span class="size-x">×</span>
          <label>高 <input type="number" v-model.number="popupH" min="150" class="s-input-num" /></label>
          <button class="s-btn-small" @click="previewSize">👁 预览</button>
          <button class="s-btn-small s-btn-reset" @click="restoreDefaultSize">↺ 默认</button>
        </div>
      </div>

      <!-- 快捷键 -->
      <div class="s-section">
        <div class="s-label">⌨ 快捷键 <span class="s-tag-save">即时生效</span></div>
        <div class="shortcut-area">
          <span class="shortcut-display">{{ shortcutDisplay }}</span>
          <button class="s-btn-small" :class="{ recording }" @click="startRecording">
            {{ recording ? "按下组合键..." : "录制" }}
          </button>
        </div>
      </div>

      <!-- 音效选择 -->
      <div class="s-section">
        <div class="s-label">🔊 音效选择 <span class="s-tag-save">即时生效</span></div>
        <div class="s-hint">每个事件可独立选择音效，选"关闭"则静音</div>
        <div class="sound-list">
          <div v-for="ev in soundEvents" :key="ev.key" class="sound-row">
            <span class="sound-name">{{ ev.label }}</span>
            <div class="sound-actions">
              <select
                class="s-input sound-select"
                :value="assignments[ev.key] || ev.defaultSoundId"
                @change="selectSound(ev.key, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="s in soundLibrary" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
              <button class="s-btn-small" @click="previewSound(ev.key)">▶</button>
            </div>
          </div>
          <div class="s-hint" style="margin-top:8px">
            <button class="s-btn-small s-btn-reset" @click="restoreSoundDefaults">↺ 恢复默认</button>
          </div>
        </div>
      </div>

    </div>

    <div id="s-foot">
      <div v-if="saved" class="s-saved-msg">✅ 已保存！所有设置即时生效</div>
      <button class="s-btn" @click="doCancel">取消</button>
      <button class="s-btn s-btn-primary" @click="doSave">💾 保存设置</button>
    </div>
  </div>
</template>

<style scoped>
* { margin: 0; padding: 0; box-sizing: border-box; }
#s-root {
  width: 100%; height: 100%;
  display: flex;
  flex-direction: column;
  background: #3e1a2e;
  color: #f0e0f0;
  font-family: "zpix", "pixel-mplus", sans-serif;
  font-size: 11px;
  overflow: hidden;
}
#s-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #4a2540;
  border-bottom: 1px solid #5a3050;
  color: #f0a0c0;
  font-size: 13px;
  flex-shrink: 0;
  user-select: none;
}
#s-head .s-hint { flex: 1; font-size: 9px; color: #8a6080; }
.s-close {
  background: none; border: none;
  color: #f0a0c0; cursor: pointer;
  font-size: 14px; padding: 2px 6px;
}
.s-close:hover { color: #fff; }
#s-body {
  flex: 1; overflow-y: auto;
  padding: 8px; display: flex;
  flex-direction: column; gap: 6px;
}
.s-section {
  background: #2a1020;
  border: 1px solid #4a3050;
  border-radius: 6px; padding: 8px;
}
.s-label { color: #f0a0c0; font-size: 12px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.s-tag { font-size: 8px; background: #6a3050; color: #f0a0c0; padding: 1px 5px; border-radius: 6px; white-space: nowrap; }
.s-tag-save { font-size: 8px; background: #2a6040; color: #a0f0c0; padding: 1px 5px; border-radius: 6px; white-space: nowrap; }
.s-hint { color: #8a6080; font-size: 10px; margin-top: 4px; }
.s-field { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.s-field-inline { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.s-field-inline label { color: #f0e0f0; font-size: 11px; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.s-field-col { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
.s-fname { color: #8a6080; font-size: 10px; min-width: 50px; flex-shrink: 0; }
.s-input {
  flex: 1; min-width: 0;
  background: #1a0a12; border: 1px solid #5a3050;
  border-radius: 4px; color: #f0e0f0;
  padding: 2px 6px; font-size: 11px; font-family: inherit;
}
.s-input:focus { border-color: #c4276f; outline: none; }
.s-textarea { resize: vertical; min-height: 36px; }
.s-input-num { width: 64px; text-align: center; }
.s-btn-mini {
  padding: 1px 6px; font-size: 10px;
  background: #5a3050; border: 1px solid #6a4060;
  border-radius: 8px; color: #f0e0f0;
  cursor: pointer; font-family: inherit; flex-shrink: 0;
}
.s-btn-mini:hover { background: #6a4060; }
.s-btn-small {
  padding: 2px 8px; font-size: 10px;
  background: #6a3050; color: #f0a0c0;
  border: 1px solid #8a5070; border-radius: 10px;
  cursor: pointer; font-family: inherit; white-space: nowrap; flex-shrink: 0;
}
.s-btn-small:hover { background: #8a4070; }
.s-btn-small:disabled { opacity: 0.3; cursor: default; }
.s-btn-small.recording { background: #c4276f; color: #fff; animation: pulse-rec 0.8s ease infinite; }
.s-btn-reset { background: #5a3050; color: #8a6080; border-color: #6a4060; }
.s-btn-reset:hover { background: #6a4060; color: #f0a0c0; }
@keyframes pulse-rec { 0%,100%{opacity:1} 50%{opacity:0.5} }
.shortcut-area { display: flex; align-items: center; gap: 6px; }
.shortcut-display {
  color: #f0e0f0; font-size: 12px;
  background: #1a0a12; padding: 3px 10px;
  border-radius: 4px; border: 1px solid #5a3050; font-family: monospace;
}
.radio-group { display: flex; flex-direction: column; gap: 4px; }
.radio-item { display: flex; align-items: center; gap: 6px; color: #f0e0f0; font-size: 11px; cursor: pointer; }
.radio-item input { accent-color: #c4276f; }
.size-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.size-row label { color: #f0e0f0; font-size: 11px; display: flex; align-items: center; gap: 4px; }
.size-x { color: #f0a0c0; }
.sound-list { display: flex; flex-direction: column; gap: 6px; }
.sound-row { display: flex; align-items: center; justify-content: space-between; }
.sound-name { color: #f0e0f0; font-size: 11px; min-width: 70px; flex-shrink: 0; }
.sound-actions { display: flex; align-items: center; gap: 6px; }
.sound-select { min-width: 100px; width: auto; flex: 0; }
select.s-input { cursor: pointer; }
#s-foot {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding: 8px 12px;
  background: #4a2540; border-top: 1px solid #5a3050; flex-shrink: 0;
}
.s-saved-msg { flex: 1; color: #a0f0c0; font-size: 10px; }
.s-btn {
  padding: 4px 14px; font-size: 11px;
  background: #5a3050; color: #f0e0f0;
  border: 1px solid #6a4060; border-radius: 12px;
  cursor: pointer; font-family: inherit;
}
.s-btn:hover { background: #6a4060; }
.s-btn-primary { background: #c4276f; border-color: #c4276f; }
.s-btn-primary:hover { background: #e84a8a; }
</style>
