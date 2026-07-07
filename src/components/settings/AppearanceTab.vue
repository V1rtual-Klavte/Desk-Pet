<script setup lang="ts">
import { ref, onMounted } from "vue";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { userConfig } from "@/services/config";
import {
  getSoundLibrary,
  getSoundAssignments,
  soundEvents,
  type SoundDef,
} from "@/services/audio/registry";
import {
  getActiveProfile,
  activateProfile,
  initProfiles,
  exportProfileZip,
  importProfileZip,
  deleteProfile,
  type ProfileData,
  type ProfileThemeColors,
} from "@/services/profile";
import { createLogger } from "@/services/logger";

const log = createLogger("Settings");

// ── 灵动图层 ──
const parallaxEnabled = ref(userConfig.parallaxEnabled);
const parallaxIntensity = ref(userConfig.parallaxIntensity);

async function openLayerEditor() {
  try {
    const existing = await WebviewWindow.getByLabel("layer-editor");
    if (existing) {
      await existing.setFocus();
      return;
    }
  } catch {
    /* ignore */
  }
  const win = new WebviewWindow("layer-editor", {
    url: "layer-editor.html",
    title: "图层编辑器 - 糖糖桌宠",
    width: 820,
    height: 580,
    resizable: true,
    decorations: true,
    alwaysOnTop: true,
  });
  setTimeout(async () => {
    try {
      await win.setAlwaysOnTop(true);
    } catch {}
    try {
      await win.setFocus();
    } catch {}
    const { invoke } = await import("@tauri-apps/api/core");
    invoke("enhance_layer_editor_window").catch(() => {});
  }, 300);
}

// ── 音效 ──
const soundLibrary = ref<SoundDef[]>(getSoundLibrary());
const assignments = ref<Record<string, string>>(getSoundAssignments());

function previewSound(eventKey: string) {
  const soundId = assignments.value[eventKey];
  if (soundId && soundId !== "none") {
    const s = soundLibrary.value.find((s) => s.id === soundId);
    if (s) s.play();
  }
}

function selectSound(eventKey: string, soundId: string) {
  assignments.value[eventKey] = soundId;
}

function restoreSoundDefaults() {
  for (const ev of soundEvents) assignments.value[ev.key] = ev.defaultSoundId;
}

// ── Profile ──
const profileList = ref<
  { id: string; meta: { name: string; description: string; builtin: boolean; preset?: string } }[]
>([]);
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
    initColorEditor();
    initFontEditor();
  }
}

async function doExportProfile() {
  if (!activeProfileId.value) return;
  try {
    await exportProfileZip(activeProfileId.value);
  } catch (e: any) {
    log.error("导出失败:", e);
  }
}

async function doImportProfile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = await importProfileZip(file);
      if (result.success) {
        await refreshProfileList();
      } else {
        log.warn("导入失败:", result.error);
      }
    } catch (e: any) {
      log.error("导入异常:", e);
    }
  };
  input.click();
}

async function doDeleteProfile() {
  if (!activeProfileId.value) return;
  const p = getActiveProfile();
  if (p?.meta.builtin) {
    log.warn("内置 Profile 不可删除");
    return;
  }
  try {
    await deleteProfile(activeProfileId.value);
    refreshProfileList();
  } catch (e: any) {
    log.error("删除失败:", e);
  }
}

// ── 预设切换 ──
const presets = [
  { id: "pink", name: "🌸 粉色", desc: "默认粉色主题" },
  { id: "dark", name: "🌙 暗夜", desc: "暗色护眼主题" },
  { id: "glass", name: "🪟 玻璃", desc: "透明毛玻璃效果" },
];

async function switchPreset(presetId: string) {
  const presetProfile = profileList.value.find((p) => p.meta.preset === presetId);
  if (presetProfile) {
    await switchProfile(presetProfile.id);
  }
}

// ── 颜色编辑 ──
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

function applyColors() {
  const root =
    document.getElementById("root") ||
    document.getElementById("s-root") ||
    document.documentElement;
  if (!root) return;
  for (const f of colorFields) {
    if (!editedColors.value[f.key]) continue;
    root.style.setProperty(getCssVarName(f.key), editedColors.value[f.key]);
  }
}

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
  const p = getActiveProfile();
  if (p) activateProfile(p.id);
}

async function saveColorsToProfile() {
  const p = getActiveProfile();
  if (!p || p.meta.builtin) {
    log.warn("内置 Profile 不可修改");
    return;
  }
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
    await invoke("profile_file_write", {
      profileId: p.id,
      relativePath: "profile.yaml",
      content: Array.from(new TextEncoder().encode(newYaml)),
    });
    log.info("颜色已保存");
  } catch (e: any) {
    log.error("保存失败:", e);
  }
}

// ── 字体 ──
const fontAssign = ref({ ui: "zpix", chat: "zpix" });

function initFontEditor() {
  const p = getActiveProfile();
  if (!p) return;
  fontAssign.value = {
    ui: p.theme.fonts.ui || "zpix",
    chat: p.theme.fonts.chat || "zpix",
  };
}

// ── 克隆 ──
async function doCloneProfile() {
  const src = getActiveProfile();
  if (!src) return;
  const newId = `${src.id}-clone-${Date.now()}`;
  try {
    for (const fn of ["profile.yaml", "character.yaml"]) {
      const resp = await fetch(`${src.basePath}/${fn}`);
      if (resp.ok) {
        let text = await resp.text();
        if (fn === "profile.yaml")
          text = text
            .replace(/builtin:\s*true/, "builtin: false")
            .replace(/name:\s*"[^"]*"/, `name: "${src.meta.name} (副本)"`);
        const buf = new TextEncoder().encode(text);
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("profile_file_write", {
          profileId: newId,
          relativePath: fn,
          content: Array.from(buf),
        });
      }
    }
    log.info(`已克隆: "${newId}"`);
    await refreshProfileList();
    switchProfile(newId);
  } catch (e: any) {
    log.error("克隆失败:", e);
  }
}

