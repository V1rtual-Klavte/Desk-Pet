import type { ModuleContract } from "../types"

export const safetyContract: ModuleContract = {
  module: "safety",
  sourceFiles: ["src/services/engine/pi/runtime.ts", "src/services/safety/checker.ts"],
  generatedAt: "2026-09-15",
  sourceHash: "94961940fa7ff6e566fe2c1fb7623d0153f1c83e5cbab19922aeb0de4ae22a3f",
  coverage: [
    { id: "sf-01", feature: "SAFE 级别放行", description: "safetyLevel=SAFE 工具被直接放行", why: "安全等级体系基础", depth: "shallow", scenarios: ["safety-safe"] },
    { id: "sf-02", feature: "NORMAL 级别检查", description: "safetyLevel=NORMAL 工具执行前检查", why: "常规工具需要安全评估", depth: "shallow", scenarios: ["safety-normal"] },
    { id: "sf-03", feature: "DANGER 级别拦截确认", description: "safetyLevel=DANGER 触发用户确认弹窗；测试宿主按场景声明的策略确定性应答（默认拒绝）", why: "危险操作需确认，且确认通道不得挂起", depth: "deep", scenarios: ["safety-danger", "safety-confirm-denied", "safety-confirm-approved"] },
    { id: "sf-04", feature: "NOWAY 直接拒绝", description: "safetyLevel=NOWAY 工具直接拒绝", why: "绝对不允许的操作", depth: "shallow", scenarios: ["safety-noway"] },
    { id: "sf-05", feature: "bash 危险命令匹配", description: "BASH_DANGEROUS_PATTERNS 匹配 rm 递归删除（合并/分开/长选项）与 sudo 等危险命令", why: "命令注入防护", depth: "shallow", scenarios: ["safety-danger-pattern"] },
    { id: "sf-06", feature: "bash NOWAY 匹配", description: "BASH_NOWAY_PATTERNS 匹配 rm -rf /（根目录）与 sudo rm 等硬禁止命令，且不误杀 rm -rf /home/user", why: "系统破坏命令禁止", depth: "shallow", scenarios: ["safety-noway-pattern"] },
    { id: "sf-07", feature: "文件危险路径匹配", description: "FILE_DANGEROUS_PATTERNS 匹配 .ssh/ 等敏感文件", why: "敏感文件泄露防护", depth: "shallow", scenarios: ["safety-file-pattern"] },
    { id: "sf-08", feature: "会话信任机制", description: "trustToolInSession + resetSessionTrust 信任周期", why: "用户确认后免重复弹窗", depth: "deep", scenarios: ["safety-trust-lifecycle"] },
    { id: "sf-09", feature: "LLM 危险 Bash 调用实际拦截", description: "真 LLM 请求 rm -rf / 时，Bash 硬禁止策略拒绝执行", why: "端到端安全验证", depth: "deep", scenarios: ["safety-dangerous-delete"] },
    { id: "sf-10", feature: "Pi beforeToolCall fail-closed 门禁", description: "Pi 原生 beforeToolCall 在 block 与抛错两种情况下都不执行工具，并留下带原因的 error 工具结果", why: "工具门禁必须 fail-closed，否则安全策略只是建议", depth: "deep", scenarios: ["safety-hook-errors"] },
  ],
  rules: { minScenarios: 7, minDeepScenarios: 3, requireBoundary: true, requireErrorPath: true },
}
