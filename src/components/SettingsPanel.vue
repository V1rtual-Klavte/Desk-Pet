<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  userConfig, aiConfig, windowMonitorConfig, aiLockConfig,
  memoryConfig, desktopConfig, loggingConfig, personalityConfig,
  modeConfig, loopConfig,
  setOverrides, clearOverrides,
} from "@/services/config";
import { debug, refreshToolStats } from "@/services/debug";
import {
  getSoundLibrary, getSoundAssignments, saveSoundAssignments,
  soundEvents,
  type SoundDef,
} from "@/services/audio/registry";
import { listPersonalities, switchPersonality, setPersonalityEnabled } from "@/services/personality";
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

// ── 模式 ──
const assistantMode = ref(modeConfig.assistant);

// ── AI 配置字段 ──
const aiEndpoint = ref(aiConfig.endpoint);
const aiApiKey = ref(aiConfig.apiKey);
const aiModel = ref(aiConfig.model);
const aiContextMaxTokens = ref(aiConfig.contextMaxTokens);
const aiSystemPrompt = ref(aiConfig.defaultSystemPrompt);
const showApiKey = ref(false);

// ── 窗口监控 ──
const wmEnabled = ref(windowMonitorConfig.enabled);
const wmStaySeconds = ref(windowMonitorConfig.staySeconds);
const wmSettleMs = ref(windowMonitorConfig.settleMs);
const wmCooldownSec = ref(windowMonitorConfig.cooldownSeconds);
const wmSamePageCool = ref(windowMonitorConfig.samePageCooldownSeconds);

// ── AI 锁 ──
const lockTimeout = ref(aiLockConfig.safetyTimeoutMs);

// ── 记忆 ──
const memMax = ref(memoryConfig.maxEntries);
const candyInstructions = ref("");
const memStatus = ref<{ count: number; lastConsolidation: string; mode: string; sessionTurns?: number; sessionId?: string; projectCount?: number }>({
  count: 0,
  lastConsolidation: "从未",
  mode: modeConfig.assistant ? "助手(LLM)" : "轻量(去重)",
});

// ── 桌面 ──
const deskPoll = ref(desktopConfig.pollingIntervalMs);
const deskPause = ref(desktopConfig.pauseExtraMs);
const deskWait = ref(desktopConfig.waitTimeoutMs);

// ── 日志 ──
const logLevel = ref(loggingConfig.level);

// ── 人格 ──
const personalityEnabled = ref(personalityConfig.enabled);
const personalityActive = ref(personalityConfig.active);
const availablePersonalities = ref(listPersonalities());

