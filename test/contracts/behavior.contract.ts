// 2026-10-10 整理水位推进修复（本批刷新）：sourceFiles 中仅 host/dispatch.rs 变化 —— memory_job_checkpoint 分派臂新增可选 coveredSourceIds 参数（批内水位按每个覆盖会话推进，见 memory 契约同批记录）；窗口采集、画像、presence 与原生观察协议不受影响，bh-01..06 逐点复核未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-09 验收补充：顶栏 typing 所有权泄漏修复波及本契约 sourceFiles（runner/runtime/titlebar 的 defer 判据收口与旧代际清扫），逐点复核与本院行为面不相交，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-09 最终静态复核：互斥计时、分类依据及计量升级撤销已静态复核，回归锚点同步；验收已执行（L2/L3 与 Rust 单测全绿），sourceHash 按当前源码在验收轮刷新。
// 2026-10-05 设置页 Card 增删改查 + 模版批次：本契约 sourceFiles 中仅
// `crates/native-host/src/host/dispatch.rs` 变化 —— 新增一条 `personality_file_delete`
// 分派臂（命令矩阵 128→129），既有命令接线与错误语义一个未改；观察协议命令
// （monitor_ctl / observation_cmd）与 monitor 路径不在该臂范围。bh-01..bh-06 逐点复核
// 行为面未变，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— crates/native-host/src/commands/mod.rs
// （仅命令域头注释里的设计契约路径改指 history 归档；模块清单与 monitor_ctl 的声明未动，
// 已与 pre-waveB 备份逐字对照确认无行为改动）。bh-01..bh-06 逐点核对：改动面与窗口采集、
// 画像、presence 与原生观察协议不相交，覆盖描述与当前实现一致。本批刷新同时包含另一会话
// 的改动；本轮只做 coverage 描述与当前实现一致性核对（非逐行行为审计），未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— crates/native-host/src/host/dispatch.rs
// 新增一条 `chat_delete_session_images` 分派臂（命令矩阵 134→135），不在窗口采集、画像、
// 2026-10-06 dreaming 日 token 闸撤除批次（本批刷新）：sourceFiles 变化 ——
// crates/native-host/src/host/dispatch.rs（memory_dreaming_budget_reserve 分派臂去 dailyLimit、
// 响应改 null：dreaming 日 token 上限不再作门禁，预留只记账）。本契约覆盖点不在改动面内，
// 未修订；本批刷新同时包含工作树中其它并发改动的源文件（非逐行行为审计），sourceHash 按当前
// 源码复算。
// 2026-10-06（本批刷新）：hash 变化来自**并发工作树**对 `crates/native-host/src/host/dispatch.rs`
// 的改动（非本批文件；本批只动了提问选择与去超时批次列出的文件）。覆盖点未修订，按当前源码复算；
// 该并发改动若继续推进，请在它的批次里重新 analyze→刷新。
// 2026-10-06 派生行为结论沉淀批次（analyze→刷新）：sourceFiles 新增
// `src/services/behavior/conclusions.ts` —— 画像层唯一允许进入长期记忆的出口（稳定结论视图）：
// 纯函数 `sedimentConclusions(snapshot)`，输入只有 `BehaviorSnapshot`（拿不到 daily/segments
// 原始账），reliable 档才产出、每条结论自带判据（窗口与画像字段）、不记具体某天的工时/精确
// 时间戳/逐次切换细节；结论由当前 30 日滚动窗口重算，可被新数据推翻（与原始账 7/40 日滚动
// 缓冲口径一致）。新增 bh-07 登记 4 个 caseId（L2 `结论沉淀视图.test.ts`）。另
// `crates/native-host/src/host/dispatch.rs` 变化：`memory_job_sources` /
// `memory_pending_source_count` 增可选 `origin` 参数（整理按来源类别取批），不在窗口采集与
// 观察协议面内。bh-01..bh-06 逐点核对实现点仍在、语义未变；本轮为描述与来源一致性核对
//（非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-08 定向复核（本批刷新）：sourceFiles 变化 = `crates/native-host/src/monitor/thread.rs`。
// 该文件的改动是**观察线程启动即首采**：原实现首轮判不出 generation 变化就直接睡到下一个平台
// 事件，于是「应用启动到用户第一次切窗口」之间窗口观察恒为空（实测就绪约 2 分钟 → 0.5 秒）。
// 对行为画像的影响面：**供给多了一条「启动时刻」的观察**（此前该时刻没有观察）—— 采集侧
// `collector.ts`、活跃/类别判定、rollup 口径与阈值一律未动。覆盖点描述与实现点均不变，
// 无 caseId 迁移。
// 2026-10-09 metrics/evidence sync: coverage and sourceFiles now include v2 activity buckets,
// legacy measurement quarantine, and derived-memory reconciliation. New caseIds are recorded
// below; sourceHash was refreshed by the root agent's acceptance pass (2026-10-09).
import type { ModuleContract } from "../host/types"

