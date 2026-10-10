// ==========================================
// 与原生宿主的私有连接（控制 + 二进制两条 socket）
// ==========================================
//
// 一条端点、两条连接：控制必须先建立（首字节 0x01），随后握手 hello/welcome，
// 再开二进制连接（首字节 0x02 + 一次性握手值）。stdout/stderr 不承载 RPC。
//
// 关键语义：
// - **控制通道优先队列**：取消等控制帧先于普通帧写出（`PriorityWriteQueue`），
//   图片/大 JSON 不在控制通道上排队。
// - **背压**：二进制通道按信用记账（`CreditGate`），额度不足等待，不静默丢弃。
// - **取消**：`AbortSignal` 触发即发 cancel（控制优先），结果以宿主响应为准
//   —— 若宿主在收到取消前已完成，返回成功（取消不回滚已提交写入）。
// - **大字段**：参数侧自动上传（blobOpen → blobReady → 块 → blobCommitted），
//   结果侧自动物化（`$hostBlobRef`）。
//
// 连接参数只从受控启动信息（环境变量 `DESKPET_HOST_LAUNCH`）读取 —— 见
// `crates/native-host/src/ipc/mod.rs` 的「受控启动信息」节；这里不自行推导路径。

import net from "node:net"
import { randomBytes } from "node:crypto"

import { createLogger } from "@/services/logger"
import type { HostBlobRef, RunScope } from "./types"
import {
  BOOTSTRAP_FRAME_GUARD_BYTES,
  BinaryChunkReader,
  ControlFrameReader,
  FRAME_MAGIC,
  HostBridgeUnavailableError,
  HostCommandError,
  HostProtocolError,
  MAX_HANDSHAKE_TOKEN_BYTES,
  PROTOCOL_VERSION,
  ROLE_BINARY,
  ROLE_CONTROL,
  UPLOAD_MARKER_KEY,
  UPLOAD_SETTLE_TIMEOUT_MS,
  assertFrame,
  encodeBinaryChunk,
  encodeFrame,
  type ClientHello,
  type DecodedChunk,
  type ServerWelcome,
  type WireFrame,
} from "./wire"

/** 受控启动信息（Rust `ipc/mod.rs` 写定的唯一真相源：环境变量 + 一行 JSON）。 */
export const LAUNCH_ENV_VAR = "DESKPET_HOST_LAUNCH"

export interface LaunchInfo {
  endpoint: string
  handshake: string
  entry: string
  nodeBinary: string
}

export interface LaunchInfoErrorInfo {
  code: string
  message: string
}

