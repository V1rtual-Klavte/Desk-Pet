import type { ModuleContract } from "../host/types"
export const chatImagesContract: ModuleContract = {
  module: "chat-images",
  sourceFiles: [
    "src/services/images/index.ts", "src/services/images/paths.ts", "src/services/images/request.ts", "src/services/images/processor.ts", "src/services/images/limits.json",
    "src/services/images/budget.ts", "src/services/context/budget.ts",
    "src-tauri/src/commands/chat_images.rs", "src-tauri/src/commands/mod.rs", "src-tauri/src/lib.rs",
    "src/services/agent/runner.ts", "src/services/agent/types.ts", "src/services/engine/preprocessor.ts", "src/services/engine/runtime/input-identity.ts",
    "src/services/engine/harness/runtime.ts", "src/services/engine/harness/harness-slot.ts", "src/services/session/read-model.ts", "src/services/session/manager.ts", "src/components/ChatPanel.vue",
  ],
  sourceHash: "b2f56527889c75884120742dd6c7329c47774b40f98a5265a38086b3dde3b0db",
  coverage: [{ id: "ci-01", feature: "用户图片原路径整链", description: "原生常规图片准入最多4张/15MiB，图片-only输入提交后持久JSONL只存路径；模型请求临时读取真实图像，原文件删除后展示投影仍保留路径、请求明确缺失而无图像副本", why: "文本和UI缩略图不能证明模型收到了图像，也不能证明编码未进入JSONL", layer: "e2e", depth: "deep", scenarios: ["chat-image-path-production"] },
    { id: "ci-02", feature: "视觉预算与审计投影", description: "真实用户图像参与主请求与辅助请求的统一保守预算；base64长短不冒充语言token，完整图像内容仍进入仅hash审计投影", why: "图片预算为零会使上下文与主动持久额度准入失真，图像变化也不能得到相同审计内容", layer: "unit", depth: "deep", scenarios: ["chat-image-budget-content-hash"] }],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}
