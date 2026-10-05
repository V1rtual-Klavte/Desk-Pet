// ==========================================
// Node 环境端口注册 —— 只被 `connectHostBridge()` 调用
// ==========================================
//
// 本文件是 Node 侧的端口实现：
// - 运行模式：`ServerWelcome.runtimeMode`（W2 握手；不读 process.env，契约 §3）；
// - 平台：`ServerWelcome.platform`（同一次握手；env 的派生值随注册点刷新，
//   `@/services/env` 的 refreshHostPlatform()）；
// - UI 事件发布 / 回执订阅：桥对象的运行时扩展面（publishEvent / subscribe）；
// - 路径运算：`node:path` / `node:os`；
// - 资源 URL：**不注册** —— Node 没有本地渲染通道，等 W7 的原生资源通道；
//   消费点（profile 装载/图片 URL）在 Node 里会以 HostPortUnavailableError 显式失败，
//   不伪造 URL。
//
// 只在 Node 进程加载（connectHostBridge 的调用方：产品 harness、L4 宿主）。

import { homedir, tmpdir } from "node:os"
import * as nodePath from "node:path"
import { refreshHostPlatform } from "@/services/env"
import type { HostBridgeRuntime } from "./bridge"
import { setExecutionPathKit, setHostEnvironment } from "./ports"
import { setUiEventPublisher, setUiReceiptSource } from "./ui-events"
import type { HostEventMap } from "./types"

/** 把 Node 环境的端口实现注册进各取用口（`connectHostBridge` 构造桥对象时调用一次）。 */
export function installNodeHostPorts(bridge: HostBridgeRuntime): void {
  setHostEnvironment({ runtimeMode: bridge.runtimeMode, platform: bridge.platform })
  // 平台派生值（env 的 isMacOS 等）从同一端口刷新：模块求值早于握手时它们是保守值，
  // 这里把 ServerWelcome 披露的平台落到活绑定上（唯一刷新点，不在别处另判）。
  refreshHostPlatform()
  setUiEventPublisher({
    publish: async (event, payload) => {
      // publishEvent 是同步投递（写控制帧；通道关闭时同步抛）——包成 async 让失败以
      // reject 形式到达调用方。
      bridge.publishEvent(event, payload)
    },
  })
  setUiReceiptSource({
    // 线协议按事件名分发（connection.subscribe），回执名由宿主（W5）按同名事件投递；
    // 类型在这里收窄回 UiReceiptMap，不让领域代码看到更宽的 HostEventMap。
    subscribe: (event, listener) =>
      bridge.subscribe(
        event as unknown as keyof HostEventMap,
        listener as unknown as (payload: HostEventMap[keyof HostEventMap]) => void,
      ),
  })
  setExecutionPathKit({
    homeDir: async () => homedir(),
    tempDir: async () => tmpdir(),
    join: async (...parts) => nodePath.join(...parts),
    resolve: async (...parts) => nodePath.resolve(...parts),
    isAbsolute: async (path) => nodePath.isAbsolute(path),
  })
}
