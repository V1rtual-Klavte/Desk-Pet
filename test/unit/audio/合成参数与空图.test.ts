// ==========================================
// SoundGraph 合成参数校验 —— 失败分支（Node 侧）
// ==========================================
//
// 音效链路：Node 合成 WAV（本文件被测的 `renderSoundGraphWav`）→ 宿主播放
// （crates/native-host/src/audio/mod.rs，失败走统一留痕）。本文件覆盖合成侧的
// 「参数非法 / 边界」失败分支：非法采样率与超时长必须如实抛错（不许静默截断或
// 产出坏数据），空图不产出 WAV —— 调用方（registry）据此决定留痕口径。
//
// 为何在 L2：被测对象是零 IPC 的纯函数（合成参数与时长边界），按 test/AGENTS 的
// 选层顺序（真 Rust 边界 → L4；真 JSONL/agent loop → L3；否则 L2）归单元层；
// 既有 audio 契约的覆盖点（au-02 合成）也都在 L2。
//
// caseId 清单（新增，需在契约生成时登记 coverage）：
//   · audio-synth-param-rejects / audio-synth-duration-bounds → 归 audio 契约 au-02
//     （登记时把两条 caseId 加进 au-02 的 scenarios 并同步覆盖描述）

import { describe, expect, it } from "vitest"

import { renderSoundGraphWav } from "@/services/audio/synth"
import type { SoundGraph } from "@/services/audio/types"

/** 极小合法图：0.05s 正弦 + 线性收尾包络（参数用，不依赖任何预设的时长）。 */
const TINY_GRAPH: SoundGraph = {
  voices: [{
    source: "oscillator",
    wave: "sine",
    frequency: [{ time: 0, value: 440, curve: "set" }],
    gain: [
      { time: 0, value: 1, curve: "set" },
      { time: 0.05, value: 0, curve: "linear" },
    ],
    start: 0,
    stop: 0.05,
  }],
}

function decode(bytes: string): Buffer {
  return Buffer.from(bytes, "base64")
}

describe("SoundGraph 合成参数校验", () => {
  it("拒绝非法采样率，合法档位不误拒 [audio-synth-param-rejects]", () => {
    // 非整数 / 越界：如实抛错，不许静默取整或换成默认采样率。
    expect(() => renderSoundGraphWav(TINY_GRAPH, 7_999)).toThrow("sampleRate")
    expect(() => renderSoundGraphWav(TINY_GRAPH, 96_001)).toThrow("sampleRate")
    expect(() => renderSoundGraphWav(TINY_GRAPH, 22_050.5)).toThrow("sampleRate")
    expect(() => renderSoundGraphWav(TINY_GRAPH, Number.NaN)).toThrow("sampleRate")

    // 合法边界（含端点）照常产出可解码的 WAV，且采样率写进头部。
    const low = decode(renderSoundGraphWav(TINY_GRAPH, 8_000))
    expect(low.subarray(0, 4).toString("ascii")).toBe("RIFF")
    expect(low.readUInt32LE(24)).toBe(8_000)
    const high = decode(renderSoundGraphWav(TINY_GRAPH, 96_000))
    expect(high.readUInt32LE(24)).toBe(96_000)
  })

  it("拒绝超时长，空图/零时长不产出 WAV [audio-synth-duration-bounds]", () => {
    const tooLong: SoundGraph = {
      voices: [{ ...TINY_GRAPH.voices[0], stop: 8.5 }],
    }
    expect(() => renderSoundGraphWav(tooLong)).toThrow("时长超过上限")
    // 恰好到上限（8s）不是「超过」，照常产出。
    const atLimit: SoundGraph = { voices: [{ ...TINY_GRAPH.voices[0], stop: 8 }] }
    expect(decode(renderSoundGraphWav(atLimit)).length).toBeGreaterThan(44)

    // 空图与零时长：没有可播放内容，返回空串（调用方按「无数据」处理，不播也不报错）。
    expect(renderSoundGraphWav({ voices: [] })).toBe("")
    expect(renderSoundGraphWav({ voices: [{ ...TINY_GRAPH.voices[0], stop: 0 }] })).toBe("")
  })
})
