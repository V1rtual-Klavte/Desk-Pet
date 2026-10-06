// 2026-10-05 设置页 Card 增删改查 + 模版批次：本契约 sourceFiles 中仅
// `crates/native-host/src/host/dispatch.rs` 变化 —— 新增一条 `personality_file_delete`
// 分派臂（命令矩阵 128→129），截图/图片命令的既有接线与错误语义未改。ci-01..ci-06
// 逐点复核行为面未变，仅按当前源码刷新 sourceHash。
// 2026-10-05 三批复查（本批刷新）：sourceFiles 变化 —— runtime.ts（RUNTIME_DATA 协议缺失
// 检测与提醒接线，与图片链路无交集）、crates/native-host/src/commands/mod.rs（仅命令域头注释
// 里的设计契约路径改指 history 归档，模块清单与 chat_images / screenshot_cmd 声明未动）。
// ci-01..ci-06 的准入、截图、预览与投影链路逐点核对覆盖描述与当前实现一致，未修订覆盖点，
// 仅按当前源码刷新 sourceHash。
// 2026-10-05 收尾复查（本批刷新）：sourceFiles 变化 —— runtime.ts（onUsage 展示统计口径改造：
// 主动表达回合不再刷新展示统计、真实 prompt 含缓存读写；与截图/图片命令、图像预算与投影
// 链路不相交）。ci-01..ci-06 逐点核对实现点仍在、覆盖描述与当前实现一致。本批刷新同时包含
// 另一会话的改动；本轮只做 coverage 描述与当前实现一致性核对（非逐行行为审计），未修订
// 覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 压缩拒绝留痕批次（本批刷新）：sourceFiles 变化 —— runtime.ts（createCompactionHook
// 新增 noteDecline：四个拒绝结局结构化留痕 + 统一日志）与 harness-slot.ts（compaction_end 按
// manual/overflow 落 deskpet.compaction_declined 条目、threshold 只留日志），与截图/图片命令、
// 图像预算与投影链路不相交。ci-01..ci-06 的准入、截图、预览与投影链路逐点核对实现点仍在、
// 覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-05 复算补充（同一刷新轮）：复算时并发落进一处本批改动单之外的 context/budget.ts
// 变化（keepRecentTokens 上限改为随窗口长大：max(MAX_HEADROOM, min(80k, 窗口 × 1/4))，小窗口
// 逐字不变；并发写入，不在本批改动单内）。按当前源码复算，sourceHash 一并覆盖它；
// ci-01..ci-06 无覆盖点描述 keepRecentTokens（图像预算走独立份额），逐点核对不受影响。
// 2026-10-05 频率档位收口波（analyze→generate）：ci-03 描述订正 —— 截图工具的隐私总闸已从
// `ai.silentAccess.enabled` 改为 `ai.silentAccess.frequency`（off 即关闭，档位非 off 放行；
// 前端闸门见 src/services/tool/local/screenshot.ts，Rust capture_screenshot 复检同档）。
// ci-01..ci-06 其余点按当前源码复核未变，sourceHash 按当前源码复算。
// 2026-10-06 聊天图片批次（analyze→generate）：sourceFiles 变化 ——
// `crates/native-host/src/commands/chat_images.rs`（新增命令 chat_delete_session_images：
// 删会话连带清理托管聊天图片，只删托管根内的常规文件）、
// `crates/native-host/src/commands/screenshot_cmd.rs`（新增 PASTED_DIR 与
// managed_chat_image_dirs（托管根的唯一枚举点）；落盘/授权/保留三步收口为
// save_managed_image，截图与粘贴共用）、`crates/native-host/src/host/dispatch.rs`
// （新分派臂，命令矩阵 134→135）、`src/services/session/manager.ts`（deleteSession 成功后
// 收集条目图片路径、去重后交宿主清理；失败只留痕）、`src/services/host/types.ts`
// （新命令类型形状）、`crates/native-host/src/ui/chat/paste.rs`（新增：剪贴板粘贴落盘入口，
// sourceFiles 补入）。新增 ci-07（integration）：删会话清理托管聊天图片，登记
// session-delete-images-call / -empty / -failure 三个 caseId（此前无契约引用，全量
// integration 判 ORPHAN）。ci-01..ci-06 逐点核对实现点仍在、覆盖描述与当前实现一致；
// sourceHash 按当前源码复算。
// 2026-10-06 粘贴准入口径修正（analyze→generate）：sourceFiles 中仅
// `crates/native-host/src/ui/chat/paste.rs` 变化 —— 同步准入段抽为 `admit_paste_request`，
// 单张上限（15 MiB）改为只作用于**最终落盘字节**（`prepare_payload`），原始剪贴板载荷
// 另设 64 MiB 的防御守卫（`admit_raw_payload`）。原实现拿原始长度卡 15 MiB，会误杀
// 最常见的「粘贴一张截图」：Windows 的 CF_DIB 一张 4K 屏 ≈33 MB、macOS 的 TIFF 数十 MB，
// 转成 PNG 后往往只有几 MB（跨平台接线时发现）。新增两条 Rust 单测
// （`sync_admission_does_not_gate_on_raw_size` / `raw_payload_guard_only_bounds_the_clipboard_blob`），
// 并做过「退回修复看它红」的区分力演练。粘贴路径在 ci-07 的说明里本就注明由 Rust 单测
// 背书、不登记三层 caseId；ci-01..ci-07 覆盖描述经核对仍准确，sourceHash 按当前源码复算。
// 2026-10-06 子运行接线修复批次（本批刷新）：sourceFiles 变化 ——
// src/services/engine/harness/runtime.ts（createTurnSpec 补转发 providerAdmission /
// disableAutomaticCompaction；createTurnSinks 增 visible 形参：子运行不外推过程消息、工具结果
// 与流式草稿）。ci-01..ci-07 逐点核对：图片投影与截图/删会话清理链都走主回合口径，不经子运行
// sinks 或子运行 provider 准入，覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 估算偏差口径修正批次（本批刷新）：sourceFiles 变化 ——
// src/services/context/budget.ts（新增 totalInputTokens 纯函数）与
// src/services/engine/harness/runtime.ts（估算偏差对账口径；图像预算走独立份额，不受影响）。
// ci-01..ci-07 覆盖描述与当前实现一致，未修订覆盖点，仅按当前源码刷新 sourceHash。
// 2026-10-06 回合治理与图片生命周期批次（analyze→generate）：sourceFiles 变化 ——
// `crates/native-host/src/ui/chat/placeholders.rs` / `model.rs` / `ui.rs` 补入（粘贴草稿的
// 托管生命周期：`ImagePlaceholder.managed` 标记、`PendingDraftRelease::{Send,Discard}`
// 参数化清空、撤选即删单张、退出回滚入口 `rollback_pending_draft` 挂在 main.rs:436 的
// ServiceExitHook 第一步 —— 两平台 quit() 的 UI/supervisor teardown 都在其后，挂点不上移）；
// `crates/native-host/src/commands/screenshot_cmd.rs`（删 SCREENSHOT_RETENTION 与
// prune_managed_images：落盘不再有 200 张淘汰，删会话清理不依赖 prune）、
// `src/services/tool/local/screenshot.ts`（show_to_user≠true 不再调用 save_screenshot、
// details 两态）、`src/services/tool/local/screenshot-details.ts`（写入方两态契约文档；
// 读取器实现未变，合法 false 形态仍放行）、`src/services/session/manager.ts`（清理失败
// 注释口径：没有目录级兜底淘汰）。
// ci-03 描述修订：取消「只保留最新 200 个」、补「私有截图不落盘、details 无 screenshotPath」；
// ci-07 描述修订：删「200 上限兜底淘汰」，改为「残留不再自动淘汰、由用户手动删除」；
// 2026-10-06 dreaming 日 token 闸撤除批次（本批刷新）：sourceFiles 变化 ——
// crates/native-host/src/host/dispatch.rs（memory_dreaming_budget_reserve 分派臂去 dailyLimit、
// 响应改 null：dreaming 日 token 上限不再作门禁，预留只记账）。本契约覆盖点不在改动面内，
// 未修订；本批刷新同时包含工作树中其它并发改动的源文件（非逐行行为审计），sourceHash 按当前
// 源码复算。
import type { ModuleContract } from "../host/types"
export const chatImagesContract: ModuleContract = {
  module: "chat-images",
  sourceFiles: [
    "src/services/images/index.ts", "src/services/images/paths.ts", "src/services/images/request.ts", "src/services/images/processor.ts", "src/services/images/limits.json",
    "src/services/images/budget.ts", "src/services/context/budget.ts",
    "crates/native-host/src/commands/chat_images.rs", "crates/native-host/src/commands/mod.rs", "crates/native-host/src/host/dispatch.rs",
    "src/services/agent/runner.ts", "src/services/agent/types.ts", "src/services/engine/preprocessor.ts", "src/services/engine/runtime/input-identity.ts",
    "src/services/engine/harness/runtime.ts", "src/services/engine/harness/harness-slot.ts", "src/services/session/read-model.ts", "src/services/session/manager.ts", "crates/native-host/src/images/inline.rs",
    "src/services/session/messages.ts", "src/services/tool/local/screenshot.ts", "src/services/tool/local/screenshot-details.ts", "crates/native-host/src/commands/screenshot_cmd.rs",
    // 2026-10-06 粘贴落盘入口（剪贴板 → pasted/ → 待发送区）补入：它是聊天图片的第三条
    // 通路（文件选择器 / 拖入 / 粘贴），pasted/ 与 screenshots/ 同属 ci-07 的托管根；
    // 转码与落盘基础件（images/format.rs 的 sniff_paste、images/decode.rs 的
    // decode_transcode_source、screenshot_cmd.rs 的 save_managed_image）由 Rust 单测背书，
    // 与 images/inline.rs 同口径不进三层 caseId 账。
    "crates/native-host/src/ui/chat/paste.rs",
    // 2026-10-06 托管图片生命周期批次补入（粘贴草稿的丢弃/回滚都定义在这三个文件里）：
    // placeholders.rs（managed 标记 + discard_managed_files 丢弃语义唯一实现点）、
    // model.rs（PendingDraftRelease::{Send,Discard} 参数化清空、remove_pending_image 撤选删单张）、
    // ui.rs（add_managed_pending_images 打标入口、rollback_pending_draft 退出回滚）。
    // 三者行为均由 Rust 内联单测背书（无 caseId，与 paste.rs 同口径）。
    "crates/native-host/src/ui/chat/placeholders.rs",
    "crates/native-host/src/ui/chat/model.rs",
    "crates/native-host/src/ui/chat/ui.rs",
  ],
  sourceHash: "6ebd9dc595b02ea95cd2e11c9afdff214f482b6d57cf72d86da78d786b9c1f28",
  coverage: [{ id: "ci-01", feature: "用户图片原路径整链", description: "原生常规图片准入最多4张/15MiB，图片-only输入提交后持久JSONL只存路径；模型请求临时读取真实图像，原文件删除后展示投影仍保留路径、请求明确缺失而无图像副本", why: "文本和UI缩略图不能证明模型收到了图像，也不能证明编码未进入JSONL", layer: "e2e", depth: "deep", scenarios: ["chat-image-path-production"] },
    { id: "ci-02", feature: "视觉预算与审计投影", description: "真实用户图像参与主请求与辅助请求的统一保守预算；base64长短不冒充语言token，完整图像内容仍进入仅hash审计投影", why: "图片预算为零会使上下文与主动持久额度准入失真，图像变化也不能得到相同审计内容", layer: "unit", depth: "deep", scenarios: ["chat-image-budget-content-hash"] },
    { id: "ci-03", feature: "截图展示给用户与隐私总闸", description: "screenshot 工具只在 ai.silentAccess.frequency 非 off（低/中/高档）时可用：Rust capture_screenshot 复检同一档位（off 即 Cancelled），前端命中时返回中性说明且不触达采集/落盘；show_to_user=true 时截图先经 save_screenshot 原子落盘（数据根 screenshots/；2026-10-06 取消 200 张保留上限，落盘文件不再被淘汰，回收只有删会话连带清理与用户手动删除）再挂到本回合提交的助手条目 deskpetImagePaths，读模型重载带回、原文件删除后仍保留路径（界面按不可用呈现）；show_to_user 缺省/false 时不落盘（不调用 save_screenshot、数据根不产生文件），工具结果 details 只有 showToUser、不带 screenshotPath，不挂条目、结算不回传；工具结果对模型始终携带 PNG image 块（私有截图模型照常看得见内嵌图片）", why: "「她给你看她看到的画面」要求条目与文件同源（先文件后条目、取消不产生半条消息），且隐私档位为 off 时不能截；私有截图不该在数据根留下用户没要展示的文件", layer: "integration", depth: "deep", scenarios: ["screenshot-show-to-user-attach", "screenshot-default-private", "screenshot-gate-neutral"] },
    { id: "ci-04", feature: "截图工具 details 形状契约", description: "screenshot 工具 details 的判定叶子：完整形状（screenshotPath + showToUser 布尔）放行、showToUser=false 同样放行；缺字段、错类型、空路径、非对象一律拒绝，多余键不透传", why: "工具结果 details 是运行内核与挂接点的唯一契约，形状判定必须严进严出而不是宽松吞掉异常输入", layer: "unit", depth: "shallow", scenarios: ["screenshot-details-tool-name", "screenshot-details-shape"] },
    // W7b 聊天图片自动预览开关：宿主侧生命周期（关闭占位零预读 / 开启只按可见加载 /
    // 关闭释放且晚到结果按 owner+viewGeneration 丢弃 / 查看器独立）由
    // crates/native-host/src/images/inline.rs 的 Rust 单测覆盖（cargo test --lib -p native-host，
    // 不进三层 caseId 账）；真实原生聊天窗的 L4 场景随 W8a/W11 的原生 UI 测试驱动落地后再补 coverage。
    { id: "ci-05", feature: "聊天图片自动预览开关配置面", description: "唯一字段 appearance.chatImagePreview 默认 false：字段缺省（未提供该可选字段）按唯一默认值读取、显式的 true/false 原样成立；设置页保存路径（setOverride → 同一 cfg → queueConfigSave）写回后 getter 立即读到新值，面板不复制默认值", why: "默认关闭与单一读取入口是「历史只显示占位、占位零预读」的前提；默认值或读取键漂移会让默认体验静默变成读图", layer: "unit", depth: "shallow", scenarios: ["chat-image-preview-config-default", "chat-image-preview-save-immediate"] },
    { id: "ci-06", feature: "自动预览开关不改变模型请求投影与持久形态", description: "开关开/关下 hydrateImageMessages 都从原路径读出真实图像 part（同一缩放/编码处理器与失败回退语义），投影不改写原消息、不向消息对象加图像数据；JSONL 原路径（deskpetImagePaths）持久形态与该字段无关", why: "开关只控制聊天历史的内联呈现，绝不能缩水模型看图或把图像编码塞进会话正文", layer: "integration", depth: "deep", scenarios: ["chat-image-preview-request-projection-independent"] },
    // 2026-10-06 删会话清理托管聊天图片（新增 ci-07，integration）：本条覆盖 Node 侧
    // 的三段行为（收集去重 → 命令调用 → 空集/失败边界），真临时数据根 + 真 JSONL 会话文件。
    // **包含判定与删除行为由 Rust 单测背书**：只删 screenshots/ 与 pasted/ 托管根内的常规文件，
    // 根外路径（用户原图）、目录、符号链接（含指向根内的）与已不存在的文件一律 skipped，
    // 单条失败不影响其它（crates/native-host/src/commands/chat_images.rs 的 tests），
    // 与 images/inline.rs 同口径不进三层 caseId 账。粘贴入口（ui/chat/paste.rs）的
    // 落盘/转码/待发送区同样只有 Rust 单测背书（无 caseId），故不为它登记覆盖点，
    // 只把文件纳入 sourceFiles。
    // 2026-10-06 托管图片生命周期批次补记：粘贴草稿「未发送即丢弃」的三种触发（撤选删单张、
    // 切会话、退出回滚）与「发送只清列表不删文件」的区分由 `PendingDraftRelease::{Send,Discard}`
    // 在类型上承载，行为由 placeholders.rs / model.rs / ui.rs 的 Rust 单测背书（managed 项才删、
    // 用户自有文件一律不删；无 caseId，故不登记覆盖点，文件已纳入 sourceFiles）。
    { id: "ci-07", feature: "删会话清理托管聊天图片", description: "删会话成功后，从该会话全部 message 条目收集图片路径（跨条目重复引用去重成一个集合）交给宿主命令 chat_delete_session_images：恰好一次调用，载荷同时含托管图片（screenshots/、pasted/）与条目里只存路径的用户原图 —— 两类都如实交出，删不删由 Rust 按托管根包含判定（Node 侧不删任何文件，含已删除会话的托管图片文件仍原样存在）；条目里没有任何图片路径时不调用宿主（不产生空请求）；宿主清理失败只留痕，deleteSession 照常返回 true（2026-10-06 取消 200 张保留上限后残留不再自动淘汰，留在目录中由用户手动删除）", why: "删会话是用户可见的破坏动作：漏清托管图片会让数据根累积无人引用的截图/粘贴图（没有别的回收点），而越界删除（用户原图）或把失败伪装成成功是不可逆的数据损失；去重收集、空集不调用与失败不改返回三条边界各自有独立用例实测，包含判定则必须由 Rust 侧负向断言（根外不删）背书", layer: "integration", depth: "deep", scenarios: ["session-delete-images-call", "session-delete-images-empty", "session-delete-images-failure"] }],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}
