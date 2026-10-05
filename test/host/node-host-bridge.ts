// ==========================================
// NodeHostBridge —— L2/L3 测试宿主的 HostBridge 实现
// ==========================================
//
// 这是**测试宿主**的桥：transport 直接是 `test/host/node-ipc.ts` 的命令面（按 Rust
// `#[tauri::command]` 逐条等价复现的 Node 适配层），**全程不经过 `@tauri-apps/*`、
// 也不经过任何旧壳（Tauri）实现**。由 `test/host/install-node-bridge.ts` 经
// setHostBridge() 注入（产品窗口在 bootWindow() 注入、L4 在 native-main.ts 注入 ——
// 一个环境只注入一个实现）。
//
// 语义与迁移期产品桥（`@/services/host/tauri-bridge.ts`）逐条对齐，搬过来的是它做对的
// 部分（没有搬的是旧宿主专有的东西：Tauri emit / convertFileSrc 走 Node 等价实现）：
//
// - **参数**：原样透传；只有 `profile_file_write` / `personality_file_write` 的
//   content 从应用层 Uint8Array 编码成适配层线格式的 number[]（与 Tauri 的 `Vec<u8>`
//   线格式同形，node-ipc 的 handler 也按 number[] 读取）。
// - **结果物化**：`file_read_binary` / `profile_file_read` / `personality_file_read`
//   的线格式是 number[]，在这里物化为 Uint8Array；线格式不是字节数组时如实报错，
//   不把形状不对的数据交给调用方。
// - **失败归一（不销毁桥不理解的错误）**：适配层的 `{code,message}` 载荷原样透传；
//   其它错误**保留原对象本身**、只在缺失时补 `code`（默认 "OTHER"）与可读 message ——
//   `name`/`stack`/`cause` 与 instanceof 语义不动。这条修过一个真 bug：把
//   `UnsupportedInNodeError` 替换成新 Error 会丢掉 `name`，`standard-setup.ts` 的
//   「Node 适配层没有该后端」豁免分支因此失效（见《未完成工作与已知缺口》原生宿主迁移过程记录 §9.4 第 27/29 条）。
//   原对象不可扩展时才包装成新 Error，原错误完整挂在 `cause` 上。
// - **取消**：`options.signal` 真正生效 —— abort 后调用方立刻以 AbortError 拒绝，
//   不等命令结果；原始 reason 挂在 `cause`（超时/自定义 reason 的线索不丢）。
// - **scope**：测试宿主没有消费点（适配层没有信封字段），不做假投递。
// - **事件订阅**：没有实现，**如实抛错**（与 node-event 的纪律一致：绝不返回
//   「订阅成功但永不触发」的空实现）。这里用同步抛而不是异步拒绝：subscribe 的同步
//   签名接不住异步注册失败，异步拒绝只会变成 unhandled rejection，比同步抛更难定位。
// - **blob 通道**：不存在 —— readBlob/releaseBlob 明确抛结构化 UNSUPPORTED，
//   不伪造字节来源（HostBlobRef 只能由真实宿主在路径校验后签发）。
//
// [保留已登记 §4.2] 本文件在 Node 侧运行，不 import `@/services/logger|error` 的日志面；
// 归一需要的 formatError/isAppErrorPayload 来自无依赖叶子 `@/services/error/format`。

import { formatError, isAppErrorPayload } from "@/services/error/format"
import {
  setExecutionPathKit,
  setHostEnvironment,
  setResourceUrlResolver,
  setUiEventPublisher,
} from "@/services/host"
import type {
  HostBlobRef,
  HostBridge,
  HostCommandMap,
  HostError,
  HostEventMap,
  RunScope,
} from "@/services/host"
import { emit } from "./node-event"
import { convertFileSrc, invoke } from "./node-ipc"
import { homeDir, isAbsolute, join, resolve, tempDir } from "./node-path"
import { UnsupportedInNodeError } from "./unsupported"

/**
 * 应用层字节参数 → 适配层线格式的转换表。
 * 只登记确有字节载荷的命令；其余命令不做任何深拷贝/遍历（参数原样透传）。
 */
const BYTE_CONTENT_ARG: Partial<Record<keyof HostCommandMap, string>> = {
  profile_file_write: "content",
  personality_file_write: "content",
}

