<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  userConfig, aiConfig, windowMonitorConfig, aiLockConfig,
  memoryConfig, desktopConfig, loggingConfig, personalityConfig,
  modeConfig, loopConfig, toolsConfig, safetyConfig,
  setOverrides, setOverride, clearOverrides, getAllOverrides,
} from "@/services/config";
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
const aiThinkingEffort = ref(aiConfig.thinkingEffort);

// ── 安全 ──
const safetyMode = ref(safetyConfig.mode as string);
const sessionTrustEnabled = ref(safetyConfig.sessionTrustEnabled);

const aiRequireApiKey = ref(aiConfig.requireApiKey);
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
const popupDefaultSize = { w: 730, h: 450 };

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

// ── 工具配置 ──
const bashWhitelist = ref(toolsConfig.bashWhitelist.join("\n"));
const fileWriteEnabled = ref(toolsConfig.fileWriteEnabled);

// ── MCP 配置 ──
const mcpEnabled = ref(toolsConfig.mcpEnabled);
const mcpServerList = ref<{ name: string; transport: string; command: string; args: string; url: string; enabled: boolean }[]>([]);
const editingMcpIdx = ref(-1);
const mcpForm = ref({ name: "", transport: "stdio", command: "", args: "", url: "", enabled: true });

// ── 内置 MCP ──
const builtinMcpList = ref<{ name: string; enabled: boolean; args: string; description: string; envStr: string }[]>([]);
const editingBuiltinIdx = ref(-1);

async function loadBuiltinMcpConfig() {
  const raw = toolsConfig.builtinMcpServers as Record<string, any>
  if (!raw || typeof raw !== "object") { builtinMcpList.value = []; return }
  builtinMcpList.value = Object.entries(raw).map(([name, def]: [string, any]) => ({
    name,
    enabled: def.enabled !== false,
    args: Array.isArray(def.args) ? def.args.join(" ") : (def.args ? String(def.args) : ""),
    description: def.description ?? name,
    envStr: def.env ? Object.entries(def.env).map(([k,v]) => `${k}=${v}`).join("\n") : "",
  }))
}
function toggleBuiltinMcp(idx: number) {
  builtinMcpList.value[idx].enabled = !builtinMcpList.value[idx].enabled
}
function startEditBuiltin(idx: number) {
  editingBuiltinIdx.value = idx
}
function cancelEditBuiltin() {
  editingBuiltinIdx.value = -1
}

async function loadMcpConfig() {
  // ★ 直接从 CONFIG 读取（而非 Manager 内部缓存），确保跨窗口持久化
  const servers = toolsConfig.mcpServers
  if (Array.isArray(servers) && servers.length > 0) {
    mcpServerList.value = servers.map((s: any) => ({
      name: String(s.name || ""),
      transport: s.transport === "sse" ? "sse" : "stdio",
      command: s.command ? String(s.command) : "",
      args: Array.isArray(s.args) ? s.args.join(" ") : (s.args ? String(s.args) : ""),
      url: s.url ? String(s.url) : "",
      enabled: s.enabled !== false,
    }))
  }
}
function addOrUpdateMcpServer() {
  const s = mcpForm.value;
  if (!s.name.trim()) return;
  if (editingMcpIdx.value >= 0) {
    mcpServerList.value[editingMcpIdx.value] = { ...s };
  } else {
    mcpServerList.value.push({ ...s });
  }
  mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", enabled: true };
  editingMcpIdx.value = -1;
}
function editMcpServer(idx: number) {
  editingMcpIdx.value = idx;
  mcpForm.value = { ...mcpServerList.value[idx] };
}
function removeMcpServer(idx: number) {
  mcpServerList.value.splice(idx, 1);
  if (editingMcpIdx.value === idx) { editingMcpIdx.value = -1; mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", enabled: true }; }
}
function cancelMcpEdit() {
  editingMcpIdx.value = -1;
  mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", enabled: true };
}
async function importMcpJson() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { importMcpServersFromJson } = await import("@/services/tool/mcp/manager");
    const result = importMcpServersFromJson(text);
    if (result.success) {
      await loadMcpConfig();
      log.info("MCP 配置已导入:", result.count, "个服务器");
    } else {
      log.warn("MCP 导入失败:", result.error);
    }
  };
  input.click();
}
async function exportMcpJson() {
  const { exportMcpServersToJson } = await import("@/services/tool/mcp/manager");
  const json = exportMcpServersToJson();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "mcp-servers.json"; a.click();
  URL.revokeObjectURL(url);
}

