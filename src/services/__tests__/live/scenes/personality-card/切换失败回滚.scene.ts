import type { SceneDef } from "../../types"
import type { StreamFn } from "@earendil-works/pi-agent-core"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { invoke } from "@tauri-apps/api/core"
import { installPiRuntimeProviderForTest } from "@/services/engine/pi"
import { runtimePath } from "@/services/paths"
import {
  getActiveCard,
  getActivePersonalityId,
  listPersonalities,
  switchPersonality,
} from "@/services/personality/registry"
import { getPoolSnapshot, getVariableRegistry } from "@/services/personality/variable-pool"

/**
 * 切换失败的原子性（VAR-02）。
 *
 * 真实可达的失败点是阶段文案：`switchPersonality` 先 `ensureStagesReady`
 * （磁盘缓存未命中 → 一次性 LLM 生成），生成不可用时整次切换失败。
 * 失败不得留下部分应用：activeId、变量注册表与变量池都必须与失败前逐项一致。
 *
 * 注册表被单列不是凑数：改动前回滚只还原池、不还原注册表，切换失败后后续写入
 * 会按目标卡的 schema 校验、Prompt 里的变量元数据整块消失。所以目标卡刻意选一张
 * **变量定义不同**的卡 —— 一旦目标卡的 schema 泄漏进注册表，名字比对立刻红。
 */
const scene: SceneDef = {
  meta: {
    caseId: "card-switch-failure-rollback",
    module: "personality-card",
    contractId: "pc-11",
    description: "切换失败不产生部分应用：activeId、变量注册表与变量池保持失败前状态",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["personality-card", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "阶段文案生成不可用 → 切换失败并完整回滚",
    userText: "检查切换失败的回滚。",
    checks: [{ type: "expectSwitchFailureRollback", run: async () => {
      const active = getActiveCard()
      if (!active) throw new Error("bootstrap 之后没有激活的 Card")

      const others = listPersonalities().filter(card => card.id !== active.id)
      if (others.length === 0) throw new Error("运行数据根里只有一张 Card，无法构造切换失败")
      const target = others.find(card =>
        JSON.stringify(card.sections.variableDefs) !== JSON.stringify(active.sections.variableDefs))
      if (!target) throw new Error("没有变量定义不同的第二张 Card，注册表断言失去区分度")

      const activeIdBefore = getActivePersonalityId()
      const registryBefore = JSON.stringify(getVariableRegistry())
      const poolBefore = JSON.stringify(getPoolSnapshot())
      const targetDefNames = target.sections.variableDefs.map(def => def.name)

      // 目标卡不能留着可用的阶段文案缓存：命中缓存就不会去调模型，失败点也就不成立
      await invoke("file_remove", {
        path: await runtimePath("personality", "stages", `${target.id}.json`),
        recursive: false,
        force: true,
      })

      // 模型侧不可用：一次性文本调用直接抛错（阶段文案生成的失败吞进 null，
      // 由 ensureStagesReady 转成「阶段文案生成失败」）
      const fake = installFakeProvider([fakeText("这条响应不会被消费")])
      let attempts = 0
      const restoreOverride = installPiRuntimeProviderForTest({
        model: fake.model,
        streamFn: (() => {
          attempts++
          throw new Error("模拟阶段文案生成不可用")
        }) as StreamFn,
      })
      let result: Awaited<ReturnType<typeof switchPersonality>>
      try {
        result = await switchPersonality(target.id)
      } finally {
        restoreOverride()
        fake.restore()
      }

      // 失败点必须是本场景要钉的那一条：否则「切换失败」可能只是卡根本不存在
      if (attempts === 0) throw new Error("切换没有走到阶段文案生成，失败点不是模型不可用")
      if (result.ok) throw new Error(`切换被放行: ${target.id}`)
      if (!result.error?.includes("阶段文案生成失败")) {
        throw new Error(`失败点不是阶段文案生成: ${result.error ?? "(无原因)"}`)
      }

      // 失败后的状态与失败前逐项一致
      if (getActivePersonalityId() !== activeIdBefore) {
        throw new Error(`失败的切换改动了 activeId: ${activeIdBefore} -> ${getActivePersonalityId()}`)
      }
      if (getActiveCard()?.id !== active.id) throw new Error("失败的切换改动了激活 Card")
      if (JSON.stringify(getVariableRegistry()) !== registryBefore) {
        throw new Error(`失败的切换改动了变量注册表: ${JSON.stringify(getVariableRegistry())}`)
      }
      if (JSON.stringify(getPoolSnapshot()) !== poolBefore) {
        throw new Error("失败的切换改动了变量池")
      }
      // 目标卡的 schema 一个都不该出现在注册表里（注册表整体相等已蕴含，单列为了可读的失败信息）
      const namesAfter = getVariableRegistry().map(def => def.name)
      for (const name of targetDefNames) {
        if (namesAfter.includes(name) && !JSON.parse(registryBefore).some((def: { name: string }) => def.name === name)) {
          throw new Error(`目标卡的变量 ${name} 泄漏进了注册表`)
        }
      }
      if (getPoolSnapshot().system.activeCardId !== active.id) {
        throw new Error("失败的切换改动了池的卡归属")
      }
    } }],
  }],
}

export default scene
