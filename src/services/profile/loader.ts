// ==========================================
// Profile 加载器 — 懒加载
// 启动只加载 CONFIG 指定的 profile，设置页才扫描列表
// ==========================================

import { createLogger } from "@/services/logger";
import { appearanceConfig, flushConfig, setOverride } from "@/services/config";
import { DEFAULT_PROFILE } from "@/services/paths";
// Profile 文本经受控文件命令读取；Node Harness 不负责把本地路径伪装成 UI URL。
import { getHostBridge } from "@/services/host";
import { formatError } from "@/services/error";
import { notifyActiveProfileChanged } from "@/services/native-ui/active-profile-signal";

const log = createLogger("Profile");

// ── 类型 ──

export interface ProfileMeta {
  name: string
  description: string
  version: number
}

export interface ProfileTheme {
  parallax: ProfileParallax
}

export interface ProfileParallaxLayer {
  enabled: boolean; image: string; sensitivity: number
  scale: number
  offsetX: number; offsetY: number; locked: boolean
}

export interface ProfileParallax {
  layers: ProfileParallaxLayer[]
}

export interface ProfileData {
  id: string; meta: ProfileMeta; theme: ProfileTheme
}

/**
 * 五层缺省灵敏度（L0→L4）：与旧壳 `DEFAULT_LAYERS` 同口径，也与宿主
 * `ui/editor` 单层复位的 `DEFAULT_SENSITIVITY` 一致。
 * 新建 Profile 的空壳层与「层存在但缺 sensitivity 字段」共用这一张表。
 */
export const DEFAULT_LAYER_SENSITIVITIES = [0.2, 0.5, 0.8, 1.2, 1.6] as const

// ── 内部状态 ──
let profiles = new Map<string, ProfileData>()
let activeId: string | null = null;
let loaded = false;

// ── YAML 加载 ──
let jsYamlModule: any = null;

async function loadYaml(): Promise<any> {
  if (!jsYamlModule) jsYamlModule = await import("js-yaml");
  return jsYamlModule;
}

async function readProfileYaml<T>(profileId: string, relativePath: string): Promise<T> {
  const bytes = await getHostBridge().request("profile_file_read", { profileId, relativePath });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const yaml = await loadYaml();
  return yaml.load(text) as T;
}

/** 导入或复制后清理内存缓存，确保下次加载读取最新文件。 */
export function invalidateProfileCache(profileId: string): void {
  profiles.delete(profileId)
}

/** 清空全部 Profile 缓存（默认资源恢复后调用，让下次读取走磁盘）。 */
export function invalidateAllProfileCaches(): void {
  profiles.clear()
}

/** 文件编辑后重新读取运行时 Profile；保留旧接口以供图层编辑器触发刷新。 */
export async function refreshProfileAssets(profileId: string): Promise<ProfileData | null> {
  const wasActive = activeId === profileId
  invalidateProfileCache(profileId)
  const profile = await ensureProfileLoaded(profileId)
  if (profile && wasActive) activateProfile(profileId)
  return profile
}

// ── Profile 加载 ──

/** 按层取默认值：层数超出缺省表长度时回退到最后一层并留痕，绝不产出 undefined。 */
function layerDefault<T>(table: readonly T[], index: number, field: string): T {
  const value = table[index]
  if (value !== undefined) return value
  log.warn(`Profile 层数超出默认表长度，${field} 回退最后一层默认值: layer=${index}`)
  return table[table.length - 1]!
}

async function loadProfile(id: string): Promise<ProfileData> {
  const rawProfile = await readProfileYaml<any>(id, "profile.yaml");

  return {
    id,
    meta: {
      name: rawProfile?.meta?.name || id,
      description: rawProfile?.meta?.description || "",
      version: rawProfile?.meta?.version || 1,
    },
    theme: {
      parallax: {
        layers: (rawProfile?.theme?.parallax?.layers || []).map((l: any, i: number) => ({
          enabled: l?.enabled ?? (i === 2),
          image: l?.image ?? (i === 2 ? "materials/L2/body.png" : ""),
          sensitivity: l?.sensitivity ?? layerDefault(DEFAULT_LAYER_SENSITIVITIES, i, "sensitivity"),
          scale: l?.scale ?? 1.0,
          offsetX: l?.offsetX ?? 0,
          offsetY: l?.offsetY ?? 0,
          locked: l?.locked ?? false,
        })),
      },
    },
  };
}

// ── 公共 API ──

