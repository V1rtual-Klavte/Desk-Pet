// 2026-10-16 定向复核：runtime 仅传递 partial 记忆候选保留选项；
// hz-01..04 的解析、沉默护栏、分泡揭示和顶栏释放链路未变，按现源码刷新 hash。
// 2026-10-09 顶栏 typing 所有权泄漏修复（验收轮）：defer 判据与 runner 入队条件收口为同一个 defersTitlebarReleaseToReveal（工具轮/已停止回合不再只 defer 不入队），并新增新回合起始的旧代际自愈清扫（中断/遗弃回合的 finally 不执行时的兜底）。覆盖点与 caseId 语义不变，sourceHash 按当前源码在本轮刷新。
// 2026-10-09 最终静态复核：输入去重和空工具选项不改变分泡、提交与顶栏所有权，覆盖点静态对照；未执行测试。
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
// 2026-10-08 本批改动（本批刷新）：sourceFiles 变化 = `src/services/humanizer/protocol.ts`
// 与 `src/services/engine/harness/runtime.ts`。
// ① **提示词重写**（用户裁定：拟人化碰上知识问题按「**压形式、不压内容**」；且 humanizer
//    只管形式，人设归 Card 的 `# 语言风格` —— 职责分离）：点名禁 markdown 标题与加粗、
//    点名禁「学界叫…」「说白了就是…」「XX 是一种…」「不是 A 那种 B」这类定义句与对比句；
//    task 档从「不卖萌、不拆条、不沉默」改为「结果准确优先、**语气照旧**」；另加两组负例
//    （直接取自 2026-10-08 实机翻车：`## Feign 是什么` 那条、以及「你可能是压力太大了」那条）。
// ② **分泡**：原「含 ``` 就整条不拆」是一刀切，带代码的讲解会整条一大块（用户实机反馈）
//    —— 改为**围栏感知的分段**：围栏内空行不是断点，围栏前后的说话照常各自成泡。
//    判据已写进 `humanizer-blank-line-split`（新增「围栏内空行不成断点」的反向断言）。
// ③ **续跑补接线**：`continueInterruptedRun` 的三处装配原本没传 `humanizerEnabled`，导致
//    「中断后继续」那一轮的可见正文既不注入提示词、也不做分泡/沉默处理，与主回合口径不一致。
// 覆盖点未修订、无 caseId 迁移。
// 2026-10-09 提示优先级：对任何问题，准确性与必要事实/用户限制/条件/步骤高于简短口语、分泡和避免文档腔；
// 「不追求体系完整」收窄为不铺无关背景，不再暗示可以省略答案必需信息。
// 2026-10-20 分泡兜底修正（本批刷新）：protocol.ts 去掉 15 字硬切与连接词/语气词切分
// （会切断「浮层」「老实」并留下单词泡），改为只按句读、逗号和空白边界切，短片段按 30 字合并
// 且不单独成泡；约 40% 的文本按哈希走 15 字细切（气泡数随机但不抖动）；技术/中英混排按
// 同文种空白边界切并保持英文词与代码标识完整；casual 气泡剥行首/行尾标点，中英之间不再
// 自动补空格（2026-10-20 用户裁定：补空格会与分泡抢边界）。
// runtime.ts 的工具轮可见台词也过拟人变换（任何可见消息不漏）。hz-01/hz-04 描述与场景同步
// （新增 humanizer-technical-split / humanizer-no-fragment / humanizer-fine-split）；
// hz-02..03 行为面未变。sourceHash 按当前源码复算。
// 2026-10-20 标点收口（本批刷新）：用户裁定沿用原有分泡粒度，只保留问号/叹号，其余标点可剥；
// 分号、顿号、冒号在正文侧换成空格（围栏与行内代码保留），约 40% 的逗号按文本+位置哈希换成空格；
// 冒号同时作为长句兜底分泡的硬边界；长句兜底分泡时带 ?! 的前一句不被并回，连续 ?! 作为一个
// 边界不拆开。hz-01 描述同步；hz-02..04 行为面未变。sourceHash 按当前源码复算。
// 2026-10-20 提示词精简（同批）：humanizer 提示词不再下发 <<SPLIT>> 分泡标记，只保留内容优先、
// 说话方式/说话内容/长度与沉默；分泡完全由代码承担。细切档把所有全角标点当硬边界，
// 普通档只把 ?! 和冒号当硬边界；ASCII `. , :` 不切，保护版本号/URL/时间。sourceHash 复算。
// 2026-10-20 列表收口（同批）：分点内容要求每点前输出 <<SPLIT>>；代码把阿拉伯数字/中文数字/
// 圈号/项目符号的列表起始当硬边界，编号后的点/括号换成空格，避免气泡以 `1.` 开头被渲染成
// markdown 列表，也避免 `2.` 黏进上一条。sourceHash 复算。
// 2026-10-20 空格不再切分（同批）：splitByWhitespace 删除，空格只留在泡内；
// 「JDK 8」「Java 8」这类技术词不再被空格切开；提示词分句改说短逗号。sourceHash 复算。
// 2026-10-21 细切与空格兜底（本批刷新）：细切概率 40% → 60%（2026-10-21 用户口径：
// 细切可以再多）；长段在句读切不出边界时按**中英边界空格**兜底切分（空格不切拉丁词之间，
// `JDK 8`/`VS Code` 保持完整；纯英文长句仍不拆），修「整段只用空格断句时挤成一个气泡」。
// hz-01 描述同步（新增 humanizer-fine-share / humanizer-space-only-split）；hz-02..04
// 行为面未变。sourceHash 按当前源码复算。
// 2026-10-21 粒度收口（同批）：普通档单泡目标 30 → 24 字、上限 50 → 38 字（用户口径：
// 38–40 字的一条仍算「一大段」）；并泡上限从 max+15 收回 max；标点切分后仍超上限的片段
// 再做一次空格兜底（修「前半句带句号、后半句 75 字原样留下」）。hz-01 描述同步；
// sourceHash 按当前源码复算。
// 2026-10-21 提示词收口（同批）：拟人提示只管内容与语气，排版（分条/换行/拆泡）全部归代码，
// 删除「短句为主」「分点单独一行 + SPLIT」「不要模仿历史」等与代码抢边界的规则。
import type { ModuleContract } from "../host/types"

