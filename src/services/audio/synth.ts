import type {
  AutomationPoint,
  OscillatorModulation,
  OscillatorWave,
  SoundGraph,
  SoundVoice,
} from "./types"

export const NATIVE_AUDIO_SAMPLE_RATE = 22_050
const MAX_CUE_SECONDS = 8
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function parameter(points: readonly AutomationPoint[], time: number, fallback: number): number {
  if (points.length === 0) return fallback
  let previous: AutomationPoint | undefined
  for (const current of points) {
    if (time < current.time) {
      if (!previous || current.curve === "set") return previous?.value ?? fallback
      const span = current.time - previous.time
      if (span <= 0) return current.value
      const progress = (time - previous.time) / span
      if (current.curve === "exponential") {
        if (previous.value <= 0 || current.value <= 0) {
          throw new Error("SoundGraph 指数自动化的端点必须大于零")
        }
        return previous.value * (current.value / previous.value) ** progress
      }
      return previous.value + (current.value - previous.value) * progress
    }
    if (time === current.time) return current.value
    previous = current
  }
  return previous?.value ?? fallback
}

function waveSample(wave: OscillatorWave, phase: number, frequency: number, sampleRate: number): number {
  if (wave === "sine") return Math.sin(phase)
  const harmonicLimit = Math.max(1, Math.min(128, Math.floor((sampleRate * 0.49) / Math.max(1, Math.abs(frequency)))))
  let sum = 0
  if (wave === "square") {
    for (let n = 1; n <= harmonicLimit; n += 2) sum += Math.sin(phase * n) / n
    return sum * (4 / Math.PI)
  }
  if (wave === "sawtooth") {
    for (let n = 1; n <= harmonicLimit; n += 1) sum += ((n & 1) === 1 ? 1 : -1) * Math.sin(phase * n) / n
    return sum * (2 / Math.PI)
  }
  for (let n = 1; n <= harmonicLimit; n += 2) {
    sum += ((n & 3) === 1 ? 1 : -1) * Math.sin(phase * n) / (n * n)
  }
  return sum * (8 / (Math.PI * Math.PI))
}

function modulatorSample(modulation: OscillatorModulation, time: number, state: { phase: number }, sampleRate: number): number {
  if (time < modulation.start || time >= modulation.stop) return 0
  const frequency = Math.max(0, parameter(modulation.frequency, time, 440))
  const value = waveSample(modulation.wave, state.phase, frequency, sampleRate)
  state.phase += Math.PI * 2 * frequency / sampleRate
  return value * modulation.depth
}

class LowpassState {
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  process(input: number, cutoff: number, q: number, sampleRate: number): number {
    const frequency = Math.max(1, Math.min(sampleRate * 0.49, cutoff))
    const resonance = Math.max(0.0001, q)
    const k = Math.tan(Math.PI * frequency / sampleRate)
    const norm = 1 / (1 + k / resonance + k * k)
    const b0 = k * k * norm
    const b1 = 2 * b0
    const b2 = b0
    const a1 = 2 * (k * k - 1) * norm
    const a2 = (1 - k / resonance + k * k) * norm
    const output = b0 * input + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2
    this.x2 = this.x1
    this.x1 = input
    this.y2 = this.y1
    this.y1 = output
    return output
  }
}

interface VoiceState {
  readonly voice: SoundVoice
  phase: number
  readonly frequencyModulation: { phase: number }
  readonly gainModulation: { phase: number }
  noiseState: number
  readonly filter: LowpassState | null
}

function initialNoiseState(): number {
  return (Math.random() * 0xffff_ffff) >>> 0 || 1
}

function noiseSample(state: VoiceState): number {
  // xorshift32 gives each rendered clip its own deterministic-in-clip white-noise buffer.
  let value = state.noiseState
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  state.noiseState = value >>> 0
  return (state.noiseState / 0x7fff_ffff) - 1
}

function renderVoice(state: VoiceState, time: number, sampleRate: number): number {
  const { voice } = state
  if (time < voice.start || time >= voice.stop) return 0
  let signal: number
  if (voice.source === "noise") {
    signal = noiseSample(state)
  } else {
    const baseFrequency = parameter(voice.frequency ?? [], time, 440)
    const modulation = voice.frequencyModulation
      ? modulatorSample(voice.frequencyModulation, time, state.frequencyModulation, sampleRate)
      : 0
    const frequency = Math.max(0, baseFrequency + modulation)
    signal = waveSample(voice.wave ?? "sine", state.phase, frequency, sampleRate)
    state.phase += Math.PI * 2 * frequency / sampleRate
  }
  if (voice.filter && state.filter) {
    signal = state.filter.process(
      signal,
      parameter(voice.filter.frequency, time, 350),
      voice.filter.q,
      sampleRate,
    )
  }
  const gain = parameter(voice.gain, time, 1)
  const gainModulation = voice.gainModulation
    ? modulatorSample(voice.gainModulation, time, state.gainModulation, sampleRate)
    : 0
  return signal * (gain + gainModulation)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
}

function pcmToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  writeAscii(view, 0, "RIFF")
  view.setUint32(4, bytes.length - 8, true)
  writeAscii(view, 8, "WAVE")
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff), true)
  }
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  let result = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const hasB = index + 1 < bytes.length
    const hasC = index + 2 < bytes.length
    const b = hasB ? bytes[index + 1] : 0
    const c = hasC ? bytes[index + 2] : 0
    result += BASE64[a >>> 2]
      + BASE64[((a & 3) << 4) | (b >>> 4)]
      + (hasB ? BASE64[((b & 15) << 2) | (c >>> 6)] : "=")
      + (hasC ? BASE64[c & 63] : "=")
  }
  return result
}

/** 将 Native-only 声音图编译为标准 RIFF/WAVE、mono、PCM signed 16-bit little-endian。 */
export function renderSoundGraphWav(graph: SoundGraph, sampleRate = 22_050): string {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) {
    throw new Error(`SoundGraph sampleRate 不支持: ${sampleRate}`)
  }
  const duration = graph.voices.reduce((maximum, voice) => Math.max(maximum, voice.stop), 0)
  if (duration <= 0) return ""
  if (duration > MAX_CUE_SECONDS) throw new Error(`SoundGraph 时长超过上限 ${MAX_CUE_SECONDS}s: ${duration}`)
  const samples = new Float32Array(Math.ceil(duration * sampleRate))
  const states: VoiceState[] = graph.voices.map((voice) => ({
    voice,
    phase: 0,
    frequencyModulation: { phase: 0 },
    gainModulation: { phase: 0 },
    noiseState: initialNoiseState(),
    filter: voice.filter ? new LowpassState() : null,
  }))
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate
    let mixed = 0
    for (const state of states) mixed += renderVoice(state, time, sampleRate)
    samples[index] = mixed
  }
  return toBase64(pcmToWav(samples, sampleRate))
}
