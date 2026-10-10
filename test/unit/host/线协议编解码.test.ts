// ==========================================
// 私有 IPC 线协议（src/services/host/wire.ts）—— 字节布局与信封校验
// ==========================================
//
// 两侧（Rust ipc/protocol.rs 与 Node）不允许各存口头约定，坏帧必须当场失败：
// 这里断言的是「超限拒绝、坏 JSON 拒绝、信封不自洽拒绝、半帧不产出」——
// 每一条都对应一种「静默把坏数据交出去」的可能，改坏实现必红。
//
// 不覆盖真 socket（握手、分派、背压）—— 那需要真连接，留给 L4 / 后续宿主测试。

import { describe, expect, it } from "vitest"

import {
  BINARY_HEADER_BYTES,
  BINARY_PAYLOAD_OVERHEAD,
  BinaryChunkReader,
  BINARY_FLAG_LAST,
  ControlFrameReader,
  decodeFrameBody,
  encodeBinaryChunk,
  encodeFrame,
  FRAME_MAGIC,
  HANDSHAKE_STATUS_OK,
  parseHostBlobMarker,
  parseUploadMarker,
  PROTOCOL_VERSION,
  ROLE_BINARY,
  ROLE_CONTROL,
  uploadMarker,
  type RequestPayload,
  type WireFrame,
} from "@/services/host/wire"

/** 合法请求帧：坏帧用例在它之上做单点改动，其余字段保持可解析。 */
function requestFrame(overrides: Partial<WireFrame> = {}): WireFrame {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "request",
    requestId: 1,
    payload: { payloadKind: "request", method: "ping", args: {} },
    ...overrides,
  }
}

/** 绕过类型系统构造待校验的原始对象（校验器的输入就是 unknown，测试按线格式构造）。 */
function rawFrame(value: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8")
}

function requestIdOf(frame: WireFrame): number {
  return frame.requestId as number
}

function methodOf(frame: WireFrame): string {
  return (frame.payload as RequestPayload).method
}

