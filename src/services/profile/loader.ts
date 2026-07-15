// ==========================================
// Profile 加载器 v3 — 懒加载 + 精简色彩 + 素材回退
// 启动只加载 CONFIG 指定的 profile，设置页才扫描列表
// ==========================================

import { createLogger } from "@/services/logger";
import { appearanceConfig } from "@/services/config";

const log = createLogger("Profile");

// ── 字体 @font-face 缓存 ──
let _fontStyleEl: HTMLStyleElement | null = null;

function injectFonts(profile: ProfileData): void {
  if (_fontStyleEl) { _fontStyleEl.remove(); _fontStyleEl = null; }
  const b = profile.basePath;
  const fonts = profile.theme.fonts;

  const fontMap: Record<string, string> = {
    zpix: "zpix.ttf",
    "pixel-mplus": "PixelMplus10-Regular.ttf",
    "pixel-mplus-bold": "PixelMplus10-Bold.ttf",
  };

  const families = new Set<string>();
  if (fonts.ui) families.add(fonts.ui);
  if (fonts.chat) families.add(fonts.chat);

  let css = "";
  for (const family of families) {
    const filename = fontMap[family];
    if (filename) {
      css += `@font-face{font-family:"${family}";src:url("${b}/fonts/${filename}") format("truetype");}\n`;
    }
  }

  if (css) {
    _fontStyleEl = document.createElement("style");
    _fontStyleEl.textContent = css;
    document.head.appendChild(_fontStyleEl);
  }
}

// ── 类型 ──

export interface ProfileMeta {
  name: string
  description: string
  version: number
  builtin: boolean
  preset?: string
}

export interface ProfileThemeColors {
  背景: string; 卡片背景: string; 聊天背景: string
  边框: string; 分割线: string; 输入边框: string
  主文字: string; 亮文字: string; 粉色文字: string; 暗文字: string
  强调色: string; 强调悬浮: string
  标题栏渐变起: string; 标题栏渐变止: string; 标题栏文字: string
  表面色: string; 深表面色: string; 遮罩: string
  透明背景: string; 模糊度: string
}

export interface ProfileTheme {
  colors: ProfileThemeColors
  fonts: { ui: string; chat: string; size: number }
  shield: { enabled: boolean; image: string }
  parallax: ProfileParallax
}

export interface ProfileParallaxLayer {
  enabled: boolean; image: string; sensitivity: number
  shadow: number; brightness: number; contrast: number; saturate: number
  scale: number
  offsetX: number; offsetY: number; locked: boolean
}

export interface ProfileParallax {
  intensity: number
  layers: ProfileParallaxLayer[]
}

export interface ProfileSound {
  volume: number
  events: Record<string, string>
}

export interface ProfileCharacter {
  id: string; name: string; scale: number; scaleMode: "pixelated" | "smooth"
}

export interface AnimFrame { f: string; d: number }
export interface AnimDef { loop: boolean; frames: AnimFrame[] }
export interface ExpressionRule { kw: string[]; anim: string }

export interface ProfileData {
  id: string; meta: ProfileMeta; theme: ProfileTheme
  sound: ProfileSound; character: ProfileCharacter
  animations: Record<string, AnimDef>; expressions: ExpressionRule[]
  builtinAnimations: string[]; basePath: string
}

// ── 内部状态 ──
let profiles = new Map<string, ProfileData>();
let activeId: string | null = null;
let loaded = false;
const DEFAULT_BUILTIN = "sugar-pink";

// ── YAML 加载 ──
let jsYamlModule: any = null;

async function loadYaml(): Promise<any> {
  if (!jsYamlModule) jsYamlModule = await import("js-yaml");
  return jsYamlModule;
}

async function fetchYaml<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const text = await resp.text();
  const yaml = await loadYaml();
  return yaml.load(text) as T;
}

// ── Profile 加载 ──