/** 从环境变量读受控启动信息。缺失/损坏是致命错误（不许静默降级）。 */
export function readLaunchInfo(env: NodeJS.ProcessEnv = process.env): LaunchInfo {
  const raw = env[LAUNCH_ENV_VAR]
  if (typeof raw !== "string" || raw.length === 0) {
    throw new HostCommandError(
      "LAUNCH_INFO_MISSING",
      `缺少受控启动信息（${LAUNCH_ENV_VAR}）：Node 只能由原生宿主拉起`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new HostCommandError("LAUNCH_INFO_MALFORMED", `受控启动信息不是合法 JSON: ${String(error)}`)
  }
  const record = parsed as Partial<LaunchInfo>
  if (
    typeof record.endpoint !== "string" ||
    typeof record.handshake !== "string" ||
    typeof record.entry !== "string" ||
    typeof record.nodeBinary !== "string"
  ) {
    throw new HostCommandError("LAUNCH_INFO_MALFORMED", "受控启动信息字段不完整")
  }
  return {
    endpoint: record.endpoint,
    handshake: record.handshake,
    entry: record.entry,
    nodeBinary: record.nodeBinary,
  }
}

/** 握手后的会话信息（只从 ServerWelcome 取，Node 不自行判断平台/运行模式）。 */
export type WelcomeInfo = ServerWelcome

export interface FlushReport {
  flushed: boolean
  pending: number
  detail?: string
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface UploadSettler {
  resolve: () => void
  reject: (error: Error) => void
}

interface ActiveRead {
  blobId: string
  expectedBytes: number
  received: number
  parts: Buffer[]
  resolve: (data: Uint8Array) => void
  reject: (error: Error) => void
}

interface UploadJob {
  bytes: Buffer
  kind: "bytes" | "json"
}

interface PlannedUpload extends UploadJob {
  marker: { id: string; kind: "bytes" | "json" }
}

const UPLOAD_ID_BYTES = 16

export interface RequestOptions {
  signal?: AbortSignal
  scope?: RunScope
}

export class HostConnection {
  private readonly log = createLogger("HostConnection")
  private readonly controlSocket: net.Socket
  private readonly binarySocket: net.Socket
  private readonly controlReader = new ControlFrameReader()
  private readonly binaryReader = new BinaryChunkReader()
  private readonly controlQueue: PriorityWriteQueue
  private readonly binaryQueue: PriorityWriteQueue
  private readonly sendCredit: CreditGate
  private readonly pending = new Map<number, PendingRequest>()
  private readonly subscriptions = new Map<string, Set<(payload: unknown) => void>>()
  private readonly uploadSettlers = new Map<string, UploadSettler>()
  /** 已收到 blobAbort 的上传 id：流式循环据此立刻停下（不让块撞上宿主的协议校验）。 */
  private readonly abortedUploads = new Set<string>()
  private readonly disconnectHandlers: Array<(reason: string) => void> = []
  private shutdownHandler: (() => Promise<FlushReport>) | null = null
  private nextRequestId = 1
  private eventSeq = 0
  private activeRead: ActiveRead | null = null
  private readTail: Promise<unknown> = Promise.resolve()
  private uploadTail: Promise<unknown> = Promise.resolve()
  private closed = false
  private closeReason = "未关闭"

  readonly welcome: WelcomeInfo

  private constructor(
    launch: LaunchInfo,
    nodeVersion: string,
    welcome: WelcomeInfo,
    controlSocket: net.Socket,
    binarySocket: net.Socket,
  ) {
    this.welcome = welcome
    this.controlSocket = controlSocket
    this.binarySocket = binarySocket
    this.controlQueue = new PriorityWriteQueue(controlSocket, (error) =>
      this.failFatal("控制通道写出失败", error),
    )
    this.binaryQueue = new PriorityWriteQueue(binarySocket, (error) =>
      this.failFatal("二进制通道写出失败", error),
    )
    this.sendCredit = new CreditGate(welcome.limits.streamCreditBytes)
    this.wireSockets()
  }

  private absorbHandshakeLeftovers(controlLeftover: Buffer, binaryLeftover: Buffer): void {
    if (controlLeftover.length > 0) {
      for (const frame of this.controlReader.push(controlLeftover, this.limits.controlFrameMaxBytes)) {
        this.handleFrame(frame)
      }
    }
    if (binaryLeftover.length > 0) {
      for (const chunk of this.binaryReader.push(binaryLeftover, this.limits.blobChunkMaxBytes)) {
        this.handleBinaryChunk(chunk)
      }
    }
  }

  // ── 连接建立 ──

  static async connect(options: { launch: LaunchInfo; nodeVersion?: string }): Promise<HostConnection> {
    const { launch } = options
    const nodeVersion = options.nodeVersion ?? process.versions.node

    // 1) 控制连接 + hello/welcome
    const control = await connectSocket(launch.endpoint)
    await writeSocket(control, Buffer.concat([Buffer.from([ROLE_CONTROL]), FRAME_MAGIC]))
    const hello: ClientHello = {
      protocolVersion: PROTOCOL_VERSION,
      handshake: launch.handshake,
      nodeVersion,
    }
    await writeSocket(
      control,
      encodeFrame(
        {
          protocolVersion: PROTOCOL_VERSION,
          kind: "control",
          payload: { payloadKind: "control", op: "hello", hello },
        },
        BOOTSTRAP_FRAME_GUARD_BYTES,
      ),
    )
    const controlBytes = new SocketByteReader(control)
    const welcomeFrame = await readOneFrame(controlBytes, BOOTSTRAP_FRAME_GUARD_BYTES)
    const welcomeOp = (welcomeFrame.payload as { op?: string }).op ?? ""
    if (welcomeOp !== "welcome") {
      throw new HostProtocolError("HANDSHAKE_UNEXPECTED_FRAME", `期望 welcome，收到 ${welcomeOp}`)
    }
    const welcome = validateWelcome((welcomeFrame.payload as { welcome?: unknown }).welcome)

    // 2) 二进制连接（控制已建立后才行；token 即一次性握手值）
    const binary = await connectSocket(launch.endpoint)
    const token = Buffer.from(launch.handshake, "utf8")
    if (token.length > MAX_HANDSHAKE_TOKEN_BYTES) {
      throw new HostProtocolError("HANDSHAKE_REJECTED", "一次性握手值超长")
    }
    const tokenHead = Buffer.alloc(4)
    tokenHead.writeUInt32LE(token.length, 0)
    await writeSocket(binary, Buffer.concat([Buffer.from([ROLE_BINARY]), FRAME_MAGIC, tokenHead, token]))
    const binaryBytes = new SocketByteReader(binary)
    const statusReply = await binaryBytes.readExactly(5)
    if (!statusReply.subarray(0, 4).equals(FRAME_MAGIC)) {
      throw new HostProtocolError("HANDSHAKE_REJECTED", "二进制通道握手回包魔数不匹配")
    }
    const status = statusReply.readUInt8(4)
    if (status !== 0) {
      throw new HostProtocolError("HANDSHAKE_REJECTED", `二进制通道被拒绝（状态 ${status}）`)
    }

    const connection = new HostConnection(launch, nodeVersion, welcome, control, binary)
    // 握手期缓冲的余量字节交还给正常分帧器（对端可能在 welcome 后立刻发帧）。
    connection.absorbHandshakeLeftovers(controlBytes.dispose(), binaryBytes.dispose())
    return connection
  }

  // ── 会话信息 ──

  get appEpoch(): string {
    return this.welcome.appEpoch
  }

  get nodeEpoch(): number {
    return this.welcome.nodeEpoch
  }

  get platform(): "windows" | "macos" {
    return this.welcome.platform
  }

  get runtimeMode(): "development" | "production" {
    return this.welcome.runtimeMode
  }

  get limits(): WelcomeInfo["limits"] {
    return this.welcome.limits
  }

  isClosed(): boolean {
    return this.closed
  }

  defaultScope(): RunScope {
    return { appEpoch: this.appEpoch, nodeEpoch: this.nodeEpoch }
  }

  // ── 生命周期回调 ──

  /** 宿主请求关停时调用：返回值会作为 flush 的真实报告回给宿主。 */
  onShutdown(handler: () => Promise<FlushReport>): void {
    this.shutdownHandler = handler
  }

  /** 连接断开（含宿主死亡）时调用；harness 据此决定退出。 */
  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandlers.push(handler)
  }

  // ── 请求 ──

  private requestFrame(method: string, args: unknown, scope: RunScope, requestId: number): WireFrame {
    return {
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId,
      scope,
      payload: { payloadKind: "request", method, args },
    }
  }

  async request(method: string, args: unknown, options: RequestOptions = {}): Promise<unknown> {
    this.assertOpen()
    const signal = options.signal
    if (signal?.aborted) {
      throw new HostCommandError("CANCELLED", `请求在发送前已被取消: ${method}`)
    }
    const scope = options.scope ?? this.defaultScope()

    const requestId = this.nextRequestId++
    const onAbort = () => {
      // 取消经控制优先队列先出；结果以宿主响应为准（若已完成则返回成功）。
      this.sendControlFrame({
        protocolVersion: PROTOCOL_VERSION,
        kind: "control",
        payload: { payloadKind: "control", op: "cancel", requestId },
      })
    }
    const uploadedBlobIds: string[] = []
    let enqueued = false
    let pendingRegistered = false
    try {
      // 先检查真实完整信封。若超出协商帧长，把整份参数 JSON 上传一次，
      // 避免先拆出若干字段 blob、再因合并帧依然超限而白白消耗 I/O。
      const plan = this.planJsonArgs(args)
      let frame = this.requestFrame(method, plan.prepared, scope, requestId)
      const directEnvelope = JSON.stringify(frame)
      if (directEnvelope === undefined) throw new HostProtocolError("REQUEST_ARGS_NOT_JSON", "请求信封无法编码为 JSON")
      const requiresJsonBlob = Buffer.byteLength(directEnvelope, "utf8") > this.limits.controlFrameMaxBytes
      if (requiresJsonBlob) {
        const marker: Record<string, unknown> = {
          [UPLOAD_MARKER_KEY]: { id: "0".repeat(UPLOAD_ID_BYTES * 2), kind: "json" },
        }
        // 预先验证 marker 信封本身可发送，避免上传后才发现 method/scope 等固定部分超限。
        frame = this.requestFrame(method, marker, scope, requestId)
        const markerEnvelope = JSON.stringify(frame)
        if (markerEnvelope === undefined) throw new HostProtocolError("REQUEST_ARGS_NOT_JSON", "请求信封无法编码为 JSON")
        const bodyBytes = Buffer.byteLength(markerEnvelope, "utf8")
        if (bodyBytes > this.limits.controlFrameMaxBytes) {
          throw new HostProtocolError("FRAME_TOO_LARGE", `参数已改为 JSON blob，但请求信封仍有 ${bodyBytes} 字节，超过协商上限 ${this.limits.controlFrameMaxBytes}`)
        }
      }

      // 大二进制值继续走原始 bytes blob，避免 Array.from 把图片等扩成数倍数字文本。
      // 若整份参数仍需 JSON blob，这些 bytes marker 会一并嵌在 JSON 中供 Rust 递归物化。
      for (const upload of plan.uploads) {
        const blobId = await this.uploadBlob(upload, signal, scope)
        uploadedBlobIds.push(blobId)
        upload.marker.id = blobId
      }
      if (requiresJsonBlob) {
        const serializedArgs = JSON.stringify(plan.prepared)
        if (serializedArgs === undefined) throw new HostProtocolError("REQUEST_ARGS_NOT_JSON", "请求参数无法编码为 JSON")
        const jsonUpload: UploadJob = {
          bytes: Buffer.from(serializedArgs, "utf8"),
          kind: "json",
        }
        const blobId = await this.uploadBlob(jsonUpload, signal, scope)
        uploadedBlobIds.push(blobId)
        const marker = (frame.payload as { args: Record<string, unknown> }).args
        marker[UPLOAD_MARKER_KEY] = { id: blobId, kind: "json" }
      }
      const encoded = encodeFrame(frame, this.limits.controlFrameMaxBytes)
      if (signal?.aborted) throw this.cancelledRequest(method)

      const settled = new Promise<unknown>((resolve, reject) => {
        this.pending.set(requestId, { method, resolve, reject })
        pendingRegistered = true
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      // AbortSignal may have fired between upload completion and listener setup.
      if (signal?.aborted) throw this.cancelledRequest(method)
      this.controlQueue.enqueue(encoded, "normal")
      enqueued = true
      return await settled
    } catch (error) {
      if (pendingRegistered && !enqueued) this.pending.delete(requestId)
      if (uploadedBlobIds.length > 0 && !enqueued) this.cleanupUnsentUploads(uploadedBlobIds, scope, error)
      throw error
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  // ── 事件 ──

  subscribe(event: string, listener: (payload: unknown) => void): () => void {
    this.assertOpen()
    let set = this.subscriptions.get(event)
    if (!set) {
      set = new Set()
      this.subscriptions.set(event, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  /** 把 Node 领域事件推给宿主（`HostEventMap` 的 Node 生产者侧；W4 接线）。 */
  publishEvent(event: string, payload: unknown, scope: RunScope = this.defaultScope()): void {
    this.assertOpen()
    const seq = ++this.eventSeq
    this.sendControlFrame({
      protocolVersion: PROTOCOL_VERSION,
      kind: "event",
      scope,
      payload: { payloadKind: "event", event, seq, payload },
    })
  }

  // ── blob ──

  async readBlob(ref: HostBlobRef, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    this.assertOpen()
    validateBlobRef(ref)
    if (ref.scope.appEpoch !== this.appEpoch || ref.scope.nodeEpoch !== this.nodeEpoch) {
      throw new HostCommandError("SCOPE_STALE", "blob 句柄属于其它宿主/Node 代际，拒绝读取")
    }
    // 同一方向同时只跑一个传输：串行排队。
    const run = this.readTail.then(() => this.performRead(ref, options.signal))
    this.readTail = run.catch(() => undefined)
    return run
  }

  private async performRead(ref: HostBlobRef, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen()
    if (signal?.aborted) {
      throw new HostCommandError("CANCELLED", "读取在发送前已被取消")
    }
    const requestId = this.nextRequestId++
    let resolveData!: (data: Uint8Array) => void
    let rejectData!: (error: Error) => void
    const data = new Promise<Uint8Array>((resolve, reject) => {
      resolveData = resolve
      rejectData = reject
    })
    // 失败路径可能先以响应错误结束（blobAbort 也会拒绝它）；先挂上处理器，
    // 避免 Node 的 unhandledRejection 把一次可归因的失败变成进程级事故。
    void data.catch(() => undefined)
    this.activeRead = {
      blobId: ref.id,
      expectedBytes: ref.bytes,
      received: 0,
      parts: [],
      resolve: resolveData,
      reject: rejectData,
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { method: "blob_read", resolve, reject })
    })
    const onAbort = () => {
      this.sendControlFrame({
        protocolVersion: PROTOCOL_VERSION,
        kind: "control",
        payload: { payloadKind: "control", op: "cancel", requestId },
      })
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      this.controlQueue.enqueue(
        encodeFrame(
          {
            protocolVersion: PROTOCOL_VERSION,
            kind: "request",
            requestId,
            scope: ref.scope,
            payload: { payloadKind: "request", method: "blob_read", args: { blobId: ref.id } },
          },
          this.limits.controlFrameMaxBytes,
        ),
        "normal",
      )
      await response
      return await data
    } catch (error) {
      if (this.activeRead) this.activeRead = null
      throw error
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async releaseBlob(ref: HostBlobRef): Promise<void> {
    this.assertOpen()
    validateBlobRef(ref)
    await this.request("blob_release", { blobId: ref.id }, { scope: ref.scope })
  }

  // ── 参数 JSON 规划 ──

  private planJsonArgs(args: unknown): { prepared: unknown; uploads: PlannedUpload[] } {
    const threshold = Math.max(1024, Math.floor(this.limits.controlFrameMaxBytes / 2))
    const uploads: PlannedUpload[] = []
    const walk = (value: unknown, key: string, applyToJSON = true): unknown => {
      if (value instanceof Uint8Array) {
        if (value.byteLength > threshold) {
          const marker = { id: "0".repeat(UPLOAD_ID_BYTES * 2), kind: "bytes" as const }
          uploads.push({
            bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
            kind: "bytes",
            marker,
          })
          return { [UPLOAD_MARKER_KEY]: marker }
        }
        return Array.from(value)
      }
      if (typeof value !== "object" || value === null) return value
      if (applyToJSON) {
        const toJSON = (value as { toJSON?: unknown }).toJSON
        if (typeof toJSON === "function") {
          const serialized = toJSON.call(value, key) as unknown
          if (serialized !== value) return walk(serialized, key, false)
        }
      }
      if (Array.isArray(value)) return value.map((item, index) => walk(item, String(index)))
      if (typeof value === "object" && value !== null) {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          out[key] = walk(item, key)
        }
        return out
      }
      return value
    }
    return { prepared: walk(args, ""), uploads }
  }

  private cancelledRequest(method: string): HostCommandError {
    return new HostCommandError("CANCELLED", `请求在发送前已被取消: ${method}`)
  }

  private cleanupUnsentUploads(blobIds: readonly string[], scope: RunScope, primaryError: unknown): void {
    for (const blobId of blobIds) {
      void this.request("blob_release", { blobId }, { scope }).catch((cleanupError: unknown) => {
        this.log.warn("未发送请求的上传 blob 清理失败；原请求错误保持不变", { primaryError, cleanupError, blobId })
      })
    }
  }

  private async uploadBlob(job: UploadJob, signal: AbortSignal | undefined, scope: RunScope): Promise<string> {
    const run = this.uploadTail.then(() => this.performUpload(job, signal))
    this.uploadTail = run.catch(() => undefined)
    if (!signal) return run
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbort)
        reject(this.cancelledRequest("JSON blob upload"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
      void run.then(
        blobId => {
          signal.removeEventListener("abort", onAbort)
          if (settled) {
            this.cleanupUnsentUploads([blobId], scope, this.cancelledRequest("JSON blob upload"))
            return
          }
          settled = true
          resolve(blobId)
        },
        error => {
          signal.removeEventListener("abort", onAbort)
          if (!settled) {
            settled = true
            reject(error)
          }
        },
      )
    })
  }

  private async performUpload(job: UploadJob, signal?: AbortSignal): Promise<string> {
    this.assertOpen()
    if (signal?.aborted) throw new HostCommandError("CANCELLED", "上传在开始前已被取消")
    const blobId = randomBytes(UPLOAD_ID_BYTES).toString("hex")
    const ready = this.awaitUploadSettle(blobId, "ready")
    this.sendControlFrame({
      protocolVersion: PROTOCOL_VERSION,
      kind: "control",
      payload: {
        payloadKind: "control",
        op: "blobOpen",
        blobId,
        bytes: job.bytes.length,
        kind: job.kind,
      },
    })
    await ready

    const committed = this.awaitUploadSettle(blobId, "committed")
    const chunkMax = this.limits.blobChunkMaxBytes
    try {
      for (let offset = 0; offset < job.bytes.length || offset === 0; ) {
        if (this.abortedUploads.has(blobId)) {
          throw new HostCommandError("BLOB_ABORTED", "上传被宿主中止")
        }
        const end = Math.min(offset + chunkMax, job.bytes.length)
        const last = end === job.bytes.length
        const slice = job.bytes.subarray(offset, end)
        const granted = await this.sendCredit.take(slice.length, () => this.closed)
        if (!granted) throw new HostBridgeUnavailableError("连接已断开，上传中止")
        this.binaryQueue.enqueue(encodeBinaryChunk(offset, last, slice, chunkMax), "normal")
        offset = end
        if (last) break
      }
      await committed
      return blobId
    } finally {
      this.abortedUploads.delete(blobId)
    }
  }

  private awaitUploadSettle(blobId: string, phase: "ready" | "committed"): Promise<void> {
    const key = `${blobId}:${phase}`
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.uploadSettlers.delete(key)
        reject(new HostCommandError("UPLOAD_TIMEOUT", `上传 ${phase} 阶段未在期限内得到宿主回应`))
      }, UPLOAD_SETTLE_TIMEOUT_MS)
      this.uploadSettlers.set(key, {
        resolve: () => {
          clearTimeout(timer)
          this.uploadSettlers.delete(key)
          resolve()
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          this.uploadSettlers.delete(key)
          reject(error)
        },
      })
    })
  }

  // ── socket 事件与分派 ──

  private wireSockets(): void {
    this.controlSocket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of this.controlReader.push(chunk, this.limits.controlFrameMaxBytes)) {
          this.handleFrame(frame)
        }
      } catch (error) {
        this.failFatal("控制通道分帧失败", error)
      }
    })
    this.controlSocket.on("error", (error: Error) => this.handleSocketClosed(`控制连接错误: ${error.message}`))
    this.controlSocket.on("close", () => this.handleSocketClosed("控制连接已关闭"))

    this.binarySocket.on("data", (chunk: Buffer) => {
      try {
        for (const decoded of this.binaryReader.push(chunk, this.limits.blobChunkMaxBytes)) {
          this.handleBinaryChunk(decoded)
        }
      } catch (error) {
        this.failFatal("二进制通道分帧失败", error)
      }
    })
    this.binarySocket.on("error", (error: Error) => this.handleSocketClosed(`二进制连接错误: ${error.message}`))
    this.binarySocket.on("close", () => this.handleSocketClosed("二进制连接已关闭"))
  }

  private handleFrame(frame: WireFrame): void {
    switch (frame.kind) {
      case "response": {
        const requestId = frame.requestId as number
        const pending = this.pending.get(requestId)
        if (!pending) {
          // 取消后迟到的响应：丢弃（normal 队列里的取消已发过）。
          return
        }
        this.pending.delete(requestId)
        const payload = frame.payload as { ok: boolean; result?: unknown; error?: { code: string; message: string } }
        if (payload.ok) pending.resolve(payload.result ?? null)
        else {
          const wire = payload.error ?? { code: "UNKNOWN", message: "宿主返回了无错误说明的失败" }
          pending.reject(new HostCommandError(wire.code, wire.message))
        }
        return
      }
      case "event": {
        const payload = frame.payload as { event: string; seq: number; payload: unknown }
        this.handleHostEvent(frame.scope as RunScope, payload.event, payload.payload)
        return
      }
      case "control":
        this.handleControl(frame)
        return
      case "request": {
        // 宿主 → Node 的命令面属于 W4；本波如实报无处理器，不伪成功。
        const requestId = frame.requestId as number
        const method = (frame.payload as { method?: string }).method ?? ""
        this.sendControlFrame({
          protocolVersion: PROTOCOL_VERSION,
          kind: "response",
          requestId,
          payload: {
            payloadKind: "response",
            ok: false,
            error: { code: "NODE_NO_HANDLER", message: `Node 侧命令面尚未接线（W4）：${method}` },
          },
        })
        return
      }
    }
  }

  private handleHostEvent(scope: RunScope, event: string, payload: unknown): void {
    if (scope.appEpoch !== this.appEpoch || scope.nodeEpoch !== this.nodeEpoch) {
      // 旧代际事件一律丢弃（契约 §4.1）。
      return
    }
    const listeners = this.subscriptions.get(event)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch {
        // 订阅者自身的异常不回灌到连接；W3 的统一错误出口会记录它。
      }
    }
  }

  private handleControl(frame: WireFrame): void {
    const payload = frame.payload as { op: string } & Record<string, unknown>
    switch (payload.op) {
      case "cancel": {
        const requestId = payload.requestId as number
        const pending = this.pending.get(requestId)
        if (pending) {
          this.pending.delete(requestId)
          pending.reject(new HostCommandError("CANCELLED", `宿主取消了请求: ${pending.method}`))
        }
        return
      }
      case "credit": {
        const direction = payload.direction
        const bytes = typeof payload.bytes === "number" ? payload.bytes : 0
        if (direction === "nodeToHost") this.sendCredit.grant(bytes)
        return
      }
      case "blobReady": {
        this.uploadSettlers.get(`${String(payload.blobId)}:ready`)?.resolve()
        return
      }
      case "blobCommitted": {
        this.uploadSettlers.get(`${String(payload.blobId)}:committed`)?.resolve()
        return
      }
      case "blobAbort": {
        const blobId = String(payload.blobId)
        this.abortedUploads.add(blobId)
        const wire = payload.error as { code?: string; message?: string } | undefined
        const error = new HostCommandError(wire?.code ?? "BLOB_ABORTED", wire?.message ?? "blob 传输被宿主中止")
        this.uploadSettlers.get(`${blobId}:ready`)?.reject(error)
        this.uploadSettlers.get(`${blobId}:committed`)?.reject(error)
        if (this.activeRead?.blobId === blobId) {
          const active = this.activeRead
          this.activeRead = null
          active.reject(error)
        }
        return
      }
      case "shutdown": {
        void this.handleShutdown(payload)
        return
      }
      case "scopeRevoked": {
        // Node 代际轮换通知：本波 Node 无 epoch 绑定的持久状态，记录即可（W3/W4 接入）。
        return
      }
      case "ping": {
        this.sendControlFrame({ protocolVersion: PROTOCOL_VERSION, kind: "control", payload: { payloadKind: "control", op: "pong" } })
        return
      }
      case "pong":
        return
      case "protocolError": {
        const wire = payload.error as { code?: string; message?: string } | undefined
        this.failFatal("对端报告协议错误", new HostProtocolError(wire?.code ?? "PROTOCOL_VIOLATION", wire?.message ?? ""))
        return
      }
      case "welcome":
      case "hello":
      case "shutdownFlush":
        // 方向性错误：只应出现在对面。
        return
      default:
        return
    }
  }

  private async handleShutdown(payload: Record<string, unknown>): Promise<void> {
    const reason = typeof payload.reason === "string" ? payload.reason : "宿主关停"
    let report: FlushReport
    try {
      if (this.shutdownHandler) {
        report = await this.shutdownHandler()
      } else {
        report = { flushed: false, pending: 0, detail: "未注册 flush 处理器（harness 尚未接线）" }
      }
    } catch (error) {
      report = { flushed: false, pending: 0, detail: `flush 处理器失败: ${String(error)}` }
    }
    try {
      this.sendControlFrame({
        protocolVersion: PROTOCOL_VERSION,
        kind: "control",
        payload: {
          payloadKind: "control",
          op: "shutdownFlush",
          flushed: report.flushed,
          pending: report.pending,
          ...(report.detail !== undefined ? { detail: report.detail } : {}),
        },
      })
    } catch {
      // 连接已断：报告发不出去，宿主会按超时如实记中断。
    }
    this.close(
      report.flushed
        ? `${reason}（flush 完成）`
        : `${reason}（flush 未完成，宿主会如实记中断）`,
    )
  }

  private handleBinaryChunk(chunk: DecodedChunk): void {
    const active = this.activeRead
    if (!active) {
      // 无归属的块：只可能来自刚被取消/中止的传输（对端已停发，块在途）。
      // 丢弃而不杀连接 —— 该次读取已经失败，块内容没有消费者。
      return
    }
    if (chunk.offset !== active.received) {
      this.activeRead = null
      active.reject(new HostProtocolError("CHUNK_OFFSET_MISMATCH", `块 offset ${chunk.offset} 与已收 ${active.received} 不连续`))
      return
    }
    active.parts.push(chunk.data)
    active.received += chunk.data.length
    // 收方消费即归还信用（等待而非丢弃的另一半）。
    this.sendControlFrame({
      protocolVersion: PROTOCOL_VERSION,
      kind: "control",
      payload: {
        payloadKind: "control",
        op: "credit",
        direction: "hostToNode",
        bytes: Math.max(chunk.data.length, 1),
      },
    })
    if (chunk.last) {
      this.activeRead = null
      if (active.received !== active.expectedBytes) {
        active.reject(
          new HostProtocolError(
            "BLOB_LENGTH_MISMATCH",
            `blob 声明 ${active.expectedBytes} 字节，实收 ${active.received}`,
          ),
        )
        return
      }
      active.resolve(new Uint8Array(Buffer.concat(active.parts)))
    }
  }

  // ── 关闭 ──

  private sendControlFrame(frame: WireFrame): void {
    if (this.closed) {
      throw new HostBridgeUnavailableError(`连接已关闭（${this.closeReason}）`)
    }
    this.controlQueue.enqueue(encodeFrame(frame, this.limits.controlFrameMaxBytes), "control")
  }

  private handleSocketClosed(reason: string): void {
    if (this.closed) return
    this.close(reason)
  }

  private failFatal(reason: string, error: unknown): void {
    if (this.closed) return
    const detail = error instanceof Error ? error.message : String(error)
    this.close(`${reason}: ${detail}`)
  }

  /** 本地关闭：失败全部 pending、唤醒等待者、销毁 socket。 */
  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    const error = new HostBridgeUnavailableError(`宿主通道已关闭：${reason}`)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const settler of this.uploadSettlers.values()) settler.reject(error)
    this.uploadSettlers.clear()
    if (this.activeRead) {
      const active = this.activeRead
      this.activeRead = null
      active.reject(error)
    }
    this.sendCredit.wakeAll()
    try {
      this.controlSocket.destroy()
    } catch {
      // 已销毁
    }
    try {
      this.binarySocket.destroy()
    } catch {
      // 已销毁
    }
    for (const handler of this.disconnectHandlers) {
      try {
        handler(reason)
      } catch {
        // 断开回调自身异常不阻断其它回调
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new HostBridgeUnavailableError(`宿主通道未就绪或已断开：${this.closeReason}`)
    }
  }
}

