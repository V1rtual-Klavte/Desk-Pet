// ==========================================
// 宿主 → Node 请求面（W9b）：设置读写 / 分隔条宽度写回 / 人格卡列表 / 编辑器 I/O
// A2 增补：会话标签与历史面板的五条 `chat_*` 方法（处理体在 `chat-intents.ts`，
// 方法名与 args 形状登记在 `HostRequestMap`；传输复用同一事件/回执通道）。
// 本包增补：核心聊天链路四条（`chat_send` / `chat_slash_command` / `chat_stop` /
// `chat_switch_session`；处理体同在 `chat-intents.ts`，前三条的宿主侧提交非阻塞）；
// 消息行动作与抽屉三个 CONFIG 写四条（`chat_remember_message` /
// `chat_set_default_delivery` / `chat_set_thinking_effort` / `chat_set_safety_mode`；
// 处理体同在 `chat-intents.ts`，有界请求）；
// 决策类面板动作九条（计划恢复/丢弃、未知副作用处置、队列撤回、暂停输入继续/丢弃、
// 中断运行继续/丢弃；处理体在 `decision-intents.ts`，其中 resume_plan /
// resume_paused_inputs / continue_interrupted_run 的宿主侧提交非阻塞）。
// ==========================================
//
// 方向：**原生 UI 发起、Node 应答**（执行契约 §2 的「UI → 用户意图 / 设置提交」与
// §3/§6.4 的权属划分 —— CONFIG/Profile 的唯一真相源在 Node，原生 UI 只持不可变
// 快照与临时草稿）。方法与形状登记在 `src/services/host/types.ts` 的 `HostRequestMap`。
//
// 传输（本模块只做消费侧）：宿主经事件 `HOST_REQUEST_EVENT` 投
// `HostRequestEnvelope{requestId, method, args}`；本模块处理后经命令
// `host_request_result` 回执。信封/方法/参数/结果是跨 transport 不变的形状 ——
// W4 的「Node 侧命令面」（`HostBridge::call`）落地后可整体改走请求/响应通道。
//
// 写入纪律：
//   - 设置提交走既有 CONFIG 写路径（`setOverride(s)` → `flushConfig()` 的原子写盘），
//     键 = CONFIG 路径，不建第二张映射表；人格卡切换走注册表唯一入口
//     `switchPersonality`（不是普通 setOverride）；
//   - 编辑器保存走既有 Profile 唯一写入路径（`profile_file_read` → 合并 →
//     `profile_file_write`，与旧图层编辑器的 persistProfile 同一链路）；
//   - 本模块不落任何第二份持久状态：读的是 CONFIG/Profile 现状，写的是既有文件。
//
// 失败语义：处理器抛出的异常一律转成结构化 `{code, message}` 回执（code 取
// `errorCode()`，不降级成裸字符串）；回执发送失败（宿主已断开）只留痕 ——
// 调用方（宿主）有超时归宿，不在这里补发第二次裁决。

import { dump as dumpYaml, load as loadYaml } from "js-yaml"

import {
  appearanceConfig,
  applyLogLevel,
  exportConfigYaml,
  flushConfig,
  generalConfig,
  getAllOverrides,
  getBundledDefaults,
  getOverride,
  humanizerConfig,
  importConfigYaml,
  initConfig,
  setOverride,
  silentAccessConfig,
  userConfig,
} from "@/services/config"
import { errorCode, formatError } from "@/services/error"
import { getHostBridge, HOST_REQUEST_EVENT } from "@/services/host"
import { createLogger } from "@/services/logger"
import { normalizeSeparators, runtimePath } from "@/services/paths"
import { getActivePersonalityId, listCardMetas, switchPersonality } from "@/services/personality"
import { refreshProfileAssets } from "@/services/profile"
import type {
  EditorAssetPayload,
  EditorLayerPayload,
  EditorProfilePayload,
  EditorSavePayload,
  HostRequestEnvelope,
  MemoryItemChangePayload,
  PersonalityCardsPayload,
  SettingChangePayload,
  SettingValue,
  SettingsSnapshotPayload,
  StageLayerPayload,
} from "@/services/host/types"
import {
  chatCloseSession,
  chatDeleteSession,
  chatNewSession,
  chatRememberMessage,
  chatRequestSessionHistory,
  chatRestoreSession,
  chatSend,
  chatSetDefaultDelivery,
  chatSetSafetyMode,
  chatSetThinkingEffort,
  chatSlashCommand,
  chatStop,
  chatSwitchSession,
  runChatAfterReplyPush,
} from "./chat-intents"
import {
  cardManage,
  cardMarkdownRead,
  cardMarkdownWrite,
  cardStagesRead,
  cardStagesRegenerate,
  cardStagesWrite,
  cardTemplate,
  cardVariablePool,
  mcpDelete,
  mcpExport,
  mcpImport,
  mcpSave,
  mcpServerForm,
  mcpCredentialWrite,
  mcpTest,
  memoryBackupList,
  memoryDreamingSweep,
  memoryItemChange,
  memoryItemDetail,
  memoryJobCancel,
  memoryJobResume,
  memoryMaintenance,
  memoryOverview,
  memoryRestore,
  memorySourceEvidence,
  pickOpenFile,
  pickSaveFile,
  profileList,
  profileManage,
  readTextFile,
  skillDelete,
  skillUpload,
  soundLibrary,
  soundPreview,
  soundReset,
  soundSetAssignment,
  toolsMcpServers,
  toolsMcpToggle,
  toolsSkills,
  toolsSkillToggle,
  toolsToolPolicies,
  v1rtualRead,
  v1rtualWrite,
  writeTextFile,
} from "./management-intents"
import {
  chatAbortRunningPlan,
  chatContinueInterruptedRun,
  chatDiscardInterruptedRun,
  chatDiscardPausedInputs,
  chatDiscardPlan,
  chatResolveUnknownSideEffect,
  chatResumePausedInputs,
  chatResumePlan,
  chatWithdrawQueued,
} from "./decision-intents"
import { pushNativeUiState, sendStageProfile } from "./pushes"

