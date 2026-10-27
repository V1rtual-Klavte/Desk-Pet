// 异常体系（Node 域）契约 —— 统一错误出口与错误摘要。
//
// 范围：`test/unit/error/全局错误出口.test.ts` 的全部 caseId 锚点。
// `src/services/error/global.ts` 是 Node 领域的唯一错误出口（AGENTS「错误留痕」的 TS 入口）：
// 写日志、经 `report_frontend_error` 交给宿主落盘、按 overlay 决定是否弹层，且自身永不抛。
// `format.ts` 的 `summarizeError` 也在这里锚定 —— 它决定随会话持久化的错误摘要是否先脱敏。
// 同一文件的 `errorCode`（HostCommandError 取码）属宿主错误码保真，归 host hz-03，不在此重复。
//
// sourceFiles 与 host 契约共享 `src/services/error/format.ts`（env/host 共享 node-ports.ts 的
// 先例）：两边依赖的行为面不同，各自按声明集合算 hash。宿主侧的真实落盘与弹层渲染属 L4 的
// Rust 边界，不在这里冒充；本契约全部覆盖点在 L2，门槛按既有 no-e2e 契约的先例归零清空，
// 不是放宽 —— 跨层完整性由 checkLayerCoverage 负责。
import type { ModuleContract } from "../host/types"

export const errorContract: ModuleContract = {
  module: "error",
  sourceFiles: [
    "src/services/error/global.ts",
    "src/services/error/format.ts",
  ],
  sourceHash: "12f7b67ec4d1b86a84035978bd215b2a66d0411adebf899bea668d1403aa700d",
  coverage: [
    {
      id: "er-01",
      feature: "统一错误出口的报告三件套、降级与永不抛出",
      description:
        "reportError 只经 `report_frontend_error` 一条通道把 `{ source, message, stack }` 交给宿主：source 是「来源/分类」（options.kind 缺省 error），message 是脱敏前的原文，stack 是包含行号的完整详情（不是只有 message）；同时写一条 error 日志，fatal 与 kind 进入日志行、详情保留原文。`overlay:false` 的预期内失败只写 warn，不升级成错误日志。出口自身永不抛：宿主通道未注入时照常记日志并返回；宿主上报异步失败被吞掉，不产生未处理拒绝，调用方也收不到异常",
      why: "三件套缺任一件故障都无法定位（没有 stack 只剩一句转述）；把预期内失败升级成 error 会让真正的故障淹没在噪声里；出口自己抛错会引发二次报错，而「抛了错」在测试里反而最容易写成「预期会炸」的假通过",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "error-outlet-report-payload",
        "error-outlet-kind-fatal",
        "error-outlet-overlay-false-warn",
        "error-outlet-never-throws",
        "error-outlet-report-failure-swallowed",
      ],
    },
    {
      id: "er-02",
      feature: "错误摘要的脱敏、空白折叠与截断",
      description:
        "summarizeError 对随会话持久化的错误文本先打码密钥形态（`sk-` 保留前缀、`Authorization: Bearer`、`password=`、JSON 的 apiKey 字段），再折叠空白并按上限截断加省略号（默认 120 字 + …，自定义上限同口径），普通文本原样保留；AppErrorPayload 取 message 再脱敏。打码规则顺序固定（`sk-` 先于通用键值规则），替换结果不得带 `$1` 字面量",
      why: "摘要会进会话文件与错误报告：密钥未打码等于把凭据写进持久化；`$1` 泄漏是替换规则被改坏的静默信号；截断口径不统一会让同一错误在不同出口长短不一",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "error-summary-secret-masking",
        "error-summary-collapse-truncate",
        "error-summary-payload-message",
      ],
    },
  ],
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}

export default errorContract
