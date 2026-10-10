// ==========================================
// HostBridge 命令/事件类型矩阵 —— W0 冻结件
// ==========================================
//
// 本文件是 Node Harness ↔ Native 宿主之间**唯一**的命令与事件形状定义点
// （执行契约 §4.1/§4.2，docs/history/implementation/原生宿主轻量化执行契约-2026-10-04基线.md）。
// 这里只有类型，没有实现；传输（socket/pipe、帧编解码、背压、blob 编解码）在 W2 落地。
//
// 权威来源：
// - 命令清单与参数名：Rust `crates/native-host/src/host/dispatch.rs` 的 `NativeDispatcher`
//   分派表（141 条，逐条对应本文件的 `HostCommandMap`），实现落在 `crates/native-host/src/`
//   各域。参数是 camelCase 线格式（Rust `max_bytes` → `maxBytes`）。TS 调用点
//   （138 处 / 35 文件）只用于核对「谁在用、返回类型被当成什么」，不作为签名依据。
// - `RunScope` / `HostBlobRef`：`crates/native-host/src/ipc/protocol.rs` 逐字段对齐。
// - 失败错误码：`AppError::code()`（crates/native-host/src/error.rs，见下方 HostError）。
//
// 两条应用层规则（契约 §4.2，transport 改造不许缩水）：
// 1. `result` 是**应用层**类型，不是线格式：字节内容是 `Uint8Array`（不退回 `number[]`），
//    大字段不截断 —— 64 KiB 控制帧上限由 HostBridge 实现内部编码成 blob 规避，
//    业务消费者拿到的仍是完整原值。
// 2. `AppResult<T>` 的失败**不进 `result`**：失败以 `Promise` reject 的结构化 `HostError`
//    表达；`result` 只写成功值。Rust `Option<T>` 写 `T | null`，`()` 写 `void`。
//    参数侧的 Rust `Option<T>` 统一写 `?: T | null`（缺省与显式 null 都等价于 None）。
//
// 与 Rust 分派表的对账（W0 报告）：109 条全部登记，无缺、无多；其中 5 条 `e2e_*`
// 是测试宿主专用（仅 debug + is_e2e 隔离宿主开放，见执行契约 §8 W11），照常登记以保持
// 一一对账，迁移测试设施时再随所在宿主一起搬。
// W5 有意扩展一条新能力：`configure_global_shortcut`（原生宿主直接注册全局快捷键，
// 见下方窗口增强分组之后）。W7 再有意扩展 `configure_chat_image_preview`（聊天图片
// 自动预览开关下发，见同一分组）。W10b 再有意扩展 `update_check` /
// `update_download_and_install`（Native UpdatePort，见应用内更新分组）。W9b 再有意
// 扩展 5 条：`apply_font_snapshot` / `apply_stage_profile` / `set_chat_panel`
// （Node → 宿主的状态推送）+ `host_request_result`（宿主 → Node 请求面的回执）+
// `pick_profile_asset`（原生素材选择器，宿主实现未接线、如实报错）。A2 再有意扩展
// 2 条：`apply_chat_projection`（会话侧读模型投影帧）+ `apply_titlebar_status`
// （顶栏状态位最终文本），见「会话标签 / 历史面板 / 顶栏状态位」分组。A3 再有意扩展
// 2 条：`set_popup_placement` + `set_popup_size`（弹窗摆位/尺寸的 Node → 宿主运行时
// 应用，见「弹窗摆位与尺寸」分组）。**主题批次再有意扩展 1 条**：`apply_theme`
// （`appearance.theme` 的 Node → 宿主下发，见「原生 UI 状态推送」分组）。设置页 Card
// 管理批次再有意扩展 1 条：`personality_file_delete`（人格文件域删除，只删普通文件、
// 拒绝链接叶子，见「人格文件」分组）。
// 都不是旧命令的重名兼容，登记后矩阵为 141 条。
// 对账以「W0 冻结件的现存 107 条逐条对应 + 34 条有意扩展」为准：冻结件已删
// `profile_clone`（「新建 Profile」改造）与 `mcp_send`（MCP 桥裸行收发改
// `mcp_write` / `mcp_read` 两条，本批有意扩展 +2；两者均非旧命令的重名兼容）。
//
// W9b 另定义**宿主 → Node 请求面** `HostRequestMap`（见命令矩阵之后的独立小节）：
// 原生 UI 发起、Node 应答的读取/提交（设置读写、分隔条宽度写回、人格卡列表、编辑器
// I/O）。传输为「宿主经 `publish_event` 投 `HOST_REQUEST_EVENT` + Node 经
// `host_request_result` 回执」两条既有通道，不动 ipc/** 的冻结协议；方法名/参数/
// 结果是跨 transport 不变的形状，W4 的「Node 侧命令面」落地后可整体换到
// `HostBridge::call` 而不改任何方法体。**A2 增补**：同一张表登记五条 `chat_*`
// 会话意图方法（会话标签与历史面板；A1 的 `ChatIntent` 增补），传输与归宿不变。
// **本包增补**：核心聊天链路四条（`chat_send` / `chat_slash_command` / `chat_stop` /
// `chat_switch_session`；其中前三条的宿主侧提交非阻塞，见对应条目注释）。
//
// 命名与线格式纪律：命令名与参数线格式不得改动（改名/改参 = 契约变更，必须同步本文件
// 与全部消费者）。正文对 Rust 源码的引用（文件/行号）用于定位实现，签名与错误码以
// `crates/native-host/` 为准。

import type {
  MemoryCandidateDraft,
  MemoryChangeRequest,
  MemoryDreamingBudget,
  MemoryHistoryEntry,
  MemoryItem,
  MemoryJob,
  MemoryJobListItem,
  MemoryOrigin,
  MemoryRecallCandidateSnapshot,
  MemoryRestorePreview,
  MemoryScope,
  MemorySource,
  MemoryStatusSnapshot,
} from "@/services/agent/memory"
import type {
  ConversationIndexBatch,
  ConversationIndexEntry,
  ConversationIndexStatus,
  ConversationSearchResult,
  MemoryRecallTarget,
  ProactiveAttemptStatus,
  ProactiveAuxiliaryBudgetReserveRequest,
  ProactiveAuxiliaryBudgetReserveResponse,
  ProactiveAuxiliaryBudgetSettleRequest,
  ProactiveAuxiliaryBudgetSettleResponse,
  ProactiveChangeRequest,
  ProactiveChangeResponse,
  ProactiveClaimRequest,
  ProactiveClaimResponse,
  ProactiveControl,
  ProactiveControlRequest,
  ProactiveQueryRequest,
  ProactiveQueryResponse,
  ProactiveReconcileRequest,
  ProactiveScanRequest,
  ProactiveScanResponse,
  ProactiveSettleRequest,
  ProactiveValidateRequest,
  ProactiveValidateResponse,
} from "@/services/agent/memory/protocol"
import type { ThinkingEffort } from "@/services/agent/types"
import type { PlanStep } from "@/services/engine"
// A2：会话侧投影帧的线上形状（唯一定义点在 native-ui；Rust 侧为
// `TranscriptProjection` 的会话侧子集，字段名逐字对齐）。
import type { SessionProjectionPayload } from "@/services/native-ui/session-projection"
import type { ReadTargetRequest, ScreenCaptureResult, TargetReadResult } from "@/services/observation"
import type { RuntimePathScope, RuntimePathsPayload } from "@/services/paths"
import type { SimpleStageKey } from "@/services/personality"
import type { RestoreResult } from "@/services/profile"
import type { SkillCatalogFingerprint } from "@/services/skill"
import type { BashBackgroundFinishedPayload, PermitReclaim, PermitSnapshot } from "@/services/tool"
import type { CaptureScreenshotResult, SavedScreenshotResult } from "@/services/tool/local/screenshot"
import type { BashPayload, FileInfoPayload } from "@/services/tool/pi/native-execution-env"
import type { RuntimeActivity, WindowObservation } from "@/services/window"
// 事件名（线格式字节）的唯一取用点：矩阵键从这些常量计算，不再写第二份字面量。
import {
  HOST_EVENT_ASSISTANT_STREAM,
  HOST_EVENT_ASSISTANT_STREAM_END,
  HOST_EVENT_BASH_BACKGROUND_FINISHED,
  HOST_EVENT_CHOICE_END,
  HOST_EVENT_CHOICE_START,
  HOST_EVENT_CURSOR_MOVE,
  HOST_EVENT_PERMISSION_CONFIRM,
  HOST_EVENT_PLAN_END,
  HOST_EVENT_PLAN_PROGRESS,
  HOST_EVENT_PLAN_START,
  HOST_EVENT_PLAN_STEP_GATE,
  HOST_EVENT_REVEAL_PROGRESS,
  HOST_EVENT_RUN_STATE,
  HOST_EVENT_SEND_OUTCOME,
  HOST_EVENT_STAGE_HINT,
  HOST_EVENT_TOOL_COMPLETED,
  HOST_EVENT_TOOL_EXECUTING,
  HOST_EVENT_WINDOW_OBSERVED,
} from "./event-names"

// ==========================================
// 信封基础类型（与 crates/native-host/src/ipc/protocol.rs 逐字段对齐）
// ==========================================

/**
 * 一次运行的归属范围。事件与结果都带 scope；旧 Node、旧会话/代际、旧 Profile/预览
 * owner 的结果不得写进新状态（执行契约 §4.1）。
 *
 * 字段与 Rust `RunScope` 逐项一致：`appEpoch`（宿主进程身份，重启即换）、`nodeEpoch`
 * （Node 代际，崩溃重启 +1）、其余为可选归属。Rust 侧空可选字段在线格式上省略
 * （skip_serializing_if），反序列化时缺省即 None —— 因此这里写成可选而非 `| null`。
 */
/**
 * `update_check` 的候选版本描述（W10b 有意扩展）。
 *
 * 只承载**展示与决策需要的最小信息**；完整 envelope（组件 URL/哈希/尺寸、version-set）
 * **不过桥** —— 下载与安装的校验全在宿主侧完成，Node 不参与验签、不接触制品字节。
 */
export interface HostUpdateCheckResult {
  /** 候选版本号（semver 字符串）。 */
  version: string
  /** 该版本的发布说明（可空）。 */
  notes?: string | null
  /** 发布时间（ISO 8601，可空）。 */
  publishedAt?: string | null
}

export type RunScope = {
  appEpoch: string
  nodeEpoch: number
  sessionId?: string
  runGeneration?: number
  runId?: string
  turnId?: string
  toolCallId?: string
}

/**
 * 大内容的短期句柄。宿主注册表校验 owner、长度与生命周期；
 * **任意路径不等于 blob 授权**，句柄只由宿主在完成路径校验后签发。
 *
 * `bytes` 是 Rust `u64`；`scope` 失效即归还句柄（releaseBlob）。
 */
export type HostBlobRef = {
  id: string
  bytes: number
  mimeType?: string
  scope: RunScope
}

/**
 * 结构化错误。**不能退化成字符串**：以下错误码是被业务分支消费的函数级契约
 * （TS 侧经 `errorCode()` 判定），丢码等于改语义，必须保真：
 *
 *   函数级必需码（多个模块按它分支）：
 *   - `PATH_NOT_FOUND`：路径不存在（读路径 canonicalize 失败等）
 *   - `PATH_ESCAPE`：越出允许根 / 域内相对路径含绝对或 `..` 段
 *   - `SENSITIVE_PATH`：凭据路径（`.ssh` 组件 / `.pem` / `.key`）最终判定
 *   - `NOT_ABSOLUTE`：工具路径必须是绝对路径
 *   - `MEMORY_CONFLICT`：记忆版本冲突（stale 基准）
 *   - `MEMORY_PROTECTED_PATH`：记忆路径受保护
 *   - `CANCELLED`：调用方取消（与 TIMEOUT 分开：取消是意图，不是失败原因不明）
 *   - `TIMEOUT`：命令执行超时
 *
 *   `AppError::code()` 完整清单（实现：crates/native-host/src/error.rs，一条不漏）：
 *   `PATH_ESCAPE`、`PATH_NOT_FOUND`、`NOT_ABSOLUTE`、`SENSITIVE_PATH`、`CANCELLED`、
 *   `TIMEOUT`、`NO_HOME_DIR`、`IO`、`CONFIG`、`TOOL`、`MEMORY`、`MEMORY_PROTECTED_PATH`、
 *   `MEMORY_CONFLICT`、`OTHER`。
 *
 * `message` 是已经脱敏的说明文本，消费者不得靠匹配 message 分支。
 */
export type HostError = {
  code: string
  message: string
}

// ==========================================
// 原生 UI 状态推送与宿主请求面的载荷（W9b 有意扩展）
// ==========================================
//
// 这些形状同时被 (a) `HostCommandMap` 的新命令（Node → 宿主）与 (b) `HostRequestMap`
// （宿主 → Node）引用。**不在这里复制 CONFIG 默认值**：所有值由 Node 经现有类型化
// getter 读取后推送/应答，Rust 侧只持不可变快照与临时草稿（执行契约 §3、§6.4）。

/** 设置值。形状与原生控件一一对应；枚举以字符串承载（值必须命中设置 schema 的选项）。 */
export type SettingValue = boolean | number | string

/** `settings_read` 的整表快照：键 = **CONFIG 路径**（点分），不建第二张映射表。 */
export interface SettingsSnapshotPayload {
  values: Record<string, SettingValue>
}

/** `settings_commit` 的一次改动（键 = CONFIG 路径）。 */
export interface SettingChangePayload {
  key: string
  value: SettingValue
}

