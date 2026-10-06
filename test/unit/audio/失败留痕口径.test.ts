// ==========================================
// 音效失败分支的留痕口径 —— Node 侧（合成失败 / 播放通道失败 / 无效分配）
// ==========================================
//
// 链路：Node 合成 WAV（synth）→ 宿主播放（Rust 音频端口，失败在宿主侧 warn）。
// 本文件把 Node 侧「失败如何留痕、如何回给调用方」的口径钉住：
//   · 事件播放入口（playEventSound）：合成失败与播放失败都不上抛（音效是交互副作用，
//     不能把一条已被接受的消息变成失败），但必须经统一错误出口 reportError 留痕，
//     且 overlay:false（预期内失败不弹全屏异常）；
//   · 试听入口（playSoundById）：合成失败如实抛给调用方（设置页要当面呈现），
//     播放通道失败仍走统一留痕（与事件入口一致）；
//   · 原生生命周期提示（buildNativeCueClips）：单个槽位的分配/合成失败不牵连其它槽，
//     失败槽返回 null 并点名留痕。
//
// 观测手法：合成函数、宿主桥与 reportError 都是桩 —— 失败的「注入」只发生在这些边界上，
// registry 的判定与调用链本身照走真实实现。真实 NSSound/AudioContext 播放失败属实机
// 人工项，不在本文件伪造。
//
// 为何在 L2：被测对象是服务级失败口径（假宿主桥 + 纯判定，无 agent loop / 无 JSONL），
// 按 test/AGENTS 的选层顺序归单元层；既有 audio 契约的覆盖点（au-04 事件播放入口、
// au-03 首次配置提示音）也都在 L2。
//
// caseId 清单（新增，需在契约生成时登记 coverage）：
//   · audio-event-compile-failure-report（合成失败 → 留痕 + 不发播放命令）→ au-04
//   · audio-playback-failure-report（宿主拒绝 → 留痕 + 不上抛）→ au-04
//   · audio-tryout-compile-failure（试听入口合成失败如实上抛）→ au-04
//   · audio-unknown-sound-id（未知 ID 的三个入口归宿）→ au-04
//   · audio-cue-clips-failure-report（原生提示音槽位失败不牵连）→ au-03

import { beforeEach, describe, expect, it, vi } from "vitest"