// ==========================================
// 辅助
// ==========================================

function validateWelcome(value: unknown): WelcomeInfo {
  const record = value as Partial<WelcomeInfo> | undefined
  if (
    !record ||
    typeof record !== "object" ||
    typeof record.protocolVersion !== "number" ||
    typeof record.appEpoch !== "string" ||
    typeof record.nodeEpoch !== "number" ||
    typeof record.appVersion !== "string" ||
    (record.runtimeMode !== "development" && record.runtimeMode !== "production") ||
    (record.platform !== "windows" && record.platform !== "macos") ||
    typeof record.limits !== "object" ||
    record.limits === null
  ) {
    throw new HostProtocolError("WELCOME_INVALID", "ServerWelcome 结构不完整")
  }
  const limits = record.limits as WelcomeInfo["limits"]
  if (
    !Number.isSafeInteger(limits.controlFrameMaxBytes) ||
    !Number.isSafeInteger(limits.blobChunkMaxBytes) ||
    !Number.isSafeInteger(limits.streamCreditBytes)
  ) {
    throw new HostProtocolError("WELCOME_INVALID", "ServerWelcome.limits 结构不完整")
  }
  if (record.protocolVersion !== PROTOCOL_VERSION) {
    throw new HostProtocolError(
      "PROTOCOL_VERSION_MISMATCH",
      `协议版本不一致：宿主 ${record.protocolVersion}，Node ${PROTOCOL_VERSION}`,
    )
  }
  return record as WelcomeInfo
}

