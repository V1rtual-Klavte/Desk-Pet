import type { ModuleContract } from "../host/types"

// 2026-10-04 名字变量改造（frontmatter nameVar / activeCardName 跟随 / 池代际读取点）触达
// 本契约 sourceFiles 的 4 个 personality 文件；审阅确认主动链只消费 getActiveCard /
// getActivePersonalityId / getPoolSnapshot / subscribeVariableCommits，不消费 activeCardName，
// 覆盖点行为未变，仅按新源码刷新 sourceHash。
export const proactiveContract:ModuleContract={
  module:"proactive",sourceHash: "af09cb852a3225871559aad9e6c565d86779ca88e7a2527c42e00401273414a1",
  sourceFiles:["src/services/proactive/config.ts","src/services/proactive/index.ts","src/services/proactive/scanner.ts","src/services/proactive/opportunities.ts","src/services/proactive/time.ts",
    "src/services/proactive/planner.ts","src/services/proactive/delivery.ts","src/services/proactive/ipc.ts","src/services/proactive/auxiliary-budget.ts","src/services/proactive/control-bridge.ts","src/services/proactive/protocol.json",
    "src/services/proactive/protocol.ts","src/services/proactive/trace.ts","src/services/proactive/types.ts","src/services/proactive/presence.ts","src/services/proactive/usage.ts",
    "src/services/proactive/content/pool.ts","src/services/proactive/content/calendar.ts","src/services/proactive/content/calendar.json",
    "src/services/observation/index.ts","src/services/observation/store.ts","src/services/observation/types.ts","src/services/observation/topics.ts",
    "src/services/behavior/index.ts","src/services/behavior/aggregate.ts","src/services/behavior/types.ts",
    "src/services/config.ts","src/services/personality/types.ts","src/services/personality/loader.ts","src/services/personality/registry.ts","src/services/personality/variable-pool.ts",
    "src/services/tool/local-extra/proactive.ts","src/services/tool/registry.ts","src/services/engine/slash/commands/proactive.ts",
    "src/services/init.ts","src/App.vue","src/services/agent/runner.ts","src/services/agent/types.ts","src/services/interaction.ts","src/services/session/index.ts","src/services/session/messages.ts","src/services/session/read-model.ts","src/services/engine/harness/runtime.ts",
    "src/services/engine/harness/delivery.ts","src-tauri/src/proactive/store.rs","src-tauri/src/proactive/schema.rs",
    "src-tauri/src/proactive/mod.rs","src-tauri/src/proactive/commands.rs","src-tauri/src/memory/protocol.rs","src/services/agent/memory/protocol.json","src/services/agent/memory/protocol.ts",
    "src-tauri/resources/defaults/personality/cards/default.md"],
  coverage:[
    {id:"pr-01",feature:"精度与当地日历",description:"day/minute窗、23–09静默边界、22点晚安独占窗口、DST缺时/重时和月末周期均按独立UTC见证断言",why:"截止日期不能伪造为用户指定钟点，周期不能按固定毫秒偏移，晚安机会后不能回落普通分享",layer:"unit",depth:"deep",scenarios:["proactive-day-anchor","proactive-minute-anchor","proactive-dst-resolution","proactive-quiet-boundary","proactive-recurring-slot","proactive-goodnight-window"]},
    {id:"pr-02",feature:"来源、去重与打扰抑制",description:"未回复阈值按当地日冻结降档而不封停，自足/工作边界、已评估和过期机会、同事项合并，以及无来源/完成/记忆关闭不提醒；去重先于截取，已评估的前缀不遮挡其后的有效机会；收工要求可靠画像且休闲/空闲连续满十分钟",why:"不能无来源发话、重复提醒、消耗未合格机会的额度，也不能让旧的已评估项挡住真正到期的机会或因沉默完全停发",layer:"unit",depth:"deep",scenarios:["proactive-no-profile-random","proactive-unanswered-guards","proactive-unanswered-daily-freeze","proactive-feedback-timestamp-projection","proactive-feedback-recovery-user-boundary","proactive-feedback-cleared-epoch-history","proactive-dedupe-window","proactive-working-evidence","proactive-calendar-coverage","proactive-evaluated-prefix-does-not-mask","proactive-finished-work-rest-lease"]},
    {id:"pr-03",feature:"有限规划",description:"只接受声明JSON决策，未来跟进1到7天，未知工具/周期字段拒绝",why:"自主规划不能扩大成任意脚本或未获用户同意的周期",layer:"unit",depth:"deep",scenarios:["proactive-planner-validation"]},
    {id:"pr-04",feature:"周期与用量治理",description:"周期由可信用户明确约定：可先记录提议，只有本轮明确同意并引用匹配的 proposalId 才能建立，跨回合接受不看 runGeneration 但必须同会话/Card/hash；延后保留原有效期、不截短周期；随机1–3小时持久槽只限普通分享，画像/锚/晚安不被误挡；实际Token包含缓存分列，辅助预留共享总额且unknown结算保留账本，静默skip结案且不记成功或重放",why:"既不能把提议当成授权，也不能让延后静默截断已同意的周期，更不能以零值掩盖失败成本、遗留预留、阻断锚时机或重放静默机会",layer:"unit",depth:"deep",scenarios:["proactive-recurrence-consent","proactive-actual-usage","proactive-recurrence-proposal-acceptance","proactive-recurrence-snooze-validity","proactive-random-interval-scope"]},
    {id:"pr-05",feature:"结构化送达提交",description:"真实生产回合无工具主动表达，先核对JSONL终态tip再SQLite回执，回执成功后才投递UI/Card",why:"模型文本、message_end、随机UI身份均不能证明送达",layer:"e2e",depth:"deep",scenarios:["proactive-expression-native-commit"]},
    {id:"pr-06",feature:"失效与恢复",description:"失效末端守卫不提交有效消息或变量；精确请求/尝试身份恢复已提交回执，无副作用重放",why:"切换/插话与崩溃均可能使异步结果归属错误",layer:"e2e",depth:"deep",scenarios:["proactive-expression-admission-guard"]},
    {id:"pr-07",feature:"原生提交读模型",description:"真JSONL/native operation tip证明主动助手提交；回执未确认时隐藏，拒绝准入不调用Provider；合法静默保留空tip证据但返回skipped且不投影气泡",why:"不能把UI文本或message_end当作持久送达，guard必须在Provider前生效，静默不能被伪装成送达",layer:"integration",depth:"deep",scenarios:["proactive-expression-commit","proactive-admission-guard","proactive-silent-skip"]},
  ],
  // L4 校验只统计 layer:"e2e" 覆盖点；其余 caseId 在 L2/L3 由跨层校验负责。
  rules:{minScenarios:2,minDeepScenarios:2,requireBoundary:true,requireErrorPath:true},
}
