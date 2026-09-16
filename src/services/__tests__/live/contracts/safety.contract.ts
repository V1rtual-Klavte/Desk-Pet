import type { ModuleContract } from "../types"

export const safetyContract: ModuleContract = {
  module: "safety",
  sourceFiles: ["src/services/engine/pi/runtime.ts", "src/services/safety/checker.ts"],
  generatedAt: "2026-09-15",
  sourceHash: "bf3bfa0013b02c5f56aa2bae1615d48eea74f9e198c226d64fb029c9a342af91",
  coverage: [
    { id: "sf-01", feature: "SAFE 级别放行", description: "safetyLevel=SAFE 工具被直接放行", why: "安全等级体系基础", depth: "shallow", scenarios: ["safety-safe"] },
    { id: "sf-02", feature: "NORMAL 级别检查", description: "safetyLevel=NORMAL 工具执行前检查", why: "常规工具需要安全评估", depth: "shallow", scenarios: ["safety-normal"] },
    { id: "sf-03", feature: "DANGER 级别拦截确认", description: "safetyLevel=DANGER 触发用户确认弹窗；同一份参数被确认过之后放行，换一组参数重新确认；let_me_tk 模式下会话信任不参与；测试宿主按场景声明的策略确定性应答（默认拒绝）", why: "危险操作需确认，且确认通道不得挂起", depth: "deep", scenarios: ["safety-danger", "safety-confirm-denied", "safety-confirm-approved"] },
    { id: "sf-04", feature: "NOWAY 直接拒绝", description: "safetyLevel=NOWAY 工具直接拒绝", why: "绝对不允许的操作", depth: "shallow", scenarios: ["safety-noway"] },
    { id: "sf-05", feature: "bash 危险命令匹配", description: "BASH_DANGEROUS_PATTERNS 匹配 rm 递归删除（合并/分开/长选项）与 sudo 等危险命令", why: "命令注入防护", depth: "shallow", scenarios: ["safety-danger-pattern"] },
    { id: "sf-06", feature: "bash NOWAY 匹配", description: "BASH_NOWAY_PATTERNS 匹配 rm -rf /（根目录）与 sudo rm 等硬禁止命令，且不误杀 rm -rf /home/user", why: "系统破坏命令禁止", depth: "shallow", scenarios: ["safety-noway-pattern"] },
    { id: "sf-07", feature: "文件路径分级", description: "resolveFilePathLevel 按路径分级：私钥凭据一律 NOWAY、.env 与系统目录 DANGER、普通路径 SAFE，Windows 反斜杠先归一，缺失 path 参数不提级；FILE_DANGEROUS_PATTERNS 仍是两级模式的并集", why: "敏感文件泄露防护，且分级必须真正接在生产工具上而不只是被断言", depth: "shallow", scenarios: ["safety-file-pattern"] },
    { id: "sf-08", feature: "会话信任粒度", description: "会话信任的粒度是「工具 + 本次参数」：同一份参数确认过才免再询问，换参数不继承；单参调用仍是工具级信任；resetSessionTrust 清空两种信任；任一种信任都不能越过动态 NOWAY", why: "用户确认后免重复弹窗，但确认一个参数不能顺带放行该工具的其他调用", depth: "deep", scenarios: ["safety-trust-lifecycle"] },
    { id: "sf-09", feature: "LLM 危险 Bash 调用实际拦截", description: "真 LLM 请求 rm -rf / 时，Bash 硬禁止策略拒绝执行", why: "端到端安全验证", depth: "deep", scenarios: ["safety-dangerous-delete"] },
    { id: "sf-10", feature: "Pi beforeToolCall fail-closed 门禁", description: "Pi 原生 beforeToolCall 在 block 与抛错两种情况下都不执行工具，并留下带原因的 error 工具结果", why: "工具门禁必须 fail-closed，否则安全策略只是建议", depth: "deep", scenarios: ["safety-hook-errors"] },
  ],
  rules: { minScenarios: 7, minDeepScenarios: 3, requireBoundary: true, requireErrorPath: true },
}
