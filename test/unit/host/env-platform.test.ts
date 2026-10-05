// ==========================================
// 平台检测 —— 唯一真相源是宿主握手（产品构建形态的行为）
// ==========================================
//
// 归属 L2 的依据：平台派生值是「端口注册 → 读取值」的纯逻辑（无 IPC 往返、无落盘、
// 无回合）；用记录型假 runtime 即可观测注册是否把 ServerWelcome.platform 投影到
// env 的活绑定上。
//
// 被测行为（修复「产品包平台恒为 unknown」）：
//   · installNodeHostPorts 注册的 HostEnvironment.platform 与运行期 runtime.platform 同源，
//     且 env 的 platform/isMacOS/windowMonitorAvailable 随之刷新（活绑定）；
//   · 平台值与浏览器全局无关：navigator 不可用时仍来自握手（产品产物由
//     --define:navigator=undefined 把浏览器全局折叠掉，旧实现因此恒为 unknown）。
//
// 「env.ts 不得再依赖 navigator/window」的守卫不写成读源码断言的用例（测试纪律规则 3
// 禁止在测试里读源码文本作断言）；该守卫的落点是构建产物级的 rg 检查（见交付报告），
// 本文件只断言产品形态下的行为结果。
//
// **未运行**：本包交付时只做类型/编译检查（见交付报告）。

import { afterEach, describe, expect, it } from "vitest"

import {
  crossMonitorAvailable,
  isMacOS,
  isWindows,
  platform,
  windowMonitorAvailable,
} from "@/services/env"
import {
  setExecutionPathKit,
  setHostEnvironment,
  setUiEventPublisher,
  setUiReceiptSource,
} from "@/services/host"
import type { HostBridgeRuntime } from "@/services/host"
import { installNodeHostPorts } from "@/services/host/node-ports"

/** 记录型假 runtime：只保留 installNodeHostPorts 消费的面（与既有两个端口用例同形）。 */
function fakeRuntime(platform: "windows" | "macos"): HostBridgeRuntime {
  return {
    runtimeMode: "production",
    platform,
    publishEvent: () => {},
    subscribe: () => () => {},
  } as unknown as HostBridgeRuntime
}

afterEach(() => {
  setHostEnvironment(null)
  setExecutionPathKit(null)
  setUiEventPublisher(null)
  setUiReceiptSource(null)
})

describe("平台派生值来自握手端口", () => {
  it("macOS 握手：platform=macos、isMacOS=true、观察能力可用 [env-platform-from-handshake]", () => {
    installNodeHostPorts(fakeRuntime("macos"))
    expect(platform).toBe("macos")
    expect(isMacOS).toBe(true)
    expect(isWindows).toBe(false)
    expect(windowMonitorAvailable).toBe(true)
    expect(crossMonitorAvailable).toBe(true)
  })

  it("Windows 握手：platform=windows、isMacOS=false（快捷键必须取 winModifiers）[env-platform-windows]", () => {
    installNodeHostPorts(fakeRuntime("windows"))
    expect(platform).toBe("windows")
    expect(isMacOS).toBe(false)
    expect(isWindows).toBe(true)
  })

  it("navigator 不可用时平台仍来自握手（不依赖浏览器全局）[env-platform-independent-of-navigator]", () => {
    // 模拟产品产物的形态：浏览器全局被构建参数折叠为 undefined。Node 的 navigator
    // 若是不可配置的固有属性则跳过置空（本断言退化为与上一条同形的握手取值）。
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    const canHideNavigator = descriptor?.configurable === true
    if (canHideNavigator) {
      Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true })
    }
    try {
      installNodeHostPorts(fakeRuntime("macos"))
      expect(platform).toBe("macos")
      expect(isMacOS).toBe(true)
    } finally {
      if (canHideNavigator && descriptor) Object.defineProperty(globalThis, "navigator", descriptor)
    }
  })
})