const log = createLogger("NativeUi")

// `HOST_REQUEST_EVENT`（宿主 → Node 请求的事件名）的定义点已收进 host 域的线协议
// 事件名区（`@/services/host` 的 event-names.ts；Rust 同步点见那里的注释），
// 本模块只引用，不保留第二份定义。

/** 回执命令名（与 `HostCommandMap` 的 `host_request_result` 同名）。 */
export const HOST_REQUEST_RESULT_METHOD = "host_request_result"

/** 人格卡字段键（切换走注册表唯一入口，见 `applySettingChanges`）。 */
const PERSONALITY_ACTIVE_KEY = "ai.personality.active"

/** 激活 Profile 字段键（切换走 Profile 域唯一入口 `switchActiveProfile`，见 `settingsCommit`）。 */
const PROFILE_ACTIVE_KEY = "appearance.activeProfile"

/** 聊天列宽度写回的可接受范围：与设置 schema 的 `general.popup.chatWidth`（120–1000）同口径。 */
const CHAT_WIDTH_MIN = 120
const CHAT_WIDTH_MAX = 1000

/**
 * 窗口尺寸写回的可接受范围：与设置 schema 的 `general.popup.defaultSize.w`（200–4000）
 * 与 `.h`（150–4000）同口径 —— 拖动/设置两条编辑同一字段，写出的值不能让另一方读出非法值。
 */
const POPUP_WIDTH_MIN = 200
const POPUP_HEIGHT_MIN = 150
const POPUP_SIZE_MAX = 4000

let registered = false
let unsubscribe: (() => void) | null = null
let draining = false
let drainResult: Promise<HostRequestDrainReport> | null = null
let stoppedRequests: Promise<readonly string[]>[] | null = null
let admissionFailures: string[] = []
const pendingRequests = new Set<Promise<readonly string[]>>()

export interface HostRequestDrainReport {
  completed: number
  failures: string[]
}

/** 订阅宿主请求（幂等；由 `initNativeUiBridge` 在领域引导收口调用一次）。 */
export function initHostRequestHandlers(): void {
  if (registered) return
  if (draining) throw new Error("宿主请求处理器已进入关停排空，不能重新注册")
  const bridge = getHostBridge()
  // 事件名不在 HostEventMap（那是 Node/宿主 → UI 的读模型矩阵）：与 UI 回执
  // （ui-events.ts 的 UiReceiptMap）同款，经运行时收窄后订阅。宿主按同名事件投递。
  unsubscribe = bridge.subscribe(
    HOST_REQUEST_EVENT as unknown as keyof import("@/services/host/types").HostEventMap,
    (payload) => {
      if (draining) {
        log.warn("Node 关停排空期间收到新的宿主请求，按 admission 关闭拒绝")
        return
      }
      const envelope = payload as unknown as HostRequestEnvelope
      const task = handleEnvelope(envelope)
      pendingRequests.add(task)
      void task.then(() => {
        pendingRequests.delete(task)
      })
    },
  )
  registered = true
}

/** 关闭新宿主请求 admission；关停时与 Harness 取消并行调用，不等待在途 handler。 */
export function stopHostRequestHandlers(): void {
  if (draining) return
  draining = true
  const stop = unsubscribe
  unsubscribe = null
  registered = false
  stoppedRequests = [...pendingRequests]
  try {
    stop?.()
  } catch (error) {
    admissionFailures.push(`宿主请求 unsubscribe 失败：${formatError(error)}`)
  }
}

/** 关闭新请求 admission，并等待所有此前已启动 handler 与回执完成。 */
export function drainHostRequestHandlers(): Promise<HostRequestDrainReport> {
  stopHostRequestHandlers()
  if (drainResult) return drainResult
  const pending = stoppedRequests ?? [...pendingRequests]
  drainResult = Promise.all(pending).then((results) => ({
    completed: pending.length,
    failures: [...admissionFailures, ...results.flatMap((result) => result)],
  }))
  return drainResult
}

/** 测试拆卸。 */
export async function __resetHostRequestHandlersForTest(): Promise<void> {
  await drainHostRequestHandlers()
  drainResult = null
  draining = false
  stoppedRequests = null
  admissionFailures = []
}

async function handleEnvelope(envelope: HostRequestEnvelope): Promise<readonly string[]> {
  if (!envelope || typeof envelope.requestId !== "number" || typeof envelope.method !== "string") {
    log.warn("收到形状无效的宿主请求（缺 requestId/method），按协议违规丢弃")
    return []
  }
  const failures: string[] = []
  let result: unknown
  let handlerFailed = false
  try {
    result = await dispatchHostRequest(envelope.method, envelope.args)
  } catch (error) {
    handlerFailed = true
    const detail = formatError(error)
    failures.push(`宿主请求 ${envelope.method} handler 失败：${detail}`)
    const delivered = await reply(envelope.requestId, false, undefined, {
      code: errorCode(error) ?? "OTHER",
      message: detail,
    })
    if (!delivered) failures.push(`宿主请求 ${envelope.method} 失败回执未送达`)
  }
  if (!handlerFailed) {
    const delivered = await reply(envelope.requestId, true, result)
    if (!delivered) failures.push(`宿主请求 ${envelope.method} 成功回执未送达`)
  }
  // A2：回执发出之后补投影推送（顺序有语义：宿主侧「读取中」在回执后登记、
  // 在投影帧到达时清除；见 chat-intents 文件头）。只对视情况方法动作，失败只留痕。
  try {
    await runChatAfterReplyPush(envelope.method)
  } catch (error) {
    const detail = formatError(error)
    log.warn(`宿主请求 ${envelope.method} 回执后的投影推送失败：${detail}`)
    failures.push(`宿主请求 ${envelope.method} 回执后处理失败：${detail}`)
  }
  return failures
}

