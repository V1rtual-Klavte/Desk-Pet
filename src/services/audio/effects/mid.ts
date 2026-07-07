// 中音效 (200-500ms): 琶音/柔波/星尘/共鸣
import { getCtx } from "../context"
import type { SoundDef } from "../types"
export const midSounds: SoundDef[] = [
  {
    id: "arpeggio_mid", name: "琶音上行",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [659, 784, 1047, 1319].forEach((freq, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = freq
          const t = ctx.currentTime + i * 0.08
          gain.gain.setValueAtTime(0.09, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(t); osc.stop(t + 0.14)
        })
      } catch {}
    },
  },
  {
    id: "wave_mid", name: "柔波",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), lfo = ctx.createOscillator(), lfoGain = ctx.createGain(), gain = ctx.createGain()
        osc.type = "sine"
        osc.frequency.setValueAtTime(800, ctx.currentTime)
        osc.frequency.linearRampToValueAtTime(1000, ctx.currentTime + 0.20)
        lfo.type = "sine"; lfo.frequency.value = 5; lfoGain.gain.value = 0.3
        lfo.connect(lfoGain); lfoGain.connect(gain.gain)
        gain.gain.setValueAtTime(0.12, ctx.currentTime); gain.gain.setValueAtTime(0.12, ctx.currentTime + 0.30)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.40)
        osc.connect(gain); gain.connect(ctx.destination)
        lfo.start(ctx.currentTime); osc.start(ctx.currentTime)
        lfo.stop(ctx.currentTime + 0.42); osc.stop(ctx.currentTime + 0.42)
      } catch {}
    },
  },
  {
    id: "sparkle_mid", name: "星尘",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const baseFreqs = [2000, 2800, 3600, 4400, 5200]
        for (let i = 0; i < 8; i++) {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "sine"
          osc.frequency.value = baseFreqs[i % baseFreqs.length] + Math.random() * 400
          const t = ctx.currentTime + Math.random() * 0.20
          gain.gain.setValueAtTime(0.04, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08 + Math.random() * 0.06)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(t); osc.stop(t + 0.20)
        }
      } catch {}
    },
  },
  {
    id: "resonance_mid", name: "共鸣",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [523, 784, 1047, 1319, 1568].forEach((freq, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = i === 0 ? "sine" : "triangle"; osc.frequency.value = freq
          gain.gain.setValueAtTime(0.06 - i * 0.01, ctx.currentTime)
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.46)
        })
      } catch {}
    },
  },
]
