// 长音效 (2-3s): 风潮/水晶/暖阳/余韵
import { getCtx } from "../context"
import type { SoundDef } from "../types"
export const longSounds: SoundDef[] = [
  {
    id: "wind_long", name: "风潮",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [262, 330, 392, 523].forEach((freq, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = freq
          gain.gain.setValueAtTime(0.001, ctx.currentTime)
          gain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.6)
          gain.gain.setValueAtTime(0.06, ctx.currentTime + 1.8)
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(ctx.currentTime + i * 0.15); osc.stop(ctx.currentTime + 2.5)
        })
      } catch {}
    },
  },
  {
    id: "crystal_long", name: "水晶",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [1047, 1319, 1568, 1760, 2093, 2637].forEach((freq, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = freq
          const t = ctx.currentTime + i * 0.25
          gain.gain.setValueAtTime(0.001, t)
          gain.gain.linearRampToValueAtTime(0.07, t + 0.06)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.50)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(t); osc.stop(t + 0.50)
        })
      } catch {}
    },
  },
  {
    id: "warm_long", name: "暖阳",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain()
        osc.type = "sawtooth"
        osc.frequency.setValueAtTime(220, ctx.currentTime)
        osc.frequency.linearRampToValueAtTime(330, ctx.currentTime + 1.2)
        osc.frequency.linearRampToValueAtTime(220, ctx.currentTime + 2.2)
        filter.type = "lowpass"
        filter.frequency.setValueAtTime(400, ctx.currentTime)
        filter.frequency.linearRampToValueAtTime(2000, ctx.currentTime + 1.0)
        filter.frequency.linearRampToValueAtTime(400, ctx.currentTime + 2.0)
        filter.Q.value = 2
        gain.gain.setValueAtTime(0.001, ctx.currentTime)
        gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.3)
        gain.gain.setValueAtTime(0.08, ctx.currentTime + 1.8)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.3)
        osc.connect(filter); filter.connect(gain); gain.connect(ctx.destination)
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 2.3)
      } catch {}
    },
  },
  {
    id: "bell_long", name: "余韵",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [{ f: 523, g: 0.12 }, { f: 659, g: 0.06 }, { f: 784, g: 0.05 }, { f: 1047, g: 0.04 }, { f: 1319, g: 0.03 }, { f: 1568, g: 0.02 }].forEach(({ f, g }) => {
          const osc = ctx.createOscillator(), gainNode = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = f
          gainNode.gain.setValueAtTime(g, ctx.currentTime)
          gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.8)
          osc.connect(gainNode); gainNode.connect(ctx.destination)
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 2.8)
        })
      } catch {}
    },
  },
]
