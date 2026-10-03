// ==========================================
// 阶段文案链路 —— 从 test/e2e/scenes/personality-card/阶段文案链路.scene.ts 迁到 L3
// ==========================================
//
// 归属 L3 的理由（按 import 判定）：场景 import `@/services/tool` 的 `actionCategoryOf`，
// 工具 barrel 会带出执行许可（IPC），命中规则 6 的清单。
//
// 用户可见的阶段与兜底文案只有 Card 一个来源：四个 getter 各自到达取用点，
// 逐 key 比对探针 Card 与中性常量的差异；Card 完全不可用时全部回非空常量 ——
// 空串会让 UI 静默显示空框。
//
// 审视结论：修正后搬。原场景 `clearStagesCache()` 之后**未还原**模块级缓存（D8），
// 迁进 vitest 会让同文件后续用例（未来的用例）恒拿中性常量；这里改为 snapshot/restore
// 包住整段，且清缓存后先证明「取到的确实不是探针值」再证明每个取用点非空。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import {
  COMMAND_KEYS,
  FALLBACK_KEYS,
  clearStagesCache,
  getCachedStages,
  getCommandReply,
  getFallbackReply,
  getSimpleStage,
  getStagePrompt,
  loadStages,
  restoreStagesCache,
  snapshotStagesCache,
} from "@/services/personality"
import type { StageMap } from "@/services/personality"
import { actionCategoryOf, registerDefaultTools } from "@/services/tool"

/** 探针 Card 的阶段文案：故意与 FALLBACK_STAGES 不同，且 blocked 缺 fs.read 类别。 */
const PROBE_STAGES: StageMap = {
  thinking: "探针思考中",
  planning: "探针规划",
  presence: { idle: "探针空闲", working: "探针工作", resting: "探针休息" },
  executing: { "fs.read": "探针读取中", _default: "探针执行中" },
  done: { "fs.write": "探针写入完成", _default: "探针完成" },
  blocked: { _default: "探针已拦截" },
  error: "探针错误",
  retry: "探针重试",
  commands: {
    clear: "探针已清空", memoryCleared: "探针记忆已清理",
    proactiveEnabled: "探针主动陪伴已开启", proactiveDisabled: "探针主动陪伴已关闭",
    proactiveStatus: "探针主动陪伴状态", behaviorCleared: "探针行为观测已清除",
    compactCompleted: "探针压缩完成", compactDeclined: "探针未压缩", compactNothing: "探针无可压缩",
    compactBusy: "探针压缩忙", compactClosed: "探针会话不可用", compactPending: "探针排队未清空",
    compactFailed: "探针压缩失败",
    skillStarted: "探针技能已加入", skillUnknown: "探针技能不存在", skillEmpty: "探针技能无正文",
    skillDisabled: "探针技能已关闭",
  },
  fallbacks: {
    concurrentRejected: "探针忙", maxRetriesExhausted: "探针重试失败", turnTimeout: "探针超时",
    toolLoopMaxRounds: "探针轮数用尽", llmUnavailable: ["探针不可用"],
    subAgentFailed: "探针子代理失败", subAgentNoResult: "探针子代理无结果",
    runInterrupted: "探针上次中断", compactionRejected: "探针压缩进行中", pausedReturnFailed: "探针暂停输入未放回",
    planCancelled: "探针计划已取消", planCompleted: "探针计划已完成", planResumeBusy: "探针会话忙",
  },
  greetings: ["探针问候"],
}

let root = ""

beforeEach(async () => {
  // 数据根给 logger 与（工具注册链上的）路径解析用；工具注册本身不落盘
  root = mkdtempSync(join(tmpdir(), "deskpet-personality-card-"))
  setTestDataRoot(root)
  // 类别解析断言的对象是真实注册表：注册内置工具（read/write 的 actionCategory 声明点）
  await registerDefaultTools()
})

afterEach(() => {
  clearStagesCache()
  rmSync(root, { recursive: true, force: true })
})