async function reply(
  requestId: number,
  ok: boolean,
  result?: unknown,
  error?: { code: string; message: string },
): Promise<boolean> {
  try {
    await getHostBridge().request(HOST_REQUEST_RESULT_METHOD, { requestId, ok, result, error })
    return true
  } catch (sendError) {
    // 宿主已断开/超时归宿由宿主侧负责（TIMEOUT 与业务失败分开）——这里补发没有意义，
    // 如实留痕即可，不吞掉原因。
    log.warn(`宿主请求回执发送失败（requestId=${requestId}）：${formatError(sendError)}`)
    return false
  }
}

/** 方法分派（导出供测试直接驱动）。 */
export async function dispatchHostRequest(method: string, args: unknown): Promise<unknown> {
  switch (method) {
    case "settings_read":
      return settingsRead()
    case "settings_commit":
      return settingsCommit(args as { changes: SettingChangePayload[] })
    case "set_chat_width":
      return setChatWidth(args as { width: number })
    case "set_popup_geometry":
      return setPopupGeometry(
        args as {
          size?: { w: number; h: number } | null
          position?: { x: number; y: number } | null
        },
      )
    case "personality_cards":
      return personalityCards()
    case "editor_load":
      return editorLoad()
    case "editor_save":
      return editorSave(args as EditorSavePayload)
    // 编辑器素材列表/跨层复制（本包补齐；形状见编辑器 I/O 小节的 EditorAssetPayload）。
    case "editor_list_assets":
      return editorListAssets()
    case "editor_copy_asset":
      return editorCopyAsset(args as { layer?: number; source?: string })
    // ── A2：会话标签 / 历史面板（承接见 chat-intents.ts 文件头）──
    case "chat_new_session":
      return chatNewSession()
    case "chat_close_session":
      return chatCloseSession(args)
    case "chat_delete_session":
      return chatDeleteSession(args)
    case "chat_restore_session":
      return chatRestoreSession(args)
    case "chat_request_session_history":
      return chatRequestSessionHistory()
    // ── 本包：核心聊天链路（承接见 chat-intents.ts 文件头；send/slash/stop 的宿主侧
    //    提交是非阻塞的，回执在回合/运行收尾后才到 —— 这里照常应答，语义由回执承载）──
    case "chat_send":
      return chatSend(args)
    case "chat_slash_command":
      return chatSlashCommand(args)
    case "chat_stop":
      return chatStop(args)
    case "chat_switch_session":
      return chatSwitchSession(args)
    // ── 本包：消息行动作与会话级覆盖（承接见 chat-intents.ts 对应小节）──
    case "chat_remember_message":
      return chatRememberMessage(args)
    case "chat_set_default_delivery":
      return chatSetDefaultDelivery(args)
    case "chat_set_thinking_effort":
      return chatSetThinkingEffort(args)
    case "chat_set_safety_mode":
      return chatSetSafetyMode(args)
    // ── 本包：决策类面板动作（承接见 decision-intents.ts 文件头；resume_plan /
    //    resume_paused_inputs / continue_interrupted_run 的宿主侧提交是非阻塞的，
    //    回执在整段计划/整个回合收尾后才到 —— 这里照常应答，语义由回执承载）──
    case "chat_abort_running_plan":
      return chatAbortRunningPlan(args)
    case "chat_resume_plan":
      return chatResumePlan(args)
    case "chat_discard_plan":
      return chatDiscardPlan(args)
    case "chat_resolve_unknown_side_effect":
      return chatResolveUnknownSideEffect(args)
    case "chat_withdraw_queued":
      return chatWithdrawQueued(args)
    case "chat_resume_paused_inputs":
      return chatResumePausedInputs(args)
    case "chat_discard_paused_inputs":
      return chatDiscardPausedInputs(args)
    case "chat_continue_interrupted_run":
      return chatContinueInterruptedRun(args)
    case "chat_discard_interrupted_run":
      return chatDiscardInterruptedRun(args)
    // ── W9d：设置页管理面（承接见 management-intents.ts 文件头）──
    case "tools_mcp_servers":
      return toolsMcpServers()
    case "tools_mcp_toggle":
      return toolsMcpToggle(args)
    case "tools_skills":
      return toolsSkills()
    case "tools_skill_toggle":
      return toolsSkillToggle(args)
    case "tools_tool_policies":
      return toolsToolPolicies()
    case "memory_overview":
      return memoryOverview(args)
    case "memory_item_detail":
      return memoryItemDetail(args)
    case "memory_item_change":
      return memoryItemChange(args as MemoryItemChangePayload)
    case "profile_list":
      return profileList()
    // ── 本批：设置页管理面扩展（通用 / AI / 外观 / 工具 / 记忆；承接见各小节）──
    case "settings_defaults":
      return settingsDefaults()
    case "config_export":
      return configExport()
    case "config_import":
      return configImport()
    case "v1rtual_read":
      return v1rtualRead()
    case "v1rtual_write":
      return v1rtualWrite(args)
    case "card_stages_read":
      return cardStagesRead(args)
    case "card_stages_write":
      return cardStagesWrite(args)
    case "card_stages_regenerate":
      return cardStagesRegenerate(args)
    case "card_variable_pool":
      return cardVariablePool(args)
    case "card_manage":
      return cardManage(args)
    case "card_markdown_read":
      return cardMarkdownRead(args)
    case "card_markdown_write":
      return cardMarkdownWrite(args)
    case "card_template":
      return cardTemplate()
    case "profile_manage":
      return profileManage(args)
    case "sound_library":
      return soundLibrary()
    case "sound_set_assignment":
      return soundSetAssignment(args)
    case "sound_reset":
      return soundReset()
    case "sound_preview":
      return soundPreview(args)
    case "mcp_server_form":
      return mcpServerForm(args)
    case "mcp_credential_write":
      return mcpCredentialWrite(args)
    case "mcp_save":
      return mcpSave(args)
    case "mcp_delete":
      return mcpDelete(args)
    case "mcp_test":
      return mcpTest(args)
    case "mcp_import":
      return mcpImport()
    case "mcp_export":
      return mcpExport()
    case "skill_upload":
      return skillUpload()
    case "skill_delete":
      return skillDelete(args)
    case "memory_source_evidence":
      return memorySourceEvidence(args)
    case "memory_dreaming_sweep":
      return memoryDreamingSweep()
    case "memory_maintenance":
      return memoryMaintenance(args)
    case "memory_backup_list":
      return memoryBackupList()
    case "memory_restore":
      return memoryRestore(args)
    case "memory_job_cancel":
      return memoryJobCancel(args)
    case "memory_job_resume":
      return memoryJobResume(args)
    default:
      throw Object.assign(new Error(`未知的宿主请求方法: ${method}`), { code: "OTHER" })
  }
}