export async function initProfiles(): Promise<void> {
  if (loaded) return;
  const targetId = appearanceConfig.activeProfile || DEFAULT_PROFILE;
  let loadFailure: unknown
  try {
    const data = await loadProfile(targetId);
    profiles.set(targetId, data);
    log.info(`Profile 已加载: "${targetId}" (${data.meta.name})`);
  } catch (e) {
    loadFailure = e
    log.error(`Profile "${targetId}" 加载失败:`, formatError(e));
    if (targetId !== DEFAULT_PROFILE) {
      try {
        const fallback = await loadProfile(DEFAULT_PROFILE);
        profiles.set(DEFAULT_PROFILE, fallback);
        log.warn(`回退到默认 Profile: "${DEFAULT_PROFILE}"`);
      } catch (e2) {
        loadFailure = e2
        log.error("默认 Profile 也加载失败:", formatError(e2))
      }
    }
  }
  if (profiles.size === 0) {
    throw Object.assign(new Error("激活的 Profile 与默认 Profile 均无法加载"), { cause: loadFailure })
  }
  loaded = true;
  if (profiles.has(targetId)) activateProfile(targetId);
  else if (profiles.size > 0) activateProfile(profiles.keys().next().value!);
}

export async function discoverAllProfiles(): Promise<string[]> {
  const found = new Set<string>();
  try {
    const runtimeProfiles: string[] = await getHostBridge().request("list_profiles", {});
    for (const id of runtimeProfiles) found.add(id);
  } catch (e) {
    log.warn("列举 Profile 失败", formatError(e));
  }
  return [...found];
}

export async function ensureProfileLoaded(id: string): Promise<ProfileData | null> {
  if (profiles.has(id)) return profiles.get(id)!;
  try {
    const data = await loadProfile(id);
    profiles.set(id, data);
    // 内存只留「激活的 + 刚加载的」这一瞬过渡；切换完成后由 activateProfile 收敛到只剩激活
    for (const key of [...profiles.keys()]) {
      if (key !== id && key !== activeId) {
        profiles.delete(key);
      }
    }
    return data;
  }
  catch (e) { log.error(`Profile "${id}" 加载失败:`, formatError(e)); return null; }
}

export function activateProfile(id: string): boolean {
  if (!profiles.has(id)) { log.error(`Profile "${id}" 未加载`); return false; }
  activeId = id;
  const p = profiles.get(id)!;
  // 内存只留激活 Profile：切换成功即淘汰其余缓存（数据 + 资产目录 URL）
  for (const key of [...profiles.keys()]) {
    if (key !== id) {
      profiles.delete(key);
    }
  }
  // 原生 UI 的舞台快照随激活项重推（W9b）：信号走零依赖叶子，避免 loader ↔
  // 推送模块的循环依赖；未注册消费者（如早期引导）时是 no-op，注册方自行补首推。
  notifyActiveProfileChanged();
  log.info(`Profile 已激活: "${id}" (${p.meta.name})`);
  return true;
}

/**
 * 切换活动 Profile 的唯一入口：内存激活 + 持久化 appearance.activeProfile。
 *
 * 返回 false 时保持原状态：`activateProfile` 失败不会改写 `activeId`，调用方
 * 不要自己再拼 `activateProfile` + `setOverride`。
 *
 * 「通知其它窗口刷新」是**纯 UI 的窗口间协调**（原生宿主迁移过程记录 §9.4 第 7 条判据 (b)，不进 Node 图）：
 * 原生 UI 若需要刷新，由其在内部承接。
 */
export async function switchActiveProfile(id: string): Promise<boolean> {
  const profile = await ensureProfileLoaded(id)
  if (!profile) { log.error(`Profile "${id}" 不可用，切换取消`); return false }
  if (!activateProfile(id)) return false
  setOverride("appearance.activeProfile", id)
  await flushConfig()
  return true
}

export function getActiveProfile(): ProfileData | null {
  if (!activeId) return null;
  return profiles.get(activeId) || null;
}

export function getProfile(id: string): ProfileData | undefined {
  return profiles.get(id);
}

export function isProfilesLoaded(): boolean { return loaded; }

/** 轻量读 meta（设置页列 Profile 用）：只取 meta、不进缓存 —— 内存里只留激活 Profile。 */
export async function readProfileMeta(id: string): Promise<ProfileMeta | null> {
  try {
    const raw = await readProfileYaml<any>(id, "profile.yaml")
    return {
      name: raw?.meta?.name || id,
      description: raw?.meta?.description || "",
      version: raw?.meta?.version || 1,
    }
  } catch (e) {
    log.warn(`读取 Profile meta 失败: ${id}`, formatError(e))
    return null
  }
}

/** 获取灵动图层素材 URL，从 profile parallax.image 字段解析 */
