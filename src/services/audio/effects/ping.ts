// 短提醒单音 (余韵风格): 金铎/银铃/玉磬/铜磬
import { getCtx } from "../context"
import type { SoundDef } from "../types"
export const pingSounds: SoundDef[] = [
  {
    id: "ping_low", name: "金铎",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [{ f: 262, g: 0.14, t: "sine" }, { f: 330, g: 0.06, t: "sine" }, { f: 392, g: 0.05, t: "sine" }, { f: 523, g: 0.07, t: "triangle" }, { f: 659, g: 0.04, t: "sine" }, { f: 784, g: 0.03, t: "triangle" }, { f: 1047, g: 0.02, t: "sine" }].forEach(({ f, g, t }) => {
          const osc = ctx.createOscillator(), gainNode = ctx.createGain()
          osc.type = t as OscillatorType; osc.frequency.value = f
          gainNode.gain.setValueAtTime(g, ctx.currentTime)
          gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.8)
          osc.connect(gainNode); gainNode.connect(ctx.destination)
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 2.8)
        })
      } catch {}
    },
  },
  {
    id: "ping_mid", name: "银铃",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [{ f: 784, g: 0.10, d: 0.00 }, { f: 988, g: 0.05, d: 0.04 }, { f: 1175, g: 0.06, d: 0.08 }, { f: 1480, g: 0.04, d: 0.03 }, { f: 1568, g: 0.05, d: 0.12 }, { f: 1760, g: 0.03, d: 0.06 }, { f: 1976, g: 0.02, d: 0.15 }].forEach(({ f, g, d }) => {
          const osc = ctx.createOscillator(), gainNode = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = f
          const t = ctx.currentTime + d
          gainNode.gain.setValueAtTime(0.001, t)
          gainNode.gain.linearRampToValueAtTime(g, t + 0.03)
          gainNode.gain.exponentialRampToValueAtTime(0.001, t + 2.0)
          osc.connect(gainNode); gainNode.connect(ctx.destination)
          osc.start(t); osc.stop(t + 2.0)
        })
      } catch {}
    },
  },
  {
    id: "ping_crisp", name: "玉磬",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [{ f: 1319, g: 0.11 }, { f: 1661, g: 0.06 }, { f: 1976, g: 0.05 }, { f: 2637, g: 0.04 }, { f: 3322, g: 0.025 }, { f: 3951, g: 0.015 }, { f: 5274, g: 0.008 }].forEach(({ f, g }) => {
          const osc = ctx.createOscillator(), gainNode = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = f
          gainNode.gain.setValueAtTime(g, ctx.currentTime)
          gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5)
          osc.connect(gainNode); gainNode.connect(ctx.destination)
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 2.5)
        })
      } catch {}
    },
  },
  {
    id: "ping_high", name: "铜磬",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [{ f: 440, g: 0.12 }, { f: 554, g: 0.05 }, { f: 659, g: 0.06 }, { f: 880, g: 0.04 }, { f: 1109, g: 0.03 }, { f: 1320, g: 0.02 }].forEach(({ f, g }) => {
          const osc = ctx.createOscillator(), lfo = ctx.createOscillator(), lfoGain = ctx.createGain(), gainNode = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = f
          lfo.type = "sine"; lfo.frequency.value = 3.5 + Math.random()
          lfoGain.gain.value = f * 0.002
          lfo.connect(lfoGain); lfoGain.connect(osc.frequency)
          gainNode.gain.setValueAtTime(g, ctx.currentTime)
          gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 3.0)
          osc.connect(gainNode); gainNode.connect(ctx.destination)
          lfo.start(ctx.currentTime); osc.start(ctx.currentTime)
          lfo.stop(ctx.currentTime + 3.0); osc.stop(ctx.currentTime + 3.0)
        })
      } catch {}
    },
  },
]