// 2026-10-10 记忆断点修复定向核对：本域既有消费者与分派语义未变；新增受控会话读取及请求内guide由memory契约持有，生成协议仅增命令/规范排版。
export const behaviorContract: ModuleContract = {
  module: "behavior",
  sourceFiles: [
    "src/services/behavior/aggregate.ts",
    "src/services/behavior/classifier.ts",
    "src/services/behavior/collector.ts",
    "src/services/behavior/conclusions.ts",
    "src/services/behavior/paths.ts",
    "src/services/behavior/types.ts",
    "src/services/agent/memory/evidence.ts",
    "src/services/agent/memory/sources.ts",
    "src/services/agent/memory/index.ts",
    "src/services/window/listener.ts",
    "src/services/window/monitor.ts",
    "src/services/window/types.ts",
    "crates/native-host/src/monitor/capture.rs",
    "crates/native-host/src/monitor/events.rs",
    "crates/native-host/src/monitor/mod.rs",
    "crates/native-host/src/monitor/thread.rs",
    "crates/native-host/src/monitor/visibility.rs",
    "crates/native-host/src/commands/monitor_ctl.rs",
    "src/services/proactive/presence.ts",
    "src/services/titlebar.ts",
    // 原 `src/components/StreamView.vue`（presence 动作的 DOM/CSS 呈现）随 WebView 删壳退役：
    // 呈现消费方在原生舞台尚未接线，本契约只覆盖到 presence 服务状态机与 titlebar 通道。
    "crates/native-host/src/commands/mod.rs",
    "crates/native-host/src/host/dispatch.rs",
    "test/e2e/scenes/behavior/原生观察边界.scene.ts",
  ],
  sourceHash: "52b607f8ace8c1b7aa08a542a57c0f01a492b2b714f34482abcd064408fe8be1",
  coverage: [
    { id: "bh-01", feature: "窗口类别与画像指标", description: "应用类别仅由命中的appId身份规则以high置信度确认；title只可提供low置信media activity hint，不能把未知app分类成已知类别，原始title不落盘。日历窗口生成近30日画像与真实7日activity/focus，不以最近有数据的天数冒充自然周；focus只表示已分类work/development应用的active连续段代理值，不宣称心理专注；未知应用时长不伪装为已知类别", why: "画像和机会必须有来源可解释，分类错误会伪造习惯与工作结论", layer: "unit", depth: "shallow", scenarios: ["behavior-app-classification", "behavior-metrics-source"] },
    { id: "bh-02", feature: "覆盖率与活动时间证据", description: "active/idle/unknown/unobserved四类时间互斥；短间隔仅在两端idle低于5分钟、前点idle加跨度仍不超过5分钟时可全计active，长间隔按单调idle证据切分，计数重置或无法解释的部分归unknown，墙钟超出monotonic确认量与边界前未证实部分归unobserved；hourMs只累计active。无有效采集时间时质量unavailable，至少3个有效观察日且covered/(covered+unobserved)达到60%才可靠；measurementVersion=2，旧daily在持久待办写入后删除，不进入新画像；读取失败可重试、ack后重启不反复撤销，持久撤销待办在memory recall或derived registration前关闭旧derived行为来源，闭包成功后ack，失败保留待办", why: "事件间长空窗与idle重置不能伪装成连续活跃或专注；旧口径daily和旧结论不能混入v2画像", layer: "unit", depth: "deep", scenarios: ["behavior-quality-threshold", "behavior-legacy-measurement-quarantine", "behavior-history-retry-and-marker-ack"] },
    { id: "bh-03", feature: "有限presence状态", description: "presence只允许idle/working/resting；状态由owner持有并可到期，短动作两秒以内且滚动一小时最多两次", why: "桌宠表现必须有限且不会覆盖其他状态所有者", layer: "unit", depth: "deep", scenarios: ["presence-owner-scope", "presence-motion-bound", "presence-owner-expiry"] },
    { id: "bh-04", feature: "实际观察与派生落盘", description: "真完整WindowObservation进入单一收集器；按本地日/小时分割并滚动写有界JSONL分片与每日聚合；窗口标题不落盘，图片段与日聚合来自真实IPC隔离根读取；长idle gap按证据切分，idle reset和阈值边缘不能全算活跃", why: "纯数学测试无法证明采集器真实调用存储、聚合与隐私边界正确", layer: "integration", depth: "deep", scenarios: ["behavior-persisted-rollup", "behavior-idle-bounded-gap", "behavior-reset-idle-unknown-gap"] },
    { id: "bh-05", feature: "画像清除与停止", description: "行为清除串行排空、删除behavior文件树并清内存读模型；采集许可保持原状，清除水位之前的迟到观察不能重建画像，之后的新样本可重新采集", why: "清除不能只清UI或留下能被后台回写的个人画像，也不能悄悄关闭用户启用的采集", layer: "integration", depth: "deep", scenarios: ["behavior-clear-erases-source"] },
    { id: "bh-06", feature: "原生观察协议", description: "Windows/macOS native command enable/disable 与独立 activity 查询返回锁屏、系统 idle、桌宠可见与前台；observation 带真实时间、generation/sequence、appId/app/title，隐私快照无标题/应用字段。注（可验证性边界）：E2E 宿主不启动 monitor 工作线程（`main.rs` 的 run_e2e 不调用 spawn_monitor_thread），`window-observed` 没有事件源 —— 场景把「宿主不会发布任何观察事件」断言成前置，事件载荷协议（采样时间、generation/sequence、前后台/可见性）当前无可执行入口验证；宿主在 e2e 分支接入事件源后该前置会失败并提示重写", why: "模拟载荷与TS类型不足以证明跨平台Rust采样和命令注册可用", layer: "e2e", depth: "deep", scenarios: ["behavior-native-observation"] },
    { id: "bh-07", feature: "稳定结论沉淀视图（记忆准入的唯一出口）", description: "`sedimentConclusions(snapshot)` 是画像层唯一允许进入长期记忆的出口：输入只有近 30 日画像读模型（rhythm/apps/focus/activity + quality），拿不到 daily/segments 原始账；只有 reliable（≥3 有效观察日且覆盖率 ≥60%）才产出结论，unavailable/insufficient 一律空数组；每画像组一条、共四槽位，文本只含带段/整比/取整表述并自带判据（窗口与画像字段），不输出具体某天的工时、精确时间戳、逐次应用切换细节或原始计数；同输入重算稳定、输入形状变化则文本变化（可重验/可推翻）。来源登记、整理与清画像失效链在 memory 契约（mm-46/mm-47/mm-48 与 Rust 单测）", why: "结论一旦进记忆就会长期留存而原始账是滚动缓冲：没有 reliable 门禁会把噪声当习惯，没有「结论+判据」就无从重验，原始账混入则等于把窗口外的个人数据写成长期事实", layer: "unit", depth: "deep", scenarios: ["derived-behavior-reliable-gate", "derived-behavior-conclusion-criteria", "derived-behavior-not-raw-ledger", "derived-behavior-recompute"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: false },
}
