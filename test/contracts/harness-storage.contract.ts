// 2026-10-06 聊天图片与折叠守卫批次（analyze→generate）：sourceFiles 变化 ——
// `src/services/engine/harness/session-fold.ts`：FOLD_POLICY 新增第四个阈值 maxFileBytes
// （64 MiB，读取守卫 = 折叠自愿设的读上界），旧守卫「文件 > MAX_TOOL_FILE_BYTES（5 MiB）
// 就不读」被替换 —— 会话读路径没有单次大小上限（session_read_text），MAX_TOOL_FILE_BYTES
// 只约束写（file_write）；结果守卫（折叠结果 > 5 MiB → skip("too-large")）保留。
// hs-07 描述按当前判定顺序订正（读守卫 / 结果守卫各按其上限），并把尺寸守卫的两条 L3
// 用例登记进 scenarios（harness-session-fold-read-guard / harness-session-fold-result-guard，
// 此前测试未带 caseId）。hs-02 的「读写都下发 5 MB 硬上限」口径经复核仍成立（写侧不变；
// 读侧折叠守卫已归 hs-07 的 maxFileBytes，非会话 FileSystem 的 file_read 上限不变）。
// 其余点不在改动面内、实现点仍在；sourceHash 按当前源码复算。
// 2026-10-06 契约刷新（第二轮验收 · 本批刷新）：sourceFiles 变化 ——
// src/services/tool/pi/native-execution-env.ts 只有注释新增（exec 的 timeoutMs 秒→毫秒换算
// 与 pi-bash 的 prepareArguments 下传、直调 null 由 Rust 同值兜底的关系说明，属 bash 超时
// 档位批次；换算本身不在本契约覆盖点的行为面内）。hs-01..hs-09 逐点核对：MAX_TOOL_FILE_BYTES
// = 5 MiB（读侧上限与 file_write/file_append 单次写上限、会话条目写盘的唯一物理上限）与
// 错误码映射（PATH_NOT_FOUND→not_found、未列出的码保持 unknown）实现点仍在；FOLD_POLICY 的
// minFileBytes / maxFileBytes（64 MiB，折叠自愿的读上界）/ 结果守卫读 MAX_TOOL_FILE_BYTES
// 三处与 hs-07 描述一致。未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 会话活动时间批次（实施期记录；sourceHash 与覆盖点待验收 analyze→generate 刷新）：
// sourceFiles 中的 src/services/session/repo.ts 变化 —— PiSessionSummary 新增 `activityAt`
//（会话列表排序口径：正文最后一条 role:"user" 条目；读取只扫文件尾部 + (路径, mtime) 键控缓存，
// 新模块 src/services/session/activity.ts；宿主侧 `session_read_text` 增可选 `tailBytes` 尾部
// 读取模式）。本契约覆盖面内的存储语义未变：hs-07 的折叠读取守卫（maxFileBytes）与
// MAX_TOOL_FILE_BYTES 的写侧上限口径不变；hs-01..hs-09 逐点核对实现点仍在、描述与当前实现一致。
// 2026-10-06 超时后台化批次（本批刷新）：native-execution-env.ts —— 构造增可选 sessionId
//（完成通知归属）、exec 增加 backgrounded 回执映射（hs-01 的构造签名一句已同步）；
//MAX_TOOL_FILE_BYTES 与折叠链未动。hs-01..hs-09 逐点核对一致；sourceHash 按当前源码复算。
// 2026-10-06 验收批次（analyze→generate 的声明部分；sourceHash 留待主会话统一批量刷新）：
// sourceFiles 变化 —— session-file-system.ts（会话根内整文件覆盖写分流 session_write_text、
// 上限 SESSION_WRITE_MAX_BYTES = 64 MiB；只放宽 writeFile，追加写与根外路径仍走工具面
// 5 MiB）、session-fold.ts（结果守卫改按会话写上限判定；可回收规则扩为「同一 value key
// 只保留最后一次写入」）、native-execution-env.ts（MAX_TOOL_FILE_BYTES 注释改为只约束
// 工具面 + 临时名前缀常量 DEFAULT_TEMP_PREFIX）、session/repo.ts（PiSessionSummary 的
// activityAt）与 session/activity.ts（新模块：活动时间尾部读取）；新增宿主侧
// crates/native-host/src/commands/session_fs.rs 入列（session_read_text 的 tailBytes 尾部
// 模式与 session_write_text 的会话写路径的实际实现点，此前不在任何契约的 hash 覆盖内）。
// 修订：hs-02 注册 harness-session-write-limit 并按会话专用写上限订正（旧「5 MiB 是会话
// 条目写盘的唯一物理上限／折叠结果守卫读同一份」已过时）；hs-07 的①补「同一 value key
// 只保留最后一次写入」规则扩展、结果守卫口径改 SESSION_WRITE_MAX_BYTES、触发挂点改由两条
// 关闭后折叠用例直接断言；新增 hs-10（会话活动时间：会话读的 tailBytes 模式 + 活动时间
// 读取的磁盘侧口径，测试锚点 harness-session-activity-tail-read，落在
// test/integration/session/会话活动时间.test.ts 的「活动时间取最后一条用户消息」用例上）。
// hs-01..hs-09 其余逐点核对实现点仍在、覆盖描述与当前实现一致（描述/来源核对，
// 非逐行行为审计）。
import type { ModuleContract } from "../host/types"

