// ==========================================
// 全局环境变量 —— 平台检测
// ==========================================
//
// 平台值的**唯一真相源是宿主握手**：`ServerWelcome.platform`（Rust 侧 HostPlatform，
// 值 `"windows" | "macos"`）→ `HostBridgeRuntime.platform` → `HostEnvironment` 端口
// （`src/services/host/ports.ts` 的 `platform` 字段）。领域代码不嗅探 navigator/window，
// 也不按 `process.platform` 等第二来源另判（执行契约「一个真相源，两侧不各存默认值」）。
//
// 时序：模块求值可能早于桥接注入（ESM 静态图先于 `connectHostBridge()` 运行），因此
// 导出值是**活绑定**，由 `refreshHostPlatform()` 在端口装配点（`host/node-ports.ts` 的
// `installNodeHostPorts`，即 `connectHostBridge()` 构造时）刷新；刷新前为 "unknown"
// （保守值，避免在握手确认前押注某个平台）。产品路径的读取全部发生在领域引导之后
// （首批消费是 native-ui 的推送），不存在「刷新前读取」的竞态。
//
// 为什么 `env.ts` 直接 import 叶模块 `host/ports.ts` 而不是 `@/services/host` 桶：
// 装配点是 `host/node-ports.ts` → 本文件 → 端口叶；若走桶会与
// index → bridge → node-ports → 本文件形成循环。领域代码仍从桶取端口。
//
// 构建说明：产品产物（`build:harness` 的 esbuild）保留
// `--define:navigator=undefined --define:globalThis.navigator=undefined`，该 define
// **只服务第三方 SDK 的浏览器探测**（openai SDK 的 detect-platform / streaming 分支与
// Vue 的 devtools 注入探测），**产品代码不再依赖它** —— 保留实证：去掉 define 后产物
// 残留 5 处 navigator（其中 2 处 `navigator.`，来自上述依赖），构建守卫（产物零命中
// `navigator.`）不再成立；带 define 时为零命中。
// 历史教训：`typeof navigator` 类判断会被该 define 折叠为 `if (false)` —— 据此
// 选平台会恒得 "unknown"、macOS 取到 Windows 修饰键；平台已改走宿主握手，
// 产品代码不得再以 navigator 作平台来源。

import { getHostEnvironment } from "@/services/host/ports"

/** 运行平台。宿主握手只披露 Windows/macOS；"linux"/"unknown" 是未刷新/保守取值。 */
export type Platform = "windows" | "macos" | "linux" | "unknown"

export let platform: Platform = "unknown"
export let isWindows = false
export let isMacOS = false
export let isLinux = false

/** 窗口监控是否可用（原生宿主两端都有观察通道）。 */
export let windowMonitorAvailable = false

/** 跨显示器检测是否可用（原生宿主两端都有观察通道）。 */
export let crossMonitorAvailable = false

/**
 * 握手披露值 → 完整平台类型。握手只可能给 windows/macos（HostPlatform 只有两个变体）；
 * 经函数边界拓宽，保留 "linux" 的完整比较而不把联合窄化成二值。
 */
function widenPlatform(disclosed: "windows" | "macos"): Platform {
  return disclosed
}

/**
 * 从宿主环境端口刷新平台派生值（`installNodeHostPorts` 在注册端口后调用一次；
 * 其它环境由各自的端口注入点负责）。未注入端口时显式抛（HostPortUnavailableError），
 * 不静默保持 "unknown" —— 到点没刷新属于接线错误。
 */
export function refreshHostPlatform(): void {
  const next = widenPlatform(getHostEnvironment().platform)
  platform = next
  isWindows = next === "windows"
  isMacOS = next === "macos"
  isLinux = next === "linux"
  windowMonitorAvailable = isWindows || isMacOS
  crossMonitorAvailable = isWindows || isMacOS
}