// ==========================================
// 本批：通用页（恢复默认 / 配置导入导出）
// ==========================================

/**
 * 「↺ 默认」：内置 CONFIG 模板的整表投影（与 `settings_read` 同形）。
 * 默认值的唯一真值点在 Node 的 CONFIG.yaml 模板；宿主把返回值填进草稿，保存前不落盘。
 */
async function settingsDefaults(): Promise<SettingsSnapshotPayload> {
  await initConfig()
  const values: Record<string, SettingValue> = {}
  flattenConfig(getBundledDefaults(), "", values)
  return { values }
}

/**
 * 「导出配置」：生成 YAML → 原生保存对话框 → 既有 `file_write` 落盘。
 * 用户取消是正常结果（`saved=false`），不是失败；写盘失败如实抛出。
 */
async function configExport(): Promise<{ saved: boolean; path: string | null }> {
  await initConfig()
  const yaml = exportConfigYaml()
  const path = await pickSaveFile("deskpet-config.yaml", "DeskPet 配置", "yaml")
  if (!path) return { saved: false, path: null }
  await writeTextFile(path, yaml)
  log.info(`配置已导出: ${path}`)
  return { saved: true, path }
}

/**
 * 「导入配置」：打开对话框 → 读取 → `importConfigYaml` 校验后替换运行时 CONFIG 并写盘。
 * 导入成功后按既有的运行期重应用路径重放三个受影响的分支（观察总闸 / 日志级别 / 拟人表达），再推 UI 投影。
 */
async function configImport(): Promise<{ imported: boolean }> {
  const path = await pickOpenFile(["yaml", "yml"], "DeskPet 配置")
  if (!path) return { imported: false }
  const text = await readTextFile(path)
  await importConfigYaml(text)
  await reapplyRuntimeSettings([
    { key: "ai.silentAccess.frequency", value: silentAccessConfig.frequency },
    { key: "general.logging.level", value: generalConfig.loggingLevel },
    { key: "ai.humanizer.enabled", value: humanizerConfig.enabled },
  ])
  await pushNativeUiState()
  log.info(`配置已导入: ${path}`)
  return { imported: true }
}

// ==========================================
// 设置读写
// ==========================================

/**
 * 整表快照：键 = CONFIG 路径（点分），值只保留标量。
 *
 * - 嵌套对象展开为点分键（`appearance.font` → `appearance.font.family/.size`）；
 * - 标量数组（如 `tools.bash.whitelist`、`general.shortcut.macModifiers`）按
 *   「多行文本，一行一项」承载（设置 schema 的 Multiline/文本形状约定，回写时还原）；
 * - 对象数组（MCP 服务器列表等）没有对应控件，跳过。
 * 缺键 = 该字段未配置（**不在这里补任何默认值** —— getter/消费方各自兜底）。
 */
export function collectSettingsSnapshot(): SettingsSnapshotPayload {
  const values: Record<string, SettingValue> = {}
  flattenConfig(getAllOverrides(), "", values)
  return { values }
}

function flattenConfig(node: unknown, prefix: string, out: Record<string, SettingValue>): void {
  if (node === null || node === undefined) return
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    if (prefix.length > 0) out[prefix] = node
    return
  }
  if (Array.isArray(node)) {
    // `length > 0` 必须显式判：空数组的 `every` 恒真（vacuous truth），不加会把
    // 「空的对象数组」（如 `tools.mcp.servers: []`）误当标量数组产出空串键 ——
    // 与「对象数组没有对应控件，跳过」的规格相反。
    if (
      prefix.length > 0 &&
      node.length > 0 &&
      node.every((item) => typeof item === "string" || typeof item === "number")
    ) {
      out[prefix] = node.join("\n")
    }
    return
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flattenConfig(value, prefix.length > 0 ? `${prefix}.${key}` : key, out)
    }
  }
}

/** 快照回写形状：多行文本回标量数组（与 `flattenConfig` 互逆）；其余原样。 */
export function normalizeSettingValue(key: string, value: SettingValue): unknown {
  if (typeof value !== "string") return value
  const current = getOverride<unknown>(key)
  if (Array.isArray(current)) {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }
  return value
}

async function settingsRead(): Promise<SettingsSnapshotPayload> {
  // 自足加载（幂等）：设置窗可能在领域引导完成前的窗口期打开；读的是运行时 CONFIG，
  // 不是内置模板。
  await initConfig()
  return collectSettingsSnapshot()
}

/**
 * 提交设置变更表：应用 → 一次原子写盘 → 重应用运行期派生值 → 推送受影响的 UI 状态。
 *
 * 部分失败语义：人格卡切换（注册表入口，可能因 Card 缺失/阶段生成失败拒绝）在
 * 应用任何改动**之前**执行 —— 失败时内存里不留半套改动，草稿留在原生设置窗。
 * 写盘失败如实抛出（内存已应用、磁盘未落；与旧设置面板同口径：错误摆给用户，
 * 由用户重试保存）。写盘成功后的重应用失败不回滚、不判保存失败（见
 * reapplyRuntimeSettings 的失败语义）。
 */