/**
 * 舞台层（`apply_stage_profile` 的载荷）。
 *
 * `path` 是 **profiles 域内相对路径**（`<profileId>/materials/L2/body.png`）：
 * 宿主用 `AppPaths.profiles` 拼绝对路径并走既有 `validate_file_path` 校验，
 * Node 不拼文件系统绝对路径（AGENTS「Rust 持有 base」）。
 */
export interface StageLayerPayload {
  path: string
  enabled: boolean
  sensitivity: number
  scale: number
  offsetXPercent: number
  offsetYPercent: number
}

/** `personality_cards` 的应答：可用人格卡与当前激活项（值来自人格注册表，不是 CONFIG 副本）。 */
export interface PersonalityCardsPayload {
  active: string | null
  cards: Array<{ id: string; name: string; description: string }>
}

/** 编辑器图层（`editor_load` / `editor_save` 共用；`path` 同 StageLayerPayload 的域内相对路径约定）。 */
export interface EditorLayerPayload {
  /**
   * **profiles 域内相对路径**（`<profileId>/materials/L{n}/x.png`），与 `editor_load`
   * 的出参形状对称；空串 = 该层尚无素材。写回 `profile.yaml` 时由 `stripProfilePrefix`
   * 去掉 `<profileId>/` 前缀 —— 所以这里**绝不能是绝对路径**。
   */
  path: string
  /**
   * 换素材选中的**外部**文件绝对路径（仅 `editor_save` 方向有值）：宿主保存时先把它
   * 复制进 `<profileId>/materials/L{n}/`（入库）再写 yaml。素材已在 Profile 内时为
   * `null`/缺省 —— 此时直接按 `path` 写，不复制。
   */
  sourcePath?: string | null
  name: string
  enabled: boolean
  locked: boolean
  sensitivity: number
  scale: number
  offsetXPercent: number
  offsetYPercent: number
}

/** `editor_load` 的应答（当前激活 Profile 的编辑视图）。 */
export interface EditorProfilePayload {
  profileId: string
  profileName: string
  layers: EditorLayerPayload[]
  effectEnabled: boolean
  intensity: number
}

/** `editor_save` 的载荷（保存走既有 Profile 唯一写入路径与原子写盘）。 */
export interface EditorSavePayload {
  profileId: string
  layers: EditorLayerPayload[]
  intensity: number
  effectEnabled: boolean
}

/**
 * 编辑器素材项（`editor_list_assets` / `editor_copy_asset` 的应答项）。
 *
 * 与 `EditorLayerPayload` 同一套路径分野：`path` 是**线格式**
 * `<profileId>/materials/L{n}/x.png`（保存/复制请求只认它），`absolutePath` 是
 * 经 `runtimePath()` 拼出的渲染路径（宿主直接用于预览解码，**不写回任何持久层**）。
 */
export interface EditorAssetPayload {
  path: string
  absolutePath: string
  /** 素材所在层（0 起）；与编辑层不同 = 选择后由宿主走复制。 */
  layer: number
  /** 文件名（宿主列表显示）。 */
  name: string
}

/**
 * 设置页管理面（W9d）的列表行 —— **展示投影**：`title`/`subtitle` 由 Node 组装
 * （与聊天投影同款「Node 组装读模型、界面只渲染」），`id` 是写操作的坐标
 * （MCP=服务器名 / Skill=skills 域内相对路径 / 记忆=条目 id）。
 */
export interface ManagementRowPayload {
  id: string
  title: string
  subtitle: string
  /**
   * 行动作：toggle=逐项开关；select=点开详情（记忆条目/来源行）；
   * preview=试听（音效行）；pick=行内下拉；credential=凭据输入（弹原生输入框写自有存储）；
   * cancel=终止记忆整理作业；resume=继续受限的整理作业；choose=选中（备份列表行）；
   * none=只读行。
   */
  action: "toggle" | "select" | "preview" | "pick" | "credential" | "cancel" | "resume" | "choose" | "none"
  /** 次动作（可选渲染第二个按钮）：edit=打开行编辑文档；delete=删除该行资源；preview=试听（下拉行的次动作）。 */
  action2?: "edit" | "delete" | "preview"
  /** 开关类行的当前状态（其它行为 false）。 */
  enabled: boolean
  /** 行内下拉（`action = "pick"` 时必填）：选项 + 当前选中值（宿主侧成对校验）。 */
  pick?: { options: { value: string; label: string }[]; selected: string }
}

/** `tools_mcp_servers` / `tools_tool_policies` 的应答。 */
export interface ManagementRowsPayload {
  rows: ManagementRowPayload[]
}

/** 外观页的一个 Profile 选项（`profile_list` 的应答项；值来自 Profile 域的轻量元数据读）。 */
export interface ProfileOptionPayload {
  id: string
  name: string
  description: string
}

/**
 * `profile_list` 的应答：可用 Profile 与当前激活项。
 *
 * 选项来自 `discoverAllProfiles` + `readProfileMeta`（只读 meta，不进内存缓存）；
 * 切换由 Node 走 `switchActiveProfile` 唯一入口（激活、落盘、通知其它窗口一体收口）。
 */
export interface ProfileListPayload {
  active: string | null
  profiles: ProfileOptionPayload[]
}

/** `tools_skills` 的应答：清单 + 目录索引告警（成功读取的诊断，不是读取失败）。 */
export interface SkillsPayload {
  rows: ManagementRowPayload[]
  indexError: string | null
}

/** `tools_mcp_toggle` / `tools_skill_toggle` 的载荷（id 为行坐标）。 */
export interface ManagementTogglePayload {
  id: string
  enabled: boolean
}

/** `memory_overview` 的应答（状态行 + 条目 + 整理作业）。 */
export interface MemoryOverviewPayload {
  /** 库当前 revision（展示用；变更基准以详情读取的 revision 为准）。 */
  revision: number
  statusText: string
  items: ManagementRowPayload[]
  jobs: ManagementRowPayload[]
}

/** `memory_item_detail` 的应答（详情 + 历史版本）。 */
export interface MemoryItemDetailPayload {
  /** 读取时的库 revision（变更请求的 baseRevision；stale 由 Rust 抛 MEMORY_CONFLICT）。 */
  revision: number
  itemId: string
  version: number
  pinned: boolean
  /** 只读概要（多行文本：类型/范围/状态/来源/重要性与时间）。 */
  info: string
  content: string
  /**
   * 当前版本的来源行（一行一条来源，`id` = sourceId，动作 select）：
   * 宿主逐条渲染；点某行才展开该条的完整证据/原话（不再一次拼接多条）。
   */
  sources: ManagementRowPayload[]
  history: ManagementRowPayload[]
}

/**
 * `memory_item_change` 的载荷：纠正 / 核心画像标记 / 遗忘。
 *
 * **actor 不由调用方提供**：Node 侧固定 `user_ui`；信任门槛保持 Rust
 * `memory_apply_change` 的既有裁决，界面不放宽。
 */
export interface MemoryItemChangePayload {
  action: "update" | "forget"
  itemId: string
  expectedVersion: number
  baseRevision: number
  /** update 时的新正文（不传 = 不改正文，如仅切换核心画像标记）。 */
  content?: string | null
  /** update 时核心画像目标状态（不传 = 不改）。 */
  pinned?: boolean | null
}

export interface MemoryItemChangeResult {
  revision: number
}

// ── 设置页管理面（本批扩展）：通用 / AI / 外观 / 工具 / 记忆 ──

/** `config_export` 的应答：`saved=false` = 用户取消保存（不是失败）。 */
export interface ConfigTransferResult {
  saved: boolean
  path: string | null
}

/**
 * `card_stages_read` / `card_stages_write` 的应答。
 *
 * `text` 是阶段文案的**行编辑格式**（格式定义只在 Node 的 personality 域；
 * Rust 只显示与回传，不解析）。
 */
export interface CardStagesPayload {
  cardId: string
  /** true = 尚未生成过角色化阶段文案（当前展示的是兜底值）。 */
  fallback: boolean
  text: string
}

/** `card_variable_pool` 的应答：只读预览文本（行格式定义在 Node）。 */
export interface CardVariablePoolPayload {
  cardId: string | null
  text: string
}

/**
 * `sound_library` 的应答：逐事件音效分配行。
 *
 * 每行 `id` = 事件键（写回时原样回传），`action = "pick"` + `pick` 载荷承载
 * 「可选音效 + 当前分配」（none = 静音）；`action2 = "preview"` 是试听次动作
 * （宿主按钮点击转 `sound_preview`，播当前分配）；静音行不带试听次动作。
 */
export interface SoundLibraryPayload {
  rows: ManagementRowPayload[]
}

/**
 * `mcp_server_form` 的应答：MCP 表单的逐字段值（原生控件直接用）。
 *
 * `name` 空串 = 新建模板；`args` 每行一个参数；`env` / `headers` 是多行 KEY=VALUE
 * 文本（行格式的解析仍在 Node 的 MCP 域；Rust 只显示与回传）。字段语义与校验在 Node。
 */
export interface McpServerFormPayload {
  /** 目标服务器名（新建时为空串）。 */
  name: string
  transport: "stdio" | "http"
  command: string
  /** 每行一个参数（多行文本控件）。 */
  args: string
  url: string
  /** KEY=VALUE 每行一条（多行文本控件）。 */
  env: string
  headers: string
  enabled: boolean
}

/**
 * `mcp_save` 的载荷：表单字段值 + 原条目坐标。
 *
 * `originalName` 空 = 新增（目标名已被占用时 Node 明确报错，不静默覆盖）；
 * 非空 = 更新原条目（允许改名；改名撞名同样报错）。
 */
export interface McpServerFormSavePayload {
  originalName: string
  name: string
  transport: string
  command: string
  args: string
  url: string
  env: string
  headers: string
  enabled: boolean
}

/**
 * `memory_source_evidence` 的应答：一条来源的原话回看。
 *
 * `evidence` 是登记时的有界证据（≤2000 字符）；`original` 是从会话正文解析出的
 * 完整原话（读取失败或条目已回收时为 null，界面如实标注「已不可用」）。
 */
export interface MemorySourceEvidencePayload {
  sourceId: string
  available: boolean
  info: string
  evidence: string
  original: string | null
}

/** `memory_maintenance` / `memory_restore` 的应答（中性过程说明 + 结果坐标）。 */
export interface MemoryMaintenanceResult {
  message: string
  path: string | null
  revision: number | null
}

/** `profile_manage` 的载荷（新建 / 重命名 / 删除 / 导出 / 导入 / 恢复默认资源）。 */
export type ProfileManagePayload =
  | { op: "create" }
  | { op: "rename"; profileId: string; name: string }
  | { op: "delete"; profileId: string }
  | { op: "export"; profileId: string }
  | { op: "import" }
  | { op: "restore_defaults" }

/** `profile_manage` 的应答：中性结果说明 + 操作后的可用 Profile 列表。 */
export interface ProfileManageResult {
  message: string
  list: ProfileListPayload
}

/** `card_manage` 的载荷（新建 / 重命名 / 删除 / 导出 / 导入）。 */
export type CardManagePayload =
  | { op: "create"; name: string }
  | { op: "rename"; cardId: string; name: string }
  | { op: "delete"; cardId: string }
  | { op: "export"; cardId: string }
  | { op: "import" }

/** `card_manage` 的应答：中性结果说明 + 操作后的可用 Card 列表。 */
export interface CardManageResult {
  message: string
  list: { cards: Array<{ id: string; name: string }> }
}

/** 宿主 → Node 请求的线信封（宿主经 `HOST_REQUEST_EVENT` 事件投递；`requestId` 配对回执）。 */
export interface HostRequestEnvelope {
  requestId: number
  method: keyof HostRequestMap
  args: unknown
}

/** `host_request_result` 的载荷：Node 对一条宿主请求的回执。 */
export interface HostRequestResultPayload {
  requestId: number
  ok: boolean
  /** 成功结果（形状由 `HostRequestMap[method].result` 决定）。 */
  result?: unknown
  /** 失败（ok=false 时必有；码表与 `HostError` 一致）。 */
  error?: HostError
}

// ==========================================
// 命令矩阵
// ==========================================
//
// 按领域分组登记（不承诺与 Rust 分派表的注册顺序逐一相同；W0 对账为 109/109，
// 无缺无多）。每条的 args 是 camelCase 线格式的应用层投影；result 是成功值
// （失败 reject HostError，见文件头）。
//
// 消费方标注（迁移时决定命令归 Node 还是原生 UI 直接调用；签名不变）：
// - 「Node 工具/业务」：工具执行、会话/记忆/主动、文件/进程类命令。
// - 「原生 UI」：窗口/光标/显示器/devtools 等桌面域；W5 决定 UI 是否直连宿主而不经 Node
//   转发（60fps 的光标事件尤其不能绕 Node）。

