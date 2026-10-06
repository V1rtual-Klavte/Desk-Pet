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
// 2026-10-05 频率档位 W1-T3（本批登记，未跑 analyze→generate）：sourceFiles 变化 ——
// scanner.ts（screenState 三态准入：unavailable 丢弃、locked 与 observed 同样放行）、
// observation/scheduler.ts + decide.ts（locked 批次跳过截图、决策提示改用最后一次窗口快照、
// Node 侧单批 ≤3 目标截断删除）。新增 pr-09（观察门禁资格）与 pr-10（变量跨档机会接线）
// 两个 integration 覆盖点，caseId 由对应 L3 用例携带；sourceHash 与 pr-01..pr-08 的逐点
// 复核留待收口波统一 analyze→generate。
// 2026-10-05 频率档位 W2-B1（本批登记，未跑 analyze→generate）：sourceFiles 变化 ——
// scanner.ts（控制门禁改读 CONFIG 档位 proactiveFrequency()、固定 tickMs 节拍改档位区间
// 随机唤醒、四个数值改档位派生）、control.ts（enabled 链路删除后改为档位投影下发
// pushProactiveLimits）、index.ts（setEnabled 与进程内控制分发删除）、cooldown.ts（默认
// 冷却取中档派生值）；同步 agent/memory/protocol.json 的 ProactiveControl.enabled 删除与
// ProactiveControlRequest.limits 新增（W2-A1 已改生成物）。新增 pr-11 覆盖点，caseId 由
// test/integration/proactive/档位调度与投影.test.ts 携带；sourceHash 留待收口波统一刷新。
// 2026-10-05 频率档位 W4-A（本批登记，未跑 analyze→generate）：sourceFiles 行为面变化 ——
// planner.ts（规划子运行改带只读工具：按注册名从工具注册表取 SAFE 白名单 screenshot /
// window_info / system_info，maxRounds 封顶 3；clipboard_read 与 MCP 工具因声明 DANGER 不纳入
// —— 无用户回合会在 awaitPermission 上干等确认；screenshot 另受模型能力闸（辅助模型
// `input` 不含 image 时不发，截图结果带图片块会打挂回灌）；规划输入补齐 Card 人设 / presence / 变量池 /
// 行为画像 / 可读本地时间，人设与变量按 token 预算截断；目标记忆召回加 ai.memory.enabled 总闸，
// 与 scanner / 观察决策同口径）、proactive/config.ts（新增 PLANNING_TOOL_ROUNDS /
// PLANNING_PERSONA_BUDGET / PLANNING_VARIABLE_BUDGET）。scanner.ts 的表达侧
// planner_tools_present 门禁语义未变（核实：它检查的是表达 attempt 的 reservation，不是规划
// attempt）。新增 pr-12（unit）与 pr-13（integration）两个覆盖点；sourceHash 留待收口波统一刷新。
// 2026-10-05 频率档位收口波（analyze→generate）：sourceFiles 按 W2-M9 补列 `src/services/
// cooldown.ts` 与 `src/services/proactive/tiers.ts`（pr-11 的实现依赖两者：冷却默认值与 TS 查表）。
// 新增 pr-14（unit）登记静默时段三形态与派生窗口的 7 个 L2 caseId（W2-M1 清单）；pr-12 / pr-13
// 的既有登记经对账通过（caseId 与 test/unit/proactive/规划子运行与输入.test.ts、test/integration/
// proactive/规划子运行门禁.test.ts 逐一对应）。sourceHash 按当前源码复算。
// 2026-10-06 上下文窗口默认值批次（analyze→刷新）：sourceFiles 变化 —— src/services/config.ts
// （2f32519：所引 DEFAULT_CONTEXT_WINDOW 的值 131_072→262_144，config.ts 自身只改了引用注释，
// getter 形状与读取键未动）。pr-01..pr-14 逐点核对：没有任何覆盖点描述上下文窗口默认值 /
// contextMaxTokens（pr-04 的用量账本与 pr-12 的 token 封顶都不读该缺省），主动链行为面未变、
// 描述经核对仍准确，未修订覆盖点；sourceFiles 无需增删（config.ts 已在列；budget.ts 不在列且
// 主动链不直接消费它）。本契约此前被 config 批次留在 STALE，本批一并收口，sourceHash 按当前
// 源码复算。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（规划子运行的 provider 准入经 createTurnSpec 转发后
// 才真正被咨询；子运行 invisible sinks）与 src/services/proactive/scanner.ts（规划准入从未被
// 咨询的路径新增 log.warn 留痕，此前完全静默）。pr-01..pr-14 逐点核对：pr-12 的规划输入/工具
// 面与 pr-13 的表达侧 claim 门禁语义未变（修的是规划侧准入接线与静默路径留痕；该接线本身的
// L3 覆盖登记在 agent-runtime 的 ar-26），其余点不在改动面内、实现点仍在，未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（估算偏差对账口径；主动链机会、调度与投影未动）。
// pr-01..pr-14 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码
// 刷新 sourceHash。
// 2026-10-06 回合治理与图片生命周期批次（analyze→generate）：sourceFiles 删
// `src/services/cooldown.ts`（整模块删除——冷却真相源搬进 Rust 账本，AI 生成锁搬进
// engine/harness），其余条目为行为面变化 —— scanner.ts（门禁改读 scan.budget.cooldownUntil，
// 冷却不再由 Node 持有；`isAIGenerating` 改从 harness 取）、config.ts（ai.lock 整节删除，主动链
// 不读该键）、agent/runner.ts 与 harness/runtime.ts（受理计数接管 AI 锁）、
// proactive/store.rs（cooldownUntil 快照 + claim 门禁 denied_claim("cooldown")）、
// agent/memory/protocol.{json,ts}（ProactiveBudget.cooldownUntil）。新增 pr-15（integration）
// 登记 `proactive-cooldown-gate`（test/integration/proactive/冷却门禁.test.ts）。AI 生成锁的
// 真相源迁到 `engine/harness/harness-slot.ts`，但锁本身不由本契约覆盖点断言（其 L3 覆盖登记在
// agent-runtime），故 sourceFiles 未增列该文件。前几批留待收口的登记一并收口：W1-T3 的
// pr-09/pr-10、W2-B1 的 pr-11、W4-A 的 pr-12/pr-13 与 pr-14 的实现点逐点核对仍在（scanner 的
// screenState 准入与表达侧 toolCount 门禁、scheduler/decide 的 locked 批次、tiers/control 的
// 档位查表与投影、planner 的白名单与 maxRounds、time.ts 的静默派生），覆盖描述与当前实现一致；
// pr-01..pr-08 对照实现点与 caseId 载体逐点核对（time.ts / opportunities.ts / planner.ts /
// usage.ts 实现点仍在，L4 场景与 L3 用例的 caseId 均存在），未发现需修订项。除新增 pr-15 外
// 未修订覆盖点；本轮只做描述与来源一致性核对（非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 验收收口（本批刷新）：sourceFiles 变化仅限 scanner.ts 的**注释**（冷却起点口径改指
// occurrence 的 `updated_at`，与 Part 3 的 B 方案裁定对齐）；pr-01..pr-15 逐点核对实现点与覆盖
// 描述仍一致，未修订覆盖点，按当前源码刷新 sourceHash。
// 2026-10-06 证据缺口补漏（本批登记）：新增 pr-16（integration：生成锁门禁）登记
// `proactive-ai-generating-gate`（test/integration/proactive/生成锁门禁.test.ts）—— scanner 在
// 表达前检查 isAIGenerating()：回合在飞时跳过并留痕 proactive_skipped(reason:"ai_generating")、
// 表达端口不被触达（门禁排在 lane_busy 之前，锁与在飞 lane 同时为真时理由必须是 ai_generating）；
// 锁归假后同一机会照常放行。pr-11 增补 scenario `proactive-tier-table-frozen`
// （test/unit/proactive/档位表与收拢.test.ts，先于本批无 caseId）：档位值表按契约 §2.3/§5.4
// 的字面值冻结（改任何一档的数值都会红）。pr-01..pr-15 逐点核对实现点仍在、覆盖描述与当前实现
// 一致，未修订覆盖点。sourceFiles 未增删，sourceHash 按当前源码复算。
// 2026-10-06 日 token 闸撤除批次（本批刷新）：sourceFiles 行为面变化 —— store.rs（claim 门禁
// 删除 `token_budget` 拒绝：日 token 总量不再作为拒绝理由；reserved/used/unknown 的记账、
// settle 回冲与 scan budget 快照照旧；辅助预留同口径删除 token 总量检查，dailyLimit 次数仍是
// 唯一硬边界，函数签名不再接收 ProactiveLimits）、commands.rs（辅助预留命令不再消费档位投影，
// 原「低档 token 上限」用例改钉「不按 token 拒、次数仍收紧」）、mod.rs（daily_tokens 注明为
// 观测阈值，不再参与裁决）。host/dispatch.rs 同步改了分派臂参数（未列 sourceFiles：wire 形状
// 与命令签名未动）。Rust 新增两条内联断言（planning 烧满 token 账后表达 claim 仍被放行 / 反向
// 对称），已写未运行（留验收统一跑）；pr-04 覆盖描述修订「辅助预留共享总额」→「计入同一 token
// 账、总量不再参与准入」，pr-01..pr-16 其余各点核对实现点仍在、覆盖描述与当前实现一致。
// sourceHash 按当前工作区源码复算（同时含并行工作线在非本契约文件上的改动）。
// 2026-10-06 dreaming 日 token 闸撤除批次（本批刷新）：sourceFiles 变化 ——
// src/services/proactive/protocol.json 的 tiers.dreaming 删除 dailyTokens（日上限不再是门禁，
// 也不留观测阈值；三档剩余 idleSeconds / minIntervalMinutes 数值不变），生成物 protocol.ts 与
// crates/native-host/src/memory/protocol.rs 同批重生成（主动链行为未变）。pr-11 描述补一句
// 「dreaming 档 dailyTokens 已删除，档位值表冻结只覆盖剩余字段」；其余覆盖点不在改动面内。
// sourceHash 按当前工作区源码复算。
// 2026-10-06 第二轮实测反馈批次（本批验收 analyze→generate）：sourceFiles 行为面变化 ——
// crates/native-host/src/proactive/{store,commands,mod}.rs 与 protocol 链的日 token 闸撤除
// （claim 与辅助预留都不再按 token 总量拒绝；reserved/used/unknown 照记；唯一硬边界是次数）、
// tiers.dreaming 的 dailyTokens 删除（见上一条批次）、config.ts（回合墙钟与计划步骤超时放宽，
// 主动链不读这两个键）、tool/registry.ts（新增 propose_plan 注册，pr-12 的白名单仍按注册名
// 过滤、名单外工具不进场）。层级登记修正（快层报 MISSING/ORPHAN）：`proactive-tier-table-frozen`
// 由 unit 层（test/unit/proactive/档位表与收拢.test.ts）收集，此前被登记在 integration 的
// pr-11 上；本批按实际载体拆出为同层单元点 pr-17（pr-11 只保留档位门禁/唤醒/投影四条 L3
// 语义），caseId 未删、未挪层。pr-01..pr-17 逐点核对实现点仍在、覆盖描述与当前实现一致
// （非逐行行为审计）；pr-04 的 token 账新口径与 pr-16 的生成锁门禁描述按当前实现复核无误。
// sourceHash 按当前工作区源码复算（同时含并行工作线在非本契约文件上的改动）。
export const proactiveContract:ModuleContract={
  module:"proactive",sourceHash: "c7c5d827ec67909dc2057c670e6b0888b93539c08151b64ebb35a83ecdca7e93",
  sourceFiles:["src/services/proactive/config.ts","src/services/proactive/index.ts","src/services/proactive/scanner.ts","src/services/proactive/opportunities.ts","src/services/proactive/time.ts",
    "src/services/proactive/planner.ts","src/services/proactive/delivery.ts","src/services/proactive/ipc.ts","src/services/proactive/auxiliary-budget.ts","src/services/proactive/control.ts","src/services/proactive/protocol.json",
    "src/services/proactive/protocol.ts","src/services/proactive/tiers.ts","src/services/proactive/trace.ts","src/services/proactive/types.ts","src/services/proactive/presence.ts","src/services/proactive/usage.ts",
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
    {id:"pr-04",feature:"周期与用量治理",description:"周期由可信用户明确约定：可先记录提议，只有本轮明确同意并引用匹配的 proposalId 才能建立，跨回合接受不看 runGeneration 但必须同会话/Card/hash；延后保留原有效期、不截短周期；随机1–3小时持久槽只限普通分享，画像/锚/晚安不被误挡；实际Token包含缓存分列，辅助预留计入同一token账（总量不再参与准入）且unknown结算保留账本，静默skip结案且不记成功或重放",why:"既不能把提议当成授权，也不能让延后静默截断已同意的周期，更不能以零值掩盖失败成本、遗留预留、阻断锚时机或重放静默机会",layer:"unit",depth:"deep",scenarios:["proactive-recurrence-consent","proactive-actual-usage","proactive-recurrence-proposal-acceptance","proactive-recurrence-snooze-validity","proactive-random-interval-scope"]},
    {id:"pr-05",feature:"结构化送达提交",description:"真实生产回合无工具主动表达，先核对JSONL终态tip再SQLite回执，回执成功后才投递会话视图（pushCommittedProactiveMessage）；原生 UI 经会话投影/正文推送看到已提交条目",why:"模型文本、message_end、随机UI身份均不能证明送达",layer:"e2e",depth:"deep",scenarios:["proactive-expression-native-commit"]},
    {id:"pr-06",feature:"失效与恢复",description:"失效末端守卫不提交有效消息或变量；精确请求/尝试身份恢复已提交回执，无副作用重放",why:"切换/插话与崩溃均可能使异步结果归属错误",layer:"e2e",depth:"deep",scenarios:["proactive-expression-admission-guard"]},
    {id:"pr-07",feature:"原生提交读模型",description:"真JSONL/native operation tip证明主动助手提交；回执未确认时隐藏，拒绝准入不调用Provider；合法静默保留空tip证据但返回skipped且不投影气泡",why:"不能把UI文本或message_end当作持久送达，guard必须在Provider前生效，静默不能被伪装成送达",layer:"integration",depth:"deep",scenarios:["proactive-expression-commit","proactive-admission-guard","proactive-silent-skip"]},
    {id:"pr-08",feature:"领域引导拆分与接线",description:"initDomainBootstrap 是唯一 Node 引导序列（src/services/init.ts，src/harness/main.ts 调用）：按序接上路径/CONFIG→记忆与 dreaming→Profile 元数据→Card/registry→主动回执读取器→工具与 slash 命令表→会话恢复与 Plan checkpoint→空会话欢迎语（激活 Card 问候语、恰好落盘一条）→原生 UI 桥→窗口观察→主动/了解调度；同一进程重复调用并入同一次运行（含失败结果——失败也锁在单次闩里，修复环境后不重试，向上抛并保留真实错误码，后续步骤不执行）。Node 引导不注册主题消费者、不做 CSS 翻译（旧机制已删）：Profile 激活只经零依赖叶子通知原生 UI 重推舞台，主题样式在原生 UI 侧消费",why:"两套引导会让唯一 Node Harness 的状态初始化两次；失败被吞或允许重试会把半初始化状态当成可恢复（单次闩把失败也锁住）。拆分点必须有行为门禁，不能靠「碰巧没冲突」；主题消费已随 UI 移出 Node 域，不再是本点的验证内容",layer:"integration",depth:"deep",scenarios:["init-domain-sequence","init-domain-failure-visible"]},
    {id:"pr-09",feature:"观察门禁资格（screenState 三态）",description:"命令路径 screenState 决定两条链的准入：unavailable（真不可知）时主动机会在准入丢弃并留痕 proactive_skipped(observation_unavailable)，express 不被调用；observed 与 locked（用户离开）同样放行到表达端口。locked 时静默了解批次仍可跑（预算准入与结算照常），但不请求 observation_capture_screen，决策提示改用最后一次窗口快照并注明 observedAt 的陈旧性；窗口类机会仍按当前窗口可用性自然失效（不是额外加严）",why:"锁屏语义修复前该字段恒 unavailable，主动消息与静默了解两条链全停；把 locked 当不可观察会让故障原样保留，而一律跳过截图或对窗口数据放行又会让锁屏批次读不到新鲜证据或假装窗口仍在",layer:"integration",depth:"deep",scenarios:["proactive-observation-gate"]},
    {id:"pr-10",feature:"变量跨档机会的接线",description:"默认卡数值跨过 proactiveBands 档位时，scanner 的变量提交分支形成 variable_change 机会（槽位带跨档后的档位下标）；同一档位内的写入不形成机会。断言落在机会构造槽位而不是回调次数上",why:"proactiveBands 曾被一律解析成字符串数组而整条丢弃，机会恒不产生；这条接线回归只有真实 Card/变量池链路能观测，单元层的档位算术覆盖不到解析接线",layer:"integration",depth:"shallow",scenarios:["proactive-variable-band-opportunity"]},
    {id:"pr-11",feature:"档位门禁、随机唤醒与投影",description:"主动消息档位（CONFIG ai.proactive.frequency）是唯一开关，取代固定 tickMs 节拍：off 时不排唤醒定时器、事件唤醒不扫描（tick 自身也留 proactive_off 跳过痕迹）、不下发档位投影；低/中/高三档各自按 wakeMinMs–wakeMaxMs 区间（[min,max) 左闭右开、向下取整）随机抽下一次唤醒延迟；事件唤醒先取消旧定时器、由 tick 收尾统一重排（无双重调度）；档位变更（refreshProactive）换到新档区间，并把该档一整行 limits 经 proactive_control 投影下发（off 不推，Rust 保持现值/缺省）；档位值表本身的冻结与读取期收拢是同模块的 L2 语义，见 pr-17",why:"固定节拍换成随机唤醒后，档位必须真的决定唤醒区间与门禁：off 若只靠 Rust 终裁拦截，Node 仍会按节拍唤醒并扫描，把「关」变成「只是不发送」；投影行必须与档位表逐字段一致（Rust 按整行精确匹配校验），把中档/高档截在旧上限会静默压掉高频能力",layer:"integration",depth:"deep",scenarios:["proactive-tier-gate-off","proactive-random-wake-schedule","proactive-wake-interval-bounds","proactive-limits-projection"]},
    {id:"pr-12",feature:"规划子运行的有界工具面与输入补齐",description:"规划子运行按注册名从工具注册表装配白名单工具（screenshot / window_info / system_info）：名单外工具与声明非 SAFE 的工具都不进场；注入 run 的 maxRounds=3、timeout 与输出预留封顶、scope 携带会话与取消信号；owner 失效、取消或工具用尽后没有合法 JSON 时都以 decline 收口（planning_cancelled / planner_invalid_decision）。规划输入 task 补入 Card 人设摘要（token 预算截断）、presence 快照与判定时刻、变量池只读摘要（system 原始值与 card/interaction 当前值，不含写入指令与 VariableState 元数据）、行为画像质量与就近三小时的活跃毫秒、带时区的可读本地时间；目标记忆召回受 ai.memory.enabled 总闸门禁，关闭时 evidence 按空降级而不是报错",why:"规划器升级为带工具的有界 agent 后，工具面必须只含无用户回合也能执行的只读工具（DANGER 级会落到 awaitPermission 干等用户确认），且轮数/超时/token 都必须有封顶；输入补齐是「把决定权真正交给 LLM」的另一半，没有人物、画像与变量的规划只能靠窗口与记忆片段做决定",layer:"unit",depth:"deep",scenarios:["proactive-planner-tool-whitelist","proactive-planner-tool-level-guard","proactive-planner-screenshot-model-gate","proactive-planner-run-bounds","proactive-planner-cancel-decline","proactive-planner-tool-exhausted-decline","proactive-planner-input-context","proactive-planner-input-weekend","proactive-planner-input-degraded","proactive-planner-memory-gate"]},
    {id:"pr-13",feature:"表达准入的工具门禁",description:"表达 attempt 的准入回调在 reservation.toolCount!==0 时在 claim 之前整次拒回并留痕 proactive_skipped(planner_tools_present)；toolCount=0 的当前形态照常进入 claim。规划子运行带工具不改变表达侧 tools=[] 的口径",why:"规划子运行放开工具后，表达侧必须继续无工具：表达是用户可见的最终输出，工具面会改变主动消息的生成路径与计费面；门禁必须在 claim 之前生效，不能让被拒的表达消耗当日配额",layer:"integration",depth:"shallow",scenarios:["proactive-expression-tool-gate"]},
    {id:"pr-14",feature:"静默时段（CONFIG 派生）与窗口派生",description:"静默时段是 CONFIG 派生（ai.proactive.quietStartHour/quietEndHour，默认 23/9，仅约束主动消息）：isQuietHour/isQuietTime 覆盖跨夜 / 同日 / start==end（不静默）三形态并随 CONFIG 值走（setOverride 后同日静默生效、start==end 全不静默）；nextSpeakingTime 三形态（跨夜顺延次日、同日回到当日结束、相等原样返回）；isNightlyWindow 是静默开始前一小时（start=0 落前一日 23 点）；checkin 的 before 窗口随静默三形态派生且 from 恒早于 until；白天硬窗口（9–12 / 18–22）删除后 rhythm/retrospective 整日有效、只有静默时段是硬边界；晚安窗口收口于静默开始时刻（quietStartHour−1 派生，不硬编码 22）",why:"静默时段是用户可配置的硬边界：窗口派生、晚安收口与 checkin 窗口若仍读旧常量，用户改静默时段后这些机会会按旧时刻静默/放行，感知为「设了没用」",layer:"unit",depth:"deep",scenarios:["proactive-quiet-hour-forms","proactive-quiet-config-driven","proactive-next-speaking-forms","proactive-nightly-window-derived","proactive-checkin-window-derived","proactive-no-daytime-window","proactive-retrospective-goodnight-derived"]},
    {id:"pr-15",feature:"冷却门禁（账本推导 + 快照读取）",description:"全局冷却的起点在宿主账本：scan 的 budget.cooldownUntil = proactive_occurrences 中 kind='expression' 且 status='committed' 的 MAX(updated_at) + 档位 limits.cooldownMs（全表查询、跨日成立；无记录或已过期给 null），claim 在同一窗口内以 denied_claim(\"cooldown\") 拒绝且不受 respect_random_interval 约束。Node scanner 的门禁只读该快照：未过期时机会被跳过并留痕 proactive_skipped(reason:\"cooldown\")、表达端口不被触达；已过期或 null（无 committed 记录）照常放行。Node 不再持有可写冷却状态、不再有强制解锁定时器；unresolved 结算不构成冷却起点，对账补提交后按对账时刻起算",why:"冷却状态留在 Node 内存时重启即丢、多入口各持一份，既可能在窗口内重复发话也可能永久冷却；搬到账本后「窗口内不重复发话」只由已提交投递的记账时间推导，Node 与宿主读同一份快照，冷却起点在记忆治理清扫下也不被改写",layer:"integration",depth:"shallow",scenarios:["proactive-cooldown-gate"]},
    {id:"pr-16",feature:"生成锁门禁（回合在飞不发话）",description:"scanner 在表达前检查 isAIGenerating()（受理计数 + 槽状态推导，真相源在 engine/harness/harness-slot）：回合在飞时该机会在门禁处跳过并留痕 proactive_skipped(reason:\"ai_generating\")、表达端口不被触达。门禁排在 lane_busy 之前 —— 锁与在飞 lane 同时为真时留痕理由必须是 ai_generating 而不是 lane_busy。回合交回（锁归假）后同一机会、同一档位照常放行：唯一变量是回合状态；同一在飞回合的 Provider 请求由闸门扣住，锁为真是在真实回合上验证的，不是另一个可写布尔",why:"回合在飞时主动发话会与用户正在进行的对话抢话；把该分支删掉或排到 lane_busy 之后，留痕会退化成别的理由而表达仍可能被放行 —— 用户会看到角色在生成中途自行插话，而扫描日志里看不出这是生成锁没挡住",layer:"integration",depth:"shallow",scenarios:["proactive-ai-generating-gate"]},
    {id:"pr-17",feature:"档位值表冻结与读取期收拢",description:"档位值表（tiers.ts 的三域各档数值）按契约 §2.3/§5.4 的字面值冻结：主动消息档由 L2 用例逐字段见证（唤醒区间上下限、每日次数、最小间隔与散布、dailyTokens 观测阈值、停留/结算/冷却各值，改任何一档的数值都会红）；dreaming 档的 dailyTokens 已随 2026-10-06 日 token 闸撤除从表中删除，冻结只覆盖剩余字段（idleSeconds / minIntervalMinutes）；读取期对非法/缺失档位收拢为 medium 且不改写不写盘",why:"档位数值是唤醒节拍、冷却窗口与整行投影下发的唯一真相源：任何一档被改动都会静默改变实际运行节奏；被删的 dreaming dailyTokens 若被加回、或收拢退化成把非法值当合法档位，冻结与收拢断言必须变红",layer:"unit",depth:"shallow",scenarios:["proactive-tier-table-frozen"]},
  ],
  // L4 校验只统计 layer:"e2e" 覆盖点；其余 caseId 在 L2/L3 由跨层校验负责。
  rules:{minScenarios:2,minDeepScenarios:2,requireBoundary:true,requireErrorPath:true},
}
