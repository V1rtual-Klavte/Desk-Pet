import { describe, expect, it, vi } from "vitest"
import { HostConnection } from "@/services/host/connection"
import { decodeFrameBody, type WireFrame } from "@/services/host/wire"

function connection(maxBytes: number) {
  const sent: Buffer[] = []
  const uploaded: Array<{ bytes: Buffer; kind: string }> = []
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const instance = Object.create(HostConnection.prototype) as HostConnection
  Object.assign(instance, {
    welcome: { appEpoch: "app", nodeEpoch: 9, limits: { controlFrameMaxBytes: maxBytes, blobChunkMaxBytes: 4096, streamCreditBytes: 8192 } },
    closed: false,
    closeReason: "",
    nextRequestId: 1,
    pending,
    controlQueue: {
      enqueue: (frame: Buffer) => {
        sent.push(frame)
        const decoded = decodeFrameBody(frame.subarray(4))
        const requestId = decoded.requestId!
        pending.get(requestId)?.resolve({ accepted: true })
      },
    },
    uploadBlob: vi.fn(async (job: { bytes: Buffer; kind: string }, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason
      uploaded.push(job)
      return `blob-${uploaded.length}`
    }),
  })
  return { instance, sent, uploaded }
}

function sentFrame(sent: Buffer[]): WireFrame {
  expect(sent).toHaveLength(1)
  return decodeFrameBody(sent[0]!.subarray(4))
}