async function loadProfile(id: string): Promise<ProfileData> {
  const basePath = `/profiles/${id}`;

  const rawProfile = await fetchYaml<any>(`${basePath}/profile.yaml`);

  let rawChar: any;
  let charBasePath = basePath; // ★ 帧素材实际所在 Profile（可能回退到默认）
  try {
    rawChar = await fetchYaml<any>(`${basePath}/character.yaml`);
  } catch {
    charBasePath = `/profiles/${DEFAULT_BUILTIN}`;
    rawChar = await fetchYaml<any>(`${charBasePath}/character.yaml`);
  }
  const resolveFramePath = (f: string) => `${charBasePath}/${f}`;

  const animations: Record<string, AnimDef> = {};
  if (rawChar?.animations) {
    for (const [name, def] of Object.entries(rawChar.animations)) {
      const animDef = def as any;
      animations[name] = {
        loop: animDef.loop === true,
        frames: (animDef.frames || []).map((f: any) => ({
          f: resolveFramePath(f.f),
          d: f.d || 120,
        })),
      };
    }
  }

  return {
    id,
    meta: {
      name: rawProfile?.meta?.name || id,
      description: rawProfile?.meta?.description || "",
      version: rawProfile?.meta?.version || 1,
      builtin: rawProfile?.meta?.builtin ?? false,
      preset: rawProfile?.meta?.preset,
    },
    theme: {
      colors: rawProfile?.theme?.colors || {},
      fonts: rawProfile?.theme?.fonts || { ui: "zpix", chat: "zpix", size: 14 },
      shield: rawProfile?.theme?.shield || { enabled: false, image: "" },
      parallax: {
        intensity: rawProfile?.theme?.parallax?.intensity ?? 1.0,
        layers: (rawProfile?.theme?.parallax?.layers || []).map((l: any, i: number) => ({
          enabled: l?.enabled ?? (i === 2),
          image: l?.image ?? (i === 2 ? "materials/L2/body.png" : ""),
          sensitivity: l?.sensitivity ?? [0.2, 0.5, 0.8, 1.2, 1.6][i],
          shadow: l?.shadow ?? [0.25, 0.18, 0.12, 0.06, 0.03][i],
          brightness: l?.brightness ?? [0.93, 0.95, 1.00, 1.02, 1.03][i],
          contrast: l?.contrast ?? [0.96, 0.98, 1.00, 1.02, 1.03][i],
          saturate: l?.saturate ?? [0.92, 0.95, 1.00, 1.05, 1.08][i],
          scale: l?.scale ?? 1.0,
          offsetX: l?.offsetX ?? 0,
          offsetY: l?.offsetY ?? 0,
          locked: l?.locked ?? false,
        })),
      },
    },
    sound: {
      volume: rawProfile?.sound?.volume ?? 0.8,
      events: rawProfile?.sound?.events || {},
    },
    character: {
      id: rawChar?.character?.id || id,
      name: rawChar?.character?.name || id,
      scale: rawChar?.character?.scale ?? 1.0,
      scaleMode: rawChar?.character?.scaleMode || "pixelated",
    },
    animations,
    expressions: rawChar?.expressions || [],
    builtinAnimations: rawChar?.builtinAnimations || [],
    basePath,
  };
}

// ── 公共 API ──

export async function initProfiles(): Promise<void> {
  if (loaded) return;
  const targetId = appearanceConfig.activeProfile || DEFAULT_BUILTIN;
  try {
    const data = await loadProfile(targetId);
    profiles.set(targetId, data);
    log.info(`Profile 已加载: "${targetId}" (${data.meta.name})`);
  } catch (e) {
    log.error(`Profile "${targetId}" 加载失败:`, e);
    if (targetId !== DEFAULT_BUILTIN) {
      try {
        const fallback = await loadProfile(DEFAULT_BUILTIN);
        profiles.set(DEFAULT_BUILTIN, fallback);
        log.warn(`回退到默认 Profile: "${DEFAULT_BUILTIN}"`);
      } catch (e2) { log.error("默认 Profile 也加载失败:", e2); }
    }
  }
  loaded = true;
  if (profiles.has(targetId)) activateProfile(targetId);
  else if (profiles.size > 0) activateProfile(profiles.keys().next().value!);
}