/** 结果是字节（线格式 number[]）的命令，应用层物化为 Uint8Array。 */
const BYTE_RESULT_METHODS: ReadonlySet<string> = new Set([
  "file_read_binary",
  "profile_file_read",
  "personality_file_read",
])

export class NodeHostBridge implements HostBridge {
  constructor() {
    // 环境端口装配（模式说明见 @/services/host/ports.ts）：领域代码只认取用口，
    // 一个环境只装配一个实现。实现全部来自 Node 适配层，无 Tauri：
    // - 运行模式：测试宿主不是生产构建，与 node-ipc 的 get_runtime_paths 口径一致；
    // - 平台：测试宿主没有 ServerWelcome 握手，取 `process.platform`（与真实宿主
    //   HostPlatform::CURRENT 同源；非 Windows 即 macOS，两个值域与宿主一致）；
    // - 资源 URL：node-ipc 的 convertFileSrc（与 Tauri 同实现，只做 URL 拼装）；
    // - 执行环境路径运算：node-path 的 node:path / node:os 实现；
    // - UI 事件发布：落到 node-event.emit —— 没有事件系统，如实抛错（不造假总线）。
    setHostEnvironment({
      runtimeMode: "development",
      platform: process.platform === "win32" ? "windows" : "macos",
    })
    setResourceUrlResolver({ toResourceUrl: localPath => convertFileSrc(localPath) })
    setExecutionPathKit({ homeDir, tempDir, join, resolve, isAbsolute })
    setUiEventPublisher({
      publish: async (event, payload) => {
        await emit(event, payload)
      },
    })
  }

  async request<K extends keyof HostCommandMap>(
    method: K,
    args: HostCommandMap[K]["args"],
    options?: { signal?: AbortSignal; scope?: RunScope },
  ): Promise<HostCommandMap[K]["result"]> {
    const signal = options?.signal
    if (signal?.aborted) throw abortError(signal)

    let detachAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return
      const onAbort = () => reject(abortError(signal))
      signal.addEventListener("abort", onAbort, { once: true })
      detachAbort = () => signal.removeEventListener("abort", onAbort)
    })

    // 先发起命令再 race：abort 时立刻拒绝调用方，不等命令结果。
    const invocation = invoke<HostCommandMap[K]["result"]>(method as string, encodeRequestArgs(method, args)).then(
      (value): HostCommandMap[K]["result"] => decodeResponse(method, value),
    )

    try {
      return await Promise.race([invocation, aborted])
    } catch (error) {
      if (isAbortError(error)) throw error
      throw toHostError(error)
    } finally {
      detachAbort?.()
    }
  }

  /**
   * 测试宿主没有事件总线：订阅**如实抛错**（见文件头；不返回假退订、不造假总线）。
   * 需要事件驱动行为的验证属于 L4（原生宿主有真事件通道），用 `UnsupportedInNodeError`
   * 与 node-event 保持同一判据与错误身份。
   */
  subscribe<K extends keyof HostEventMap>(event: K, _listener: (payload: HostEventMap[K]) => void): () => void {
    throw new UnsupportedInNodeError(`event.listen(${String(event)})`)
  }

  async readBlob(ref: HostBlobRef, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    void ref
    void options
    throw blobChannelUnsupported("readBlob")
  }

  async releaseBlob(ref: HostBlobRef): Promise<void> {
    void ref
    throw blobChannelUnsupported("releaseBlob")
  }
}

// ==========================================
// 线格式转换（与产品桥同表同语义）
// ==========================================

function encodeRequestArgs<K extends keyof HostCommandMap>(
  method: K,
  args: HostCommandMap[K]["args"],
): Record<string, unknown> {
  const key = BYTE_CONTENT_ARG[method]
  if (!key) return args as Record<string, unknown>
  const content = (args as Record<string, unknown>)[key]
  if (!(content instanceof Uint8Array)) return args as Record<string, unknown>
  // 适配层的 Vec<u8> 线格式是 JSON number[]；应用层契约是 Uint8Array。
  return { ...(args as Record<string, unknown>), [key]: Array.from(content) }
}

