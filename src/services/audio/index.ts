// 音效系统 — 统一入口
export {
  getSoundLibrary, getSoundById, getSoundAssignments,
  saveSoundAssignments, playEventSound, playSoundById, playNotificationByBoundary,
  soundEvents, buildNativeCueClips,
  type SoundEvent, type SoundDef,
  type NativeCueClips,
} from "./registry"
