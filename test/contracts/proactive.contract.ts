import type { ModuleContract } from "../host/types"

// 2026-10-04 名字变量改造（frontmatter nameVar / activeCardName 跟随 / 池代际读取点）触达
// 本契约 sourceFiles 的 4 个 personality 文件；审阅确认主动链只消费 getActiveCard /
// getActivePersonalityId / getPoolSnapshot / subscribeVariableCommits，不消费 activeCardName，
// 覆盖点行为未变，仅按新源码刷新 sourceHash。
// 2026-10-04 再次刷新：宿主桥 transport 迁移（invoke → HostBridge.request）触达本契约
// sourceFiles 的 loader / config / observation / proactive 调用点，crate 命令面只移除
// #[tauri::command] 包装改由壳层转发；均为 transport/改名，覆盖点行为未变，按当前源码刷新。
// 2026-10-04 W4：init.ts / App.vue 的「领域引导 / UI 投影」拆分改动了本契约 sourceFiles
// 指向的文件；新增 pr-08 的 caseId 已由 L3 用例携带（test/integration/node-bootstrap），
// sourceHash 由协调者在波次边界统一重刷，本轮不刷。
// 2026-10-04 W11b（波次收口）：control-bridge.ts 已删除并拆分为领域侧
// `src/services/proactive/control.ts`（进程内处理器登记 + 状态分发，Node 图）与
// `src/ui/proactive-control.ts`（旧壳跨窗口协议，随 W10 删壳）；sourceFiles 条目改为
// 领域侧文件。pr-01..pr-08 逐点按当前源码复核通过（transport/搬迁/引导拆分，行为未变），
// sourceHash 按当前源码重刷。
// 2026-10-05 设置页 Card 增删改查 + 模版批次：sourceFiles 中 personality/loader.ts 把
// saveUserCard 的内联文件名清洗提成 safeCardFileName（正则逐字等价，保存行为不变）、
// init.ts 仅去掉 Profile 就绪日志里的 `(character.name)` 半句（随 character.yaml 死链清理，
// 引导序列与失败语义未动）、cards/default.md 改的是「行为进阶 / 必须遵守」段落 —— 主动内容池
// （proactive/content/pool.ts）消费的 sections.roleSetting（角色设定）与变量定义/proactiveBands
// 均未动；config.ts 的累积改动经核对未出现 proactive 相关键。pr-01..pr-08 逐点复核行为面未变，
// 仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：sourceFiles 变化 —— runtime.ts（RUNTIME_DATA 协议缺失
// 检测与提醒接线；主动表达回合 isActiveMessage 不参与检测也不注入提醒）、config.ts
// （设置面的当批改动，经核对未出现 proactive 相关键）、
// resources/defaults/personality/cards/default.md（本轮改「行为进阶 / 必须遵守」两段与
// 好感度变量 description：明确信任表达与分歧和解也按分量调整；主动内容池消费的
// roleSetting 与 proactiveBands 均未动）。pr-01..pr-08 逐点核对行为面未变，未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造：
// 主动表达回合不再刷新「最近一次请求」展示统计，其用量照常计入累计分桶；pr-04 的实际 Token
// 分列与预留账本语义未变）。pr-01..pr-08 逐点核对实现点仍在、覆盖描述与当前实现一致。本批
// 刷新同时包含另一会话的改动；本轮只做 coverage 描述与当前实现一致性核对（非逐行行为审计），
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志；主动表达回合不参与压缩调度）。pr-01..pr-08
// 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
export const proactiveContract:ModuleContract={
  module:"proactive",sourceHash: "42b76b488082813ce8d4916319e443085c01f145089747d6ea013bb9c3bdf8ab",
  sourceFiles:["src/services/proactive/config.ts","src/services/proactive/index.ts","src/services/proactive/scanner.ts","src/services/proactive/opportunities.ts","src/services/proactive/time.ts",
    "src/services/proactive/planner.ts","src/services/proactive/delivery.ts","src/services/proactive/ipc.ts","src/services/proactive/auxiliary-budget.ts","src/services/proactive/control.ts","src/services/proactive/protocol.json",
    "src/services/proactive/protocol.ts","src/services/proactive/trace.ts","src/services/proactive/types.ts","src/services/proactive/presence.ts","src/services/proactive/usage.ts",
    "src/services/proactive/content/pool.ts","src/services/proactive/content/calendar.ts","src/services/proactive/content/calendar.json",
    "src/services/observation/index.ts","src/services/observation/store.ts","src/services/observation/types.ts","src/services/observation/topics.ts",
    "src/services/behavior/index.ts","src/services/behavior/aggregate.ts","src/services/behavior/types.ts",
    "src/services/config.ts","src/services/personality/types.ts","src/services/personality/loader.ts","src/services/personality/registry.ts","src/services/personality/variable-pool.ts",
    "src/services/tool/local-extra/proactive.ts","src/services/tool/registry.ts","src/services/engine/slash/commands/proactive.ts",
    // 原 src/App.vue（scanner start/stop/refresh 引导接线 + UI 投影）随 WebView 删壳退役：
    // 原生 UI 的控制入口尚未接线到领域处理器（见 proactive/control.ts 头注），此处不指向替代物。
    // （注释内不写双引号路径：sourceHash 的读法会把方括号区间里任何双引号串当 sourceFile。）
    "src/services/init.ts","src/services/agent/runner.ts","src/services/agent/types.ts","src/services/interaction.ts","src/services/session/index.ts","src/services/session/messages.ts","src/services/session/read-model.ts","src/services/engine/harness/runtime.ts",
    "src/services/engine/harness/delivery.ts","crates/native-host/src/proactive/store.rs","crates/native-host/src/proactive/schema.rs",
    "crates/native-host/src/proactive/mod.rs","crates/native-host/src/proactive/commands.rs","crates/native-host/src/memory/protocol.rs","src/services/agent/memory/protocol.json","src/services/agent/memory/protocol.ts",
    "resources/defaults/personality/cards/default.md"],
  coverage:[
    {id:"pr-01",feature:"精度与当地日历",description:"day/minute窗、23–09静默边界、22点晚安独占窗口、DST缺时/重时和月末周期均按独立UTC见证断言",why:"截止日期不能伪造为用户指定钟点，周期不能按固定毫秒偏移，晚安机会后不能回落普通分享",layer:"unit",depth:"deep",scenarios:["proactive-day-anchor","proactive-minute-anchor","proactive-dst-resolution","proactive-quiet-boundary","proactive-recurring-slot","proactive-goodnight-window"]},
    {id:"pr-02",feature:"来源、去重与打扰抑制",description:"未回复阈值按当地日冻结降档而不封停，自足/工作边界、已评估和过期机会、同事项合并，以及无来源/完成/记忆关闭不提醒；去重先于截取，已评估的前缀不遮挡其后的有效机会；收工要求可靠画像且休闲/空闲连续满十分钟",why:"不能无来源发话、重复提醒、消耗未合格机会的额度，也不能让旧的已评估项挡住真正到期的机会或因沉默完全停发",layer:"unit",depth:"deep",scenarios:["proactive-no-profile-random","proactive-unanswered-guards","proactive-unanswered-daily-freeze","proactive-feedback-timestamp-projection","proactive-feedback-recovery-user-boundary","proactive-feedback-cleared-epoch-history","proactive-dedupe-window","proactive-working-evidence","proactive-calendar-coverage","proactive-evaluated-prefix-does-not-mask","proactive-finished-work-rest-lease"]},
    {id:"pr-03",feature:"有限规划",description:"只接受声明JSON决策，未来跟进1到7天，未知工具/周期字段拒绝",why:"自主规划不能扩大成任意脚本或未获用户同意的周期",layer:"unit",depth:"deep",scenarios:["proactive-planner-validation"]},
    {id:"pr-04",feature:"周期与用量治理",description:"周期由可信用户明确约定：可先记录提议，只有本轮明确同意并引用匹配的 proposalId 才能建立，跨回合接受不看 runGeneration 但必须同会话/Card/hash；延后保留原有效期、不截短周期；随机1–3小时持久槽只限普通分享，画像/锚/晚安不被误挡；实际Token包含缓存分列，辅助预留共享总额且unknown结算保留账本，静默skip结案且不记成功或重放",why:"既不能把提议当成授权，也不能让延后静默截断已同意的周期，更不能以零值掩盖失败成本、遗留预留、阻断锚时机或重放静默机会",layer:"unit",depth:"deep",scenarios:["proactive-recurrence-consent","proactive-actual-usage","proactive-recurrence-proposal-acceptance","proactive-recurrence-snooze-validity","proactive-random-interval-scope"]},
    {id:"pr-05",feature:"结构化送达提交",description:"真实生产回合无工具主动表达，先核对JSONL终态tip再SQLite回执，回执成功后才投递会话视图（pushCommittedProactiveMessage）；原生 UI 经会话投影/正文推送看到已提交条目",why:"模型文本、message_end、随机UI身份均不能证明送达",layer:"e2e",depth:"deep",scenarios:["proactive-expression-native-commit"]},
    {id:"pr-06",feature:"失效与恢复",description:"失效末端守卫不提交有效消息或变量；精确请求/尝试身份恢复已提交回执，无副作用重放",why:"切换/插话与崩溃均可能使异步结果归属错误",layer:"e2e",depth:"deep",scenarios:["proactive-expression-admission-guard"]},
    {id:"pr-07",feature:"原生提交读模型",description:"真JSONL/native operation tip证明主动助手提交；回执未确认时隐藏，拒绝准入不调用Provider；合法静默保留空tip证据但返回skipped且不投影气泡",why:"不能把UI文本或message_end当作持久送达，guard必须在Provider前生效，静默不能被伪装成送达",layer:"integration",depth:"deep",scenarios:["proactive-expression-commit","proactive-admission-guard","proactive-silent-skip"]},
    {id:"pr-08",feature:"领域引导拆分与接线",description:"initDomainBootstrap 是唯一 Node 引导序列（src/services/init.ts，src/harness/main.ts 调用）：按序接上路径/CONFIG→记忆与 dreaming→Profile 元数据→Card/registry→主动回执读取器→工具与 slash 命令表→会话恢复与 Plan checkpoint→空会话欢迎语（激活 Card 问候语、恰好落盘一条）→原生 UI 桥→窗口观察→主动/了解调度；同一进程重复调用并入同一次运行（含失败结果——失败也锁在单次闩里，修复环境后不重试，向上抛并保留真实错误码，后续步骤不执行）。Node 引导不注册主题消费者、不做 CSS 翻译（旧机制已删）：Profile 激活只经零依赖叶子通知原生 UI 重推舞台，主题样式在原生 UI 侧消费",why:"两套引导会让唯一 Node Harness 的状态初始化两次；失败被吞或允许重试会把半初始化状态当成可恢复（单次闩把失败也锁住）。拆分点必须有行为门禁，不能靠「碰巧没冲突」；主题消费已随 UI 移出 Node 域，不再是本点的验证内容",layer:"integration",depth:"deep",scenarios:["init-domain-sequence","init-domain-failure-visible"]},
  ],
  // L4 校验只统计 layer:"e2e" 覆盖点；其余 caseId 在 L2/L3 由跨层校验负责。
  rules:{minScenarios:2,minDeepScenarios:2,requireBoundary:true,requireErrorPath:true},
}
