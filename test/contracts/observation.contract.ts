// 2026-10-05 设置页 Card 增删改查 + 模版批次：本契约 sourceFiles 中三处变化，均为新增 ——
// `src/services/native-ui/host-requests.ts` 加四条 Card 请求臂、`ui/settings/schema.rs`
// 的 AI 页「人格」节加 7 个 action.card* 动作字段（silentAccess 字段与既有动作未动）、
// `host/dispatch.rs` 加 `personality_file_delete` 分派臂；sourceFiles 里
// `src/services/config.ts` 的累积改动经核对，增删行未出现 silentAccess / observation /
// proactive 相关键。ob-01..ob-07 逐点复核行为面未变，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：sourceFiles 变化 —— runtime.ts（RUNTIME_DATA 协议缺失
// 检测与提醒接线）、config.ts + ui/settings/schema.rs（设置面的当批改动；经核对 current
// 源码里 silentAccess 与观察/主动读取键、ob-* 相关字段未受影响）、
// crates/native-host/src/commands/mod.rs（仅命令域头注释里的设计契约路径改指 history 归档，
// observation_cmd / monitor_ctl 模块声明未动）。ob-01..ob-07 逐点核对实现点仍在、语义未变，
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造；
// 观察调度、静默了解与主动读取链路不在改动面内）。ob-01..ob-07 逐点核对实现点仍在、覆盖
// 描述与当前实现一致。本批刷新同时包含另一会话的改动；本轮只做 coverage 描述与当前实现
// 一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志）与 runtime/types.ts（新增 CompactionDeclineRecord
// / CompactionTrigger / CompactionDeclineKind / CompactionOverflowDetail，压缩审计槽专属类型，
// 观察域的 snapshot / types 消费点不受影响）。ob-01..ob-07 逐点核对实现点仍在、覆盖描述与
// 当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 复算补充（同一刷新轮）：复算时并发落进一处本批改动单之外的 context/budget.ts
// 变化（keepRecentTokens 上限改为随窗口长大；并发写入，不在本批改动单内）。按当前源码复算，
// sourceHash 一并覆盖它；ob-01..ob-07 无覆盖点描述 keepRecentTokens，逐点核对不受影响。
// 2026-10-05 频率档位 W1（本批只做描述订正与登记，未跑 analyze→generate）：sourceFiles 变化 ——
// scheduler.ts（screenState=locked 的批次资格、锁定批跳过截图、决策提示改用最后一次窗口快照）、
// decide.ts（删除单批 ≤3 目标截断与提示词）、config.ts（删除 MAX_READ_TARGETS_PER_BATCH）、
// observation_cmd.rs / monitor/*（Rust 终裁与 screen_state 改名，锁屏可用）。ob-04 的 ≤3 口径
// 已按 Node 现状订正；ob-03 的 Rust 上限描述与全表 sourceHash 留待收口波统一 analyze→generate。
// 2026-10-05 频率档位 W4-B（本批只做描述订正与登记，未跑 analyze→generate）：sourceFiles 变化 ——
// scheduler.ts（决策输入补齐：本地时间 / Card 人设有界摘要 / 行为画像快照 / 话题权重 top-5 /
// 长期记忆核心画像，均只读、有界、运行时绑定；召回关闭重排，不新增模型调用）、decide.ts
// （新增 DECISION_MEMORY_TOKEN_BUDGET、boundedCardBrief、localTimeBrief 与提示词参考资料口径）。
// ob-04 描述补「决策输入」一句并登记三个新 caseId（由 test/integration/observation/
// 决策输入补齐.test.ts 与 test/unit/observation/决策解析与读取名额.test.ts 携带）；
// sourceHash 与其余逐点复核留待收口波统一 analyze→generate。
// 2026-10-05 频率档位收口波（analyze→generate）：ob-03 的 Rust 读取上限描述订正 —— W1 已删
// 大小/条目数值上限、保留路径边界（绝对路径 / canonical 解析 / home 内 / 数据根外 / 非凭据 /
// 非 home 系统目录），目录全量列名、文件整读。ob-04 拆点：决策输入三 caseId（observation-
// decision-inputs / -degrade / -memory-identity）载体是 L3（决策输入补齐.test.ts），归新增
// ob-08（integration）；上一段的「由…与决策解析与读取名额.test.ts 携带」据此更正 —— 该 L2
// 文件实际只携带 parse / read-quota / card-brief / local-time 四个。新增 ob-09（integration）
// 登记 静默了解档位参数消费.test.ts 的 4 个 caseId。ob-01..ob-07 其余点按当前源码复核未变；
// sourceHash 按当前源码复算。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— crates/native-host/Cargo.toml 与
// Cargo.lock（image 依赖新增 tiff feature：只为剪贴板粘贴转码开，聊天准入白名单（sniff）不变、
// 截图/观察链路不受影响；注释同步改写）、crates/native-host/src/host/dispatch.rs 新增一条
// chat_delete_session_images 分派臂（命令矩阵 134→135）。ob-01..ob-09 逐点核对实现点仍在、
// 覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（子运行 provider 准入转发与 invisible sinks；观察
// 决策、静默了解与话题链路未动）。ob-01..ob-09 逐点核对实现点仍在、覆盖描述与当前实现一致，
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/context/budget.ts（新增 totalInputTokens）、
// src/services/engine/harness/{runtime,model-gateway}.ts（偏差对账口径；观察决策与静默了解
// 链路未动）。ob-01..ob-09 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-06 回合治理与图片生命周期批次（analyze→刷新）：sourceFiles 变化 ——
// observation/scheduler.ts（isAIGenerating 改从 engine/harness 取：AI 生成锁真相源随
// `src/services/cooldown.ts` 删除移居 harness 的回合受理状态，调度门禁语义不变）、
// config.ts（ai.lock 配置整节删除，调度器不读该键）、engine/harness/index.ts（barrel 透出
// isAIGenerating 与 HarnessTurnAdmission；ob-07 负向断言的四个缺席名复核仍无命中）、
// engine/harness/runtime.ts、agent/runner.ts 与 proactive/store.rs（受理计数落点与冷却快照；
// 观察决策、静默了解与话题链路未动）。ob-01..ob-09 逐点核对实现点仍在、覆盖描述与当前实现
// 一致（ob-09 的档位门禁与 ob-04 的读取名额/决策解析未受本批影响），未修订覆盖点，仅按当前
// 源码刷新 sourceHash。
// 2026-10-06 dreaming 日 token 闸撤除批次（本批刷新）：sourceFiles 变化 ——
// src/services/agent/memory/ipc.ts（reserveMemoryDreamingBudget 去 dailyLimit、返回 void）与
// crates/native-host/src/host/dispatch.rs（对应分派臂同步）：dreaming 日 token 上限不再作门禁，
// 预留只记账。本契约覆盖点不在改动面内，未修订；本批刷新同时包含工作树中其它并发改动的
// 源文件（非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 第二轮实测反馈批次（本批验收 analyze→generate）：sourceFiles 行为面变化 ——
// config.ts（回合墙钟 120s→600s、计划步骤 90s→300s：观察/静默了解链不读这两个键）、
// agent/memory/ipc.ts（dreaming 预留在命令层只记账：去 dailyLimit、返回 void）、
// proactive/store.rs 与 commands.rs（claim 与辅助预留撤 token 总量闸：辅助侧仍按请求
// dailyLimit 与档位天花板收紧次数，ob-09 的档位参数预留语义未变）、host/dispatch.rs（对应
// 分派臂同步）、ui/settings/schema.rs（dreaming 档位 help 文案去 token 预算措辞，非行为面）、
// engine/harness/index.ts（新增 readLastConversationPromptTokens 导出；ob-07 的负向缺席名
// 复核仍无命中）。ob-01..ob-09 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，
// sourceHash 按当前工作区源码复算（同时含并行工作线在非本契约文件上的改动）。
import type { ModuleContract } from "../host/types"

