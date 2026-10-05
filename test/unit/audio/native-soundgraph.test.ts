import { afterEach, describe, expect, it, vi } from "vitest"

const audioMocks = vi.hoisted(() => ({
  assignments: {} as Record<string, string>,
  request: vi.fn(async (_method: string, _args: unknown) => undefined),
  reportError: vi.fn(),
}))

vi.mock("@/services/config", () => ({
  getOverride: (path: string) => path === "appearance.soundAssignments" ? audioMocks.assignments : undefined,
  setOverride: (path: string, value: Record<string, string>) => {
    if (path === "appearance.soundAssignments") audioMocks.assignments = value
  },
}))
vi.mock("@/services/host", () => ({
  getHostBridge: () => ({ request: audioMocks.request }),
}))
vi.mock("@/services/error", () => ({ reportError: audioMocks.reportError }))

import {
  buildNativeCueClips,
  getSoundById,
  getSoundLibrary,
  getSoundAssignments,
  playEventSound,
  playNotificationByBoundary,
  saveSoundAssignments,
  soundEvents,
} from "@/services/audio"
import { renderSoundGraphWav } from "@/services/audio/synth"

afterEach(() => {
  audioMocks.assignments = {}
  audioMocks.request.mockClear()
  audioMocks.reportError.mockClear()
})

const EXPECTED_SOUND_IDS = [
  "none", "popup_up", "retract_down", "welcome_chord", "send_short", "reply_ding",
  "surface_light", "middle_tremolo", "deep_noise", "pop_short", "drop_short", "chime_short",
  "tick_short", "arpeggio_mid", "wave_mid", "sparkle_mid", "resonance_mid", "wind_long",
  "crystal_long", "warm_long", "bell_long", "horror_stab", "heartbeat", "dread_rise",
  "ghost_whisper", "cosmic_float", "pulse_rhythm", "raindrop", "music_box", "ping_low",
  "ping_mid", "ping_crisp", "ping_high",
]

function decodeWav(base64: string): DataView {
  const bytes = Buffer.from(base64, "base64")
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

describe("Native SoundGraph 音效", () => {
  it("保留设置页使用的全部音效 ID、名称和八个事件分配 [native-audio-library-config]", () => {
    const library = getSoundLibrary()
    expect(library.map((sound) => sound.id)).toEqual(EXPECTED_SOUND_IDS)
    expect(library.every((sound) => sound.name.length > 0)).toBe(true)
    expect(soundEvents.map((event) => event.key)).toEqual([
      "welcome", "send", "reply", "popup", "retract", "surface", "middle", "deep",
    ])
    expect(getSoundAssignments()).toEqual({
      welcome: "welcome_chord", send: "send_short", reply: "reply_ding", popup: "popup_up",
      retract: "retract_down", surface: "surface_light", middle: "middle_tremolo", deep: "deep_noise",
    })
    saveSoundAssignments({ surface: "ping_crisp" })
    expect(getSoundAssignments().surface).toBe("ping_crisp")
  })

  it("将振荡器、频率自动化、增益包络与低通图编译为 mono PCM16 WAV [native-audio-wav-pcm16]", () => {
    const wav = renderSoundGraphWav(getSoundById("warm_long")!.compose())
    const view = decodeWav(wav)
    expect(String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(i)))).toBe("RIFF")
    expect(String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(8 + i)))).toBe("WAVE")
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(22_050)
    expect(view.getUint16(34, true)).toBe(16)
    // 字节数必须取整：22050*2.3*2 在 IEEE754 下是 101429.99999999999，直接比较会
    // 因浮点末位差红；WAV 头的 data 尺寸本就是整数，实现取整是正确行为。
    expect(view.getUint32(40, true)).toBe(Math.round(22_050 * 2.3 * 2))
  })

  it("保留 noise、调制振荡器和所有预设的可编译图 [native-audio-all-presets-compose]", () => {
    for (const id of EXPECTED_SOUND_IDS.filter((value) => value !== "none")) {
      const preset = getSoundById(id)
      expect(preset, id).toBeDefined()
      const graph = preset!.compose()
      expect(graph.voices.length, id).toBeGreaterThan(0)
      expect(graph.voices.every((voice) => voice.stop > voice.start), id).toBe(true)
      const wav = renderSoundGraphWav(graph)
      expect(wav.slice(0, 12), id).not.toBe("")
      expect(Buffer.from(wav, "base64").toString("ascii", 0, 4), id).toBe("RIFF")
    }
    expect(getSoundById("deep_noise")!.compose().voices.some((voice) => voice.source === "noise")).toBe(true)
    expect(getSoundById("ghost_whisper")!.compose().voices.some((voice) => voice.filter?.type === "lowpass")).toBe(true)
    expect(getSoundById("middle_tremolo")!.compose().voices[0].frequencyModulation?.depth).toBe(15)
    expect(getSoundById("popup_up")!.compose().voices[0].frequency).toEqual([
      { time: 0, value: 800, curve: "set" }, { time: 0.10, value: 1200, curve: "exponential" },
    ])
    expect(getSoundById("warm_long")!.compose().voices[0].filter).toEqual({
      type: "lowpass",
      frequency: [
        { time: 0, value: 400, curve: "set" },
        { time: 1, value: 2000, curve: "linear" },
        { time: 2, value: 400, curve: "linear" },
      ],
      q: 2,
    })
  })

  it("为 Native 首次配置产出 welcome/popup/retract WAV，none 用 null [native-audio-initial-cues]", () => {
    const first = buildNativeCueClips()
    expect(Object.keys(first)).toEqual(["welcome", "popup", "retract"])
    expect(first.welcome).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(first.popup).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(first.retract).toMatch(/^[A-Za-z0-9+/]+=*$/)
    saveSoundAssignments({ welcome: "none", popup: "none", retract: "none" })
    expect(buildNativeCueClips()).toEqual({ welcome: null, popup: null, retract: null })
  })

  it("事件与 unansweredCount 边界走 Native WAV 命令，关闭事件不发 IPC [native-audio-event-ipc]", async () => {
    await playEventSound("send")
    expect(audioMocks.request).toHaveBeenCalledOnce()
    expect(audioMocks.request.mock.calls[0][0]).toBe("audio_play_wav")
    const args = audioMocks.request.mock.calls[0][1] as { data: string }
    const playedWav = decodeWav(args.data)
    expect(String.fromCharCode(playedWav.getUint8(0), playedWav.getUint8(1), playedWav.getUint8(2), playedWav.getUint8(3))).toBe("RIFF")
    audioMocks.request.mockClear()

    await playNotificationByBoundary(1)
    expect(audioMocks.request).toHaveBeenCalledOnce()
    await playNotificationByBoundary(3)
    await playNotificationByBoundary(4)
    expect(audioMocks.request).toHaveBeenCalledTimes(3)
    audioMocks.assignments.send = "none"
    audioMocks.request.mockClear()
    await playEventSound("send")
    expect(audioMocks.request).not.toHaveBeenCalled()
  })
})
