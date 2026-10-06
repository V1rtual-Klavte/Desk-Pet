// 宿主传输适配层契约（Node 侧取用面 / 装配 / 错误码保真）。
//
// 范围：`test/unit/host/ports.test.ts` 与 `test/unit/host/node-ports.test.ts` 的全部
// caseId 锚点，加上 `test/unit/error/error-code.test.ts` 的 `host-command-error-code`
// —— HostCommandError 的码保真就是这条远端错误面的一部分（errorCode 的实现文件随
// 覆盖点一并登记）。原生更新命令的形状与 Node 请求面的边界不在这里，归 update 契约。
// 全部覆盖点在 L2；宿主桥的真实 transport 行为属真 Rust 边界，不在这里冒充。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— src/services/host/index.ts（设计契约
// 引用路径改指 docs/history 归档基线；冻结接口与唯一取用口形状未动）、src/services/error/format.ts
// （错误码归一化；errorCode 对 HostCommandError 取码、普通 Error 返回 null 的语义未变）。
// hz-01..hz-03 逐点核对：五个端口的 fail-fast 与转发保真、Node 端口装配、错误码保真实现点仍在、
// 覆盖描述与当前实现一致。本批刷新同时包含另一会话的改动；本轮只做 coverage 描述与当前实现
// 一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 提问选择与去超时批次（本批刷新）：sourceFiles 变化仅限
// `src/services/host/ui-events.ts`：NodeUiEventName 补 `deskpet-choice-start` /
// `deskpet-choice-end`，UiReceiptMap 补 `deskpet-choice-resolved`（提问选择的回执条目），
// 权限确认载荷的 `expiresAt` 随「选择类弹窗不留超时」退场。端口机制未变（五取用口、退订、
// 保真转发与失败上抛），各覆盖点逐条核对实现点仍在；sourceHash 按当前源码复算。
import type { ModuleContract } from "../host/types"

export const hostContract: ModuleContract = {
  module: "host",
  sourceFiles: [
    "src/services/host/ports.ts",
    "src/services/host/ui-events.ts",
    "src/services/host/node-ports.ts",
    "src/services/host/index.ts",
    "src/services/host/wire.ts",
    "src/services/error/format.ts",
  ],
  sourceHash: "e2004dca8ce2fe0ca3bdbacc49cca0509c699a4104eecc8c033bd3b3ff9f884b",
  coverage: [
    {
      id: "hz-01",
      feature: "端口取用面的 fail-fast 与转发保真",
      description:
        "五个取用口（HostEnvironment / ResourceUrlResolver / ExecutionPathKit / UiEventPublisher / UiReceiptSource）未注入时抛 HostPortUnavailableError，不返回空实现、不静默兜底；publishUiEvent 原样转发事件名与载荷、实现失败以 reject 上抛（不吞）；subscribeUiReceipt 只把回执交给对应事件监听器、退订后不再分发；toResourceUrl 与路径运算逐一透传实现返回值（顺序与入参不丢）",
      why: "静默兜底会把「宿主能力缺失」伪装成产品行为；转发不保真或吞掉失败会让领域把一次没有送达的事件当成已送达",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "host-port-unavailable",
        "host-port-ui-event-forwarding",
        "host-port-ui-receipt-dispatch",
        "host-port-resource-and-path-kit",
      ],
    },
    {
      id: "hz-02",
      feature: "Node 端口装配（installNodeHostPorts）",
      description:
        "注册后运行模式来自握手 runtimeMode（不读进程环境）；publishUiEvent 落到 runtime.publishEvent（事件名与载荷原样）、回执订阅落到 runtime.subscribe（宿主按同名事件投递的载荷进入对应监听器）；ExecutionPathKit 与 node:os / node:path 同源（home/temp/join/resolve/isAbsolute 结果逐一相等）",
      why: "装配接错端口会让领域读不到宿主事实，或把事件发进没有消费者的空通道 —— 两种都表现为「功能静默不生效」",
      layer: "unit",
      depth: "deep",
      scenarios: ["host-node-ports-wiring", "host-node-ports-path-kit"],
    },
    {
      id: "hz-03",
      feature: "HostCommandError 错误码保真",
      description:
        "HostCommandError 携带的远端错误码经 errorCode() 原样取回（供领域按码分支）；普通 Error 无码返回 null，不臆造码",
      why: "错误码是被多个模块消费的函数级契约（PATH_NOT_FOUND 等），丢码等于改语义，而「抛了错」本身不会红",
      layer: "unit",
      depth: "shallow",
      scenarios: ["host-command-error-code"],
    },
  ],
  // 本契约全部覆盖点在 L2：端口取用面与装配是纯适配层，真实的桥接 I/O 属 L4 的
  // 真 Rust 边界，这里没有可核对内容。门槛按既有 no-e2e 契约（variable-pool /
  // memory-bench / native-ui）的先例归零清空，不是放宽 —— 跨层完整性由
  // checkLayerCoverage 负责（caseId 的声明层都是 unit）。
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