describe("控制帧编解码", () => {
  it("encodeFrame/decodeFrameBody 往返保持字段，长度前缀是 u32 LE", () => {
    const frame = requestFrame({ requestId: 42, payload: { payloadKind: "request", method: "get_runtime_paths", args: { a: 1 } } })
    const encoded = encodeFrame(frame, 4096)
    expect(encoded.readUInt32LE(0)).toBe(encoded.length - 4)
    expect(decodeFrameBody(encoded.subarray(4))).toEqual(frame)
  })

  it("超过上限的帧拒绝发送，恰好等于上限放行", () => {
    const frame = requestFrame({ payload: { payloadKind: "request", method: "m".repeat(64), args: {} } })
    const bodyLength = Buffer.byteLength(JSON.stringify(frame), "utf8")
    expect(() => encodeFrame(frame, bodyLength - 1)).toThrowError(
      expect.objectContaining({ name: "HostProtocolError", code: "FRAME_TOO_LARGE" }),
    )
    expect(encodeFrame(frame, bodyLength)).toHaveLength(bodyLength + 4)
  })

  it("坏 JSON 与协议版本不一致分别以结构化错误拒绝", () => {
    expect(() => decodeFrameBody(Buffer.from("{not json", "utf8"))).toThrowError(
      expect.objectContaining({ name: "HostProtocolError", code: "FRAME_MALFORMED" }),
    )
    expect(() => decodeFrameBody(rawFrame({ ...requestFrame(), protocolVersion: PROTOCOL_VERSION + 1 }))).toThrowError(
      expect.objectContaining({ code: "PROTOCOL_VERSION_MISMATCH" }),
    )
  })

  it("信封 kind 与载荷 payloadKind 必须一致，request/response 必须带 requestId", () => {
    expect(() =>
      decodeFrameBody(rawFrame({ protocolVersion: PROTOCOL_VERSION, kind: "request", payload: { payloadKind: "response", ok: true } })),
    ).toThrowError(expect.objectContaining({ code: "FRAME_INVALID" }))
    expect(() =>
      decodeFrameBody(
        rawFrame({ protocolVersion: PROTOCOL_VERSION, kind: "request", payload: { payloadKind: "request", method: "ping", args: {} } }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FRAME_INVALID" }))
  })

  it("Response 的 ok/error 必须自洽：成功不得带错误、失败必须带错误", () => {
    const wire = (payload: Record<string, unknown>) =>
      rawFrame({ protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: 7, payload: { payloadKind: "response", ...payload } })
    expect(() => decodeFrameBody(wire({ ok: true, error: { code: "X", message: "不该出现" } }))).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    )
    expect(() => decodeFrameBody(wire({ ok: false }))).toThrowError(expect.objectContaining({ code: "FRAME_INVALID" }))
    expect(() => decodeFrameBody(wire({ ok: true, result: null }))).not.toThrow()
    expect(() => decodeFrameBody(wire({ ok: false, error: { code: "X", message: "失败" } }))).not.toThrow()
  })

  it("Event 帧必须带 scope，Control 帧不需要", () => {
    expect(() =>
      decodeFrameBody(
        rawFrame({ protocolVersion: PROTOCOL_VERSION, kind: "event", payload: { payloadKind: "event", event: "window-observed", seq: 1, payload: {} } }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FRAME_INVALID" }))
    const withScope = rawFrame({
      protocolVersion: PROTOCOL_VERSION,
      kind: "event",
      scope: { appEpoch: "e1", nodeEpoch: 1 },
      payload: { payloadKind: "event", event: "window-observed", seq: 1, payload: {} },
    })
    expect(decodeFrameBody(withScope).kind).toBe("event")
  })
})

describe("二进制帧", () => {
  it("encodeBinaryChunk 线格式：长度字段 = 9 + 数据长，末块位写在 flags 字节，超限拒绝", () => {
    const data = new Uint8Array([1, 2, 3, 4])
    const encoded = encodeBinaryChunk(7, true, data, 1024)
    expect(encoded).toHaveLength(BINARY_HEADER_BYTES + data.length)
    expect(encoded.readUInt32LE(0)).toBe(BINARY_PAYLOAD_OVERHEAD + data.length)
    expect(encoded.readBigUInt64LE(4)).toBe(7n)
    expect(encoded.readUInt8(12)).toBe(BINARY_FLAG_LAST)
    expect([...encoded.subarray(BINARY_HEADER_BYTES)]).toEqual([1, 2, 3, 4])

    expect(() => encodeBinaryChunk(0, false, new Uint8Array(33), 32)).toThrowError(
      expect.objectContaining({ code: "CHUNK_TOO_LARGE" }),
    )
  })

  it("offset 按 u64 LE 读出（不截成 u32），last 位独立于数据", () => {
    const reader = new BinaryChunkReader()
    const chunk = encodeBinaryChunk(2 ** 40 + 7, true, new Uint8Array([1]), 1024)
    const [decoded] = reader.push(chunk, 1024)
    expect(decoded!.offset).toBe(2 ** 40 + 7)
    expect(decoded!.last).toBe(true)
  })

  it("保留位、非法长度、超长块都如实拒绝", () => {
    const reader = new BinaryChunkReader()
    const reserved = encodeBinaryChunk(0, true, new Uint8Array([9]), 1024)
    reserved.writeUInt8(0x02, 12)
    expect(() => reader.push(reserved, 1024)).toThrowError(expect.objectContaining({ code: "CHUNK_INVALID" }))

    const tooShort = Buffer.alloc(BINARY_HEADER_BYTES)
    tooShort.writeUInt32LE(BINARY_PAYLOAD_OVERHEAD - 1, 0)
    expect(() => reader.push(Buffer.concat([tooShort, Buffer.alloc(BINARY_HEADER_BYTES)]), 1024)).toThrowError(
      expect.objectContaining({ code: "CHUNK_INVALID" }),
    )

    const tooLong = Buffer.alloc(BINARY_HEADER_BYTES)
    tooLong.writeUInt32LE(BINARY_PAYLOAD_OVERHEAD + 1024 + 1, 0)
    expect(() => reader.push(tooLong, 1024)).toThrowError(expect.objectContaining({ code: "CHUNK_INVALID" }))
  })

  it("零字节末块是合法块，半帧留在缓冲不产出", () => {
    const reader = new BinaryChunkReader()
    const empty = encodeBinaryChunk(0, true, new Uint8Array(0), 1024)
    expect(reader.push(empty.subarray(0, 5), 1024)).toEqual([])
    const [decoded] = reader.push(empty.subarray(5), 1024)
    expect(decoded).toMatchObject({ offset: 0, last: true })
    expect(decoded!.data).toHaveLength(0)
  })

  // 曾经是 `it.fails`：`BinaryChunkReader` 把长度字段当成「整帧长度」，而 Rust 权威口径
  // （`ipc/transport.rs` 的 encode_binary_chunk 与 `ipc/mod.rs` 的帧布局注释）是
  // 「前缀值 = 9 + data.len()，整帧 = 4 + 前缀值」—— 少算那 4 字节会让 data 截尾、缓冲
  // 错位。该缺陷**实际发生过**：`pnpm dev` 里 Node 读出垃圾长度 171454000 → CHUNK_INVALID
  // → Node 退出码 71 崩溃循环。已修（`wire.ts` 的 `BINARY_PREFIX_BYTES`），本条翻回普通断言。
  it("非空块的 data 完整解出且缓冲精确消费", () => {
    const reader = new BinaryChunkReader()
    const chunk = encodeBinaryChunk(0, true, new Uint8Array([1, 2, 3, 4]), 1024)
    const [decoded] = reader.push(chunk, 1024)
    expect([...decoded!.data]).toEqual([1, 2, 3, 4])

    // 跨 chunk 到达时同样只能消费整帧：剩余 4 字节不得被当成下一帧的长度前缀
    const splitReader = new BinaryChunkReader()
    expect(splitReader.push(chunk.subarray(0, 7), 1024)).toEqual([])
    const [second] = splitReader.push(chunk.subarray(7), 1024)
    expect([...second!.data]).toEqual([1, 2, 3, 4])
  })
})

describe("增量分帧器", () => {
  it("控制通道：一次推入多帧全部解出，半帧留在缓冲、补齐后才产出", () => {
    const reader = new ControlFrameReader()
    const first = encodeFrame(requestFrame({ requestId: 11 }), 4096)
    const second = encodeFrame(requestFrame({ requestId: 12 }), 4096)

    const both = reader.push(Buffer.concat([first, second]), 4096)
    expect(both.map(requestIdOf)).toEqual([11, 12])

    expect(reader.push(first.subarray(0, 3), 4096)).toEqual([])
    expect(reader.push(first.subarray(3, 6), 4096)).toEqual([])
    const decoded = reader.push(first.subarray(6), 4096)
    expect(decoded.map(frame => methodOf(frame))).toEqual(["ping"])
  })

  it("对端声明超长帧立即抛错，且缓冲不清空（连接不可继续）", () => {
    const reader = new ControlFrameReader()
    const head = Buffer.alloc(4)
    head.writeUInt32LE(2048, 0)
    expect(() => reader.push(head, 1024)).toThrowError(
      expect.objectContaining({ name: "HostProtocolError", code: "FRAME_TOO_LARGE" }),
    )
    // 若实现把缓冲清掉后继续收下一段，坏帧会被静默跳过 —— 第二次必须仍拒绝。
    expect(() => reader.push(Buffer.alloc(0), 1024)).toThrowError(expect.objectContaining({ code: "FRAME_TOO_LARGE" }))
  })
})

describe("blob 标记的严格形状", () => {
  it("宿主 blob 标记只在形状完整时被识别，编码字段缺省为字节语义", () => {
    const ref = { id: "b-1", bytes: 3, scope: { appEpoch: "e", nodeEpoch: 2 } }
    expect(parseHostBlobMarker({ $hostBlobRef: ref })).toEqual({ ref, encoding: "bytes" })
    expect(parseHostBlobMarker({ $hostBlobRef: ref, $blobEncoding: "utf8" })).toEqual({ ref, encoding: "utf8" })
    expect(parseHostBlobMarker({ $hostBlobRef: ref, $blobEncoding: "json" })).toEqual({ ref, encoding: "json" })
    expect(() => parseHostBlobMarker({ $hostBlobRef: ref, $blobEncoding: "yaml" })).toThrowError(
      expect.objectContaining({ name: "HostProtocolError", code: "BLOB_ENCODING_INVALID" }),
    )
    expect(parseHostBlobMarker({ $hostBlobRef: { id: 7, bytes: 3, scope: {} } })).toBeNull()
    expect(parseHostBlobMarker({ $hostBlobRef: "not-an-object" })).toBeNull()
    expect(parseHostBlobMarker([ref])).toBeNull()
  })

  it("上传标记只认恰好 id+kind 两个字段，多字段同名不误伤", () => {
    expect(parseUploadMarker(uploadMarker("blob-9", "text"))).toEqual({ id: "blob-9", kind: "text" })
    expect(parseUploadMarker({ $wireBlob: { id: "blob-9", kind: "text", extra: 1 } })).toBeNull()
    expect(parseUploadMarker({ $wireBlob: { id: "blob-9", kind: "file" } })).toBeNull()
    expect(parseUploadMarker({ $wireBlob: { kind: "text" } })).toBeNull()
    expect(parseUploadMarker({ $wireBlob: { id: "blob-9", kind: "bytes" } })).toEqual({ id: "blob-9", kind: "bytes" })
    expect(parseUploadMarker(uploadMarker("blob-json", "json"))).toEqual({ id: "blob-json", kind: "json" })
  })
})

describe("协议常量", () => {
  it("角色字节、魔数与二进制帧头长度两侧同源（改一侧即协议破裂）", () => {
    expect(ROLE_CONTROL).toBe(1)
    expect(ROLE_BINARY).toBe(2)
    expect([...FRAME_MAGIC]).toEqual([0x44, 0x53, 0x50, 0x4b])
    expect(BINARY_HEADER_BYTES).toBe(13)
    expect(BINARY_PAYLOAD_OVERHEAD).toBe(9)
    expect(BINARY_FLAG_LAST).toBe(1)
    expect(HANDSHAKE_STATUS_OK).toBe(0)
  })
})