export type HostCommandMap = {
  /** Native 音频输出：TS声音定义生成的完整RIFF PCM，不在Native复制预设。 */
  audio_play_wav: { args: { data: string }; result: void }
  ui_set_sound_cues: {
    args: { clips: { welcome: string | null; popup: string | null; retract: string | null } }
    result: void
  }
  // ── 应用生命周期（host/dispatch.rs 分派 + main.rs 退出序列）──
  /** 原生 UI：重启应用（经 LifecyclePort 的统一退出/重启序列）。 */
  app_restart: { args: Record<string, never>; result: void }

  // ── 光标与弹窗定位（crates/native-host/src/commands/cursor.rs）──
  /** 原生 UI：主窗口 transform-origin 用的光标位置。字段沿用 Rust 序列化形状（snake_case）。 */
  get_cursor_position: {
    args: Record<string, never>
    result: {
      x: number
      y: number
      screen_x: number
      screen_y: number
      screen_w: number
      screen_h: number
    }
  }
  /** 原生 UI：快捷键弹窗位置计算（字段为 Rust 序列化形状 snake_case）。 */
  compute_popup_position: {
    args: { winW: number; winH: number }
    result: {
      win_x: number
      win_y: number
      cursor_x: number
      cursor_y: number
      scale_x: number
      scale_y: number
    }
  }

  // ── 系统观察与显示器（crates/native-host/src/commands/monitor_ctl.rs、monitor/mod.rs）──
  /** Node + 原生 UI：系统观察总闸（Node 侧 wrapper：src/services/window/monitor.ts）。 */
  set_monitor_enabled: { args: { enabled: boolean }; result: void }
  /** Node + 原生 UI：一次性活动快照。类型复用 @/services/window 的 RuntimeActivity。 */
  get_runtime_activity: { args: Record<string, never>; result: RuntimeActivity }

  // ── 字体（crates/native-host/src/commands/font_cmd.rs）──
  /** 原生 UI：系统已安装字体名枚举（appearance.font 的取值域）。 */
  list_system_fonts: { args: Record<string, never>; result: string[] }

  // ── 日志与诊断（crates/native-host/src/commands/logging.rs）──
  /** Node：批量日志行落盘（前端已按生效级别过滤，Rust 原样写）。 */
  log_messages: { args: { msgs: string[] }; result: void }
  /** Node：运行时日志级别（0=DEBUG..3=ERROR，Rust 侧为 u8）。 */
  set_log_config: { args: { level: number }; result: void }
  /** Node：前端异常统一出口（reportError → 这里）。 */
  report_frontend_error: { args: { source: string; message: string; stack: string }; result: void }
  /** 原生 UI：开发者工具入口（W5/W10 随 WebView 移除重新裁定归宿）。 */
  open_devtools: { args: Record<string, never>; result: void }

  // ── 窗口增强（crates/native-host/src/window/settings.rs）──
  // 窗口域命令，消费方是原生 UI 窗口管理（TS 侧当前无调用点）；三条去留
  // （留在 HostCommandMap 还是变成原生 UI 内部调用）待裁定。
  enhance_settings_window: { args: Record<string, never>; result: void }
  enhance_layer_editor_window: { args: Record<string, never>; result: void }
  set_picker_window_level: { args: { picking: boolean }; result: void }

  // ── 全局快捷键（W5 有意扩展 W0 冻结矩阵；新能力，不是重名兼容命令）──
  /**
   * Node → 宿主：配置全局快捷键。`modifiers` 已由 Node 按平台解析好
   * （macOS 取 `general.shortcut.macModifiers`，Windows 取 `winModifiers`；
   * 取值为 Control / Command / Alt / Shift 的名称，键码与修饰位由宿主按自身平台编译）。
   *
   * - Node 在启动与设置保存时推送；**宿主收到前不注册任何快捷键**；
   * - 重复推送 = 修改快捷键（宿主先注销旧注册再注册新的，旧语义 unregister→register）；
   * - 缺修饰键 / 未知键/修饰键在宿主侧解析失败，以结构化 `CONFIG` 错误 reject，
   *   不静默忽略（注册失败显式可见）；
   * - 宿主侧实现在 `crates/native-host/src/{ui/shortcut.rs,ui/platform/*}`，
   *   命令入口 `main.rs` 的 `BootstrapDispatcher`；Rust 不复制 CONFIG 默认值。
   */
  configure_global_shortcut: {
    args: { key: string; modifiers: string[] }
    result: void
  }

  // ── 聊天图片自动预览（W7 有意扩展 W0 冻结矩阵；新能力，不是重名兼容命令）──
  /**
   * Node → 宿主：下发 `appearance.chatImagePreview`（聊天图片自动预览，默认 false）。
   *
   * - Node 在启动与设置保存时推送（值只经 `appearanceConfig.chatImagePreview` 读取，
   *   Node 不复制默认值）；**宿主收到前按关闭处理**，不读取任何图片字节。
   * - `enabled:false`：历史/滚动/切会话/初次加载只显示占位（序号/文件名/可用状态），
   *   不读字节/不解码/不生成缩略图；宿主立即取消在途内联加载、释放已解码内联帧，
   *   晚到结果按 owner/viewGeneration 丢弃。点击占位仍可打开独立查看器。
   * - `enabled:true`：只为当前可见消息按需加载内联预览（可见性/滚动判断在 UI 侧）；
   *   离开视口、切会话、收起或关闭聊天视图即释放。
   * - 只控制聊天历史的内联呈现：不影响模型看图（`hydrateImageMessages` /
   *   `loadRequestImage` 的请求投影）、图片选择/发送、截图、`read` 图片工具与
   *   JSONL 里的原路径；独立查看器有自己的 owner/关闭动作，不依赖本开关。
   * - 宿主侧落点：`crates/native-host/src/images/inline.rs` 的
   *   `InlinePreviewManager::set_enabled`（Rust 不复制 CONFIG 默认值）。
   */
  configure_chat_image_preview: {
    args: { enabled: boolean }
    result: void
  }

  // ── 应用内更新（W10b 有意扩展 W0 冻结矩阵；新能力，不是重名兼容命令）──
  /**
   * Node → 宿主：检查是否有可安装的新版本。
   *
   * - 返回 `null` = 已是最新或没有**验签通过且版本更高**的候选；**不降级、不重装同版本**。
   * - 宿主侧的完整校验链：feed 大小硬闸 → `schemaVersion` → 应用标识 → **逐条验签
   *   （任一条坏签名整份拒绝，fail closed）** → 平台/架构 → 完整组件集 → 版本更高。
   * - 失败经 `AppError::Remote{code,message}` 透出**稳定错误码**
   *   （`UPDATE_SCHEMA`/`BAD_SIGNATURE`/`PLATFORM`/`ARCH`/`LOW_VERSION`/`COMPONENTS`/
   *   `VERSION_SET`/`NETWORK`/…），前端按 code 分支，**不降级为字符串**。
   * - 宿主侧落点：`crates/native-host/src/update/`。
   */
  update_check: {
    args: Record<string, never>
    result: HostUpdateCheckResult | null
  }
  /**
   * Node → 宿主：下载并预备安装已确认的更新（**不含重启**）。
   *
   * - 下载期边下边判尺寸上限、完成后核对 `size` 与 `sha256`，不符即删 `.part` 并拒绝，
   *   **不落半个版本**。
   * - 落盘为 staging + 相位状态（`install-state.json`）；**关闭整套进程后由独立 helper
   *   替换并重启**（`deskpet-update-helper`，经 stdin EOF 与宿主退出握手）。
   * - **不混装**：替换前重走「验签 → 逐文件重算哈希 → 包内 `version-set.json` 与签名声明
   *   逐项对照 → 必需条目存在」，不一致即拒绝且不碰安装目录；替换是**整目录改名换位**，
   *   失败回滚到上一完整版本。
   * - 调用方随后应触发 `app_restart`（真正退出→helper 替换→重启）。
   */
  update_download_and_install: {
    args: Record<string, never>
    result: { version: string }
  }

  // ── 原生 UI 状态推送与宿主请求回执（W9b 有意扩展 W0 冻结矩阵；新能力，不是重名兼容）──
  /**
   * Node → 宿主：全局字体快照（`appearance.font` 的 Native 投影）。
   *
   * - 值只经 `appearanceConfig.fontFamily` / `appearanceConfig.fontSize` 读取，
   *   **Node 不复制默认值**；`family: null` = 未配置 → 宿主各窗口用系统 fallback，
   *   `size: null` = 未配置 → 控件基线字号。
   * - Node 在**启动握手后**与**设置保存后**各推一次（`settings_commit` 成功路径）；
   *   **宿主收到前不应用任何字体**（控件用自身基线）。
   * - 宿主侧落点：`crates/native-host/src/ui/font.rs`（快照）+ 各平台控件应用。
   */
  apply_font_snapshot: {
    args: { family: string | null; size: number | null }
    result: void
  }
  /**
   * Node → 宿主：界面主题（`appearance.theme` 的 Native 投影）。
   *
   * - 取值是五套产品级预设之一：`"brushed"` | `"chrome"` | `"verdigris"` |
   *   `"nightfall"` | `"azurite"`
   *   （与 Profile 正交，Profile 不承载外观色 —— 见 `@/services/config` 的 `ThemeId`）。
   * - 值只经 `userConfig.theme` 读取，**Node 不复制默认值**；非法值由宿主
   *   `ui::theme::normalize` 收拢为默认（不写盘、不建旧值映射）。
   * - Node 在**启动握手后**与**设置保存后**各推一次（`settings_commit` 成功路径）；
   *   **宿主收到前用默认主题**（`brushed`）。
   * - 宿主侧落点：`crates/native-host/src/ui/theme/`（token 表 + 纹理 + 平台绘制）。
   *   同一主题重复推送不触发重建；真正切换时才重绘并释放不属于新主题的纹理。
   */
  apply_theme: {
    args: { theme: string }
    result: void
  }
  /**
   * Node → 宿主：主窗角色舞台快照（当前激活 Profile 的层列表 + `appearance` 投影）。
   *
   * - 层 `path` 是 profiles 域内相对路径；`effectEnabled`/`intensity`/`popupWidth` 来自
   *   `appearance.effectMode === "parallax"` / `appearance.parallaxIntensity` /
   *   `general.popup.defaultSize.w` 的现有 getter，**不复制默认值**。
   * - Node 在启动握手后、设置保存后（影响外观的键）与编辑器保存成功后各推一次；
   *   **宿主收到前舞台无层**；重复推送 = 替换权威快照（编辑器预览回滚到它）。
   * - 宿主侧落点：`crates/native-host/src/ui/stage.rs`（`Stage::apply_profile`）。
   */
  apply_stage_profile: {
    args: {
      layers: StageLayerPayload[]
      effectEnabled: boolean
      intensity: number
      popupWidth: number
    }
    result: void
  }
  /**
   * Node → 宿主：主窗聊天列宽度（`general.popup.chatWidth` 的持久投影）。
   *
   * - `open` = 开合覆盖：`null` 表示**不改变当前开合**（开合由托盘/运行时状态驱动，
   *   Node 只在确有裁定权时下发）；`width` = 持久宽度，`null` = 未配置（布局兜底）。
   * - Node 在启动握手后与设置保存后各推一次；宿主收到前用布局兜底比例。
   * - 分隔条拖动**不改运行时布局体验**，只在拖动结束时经宿主请求面
   *   `set_chat_width` 写回 CONFIG（原子写盘，不新增 localStorage/持久副本）。
   * - 宿主侧落点：`crates/native-host/src/ui/{mod.rs,platform/*}` 的 `set_chat_panel`。
   */
  set_chat_panel: {
    args: { open: boolean | null; width: number | null }
    result: void
  }

  // ── 弹窗摆位与尺寸的运行时闭环（A3 有意扩展 W0 冻结矩阵；新能力，不是重名兼容）──
  /**
   * Node → 宿主：弹窗摆位模式（`general.popup.mode` / `fixedPosition` 的 Native 投影）。
   *
   * - `{ mode: "cursor" }`：跟随光标；宿主只更新模式、**不移动当前窗口**
   *   （下一次呼出才以光标为中心落位）。
   * - `{ mode: "fixed", x, y }`：固定位置；`x`/`y` 是窗口左上角（逻辑像素、左上原点，
   *   与 `set_popup_geometry` 的位置写回同一坐标系）。宿主收到后立即把主窗移到该
   *   位置（越界 clamp 回屏幕内）—— 不能只等下一次呼出，否则固定模式看起来没生效。
   * - `{ mode: "fixed" }`（两个坐标都缺省）：配置里还没有位置（用户刚把模式切成
   *   固定、一次都还没拖过窗口）。宿主切到固定模式但**不移动窗口**（呼出仍按光标
   *   落位，`mode=fixed && !fixedPosition` 同款过渡）；用户在固定模式里拖动
   *   一次后坐标经 A3 写回落盘，后续推送带上坐标。没这个过渡态，宿主会永远停在
   *   跟随光标模式，固定位置在设置里「改了不生效」。
   * - 只带一个坐标是非法载荷（宿主以结构化 `CONFIG` 错误拒绝，不静默回退）。
   * - Node 在启动握手后与设置保存后各推一次（`pushNativeUiState`）；值只经
   *   `generalConfig.popupMode` 与 `userConfig.fixedPosition`（既有 getter）读取，
   *   **不复制默认值**。
   * - 宿主应用位置（带坐标的 fixed）时记录程序摆放原点（macOS `last_placed_origin`），
   *   **不触发** A3 的位置写回 —— Node → 宿主 → Node 不形成回路；用户拖动仍照常写回。
   * - 宿主侧落点：`crates/native-host/src/ui/{mod.rs,state.rs,platform/*}` 的
   *   `set_popup_placement`。
   */
  set_popup_placement: {
    args: { mode: "cursor" } | { mode: "fixed"; x?: number; y?: number }
    result: void
  }
  /**
   * Node → 宿主：弹窗默认尺寸（`general.popup.defaultSize` 的 Native 投影）。
   *
   * - 宿主收到后立即把主窗改为该尺寸（保持左上角不动；小于主窗最小尺寸时 clamp
   *   到最小尺寸），不需要等下一次呼出。
   * - 应用是程序性改尺寸：宿主记录该值并在写回边沿比较，**应用不会触发**
   *   `set_popup_geometry` 的尺寸写回（防「应用 → 写回 → 再应用」回路/反复写盘）；
   *   用户拖边缘仍照常写回。
   * - Node 在启动握手后与设置保存后各推一次；值只经 `generalConfig.defaultPopupSize`
   *   读取，不复制默认值。
   * - 宿主侧落点：`crates/native-host/src/ui/{mod.rs,platform/*}` 的 `set_popup_size`。
   */
  set_popup_size: { args: { w: number; h: number }; result: void }
  /**
   * Node → 宿主：自动呼出主窗开关（`general.popup.autoPopupOnMessage` 的 Native 投影）。
   *
   * - 只传开关值：**宿主收到推送前按 false（fail-closed，与 `configure_chat_image_preview`
   *   同口径）**；值只经既有 getter（`generalConfig.autoPopupOnMessage`）读取，Node 不复制
   *   默认值；不落盘、重启归缺省。
   * - **本命令不含窗口动作**：Node 不得驱动窗口显隐/层级（§9.4 裁定 1）。是否/何时呼出由
   *   原生 UI 自行裁决 —— 收到 `apply_chat_projection` / `apply_titlebar_status` 时，若已
   *   提交读模型出现**新提交的助手条目**（同会话内末尾助手条目变化；首帧历史填充与切会话
   *   只建基线）且开关开启、主窗已收起，则走既有呼出/收回状态机呼出；用户主动收起后随即
   *   到来的新回复照弹（旧壳 `ChatPanel`/`App.vue` 没有额外抑制），动画中与释放尾巴内由
   *   状态机护栏忽略。
   * - Node 在启动握手后与设置保存后各推一次（`pushNativeUiState`）。
   * - 宿主侧落点：`crates/native-host/src/ui/state.rs`（flag 与判定器）+
   *   `ui/platform/{macos,windows}.rs` 的到达检查。
   */
  set_popup_auto_show: { args: { enabled: boolean }; result: void }

  /**
   * Node → 宿主：交付一条**宿主 → Node 请求**（`HostRequestMap`）的回执。
   *
   * - 宿主经事件 `HOST_REQUEST_EVENT` 发出 `{ requestId, method, args }`；Node 的
   *   唯一消费点在 `src/services/native-ui/host-requests.ts`。
   * - `ok=false` 必须带结构化 `error`（码表同 `HostError`，不降级成字符串）；
   *   `requestId` 不匹配（迟到于超时 / 已取消）时宿主按已在的归宿丢弃并留痕。
   */
  host_request_result: {
    args: HostRequestResultPayload
    result: void
  }
  /**
   * Node → 宿主：打开原生图片选择器选择一个 Profile 素材（编辑器「换素材」）。
   *
   * - 返回选中文件的**绝对路径**；用户取消返回 `null`。
   * - 宿主必须走既有路径边界校验（`AppPaths`），选中的文件后续由既有
   *   `profile_file_write` 复制进 Profile；Node 不自行创建选择器。
   * - **W9b 只登记形状**：宿主侧原生文件对话框尚未实现，命令如实报「未接线」。
   */
  pick_profile_asset: {
    args: Record<string, never>
    result: string | null
  }
  // ── 通用文件对话框（本批有意扩展 W0 冻结矩阵；新能力，不是重名兼容）──
  /**
   * Node → 宿主：带调用方过滤器的单文件打开对话框（配置导入 / MCP 导入 /
   * Skill 上传 / Profile 导入 / 记忆恢复等）。
   *
   * - `extensions` 是小写扩展名列表（不带点），宿主据此设置文件类型过滤；
   *   `label` 是过滤器显示名（中性文案）；
   * - 返回选中文件的**绝对路径**；用户取消返回 `null`（不是错误）。
   * - 与 `pick_profile_asset` 的区别：过滤器由调用方给定，不绑定图片格式；
   *   Node 拿到路径后经既有 `file_read` / `file_read_binary` 读取内容。
   * - 宿主侧落点：`FileDialogPort::pick_file_filtered`（原生 NSOpenPanel /
   *   GetOpenFileNameW）。
   */
  pick_file_open: {
    args: { extensions: string[]; label: string }
    result: string | null
  }
  /**
   * Node → 宿主：单文件保存对话框（配置导出 / MCP 导出等）。
   *
   * - `suggestedName` 是预填文件名；`filterLabel` / `extension` 是过滤器显示名与
   *   扩展名（不带点），供平台保存面板设置默认扩展名；
   * - 返回目标**绝对路径**；用户取消返回 `null`。文件字节由 Node 的既有
   *   `file_write` 写入（本命令只负责选路径，不写文件）。
   */
  pick_file_save: {
    args: { suggestedName: string; filterLabel: string; extension: string }
    result: string | null
  }

  // ── 会话标签 / 历史面板 / 顶栏状态位（A2 有意扩展 W0 冻结矩阵；新能力，不是重名兼容）──
  /**
   * Node → 宿主：会话侧读模型投影帧（会话标签列表 / 历史列表 / 活跃会话指针）。
   *
   * - **帧形状的权威定义在 Rust** `crates/native-host/src/ui/chat/projection.rs` 的
   *   `TranscriptProjection`；本命令 args 只承载其中**会话侧子集**
   *   （`sessionId` / `sessions` / `sessionHistory`，TS 侧形状见
   *   `@/services/native-ui/session-projection` 的 `SessionProjectionPayload`）。
   *   `sessions` / `sessionHistory` 缺省 = 宿主保持现值（窗口级视图数据，普通正文帧
   *   不重发标签列表）；正文与其余面板字段由 W3c/W4 的整帧生产者并入**同一帧形状**，
   *   不得另开第二条投影协议。
   * - 发送方（A2）：`src/services/native-ui/session-projection.ts` 的
   *   `pushSessionProjection`。触发时机 = 会话读模型变化（新建/关闭/删除/恢复/切换/
   *   改名/中断标记；经 `session-signal` 通知）、`chat_request_session_history` 的刷新
   *   结果（**回执之后**）、启动首帧（`initNativeUiBridge`）。
   * - 宿主侧落点：IPC 分派层 → `ChatUi::apply_projection`（`ui/chat/ui.rs`）；解析失败
   *   如实报错，不静默丢帧。
   */
  apply_chat_projection: { args: SessionProjectionPayload; result: void }
  /**
   * Node → 宿主：顶栏状态位**最终文本**（缺省「就绪」——无 owner = 空闲的中性
   * 文案；窗口运行时状态）。
   *
   * - 仲裁（owner/优先级/序列）唯一在 `src/services/titlebar.ts`；宿主不重实现、
   *   只持文本快照（`crates/native-host/src/ui/titlebar.rs` 的 `store/current`）。
   * - 发送方（A2）：`src/services/native-ui/titlebar-status.ts` 的 `pushTitlebarStatus`
   *   挂在 `renderOwner()` 的渲染通知上；**去重**（同一文本只推一次，失败不更新去重位、
   *   下次渲染重试）；不随 Profile、不持久化，重启回缺省（宿主未收到推送时保持缺省）。
   * - 宿主侧落点：IPC 分派层 → `UiHandle::apply_titlebar_status`（`ui/mod.rs`）；
   *   `text` 空白由宿主按 None 同义处理（回落缺省），Node 侧始终发最终文本。
   */
  apply_titlebar_status: { args: { text: string }; result: void }

  // ── Bash（crates/native-host/src/commands/tool_exec/bash.rs）──
  bash_exec: {
    args: {
      command: string
      cwd?: string | null
      executionId?: string | null
      /** 毫秒；缺省用 Rust 兜底上限（与 TS 的 bash 档位同值：5 分钟）。
       *  正常路径由 pi-bash 的 prepareArguments 下传生效值（见 tool/local/bash-timeout.ts），
       *  null 只出现在不经该工具的直调上。 */
      timeoutMs?: number | null
      maxBytes?: number | null
      maxLines?: number | null
      /** 截断时保留完整输出到文件并回传 spillPath。 */
      spill?: boolean | null
      /** 发起会话（前台超时转后台后，完成事件按它回投「完成通知」落进正确会话）；
       *  缺省 = 无会话归属，完成通知无展示位（Rust 侧如实留痕跳过）。 */
      sessionId?: string | null
    }
    // W3b 清 TODO(W0)：BashPayload 已由 tool/pi/native-execution-env.ts 导出，矩阵 import 复用，
    //   不再冻结第二份同形结构。
    result: BashPayload
  }
  /** 命中在跑的子进程 / spawn 前立案 / 无此 id 三态如实返回。 */
  bash_cancel: { args: { executionId: string }; result: boolean }

  // ── 文件系统（crates/native-host/src/commands/tool_exec/fs.rs）──
  file_read: {
    args: { path: string; maxBytes?: number | null }
    // 超过 maxBytes 时 Rust 报错（不截断），content 是严格 UTF-8 解码。
    result: { content: string; size: number }
  }
  /** 字节读取：应用层就是 Uint8Array（今天 TS 侧写 number[] 再转，属线格式泄漏）。 */
  file_read_binary: { args: { path: string; maxBytes?: number | null }; result: Uint8Array }
  file_write: {
    args: { path: string; content: string; maxBytes?: number | null }
    result: { success: boolean }
  }
  /** 同 file_write，但先写同目录临时文件再 rename（原子替换）。 */
  file_write_atomic: {
    args: { path: string; content: string; maxBytes?: number | null }
    result: { success: boolean }
  }
  /** maxBytes 是**必填**（Rust `u64`，不是 Option）。 */
  file_append: { args: { path: string; content: string; maxBytes: number }; result: void }
  file_rename: { args: { sourcePath: string; destinationPath: string }; result: void }
  file_remove: { args: { path: string; recursive: boolean; force: boolean }; result: void }
  dir_create: { args: { path: string; recursive: boolean }; result: void }
  file_list: {
    args: { path: string }
    // W3b 清 TODO(W0)：FileInfoPayload 已由 tool/pi/native-execution-env.ts 导出，import 复用。
    result: { entries: FileInfoPayload[] }
  }
  /** 同 FileInfoPayload，单条形态；不跟随符号链接（链接自身报 symlink）。 */
  file_info: {
    args: { path: string }
    result: FileInfoPayload
  }
  file_exists: { args: { path: string }; result: boolean }
  file_canonical_path: { args: { path: string }; result: string }

  // ── 聊天图片准入（crates/native-host/src/commands/chat_images.rs）──
  /** 原生 UI/Node：系统选择器（返回通过的绝对路径）。 */
  pick_chat_images: { args: Record<string, never>; result: string[] }
  /** 按 images/limits.json 的格式/数量/大小边界校验；返回通过的路径。 */
  validate_chat_images: { args: { paths: string[] }; result: string[] }
  /**
   * 删会话连带清理「托管聊天图片」（截图 `screenshots/`、粘贴 `pasted/`）。
   * 只删托管根内的常规文件：根外路径（用户原图）、目录、符号链接与已不存在的文件
   * 一律计入 skipped，绝不删除；单条失败不影响其它项。形状与 Rust
   * `commands/chat_images.rs::chat_delete_session_images` 逐字对齐。
   */
  chat_delete_session_images: { args: { paths: string[] }; result: { deleted: number; skipped: number } }

  // ── 静默观察与截图（observation_cmd.rs / screenshot_cmd.rs）──
  observation_capture_screen: {
    args: Record<string, never>
    /** 类型复用 @/services/observation 的 ScreenCaptureResult（scheduler.ts 为唯一定义点）。 */
    result: ScreenCaptureResult
  }
  observation_read_targets: {
    args: { targets: ReadTargetRequest[] }
    result: TargetReadResult[]
  }
  capture_screenshot: {
    args: Record<string, never>
    /** 类型复用 @/services/tool/local/screenshot 的 CaptureScreenshotResult（消费点为唯一定义处）。 */
    result: CaptureScreenshotResult
  }
  save_screenshot: {
    args: { imageBase64: string }
    /** 类型复用 @/services/tool/local/screenshot 的 SavedScreenshotResult。 */
    result: SavedScreenshotResult
  }

  // ── 本地工具剩余（tool_exec/desktop.rs、system.rs）──
  app_open: { args: { path: string }; result: { success: boolean } }
  clipboard_read: { args: Record<string, never>; result: { text: string } }
  clipboard_write: { args: { text: string }; result: { success: boolean } }
  /** Rust 直接返回结构体（非 AppResult）；camelCase 由 serde rename_all 提供。 */
  system_info: {
    args: Record<string, never>
    result: {
      os: string
      arch: string
      cpuCount: number
      memTotal: number
      memUsed: number
      memAvailable: number
    }
  }

  // ── MCP 进程桥（crates/native-host/src/commands/mcp_bridge.rs）──
  // 注意：spawn 结果结构体**没有** serde rename_all，线格式与消费点（transport.ts）
  // 都是 snake_case 的 `server_id`；不要在应用层静默改名为 serverId。
  mcp_spawn: {
    args: {
      name: string
      command: string
      args: string[]
      transport: string
      /** 附加环境变量（在父进程环境上合并，同名覆盖）。 */
      env?: Record<string, string> | null
    }
    result: { success: boolean; server_id: string; error: string | null }
  }
  /** 写入一行 JSON-RPC 原文（宿主写入时自动补换行）；失败（未连接 / 应用正在退出 / 写入失败）以具体错误 reject。 */
  mcp_write: { args: { serverId: string; line: string }; result: void }
  mcp_read: {
    args: { serverId: string; timeoutMs?: number | null }
    /**
     * line 为行原文；超时返回 line=null（默认 30000ms，clamp ≤120000），closed=true 后恒真。
     * 结果结构体同样没有 rename_all，字段名 `line`/`closed` 原样（消费点 transport.ts）。
     */
    result: { line: string | null; closed: boolean }
  }
  mcp_kill: { args: { serverId: string }; result: { success: boolean; server_id: string } }

  // ── 记忆文件种子（crates/native-host/src/commands/memory_cmd.rs）──
  /** 返回 memory 目录绝对路径。 */
  init_memory_files: { args: Record<string, never>; result: string }

  // ── 运行时路径与配置（crates/native-host/src/lib.rs）──
  get_runtime_paths: {
    args: Record<string, never>
    /** 类型复用 @/services/paths 的 RuntimePathsPayload（Rust 侧 rename_all 已是 camelCase）。 */
    result: RuntimePathsPayload
  }
  resolve_runtime_path: {
    args: { scope: RuntimePathScope; segments: string[] }
    result: string
  }
  /** 配置读取失败是 IO 码（不是 PATH_NOT_FOUND），Node 适配层同口径。 */
  read_runtime_config: { args: Record<string, never>; result: string }
  write_runtime_config: { args: { content: string }; result: void }
  /** sessions/index.json：仅 UI 状态，可丢弃；不存在返回 null。 */
  read_session_ui_state: { args: Record<string, never>; result: string | null }
  write_session_ui_state: { args: { content: string }; result: void }

  // ── 会话文件（crates/native-host/src/commands/session_fs.rs）──
  /**
   * path 是 sessions 域内相对路径；maxLines 只限制读取行数。
   * tailBytes 是尾部读取模式（只读最后 N 字节、返回从行边界开始的整行文本；窗口起点落在
   * 行中间时丢弃截断的半行）—— 供会话活动时间扫描使用，与 maxLines 互斥（同时传报 CONFIG）。
   */
  session_read_text: {
    args: { path: string; maxLines?: number | null; tailBytes?: number | null }
    result: string
  }
  /**
   * path 是 sessions 域内相对路径（同 session_read_text）；maxBytes 必填，是本次 content 的
   * UTF-8 字节上限，由调用方按会话专用口径下发（`SessionFileSystem` 的 `SESSION_WRITE_MAX_BYTES`，
   * 比工具面 file_write 的 5 MiB 放宽）—— Rust 只把它当参数执行，边界钉在会话根。
   */
  session_write_text: { args: { path: string; content: string; maxBytes: number }; result: void }

  // ── Profile（crates/native-host/src/commands/profile_cmd.rs）──
  // Vec<u8> 参数/结果在应用层一律是 Uint8Array（与 file_read_binary 同一口径）。
  profile_file_write: {
    args: { profileId: string; relativePath: string; content: Uint8Array }
    result: void
  }
  profile_file_read: { args: { profileId: string; relativePath: string }; result: Uint8Array }
  profile_delete: { args: { profileId: string }; result: void }
  /** 保存对话框导出 zip；用户取消返回 null。 */
  export_profile_zip: { args: { profileId: string }; result: string | null }
  /** 无 profile.yaml 时返回空串。 */
  profile_asset_base: { args: { profileId: string }; result: string }
  list_profiles: { args: Record<string, never>; result: string[] }
  /** subdir 为域内相对子目录；缺省表示 Profile 根。 */
  list_profile_files: { args: { profileId: string; subdir?: string | null }; result: string[] }

  // ── 默认资源与 Skill（resources_cmd.rs / skill_cmd.rs）──
  restore_default_resources: {
    args: Record<string, never>
    /** 类型复用 @/services/profile 的 RestoreResult（io.ts 为唯一定义点）。 */
    result: RestoreResult
  }
  /** relativePath 是 skills 域内相对路径（不是 frontmatter 的 name）。 */
  skill_delete: { args: { relativePath: string }; result: void }
  /** 类型复用 @/services/skill 的 SkillCatalogFingerprint（目录指纹，不读正文）。 */
  skill_catalog_fingerprint: { args: Record<string, never>; result: SkillCatalogFingerprint }

  // ── 人格文件（crates/native-host/src/commands/personality_fs_cmd.rs）──
  /** path 是 personality 域内相对路径；写入返回落盘后的绝对路径。 */
  personality_file_read: { args: { path: string }; result: Uint8Array }
  personality_file_write: { args: { path: string; content: Uint8Array }; result: string }
  /** 目录不存在返回空数组；dirPath 为域内相对路径。 */
  personality_file_list: { args: { dirPath: string }; result: string[] }
  /** 只删普通文件：目录与符号链接叶子被拒，目标不存在时按 PATH_NOT_FOUND 如实报错。 */
  personality_file_delete: { args: { path: string }; result: void }

  // ── 工具许可（crates/native-host/src/commands/tool_permit.rs）──
  tool_permit_acquire: {
    args: {
      requestId: string
      /** 与 Rust PermitKind::parse 一致：只接受 "shared" / "exclusive"。 */
      kind: "shared" | "exclusive"
      borrowerId: string
      sessionId: string
      runGeneration: number
      operationId: string
    }
    result: boolean
  }
  /** 借用者上线并回收同窗口旧实例的孤儿额度。 */
  tool_permit_attach: { args: { borrowerId: string }; result: PermitReclaim }
  tool_permit_release: { args: { borrowerId: string; requestId: string }; result: void }
  tool_permit_cancel: { args: { borrowerId: string; requestId: string }; result: boolean }
  /** 返回实际生效的上限（越界报错，不静默夹边界）。 */
  tool_permit_set_max_shared_readers: { args: { limit: number }; result: number }
  tool_permit_snapshot: { args: Record<string, never>; result: PermitSnapshot }

  // ── 记忆（crates/native-host/src/memory/commands.rs）──
  // 结构复用 src/services/agent/memory/protocol.ts / barrel（生成物是唯一真相源，
  // 不在此重抄）；失败（含 MEMORY_CONFLICT）走 reject。
  memory_status: { args: Record<string, never>; result: MemoryStatusSnapshot }
  memory_list: {
    args: { scope?: MemoryScope | null; scopeId?: string | null; limit?: number | null }
    result: MemoryItem[]
  }
  memory_detail: { args: { id: string }; result: MemoryItem | null }
  memory_history: { args: { id: string }; result: MemoryHistoryEntry[] }
  /** 返回接受的来源条数。 */
  memory_register_sources: { args: { sources: MemorySource[] }; result: number }
  memory_query: {
    args: {
      query: string
      scope?: MemoryScope | null
      scopeId?: string | null
      sessionId?: string | null
      limit?: number | null
    }
    result: MemoryItem[]
  }
  memory_recall_candidates: {
    args: {
      query: string
      cardId?: string | null
      sessionId: string
      limit?: number | null
      targets?: MemoryRecallTarget[] | null
      allowExpiredTargets?: boolean | null
    }
    result: MemoryRecallCandidateSnapshot
  }
  /** Read the persisted per-session transcript fingerprints and conversation-index revisions. */
  conversation_index_status: {
    args: Record<string, never>
    result: ConversationIndexStatus
  }
  /** Replace one session's visible conversation index using per-session and forget-epoch CAS. */
  conversation_index_replace: {
    args: {
      sessionId: string
      fingerprint: string
      expectedFingerprint: string | null
      expectedForgetEpoch: number
      entries: ConversationIndexEntry[]
      batch?: ConversationIndexBatch
    }
    result: number
  }
  /** Keep the listed real session IDs and prune all other conversation-index rows. */
  conversation_index_prune: { args: { sessionIds: string[] }; result: number }
  /** Search transcript chunks; recent fallback is only for explicit referential queries. */
  conversation_search: {
    args: { query: string; sessionId: string; limit?: number; before?: number; recentFallback?: boolean }
    result: ConversationSearchResult
  }
  /** Expand an already-selected conversation hit into a paged, privacy-filtered chunk-0 transcript. */
  conversation_context: {
    args: { sessionId: string; anchorEntryId: string; afterSeq?: number; limit?: number; before?: number }
    result: ConversationSearchResult
  }
  memory_get_items: { args: { ids: string[] }; result: MemoryItem[] }
  /**
   * args 直接复用 memory 域导出的 MemoryChangeRequest（operationId/baseRevision/action/
   * actor/trustedUserEventId/trustedSessionId/itemId/expectedVersion/draft 与 Rust 参数一一对应）。
   * 返回提交后的 revision；stale 基准由 Rust 抛 MEMORY_CONFLICT。
   */
  memory_apply_change: { args: MemoryChangeRequest; result: number }
  memory_job_start: { args: { phase: MemoryJob["phase"]; leaseOwner: string }; result: MemoryJob }
  memory_job_list: {
    args: { limit?: number | null; offset?: number | null }
    result: MemoryJobListItem[]
  }
  memory_job_checkpoint: {
    /**
     * `coveredSourceIds` = 本批实际处理的全部来源：来源按 (session_id, seq) 成批取数，
     * 一批横跨多个会话，宿主按会话各自推进水位；缺省（null）只推进 cursor 来源所在会话。
     */
    args: {
      jobId: string
      cursor: string
      coveredSourceIds?: string[] | null
      leaseOwner: string
      leaseMs?: number | null
    }
    result: MemoryJob
  }
  memory_job_cancel: { args: { jobId: string; leaseOwner: string }; result: MemoryJob }
  memory_job_resume: { args: { jobId: string; leaseOwner: string }; result: MemoryJob }
  /** origin 省略（null）= 两类来源都取；整理按类别开作业，不混池。 */
  memory_job_sources: { args: { jobId: string; origin?: MemoryOrigin | null }; result: MemorySource[] }
  /**
   * 开作业前的只读前置查询：水位之后待处理来源数（与 `memory_job_sources` 同一水位判定）。
   * 返回 0 时 dreaming 直接跳过本次整理，不创建 job、不动预算与租约；
   * origin 省略（null）= 两类来源合计。
   */
  memory_pending_source_count: { args: { origin?: MemoryOrigin | null }; result: number }
  memory_source_evidence: { args: { sourceId: string }; result: MemorySource | null }
  /** 返回接受的候选条数。 */
  memory_candidates_add: {
    args: { jobId: string; candidates: MemoryCandidateDraft[] }
    result: number
  }
  /** 完成 dreaming job 并在 Rust 事务中自动提交全部合格候选；返回新 revision。 */
  memory_dreaming_commit: { args: { jobId: string; baseRevision: number }; result: number }
  /**
   * 登记一笔 dreaming token 预留：只记账（reserved 增量 + 租约行），不作准入；
   * 日 token 上限自 2026-10-06 起撤除，预留一律接受，幂等重放直接返回。
   */
  memory_dreaming_budget_reserve: {
    args: { reservationId: string; localDate: string; reservedTokens: number }
    result: void
  }
  /** usedTokens 传 null 表示未使用（Rust Option<i64>）。 */
  memory_dreaming_budget_settle: {
    args: {
      reservationId: string
      localDate: string
      reservedTokens: number
      usedTokens: number | null
    }
    result: void
  }
  memory_dreaming_budget: { args: { localDate: string }; result: MemoryDreamingBudget }
  /** 导出/备份返回落盘路径；rebuild/restore 返回新 revision。 */
  memory_export: { args: Record<string, never>; result: string }
  memory_backup: { args: Record<string, never>; result: string }
  memory_rebuild: { args: Record<string, never>; result: number }
  memory_restore: { args: { backupPath: string }; result: number }
  memory_restore_preview: { args: { backupPath: string }; result: MemoryRestorePreview }

  // ── MCP 凭据（crates/native-host/src/commands/mcp_credentials.rs）──
  //
  // 服务器 headers 模板引用的 `${VAR}`（如 github 的 GITHUB_TOKEN）存记忆库的
  // `mcp_credentials` 表（应用自有 SQLite，**不写 CONFIG**）。`mcp_credential_get` 是值
  // 的唯一出口，消费方只有 MCP 连接期注入（`tool/mcp/client.ts`）；其余命令只报名单/
  // 是否删掉。**值不进任何日志与回执**（除 get 的定向返回）。
  /** 写入/更新一条凭据（值不能为空）。 */
  mcp_credential_set: {
    args: { server: string; var: string; value: string }
    result: void
  }
  /** 删除一条凭据；返回是否真的删掉了（未设置 = false）。 */
  mcp_credential_delete: { args: { server: string; var: string }; result: boolean }
  /** 该服务器已设置的变量名名单（不返回值；设置面状态显示用）。 */
  mcp_credential_status: { args: { server: string }; result: string[] }
  /** 读取一条凭据的值（唯一消费者是 Node 连接期注入；不外传、不落日志）。 */
  mcp_credential_get: { args: { server: string; var: string }; result: string | null }

  // ── 主动陪伴（crates/native-host/src/proactive/commands.rs，宏生成同名命令）──
  // 全部是 `request: Value -> Value` 形态；request/response 结构复用生成物
  // protocol.ts 的 Proactive* 类型（唯一真相源）。
  proactive_scan: { args: { request: ProactiveScanRequest }; result: ProactiveScanResponse }
  proactive_query: { args: { request: ProactiveQueryRequest }; result: ProactiveQueryResponse }
  proactive_change: { args: { request: ProactiveChangeRequest }; result: ProactiveChangeResponse }
  proactive_claim: { args: { request: ProactiveClaimRequest }; result: ProactiveClaimResponse }
  proactive_validate: {
    args: { request: ProactiveValidateRequest }
    result: ProactiveValidateResponse
  }
  proactive_settle: {
    args: { request: ProactiveSettleRequest }
    result: { revision: number; status: ProactiveAttemptStatus }
  }
  proactive_reconcile: {
    args: { request: ProactiveReconcileRequest }
    result: { revision: number; status: ProactiveAttemptStatus }
  }
  proactive_control: { args: { request: ProactiveControlRequest }; result: ProactiveControl }
  proactive_auxiliary_budget_reserve: {
    args: { request: ProactiveAuxiliaryBudgetReserveRequest }
    result: ProactiveAuxiliaryBudgetReserveResponse
  }
  proactive_auxiliary_budget_settle: {
    args: { request: ProactiveAuxiliaryBudgetSettleRequest }
    result: ProactiveAuxiliaryBudgetSettleResponse
  }

  // ── 测试宿主专用（仅 debug + is_e2e 隔离宿主开放；W11 随测试设施迁移）──
  //
  // TODO(W0): 这 5 条的消费方只存在于测试侧，类型归属尚未裁定：
  //   - e2e_options 的 TS 投影是 test/e2e/e2e-main.ts:33 的模块私有 RuntimeOptions；
  //   - e2e_trace 的 TraceChunk/TraceChunkAck 在 test/trace/evidence.ts（src 不依赖 test，
  //     故此处只冻结确定的外形，chunk 内部 TraceRecord 结构留 unknown）；
  //   - e2e_memory_performance 的完整测量结构只被 scripts/ 消费。
  //   W11 迁移测试驱动时决定：命令留在宿主测试通道（新 Native 宿主保留同名命令），还是
  //   移出产品 HostCommandMap。届时把类型落到不再跨 src/test 树的位置。
  e2e_options: {
    args: Record<string, never>
    // Rust E2eOptions：26 个 Option<String>（release 构建全部为 null），camelCase；
    // 其中 case_id 经 serde rename 是 `case`。
    result: {
      module: string | null
      scene: string | null
      case: string | null
      tag: string | null
      suite: string | null
      repeat: string | null
      strict: string | null
      report: string | null
      seedHash: string | null
      sourceHashes: string | null
      commit: string | null
      quality: string | null
      qualitySeed: string | null
      performance: string | null
      trace: string | null
      bench: string | null
      benchDataset: string | null
      benchSplit: string | null
      benchLimit: string | null
      benchCase: string | null
      benchSeed: string | null
      benchJudge: string | null
      benchJudgeModel: string | null
      benchReaderControl: string | null
      evalProvider: string | null
      evalModel: string | null
      evalJudgeModel: string | null
    }
  }
  /** 落盘 e2e-result.txt 并以退出码 0 结束进程（测试协议，非产品路径）。 */
  e2e_complete: { args: { passed: boolean; report: string }; result: void }
  e2e_trace: {
    // TODO(W0): chunk 类型在 test/trace/evidence.ts（见上方组注释）；此处保留 unknown，
    //   不跨 src/test 树引用，也不在本包重抄一份测试结构。
    args: { chunk: unknown }
    result: { chunkId: string; chunkSeq: number; persisted: boolean }
  }
  /** 返回 fixture/measurements/initialTargetMet 等测量包；完整结构只被 scripts/ 消费。 */
  e2e_memory_performance: { args: { count: number }; result: Record<string, unknown> }
  /** 重置评测库；status 与 memory_status 同形（MemoryStatusSnapshot）。 */
  e2e_memory_reset: {
    args: Record<string, never>
    result: { generation: number; freshStore: true; status: MemoryStatusSnapshot }
  }
}