export async function discoverAllProfiles(): Promise<string[]> {
  const found = new Set<string>();
  for (const id of ["sugar-pink", "dark-purple", "glass"]) {
    try { const resp = await fetch(`/profiles/${id}/profile.yaml`); if (resp.ok) found.add(id); } catch {}
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const userProfiles: string[] = await invoke("list_user_profiles");
    for (const id of userProfiles) found.add(id);
  } catch {}
  return [...found];
}

export async function ensureProfileLoaded(id: string): Promise<ProfileData | null> {
  if (profiles.has(id)) return profiles.get(id)!;
  const MAX_PROFILES = 20
  if (profiles.size >= MAX_PROFILES) {
    const oldest = profiles.keys().next().value
    if (oldest) {
      profiles.delete(oldest)
      log.info("profile 已达上限，淘汰最旧:", oldest)
    }
  }
  try { const data = await loadProfile(id); profiles.set(id, data); return data; }
  catch (e) { log.error(`Profile "${id}" 加载失败:`, e); return null; }
}

export function activateProfile(id: string): boolean {
  if (!profiles.has(id)) { log.error(`Profile "${id}" 未加载`); return false; }
  activeId = id;
  const p = profiles.get(id)!;
  injectFonts(p);
  injectCssVars(p);
  // 通知 StreamView 重载图层（解决 profile 懒加载时序问题）
  try { localStorage.setItem("deskpet_parallax_dirty", "1"); } catch {}
  log.info(`Profile 已激活: "${id}" (${p.meta.name})`);
  return true;
}

// ── CSS 变量注入 ──
let _cssVarStyleEl: HTMLStyleElement | null = null;

