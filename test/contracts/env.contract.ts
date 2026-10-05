// 平台检测契约（宿主握手是唯一真相源）。
//
// 范围：`test/unit/host/env-platform.test.ts` 的 `env-platform-*` 三条。装配点
// `src/services/host/node-ports.ts` 与 host 契约共享（同一文件在两个契约里的覆盖点
// 不同：这里是「握手 → env 活绑定」的刷新行为，host 契约是端口注册本身），各算各的
// hash。全部覆盖点在 L2；产品产物的构建形态（浏览器全局被 define 折叠）属构建门禁，
// 不在这里冒充。
import type { ModuleContract } from "../host/types"

export const envContract: ModuleContract = {
  module: "env",
  sourceFiles: ["src/services/env.ts", "src/services/host/node-ports.ts"],
  sourceHash: "3050784fe4ac11969d2ca31d3be46d9ff75d1aff4e7215239f534d5ceea10ef9",
  coverage: [
    {
      id: "env-01",
      feature: "平台派生值来自宿主握手（活绑定）",
      description:
        "installNodeHostPorts 注册的 HostEnvironment.platform 与握手值同源，env 的 platform/isMacOS/isWindows/windowMonitorAvailable/crossMonitorAvailable 活绑定随之刷新：macOS 握手得到 macos/true/观察可用，Windows 握手得到 windows/false（快捷键必须取 winModifiers 的依据）；浏览器全局 navigator 被折叠为 undefined 时取值不变 —— 平台不从 navigator/window 推导",
      why: "平台分支取错只会在另一平台暴露；从浏览器全局推导会让产品包恒为 unknown（构建 define 会把它折叠掉），而「握手能读到值」本身不会红",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "env-platform-from-handshake",
        "env-platform-windows",
        "env-platform-independent-of-navigator",
      ],
    },
  ],
  // 本契约全部覆盖点在 L2：握手投影是纯逻辑，真实握手在 L4 的链路里发生，
  // 这里没有可核对内容。门槛按既有 no-e2e 契约的先例归零清空（见 native-ui /
  // variable-pool），不是放宽 —— 跨层完整性由 checkLayerCoverage 负责。
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