// ── Skill 配置 ──
const skillEnabled = ref(toolsConfig.skillEnabled);
const skillList = ref<{ id: string; name: string; description: string; keywords: string }[]>([]);

async function loadSkillConfig() {
  const { getLoadedSkills } = await import("@/services/tool/skill/loader");
  skillList.value = getLoadedSkills().map(s => ({
    id: s.meta.id,
    name: s.meta.name,
    description: s.meta.description,
    keywords: (s.meta.trigger_keywords ?? []).join(", "),
  }));
}

// ── MCP 测试连接 ──
const mcpTesting = ref(false)
const mcpTestResult = ref("")
async function testMcpConnection() {
  const s = mcpForm.value
  if (!s.name.trim() || !s.command.trim()) {
    mcpTestResult.value = "❌ 请先填写名称和命令"
    return
  }
  mcpTesting.value = true
  mcpTestResult.value = "⏳ 连接中..."
  try {
    const { connectMcpServer } = await import("@/services/tool/mcp/manager")
    const result = await connectMcpServer({
      name: s.name.trim(),
      transport: s.transport as "stdio" | "sse",
      command: s.command.trim(),
      args: s.args.trim() ? s.args.trim().split(/\s+/) : [],
      url: s.url.trim() || undefined,
      enabled: s.enabled,
    })
    if (result.success) {
      mcpTestResult.value = `✅ 连接成功！发现 ${result.toolCount} 个工具`
    } else {
      mcpTestResult.value = `❌ 连接失败: ${result.error || "未知错误"}`
    }
  } catch (e) {
    mcpTestResult.value = `❌ 异常: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    mcpTesting.value = false
  }
}

async function removeSkill(skillId: string) {
  const { removeSkill: doRemove } = await import("@/services/tool/skill/loader");
  doRemove(skillId);
  await loadSkillConfig();
}
async function uploadSkillMd() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { addSkillFromMarkdown } = await import("@/services/tool/skill/loader");
    const skill = addSkillFromMarkdown(text);
    if (skill) {
      await loadSkillConfig();
      log.info("Skill 已上传:", skill.meta.name);
    } else {
      log.warn("Skill 上传失败: frontmatter 解析失败");
    }
  };
  input.click();
}

// ── 重启应用 ──
async function restartApp() {
  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow")
    const windows = await getAllWebviewWindows()
    for (const w of windows) {
      try { w.close() } catch { /* ignore */ }
    }
  } catch { /* fallback: just close current */ }
  win.close().catch(() => {})
}

// ── CONFIG 导入导出 ──
async function exportConfigYaml() {
  try {
    const jsYaml = await import("js-yaml");
    const overrides = getAllOverrides();
    const yamlStr = jsYaml.dump(overrides, { lineWidth: -1, noRefs: true });
    const blob = new Blob([yamlStr], { type: "application/x-yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "deskpet-config-export.yaml";
    a.click();
    URL.revokeObjectURL(url);
    log.info("CONFIG 已导出");
  } catch (e) {
    log.error("导出失败", e);
  }
}
async function importConfigYaml() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".yaml,.yml";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(text) as Record<string, any>;
      if (!parsed || typeof parsed !== "object") {
        log.warn("导入失败: 无效的 YAML 格式");
        return;
      }
      // 扁平化 key → 应用为覆盖值
      const flat: Record<string, any> = {};
      function flatten(obj: any, prefix: string) {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k;
          if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            flatten(v, key);
          } else {
            flat[key] = v;
          }
        }
      }
      flatten(parsed, "");
      setOverrides(flat);
      log.info("CONFIG 已导入:", Object.keys(flat).length, "个设置项");
      // 刷新页面以应用新配置
      location.reload();
    } catch (e) {
      log.error("导入失败", e);
    }
  };
  input.click();
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
    "ai.requireApiKey": aiRequireApiKey.value,
    "ai.model": aiModel.value,
    "ai.contextMaxTokens": aiContextMaxTokens.value,
    "ai.thinkingEffort": aiThinkingEffort.value,
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
    "safety.mode": safetyMode.value,
    "safety.sessionTrustEnabled": sessionTrustEnabled.value,
    "tools.bash.whitelist": bashWhitelist.value.split("\n").map(s => s.trim()).filter(Boolean),
    "tools.file.writeEnabled": fileWriteEnabled.value,
    "tools.mcp.enabled": mcpEnabled.value,
    "tools.skill.enabled": skillEnabled.value,
  });

  // 同步内置 MCP 配置
  const builtinRaw = toolsConfig.builtinMcpServers as Record<string, any>
  if (builtinRaw && typeof builtinRaw === "object") {
    const updated: Record<string, any> = {}
    for (const b of builtinMcpList.value) {
      const original = builtinRaw[b.name] || {}
      const env: Record<string, string> = {}
      if (b.envStr.trim()) {
        for (const line of b.envStr.trim().split("\n")) {
          const eq = line.indexOf("=")
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
        }
      }
      updated[b.name] = {
        enabled: b.enabled,
        command: original.command || "npx",
        args: b.args.trim() ? b.args.trim().split(/\s+/).filter(Boolean) : (original.args || []),
        description: original.description || "",
        ...(Object.keys(env).length > 0 || (original.env && Object.keys(original.env).length > 0) ? { env } : {}),
      }
    }
    setOverride("tools.mcp.builtin", updated)
  }

  // 同步 MCP 服务器列表到 Manager（Manager 会同步到 CONFIG 覆盖层）
  const { setMcpServers } = await import("@/services/tool/mcp/manager");
  setMcpServers(mcpServerList.value.map(s => ({
    name: s.name,
    transport: s.transport as "stdio" | "sse",
    command: s.command || undefined,
    args: s.args ? s.args.split(/\s+/).filter(Boolean) : undefined,
    url: s.url || undefined,
    enabled: s.enabled,
  })));

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

  // 加载 MCP/Skill 配置
  await loadMcpConfig();
  loadBuiltinMcpConfig();
  await loadSkillConfig();

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
          <span class="s-fname">需要密钥</span>
          <label class="radio-item">
            <input type="checkbox" v-model="aiRequireApiKey" />
            <span>关闭后可在本地 Ollama 等无密钥环境使用</span>
          </label>
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
        <div class="s-field-inline" style="margin-top:4px">
          <span class="s-fname">默认思考强度</span>
          <label v-for="lv in ['auto','low','medium','high']" :key="lv" class="radio-item">
            <input type="radio" v-model="aiThinkingEffort" :value="lv" />
            <span>{{ lv }}</span>
          </label>
        </div>
        <div class="s-hint" style="font-size:9px">
          新会话默认采用此强度。会话中可在底部仪表盘临时覆盖（仅当前会话生效）。
        </div>
      </div>

      <!-- 安全模式 -->
      <div class="s-section">
        <div class="s-label">🛡 安全控制 <span class="s-tag-save">即时生效</span></div>
        <div class="s-field-inline" style="margin-bottom:4px">
          <span class="s-fname">安全策略</span>
          <label v-for="m in [{v:'just_do_it',l:'全放行'},{v:'tell_me',l:'告知确认'},{v:'let_me_tk',l:'全部确认'}]" :key="m.v" class="radio-item">
            <input type="radio" v-model="safetyMode" :value="m.v" />
            <span>{{ m.l }}</span>
          </label>
        </div>
        <div class="s-hint" style="font-size:9px; margin-bottom:4px">
          <template v-if="safetyMode === 'just_do_it'">⚡ DANGER 工具直接放行，不弹确认窗（最宽松）</template>
          <template v-else-if="safetyMode === 'tell_me'">📋 按规则弹确认窗：NORMAL 首次确认后会话信任，DANGER 每次确认（默认）</template>
          <template v-else>🔒 所有非 SAFE 工具调用都需要确认（最严格）</template>
        </div>
        <div class="s-field-inline">
          <label class="radio-item">
            <input type="checkbox" v-model="sessionTrustEnabled" />
            <span>会话内信任 NORMAL 工具（一次确认后本会话不再询问）</span>
          </label>
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

      <!-- 工具配置 -->
      <div class="s-section">
        <div class="s-label">🔧 工具配置 <span class="s-tag">即时生效</span></div>
        <div class="s-field-col">
          <span class="s-fname">Bash 白名单（每行一个命令）</span>
          <textarea class="s-input s-textarea s-mono" v-model="bashWhitelist" rows="4" placeholder="ls&#10;cat&#10;head..."></textarea>
        </div>
        <div class="s-field-inline" style="margin-top:4px">
          <label class="radio-item">
            <input type="checkbox" v-model="fileWriteEnabled" :disabled="!assistantMode" />
            <span>允许写文件（仅助手模式）</span>
          </label>
        </div>
        <div class="s-hint" style="margin-top:4px">
          Bash 白名单 {{ bashWhitelist.split('\n').filter(l => l.trim()).length }} 个命令
          | 文件写: {{ fileWriteEnabled ? '✅' : '❌' }}
        </div>
      </div>

      <!-- MCP 配置 -->
      <div class="s-section">
        <div class="s-label">🔌 MCP 配置 <span class="s-tag">需重启</span></div>
        <div class="s-field-inline" style="margin-bottom:6px">
          <label class="radio-item">
            <input type="checkbox" v-model="mcpEnabled" :disabled="!assistantMode" />
            <span>启用 MCP 服务（仅助手模式）</span>
          </label>
        </div>
        <div class="s-hint">
          内置 {{ builtinMcpList.length }} + 自定义 {{ mcpServerList.length }} 个服务器
          <span v-if="!mcpEnabled"> | ⚠️ 未启用（需开启开关+重启）</span>
        </div>

        <!-- 内置 MCP -->
        <div class="s-field-row" style="margin-top:6px; justify-content:space-between">
          <span class="s-fname">📦 内置 MCP</span>
          <button class="s-btn-small" @click="loadBuiltinMcpConfig()">🔄 刷新</button>
        </div>
        <div class="tool-preview-list" style="margin-bottom:6px">
          <div v-for="(b, i) in builtinMcpList" :key="b.name" class="tool-preview-item" style="justify-content:space-between; align-items:center">
            <span style="display:flex; gap:6px; align-items:center">
              <span class="tool-preview-name">{{ b.description || b.name }}</span>
              <span class="s-mono" style="font-size:9px; color:#8a6080">{{ b.name }}</span>
            </span>
            <span style="display:flex; gap:4px; align-items:center">
              <button v-if="editingBuiltinIdx !== i" class="s-btn-small" :class="{ 's-btn-reset': !b.enabled }" @click="toggleBuiltinMcp(i)">
                {{ b.enabled ? '✅ 开' : '❌ 关' }}
              </button>
              <button v-if="editingBuiltinIdx !== i" class="s-btn-small" @click="startEditBuiltin(i)" style="font-size:10px">✏</button>
              <button v-if="editingBuiltinIdx === i" class="s-btn-small s-btn-reset" @click="cancelEditBuiltin()">取消</button>
            </span>
          </div>
        </div>
        <!-- 内置 MCP 编辑面板 -->
        <div v-if="editingBuiltinIdx >= 0" class="s-field-col" style="gap:3px; background:#1a0a12; padding:6px; border-radius:4px; margin-bottom:4px">
          <div class="s-field-inline">
            <span class="s-fname" style="font-size:9px">{{ builtinMcpList[editingBuiltinIdx]?.name }}</span>
          </div>
          <div class="s-field-inline">
            <label style="font-size:9px">参数</label>
            <input class="s-input" v-model="builtinMcpList[editingBuiltinIdx].args" style="width:240px;font-size:10px" placeholder="npx -y @xxx" />
          </div>
          <div class="s-field-col" style="gap:2px">
            <label style="font-size:9px">环境变量 (KEY=VALUE 每行一个)</label>
            <textarea class="s-input s-textarea s-mono" v-model="builtinMcpList[editingBuiltinIdx].envStr" rows="2" style="font-size:9px" placeholder="API_KEY=xxx"></textarea>
          </div>
        </div>

        <!-- 自定义 MCP -->
        <div class="s-field-row" style="margin-top:4px; justify-content:space-between">
          <span class="s-fname">🔧 自定义 MCP</span>
          <span style="display:flex; gap:4px">
            <button class="s-btn-small" @click="importMcpJson()">📥 导入JSON</button>
            <button class="s-btn-small" @click="exportMcpJson()">📤 导出JSON</button>
          </span>
        </div>
        <div class="tool-preview-list" style="margin-bottom:4px">
          <div v-if="mcpServerList.length === 0" class="s-hint" style="padding:4px">暂无自定义 MCP 服务器</div>
          <div v-for="(s, i) in mcpServerList" :key="i" class="tool-preview-item" style="justify-content:space-between">
            <span>
              <span class="tool-preview-name">{{ s.name }}</span>
              <span class="tool-preview-src">[{{ s.transport }}]</span>
              <span v-if="s.command" class="s-mono" style="font-size:9px; color:#8a6080">{{ s.command }}</span>
            </span>
            <span style="display:flex; gap:4px">
              <button class="s-btn-small" @click="editMcpServer(i)">✏</button>
              <button class="s-btn-small s-btn-reset" @click="removeMcpServer(i)">✕</button>
            </span>
          </div>
        </div>
        <!-- 添加/编辑表单 -->
        <div class="s-field-col" style="gap:3px; background:#1a0a12; padding:6px; border-radius:4px">
          <div class="s-field-inline">
            <label style="font-size:9px">名称</label>
            <input class="s-input" v-model="mcpForm.name" style="width:80px;font-size:10px" placeholder="server-name" />
            <label style="font-size:9px">传输</label>
            <select class="s-input sound-select" v-model="mcpForm.transport" style="font-size:10px;width:70px">
              <option value="stdio">stdio</option>
              <option value="sse">sse</option>
            </select>
          </div>
          <div class="s-field-inline" v-if="mcpForm.transport === 'stdio'">
            <label style="font-size:9px">命令</label>
            <input class="s-input" v-model="mcpForm.command" style="width:100px;font-size:10px" placeholder="npx" />
            <label style="font-size:9px">参数</label>
            <input class="s-input" v-model="mcpForm.args" style="width:120px;font-size:10px" placeholder="-y @modelcontextprotocol/server-xxx" />
          </div>
          <div class="s-field-inline" v-if="mcpForm.transport === 'sse'">
            <label style="font-size:9px">URL</label>
            <input class="s-input" v-model="mcpForm.url" style="width:200px;font-size:10px" placeholder="http://localhost:8080/sse" />
          </div>
          <div class="s-field-inline" style="gap:4px">
            <button class="s-btn-small" @click="addOrUpdateMcpServer()">{{ editingMcpIdx >= 0 ? '更新' : '添加' }}</button>
            <button v-if="editingMcpIdx >= 0" class="s-btn-small s-btn-reset" @click="cancelMcpEdit()">取消</button>
            <button class="s-btn-small" :disabled="mcpTesting" @click="testMcpConnection()">{{ mcpTesting ? '⏳' : '🔌' }} 测试</button>
          </div>
          <div v-if="mcpTestResult" class="s-hint" style="margin-top:2px">{{ mcpTestResult }}</div>
        </div>
      </div>

      <!-- Skill 配置 -->
      <div class="s-section">
        <div class="s-label">📦 Skill 配置 <span class="s-tag">需重启</span></div>
        <div class="s-field-inline" style="margin-bottom:6px">
          <label class="radio-item">
            <input type="checkbox" v-model="skillEnabled" :disabled="!assistantMode" />
            <span>启用 Skill（仅助手模式）</span>
          </label>
        </div>
        <div class="s-hint">
          已配置 {{ skillList.length }} 个 Skill
          <span v-if="!skillEnabled"> | ⚠️ 未启用（需开启开关+重启）</span>
          <button class="s-btn-small" style="margin-left:6px" @click="uploadSkillMd()">📤 上传 .md</button>
          <button class="s-btn-small" style="margin-left:4px" @click="loadSkillConfig()">🔄 刷新</button>
        </div>
        <div class="tool-preview-list">
          <div v-if="skillList.length === 0" class="s-hint" style="padding:4px">暂无 Skill</div>
          <div v-for="s in skillList" :key="s.id" class="tool-preview-item" style="justify-content:space-between">
            <span>
              <span class="tool-preview-name">{{ s.name }}</span>
              <span class="tool-preview-src">{{ s.description }}</span>
            </span>
            <span style="display:flex; gap:4px; align-items:center">
              <span class="s-hint" style="font-size:9px; margin:0">{{ s.keywords }}</span>
              <button class="s-btn-small s-btn-reset" @click="removeSkill(s.id)">✕</button>
            </span>
          </div>
        </div>
        <div class="s-hint" style="margin-top:4px">
          Skill .md 文件格式: 以 <code>---</code> 包裹 YAML frontmatter (id/name/description/trigger_keywords/tools_needed), 正文为执行步骤
        </div>
      </div>

    </div>

    <div id="s-foot">
      <span class="s-hint" style="margin-right:auto">⚠️ 标记"需重启"的设置在保存后需重启应用生效</span>
      <button class="s-btn-small" style="margin-right:4px" @click="importConfigYaml()">📥 导入</button>
      <button class="s-btn-small" style="margin-right:6px" @click="exportConfigYaml()">📤 导出</button>
      <button class="s-btn s-btn-reset" style="margin-right:6px" @click="restartApp()">🔄 重启应用</button>
      <div v-if="saved" class="s-saved-msg">✅ 已保存！</div>
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