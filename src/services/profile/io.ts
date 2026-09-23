// ==========================================
// Profile IO — 导入 / 导出 / 复制 / 删除
//
// 所有 Profile 都从运行时 data_root/profiles 读取和写入。
// 所有操作返回 ProfileOpResult，由调用方决定怎么提示用户 —— 不在这里弹窗，
// 保持服务层与 UI 解耦。
// ==========================================

import JSZip from "jszip";
import { invoke } from "@tauri-apps/api/core";
import {
  getActiveProfile,
  invalidateAllProfileCaches,
  invalidateProfileCache,
  listProfiles,
  switchActiveProfile,
} from "./loader";
import { BaseDirs, DEFAULT_PROFILE } from "@/services/paths";
import { createLogger } from "@/services/logger";
import { formatError } from "@/services/error";

const log = createLogger("ProfileIO");

/** 所有 Profile 操作的统一返回 */
export interface ProfileOpResult {
  ok: boolean
  /** 给用户看的一句话结论 */
  message: string
  /** 补充详情，如完整路径 */
  detail?: string
  /** 用户主动取消 —— 不是失败，调用方应直接静默返回 */
  cancelled?: boolean
}

function ok(message: string, detail?: string): ProfileOpResult {
  return { ok: true, message, detail }
}
function fail(message: string, detail?: string): ProfileOpResult {
  return { ok: false, message, detail }
}
const CANCELLED: ProfileOpResult = { ok: false, cancelled: true, message: "" }

/** 用户 profile 的展示用路径（相对 data_root） */
function profileLabel(profileId: string): string {
  return `profiles/${profileId}`
}

// ── 导出 ──

/**
 * 导出 Profile 为 zip。
 *
 * 打包与写盘都在 Rust 侧完成：Profile 实测 28MB / 229 个文件，经 IPC 传字节会
 * 序列化成上百 MB 的 JSON 数组；而且 Rust 直接遍历目录，不需要前端维护文件清单。
 * Rust 会弹原生「另存为」对话框，用户取消时返回 Ok(None)。
 */
export async function exportProfileZip(profileId: string): Promise<ProfileOpResult> {
  try {
    const savedPath = await invoke<string | null>("export_profile_zip", { profileId });
    if (!savedPath) return CANCELLED;
    log.info(`已导出 ${profileId} → ${savedPath}`);
    return ok(`${profileId}.zip 已导出`, savedPath);
  } catch (e) {
    log.error("导出失败", formatError(e));
    return fail(formatError(e));
  }
}

// ── 复制 ──