// ==========================================
// 宿主 → Node 请求面（W9b 有意扩展）
// ==========================================
//
// 方向与命令矩阵相反：**原生 UI 发起、Node 应答**。用途是「CONFIG/Profile 的唯一
// 真相源在 Node，原生 UI 只持不可变快照/临时草稿」（执行契约 §3、§6.4）：
//   - `settings_read` / `settings_commit`：设置窗打开时拉整表快照、保存时提交改动；
//     Node 经既有 CONFIG 类型化读写（getter / setOverride / flushConfig 原子保存）
//     落盘，Rust 不解析 YAML、不另存设置；
//   - `set_chat_width`：主窗分隔条拖动结束时写回 `general.popup.chatWidth`；
//   - `personality_cards`：设置窗的「人格卡」选择项来源（注册表，不是 CONFIG 副本）；
//   - `editor_load` / `editor_save`：图层编辑器 I/O；保存走既有 Profile 唯一写入路径；
//   - `pick_profile_asset` 是宿主本地能力（不在此表，见 HostCommandMap）。
//
// 传输（W9b 现状）：宿主经 `HostBridge::publish_event` 投事件 `HOST_REQUEST_EVENT`
// （`HostRequestEnvelope`），Node 消费后经 `host_request_result` 命令回执。这不是
// 冻结协议的第二次定义：信封字段与两个既有通道（双向 event / Node→host request）
// 逐项对齐；W4 的「Node 侧命令面」（`HostBridge::call` 的 Node 端处理器注册）落地后，
// 同一张表可整体改走请求/响应通道，**方法名、参数与结果形状不变**。
//
// 失败语义：Node 端失败必须以结构化 `HostError`（code+message）回执；宿主侧等待方
// 以 `AppError::Remote` 保真透出，TIMEOUT 与业务失败分开（取消/超时不伪装成成功）。

