// ==========================================
// HostBridge —— Node Harness ↔ Native 宿主唯一桥接入口（W0 冻结）
// ==========================================
//
// 本文件冻结公开形状（执行契约 §4.1，docs/history/implementation/原生宿主轻量化执行契约-2026-10-04基线.md）
// 与唯一取用口；transport 实现放在同目录的实现文件，本文件自身不实现 transport、
// 不发 IPC、不连 socket。W2/W3/W10 提供实现时不得改变这里的形状。
//
// **本 barrel 的静态依赖必须保持 Node 可加载**：这里再导出 `./bridge` 的
// `connectHostBridge`（W2 IPC），但不得引入任何浏览器依赖（`@tauri-apps/*`
// 一类）—— 领域模块普遍 import 本桶，一旦拖进浏览器依赖，Node 进程里任何 import
// 本桶的模块都会直接崩。
// 实现由 bootstrap 显式注入，一个环境只注入一个：
// - Node Harness：`src/harness/main.ts` 握手成功后注入 `connectHostBridge(...)`（W2 IPC）。
// 未注入时 `getHostBridge()` 抛 HostBridgeUnavailableError；无降级链、无默认实现。
//
// 实现者必须遵守的语义（契约 §4.1/§4.2）：
// - `request` 失败以 reject(HostError) 表达（结构同 `@/services/error` 的 errorCode 形状），
//   不返回 null/undefined 冒充成功；`subscribe` 返回退订函数。
// - 每条请求/事件带 scope（RunScope）：旧 Node、旧会话/代际、旧 owner 的结果不得写新状态。
// - 64 KiB 控制帧是流控单位，不是业务上限：超长字段编码为 blob 再物化完整原值，
//   应用层结果类型不缩水（见 types.ts 文件头）。
// - 控制通道与二进制通道分开；取消/shutdown/owner 失效走控制优先队列，不排在图片字节后面。
// - `readBlob` 只接受宿主签发过的 HostBlobRef（完成路径校验后签发）；**任意路径不是
//   blob 授权**。关闭/取消/断线要归还句柄（`releaseBlob`）。

import type { HostBlobRef, HostCommandMap, HostEventMap, RunScope } from "./types"
import { HostBridgeUnavailableError } from "./wire"

export type { HostBlobRef, HostCommandMap, HostError, HostEventMap, RunScope } from "./types"

export interface HostBridge {
  /** 调用一条宿主命令。K 限定在冻结矩阵内；参数/结果类型由 HostCommandMap 决定。 */
  request<K extends keyof HostCommandMap>(
    method: K,
    args: HostCommandMap[K]["args"],
    options?: { signal?: AbortSignal; scope?: RunScope },
  ): Promise<HostCommandMap[K]["result"]>

  /** 订阅宿主/Node 状态推送（矩阵 (a) 类）。返回退订函数；注册失败应报错而非静默。 */
  subscribe<K extends keyof HostEventMap>(
    event: K,
    listener: (payload: HostEventMap[K]) => void,
  ): () => void

  /** 按句柄读取大内容（二进制通道 + 背压）。 */
  readBlob(ref: HostBlobRef, options?: { signal?: AbortSignal }): Promise<Uint8Array>

  /** 归还 blob 句柄（关闭/取消/断线时实现也必须自行归还）。 */
  releaseBlob(ref: HostBlobRef): Promise<void>
}

/**
 * 宿主通道未就绪时抛（尚未握手、握手失败、连接断开、Node 监督器正在重启……）。
 *
 * **不允许用它做静默降级**：捕获后继续、把功能标成「尽力而为」、退回过期缓存或空结果，
 * 都属于把宿主故障伪装成产品行为。等待/重连必须是显式的（重试或向上失败），
 * 且故障提示保持中性 —— 系统错误不用 Card 台词遮盖（契约 §4.3）。
 * 单位（usage/audit/已准入写队列）的未知状态不得当作成功继续。
 */
// 定义与实现同源在 wire.ts（connection.ts 也要抛它）；桶再导出同一形状，
// 未注入时 getHostBridge() 也抛这个类（见文末取用口）。
export { HostBridgeUnavailableError }

