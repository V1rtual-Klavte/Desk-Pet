// ==========================================
// Node → 原生宿主的 UI 状态推送（W9b）
// ==========================================
//
// 十个推送口（执行契约 §6.1/§6.2/§6.4 的 Native 投影；命令形状登记在
// `src/services/host/types.ts` 的 W5/W7/W9b/A3 与主题批次分组）：
//   configure_global_shortcut   全局快捷键（general.shortcut.*；modifiers 按平台解析）
//   apply_font_snapshot         全局字体（appearance.font）
//   apply_theme                 界面主题（appearance.theme；只传 id，色值真相在宿主）
//   apply_stage_profile         主窗舞台（当前 Profile 层列表 + appearance 投影）
//   set_chat_panel              聊天列宽度（general.popup.chatWidth）
//   configure_chat_image_preview 聊天图片自动预览（appearance.chatImagePreview）
//   set_popup_placement         弹窗摆位（general.popup.mode + fixedPosition；A3）
//   set_popup_size              弹窗尺寸（general.popup.defaultSize；A3）
//   set_popup_auto_show         自动呼出开关（general.popup.autoPopupOnMessage；本批）
//   ui_set_sound_cues           音效素材（welcome/popup/retract 的 WAV 关闭包）
//
// 值一律经**现有类型化 getter / 配置门面**读取（appearanceConfig.*、
// generalConfig.*、userConfig.chatWidth），本模块不复制任何默认值；Rust 侧只持
// 不可变快照。推送时机（本模块的唯一入口 `pushNativeUiState`）：
//   - 启动握手后（`initNativeUiBridge`，由领域引导收口调用）各推一次；
//   - 相应设置保存后（host-requests 的 settings_commit 成功路径）各推一次；
//   - 编辑器保存成功后（host-requests 的 editor_save 成功路径）重推舞台。
//
// 失败语义：**如实失败，不阻断调用方**。宿主没有这些原生端口时推送会失败 ——
// 失败必须可见（warn 一条、带逐项原因），但不把宿主缺失伪装成领域初始化失败。

import { appearanceConfig, generalConfig, userConfig } from "@/services/config"
import { isMacOS } from "@/services/env"
import { getActiveProfile } from "@/services/profile"
import { buildNativeCueClips } from "@/services/audio"
import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import type { StageLayerPayload } from "@/services/host/types"

const log = createLogger("NativeUi")

/** 一次推送的结果：失败项如实带回（调用方决定如何留痕）。 */
export interface PushOutcome {
  method: string
  error?: unknown
}

/**
 * 全局快捷键（`general.shortcut.*` 的 Native 投影）。
 *
 * `modifiers` 由 Node 按平台解析好：macOS 取 `generalConfig.shortcutMacModifiers`、
 * Windows 取 `shortcutWinModifiers`（`@/services/env` 的 `isMacOS`，其值来自宿主握手
 * 的 `ServerWelcome.platform`，端口装配时刷新，见 `host/node-ports.ts`）；
 * 宿主只做名称 → 键码/修饰位的编译。键与修饰键的值只经 `generalConfig` 的既有
 * getter（不复制默认值）。**宿主收到前不注册任何快捷键**；重复推送 = 修改快捷键
 * （宿主先注销旧注册再注册新的），解析失败由宿主以结构化 `CONFIG` 错误拒绝。
 */
export async function pushGlobalShortcut(): Promise<void> {
  await getHostBridge().request("configure_global_shortcut", {
    key: generalConfig.shortcutKey,
    modifiers: isMacOS ? generalConfig.shortcutMacModifiers : generalConfig.shortcutWinModifiers,
  })
}

/** 全局字体快照（`appearance.font` 的 Native 投影；缺省 = null，由宿主用系统 fallback）。 */
export async function pushFontSnapshot(): Promise<void> {
  await getHostBridge().request("apply_font_snapshot", {
    // 空族名 = 「跟随系统默认字体栈」（getter 的既有语义），线上归 null；
    // 不在这里补任何默认字体名。
    family: appearanceConfig.fontFamily || null,
    size: appearanceConfig.fontSize,
  })
}

/**
 * 界面主题（`appearance.theme` 的 Native 投影）。
 *
 * 值只经 `userConfig.theme` 读取（非法值已在读取期收拢为 `DEFAULT_THEME`），
 * **不在 Node 侧复制主题的色值或默认值** —— token 表是 Rust 侧 `ui/theme` 的
 * 单一真相源，Node 只传 id。主题与 Profile 正交，因此本推送不带 profileId。
 */
export async function pushTheme(): Promise<void> {
  await getHostBridge().request("apply_theme", { theme: userConfig.theme })
}

/**
 * 当前 Profile 的五层 → 舞台层载荷（profiles 域内相对路径，宿主拼数据根并校验）。
 *
 * 过滤空 `image` 的层：Profile 允许「禁用层不带素材」（默认五层里就有空图层的
 * 占位），空路径无从解码，推给宿主只会产生解码失败留痕；相对顺序（z 序）不变。
 */
export function buildStageLayers(
  profileId: string,
  layers: ReadonlyArray<{ enabled: boolean; image: string; sensitivity: number; scale: number; offsetX: number; offsetY: number }>,
): StageLayerPayload[] {
  const prefix = `${profileId}/`
  return layers
    .filter((layer) => layer.image.trim().length > 0)
    .map((layer) => ({
      path: `${prefix}${layer.image.replaceAll("\\", "/").replace(/^\/+/, "")}`,
      enabled: layer.enabled,
      sensitivity: layer.sensitivity,
      scale: layer.scale,
      offsetXPercent: layer.offsetX,
      offsetYPercent: layer.offsetY,
    }))
}

