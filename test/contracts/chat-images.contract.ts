import type { ModuleContract } from "../host/types"
export const chatImagesContract: ModuleContract = {
  module: "chat-images",
  sourceFiles: [
    "src/services/images/index.ts", "src/services/images/paths.ts", "src/services/images/request.ts", "src/services/images/processor.ts", "src/services/images/limits.json",
    "src/services/images/budget.ts", "src/services/context/budget.ts",
    "src-tauri/src/commands/chat_images.rs", "src-tauri/src/commands/mod.rs", "src-tauri/src/lib.rs",
    "src/services/agent/runner.ts", "src/services/agent/types.ts", "src/services/engine/preprocessor.ts", "src/services/engine/runtime/input-identity.ts",
    "src/services/engine/harness/runtime.ts", "src/services/engine/harness/harness-slot.ts", "src/services/session/read-model.ts", "src/services/session/manager.ts", "src/components/ChatPanel.vue",
    "src/services/session/messages.ts", "src/services/tool/local/screenshot.ts", "src/services/tool/local/screenshot-details.ts", "src-tauri/src/commands/screenshot_cmd.rs",
  ],
  sourceHash: "eb67593114254185a30fd2f12f683c49e203a5f83955ab36823b419a96e49a16",
  coverage: [{ id: "ci-01", feature: "用户图片原路径整链", description: "原生常规图片准入最多4张/15MiB，图片-only输入提交后持久JSONL只存路径；模型请求临时读取真实图像，原文件删除后展示投影仍保留路径、请求明确缺失而无图像副本", why: "文本和UI缩略图不能证明模型收到了图像，也不能证明编码未进入JSONL", layer: "e2e", depth: "deep", scenarios: ["chat-image-path-production"] },
    { id: "ci-02", feature: "视觉预算与审计投影", description: "真实用户图像参与主请求与辅助请求的统一保守预算；base64长短不冒充语言token，完整图像内容仍进入仅hash审计投影", why: "图片预算为零会使上下文与主动持久额度准入失真，图像变化也不能得到相同审计内容", layer: "unit", depth: "deep", scenarios: ["chat-image-budget-content-hash"] },
    { id: "ci-03", feature: "截图展示给用户与隐私总闸", description: "screenshot 工具只在 ai.silentAccess.enabled 开启时可用：Rust capture_screenshot 复检同一开关（关闭即 Cancelled），前端命中时返回中性说明且不触达采集/落盘；show_to_user=true 时截图先经 save_screenshot 原子落盘（数据根 screenshots/，只保留最新 200 个）再挂到本回合提交的助手条目 deskpetImagePaths，读模型重载带回、原文件删除后仍保留路径（界面按不可用呈现）；show_to_user 缺省时不挂条目、结算不回传；工具结果对模型始终携带 PNG image 块", why: "「她给你看她看到的画面」要求条目与文件同源（先文件后条目、取消不产生半条消息），且隐私总闸关闭时不能截", layer: "integration", depth: "deep", scenarios: ["screenshot-show-to-user-attach", "screenshot-default-private", "screenshot-gate-neutral"] },
    { id: "ci-04", feature: "截图工具 details 形状契约", description: "screenshot 工具 details 的判定叶子：完整形状（screenshotPath + showToUser 布尔）放行、showToUser=false 同样放行；缺字段、错类型、空路径、非对象一律拒绝，多余键不透传", why: "工具结果 details 是运行内核与挂接点的唯一契约，形状判定必须严进严出而不是宽松吞掉异常输入", layer: "unit", depth: "shallow", scenarios: ["screenshot-details-tool-name", "screenshot-details-shape"] }],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}
