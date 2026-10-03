import type { ModuleContract } from "../host/types"

export const proactiveContract:ModuleContract={
  module:"proactive",sourceHash: "ec42af9bd922c1749ba364cc905339d56e903f40ff5434a122a861c012127586",
  sourceFiles:["src/services/proactive/config.ts","src/services/proactive/index.ts","src/services/proactive/scanner.ts","src/services/proactive/opportunities.ts","src/services/proactive/time.ts",
    "src/services/proactive/planner.ts","src/services/proactive/delivery.ts","src/services/proactive/ipc.ts","src/services/proactive/protocol.json",
    "src/services/proactive/protocol.ts","src/services/proactive/trace.ts","src/services/proactive/types.ts","src/services/proactive/presence.ts","src/services/proactive/usage.ts",
    "src/services/proactive/content/pool.ts","src/services/proactive/content/calendar.ts","src/services/proactive/content/calendar.json",
    "src/services/tool/local-extra/proactive.ts","src/services/tool/registry.ts","src/services/engine/slash/commands/proactive.ts",
    "src/services/init.ts","src/App.vue","src/services/agent/runner.ts","src/services/agent/types.ts","src/services/engine/harness/runtime.ts",
    "src/services/engine/harness/delivery.ts","src/services/session/read-model.ts","src-tauri/src/proactive/store.rs","src-tauri/src/proactive/schema.rs",
    "src-tauri/src/proactive/mod.rs","src-tauri/src/proactive/commands.rs","src/services/agent/memory/protocol.json","src/services/agent/memory/protocol.ts"],
  coverage:[
    {id:"pr-01",feature:"精度与当地日历",description:"day/minute窗、静默边界、DST缺时/重时和月末周期均按独立UTC见证断言",why:"截止日期不能伪造为用户指定钟点，周期不能按固定毫秒偏移",layer:"unit",depth:"deep",scenarios:["proactive-day-anchor","proactive-minute-anchor","proactive-dst-resolution","proactive-quiet-boundary","proactive-recurring-slot"]},
    {id:"pr-02",feature:"来源、去重与打扰抑制",description:"未回复2/4档、working、已评估和过期机会、同事项合并，以及无来源/完成/记忆关闭不提醒",why:"不能无来源发话、重复提醒或消耗未合格机会的额度",layer:"unit",depth:"deep",scenarios:["proactive-unanswered-guards","proactive-dedupe-window","proactive-working-evidence","proactive-calendar-coverage"]},
    {id:"pr-03",feature:"有限规划",description:"只接受声明JSON决策，未来跟进1到7天，未知工具/周期字段拒绝",why:"自主规划不能扩大成任意脚本或未获用户同意的周期",layer:"unit",depth:"deep",scenarios:["proactive-planner-validation"]},
    {id:"pr-04",feature:"周期与用量治理",description:"周期由可信用户明确约定；实际Token包含缓存分列，缺或非法用量不冒充零",why:"既不能把提议变成约定，也不能以零值掩盖失败成本",layer:"unit",depth:"deep",scenarios:["proactive-recurrence-consent","proactive-actual-usage"]},
    {id:"pr-05",feature:"结构化送达提交",description:"真实生产回合无工具主动表达，先核对JSONL终态tip再SQLite回执，回执成功后才投递UI/Card",why:"模型文本、message_end、随机UI身份均不能证明送达",layer:"e2e",depth:"deep",scenarios:["proactive-expression-native-commit"]},
    {id:"pr-06",feature:"失效与恢复",description:"失效末端守卫不提交有效消息或变量；精确请求/尝试身份恢复已提交回执，无副作用重放",why:"切换/插话与崩溃均可能使异步结果归属错误",layer:"e2e",depth:"deep",scenarios:["proactive-expression-admission-guard"]},
    {id:"pr-07",feature:"原生提交读模型",description:"真JSONL/native operation tip证明主动助手提交；回执未确认时隐藏，拒绝准入不调用Provider",why:"不能把UI文本或message_end当作持久送达，guard必须在Provider前生效",layer:"integration",depth:"deep",scenarios:["proactive-expression-commit","proactive-admission-guard"]},
  ],
  // L4 校验只统计 layer:"e2e" 覆盖点；其余 caseId 在 L2/L3 由跨层校验负责。
  rules:{minScenarios:2,minDeepScenarios:2,requireBoundary:true,requireErrorPath:true},
}
