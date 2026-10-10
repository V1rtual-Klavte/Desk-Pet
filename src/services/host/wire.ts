// ==========================================
// 私有 IPC 的线协议（字节布局）
// ==========================================
//
// **唯一权威是 Rust 侧 `crates/native-host/src/ipc/mod.rs` 的模块文档与
// `ipc/protocol.rs` 的常量**。本文件是它在 Node 侧的实现，两侧不允许各存口头约定：
// - 结构性常量（角色字节、魔数、帧头长度）两侧同源，都在代码里写死；
// - 流控常量（控制帧上限/块上限/信用）**只从 ServerWelcome.limits 取**，
//   本文件不提供任何默认值。
//
// 帧布局（控制通道，双向）：
//   u32 LE payload_len | payload（UTF-8 JSON）
// 帧布局（二进制通道，双向）：
//   u32 LE payload_len | u64 LE offset | u8 flags | data
//   payload_len = 9 + data.len()；flags bit0 = 末块；其余位保留必须为 0。
//
// 信封：FrameHeader 的字段平铺 + payload；payload.payloadKind 必须与 kind 一致。

import type { HostBlobRef, RunScope } from "./types"

export const PROTOCOL_VERSION = 1

/** 角色字节之后、正式分帧之前的固定魔数 "DSPK"。 */
export const FRAME_MAGIC = Buffer.from([0x44, 0x53, 0x50, 0x4b])

export const ROLE_CONTROL = 0x01
export const ROLE_BINARY = 0x02

export const BINARY_FLAG_LAST = 0x01
/** 长度前缀本身的字节数：整帧 = `BINARY_PREFIX_BYTES + payloadLen`。 */
export const BINARY_PREFIX_BYTES = 4
/** 固定头总长 = 前缀 4 + offset 8 + flags 1（数据从这一位开始）。 */
export const BINARY_HEADER_BYTES = 13
/** 长度字段覆盖的部分 = offset 8 + flags 1（**不含**前缀自身）。 */
export const BINARY_PAYLOAD_OVERHEAD = 9

/** 二进制握手 token 的长度上限（与宿主一致，防超长分配）。 */
export const MAX_HANDSHAKE_TOKEN_BYTES = 1024

/** 二进制握手回包状态（与宿主 `HANDSHAKE_*` 常量同值）。 */
export const HANDSHAKE_STATUS_OK = 0
export const HANDSHAKE_STATUS_UNAUTHORIZED = 1
export const HANDSHAKE_STATUS_NO_CONTROL = 2
export const HANDSHAKE_STATUS_ALREADY_USED = 3

/**
 * 握手期解析欢迎帧的引导护栏。
 *
 * **这不是协议限额的第二份默认值**：ServerWelcome.limits 才是限额的唯一来源；
 * 这里只是「还没拿到限额之前，防止对端用巨型长度撑爆连接」的引导上限，
 * 拿到 welcome 之后一律使用它披露的 controlFrameMaxBytes。
 */
export const BOOTSTRAP_FRAME_GUARD_BYTES = 1024 * 1024

/** Node 上传一个 blob 后等宿主受理/登记的期限（无回应由断线兜底）。 */
export const UPLOAD_SETTLE_TIMEOUT_MS = 60_000

// ── 结构化错误（`errorCode()` 能识别 code；带 stack 便于留痕）──
//
// `HostBridgeUnavailableError` 的公开形状冻结在 `index.ts`（W0），那里只是再导出；
// 定义放在本文件是为了让 connection.ts 也能抛它而不形成模块环。

/**
 * 宿主通道未就绪时抛（尚未握手、握手失败、连接断开、Node 监督器正在重启……）。
 *
 * **不允许用它做静默降级**：等待/重连必须显式（重试或向上失败），故障提示保持中性。
 */
export class HostBridgeUnavailableError extends Error {
  constructor(message = "宿主通道未就绪：HostBridge 尚未握手或已断开。") {
    super(message)
    this.name = "HostBridgeUnavailableError"
  }
}

/** 宿主命令失败：code 与 Rust `AppError::code()`/WireError 同表，不许降级成字符串。 */
export class HostCommandError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "HostCommandError"
    this.code = code
  }
}

/** 线协议被违反（超长帧、坏 JSON、错序分帧）：连接不可继续（也是通道不可用）。 */
export class HostProtocolError extends HostBridgeUnavailableError {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "HostProtocolError"
    this.code = code
  }
}

// ── 信封类型（与 ipc/protocol.rs / transport.rs 逐字段对齐）──

export interface WireError {
  code: string
  message: string
}

export type FrameKind = "request" | "response" | "event" | "control"
export type PayloadKind = "request" | "response" | "event" | "control"

