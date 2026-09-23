import type { ModuleContract } from "../types"

export const personalityCardContract: ModuleContract = {
  module: "personality-card",
  sourceFiles: ["src/services/personality/registry.ts", "src/services/personality/loader.ts", "src/services/personality/stages-cache.ts"],
  generatedAt: "2026-09-23",
  sourceHash: "a6cbd8d5e2b9ade873919e02c84a2366d40e0ad895334c761b13b047d55bf7ff",
  coverage: [
    { id: "pc-01", feature: "Card 解析", description: "importUserCard 把 Card markdown 解析成 PersonalityCard：frontmatter 的 id/name/version 与各区块的 sections 都要落到字段上，source 恒为 runtime，hash 非空", why: "人格卡系统基础", depth: "shallow", scenarios: ["card-parse"] },
    { id: "pc-02", feature: "注册表的非法切换守卫", description: "switchPersonality(null) 与切换到不存在的人格都返回 ok:false 并给出原因，且失败的切换不得改动 activeId（拒绝必须原子）", why: "人格切换失败回滚是运行时核心约束", depth: "shallow", scenarios: ["card-registry-guard"] },
    { id: "pc-03", feature: "Card 变量定义解析", description: "variableDefs 解析为 CardVariableDef[]：card 与 interaction 的 scope、type、initial、min/max、updateBy 都要正确", why: "变量池初始化依赖", depth: "shallow", scenarios: ["card-variable-defs"] },
    { id: "pc-04", feature: "Card 语气指引", description: "「行为进阶」区块以原文存入 sections.whenText —— 它是自然语言语气指引，不是可执行的条件 DSL", why: "语气指引要原样进 prompt，不能被解析成会漂移的结构", depth: "shallow", scenarios: ["card-when-text"] },
    { id: "pc-06", feature: "切卡后变量池重建", description: "换一套 variableDefs 重建后，上一张卡的变量消失、新变量按 def 初始化，system.activeCardId 同步更新", why: "不同 Card 不同变量", depth: "deep", scenarios: ["card-switch-resets-pool"] },
    { id: "pc-07", feature: "激活 Card 驱动系统提示词", description: "bootstrap 之后存在激活 Card，getActivePersonalityId 与之一致，getSystemPrompt() 含该卡的角色设定", why: "Card 内容必须真的进到 prompt，而不只是加载进内存", depth: "deep", scenarios: ["card-active-prompt"] },
    { id: "pc-08", feature: "生产入口下的 Card", description: "sendMessage 走完生产链路后仍有回复、激活 Card 未丢失、activeId 与之一致、会话记录已推进", why: "单元场景只能证明解析正确，证明不了加载好的 Card 真的接进了生产回合", depth: "deep", scenarios: ["card-production-turn"] },
    { id: "pc-10", feature: "阶段文案失效判定", description: "阶段文案缓存按 sourceHash（= SHA-256(角色设定 + 语言风格)，定义点 stageSourceHash）与 cardId 归属判过期：sourceHash 变化或 cardId 不符即过期、缺 greetings 等形态不合法的旧文件也判过期；cardVersion 是元数据、不参与判定；只改非生成输入（行为进阶、变量定义）不改变失效键，改角色设定或语言风格必变", why: "失效键必须与生成输入严格同源：宽了会触发多余的生成调用，窄了会把旧文案继续用在换了人设的 Card 上", depth: "shallow", scenarios: ["card-stages-staleness"] },
    { id: "pc-11", feature: "切换失败回滚", description: "切换在阶段文案生成不可用时失败，且不产生部分应用：activeId、变量注册表与变量池逐项保持失败前的状态（目标卡与活动卡的变量定义不同，注册表一旦泄漏目标卡 schema 立即可观测）", why: "VAR-02 的根因：回滚只还原变量池、不还原注册表，失败后后续写入会按目标卡的 schema 校验、Prompt 里的变量元数据整块消失", depth: "deep", scenarios: ["card-switch-failure-rollback"] },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 2, requireBoundary: true, requireErrorPath: true },
}