function validateBlobRef(ref: HostBlobRef): void {
  if (
    !ref ||
    typeof ref.id !== "string" ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0 ||
    typeof ref.scope !== "object" ||
    ref.scope === null ||
    typeof ref.scope.appEpoch !== "string" ||
    !Number.isSafeInteger(ref.scope.nodeEpoch)
  ) {
    throw new HostProtocolError("BLOB_REF_INVALID", "HostBlobRef 结构不完整（句柄只能来自宿主签发）")
  }
}

/** 控制优先、普通其次的写队列：取消/关停不排在普通帧后面。 */
class PriorityWriteQueue {
  private readonly controlQueue: Buffer[] = []
  private readonly normalQueue: Buffer[] = []
  private pumping = false
  private dead = false

  constructor(
    private readonly socket: net.Socket,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(bytes: Buffer, priority: "control" | "normal"): void {
    if (this.dead) throw new HostBridgeUnavailableError("写队列已关闭（宿主通道已断开）")
    if (priority === "control") this.controlQueue.push(bytes)
    else this.normalQueue.push(bytes)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.dead) {
        const next = this.controlQueue.shift() ?? this.normalQueue.shift()
        if (!next) break
        await writeSocket(this.socket, next)
      }
    } catch (error) {
      this.dead = true
      this.onError(error)
    } finally {
      this.pumping = false
    }
  }
}