async function settingsCommit(args: { changes: SettingChangePayload[] }): Promise<void> {
  const changes = args?.changes
  if (!Array.isArray(changes)) {
    throw Object.assign(new Error("settings_commit 缺少 changes 数组"), { code: "CONFIG" })
  }
  await initConfig()

  // ① 人格卡：唯一入口是注册表的 switchPersonality（它会加载 stages 与变量池，
  //    失败自带回滚）；成功后才把选择持久化进 CONFIG。
  const personalityChange = changes.find((change) => change.key === PERSONALITY_ACTIVE_KEY)
  if (personalityChange) {
    const cardId = typeof personalityChange.value === "string" ? personalityChange.value : ""
    if (cardId.length === 0) {
      throw Object.assign(new Error("人格卡不能为空（不能关闭人格）"), { code: "CONFIG" })
    }
    const switched = await switchPersonality(cardId)
    if (!switched.ok) {
      throw Object.assign(new Error(switched.error ?? `切换人格卡失败: ${cardId}`), { code: "OTHER" })
    }
    // 切卡成功后的激活问候（旧壳 AITab.applySwitch 同一步）：此时 stages 缓存已是新卡，
    // `pickActiveGreeting` 取到的就是新卡的问候。用 `pushAssistantMessage` 而不是
    // `initWelcome` —— 问候只进入当前会话视图，不写 greeting 持久条目（旧壳同口径）。
    // 问候推送失败不阻断保存（卡已切换、配置照常写盘）：如实留痕，不伪造「已问候」。
    try {
      const { pickActiveGreeting } = await import("@/services/personality")
      const greeting = pickActiveGreeting()
      if (greeting) {
        const { getActiveSessionId, pushAssistantMessage } = await import("@/services/session")
        const sessionId = getActiveSessionId()
        if (sessionId) pushAssistantMessage(greeting, sessionId)
        else log.debug("切卡问候未推送：当前没有活跃会话")
      }
    } catch (error) {
      log.warn(`切卡后的激活问候推送失败（卡已切换）: ${formatError(error)}`)
    }
  }

  // ①.5 激活 Profile：唯一入口是 Profile 域的 `switchActiveProfile`（激活 + 落盘 +
  //     通知其它窗口；舞台重推经 active-profile-signal 监听自动跟上）。与人格卡同款：
  //     先切换（失败中止保存、内存不留半套改动），成功后才并入本次写盘。
  const profileChange = changes.find((change) => change.key === PROFILE_ACTIVE_KEY)
  if (profileChange) {
    const profileId = typeof profileChange.value === "string" ? profileChange.value : ""
    if (profileId.length === 0) {
      throw Object.assign(new Error("Profile 不能为空（不能取消激活）"), { code: "CONFIG" })
    }
    const { switchActiveProfile } = await import("@/services/profile")
    if (!(await switchActiveProfile(profileId))) {
      throw Object.assign(
        new Error(`切换 Profile 失败: ${profileId}（请确认它还存在）`),
        { code: "OTHER" },
      )
    }
  }

  // ② 其余变更按 CONFIG 路径直接落进 cfg（与设置面板的 setOverrides 同一写路径）。
  for (const change of changes) {
    if (change.key === PERSONALITY_ACTIVE_KEY) {
      setOverride(change.key, change.value)
      continue
    }
    setOverride(change.key, normalizeSettingValue(change.key, change.value))
  }

  // ③ 一次写盘（写队列会把上面的多次 setOverride 合并成一次磁盘写入）。
  await flushConfig()

  // ③.5 重应用受影响的运行期派生值（只按变更键裁定，见 reapplyRuntimeSettings）。
  //      在推送之前：先重应用（观察总闸/快捷键重注册等）再刷新 UI 投影。
  await reapplyRuntimeSettings(changes)

  // ④ 推送受影响的原生 UI 状态（推送失败不回滚已保存的配置：配置在盘上，
  //    失败已由 pushNativeUiState 逐项留痕）。
  await pushNativeUiState()
}

/**
 * 设置保存后重应用「改了要立刻生效」的运行期派生值。
 *
 * 按键裁定（值一律读保存后的 CONFIG 现值，不再读 `changes` 里的草稿值）：
 *   - `ai.silentAccess.*` → 观察总闸（`setMonitorEnabled`，内含行为采集启停）+ 静默了解
 *     调度起停（档位「关」= 停；否则起）；
 *   - `ai.proactive.*` → `refreshProactive()`（档位与静默时段都是 scanner 的运行期
 *     配置输入，每次保存后都要重应用；scanner 按档位「关」自行停跑）；
 *   - `general.logging.level` → `applyLogLevel()`（logger 级别是缓存值，需在保存后
 *     重应用；Rust 侧同步接收）；
 *   - `ai.humanizer.enabled` → `revealAll()`（保存后立即揭示已提交未展示的分泡）；
 *   - `ai.conversation.defaultDelivery` / `ai.thinking.effort` / `ai.safety.mode`
 *     → 重推一次会话投影帧（复用 `pushSessionProjection`，不另建刷新机制）：聊天
 *     抽屉三个下拉的选中态来自投影（宿主不读 CONFIG），设置页改了这三项要让抽屉
 *     即时跟上（抽屉与设置页是同一份配置的两个面）。
 * 其余设置项的消费点都在读取时取现值（类型化 getter / 下一次 run 冻结），无需重应用：
 * 快捷键/字体/主题/舞台/聊天列宽/图片预览/摆位/尺寸/自动呼出/音效已由
 * `pushNativeUiState` 的十条推送覆盖（逐项口径见 pushes.ts 头部）；
 * ContextKernel/Plan/Memory/MCP 等在下一次 run 组装时读取现值。
 *
 * 失败语义：配置已写盘，重应用失败**不回滚**、也不把保存判成失败；逐项留痕（与
 * pushNativeUiState 同一口径 —— 失败必须可见，但宿主缺失不伪装成领域错误）。
 */
