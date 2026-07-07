// 音效系统 — 共享类型
export interface SoundDef {
  id: string
  name: string
  play: () => Promise<void>
}