// ── 生命周期 ──
onMounted(async () => {
  await initProfiles();
  refreshProfileList();
  initFontEditor();
});

defineExpose({
  parallaxEnabled,
  parallaxIntensity,
  assignments,
});
</script>

<template>
  <div>
  <!-- 预设切换 -->
  <div class="s-section">
    <div class="s-label">🎨 预设方案</div>
    <div class="preset-row">
      <button
        v-for="pr in presets"
        :key="pr.id"
        class="preset-btn"
        :class="{ active: profileDetail?.meta?.preset === pr.id }"
        @click="switchPreset(pr.id)"
        :title="pr.desc"
      >{{ pr.name }}</button>
    </div>
    <div class="s-hint">一键切换配色方案，应用即时生效</div>
  </div>

  <!-- 灵动图层 -->
  <div class="s-section">
    <div class="s-label">✨ 灵动图层（五层景深视差）</div>
    <label class="s-toggle-row">
      <span class="fn">启用景深视差</span>
      <input type="checkbox" class="s-check" v-model="parallaxEnabled" />
    </label>
    <div class="fld" v-if="parallaxEnabled">
      <span class="fn">视差强度</span>
      <input type="range" class="inp-range" min="0" max="2" step="0.1" v-model.number="parallaxIntensity" />
      <span class="range-val">{{ parallaxIntensity.toFixed(1) }}</span>
    </div>
    <div class="row-gap" style="margin-top:6px">
      <button class="btn-s" style="background:rgba(196,39,111,0.2);border-color:rgba(196,39,111,0.4);color:#f0a0c0" @click="openLayerEditor()">🎨 打开图层编辑器</button>
    </div>
    <div class="s-hint">逐层调整素材、灵敏度、偏移、滤镜。图层编辑器以独立弹窗打开，级别高于设置窗。</div>
  </div>

  <!-- Profile + 预览 -->
  <div class="s-section">
    <div class="s-label">📦 Profile</div>
    <select class="inp" style="width:100%;margin-bottom:6px" v-model="activeProfileId" @change="switchProfile(($event.target as HTMLSelectElement).value)">
      <option v-for="p in profileList" :key="p.id" :value="p.id">{{ p.meta.name }} {{ p.meta.builtin ? '[内置]' : '[用户]' }}</option>
    </select>
    <div v-if="profileDetail" class="profile-preview">
      <img :src="profileDetail.basePath + '/materials/L2/body.png'" class="preview-body" @error="($event.target as HTMLImageElement).style.display='none'" />
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
</div>
</template>

<style scoped>
/* ── 预设按钮 ── */
.preset-row { display: flex; gap: 6px; margin-top: 4px; }
.preset-btn {
  padding: 6px 14px; font-size: 11px; font-family: inherit;
  background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.5);
  border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
  cursor: pointer; transition: all .15s;
}
.preset-btn:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.8); }
.preset-btn.active { background: var(--color-accent,#c4276f); color: #fff; border-color: var(--color-accent,#c4276f); }

/* ── 颜色编辑 ── */
.color-grid-simple { display: grid; grid-template-columns: repeat(auto-fill, minmax(155px, 1fr)); gap: 3px; }
.color-row { display: flex; align-items: center; gap: 3px; }
.color-label { font-size: 9px; opacity: 0.55; min-width: 48px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.color-picker { width: 22px; height: 20px; border: none; border-radius: 3px; cursor: pointer; padding: 0; background: none; flex-shrink: 0; }
.color-picker::-webkit-color-swatch-wrapper { padding: 0; }
.color-picker::-webkit-color-swatch { border: 1px solid rgba(255,255,255,0.2); border-radius: 3px; }
.color-val { flex: 1; min-width: 60px; font-size: 9px !important; padding: 1px 3px !important; }

/* ── 灵动图层 ── */
.inp-range { flex: 1; height: 4px; accent-color: var(--color-accent,#c4276f); }
.range-val { width: 32px; text-align: right; font-size: 12px; color: var(--color-text-muted,#8a6080); }

/* ── Profile 预览 ── */
.profile-preview { display: flex; gap: 8px; padding: 6px; background: rgba(0,0,0,0.15); border-radius: 8px; align-items: flex-start; }
.preview-body { width: 48px; height: 48px; object-fit: contain; image-rendering: pixelated; border-radius: 4px; border: 2px solid rgba(255,255,255,0.1); flex-shrink: 0; background: rgba(0,0,0,0.2); }
.preview-info { flex: 1; min-width: 0; }
.preview-name { font-size: 12px; color: var(--color-accent,#c4276f); font-weight: bold; }
.preview-meta { font-size: 10px; opacity: 0.5; margin-top: 2px; }
.preview-desc { font-size: 9px; opacity: 0.35; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-tags { display: flex; gap: 4px; margin-top: 3px; }

/* ── 音效 ── */
.sound-list { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.sound-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.sound-name { font-size: 10px; min-width: 60px; flex-shrink: 0; }
.sound-actions { display: flex; align-items: center; gap: 6px; }
.sound-sel { min-width: 100px; width: auto; flex: 0; }
</style>
