// 2026-10-05 本批复查与刷新：契约 sourceFiles 里仅 runtime.ts 变化（另一会话同批写入：
// 工具过程文案新增 emitToolStageTitlebar 改推顶栏）；sf-01..sf-22 逐点核对实现点仍在、
// 语义未变（裁决表、确认通道与凭据路径不受影响）。本批刷新同时包含另一会话对 runtime.ts
// 的改动；主会话只做了「coverage 描述与当前实现一致性」的核对（不是逐行行为审计），
// 未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：runtime.ts 再次变化 —— RUNTIME_DATA 协议缺失检测与提醒
// 接线（结算 mark/clear 与 log.warn）。sf-01..sf-22 的裁决表、确认/放行通道、凭据路径与策略
// 冻结逐点核对不受影响（结算新增逻辑不触达许可内核），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造；
// 不触达许可内核、确认/放行通道与凭据路径）。sf-01..sf-23（共 22 点）逐点核对实现点仍在、
// 覆盖描述与当前实现一致。本批刷新同时包含另一会话的改动；本轮只做 coverage 描述与当前实现
// 一致性核对（非逐行行为审计），未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 拒绝留痕：四个 decline 结局结构化 + 统一日志）与 harness-slot.ts（compaction_end 落
// deskpet.compaction_declined 条目的条件扩到 decline）。两处都不触达许可内核、确认/放行通道
// 与凭据路径。sf-01..sf-23（共 22 点）逐点核对实现点仍在、覆盖描述与当前实现一致，未修订
// 覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 聊天图片批次（本批刷新）：sourceFiles 变化 —— src/services/session/manager.ts
// （deleteSession 成功后新增托管聊天图片清理：去重收集条目图片路径交宿主命令、
// 失败只留痕不改返回语义）。删除会话前既有的 invalidatePermissionScope(sessionId) 路径未动，
// 图片清理不触达许可内核、确认/放行通道与凭据路径。sf-01..sf-23（共 22 点）逐点核对实现点
// 仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（子运行 provider 准入与 invisible sinks 的接线修复；
// 主回合 activeAdmission、许可内核、确认与放行通道路径未动）。sf-01..sf-23（共 22 点）逐点
// 核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（估算偏差对账口径；许可内核、确认/放行通道与凭据
// 路径未动）。sf-01..sf-23（共 22 点）逐点核对实现点仍在、覆盖描述与当前实现一致，未修订
// 覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 工具循环治理与锁迁移批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（工具循环治理接线：beforeTool 计数上限只对子运行、
// 病理软/硬判据与 after_tool 的 terminate、maxToolCalls 可选化、applyLevels 可选软提示尾参）、
// src/services/engine/harness/harness-slot.ts（stoppedAtToolLimit 改名 stoppedByToolGovernance、
// afterTool 返回类型增 terminate、新增回合受理凭据 admit/endAdmission —— AI 生成锁的真相源
// 迁到此处且不再有定时器强解）、src/services/session/manager.ts（删会话托管图片清理的注释
// 口径）。三者均不触达许可内核、确认/放行通道、凭据路径与策略冻结实现（checker/permission/
// confirm/paths/bash_policy 等文件本批零改动）。sf-01..sf-23（共 22 点）逐点核对实现点仍在
// （裁决表、白名单、路径分级、确认身份与失效、授权范围、冻结快照、Rust 终判的符号与描述
// 一致）、覆盖描述与当前实现一致，未修订覆盖点；本轮为描述与来源核对（非逐行行为审计），
// sourceHash 按当前源码复算。
// 2026-10-06 bash 超时档位/进程组回收批次（analyze→刷新）：sourceFiles 变化 ——
// src/services/safety/checker.ts（BASH_DANGEROUS_PATTERNS 新增 `display dialog` / `display alert`：
// 等待用户点按的 GUI 弹窗先走确认，只匹配这两个等待式命令、不误伤 osascript 的普通自动化）、
// src/services/tool/local/pi-tools.ts（bash 5 分钟档位声明 + withBashToolPolicy 接入；档位/夹取
// 语义的覆盖归 tool-execution 的 te-33/te-34，不在本契约新增覆盖点）、
// crates/native-host/src/commands/tool_exec/mod.rs（新增 Rust 单测：进程组回收含孙进程探活、
// stdin 关死、Rust 兜底与 TS 档位同值——被改的实现点在 bash.rs，不在本契约 sourceFiles）。
// sf-05 描述修订（记录新增模式）；sf-01..sf-23 其余点逐点核对实现点仍在（裁决表、确认/授权、
// 凭据路径、策略冻结不在改动面内；stdin 关死与组回收不影响 sf-16/sf-18 的「spawn 之前拒绝」
// 语义）、覆盖描述与当前实现一致；本轮为描述与来源核对（非逐行行为审计），sourceHash 按当前源码复算。
// 2026-10-06 提问选择与去超时批次（analyze→刷 hash）：sourceFiles 变化 —— 补入
// `src/services/engine/user-wait.ts`（等待期预算豁免的唯一登记点：权限确认等用户拍板期间
// 回合墙钟与工具超时停表）；`safety/confirm.ts`（**等待不再有超时**：5 分钟 CONFIRM_TIMEOUT_MS
// 与 `expiresAt` 时效前置判断随 2026-10-06 用户裁决删除，「会话内允许」的授权保鲜期另立
// GRANT_TTL_MS 从用户按下允许的时刻起算；逃生口 = 下发失败由 native-ui 桥按拒绝立即结算 /
// 新请求顶掉旧请求按拒绝 / signal abort 按拒绝 / invalidatePermissionScope 按拒绝）、
// `safety/permission.ts`（PermissionRequest 去掉 expiresAt 字段与等待前置过期判断；授权绑定
// 项随之少一维，会话/代际/参数/策略不变）、`tool/types.ts` 与 `tool/policy.ts`
//（`execution.timeoutMs` 允许显式 `null`）、`harness-slot.ts` / `runtime.ts`（墙钟可暂停与
// 注释面）、`session/manager.ts`（切会话/关标签同时取消待答提问）随同一批改动。
// 新增 sf-24（权限确认的等待与逃生口：假时钟 10 分钟仍待答 + 下发失败立即按拒绝结算）；
// sf-01..sf-23 逐点核对实现点仍在、覆盖描述与当前实现一致（sf-05 的 why 把「确认类操作走计划
// 确认面板」订正为「走桌宠自己的确认 / 选择面板」；描述/来源核对，非逐行行为审计）；
// sourceHash 按当前源码复算。
// 2026-10-06 超时后台化批次（本批刷新）：sourceFiles 中含本批改动 —— tool/types.ts 与
//tool/policy.ts（timeoutMs 的 null 语义扩为「执行死线由执行端承载」；校验规则未变）、
//pi-tools.ts（bash 声明由 300000 改为显式 null，安全分级逻辑未动）、local-extra/agent-tool.ts
//（handler 接 ctx 并把取消域传给子运行，声明等级未动）、mcp/client.ts（声明执行预算 +
//取消信号透传，声明等级未动）、harness-slot.ts / tool_exec/mod.rs（trace 附加字段与测试更名）。
//sf-01..sf-23 逐点核对：风险分级、确认通道与凭据终判的实现点与描述未受本批影响；
//sourceHash 按当前源码复算（同批含另会话在飞改动）。
// 2026-10-06 第三轮收口（analyze→刷 hash）：本批 sourceFiles 变化 —— `safety/confirm.ts` 与
// `safety/permission.ts`（等待去超时 + GRANT_TTL_MS 授权保鲜期从按下允许起算）、
// `engine/user-wait.ts`（等待期预算豁免的唯一登记点）、`tool/types.ts` / `tool/policy.ts` 的
// timeoutMs 显式 null 语义、`local/pi-tools.ts`、`local-extra/agent-tool.ts`、`mcp/client.ts`、
// `session/manager.ts`、`runtime.ts` / `harness-slot.ts`、`tool_exec/mod.rs`（第三轮各任务已
// 登记 sf-24 与注释留痕，本轮逐点复核描述与当前实现一致，未修订）。sf-22 一处措辞订正：
// 拒绝来源里的「确认过期」改为「确认已失效」—— 确认等待已无超时（2026-10-06 用户裁决），
// 失效只来自新请求顶掉 / 取消 / 会话生命周期 / 下发失败（逃生口逐条见 sf-24）。
// sf-01..sf-23 其余点逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行
// 行为审计）；sourceHash 按当前源码复算。
// 2026-10-06 计划报告口径收窄批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（runPlanPhase 的 onStepNotice 收窄：工具名不存在
// 仍发聊天系统消息；未限定工具只写进度事件与统一日志，不再逐步骤敲系统消息）。sf-01..sf-24
// 逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）：许可内核、
// 确认 / 放行通道、凭据路径与策略冻结不在改动面内。未修订覆盖点，sourceHash 按当前源码复算
//（本批复算一并覆盖「契约账本批次」增列 paths/security.rs 时未重算的 sourceFiles 状态）。
// 2026-10-06 最终波统一刷新（本批刷新）：sourceFiles 变化仅 `src/services/session/manager.ts`
// —— deleteSession 去掉观察域的话题来源作废入口：删会话不再作废该会话产生的话题来源
// （2026-10-06 用户裁决：话题证据独立存活到自身 90 天 TTL 自然过期；作废入口只留显式治理
// 路径——清除静默了解与记忆遗忘；行为覆盖登记在 observation 的 ob-02，新 caseId
// `session-delete-keeps-topics` 的载体是 test/integration/session/会话删除与托管图片清理.test.ts）。
// 删除会话前既有的 invalidatePermissionScope(sessionId) 路径未动。sf-01..sf-24 逐点核对：
// 本契约没有「会话删除连带清话题/观察数据」的覆盖点描述（sf-20 的会话/代际授权失效与 sf-24
// 的确认逃生口都不在改动面内，许可内核、确认/放行通道与凭据路径未动），实现点仍在、覆盖
// 描述与当前实现一致，未修订覆盖点；sourceHash 按当前源码复算。
import type { ModuleContract } from "../host/types"

