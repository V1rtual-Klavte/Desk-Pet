/** 预设唯一描述：UI 元数据保留稳定 ID 与名称；Native 播放由 Node 编译为 WAV。 */
export interface SoundDef {
  readonly id: string
  readonly name: string
  readonly compose: () => SoundGraph
}

export type OscillatorWave = "sine" | "square" | "sawtooth" | "triangle"
export type AutomationCurve = "set" | "linear" | "exponential"

/** 时间以音效起点为 0 秒，curve 描述从前一控制点到本点的插值。 */
export interface AutomationPoint {
  readonly time: number
  readonly value: number
  readonly curve: AutomationCurve
}

export interface LowpassFilter {
  readonly type: "lowpass"
  readonly frequency: readonly AutomationPoint[]
  readonly q: number
}

export interface OscillatorModulation {
  readonly wave: OscillatorWave
  readonly frequency: readonly AutomationPoint[]
  readonly depth: number
  readonly start: number
  readonly stop: number
}

export interface SoundVoice {
  readonly source: "oscillator" | "noise"
  readonly wave?: OscillatorWave
  readonly frequency?: readonly AutomationPoint[]
  readonly frequencyModulation?: OscillatorModulation
  readonly gainModulation?: OscillatorModulation
  readonly gain: readonly AutomationPoint[]
  readonly filter?: LowpassFilter
  readonly start: number
  readonly stop: number
}

/** Native-only SoundGraph DSL: a summed set of sources with timed params and DSP nodes. */
export interface SoundGraph {
  readonly voices: readonly SoundVoice[]
}
