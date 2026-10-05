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
  sourceHash: "c160dc0db3a264354b80a1499c4e016418017f8c7f0799d6381601236d8f5db5",
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
      description: "静默访问关闭时，真实Rust注册的截图与目标读取命令（observation_read_targets）返回CANCELLED，系统窗口观察显示disabled；前端关闭只能阻止调度，最终权限由原生MonitorState裁决。读取目标由 AI 决策（decide.ts）、宿主逐项重校验（home 内、非凭据、非数据根、大小/条目上限），单项失败只记 skipped 不中断整批。",
      why: "前端状态或漏接的后台任务不能绕过用户关闭许可，原生边界必须阻止截图和文件读取。",
      layer: "e2e",
      depth: "deep",
      scenarios: ["observation-native-disabled-boundary"],
    },
    {
      id: "ob-04",
      feature: "静默了解的目标决策与读取名额",
      description: "读什么由 AI 决策：决策调用输出 {targets:[{path,kind,why}]}（≤3、绝对路径），解析器对围栏 JSON、非数组、字段非法、相对路径、重复路径一律退化为空清单（本批只截图、不报错崩批）；每小时读取名额（MAX_READS_PER_HOUR，滚动窗口）在批次开始前扣减，超限即跳过决策与读取。",
      why: "用户已撤销「指定目录」配置，读目标改由模型判断；决策输出是不可信输入，解析必须 fail-closed 且不能把坏 JSON 变成崩溃或乱读。",
      layer: "unit",
      depth: "shallow",
      scenarios: ["observation-decision-parse", "observation-read-quota"],
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
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}