/** 发送侧信用额度：不足即等待（不静默丢弃），关闭时唤醒并返回 false。 */
class CreditGate {
  private remaining: number
  private readonly waiters: Array<() => void> = []

  constructor(initial: number) {
    this.remaining = initial
  }

  async take(bytes: number, isClosed: () => boolean): Promise<boolean> {
    const need = Math.max(bytes, 1)
    while (this.remaining < need) {
      if (isClosed()) return false
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    if (isClosed()) return false
    this.remaining -= need
    return true
  }

  grant(bytes: number): void {
    this.remaining += bytes
    this.flushWaiters()
  }

  wakeAll(): void {
    this.flushWaiters()
  }

  private flushWaiters(): void {
    const waiters = this.waiters.splice(0, this.waiters.length)
    for (const waiter of waiters) waiter()
  }
}

function connectSocket(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path)
    const onError = (error: Error) => {
      socket.off("connect", onConnect)
      reject(new HostBridgeUnavailableError(`端点连接失败（${path}）: ${error.message}`))
    }
    const onConnect = () => {
      // 保留 once("error")：握手期 socket 出错不能让 'error' 事件无监听者而炸进程；
      // 该监听器在手握手完成后的一次错误里自我注销（已 settled 的 reject 是空操作）。
      resolve(socket)
    }
    socket.once("error", onError)
    socket.once("connect", onConnect)
  })
}

