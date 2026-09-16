import type { ModuleContract } from "../types"

export const variablePoolContract: ModuleContract = {
  module: "variable-pool",
  sourceFiles: ["src/services/engine/pi/runtime.ts", "src/services/personality/variable-pool.ts", "src/services/personality/types.ts", "src/services/reply/generator.ts"],
  generatedAt: "2026-09-15",
  sourceHash: "e8e91b7bbc640f95f64837827a8160175f7284fd08ccdd9239f6ef3562d20517",
  coverage: [
    { id: "vp-01", feature: "系统变量计算", description: "computeSystemVariables 计算6个系统变量", why: "Prompt 注入基础", depth: "shallow", scenarios: ["variable-system-vars"] },
    { id: "vp-02", feature: "变量池初始化", description: "initVariablePool 从Card variableDefs初始化", why: "Card切换和重启时正确构建", depth: "deep", scenarios: ["variable-pool-init"] },
    { id: "vp-03", feature: "变量池刷新", description: "refreshVariablePool 重新计算系统变量", why: "每轮对话前刷新", depth: "deep", scenarios: ["variable-pool-refresh"] },
    { id: "vp-04", feature: "RUNTIME_DATA 写入变量池", description: "真实模型按提示发出 RUNTIME_DATA 后，池里的值与请求一致（字符串按 coerceValue 规则去引号比较）且 updatedBy=llm；模型未请求写入的那一轮放过，但整场至少要有一次，否则视为链路未被验证", why: "回复生成器拥有变量写入边界；断言模型自发每轮都写属于模型行为而非引擎契约", depth: "deep", scenarios: ["variable-affection-praise"] },
    { id: "vp-05", feature: "batchWriteVars 拒绝未注册变量", description: "写入未在 variableDefs 中定义的变量被拒绝", why: "防止 LLM 写入未定义变量", depth: "shallow", scenarios: ["variable-pool-unregistered"] },
    { id: "vp-06", feature: "batchWriteVars 类型/范围约束", description: "number/string/boolean 类型校验 + number min/max + string enum，非法值拒绝", why: "防护 LLM 幻觉", depth: "shallow", scenarios: ["variable-boundary-reject"] },
    { id: "vp-07", feature: "batchWriteVars updateBy=system 只读", description: "updateBy 不是 llm 的 card 变量无法通过 batchWriteVars 写入", why: "保护系统变量", depth: "shallow", scenarios: ["variable-pool-system-readonly"] },
    { id: "vp-08", feature: "RUNTIME_DATA 变量写入端到端", description: "LLM 回复含 RUNTIME_DATA 变量行 → 引擎解析 → batchWriteVars → pool 更新", why: "核心写入闭环", depth: "deep", scenarios: ["variable-runtime-data-write"] },
    { id: "vp-09", feature: "Reset=never策略", description: "永不重置的持久变量", why: "亲密度等不能丢", depth: "deep", scenarios: ["variable-reset-never"] },
    { id: "vp-10", feature: "Reset=daily策略", description: "日期变更时重置", why: "每日变量正确重置", depth: "deep", scenarios: ["variable-reset-daily"] },
    { id: "vp-11", feature: "Reset=session策略", description: "新会话时重置", why: "会话级变量刷新", depth: "deep", scenarios: ["variable-reset-session"] },
    { id: "vp-12", feature: "交互变量更新", description: "updateInteractionVar写入interaction变量", why: "系统行为反馈", depth: "deep", scenarios: ["variable-interaction-update"] },
    { id: "vp-13", feature: "持久化保存", description: "savePoolToDisk写入stages/{cardId}.json", why: "重启不丢变量", depth: "deep", scenarios: ["variable-pool-save"] },
    { id: "vp-14", feature: "持久化恢复", description: "loadCardVars从磁盘恢复变量", why: "重启恢复", depth: "deep", scenarios: ["variable-pool-load"] },
    { id: "vp-15", feature: "formatPoolForPrompt", description: "四类变量格式化为LLM可读文本", why: "LLM prompt变量注入", depth: "shallow", scenarios: ["variable-pool-prompt"] },
    { id: "vp-16", feature: "snapshot/restore变量池", description: "保存恢复运行时状态", why: "重试快照回滚", depth: "shallow", scenarios: ["variable-pool-snapshot"] },
    { id: "vp-17", feature: "变量池销毁", description: "destroyPool清空所有变量", why: "场景间状态隔离", depth: "deep", scenarios: ["variable-pool-destroy"] },
    { id: "vp-18", feature: "持久化恢复非法值回退", description: "持久化值超出范围回退到initial", why: "防护磁盘数据损坏", depth: "shallow", scenarios: ["variable-pool-invalid-restore"] },
  ],
  rules: { minScenarios: 15, minDeepScenarios: 9, requireBoundary: true, requireErrorPath: true },
}