function injectCssVars(profile: ProfileData): void {
  if (_cssVarStyleEl) _cssVarStyleEl.remove();
  const c = profile.theme.colors as unknown as Record<string, string>;
  const f = profile.theme.fonts;
  const preset = profile.meta.preset || "pink";
  const v = (key: string, fb: string) => c[key] || fb;
  const accentLight = v("强调色", "#c4276f").replace(")", ",0.35)").replace("rgb", "rgba");
  const textPinkLight = v("粉色文字", "#f0a0c0").replace(")", ",0.3)").replace("rgb", "rgba");
  const isGlass = preset === "glass";
  const glassBg = v("透明背景", "rgba(252,228,236,0.25)");
  const glassBlur = v("模糊度", "0px");

  const css = `:root {
  --color-bg: ${v("背景", "#fce4ec")};
  --color-border: ${v("边框", "#a01a5a")};
  --color-text: ${v("主文字", "#333")};
  --color-accent: ${v("强调色", "#c4276f")};
  --color-accent-hover: ${v("强调悬浮", "#e84a8a")};
  --color-chat-bg: ${v("聊天背景", "#fce4ec")};
  --color-divider: ${v("分割线", "#e8a0b0")};
  --color-settings-bg: ${v("深表面色", "#3e1a2e")};
  --color-settings-card: ${v("卡片背景", "#2a1020")};
  --color-text-muted: ${v("暗文字", "#8a6080")};
  --color-text-bright: ${v("亮文字", "#f0e0f0")};
  --color-text-pink: ${v("粉色文字", "#f0a0c0")};
  --color-accent-light: ${accentLight};
  --color-accent-shadow: ${v("强调色", "#c4276f").replace(")", ",0.15)").replace("rgb", "rgba")};
  --color-surface-dark: ${v("表面色", "#4a2540")};
  --color-surface-darker: ${v("深表面色", "#3e1a2e")};
  --color-surface-deep: ${v("卡片背景", "#2a1020")};
  --color-surface-deepest: ${v("深表面色", "#3e1a2e")};
  --color-border-light: ${v("表面色", "#4a2540")};
  --color-border-input: ${v("输入边框", "#6a4060")};
  --color-border-gradient: ${v("标题栏渐变起", "#f7a8c4")}, ${v("标题栏渐变止", "#c4276f")};
  --color-titlebar-gradient-start: ${v("标题栏渐变起", "#f7a8c4")};
  --color-titlebar-gradient-end: ${v("标题栏渐变止", "#c4276f")};
  --color-titlebar-border-top: ${v("标题栏渐变起", "#f7a8c4")};
  --color-titlebar-border-bottom: ${v("边框", "#a01a5a")};
  --color-titlebar-text: ${v("标题栏文字", "#fff")};
  --color-titlebar-btn-bg: ${v("标题栏文字", "#fff").replace(")", ",0.2)").replace("rgb", "rgba")};
  --color-titlebar-btn-border: ${v("标题栏文字", "#fff").replace(")", ",0.3)").replace("rgb", "rgba")};
  --color-titlebar-btn-hover-bg: ${v("标题栏文字", "#fff").replace(")", ",0.4)").replace("rgb", "rgba")};
  --color-titlebar-btn-hover-border: ${v("标题栏文字", "#fff").replace(")", ",0.5)").replace("rgb", "rgba")};
  --color-titlebar-close-hover: #c42b1c;
  --color-scrollbar-track: rgba(0,0,0,0.15);
  --color-scrollbar-thumb: ${textPinkLight};
  --color-scrollbar-thumb-hover: ${v("粉色文字", "#f0a0c0").replace(")", ",0.5)").replace("rgb", "rgba")};
  --color-scrollbar-thumb-drag: ${v("粉色文字", "#f0a0c0").replace(")", ",0.65)").replace("rgb", "rgba")};
  --color-dropdown-bg: ${v("卡片背景", "#2a1020")};
  --color-dropdown-border: ${v("输入边框", "#6a4060")};
  --color-dropdown-hover-bg: ${v("表面色", "#4a2540")};
  --color-dropdown-shadow: rgba(0,0,0,0.4);
  --color-dropdown-desc: ${v("暗文字", "#8a6080")};
  --color-overlay-bg: ${v("遮罩", "rgba(30,8,16,0.7)")};
  --color-confirm-bg: ${v("卡片背景", "#2a1020")};
  --color-confirm-border: ${v("表面色", "#4a2540")};
  --color-confirm-text: ${v("亮文字", "#f0e0f0")};
  --color-tool-status-bg: ${v("遮罩", "rgba(30,8,16,0.7)")};
  --color-tool-status-border: ${v("表面色", "#4a2540")};
  --color-system-msg-bg: ${v("表面色", "#4a2540").replace(")", ",0.3)").replace("rgb", "rgba")};
  --color-system-msg-border: ${v("暗文字", "#8a6080").replace(")", ",0.2)").replace("rgb", "rgba")};
  --color-notif-bg: ${v("深表面色", "#3e1a2e").replace(")", ",0.9)").replace("rgb", "rgba")};
  --color-notif-border: ${v("强调色", "#c4276f").replace(")", ",0.2)").replace("rgb", "rgba")};
  --color-notif-hover-bg: ${v("深表面色", "#3e1a2e").replace(")", ",0.95)").replace("rgb", "rgba")};
  --color-notif-hover-border: ${v("强调色", "#c4276f").replace(")", ",0.45)").replace("rgb", "rgba")};
  --color-notif-close-hover-bg: ${v("强调色", "#c4276f").replace(")", ",0.35)").replace("rgb", "rgba")};
  --color-debug-text: ${v("暗文字", "#8a6080")};
  --color-debug-dim-text: ${v("暗文字", "#8a6080")};
  --color-debug-dim-hover-text: ${v("亮文字", "#f0e0f0")};
  --color-debug-tool-text: #a0c0f0; --color-debug-tool-hover-text: #c0e0ff;
  --color-debug-mcp: #f0c060; --color-debug-skill: #60f0a0;
  --color-debug-empty: ${v("暗文字", "#8a6080")};
  --color-contextmenu-bg: ${v("深表面色", "#3e1a2e")};
  --color-contextmenu-border: ${v("边框", "#a01a5a")};
  --color-contextmenu-text: ${v("亮文字", "#f0e0f0")};
  --color-contextmenu-hover-bg: ${v("强调色", "#c4276f")};
  --color-contextmenu-hover-text: #fff;
  --color-tab-bar-bg: ${v("深表面色", "#3e1a2e")};
  --color-tab-bar-border: ${v("表面色", "#4a2540")};
  --color-tab-inactive-bg: ${v("表面色", "#4a2540")};
  --color-tab-inactive-text: ${v("暗文字", "#8a6080")};
  --color-tab-hover-bg: ${v("表面色", "#4a2540")};
  --color-tab-hover-text: ${v("亮文字", "#f0e0f0")};
  --color-tab-active-bg: ${v("强调色", "#c4276f")};
  --color-tab-active-text: #fff;
  --color-history-bg: ${v("卡片背景", "#2a1020")};
  --color-history-item-border: ${v("表面色", "#4a2540")};
  --color-history-item-hover-bg: ${v("表面色", "#4a2540")};
  --color-history-topic-text: ${v("亮文字", "#f0e0f0")};
  --color-history-meta-text: ${v("暗文字", "#8a6080")};
  --color-winsim-bg: #000; --color-winsim-taskbar-bg: ${v("表面色", "#4a2540")};
  --color-winsim-accent: ${v("强调色", "#c4276f")};
  --color-glass-bg: ${glassBg}; --color-glass-blur: ${glassBlur};
  --font-ui: "${f.ui || "zpix"}"; --font-chat: "${f.chat || "zpix"}";
  --font-mono: "Courier New", monospace; --font-notification: "Microsoft YaHei", sans-serif;
  --font-size: ${f.size || 14}px; --font-size-small: 10px; --font-size-large: 18px;
  --font-line-height: 1.6;
}`;

  if (isGlass && glassBlur !== "0px") {
    const glassCss = `
#root, #s-root { backdrop-filter: blur(${glassBlur}); -webkit-backdrop-filter: blur(${glassBlur}); }
#root { background: ${glassBg}; } #s-root { background: ${glassBg}; }`;
    _cssVarStyleEl = document.createElement("style");
    _cssVarStyleEl.textContent = css + glassCss;
  } else {
    _cssVarStyleEl = document.createElement("style");
    _cssVarStyleEl.textContent = css;
  }
  document.head.appendChild(_cssVarStyleEl);
}