export const harnessStorageContract: ModuleContract = {
  module: "harness-storage",
  sourceFiles: [
    "src/services/engine/harness/session-repo.ts",
    "src/services/engine/harness/session-frame-buffer.ts",
    "src/services/engine/harness/session-fold.ts",
    // 2026-10-06 验收批次补入：会话根内整文件覆盖写的分流与专用上限（SESSION_WRITE_MAX_BYTES）
    // 的唯一定义点 —— hs-02 的写侧放宽（harness-session-write-limit）与 hs-07 的结果守卫
    // 都从这里取真实上限（与 FOLD_POLICY.maxFileBytes 同值：折叠只删不增 ⇒ 结果 ≤ 输入 ≤ 读守卫）。
    "src/services/engine/harness/session-file-system.ts",
    "src/services/tool/pi/native-execution-env.ts",
    "src/services/session/repo.ts",
    // 2026-10-06 验收批次补入：会话活动时间读取（hs-10）的实现 —— 只扫文件尾部的
    // session_read_text tailBytes 模式 + (路径, 仓库 mtime) 键控缓存 + 最后一条 user 条目的尾部解析。
    "src/services/session/activity.ts",
    // 2026-10-06 验收批次补入：宿主会话读写命令的实际实现点（session_read_text 的 tailBytes
    // 尾部模式、session_write_text 的会话专用上限执行与 base 边界裁决）；hs-02 写侧边界的
    // Rust 半边与 hs-10 的字节裁剪语义都在这里，改它此前不判 STALE。
    "crates/native-host/src/commands/session_fs.rs",
    // 2026-10-06 契约账本批次 systematic sourceFiles 复查补入：hs-04（旁路写入与分支 tip 链）
    // 声称「活槽存在时 appendPiSessionCustomEntry 转交 HarnessSlot.appendCustomEntry → AgentLane，
    // 由 Pi 按当前 operation 状态提交进分支或持久 inbox」—— 这段转交语义的实现点在
    // `src/services/engine/harness/harness-slot.ts`（session/repo.ts 只是入口）。此前漏列：
    // 改坏转交（回退到旧内存 tip 续写、把条目挤成孤立分支）会让场景红而本契约 hash 不动。
    // 该文件同时在 agent-runtime 契约在列，共享文件多契约并列是既有形态。
    "src/services/engine/harness/harness-slot.ts",
  ],
  sourceHash: "ce10eb697db8c1c476ce1f3b55fc82077c1f68fcfbe149e8e7eb9ca62c683500",
  coverage: [
    {
      id: "hs-01",
      feature: "JsonlSessionRepo 官方一致性",
      description: "官方一致性套件 17 条 case 里取 15 条（lifecycle 4 / ownership 1 / messages 2 / fork 行为 7 / fork 源快照 1）在 NativeExecutionEnv（真实 Rust IPC）上通过：创建、列举、删除、独占打开、消息持久化、fork；fork destination reservation 组（2 条「先调用者先占位」）整体不纳入：其中「先 fork 后 create」一条依赖占位时序，在官方 NodeExecutionEnv（node:fs）上同样稳定失败（2026-09-24 复核：17 条里 16 过、1 败且败的正是该条）—— 上游 `JsonlSessionRepo.fork` 在占位前多一次 `captureForkSource` await，create 因此确定性地先占住目标 id，不是偶发抖动。本覆盖点是 H-1 的存储层边界：只验证存储实现，不经过模型；生产入口的写入路径由 hs-04 承接",
      why: "H-1 用官方协议验证存储实现，重启恢复与 fork 语义不靠自造断言",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-session-repo-conformance"],
    },
    {
      id: "hs-02",
      feature: "NativeExecutionEnv FileSystem 补全",
      description: "readTextFile/writeFile/appendFile/renameFile/createDir/remove/createTempDir/listDir 经真实 Rust 命令完成且不 throw（失败以 Result 返回）；失败按 Rust 结构化错误码归类而不是拿 message 猜，但**本点（L3 用例）背书的只有两条**：PATH_NOT_FOUND→not_found 与未列出的码（以 TOOL 实测）如实保持 unknown —— **SENSITIVE_PATH / PATH_ESCAPE→permission_denied 与 NOT_ABSOLUTE→invalid 依赖 Rust 侧路径裁决**，`test/host/node-ipc.ts` 按设计只实现机制、不做路径裁决（实测 `.ssh/probe` 落成 not_found、相对路径写入直接成功），Node 侧无法复现，**这 2 条属 L4**（production 批次另立出口），本点不声称覆盖；rename 原子替换已存在目标；remove 遵守 recursive/force（force 时缺失算成功，目录需 recursive）；createDir 默认递归；listDir 直接返回绝对 path、size、mtimeMs 与 file/directory/symlink 三值 kind。构造签名是 new NativeExecutionEnv(cwd, sessionId?)（模式参数已删，决策 5；可选 sessionId 是 2026-10-06 后台化批次加入的完成通知归属，只随 bash_exec 下传，不在本契约行为面内）。所有读写都下发 MAX_TOOL_FILE_BYTES = 5 MB 的硬上限（readTextFile/readBinaryFile 的读上限，writeFile/file_append 的单次写上限）—— 它约束的是**工具面**的通用文件命令，MCP 的一次性截断删除后大结果全靠它兜底：超限时 Rust 如实报错、**不做静默截断**（§8.8 的裁定。注：正好超限被拒这条边界未由本点的场景断言）。会话条目的写盘另有会话专用口径（2026-10-06 折叠批次落地）：会话仓库经 `SessionFileSystem` 把会话根内的**整文件覆盖写**分流到 `session_write_text`，上限取 `SESSION_WRITE_MAX_BYTES` = 64 MiB（与 `FOLD_POLICY.maxFileBytes` 同值），追加写（帧、提交事务）仍走工具面 `file_append` 的 5 MiB、根外路径回落 `file_write` 的本上限 —— L3 用例 `harness-session-write-limit` 实测两侧边界：根内 >5 MiB 写入放行并逐字节落盘，同一实例、同一载荷在根外仍被拒（错误码如实为 unknown），且常量关系 `SESSION_WRITE_MAX_BYTES > MAX_TOOL_FILE_BYTES` 成立；Rust 侧的 base 边界裁决留 L4。折叠链的两条尺寸守卫都不复制本常量：读取守卫是 `FOLD_POLICY.maxFileBytes`（64 MiB，折叠自愿设的读上界，不是读路径限制 —— 会话读路径本身没有 5 MiB 限制），结果守卫读 `SESSION_WRITE_MAX_BYTES`（会话写路径的真实约束，见 hs-07）",
      why: "JsonlSessionRepo 的原子发布依赖 append+rename，list 依赖完整 FileInfo 字段，能力缺口会让会话无法落盘或无法恢复；错误码是调用方唯一的分类依据，文案随实现漂移",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-execution-env-filetree", "harness-session-write-limit"],
    },
    {
      id: "hs-03",
      feature: "会话重启恢复与目录边界",
      description: "同一磁盘根上新建仓库实例后，list 从磁盘头部恢复 metadata、open 重新加载会话状态；会话文件落在给定会话根（数据根 sessions/ 同形）的 --cwd-- 子目录下，根上的 index.json（UI 状态）与旧 .md 残留不参与扫描、也不影响读写；列举不默认按当前 cwd 过滤，也不忽略调用方显式传的 cwd：数据根变更或 --cwd-- 目录编码碰撞后，同根下别的 cwd 目录里的会话仍被如实列出（调用方按 metadata.cwd 自行判别），显式 { cwd } 则只列那一个目录。消费侧（session/repo 的 listPiSessionMetadata）对跨根项做一次性的留痕属日志行为，未由场景断言",
      why: "H-1 的完成条件是重启后可恢复会话，且会话正文与同根的 UI 状态文件互不干扰；「index.json 里有 id、列表里静默消失」正是列举按当前数据根过滤带来的现象",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-session-restart-recovery"],
    },
    {
      id: "hs-04",
      feature: "旁路写入与分支 tip 链",
      description: "阻塞工具期间经 session/repo 的旁路入口写入自定义条目，断言它回合结束后的归宿：条目在会话文件中可读、其 seq 早于收尾后的 tip，且**在** lane 分支的 tip 链上。活槽存在时 `appendPiSessionCustomEntry` 转交 `HarnessSlot.appendCustomEntry` → `AgentLane`，由 Pi 按当前 operation 状态提交进分支或持久 inbox，Harness 不再从旧内存 `state.tipId` 续写把旁路条目挤成孤立分支；无活槽的空闲会话仍走 session Branch 单写路径。契约只钉「条目在 tip 回溯链上」这一证据链归属，不钉它必须落在哪一个提交批次",
      why: "lane 的 tip 缓存若按旧 tip 续写，旁路写入的审计条目会静默从证据链里消失（条目还在文件里，却不在 tip 回溯链上）——本覆盖点就是这条风险的实测出口",
      layer: "e2e",
      depth: "deep",
      scenarios: ["harness-branch-tip-bypass"],
    },
    {
      id: "hs-05",
      feature: "帧写入合并与触发时机",
      description: "帧写入缓冲装饰器（session-frame-buffer.ts）在真实 commit 路径上的行为（2026-10-05 起含同键 delta 合并；细粒度合并语义见 hs-09）：① 合并——200 条真实帧 append（thinking_delta，单条约 370 B）的底层 appendFile 调用数 ≤ ⌈实收字节/16 KiB⌉+1 且 ≥1（合并率 50× 量级）；活动会话读路径（in-memory 状态）仍按序读回 200 条、内容逐项一致（合并只改落盘层，不改活动会话逻辑状态），而未包装 env 直读的盘上帧行数 < 推入帧数且按序拼接逐字节等价（合并发生的持久层证据）；② 非帧写入永远立即落盘——流式中以 value/set 收尾时先冲干净同路径缓冲再转发，未包装的 env 直读原始文件同刻能看到该 value/set 行与全部缓冲帧（帧行排在其前，帧行按序拼接 = 推入序列）；③ 读前 flush——装饰器读同一路径前先落缓冲（三条同键 delta 合并成一行、拼接等价），且底层调用顺序是 appendFile→readTextFile（顺序证据）；④ 关闭前 flush——会话句柄释放（releasePiSession）经模块级 flushSessionFrameWrites 把残留帧落盘，文件末行即含最后一条 delta 的帧；⑤ 失败留痕——注入落盘失败时经 logger（通道 `FrameBuffer`）的 error 级留痕（logger 的 error 无条件走 `console.error`，场景据此捕获）含 FRAME_FLUSH_FAILURE_MARK、缓冲被丢弃（不重试、失败批不重放）、下一批只带自己那一帧。另有 FIFO 重放等价（两类触发都走到；底层实收的 delta 按序拼接与推入序列逐字节相同、行数少于帧数）、体积阈值触发（未达阈值不落盘 / 跨阈值整批合成一行、一条不少）与 O-9 旁路（关闭合并后 8 帧 → 8 次 appendFile，同一批帧行走合并路径后调用数与行数都更少且 delta 拼接与直写逐字节相同）。判别一律用生产判别器 isFrameAppendTransaction（解析后要求恰好单写 + kind/op/namespace 三字段），不用子串匹配。**未覆盖**：真实流式回合下的帧落盘与读回归属 hs-06；应用级强制退出（托盘 app.exit）不在此口径内——「退出前」= 会话句柄关闭前",
      why: "帧是每个流式 delta 一行的进度快照，基线实测 124.8 次/秒写盘；合并若漏（不合并/丢帧/顺序错乱/拼接错）或非帧写入被推迟，轻则磁盘抖动重则正文 entry 持久性受影响；失败若静默（上游 progress.js 把帧写失败吞掉）或重试重放，会既无痕迹又无界增长。本覆盖点是 T-1..T-6 的唯一机制出口，O-9 开关「写反或恒真」也由它的旁路 check 挡住",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-frame-write-buffer"],
    },
    {
      id: "hs-09",
      feature: "同键 delta 帧合并的语义（L2 纯逻辑）",
      description: "缓冲装饰器在内存 FileSystem 上的合并语义逐条钉死：① 同一 (namespace, key, value.type, value.contentIndex) 槽位的连续 delta 合并成一条记录——N 条只产生一次 drain 与一行，value.delta 按到达顺序字符串拼接、seq 取最后一条；② 物化边界——非 delta 帧（text_end 等覆盖语义帧）强制先物化，合并行排在 end 行之前，end 之后的 delta 另起一行；③ 槽位隔离——不同 contentIndex / 不同 type / contentIndex 缺失（归一为一个槽位）互不合并，各成一行；④ 跨类型交错（text→thinking→text）时物化按最后 seq 升序排序，整文件行 seq 严格递增；⑤ 重放等价——同一帧序列的原始逐帧与合并结果，经本仓 session-fold.ts 的真实重放（replayLogState）+ pi-ai 的真实帧折叠（reduceAssistantMessageFrames）折出**同一助手消息**（含工具调用 JSON 累积与 text_end 覆盖），且合并后行数更少；⑥ 非帧写入仍先冲干净缓冲、自身立即落盘（T-3 不因合并改变）。测试用上游 write 构造器造帧行并手赋 seq（模拟提交时分配），判别用生产判别器。",
      why: "「一个 token 一条 JSONL 记录」的落盘膨胀（实测单会话 488 thinking_delta + 97 text_delta）只能靠合并消除；合并一旦跨 *_end 边界、拼接顺序错乱或 seq 排序错，崩溃恢复/重放读回会静默产出与原始流不一致的正文——这是 L3 计数器口径看不见的语义层，必须在真实重放与真实折叠函数上逐条对照。",
      layer: "unit",
      depth: "deep",
      scenarios: [
        "harness-frame-delta-merge-same-slot",
        "harness-frame-delta-merge-boundary",
        "harness-frame-delta-merge-slots",
        "harness-frame-delta-merge-seq-order",
        "harness-frame-delta-merge-replay-equivalence",
        "harness-frame-delta-merge-nonframe-immediate",
      ],
    },
    {
      id: "hs-06",
      feature: "真实流式回合下的帧落盘与重放读回",
      description: "production 入口（经 sendMessage 走 fake Provider 的真实流式链路）跑完整一回合后，从**未包装**的 NativeExecutionEnv 直读会话 JSONL 原始文件：① 该回合的帧行已落盘且存在 text_delta 行，按 seq 升序拼接所有行的 delta 后**包含**唯一哨兵（内容与顺序的正面证据；不要求与输入整段相等，宿主可能有投影/过滤）。**2026-10-05 起同键 delta 合并落地**：同一 (type,contentIndex) 槽位的 delta 在边界（非 delta 帧 / drain）之间合成一行，行数从逐 token 的数百行降到个位数——断言以「拼接包含哨兵 + seq 严格递增」为准，不再要求行数达到流式 delta 的估算值（原「≥ 100 行」的下限是逐 token 落盘时代的口径，随合并作废）；② 本回合 assistant entry 的 seq 大于该帧组内全部行 的 seq，且该 entry 行确实在盘上 —— 证明「帧在缓冲里 → 一次非帧 entry 提交把缓冲冲干净并立即落盘」（T-3 的真实链路侧）；③ 把**终局 delete 之前**的真实字节截成快照喂给新的仓库实例，`list()`/`open()`/`readList(order:\"asc\")` 逐项断言行数、seq 与 value 与 ① 相等（T-4：重放读回不回归）。**③ 的口径必须按实测**：上游在回合收尾的多写事务里对帧列表发 `list/delete`（`drive/terminal.js` 的 operationCleanupWrites，参考会话 9/9 组都有、且与 assistant entry/usage/branch tip 同一行），因此**回合结束后从实时数据根 `readList` 返回 0 条**——本覆盖点证明的是「帧确实落盘且可被重放读回」，**不是**「回合结束后仍可从 readList 读回帧」。本场景补的空白：hs-05 证明机制与调用次数（可注入计数 env），本场景证明真实链路只证内容与顺序、不证调用次数（应用单例 repo 无法注入计数器）",
      why: "hs-05 用可注入的计数 env 钉住机制，但注入路径与生产单例仓库不是同一对象；真实流式链路若在接线处退化（例如装饰器没包上生产路径、或非帧提交不再触发 flush），只有本覆盖点能在没有计数器的情况下用「内容 + 顺序 + 重放读回」把它抓出来",
      layer: "e2e",
      depth: "deep",
      scenarios: ["harness-frame-throttle-live"],
    },
    {
      id: "hs-07",
      feature: "会话日志折叠的正确性（纯删除式回收）",
      description: "在临时会话根上跑一次**真实折叠**（真仓库提交造条目 + raw append 造帧的夹具），逐条钉住：① 可回收判定（2026-10-06 规则扩展「同一 value key 只保留最后一次写入」）：已 delete 的 key 的全部 append/set 行被删（`list/append` 与 `value/set`，行号**严格小于**该 key 最后一次对应 `delete` 的行号；delete 行自身与其后的写入一律保留）；从未 delete、被反复覆盖的 `value` key，行号严格小于该 key 最后一次 `value/set` 的 set 行同样可丢（scalar 覆盖语义；`list/append` 不适用这条 —— 元素序列是语义，其回收来源仍是最后一次 delete 之前）；② **保留行必须是原文子串**（折叠只做行级纯删除，不重编号、不重写任何保留行、不重新序列化，且整行粒度 —— 一行里只要有一个保留写入就整行原样留下）；③ 折叠前后 `logStateDigest()` **逐字相同**（= `sha256Text(stableSerialize(replayLogState(log)))`；S-1：摘要只依赖逻辑状态，不含行序/字节数/时间戳）；④ 折叠后文件仍可被上游重放读回；⑤ **幂等**——折叠结果再折叠不再有可回收行；⑥ **版本白名单降级（S-6）**——header 不是 v4 + `storageVersion: 1`（`JSONL_STORAGE_VERSION`）时 `skip(\"unknown-format\")`、原文件逐字未动，`storageVersion` 变值与 `v: 3` 两个变体各验一遍（探针文件必须先超闸门 1，否则断言会退化成闸门 1）。夹具的字节/字符比经离线实跑量测（1.809）后定阈值，不按估算写。折叠驱动 `foldSessionFile` 的判定顺序写死（**先判定后动盘**）：闸门 1（`fileInfo().size <= minFileBytes`，只看不读）→ 读取守卫（超 `FOLD_POLICY.maxFileBytes` = 64 MiB 不读不折 —— 它是折叠自愿设的读上界，会话读路径本身没有单次大小上限）→ 读一次全文 → 白名单判定 → 闸门 2（`minReclaimBytes` 与 `minReclaimRatio` 字节口径 AND）→ 结果守卫（折叠结果仍超会话写上限 `SESSION_WRITE_MAX_BYTES` = 64 MiB → `skip(\"too-large\")`，磁盘逐字未动）→ 先算两侧摘要再写。两条尺寸守卫各有 L3 用例实测：读守卫侧「文件超 5 MiB 写入上限仍折成功」（`harness-session-fold-read-guard`，旧守卫把写上限误用到读侧时这条会红）；结果守卫侧「折叠结果超工具面 5 MiB 但未超会话专用上限 → 折成功、结果经会话写路径落盘」（`harness-session-fold-result-guard`，旧守卫按 5 MiB 判时这条会红）。触发挂点由 `harness-session-fold-close-path` / `harness-session-fold-close-failure` 两个 caseId 直接断言（真实 release 路径真折叠、缓冲尾巴一并回收、条目逐字保留与重开重放；rename 注入失败时原文件逐字未变、release 照常 resolve、统一留痕、故障解除后会话照常可用）：`releasePiSession` 的 `try/catch/finally` **整体之后**（主路径：先 `close`、再冲帧缓冲、最后折叠）与 `open` 前按需兜底（`maybeFoldBeforeOpen`，仅当文件超 `minFileBytes` 才真的折叠，常态只花一次 stat）；两处失败都只留痕，不影响会话功能。**未覆盖**：中断安全与地址交界属 hs-08；上游 `JsonlStorage.open` 的正面确认属 hs-01 —— 本点对 raw 行的上游合法性只有「seq 严格递增 + 重放不抛」两条侧证",
      why: "折叠是这个批次里唯一**重写用户文件**的动作，一旦保留行被重写或逻辑状态被改动，损害是不可逆的（会话历史被静默篡改）。本覆盖点是 S-1..S-4/S-6 的唯一出口：它同时证明「回收真的发生」与「除了该删的行，一个字节都没动」",
      layer: "integration",
      depth: "deep",
      scenarios: [
        "harness-session-log-fold",
        "harness-session-fold-read-guard",
        "harness-session-fold-result-guard",
        "harness-session-fold-close-path",
        "harness-session-fold-close-failure",
      ],
    },
    {
      id: "hs-08",
      feature: "折叠的中断安全与地址不变性",
      description: "三条互补路径。① **中断安全（S-5）**：用场景内 `NativeExecutionEnv` 子类注入 rename / 临时文件写入失败，证明折叠失败返回结构化 skipped（不抛）、**原文件逐字未变**、其后仍能正常 open 与读回；包含违反 FileSystem 不抛契约的 fileInfo throw，显式 fold 归一为 skipped/read-failed，open 兜底失败仍继续打开。若进程在折叠中途被杀会留下 `.tmp-` 残留：残留**不参与会话列举、不阻断 open**（实现没有残留回收）。② **地址不变性（X-1）**：折叠只删整行、保留行是原文子串 ⇒ 条目 id 与 seq 不变 ⇒ **折叠前发出的地址在折叠后逐字相同**，且仍能唯一命中；按 id 回读正文逐字相同。合成 toolResult 条目走真实提交路径（`branch.appendMessage`）而非手写 entry 行，省掉手工维护 seq 高水位的纪律",
      why: "折叠重写用户文件的两类致命失败：一是写坏了（中断），二是写对了但历史被改动（地址漂移、模型手里的回读地址失效）。这两条各自都能让「压缩只改变请求视图、原文条目始终保留」这条不变量名存实亡，故必须各有实测出口",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-session-log-fold-crash", "harness-session-log-fold-address", "harness-session-fold-throw-safe"],
    },
    {
      id: "hs-10",
      feature: "会话活动时间（列表排序口径的尾部读取）",
      description: "会话列表（标签条与历史面板）排序用的活动时间 = 正文里**最后一条 `role:\"user\"` 条目**的时间戳（`message.timestamp` 优先、回退条目级 timestamp，与读模型的展示时间同口径），其后的助手条目、主动消息与自定义/控制条目都不算；没有用户消息时 activityAt 为 null（列表按 createdAt 回退，同值按 id 升序稳定排列）。读取走**会话读的 tailBytes 尾部模式**（宿主 `session_read_text`：只读最后 N 字节、返回从行边界开始的整行文本；窗口不够按 4 倍扩大直到见到会话头），只扫文件尾部、从末尾向前找最后一条完整 user 条目 —— 不拿文件 mtime 当活动时间（折叠的纯删除式重写与重命名追加 `value` 行都会推进 mtime，但都不是用户活动）；同一会话上确认：重命名与关闭时折叠都不改变活动时间。L3 用例在真临时数据根 + 真 JSONL 上断言（宿主命令面由 `test/host/node-ipc.ts` 提供 tailBytes 等价实现；Rust 侧的字节裁剪与路径边界由 `session_fs.rs` 单测与 L4 覆盖，不在本点）",
      why: "文件 mtime 会被维护类写入（折叠、重命名）推进，把旧会话顶到列表顶部；活动时间必须从正文内容读，且读取要能只扫尾部窗口（整读会让每次列表刷新按会话体积付费）。尾部窗口的行边界语义错了会读不到或读错最后一条 user 条目 —— 用户看到的是列表排序与实际聊天次序不符（最近聊过的会话不在最前）",
      layer: "integration",
      depth: "shallow",
      scenarios: ["harness-session-activity-tail-read"],
    },
  ],
  // 存储失败/折叠注入失败已在 L3 的 hs-02/hs-08 验证；L4只保留需要真实Rust的生产正常链路。
  rules: {
    // W0–W7 把本契约迁出 L4 的场景按 L4 侧当前值重标定：门槛=当前 rules 声明值，
    // 只缩不放（数字由 checker 报错提供）；留在 L4 的为 hs-04 `harness-branch-tip-bypass`、
    // hs-06 `harness-frame-throttle-live`，迁出点（hs-01/02/03/05/07/08）
    // 由 L2/L3 承担，跨层完整性由 checkLayerCoverage 负责。
    minScenarios: 2,
    minDeepScenarios: 2,
    requireBoundary: true,
    requireErrorPath: false,
  },
}
