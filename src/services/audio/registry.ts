// ==========================================
// 音效注册中心
// 音效定义由 effects/*.ts 提供，本文件负责注册 + 事件分配
// ==========================================

import type { SoundDef } from "./types"

// 从各效果文件导入音效数组
import { basicSounds } from "./effects/basic"
import { surfaceSounds } from "./effects/surface"
import { shortSounds } from "./effects/short"
import { midSounds } from "./effects/mid"
import { longSounds } from "./effects/long"
import { horrorSounds } from "./effects/horror"
import { specialSounds } from "./effects/special"
import { pingSounds } from "./effects/ping"

// ── 音效类型 ──
export type { SoundDef }

// ── 音效库（组装所有分类）──
const soundLibrary: SoundDef[] = [
  ...basicSounds,
  ...surfaceSounds,
  ...shortSounds,
  ...midSounds,
  ...longSounds,
  ...horrorSounds,
  ...specialSounds,
  ...pingSounds,
]

/** 获取完整音效库 */
export function getSoundLibrary(): SoundDef[] {
  return soundLibrary
}

/** 按 ID 查找音效 */
export function getSoundById(id: string): SoundDef | undefined {
  return soundLibrary.find(s => s.id === id)
}

// ── 音效事件定义 ──
export interface SoundEvent {
  key: string
  label: string
  defaultSoundId: string
}

/** 所有可配置音效事件 */
export const soundEvents: SoundEvent[] = [
  { key: "welcome", label: "启动欢迎", defaultSoundId: "welcome_chord" },
  { key: "send", label: "发送消息", defaultSoundId: "send_short" },
  { key: "reply", label: "收到回复", defaultSoundId: "reply_ding" },
  { key: "popup", label: "弹窗出现", defaultSoundId: "popup_up" },
  { key: "retract", label: "窗口收回", defaultSoundId: "retract_down" },
  { key: "surface", label: "表层提示", defaultSoundId: "surface_light" },
  { key: "middle", label: "中层提示", defaultSoundId: "middle_tremolo" },
  { key: "deep", label: "深层提示", defaultSoundId: "deep_noise" },
]

/** 事件 key → 默认音效 ID 速查表 */
const eventDefaults: Record<string, string> = {}
for (const e of soundEvents) eventDefaults[e.key] = e.defaultSoundId

// ── 用户音效分配（localStorage）──
const ASSIGNMENTS_KEY = "deskpet_sound_assignments"

function loadAssignments(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || "{}")
  } catch (e) {
    console.warn("[Audio] 音效分配数据解析失败，已重置:", e)
    return {}
  }
}

/** 获取所有音效分配 */
export function getSoundAssignments(): Record<string, string> {
  const stored = loadAssignments()
  const result: Record<string, string> = {}
  for (const e of soundEvents) {
    result[e.key] = stored[e.key] || e.defaultSoundId
  }
  return result
}

/** 保存音效分配 */
export function saveSoundAssignments(assignments: Record<string, string>): void {
  try {
    localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments))
  } catch {}
}

// ── 统一播放入口 ──

/** 播放指定事件的音效（按用户分配，回退默认） */
export async function playEventSound(eventKey: string): Promise<void> {
  const assignments = loadAssignments()
  const soundId = assignments[eventKey] || eventDefaults[eventKey] || "none"
  if (soundId === "none") return
  await getSoundById(soundId)?.play()
}

/** 根据 unansweredCount 联动提示音效 */
export async function playNotificationByBoundary(unansweredCount?: number): Promise<void> {
  const count = unansweredCount ?? 0
  if (count <= 1) await playEventSound("surface")
  else if (count <= 3) await playEventSound("middle")
  else await playEventSound("deep")
}