// 2026-10-10 记忆断点修复定向核对：本域既有消费者与分派语义未变；新增受控会话读取及请求内guide由memory契约持有，生成协议仅增命令/规范排版。
// 2026-10-21 拟人分泡批次（本批刷新）：去掉并泡（groupPieces / mergeShortGroups /
// mergeCrossScriptParts 删除，切出几段就是几泡）；空格兜底只认「中文 中文」之间的空格，
// 中文与英文/数字/行内代码相邻的空格不切；带 <<SPLIT>> 的标记段先按空行分段，代码围栏
// 前后的说话各自成泡。hz-01 描述同步，新增 humanizer-split-marker-code-fence；
// hz-02..04 行为面未变。sourceHash 按当前源码复算。
// 2026-10-21 历史消息理解边界（本批刷新）：HUMANIZER_PROMPT 新增「历史消息仅用于理解」小节
// —— 历史只提供对话事实与上下文、用户偏好与明确约定、当前话题及语义连续性，不得把历史
// assistant 的语言形式当风格示例（尤其缺标点、连续短句、用换行代替断句）。此前同批精简删除的
// 「不要模仿历史」以更窄的「仅用于理解」口径回归（用户口径：救回被拆泡历史带偏的风格）。
// 纯提示词文本；分泡/沉默/提交代码路径未动，hz-01..04 行为面未变，sourceHash 按当前源码复算。
// 2026-10-21 原始助手正文进请求视图（本批刷新）：protocol.ts 新增 humanizerRawVisibleText
// （只摘控制标记，保留标点/换行）；runtime.ts 提交时记录、请求视图替换、Provider 前移除。
// hz-01 的展示分泡与 hz-04 的提交/揭示行为未变；sourceHash 按当前源码复算。
// 2026-10-21 提示词措辞微调（本批刷新）：HUMANIZER_PROMPT「可适当」→「可少量」，行为面未变，
// sourceHash 按当前源码复算。
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
  // 2026-10-18 列项答案补全批次：补全在拟人变换之后、提交之前应用；无列项时拟人行为不变，有列项时保留多泡并追加缺失项，定向复核后刷新。
  sourceHash: "f40cb37c2f8e00ed1afafc79714780c27876cb0ef8196821daa4ca0317a08641",
  coverage: [
    {
      id: "hz-01",
      feature: "表达标记解析",
      description: "识别正文中代码围栏和行内代码外的 SPLIT token（含行内、空格或大小写变化）并按其分泡（不设总条数上限）；casual 流无标记时按空行分段成泡（单个换行与围栏内空行不分），长段兜底先按句读、逗号、冒号等标点切分，句读切不出边界、或句读切完后仍有片段超过 38 字时，再按「中文 中文」之间的空格兜底切分（中文与英文/数字/行内代码相邻的空格不切，`JDK 8`/`VS Code` 这类技术词保持完整，纯英文长句仍不拆；不做字数硬切，也不从连接词/语气词下刀；技术/中英混排保持英文词与代码标识完整），切出几段就是几泡、不再按目标长度合并，没有任何标点或中文空格边界的片段保持原样；问号/叹号保留，长句兜底分泡时不把带 ?! 或冒号的前一句并回下一句，连续 ?! 不被拆开；约 60% 的文本按哈希走细切（气泡数随机但不抖动），细切档把所有全角标点（。！？；：，、…—–引号括号）当硬边界，普通档只把 ?! 和冒号当硬边界，ASCII `. , :` 不切；列表起始（阿拉伯数字/中文数字/圈号/项目符号）是硬边界，编号后的点或括号换成空格，多行短列表也按项拆开；分号、顿号、冒号在正文侧换成空格，约 40% 的逗号按文本+位置哈希换成空格，其余泡首/泡尾句读剥掉，中英之间不自动补空格；task 流只剥标记且保持单泡；SILENT 只在 casual 整条可见正文等于哨兵时成立",
      why: "输出协议必须对模型偏差采取可预测处理，不能把正文中的相似文本误当控制标记；模型用空行分段时要分成几条气泡（2026-10-05 用户规则）；技术类可以多泡但不能切在句子中间（2026-10-20 用户规则）；整段只用空格断句时要分泡，不能挤成一大条（2026-10-21 用户规则）",
      layer: "unit",
      depth: "shallow",
      scenarios: ["humanizer-protocol-split-no-cap", "humanizer-protocol-marker-normalization", "humanizer-blank-line-split", "humanizer-task-single-part", "humanizer-silent-exact", "humanizer-long-fallback", "humanizer-technical-split", "humanizer-no-fragment", "humanizer-fine-split", "humanizer-bubble-single-line", "humanizer-connective-split", "humanizer-punct-cleanup", "humanizer-task-bubble-lines", "humanizer-fine-share", "humanizer-space-only-split", "humanizer-split-marker-code-fence"],
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
    { id: "hz-04", feature: "生产入口分泡与顶栏所有权", description: "真实 sendMessage 提交的普通聊天多泡正文进入逐泡揭示：生成期 Card typing 文案由顶栏状态通道持有、首泡揭示时释放；提交后首个揭示状态为 held（不整条全显）、第二泡按泡间节奏延后、停止立即全显并回收瞬态状态；带工具调用的中间回合，其可见台词同样经过拟人变换（toolCall part 原样保留）。组件渲染的 DOM 证据随 WebView 退役，本点只承担服务级链路", why: "调度器单测不能证明真实生产入口（runner/runtime）消费了瞬态揭示与阶段所有权通道，也不能证明工具轮可见台词没有绕过拟人化", layer: "e2e", depth: "deep", scenarios: ["humanizer-real-component-reveal"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: false },
}

export default humanizerContract
