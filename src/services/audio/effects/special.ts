// 特色长音效: 宇宙飘浮/脉冲/雨滴/八音盒
import { getCtx } from "../context"
import type { SoundDef } from "../types"
export const specialSounds: SoundDef[] = [
  {
    id: "cosmic_float", name: "宇宙飘浮",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        osc.type = "sine"
        osc.frequency.setValueAtTime(880, ctx.currentTime)
        osc.frequency.linearRampToValueAtTime(920, ctx.currentTime + 1.0)
        osc.frequency.linearRampToValueAtTime(840, ctx.currentTime + 2.0)
        osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 2.5)
        gain.gain.setValueAtTime(0.001, ctx.currentTime)
        gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.3)
        gain.gain.setValueAtTime(0.08, ctx.currentTime + 1.5)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 2.5)
        ;[1319, 1760, 2093].forEach((f, i) => {
          const h = ctx.createOscillator(), g = ctx.createGain()
          h.type = "sine"; h.frequency.value = f
          const t = ctx.currentTime + 0.4 + i * 0.55
          g.gain.setValueAtTime(0.001, t)
          g.gain.linearRampToValueAtTime(0.04, t + 0.05)
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.40)
          h.connect(g); g.connect(ctx.destination)
          h.start(t); h.stop(t + 0.40)
        })
      } catch {}
    },
  },
  {
    id: "pulse_rhythm", name: "脉冲",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [0, 0.25, 0.55, 0.75, 1.05, 1.35, 1.55, 1.75].forEach((offset) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "triangle"
          osc.frequency.setValueAtTime(110, ctx.currentTime + offset)
          osc.frequency.exponentialRampToValueAtTime(55, ctx.currentTime + offset + 0.12)
          gain.gain.setValueAtTime(0.15, ctx.currentTime + offset)
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.14)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(ctx.currentTime + offset); osc.stop(ctx.currentTime + offset + 0.14)
        })
        ;[0.25, 0.75, 1.35].forEach((offset) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "square"; osc.frequency.value = 440
          gain.gain.setValueAtTime(0.03, ctx.currentTime + offset)
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.06)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(ctx.currentTime + offset); osc.stop(ctx.currentTime + offset + 0.06)
        })
      } catch {}
    },
  },
  {
    id: "raindrop", name: "雨滴",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [1200, 1050, 920, 780, 660, 550, 460, 380, 310, 260, 210, 170, 140, 110, 90].forEach((freq, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = freq
          const t = ctx.currentTime + i * 0.14
          gain.gain.setValueAtTime(0.10, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(t); osc.stop(t + 0.18)
        })
        const pad = ctx.createOscillator(), padGain = ctx.createGain()
        pad.type = "sine"
        pad.frequency.setValueAtTime(220, ctx.currentTime)
        pad.frequency.linearRampToValueAtTime(160, ctx.currentTime + 2.0)
        padGain.gain.setValueAtTime(0.001, ctx.currentTime)
        padGain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.3)
        padGain.gain.setValueAtTime(0.06, ctx.currentTime + 0.8)
        padGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.2)
        pad.connect(padGain); padGain.connect(ctx.destination)
        pad.start(ctx.currentTime); pad.stop(ctx.currentTime + 2.2)
      } catch {}
    },
  },
  {
    id: "music_box", name: "八音盒",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const melody = [1047, 1175, 1319, 1568, 1319, 1175, 1047, 880]
        const times = [0, 0.32, 0.64, 1.0, 1.32, 1.64, 2.0, 2.32]
        melody.forEach((freq, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "triangle"; osc.frequency.value = freq
          const t = ctx.currentTime + times[i]
          gain.gain.setValueAtTime(0.12, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(t); osc.stop(t + 0.28)
        })
        const ring = ctx.createOscillator(), ringGain = ctx.createGain()
        ring.type = "sine"; ring.frequency.value = 2093
        ringGain.gain.setValueAtTime(0.001, ctx.currentTime + 1.8)
        ringGain.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 2.0)
        ringGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.8)
        ring.connect(ringGain); ringGain.connect(ctx.destination)
        ring.start(ctx.currentTime + 1.8); ring.stop(ctx.currentTime + 2.8)
      } catch {}
    },
  },
]