async function reapplyRuntimeSettings(changes: SettingChangePayload[]): Promise<void> {
  const touched = (prefix: string): boolean =>
    changes.some((change) => typeof change.key === "string" && change.key.startsWith(prefix))
  const failures: string[] = []
  if (touched("ai.silentAccess.")) {
    try {
      const { setMonitorEnabled } = await import("@/services/window")
      const enabled = silentAccessConfig.frequency !== "off"
      await setMonitorEnabled(enabled)
      const { startSilentUnderstanding, stopSilentUnderstanding } = await import("@/services/observation")
      if (enabled) startSilentUnderstanding()
      else await stopSilentUnderstanding()
    } catch (error) {
      failures.push(`silentAccess=${formatError(error)}`)
    }
  }
  if (touched("ai.proactive.")) {
    try {
      const { refreshProactive } = await import("@/services/proactive")
      refreshProactive()
    } catch (error) {
      failures.push(`proactive=${formatError(error)}`)
    }
  }
  if (touched("general.logging.level")) {
    try {
      applyLogLevel()
    } catch (error) {
      failures.push(`logging=${formatError(error)}`)
    }
  }
  if (touched("ai.humanizer.enabled")) {
    try {
      const { revealAll } = await import("@/services/humanizer")
      revealAll()
    } catch (error) {
      failures.push(`humanizer=${formatError(error)}`)
    }
  }
  if (
    touched("ai.conversation.defaultDelivery") ||
    touched("ai.thinking.effort") ||
    touched("ai.safety.mode")
  ) {
    try {
      // 动态 import：与上面几条同款跨域取用（模块图不在本文件顶端展开）。
      const { pushSessionProjection } = await import("@/services/native-ui/session-projection")
      await pushSessionProjection()
    } catch (error) {
      failures.push(`chatProjection=${formatError(error)}`)
    }
  }
  if (failures.length > 0) {
    log.warn(
      "设置保存后的运行期重应用未完成（配置已落盘；失败项在下次启动时生效）: " + failures.join(" | "),
    )
  }
}

// ==========================================
// 聊天列宽度写回（分隔条拖动结束）
// ==========================================

async function setChatWidth(args: { width: number }): Promise<void> {
  const raw = args?.width
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw Object.assign(new Error("set_chat_width 缺少有效的 width"), { code: "CONFIG" })
  }
  // 取整并夹到与设置 schema（general.popup.chatWidth，120–1000）相同的值域：
  // 两处编辑同一字段（设置窗 / 拖动），写出的值不能让另一方立刻读出一个非法值。
  const width = Math.round(Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, raw)))
  await initConfig()
  setOverride("general.popup.chatWidth", width)
  await flushConfig()
}

// ==========================================
// 窗口几何写回（A3：拖动/缩放结束 → CONFIG）
// ==========================================

/**
 * 窗口尺寸/位置写回（宿主在用户拖动/缩放结束的边沿提交）。
 *
 * - `size` → `general.popup.defaultSize`（取整并夹到设置 schema 的值域：两处编辑
 *   同一字段，写出的值不能让另一方立刻读出一个非法值）；
 * - `position` → `general.popup.fixedPosition`（取整；固定位置模式下窗口左上角，
 *   逻辑像素、左上原点 —— 与 `compute_popup_position` 同一坐标系）；
 * - 与当前值相同则跳过（边沿事件不应制造无谓写盘）；
 * - 一次 `flushConfig()`（写队列把同批 `setOverride` 合并成一次磁盘写入），
 *   不新增 localStorage / 持久副本。
 */
async function setPopupGeometry(args: {
  size?: { w: number; h: number } | null
  position?: { x: number; y: number } | null
}): Promise<void> {
  await initConfig()
  let changed = false

  const size = args?.size
  if (size && Number.isFinite(size.w) && Number.isFinite(size.h)) {
    const w = Math.round(Math.min(POPUP_SIZE_MAX, Math.max(POPUP_WIDTH_MIN, size.w)))
    const h = Math.round(Math.min(POPUP_SIZE_MAX, Math.max(POPUP_HEIGHT_MIN, size.h)))
    const current = generalConfig.defaultPopupSize
    if (current.w !== w || current.h !== h) {
      setOverride("general.popup.defaultSize", { w, h })
      changed = true
    }
  }

  const position = args?.position
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    const x = Math.round(position.x)
    const y = Math.round(position.y)
    const current = userConfig.fixedPosition
    if (!current || current.x !== x || current.y !== y) {
      setOverride("general.popup.fixedPosition", { x, y })
      changed = true
    }
  }

  if (changed) {
    await flushConfig()
  }
}

// ==========================================
// 人格卡列表
// ==========================================

async function personalityCards(): Promise<PersonalityCardsPayload> {
  return {
    active: getActivePersonalityId(),
    cards: (await listCardMetas()).map((card) => ({
      id: card.id,
      name: card.name,
      description: card.description,
    })),
  }
}

// ==========================================
// 图层编辑器 I/O
// ==========================================

/** 单层 → 编辑器载荷（profiles 域内相对路径，宿主拼数据根并校验）。 */
function toEditorLayer(profileId: string, layer: { enabled: boolean; image: string; sensitivity: number; scale: number; offsetX: number; offsetY: number; locked: boolean }): EditorLayerPayload {
  const image = layer.image.replaceAll("\\", "/").replace(/^\/+/, "")
  return {
    path: image.length > 0 ? `${profileId}/${image}` : "",
    name: image.length > 0 ? (image.split("/").pop() ?? image) : "",
    enabled: layer.enabled,
    locked: layer.locked,
    sensitivity: layer.sensitivity,
    scale: layer.scale,
    offsetXPercent: layer.offsetX,
    offsetYPercent: layer.offsetY,
  }
}

