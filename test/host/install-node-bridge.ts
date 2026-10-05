// ==========================================
// L2/L3 宿主桥安装点 —— vitest setupFiles 条目
// ==========================================
//
// 这里安装的**不是真宿主连接**，是「Node 测试宿主的桥」：`NodeHostBridge`（见
// node-host-bridge.ts）的 transport 直接是 `test/host/node-ipc.ts` —— 按 Rust
// `#[tauri::command]` 逐条等价复现的 Node 适配层 —— **全程不经过 `@tauri-apps/*`、
// 也不经过任何旧壳（Tauri）实现**。所以测试没有、也不可能连上真宿主：每一次
// `request` 都落到 Node 适配层，未登记 / Rust 专属命令以 UnsupportedInNodeError 收场；
// 事件订阅（subscribe）与 blob 通道如实抛错，不造假总线、不伪造字节来源。
//
// 为什么需要本文件：`@/services/host` 的取用口只认 bootstrap 注入（无懒默认、无降级链）。
// 产品窗口在 bootWindow() 注入、L4 宿主在 native-main.ts 注入；L2/L3 没有 bootstrap，
// 由本文件充当等价注入点。vitest 的 setupFiles 会在每个测试文件之前加载本模块，
// 因此测试文件 top-level import 领域模块时桥已经就位。
//
// 数据根**不在**这里设置：node-ipc 要求各测试文件自己 `setTestDataRoot(临时目录)`
// （见 node-ipc.ts 文件头）。本文件只保证「桥在」，不代设、也不伪造任何数据根 ——
// 未设数据根就触桥的用例会照 node-ipc 的规矩报「测试数据根未初始化」，那是测试
// 自己的前提缺失，与桥无关。

import { setHostBridge } from "@/services/host"
import { NodeHostBridge } from "./node-host-bridge"

/**
 * 向取用口注入 Node 测试宿主的桥（与产品侧 bootWindow / harness 的注入等价）。
 *
 * 导出供测试显式重装（例如测试自己 `setHostBridge(null)` 清空之后）；
 * setupFiles 加载本模块时也会自动安装一次，测试文件无需再写样板。
 */
export function installNodeHostBridge(): void {
  setHostBridge(new NodeHostBridge())
}

// setupFiles 按模块副作用生效：被 vitest 加载即完成安装。
installNodeHostBridge()