/** 取最小的未占用副本名：copy1、copy2…… */
export function nextCloneId(existingIds: string[]): string {
  const taken = new Set(existingIds)
  for (let i = 1; ; i++) {
    const candidate = `copy${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * 复制 Profile。副本不再属于预设按钮，后续按普通运行时 Profile 管理。
 */
export async function cloneProfile(
  sourceId: string,
  existingIds: string[],
): Promise<ProfileOpResult & { newId?: string }> {
  const newId = nextCloneId(existingIds)
  try {
    await invoke("profile_clone", {
      sourceProfileId: sourceId,
      targetProfileId: newId,
    })

    const raw = await invoke<number[]>("profile_file_read", {
      profileId: newId,
      relativePath: "profile.yaml",
    })
    const jsYaml = await import("js-yaml")
    const doc = jsYaml.load(new TextDecoder().decode(new Uint8Array(raw))) as Record<string, any>
    doc.meta = { ...(doc.meta || {}) }
    delete doc.meta.builtin
    delete doc.meta.preset
    await invoke("profile_file_write", {
      profileId: newId,
      relativePath: "profile.yaml",
      content: Array.from(new TextEncoder().encode(jsYaml.dump(doc))),
    })

    invalidateProfileCache(newId)
    log.info(`已复制 Profile: ${sourceId} → ${newId}`)
    return { ...ok(`已复制为 ${newId}`, `${BaseDirs.profiles()}/${newId}`), newId }
  } catch (e) {
    log.error("复制失败", formatError(e))
    return fail(formatError(e))
  }
}

// ── 导入 ──

/** 从 zip 文件导入 profile */
export async function importProfileZip(file: File): Promise<ProfileOpResult & { profileId?: string }> {
  try {
    const zip = await JSZip.loadAsync(file)
    if (!zip.file("profile.yaml")) {
      return fail("压缩包缺少 profile.yaml，不是有效的 Profile 导出文件")
    }

    const profileId = file.name
      .replace(/\.zip$/i, "")
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .toLowerCase()
    if (!profileId) return fail("无法从文件名推导出合法的 Profile ID")

    let count = 0
    // 同路径判定按文件系统的口径：分隔符归一、去掉 `./`、不区分大小写
    // （macOS / Windows 默认大小写不敏感，两个条目会互相覆盖）
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      // 跳过 macOS 打包产生的隐藏文件
      if (path.startsWith("__MACOSX") || path.includes("/._")) continue
      const key = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
      const previous = seen.get(key)
      if (previous !== undefined && previous !== path) {
        collisions.push(`${previous} ← ${path}`)
        log.warn("导入包内两个条目指向同一路径，后者覆盖前者:", previous, path)
      }
      seen.set(key, path)
      const data = await entry.async("uint8array")
      await invoke("profile_file_write", {
        profileId,
        relativePath: path,
        content: Array.from(data as Uint8Array),
      })
      count++
    }

    invalidateProfileCache(profileId)
    log.info(
      `已导入 ${profileId}（${count} 个文件${collisions.length ? `，${collisions.length} 个条目被同路径条目覆盖` : ""}）`,
    )
    return {
      ...ok(
        collisions.length
          ? `已导入 ${count} 个文件，其中 ${collisions.length} 个条目被同路径的后续条目覆盖（去重后 ${count - collisions.length} 个路径）`
          : `已导入 ${count} 个文件`,
        collisions.length
          ? `被覆盖的条目: ${collisions.join(", ")}`
          : `${BaseDirs.profiles()}/${profileId}`,
      ),
      profileId,
    }
  } catch (e) {
    log.error("导入失败", formatError(e))
    return fail(formatError(e))
  }
}

// ── 删除 ──

/**
 * 删除运行时 Profile。
 *
 * 内置默认 Profile 是 `character.yaml` 与 `useDefaultUi` 的兜底来源，删掉会让整条
 * 回退链断掉，所以在这里前置拒绝（Rust 的 `profile_delete` 只删目录，不加同名常量，
 * 避免出现第二定义点）。被删的正好是当前活动 Profile 时，删完必须换一个可用的，
 * 否则 `activeId` 会悬空。
 */
export async function deleteProfile(profileId: string): Promise<ProfileOpResult> {
  if (profileId === DEFAULT_PROFILE) {
    return fail(`内置默认 Profile「${DEFAULT_PROFILE}」不能删除；如需还原请用「恢复默认资源」`)
  }
  const wasActive = getActiveProfile()?.id === profileId
  try {
    await invoke("profile_delete", { profileId })
    invalidateProfileCache(profileId)
    log.info(`已删除 Profile: ${profileId}`)

    if (!wasActive) return ok(`已删除 ${profileId}`, profileLabel(profileId))

    if (await switchActiveProfile(DEFAULT_PROFILE)) {
      return ok(`已删除 ${profileId}，已切回默认 Profile`, profileLabel(profileId))
    }
    const fallback = listProfiles().find((p) => p.id !== profileId)
    if (fallback && await switchActiveProfile(fallback.id)) {
      return ok(`已删除 ${profileId}，已切换到 ${fallback.id}`, profileLabel(profileId))
    }
    log.error(`已删除 ${profileId}，但没有可切换的 Profile（默认 Profile 不可用，内存中也无其他 Profile）`)
    return fail(`已删除 ${profileId}，但当前没有可用的 Profile，请重启应用或恢复默认资源`)
  } catch (e) {
    log.error("删除失败", formatError(e))
    return fail(formatError(e))
  }
}

// ── 恢复默认资源 ──

/** Rust 侧 restore_default_resources 的返回 */
interface RestoreResult {
  profiles: number
  cards: number
  skills: number
}

/**
 * 用随包种子覆盖运行时资源，恢复出厂状态。
 *
 * 会覆盖运行时目录里同名的内置 Profile 与 Card（含你对它们的改动）；
 * 用户自建的 Profile / Card 不在种子里，不受影响。调用方必须先向用户确认。
 */
export async function restoreDefaultResources(): Promise<ProfileOpResult> {
  try {
    const r = await invoke<RestoreResult>("restore_default_resources")

    // 磁盘上的内置资源已被覆盖：Profile 丢弃缓存，Card 与 Skill 重新读盘。
    invalidateAllProfileCaches()
    const { initCards } = await import("@/services/personality")
    await initCards()
    const { refreshSkills } = await import("@/services/skill")
    await refreshSkills()

    log.info(
      `默认资源已恢复: Profile ${r.profiles} 个文件, Card ${r.cards} 个文件, Skill ${r.skills} 个文件`,
    )
    return ok(
      `已恢复 ${r.profiles} 个 Profile 文件、${r.cards} 个 Card 文件、${r.skills} 个 Skill 文件`,
      "人格卡需重启后完全生效",
    )
  } catch (e) {
    log.error("恢复默认资源失败", formatError(e))
    return fail(formatError(e))
  }
}
