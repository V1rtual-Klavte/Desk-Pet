// ==========================================
// 异常体系 —— 统一出口
//   format       : 错误归一化纯函数（零依赖，可被 logger 单独引用）
//   global       : 全局拦截 + DOM 覆盖层 + reportError
//   failure-kind : 失败分类叶子（零依赖；生产回合与 Live Test 共用同一份正则表）
// ==========================================

export {
  formatError,
  errorCode,
  errorDetail,
  summarizeError,
  isAppErrorPayload,
  type AppErrorPayload,
} from "./format"

export { classifyFailureKind, type FailureKind } from "./failure-kind"

export {
  reportError,
  installGlobalHandlers,
  installVueErrorHandler,
  type ReportOptions,
} from "./global"
