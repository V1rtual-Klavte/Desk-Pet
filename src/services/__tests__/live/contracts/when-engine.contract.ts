import type { ModuleContract } from "../types"

export const whenEngineContract: ModuleContract = {
  module: "when-engine",
  sourceFiles: ["src/services/personality/when-engine.ts"],
  generatedAt: "2026-07-24T00:00:00Z",
  sourceHash: "",
  coverage: [
    { id: "we-01", feature: "evaluateWhen 基本求值", description: "字面量 true、number/string 比较、AND/OR 组合、括号优先级、系统变量访问", why: "When 引擎核心求值器", depth: "shallow", scenarios: [] },
    { id: "we-02", feature: "evaluateWhenEngine 规则优先级", description: "按顺序匹配 WhenRule[]，首次命中则返回", why: "规则优先级决定 LLM 行为语气", depth: "shallow", scenarios: [] },
    { id: "we-03", feature: "evaluateWhen 不存在变量", description: "引用未注册变量名 → 返回 false", why: "防止未定义变量意外命中", depth: "shallow", scenarios: [] },
    { id: "we-04", feature: "When 引擎与变量池联动", description: "var_write 更新变量后，When 引擎重新求值应命中不同规则", why: "变量变化 → 行为变化核心闭环", depth: "deep", scenarios: [] },
    { id: "we-05", feature: "evaluateWhen 无规则命中", description: "WhenRule[] 全部不匹配 → 返回 null", why: "兜底：空规则列表不 crash", depth: "shallow", scenarios: [] },
    { id: "we-06", feature: "多条件复合规则", description: "AND/OR 嵌套 + 括号优先级", why: "复杂 When 条件验证", depth: "shallow", scenarios: [] },
  ],
  rules: { minScenarios: 5, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}