describe("阶段文案链路", () => {
  it("工具类别解析，四类用户可见文案逐一到达取用点 [stage-prompt-link]", () => {
    // 1) 类别解析：已注册工具按声明取类别；未知名字回 _default（MCP/Skill/已释放工具同形）
    expect(actionCategoryOf("read")).toBe("fs.read")
    expect(actionCategoryOf("write")).toBe("fs.write")
    expect(actionCategoryOf("__not_a_tool__")).toBe("_default")

    const saved = snapshotStagesCache()
    try {
      // 2) Card 文案到达 UI 取用点：装上探针 Card，断言取到 Card 文本而非兜底
      loadStages({
        cardId: "probe-card", cardVersion: 1, sourceHash: "probe",
        generatedAt: Date.now(), isFallback: false, stages: PROBE_STAGES,
      })
      expect(getStagePrompt("executing", actionCategoryOf("read"))).toBe("探针读取中")
      expect(getStagePrompt("done", actionCategoryOf("write"))).toBe("探针写入完成")
      // 3) 类别缺失时的回退：blocked 没有 fs.read 类别 → Card 的 _default；再缺则 FALLBACK_STAGES，绝不是空串
      expect(getStagePrompt("blocked", actionCategoryOf("read"))).toBe("探针已拦截")
      // 未知工具名 → _default 类别 → Card 的 _default：整条链路（不是某个常量恰好相等）
      expect(getStagePrompt("executing", actionCategoryOf("__not_a_tool__"))).toBe("探针执行中")

      // 4) 标量阶段（状态行）也走同一条 Card 链路：thinking/planning/error/retry 都有 Card 文本
      for (const key of ["thinking", "planning", "error", "retry"] as const) {
        expect(getSimpleStage(key), `${key} 未取到 Card 文案`).toBe(PROBE_STAGES[key])
      }
      // 5) 命令输出：每个 key 都必须来自 Card，不能有 key 落到中性常量。
      //    先钉住 `/skill` 的四个终态键仍在清单里：下面的循环按 COMMAND_KEYS 动态跑，
      //    键从清单里掉了它只会静默少跑四轮，不会有任何断言失败。
      for (const key of ["skillStarted", "skillUnknown", "skillEmpty", "skillDisabled"] as const) {
        expect(COMMAND_KEYS, `COMMAND_KEYS 缺少 /skill 的终态键: ${key}`).toContain(key)
      }
      for (const key of COMMAND_KEYS) {
        expect(getCommandReply(key), `commands.${key} 未取到 Card 文案`).toBe(PROBE_STAGES.commands[key])
      }
      // 6) 兜底正文同样按 key 取 Card 文本（数组型 llmUnavailable 按元素命中）
      for (const key of FALLBACK_KEYS) {
        const probe = getFallbackReply(key)
        const expected = PROBE_STAGES.fallbacks[key]
        const hit = Array.isArray(expected) ? expected.includes(probe) : probe === expected
        expect(hit, `fallbacks.${key} 未取到 Card 文案: ${JSON.stringify(probe)}`).toBe(true)
      }

      // 7) Card 完全不可用时回中性常量：命令输出与标量阶段都不能是空串（空框就是静默失效）。
      //    先证明缓存真的被清（取到的不再是探针值），再证明每个取用点非空。
      clearStagesCache()
      expect(getCachedStages()).toBeNull()
      for (const key of ["thinking", "planning", "error", "retry"] as const) {
        const text = getSimpleStage(key)
        expect(text, `无 Card 时 ${key} 回退为空`).toBeTruthy()
        expect(text, `无 Card 时 ${key} 仍在用 Card 文案`).not.toBe(PROBE_STAGES[key])
      }
      for (const key of COMMAND_KEYS) {
        expect(getCommandReply(key), `无 Card 时 commands.${key} 回退为空`).toBeTruthy()
      }
      for (const key of FALLBACK_KEYS) {
        expect(getFallbackReply(key), `无 Card 时 fallbacks.${key} 回退为空`).toBeTruthy()
      }
    } finally {
      // D8 修正：stages 缓存是模块级单例，clearStagesCache() 后必须还原 ——
      // 原场景漏了这一步，之后的取用点会一直拿中性常量，直到下一次切卡。
      restoreStagesCache(saved)
    }
  })
})
