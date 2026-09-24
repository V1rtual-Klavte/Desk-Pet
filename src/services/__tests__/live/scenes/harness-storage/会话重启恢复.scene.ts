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
        // 一层 --cwd-- 目录：list 是按 cwd 目录逐层扫描的，路径少了这层就说明布局变了而 list 仍要能恢复
        const relative = path.slice(sessionsRoot.length + 1)
        const directoryName = relative.slice(0, relative.indexOf("/"))
        if (!directoryName.startsWith("--") || !directoryName.endsWith("--")) {
          throw new Error(`会话文件不在 --cwd-- 子目录下: ${path}`)
        }
      },
    },
    {
      // 列举归属（W1–W4：`list` 不再强制 `{ cwd: 本实例 cwd }`）。数据根变更或
      // `--<cwd>--` 目录编码碰撞后，同一会话根里会有不属于当前数据根的会话 ——
      // 它们必须被如实列出（消费侧再按 metadata.cwd 判别），而不是从列表里静默消失；
      // 同时显式传入的 cwd 要被如实透传，不能被忽略后回退成本实例的 cwd。
      type: "expectCrossRootSessionsStayListed",
      run: async () => {
        const env = new TauriExecutionEnv(await runtimePath("data"), "pet")
        const sessionsRoot = await runtimePath("data", `cross-root-${crypto.randomUUID()}`)
        const otherCwd = `${sessionsRoot}-other-cwd`
        const here = await createPiSessionRepo({ sessionsRoot })
        const elsewhere = await createPiSessionRepo({ sessionsRoot, cwd: otherCwd })
        try {
          await (await here.create({ id: "root-a" }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT)
          await (await elsewhere.create({ id: "root-b" }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT)

          // ① 不带 options：两个 cwd 目录里的会话都要在（旧实现只列本实例 cwd 的那一个）。
          const all = await elsewhere.list(undefined, BACKGROUND_CONTEXT)
          const ids = all.map(item => item.id).sort()
          if (JSON.stringify(ids) !== JSON.stringify(["root-a", "root-b"])) {
            throw new Error(`跨根会话未被如实列出: ${JSON.stringify(all.map(item => ({ id: item.id, cwd: item.cwd })))}`)
          }
          // ② 显式 cwd 被如实透传：指向别的归属时只列它，指向本实例归属时只列 root-b。
          const rootA = all.find(item => item.id === "root-a")
          if (!rootA) throw new Error("root-a 不在列举结果里")
          const onlyA = await elsewhere.list({ cwd: rootA.cwd }, BACKGROUND_CONTEXT)
          if (onlyA.length !== 1 || onlyA[0]?.id !== "root-a") {
            throw new Error(`显式 cwd 未被如实透传（应只列 root-a）: ${JSON.stringify(onlyA.map(item => item.id))}`)
          }
          const onlyB = await elsewhere.list({ cwd: otherCwd }, BACKGROUND_CONTEXT)
          if (onlyB.length !== 1 || onlyB[0]?.id !== "root-b") {
            throw new Error(`显式 cwd 未被如实透传（应只列 root-b）: ${JSON.stringify(onlyB.map(item => item.id))}`)
          }
        } finally {
          await here.close(BACKGROUND_CONTEXT)
          await elsewhere.close(BACKGROUND_CONTEXT)
          await env.remove(sessionsRoot, { recursive: true, force: true }, BACKGROUND_CONTEXT)
        }
      },
    }],
  }],
}

export default 会话重启恢复
