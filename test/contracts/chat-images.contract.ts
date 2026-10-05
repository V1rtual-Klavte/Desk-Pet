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
  ],
  sourceHash: "15ec4be2941253dc1830f7e1bff59439dd154341b57a79daed3670c13c376998",
  coverage: [{ id: "ci-01", feature: "用户图片原路径整链", description: "原生常规图片准入最多4张/15MiB，图片-only输入提交后持久JSONL只存路径；模型请求临时读取真实图像，原文件删除后展示投影仍保留路径、请求明确缺失而无图像副本", why: "文本和UI缩略图不能证明模型收到了图像，也不能证明编码未进入JSONL", layer: "e2e", depth: "deep", scenarios: ["chat-image-path-production"] },
    { id: "ci-02", feature: "视觉预算与审计投影", description: "真实用户图像参与主请求与辅助请求的统一保守预算；base64长短不冒充语言token，完整图像内容仍进入仅hash审计投影", why: "图片预算为零会使上下文与主动持久额度准入失真，图像变化也不能得到相同审计内容", layer: "unit", depth: "deep", scenarios: ["chat-image-budget-content-hash"] },
    { id: "ci-03", feature: "截图展示给用户与隐私总闸", description: "screenshot 工具只在 ai.silentAccess.enabled 开启时可用：Rust capture_screenshot 复检同一开关（关闭即 Cancelled），前端命中时返回中性说明且不触达采集/落盘；show_to_user=true 时截图先经 save_screenshot 原子落盘（数据根 screenshots/，只保留最新 200 个）再挂到本回合提交的助手条目 deskpetImagePaths，读模型重载带回、原文件删除后仍保留路径（界面按不可用呈现）；show_to_user 缺省时不挂条目、结算不回传；工具结果对模型始终携带 PNG image 块", why: "「她给你看她看到的画面」要求条目与文件同源（先文件后条目、取消不产生半条消息），且隐私总闸关闭时不能截", layer: "integration", depth: "deep", scenarios: ["screenshot-show-to-user-attach", "screenshot-default-private", "screenshot-gate-neutral"] },
    { id: "ci-04", feature: "截图工具 details 形状契约", description: "screenshot 工具 details 的判定叶子：完整形状（screenshotPath + showToUser 布尔）放行、showToUser=false 同样放行；缺字段、错类型、空路径、非对象一律拒绝，多余键不透传", why: "工具结果 details 是运行内核与挂接点的唯一契约，形状判定必须严进严出而不是宽松吞掉异常输入", layer: "unit", depth: "shallow", scenarios: ["screenshot-details-tool-name", "screenshot-details-shape"] },
    // W7b 聊天图片自动预览开关：宿主侧生命周期（关闭占位零预读 / 开启只按可见加载 /
    // 关闭释放且晚到结果按 owner+viewGeneration 丢弃 / 查看器独立）由
    // crates/native-host/src/images/inline.rs 的 Rust 单测覆盖（cargo test --lib -p native-host，
    // 不进三层 caseId 账）；真实原生聊天窗的 L4 场景随 W8a/W11 的原生 UI 测试驱动落地后再补 coverage。
    { id: "ci-05", feature: "聊天图片自动预览开关配置面", description: "唯一字段 appearance.chatImagePreview 默认 false：字段缺省（未提供该可选字段）按唯一默认值读取、显式的 true/false 原样成立；设置页保存路径（setOverride → 同一 cfg → queueConfigSave）写回后 getter 立即读到新值，面板不复制默认值", why: "默认关闭与单一读取入口是「历史只显示占位、占位零预读」的前提；默认值或读取键漂移会让默认体验静默变成读图", layer: "unit", depth: "shallow", scenarios: ["chat-image-preview-config-default", "chat-image-preview-save-immediate"] },
    { id: "ci-06", feature: "自动预览开关不改变模型请求投影与持久形态", description: "开关开/关下 hydrateImageMessages 都从原路径读出真实图像 part（同一缩放/编码处理器与失败回退语义），投影不改写原消息、不向消息对象加图像数据；JSONL 原路径（deskpetImagePaths）持久形态与该字段无关", why: "开关只控制聊天历史的内联呈现，绝不能缩水模型看图或把图像编码塞进会话正文", layer: "integration", depth: "deep", scenarios: ["chat-image-preview-request-projection-independent"] }],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}
