// ==========================================
// HostBridge 实现（公开形状在 index.ts 冻结，这里只实现）
// ==========================================
//
// 职责边界：
// - 线协议与连接在 connection.ts / wire.ts；本文件把连接包装成冻结的 HostBridge，
//   并完成**结果物化**：结果里的 `$hostBlobRef` 标记自动经二进制通道取回，
//   文本按完整字符串、字节按 `Uint8Array` 还原 —— 应用层 result 类型不缩水。
// - 失败一律是结构化 `HostCommandError { code, message }`（`errorCode()` 可识别），
//   不允许把宿主错误降级成字符串。
//
// 运行期附加面（`HostBridgeRuntime`）只多生命周期与事件发布入口，不动冻结的 HostBridge。

import type { HostBlobRef, HostCommandMap, HostEventMap, RunScope } from "./types"
import { HostConnection, readLaunchInfo, type FlushReport, type LaunchInfo } from "./connection"
import { HOST_BLOB_MARKER_KEY, HostProtocolError, parseHostBlobMarker } from "./wire"
import { installNodeHostPorts } from "./node-ports"

export type { FlushReport, LaunchInfo } from "./connection"

export interface HostBridgeRuntimeOptions {
  /** 显式传入启动信息；缺省从受控启动信息（环境变量）读取。 */
  launch?: LaunchInfo
  /** 覆盖上报的 Node 版本（默认 `process.versions.node`）。 */
  nodeVersion?: string
}

export interface HostBridgeRuntime {
  request<K extends keyof HostCommandMap>(
    method: K,
    args: HostCommandMap[K]["args"],
    options?: { signal?: AbortSignal; scope?: RunScope },
  ): Promise<HostCommandMap[K]["result"]>
  subscribe<K extends keyof HostEventMap>(
    event: K,
    listener: (payload: HostEventMap[K]) => void,
  ): () => void
  readBlob(ref: HostBlobRef, options?: { signal?: AbortSignal }): Promise<Uint8Array>
  releaseBlob(ref: HostBlobRef): Promise<void>

  readonly appEpoch: string
  readonly nodeEpoch: number
  readonly platform: "windows" | "macos"
  readonly runtimeMode: "development" | "production"
  readonly limits: {
    controlFrameMaxBytes: number
    blobChunkMaxBytes: number
    streamCreditBytes: number
  }
  /** 把 Node 领域事件推给宿主（`HostEventMap` 的 Node 生产者侧；W4 接线）。 */
  publishEvent(event: string, payload: unknown, scope?: RunScope): void
  /** 宿主请求关停时的 flush 处理器：返回值即回给宿主的真实报告。 */
  onShutdown(handler: () => Promise<FlushReport>): void
  /** 连接断开（含宿主死亡）时回调；harness 据此退出进程。 */
  onDisconnect(handler: (reason: string) => void): void
  isClosed(): boolean
  close(reason?: string): void
}

export class HostBridgeImpl implements HostBridgeRuntime {
  constructor(private readonly connection: HostConnection) {
    // 桥对象构造即装配 Node 环境端口（模式说明见 ports.ts 文件头）：领域代码只认
    // 取用口，端口实现由环境 bootstrap 注入，一个环境只装配一个实现。
    installNodeHostPorts(this)
  }

  async request<K extends keyof HostCommandMap>(
    method: K,
    args: HostCommandMap[K]["args"],
    options?: { signal?: AbortSignal; scope?: RunScope },
  ): Promise<HostCommandMap[K]["result"]> {
    const raw = await this.connection.request(method as string, args, options)
    return (await this.materializeResult(raw)) as HostCommandMap[K]["result"]
  }

  subscribe<K extends keyof HostEventMap>(
    event: K,
    listener: (payload: HostEventMap[K]) => void,
  ): () => void {
    return this.connection.subscribe(event as string, listener as (payload: unknown) => void)
  }

  async readBlob(ref: HostBlobRef, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    return this.connection.readBlob(ref, options)
  }

  async releaseBlob(ref: HostBlobRef): Promise<void> {
    await this.connection.releaseBlob(ref)
  }

  get appEpoch(): string {
    return this.connection.appEpoch
  }

  get nodeEpoch(): number {
    return this.connection.nodeEpoch
  }

  get platform(): "windows" | "macos" {
    return this.connection.platform
  }

  get runtimeMode(): "development" | "production" {
    return this.connection.runtimeMode
  }

  get limits(): { controlFrameMaxBytes: number; blobChunkMaxBytes: number; streamCreditBytes: number } {
    return this.connection.limits
  }

  publishEvent(event: string, payload: unknown, scope?: RunScope): void {
    this.connection.publishEvent(event, payload, scope)
  }

  onShutdown(handler: () => Promise<FlushReport>): void {
    this.connection.onShutdown(handler)
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.connection.onDisconnect(handler)
  }

  isClosed(): boolean {
    return this.connection.isClosed()
  }

  close(reason = "本地关闭"): void {
    this.connection.close(reason)
  }

  // ── 结果物化 ──

  /**
   * 把结果里的 blob 标记还原成完整原值：
   * - `$blobEncoding === "utf8"` → 字符串；
   * - 否则 → `Uint8Array`（字节语义，不退回 number[]）。
   * 形状无效的标记是协议错误（不静默放行给业务层）。
   */
  private async materializeResult(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (const item of value) out.push(await this.materializeResult(item))
      return out
    }
    if (typeof value === "object" && value !== null) {
      const marker = parseHostBlobMarker(value)
      if (marker) {
        const bytes = await this.connection.readBlob(marker.ref)
        if (marker.encoding === "utf8") {
          return Buffer.from(bytes).toString("utf8")
        }
        return bytes
      }
      if (HOST_BLOB_MARKER_KEY in (value as Record<string, unknown>)) {
        throw new HostProtocolError(
          "BLOB_MARKER_INVALID",
          "结果中的 $hostBlobRef 标记形状无效（句柄只能来自宿主签发）",
        )
      }
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = await this.materializeResult(item)
      }
      return out
    }
    return value
  }
}

/** 连接建立并完成 hello/welcome 后返回唯一桥接入口。 */
export async function connectHostBridge(options: HostBridgeRuntimeOptions = {}): Promise<HostBridgeRuntime> {
  const launch = options.launch ?? readLaunchInfo()
  const connection = await HostConnection.connect({ launch, nodeVersion: options.nodeVersion })
  return new HostBridgeImpl(connection)
}
