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
import {
  listProfiles, getActiveProfile, activateProfile,
  initProfiles,
  exportProfileZip, importProfileZip, deleteProfile,
  type ProfileData,
  type ProfileThemeColors,
} from "@/services/profile";
import { listPersonalities, switchPersonality, setPersonalityEnabled } from "@/services/personality";
import { createLogger } from "@/services/logger";
import { isMacOS } from "@/services/env";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";

const log = createLogger("Settings");
const win = getCurrentWebviewWindow();

// ── Tab 控制 ──
const tabs = [
  { id: "general", label: "🏠 通用", icon: "G" },
  { id: "ai", label: "🤖 AI", icon: "A" },
  { id: "tools", label: "🔧 工具", icon: "T" },
  { id: "appearance", label: "🎨 外观", icon: "P" },
] as const;
const activeTab = ref<"general"|"ai"|"tools"|"appearance">("general");

// ═══════════════════════════════════
// General tab
// ═══════════════════════════════════
const assistantMode = ref(modeConfig.assistant);
const popupMode = ref(userConfig.popupMode);
const autoPopup = ref(userConfig.autoPopupOnMessage);
const popupW = ref(userConfig.popupSize.w);
const popupH = ref(userConfig.popupSize.h);
const popupDefaultSize = { w: 730, h: 450 };
const logLevel = ref(loggingConfig.level);
const deskPoll = ref(desktopConfig.pollingIntervalMs);
const deskPause = ref(desktopConfig.pauseExtraMs);
const deskWait = ref(desktopConfig.waitTimeoutMs);

// 快捷键
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
function startRecording() { recording.value = true; recKey.value = ""; recMods.value = []; }
function onKeyDown(e: KeyboardEvent) {
  if (!recording.value) return;
  e.preventDefault(); e.stopPropagation();
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;
  recKey.value = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  recMods.value = [];
  if (e.ctrlKey) recMods.value.push("Control");
  if (e.metaKey) recMods.value.push("Command");
  if (e.altKey) recMods.value.push("Alt");
  if (e.shiftKey && e.key !== "Shift") recMods.value.push("Shift");
  recording.value = false;
}

// 位置
const displayPos = ref<{ x: number; y: number } | null>(userConfig.fixedPosition);

// ═══════════════════════════════════
// AI tab
// ═══════════════════════════════════
const aiEndpoint = ref(aiConfig.endpoint);
const aiApiKey = ref(aiConfig.apiKey);
const aiModel = ref(aiConfig.model);
const aiContextMaxTokens = ref(aiConfig.contextMaxTokens);
const aiSystemPrompt = ref(aiConfig.defaultSystemPrompt);
const showApiKey = ref(false);
const aiThinkingEffort = ref(aiConfig.thinkingEffort);
const aiStreamEnabled = ref(loopConfig.streamEnabled);
const aiRequireApiKey = ref(aiConfig.requireApiKey);
const safetyMode = ref(safetyConfig.mode as string);
const sessionTrustEnabled = ref(safetyConfig.sessionTrustEnabled);

const wmEnabled = ref(windowMonitorConfig.enabled);
const wmStaySeconds = ref(windowMonitorConfig.staySeconds);
const wmSettleMs = ref(windowMonitorConfig.settleMs);
const wmCooldownSec = ref(windowMonitorConfig.cooldownSeconds);
const wmSamePageCool = ref(windowMonitorConfig.samePageCooldownSeconds);
const lockTimeout = ref(aiLockConfig.safetyTimeoutMs);
const memMax = ref(memoryConfig.maxEntries);

const personalityEnabled = ref(personalityConfig.enabled);
const personalityActive = ref(personalityConfig.active);
const availablePersonalities = ref(listPersonalities());

// 记忆状态
const candyInstructions = ref("");
const memStatus = ref<{ count: number; lastConsolidation: string; mode: string; sessionTurns?: number; sessionId?: string; projectCount?: number }>({
  count: 0, lastConsolidation: "从未",
  mode: modeConfig.assistant ? "助手(LLM)" : "轻量(去重)",
});

// ═══════════════════════════════════
// Tools tab
// ═══════════════════════════════════
const bashWhitelist = ref(toolsConfig.bashWhitelist.join("\n"));
const fileWriteEnabled = ref(toolsConfig.fileWriteEnabled);
const mcpEnabled = ref(toolsConfig.mcpEnabled);
const mcpServerList = ref<{ name: string; transport: string; command: string; args: string; url: string; enabled: boolean }[]>([]);
const editingMcpIdx = ref(-1);
const mcpForm = ref({ name: "", transport: "stdio", command: "", args: "", url: "", enabled: true });
const builtinMcpList = ref<{ name: string; enabled: boolean; args: string; description: string; envStr: string }[]>([]);
const editingBuiltinIdx = ref(-1);

const skillEnabled = ref(toolsConfig.skillEnabled);
const skillList = ref<{ id: string; name: string; description: string; keywords: string }[]>([]);
const mcpTesting = ref(false);
const mcpTestResult = ref("");

async function loadBuiltinMcpConfig() {
  const raw = toolsConfig.builtinMcpServers as Record<string, any>;
  if (!raw || typeof raw !== "object") { builtinMcpList.value = []; return; }
  builtinMcpList.value = Object.entries(raw).map(([name, def]: [string, any]) => ({
    name, enabled: def.enabled !== false,
    args: Array.isArray(def.args) ? def.args.join(" ") : (def.args ? String(def.args) : ""),
    description: def.description ?? name,
    envStr: def.env ? Object.entries(def.env).map(([k,v]) => `${k}=${v}`).join("\n") : "",
  }));
}
function toggleBuiltinMcp(idx: number) { builtinMcpList.value[idx].enabled = !builtinMcpList.value[idx].enabled; }
function startEditBuiltin(idx: number) { editingBuiltinIdx.value = idx; }
function cancelEditBuiltin() { editingBuiltinIdx.value = -1; }

