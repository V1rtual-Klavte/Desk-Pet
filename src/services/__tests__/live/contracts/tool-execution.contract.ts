import type { ModuleContract } from "../types"

export const toolExecutionContract: ModuleContract = {
  module: "tool-execution",
  sourceFiles: ["src/services/tool/router.ts", "src/services/tool/registry.ts"],
  generatedAt: "2026-07-24T00:00:00Z",
  sourceHash: "",
  coverage: [
    { id: "te-01", feature: "工具注册", description: "registerDefaultTools 注册所有默认工具", why: "工具系统基础", depth: "shallow", scenarios: [] },
    { id: "te-02", feature: "工具按模式获取", description: "getToolsForMode('pet') 返回 pet 工具集", why: "不同模式不同工具", depth: "shallow", scenarios: [] },
    { id: "te-03", feature: "工具执行成功路径", description: "executeTool 正常返回结果", why: "工具执行核心路径", depth: "shallow", scenarios: [] },
    { id: "te-04", feature: "工具执行失败路径", description: "无效路径/参数 → 返回失败", why: "错误路径覆盖", depth: "shallow", scenarios: [] },
    { id: "te-05", feature: "bash 白名单放行", description: "echo/ls/cat 等白名单命令执行", why: "安全白名单机制", depth: "shallow", scenarios: [] },
    { id: "te-06", feature: "bash 非白名单拦截", description: "curl/rm 等命令被拦截", why: "安全防护", depth: "shallow", scenarios: [] },
    { id: "te-07", feature: "var_read/write 联动", description: "LLM 通过工具读写变量", why: "LLM 工具调用核心", depth: "deep", scenarios: [] },
    { id: "te-08", feature: "真 LLM 多工具调用", description: "真实 LLM 对话中先后调用多个工具", why: "端到端工具链验证", depth: "deep", scenarios: [] },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 2, requireBoundary: true, requireErrorPath: true },
}
