// 2026-10-10 聚合 JSON 传输：hz-06覆盖请求的整包上传与取消；hz-05覆盖 JSON 回包递归物化和句柄归还。memory-multi-turn 经真 Rust IPC 验证超帧索引与完整超帧搜索结果，业务层不承担帧容量预检。
// 宿主传输适配层契约（Node 侧取用面 / 装配 / 错误码保真）。
//
// 范围：`test/unit/host/ports.test.ts` 与 `test/unit/host/node-ports.test.ts` 的全部
// caseId 锚点，加上 `test/unit/error/error-code.test.ts` 的 `host-command-error-code`
// —— HostCommandError 的码保真就是这条远端错误面的一部分（errorCode 的实现文件随
// 覆盖点一并登记）—— 以及 `test/unit/host/事件名单点.test.ts` 的 `host-wire-event-names`
// （线协议事件名常量的冻结字节）。原生更新命令的形状与 Node 请求面的边界不在这里，
// 归 update 契约。全部覆盖点在 L2；宿主桥的真实 transport 行为属真 Rust 边界，
// 不在这里冒充。
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
// 2026-10-06 验收 analyze→generate（事件名单点收口批次）：新增覆盖点 hz-04
// （线协议事件名常量与冻结的线格式字节逐一一致；caseId：host-wire-event-names，L2
// test/unit/host/事件名单点.test.ts —— 本批为该守门用例补的锚点）。sourceFiles 变化 ——
// src/services/host/event-names.ts（新增零依赖叶子：HostEventMap 推送键、UiReceiptMap 回执键与
// HOST_REQUEST_EVENT 的字符串值定义点；types.ts / ui-events.ts 只按常量计算矩阵键，改线名两处
// 一字不动 —— 不列本文件就是本仓登记过的门禁失明形态）。另核对 src/services/reply/protocol.ts
// （RUNTIME_DATA 标签叶子，新文件）：不属宿主传输面，未加入本契约 sourceFiles（其行为面归
// variable-pool 契约，该契约本批已补入）。hz-01..hz-03 逐点核对实现点仍在、覆盖描述与当前
// 实现一致；sourceHash 随本批统一刷新。
import type { ModuleContract } from "../host/types"

export const hostContract: ModuleContract = {
  module: "host",
  sourceFiles: [
    "src/services/host/ports.ts",
    // 2026-10-06 事件名单点收口（hz-04）：事件名的字符串值（线格式字节）定义点从 ui-events.ts /
    // types.ts 移到这里，两处矩阵只引用常量 —— 不列本文件时，改线名不会让本契约失效（门禁失明）。
    "src/services/host/event-names.ts",
    "src/services/host/ui-events.ts",
    "src/services/host/node-ports.ts",
    "src/services/host/index.ts",
    "src/services/host/wire.ts",
    "src/services/host/bridge.ts",
    // hz-06 owns complete request-envelope sizing and automatic aggregate JSON upload.
    "src/services/host/connection.ts",
    "crates/native-host/src/ipc/bridge.rs",
    "crates/native-host/src/ipc/blob.rs",
    "crates/native-host/src/ipc/transport.rs",
    "crates/native-host/src/ipc/mod.rs",
    "crates/native-host/src/host/supervisor.rs",
    "src/services/error/format.ts",
  ],
  sourceHash: "77503cb81dabbacc96547d5251979d3e41955a5fa03aa62789226c27e1fd09b6",
  coverage: [
    {
      id: "hz-06",
      feature: "完整请求 JSON 自动传输",
      description: "实际 request 按完整信封 UTF-8 字节数判定；多小字段聚合超帧时整份参数一次 JSON blob 上传，小 Uint8Array 保持字节数组、大字节走原始 bytes blob，Date/toJSON 保持 JSON 语义；发送前与上传中取消不发送业务请求，晚完成上传或入队失败清理未消费句柄。Rust 递归物化 JSON 上传并校验 scope、一次性消费；双向大 JSON 的真 IPC 由 memory-multi-turn 验证",
      why: "控制帧大小只用于流控，不能变成索引、搜索或其他请求结果的数据上限",
      layer: "unit",
      depth: "deep",
      scenarios: ["host-request-json-blob-frame", "host-request-json-blob-cancel", "host-request-json-blob-bytes", "host-request-json-blob-json-semantics", "host-request-json-blob-late-cleanup", "host-request-json-blob-enqueue-cleanup"],
    },
    {
      id: "hz-05",
      feature: "自动物化结果的 Blob 归还与取消",
      description: "公开 request 还原字节、UTF-8 与完整 JSON；JSON blob 继续递归物化嵌套句柄。以整份结果为 owner，成功、坏 JSON、未知编码、失败、取消都归还全部已发现有效句柄，包括尚未读取的兄弟与重复引用。读取和清理同时失败保留原读取错误，成功物化但清理失败明确 reject；取消信号传入实际 readBlob。Rust 聚合回包转 JSON blob、关停屏障由所属内联单测补充核对，不冒充 L2 传输实测",
      why: "未归还会让已读数据长期驻留；兄弟字段漏清理、取消未透传或失败被清理覆盖都让请求结果与资源归宿失真",
      layer: "unit",
      depth: "deep",
      scenarios: ["host-blob-materialize-release", "host-blob-read-failure-release", "host-blob-release-failure", "host-blob-materialize-cancel", "host-json-blob-nested-release", "host-json-blob-failure-cleanup"],
    },
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
    // 2026-10-06 验收 analyze→generate：事件名单点收口（新增 hz-04，L2）。
    {
      id: "hz-04",
      feature: "线协议事件名常量与 Rust 分派同名（冻结字节）",
      description:
        "三组事件名常量（HostEventMap 的推送键、UiReceiptMap 的回执键、宿主 → Node 请求通道名 HOST_REQUEST_EVENT）的字符串值与冻结的线格式字节逐一一致，期望值在用例表里逐字写死、不从常量互相推导；改名必须同步 Rust 分派（`ui/chat/events.rs` 的 from_wire、`ui/chat/intents.rs` 的 RECEIPT_*、`ui/ports.rs` 的 HOST_REQUEST_EVENT），否则事件静默无人消费",
      why: "事件名是跨语言线格式的一部分：TS 侧改一处字面量而 Rust 未跟进时，事件与回执会静默丢失 —— 运行期没有错误面能区分「没人监听」与「名字不匹配」",
      layer: "unit",
      depth: "shallow",
      scenarios: ["host-wire-event-names"],
    },
  ],
  // 本契约全部覆盖点在 L2：端口取用面与装配是纯适配层，真实的桥接 I/O 属 L4 的
  // 真 Rust 边界，这里没有可核对内容。门槛按既有 no-e2e 契约（variable-pool /
  // memory-bench / native-ui）的先例归零清空，不是放宽 —— 跨层完整性由
  // checkLayerCoverage 负责（caseId 的声明层都是 unit）。
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
