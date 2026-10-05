// 2026-10-05 设置页 Card 增删改查 + 模版批次：本契约 sourceFiles 中仅
// `crates/native-host/src/host/dispatch.rs` 变化 —— 新增一条 `personality_file_delete`
// 分派臂（命令矩阵 128→129），e2e_trace / benchmark / 质量与性能脚本路径不受影响。
// eval-01..eval-09 逐点复核行为面未变，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：sourceFiles 变化 —— 仅 runtime.ts（RUNTIME_DATA 协议缺失
// 检测与提醒接线）。eval-01..eval-09 的 trace / 评测 / 保留路径逐点核对不受影响（提醒状态与
// log.warn 不新增 trace 事件、不改请求归属与快照落盘），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造；
// 不新增 trace 事件、不改 provider_usage 快照与请求归属，评测、保留与性能路径不受影响）。
// eval-01..eval-09 逐点核对实现点仍在、覆盖描述与当前实现一致。本批刷新同时包含另一会话的
// 改动；本轮只做 coverage 描述与当前实现一致性核对（非逐行行为审计），未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志）与 harness-slot.ts（compaction_end 按
// manual/overflow 落 deskpet.compaction_declined 条目、threshold 只留日志）。两者不新增 trace
// 事件、不改请求归属、快照与报告保留路径。eval-01..eval-09 逐点核对实现点仍在、覆盖描述与
// 当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
import type { ModuleContract } from "../host/types"

export const evaluationContract: ModuleContract = {
  module: "evaluation",
  sourceFiles: ["test/host/standard-setup.ts", "vite.config.ts", "src/services/engine/runtime/trace.ts", "src/services/engine/harness/harness-slot.ts", "src/services/engine/harness/runtime.ts", "src/services/engine/harness/model-gateway.ts", "src/services/agent/memory/provider.ts", "src/services/agent/memory/dreaming.ts", "crates/native-host/src/e2e_trace.rs", "crates/native-host/src/memory/benchmark.rs", "crates/native-host/src/memory/store.rs", "crates/native-host/src/paths/mod.rs", "crates/native-host/src/host/dispatch.rs", "test/host/trace-observer.ts", "test/trace/evidence.ts", "scripts/report-retention.mjs", "scripts/trace-evidence.mjs", "scripts/contract-layers.mjs", "scripts/e2e-test.mjs", "test/memory-quality/dataset.mjs", "test/memory-quality/index.mjs", "test/memory-quality/live-adapter.ts", "scripts/memory-quality-review.mjs", "scripts/memory-performance.mjs", "test/e2e/eval-models.ts", "test/eval-models.json", "test/e2e/memory-performance.ts", "test/host/performance.ts", "test/e2e/native-main.ts", "test/e2e/scene-runner.ts"],
  sourceHash: "aa74f321f2f129f8ce5684bf72ec2ef7ed91d9639498919a1b46dbee71f9754c",
  coverage: [
    {"id": "eval-01", "feature": "生产 trace 提交线路", "description": "真实 sendMessage 经过 Rust IPC：输入、host/Pi关联、Provider span、首文本生成与 JSONL assistant entry commit 一致；消息结束不冒充提交或UI首显", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "e2e", "depth": "deep", "scenarios": ["trace-production-commit"]},
    {"id": "eval-02", "feature": "惰性与隔离观测", "description": "无订阅者不计算payload；listener异常隔离、event冻结、spread context共享单调序号；正文与工具参数结果不进入允许字段，主动/行为事件只保留结构字段（应用身份、标题与任务正文被白名单挡下）", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["trace-lazy-off", "trace-listener-isolation", "trace-sequence-redaction", "trace-preview", "trace-scope-candidates", "trace-memory-rendered-schema", "trace-proactive-behavior-schema"]},
    {"id": "eval-03", "feature": "提交与记忆准入证据", "description": "真实 loop 和 JSONL 条目支持 commit 身份；注入自定义MemoryProvider，在真正Provider请求内核对预算淘汰结果和 rendered sourceIds", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "integration", "depth": "deep", "scenarios": ["trace-entry-commit", "trace-memory-rendered"]},
    {"id": "eval-04", "feature": "来源与有界缓冲", "description": "迟到事件保持最初trial归属；未知任务为orphan；有界映射淘汰；缓冲数/字节上限、序号缺口、drop及待ACK精确重试可见；单块字节预算切分（前缀出块、剩余留存、单条超预算独占一块、drop随批首块带走并清零）", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["trace-context-origin", "trace-bounded-ack", "trace-context-bound", "trace-chunk-byte-split", "trace-chunk-oversize-event", "trace-chunk-empty-boundary", "trace-chunk-drop-carry"]},
    {"id": "eval-05", "feature": "用户理想与独立审阅门禁", "description": "用户任意文本理想稿不自动生成；缺审阅pending；哈希、完整性、边界、全部trial及orphan引用核验；失配/drop/半行/完整终态后追加不能通过；静默trial可用真实边界引用", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["trace-review-pending", "trace-review-stale", "trace-review-hash-bound"]},
    {"id": "eval-06", "feature": "成组证据保留", "description": "保留单元是组：同一场的 json/html 与审阅/评分卫星连带（字节计入、孤儿卫星清除）、trace bundle 含 .pending 残片整组淘汰、performance 池同口径；最近3场且总200MiB且最新一组恒留；caseid/flaky产物保留", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["trace-bundle-retention", "report-retention-group-key", "report-retention-newest-three", "report-retention-newest-kept-over-budget", "report-retention-satellite-share-fate", "report-retention-json-html-pair", "report-retention-unmanaged-kept", "report-retention-orphan-sweep"]},
    {"id": "eval-07", "feature": "质量评测集与指标", "description": "80题5capability和来源/scope/时间标注验证；无记忆的候选指标不可冒充0；未独立评分的answer/extraction为未知；配对成本与按case聚合的收益区间", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["mq-dataset-80-balanced", "mq-dataset-required-gold", "mq-score-no-memory-null"]},
    {"id": "eval-08", "feature": "质量配对与审阅约束", "description": "三trial五策略+独立提取；cell矩阵完整、fresh generation与fixture指纹守卫；提交失败/中断失败；模型输出失败保留且不终止其他对照，三次连续基础设施失败中止；gold双人审计、独立校准judge盲审绑定整份采集，缺/旧审阅及定向样本不能批准完整质量", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["mq-runner-paired-gate", "mq-model-output-failure", "mq-review-bound-gate"]},
    {"id": "eval-09", "feature": "性能统计", "description": "nearest-rank P95保留长尾；缺样本或非法耗时为null；release 存储与 debug IPC 两类证据范围不混算（真实 UI 渲染延迟不在本口径内：Live 宿主没有聊天窗，不冒充 UI 证据）", "why": "评测证据本身必须能区分真实通过、未完成和错误产物，防止自动修复循环获得假成功", "layer": "unit", "depth": "deep", "scenarios": ["performance-tail", "performance-missing"]},
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: false },
}
