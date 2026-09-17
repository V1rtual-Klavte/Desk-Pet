import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, Result } from "@earendil-works/pi-agent-core"
import type { SceneDef } from "../../types"
import { createPiSessionRepo } from "@/services/engine/pi"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import { runtimePath } from "@/services/paths"

function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

export const 会话重启恢复: SceneDef = {
  meta: {
    caseId: "harness-session-restart-recovery",
    module: "harness-storage",
    contractId: "hs-03",
    description: "换一个仓库实例后会话可从磁盘恢复；会话文件落在数据根 sessions/ 下，与同根的 UI 状态文件互不干扰",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["harness-storage", "session-repo", "boundary"],
  },
  turns: [{
    index: 1,
    description: "同一磁盘根上重建仓库实例（根目录预置 index.json / 旧 .md 残留）",
    userText: "校验 JsonlSessionRepo 的重启恢复。",
    checks: [{
      type: "expectSessionRecoveredFromFreshRepo",
      run: async () => {
        const env = new TauriExecutionEnv(await runtimePath("data"), "pet")
        const sessionsRoot = await runtimePath("data", `restart-${crypto.randomUUID()}`)
        // 与真实数据根同形：sessions 根同时存放可丢弃 UI 状态与旧 .md 残留。
        fileOk(await env.createDir(sessionsRoot, undefined, BACKGROUND_CONTEXT))
        fileOk(await env.writeFile(`${sessionsRoot}/index.json`, JSON.stringify({ version: 1 }), BACKGROUND_CONTEXT))
        fileOk(await env.writeFile(`${sessionsRoot}/stale-session.md`, "# 旧残留", BACKGROUND_CONTEXT))

        // 第一次运行：创建会话、写入名字后关闭（不依赖任何内存状态）
        const first = await createPiSessionRepo({ sessionsRoot })
        const session = await first.create({ id: "restart-probe" }, BACKGROUND_CONTEXT)
        await session.setName("重启恢复", BACKGROUND_CONTEXT)
        const { path, cwd } = session.metadata
        await session.close(BACKGROUND_CONTEXT)
        await first.close(BACKGROUND_CONTEXT)

        // 第二次运行：新实例只从磁盘解析 metadata 并加载会话
        const second = await createPiSessionRepo({ sessionsRoot })
        try {
          const listed = await second.list(undefined, BACKGROUND_CONTEXT)
          const recovered = listed.find(item => item.id === "restart-probe")
          if (!recovered) throw new Error(`重启后 list 未恢复会话: ${JSON.stringify(listed)}`)
          if (recovered.cwd !== cwd) throw new Error(`重启后 cwd 不一致: ${recovered.cwd}`)
          if (recovered.path !== path) throw new Error(`重启后 path 不一致: ${recovered.path}`)

          const reopened = await second.open(recovered, BACKGROUND_CONTEXT)
          try {
            const name = await reopened.getName(BACKGROUND_CONTEXT)
            if (name !== "重启恢复") throw new Error(`重启后会话名未恢复: ${JSON.stringify(name)}`)
          } finally {
            await reopened.close(BACKGROUND_CONTEXT)
          }
        } finally {
          await second.close(BACKGROUND_CONTEXT)
        }

        // 目录边界：会话文件在给定会话根的子目录下、是 .jsonl；根上的 index.json / 旧 .md 不参与扫描。
        if (!path.startsWith(`${sessionsRoot}/`)) throw new Error(`会话文件不在会话根下: ${path}`)
        if (!path.endsWith(".jsonl")) throw new Error(`会话文件不是 .jsonl: ${path}`)
        if (path.includes("/index.json") || path.endsWith(".md")) throw new Error(`会话路径混入 UI 状态或旧格式: ${path}`)
      },
    }],
  }],
}

export default 会话重启恢复
