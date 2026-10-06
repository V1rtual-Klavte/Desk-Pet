// 音效系统契约（预设注册表 / WAV 合成 / 事件播放边界）。
//
// 范围：`test/unit/audio/native-soundgraph.test.ts`、`test/unit/audio/合成参数与空图.test.ts`
// 与 `test/unit/audio/失败留痕口径.test.ts` 的全部 caseId 锚点。音效的
// 原生输出命令（audio_play_wav / ui_set_sound_cues）在 HostCommandMap 里的形状由
// 这里的播放断言间接钉住（请求名与 RIFF 载荷），命令矩阵本身的形状归 update 契约
// 的邻居 host 传输面，不另开第二份定义。全部覆盖点在 L2；真实出声属原生宿主，
// 不在这里冒充。
//
// 2026-10-06 验收 analyze→generate（合成边界与失败留痕批次）：新增 caseId 七条 ——
// au-02 登记 audio-synth-param-rejects / audio-synth-duration-bounds（合成参数与时长边界，
// test/unit/audio/合成参数与空图.test.ts）；au-03 登记 audio-cue-clips-failure-report；au-04 登记
// audio-event-compile-failure-report / audio-playback-failure-report / audio-tryout-compile-failure /
// audio-unknown-sound-id（test/unit/audio/失败留痕口径.test.ts）。au-02 / au-03 / au-04 的描述按
// 新锚定行为同步（参数与时长如实拒绝、单槽失败不牵连、事件入口与试听入口的失败归属）。
// 行为实现点（synth.ts 的参数校验、registry.ts 的留痕/归属分支）均已在 sourceFiles 中登记，未增删。
// `crates/native-host/src/audio/mod.rs` 本批只加了 Rust 单测（validate_wav 校验、播放入口
// 先校验后派发、未配置 cue 的重复播放）——原生侧校验与出声不属任何覆盖点的声称面
// （本契约口径：真实出声属原生宿主，不在这里冒充），未补入 sourceFiles。
// sourceHash 随本批统一刷新。
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
      feature: "SoundGraph 到 WAV 的合成与参数/时长边界",
      description:
        "振荡器/频率自动化/增益包络/低通图编译为单声道 16-bit 22050Hz PCM WAV：RIFF/WAVE 头、fmt 块（PCM、mono、采样率、位深）与 data 长度按图时长正确；全部预设可编译（voices 非空、stop > start），noise / 调制振荡器 / lowpass 等声明元素真实进入图。参数与时长边界如实拒绝，不静默截断或产出坏数据：sampleRate 只收 [8000, 96000] 内整数（非整数/越界/NaN 抛错，两个端点照常产出且采样率写进头部），图时长超过 8s 上限抛错、恰好到上限照常产出，空图与零时长返回空串（调用方按「无数据」处理）",
      why: "WAV 头错宿主解出噪声或拒播；某个预设编译不出来只有在真正播放时才暴露；参数越界若被静默收拢，调用方会拿到一份参数与预期不符的「成功」产物",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-audio-wav-pcm16",
        "native-audio-all-presets-compose",
        "audio-synth-param-rejects",
        "audio-synth-duration-bounds",
      ],
    },
    {
      id: "au-03",
      feature: "首次配置的原生提示音",
      description:
        "welcome/popup/retract 三条编译为 base64 WAV；对应事件分配 none 时该条为 null（不伪造空串波形）；单槽失败不牵连其它槽——分配无效或合成失败只让该槽返回 null，并经统一错误出口点名留痕（「原生提示音分配无效」/「原生提示音编译失败（event/soundId）」，overlay:false），其余槽照常合成",
      why: "首次握手推给宿主的提示音形状错了会整条不响，而「推过」本身不会红；一个坏分配若整体拒绝或静默顶替，会把其它两条正常的提示音一起毁掉",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-audio-initial-cues", "audio-cue-clips-failure-report"],
    },
    {
      id: "au-04",
      feature: "事件播放入口与 IPC 边界（含失败归属）",
      description:
        "playEventSound 经 audio_play_wav 发完整 RIFF（载荷是真 WAV，不是占位）；playNotificationByBoundary 的 unansweredCount 分档（≤1 / ≤3 / >3）逐档各触发一次；事件分配 none 时不发 IPC。失败口径分入口：事件入口的合成失败与播放通道失败都不上抛、经统一错误出口留痕（overlay:false；合成失败时不发播放命令），未登记的音效 ID 同样留痕不播；试听入口（playSoundById）的合成失败与未知 ID 如实抛给调用方（不吞成留痕、不发播放命令），播放通道失败仍走统一留痕",
      why: "分档边界写错会让提醒音档位漂移；none 仍发 IPC 会让「关闭音效」在原生侧照样出声；失败若上抛会把一条已被接受的消息变成失败，试听若吞成留痕则设置页会把「没响」画成正常",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-audio-event-ipc",
        "audio-event-compile-failure-report",
        "audio-playback-failure-report",
        "audio-tryout-compile-failure",
        "audio-unknown-sound-id",
      ],
    },
  ],
  // 本契约全部覆盖点在 L2：波形合成与播放接线是纯逻辑 + 假桥，真实出声属 L4，
  // 这里没有可核对内容。门槛按既有 no-e2e 契约的先例归零清空，不是放宽 ——
  // 跨层完整性由 checkLayerCoverage 负责。
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
