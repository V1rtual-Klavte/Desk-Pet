// 音效系统契约（预设注册表 / WAV 合成 / 事件播放边界）。
//
// 范围：`test/unit/audio/native-soundgraph.test.ts` 的全部 caseId 锚点。音效的
// 原生输出命令（audio_play_wav / ui_set_sound_cues）在 HostCommandMap 里的形状由
// 这里的播放断言间接钉住（请求名与 RIFF 载荷），命令矩阵本身的形状归 update 契约
// 的邻居 host 传输面，不另开第二份定义。全部覆盖点在 L2；真实出声属原生宿主，
// 不在这里冒充。
import type { ModuleContract } from "../host/types"

export const audioContract: ModuleContract = {
  module: "audio",
  sourceFiles: [
    "src/services/audio/index.ts",
    "src/services/audio/registry.ts",
    "src/services/audio/presets.ts",
    "src/services/audio/synth.ts",
    "src/services/audio/types.ts",
  ],
  sourceHash: "c4f56a4f9c040a9b1ea032e3bd58848fefbea3a17630fa3a3086f291b68966bc",
  coverage: [
    {
      id: "au-01",
      feature: "音效库与事件分配",
      description:
        "库 = 33 个登记 id（含 none）逐项可查且显示名非空，八个事件键固定；getSoundAssignments 缺省回落各事件默认音效，saveSoundAssignments 只写 appearance.soundAssignments 且后续读取立即生效（覆盖到修改的那一项）",
      why: "设置页按 id 取元数据：登记表漂移会让界面出现取不到的音效行；分配写不进 CONFIG 则该事件永远放默认音",
      layer: "unit",
      depth: "deep",
      scenarios: ["native-audio-library-config"],
    },
    {
      id: "au-02",
      feature: "SoundGraph 到 WAV 的合成",
      description:
        "振荡器/频率自动化/增益包络/低通图编译为单声道 16-bit 22050Hz PCM WAV：RIFF/WAVE 头、fmt 块（PCM、mono、采样率、位深）与 data 长度按图时长正确；全部预设可编译（voices 非空、stop > start），noise / 调制振荡器 / lowpass 等声明元素真实进入图",
      why: "WAV 头错宿主解出噪声或拒播；某个预设编译不出来只有在真正播放时才暴露",
      layer: "unit",
      depth: "deep",
      scenarios: ["native-audio-wav-pcm16", "native-audio-all-presets-compose"],
    },
    {
      id: "au-03",
      feature: "首次配置的原生提示音",
      description:
        "welcome/popup/retract 三条编译为 base64 WAV；对应事件分配 none 时该条为 null（不伪造空串波形）",
      why: "首次握手推给宿主的提示音形状错了会整条不响，而「推过」本身不会红",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-audio-initial-cues"],
    },
    {
      id: "au-04",
      feature: "事件播放入口与 IPC 边界",
      description:
        "playEventSound 经 audio_play_wav 发完整 RIFF（载荷是真 WAV，不是占位）；playNotificationByBoundary 的 unansweredCount 分档（≤1 / ≤3 / >3）逐档各触发一次；事件分配 none 时不发 IPC",
      why: "分档边界写错会让提醒音档位漂移；none 仍发 IPC 会让「关闭音效」在原生侧照样出声",
      layer: "unit",
      depth: "deep",
      scenarios: ["native-audio-event-ipc"],
    },
  ],
  // 本契约全部覆盖点在 L2：波形合成与播放接线是纯逻辑 + 假桥，真实出声属 L4，
  // 这里没有可核对内容。门槛按既有 no-e2e 契约的先例归零清空，不是放宽 ——
  // 跨层完整性由 checkLayerCoverage 负责。
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