function writeSocket(socket: net.Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * 握手期的按字节读取器：socket 的 data 分片不按调用者的读边界切，必须自己缓冲，
 * 余量在 `dispose()` 时交还（交给正常分帧器），不能丢。
 */
class SocketByteReader {
  private buffered: Buffer = Buffer.alloc(0)
  private readonly waiters: Array<() => void> = []
  private error: Error | null = null
  private closed = false
  private readonly onData = (chunk: Buffer) => {
    this.buffered = Buffer.concat([this.buffered, chunk])
    this.flush()
  }
  private readonly onError = (error: Error) => {
    this.error = error
    this.flush()
  }
  private readonly onClose = () => {
    this.closed = true
    this.flush()
  }

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData)
    socket.on("error", this.onError)
    socket.on("close", this.onClose)
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      if (this.error) throw this.error
      if (this.closed) throw new HostProtocolError("PEER_CLOSED", "握手期连接被关闭")
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    const out = Buffer.from(this.buffered.subarray(0, length))
    this.buffered = this.buffered.subarray(length)
    return out
  }

  /** 停止接管 socket，返回尚未消费的余量字节。 */
  dispose(): Buffer {
    this.socket.off("data", this.onData)
    this.socket.off("error", this.onError)
    this.socket.off("close", this.onClose)
    const leftover = this.buffered
    this.buffered = Buffer.alloc(0)
    return leftover
  }

  private flush(): void {
    const waiters = this.waiters.splice(0, this.waiters.length)
    for (const waiter of waiters) waiter()
  }
}

async function readOneFrame(reader: SocketByteReader, maxBytes: number): Promise<WireFrame> {
  const head = await reader.readExactly(4)
  const declared = head.readUInt32LE(0)
  if (declared > maxBytes) {
    throw new HostProtocolError("FRAME_TOO_LARGE", `握手帧长 ${declared} 超过引导上限 ${maxBytes}`)
  }
  const body = await reader.readExactly(declared)
  const frame = JSON.parse(body.toString("utf8")) as WireFrame
  assertFrame(frame)
  return frame
}