describe("HostConnection 自动聚合请求 blob", () => {
  it("按完整 UTF-8 信封精确计量；多组小字段合并超限时上传完整参数 JSON [host-request-json-blob-frame]", async () => {
    const args = {
      items: Array.from({ length: 24 }, (_, index) => ({ index, text: `第${index}项\n\"` + "a".repeat(90) })),
      unicode: "你好🙂".repeat(18),
      bytes: Uint8Array.from([0, 1, 127, 128, 255]),
    }
    const normalized = { ...args, bytes: Array.from(args.bytes) }
    const roomy = connection(32_768)
    await roomy.instance.request("ping", args)
    const directFrame = sentFrame(roomy.sent)
    const directBody = Buffer.from(JSON.stringify(directFrame), "utf8")
    expect(directBody.length).toBeLessThanOrEqual(32_768)
    expect(directFrame.requestId).toBe(1)
    expect((directFrame.payload as { args: unknown }).args).toEqual(normalized)
    expect(roomy.uploaded).toHaveLength(0)

    const tight = connection(directBody.length - 1)
    await tight.instance.request("ping", args)
    const frame = sentFrame(tight.sent)
    const encodedBody = tight.sent[0]!.subarray(4)
    expect(encodedBody.length).toBeLessThanOrEqual(directBody.length - 1)
    expect(frame.requestId).toBe(1)
    expect(frame.scope).toEqual({ appEpoch: "app", nodeEpoch: 9 })
    const requestArgs = (frame.payload as { args: Record<string, unknown> }).args
    expect(requestArgs).toEqual({ $wireBlob: { id: "blob-1", kind: "json" } })
    expect(tight.uploaded).toHaveLength(1)
    expect(tight.uploaded[0]!.kind).toBe("json")
    expect(tight.uploaded[0]!.bytes.toString("utf8")).toBe(JSON.stringify(normalized))
    expect(JSON.parse(tight.uploaded[0]!.bytes.toString("utf8"))).toEqual(normalized)
  })

  it("保留 Uint8Array 原始 bytes 上传，并在 JSON blob 内引用同一 marker [host-request-json-blob-bytes]", async () => {
    const binary = Uint8Array.from({ length: 5_000 }, (_, index) => index % 256)
    const direct = connection(1_024)
    await direct.instance.request("ping", { binary })
    const directArgs = (sentFrame(direct.sent).payload as { args: Record<string, unknown> }).args
    expect(direct.uploaded).toHaveLength(1)
    expect(direct.uploaded[0]!.kind).toBe("bytes")
    expect(direct.uploaded[0]!.bytes).toEqual(Buffer.from(binary))
    expect(directArgs.binary).toEqual({ $wireBlob: { id: "blob-1", kind: "bytes" } })

    const aggregate = connection(1_024)
    await aggregate.instance.request("ping", { binary, text: "x".repeat(3_000) })
    const requestArgs = (sentFrame(aggregate.sent).payload as { args: Record<string, unknown> }).args
    expect(aggregate.uploaded.map(upload => upload.kind)).toEqual(["bytes", "json"])
    expect(JSON.parse(aggregate.uploaded[1]!.bytes.toString("utf8"))).toEqual({
      binary: { $wireBlob: { id: "blob-1", kind: "bytes" } },
      text: "x".repeat(3_000),
    })
    expect(requestArgs).toEqual({ $wireBlob: { id: "blob-2", kind: "json" } })
  })

  it("保留 Date 和自定义 toJSON 序列化结果 [host-request-json-blob-json-semantics]", async () => {
    const toJSONKeys: string[] = []
    const args = {
      date: new Date("2026-10-10T00:00:00.000Z"),
      custom: {
        toJSON(key: string) {
          toJSONKeys.push(key)
          return { property: key, value: "serialized" }
        },
      },
      text: "large enough to use the JSON blob path ".repeat(50),
    }
    const conn = connection(512)
    await conn.instance.request("ping", args)
    expect(JSON.parse(conn.uploaded[0]!.bytes.toString("utf8"))).toEqual({
      date: "2026-10-10T00:00:00.000Z",
      custom: { property: "custom", value: "serialized" },
      text: args.text,
    })
    expect(toJSONKeys).toEqual(["custom"])
  })

  it("上传中取消立即拒绝，晚完成的句柄随后 release 且不发送业务请求 [host-request-json-blob-late-cleanup]", async () => {
    const controller = new AbortController()
    const conn = connection(512)
    let finishUpload!: (blobId: string) => void
    const uploadStarted = vi.fn()
    // Exercise the production uploadBlob wrapper: this object bypasses field
    // initializers, so initialize its queue and remove the helper's upload stub.
    Reflect.deleteProperty(conn.instance, "uploadBlob")
    Object.assign(conn.instance, {
      uploadTail: Promise.resolve(),
      log: { warn: vi.fn() },
      performUpload: vi.fn(() => {
        uploadStarted()
        return new Promise<string>(resolve => { finishUpload = resolve })
      }),
    })
    const request = conn.instance.request("ping", { text: "large".repeat(300) }, { signal: controller.signal })
    await Promise.resolve()
    expect(uploadStarted).toHaveBeenCalledOnce()
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: "CANCELLED" })
    expect(conn.sent).toHaveLength(0)

    finishUpload("late-blob")
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    const cleanup = conn.sent.map(frame => decodeFrameBody(frame.subarray(4)))
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]!.payload).toMatchObject({ method: "blob_release", args: { blobId: "late-blob" } })
  })

  it("入队失败后清理已上传句柄且仍拒绝原始错误 [host-request-json-blob-enqueue-cleanup]", async () => {
    const conn = connection(512)
    const enqueueFailure = new Error("queue closed")
    const originalQueue = (conn.instance as unknown as { controlQueue: { enqueue(frame: Buffer, priority?: "normal" | "control"): void } }).controlQueue
    let first = true
    Object.assign(conn.instance, {
      uploadBlob: vi.fn(async () => "orphan-blob"),
      controlQueue: {
        enqueue(frame: Buffer, priority?: "normal" | "control") {
          if (first) {
            first = false
            throw enqueueFailure
          }
          originalQueue.enqueue(frame, priority)
        },
      },
    })
    await expect(conn.instance.request("ping", { text: "large".repeat(300) })).rejects.toBe(enqueueFailure)
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    const cleanup = conn.sent.map(frame => decodeFrameBody(frame.subarray(4)))
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]!.payload).toMatchObject({ method: "blob_release", args: { blobId: "orphan-blob" } })
  })

  it("发送前取消不上传也不发送请求帧 [host-request-json-blob-cancel]", async () => {
    const alreadyCancelled = new AbortController()
    const before = connection(1024)
    alreadyCancelled.abort(new Error("before send"))
    await expect(before.instance.request("ping", { x: "large" }, { signal: alreadyCancelled.signal })).rejects.toMatchObject({ code: "CANCELLED" })
    expect(before.sent).toHaveLength(0)
    expect(before.uploaded).toHaveLength(0)
  })
})
