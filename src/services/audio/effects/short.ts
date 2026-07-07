// 短音效 (<200ms): 电子弹跳/水滴/风铃/咔哒
import { getCtx } from "../context"
import type { SoundDef } from "../types"
export const shortSounds: SoundDef[] = [
  {
    id: "pop_short", name: "电子弹跳",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        osc.type = "square"
        osc.frequency.setValueAtTime(400, ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(2400, ctx.currentTime + 0.06)
        gain.gain.setValueAtTime(0.10, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.10)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.10)
      } catch {}
    },
  },
  {
    id: "drop_short", name: "水滴",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        osc.type = "sine"
        osc.frequency.setValueAtTime(2400, ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.12)
        gain.gain.setValueAtTime(0.15, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.14)
      } catch {}
    },
  },
  {
    id: "chime_short", name: "风铃",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc1 = ctx.createOscillator(), osc2 = ctx.createOscillator(), gain = ctx.createGain()
        osc1.type = "triangle"; osc1.frequency.value = 1600
        osc2.type = "triangle"; osc2.frequency.value = 2400
        gain.gain.setValueAtTime(0.12, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16)
        osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination)
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime + 0.02)
        osc1.stop(ctx.currentTime + 0.16); osc2.stop(ctx.currentTime + 0.16)
      } catch {}
    },
  },
  {
    id: "tick_short", name: "咔哒",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        osc.type = "sine"
        osc.frequency.setValueAtTime(200, ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.04)
        gain.gain.setValueAtTime(0.20, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.05)
      } catch {}
    },
  },
]