async function loadMcpConfig() {
  const servers = toolsConfig.mcpServers;
  if (Array.isArray(servers) && servers.length > 0) {
    mcpServerList.value = servers.map((s: any) => ({
      name: String(s.name || ""),
      transport: s.transport === "sse" ? "sse" : "stdio",
      command: s.command ? String(s.command) : "",
      args: Array.isArray(s.args) ? s.args.join(" ") : (s.args ? String(s.args) : ""),
      url: s.url ? String(s.url) : "",
      enabled: s.enabled !== false,
    }));
  }
}
function addOrUpdateMcpServer() {
  const s = mcpForm.value;
  if (!s.name.trim()) return;
  if (editingMcpIdx.value >= 0) { mcpServerList.value[editingMcpIdx.value] = { ...s }; }
  else { mcpServerList.value.push({ ...s }); }
  mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", enabled: true };
  editingMcpIdx.value = -1;
}
function editMcpServer(idx: number) { editingMcpIdx.value = idx; mcpForm.value = { ...mcpServerList.value[idx] }; }
function removeMcpServer(idx: number) { mcpServerList.value.splice(idx, 1); if (editingMcpIdx.value === idx) cancelMcpEdit(); }
function cancelMcpEdit() { editingMcpIdx.value = -1; mcpForm.value = { name: "", transport: "stdio", command: "", args: "", url: "", enabled: true }; }
async function importMcpJson() {
  const input = document.createElement("input"); input.type = "file"; input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return;
    const text = await file.text();
    const { importMcpServersFromJson } = await import("@/services/tool/mcp/manager");
    importMcpServersFromJson(text);
    await loadMcpConfig();
  };
  input.click();
}
async function exportMcpJson() {
  const { exportMcpServersToJson } = await import("@/services/tool/mcp/manager");
  const blob = new Blob([exportMcpServersToJson()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "mcp-servers.json"; a.click();
  URL.revokeObjectURL(url);
}
async function testMcpConnection() {
  const s = mcpForm.value;
  if (!s.name.trim() || !s.command.trim()) { mcpTestResult.value = "❌ 请先填写名称和命令"; return; }
  mcpTesting.value = true; mcpTestResult.value = "⏳ 连接中...";
  try {
    const { connectMcpServer } = await import("@/services/tool/mcp/manager");
    const r = await connectMcpServer({ name: s.name.trim(), transport: s.transport as "stdio"|"sse", command: s.command.trim(), args: s.args.trim() ? s.args.trim().split(/\s+/) : [], url: s.url.trim() || undefined, enabled: s.enabled });
    mcpTestResult.value = r.success ? `✅ 连接成功！${r.toolCount} 个工具` : `❌ 失败: ${r.error}`;
  } catch (e: any) { mcpTestResult.value = `❌ 异常: ${e.message || e}`; }
  mcpTesting.value = false;
}
async function loadSkillConfig() {
  const { getLoadedSkills } = await import("@/services/tool/skill/loader");
  skillList.value = getLoadedSkills().map(s => ({ id: s.meta.id, name: s.meta.name, description: s.meta.description, keywords: (s.meta.trigger_keywords ?? []).join(", ") }));
}
async function removeSkill(skillId: string) { const { removeSkill: doRemove } = await import("@/services/tool/skill/loader"); doRemove(skillId); await loadSkillConfig(); }
async function uploadSkillMd() {
  const input = document.createElement("input"); input.type = "file"; input.accept = ".md";
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return;
    const text = await file.text();
    const { addSkillFromMarkdown } = await import("@/services/tool/skill/loader");
    addSkillFromMarkdown(text); await loadSkillConfig();
  };
  input.click();
}

// ═══════════════════════════════════
// Appearance tab — 精简版
// ═══════════════════════════════════
const soundLibrary = ref<SoundDef[]>(getSoundLibrary());
const assignments = ref<Record<string, string>>(getSoundAssignments());

function previewSound(eventKey: string) {
  const soundId = assignments.value[eventKey];
  if (soundId && soundId !== "none") {
    const s = soundLibrary.value.find(s => s.id === soundId);
    if (s) s.play();
  }
}
function selectSound(eventKey: string, soundId: string) { assignments.value[eventKey] = soundId; }
function restoreSoundDefaults() {
  for (const ev of soundEvents) assignments.value[ev.key] = ev.defaultSoundId;
}

// ── Profile ──
const profileList = ref<{ id: string; meta: { name: string; description: string; builtin: boolean; preset?: string } }[]>([]);
const activeProfileId = ref("");
const profileDetail = ref<ProfileData | null>(null);

async function refreshProfileList() {
  const { discoverAllProfiles, ensureProfileLoaded } = await import("@/services/profile");
  const ids = await discoverAllProfiles();
  const list: any[] = [];
  for (const id of ids) {
    const p = await ensureProfileLoaded(id);
    if (p) list.push({ id: p.id, meta: p.meta });
  }
  profileList.value = list;
  const active = getActiveProfile();
  activeProfileId.value = active?.id || "";
  profileDetail.value = active;
  initColorEditor();
}
async function switchProfile(id: string) {
  const { ensureProfileLoaded } = await import("@/services/profile");
  await ensureProfileLoaded(id);
  if (activateProfile(id)) {
    activeProfileId.value = id;
    profileDetail.value = getActiveProfile();
    setOverride("appearance.activeProfile", id);
    initColorEditor();
    initFontEditor();
  }
}
async function doExportProfile() {
  if (!activeProfileId.value) return;
  try { await exportProfileZip(activeProfileId.value); } catch (e: any) { log.error("导出失败:", e); }
}
async function doImportProfile() {
  const input = document.createElement("input"); input.type = "file"; input.accept = ".zip";
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      const result = await importProfileZip(file);
      if (result.success) { await refreshProfileList(); }
      else { log.warn("导入失败:", result.error); }
    } catch (e: any) { log.error("导入异常:", e); }
  };
  input.click();
}
async function doDeleteProfile() {
  if (!activeProfileId.value) return;
  const p = getActiveProfile();
  if (p?.meta.builtin) { log.warn("内置 Profile 不可删除"); return; }
  try { await deleteProfile(activeProfileId.value); refreshProfileList(); } catch (e: any) { log.error("删除失败:", e); }
}

