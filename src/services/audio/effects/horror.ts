// 恐怖音效: 惊悚短音/心跳/渐近恐惧/鬼魅低语
import { getCtx } from "../context"
import type { SoundDef } from "../types"
export const horrorSounds: SoundDef[] = [
  {
    id: "horror_stab", name: "惊悚短音",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc1 = ctx.createOscillator(), osc2 = ctx.createOscillator(), gain = ctx.createGain()
        osc1.type = "square"; osc2.type = "square"
        osc1.frequency.setValueAtTime(440, ctx.currentTime)
        osc1.frequency.exponentialRampToValueAtTime(830, ctx.currentTime + 0.08)
        osc2.frequency.setValueAtTime(466, ctx.currentTime)
        osc2.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08)
        gain.gain.setValueAtTime(0.15, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12)
        osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination)
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime)
        osc1.stop(ctx.currentTime + 0.12); osc2.stop(ctx.currentTime + 0.12)
      } catch {}
    },
  },
  {
    id: "heartbeat", name: "心跳",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [0, 0.18].forEach((offset) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "sine"
          osc.frequency.setValueAtTime(80, ctx.currentTime + offset)
          osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + offset + 0.10)
          gain.gain.setValueAtTime(0.25, ctx.currentTime + offset)
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.12)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(ctx.currentTime + offset); osc.stop(ctx.currentTime + offset + 0.12)
        })
      } catch {}
    },
  },
  {
    id: "dread_rise", name: "渐近恐惧",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [220, 233, 247, 262, 277, 294, 311, 330, 349, 370, 392, 415].forEach((freq, i) => {
          const osc = ctx.createOscillator(), gainNode = ctx.createGain()
          osc.type = "sawtooth"
          const t = ctx.currentTime + i * 0.20
          osc.frequency.value = freq
          gainNode.gain.setValueAtTime(0.001, t)
          gainNode.gain.linearRampToValueAtTime(0.04, t + 0.08)
          gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
          osc.connect(gainNode); gainNode.connect(ctx.destination)
          osc.start(t); osc.stop(t + 0.22)
        })
        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 2.5), ctx.sampleRate)
        const data = buf.getChannelData(0)
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
        const noise = ctx.createBufferSource(); noise.buffer = buf
        const noiseGain = ctx.createGain()
        noiseGain.gain.setValueAtTime(0.001, ctx.currentTime)
        noiseGain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 1.8)
        noiseGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5)
        noise.connect(noiseGain); noiseGain.connect(ctx.destination)
        noise.start(ctx.currentTime); noise.stop(ctx.currentTime + 2.5)
      } catch {}
    },
  },
  {
    id: "ghost_whisper", name: "鬼魅低语",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const baseOsc = ctx.createOscillator(), lfo = ctx.createOscillator(), lfoGain = ctx.createGain()
        const filter = ctx.createBiquadFilter(), gain = ctx.createGain()
        baseOsc.type = "sine"
        baseOsc.frequency.setValueAtTime(330, ctx.currentTime)
        lfo.type = "sine"; lfo.frequency.setValueAtTime(2, ctx.currentTime)
        lfo.frequency.linearRampToValueAtTime(0.5, ctx.currentTime + 2.0)
        lfoGain.gain.value = 15
        lfo.connect(lfoGain); lfoGain.connect(baseOsc.frequency)
        filter.type = "lowpass"
        filter.frequency.setValueAtTime(800, ctx.currentTime)
        filter.frequency.linearRampToValueAtTime(200, ctx.currentTime + 2.2)
        filter.frequency.linearRampToValueAtTime(2000, ctx.currentTime + 2.6)
        filter.Q.value = 5
        gain.gain.setValueAtTime(0.001, ctx.currentTime)
        gain.gain.linearRampToValueAtTime(0.10, ctx.currentTime + 0.4)
        gain.gain.setValueAtTime(0.10, ctx.currentTime + 1.8)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.8)
        baseOsc.connect(filter); filter.connect(gain); gain.connect(ctx.destination)
        lfo.start(ctx.currentTime); baseOsc.start(ctx.currentTime)
        lfo.stop(ctx.currentTime + 2.8); baseOsc.stop(ctx.currentTime + 2.8)
        const highOsc = ctx.createOscillator(), highGain = ctx.createGain()
        highOsc.type = "sine"
        highOsc.frequency.setValueAtTime(660, ctx.currentTime)
        highOsc.frequency.linearRampToValueAtTime(700, ctx.currentTime + 1.2)
        highOsc.frequency.linearRampToValueAtTime(600, ctx.currentTime + 2.0)
        highGain.gain.setValueAtTime(0.001, ctx.currentTime + 0.3)
        highGain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.6)
        highGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5)
        highOsc.connect(highGain); highGain.connect(ctx.destination)
        highOsc.start(ctx.currentTime + 0.3); highOsc.stop(ctx.currentTime + 2.5)
      } catch {}
    },
  },
]
