import type { ModuleContract } from "../types"

export const safetyContract: ModuleContract = {
  module: "safety",
  sourceFiles: ["src/services/safety/checker.ts"],
  generatedAt: "2026-07-24T00:00:00Z",
  sourceHash: "",
  coverage: [
    { id: "sf-01", feature: "SAFE 级别放行", description: "safetyLevel=SAFE 工具被直接放行", why: "安全等级体系基础", depth: "shallow", scenarios: [] },
    { id: "sf-02", feature: "NORMAL 级别检查", description: "safetyLevel=NORMAL 工具执行前检查", why: "常规工具需要安全评估", depth: "shallow", scenarios: [] },
    { id: "sf-03", feature: "DANGER 级别拦截确认", description: "safetyLevel=DANGER 触发用户确认弹窗", why: "危险操作需确认", depth: "deep", scenarios: [] },
    { id: "sf-04", feature: "NOWAY 直接拒绝", description: "safetyLevel=NOWAY 工具直接拒绝", why: "绝对不允许的操作", depth: "shallow", scenarios: [] },
    { id: "sf-05", feature: "bash 危险命令匹配", description: "BASH_DANGEROUS_PATTERNS 匹配 rm/curl/wget", why: "命令注入防护", depth: "shallow", scenarios: [] },
    { id: "sf-06", feature: "bash NOWAY 匹配", description: "BASH_NOWAY_PATTERNS 匹配 sudo rm -rf /", why: "系统破坏命令禁止", depth: "shallow", scenarios: [] },
    { id: "sf-07", feature: "文件危险路径匹配", description: "FILE_DANGEROUS_PATTERNS 匹配 .ssh/ 等敏感文件", why: "敏感文件泄露防护", depth: "shallow", scenarios: [] },
    { id: "sf-08", feature: "会话信任机制", description: "trustToolInSession + resetSessionTrust 信任周期", why: "用户确认后免重复弹窗", depth: "deep", scenarios: [] },
    { id: "sf-09", feature: "LLM 工具调用实际拦截", description: "真 LLM 尝试调用危险工具时正确拦截", why: "端到端安全验证", depth: "deep", scenarios: [] },
  ],
  rules: { minScenarios: 7, minDeepScenarios: 3, requireBoundary: true, requireErrorPath: true },
}
