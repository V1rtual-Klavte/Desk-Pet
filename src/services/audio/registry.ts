// Native 音效预设单一注册表：保留设置页 metadata 与既有 CONFIG 事件分配。

import { getOverride, setOverride } from "@/services/config"
import { reportError } from "@/services/error"
import { getHostBridge } from "@/services/host"
import { renderSoundGraphWav } from "./synth"
import { soundPresets } from "./presets"
import type { SoundDef } from "./types"

export type { SoundDef }

const soundLibrary: readonly SoundDef[] = soundPresets
const soundById = new Map(soundLibrary.map((sound) => [sound.id, sound] as const))

/** 获取设置页音效元数据；ID 与显示名沿用既有登记。 */
export function getSoundLibrary(): SoundDef[] {
  return soundLibrary.map(({ id, name, compose }) => ({ id, name, compose }))
}

export function getSoundById(id: string): SoundDef | undefined {
  return soundById.get(id)
}

export interface SoundEvent {
  key: string
  label: string
  defaultSoundId: string
}

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

const eventDefaults = Object.fromEntries(soundEvents.map(({ key, defaultSoundId }) => [key, defaultSoundId]))

function loadAssignments(): Record<string, string> {
  return getOverride<Record<string, string>>("appearance.soundAssignments") || {}
}

export function getSoundAssignments(): Record<string, string> {
  const stored = loadAssignments()
  const assignments: Record<string, string> = {}
  for (const event of soundEvents) assignments[event.key] = stored[event.key] || event.defaultSoundId
  return assignments
}

export function saveSoundAssignments(assignments: Record<string, string>): void {
  setOverride("appearance.soundAssignments", assignments)
}

async function playWav(data: string, soundId: string): Promise<void> {
  if (!data) return
  try {
    await getHostBridge().request("audio_play_wav", { data })
  } catch (error) {
    // Audio is a side effect of interaction and must never turn an accepted message into failure.
    // Keep the reason visible through the shared error outlet instead of falling silent.
    reportError("Audio", error, { kind: `Native 音效播放失败（${soundId}）`, overlay: false })
  }
}

/** 编译并播放一条预设 WAV；公开事件入口继续使用当前配置的 soundAssignments。 */
export async function playEventSound(eventKey: string): Promise<void> {
  const assignments = loadAssignments()
  const soundId = assignments[eventKey] || eventDefaults[eventKey] || "none"
  if (soundId === "none") return
  const sound = soundById.get(soundId)
  if (!sound) {
    reportError("Audio", new Error(`未登记的音效 ID：${soundId}`), { kind: "音效分配无效", overlay: false })
    return
  }
  try {
    const wav = renderSoundGraphWav(sound.compose())
    await playWav(wav, soundId)
  } catch (error) {
    reportError("Audio", error, { kind: `Native 音效图编译失败（${soundId}）`, overlay: false })
  }
}

/**
 * 试听指定音效（设置页「试听」入口）：只编译与播放，不改 CONFIG、不影响事件分配。
 *
 * 未知 ID 与波形编译失败如实抛错（调用方把失败呈现给用户）；播放通道本身失败
 * 仍走统一错误出口（非致命，与事件播放入口一致）。
 */
export async function playSoundById(soundId: string): Promise<void> {
  if (soundId === "none") return
  const sound = soundById.get(soundId)
  if (!sound) throw new Error(`未登记的音效 ID：${soundId}`)
  const wav = renderSoundGraphWav(sound.compose())
  await playWav(wav, soundId)
}

/** unansweredCount 分档行为与原入口一致。 */
export async function playNotificationByBoundary(unansweredCount?: number): Promise<void> {
  const count = unansweredCount ?? 0
  if (count <= 1) await playEventSound("surface")
  else if (count <= 3) await playEventSound("middle")
  else await playEventSound("deep")
}

export interface NativeCueClips {
  welcome: string | null
  popup: string | null
  retract: string | null
}

/** 首次握手后推给 Native 的三条宿主生命周期提示；Native 不复刻预设波形。 */
export function buildNativeCueClips(): NativeCueClips {
  const assignments = getSoundAssignments()
  const build = (eventKey: keyof NativeCueClips): string | null => {
    const soundId = assignments[eventKey]
    if (soundId === "none") return null
    const sound = soundById.get(soundId)
    if (!sound) {
      reportError("Audio", new Error(`事件 ${eventKey} 分配到未知音效 ${soundId}`), { kind: "原生提示音分配无效", overlay: false })
      return null
    }
    try {
      return renderSoundGraphWav(sound.compose())
    } catch (error) {
      reportError("Audio", error, { kind: `原生提示音编译失败（${eventKey}/${soundId}）`, overlay: false })
      return null
    }
  }
  return {
    welcome: build("welcome"),
    popup: build("popup"),
    retract: build("retract"),
  }
}