export type HostRequestMap = {
  /** 设置窗打开/刷新：整表快照（键 = CONFIG 路径；缺键 = 该字段未配置）。 */
  settings_read: { args: Record<string, never>; result: SettingsSnapshotPayload }
  /** 设置窗保存：提交变更表；失败如实回执（草稿保留在 Rust 侧）。 */
  settings_commit: { args: { changes: SettingChangePayload[] }; result: void }
  /** 分隔条拖动结束：写回 `general.popup.chatWidth`（既有原子保存路径）。 */
  set_chat_width: { args: { width: number }; result: void }
  /**
   * 窗口拖动/缩放结束的几何写回（A3）：`size` → `general.popup.defaultSize`、
   * `position` → `general.popup.fixedPosition`；两个字段都可缺省（只写带上的那个）。
   *
   * - 宿主侧触发点是「用户操作结束」边沿（macOS `windowDidEndLiveResize` / 拖动去抖；
   *   Windows `WM_EXITSIZEMOVE`），不逐帧写盘；
   * - 值取整并夹到设置 schema 的值域（w 200–4000 / h 150–4000），与设置窗编辑
   *   同一字段、互不制造非法值；与现状相同则跳过写盘；
   * - 位置只在固定位置模式（`general.popup.mode=fixed`）由宿主提交 —— 跟随光标
   *   模式的落点由光标决定，不写回。写盘走既有 `setOverride` + `flushConfig`。
   */
  set_popup_geometry: {
    args: {
      size?: { w: number; h: number } | null
      position?: { x: number; y: number } | null
    }
    result: void
  }
  /** 设置窗「人格卡」选择项：可用 Card 列表与当前激活项。 */
  personality_cards: { args: Record<string, never>; result: PersonalityCardsPayload }
  /** 图层编辑器打开：当前激活 Profile 的层草稿。 */
  editor_load: { args: Record<string, never>; result: EditorProfilePayload }
  /** 图层编辑器保存：走既有 Profile 唯一写入路径与原子写盘。 */
  editor_save: { args: EditorSavePayload; result: void }
  /** 图层编辑器素材列表：枚举激活 Profile 全部 `materials/L{n}/` 的图片素材。 */
  editor_list_assets: { args: Record<string, never>; result: { assets: EditorAssetPayload[] } }
  /** 换素材选到**别的层**的素材：复制进目标层后回填新的线格式/绝对路径。 */
  editor_copy_asset: { args: { layer: number; source: string }; result: EditorAssetPayload }

  // ── A2：会话标签 / 历史面板的用户意图（A1 的 `ChatIntent` 增补，五条）──
  //
  // 传输复用同一事件（`deskpet-host-request`）+ 回执（`host_request_result`）通道；
  // 处理体在 `src/services/native-ui/chat-intents.ts`。
  // 标签列表本身**不经请求面增删**：UI 不本地增删，显示变化经 `apply_chat_projection`
  // 的回推完成（A1 的「不建第二份标签 Store」）。
  /**
   * 新建会话：`createNewSession()` + 以激活 Card 补欢迎语。
   * 回执成功 = 领域操作完成（显示变化经投影回推）。
   */
  chat_new_session: { args: Record<string, never>; result: void }
  /** 关闭标签、**保留会话文件**（收口：列表空了建新会话、关的是活跃会话则切到首个剩余）。 */
  chat_close_session: { args: { sessionId: string }; result: void }
  /** 删除会话：磁盘文件 + 列表 + UI 状态（历史面板与标签操作共用；收口同上）。 */
  chat_delete_session: { args: { sessionId: string }; result: void }
  /** 从历史重新打开并切换到该会话（UI 只传 id，meta 由 Node 侧查仓库）。 */
  chat_restore_session: { args: { sessionId: string }; result: void }
  /**
   * 重新读取会话历史（`refreshSessionHistory()`）；**结果不经回执承载**，
   * 经投影 `sessionHistory` 在**回执之后**回推（顺序语义见 chat-intents.ts 文件头）。
   * 刷新失败不回执失败：结果以 `sessionHistory.error=true` 投影（读取失败与「确实没有」不同形）。
   */
  chat_request_session_history: { args: Record<string, never>; result: void }

  // ── 本包：核心聊天链路（发送 / slash / 停止 / 切换）──
  //
  // 复用同一事件 + 回执通道与既有领域入口（处理体在 `src/services/native-ui/chat-intents.ts`）。
  // **提交纪律**：`chat_send` / `chat_slash_command` / `chat_stop` 的领域结算点在
  // 回合/运行收尾（分钟级），宿主用非阻塞提交（`notify`，只留痕、不等回执）——任何
  // 有界等待都只会得到假的 TIMEOUT（见 Rust `ui/chat/intents.rs` 的热路径说明）；
  // `chat_switch_session` 与会话管理组同为有界请求（请求周期内完成）。
  /**
   * 发送一条普通消息（用户 ingress）。领域入口 = `sendMessage(text, { imagePaths })`
   * （先落盘再投递在该入口内部完成，本层不另建投递通道）。
   *
   * - `sessionId` 是宿主 UI 的会话快照：Node 活跃会话是唯一所有者，快照不一致
   *   （切换在途）按活跃会话处理并留痕；
   * - 忙碌时的投递意图由 ingress 按 CONFIG `ai.conversation.defaultDelivery` 决定
   *   （宿主不复制默认值；2026-10-06 用户裁决后线格式**没有**单条显式投递参数）；
   * - 回执形状是 void：`SendMessageResult` 不进回执，失败呈现由 Node 领域的系统消息 /
   *   兜底回复承担（回执迟到时宿主只留痕）。
   */
  chat_send: {
    args: {
      sessionId?: string | null
      text: string
      imagePaths?: string[] | null
    }
    result: void
  }
  /**
   * 发送 `/` 开头的命令文本：与今天同一条 `sendMessage`（由 ingress preProcess
   * 决定执行/透传；忙碌时按既有语义 nextRun 排队）。
   */
  chat_slash_command: { args: { sessionId?: string | null; command: string }; result: void }
  /**
   * 停止当前运行（`stopActiveRun(sessionId)`；在跑计划经它一并终止）。回执在运行
   * 收尾后到达，宿主非阻塞提交；「没有可停的运行」是既有语义的如实归宿（非错误）。
   */
  chat_stop: { args: { sessionId: string }; result: void }
  /**
   * 切换活跃会话（`switchToSession(id)`；与其他会话操作同组，有界请求）。
   * 未知 id 的归宿是既有领域语义（留痕 + no-op），显示变化经投影回推。
   */
  chat_switch_session: { args: { sessionId: string }; result: void }
  /**
   * 「记住这条」：把某条**已提交的用户消息**显式写入长期记忆（旧壳
   * `ChatPanel.vue:270 rememberUserMessage`）。
   *
   * 候选资格由 Node 侧既有可信来源解析裁定（`origin=user` + `taint=trusted_user` +
   * `eligibleForMemory`），**宿主不复刻这套判定**（第二定义点）；不可信/不存在即
   * 如实拒绝。回执带 `revision`，宿主据此回「已记住」这类中性回执。
   */
  chat_remember_message: { args: { sessionId: string; eventId: string }; result: { revision: number } }
  /**
   * 默认投递方式（抽屉「投递」下拉）：写 CONFIG `ai.conversation.defaultDelivery`
   * ——与设置页「默认发送方式（忙碌时）」同键同值域（steer=插话 / followUp=稍后继续），
   * 走 `setOverride` + `flushConfig` 的同一条写盘路径。**没有「默认」档**（配置总有值）。
   */
  chat_set_default_delivery: {
    args: { delivery: "steer" | "followUp" }
    result: void
  }
  /**
   * 思考强度（抽屉「思考」下拉）：写 CONFIG `ai.thinking.effort`（与设置页同键；
   * 值域 auto/low/medium/high）。**没有「默认」档**（配置总有值）。
   */
  chat_set_thinking_effort: {
    args: { effort: ThinkingEffort }
    result: void
  }
  /**
   * 安全策略（抽屉「安全」下拉）：写 CONFIG `ai.safety.mode`（与设置页「确认策略」
   * 同键同值域：just_do_it/tell_me/let_me_tk）。**没有「默认」档**（配置总有值）；
   * 回合冻结纪律不变 —— 改配置从下一回合生效。
   */
  chat_set_safety_mode: {
    args: { mode: "just_do_it" | "tell_me" | "let_me_tk" }
    result: void
  }

  // ── 本包：决策类面板动作（计划恢复 / 队列撤回 / 中断处置）──
  //
  // 复用同一事件 + 回执通道；处理体在 `src/services/native-ui/decision-intents.ts`；
  // Rust 侧映射在 `crates/native-host/src/ui/chat/intents.rs` 的
  // `decision_request` / `decision_submit`（方法名与 args 逐字对齐本表）。
  // **提交纪律**（与「核心聊天链路」同一条分界原则）：结算点是「整段计划/整个回合
  // 跑完」的三条走非阻塞提交（宿主 `notify`，领域收尾后回执只留痕）——
  // `chat_resume_plan` / `chat_resume_paused_inputs` / `chat_continue_interrupted_run`；
  // 其余六条是请求周期内有确定结果的领域写（撤回 / 丢弃 / 终止 / 处置），走有界
  // `request`（与 A2 会话管理组同款裁定：用户尺度低频，接受 UI 回调内的有界阻塞）。
  //
  // 归宿语义与既有面板同源：目标不存在/不可处置是**如实 no-op**（不报错也不谎报），
  // 只有「通道不可用」这类真失败才以结构化错误拒绝；瞬时提示语（showDeliveryNote）
  // 在新宿主的承载面不在本包范围内（回执形状一律 void）。
  /**
   * 终止该会话正在执行中的计划（`abortRunningPlan(sessionId)`）。
   * 未在执行时是 no-op（如实归宿；面板本地收起由宿主侧过渡承担）。
   */
  chat_abort_running_plan: { args: { sessionId: string }; result: void }
  /**
   * 继续一个待处置计划：只跑剩余步骤（`resumePlan(sessionId, planId)`）。
   * 忙碌/未知计划/未知副作用未处置的拒绝由领域写系统消息呈现（回执只报「已提交」）。
   */
  chat_resume_plan: { args: { sessionId: string; planId: string }; result: void }
  /** 丢弃一个待处置计划（`discardPlan`；未知/不可处置的计划返回 false = no-op）。 */
  chat_discard_plan: { args: { sessionId: string; planId: string }; result: void }
  /**
   * 处置一个未知副作用步骤：`planCheckpointStore.resolveUnknownSideEffect(planId, stepId, resolution)`。
   * `resolution` 取值与 Rust `UnknownStepResolution.as_str` 逐字一致
   * （`already_applied` = 标记为已完成并写凭证；`retry` = 记为一次新执行尝试）。
   */
  chat_resolve_unknown_side_effect: {
    args: { planId: string; stepId: string; resolution: "already_applied" | "retry" }
    result: void
  }
  /**
   * 撤回一条尚未被消费的排队项（`withdrawQueuedInput(sessionId, entryId)`）。
   * `cancelled` / `already_consumed` / `not_found` 都是如实归宿（条目不再在队列里 = 撤回
   * 意图已达成）；只有 `unavailable`（槽或 lane 通道不可用）以结构化错误拒绝，
   * 不让界面把「通道坏了」误读成「已撤回」。
   */
  chat_withdraw_queued: { args: { sessionId: string; entryId: string }; result: void }
  /**
   * 取出暂停项并按原顺序投递成一次标准回合（`resumePausedInputs(sessionId)`）。
   * 无暂停项/未获准入的归宿由领域承担（返回 undefined / 失败结果，不进回执）。
   */
  chat_resume_paused_inputs: { args: { sessionId: string }; result: void }
  /**
   * 逐条撤回全部暂停项（`takePausedInputs(sessionId)` 取出后丢弃）。
   * 选择理由：`takePausedInputs` 是「取出全部 nextRun 并撤回」的既有原语（与
   * `resumePausedInputs` 同一条 lane 撤回路径）；`listQueuedInputs` + 循环
   * `withdrawQueuedInput` 是 UI 侧重建同一语义且带 `loaded=false` 歧义（镜像未就绪时
   * 空列表 ≠ 没有暂停项），不作第二实现。没有槽/没有暂停项 = 撤回 0 条（no-op）。
   */
  chat_discard_paused_inputs: { args: { sessionId: string }; result: void }
  /** 继续上次中断的运行（`continueInterruptedRun(sessionId)`；无中断运行 = no-op）。 */
  chat_continue_interrupted_run: { args: { sessionId: string }; result: void }
  /**
   * 丢弃上次中断的运行（`discardInterruptedRun(sessionId)`；无槽 = 无中断运行，no-op）。
   * 归还的未消费输入由领域的既有暂停语义承担（结果不进回执）。
   */
  chat_discard_interrupted_run: { args: { sessionId: string }; result: void }

  // ── W9d：设置页管理面（工具 Tab / 记忆 Tab；原生设置窗发起、Node 应答）──
  //
  // 处理体在 `src/services/native-ui/management-intents.ts`。读的是既有领域入口的
  // 现状（toolsConfig / skill store / 工具注册表 / 记忆 ipc），写的是既有写入口
  // （MCP 配置写 + flushConfig、Skill frontmatter、memory_apply_change）；
  // 行是展示投影（title/subtitle 由 Node 组装），Rust 只渲染与回传坐标。
  /** 工具页：MCP 服务器行（`id` = 服务器名，toggle 走既有写入口）。 */
  tools_mcp_servers: { args: Record<string, never>; result: ManagementRowsPayload }
  /** 工具页：逐项开关一个 MCP 服务器（占用中的服务器由既有入口拒绝）。 */
  tools_mcp_toggle: { args: ManagementTogglePayload; result: void }
  /** 工具页：Skill 清单（`id` = skills 域内相对路径；含被关闭者与目录索引告警）。 */
  tools_skills: { args: Record<string, never>; result: SkillsPayload }
  /** 工具页：逐项开关一个 Skill（写 frontmatter `enabled`，下一个回合生效）。 */
  tools_skill_toggle: { args: ManagementTogglePayload; result: void }
  /** 工具页：工具策略声明表（只读；PermissionKernel 仍是唯一终裁）。 */
  tools_tool_policies: { args: Record<string, never>; result: ManagementRowsPayload }
  /**
   * 记忆页：库总览（状态 + 条目 + 整理作业；数据来自既有 memory ipc 通道）。
   *
   * `scope`/`scopeId` 是可选范围筛选（透传既有 `memory_list` 的 scope 参数：
   * user / card / session；不传 = 全部范围）。筛选只影响条目列表，不影响状态行。
   */
  memory_overview: {
    args: { scope?: "user" | "card" | "session" | null; scopeId?: string | null }
    result: MemoryOverviewPayload
  }
  /** 记忆页：条目详情 + 历史版本（含来源审计摘要）。 */
  memory_item_detail: { args: { id: string }; result: MemoryItemDetailPayload }
  /** 记忆页：一次治理变更（纠正/核心画像标记/遗忘；actor 固定 user_ui，门禁不放宽）。 */
  memory_item_change: { args: MemoryItemChangePayload; result: MemoryItemChangeResult }
  /**
   * 外观页：激活 Profile 选择项（可用 Profile 列表与当前激活项）。
   *
   * 切换不是普通 CONFIG 写：`settings_commit` 对 `appearance.activeProfile` 走
   * `switchActiveProfile` 唯一入口（激活 + 落盘 + 通知），与人格卡同款例外。
   */
  profile_list: { args: Record<string, never>; result: ProfileListPayload }

  // ── 设置页管理面扩展（本批）：通用 / AI / 外观 / 工具 / 记忆 ──
  //
  // 与 W9d 同一条通道与纪律：处理体在 `management-intents.ts` / `host-requests.ts`；
  // 写操作一律落既有领域入口（CONFIG 类型化写、Profile 域、skill 域、memory ipc），
  // 原生设置窗只持不可变快照与临时草稿。需要文件对话框的操作由 Node 调用
  // `pick_file_open` / `pick_file_save`（HostCommandMap）取得路径后经既有文件命令读写。
  /**
   * 通用页「↺ 默认」：内置 CONFIG 模板的整表投影（与 `settings_read` 同形）。
   * 默认值唯一真值点在 Node（CONFIG.yaml 模板）；宿主只把它填进草稿，保存前不落盘。
   */
  settings_defaults: { args: Record<string, never>; result: SettingsSnapshotPayload }
  /** 通用页「导出配置」：Node 生成 YAML → 保存对话框 → 写入所选路径。 */
  config_export: { args: Record<string, never>; result: ConfigTransferResult }
  /** 通用页「导入配置」：打开对话框 → 读取 YAML → 校验后替换运行时 CONFIG 并写盘。 */
  config_import: { args: Record<string, never>; result: { imported: boolean } }
  /** AI 页：V1RTUAL.md 用户指令读取。 */
  v1rtual_read: { args: Record<string, never>; result: { content: string } }
  /** AI 页：V1RTUAL.md 全量写入（既有 `updateV1rtualInstructions` 唯一入口）。 */
  v1rtual_write: { args: { content: string }; result: void }
  /** AI 页：当前卡阶段文案（行编辑格式；不传 cardId = 激活卡）。 */
  card_stages_read: { args: { cardId?: string | null }; result: CardStagesPayload }
  /** AI 页：阶段文案保存（Node 解析行格式 → validateStages → updateStagesFile）。 */
  card_stages_write: { args: { cardId?: string | null; text: string }; result: void }
  /** AI 页：阶段文案重新生成（`generateStagesForCard`，失败如实拒绝）。 */
  card_stages_regenerate: { args: { cardId?: string | null }; result: CardStagesPayload }
  /** AI 页：变量池只读预览（激活卡或指定卡）。 */
  card_variable_pool: { args: { cardId?: string | null }; result: CardVariablePoolPayload }
  /** AI 页：Card 管理动作（新建/重命名/删除/导出/导入），结果附最新卡列表。 */
  card_manage: { args: CardManagePayload; result: CardManageResult }
  /** AI 页：Card 本体 markdown（不传 cardId = 激活卡）。 */
  card_markdown_read: { args: { cardId?: string | null }; result: { cardId: string; text: string } }
  /** AI 页：Card 本体 markdown 保存（解析校验 → 按原卡 id 写回 → 重载注册表）。 */
  card_markdown_write: { args: { cardId?: string | null; text: string }; result: void }
  /** AI 页：Card 作者模版全文（只读提示词；模板缺失时如实拒绝）。 */
  card_template: { args: Record<string, never>; result: { text: string } }
  /** 外观页：Profile 管理动作（复制/删除/导出/导入/恢复默认资源）。 */
  profile_manage: { args: ProfileManagePayload; result: ProfileManageResult }
  /** 外观页：音效库（逐事件分配行：行内下拉的选项与当前选中值）。 */
  sound_library: { args: Record<string, never>; result: SoundLibraryPayload }
  /** 外观页：单个事件的音效分配写回（`soundId = "none"` 表示静音；写 CONFIG 后重推宿主提示音）。 */
  sound_set_assignment: { args: { event: string; soundId: string }; result: void }
  /** 外观页：清空分配覆盖，全部事件回内置默认（写 CONFIG 后重推宿主提示音）。 */
  sound_reset: { args: Record<string, never>; result: void }
  /** 外观页：试听一条预设（不改配置、不影响事件分配）。 */
  sound_preview: { args: { soundId: string }; result: void }
  /** 工具页：MCP 服务器编辑表单（`name` 缺省 = 新建模板；字段值与校验都在 Node）。 */
  mcp_server_form: { args: { name?: string | null }; result: McpServerFormPayload }
  /**
   * 工具页：写入一条 MCP 凭据（GitHub 令牌）。
   *
   * `id` 是凭据行的行坐标（Node 组装行时定义并解析回 server/var）；`value` 由用户在
   * 原生输入框输入，经宿主 `mcp_credential_set` 存进应用自有存储 —— **不写 CONFIG、
   * 不回显、不进日志**（回执只有 void）。
   */
  mcp_credential_write: { args: { id: string; value: string }; result: void }
  /** 工具页：MCP 表单保存（`originalName` 空 = 新增；非空 = 更新原条目，允许改名）。 */
  mcp_save: { args: McpServerFormSavePayload; result: void }
  /** 工具页：删除 MCP 服务器（表单编辑走 `mcp_save`）。 */
  mcp_delete: { args: { name: string }; result: void }
  /** 工具页：连接测试（借出→归还；连接失败是结果不是异常）。 */
  mcp_test: { args: { name: string }; result: { ok: boolean; message: string } }
  /** 工具页：MCP JSON 导入（打开对话框 → 读取 → 既有 import 入口）。 */
  mcp_import: { args: Record<string, never>; result: { imported: number; canceled: boolean } }
  /** 工具页：MCP JSON 导出（既有 export 入口 → 保存对话框 → 写文件）。 */
  mcp_export: { args: Record<string, never>; result: ConfigTransferResult }
  /** 工具页：上传 .md 作为 Skill（打开对话框 → 读取 → upsertSkill）。取消返回 null。 */
  skill_upload: { args: Record<string, never>; result: { name: string | null } }
  /** 工具页：删除 Skill（skills 域内相对路径；走既有 deleteSkill）。 */
  skill_delete: { args: { id: string }; result: void }
  /** 记忆页：登记来源的原话回看（有界证据 + 会话正文原话）。 */
  memory_source_evidence: { args: { sourceId: string }; result: MemorySourceEvidencePayload }
  /** 记忆页：手动整理（`runDreamingSweep`；无 LLM 配置等情况如实报错）。 */
  memory_dreaming_sweep: { args: Record<string, never>; result: MemoryMaintenanceResult }
  /** 记忆页：一致性备份 / 导出只读副本 / 重建索引（既有 memory ipc）。 */
  memory_maintenance: {
    args: { op: "backup" | "export" | "rebuild_index" }
    result: MemoryMaintenanceResult
  }
  /**
   * 记忆页：托管备份列表（`memory/backups` 下的 `.sqlite3`，按 mtime 倒序）。
   *
   * 行 `id` = 备份绝对路径（宿主选中后经 `memory_restore` 原样回传；路径边界由 Rust
   * `memory_restore*` 裁决）；行 `action = "choose"`（宿主行按钮显示选中态）。
   * 目录不存在 = 空列表（还没有备份）；目录存在但读不了 = 如实抛错。
   */
  memory_backup_list: { args: Record<string, never>; result: ManagementRowsPayload }
  /**
   * 记忆页：恢复预览 / 应用（`backupPath` = 备份列表里**选中的那一份**，不再是
   * 「最新一份」隐式坐标；preview = 只读预检，apply = 执行恢复）。
   */
  memory_restore: {
    args: { op: "preview" | "apply"; backupPath: string }
    result: MemoryMaintenanceResult
  }
  /**
   * 记忆页：终止一条整理作业（`memory_job_cancel`，lease owner = 记忆整理的既有写者）。
   * 只有进行中的作业生效；状态没有变成 cancelled 就如实拒绝（不谎报取消成功）。
   */
  memory_job_cancel: { args: { jobId: string }; result: { message: string } }
  /**
   * 记忆页：继续一条受限的整理作业（`memory_job_resume` + 既有
   * `runDreamingSweep({ resumeJobId })`：恢复 review 作业并按游标跑到收口）。
   * 非 review / revision 或 forget_epoch 已变的作业由领域如实拒绝。
   */
  memory_job_resume: { args: { jobId: string }; result: MemoryMaintenanceResult }
}

