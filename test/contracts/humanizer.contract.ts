// 2026-10-05 本批复查与刷新：契约 sourceFiles 里 runtime.ts 由另一会话同批写入
// （新增 emitToolStageTitlebar：工具过程文案改推顶栏，与阶段提示共用同一 owner 与释放点），
// runner.ts 的改动是「@/services/host/humanizer → @/services/humanizer」的纯 import 路径改名。
// hz-01..hz-04 逐点核对实现点仍在、语义未变（hz-03/hz-04 的标题栏所有权与释放点由调度器
// 承担，runtime 的新增推送不改其职责边界）。本批刷新同时包含另一会话对 runtime.ts 的改动；
// 主会话只做了「coverage 描述与当前实现一致性」的核对（不是逐行行为审计），未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：runtime.ts 再次变化 —— RUNTIME_DATA 协议缺失检测与提醒
// 接线（结算 mark/clear 与下一回合 buildPrompt 传参）。hz-01..hz-04 的表达解析、沉默护栏与
// 逐泡揭示/标题栏所有权由 humanizer 调度器承担，与改动面无交集，逐点核对实现点仍在、
// 语义未变，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造；
// 与拟人表达的解析、沉默护栏、逐泡揭示与标题栏调度不相交）。hz-01..hz-04 逐点核对实现点
// 仍在、覆盖描述与当前实现一致。本批刷新同时包含另一会话的改动；本轮只做 coverage 描述与
// 当前实现一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志；与拟人表达的解析、沉默护栏、逐泡揭示与标题栏
// 调度不相交）。hz-01..hz-04 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（子运行 invisible sinks：子运行的流式草稿与过程消息
// 不外推；主回合的逐泡揭示与 stream-end 口径未动）。hz-01..hz-04 逐点核对实现点仍在、覆盖
// 描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（估算偏差对账口径；逐泡揭示与瞬态状态口径未动）。
// hz-01..hz-04 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码
// 刷新 sourceHash。
// 2026-10-06 工具循环治理与锁迁移批次（本批刷新）：sourceFiles 变化 ——
// src/services/agent/runner.ts（三个运行入口的 AI 生成锁由 setAIGenerating 布尔改为
// harnessSlots.admit()/endAdmission()，锁的真相源迁到回合状态；提交/揭示链路未动）、
// src/services/engine/harness/runtime.ts（工具循环治理：beforeTool/afterTool 的病理判据、
// maxToolCalls 可选化、applyLevels 增加可选软提示尾参 —— 尾参只作用于工具结果正文，
// 与人拟表达的解析、沉默护栏、逐泡揭示与标题栏所有权不相交）。
// hz-01..hz-04 逐点核对实现点仍在（transformHumanizerText / humanizerSilenceGuard /
// setFirstRevealHandler 与调度器行为未变）、覆盖描述与当前实现一致，未修订覆盖点；
// 本轮为描述与来源核对（非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 提问选择与去超时批次（本批刷新）：sourceFiles 变化仅限
// `src/services/engine/harness/runtime.ts` 的注释面（NON_CONFIRM_CONTEXT 去掉确认超时一支）。
// 各覆盖点逐条核对实现点仍在、描述与当前实现一致；sourceHash 按当前源码复算。
// 2026-10-06 计划报告口径收窄批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（runPlanPhase 的 onStepNotice 收窄：工具名不存在
// 仍发聊天系统消息；未限定工具只写进度事件与统一日志，不再逐步骤敲系统消息）。hz-01..hz-04
// 的表达解析、沉默护栏、逐泡揭示与顶栏所有权不在改动面内；逐点核对实现点仍在、覆盖描述与
// 当前实现一致（描述/来源核对，非逐行行为审计）。未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-06 抽屉 CONFIG 写批次（本批刷新）：sourceFiles 变化 —— src/services/agent/runner.ts
//（繁忙投递意图的显式选择整链删除：resolveDeliveryIntent(text) 只留 slash→nextRun 与 CONFIG
// `ai.conversation.defaultDelivery`；resolveDeliveryIntent 的签名与调用点改写不改变提交/揭示
// 链路）、src/services/engine/harness/runtime.ts（思考/安全的会话级覆盖机制删除后直读 CONFIG；
// hz-01..hz-04 的行为面不含这两条读取路径）。逐点核对实现点仍在、覆盖描述与当前实现一致
//（描述/来源核对，非逐行行为审计）；sourceHash 按当前源码复算。
import type { ModuleContract } from "../host/types"

