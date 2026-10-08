import { afterEach, describe, expect, it, vi } from "vitest"

const loggerMocks = vi.hoisted(() => {
  // setupFiles 先装宿主桥；重新加载本文件的真实 bridge，让它使用本测试的日志端口。
  vi.resetModules()
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
})

vi.mock("@/services/logger", () => ({ createLogger: () => loggerMocks }))

import {
  setExecutionPathKit,
  setHostBridge,
  setHostEnvironment,
  setUiEventPublisher,
  setUiReceiptSource,
} from "@/services/host"
import { HostBridgeImpl } from "@/services/host/bridge"
import type { HostConnection } from "@/services/host/connection"
import type { HostBlobRef } from "@/services/host/types"

type BlobRead = (ref: HostBlobRef, options?: { signal?: AbortSignal }) => Promise<Uint8Array>
type BlobRelease = (ref: HostBlobRef) => Promise<void>

function marker(id: string, encoding?: "utf8" | "bytes"): Record<string, unknown> {
  return {
    $hostBlobRef: { id, bytes: 10, scope: {} },
    ...(encoding ? { $blobEncoding: encoding } : {}),
  }
}

function bridgeFor(
  result: unknown,
  initiallyOpenHandles: readonly string[],
  read: BlobRead = async () => new Uint8Array(),
  release: BlobRelease = async () => {},
) {
  const openHandles = new Set(initiallyOpenHandles)
  const reads: Array<{ ref: HostBlobRef; options?: { signal?: AbortSignal } }> = []
  const releases: HostBlobRef[] = []
  const connection = {
    runtimeMode: "development",
    platform: "macos",
    request: async () => result,
    readBlob: async (ref: HostBlobRef, options?: { signal?: AbortSignal }) => {
      reads.push({ ref, options })
      return read(ref, options)
    },
    releaseBlob: async (ref: HostBlobRef) => {
      releases.push(ref)
      await release(ref)
      openHandles.delete(ref.id)
    },
    publishEvent: () => {},
    subscribe: () => () => {},
  } as unknown as HostConnection

  return { bridge: new HostBridgeImpl(connection), openHandles, reads, releases }
}

afterEach(() => {
  vi.clearAllMocks()
  setHostBridge(null)
  setHostEnvironment(null)
  setExecutionPathKit(null)
  setUiEventPublisher(null)
  setUiReceiptSource(null)
})

describe("HostBridge 自动 blob 物化", () => {
  it("保留嵌套字节与 UTF-8 原值，并在物化后归还全部句柄 [host-blob-materialize-release]", async () => {
    const signal = new AbortController().signal
    const { bridge, openHandles, reads, releases } = bridgeFor({
      bytes: marker("bytes"),
      nested: [{ text: marker("text", "utf8") }, { repeatedBytes: marker("bytes") }],
    }, ["bytes", "text"], async ref => ref.id === "bytes" ? Uint8Array.from([0, 255, 65]) : Buffer.from("你好", "utf8"))

    const result = await bridge.request("get_runtime_paths", {}, { signal })

    expect(result).toEqual({
      bytes: Uint8Array.from([0, 255, 65]),
      nested: [{ text: "你好" }, { repeatedBytes: Uint8Array.from([0, 255, 65]) }],
    })
    expect(reads.map(read => read.ref.id)).toEqual(["bytes", "text", "bytes"])
    expect(reads.every(read => read.options?.signal === signal)).toBe(true)
    expect(releases.map(ref => ref.id)).toEqual(["bytes", "text"])
    expect(openHandles.size).toBe(0)
  })

  it("读取失败时仍归还句柄，且归还失败留痕但不覆盖读取错误 [host-blob-read-failure-release]", async () => {
    const readFailure = new Error("blob read failed")
    const sibling = bridgeFor({ items: [marker("first"), marker("unread-sibling")] }, ["first", "unread-sibling"], async () => {
      throw readFailure
    })

    await expect(sibling.bridge.request("get_runtime_paths", {})).rejects.toBe(readFailure)

    expect(sibling.reads.map(read => read.ref.id)).toEqual(["first"])
    expect(sibling.releases.map(ref => ref.id)).toEqual(["first", "unread-sibling"])
    expect(sibling.openHandles.size).toBe(0)

    const releaseFailure = new Error("blob release failed")
    const { bridge, openHandles, releases } = bridgeFor(
      marker("broken"),
      ["broken"],
      async () => { throw readFailure },
      async () => { throw releaseFailure },
    )

    await expect(bridge.request("get_runtime_paths", {})).rejects.toBe(readFailure)

    expect(releases.map(ref => ref.id)).toEqual(["broken"])
    expect(openHandles).toEqual(new Set(["broken"]))
    expect(loggerMocks.warn).toHaveBeenCalledWith("自动物化后归还 blob 句柄失败", releaseFailure)
  })

  it("读取成功但归还失败时拒绝请求，不把未归还当成成功 [host-blob-release-failure]", async () => {
    const releaseFailure = new Error("blob release failed")
    const { bridge, openHandles, releases } = bridgeFor(
      marker("leaked"),
      ["leaked"],
      async () => Uint8Array.from([7]),
      async () => { throw releaseFailure },
    )

    await expect(bridge.request("get_runtime_paths", {})).rejects.toBe(releaseFailure)

    expect(releases.map(ref => ref.id)).toEqual(["leaked"])
    expect(openHandles).toEqual(new Set(["leaked"]))
  })

  it("取消信号传入读取后仍归还句柄，并保留取消错误 [host-blob-materialize-cancel]", async () => {
    const controller = new AbortController()
    const cancelled = new Error("cancelled")
    controller.abort(cancelled)
    const { bridge, openHandles, reads, releases } = bridgeFor(
      marker("cancelled"),
      ["cancelled"],
      async (_ref, options) => { throw options?.signal?.reason },
    )

    await expect(bridge.request("get_runtime_paths", {}, { signal: controller.signal })).rejects.toBe(cancelled)

    expect(reads[0]?.options?.signal).toBe(controller.signal)
    expect(releases.map(ref => ref.id)).toEqual(["cancelled"])
    expect(openHandles.size).toBe(0)
  })
})
