import type { ModuleContract } from "../types"

export const toolExecutionContract: ModuleContract = {
  module: "tool-execution",
  sourceFiles: [
    "src/services/engine/pi/runtime.ts",
    "src/services/tool/router.ts",
    "src/services/tool/session-transcript.ts",
    "src/services/context/tool-output.ts",
    "src/services/tool/registry.ts",
    "src/services/tool/local/pi-tools.ts",
    "src/services/tool/pi/harness-adapter.ts",
    "src/services/tool/pi/tauri-execution-env.ts",
    "src/services/safety/checker.ts",
    "src/services/reply/generator.ts",
    "src/services/engine/pi/net-guard.ts",
    "src/services/engine/pi/model-gateway.ts",
    "src/services/skill/loader.ts",
    "src-tauri/src/commands/skill_cmd.rs",
    "src/services/tool/mcp/manager.ts",
  ],
  generatedAt: "2026-09-17",
  sourceHash: "ccfacf64ee490a310a380526315eada118e3f3518a5b20077ad36689862edd15",
  coverage: [
    { id: "te-13", feature: "工具结果持久化与回读", description: "生产工具配对作为会话条目持久化，完整工具文本保留（L0只改请求视图），read_session_event 按条目 id 分页回读并限定当前 session", why: "短请求不能以丢失工具证据为代价", depth: "deep", scenarios: ["tool-transcript-recovery"] },
    { id: "te-08", feature: "真 LLM 多工具调用", description: "真实 LLM 对话中先后调用多个工具", why: "端到端工具链验证", depth: "deep", scenarios: ["tool-system-info"] },
    { id: "te-09", feature: "Provider 网络边界", description: "Provider 固定用户配置的 origin，拒绝 host/scheme/port 漂移并禁止重定向携带认证；显式 localhost/provider 可用，响应按流限额", why: "避免网络策略绕过和内存失控", depth: "shallow", scenarios: ["tool-provider-network-boundary"] },
    { id: "te-10", feature: "工具取消错误码", description: "已取消的工具调用不进入 handler 且返回稳定错误码", why: "取消必须可观测且不可产生副作用", depth: "shallow", scenarios: ["tool-cancelled"] },
    { id: "te-11", feature: "Skill 元数据渐进加载", description: "catalog 只保留有界 frontmatter 元数据，正文不进缓存或 prompt；pet/assistant 按 invocationPolicy 筛选", why: "启动和首回合不能加载全部 Skill 正文，同时轻量模式只暴露明确声明的能力", depth: "deep", scenarios: ["tool-skill-metadata-progressive"] },
    { id: "te-12", feature: "Skill catalog 失效", description: "保存覆盖和删除 Skill 后，catalog 重新读取元数据真相源，不保留旧描述或已删除条目", why: "metadata cache 有界也必须随版本变化失效，避免向模型暴露不存在的能力", depth: "shallow", scenarios: ["tool-skill-catalog-invalidation"] },
    { id: "te-14", feature: "MCP 配置字段保留", description: "编辑内置 MCP 的常规字段时保留 includeTools/excludeTools，避免工具暴露范围静默扩大", why: "过滤规则是能力边界，设置页只编辑 args/env 不能抹掉源配置", depth: "shallow", scenarios: ["tool-mcp-config-preserve"] },
  ],
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: false, requireErrorPath: false },
}