// ── 预设切换 ──
const presets = [
  { id: "pink", name: "🌸 粉色", desc: "默认粉色主题" },
  { id: "dark", name: "🌙 暗夜", desc: "暗色护眼主题" },
  { id: "glass", name: "🪟 玻璃", desc: "透明毛玻璃效果" },
];

async function switchPreset(presetId: string) {
  // 找到对应预设的 profile
  const presetProfile = profileList.value.find(p => p.meta.preset === presetId);
  if (presetProfile) {
    await switchProfile(presetProfile.id);
  }
}

// ── 颜色编辑（精简版）──
/** 颜色字段定义：中文标签 → yaml key */
const colorFields: { key: string; label: string }[] = [
  { key: "背景", label: "窗口背景" },
  { key: "卡片背景", label: "卡片/弹窗" },
  { key: "聊天背景", label: "聊天区域" },
  { key: "边框", label: "窗口边框" },
  { key: "分割线", label: "分割线" },
  { key: "输入边框", label: "输入框边框" },
  { key: "主文字", label: "主要文字" },
  { key: "亮文字", label: "亮色文字" },
  { key: "粉色文字", label: "高亮文字" },
  { key: "暗文字", label: "暗色文字" },
  { key: "强调色", label: "强调色" },
  { key: "强调悬浮", label: "悬浮高亮" },
  { key: "标题栏渐变起", label: "标题左色" },
  { key: "标题栏渐变止", label: "标题右色" },
  { key: "标题栏文字", label: "标题文字" },
  { key: "表面色", label: "输入区/Tab" },
  { key: "深表面色", label: "深色区域" },
  { key: "遮罩", label: "弹窗遮罩" },
];

const editedColors = ref<Record<string, string>>({});

function initColorEditor() {
  const p = getActiveProfile();
  const result: Record<string, string> = {};
  for (const f of colorFields) {
    result[f.key] = p?.theme?.colors?.[f.key as keyof ProfileThemeColors] || "";
  }
  editedColors.value = result;
}

/** 应用颜色到当前页面（热重载） */
function applyColors() {
  const root = document.getElementById("root") || document.getElementById("s-root") || document.documentElement;
  if (!root) return;
  for (const f of colorFields) {
    if (!editedColors.value[f.key]) continue;
    // 通过 injectCssVars 的映射规则手动更新
    root.style.setProperty(getCssVarName(f.key), editedColors.value[f.key]);
  }
}

/** 中文key → CSS变量名映射 */
function getCssVarName(key: string): string {
  const map: Record<string, string> = {
    "背景": "--color-bg",
    "卡片背景": "--color-settings-card",
    "聊天背景": "--color-chat-bg",
    "边框": "--color-border",
    "分割线": "--color-divider",
    "输入边框": "--color-border-input",
    "主文字": "--color-text",
    "亮文字": "--color-text-bright",
    "粉色文字": "--color-text-pink",
    "暗文字": "--color-text-muted",
    "强调色": "--color-accent",
    "强调悬浮": "--color-accent-hover",
    "标题栏渐变起": "--color-titlebar-gradient-start",
    "标题栏渐变止": "--color-titlebar-gradient-end",
    "标题栏文字": "--color-titlebar-text",
    "表面色": "--color-surface-dark",
    "深表面色": "--color-surface-darker",
    "遮罩": "--color-overlay-bg",
  };
  return map[key] || `--color-${key}`;
}

function resetColors() {
  initColorEditor();
  // 重新激活 profile 来恢复颜色
  const p = getActiveProfile();
  if (p) activateProfile(p.id);
}

/** 保存颜色到 profile.yaml */
async function saveColorsToProfile() {
  const p = getActiveProfile();
  if (!p || p.meta.builtin) { log.warn("内置 Profile 不可修改"); return; }
  try {
    const resp = await fetch(`${p.basePath}/profile.yaml`);
    if (!resp.ok) throw new Error("无法读取");
    const text = await resp.text();
    const jsYaml = await import("js-yaml");
    const doc = jsYaml.load(text) as any;
    if (!doc.theme) doc.theme = {};
    if (!doc.theme.colors) doc.theme.colors = {};
    for (const f of colorFields) {
      if (editedColors.value[f.key]) doc.theme.colors[f.key] = editedColors.value[f.key];
    }
    const newYaml = jsYaml.dump(doc, { lineWidth: -1, noRefs: true });
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("profile_file_write", { profileId: p.id, relativePath: "profile.yaml", content: Array.from(new TextEncoder().encode(newYaml)) });
    log.info("颜色已保存");
  } catch (e: any) { log.error("保存失败:", e); }
}

// ── 字体 ──
const fontAssign = ref({ ui: "zpix", chat: "zpix" });

function initFontEditor() {
  const p = getActiveProfile();
  if (!p) return;
  fontAssign.value = { ui: p.theme.fonts.ui || "zpix", chat: p.theme.fonts.chat || "zpix" };
}

async function doCloneProfile() {
  const src = getActiveProfile();
  if (!src) return;
  const newId = `${src.id}-clone-${Date.now()}`;
  try {
    // 复制 profile.yaml 和 character.yaml
    for (const fn of ["profile.yaml", "character.yaml"]) {
      const resp = await fetch(`${src.basePath}/${fn}`);
      if (resp.ok) {
        let text = await resp.text();
        if (fn === "profile.yaml") text = text.replace(/builtin:\s*true/, "builtin: false").replace(/name:\s*"[^"]*"/, `name: "${src.meta.name} (副本)"`);
        const buf = new TextEncoder().encode(text);
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("profile_file_write", { profileId: newId, relativePath: fn, content: Array.from(buf) });
      }
    }
    log.info(`已克隆: "${newId}"`);
    await refreshProfileList();
    switchProfile(newId);
  } catch (e: any) { log.error("克隆失败:", e); }
}