// ==========================================
// 事件矩阵
// ==========================================
//
// (a) 类 —— Node/宿主 → UI 的读模型与状态推送。这些进 HostEventMap。
// 事件名（线格式字节）的定义点在 ./event-names.ts 的事件名区，本矩阵只定义载荷形状，
// 键从那里的常量计算（`[HOST_EVENT_*]`）。
// 正式实现中每条事件还要带 producer epoch、单调 eventSeq 与归属 scope（信封由
// protocol.rs 的 FrameHeader 承载）；旧 Node/旧会话/旧 owner 的事件必须被消费者按
// scope 丢弃。payload 里不重复这些信封字段。
//
// (b) 类 —— UI 窗口之间的本地协调，**不进** HostEventMap；清单与理由见本文件末尾。

export type HostEventMap = {
  // ── 宿主系统事件（Rust → 消费者）──
  /**
   * 系统观察采样（Rust monitor 线程 emit，monitor/thread.rs）。消费方是 Node 的
   * window listener（src/services/window/listener.ts:55）。类型复用 @/services/window
   * 的 WindowObservation；消费者必须保留 monitorGeneration/sequence 的乱序丢弃逻辑。
   */
  [HOST_EVENT_WINDOW_OBSERVED]: WindowObservation
  /**
   * 后台命令结束（Rust `commands/tool_exec/bash.rs` 的等待线程 emit；只投 Node，
   * 原生 UI 不呈现）。前台 bash 超过其预算时**不杀进程**、转后台继续跑；本事件是终点：
   * 进程自行结束或到 30 分钟后台时限被进程组回收。消费方是
   * `src/services/tool/background.ts` 的完成通知接线（聊天系统消息，`pushSystemMessage`）。
   * 载荷类型逐字镜像 Rust `crates/native-host/src/host/mod.rs::BackgroundCommandFinished`。
   */
  [HOST_EVENT_BASH_BACKGROUND_FINISHED]: BashBackgroundFinishedPayload
  /**
   * 光标位置推送（Rust commands/cursor.rs，仅坐标变化时发；~60fps）。
   * 消费方是原生 UI 的灵动图层渲染。**不应经 Node 转发** —— 60fps 穿 Node 只会
   * 加延迟；宿主侧只直投原生 UI（crates/native-host/src/host/events.rs），
   * 列入本矩阵只为保住契约形状。
   * 载荷与 get_cursor_position 的 result 同形（Rust CursorPosition，snake_case）。
   */
  [HOST_EVENT_CURSOR_MOVE]: {
    x: number
    y: number
    screen_x: number
    screen_y: number
    screen_w: number
    screen_h: number
  }

  // ── 聊天流式与运行状态（Node → UI）──
  // 生产者：src/services/engine/harness/runtime.ts 的 emitUiEvent（best-effort；
  // 失败只影响刷新，不影响回合）。事件经 HostBridge 到达原生 UI 后，
  // 「已提交读模型」仍是最终收敛点（§4.1）。
  /**
   * 助手流式增量（runtime.ts）。消费方是原生 UI 聊天域（分泡渲染前的裸增量）。
   * TODO(W0): 生产者/消费者两侧都只有内联字面量，没有可 import 的命名 payload 类型；
   *   且消费端今天把字段都当可选（防御式）。W4a 应命名并导出，冻结为必填。
   */
  [HOST_EVENT_ASSISTANT_STREAM]: { sessionId: string; delta: string }
  /** 流式收尾（runtime.ts:1477/1484）。TODO(W0): 同上，无命名 payload 类型。 */
  [HOST_EVENT_ASSISTANT_STREAM_END]: { sessionId: string }
  /**
   * 阶段提示（runtime.ts:1430）。只发**语义 key**，文案由 UI 按当前 Card 取
   * （getSimpleStage）—— 事件不携带角色台词；类型 key 复用 @/services/personality 的
   * SimpleStageKey。
   */
  [HOST_EVENT_STAGE_HINT]: { sessionId: string; stage: SimpleStageKey }
  /**
   * 工具开始/结束（runtime.ts）。消费方是原生 UI 聊天域。
   * TODO(W0): 无命名 payload 类型，两侧都是内联字面量；W4b 命名并导出。
   */
  [HOST_EVENT_TOOL_EXECUTING]: { toolId: string; toolName: string }
  /** TODO(W0): 同 tool-executing，无命名 payload 类型。 */
  [HOST_EVENT_TOOL_COMPLETED]: { toolId: string; toolName: string; success: boolean }
  /**
   * 运行态通知（runtime.ts）。原生 UI 聊天域只据此显示/收起停止按钮；
   * 真相源仍是 Node 的运行槽，UI 不因此持有第二份运行状态。
   * TODO(W0): 无命名 payload 类型；W4a 命名并导出。
   */
  [HOST_EVENT_RUN_STATE]: { sessionId: string; running: boolean }
  /**
   * 发送**投递归宿**（「已排队插话」「稍后继续」这类回执的真相源）。
   *
   * 为什么不开在 `chat_send` 的回执上：`chat_send` 是**非阻塞**提交（整回合结算，
   * 分钟级），改成有界请求会稳定撞出假 TIMEOUT、并让 UI 主线程被堵 —— 而投递归宿
   * 在**投递准入**时就已确定（忙碌路径快速返回），空闲整回合路径也只是要等到收尾。
   * 所以按「事实产生当刻单向发一条」处理：不改变 `chat_send` 的提交语义。
   *
   * `delivery` = `HarnessDeliveryReceipt` 的三值；UI 侧分别对应旧壳
   * `SendMessageResult.delivery` 的三条中性回执文案（不混角色台词）。
   */
  [HOST_EVENT_SEND_OUTCOME]: {
    sessionId: string
    requestId: string
    delivery: "steered" | "followup" | "deferred"
  }
  /**
   * 分泡揭示进度（断链 D；生产者 `src/services/native-ui/reveal-push.ts`，是 humanizer
   * 调度器每次状态变化的投影）。形状 = Rust `crates/native-host/src/ui/chat/model.rs::
   * RevealProgress`（逐字段同名）。`HumanizerRevealState.typingStartedAt` 是调度器内部
   * 计时原点，不进行载荷。真相源仍是 Node 调度器：消费端按 `revealed` 裁剪
   * `visible_parts`，不重算节奏；每次发布语义都不同（逐泡推进 / typing 终态），
   * 不做增量合并（节奏本身 ≥400ms 一档）。
   */
  [HOST_EVENT_REVEAL_PROGRESS]: {
    sessionId: string
    messageId: string
    runGeneration: number
    revealed: number
    partCount: number
    typing: boolean
  }

  // ── Plan 确认与进度（Node → UI）──
  // 注意：这四条只是「Node 问 UI」的推送方向；UI→Node 的确认/裁决
  // （resolvePlanConfirm / resolvePlanStepDecision 的答复）是**反向通道**，不属本矩阵，
  // 由 W5/W8 与 NativeUi 一起设计（必须保持今天超时/切会话/注册失败的归宿语义）。
  /**
   * 待确认计划（plan-confirmation.ts:201）。steps 复用 @/services/engine 的 PlanStep。
   * TODO(W0): 信封（sessionId/planId/steps/complexity/forceStepByStep）没有命名类型；
   *   W4a/W8 命名并导出。
   */
  [HOST_EVENT_PLAN_START]: {
    sessionId: string
    planId: string
    steps: PlanStep[]
    complexity: number
    forceStepByStep: boolean
  }
  /**
   * 计划步骤进度（runtime.ts）。消费方是原生 UI 的计划确认面板，按
   * stepId/total/status 消费；desc 是生产端补充说明，一并冻结。
   * TODO(W0): 无命名 payload 类型；status 枚举没有共享类型，W4a 命名并导出。
   */
  [HOST_EVENT_PLAN_PROGRESS]: {
    sessionId: string
    planId: string
    stepId: string
    total: number
    desc: string
    status: "running" | "done" | "failed" | "warning"
  }
  /**
   * 步骤门/失败询问（plan-confirmation.ts:269）。error 仅在 kind="failed" 时出现。
   * TODO(W0): 无命名 payload 类型；W4a/W8 命名并导出。
   */
  [HOST_EVENT_PLAN_STEP_GATE]: {
    sessionId: string
    planId: string
    kind: "approval" | "failed"
    step: PlanStep
    index: number
    total: number
    error?: string
  }
  /** 计划收尾（plan-confirmation.ts:352）。reason 的三种归宿由生产端保证。 */
  [HOST_EVENT_PLAN_END]: { sessionId: string; reason: "done" | "failed" | "cancelled" }

  // ── 向用户提问（`ask_user` 工具；Node → UI）──
  /**
   * 一次待答提问（生产者 `engine/choice-confirmation.ts::requestChoice`）。面板显示
   * question 与 options，用户经回执 `UiReceiptMap["deskpet-choice-resolved"]` 作答；
   * 面板额外提供「其它」（用户用自己的话回答 —— 自由原文以下一条消息到达，不随本
   * 通道回传）与「取消」两个固定按钮，不需要模型声明。
   * requestId 由工具调用 id 派生：同一会话可并发多条（与计划确认不同，刻意不设单槽）。
   */
  [HOST_EVENT_CHOICE_START]: {
    sessionId: string
    requestId: string
    question: string
    options: string[]
  }
  /**
   * 提问收尾（生产者 `choice-confirmation.ts::notifyChoiceEnd`）：UI 按 requestId
   * 收起对应面板。用户点选/「其它」时面板已由回执的本地过渡收起（这条是幂等兜底）；
   * 超时、切会话、会话关闭、发射失败等归宿把面板收起来的就是它。
   */
  [HOST_EVENT_CHOICE_END]: { sessionId: string; requestId: string }

  // ── 权限确认（Node → UI；回执方向见 `UiReceiptMap`）──
  /**
   * 权限确认请求。生产者 = `src/services/native-ui/permission-confirm.ts` 对
   * `confirmState.pending`（`safety/confirm.ts` 的确认单槽）的同步投影 —— 事件只在
   * 有 UI 事件通道的宿主发布；Rust 消费端 `ui/chat/events.rs::ChatEvent::from_wire`
   * → `ChatUi::apply_event` 的权限面板。回执 = `UiReceiptMap` 的
   * `"deskpet-permission-confirm-resolved"`。
   *
   * 字段是 `PermissionRequest` 的展示子集（camelCase，Rust `PermissionConfirmRequest`
   * 逐字段同名）。**没有有效期字段**（2026-10-06 用户裁决：选择类弹窗不留超时）：
   * 面板等用户想多久想多久，归宿只来自用户动作 / 取消信号 / 会话切换 / 下发失败
   *（下发失败由桥按拒绝立即结算，见 `native-ui/permission-confirm.ts`）。
   * **权限终裁仍在 PermissionKernel**：UI 只呈现与回传用户选择，不做任何判定，
   * 也不因此持有第二份授权状态。
   */
  [HOST_EVENT_PERMISSION_CONFIRM]: {
    requestId: string
    message: string
    toolName: string
    sessionId: string
    runGeneration: number
    parameterSummary: string
    effectClass: string
    inputHash: string
    policyHash: string
    toolCallId: string
  }
}

