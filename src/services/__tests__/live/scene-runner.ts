// ==========================================
// Scene Runner — 场景执行引擎
// ==========================================

import type { SceneDef, SceneResult, TurnResult, AssertionResult, AssertContext, MemorySnapshot } from "./types"
import { runAgentLoop } from "@/services/engine/agent-loop"
import { getPoolSnapshot } from "@/services/personality/variable-pool"
import { getSession } from "@/services/engine/session"
import { getContextMessages } from "@/services/session/store"
import { MemoryService } from "@/services/agent/memory"

function takeMemorySnapshot(): MemorySnapshot {
  return {
    totalEntries: MemoryService.count,
    sessionTurnCount: MemoryService.sessionTurnCount,
    entriesByCategory: MemoryService.list().reduce((acc, e) => {
      acc[e.category] = (acc[e.category] || 0) + 1
      return acc
    }, {} as Record<string, number>),
  }
}

export async function runScene(scene: SceneDef): Promise<SceneResult> {
  const start = Date.now()
  const turnResults: TurnResult[] = []

  // Setup
  if (scene.setup) {
    try {
      await scene.setup()
    } catch (e) {
      return {
        scene: scene.meta.description,
        module: scene.meta.module,
        contractId: scene.meta.contractId,
        status: "skip",
        turns: [],
        duration: Date.now() - start,
        error: `setup failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  // Execute turns
  for (const turn of scene.turns) {
    const turnStart = Date.now()

    try {
      const output = await runAgentLoop({
        userText: turn.userText,
        chatMessages: getContextMessages(),
        unansweredCount: 0,
        messageCount: getContextMessages().length,
        isActiveMessage: false,
      })

      // Collect internal state
      const session = getSession()
      const ctx: AssertContext = {
        output,
        pool: getPoolSnapshot(),
        session: {
          state: session.agentState,
          messageCount: session.messageCount,
          toolCallCount: session.toolCallCount,
        },
        memory: takeMemorySnapshot(),
        toolHistory: output.toolCallHistory.map(t => ({
          toolName: t.toolName,
          status: t.status,
        })),
      }

      // Run all assertions
      const assertions: AssertionResult[] = []
      for (const check of turn.checks) {
        try {
          await check.run(ctx)
          assertions.push({ type: check.type, pass: true })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          assertions.push({
            type: check.type,
            pass: false,
            error: msg,
          })
        }
      }

      const allPass = assertions.every(a => a.pass)
      turnResults.push({
        index: turn.index,
        description: turn.description,
        userText: turn.userText,
        assertions,
        duration: Date.now() - turnStart,
      })

      if (!allPass) break // 任一失败 → 终止场景
    } catch (e) {
      // runAgentLoop 本身抛异常（超时/网络错误等）
      const msg = e instanceof Error ? e.message : String(e)
      turnResults.push({
        index: turn.index,
        description: turn.description,
        userText: turn.userText,
        assertions: [{ type: "system", pass: false, error: msg }],
        duration: Date.now() - turnStart,
      })
      break
    }
  }

  const duration = Date.now() - start
  const allTurnsPassed = turnResults.length === scene.turns.length &&
    turnResults.every(t => t.assertions.every(a => a.pass))

  return {
    scene: scene.meta.description,
    module: scene.meta.module,
    contractId: scene.meta.contractId,
    status: allTurnsPassed ? "pass" : "fail",
    turns: turnResults,
    duration,
  }
}

export async function runAllScenes(scenes: SceneDef[]): Promise<SceneResult[]> {
  const results: SceneResult[] = []
  for (const scene of scenes) {
    results.push(await runScene(scene))
  }
  return results
}