// ═══════════════════════════════════
// 保存/取消
// ═══════════════════════════════════
const saved = ref(false);

async function doSave() {
  userConfig.popupMode = popupMode.value;
  userConfig.autoPopupOnMessage = autoPopup.value;
  userConfig.popupSize = { w: popupW.value, h: popupH.value };
  userConfig.shortcutKey = recKey.value;
  if (isMacOS) userConfig.shortcutMacModifiers = recMods.value;
  else userConfig.shortcutWinModifiers = recMods.value;

  // 音效分配持久化
  saveSoundAssignments(assignments.value);

  setOverrides({
    "ai.endpoint": aiEndpoint.value,
    "ai.apiKey": aiApiKey.value,
    "ai.requireApiKey": aiRequireApiKey.value,
    "ai.model": aiModel.value,
    "ai.contextMaxTokens": aiContextMaxTokens.value,
    "ai.thinking.effort": aiThinkingEffort.value,
    "ai.defaultSystemPrompt": aiSystemPrompt.value,
    "ai.personality.enabled": personalityEnabled.value,
    "ai.personality.active": personalityActive.value,
    "ai.windowMonitor.enabled": wmEnabled.value,
    "ai.windowMonitor.staySeconds": wmStaySeconds.value,
    "ai.windowMonitor.settleMs": wmSettleMs.value,
    "ai.windowMonitor.cooldownSeconds": wmCooldownSec.value,
    "ai.windowMonitor.samePageCooldownSeconds": wmSamePageCool.value,
    "ai.lock.safetyTimeoutMs": lockTimeout.value,
    "ai.memory.maxEntries": memMax.value,
    "general.desktop.pollingIntervalMs": deskPoll.value,
    "general.desktop.pauseExtraMs": deskPause.value,
    "general.desktop.waitTimeoutMs": deskWait.value,
    "general.logging.level": logLevel.value,
    "general.mode.assistant": assistantMode.value,
    "ai.safety.mode": safetyMode.value,
    "ai.safety.sessionTrustEnabled": sessionTrustEnabled.value,
    "tools.bash.whitelist": bashWhitelist.value.split("\n").map(s => s.trim()).filter(Boolean),
    "tools.file.writeEnabled": fileWriteEnabled.value,
    "tools.mcp.enabled": mcpEnabled.value,
    "tools.skill.enabled": skillEnabled.value,
    "ai.loop.streamEnabled": aiStreamEnabled.value,
  });

  // MCP
  const builtinRaw = toolsConfig.builtinMcpServers as Record<string, any>;
  if (builtinRaw && typeof builtinRaw === "object") {
    const updated: Record<string, any> = {};
    for (const b of builtinMcpList.value) {
      const original = builtinRaw[b.name] || {};
      const env: Record<string, string> = {};
      if (b.envStr.trim()) { for (const line of b.envStr.trim().split("\n")) { const eq = line.indexOf("="); if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim(); } }
      updated[b.name] = { enabled: b.enabled, command: original.command || "npx", args: b.args.trim() ? b.args.trim().split(/\s+/).filter(Boolean) : (original.args || []), description: original.description || "", ...(Object.keys(env).length > 0 || (original.env && Object.keys(original.env).length > 0) ? { env } : {}), };
    }
    setOverride("tools.mcp.builtin", updated);
  }
  const { setMcpServers } = await import("@/services/tool/mcp/manager");
  setMcpServers(mcpServerList.value.map(s => ({ name: s.name, transport: s.transport as "stdio"|"sse", command: s.command || undefined, args: s.args ? s.args.split(/\s+/).filter(Boolean) : undefined, url: s.url || undefined, enabled: s.enabled })));

  setPersonalityEnabled(personalityEnabled.value);
  switchPersonality(personalityEnabled.value ? personalityActive.value : null);

  if (candyInstructions.value.trim()) {
    const { MemoryService } = await import("@/services/agent/memory");
    await MemoryService.updateCandy(candyInstructions.value.trim());
  }

  saved.value = true;
  log.info("设置已保存");
  emit("deskpet-settings-saved").catch(() => {});
  setTimeout(() => { saved.value = false; }, 3000);
}

function doCancel() { win.close().catch(() => {}); }
async function restartApp() {
  try { const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow"); const windows = await getAllWebviewWindows(); for (const w of windows) { try { w.close() } catch {} } } catch {}
  win.close().catch(() => {});
}
async function previewSize() { await emit("deskpet-preview-size", { w: popupW.value, h: popupH.value }); }
async function restoreDefaultSize() { popupW.value = popupDefaultSize.w; popupH.value = popupDefaultSize.h; await emit("deskpet-preview-size", { w: popupDefaultSize.w, h: popupDefaultSize.h }); }

// CONFIG 导入导出
async function exportConfigYaml() {
  try {
    const jsYaml = await import("js-yaml");
    const yamlStr = jsYaml.dump(getAllOverrides(), { lineWidth: -1, noRefs: true });
    const blob = new Blob([yamlStr], { type: "application/x-yaml" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "deskpet-config-export.yaml"; a.click();
  } catch (e) { log.error("导出失败", e); }
}
async function importConfigYaml() {
  const input = document.createElement("input"); input.type = "file"; input.accept = ".yaml,.yml";
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(await file.text()) as Record<string, any>;
      if (!parsed || typeof parsed !== "object") return;
      const flat: Record<string, any> = {};
      function flatten(obj: any, prefix: string) { for (const [k, v] of Object.entries(obj)) { const key = prefix ? `${prefix}.${k}` : k; if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, key); else flat[key] = v; } }
      flatten(parsed, "");
      setOverrides(flat);
      location.reload();
    } catch (e) { log.error("导入失败", e); }
  };
  input.click();
}

// ── 生命周期 ──
let cleanupResize: (() => void) | null = null;
let cleanupMove: (() => void) | null = null;

