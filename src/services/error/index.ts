// ==========================================
// 异常体系 —— 统一出口
//   format  : 错误归一化纯函数（零依赖，可被 logger 单独引用）
//   global  : 全局拦截 + DOM 覆盖层 + reportError
// ==========================================

export {
  formatError,
  errorCode,
  errorDetail,
  summarizeError,
  isAppErrorPayload,
  type AppErrorPayload,
} from "./format"

export {
  reportError,
  installGlobalHandlers,
  installVueErrorHandler,
  dismissErrors,
  type ReportOptions,
} from "./global"
