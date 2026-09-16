import type { ModuleContract } from "../types"

export const personalityCardContract: ModuleContract = {
  module: "personality-card",
  sourceFiles: ["src/services/personality/registry.ts", "src/services/personality/loader.ts"],
  generatedAt: "2026-09-14",
  sourceHash: "0263716ed09aee786c57c8ec3f638cb38d2921151ba40f6baf5f4c041b35e0a3",
  coverage: [
    { id: "pc-01", feature: "Card 解析", description: "importUserCard 把 Card markdown 解析成 PersonalityCard：frontmatter 的 id/name/version 与六个区块的 sections 都要落到字段上，source 恒为 runtime，hash 非空", why: "人格卡系统基础", depth: "shallow", scenarios: ["card-parse"] },
    { id: "pc-02", feature: "注册表的非法切换守卫", description: "switchPersonality(null) 与切换到不存在的人格都返回 ok:false 并给出原因，且失败的切换不得改动 activeId（拒绝必须原子）", why: "人格切换失败回滚是运行时核心约束", depth: "shallow", scenarios: ["card-registry-guard"] },
    { id: "pc-03", feature: "Card 变量定义解析", description: "variableDefs 解析为 CardVariableDef[]：card 与 interaction 的 scope、type、initial、min/max、updateBy 都要正确", why: "变量池初始化依赖", depth: "shallow", scenarios: ["card-variable-defs"] },
    { id: "pc-04", feature: "Card 语气指引", description: "「行为进阶」区块以原文存入 sections.whenText —— 它是自然语言语气指引，不是可执行的条件 DSL", why: "语气指引要原样进 prompt，不能被解析成会漂移的结构", depth: "shallow", scenarios: ["card-when-text"] },
    { id: "pc-05", feature: "Card EmotionMappings 加载", description: "EmotionMapping[] 正确解析，含破折号音效归一为 null", why: "情绪标签依赖", depth: "shallow", scenarios: ["card-emotion-mappings"] },
    { id: "pc-06", feature: "切卡后变量池重建", description: "换一套 variableDefs 重建后，上一张卡的变量消失、新变量按 def 初始化，system.activeCardId 同步更新", why: "不同 Card 不同变量", depth: "deep", scenarios: ["card-switch-resets-pool"] },
    { id: "pc-07", feature: "激活 Card 驱动系统提示词", description: "bootstrap 之后存在激活 Card，getActivePersonalityId 与之一致，getSystemPrompt() 含该卡的角色设定", why: "Card 内容必须真的进到 prompt，而不只是加载进内存", depth: "deep", scenarios: ["card-active-prompt"] },
    { id: "pc-08", feature: "生产入口下的 Card", description: "sendMessage 走完生产链路后仍有回复、激活 Card 未丢失、activeId 与之一致、会话记录已推进", why: "单元场景只能证明解析正确，证明不了加载好的 Card 真的接进了生产回合", depth: "deep", scenarios: ["card-production-turn"] },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 2, requireBoundary: true, requireErrorPath: true },
}
