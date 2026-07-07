// 提示音效: 表层/中层/深层
import { getCtx } from "../context"
import type { SoundDef } from "../types"

export const surfaceSounds: SoundDef[] = [
  {
    id: "surface_light", name: "轻快提示",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc1 = ctx.createOscillator(), osc2 = ctx.createOscillator(), gain = ctx.createGain()
        osc1.type = "sine"; osc1.frequency.value = 1600
        osc2.type = "sine"; osc2.frequency.value = 1800
        gain.gain.setValueAtTime(0.14, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16)
        osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination)
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime + 0.08)
        osc1.stop(ctx.currentTime + 0.08); osc2.stop(ctx.currentTime + 0.16)
      } catch {}
    },
  },
  {
    id: "middle_tremolo", name: "轻微颤音",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), lfo = ctx.createOscillator(), lfoGain = ctx.createGain(), gain = ctx.createGain()
        osc.type = "sine"
        osc.frequency.setValueAtTime(1400, ctx.currentTime)
        osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.20)
        lfo.type = "sine"; lfo.frequency.value = 6; lfoGain.gain.value = 15
        lfo.connect(lfoGain); lfoGain.connect(osc.frequency)
        gain.gain.setValueAtTime(0.16, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20)
        osc.connect(gain); gain.connect(ctx.destination)
        lfo.start(ctx.currentTime); osc.start(ctx.currentTime)
        lfo.stop(ctx.currentTime + 0.21); osc.stop(ctx.currentTime + 0.21)
      } catch {}
    },
  },
  {
    id: "deep_noise", name: "紊乱噪音",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), lfo = ctx.createOscillator(), lfoGain = ctx.createGain(), gain = ctx.createGain()
        osc.type = "square"
        osc.frequency.setValueAtTime(900, ctx.currentTime)
        osc.frequency.setValueAtTime(700, ctx.currentTime + 0.08)
        osc.frequency.setValueAtTime(500, ctx.currentTime + 0.18)
        lfo.type = "sawtooth"; lfo.frequency.value = 10; lfoGain.gain.value = 25
        lfo.connect(lfoGain); lfoGain.connect(osc.frequency)
        gain.gain.setValueAtTime(0.18, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
        osc.connect(gain); gain.connect(ctx.destination)
        lfo.start(ctx.currentTime); osc.start(ctx.currentTime)
        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.26), ctx.sampleRate)
        const data = buf.getChannelData(0)
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
        const noise = ctx.createBufferSource(); noise.buffer = buf
        const noiseGain = ctx.createGain()
        noiseGain.gain.setValueAtTime(0.04, ctx.currentTime)
        noiseGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
        noise.connect(noiseGain); noiseGain.connect(ctx.destination)
        noise.start(ctx.currentTime)
        lfo.stop(ctx.currentTime + 0.26); osc.stop(ctx.currentTime + 0.26); noise.stop(ctx.currentTime + 0.26)
      } catch {}
    },
  },
]