export const observationContract: ModuleContract = {
  module: "observation",
  sourceFiles: [
    "src/services/observation/index.ts",
    "src/services/observation/types.ts",
    "src/services/observation/store.ts",
    "src/services/observation/topics.ts",
    "src/services/observation/scheduler.ts",
    "src/services/observation/ownership.ts",
    "src/services/observation/decide.ts",
    "src/services/observation/config.ts",
    "src/services/config.ts",
    "src/services/proactive/config.ts",
    "src/services/behavior/collector.ts",
    "src/services/window/listener.ts",
    "src/services/window/monitor.ts",
    "src/services/window/index.ts",
    // ob-07 断言的领域 barrel 面：主动 / 记忆两个 barrel 与上面的 observation / window
    // 属同一次「UI 协调移出领域面」裁定（W11b），其导出面的变化要重新审查该负向断言。
    "src/services/proactive/index.ts",
    "src/services/agent/memory/index.ts",
    "src/services/engine/harness/model-gateway.ts",
    "src/services/context/budget.ts",
    "src/services/images/budget.ts",
    "src/services/images/limits.json",
    "src/services/engine/runtime/snapshot.ts",
    "src/services/engine/harness/runtime.ts",
    "src/services/engine/harness/index.ts",
    "src/services/engine/runtime/types.ts",
    "src/services/agent/runner.ts",
    "src/services/agent/memory/ipc.ts",
    "src/services/proactive/content/pool.ts",
    "src/services/proactive/auxiliary-budget.ts",
    "crates/native-host/src/proactive/schema.rs",
    "crates/native-host/src/proactive/store.rs",
    "crates/native-host/src/proactive/commands.rs",
    "crates/native-host/src/commands/observation_cmd.rs",
    "crates/native-host/src/commands/mod.rs",
    "crates/native-host/src/host/dispatch.rs",
    "crates/native-host/src/error.rs",
    "crates/native-host/src/paths/security.rs",
    "crates/native-host/src/monitor/mod.rs",
    "crates/native-host/Cargo.toml",
    "Cargo.lock",
    // 原 `src/App.vue`（跨窗口观察治理生命周期；按 silentAccess 应用 setMonitorEnabled）随 WebView
    // 删壳退役：观察订阅与总闸应用已由 window/monitor.ts 的 initWindowObservation 接回（两者都在列）；
    // 跨窗口治理形态在单 Node 架构下取消，本地应用即真相源（见 observation/ownership.ts）。
    "crates/native-host/src/ui/settings/schema.rs",
    "src/services/native-ui/host-requests.ts",
    "test/integration/observation/了解层与话题来源.test.ts",
    "test/e2e/scenes/observation/静默访问关闭边界.scene.ts",
  ],
  sourceHash: "976fb22818645800fcfc59f86b1cdbc926b339550babc42d11a6cff93b5d9396",
  coverage: [
    {
      id: "ob-01",
      feature: "了解层来源、TTL、关闭与清除水位",
      description: "了解层只返回未过期的截图/文件/窗口摘要和来源身份；少于3条有效来源保持thin，关闭许可不向请求暴露观察；clear等待在途任务与入队写完成、撤掉摘要/标签，并持久化topic source watermark，提交前产生的老用户entry即使被普通回合补扫也不能回灌。Node集成只证明现有文件IPC/RAM语义，不假冒Rust截图和文件路径裁决。",
      why: "观察来源是可撤销派生资料，不能在关闭时进入模型，也不能在清除后被迟到任务或忙碌收件箱扫描复活。",
      layer: "integration",
      depth: "deep",
      scenarios: ["observation-understanding-ttl-clear"],
    },
    {
      id: "ob-02",
      feature: "话题画像的可信用户来源与失效",
      description: "只接受已提交origin=user、taint=trusted_user且eligibleForMemory的用户entry；话题辅助请求无tools，正文只在本次请求RAM中使用，持久层只含标签、权重、哈希sourceId、时间与Card失效范围。独立参与source达到2条后才向主动选材公开；标签source证据最多512条且自然保留90日；取消/清除/entry失效阻止旧标签回写。",
      why: "单次提及不等于偏好，工具/外部内容不具备用户来源资格；已遗忘或清除的话题不能继续驱动主动选材。",
      layer: "integration",
      depth: "deep",
      scenarios: ["observation-topic-trust-cancel", "observation-topic-revoked-before-provider", "observation-topic-large-batch-progress"],
    },
    {
      id: "ob-03",
      feature: "Rust观察命令的许可终裁",
      description: "静默访问关闭时，真实Rust注册的截图与目标读取命令（observation_read_targets）返回CANCELLED，系统窗口观察显示disabled；前端关闭只能阻止调度，最终权限由原生MonitorState裁决。读取目标由 AI 决策（decide.ts）、宿主逐项重校验（绝对路径、canonical 解析、主目录之内、数据根之外、非凭据路径、非 home 系统目录等路径边界；W1 起删除大小/条目数值上限——目录全量列名、文件整读），单项失败只记 skipped 不中断整批。",
      why: "前端状态或漏接的后台任务不能绕过用户关闭许可，原生边界必须阻止截图和文件读取。",
      layer: "e2e",
      depth: "deep",
      scenarios: ["observation-native-disabled-boundary"],
    },
    {
      id: "ob-04",
      feature: "静默了解的目标决策与读取名额",
      description: "读什么由 AI 决策：决策调用输出 {targets:[{path,kind,why}]}（绝对路径），解析器对围栏 JSON、非数组、字段非法、相对路径、重复路径一律退化为空清单（本批只截图、不报错崩批）；单批目标数不设硬上限（W1 起删除 ≤3 截断；单批读取量以剩余每小时名额为界），每小时读取名额（MAX_READS_PER_HOUR，滚动窗口）在批次开始前扣减，超限即跳过决策与读取。决策输入的基础块在同层按界断言：Card 人设有界摘要（名字/描述/角色设定截断）与带时区的可读本地时间；完整输入矩阵与降级由 ob-08（L3）覆盖。",
      why: "用户已撤销「指定目录」配置，读目标改由模型判断；决策输出是不可信输入，解析必须 fail-closed 且不能把坏 JSON 变成崩溃或乱读；输入块只读有界才能既把决定权交给模型，又不让每条链各自造证据或撑爆请求预算。",
      layer: "unit",
      depth: "shallow",
      scenarios: ["observation-decision-parse", "observation-read-quota", "observation-decision-card-brief", "observation-decision-local-time"],
    },
    {
      id: "ob-05",
      feature: "读取记账与了解层审计",
      description: "每发一个读取目标记 1 次并持久到 understanding.json 的滚动时间戳（上限 64 条、加载时滚出窗口外、清除了解域一并清空）；了解记录的 targets 审计字段随 record 落盘并裁剪到有界长度，旧记录缺 targets 仍可读取。",
      why: "每小时上限与「她读了什么」的可回看性都必须跨重启成立，否则上限形同虚设、用户无法审计 AI 读了哪些路径。",
      layer: "integration",
      depth: "shallow",
      scenarios: ["observation-read-accounting", "observation-audit-targets"],
    },
    {
      id: "ob-06",
      feature: "了解层旧档兼容读取",
      description: "加载 store 时保留 dir 记录与有界 targets，非法目标/非法类型/坏记账不让整次读取失败（逐条容错而不是整档报废）。",
      why: "了解层是增量落盘的历史文件，单条坏数据不能让静默了解整体不可用。",
      layer: "integration",
      depth: "shallow",
      scenarios: ["observation-legacy-store-compat"],
    },
    {
      id: "ob-07",
      feature: "UI 协调移出领域面（跨域边界）",
      description: "旧壳的跨窗口协调入口不再出现在领域 barrel 面：agent/memory 无 initMemoryRevisionSync、proactive 无 requestProactiveControl、observation 无 initObservationGovernance / stopObservationGovernance、window 无 initWindowListener；领域侧保留可用的本地路径（记忆 revision 的进程内分发不依赖任何 UI 通道，单 Node 架构下所有提交都发生在本进程）。窗口与观察治理入口退役是本点的主体，主动 / 记忆两个 barrel 面是同一次裁定的断言面（已登记进 sourceFiles）",
      why: "入口留在领域面，删壳后的窗口协调会被重新接线进 Node 图（造出第二真相源）；负向边界没有门禁就会被后续的「补兼容」悄悄加回来",
      layer: "integration",
      depth: "shallow",
      scenarios: ["ui-coordination-outside-domain-barrels"],
    },
    {
      id: "ob-08",
      feature: "静默了解决策输入补齐与降级（L3）",
      description: "决策输入在 W4-B 补齐为只读有界块并经 L3 端到端断言：本地时间（时刻+时区）、Card 人设有界摘要（名字/描述/角色设定截断）、行为画像快照（质量状态+就近 6 钟点活跃分钟）、话题权重 top-5（占比，仅 ≥2 独立来源的话题入榜）、长期记忆核心画像（召回端口空 query、token 上限 256、关闭重排、身份取运行时会话与激活 Card；条数与单条字符都有界）；原窗口快照与最近 8 条了解摘要保留。画像不可靠/话题为空/无 Card/无记忆时各块如实降级（null / [] / 质量状态原样）而批次照跑；无活跃会话时不发起记忆召回、不造身份。",
      why: "输入块只读有界才能既把决定权交给模型，又不让每条链各自造证据或撑爆请求预算；降级必须如实（不可靠带状态、无身份不造身份）而不是静默补块或抛错。",
      layer: "integration",
      depth: "shallow",
      scenarios: ["observation-decision-inputs", "observation-decision-inputs-degrade", "observation-decision-memory-identity"],
    },
    {
      id: "ob-09",
      feature: "静默了解档位参数消费（off/低/中/高）",
      description: "静默了解调度按 ai.silentAccess.frequency 档位取全部参数：off = 调度器不启动、不预留批次、话题入口不开启（可信来源被丢弃、批次零模型调用）；三档决定离开阈值（2h / 1h / 30min，差 1ms 不开）、批次间隔（2h / 30min / 15min——16 分钟前尝试在高档放行、中档被挡）与每日批数 / 每小时读取名额（4 / 8 / 12）——数值唯一来源是 proactive tiers 档位表，批次经 budget.reserve 以档位值预留；低档每小时读取名额占满时跳过决策调用、只做整理（一批 = 决策+整理两次辅助调用，名额耗尽时只剩一次）。",
      why: "档位是静默了解唯一的总闸与频率来源，任何一处仍读旧常量都会让档位选择无声失效（off 仍开批、中档按旧 4 批、低档按旧间隔）。",
      layer: "integration",
      depth: "shallow",
      scenarios: ["silent-tier-off", "silent-tier-medium-limits", "silent-tier-low-read-quota", "silent-tier-gap"],
    },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}