// ==========================================
// W2 实现入口
// ==========================================
//
// 上面的接口与错误类型是 W0 冻结件（形状不变）；下面是 W2 落地的实现入口。
// 实现分布在同包内：
//   wire.ts        线协议编解码（字节布局唯一权威在 Rust ipc/mod.rs）
//   connection.ts  两条连接、握手、优先写队列、信用背压、blob 上传/读取
//   bridge.ts      HostBridge 实现与结果物化（$hostBlobRef → 完整原值）
//
// 使用方式（harness/main.ts）：
//   setHostBridge(await connectHostBridge())      // 握手成功后注入唯一取用口
//   const paths = await getHostBridge().request("get_runtime_paths", {})

export type { LaunchInfo } from "./connection"
export type { FlushReport } from "./connection"
export { readLaunchInfo, LAUNCH_ENV_VAR } from "./connection"
export { HostCommandError, HostProtocolError } from "./wire"
export type { HostBridgeRuntime, HostBridgeRuntimeOptions } from "./bridge"
export { connectHostBridge, HostBridgeImpl } from "./bridge"

// ==========================================
// 环境端口（W4 解除包新增；宿主能力在领域代码里的唯一取用面）
// ==========================================
//
// 宿主能力在领域代码里的唯一取用面：运行模式、资源 URL、执行环境路径运算；
// UI 事件发布与 UI→Node 回执也在这里公开。装配与 HostBridge 同模式
// （实现由 Node bootstrap 注入，未注入抛 HostPortUnavailableError，无降级链）；
// 端口模块本身不 import 任何 transport 实现，Node 进程可安全 import。
export {
  HostPortUnavailableError,
  getHostEnvironment,
  setHostEnvironment,
  getResourceUrlResolver,
  setResourceUrlResolver,
  getExecutionPathKit,
  setExecutionPathKit,
  type HostEnvironment,
  type ResourceUrlResolver,
  type ExecutionPathKit,
} from "./ports"
export {
  publishUiEvent,
  subscribeUiReceipt,
  getUiEventPublisher,
  setUiEventPublisher,
  getUiReceiptSource,
  setUiReceiptSource,
  type NodeUiEventName,
  type UiEventPublisher,
  type UiReceiptSource,
  type UiReceiptMap,
} from "./ui-events"

// ==========================================
// 取用口：由各环境的 bootstrap 注入
// ==========================================
//
// 业务代码只依赖 HostBridge 接口，不感知实现；实现由 bootstrap 在**任何领域初始化
// 之前**显式注入 —— Node 侧见 src/harness/main.ts（W2 IPC 的 connectHostBridge）。
// 本 barrel 不提供、也不回落任何默认实现：不做「先试 A 再试 B」的降级链，
// 一个环境只注入一个；未注入就是未就绪，必须显式失败。
let currentBridge: HostBridge | null = null

/**
 * 获取当前注入的 HostBridge 实例。
 *
 * 尚未注入时抛 `HostBridgeUnavailableError`（不返回 null、不偷偷新造实例）：
 * 到点未注入属于启动接线错误，必须显式暴露，不能伪装成可用的空实现。
 */
export function getHostBridge(): HostBridge {
  if (!currentBridge) {
    throw new HostBridgeUnavailableError(
      "HostBridge 尚未注入：bootstrap 必须先调用 setHostBridge(...)。" +
        "Node 侧在 harness 握手成功后注入（connectHostBridge）。",
    )
  }
  return currentBridge
}

/**
 * 注入当前实现（各环境的 bootstrap 在最早时机调用，全进程只注入一个）。
 *
 * 传 null 表示**清空注入**（如测试拆卸）：之后 getHostBridge() 抛
 * HostBridgeUnavailableError。原「传 null 恢复默认实现」的旧语义随默认实现
 * 一起删除 —— 本 barrel 没有可恢复的默认实现。
 */
export function setHostBridge(bridge: HostBridge | null): void {
  currentBridge = bridge
}
