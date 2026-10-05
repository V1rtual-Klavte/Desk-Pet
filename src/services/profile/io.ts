// ==========================================
// Profile IO — 导入 / 导出 / 新建 / 重命名 / 删除
//
// 所有 Profile 都从运行时 data_root/profiles 读取和写入。
// 所有操作返回 ProfileOpResult，由调用方决定怎么提示用户 —— 不在这里弹窗，
// 保持服务层与 UI 解耦。
// ==========================================

import JSZip from "jszip";
import { join } from "node:path";
import { getHostBridge } from "@/services/host";
import {
  DEFAULT_LAYER_SENSITIVITIES,
  discoverAllProfiles,
  getActiveProfile,
  invalidateAllProfileCaches,
  invalidateProfileCache,
  readProfileMeta,
  refreshProfileAssets,
  switchActiveProfile,
} from "./loader";
import { BaseDirs, DEFAULT_PROFILE, runtimePath } from "@/services/paths";
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

/** Profile 的展示用完整路径（数据根下 `profiles/<id>`）。
 *  回执与设置页共用这一处，不在各处自行用 `/` 拼接；展示路径按平台原生分隔符
 *  拼（Windows 上 `\` 与 `/` 混拼的路径复制出去在资源管理器里打不开）。 */
export function profileDisplayPath(profileId: string): string {
  return join(BaseDirs.profiles(), profileId)
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
    const savedPath = await getHostBridge().request("export_profile_zip", { profileId });
    if (!savedPath) return CANCELLED;
    log.info(`已导出 ${profileId} → ${savedPath}`);
    return ok(`${profileId}.zip 已导出`, savedPath);
  } catch (e) {
    log.error("导出失败", formatError(e));
    return fail(formatError(e));
  }
}

// ── 新建 ──

