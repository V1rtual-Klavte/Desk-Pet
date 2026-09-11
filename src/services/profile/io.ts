// ==========================================
// Profile IO — 导入 / 导出 / 复制 / 删除
//
// 内置 profile 从只读资源目录读取，用户 profile 写入 AppPaths.profiles。
// 所有操作返回 ProfileOpResult，由调用方决定怎么提示用户 —— 不在这里弹窗，
// 保持服务层与 UI 解耦。
// ==========================================

import JSZip from "jszip";
import { invoke } from "@tauri-apps/api/core";
import { getProfile, invalidateProfileCache } from "./loader";
import { BaseDirs } from "@/services/paths";
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
 * 复制 Profile（内置或用户都可以作为源）。
 *
 * 副本必须改写 `meta.builtin = false` —— 否则会被当成只读内置资源；
 * 同时删掉 `meta.preset`，否则会混进设置页的预设按钮里。
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
    doc.meta = { ...(doc.meta || {}), builtin: false }
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

    if (getProfile(profileId)?.meta.builtin) {
      return fail(`"${profileId}" 与内置 Profile 同名，请重命名压缩包后再导入`)
    }

    let count = 0
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      // 跳过 macOS 打包产生的隐藏文件
      if (path.startsWith("__MACOSX") || path.includes("/._")) continue
      const data = await entry.async("uint8array")
      await invoke("profile_file_write", {
        profileId,
        relativePath: path,
        content: Array.from(data as Uint8Array),
      })
      count++
    }

    invalidateProfileCache(profileId)
    log.info(`已导入 ${profileId}（${count} 个文件）`)
    return { ...ok(`已导入 ${count} 个文件`, `${BaseDirs.profiles()}/${profileId}`), profileId }
  } catch (e) {
    log.error("导入失败", formatError(e))
    return fail(formatError(e))
  }
}

// ── 删除 ──

export async function deleteProfile(profileId: string): Promise<ProfileOpResult> {
  const profile = getProfile(profileId)
  if (profile?.meta.builtin) {
    return fail(`"${profileId}" 是内置 Profile，不可删除`)
  }
  try {
    await invoke("profile_delete", { profileId })
    invalidateProfileCache(profileId)
    log.info(`已删除 Profile: ${profileId}`)
    return ok(`已删除 ${profileId}`, profileLabel(profileId))
  } catch (e) {
    log.error("删除失败", formatError(e))
    return fail(formatError(e))
  }
}