// ── 资源 URL ──

export function getUiUrl(relativePath: string): string {
  const p = getActiveProfile();
  if (!p) return `/profiles/${DEFAULT_BUILTIN}/ui/${relativePath}`;
  return `${p.basePath}/ui/${relativePath}`;
}

export function getFontUrl(filename: string): string {
  const p = getActiveProfile();
  return p ? `${p.basePath}/fonts/${filename}` : `/profiles/${DEFAULT_BUILTIN}/fonts/${filename}`;
}

export function getActiveProfile(): ProfileData | null {
  if (!activeId) return null;
  return profiles.get(activeId) || null;
}

export function listProfiles(): { id: string; meta: ProfileMeta }[] {
  return Array.from(profiles.entries()).map(([id, p]) => ({ id, meta: { ...p.meta } }));
}

export function getProfile(id: string): ProfileData | undefined {
  return profiles.get(id);
}

export function isProfilesLoaded(): boolean { return loaded; }

export function getBodyUrl(profile?: ProfileData): string {
  const p = profile || getActiveProfile();
  if (!p) return `/profiles/${DEFAULT_BUILTIN}/materials/L2/body.png`;
  return `${p.basePath}/materials/L2/body.png`;
}

export function getCharacterScale(): number {
  return getActiveProfile()?.character.scale ?? 1.0;
}

export function getCharacterScaleMode(): string {
  return getActiveProfile()?.character.scaleMode || "pixelated";
}

export function getActivePreset(): string {
  return getActiveProfile()?.meta.preset || "pink";
}

/** 获取灵动图层素材 URL，从 profile parallax.image 字段解析 */
export function getParallaxLayerUrl(layerIndex: number, profile?: ProfileData): string | null {
  const p = profile || getActiveProfile();
  if (!p) return null;
  const layer = p.theme.parallax.layers[layerIndex];
  if (!layer || !layer.image) return null;
  return `${p.basePath}/${layer.image}`;
}