/**
 * 载入当前激活 Profile 的编辑视图。
 *
 * 读 profile.yaml 走既有 `profile_file_read`（域内相对路径，Rust 持有 base 与
 * 边界校验）；激活 id 来自 `appearanceConfig.activeProfile` 的既有 getter。
 */
async function editorLoad(): Promise<EditorProfilePayload> {
  const profileId = await editorProfileId()
  const raw = await getHostBridge().request("profile_file_read", {
    profileId,
    relativePath: "profile.yaml",
  })
  const profileYaml = loadYaml(new TextDecoder().decode(raw)) as Record<string, any> | null
  if (!profileYaml || typeof profileYaml !== "object") {
    throw Object.assign(new Error(`Profile 文件无法解析: ${profileId}/profile.yaml`), { code: "OTHER" })
  }
  const layers = Array.isArray(profileYaml?.theme?.parallax?.layers)
    ? (profileYaml.theme.parallax.layers as any[])
    : []
  return {
    profileId,
    profileName: typeof profileYaml?.meta?.name === "string" && profileYaml.meta.name.length > 0 ? profileYaml.meta.name : profileId,
    layers: layers.map((layer) => toEditorLayer(profileId, {
      enabled: layer?.enabled ?? false,
      image: typeof layer?.image === "string" ? layer.image : "",
      sensitivity: typeof layer?.sensitivity === "number" ? layer.sensitivity : 0.8,
      scale: typeof layer?.scale === "number" ? layer.scale : 1.0,
      offsetX: typeof layer?.offsetX === "number" ? layer.offsetX : 0,
      offsetY: typeof layer?.offsetY === "number" ? layer.offsetY : 0,
      locked: layer?.locked ?? false,
    })),
    effectEnabled: userConfig.effectMode === "parallax",
    intensity: userConfig.parallaxIntensity,
  }
}

/**
 * 保存编辑器草稿：读-改-写 profile.yaml（既有 Profile 唯一写入路径），强度写回
 * `appearance.parallax.intensity`，然后重推舞台快照（值就是刚写盘的草稿）。
 *
 * `effectEnabled` 只随载荷回报（编辑器只读展示总开关），不写回：`appearance.effectMode`
 * 的编辑入口在设置窗，编辑器不成为第二个裁定点。
 */
async function editorSave(save: EditorSavePayload): Promise<void> {
  const profileId = typeof save?.profileId === "string" ? save.profileId : ""
  if (!profileId) {
    throw Object.assign(new Error("editor_save 缺少 profileId"), { code: "CONFIG" })
  }
  if (!Array.isArray(save.layers)) {
    throw Object.assign(new Error("editor_save 缺少 layers"), { code: "CONFIG" })
  }
  await initConfig()

  // ① 换素材入库：宿主「换素材」选的是 Profile 之外的任意文件，先把它复制进本层素材
  //    目录，`path` 才是可写进 profile.yaml 的域内相对路径（旧壳 persistProfile 同一步）。
  //    入库失败即整次保存失败（草稿留在编辑器里，不写半份 yaml）。
  await importEditorSources(profileId, save.layers)

  // 读-改-写：与旧图层编辑器 persistProfile 同一链路（不整包覆盖 profile.yaml，
  // 保留文件里与本编辑器无关的段）。
  const raw = await getHostBridge().request("profile_file_read", {
    profileId,
    relativePath: "profile.yaml",
  })
  const profileYaml = (loadYaml(new TextDecoder().decode(raw)) ?? {}) as Record<string, any>
  if (typeof profileYaml !== "object") {
    throw Object.assign(new Error(`Profile 文件无法解析: ${profileId}/profile.yaml`), { code: "OTHER" })
  }
  profileYaml.theme = profileYaml.theme ?? {}
  profileYaml.theme.parallax = profileYaml.theme.parallax ?? {}
  profileYaml.theme.parallax.layers = save.layers.map((layer) => ({
    enabled: layer.enabled,
    image: stripProfilePrefix(layer.path, profileId),
    sensitivity: layer.sensitivity,
    scale: layer.scale,
    offsetX: layer.offsetXPercent,
    offsetY: layer.offsetYPercent,
    locked: layer.locked,
  }))
  const text = dumpYaml(profileYaml, { lineWidth: -1, noRefs: true })
  await getHostBridge().request("profile_file_write", {
    profileId,
    relativePath: "profile.yaml",
    content: new TextEncoder().encode(text),
  })

  // 强度是 CONFIG 字段（编辑器可调）：仅在确有变化时写回，避免无谓写盘。
  if (Number.isFinite(save.intensity) && save.intensity !== userConfig.parallaxIntensity) {
    setOverride("appearance.parallax.intensity", save.intensity)
    await flushConfig()
  }

  // 缓存同步（资源通道可用时）：失败不阻断保存 —— 文件已写盘，加载器在下次读取时
  // 自然收敛；这里只做「让内存尽快与磁盘一致」的尽力而为，失败原因留痕。
  try {
    await refreshProfileAssets(profileId)
  } catch (error) {
    log.warn(`编辑器保存后刷新 Profile 缓存失败（文件已写盘）：${formatError(error)}`)
  }

  // 舞台快照直接用刚写盘的草稿值（不依赖 loader 的资源通道）：与 profile.yaml 一致。
  const layers: StageLayerPayload[] = save.layers
    .filter((layer) => layer.path.replaceAll("\\", "/").includes("/materials/"))
    .map((layer) => ({
      path: layer.path.replaceAll("\\", "/").replace(/^\/+/, ""),
      enabled: layer.enabled,
      sensitivity: layer.sensitivity,
      scale: layer.scale,
      offsetXPercent: layer.offsetXPercent,
      offsetYPercent: layer.offsetYPercent,
    }))
  await sendStageProfile(layers, save.intensity)
}