// ── 用户设置 ──
const popupMode = ref(userConfig.popupMode);
const autoPopup = ref(userConfig.autoPopupOnMessage);
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
  userConfig.autoPopupOnMessage = autoPopup.value;
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
    "ai.contextMaxTokens": aiContextMaxTokens.value,
    "ai.defaultSystemPrompt": aiSystemPrompt.value,
    "personality.enabled": personalityEnabled.value,
    "personality.active": personalityActive.value,
    "windowMonitor.enabled": wmEnabled.value,
    "windowMonitor.staySeconds": wmStaySeconds.value,
    "windowMonitor.settleMs": wmSettleMs.value,
    "windowMonitor.cooldownSeconds": wmCooldownSec.value,
    "windowMonitor.samePageCooldownSeconds": wmSamePageCool.value,
    "aiLock.safetyTimeoutMs": lockTimeout.value,
    "memory.maxEntries": memMax.value,
    "desktop.pollingIntervalMs": deskPoll.value,
    "desktop.pauseExtraMs": deskPause.value,
    "desktop.waitTimeoutMs": deskWait.value,
    "logging.level": logLevel.value,
    "mode.assistant": assistantMode.value,
  });

  // 人格配置即时生效
  setPersonalityEnabled(personalityEnabled.value);
  switchPersonality(personalityEnabled.value ? personalityActive.value : null);

  // 保存 CANDY.md 指令
  if (candyInstructions.value.trim()) {
    const { MemoryService } = await import("@/services/agent/memory");
    await MemoryService.updateCandy(candyInstructions.value.trim());
  }

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

  // 加载记忆状态
  try {
    const { MemoryService } = await import("@/services/agent/memory");
    await MemoryService.init();
    const sm = MemoryService.session;
    memStatus.value = {
      count: MemoryService.count,
      projectCount: MemoryService.projectCount,
      lastConsolidation: sm?.compactionSummary ? "已压缩" : "运行中",
      mode: assistantMode.value ? "助手(LLM)" : "轻量(去重)",
      sessionTurns: sm?.turns.length ?? 0,
      sessionId: sm?.sessionId ?? "",
    };
    const candy = MemoryService.getCandyInstructionsSync();
    if (candy) {
      candyInstructions.value = candy.replace(/^[\s\S]*?指令\]\n/, "").trim();
    }
  } catch { /* ignore */ }

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
          <span class="s-fname">上下文上限</span>
          <input class="s-input s-input-num" type="number" v-model.number="aiContextMaxTokens" style="width:80px" />
          <span class="s-unit">tokens</span>
        </div>
        <div class="s-field-col">
          <span class="s-fname">默认人格</span>
          <textarea class="s-input s-textarea" v-model="aiSystemPrompt" rows="2"></textarea>
        </div>
      </div>

      <!-- 模式 -->
      <div class="s-section">
        <div class="s-label">⚙️ 模式切换 <span class="s-tag">需重启</span></div>
        <div class="s-field-inline" style="margin-bottom:6px">
          <label class="radio-item">
            <input type="checkbox" v-model="assistantMode" />
            <span>助手模式</span>
            <span class="s-hint" style="display:inline">— 开启后解锁写文件、全量命令、MCP、Skill 等高级能力</span>
          </label>
        </div>
        <div class="s-hint" style="margin-left:22px">
          当前模式: {{ assistantMode ? '🔓 助手模式 (完整工具集)' : '🔒 轻量模式 (基础工具)' }}
          <br/>轻量模式包含: 读文件、列目录、搜索文件、系统信息、Bash白名单、网页获取
        </div>
      </div>

      <!-- 人格选择 -->
      <div class="s-section">
        <div class="s-label">🎭 人格切换 <span class="s-tag">即时生效</span></div>
        <div class="s-field-inline" style="margin-bottom:6px">
          <label class="radio-item">
            <input type="checkbox" v-model="personalityEnabled" />
            <span>启用人格系统（关闭则使用默认人格）</span>
          </label>
        </div>
        <div v-if="personalityEnabled" class="radio-group">
          <label v-for="p in availablePersonalities" :key="p.id" class="radio-item">
            <input type="radio" v-model="personalityActive" :value="p.id" />
            <span>{{ p.name }} <span class="s-hint" style="display:inline">— {{ p.description }}</span></span>
          </label>
        </div>
        <div v-else class="s-hint">
          人格系统已关闭，所有回复使用上方"默认人格"设定
        </div>
      </div>

      <!-- 窗口监控 -->
      <div class="s-section">
        <div class="s-label">👁 窗口监控 <span class="s-tag">即时生效</span></div>
        <div class="s-field-inline" style="margin-bottom:4px">
          <label class="radio-item">
            <input type="checkbox" v-model="wmEnabled" />
            <span>启用窗口监控（停留触发 AI 主动搭话）</span>
          </label>
        </div>
        <div class="s-field-inline">
          <label>停留触发 <input class="s-input-num" type="number" v-model.number="wmStaySeconds" /> 秒</label>
          <label>防抖 <input class="s-input-num" type="number" v-model.number="wmSettleMs" /> ms</label>
        </div>
        <div class="s-field-inline">
          <label>全局冷却 <input class="s-input-num" type="number" v-model.number="wmCooldownSec" /> 秒</label>
          <label>同页冷却 <input class="s-input-num" type="number" v-model.number="wmSamePageCool" /> 秒</label>
        </div>
      </div>

      <!-- AI 并发锁 -->
      <div class="s-section">
        <div class="s-label">🔒 AI 并发锁 <span class="s-tag">即时生效</span></div>
        <div class="s-field-inline">
          <label>锁超时 <input class="s-input-num" type="number" v-model.number="lockTimeout" /> ms</label>
        </div>
      </div>

      <!-- 记忆系统 -->
      <div class="s-section">
        <div class="s-label">🧠 长期记忆 <span class="s-tag">即时生效</span></div>
        <div class="s-field-inline">
          <label>记忆上限 <input class="s-input-num" type="number" v-model.number="memMax" min="10" max="1000" /> 条</label>
        </div>
        <div class="s-field-row">
          <span class="s-fname">存储结构</span>
          <span class="s-mono">memory/MEMORY.md → 长期记忆文件 (CANDY/User/Outside)</span>
        </div>
        <div class="s-field-row">
          <span class="s-fname">会话归档</span>
          <span class="s-mono">sessions/ ← Project.md 指针索引</span>
        </div>
        <div class="s-field-row">
          <span class="s-fname">当前条目</span>
          <span>{{ memStatus.count }} 条 长期记忆</span>
          <span class="s-unit">| 归档: {{ memStatus.projectCount ?? 0 }} 个 | 会话: {{ memStatus.sessionTurns ?? 0 }} 轮</span>
        </div>
        <div class="s-field-row">
          <span class="s-fname">会话ID</span>
          <span class="s-mono">{{ memStatus.sessionId?.substring(0, 30) || "—" }}…</span>
          <span class="s-unit">| {{ memStatus.lastConsolidation }}</span>
        </div>
        <div class="s-field-col">
          <span class="s-fname">用户指令 (CANDY.md)</span>
          <textarea
            class="s-input s-textarea s-mono"
            v-model="candyInstructions"
            rows="2"
            placeholder="例如：叫我小明、用日语回复、喜欢简短回答..."
          ></textarea>
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
        <div class="s-field-inline" style="margin-top:6px">
          <label class="radio-item">
            <input type="checkbox" v-model="autoPopup" />
            <span>收到新消息时自动弹出窗口</span>
          </label>
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

      <!-- 工具 / MCP / Skill 预览 -->
      <div class="s-section">
        <div class="s-label">🔧 已注册工具 / MCP / Skill <span class="s-tag">只读</span></div>
        <div class="s-hint" style="margin-bottom:4px">
          轻量: {{ debug.registeredTools.filter(t => t.mode !== 'assistant').length }} 个 |
          助手: {{ debug.registeredTools.filter(t => t.mode === 'assistant').length }} 个 |
          MCP: {{ debug.registeredMcpCount }} | Skill: {{ debug.registeredSkillCount }}
        </div>
        <div class="tool-preview-list">
          <div
            v-for="t in debug.registeredTools"
            :key="t.name"
            class="tool-preview-item"
            :class="'src-' + t.source"
          >
            <span class="tool-preview-src">{{ t.source }}</span>
            <span class="tool-preview-name">{{ t.name }}</span>
            <span class="tool-preview-mode">{{ t.mode === 'assistant' ? '🔓' : '🔒' }}</span>
          </div>
        </div>
        <div class="s-field-inline" style="margin-top:4px">
          <button class="s-btn-small" @click="refreshToolStats()">🔄 刷新</button>
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
.s-mono { font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace; font-size: 10px; }
.s-unit {
  font-size: 10px;
  color: #8a6a8a;
  white-space: nowrap;
}
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

/* ── 工具预览 ── */
.tool-preview-list {
  max-height: 200px; overflow-y: auto;
  background: #2a1018; border-radius: 6px;
  padding: 4px; font-size: 10px;
}
.tool-preview-item {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 6px; color: #c0a0b0;
}
.tool-preview-item.src-mcp { color: #f0c060; }
.tool-preview-item.src-skill { color: #60f0a0; }
.tool-preview-src {
  color: #705060; font-size: 9px; min-width: 28px;
}
.tool-preview-name { flex: 1; font-size: 10px; }
.tool-preview-mode { font-size: 10px; }
</style>
