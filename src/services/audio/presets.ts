import type {
  AutomationCurve,
  AutomationPoint,
  LowpassFilter,
  OscillatorModulation,
  OscillatorWave,
  SoundDef,
  SoundGraph,
  SoundVoice,
} from "./types"

const point = (time: number, value: number, curve: AutomationCurve = "set"): AutomationPoint => ({ time, value, curve })
const graph = (...voices: SoundVoice[]): SoundGraph => ({ voices })

function oscillator(
  wave: OscillatorWave,
  frequency: number,
  start: number,
  stop: number,
  gain: readonly AutomationPoint[],
  options: {
    frequency?: readonly AutomationPoint[]
    frequencyModulation?: OscillatorModulation
    gainModulation?: OscillatorModulation
    filter?: LowpassFilter
  } = {},
): SoundVoice {
  return {
    source: "oscillator", wave, frequency: options.frequency ?? [point(0, frequency)],
    frequencyModulation: options.frequencyModulation, gainModulation: options.gainModulation,
    gain, filter: options.filter, start, stop,
  }
}

function noise(start: number, stop: number, gain: readonly AutomationPoint[]): SoundVoice {
  return { source: "noise", gain, start, stop }
}

const decaying = (value: number, end: number, start = 0): AutomationPoint[] => [
  point(start, value), point(end, 0.001, "exponential"),
]

const lfo = (
  wave: OscillatorWave,
  frequency: number,
  depth: number,
  stop: number,
  frequencyPoints?: readonly AutomationPoint[],
): OscillatorModulation => ({
  wave, frequency: frequencyPoints ?? [point(0, frequency)], depth, start: 0, stop,
})

const lowpass = (frequency: readonly AutomationPoint[], q: number): LowpassFilter => ({ type: "lowpass", frequency, q })