/**
 * `profileId/image` → `image`（profile.yaml 里的 image 是 Profile 内相对路径）。
 *
 * 空路径（该层尚无素材）合法；**非空但不带 `<profileId>/` 前缀即报错** —— 曾经这里
 * 用 `replace(/^\/+/, "")` 静默剥前导斜杠，于是宿主回传绝对路径时它照样"成功"，
 * 把 `Users/…/profiles/<id>/…` 整串写进了 profile.yaml，破坏 Profile 自包含。
 * 这条路只接宿主的线格式路径，前缀失配就是契约破了，不能咽下去。
 */
function stripProfilePrefix(path: string, profileId: string): string {
  const normalized = path.replaceAll("\\", "/").trim()
  if (normalized.length === 0) return ""
  const prefix = `${profileId}/`
  if (!normalized.startsWith(prefix)) {
    throw Object.assign(
      new Error(`素材路径不是 ${profileId} 的域内相对路径: ${normalized}`),
      { code: "PATH_ESCAPE" },
    )
  }
  return normalized.slice(prefix.length)
}

/**
 * 换素材入库：把宿主选中的外部文件复制进 `<profileId>/materials/L{n}/`。
 *
 * 走既有 `file_read_binary`（Rust 侧 `validate_file_path` 仍在）+ `profile_file_write`
 * （Profile 唯一写入路径），本函数不自己碰文件系统。`path` 已是入库后的域内相对
 * 路径，只用来定目标位置；无 `sourcePath` 的层（素材本来就在 Profile 内）完全跳过。
 */
async function importEditorSources(profileId: string, layers: EditorLayerPayload[]): Promise<void> {
  for (const layer of layers) {
    const source = typeof layer.sourcePath === "string" ? layer.sourcePath : ""
    if (!source) continue
    const relativePath = stripProfilePrefix(layer.path, profileId)
    if (!relativePath) {
      throw Object.assign(new Error("换素材缺少目标相对路径（path 为空）"), { code: "CONFIG" })
    }
    const content = await getHostBridge().request("file_read_binary", { path: source })
    await getHostBridge().request("profile_file_write", { profileId, relativePath, content })
    log.debug(`素材已入库: ${source} → ${profileId}/${relativePath}`)
  }
}

/** 当前激活 Profile 的 id；编辑器的一切读写都以它所属的 Profile 为界。 */
async function editorProfileId(): Promise<string> {
  await initConfig()
  const profileId = appearanceConfig.activeProfile
  if (!profileId) {
    throw Object.assign(new Error("没有激活的 Profile（appearance.activeProfile 为空）"), { code: "PATH_NOT_FOUND" })
  }
  return profileId
}

/**
 * 编辑器素材列表：枚举当前激活 Profile 的 `materials/L{n}/` 图片素材（全部层）。
 *
 * 文件枚举走 Rust 既有 `list_profile_files` 命令（数据根与边界校验都在 Rust），
 * 每条附运行时绝对路径与文件名后整表回执 —— 宿主只消费投影，不自己枚举目录、
 * 不自己拼数据根。列表不持久化：编辑器每次打开/保存后重取。
 */
async function editorListAssets(): Promise<{ assets: EditorAssetPayload[] }> {
  const profileId = await editorProfileId()
  // 不传 subdir：Rust 侧的前缀过滤按 `/` 比较，而 Windows 的路径串是 `\`，
  // 过滤会整片落空；统一在 Node 归一分隔符后筛（本函数是唯一消费者）。
  const files = await getHostBridge().request("list_profile_files", { profileId })
  const assets: EditorAssetPayload[] = []
  for (const file of files) {
    const relative = normalizeSeparators(file)
    const match = /^materials\/(L\d+)\/(.+)$/.exec(relative)
    if (!match) continue // materials 下的非层目录（如 dof/）不属于视差五层素材
    const segments = relative.split("/")
    assets.push({
      path: `${profileId}/${relative}`,
      absolutePath: await runtimePath("profiles", profileId, ...segments),
      layer: Number(match[1].slice(1)),
      name: segments[segments.length - 1],
    })
  }
  return { assets }
}

/**
 * 跨层复制：把另一层的素材复制进目标层目录（旧壳 selectAsset 跨层分支的同一语义）。
 *
 * 读取/写入都走 Profile 的既有文件命令（`profile_file_read` / `profile_file_write`），
 * 本函数不碰文件系统；目标文件名用「层_时间戳」避免覆盖同层已有素材。返回复制件的
 * 新线格式路径与绝对路径（宿主据此直接引用，无需等保存）。
 */
async function editorCopyAsset(args: { layer?: number; source?: string }): Promise<EditorAssetPayload> {
  const profileId = await editorProfileId()
  const layer = typeof args?.layer === "number" && Number.isInteger(args.layer) && args.layer >= 0 ? args.layer : -1
  if (layer < 0) {
    throw Object.assign(new Error("editor_copy_asset 缺少合法的 layer"), { code: "CONFIG" })
  }
  const source = typeof args?.source === "string" ? args.source : ""
  const relativeSource = stripProfilePrefix(source, profileId)
  if (!relativeSource) {
    throw Object.assign(new Error("editor_copy_asset 缺少 source"), { code: "CONFIG" })
  }
  const extMatch = /\.([A-Za-z0-9]+)$/.exec(relativeSource)
  const ext = extMatch ? extMatch[1].toLowerCase() : "png"
  const target = `materials/L${layer}/layer_${layer}_${Date.now()}.${ext}`
  const content = await getHostBridge().request("profile_file_read", { profileId, relativePath: relativeSource })
  await getHostBridge().request("profile_file_write", { profileId, relativePath: target, content })
  // 缓存同步（资源通道可用时）：失败不阻断复制 —— 文件已写盘，加载器下次读取收敛。
  try {
    await refreshProfileAssets(profileId)
  } catch (error) {
    log.warn(`跨层复制后刷新 Profile 缓存失败（文件已写盘）：${formatError(error)}`)
  }
  const segments = target.split("/")
  return {
    path: `${profileId}/${target}`,
    absolutePath: await runtimePath("profiles", profileId, ...segments),
    layer,
    name: segments[segments.length - 1],
  }
}