/** 取最小的未占用新建 id：profile1、profile2……（id 只允许 ASCII；显示名另取，可重复） */
export function nextCreateId(existingIds: string[]): string {
  const taken = new Set(existingIds)
  for (let i = 1; ; i++) {
    const candidate = `profile${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/** 新 Profile 的默认显示名（序号与 id 一致；重名时按（2）（3）后缀避让）。 */
function defaultProfileName(id: string, takenNames: string[]): string {
  const base = `新 Profile ${id.replace(/^profile/, "")}`
  const taken = new Set(takenNames.map(name => name.trim()))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}（${i}）`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * 新建空 Profile：写带五层空壳的 profile.yaml，并预建五层素材目录。
 *
 * 空壳层（`theme.parallax.layers`）不能省：图层编辑器按 profile.yaml 的层列表建层，
 * 缺 layers 时整窗没有层可编辑，素材也就无处插入。五层目录（`materials/L0`…`L4`）
 * 让编辑器与用户在新建后立刻有可用的落点；层参数取缺省表，素材为空。
 *
 * id 取最小未占用序号（目录名），默认名与序号一致（被占用时加括号序号避让——
 * 显示名全局唯一，重名在下拉里无法区分）。Profile 文件走 `profile_file_write`
 * （唯一写入路径），素材目录经 `dir_create` + `runtimePath()`；本函数不碰文件系统、不拼数据根。
 */
export async function createProfile(
  existingIds: string[],
  takenNames: string[] = [],
): Promise<ProfileOpResult & { newId?: string }> {
  const newId = nextCreateId(existingIds)
  const name = defaultProfileName(newId, takenNames)
  try {
    const jsYaml = await import("js-yaml")
    const encoder = new TextEncoder()
    const layers = DEFAULT_LAYER_SENSITIVITIES.map((sensitivity) => ({
      enabled: true,
      image: "",
      sensitivity,
      scale: 1.0,
      offsetX: 0,
      offsetY: 0,
      locked: false,
    }))
    // 走 js-yaml dump 而不是手写模板：显示名含引号/冒号等字符时转义由库保证。
    const profileYaml = jsYaml.dump({
      meta: { name, description: "", version: 1 },
      theme: { parallax: { layers } },
    })
    await getHostBridge().request("profile_file_write", {
      profileId: newId,
      relativePath: "profile.yaml",
      content: encoder.encode(profileYaml),
    })

    // 五个素材目录用宿主既有 mkdir 能力（`dir_create`）真建空目录：不带占位文件，
    // 用户数据与导出包里不留垃圾。绝对路径经 `runtimePath()` 由 Rust 解析与边界校验
    // （通用文件 API 的唯一取法，TS 不拼数据根，与 observation/behavior 建运行时目录同路）。
    for (let i = 0; i < layers.length; i++) {
      const dir = await runtimePath("profiles", newId, "materials", `L${i}`)
      await getHostBridge().request("dir_create", { path: dir, recursive: true })
    }

    invalidateProfileCache(newId)
    log.info(`已新建空 Profile: ${newId}（${name}），已预置五层空壳与素材目录`)
    return { ...ok(`已新建 ${name}`, profileDisplayPath(newId)), newId }
  } catch (e) {
    log.error("新建 Profile 失败", formatError(e))
    return fail(formatError(e))
  }
}

// ── 重命名 ──

/**
 * 改 Profile 的显示名（`meta.name`）：只动 profile.yaml 的 meta 段，
 * id（目录名）不变，因此素材与引用不受影响。
 *
 * 显示名全局唯一：与其它 Profile 重名时如实拒绝（下拉按名字区分，重名等于无法区分；
 * 用户报过「两个 yuki 分不清」的问题）。比对按裁剪空白后的精确匹配。
 */
export async function renameProfile(profileId: string, rawName: string): Promise<ProfileOpResult> {
  const name = rawName.trim()
  if (!name) return fail("Profile 名称不能为空")
  try {
    for (const id of await discoverAllProfiles()) {
      if (id === profileId) continue
      const meta = await readProfileMeta(id)
      if (meta && meta.name.trim() === name) {
        return fail(`已有同名 Profile：「${name}」，请换一个名字`)
      }
    }

    const raw = await getHostBridge().request("profile_file_read", {
      profileId,
      relativePath: "profile.yaml",
    })
    const jsYaml = await import("js-yaml")
    const doc = jsYaml.load(new TextDecoder().decode(raw)) as Record<string, any>
    doc.meta = { ...(doc.meta || {}), name }
    await getHostBridge().request("profile_file_write", {
      profileId,
      relativePath: "profile.yaml",
      content: new TextEncoder().encode(jsYaml.dump(doc)),
    })

    invalidateProfileCache(profileId)
    // 内存只保留激活 Profile：改的是激活项时同步重载，其余目录本就不在内存。
    if (getActiveProfile()?.id === profileId) await refreshProfileAssets(profileId)
    log.info(`已重命名 Profile: ${profileId} → ${name}`)
    return ok(`已重命名为 ${name}`, profileDisplayPath(profileId))
  } catch (e) {
    log.error("重命名 Profile 失败", formatError(e))
    return fail(formatError(e))
  }
}

// ── 导入 ──

/**
 * 从 zip 导入 profile。
 *
 * 参数用结构类型（`name` + `arrayBuffer`）而不是 DOM `File`：导入入口有两个 ——
 * 旧的网页壳直接给 `File`，原生设置窗（Node 侧）只有路径读出的字节，包一个同形状的
 * 对象即可；两者都是「有名字、能取字节的 zip」，不需要 DOM File 才能导入。
 */
export async function importProfileZip(file: {
  name: string
  arrayBuffer(): Promise<ArrayBuffer>
}): Promise<ProfileOpResult & { profileId?: string }> {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
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
      await getHostBridge().request("profile_file_write", {
        profileId,
        relativePath: path,
        content: data,
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
          : profileDisplayPath(profileId),
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
 * 内置默认 Profile 是 `appearance.activeProfile` 的默认值、首启种子与「恢复默认资源」
 * 的覆盖目标，删除会让配置默认值悬空，所以在这里前置拒绝（Rust 的 `profile_delete`
 * 只删目录，不加同名常量，避免出现第二定义点）。被删的正好是当前活动 Profile 时，
 * 删完必须换一个可用的，否则 `activeId` 会悬空。
 */
export async function deleteProfile(profileId: string): Promise<ProfileOpResult> {
  if (profileId === DEFAULT_PROFILE) {
    return fail(`内置默认 Profile「${DEFAULT_PROFILE}」不能删除；如需还原请用「恢复默认资源」`)
  }
  const wasActive = getActiveProfile()?.id === profileId
  try {
    await getHostBridge().request("profile_delete", { profileId })
    invalidateProfileCache(profileId)
    log.info(`已删除 Profile: ${profileId}`)

    if (!wasActive) return ok(`已删除 ${profileId}`, profileDisplayPath(profileId))

    if (await switchActiveProfile(DEFAULT_PROFILE)) {
      return ok(`已删除 ${profileId}，已切回默认 Profile`, profileDisplayPath(profileId))
    }
    const fallbackId = (await discoverAllProfiles()).find(id => id !== profileId)
    if (fallbackId && await switchActiveProfile(fallbackId)) {
      return ok(`已删除 ${profileId}，已切换到 ${fallbackId}`, profileDisplayPath(profileId))
    }
    log.error(`已删除 ${profileId}，但没有可切换的 Profile（默认 Profile 不可用，磁盘上也别无可用项）`)
    return fail(`已删除 ${profileId}，但当前没有可用的 Profile，请重启应用或恢复默认资源`)
  } catch (e) {
    log.error("删除失败", formatError(e))
    return fail(formatError(e))
  }
}

// ── 恢复默认资源 ──

/** Rust 侧 restore_default_resources 的返回（HostCommandMap 复用本类型，见 @/services/host）。 */
export interface RestoreResult {
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
    const r = await getHostBridge().request("restore_default_resources", {})

    // 磁盘上的内置资源已被覆盖：Profile 丢弃缓存，Card 与 Skill 重新读盘。
    // Skill 走唯一的指纹核对入口：重种子必然改动 mtime/size，指纹变了就会重载，
    // 不另开一条「强制刷新」路径，也不在两处各存一份缓存。
    invalidateAllProfileCaches()
    const { initCards } = await import("@/services/personality")
    await initCards()
    const { syncSkillCatalog } = await import("@/services/skill")
    await syncSkillCatalog()

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