// 2026-10-06 契约账本批次 systematic sourceFiles 复查补入：`crates/native-host/src/paths/security.rs`
// —— sf-16 / sf-17 声称的凭据路径**词法判定**（`.ssh` 目录组件、`.pem` / `.key` 后缀、
// `.sshnotes` 这类前缀不算、大小写同判）的唯一实现点是该文件的 `is_credential_path`
// （paths/mod.rs 只是调用方）。此前只列 mod.rs：改坏判定会让凭据路径场景红而本契约 hash
// 不动（同一门禁失明形态）。sourceFiles 只增这一条；**sourceHash 刻意不在本批重算** ——
// 本批未改任何 src 源码，留待验收环节统一刷。
// 2026-10-06 抽屉三下拉统一 CONFIG 写批次（analyze→generate）：sourceFiles 变化 ——
// src/services/safety/permission.ts（freezePermissionPolicy 直读 safetyConfig.mode：
// 会话级覆盖机制（debug.ts 的 getEffectiveSafetyMode）整体删除，「安全」下拉与设置页同写
// CONFIG `ai.safety.mode`；SafetyMode 类型迁至 config.ts；「回合开始冻结」纪律不变 ——
// 回合中改配置仍从下一回合生效）与 src/services/engine/harness/runtime.ts（计划确认的
// PLAN-12 策略点改直读 safetyConfig.mode；runPlanPhase 的 onStepNotice 收窄已由上一批
// 登记）。sf-19 描述按现状修订（驱动方式改为经 setOverride 写 CONFIG：L4 场景
// 权限策略冻结.scene.ts 已同批改写，caseId 未变）；sf-01..sf-24 其余点逐点核对实现点
// 仍在、覆盖描述与当前实现一致（描述/来源核对，非逐行行为审计）；sourceHash 按当前源码复算。
// 2026-10-06 Windows CI 修复（本批刷新）：crates/native-host/src/paths/mod.rs 只在测试模块内
// 增目录符号链接助手（symlink_dir）并换用于中间目录场景 —— 逃逸拒绝与凭据路径的裁决逻辑
// 未动（sf-01..sf-24 覆盖点行为面不受影响）；sourceHash 按当前源码复算。
// 2026-10-08 数据根便携化批次（本批刷新）：sourceFiles 变化 ——
// crates/native-host/src/paths/mod.rs（947ca92/71d7eb6 便携标记 `portable.txt` →
// `<安装位置>/userdata`：PORTABLE_MARKER / SIDE_DATA_DIR / installation_side_dir /
// side_data_root / portable_data_root；ef45e60 新增 DATA_ROOT —— AppPaths::init 把真实
// 数据根登记为允许根候选）与 crates/native-host/src/paths/security.rs（ef45e60：
// allowed_file_roots 在 home/temp 之外增列数据根候选 —— Windows 装到 D 盘/便携形态下数据根
// 落在 $HOME 之外，不加会全量撞 PATH_ESCAPE；同批 main.rs 的数据根解析与卸载器模板不在本
// 契约覆盖面）。覆盖面核对（逐行读三笔 diff 对照路径裁决 / 凭据拦截 / Bash 基线 / 权限内核）：
// 凭据词法判定（is_credential_path）、validate_file_path / validate_new_file_path 的判定
// 顺序（词法 → canonicalize → 允许根，写入侧归一化 / 祖先 canonicalize / 叶子链接逐个阶段）
// 与 bash 层 1 deny_credential_paths 均零触碰；允许根增列只覆盖应用自身数据根、且凭据判定
// 先于并独立于允许根判定，sf-16/17/18 的结论与描述不变 —— L4 凭据场景「探针基址落在允许根内」
// 的前提借此从 debug 项目根候选改为全模式结构化成立。本契约不声明允许根成员 / PATH_ESCAPE
// 语义（全文无此表述），无覆盖点需要修订；sf-01..sf-24 逐点核对实现点仍在、覆盖描述与当前
// 实现一致（其余文件本批零改动，按实现点锚定核对；描述/来源核对，非逐行行为审计），
// caseId 载体（L4 safety-credential-* / safety-confirm-denied / memory-permission-freeze /
// safety-subagent-grant-scope 与 L2/L3 各测试）均在位；未修订覆盖点，sourceHash 按当前源码复算。
export const safetyContract: ModuleContract = {
  module: "safety",
  sourceFiles: ["src/services/safety/checker.ts", "src/services/safety/permission.ts", "src/services/safety/confirm.ts", "src/services/engine/user-wait.ts", "src/services/tool/types.ts", "src/services/tool/policy.ts", "src/services/tool/local/pi-tools.ts", "src/services/tool/local-extra/clipboard.ts", "src/services/tool/local-extra/agent-tool.ts", "src/services/tool/local-extra/app.ts", "src/services/tool/mcp/client.ts", "src/services/session/manager.ts", "crates/native-host/src/paths/mod.rs", "crates/native-host/src/paths/security.rs", "crates/native-host/src/commands/bash_policy.rs", "crates/native-host/src/commands/tool_exec/mod.rs"],
  sourceHash: "fdaf1267ffc4020d12f0d9aaefacaa512ba0aebca03716b18c9194d982898fd0",
  coverage: [
    { id: "sf-01", feature: "SAFE 级别放行", description: "safetyLevel=SAFE 的工具经生产裁决入口 evaluateToolPermission（标准决策层即 allow）直接放行，不生成确认请求；同一分支现在也接住 NORMAL，会话信任与安全裁决只有 permission.ts 一份实现", why: "安全等级体系基础，且放行结论必须来自唯一裁决点", layer: "integration", depth: "shallow", scenarios: ["safety-safe"] },
    { id: "sf-02", feature: "统一裁决表（SAFE / NORMAL 一律放行）", description: "标准决策是安全等级到裁决结果的唯一映射：NOWAY → deny（最前置，先于安全模式与工具侧策略）；SAFE 与 NORMAL → allow（与安全模式无关，也不看命令是否在白名单里 —— 白名单只决定 NORMAL/DANGER 的归属，是免确认通道而不是拒绝依据）；DANGER → 交给回合冻结的安全模式（let_me_tk → ask、just_do_it → allow、其余含缺省 → ask）。工具与运行模式不再参与裁决：pet/assistant 双模式、lightweightPolicy、`ToolDef.mode`/`ToolContext.mode` 已全链删除，而旧助手下 NORMAL 没有任何 allow 路径、一律 ask —— 这条收紧的消失正是 sf-21 必须逐工具重定级的原因", why: "常规工具需要安全评估，且裁决表必须唯一：NORMAL 的归属翻转后若仍留旧描述，重定级与确认通道的场景会照着已不存在的分支写断言", layer: "integration", depth: "shallow", scenarios: ["safety-normal"] },
    // sf-03 原把「裁决 + 拒绝通道 + 放行通道」合成一点（跨层混搭）；按层拆开：
    // 裁决表为 sf-22（L3）、放行侧为 sf-23（L2）、确认被拒侧留在 sf-03（L4）。
    { id: "sf-03", feature: "确认通道（拒绝方向）", description: "走到 ask 的确认请求被拒（宿主默认 deny）后工具不得执行，拒绝要留在 toolHistory 可断言 —— 不能静默变成「回复为空」；NORMAL 的白名单命令不误走确认通道（白名单只是免确认，不再是硬墙）", why: "确认通道不得挂起，拒绝必须可观测：被拒的调用不得执行、也不得静默变成空回复", layer: "e2e", depth: "deep", scenarios: ["safety-confirm-denied"] },
    { id: "sf-22", feature: "DANGER 级别按安全模式裁决", description: "safetyLevel=DANGER（含路径分级提上来的敏感路径与危险命令）不在标准决策里直接放行或拒绝，而是交给回合冻结的安全模式：let_me_tk → ask、just_do_it → allow、其余（含缺省）→ ask；**DANGER 没有 deny 归宿** —— 拒绝只来自 NOWAY、工具侧 defaultDecision: 'deny'、不可用身份与「用户拒绝/确认已失效」（确认等待本身没有超时，失效只来自新请求顶掉、取消、会话生命周期与下发失败，见 sf-24）。走到 ask 时生成确认请求（身份 = sessionId + runGeneration + toolCallId，带 inputHash 与 policyHash）。旧机制（lightweightPolicy 的 confirm/deny、助手模式弹窗、轻量模式按策略硬拒）已删，「没有确认通道就拒绝」的语义随之消失，所以 DANGER 在默认安全模式下的结论是 ask 而不是 deny", why: "危险操作需确认：裁决表变了而描述仍写「轻量模式拒绝」，重写场景时会照着已不可达的 deny 分支写断言", layer: "integration", depth: "deep", scenarios: ["safety-danger"] },
    { id: "sf-23", feature: "确认通道（放行方向）", description: "测试宿主按场景声明的策略确定性应答（默认拒绝；声明 approve 时立即放行）：approve 走 resolveConfirm(true) → allow_session 且确认记录标记 approved；用户批准且选 allow_session 时按会话信任开关入账；确认后重新评估参数与策略哈希，任一项变化都不复用旧授权", why: "approve 侧的应答形状（allow_session）是子代理授权复用的那种授权；通道必须能被场景确定性驱动，否则「放行」只能靠产品自证", layer: "unit", depth: "deep", scenarios: ["safety-confirm-approved"] },
    { id: "sf-04", feature: "NOWAY 直接拒绝", description: "safetyLevel=NOWAY 在标准决策最前置的一步被拒绝（先于风险到安全模式的映射与工具侧策略），结论与安全模式、会话信任都无关", why: "绝对不允许的操作", layer: "integration", depth: "shallow", scenarios: ["safety-noway"] },
    { id: "sf-05", feature: "bash 危险命令匹配", description: "BASH_DANGEROUS_PATTERNS 匹配 rm 递归删除（合并/分开/长选项/多空格）、sudo 等危险命令，以及等待用户点按的系统对话框（`display dialog` / `display alert`，2026-10-06 批次加入：弹窗会被工具超时打断并留下孤儿窗口，命中后先走确认；只匹配这两个等待式命令，osascript 的普通自动化不误伤——负对照在 `[safety-danger-pattern]` 里），且不误伤普通 rm", why: "命令注入防护；等待用户的操作不许用命令实现——确认与选择类操作走桌宠自己的确认 / 选择面板，命令的 stdin 在 Rust 侧关死后这道 pattern 管的是不读 stdin 的 GUI 等待", layer: "integration", depth: "shallow", scenarios: ["safety-danger-pattern"] },
    { id: "sf-06", feature: "bash NOWAY 匹配", description: "BASH_NOWAY_PATTERNS 匹配 rm -rf /（根目录）与 sudo rm 等硬禁止命令，且不误杀 rm -rf /home/user", why: "系统破坏命令禁止", layer: "integration", depth: "shallow", scenarios: ["safety-noway-pattern"] },
    { id: "sf-07", feature: "文件路径分级", description: "resolveFilePathLevel 按路径分级：私钥凭据一律 NOWAY、.env 与系统目录 DANGER、普通路径 SAFE，Windows 反斜杠先归一，缺失 path 参数不提级；FILE_DANGEROUS_PATTERNS 仍是两个等级（凭据级 NOWAY 与敏感级 DANGER）正则的按子集并集；该分级确实挂在注册过的生产工具上 —— pi-read 按调用参数里的 path 分级，pi-bash 在命令模式匹配之后按同一规则逐个路径 token 取更严者（`cat ~/.ssh/id_rsa` 升为 NOWAY，普通路径不被误提级）", why: "敏感文件泄露防护，且分级必须真正接在生产工具上而不只是被断言", layer: "integration", depth: "shallow", scenarios: ["safety-file-pattern"] },
    { id: "sf-09", feature: "LLM 危险 Bash 调用实际拦截", description: "模型请求 rm -rf / 时，Bash 硬禁止策略在执行前拒绝执行；模型输出由 fake Provider 固定，工具与安全链路真实", why: "端到端安全验证", layer: "integration", depth: "deep", scenarios: ["safety-dangerous-delete"] },
    { id: "sf-10", feature: "Pi 工具门禁 fail-closed", description: "Pi 原生工具门禁（Harness before_tool 复用同一语义）在 block 与抛错两种情况下都不执行工具，并留下带原因的 error 工具结果", why: "工具门禁必须 fail-closed，否则安全策略只是建议", layer: "unit", depth: "deep", scenarios: ["safety-hook-errors"] },
    { id: "sf-11", feature: "MCP passthrough 终裁", description: "MCP 适配器的权限意见只能是 policy.permission.defaultDecision=passthrough；PermissionKernel 必须把它收敛为 allow、ask 或 deny，executor 不得看到 passthrough。发现侧把 MCP 工具声明为 DANGER（sf-21），因此默认安全模式下 passthrough 的收敛结果是 ask —— 重写本点场景要按 DANGER 选探针，NORMAL 在新裁决表下会先被标准决策放行", why: "发现远端工具不等于默认信任", layer: "integration", depth: "deep", scenarios: ["permission-passthrough-final"] },
    { id: "sf-12", feature: "PermissionKernel deny-first", description: "不可放宽的 NOWAY 硬拒绝优先于工具策略里的 allow；工具侧 defaultDecision 与标准决策取交集：任一侧是 ask 就是 ask（工具声明的独立 ask 不被普通 allow 吞掉），标准决策的 ask 也不能被工具侧 allow 降级为放行，工具侧 deny 直接拒绝，工具返回表外意见按 deny 处理。新裁决表下**走到 ask 只剩两条路**：DANGER 在默认安全模式下，或工具自己声明 defaultDecision: 'ask'；「NORMAL 在助手模式下必为 ask」的旧路径已不存在，所以重写本点场景必须用 DANGER（或工具侧 ask）做 ask 探针", why: "权限组合必须 fail-closed，且 ask 的来源在统一裁决后已收窄，旧探针会落在永久 allow 的分支上", layer: "integration", depth: "deep", scenarios: ["permission-deny-first"] },
    { id: "sf-13", feature: "确认身份与失效", description: "权限评估要求 sessionId、runGeneration、toolCallId 与当前代际；缺失、取消或旧代际一律拒绝", why: "旧确认不得授权新回合", layer: "integration", depth: "deep", scenarios: ["permission-identity-invalid"] },
    { id: "sf-14", feature: "精确会话授权", description: "allow_session 仅复用相同 session、generation、tool、参数与策略指纹的未过期授权；策略指纹由工具策略（含策略版本与执行/投影/摘要维度；mode 维度已删）、本次解析的风险等级、安全模式与信任开关（后二者取回合冻结快照）共同决定，任何一项变化都不复用旧授权。策略版本已递增到 2（安全等级到裁决的映射语义变化，§8.5）：旧版本声明连同旧授权一起失效，授权表本身是模块级内存 Map、不落盘也不过进程", why: "一次确认不能扩大到其他输入、回合或已改变的策略", layer: "integration", depth: "deep", scenarios: ["permission-session-grant"] },
    { id: "sf-15", feature: "取消确认", description: "已取消 signal 的确认立即按拒绝结算，不遗留 pending UI", why: "取消不能让旧确认继续授权", layer: "integration", depth: "deep", scenarios: ["permission-aborted-confirm"] },
    { id: "sf-16", feature: "凭据路径的 Rust 终判", description: "经 IPC 直连 file_read 与 bash_exec：凭据路径（`.ssh` 目录组件、`.pem`/`.key` 后缀，`.sshnotes` 这类前缀不算）被拒绝 —— 文件入口返回 SENSITIVE_PATH 而不是 PATH_NOT_FOUND（词法判定先于 canonicalize，不存在的路径也一样；写入侧在归一化路径、canonicalize 后的祖先与叶子链接上各判一次），bash 入口返回 TOOL 且文案指明凭据路径（层 1 的 deny_credential_paths，与层 1 硬基线、层 2 的系统路径保护并列，调用方不可关闭）。bash 入口**不再接受 scope 与白名单入参**（决策 7：Rust 的 `BashPolicy`/`BashScope`/`enforce_whitelist`/`first_control_syntax` 已删，`enforce_bash_policy(command)` 只收命令本身），所以拒绝不可能来自白名单、策略强度或超时 —— 旧描述里「两种 scope 共用」的前提已不存在", why: "TS 分级副本可被绕过，凭据泄露的最终判定必须在 Rust 且不可关闭；入参面收窄让「调用方无法传弱」本身成为结论", layer: "e2e", depth: "deep", scenarios: ["safety-credential-paths"] },
    { id: "sf-17", feature: "私钥读取被拦", description: "模型请求 read .ssh/id_rsa 时工具不以 done 收场、不经确认通道放行（确认被批准也不能把它放行），会话条目里不出现 OpenSSH 私钥正文", why: "私钥只读一次就足以泄露，且泄露会持久化进会话文件", layer: "e2e", depth: "deep", scenarios: ["safety-credential-read-blocked"] },
    { id: "sf-18", feature: "凭据命令的子进程边界", description: "模型请求 bash 把私钥重定向到文件时工具不以 done 收场；安全基线在 spawn 之前拒绝（被拦回合的耗时远早于命令自然时长），重定向产物不存在 —— 子进程从未产生", why: "bash 是绕过文件工具读取凭据的另一条入口，拦截必须发生在执行之前", layer: "e2e", depth: "deep", scenarios: ["safety-credential-bash-blocked"] },
    { id: "sf-19", feature: "权限策略按回合冻结", description: "PermissionContext 带预检冻结的 policy：回合中改 CONFIG `ai.safety.mode`（L4 场景经 setOverride 驱动；设置页「确认策略」与抽屉「安全」下拉同写该键）不改变本回合的裁决与 policyHash，从下一回合生效", why: "裁决与授权哈希必须来自同一份策略快照，否则同一次确认可能在策略变动后命中旧授权", layer: "e2e", depth: "deep", scenarios: ["memory-permission-freeze"] },
    { id: "sf-20", feature: "子代理授权的会话与代际绑定", description: "计划步骤子代理内的 allow_session 授权按父会话与父槽代际入账：运行内确认请求的身份与工具上下文读到的父会话/父代际逐字段一致，同参第二次命中 grant 不再确认；回合结束后 grant 随 invalidatePermissionScope(会话, 代际) 释放，同参同身份重评估回到 ask；切会话后同参 grant 同样不得命中，必须重新确认", why: "授权不绑定会话与代际会让用户在不知情的新会话里被放行，或让旧代际的授权在运行结束后继续生效", layer: "e2e", depth: "deep", scenarios: ["safety-subagent-grant-scope"] },
    { id: "sf-21", feature: "逐工具重定级", description: "决策 6 的「统一裁决表」与「逐工具重定级」是同一枚硬币：NORMAL 从「助手模式下必 ask」变成「一律 allow」之后，必须同时把隐私与远端能力的声明等级提上去 —— clipboard_read 与 agent_spawn 由 NORMAL 提为 DANGER，MCP 工具（发现侧 client.ts）声明为 DANGER，因此三者在默认安全模式下走 ask（just_do_it 下 allow）而不是被 NORMAL 静默放行；pi-bash 的白名单命令保持 NORMAL 并因此变成免确认（白名单只是免确认通道），app_open 与 clipboard_write 本来就是 DANGER、本次不变。注：本点钉的是注册表里读到的声明等级（可直接断言），实际确认动作由 sf-03 与 /skill、子代理的准入路径覆盖；本点由 L3 测试 `test/integration/safety/工具重定级.test.ts` 覆盖（caseId `safety-regraded-tools`，W2 从 L4 场景迁入）", why: "「统一后 NORMAL 一律放行」本身是放宽，提级是它的唯一补偿；漏掉任一项都会让剪贴板读取、子代理或远端 MCP 调用从「每次都问」变成「从不问」", layer: "integration", depth: "shallow", scenarios: ["safety-regraded-tools"] },
    { id: "sf-24", feature: "权限确认的等待与逃生口（不留等待超时）", description: "权限确认等待**没有超时**（2026-10-06 用户裁决：选择类弹窗不留超时，用户想多久想多久）：假时钟推进 10 分钟，confirmState.pending 仍是原请求、请求不结算（旧实现 5 分钟处按拒绝结算，本断言因此有区分力）。原先的超时兼的职责（「面板没送到就没完没了」）改由显式逃生口承接：权限事件下发失败由桥立即按拒绝结算（fail-closed，native-ui/permission-confirm.ts，caseId 归 native-ui 的 nui-25）、新请求顶掉旧请求按拒绝结算（单槽语义）、signal abort（用户停止回合/回合失效）与 invalidatePermissionScope（会话切换/关闭/恢复）按拒绝结算；授权侧「会话内允许」的 5 分钟保鲜期不受影响（授权与确认是两个生命周期，从用户按下允许起算）。注：确认载荷不再携带 expiresAt（等待没有有效期可展示），面板的「有效期至」一行随之退场", why: "等待超时按拒绝结算是把「用户还没想好」当成「用户拒绝」；但没有超时之后必须逐条给出逃生口，否则一次下发失败会让回合永久悬挂", layer: "integration", depth: "deep", scenarios: ["native-ui-permission-confirm-no-wait-timeout"] },
  ],
  // W0–W7 把本契约迁出 L4 的场景按 L4 侧当前值重标定：门槛=当前 rules 声明值
  // （sf-03 `safety-confirm-denied`、sf-16/17/18 的 `safety-credential-*`、
  // sf-19 `memory-permission-freeze`、sf-20 `safety-subagent-grant-scope` 留在 L4），
  // 只缩不放（数字由 checker 报错提供）；跨层完整性由 checkLayerCoverage 负责。
  rules: { minScenarios: 6, minDeepScenarios: 6, requireBoundary: true, requireErrorPath: true },
}
