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
// lastPromptTokens 一格（宿主侧同批删除该投影链）；会话级覆盖与生效值字段未动；正文、
// 标签、历史帧与缺省语义未动）。nui-01..nui-26 逐点核对：nui-14 / nui-18 / nui-19 的帧形状
// 与触发语义未变，其余点不在改动面内、实现点仍在。本批刷新同时包含另一会话的改动；本轮只做
// coverage 描述与当前实现一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 频率档位收口波（analyze→generate）：nui-27 的 caseId 登记经对账通过；sourceFiles
// 补入 `crates/native-host/src/ui/settings/panels.rs`（凭据行的 action 线值 `credential` 在
// 原生侧由 RowAction::parse 接收 —— nui-27 声称的「action = credential」在这根线上，只改
// handler 不改线形状时会漏判）。nui-01..nui-26 逐点复核实现点仍在、语义未变；sourceHash 按
// 当前源码复算。
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
    "src/services/native-ui/management-intents.ts",
    "src/services/native-ui/permission-confirm.ts",
    "src/services/native-ui/pushes.ts",
    "src/services/native-ui/reveal-push.ts",
    "src/services/native-ui/send-outcome-push.ts",
    "src/services/native-ui/session-projection.ts",
    "src/services/native-ui/session-signal.ts",
    "src/services/native-ui/titlebar-status.ts",
    // 2026-10-05 自带 MCP 批次补入：nui-27 的凭据行从 Node 到原生设置窗走同一根线 ——
    // 行 action 线值 `credential` 由该文件的 RowAction::parse 接收（wire+parse；
    // 平台手势与行渲染不在本契约范围，与既有「原生渲染不在这里冒充」的口径一致）。
    "crates/native-host/src/ui/settings/panels.rs",
  ],
  sourceHash: "666f28a879f8152b13e5415ed8970d4de2ec734001d8395caae2baa6228cafb4",
  coverage: [
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
      feature: "人格卡列表读 Card 注册表",
      description:
        "personality_cards 的卡列表来自 Card 注册表（初始化后 = Card 文件解析结果），未激活任何 Card 时 active 如实为 null（不假装有值）",
      why: "从 CONFIG 副本读会显示与真实注册表不一致的卡列表，切换入口指向不存在的卡",
      layer: "unit",
      depth: "shallow",
      scenarios: ["native-ui-personality-cards"],
    },
    {
      id: "nui-11",
      feature: "settings_commit 的运行期重应用（观察总闸 / 静默了解 / 主动刷新 / 日志级别 / 拟人揭示）",
      description:
        "提交 ai.silentAccess.* 时重应用观察总闸（set_monitor_enabled 走既有开关入口，且发生在写盘之后）、静默了解调度起停并 refreshProactive；与 silentAccess 无关的提交不触碰观察总闸（按变更键裁定，不做无关副作用）；提交 general.logging.level 时下发 set_log_config（记为数值级别）；提交拟人开关时 revealAll()；重应用失败只留痕——不回滚已保存的配置、不把保存判成失败",
      why: "不重应用则「改开关要重启才生效」；失败回滚会把已落盘的配置判成未保存，失败抛出则把保存整件事判成失败",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "native-ui-settings-reapply-monitor",
        "native-ui-settings-reapply-scoped",
        "native-ui-settings-reapply-logging",
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
        "chat_request_session_history 的回执先于携带 sessionHistory 的投影帧送达（宿主「读取中」只在收到带 sessionHistory 的帧时清除）；帧内 sessionHistory = 已载入 + 无错 + 每条带 messageCount；投影推送失败只留痕，已完成的刷新回执仍是 ok=true（不改写成失败）",
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
      feature: "权限确认桥（请求投影 + 回执身份结算）",
      description:
        "confirmState.pending 变化投影成一条 deskpet-permission-confirm（requestId/toolName/sessionId/runGeneration/parameterSummary/effectClass/inputHash/policyHash/toolCallId/expiresAt 逐字段）；deskpet-permission-confirm-resolved 回执按 requestId 身份结算：未知身份丢弃、非法 decision 丢弃（fail-closed，不让非法取值把待确认请求结算成非拒绝决定）、同一身份结算一次且重复回执不复活结算",
      why: "权限结算必须 fail-closed 且身份精确：迟到/非法回执若能结算，等于放行一次确认",
      layer: "integration",
      depth: "deep",
      scenarios: ["native-ui-permission-confirm-bridge"],
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
  ],
  // 本契约全部覆盖点在 L2 / L3：原生 UI 桥的推送与请求面是纯适配层，不需要真 Rust 边界
  // 或真模型，故 L4 路径上没有可核对内容。门槛按既有 no-e2e 契约（variable-pool /
  // memory-bench）的先例归零清空，不是放宽——跨层完整性由 checkLayerCoverage 负责
  //（caseId 的声明层都是 unit / integration）。
  rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
}
