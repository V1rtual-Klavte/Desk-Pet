import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { SceneDef } from "../../types"
import { createPiSessionRepo, PI_SESSIONS_DIR } from "@/services/engine/pi"
import { BaseDirs, runtimePath } from "@/services/paths"

export const 会话重启恢复: SceneDef = {
  meta: {
    caseId: "harness-session-restart-recovery",
    module: "harness-storage",
    contractId: "hs-03",
    description: "换一个仓库实例后会话可从磁盘恢复，且目录与旧 sessions/*.md 分开",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["harness-storage", "session-repo", "boundary"],
  },
  turns: [{
    index: 1,
    description: "同一磁盘根上重建仓库实例",
    userText: "校验 JsonlSessionRepo 的重启恢复。",
    checks: [{
      type: "expectSessionRecoveredFromFreshRepo",
      run: async () => {
        const sessionsRoot = await runtimePath("data", PI_SESSIONS_DIR, `restart-${crypto.randomUUID()}`)

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

        // 目录边界：写进数据根的 pi-sessions，不写进旧的 sessions/*.md 目录
        const marker = `${PI_SESSIONS_DIR}/`
        if (!path.includes(marker)) throw new Error(`会话文件不在 pi-sessions 下: ${path}`)
        if (path.startsWith(`${BaseDirs.sessions()}/`)) throw new Error(`会话文件混入旧 sessions 目录: ${path}`)
      },
    }],
  }],
}

export default 会话重启恢复
