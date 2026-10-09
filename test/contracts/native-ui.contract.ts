// 2026-10-09 顶栏 typing 所有权泄漏修复（验收轮）：defer 判据与 runner 入队条件收口为同一个 defersTitlebarReleaseToReveal（工具轮/已停止回合不再只 defer 不入队），并新增新回合起始的旧代际自愈清扫（中断/遗弃回合的 finally 不执行时的兜底）。覆盖点与 caseId 语义不变，sourceHash 按当前源码在本轮刷新。
// 2026-10-09 最终静态复核：会话投影侦听同长度追加，提示音限定同会话新助手身份，既有图片与意图边界保留；未执行测试。
// 原生 UI 桥契约（Node ↔ 原生宿主的数据流面）。
//
// 范围：`test/unit/native-ui/**` 与 `test/integration/native-ui/**` 的全部 caseId 锚点，
// 含 `reveal-push.test.ts` 的 `reveal-push-*` 三条 —— 揭示进度推送就是
// `src/services/native-ui/reveal-push.ts` 的搬运适配层，与其余推送口同模块，不是
// humanizer 调度器本身（调度器由 humanizer 契约覆盖）。全部覆盖点在 L2 / L3；原生 UI
// 的窗口渲染证据属原生 UI 测试驱动，不在这里冒充。
//
// 2026-10-05 设置页 Card 增删改查 + 模版批次：host-requests.ts 与 management-intents.ts
// 新增四条请求臂（card_manage / card_markdown_read / card_markdown_write / card_template），
// 其余既有请求的解析、回执与缺参语义未动 —— nui-09 / nui-20 的未知方法对照路径
// （`definitely_not_a_method` / `chat_not_a_real_method` 走 default 分支为 OTHER）不受影响；
// nui-01..nui-26 逐点复核行为面未变。**新请求面本身暂无 L2/L3 覆盖**（test/unit/native-ui
// 与 test/integration/native-ui 没有携带这四条 caseId 的测试），按纪律不为无测试的行为
// 凭空登记 coverage（会造成 MISSING）；领域侧行为由 personality-card 契约的 pc-13..pc-19
// 覆盖，这四条请求臂的接线覆盖属已知缺口。仅按当前源码刷新 sourceHash。
//
// 2026-10-05 二批复查（本批刷新）：另一会话同批改造设置页音效面（行内下拉 pick）——
// 整表文本 `sound_assign` 被删除，换成 `sound_set_assignment`（单事件写回）+
// `sound_reset`（恢复默认）；`sound_library` 载荷改为逐事件 pick 行（sounds/text 字段删除，
// host/types.ts 的 ManagementRowPayload 增加 action="pick" 与 pick 载荷）。nui-26 描述按
// 现状修订（caseId `native-ui-sound-reset-defaults` 仍在、现由 sound_reset 路径携带；
// 逐事件写回由同文件无 caseId 用例覆盖）；nui-01/03/09/12/20 等其余各点逐条核对实现点仍在、
// 语义未变。本批刷新同时包含另一会话对设置面板与 host/types.ts 的改动；主会话只做了
// 「coverage 描述与当前实现一致性」的核对（不是逐行行为审计），仅按当前源码刷新 sourceHash。
//
// 2026-10-05 同批补一条追踪边界：`sourceFiles` 补入 `src/services/host/types.ts`。
// 本契约覆盖的请求/推送载荷与回执类型都定义在那个文件里（本轮音效与 Card 两批改动都先动它），
// 只改形状不改 handler 时原来不会失效 —— 那正是仓库登记过两次的门禁失明形态。补入后
// 改线形状会正常判 STALE。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— src/services/host/types.ts（另一会话的
// 音效面与管理行类型扩展，nui-26 已按二批复查核对过音效路径；本轮核对请求/载荷形状与当前
// 实现一致）、src/services/native-ui/session-projection.ts（调试条投影随实现同步：去掉
// lastPromptTokens 一格（宿主侧同批删除该投影链）；会话级覆盖与生效值字段当时未动（该机制
// 已于 2026-10-06 随抽屉三下拉批次整体删除，见文末最新批次注记）；正文、
// 标签、历史帧与缺省语义未动）。nui-01..nui-26 逐点核对：nui-14 / nui-18 / nui-19 的帧形状
// 与触发语义未变，其余点不在改动面内、实现点仍在。本批刷新同时包含另一会话的改动；本轮只做
// coverage 描述与当前实现一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 频率档位收口波（analyze→generate）：nui-27 的 caseId 登记经对账通过；sourceFiles
// 补入 `crates/native-host/src/ui/settings/panels.rs`（凭据行的 action 线值 `credential` 在
// 原生侧由 RowAction::parse 接收 —— nui-27 声称的「action = credential」在这根线上，只改
// handler 不改线形状时会漏判）。nui-01..nui-26 逐点复核实现点仍在、语义未变；sourceHash 按
// 当前源码复算。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— src/services/host/types.ts 新增
// HostCommandMap.chat_delete_session_images 一条（Node→宿主命令：删会话清理托管聊天图片；
// 不是原生 UI 的请求/推送面）。另核对：聊天消息右键菜单恢复「记住这条」意图
// （共享意图链在 crates/native-host/src/ui/chat/*.rs，平台挂项在 ui/platform/*_chat.rs；
// 走既有 HostRequestMap.chat_remember_message 线形状，Node 侧一行未改）—— 菜单手势与渲染
// 不在本契约范围（平台渲染证据属原生 UI 测试驱动，既有口径），不因此新增 sourceFiles。
// 2026-10-06 dreaming 日 token 闸撤除批次（本批刷新）：sourceFiles 变化 ——
// src/services/host/types.ts（HostCommandMap 的 memory_dreaming_budget_reserve：去 dailyLimit、
// 响应 boolean → void——dreaming 日 token 上限不再作门禁，预留只记账）。本契约覆盖点不在改动
// 面内，未修订；本批刷新同时包含工作树中其它并发改动的源文件（含并行缩略图线，
// 非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 第二轮实测反馈批次（本批验收 analyze→generate）：sourceFiles 变化 ——
// src/services/native-ui/session-projection.ts（调试条投影随实现同步：lastContextUsage 由
// number 改 number|null —— null=未知，宿主显示「—」而不是 0%；重启恢复见 debug.ts 的
// restoreLastRequestStats，恢复读取器 src/services/engine/harness/request-stats.ts 不在本
// 契约 sourceFiles —— 本契约没有覆盖点描述调试投影字段面，该行为的契约登记属 agent-runtime
// 覆盖面）、registeredToolCount / registeredMcpCount 两字段删除（「注册明细」仍消费
// registeredTools）；会话投影帧与既有推送/请求面未动）与 src/services/host/types.ts
// （HostCommandMap 的 memory_dreaming_budget_reserve 去 dailyLimit、响应 boolean→void；bash
// 命令 timeoutMs 注释刷新 —— 都不属原生 UI 的请求/推送面）。nui-01..nui-27 逐点核对实现点
// 仍在、覆盖描述与当前实现一致，未修订覆盖点，sourceHash 按当前工作区源码复算（同时含并行
// 工作线在非本契约文件上的改动）。
// 2026-10-06 提问选择与去超时批次（analyze→刷 hash）：sourceFiles 变化 ——
// `src/services/host/types.ts`（新增 `deskpet-choice-start` / `deskpet-choice-end` 两条推送与
// `UiReceiptMap.deskpet-choice-resolved` 一条回执；权限确认载荷去掉 `expiresAt` 字段——等待
// 没有超时，nui-25 描述按当前载荷修订）与 `src/services/native-ui/permission-confirm.ts`
//（下发失败从「只留痕、等 TTL 结算」改为**立即按拒绝结算**的逃生口：等待本身没有超时之后，
// 「面板没送到」必须有显式归宿；nui-25 补 caseId native-ui-permission-confirm-emit-failure）。
// nui-01..nui-27 逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；
// sourceHash 按当前源码复算。
// 2026-10-06 超时后台化批次（本批刷新）：host/types.ts —— bash_exec 增可选入参 sessionId
//（完成通知归属回传）与 HostEventMap 增事件 bash-background-finished（Rust 只投 Node、
//原生 UI 不呈现）。nui-* 逐点核对实现点仍在、描述与当前实现一致；sourceHash 按当前源码复算。
// 2026-10-06 派生行为结论沉淀批次（本批刷新）：host/types.ts —— memory_job_sources /
// memory_pending_source_count 入参增可选 origin（MemoryOrigin|null；整理按来源类别取批）。
// 原生 UI 的消费面未动；nui-* 逐点核对实现点仍在、描述与当前实现一致；sourceHash 按当前
// 源码复算（同批含另会话在飞改动）。
// 2026-10-06 记忆面板来源标签批次（analyze→generate）：新增覆盖点 nui-28（记忆面板对派生
// 条目的来源标注，caseId：native-ui-memory-derived-label / native-ui-memory-derived-detail，
// L2 test/unit/native-ui/management-memory-ai.test.ts）。sourceFiles 变化 ——
// src/services/native-ui/management-intents.ts（memory_overview 行副标题与 memory_item_detail
// 的 info 对 origin=derived_behavior 条目追加 DERIVED_PROVENANCE_MARK；判据复用记忆域的
// isDerivedBehaviorSource，措辞复用召回投影的同一枚常量，不写第二份判定/文案）。
// nui-01..nui-27 逐点核对实现点仍在、覆盖描述与当前实现一致（改动只落在记忆页投影，
// 描述/来源核对，非逐行行为审计）；sourceHash 按当前源码复算。
// 2026-10-06 验收 analyze→generate（MCP 表单化 / 记忆面板细粒度 / 设置面行级管理 / 会话活动时间排序）：
// 新增覆盖点 nui-29（MCP 服务器表单化与条目严格校验，L2 三条 caseId：native-ui-mcp-config-strict /
// native-ui-mcp-form-save / native-ui-mcp-form-duplicate-name）、nui-30（记忆备份列表与按选中项恢复，
// L2 四条：native-ui-memory-backup-list / native-ui-memory-backup-list-honest /
// native-ui-memory-restore-selected / native-ui-memory-restore-requires-path）、nui-31（记忆作业行生命周期动作，L2 三条：
// native-ui-memory-job-row-actions / native-ui-memory-job-cancel / native-ui-memory-job-resume）与 nui-32
// （会话标签/历史按用户活动时间排序，L3：native-ui-session-activity-order —— 本批为该用例补的锚点，
// test/integration/native-ui/会话意图承接与投影推送.test.ts）。nui-19 既有描述已含 activityAt 字段语义
// （本批复核一致）。sourceFiles 变化 —— src/services/session/activity.ts（新增：活动时间尾部扫描/缓存与
// 排序比较器 compareSessionActivity）、src/services/session/history.ts（历史列表按同一比较器排序）、
// src/services/tool/mcp/manager.ts（条目 schema 逐字段严格校验与表单解析：CONFIG 读取 / JSON 导入 /
// 管理面表单三入口共用，nui-29 的断言点；该文件亦列在 tool-execution 契约的 sourceFiles）、
// src/services/native-ui/management-intents.ts（MCP 文档编辑替换为表单 mcp_server_form / mcp_save /
// mcp_delete；记忆面板作业行动作 / 备份列表 / 按选中恢复 / 作业取消与继续；条目详情来源逐条成行）、
// src/services/native-ui/session-projection.ts（标签排序 + 历史条目 activityAt）与
// src/services/host/types.ts（mcp_server_form / mcp_save / mcp_delete 请求臂；session_read_text 新增可选
// tailBytes 尾部读取参数；ProfileManageResult / CardManageResult 的 newId / activeId 语义 —— 设置面
// 行级管理：点行 = 选中管理对象、与激活草稿分开；Rust 侧行渲染与手势不在本契约范围，沿用既有口径）。
// nui-01..nui-28 逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；
// sourceHash 随本批统一刷新。
// 2026-10-06 设置页列表面板删除批次（analyze→generate）：sourceFiles 变化 ——
// crates/native-host/src/ui/settings/panels.rs（删除 PANEL_PROFILES / PANEL_CARDS 两个面板 id
// 常量）、src/services/native-ui/management-intents.ts（card_manage / profile_manage 回执不再携带
// newId / activeId —— 这两个字段只服务于已删除的行级列表「新建后把选中行指向新项」，线形状随面板
// 一并退场；新建仍要求服务层给出推导 id，缺 id 照旧如实失败）与 src/services/host/types.ts
// （ProfileManageResult / CardManageResult 同步删字段）。nui-01..nui-32 逐点核对实现点仍在、
// 覆盖描述与当前实现一致：nui-10（人格卡列表读注册表）与 nui-27（凭据行 action 线值 credential）
// 的请求/线值面未动，无覆盖点描述被删面板或 newId/activeId，未修订覆盖点；sourceHash 按当前源码复算。
// 2026-10-06 Card 按需加载批次（本批刷新）：sourceFiles 变化 —— src/services/native-ui/host-requests.ts
// （personality_cards 的列表来源从内存注册表改为 listCardMetas 现读 Card 目录；返回形状不变）、
// src/services/native-ui/management-intents.ts（card_manage 的撞名判定/列表与卡片读写改走
// listCardMetas / loadCard 单卡现读）、src/services/host/types.ts（update_download_and_install
// 的结果声明 void → { version }，与 Rust 实际返回对齐；不在本契约覆盖面内）。nui-10 描述
// 按现状修订（列表读目录现读、不进缓存）；其余各点逐条核对实现点仍在、语义未变。
// sourceHash 按当前源码复算。
// 2026-10-06 记忆条目字段名修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/native-ui/management-intents.ts（memory_item_change 处理器的条目 id 改读
// `itemId`：新增 requireItemId，与 MemoryItemChangePayload 声明和 Rust 发送端一致 —— 通用
// requireId 读的 `id` 是 detail 等请求的字段；原实现误读 `id`，Rust 发的 `itemId` 全被拒，
// 设置页「遗忘 / 纠正 / 核心画像」整链以「缺少有效的 id」假失败，2026-10-06 实机事故修复；
// 既有单测已补「错误字段名（id）必须拒绝」的线形状钉子，不带 caseId）。nui-* 无覆盖点描述
// 该字段面；nui-01..nui-32 逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，
// 非逐行行为审计）。未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-06 抽屉三下拉统一 CONFIG 写批次（analyze→generate）：sourceFiles 变化 ——
// src/services/host/types.ts（chat_send 线格式删除 delivery 参数；新增三条请求臂
// chat_set_default_delivery / chat_set_thinking_effort / chat_set_safety_mode —— 抽屉
// 「投递 / 思考 / 安全」三个下拉各写一个 CONFIG 键（ai.conversation.defaultDelivery /
// ai.thinking.effort / ai.safety.mode），与设置页同键同值域、没有「默认」档）、
// src/services/native-ui/chat-intents.ts（三个处理器经 setOverride + flushConfig 的同一
// 条写盘路径落盘；三条方法加入 AFTER_REPLY_PUSH_METHODS —— 回执后补推一次会话投影，
// 下拉选中态随帧收敛）、src/services/native-ui/host-requests.ts（三条请求臂注册；
// reapplyRuntimeSettings 新增按键裁定：提交触碰上述三键任一时经 pushSessionProjection
// 重推一帧（设置页→抽屉方向）、无关键不推）与 src/services/native-ui/session-projection.ts
//（调试投影删除 session*/*Effective 四个字段，改为 thinkingEffort / safetyMode 两个 CONFIG
// 现值字段；defaultDelivery 语义不变）。**会话级覆盖机制整体删除**（debug.ts 的
// setSessionThinkingEffort / setSessionSafetyMode / getEffective* 与 SafetyMode 类型已迁往
// config.ts，消费点直读配置 —— 见 agent-runtime / safety 契约的同批注记）；此前批次注记
// 里「会话级覆盖与生效值字段未动」的表述已被本批取代。
// nui-11 描述按现状修订并认领两条新 L2 caseId（native-ui-settings-reapply-drawer /
// native-ui-settings-reapply-drawer-scoped，test/unit/native-ui/settings-commit-reapply.test.ts）；
// 抽屉写处理器自身的全值域/拒绝用例（chat-intents-guards.test.ts）不带 caseId，按纪律不凭空
// 登记 coverage。nui-01..nui-32 其余点逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源
// 核对，非逐行行为审计）；sourceHash 按当前源码复算。
// 2026-10-07 Windows 设置页「工具策略」撤下批次（analyze→generate）：sourceFiles 变化 ——
// crates/native-host/src/ui/settings/panels.rs（新增 `renders_tools_panel`：工具页是否渲染某个
// 管理面板的**两端共用**判定 —— 2026-10-05 用户规则「工具里面，不要显示工具列表了」此前只在
// macOS 侧写了一份平台私有函数，Windows 工具页因此仍列着只读的「工具策略（声明）」列表；
// 规则上收到共享层后 macOS 改为引用同一条，Windows 工具页按同一条过滤）。改动只在原生渲染层，
// 不涉及任何请求/推送载荷：nui-01..nui-32 逐点核对实现点仍在、覆盖描述与当前实现一致
// （描述/来源核对，非逐行行为审计）；本契约声明「平台手势与行渲染不在本契约范围」的口径不变，
// 未修订覆盖点，sourceHash 按当前源码复算。
import type { ModuleContract } from "../host/types"