onMounted(async () => {
  document.addEventListener("keydown", onKeyDown, true);
  try {
    const { MemoryService } = await import("@/services/agent/memory");
    await MemoryService.init();
    const sm = MemoryService.session;
    memStatus.value = { count: MemoryService.count, projectCount: MemoryService.projectCount, lastConsolidation: sm?.compactionSummary ? "已压缩" : "运行中", mode: assistantMode.value ? "助手(LLM)" : "轻量(去重)", sessionTurns: sm?.turns.length ?? 0, sessionId: sm?.sessionId ?? "" };
    const candy = MemoryService.getCandyInstructionsSync();
    if (candy) candyInstructions.value = candy.replace(/^[\s\S]*?指令\]\n/, "").trim();
  } catch {}
  await loadMcpConfig();
  loadBuiltinMcpConfig();
  await loadSkillConfig();
  await initProfiles();  // ★ 只加载CONFIG指定的profile（懒加载）
  refreshProfileList();
  initFontEditor();
  try { cleanupResize = (await listen<{ w: number; h: number }>("deskpet-resized", (e) => { popupW.value = e.payload.w; popupH.value = e.payload.h; })); } catch {}
  try { cleanupMove = (await listen<{ x: number; y: number }>("deskpet-moved", (e) => { displayPos.value = { x: e.payload.x, y: e.payload.y }; })); } catch {}
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
      <span class="s-hint">修改后点击保存，部分配置需重启生效</span>
      <button class="s-close" @click="doCancel">✕</button>
    </div>

    <div id="s-body-wrap">
      <!-- 侧边导航 -->
      <div id="s-nav">
        <button v-for="t in tabs" :key="t.id" class="s-nav-btn" :class="{ active: activeTab === t.id }" @click="activeTab = t.id as any">
          {{ t.label }}
        </button>
      </div>

      <!-- 内容区 -->
      <div id="s-body">

        <!-- ═══════════════════════════ GENERAL ═══════════════════════════ -->
        <template v-if="activeTab === 'general'">
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
        </template>

        <!-- ═══════════════════════════ AI ═══════════════════════════ -->
        <template v-if="activeTab === 'ai'">
          <div class="s-section">
            <div class="s-label">🤖 API</div>
            <div class="fld"><span class="fn">端点</span><input class="inp" v-model="aiEndpoint" /></div>
            <div class="fld"><span class="fn">密钥</span><input class="inp" :type="showApiKey ? 'text' : 'password'" v-model="aiApiKey" /><button class="btn-s" @click="showApiKey = !showApiKey">{{ showApiKey ? '🙈' : '👁' }}</button></div>
            <div class="fld"><span class="fn">模型</span><input class="inp" v-model="aiModel" /></div>
            <div class="fld"><span class="fn">上下文</span><input class="inp-num" type="number" v-model.number="aiContextMaxTokens" style="width:80px" /><span class="s-muted">tokens</span></div>
            <label class="chk" style="margin-top:4px"><input type="checkbox" v-model="aiRequireApiKey" /><span>需要 API Key</span></label>
          </div>

          <div class="s-section">
            <div class="s-label">🧠 思考强度</div>
            <div class="radio-row">
              <label v-for="lv in ['auto','low','medium','high']" :key="lv" class="chk"><input type="radio" v-model="aiThinkingEffort" :value="lv" /><span>{{ lv }}</span></label>
            </div>
            <label class="chk" style="margin-top:4px"><input type="checkbox" v-model="aiStreamEnabled" /><span>流式输出</span></label>
          </div>

          <div class="s-section">
            <div class="s-label">🎭 人格 <span class="tag-tip">即时生效</span></div>
            <label class="chk"><input type="checkbox" v-model="personalityEnabled" /><span>启用人格系统</span></label>
            <div v-if="personalityEnabled" class="radio-row" style="flex-direction:column">
              <label v-for="p in availablePersonalities" :key="p.id" class="chk"><input type="radio" v-model="personalityActive" :value="p.id" /><span>{{ p.name }} — {{ p.description }}</span></label>
            </div>
            <div v-else class="s-hint">已关闭，使用默认人格</div>
          </div>

          <div class="s-section">
            <div class="s-label">💬 默认人格 Prompt</div>
            <textarea class="inp txa" v-model="aiSystemPrompt" rows="2"></textarea>
          </div>

          <div class="s-section">
            <div class="s-label">👁 窗口监控</div>
            <label class="chk"><input type="checkbox" v-model="wmEnabled" /><span>启用主动搭话</span></label>
            <div class="row-gap" style="margin-top:4px">
              <label>停留 <input class="inp-num" type="number" v-model.number="wmStaySeconds" />s</label>
              <label>防抖 <input class="inp-num" type="number" v-model.number="wmSettleMs" />ms</label>
            </div>
            <div class="row-gap">
              <label>全局冷却 <input class="inp-num" type="number" v-model.number="wmCooldownSec" />s</label>
              <label>同页冷却 <input class="inp-num" type="number" v-model.number="wmSamePageCool" />s</label>
            </div>
          </div>

          <div class="s-section">
            <div class="s-label">🛡 安全 & 并发</div>
            <div class="radio-row">
              <span class="fn">策略</span>
              <label v-for="m in [{v:'just_do_it',l:'全放行'},{v:'tell_me',l:'告知确认'},{v:'let_me_tk',l:'全部确认'}]" :key="m.v" class="chk"><input type="radio" v-model="safetyMode" :value="m.v" /><span>{{ m.l }}</span></label>
            </div>
            <label class="chk"><input type="checkbox" v-model="sessionTrustEnabled" /><span>会话信任 NORMAL 工具</span></label>
            <div class="fld" style="margin-top:4px"><span class="fn">锁超时</span><input class="inp-num" type="number" v-model.number="lockTimeout" /> ms</div>
          </div>

          <div class="s-section">
            <div class="s-label">🧠 记忆</div>
            <div class="fld"><span class="fn">上限</span><input class="inp-num" type="number" v-model.number="memMax" min="10" max="1000" /> 条</div>
            <div class="s-hint">{{ memStatus.count }} 条记忆 | 归档 {{ memStatus.projectCount ?? 0 }} | 会话 {{ memStatus.sessionTurns ?? 0 }} 轮 | {{ memStatus.lastConsolidation }}</div>
            <div class="fld-col" style="margin-top:4px"><span class="fn">CANDY.md 指令</span><textarea class="inp txa mono" v-model="candyInstructions" rows="2" placeholder="例如：叫我小明、用日语回复..."></textarea></div>
          </div>
        </template>

        <!-- ═══════════════════════════ TOOLS ═══════════════════════════ -->
        <template v-if="activeTab === 'tools'">
          <div class="s-section">
            <div class="s-label">💻 Bash 白名单</div>
            <textarea class="inp txa mono" v-model="bashWhitelist" rows="4" placeholder="ls&#10;cat&#10;grep..."></textarea>
            <div class="s-hint">{{ bashWhitelist.split('\n').filter(l => l.trim()).length }} 个命令</div>
          </div>

          <div class="s-section">
            <div class="s-label">📁 文件</div>
            <label class="chk"><input type="checkbox" v-model="fileWriteEnabled" :disabled="!assistantMode" /><span>允许写文件（仅助手模式）</span></label>
          </div>

          <div class="s-section">
            <div class="s-label">🔌 MCP <span class="tag-tip">需重启</span></div>
            <label class="chk"><input type="checkbox" v-model="mcpEnabled" :disabled="!assistantMode" /><span>启用 MCP（仅助手模式）</span></label>
            <div class="s-hint">内置 {{ builtinMcpList.length }} + 自定义 {{ mcpServerList.length }} 个</div>
            <!-- 内置 MCP -->
            <div class="s-subtitle">📦 内置</div>
            <div v-for="(b, i) in builtinMcpList" :key="b.name" class="li-row">
              <span>{{ b.description || b.name }} <code>{{ b.name }}</code></span>
              <span>
                <button class="btn-s" :class="{ 'btn-d': !b.enabled }" @click="toggleBuiltinMcp(i)">{{ b.enabled ? '✅' : '❌' }}</button>
                <button class="btn-s" @click="startEditBuiltin(i)">✏</button>
              </span>
            </div>
            <div v-if="editingBuiltinIdx >= 0" class="edit-box">
              <div class="fld"><span class="fn">{{ builtinMcpList[editingBuiltinIdx]?.name }}</span></div>
              <div class="fld"><label>参数</label><input class="inp" v-model="builtinMcpList[editingBuiltinIdx].args" /></div>
              <div class="fld-col"><label>环境变量</label><textarea class="inp txa mono" v-model="builtinMcpList[editingBuiltinIdx].envStr" rows="2" placeholder="KEY=VALUE"></textarea></div>
              <button class="btn-s btn-d" @click="cancelEditBuiltin()">取消</button>
            </div>
            <!-- 自定义 MCP -->
            <div class="s-subtitle" style="margin-top:6px">🔧 自定义</div>
            <div class="row-gap"><button class="btn-s" @click="importMcpJson()">📥 导入</button><button class="btn-s" @click="exportMcpJson()">📤 导出</button></div>
            <div v-if="mcpServerList.length === 0" class="s-hint">暂无</div>
            <div v-for="(s, i) in mcpServerList" :key="i" class="li-row">
              <span><b>{{ s.name }}</b> [{{ s.transport }}] {{ s.command }}</span>
              <span><button class="btn-s" @click="editMcpServer(i)">✏</button><button class="btn-s btn-d" @click="removeMcpServer(i)">✕</button></span>
            </div>
            <div class="edit-box" style="margin-top:4px">
              <div class="fld"><label>名称</label><input class="inp" v-model="mcpForm.name" style="width:90px" /></div>
              <div class="fld"><label>传输</label><select class="inp" v-model="mcpForm.transport" style="width:70px"><option value="stdio">stdio</option><option value="sse">sse</option></select></div>
              <div class="fld" v-if="mcpForm.transport === 'stdio'"><label>命令</label><input class="inp" v-model="mcpForm.command" style="width:100px" /><label>参数</label><input class="inp" v-model="mcpForm.args" style="width:140px" /></div>
              <div class="fld" v-if="mcpForm.transport === 'sse'"><label>URL</label><input class="inp" v-model="mcpForm.url" style="width:220px" /></div>
              <div class="row-gap">
                <button class="btn-s" @click="addOrUpdateMcpServer()">{{ editingMcpIdx >= 0 ? '更新' : '添加' }}</button>
                <button v-if="editingMcpIdx >= 0" class="btn-s btn-d" @click="cancelMcpEdit()">取消</button>
                <button class="btn-s" @click="testMcpConnection()">{{ mcpTesting ? '⏳' : '🔌' }} 测试</button>
              </div>
              <div v-if="mcpTestResult" class="s-hint">{{ mcpTestResult }}</div>
            </div>
          </div>

          <div class="s-section">
            <div class="s-label">📦 Skill <span class="tag-tip">需重启</span></div>
            <label class="chk"><input type="checkbox" v-model="skillEnabled" :disabled="!assistantMode" /><span>启用 Skill（仅助手模式）</span></label>
            <div class="row-gap" style="margin-top:4px">
              <button class="btn-s" @click="uploadSkillMd()">📤 上传 .md</button>
              <button class="btn-s" @click="loadSkillConfig()">🔄 刷新</button>
            </div>
            <div v-if="skillList.length === 0" class="s-hint">暂无</div>
            <div v-for="s in skillList" :key="s.id" class="li-row">
              <span><b>{{ s.name }}</b> {{ s.description }}</span>
              <span><span class="s-hint" style="margin:0 8px">{{ s.keywords }}</span><button class="btn-s btn-d" @click="removeSkill(s.id)">✕</button></span>
            </div>
          </div>
        </template>

        <!-- ═══════════════════════════ APPEARANCE ═══════════════════════════ -->
        <template v-if="activeTab === 'appearance'">
          <!-- 预设切换 -->
          <div class="s-section">
            <div class="s-label">🎨 预设方案</div>
            <div class="preset-row">
              <button v-for="pr in presets" :key="pr.id"
                class="preset-btn" :class="{ active: profileDetail?.meta?.preset === pr.id }"
                @click="switchPreset(pr.id)"
                :title="pr.desc"
              >{{ pr.name }}</button>
            </div>
            <div class="s-hint">一键切换配色方案，应用即时生效</div>
          </div>

          <!-- Profile + 预览 -->
          <div class="s-section">
            <div class="s-label">📦 Profile</div>
            <select class="inp" style="width:100%;margin-bottom:6px" v-model="activeProfileId" @change="switchProfile(($event.target as HTMLSelectElement).value)">
              <option v-for="p in profileList" :key="p.id" :value="p.id">{{ p.meta.name }} {{ p.meta.builtin ? '[内置]' : '[用户]' }}</option>
            </select>
            <div v-if="profileDetail" class="profile-preview">
              <img :src="profileDetail.basePath + '/body.png'" class="preview-body" @error="($event.target as HTMLImageElement).style.display='none'" />
              <div class="preview-info">
                <div class="preview-name">{{ profileDetail.meta.name }}</div>
                <div class="preview-meta">角色: {{ profileDetail.character.name }} · {{ Object.keys(profileDetail.animations).length }}动画</div>
                <div class="preview-tags">
                  <span v-if="profileDetail.meta.builtin" class="tag-tip">内置</span>
                  <span v-else class="tag-tip" style="background:rgba(100,200,100,0.2)">用户</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 颜色编辑 -->
          <div class="s-section">
            <div class="s-label">🎨 颜色调整</div>
            <div class="color-grid-simple">
              <div v-for="f in colorFields" :key="f.key" class="color-row">
                <span class="color-label">{{ f.label }}</span>
                <input type="color" class="color-picker" :value="editedColors[f.key]" @input="(e: any) => { editedColors[f.key] = e.target.value; applyColors(); }" />
                <input class="inp color-val" :value="editedColors[f.key]" @input="(e: any) => { editedColors[f.key] = e.target.value; applyColors(); }" />
              </div>
            </div>
            <div class="row-gap" style="margin-top:6px">
              <button class="btn-s" @click="applyColors()">应用</button>
              <button class="btn-s btn-d" @click="resetColors()">恢复</button>
              <button v-if="!profileDetail?.meta.builtin" class="btn-s" @click="saveColorsToProfile()">💾 保存</button>
            </div>
          </div>

          <!-- 字体 -->
          <div class="s-section">
            <div class="s-label">✏️ 字体</div>
            <div class="fld"><span class="fn">界面</span>
              <select class="inp" v-model="fontAssign.ui">
                <option value="zpix">zpix</option>
                <option value="pixel-mplus">pixel-mplus</option>
              </select>
            </div>
            <div class="fld"><span class="fn">聊天</span>
              <select class="inp" v-model="fontAssign.chat">
                <option value="zpix">zpix</option>
                <option value="pixel-mplus">pixel-mplus</option>
              </select>
            </div>
          </div>

          <!-- 音效 -->
          <div class="s-section">
            <div class="s-label">🔊 音效事件</div>
            <div class="sound-list">
              <div v-for="ev in soundEvents" :key="ev.key" class="sound-row">
                <span class="sound-name">{{ ev.label }}</span>
                <div class="sound-actions">
                  <select class="inp sound-sel" :value="assignments[ev.key] || ev.defaultSoundId" @change="selectSound(ev.key, ($event.target as HTMLSelectElement).value)">
                    <option v-for="s in soundLibrary" :key="s.id" :value="s.id">{{ s.name }}</option>
                  </select>
                  <button class="btn-s" @click="previewSound(ev.key)">▶</button>
                </div>
              </div>
              <button class="btn-s btn-d" style="margin-top:4px" @click="restoreSoundDefaults()">↺ 恢复默认</button>
            </div>
          </div>

          <!-- 管理 -->
          <div class="s-section">
            <div class="s-label">📦 管理</div>
            <div class="row-gap">
              <button class="btn-s" @click="refreshProfileList()">🔄 刷新</button>
              <button class="btn-s" @click="doCloneProfile()">📋 克隆</button>
              <button class="btn-s" @click="doExportProfile()">📤 导出</button>
              <button class="btn-s" @click="doImportProfile()">📥 导入</button>
              <button class="btn-s btn-d" @click="doDeleteProfile()" :disabled="profileDetail?.meta.builtin">🗑 删除</button>
            </div>
          </div>
        </template>

      </div>
    </div>

    <div id="s-foot">
      <span class="s-hint" style="margin-right:auto">⚠️ 标记"需重启"的设置在保存后需重启生效</span>
      <button class="btn-s" @click="importConfigYaml()">📥 导入配置</button>
      <button class="btn-s" @click="exportConfigYaml()">📤 导出配置</button>
      <button class="btn-s btn-d" @click="restartApp()">🔄 重启</button>
      <div v-if="saved" class="s-saved">✅ 已保存！</div>
      <button class="btn" @click="doCancel">取消</button>
      <button class="btn btn-primary" @click="doSave">💾 保存</button>
    </div>
  </div>
</template>

<style scoped>
*{margin:0;padding:0;box-sizing:border-box}
#s-root{width:100%;height:100%;display:flex;flex-direction:column;background:var(--color-settings-bg,#3e1a2e);color:#f0e0f0;font-family:"zpix","pixel-mplus",sans-serif;font-size:11px;overflow:hidden}
#s-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--color-settings-card,#2a1020);border-bottom:1px solid rgba(255,255,255,0.08);color:var(--color-accent,#c4276f);font-size:13px;flex-shrink:0;user-select:none}
#s-head .s-hint{flex:1;font-size:9px;opacity:0.5}
.s-close{background:none;border:none;color:var(--color-accent,#c4276f);cursor:pointer;font-size:14px;padding:2px 6px}
.s-close:hover{color:#fff}
#s-body-wrap{flex:1;display:flex;overflow:hidden}
#s-nav{display:flex;flex-direction:column;gap:2px;padding:6px 4px;background:var(--color-settings-card,#2a1020);border-right:1px solid rgba(255,255,255,0.06);min-width:80px;flex-shrink:0}
.s-nav-btn{background:none;border:none;color:rgba(255,255,255,0.5);font-size:10px;font-family:inherit;padding:8px 6px;text-align:center;cursor:pointer;border-radius:4px;transition:all .15s}
.s-nav-btn:hover{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.8)}
.s-nav-btn.active{background:var(--color-accent,#c4276f);color:#fff}
#s-body{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px}
.s-section{background:var(--color-settings-card,#2a1020);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:8px}
.s-label{color:var(--color-accent,#c4276f);font-size:12px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.s-subtitle{color:rgba(255,255,255,0.6);font-size:10px;margin:4px 0 2px}
.s-hint{font-size:9px;opacity:0.5;margin-top:2px}
.s-muted{font-size:10px;opacity:0.4}
.tag-tip{font-size:8px;background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:6px;white-space:nowrap}
.fld{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.fld-col{display:flex;flex-direction:column;gap:2px;margin-bottom:4px}
.fn{font-size:10px;opacity:0.5;min-width:50px;flex-shrink:0}
.row-gap{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.radio-row{display:flex;flex-wrap:wrap;gap:4px 10px}
.chk{display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:rgba(255,255,255,0.8)}
.chk input{accent-color:var(--color-accent,#c4276f)}
.inp{flex:1;min-width:0;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#f0e0f0;padding:2px 6px;font-size:11px;font-family:inherit}
.inp:focus{border-color:var(--color-accent,#c4276f);outline:none}
.inp-num{width:64px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#f0e0f0;padding:2px 6px;font-size:11px;font-family:inherit;text-align:center}
.inp-num:focus{border-color:var(--color-accent,#c4276f);outline:none}
.txa{resize:vertical;min-height:36px}
.mono{font-family:"SF Mono","Fira Code",monospace;font-size:10px}
select.inp{cursor:pointer}
.btn-s{padding:2px 8px;font-size:10px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.12);border-radius:10px;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0}
.btn-s:hover{background:rgba(255,255,255,0.15)}
.btn-s:disabled{opacity:0.3;cursor:default}
.btn-s.recording{background:var(--color-accent,#c4276f);color:#fff;animation:pulse .8s ease infinite}
.btn-d{opacity:0.5}
.btn-d:hover{opacity:1}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.shortcut-display{padding:3px 10px;background:rgba(0,0,0,0.3);border-radius:4px;border:1px solid rgba(255,255,255,0.1);font-family:monospace;font-size:12px}
.li-row{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 4px;font-size:10px}
.li-row code{font-size:9px;opacity:0.4}
.edit-box{padding:6px;margin:2px 0;background:rgba(0,0,0,0.2);border-radius:4px;display:flex;flex-direction:column;gap:4px}
.color-swatches{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.swatch{width:18px;height:18px;border-radius:3px;border:1px solid rgba(255,255,255,0.2)}
#s-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 12px;background:var(--color-settings-card,#2a1020);border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0}
.s-saved{flex:1;color:#a0f0c0;font-size:10px}
.btn{padding:4px 14px;font-size:11px;background:rgba(255,255,255,0.06);color:#f0e0f0;border:1px solid rgba(255,255,255,0.1);border-radius:12px;cursor:pointer;font-family:inherit}
.btn:hover{background:rgba(255,255,255,0.12)}
.btn-primary{background:var(--color-accent,#c4276f);border-color:var(--color-accent,#c4276f)}
.btn-primary:hover{opacity:0.85}
.sound-list{display:flex;flex-direction:column;gap:2px;margin-top:2px}
.sound-row{display:flex;align-items:center;justify-content:space-between;gap:6px}
.sound-name{font-size:10px;min-width:60px;flex-shrink:0}
.sound-actions{display:flex;align-items:center;gap:6px}
.sound-sel{min-width:100px;width:auto;flex:0}

/* ── 预设按钮 ── */
.preset-row{display:flex;gap:6px;margin-top:4px}
.preset-btn{padding:6px 14px;font-size:11px;font-family:inherit;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.5);border:1px solid rgba(255,255,255,0.08);border-radius:10px;cursor:pointer;transition:all .15s}
.preset-btn:hover{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.8)}
.preset-btn.active{background:var(--color-accent,#c4276f);color:#fff;border-color:var(--color-accent,#c4276f)}

/* ── 颜色编辑（精简）── */
.color-grid-simple{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:3px}
.color-row{display:flex;align-items:center;gap:3px}
.color-label{font-size:9px;opacity:0.55;min-width:48px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.color-picker{width:22px;height:20px;border:none;border-radius:3px;cursor:pointer;padding:0;background:none;flex-shrink:0}
.color-picker::-webkit-color-swatch-wrapper{padding:0}
.color-picker::-webkit-color-swatch{border:1px solid rgba(255,255,255,0.2);border-radius:3px}
.color-val{flex:1;min-width:60px;font-size:9px!important;padding:1px 3px!important}

/* ── Profile 预览 ── */
.profile-preview{display:flex;gap:8px;padding:6px;background:rgba(0,0,0,0.15);border-radius:8px;align-items:flex-start}
.preview-body{width:48px;height:48px;object-fit:contain;image-rendering:pixelated;border-radius:4px;border:2px solid rgba(255,255,255,0.1);flex-shrink:0;background:rgba(0,0,0,0.2)}
.preview-info{flex:1;min-width:0}
.preview-name{font-size:12px;color:var(--color-accent,#c4276f);font-weight:bold}
.preview-meta{font-size:10px;opacity:0.5;margin-top:2px}
.preview-desc{font-size:9px;opacity:0.35;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.preview-tags{display:flex;gap:4px;margin-top:3px}
</style>