const defs: SoundDef[] = [
  { id: "none", name: "关闭", compose: () => graph() },
  {
    id: "popup_up", name: "轻快上行", compose: () => graph(
      oscillator("sine", 800, 0, 0.12, [point(0, 0.12), point(0.12, 0.001, "exponential")], {
        frequency: [point(0, 800), point(0.10, 1200, "exponential")],
      }),
      oscillator("sine", 1000, 0.06, 0.20, [point(0.06, 0.10), point(0.20, 0.001, "exponential")], {
        frequency: [point(0.06, 1000), point(0.18, 1600, "exponential")],
      }),
    ),
  },
  {
    id: "retract_down", name: "温柔下行", compose: () => graph(
      oscillator("sine", 1400, 0, 0.14, [point(0, 0.11), point(0.14, 0.001, "exponential")], {
        frequency: [point(0, 1400), point(0.12, 900, "exponential")],
      }),
      oscillator("sine", 1100, 0.06, 0.22, [point(0.06, 0.09), point(0.22, 0.001, "exponential")], {
        frequency: [point(0.06, 1100), point(0.20, 600, "exponential")],
      }),
    ),
  },
  {
    id: "welcome_chord", name: "温暖和弦", compose: () => graph(...[523, 659, 784, 1047].map((frequency, i) => {
      const start = i * 0.12
      return oscillator("sine", frequency, start, start + 0.30, decaying(0.10, start + 0.30, start))
    })),
  },
  {
    id: "send_short", name: "短促上行", compose: () => graph(oscillator("sine", 1200, 0, 0.08, decaying(0.08, 0.08), {
      frequency: [point(0, 1200), point(0.06, 1600, "exponential")],
    })),
  },
  {
    id: "reply_ding", name: "柔和叮咚", compose: () => graph(
      oscillator("sine", 880, 0, 0.12, decaying(0.10, 0.12)),
      oscillator("sine", 1320, 0.10, 0.22, decaying(0.08, 0.20, 0.10)),
    ),
  },
  {
    id: "pop_short", name: "电子弹跳", compose: () => graph(oscillator("square", 400, 0, 0.10, decaying(0.10, 0.10), {
      frequency: [point(0, 400), point(0.06, 2400, "exponential")],
    })),
  },
  {
    id: "drop_short", name: "水滴", compose: () => graph(oscillator("sine", 2400, 0, 0.14, decaying(0.15, 0.14), {
      frequency: [point(0, 2400), point(0.12, 800, "exponential")],
    })),
  },
  {
    id: "chime_short", name: "风铃", compose: () => graph(
      oscillator("triangle", 1600, 0, 0.16, decaying(0.12, 0.16)),
      oscillator("triangle", 2400, 0.02, 0.16, decaying(0.12, 0.16)),
    ),
  },
  {
    id: "tick_short", name: "咔哒", compose: () => graph(oscillator("sine", 200, 0, 0.05, decaying(0.20, 0.05), {
      frequency: [point(0, 200), point(0.04, 60, "exponential")],
    })),
  },
  {
    id: "surface_light", name: "轻快提示", compose: () => graph(
      oscillator("sine", 1600, 0, 0.08, decaying(0.14, 0.16)),
      oscillator("sine", 1800, 0.08, 0.16, decaying(0.14, 0.16)),
    ),
  },
  {
    id: "middle_tremolo", name: "轻微颤音", compose: () => graph(oscillator("sine", 1400, 0, 0.21,
      decaying(0.16, 0.20), {
        frequency: [point(0, 1400), point(0.20, 1200, "linear")],
        frequencyModulation: lfo("sine", 6, 15, 0.21),
      })),
  },
  {
    id: "deep_noise", name: "紊乱噪音", compose: () => graph(
      oscillator("square", 900, 0, 0.26, decaying(0.18, 0.25), {
        frequency: [point(0, 900), point(0.08, 700), point(0.18, 500)],
        frequencyModulation: lfo("sawtooth", 10, 25, 0.26),
      }),
      noise(0, 0.26, decaying(0.04, 0.25)),
    ),
  },
  {
    id: "arpeggio_mid", name: "琶音上行", compose: () => graph(...[659, 784, 1047, 1319].map((frequency, i) => {
      const start = i * 0.08
      return oscillator("sine", frequency, start, start + 0.14, decaying(0.09, start + 0.14, start))
    })),
  },
  {
    id: "wave_mid", name: "柔波", compose: () => graph(oscillator("sine", 800, 0, 0.42, [
      point(0, 0.12), point(0.30, 0.12), point(0.40, 0.001, "exponential"),
    ], {
      frequency: [point(0, 800), point(0.20, 1000, "linear")],
      gainModulation: lfo("sine", 5, 0.3, 0.42),
    })),
  },
  {
    id: "sparkle_mid", name: "星尘", compose: () => {
      const base = [2000, 2800, 3600, 4400, 5200]
      return graph(...Array.from({ length: 8 }, (_, i) => {
        const frequency = base[i % base.length] + Math.random() * 400
        const start = Math.random() * 0.20
        const stop = start + 0.08 + Math.random() * 0.06
        return oscillator("sine", frequency, start, start + 0.20, decaying(0.04, stop, start))
      }))
    },
  },
  {
    id: "resonance_mid", name: "共鸣", compose: () => graph(...[523, 784, 1047, 1319, 1568].map((frequency, i) =>
      oscillator(i === 0 ? "sine" : "triangle", frequency, 0, 0.46,
        decaying(0.06 - i * 0.01, 0.45)))),
  },
  {
    id: "wind_long", name: "风潮", compose: () => graph(...[262, 330, 392, 523].map((frequency, i) =>
      oscillator("sine", frequency, i * 0.15, 2.5, [
        point(0, 0.001), point(0.6, 0.06, "linear"), point(1.8, 0.06), point(2.5, 0.001, "exponential"),
      ]))),
  },
  {
    id: "crystal_long", name: "水晶", compose: () => graph(...[1047, 1319, 1568, 1760, 2093, 2637].map((frequency, i) => {
      const start = i * 0.25
      return oscillator("sine", frequency, start, start + 0.50, [
        point(start, 0.001), point(start + 0.06, 0.07, "linear"), point(start + 0.50, 0.001, "exponential"),
      ])
    })),
  },
  {
    id: "warm_long", name: "暖阳", compose: () => graph(oscillator("sawtooth", 220, 0, 2.3, [
      point(0, 0.001), point(0.3, 0.08, "linear"), point(1.8, 0.08), point(2.3, 0.001, "exponential"),
    ], {
      frequency: [point(0, 220), point(1.2, 330, "linear"), point(2.2, 220, "linear")],
      filter: lowpass([point(0, 400), point(1, 2000, "linear"), point(2, 400, "linear")], 2),
    })),
  },
  {
    id: "bell_long", name: "余韵", compose: () => graph(...[
      { frequency: 523, gain: 0.12 }, { frequency: 659, gain: 0.06 }, { frequency: 784, gain: 0.05 },
      { frequency: 1047, gain: 0.04 }, { frequency: 1319, gain: 0.03 }, { frequency: 1568, gain: 0.02 },
    ].map(({ frequency, gain }) => oscillator("sine", frequency, 0, 2.8, decaying(gain, 2.8)))),
  },
  {
    id: "cosmic_float", name: "宇宙飘浮", compose: () => graph(
      oscillator("sine", 880, 0, 2.5, [
        point(0, 0.001), point(0.3, 0.08, "linear"), point(1.5, 0.08), point(2.5, 0.001, "exponential"),
      ], { frequency: [point(0, 880), point(1, 920, "linear"), point(2, 840, "linear"), point(2.5, 880, "linear")] }),
      ...[1319, 1760, 2093].map((frequency, i) => {
        const start = 0.4 + i * 0.55
        return oscillator("sine", frequency, start, start + 0.40, [
          point(start, 0.001), point(start + 0.05, 0.04, "linear"), point(start + 0.40, 0.001, "exponential"),
        ])
      }),
    ),
  },
  {
    id: "pulse_rhythm", name: "脉冲", compose: () => graph(
      ...[0, 0.25, 0.55, 0.75, 1.05, 1.35, 1.55, 1.75].map((start) => oscillator("triangle", 110, start, start + 0.14,
        decaying(0.15, start + 0.12, start), {
          frequency: [point(start, 110), point(start + 0.12, 55, "exponential")],
        })),
      ...[0.25, 0.75, 1.35].map((start) => oscillator("square", 440, start, start + 0.06,
        decaying(0.03, start + 0.06, start))),
    ),
  },
  {
    id: "raindrop", name: "雨滴", compose: () => graph(
      ...[1200, 1050, 920, 780, 660, 550, 460, 380, 310, 260, 210, 170, 140, 110, 90].map((frequency, i) => {
        const start = i * 0.14
        return oscillator("sine", frequency, start, start + 0.18, decaying(0.10, start + 0.18, start))
      }),
      oscillator("sine", 220, 0, 2.2, [
        point(0, 0.001), point(0.3, 0.06, "linear"), point(0.8, 0.06), point(2.2, 0.001, "exponential"),
      ], { frequency: [point(0, 220), point(2, 160, "linear")] }),
    ),
  },
  {
    id: "music_box", name: "八音盒", compose: () => graph(
      ...[1047, 1175, 1319, 1568, 1319, 1175, 1047, 880].map((frequency, i) => {
        const start = [0, 0.32, 0.64, 1, 1.32, 1.64, 2, 2.32][i]
        return oscillator("triangle", frequency, start, start + 0.28, decaying(0.12, start + 0.28, start))
      }),
      oscillator("sine", 2093, 1.8, 2.8, [
        point(1.8, 0.001), point(2, 0.04, "linear"), point(2.8, 0.001, "exponential"),
      ]),
    ),
  },
  {
    id: "ping_low", name: "金铎", compose: () => graph(...[
      { frequency: 262, gain: 0.14, wave: "sine" as const }, { frequency: 330, gain: 0.06, wave: "sine" as const },
      { frequency: 392, gain: 0.05, wave: "sine" as const }, { frequency: 523, gain: 0.07, wave: "triangle" as const },
      { frequency: 659, gain: 0.04, wave: "sine" as const }, { frequency: 784, gain: 0.03, wave: "triangle" as const },
      { frequency: 1047, gain: 0.02, wave: "sine" as const },
    ].map(({ frequency, gain, wave }) => oscillator(wave, frequency, 0, 2.8, decaying(gain, 2.8)))),
  },
  {
    id: "ping_mid", name: "银铃", compose: () => graph(...[
      { f: 784, g: 0.10, d: 0 }, { f: 988, g: 0.05, d: 0.04 }, { f: 1175, g: 0.06, d: 0.08 },
      { f: 1480, g: 0.04, d: 0.03 }, { f: 1568, g: 0.05, d: 0.12 }, { f: 1760, g: 0.03, d: 0.06 },
      { f: 1976, g: 0.02, d: 0.15 },
    ].map(({ f, g, d }) => oscillator("sine", f, d, d + 2, [
      point(d, 0.001), point(d + 0.03, g, "linear"), point(d + 2, 0.001, "exponential"),
    ]))),
  },
  {
    id: "ping_crisp", name: "玉磬", compose: () => graph(...[
      { f: 1319, g: 0.11 }, { f: 1661, g: 0.06 }, { f: 1976, g: 0.05 }, { f: 2637, g: 0.04 },
      { f: 3322, g: 0.025 }, { f: 3951, g: 0.015 }, { f: 5274, g: 0.008 },
    ].map(({ f, g }) => oscillator("sine", f, 0, 2.5, decaying(g, 2.5)))),
  },
  {
    id: "ping_high", name: "铜磬", compose: () => graph(...[
      { f: 440, g: 0.12 }, { f: 554, g: 0.05 }, { f: 659, g: 0.06 }, { f: 880, g: 0.04 },
      { f: 1109, g: 0.03 }, { f: 1320, g: 0.02 },
    ].map(({ f, g }) => oscillator("sine", f, 0, 3, decaying(g, 3), {
      frequencyModulation: lfo("sine", 3.5 + Math.random(), f * 0.002, 3),
    }))),
  },
  {
    id: "horror_stab", name: "惊悚短音", compose: () => graph(
      oscillator("square", 440, 0, 0.12, decaying(0.15, 0.12), {
        frequency: [point(0, 440), point(0.08, 830, "exponential")],
      }),
      oscillator("square", 466, 0, 0.12, decaying(0.15, 0.12), {
        frequency: [point(0, 466), point(0.08, 880, "exponential")],
      }),
    ),
  },
  {
    id: "heartbeat", name: "心跳", compose: () => graph(...[0, 0.18].map((start) =>
      oscillator("sine", 80, start, start + 0.12, decaying(0.25, start + 0.12, start), {
        frequency: [point(start, 80), point(start + 0.10, 40, "exponential")],
      }))),
  },
  {
    id: "dread_rise", name: "渐近恐惧", compose: () => graph(
      ...[220, 233, 247, 262, 277, 294, 311, 330, 349, 370, 392, 415].map((frequency, i) => {
        const start = i * 0.20
        return oscillator("sawtooth", frequency, start, start + 0.22, [
          point(start, 0.001), point(start + 0.08, 0.04, "linear"), point(start + 0.22, 0.001, "exponential"),
        ])
      }),
      noise(0, 2.5, [point(0, 0.001), point(1.8, 0.08, "linear"), point(2.5, 0.001, "exponential")]),
    ),
  },
  {
    id: "ghost_whisper", name: "鬼魅低语", compose: () => graph(
      oscillator("sine", 330, 0, 2.8, [
        point(0, 0.001), point(0.4, 0.10, "linear"), point(1.8, 0.10), point(2.8, 0.001, "exponential"),
      ], {
        frequencyModulation: lfo("sine", 2, 15, 2.8, [point(0, 2), point(2, 0.5, "linear")]),
        filter: lowpass([point(0, 800), point(2.2, 200, "linear"), point(2.6, 2000, "linear")], 5),
      }),
      oscillator("sine", 660, 0.3, 2.5, [
        point(0.3, 0.001), point(0.6, 0.05, "linear"), point(2.5, 0.001, "exponential"),
      ], { frequency: [point(0, 660), point(1.2, 700, "linear"), point(2, 600, "linear")] }),
    ),
  },
]

// 设置页排序与原始 registry 分类顺序一致，ID/名称/波形仍各自只定义在上面的预设。
const presetOrder = [
  "none", "popup_up", "retract_down", "welcome_chord", "send_short", "reply_ding",
  "surface_light", "middle_tremolo", "deep_noise",
  "pop_short", "drop_short", "chime_short", "tick_short",
  "arpeggio_mid", "wave_mid", "sparkle_mid", "resonance_mid",
  "wind_long", "crystal_long", "warm_long", "bell_long",
  "horror_stab", "heartbeat", "dread_rise", "ghost_whisper",
  "cosmic_float", "pulse_rhythm", "raindrop", "music_box",
  "ping_low", "ping_mid", "ping_crisp", "ping_high",
] as const
const byId = new Map(defs.map((sound) => [sound.id, sound] as const))
if (byId.size !== defs.length || presetOrder.length !== defs.length || presetOrder.some((id) => !byId.has(id))) {
  throw new Error("Native SoundGraph 预设 ID 必须唯一且排序表必须完整")
}
export const soundPresets: readonly SoundDef[] = presetOrder.map((id) => byId.get(id)!)