export const humanizerContract: ModuleContract = {
  module: "humanizer",
  sourceFiles: [
    "src/services/humanizer/protocol.ts",
    "src/services/humanizer/scheduler.ts",
    // hz-04 is the production consumer check: runner commits/enqueues the reply and runtime
    // transforms it and releases the typing owner at first reveal.
    "src/services/agent/runner.ts",
    "src/services/engine/harness/runtime.ts",
    // 2026-10-06 契约账本批次 systematic sourceFiles 复查补入：hz-04（生产入口分泡与顶栏
    // 所有权）的 e2e 场景断言顶栏文本的持有与释放 —— 「顶栏所有权」的 set / release 语义
    // 实现点在 `src/services/titlebar.ts`（runtime 与调度器只调用它）。此前漏列：改坏
    // set/release（例如释放失效）会让场景红而本契约 hash 不动。仲裁语义的完整断言归
    // native-ui 的 nui-12；本契约在它是「所有权释放」这一半的来源文件。
    "src/services/titlebar.ts",
  ],
  sourceHash: "e2229b767e224d1bc6067ddac1abb9aeb43ce1de743dbb769df54b7ecfbe5825",
  coverage: [
    {
      id: "hz-01",
      feature: "表达标记解析",
      description: "只识别整行 SPLIT 标记并将超过四泡的尾部合并；casual 流在无标记时按空行分段成泡（单个换行与含代码块的消息不分，task 流保持单泡且不能合法沉默）；SILENT 只在 casual 整条可见正文等于哨兵时成立",
      why: "输出协议必须对模型偏差采取可预测处理，不能把正文中的相似文本误当控制标记；模型用空行分段时要分成几条气泡（2026-10-05 用户规则）",
      layer: "unit",
      depth: "shallow",
      scenarios: ["humanizer-protocol-split-merge", "humanizer-blank-line-split", "humanizer-task-single-part", "humanizer-silent-exact"],
    },
    {
      id: "hz-02",
      feature: "会话沉默护栏",
      description: "每会话只接受一次连续 SILENT；下一次同会话 SILENT 改为当前 Card 提供的短文本，不影响另一会话的首次沉默",
      why: "连续空回复会让用户误以为消息或系统故障，且状态不能跨会话串扰",
      layer: "unit",
      depth: "shallow",
      scenarios: ["humanizer-silence-guard"],
    },
    {
      id: "hz-03",
      feature: "逐泡揭示调度",
      description: "casual 气泡按可注入时钟顺序揭示并在完成后清除瞬态状态；取消会立即全显，主动消息首泡即时；首泡显示时释放正在输入标题栏所有权",
      why: "展示延迟不能改变消息正文或在取消、切会话后把内容藏住，阶段所有权也必须在首泡到达时结束",
      layer: "unit",
      depth: "deep",
      scenarios: ["humanizer-scheduler-casual", "humanizer-scheduler-cancel", "humanizer-scheduler-active-first", "humanizer-scheduler-titlebar"],
    },
    // hz-04 口径变更（测试设施去 Tauri 批）：原「真实组件分泡呈现」场景挂载生产 ChatPanel，
    // WebView/ChatPanel 退役后必然失效。处置为改服务级场景（test/e2e/scenes/humanizer/
    // 生产入口分泡呈现.scene.ts）而非删除覆盖点 —— 删点需要放宽本契约的 L4 门槛
    // （minScenarios / minDeepScenarios / requireBoundary），那等于把组件级证据的缺口
    // 洗成「本层没有可核对内容」。组件渲染的实机证据待原生 UI 测试驱动承接，不在服务级
    // 场景里冒充；caseId 保留为稳定历史标识（personality-card pc-09 也按它引用）。
    { id: "hz-04", feature: "生产入口分泡与顶栏所有权", description: "真实 sendMessage 提交的普通聊天多泡正文进入逐泡揭示：生成期 Card typing 文案由顶栏状态通道持有、首泡揭示时释放；提交后首个揭示状态为 held（不整条全显）、第二泡按泡间节奏延后、停止立即全显并回收瞬态状态。组件渲染的 DOM 证据随 WebView 退役，本点只承担服务级链路", why: "调度器单测不能证明真实生产入口（runner/runtime）消费了瞬态揭示与阶段所有权通道", layer: "e2e", depth: "deep", scenarios: ["humanizer-real-component-reveal"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: false },
}

export default humanizerContract