function decodeResponse<K extends keyof HostCommandMap>(
  method: K,
  value: unknown,
): HostCommandMap[K]["result"] {
  if (!BYTE_RESULT_METHODS.has(method as string)) return value as HostCommandMap[K]["result"]
  if (value instanceof Uint8Array) return value as HostCommandMap[K]["result"]
  if (Array.isArray(value) && value.every((byte): byte is number => Number.isInteger(byte))) {
    return new Uint8Array(value) as HostCommandMap[K]["result"]
  }
  // 线格式不是字节数组时如实报错，不让调用方拿到形状不对的数据。
  throw bridgeError("OTHER", `字节命令 ${String(method)} 的线格式不是字节数组`)
}

// ==========================================
// 失败与取消（自产品桥搬运，语义逐条一致）
// ==========================================

/**
 * 失败归一为结构化 HostError —— **不销毁桥不理解的错误**。
 *
 * - 适配层 `{code, message}` 载荷原样透传（errorCode()/formatError() 直接消费）；
 * - 其它错误保留**原对象本身**，只在缺失时附加结构化 `code`（默认 "OTHER"）与可读
 *   `message`：`name`、`stack`、`cause` 与 instanceof/类型语义全部不动 —— 调用方按
 *   错误类型或 `name` 判定的分支（如 `standard-setup.ts` 对 UnsupportedInNodeError
 *   的豁免）不因过桥而失效；
 * - 原对象不可扩展（frozen / 只读访问器）或根本不是对象时才包装成新 Error，
 *   原错误挂在 `cause` 链上 —— 绝不凭空丢掉。
 */
function toHostError(error: unknown): HostError {
  if (isAppErrorPayload(error)) return error
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown }
    const missing: { code?: string; message?: string } = {}
    if (typeof record.code !== "string") missing.code = "OTHER"
    if (typeof record.message !== "string") missing.message = formatError(error)
    try {
      Object.assign(error, missing)
      return error as HostError
    } catch {
      // 写入被拒（frozen，或像 DOMException 的 code 那样只有 getter）不是要上报的故障，
      // 而是「原对象载不动结构化字段」的信号：切到下面的包装兜底，原错误在 cause 里完整保留。
    }
  }
  return wrapHostError(error)
}

/**
 * 归一兜底：原错误载不动结构化字段时包装成新 Error。
 * 原错误整体挂在 `cause` 上（含 name/stack）；原对象本就有字符串 code 时保真沿用，
 * 不让错误码在归一里被降级成 "OTHER"。
 */
function wrapHostError(error: unknown): HostError {
  const originalCode = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
  const code = typeof originalCode === "string" ? originalCode : "OTHER"
  return Object.assign(new Error(formatError(error)), { code, cause: error })
}

/** 桥自身产生的结构化失败（线格式违规等：没有原错误可保，直接造）。 */
function bridgeError(code: string, message: string): HostError {
  return Object.assign(new Error(message), { code })
}

/**
 * abort 语义：立刻以 AbortError 结束，不等命令结果。
 *
 * 取消判据是 `name === "AbortError"`（下游一律按名字识别），所以 reason 不是 AbortError
 * 时必须换成规范的 DOMException；但**不销毁**调用方给的原始 reason —— 挂在 `cause` 上，
 * 超时（TimeoutError）或自定义 reason 的线索不丢。（Node 18+ 有全局 DOMException。）
 */
function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  if (reason instanceof DOMException && reason.name === "AbortError") return reason
  return Object.assign(new DOMException("HostBridge 请求已被调用方取消", "AbortError"), { cause: reason })
}

function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "AbortError"
  )
}

/**
 * blob 通道在测试宿主不存在。不伪造实现：HostCommandMap 里没有任何「按 ref 取字节」的
 * 命令，HostBlobRef 只能由真实宿主在路径校验后签发 —— 测试宿主从不签发、也无法物化，
 * 所以 readBlob/releaseBlob 只能如实报错，绝不会静默给空数据或假句柄。
 */
function blobChannelUnsupported(operation: string): HostError {
  return bridgeError(
    "UNSUPPORTED",
    `测试宿主没有 blob 通道（${operation} 不可用）：` +
      "HostBlobRef 只能由真实宿主签发，测试宿主不伪造字节来源。",
  )
}