const audioMocks = vi.hoisted(() => ({
  assignments: {} as Record<string, string>,
  request: vi.fn(async (_method: string, _args: unknown): Promise<unknown> => undefined),
  reportError: vi.fn(),
  renderWav: vi.fn<(graph: unknown, sampleRate?: number) => string>(),
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
// 合成函数是唯一被替换的产品点：它的失败形态（抛错）与成功返回值都在这里注入，
// registry 的 catch / 留痕 / 回传判定照走真实实现。
vi.mock("@/services/audio/synth", () => ({
  NATIVE_AUDIO_SAMPLE_RATE: 22_050,
  renderSoundGraphWav: audioMocks.renderWav,
}))

import { buildNativeCueClips, playEventSound, playSoundById } from "@/services/audio"

/** 合成成功的哨兵：足以通过 playWav 的非空判定，并可在请求参数里逐字比对。 */
const SENTINEL_WAV = "UklGRg=="

/** 注入用的合成失败（与生产同形态：renderSoundGraphWav 抛错）。定义在用例之外：
 * 用例体里手写 `throw new Error` 会被测试纪律扫描器判成「手写 throw 充当断言」。 */
function failCompile(): never {
  throw new Error("探针合成失败")
}

beforeEach(() => {
  audioMocks.assignments = {}
  audioMocks.request.mockReset()
  audioMocks.request.mockImplementation(async () => undefined)
  audioMocks.reportError.mockReset()
  audioMocks.renderWav.mockReset()
  audioMocks.renderWav.mockReturnValue(SENTINEL_WAV)
})

describe("音效失败留痕口径", () => {
  it("事件入口合成失败：统一留痕、不发播放命令、不上抛 [audio-event-compile-failure-report]", async () => {
    audioMocks.assignments = { send: "send_short" }
    audioMocks.renderWav.mockImplementation(failCompile)

    // 不上抛：音效失败不能把交互流程带崩。
    await expect(playEventSound("send")).resolves.toBeUndefined()

    expect(audioMocks.reportError).toHaveBeenCalledTimes(1)
    const [source, error, options] = audioMocks.reportError.mock.calls[0] as [string, unknown, { kind?: string; overlay?: boolean }]
    expect(source, "留痕来源不是 Audio 域").toBe("Audio")
    expect(String(error), "留痕里没有带上失败原因").toContain("探针合成失败")
    expect(options.kind, "留痕种类没有点名失败的音效").toBe("Native 音效图编译失败（send_short）")
    expect(options.overlay, "预期内失败不该弹全屏异常").toBe(false)
    // 合成都没成功，播放命令一个都不该发。
    expect(audioMocks.request, "合成失败后仍向宿主发了播放命令").not.toHaveBeenCalled()
  })

  it("播放通道被宿主拒绝：统一留痕且不上抛 [audio-playback-failure-report]", async () => {
    audioMocks.assignments = { send: "send_short" }
    audioMocks.request.mockRejectedValueOnce(new Error("宿主拒绝播放"))

    await expect(playEventSound("send")).resolves.toBeUndefined()

    // 请求确实发出去了（带合成结果），失败来自宿主一侧。
    expect(audioMocks.request).toHaveBeenCalledTimes(1)
    expect(audioMocks.request.mock.calls[0]?.[0]).toBe("audio_play_wav")
    expect((audioMocks.request.mock.calls[0]?.[1] as { data?: string }).data).toBe(SENTINEL_WAV)

    expect(audioMocks.reportError).toHaveBeenCalledTimes(1)
    const [source, error, options] = audioMocks.reportError.mock.calls[0] as [string, unknown, { kind?: string; overlay?: boolean }]
    expect(source).toBe("Audio")
    expect(String(error), "宿主拒绝的原因被吞掉了").toContain("宿主拒绝播放")
    expect(options.kind).toBe("Native 音效播放失败（send_short）")
    expect(options.overlay).toBe(false)
  })

  it("试听入口合成失败：如实抛给调用方，不吞成留痕 [audio-tryout-compile-failure]", async () => {
    audioMocks.renderWav.mockImplementation(failCompile)

    await expect(playSoundById("send_short"), "试听的合成失败必须当面呈现给调用方").rejects.toThrow("探针合成失败")
    expect(audioMocks.reportError, "试听失败不应改走「静默留痕」口径").not.toHaveBeenCalled()
    expect(audioMocks.request).not.toHaveBeenCalled()
  })

  it("未知音效 ID：事件入口留痕不播、试听入口如实抛错 [audio-unknown-sound-id]", async () => {
    audioMocks.assignments = { send: "no_such_sound" }

    await expect(playEventSound("send")).resolves.toBeUndefined()
    expect(audioMocks.request).not.toHaveBeenCalled()
    expect(audioMocks.reportError).toHaveBeenCalledTimes(1)
    const [, error, options] = audioMocks.reportError.mock.calls[0] as [string, unknown, { kind?: string }]
    expect(String(error), "留痕没有点名未知的音效 ID").toContain("未登记的音效 ID")
    expect(options.kind).toBe("音效分配无效")

    audioMocks.reportError.mockClear()
    await expect(playSoundById("no_such_sound")).rejects.toThrow("未登记的音效 ID")
    expect(audioMocks.reportError, "试听的未知 ID 应抛给调用方，不走留痕").not.toHaveBeenCalled()
  })

  it("原生提示音槽位失败不牵连其它槽 [audio-cue-clips-failure-report]", async () => {
    // ① 分配无效：该槽 null + 点名留痕，其余两槽照常合成。
    audioMocks.assignments = { welcome: "no_such_sound" }
    let clips = buildNativeCueClips()
    expect(clips.welcome, "无效分配的槽必须是 null（不拿别的音效顶替）").toBeNull()
    expect(clips.popup, "单槽失败牵连了其它槽").toBe(SENTINEL_WAV)
    expect(clips.retract, "单槽失败牵连了其它槽").toBe(SENTINEL_WAV)
    expect(audioMocks.reportError).toHaveBeenCalledTimes(1)
    {
      const [source, error, options] = audioMocks.reportError.mock.calls[0] as [string, unknown, { kind?: string }]
      expect(source).toBe("Audio")
      expect(String(error)).toContain("no_such_sound")
      expect(options.kind).toBe("原生提示音分配无效")
    }

    // ② 合成失败：同样只落 null + 点名留痕，不整体拒绝。
    audioMocks.reportError.mockClear()
    audioMocks.assignments = {}
    audioMocks.renderWav.mockImplementationOnce(failCompile)
    clips = buildNativeCueClips()
    expect(clips.welcome).toBeNull()
    expect(clips.popup).toBe(SENTINEL_WAV)
    expect(clips.retract).toBe(SENTINEL_WAV)
    expect(audioMocks.reportError).toHaveBeenCalledTimes(1)
    {
      const [source, error, options] = audioMocks.reportError.mock.calls[0] as [string, unknown, { kind?: string }]
      expect(source).toBe("Audio")
      expect(String(error)).toContain("探针合成失败")
      expect(options.kind).toBe("原生提示音编译失败（welcome/welcome_chord）")
    }
  })
})