/** 发送一份舞台快照（层 + 强度；开关与基准宽一律取 getter 现值）。 */
export async function sendStageProfile(layers: StageLayerPayload[], intensity: number): Promise<void> {
  await getHostBridge().request("apply_stage_profile", {
    layers,
    effectEnabled: userConfig.effectMode === "parallax",
    intensity,
    popupWidth: generalConfig.defaultPopupSize.w,
  })
}

/** 主窗舞台快照（当前激活 Profile + appearance 投影）。无激活 Profile 时如实跳过。 */
export async function pushStageProfile(): Promise<void> {
  const profile = getActiveProfile()
  if (!profile) {
    // 不是静默：没有 Profile 时推空层列表会把正在显示的舞台清空，宁可不推并留痕。
    log.warn("舞台推送跳过：没有激活的 Profile")
    return
  }
  await sendStageProfile(
    buildStageLayers(profile.id, profile.theme.parallax.layers),
    userConfig.parallaxIntensity,
  )
}

/**
 * 聊天列宽度（`general.popup.chatWidth` 的持久投影）。
 *
 * `open: null` = 不改变开合：开合是窗口运行时状态（托盘/拖动期间），设置保存
 * 不该把用户刚收起的聊天列重新弹开；只有宽度来自 CONFIG。
 */
export async function pushChatPanel(): Promise<void> {
  await getHostBridge().request("set_chat_panel", {
    open: null,
    width: userConfig.chatWidth,
  })
}

/** 聊天图片自动预览开关（`appearance.chatImagePreview`；唯一默认值在该 getter 里）。 */
export async function pushChatImagePreview(): Promise<void> {
  await getHostBridge().request("configure_chat_image_preview", {
    enabled: appearanceConfig.chatImagePreview,
  })
}

/**
 * 弹窗摆位（`general.popup.mode` / `fixedPosition` 的运行时投影）。
 *
 * `fixedPosition` 从未配置（null）时下发**无坐标的 fixed**：宿主切到固定模式但不
 * 移动窗口（呼出仍按光标落位），用户在固定模式里拖动一次主窗（A3 写回坐标）后，
 * 下一次推送就带上坐标 —— 不能在这里改成不推或退化成 cursor，那样固定位置在设置里
 * 永远激活不了。`cursor` 只更新宿主模式，不移动当前窗口。
 */
export async function pushPopupPlacement(): Promise<void> {
  if (generalConfig.popupMode === "fixed") {
    const position = userConfig.fixedPosition
    if (!position) {
      await getHostBridge().request("set_popup_placement", { mode: "fixed" })
      return
    }
    await getHostBridge().request("set_popup_placement", {
      mode: "fixed",
      x: position.x,
      y: position.y,
    })
    return
  }
  await getHostBridge().request("set_popup_placement", { mode: "cursor" })
}

/** 弹窗默认尺寸（`general.popup.defaultSize`；宿主立即应用到主窗，见 types.ts）。 */
export async function pushPopupSize(): Promise<void> {
  const size = generalConfig.defaultPopupSize
  await getHostBridge().request("set_popup_size", { w: size.w, h: size.h })
}

/**
 * 自动呼出主窗开关（`general.popup.autoPopupOnMessage`；唯一默认值在该 getter 里）。
 *
 * 只推开关值：宿主收到前按 false（fail-closed），是否呼出由原生 UI 在收到新提交的
 * 助手条目时结合呼出/收回状态机自行裁决（Node 不驱动窗口显隐/层级，见 types.ts 的
 * `set_popup_auto_show` 条目注释）。
 */
export async function pushPopupAutoShow(): Promise<void> {
  await getHostBridge().request("set_popup_auto_show", {
    enabled: generalConfig.autoPopupOnMessage,
  })
}

/**
 * 十条推送各一次（启动与设置保存后的统一入口）。
 *
 * 逐项独立执行：一条失败不影响其余九条；全部完成后把失败项汇总成一条 warn
 * （宿主缺原生端口时启动即命中这一条；真实故障同样从这条日志可见）。
 */
export async function pushNativeUiState(): Promise<PushOutcome[]> {
  const targets: Array<{ method: string; run: () => Promise<void> }> = [
    { method: "configure_global_shortcut", run: pushGlobalShortcut },
    { method: "apply_font_snapshot", run: pushFontSnapshot },
    { method: "apply_theme", run: pushTheme },
    { method: "apply_stage_profile", run: pushStageProfile },
    { method: "set_chat_panel", run: pushChatPanel },
    { method: "configure_chat_image_preview", run: pushChatImagePreview },
    { method: "set_popup_placement", run: pushPopupPlacement },
    { method: "set_popup_size", run: pushPopupSize },
    { method: "set_popup_auto_show", run: pushPopupAutoShow },
    { method: "ui_set_sound_cues", run: async () => {
      await getHostBridge().request("ui_set_sound_cues", { clips: buildNativeCueClips() })
    } },
  ]
  const failures: PushOutcome[] = []
  for (const target of targets) {
    try {
      await target.run()
    } catch (error) {
      failures.push({ method: target.method, error })
    }
  }
  if (failures.length > 0) {
    log.warn(
      "原生 UI 状态推送未完成（当前宿主可能没有原生 UI 端口，如 Node 测试宿主）：" +
        failures.map((failure) => `${failure.method}=${formatError(failure.error)}`).join(" | "),
    )
  }
  return failures
}
