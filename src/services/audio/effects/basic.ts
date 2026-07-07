// 基础音效: 弹窗/收回/欢迎/发送/回复
import { getCtx } from "../context"
import type { SoundDef } from "../types"

export const basicSounds: SoundDef[] = [
  {
    id: "none", name: "关闭",
    play: async () => {},
  },
  {
    id: "popup_up", name: "轻快上行",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const [osc1, osc2, gain1, gain2] = [ctx.createOscillator(), ctx.createOscillator(), ctx.createGain(), ctx.createGain()]
        osc1.type = "sine"; osc2.type = "sine"
        osc1.frequency.setValueAtTime(800, ctx.currentTime)
        osc1.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.10)
        osc2.frequency.setValueAtTime(1000, ctx.currentTime + 0.06)
        osc2.frequency.exponentialRampToValueAtTime(1600, ctx.currentTime + 0.18)
        gain1.gain.setValueAtTime(0.12, ctx.currentTime)
        gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12)
        gain2.gain.setValueAtTime(0.10, ctx.currentTime + 0.06)
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20)
        osc1.connect(gain1); gain1.connect(ctx.destination)
        osc2.connect(gain2); gain2.connect(ctx.destination)
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime + 0.06)
        osc1.stop(ctx.currentTime + 0.12); osc2.stop(ctx.currentTime + 0.20)
      } catch {}
    },
  },
  {
    id: "retract_down", name: "温柔下行",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const [osc1, osc2, gain1, gain2] = [ctx.createOscillator(), ctx.createOscillator(), ctx.createGain(), ctx.createGain()]
        osc1.type = "sine"; osc2.type = "sine"
        osc1.frequency.setValueAtTime(1400, ctx.currentTime)
        osc1.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.12)
        osc2.frequency.setValueAtTime(1100, ctx.currentTime + 0.06)
        osc2.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.20)
        gain1.gain.setValueAtTime(0.11, ctx.currentTime)
        gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14)
        gain2.gain.setValueAtTime(0.09, ctx.currentTime + 0.06)
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22)
        osc1.connect(gain1); gain1.connect(ctx.destination)
        osc2.connect(gain2); gain2.connect(ctx.destination)
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime + 0.06)
        osc1.stop(ctx.currentTime + 0.14); osc2.stop(ctx.currentTime + 0.22)
      } catch {}
    },
  },
  {
    id: "welcome_chord", name: "温暖和弦",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        [523, 659, 784, 1047].forEach((freq, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain()
          osc.type = "sine"; osc.frequency.value = freq
          const t = ctx.currentTime + i * 0.12
          gain.gain.setValueAtTime(0.10, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.30)
          osc.connect(gain); gain.connect(ctx.destination)
          osc.start(t); osc.stop(t + 0.30)
        })
      } catch {}
    },
  },
  {
    id: "send_short", name: "短促上行",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        osc.type = "sine"
        osc.frequency.setValueAtTime(1200, ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(1600, ctx.currentTime + 0.06)
        gain.gain.setValueAtTime(0.08, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.08)
      } catch {}
    },
  },
  {
    id: "reply_ding", name: "柔和叮咚",
    play: async () => {
      const ctx = await getCtx(); if (!ctx) return
      try {
        const [osc1, osc2, gain1, gain2] = [ctx.createOscillator(), ctx.createOscillator(), ctx.createGain(), ctx.createGain()]
        osc1.type = "sine"; osc1.frequency.value = 880
        osc2.type = "sine"; osc2.frequency.value = 1320
        gain1.gain.setValueAtTime(0.10, ctx.currentTime)
        gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12)
        gain2.gain.setValueAtTime(0.08, ctx.currentTime + 0.10)
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20)
        osc1.connect(gain1); gain1.connect(ctx.destination)
        osc2.connect(gain2); gain2.connect(ctx.destination)
        osc1.start(ctx.currentTime); osc2.start(ctx.currentTime + 0.10)
        osc1.stop(ctx.currentTime + 0.12); osc2.stop(ctx.currentTime + 0.22)
      } catch {}
    },
  },
]