// ==========================================
// (b) 类：UI 窗口之间的本地协调 —— 不进 HostEventMap
// ==========================================
//
// 下列通道当前由前端 emit/emitTo 自产自听，语义是「哪个窗口说给哪个窗口听」，
// 带窗口寻址（emitTo）与请求/应答配对；Node 既不是生产者也不是消费者。单 Node 进程后
// 由原生 UI 的内部窗口协调承接，因此**不进** HostEventMap：
//
//   deskpet-moved                      主窗 → 设置窗（窗口移动通知）
//   deskpet-resized                    主窗 → 设置窗（窗口尺寸通知）
//   deskpet-preview-size               设置窗 → 主窗（试改弹窗尺寸的实时预览）
//   deskpet-settings-saved             设置窗 → 主窗（保存后刷新配置）
//   deskpet-profile-updated            编辑器/设置 → 主窗（Profile 保存后刷新缓存）
//   deskpet-observation-governance-request / -applied
//                                      窗口间 owner 选举与回执（observation/ownership.ts）
//   deskpet-memory-revision-changed / -applied
//                                      窗口间 revision 同步与回执（memory/revision.ts）
//   deskpet-proactive-control-request / -response / -state
//                                      窗口间控制请求/应答/状态广播（proactive/control.ts）
//
// 不进的判据：生产者与消费者都是 UI 窗口；事件是窗口寻址 + 请求/应答，不是 Node 的
// 读模型推送。重新设计时必须保住的语义：governance owner 唯一、revision 回执必达、
// 请求有超时/失败归宿 —— 但承载方式由原生 UI 内部重新定义。
//
// 其中 proactive control（enabled/muteUntil）与 memory revision 的**数据**仍以
// Node/Rust 命令（proactive_control、memory_*）为真相源；UI 不得因这些窗口协调通道
// 另存长期状态（契约 §3：窗口不成为新的 run owner 或长期 Store）。
// deskpet-settings-saved / deskpet-profile-updated 的持久化写入同样走 Node 命令
// （write_runtime_config / profile_file_write），事件只负责「已保存，去刷新」。
