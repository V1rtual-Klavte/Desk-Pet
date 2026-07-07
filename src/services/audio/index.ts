// 音效系统 — 统一入口
export {
  getSoundLibrary, getSoundById, getSoundAssignments,
  saveSoundAssignments, playEventSound, playNotificationByBoundary,
  soundEvents,
  type SoundEvent, type SoundDef,
} from "./registry"