export const nativeUiContract: ModuleContract = {
  module: "native-ui",
  sourceFiles: [
    // host/types.ts 是本契约的线形状来源：请求/推送的载荷与回执类型都在那里定义，
    // 只改形状不改 handler 时也必须让它失效 —— 漏了它，门禁对「载荷改字段名」这类
    // 破坏完全失明（本仓已登记过两次同类漏项）。2026-10-05 复查时补入。
    "src/services/host/types.ts",
    "src/services/native-ui/active-profile-signal.ts",
    "src/services/native-ui/chat-intents.ts",
    "src/services/native-ui/decision-intents.ts",
    "src/services/native-ui/host-requests.ts",
    "src/services/native-ui/index.ts",
    "src/harness/main.ts",
    "src/services/native-ui/management-intents.ts",
    "src/services/native-ui/permission-confirm.ts",
    "src/services/native-ui/pushes.ts",
    "src/services/native-ui/reveal-push.ts",
    "src/services/native-ui/send-outcome-push.ts",
    "src/services/native-ui/session-projection.ts",
    "src/services/native-ui/session-signal.ts",
    "src/services/native-ui/titlebar-status.ts",
    // 2026-10-06 契约账本批次 systematic sourceFiles 复查补入：nui-12 声称的是「真值点仲裁后的
    // 最终文本」—— 高优先级 owner 胜出 / 释放按优先级回落 / 全部释放回缺省（并与真值点初值
    // 同字面量） —— 这些语义的实现点在 `src/services/titlebar.ts`（titlebarLogo 的 set /
    // release / 渲染仲裁），titlebar-status.ts 只是把它推给宿主的适配层。此前只列了适配层：
    // 改坏真值点（例如 release 变 no-op、优先级比较反转）会让 nui-12 的用例变红而本契约 hash
    // 不动，属门禁失明形态。该文件同时在 behavior 契约（presence owner）与 humanizer 契约
    // （typing 所有权释放）在列，共享文件多契约并列是既有形态。
    "src/services/titlebar.ts",
    // 2026-10-05 自带 MCP 批次补入：nui-27 的凭据行从 Node 到原生设置窗走同一根线 ——
    // 行 action 线值 `credential` 由该文件的 RowAction::parse 接收（wire+parse；
    // 平台手势与行渲染不在本契约范围，与既有「原生渲染不在这里冒充」的口径一致）。
    "crates/native-host/src/ui/settings/panels.rs",
    // 2026-10-06 验收 analyze→generate 补入（nui-29）：条目 schema 的逐字段严格校验与表单解析
    // （CONFIG 读取 / JSON 导入 / 管理面表单三入口共用）的实现点 —— 只改这份判定而不动 handler 时，
    // native-ui-mcp-config-strict / -form-save / -form-duplicate-name 会变红而本契约 hash 不动
    // （本仓登记过的门禁失明形态）。该文件亦列在 tool-execution 契约的 sourceFiles。
    "src/services/tool/mcp/manager.ts",
    // 2026-10-06 验收 analyze→generate 补入（nui-32）：活动时间（正文最后一条 user 条目）的尾部
    // 扫描、缓存与排序比较器 compareSessionActivity 都在这里；排序的消费点分别是
    // session-projection.ts（标签 + 历史帧）与 session/history.ts（历史刷新）。
    "src/services/session/activity.ts",
    // 2026-10-06 验收 analyze→generate 补入（nui-32）：历史列表（sessionHistory）在同一次刷新里
    // 按同一比较器排序 —— 改坏这里，标签用例不红但历史排序与描述分叉，hash 不算上它就漏判。
    "src/services/session/history.ts",
  ],
  sourceHash: "74d497417da80eb05b5d3628073e3251dc501e0db6a429cc5579a921dde87e2b",
  coverage: [
    {
      id: "nui-34",
      feature: "可见正文窗口的同长度更新与回复音效",
      description: "正文浅快照发生条目变化就推送最新整帧，不依赖长度增长：达到可见上限后追加用户、助手、系统及已确认主动条目仍同步尾窗；同数量同身份的正文替换也同步新内容。新助手尾项按稳定身份触发回复 WAV，首条问候、会话切换和同身份重载不误响",
      why: "达到上限时追加与裁剪保持长度不变，长度监听会让已提交消息留在 Node 但原生界面永久停在旧尾窗",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-transcript-at-cap", "native-ui-transcript-same-length-replace"],
    },
    {
      id: "nui-33",
      feature: "关停排空已准入宿主请求与回执",
      description: "stop 同步关闭宿主请求订阅与 admission；drain 等待此前全部 handler 及成功/失败回执完成，设置写与普通请求的回执都不提前报告完成。关停后的请求不再执行；处理、回执或退订失败进入 drain 的失败结果，供 Harness 的 CONFIG/会话/日志收尾报告消费。共享可见性与两平台隐藏释放由 Rust 内联单测和平台接线核对，不冒充 Node 侧界面实测",
      why: "提前退出会漏掉已经接收的设置写盘或回执；把失败丢出 drain 会错误地报告持久化完成",
      layer: "unit",
      depth: "deep",
      scenarios: ["native-ui-host-request-drain", "native-ui-host-request-drain-failure", "native-ui-host-request-drain-reply"],
    },
    {
      id: "nui-01",
      feature: "状态推送的值一律经现有 getter（不复制默认值）",
      description:
        "十条原生 UI 状态推送的值型载荷只经现有类型化 getter / 配置门面读取（generalConfig.shortcutKey 与 mac/win 两组 modifiers、appearanceConfig.fontFamily/fontSize、userConfig.theme、userConfig.chatWidth、appearanceConfig.chatImagePreview、generalConfig.defaultPopupSize 的 w/h 与 general.popup.mode/fixedPosition（userConfig.fixedPosition）、generalConfig.autoPopupOnMessage；音效素材经 buildNativeCueClips），并用刻意不同于内置模板的假 CONFIG 现值断言「推出去的 = 配置现值」；全局快捷键的 modifiers 按平台选组（@/services/env 的 isMacOS 显式 mock macOS / Windows 两分支）；设置改动（setOverride 字号）后同一推送口带出新值。主题/摆位/尺寸/自动呼出/音效五条推送无逐条 caseId，断言面收敛在其余五条；舞台发送口同时钉住开关与基准宽取自 getter 现值（强度用调用方传值，不在此范围）",
      why: "推送若复制代码里的默认值，设置页改了值界面不跟随，而「推了」本身不会红；modifiers 平台分支写反只会在另一平台暴露",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-push-shortcut",
        "native-ui-push-font",
        "native-ui-push-chat-panel",
        "native-ui-push-chat-preview",
        "native-ui-push-stage-args",
        "native-ui-push-follows-getter",
      ],
    },
    {
      id: "nui-02",
      feature: "舞台层映射（域内相对路径 / 过滤空层 / z 序）",
      description:
        "buildStageLayers 把激活 Profile 的层映射成 profiles 域内相对路径（profileId 前缀 + 反斜杠归一 + 去前导斜杠），过滤空 image 的层（空路径无从解码，推给宿主只会产生解码失败留痕），保留相对顺序（z 序不变），字段名逐项转成线格式（offsetXPercent / offsetYPercent）",
      why: "前缀或字段名错了宿主解码失败整层不显示；不过滤空层会让推给宿主的列表与 Profile 的五层占位混淆",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-ui-push-stage-layers"],
    },
    {
      id: "nui-03",
      feature: "无激活 Profile 的舞台跳过与启动入口失败汇总",
      description:
        "无激活 Profile 时 pushStageProfile 如实跳过（推空层列表会把正在显示的舞台清空）；pushNativeUiState 十条推送逐项独立执行，一条失败不阻断其余，失败项汇总为 PushOutcome[]（带方法名与原始错误对象）且不抛出——调用方（领域引导）不被推送失败打断；健康宿主下返回空数组且十条各发一次",
      why: "推送失败把领域引导炸掉会让应用起不来；静默推空层则把「没有 Profile」伪装成「清空舞台」",
      layer: "unit",
      depth: "deep",
      scenarios: ["native-ui-push-stage-skip-no-profile", "native-ui-push-failure-summary"],
    },
    {
      id: "nui-04",
      feature: "激活 Profile 变化信号（零依赖叶子）",
      description:
        "active-profile-signal 只有注册 / 通知两个函数：只通知已注册的监听者，未注册（领域初始化早期）与注销后都是静默跳过，不产生任何回调",
      why: "推送侧与 Profile 装载器经它解循环依赖；注销后仍触发会把舞台重推打到旧监听者上",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-ui-active-profile-signal"],
    },
    {
      id: "nui-05",
      feature: "settings_read 整表快照的键形与值来源",
      description:
        "collectSettingsSnapshot 的键 = CONFIG 点分路径（嵌套对象展开）；标量数组 → 多行文本（Multiline 控件的形状约定）；对象数组（MCP servers 列表）不产出任何键；缺键不补默认值（CONFIG 里没有的路径不得在快照里凭空出现）；值取自配置现值（getAllOverrides 的同一读法）",
      why: "快照补默认值会让设置页显示「看起来已配置但 CONFIG 里没有」的值；键形与设置 schema 不一致会让控件静默不生效",
      layer: "unit",
      depth: "deep",
      scenarios: ["native-ui-settings-snapshot"],
    },
    {
      id: "nui-06",
      feature: "settings_commit 的写盘顺序与形状守卫",
      description:
        "settings_commit 经既有 setOverride + 配置写盘路径落盘：写盘成功先于状态推送（推送读的是提交后的新值，不是旧值也不是模板默认值）；数组字段「多行文本 → 标量数组」回写与读法互逆；人格卡切换不是普通 setOverride——ai.personality.active 空值以结构化 CONFIG 拒绝（不能借它关闭人格）；Profile 激活同样不是普通 setOverride——appearance.activeProfile 空值以结构化 CONFIG 拒绝（不能取消激活）、切换经 Profile 域唯一入口 switchActiveProfile 且失败中止保存；切卡成功后向当前会话推新卡问候（不写 greeting 持久条目，推送失败不阻断保存）；写盘失败如实抛出，且不发生任何状态推送",
      why: "先推后写会在写盘失败时留下「界面已改、磁盘没改」的假象；失败后仍推送等于把失败提交报告成成功",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-settings-commit",
        "native-ui-settings-commit-array",
        "native-ui-settings-commit-personality-guard",
        "native-ui-settings-commit-write-failure",
      ],
    },
    {
      id: "nui-07",
      feature: "分隔条宽度写回",
      description:
        "set_chat_width 取整（333.6 → 334）并夹到与设置 schema 相同的值域（5000 → 1000）后经既有写路径落盘；NaN 以结构化 CONFIG 拒绝",
      why: "拖拽写回是宿主直接写 CONFIG 的入口，越界值写进 CONFIG 会被读取期静默收拢成另一个值",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-ui-chat-width-writeback"],
    },
    {
      id: "nui-08",
      feature: "图层编辑器 I/O（load / save / 失败路径）",
      description:
        "editor_load 读激活 Profile 的 profile.yaml：元数据、层列表（含禁用层）、路径是 profiles 域内相对路径、name 取自路径、开关与强度取现值；editor_save 读-改-写同一文件（唯一写入路径 profile_file_write），image 去 profileId 前缀写回，锁定与参数逐字段保留，强度变化写回 CONFIG，顺序为 profile.yaml 落盘 → CONFIG 强度写回 → 才重推舞台；缺 profileId 以 CONFIG 拒绝且零写入；无激活 Profile 时 editor_load 以 PATH_NOT_FOUND 拒绝（不返回空编辑器）；profile_file_write 失败时 editor_save 如实抛出——不落 CONFIG、不推舞台",
      why: "编辑器是用户手改 Profile 的唯一界面：顺序错会推出半套状态，失败继续写会留下「界面已保存」的假象",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-editor-load",
        "native-ui-editor-save",
        "native-ui-editor-save-reject",
        "native-ui-editor-load-reject",
        "native-ui-editor-save-write-failure",
      ],
    },
    {
      id: "nui-09",
      feature: "宿主请求的订阅、回执与未知方法",
      description:
        "initHostRequestHandlers 注册在唯一事件名 deskpet-host-request 上；有界请求以 host_request_result 回执：成功 ok=true 且 requestId 原样带回，失败 ok=false + 结构化 code/message（不静默吞）；缺 requestId 的畸形信封直接丢弃、不产生回执（没有可用的 requestId）；未知方法经 dispatchHostRequest 如实报错（不返回空结果冒充成功）",
      why: "回执是宿主唯一的结果面：失败被吞会让面板永远停在「处理中」；把未知方法当空成功会让协议错位静默通过",
      layer: "unit",
      depth: "deep",
      scenarios: ["native-ui-host-request-reply", "native-ui-host-request-unknown"],
    },
    {
      id: "nui-10",
      feature: "人格卡列表现读 Card 目录",
      description:
        "personality_cards 的卡列表现读 Card 目录（listCardMetas 逐文件只解析 frontmatter、不进缓存），未激活任何 Card 时 active 如实为 null（不假装有值）",
      why: "从 CONFIG 副本读会显示与真实目录不一致的卡列表，切换入口指向不存在的卡",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-ui-personality-cards"],
    },
    {
      id: "nui-11",
      feature: "settings_commit 的运行期重应用（观察总闸 / 静默了解 / 主动刷新 / 日志级别 / 拟人揭示 / 抽屉三键重推投影）",
      description:
        "提交 ai.silentAccess.* 时重应用观察总闸（set_monitor_enabled 走既有开关入口，且发生在写盘之后）、静默了解调度起停并 refreshProactive；与 silentAccess 无关的提交不触碰观察总闸（按变更键裁定，不做无关副作用）；提交 general.logging.level 时下发 set_log_config（记为数值级别）；提交拟人开关时 revealAll()；提交抽屉三键（ai.conversation.defaultDelivery / ai.thinking.effort / ai.safety.mode）任一键时经 pushSessionProjection 重推一帧会话投影、且发生在写盘之后——抽屉三个下拉的选中态来自投影（宿主不读 CONFIG），设置页与抽屉是同一份配置的两个面、改完要让抽屉即时跟上；无关键不推（同一按变更键裁定，不放大副作用）；重应用失败只留痕——不回滚已保存的配置、不把保存判成失败",
      why: "不重应用则「改开关要重启才生效」；失败回滚会把已落盘的配置判成未保存，失败抛出则把保存整件事判成失败",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-settings-reapply-monitor",
        "native-ui-settings-reapply-scoped",
        "native-ui-settings-reapply-logging",
        "native-ui-settings-reapply-drawer",
        "native-ui-settings-reapply-drawer-scoped",
        "native-ui-settings-reapply-failure",
      ],
    },
    {
      id: "nui-12",
      feature: "顶栏状态位推送（取值 / 去重 / 失败重试）",
      description:
        "推的是真值点仲裁后的最终文本（高优先级 owner 胜出、释放按优先级回落、全部释放回缺省且与真值点初值同字面量；缺省是无 owner 时的中性空闲文案「就绪」，不谎报在线）；只在最终文本与上次成功推送不同才发（同文本去重）；推送失败如实抛出且不更新去重位，下一次渲染对同一文本自动重试；未注册渲染监听时真值点状态照常更新、不产生任何推送；唯一通道 = apply_titlebar_status（不旁路其它命令）",
      why: "失败被写进去重位会永久丢掉一次真实的顶栏切换；推送把仲裁炸掉会连带毁掉真值点本身",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-titlebar-push-value",
        "native-ui-titlebar-push-retry",
        "native-ui-titlebar-no-listener",
      ],
    },
    {
      id: "nui-13",
      feature: "分泡揭示进度推送（断链 D）",
      description:
        "订阅 humanizer 调度器，每次状态变化投影成一条 deskpet-reveal-progress（首发 held + 完成态全显各一条）；载荷逐字段取线上六字段 sessionId/messageId/runGeneration/revealed/partCount/typing，typingStartedAt 不出线；重复 startRevealPush 幂等（不叠加订阅、不重复推送）；通道失败（reject 或同步抛）只留痕，揭示状态照常推进与回收，无未处理拒绝",
      why: "揭示节奏的真相源在调度器，推送把失败抛回会中断揭示本身；typingStartedAt 出线会让消费端重算节奏",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "reveal-push-payload-shape",
        "reveal-push-field-projection",
        "reveal-push-failure-non-blocking",
      ],
    },
    {
      id: "nui-14",
      feature: "会话投影首帧（sessionHistory 缺省语义）",
      description:
        "initNativeUiBridge 装配后首推一帧：sessionId 与标签列表来自会话读模型现值，标签字段形状完整（id/name/createdAt/interrupted）；本进程尚未读取过历史时不携带 sessionHistory —— 宿主保持现值，不把「没读过」画成「确实没有历史会话」",
      why: "空列表与未读结果不同形：首帧把未读写成空列表会让历史面板显示假空",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-session-projection-first-frame"],
    },
    {
      id: "nui-15",
      feature: "chat_new / close / delete 的标签语义与磁盘事实",
      description:
        "chat_new_session：新建进入标签并切换活跃，会话文件与欢迎语真落盘（仓库扫描得到、欢迎语恰好一条），投影帧跟随；chat_close_session：移除标签但保留会话文件（Close ≠ Delete），关非活跃会话不动活跃指针，关活跃会话按旧壳收口切到首个剩余会话；chat_delete_session：删文件 + 标签移除 + 活跃指针收口",
      why: "Close 与 Delete 的语义混淆会删掉用户历史；不真落盘则重启后标签与文件不一致",
      layer: "integration",
      depth: "deep",
      scenarios: [
        "native-ui-chat-new-session",
        "native-ui-chat-close-keeps-file",
        "native-ui-chat-close-active-switches",
        "native-ui-chat-delete-removes-file",
      ],
    },
    {
      id: "nui-16",
      feature: "chat_restore_session 按仓库恢复",
      description:
        "按 id 在仓库里查元数据（listPiSessionMetadata + readPiSessionSummary）恢复并切换到该会话，标签与投影跟随；未知 id 以 PATH_NOT_FOUND 如实失败、标签列表不变、不产生投影推送",
      why: "恢复失败不能改状态或推假帧；UI 只传 id，meta 必须由 Node 侧查仓库而不是信任宿主快照",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-chat-restore", "native-ui-chat-restore-unknown"],
    },
    {
      id: "nui-17",
      feature: "会话操作缺 sessionId 的结构化拒绝",
      description:
        "chat_close_session / chat_delete_session / chat_restore_session 缺 sessionId 时以结构化 CONFIG 拒绝——与「未知方法」的 OTHER 不同形，宿主能区分协议错与版本不匹配",
      why: "缺参若被当成未知方法，宿主无法判断是协议违规还是命令未注册",
      layer: "integration",
      depth: "shallow",
      scenarios: ["native-ui-chat-session-id-required"],
    },
    {
      id: "nui-18",
      feature: "投影重推的触发时机",
      description:
        "切换会话 / 改名 / 中断标记变化都由会话读模型变化信号触发重推投影帧，载荷就是会话读模型的现值（sessionId、标签的 name 与 interrupted 逐项跟随）",
      why: "少任何一条触发，标签条会停在旧状态（改名不显示、角标不亮）",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-projection-push-triggers"],
    },
    {
      id: "nui-19",
      feature: "历史刷新的回执顺序与推送失败归属",
      description:
        "chat_request_session_history 的回执先于携带 sessionHistory 的投影帧送达（宿主「读取中」只在收到带 sessionHistory 的帧时清除）；帧内 sessionHistory = 已载入 + 无错 + 每条带 messageCount 与 activityAt（用户活动时间；宿主历史卡片的日期展示字段）；投影推送失败只留痕，已完成的刷新回执仍是 ok=true（不改写成失败）",
      why: "顺序反了「读取中」会残留到下一次推送；把推送失败改写成刷新失败会让宿主误报一次成功的读取",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-chat-session-history", "native-ui-chat-history-push-failure"],
    },
    {
      id: "nui-20",
      feature: "决策方法注册与缺参拒绝",
      description:
        "九个决策方法（abort/resume/discard plan、resolve unknown side effect、withdraw queued、resume/discard paused inputs、continue/discard interrupted run）已注册：缺参以结构化 CONFIG 拒绝；未注册方法走 default 分支是 OTHER——证明上表的 CONFIG 来自各自处理体的入参校验，不是「方法不存在」的同一个错误",
      why: "入参校验与命令注册必须可区分；把缺参放行会让领域入口收到形状错误的对象",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-decision-args"],
    },
    {
      id: "nui-21",
      feature: "决策动作的领域 no-op 归宿",
      description:
        "未知目标 / 无在跑计划按领域既有归宿应答：撤回、丢弃计划、丢弃暂停项、丢弃中断运行都是如实 no-op（不谎报成功、也不报假的失败）",
      why: "把 no-op 改写成失败会让宿主弹出不存在的错误提示",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-decision-noop"],
    },
    {
      id: "nui-22",
      feature: "未知计划的系统消息呈现",
      description:
        "chat_resume_plan 的未知计划由领域写系统消息落盘（重开仍可读），回执仍是成功（提交已受理）——拒绝的可见呈现由领域承担，不静默",
      why: "回执判失败会让面板认为动作未受理，而领域其实已写系统消息；静默则用户看不到拒绝原因",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-decision-resume-plan-unknown"],
    },
    {
      id: "nui-23",
      feature: "未知副作用处置",
      description:
        "chat_resolve_unknown_side_effect 对未知计划如实抛错（plan record not found），非法 resolution 以 CONFIG 拒绝（不静默造记录）",
      why: "未知计划被静默当成功会让 UI 认为副作用已处置，而记录从未存在",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-decision-resolve-unknown"],
    },
    {
      id: "nui-24",
      feature: "继续中断运行的无中断 no-op",
      description: "chat_continue_interrupted_run 没有中断运行时按领域归宿返回 undefined（不伪造继续结果）",
      why: "伪造继续结果会让界面显示一个并不存在的续跑",
      layer: "integration",
      depth: "shallow",
      scenarios: ["native-ui-decision-continue-interrupted"],
    },
    {
      id: "nui-25",
      feature: "权限确认桥（请求投影 + 回执身份结算 + 下发失败逃生口）",
      description:
        "confirmState.pending 变化投影成一条 deskpet-permission-confirm（requestId/toolName/sessionId/runGeneration/parameterSummary/effectClass/inputHash/policyHash/toolCallId 逐字段；**没有 expiresAt** —— 等待没有超时，面板也没有「有效期至」可展示）；deskpet-permission-confirm-resolved 回执按 requestId 身份结算：未知身份丢弃、非法 decision 丢弃（fail-closed，不让非法取值把待确认请求结算成非拒绝决定）、同一身份结算一次且重复回执不复活结算。下发失败 = 面板根本没送到：立即按拒绝结算（fail-closed）并清掉单槽，不把回合悬挂在一个谁也没看见的请求上 —— 等待本身没有超时，这是「送不到」的归宿（等待侧的另一半在 safety 的 sf-24）",
      why: "权限结算必须 fail-closed 且身份精确：迟到/非法回执若能结算，等于放行一次确认；没有等待超时之后，下发失败若不立即结算就等于永久悬挂",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-permission-confirm-bridge", "native-ui-permission-confirm-emit-failure"],
    },
    // nui-26 描述修订（2026-10-05 设置页音效行内下拉改造）：旧实现 sound_assign（整表文本
    // 写回、空文本=恢复默认）已删除，caseId `native-ui-sound-reset-defaults` 仍在
    // （test/unit/native-ui/management-tools-appearance.test.ts），现由 sound_reset 路径携带；
    // 逐事件写回（sound_set_assignment）由同文件无 caseId 用例覆盖。描述按当前实现改写，
    // caseId 未增删。
    {
      id: "nui-26",
      feature: "音效分配的逐事件写回与恢复默认",
      description:
        "音效分配的行内下拉选中经 sound_set_assignment 逐事件写回（只改点名事件、其余事件保持原分配，不整表重写；未知事件以结构化 CONFIG、未登记音效 id 以 PATH_NOT_FOUND、缺参/非字符串以结构化 CONFIG 拒绝，且零写盘）；「恢复默认」由 sound_reset 承担：清空分配覆盖并写盘（此后 getSoundAssignments 回落各事件登记默认值），两条路径都重推宿主生命周期提示音（ui_set_sound_cues，经 pushNativeUiState）",
      why: "「恢复默认」若靠逐事件写默认值，事件表或默认映射变化时会漏项；逐事件写回若退化成整表重写，会把未点名事件的分配静默抹掉",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-ui-sound-reset-defaults"],
    },
    // 2026-10-05：自带 MCP 批次新增 nui-27（GitHub 令牌行与写入接线，L2）。
    {
      id: "nui-27",
      feature: "MCP 凭据行（GitHub 令牌）与写入接线",
      description:
        "tools_mcp_servers 在 github 条目存在时追加一行凭据行（id = `credential:github:GITHUB_TOKEN`，action = credential）：状态经宿主 mcp_credential_status 读取（只有变量名、没有值），已设置/未设置只影响副标题；条目被删则不产出该行。mcp_credential_write 把行坐标解析回 server/var 后经宿主 mcp_credential_set 定向写入应用自有存储（不写 CONFIG、不回显、日志只记坐标）；空值/未知坐标/缺 id 在发出宿主命令之前以结构化 CONFIG 拒绝（零宿主命令、零写盘）；状态读取失败如实抛出，不把故障画成「未设置」",
      why: "凭据值不落 CONFIG 后，设置面是唯一的写入入口：坐标解析错了会把令牌存到别的键上，空值放行会让连接带上假凭据，而把故障画成「未设置」会让用户反复输入同一份无效令牌",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-ui-mcp-credential-row", "native-ui-mcp-credential-write"],
    },
    // 2026-10-06 记忆面板来源标签批次（analyze→generate）：新增 nui-28（L2）。
    {
      id: "nui-28",
      feature: "记忆面板的派生条目来源标注（列表与详情同源）",
      description:
        "记忆列表的行投影与条目的详情信息对 `origin=derived_behavior` 的条目标注来源：行副标题在 `kind · scope · vN`（与可选的「核心画像」）之后追加 `DERIVED_PROVENANCE_MARK`（「系统观察·可撤销的推断（非用户原话）」），详情 info 在「来源：」行之后追加 `来源类别：<同一标记>` 一行；用户条目（`origin=user` 或类别缺失）保持原样、两处都不加标记。标记的判据与措辞分别复用记忆域的 `isDerivedBehaviorSource` 与 `DERIVED_PROVENANCE_MARK`（与召回投影同一份，不写第二份判定/文案）；列表副标题与详情 info 均由 Node 组装，原生宿主两侧逐字渲染（Rust 无需改动）",
      why: "派生结论与用户事实共库同列：面板不区分来源时，用户会把系统观察当成自己说过的话（或反过来不敢纠正一条其实可撤销的推断）；面板若另写一份判据/措辞，与提示侧会随每次改动漂移",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-ui-memory-derived-label", "native-ui-memory-derived-detail"],
    },
    // 2026-10-06 验收 analyze→generate：MCP 表单化（新增 nui-29，L2）。
    {
      id: "nui-29",
      feature: "MCP 服务器表单化（表单读写 / 重名纪律）与 CONFIG 直改条目的严格校验",
      description:
        "`tools_mcp_servers` 读取对 CONFIG 直改条目做逐字段如实校验（schema 校验与 JSON 导入、管理面表单三入口共用，见 tool/mcp/manager.ts）：enabled 非布尔（含字符串 \"false\"）不再被静默收成启用、transport 缺失/非法结构化拒绝、sse 点名拒绝并给迁移指引、stdio 缺 command 与 http 缺 url 拒绝、args 标量不再被包成单元素数组、env 值非字符串拒绝、名字缺失拒绝；错误信息点名条目与字段，修正后读取恢复（不留过期列表缓存）。`mcp_save` 表单保存：新增条目落盘（args 每行一个参数、env 复用 KEY=VALUE 行解析，同列表其余条目原样保留），originalName 指向不存在的条目以 PATH_NOT_FOUND 拒绝；重名保存（新增撞名与改名撞名同一判据）以结构化 CONFIG 拒绝、零写盘，原条目不被静默覆盖。表单渲染 / 逐项校验 / 改名保留过滤字段 / 删除 / 导入导出等相邻分支由同文件（management-tools-appearance.test.ts）不携带 caseId 的用例执行，不在本点 scenarios 记账",
      why: "静默收拢（`enabled: \"false\"` 读成启用、args 标量包成单元素数组）会让错误配置一直跑在错误语义上，而「列表能显示」本身不会红；同名保存若静默覆盖，一次新增/改名会抹掉列表里另一条条目且没有任何信号",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-mcp-config-strict",
        "native-ui-mcp-form-save",
        "native-ui-mcp-form-duplicate-name",
      ],
    },
    // 2026-10-06 验收 analyze→generate：记忆面板细粒度（新增 nui-30 / nui-31，L2）。
    {
      id: "nui-30",
      feature: "记忆备份列表与按选中项的恢复",
      description:
        "memory_backup_list 只列托管备份目录（runtimePath memory/backups）里的 .sqlite3 文件（目录与其它文件不进列表）、按 mtime 倒序；行 id = 备份绝对路径（宿主选中后原样回传）、副标题带文件名与大小、action=choose。目录不存在 = 空列表（还没有备份，debug 留痕）；目录存在但读不了 = 如实抛错（IO）——「读不到」不伪装成「没有」。memory_restore 的 preview / apply 都作用于传入的选中路径（不再隐式取「最新一份」；缺 backupPath 以结构化 CONFIG 拒绝且零恢复命令），结果显示实际使用的文件与预检/应用结论；未知 op 同样以 CONFIG 拒绝",
      why: "把「读不到」画成「没有备份」会让界面给错指引（用户以为备份丢了）；恢复若隐式取最新一份，用户点的那一行与实际恢复的文件可以不是同一份",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-memory-backup-list",
        "native-ui-memory-backup-list-honest",
        "native-ui-memory-restore-selected",
        // 缺 backupPath 的拒绝语义独立成锚（原先与上一条共用同一 caseId，
        // 会在 unit 全量运行的同层查重里整层报错——2026-10-06 验收首查发现并拆分）。
        "native-ui-memory-restore-requires-path",
      ],
    },
    {
      id: "nui-31",
      feature: "记忆作业行的生命周期动作（投影 / 取消 / 继续）",
      description:
        "memory_overview 的作业行按状态投影动作（值域与 Rust 记忆域准入一致）：running/queued → cancel；phase=review 且 paused/cancelled/failed → resume；completed 等其余状态 → 只读 none。memory_job_cancel 以记忆整理写者的租约身份（memory-dreaming）请求，结果以宿主返回的作业状态为准——状态没变成 cancelled（终态/属主不符）就如实 CONFIG 拒绝，不谎报取消；缺 jobId 同样拒绝。memory_job_resume 走既有恢复入口（runDreamingSweep 的 resumeJobId）：非 review 作业由领域拒绝并以 OTHER 回抛（同时回手取消，不留 running 僵尸作业）；缺 jobId 以结构化 CONFIG 拒绝",
      why: "取消/继续的准入判据若与 Rust 不一致，界面会显示一个按不动的按钮或把未取消画成已取消；非 review 作业被驱动会留下僵尸作业",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-memory-job-row-actions",
        "native-ui-memory-job-cancel",
        "native-ui-memory-job-resume",
      ],
    },
    // 2026-10-06 验收 analyze→generate：会话活动时间排序（新增 nui-32，L3）。
    {
      id: "nui-32",
      feature: "会话标签列表与历史按用户活动时间排序",
      description:
        "投影帧的 `sessions`（标签列表）与 `sessionHistory` 都按用户活动时间倒序：活动时间 = 正文最后一条 `role:\"user\"` 条目（message.timestamp 优先、回退条目级 timestamp，与读模型展示时间同口径），没有用户消息回退 createdAt，同值按 id 升序（多次刷新顺序稳定）；折叠 / 重命名等维护类写入不产生新的 user 条目、活动时间不变（读取只扫文件尾部、按 (路径, mtime) 键控缓存，读取失败按 createdAt 回退并留痕——读取与比较器见 session/activity.ts）。用户在较早会话里发言后，该会话被提到标签列表最前（覆盖用例断言这一投影结果）",
      why: "排序键若取文件 mtime，折叠/重命名会把旧会话顶到最前（维护动作被画成用户活动）；列表顺序错会让人找不到刚说过话的会话",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-session-activity-order"],
    },
  ],
  // 本契约全部覆盖点在 L2 / L3：原生 UI 桥的推送与请求面是纯适配层，不需要真 Rust 边界
  // 或真模型，故 L4 路径上没有可核对内容。门槛按既有 no-e2e 契约（variable-pool /
  // memory-bench）的先例归零清空，不是放宽——跨层完整性由 checkLayerCoverage 负责
  //（caseId 的声明层都是 unit / integration）。
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
