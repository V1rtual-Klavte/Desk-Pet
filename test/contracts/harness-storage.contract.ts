import type { ModuleContract } from "../host/types"

export const harnessStorageContract: ModuleContract = {
  module: "harness-storage",
  sourceFiles: [
    "src/services/engine/pi/session-repo.ts",
    "src/services/engine/pi/session-frame-buffer.ts",
    "src/services/engine/pi/session-fold.ts",
    "src/services/tool/pi/tauri-execution-env.ts",
    "src/services/session/repo.ts",
  ],
  generatedAt: "2026-09-28",
  sourceHash: "5b9c125fa904153924b2cfd0864cef23e06e62c65a36e54bde3b80e98d7f1028",
  coverage: [
    {
      id: "hs-01",
      feature: "JsonlSessionRepo 官方一致性",
      description: "官方一致性套件 17 条 case 里取 15 条（lifecycle 4 / ownership 1 / messages 2 / fork 行为 7 / fork 源快照 1）在 TauriExecutionEnv（真实 Rust IPC）上通过：创建、列举、删除、独占打开、消息持久化、fork；fork destination reservation 组（2 条「先调用者先占位」）整体不纳入：其中「先 fork 后 create」一条依赖占位时序，在官方 NodeExecutionEnv（node:fs）上同样稳定失败（2026-09-24 复核：17 条里 16 过、1 败且败的正是该条）—— 上游 `JsonlSessionRepo.fork` 在占位前多一次 `captureForkSource` await，create 因此确定性地先占住目标 id，不是偶发抖动。本覆盖点是 H-1 的存储层边界：只验证存储实现，不经过模型；生产入口的写入路径由 hs-04 承接",
      why: "H-1 用官方协议验证存储实现，重启恢复与 fork 语义不靠自造断言",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-session-repo-conformance"],
    },
    {
      id: "hs-02",
      feature: "TauriExecutionEnv FileSystem 补全",
      description: "readTextFile/writeFile/appendFile/renameFile/createDir/remove/createTempDir/listDir 经真实 Rust 命令完成且不 throw（失败以 Result 返回）；失败按 Rust 结构化错误码归类而不是拿 message 猜，但**本点（L3 用例）背书的只有两条**：PATH_NOT_FOUND→not_found 与未列出的码（以 TOOL 实测）如实保持 unknown —— **SENSITIVE_PATH / PATH_ESCAPE→permission_denied 与 NOT_ABSOLUTE→invalid 依赖 Rust 侧路径裁决**，`test/host/node-ipc.ts` 按设计只实现机制、不做路径裁决（实测 `.ssh/probe` 落成 not_found、相对路径写入直接成功），Node 侧无法复现，**这 2 条属 L4**（production 批次另立出口），本点不声称覆盖；rename 原子替换已存在目标；remove 遵守 recursive/force（force 时缺失算成功，目录需 recursive）；createDir 默认递归；listDir 直接返回绝对 path、size、mtimeMs 与 file/directory/symlink 三值 kind。构造签名是 new TauriExecutionEnv(cwd)（模式参数已删，决策 5）。所有读写都下发 MAX_TOOL_FILE_BYTES = 5 MB 的硬上限（readTextFile/readBinaryFile 的读上限，writeFile/file_append 的单次写上限）—— 它是会话条目写盘的**唯一物理上限**，MCP 的一次性截断删除后大结果全靠它兜底：超限时 Rust 如实报错、**不做静默截断**（§8.8 的裁定。注：正好超限被拒这条边界未由本点的场景断言）。该常量的唯一定义点就在 `tool/pi/tauri-execution-env.ts`，`engine/pi/session-fold.ts` 的折叠尺寸守卫读同一份，不另存一份",
      why: "JsonlSessionRepo 的原子发布依赖 append+rename，list 依赖完整 FileInfo 字段，能力缺口会让会话无法落盘或无法恢复；错误码是调用方唯一的分类依据，文案随实现漂移",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-execution-env-filetree"],
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
      description: "阻塞工具期间经 session/repo 的旁路入口写入自定义条目，按 2026-09-24 两轮实测钉住它回合结束后的归宿：条目在会话文件中可读、其 seq 早于收尾后的 tip，但**不在** lane 分支的 tip 链上 —— Harness 的提交面按内存 `state.tipId` 续写并覆盖 `branch.tip`，把旁路条目挤成孤立分支（两轮实测链上都查不到旁路 id，前后写入的条目都在）。这是已登记的会话层限制（修法归 session 层，不在本波范围）：断言钉的是真实现状并当回归守卫 —— 将来旁路条目回到链上时场景会失败并要求更新登记",
      why: "lane 的 tip 缓存若按旧 tip 续写，旁路写入的审计条目会静默从证据链里消失（条目还在文件里，却不在 tip 回溯链上）——本覆盖点就是这条风险的实测出口",
      layer: "e2e",
      depth: "deep",
      scenarios: ["harness-branch-tip-bypass"],
    },
    {
      id: "hs-05",
      feature: "帧写入合并与触发时机",
      description: "帧写入缓冲装饰器（session-frame-buffer.ts）在真实 commit 路径上的五种行为：① 合并——200 条真实帧 append（thinking_delta，单条约 370 B）的底层 appendFile 调用数 ≤ ⌈实收字节/16 KiB⌉+1 且 ≥1（合并率 50× 量级），会话读路径按序读回 200 条内容逐项一致；② 非帧写入永远立即落盘——流式中以 value/set 收尾时先冲干净同路径缓冲再转发，未包装的 env 直读原始文件同刻能看到该 value/set 行与全部缓冲帧（帧行排在其前）；③ 读前 flush——装饰器读同一路径前先落缓冲，且底层调用顺序是 appendFile→readTextFile（顺序证据）；④ 关闭前 flush——会话句柄释放（releasePiSession）经模块级 flushSessionFrameWrites 把残留帧落盘，文件末行即最后一条帧；⑤ 失败留痕——注入落盘失败时经 logger（通道 `FrameBuffer`）的 error 级留痕（logger 的 error 无条件走 `console.error`，场景据此捕获）含 FRAME_FLUSH_FAILURE_MARK、缓冲被丢弃（不重试、失败批不重放）、下一批只带自己那一帧。另有 FIFO 逐字节等价（推入内容与底层实收拼接相等）、体积阈值触发（未达阈值不落盘 / 跨阈值整批落盘一次）与 O-9 旁路（关闭合并后 8 帧 → 8 次 appendFile，同一批字节走合并路径后调用数更少而字节流与直写逐字节相等）。判别一律用生产判别器 isFrameAppendTransaction（解析后要求恰好单写 + kind/op/namespace 三字段），不用子串匹配。**未覆盖**：真实流式回合下的帧数与读回归属 hs-06；应用级强制退出（托盘 app.exit）不在此口径内——「退出前」= 会话句柄关闭前",
      why: "帧是每个流式 delta 一行的进度快照，基线实测 124.8 次/秒写盘；合并若漏（不合并/丢帧/顺序错乱）或非帧写入被推迟，轻则磁盘抖动重则正文 entry 持久性受影响；失败若静默（上游 progress.js 把帧写失败吞掉）或重试重放，会既无痕迹又无界增长。本覆盖点是 T-1..T-6 的唯一机制出口，O-9 开关「写反或恒真」也由它的旁路 check 挡住",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-frame-write-buffer"],
    },
    {
      id: "hs-06",
      feature: "真实流式回合下的帧落盘与重放读回",
      description: "production 入口（经 sendMessage 走 fake Provider 的真实流式链路）跑完整一回合后，从**未包装**的 TauriExecutionEnv 直读会话 JSONL 原始文件：① 该回合的帧 append 数 ≥ 100（fakeText 约 4000 字符按 faux 的字符分片估算 ≈ 250 条，注释写明是估算、断言按下限）、存在 text_delta 帧、按 seq 升序拼接所有 delta 后**包含**唯一哨兵（内容与顺序的正面证据；不要求与输入整段相等，宿主可能有投影/过滤）；② 本回合 assistant entry 的 seq 大于该帧组内全部 append 的 seq，且该 entry 行确实在盘上 —— 证明「帧在缓冲里 → 一次非帧 entry 提交把缓冲冲干净并立即落盘」（T-3 的真实链路侧）；③ 把**终局 delete 之前**的真实字节截成快照喂给新的仓库实例，`list()`/`open()`/`readList(order:\"asc\")` 逐项断言帧数、seq 与 value 与 ① 相等（T-4：重放读回不回归）。**③ 的口径必须按实测**：上游在回合收尾的多写事务里对帧列表发 `list/delete`（`drive/terminal.js` 的 operationCleanupWrites，参考会话 9/9 组都有、且与 assistant entry/usage/branch tip 同一行），因此**回合结束后从实时数据根 `readList` 返回 0 条**——本覆盖点证明的是「帧确实落盘且可被重放读回」，**不是**「回合结束后仍可从 readList 读回帧」。本场景补的空白：hs-05 证明机制与调用次数（可注入计数 env），本场景证明真实链路只证内容与顺序、不证调用次数（应用单例 repo 无法注入计数器）",
      why: "hs-05 用可注入的计数 env 钉住机制，但注入路径与生产单例仓库不是同一对象；真实流式链路若在接线处退化（例如装饰器没包上生产路径、或非帧提交不再触发 flush），只有本覆盖点能在没有计数器的情况下用「内容 + 顺序 + 重放读回」把它抓出来",
      layer: "e2e",
      depth: "deep",
      scenarios: ["harness-frame-throttle-live"],
    },
    {
      id: "hs-07",
      feature: "会话日志折叠的正确性（纯删除式回收）",
      description: "在临时会话根上跑一次**真实折叠**（真仓库提交造条目 + raw append 造帧的夹具），逐条钉住：① 已 delete 的 key 的全部 append/set 行被删（`list/append` 与 `value/set`，行号**严格小于**该 key 最后一次对应 `delete` 的行号；delete 行自身与其后的写入一律保留）；② **保留行必须是原文子串**（折叠只做行级纯删除，不重编号、不重写任何保留行、不重新序列化，且整行粒度 —— 一行里只要有一个保留写入就整行原样留下）；③ 折叠前后 `logStateDigest()` **逐字相同**（= `sha256Text(stableSerialize(replayLogState(log)))`；S-1：摘要只依赖逻辑状态，不含行序/字节数/时间戳）；④ 折叠后文件仍可被上游重放读回；⑤ **幂等**——折叠结果再折叠不再有可回收行；⑥ **版本白名单降级（S-6）**——header 不是 v4 + `storageVersion: 1`（`JSONL_STORAGE_VERSION`）时 `skip(\"unknown-format\")`、原文件逐字未动，`storageVersion` 变值与 `v: 3` 两个变体各验一遍（探针文件必须先超闸门 1，否则断言会退化成闸门 1）。夹具的字节/字符比经离线实跑量测（1.809）后定阈值，不按估算写。折叠驱动 `foldSessionFile` 的判定顺序写死（**先判定后动盘**）：闸门 1（`fileInfo().size <= minFileBytes`，只看不读）→ 尺寸守卫（超 `MAX_TOOL_FILE_BYTES` 不读）→ 读一次全文 → 白名单判定 → 闸门 2（`minReclaimBytes` 与 `minReclaimRatio` 字节口径 AND）→ 结果尺寸守卫 → 先算两侧摘要再写。触发挂点（**未由本点场景断言**——本点直接驱动 `foldSession`）：`releasePiSession` 的 `try/catch/finally` **整体之后**（主路径：先 `close`、再冲帧缓冲、最后折叠）与 `open` 前按需兜底（`maybeFoldBeforeOpen`，仅当文件超 `minFileBytes` 才真的折叠，常态只花一次 stat）；两处失败都只留痕，不影响会话功能。**未覆盖**：中断安全与地址交界属 hs-08；上游 `JsonlStorage.open` 的正面确认属 hs-01 —— 本点对 raw 行的上游合法性只有「seq 严格递增 + 重放不抛」两条侧证",
      why: "折叠是这个批次里唯一**重写用户文件**的动作，一旦保留行被重写或逻辑状态被改动，损害是不可逆的（会话历史被静默篡改）。本覆盖点是 S-1..S-4/S-6 的唯一出口：它同时证明「回收真的发生」与「除了该删的行，一个字节都没动」",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-session-log-fold"],
    },
    {
      id: "hs-08",
      feature: "折叠的中断安全与地址不变性",
      description: "两条互补路径。① **中断安全（S-5）**：用场景内 `TauriExecutionEnv` 子类注入 rename / 临时文件写入失败，证明折叠**任何一步失败都返回结构化 skipped/write-failed**（不抛）、**原文件逐字未变**、其后仍能正常 open 与读回 —— 原子替换的语义是「要么整份换掉，要么一点都不动」。若进程在折叠中途被杀会留下 `.tmp-` 残留：残留**不参与会话列举、不阻断 open**（**不是**「下一次折叠会清掉残留」—— 实现没有残留回收，这条按方案自己的契约描述收窄）。② **地址不变性（X-1）**：折叠只删整行、保留行是原文子串 ⇒ 条目 id 与 seq 不变 ⇒ **折叠前发出的地址（条目 id 的唯一前缀）在折叠后逐字相同**，且仍能在折叠后的 id 全集里唯一命中；按 id 回读正文逐字相同。合成 toolResult 条目走真实提交路径（`branch.appendMessage`）而非手写 entry 行，省掉手工维护 seq 高水位的纪律",
      why: "折叠重写用户文件的两类致命失败：一是写坏了（中断），二是写对了但历史被改动（地址漂移、模型手里的回读地址失效）。这两条各自都能让「压缩只改变请求视图、原文条目始终保留」这条不变量名存实亡，故必须各有实测出口",
      layer: "integration",
      depth: "deep",
      scenarios: ["harness-session-log-fold-crash", "harness-session-log-fold-address"],
    },
  ],
  rules: {
    // W0–W7 把 7 个场景迁出 L4 后按 L4 侧当前值重标定：2 = 本契约 e2e 层有效场景数
    // （hs-04 `harness-branch-tip-bypass`、hs-06 `harness-frame-throttle-live`），
    // 2 = 其中 deep 数（门槛=当前值，一个都不许掉）；迁出的 7 个（hs-01/02/03/05/07/08
    // 的 7 个 caseId）由 L2/L3 承担，跨层完整性由 checkLayerCoverage 负责。
    minScenarios: 2,
    minDeepScenarios: 2,
    requireBoundary: true,
    requireErrorPath: true,
  },
}