export interface RequestPayload {
  payloadKind: "request"
  method: string
  args: unknown
  deadlineMs?: number
}

export interface ResponsePayload {
  payloadKind: "response"
  ok: boolean
  result?: unknown
  error?: WireError
}

export interface EventPayload {
  payloadKind: "event"
  event: string
  seq: number
  payload: unknown
}

export interface ControlPayload {
  payloadKind: "control"
  op: string
  [key: string]: unknown
}

export type WirePayload = RequestPayload | ResponsePayload | EventPayload | ControlPayload

export interface WireFrame {
  protocolVersion: number
  kind: FrameKind
  requestId?: number
  scope?: RunScope
  payload: WirePayload
}

export interface ServerWelcome {
  protocolVersion: number
  appEpoch: string
  nodeEpoch: number
  appVersion: string
  runtimeMode: "development" | "production"
  platform: "windows" | "macos"
  limits: {
    controlFrameMaxBytes: number
    blobChunkMaxBytes: number
    streamCreditBytes: number
  }
}

export interface ClientHello {
  protocolVersion: number
  handshake: string
  nodeVersion: string
}

// ── 编解码 ──

export function encodeFrame(frame: WireFrame, maxBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8")
  if (body.length > maxBytes) {
    throw new HostProtocolError(
      "FRAME_TOO_LARGE",
      `控制帧 ${body.length} 字节超过上限 ${maxBytes}：拒绝发送（大内容必须编码为 blob）`,
    )
  }
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/** 解析并校验一个帧体（不含长度前缀）。 */
export function decodeFrameBody(body: Buffer): WireFrame {
  let frame: WireFrame
  try {
    frame = JSON.parse(body.toString("utf8")) as WireFrame
  } catch (error) {
    throw new HostProtocolError("FRAME_MALFORMED", `帧 JSON 解析失败: ${String(error)}`)
  }
  assertFrame(frame)
  return frame
}

export function assertFrame(frame: WireFrame): void {
  if (frame.protocolVersion !== PROTOCOL_VERSION) {
    throw new HostProtocolError(
      "PROTOCOL_VERSION_MISMATCH",
      `协议版本不一致：对端 ${String(frame.protocolVersion)}，本端 ${PROTOCOL_VERSION}`,
    )
  }
  const kind = frame.kind
  const payloadKind = frame.payload?.payloadKind
  if (kind !== payloadKind) {
    throw new HostProtocolError("FRAME_INVALID", `信封 kind=${String(kind)} 与载荷 ${String(payloadKind)} 不匹配`)
  }
  if (kind === "request" || kind === "response") {
    if (!Number.isSafeInteger(frame.requestId)) {
      throw new HostProtocolError("FRAME_INVALID", `${kind} 帧缺少 requestId`)
    }
  }
  if (kind === "response") {
    const payload = frame.payload as ResponsePayload
    if (payload.ok ? payload.error !== undefined : payload.error === undefined) {
      throw new HostProtocolError("FRAME_INVALID", "Response 帧的 ok/error 不自洽")
    }
  }
  if (kind === "event" && !frame.scope) {
    throw new HostProtocolError("FRAME_INVALID", "Event 帧缺少 scope")
  }
}

export function encodeBinaryChunk(offset: number, last: boolean, data: Uint8Array, chunkMax: number): Buffer {
  if (data.length > chunkMax) {
    throw new HostProtocolError(
      "CHUNK_TOO_LARGE",
      `二进制块 ${data.length} 字节超过上限 ${chunkMax}`,
    )
  }
  const out = Buffer.alloc(BINARY_HEADER_BYTES + data.length)
  out.writeUInt32LE(BINARY_PAYLOAD_OVERHEAD + data.length, 0)
  out.writeBigUInt64LE(BigInt(offset), 4)
  out.writeUInt8(last ? BINARY_FLAG_LAST : 0, 12)
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, BINARY_HEADER_BYTES)
  return out
}

export interface DecodedChunk {
  offset: number
  last: boolean
  data: Buffer
}

// ── 增量分帧器（socket 'data' 分片到达，必须自己拼）──

/** 控制通道分帧器：长度前缀 + JSON，超限/错序立刻抛（连接不可继续）。 */
export class ControlFrameReader {
  private buffered: Buffer = Buffer.alloc(0)

  push(chunk: Buffer, maxBytes: number): WireFrame[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    const frames: WireFrame[] = []
    for (;;) {
      if (this.buffered.length < 4) break
      const declared = this.buffered.readUInt32LE(0)
      if (declared > maxBytes) {
        throw new HostProtocolError(
          "FRAME_TOO_LARGE",
          `对端声明帧长 ${declared} 超过上限 ${maxBytes}：拒绝且不截断（连接关闭）`,
        )
      }
      if (this.buffered.length < 4 + declared) break
      const body = this.buffered.subarray(4, 4 + declared)
      this.buffered = this.buffered.subarray(4 + declared)
      frames.push(decodeFrameBody(Buffer.from(body)))
    }
    return frames
  }
}

/** 二进制通道分帧器。 */
export class BinaryChunkReader {
  private buffered: Buffer = Buffer.alloc(0)

  push(chunk: Buffer, chunkMax: number): DecodedChunk[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    const chunks: DecodedChunk[] = []
    for (;;) {
      if (this.buffered.length < BINARY_HEADER_BYTES) break
      const payloadLen = this.buffered.readUInt32LE(0)
      const maxPayload = BINARY_PAYLOAD_OVERHEAD + chunkMax
      if (payloadLen < BINARY_PAYLOAD_OVERHEAD || payloadLen > maxPayload) {
        throw new HostProtocolError(
          "CHUNK_INVALID",
          `二进制帧长度 ${payloadLen} 非法（上限 ${maxPayload}）`,
        )
      }
      // 长度字段**只覆盖** offset+flags+data（= 9 + 数据字节数），不含它自己的 4 字节前缀，
      // 所以整帧 = 4 + payloadLen（与 Rust `ipc/transport.rs` 的 `encode_binary_chunk` 对齐：
      // 先写 `payload_len = BINARY_PAYLOAD_OVERHEAD + data.len()`，再写 offset/flags/data）。
      // 把 payloadLen 当整帧长度会**每帧少读 4 字节**：data 被截尾、缓冲错位、帧完成判定提前。
      const frameLen = BINARY_PREFIX_BYTES + payloadLen
      if (this.buffered.length < frameLen) break
      const flags = this.buffered.readUInt8(12)
      if ((flags & ~BINARY_FLAG_LAST) !== 0) {
        throw new HostProtocolError("CHUNK_INVALID", `二进制帧 flags 含保留位: 0x${flags.toString(16)}`)
      }
      const offset = Number(this.buffered.readBigUInt64LE(4))
      const data = Buffer.from(this.buffered.subarray(BINARY_HEADER_BYTES, frameLen))
      this.buffered = this.buffered.subarray(frameLen)
      chunks.push({ offset, last: (flags & BINARY_FLAG_LAST) !== 0, data })
    }
    return chunks
  }
}

// ── blob 物化标记（与 ipc/blob.rs 的 HOST_BLOB_MARKER_KEY / BLOB_ENCODING_KEY 同值）──

export const HOST_BLOB_MARKER_KEY = "$hostBlobRef"
export const BLOB_ENCODING_KEY = "$blobEncoding"
export const UPLOAD_MARKER_KEY = "$wireBlob"

export interface ParsedHostBlobMarker {
  ref: HostBlobRef
  /** 缺省即字节语义；utf8/json 分别还原字符串与完整 JSON 值。 */
  encoding: "utf8" | "bytes" | "json"
}

/** 识别结果里的宿主 blob 标记（严格形状：标记键的值必须是合法 HostBlobRef）。 */
export function parseHostBlobMarker(value: unknown): ParsedHostBlobMarker | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const raw = record[HOST_BLOB_MARKER_KEY]
  if (typeof raw !== "object" || raw === null) return null
  const ref = raw as HostBlobRef
  if (typeof ref.id !== "string" || typeof ref.bytes !== "number" || typeof ref.scope !== "object") return null
  const encodingRaw = record[BLOB_ENCODING_KEY]
  if (encodingRaw !== undefined && encodingRaw !== "utf8" && encodingRaw !== "bytes" && encodingRaw !== "json") {
    throw new HostProtocolError("BLOB_ENCODING_INVALID", `不支持的 blob 编码: ${String(encodingRaw)}`)
  }
  const encoding = encodingRaw ?? "bytes"
  return { ref, encoding }
}

export function uploadMarker(blobId: string, kind: "text" | "bytes" | "json"): Record<string, unknown> {
  return { [UPLOAD_MARKER_KEY]: { id: blobId, kind } }
}

export interface ParsedUploadMarker {
  id: string
  kind: "text" | "bytes" | "json"
}

/** 参数里的上传标记（严格形状，多字段即不识别，避免同名误伤）。 */
export function parseUploadMarker(value: unknown): ParsedUploadMarker | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const inner = (value as Record<string, unknown>)[UPLOAD_MARKER_KEY]
  if (typeof inner !== "object" || inner === null) return null
  const record = inner as Record<string, unknown>
  if (Object.keys(record).length !== 2) return null
  if (typeof record.id !== "string") return null
  if (record.kind !== "text" && record.kind !== "bytes" && record.kind !== "json") return null
  return { id: record.id, kind: record.kind }
}
