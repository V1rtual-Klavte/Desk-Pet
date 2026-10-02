// ==========================================
// 会话重启恢复 —— 从 test/e2e/scenes/harness-storage/会话重启恢复.scene.ts 迁到 L3（W2）
//
// 被测：JsonlSessionRepo 的重启恢复与目录边界（createPiSessionRepo → 真实仓库 + 帧缓冲装饰器）。
// L3 里 IPC 由 test/host/node-ipc.ts 顶替；其余是同一份产品代码。
//
// 迁移时的审视修正：原场景用 `${root}/` 拼字符串做前缀判断，Windows 上路径分隔符是 `\`
// 会假红。迁移后用 node:path 的 relative()/split 判定，两端成立。
//
// 一个场景一个 caseId：原场景的两条 check 合并在同一个 `it` 里（契约：同一 caseId 出现两次
// 即重复，收集器会判错）。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative as relativePath } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, Result } from "@earendil-works/pi-agent-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { createPiSessionRepo } from "@/services/engine/harness"
import { initPaths, runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"

/** 解包 Result（夹具解码器，不是断言）：失败时先经 expect 记一条带错误码的失败，再中止本用例。 */
function expectOk<T>(result: Result<T, FileError>, label: string): T {
  expect(result.ok, `${label}: ${result.ok ? "" : `${result.error.code}: ${result.error.message}`}`).toBe(true)
  if (!result.ok) throw new Error(`${label}: ${result.error.message}`)
  return result.value
}

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-harness-restart-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

describe("会话重启恢复", () => {
  it("换一个仓库实例后会话可从磁盘恢复；会话文件落在数据根 sessions/ 下，与同根的 UI 状态文件互不干扰 [harness-session-restart-recovery]", async () => {
    const context = BACKGROUND_CONTEXT
    const env = new TauriExecutionEnv(await runtimePath("data"))

    // ── ① 换实例恢复 + ② 目录边界 ──
    const sessionsRoot = await runtimePath("data", `restart-${crypto.randomUUID()}`)
    // 与真实数据根同形：sessions 根同时存放可丢弃 UI 状态与旧 .md 残留。
    expectOk(await env.createDir(sessionsRoot, undefined, context), "createDir(sessionsRoot)")
    expectOk(await env.writeFile(`${sessionsRoot}/index.json`, JSON.stringify({ version: 1 }), context), "writeFile(index.json)")
    expectOk(await env.writeFile(`${sessionsRoot}/stale-session.md`, "# 旧残留", context), "writeFile(stale-session.md)")
    try {
      // 第一次运行：创建会话、写入名字后关闭（不依赖任何内存状态）
      const first = await createPiSessionRepo({ sessionsRoot })
      const session = await first.create({ id: "restart-probe" }, context)
      await session.setName("重启恢复", context)
      const { path, cwd } = session.metadata
      await session.close(context)
      await first.close(context)

      // 第二次运行：新实例只从磁盘解析 metadata 并加载会话
      const second = await createPiSessionRepo({ sessionsRoot })
      try {
        const listed = await second.list(undefined, context)
        const recovered = listed.find(item => item.id === "restart-probe")
        expect(recovered, `重启后 list 未恢复会话: ${JSON.stringify(listed)}`).toBeDefined()
        expect(recovered?.cwd).toBe(cwd)
        expect(recovered?.path).toBe(path)

        const reopened = await second.open(recovered as NonNullable<typeof recovered>, context)
        try {
          expect(await reopened.getName(context), "重启后会话名未恢复").toBe("重启恢复")
        } finally {
          await reopened.close(context)
        }
      } finally {
        await second.close(context)
      }

      // 目录边界：会话文件在给定会话根的子目录下、是 .jsonl；根上的 index.json / 旧 .md 不参与扫描。
      expect(path.endsWith(".jsonl"), `会话文件不是 .jsonl: ${path}`).toBe(true)
      expect(path.includes("index.json"), `会话路径混入 UI 状态: ${path}`).toBe(false)
      expect(path.endsWith(".md"), `会话路径混入旧格式: ${path}`).toBe(false)
      const relative = relativePath(sessionsRoot, path)
      expect(relative.startsWith(".."), `会话文件不在会话根下: ${path}`).toBe(false)
      // 一层 --cwd-- 目录：list 是按 cwd 目录逐层扫描的，路径少了这层就说明布局变了而 list 仍要能恢复
      const segments = relative.split(/[\\/]/)
      expect(segments, `会话文件不在 --cwd-- 子目录下: ${path}`).toHaveLength(2)
      expect(
        segments[0].startsWith("--") && segments[0].endsWith("--"),
        `会话目录不是 --cwd-- 形状: ${segments[0]}`,
      ).toBe(true)
    } finally {
      expectOk(await env.remove(sessionsRoot, { recursive: true, force: true }, context), "remove(sessionsRoot)")
    }

    // ── ③ 列举归属：不默认按当前 cwd 过滤，也不忽略显式 cwd ──
    // 数据根变更或 --<cwd>-- 目录编码碰撞后，同一会话根里会有不属于当前数据根的会话 ——
    // 它们必须被如实列出（消费侧再按 metadata.cwd 判别），而不是从列表里静默消失。
    const crossRoot = await runtimePath("data", `cross-root-${crypto.randomUUID()}`)
    const otherCwd = `${crossRoot}-other-cwd`
    const here = await createPiSessionRepo({ sessionsRoot: crossRoot })
    const elsewhere = await createPiSessionRepo({ sessionsRoot: crossRoot, cwd: otherCwd })
    try {
      await (await here.create({ id: "root-a" }, context)).close(context)
      await (await elsewhere.create({ id: "root-b" }, context)).close(context)

      // 不带 options：两个 cwd 目录里的会话都要在（旧实现只列本实例 cwd 的那一个）。
      const all = await elsewhere.list(undefined, context)
      const ids = all.map(item => item.id).sort()
      expect(ids, `跨根会话未被如实列出: ${JSON.stringify(all.map(item => ({ id: item.id, cwd: item.cwd })))}`).toEqual([
        "root-a",
        "root-b",
      ])
      // 显式 cwd 被如实透传：指向别的归属时只列它，指向本实例归属时只列 root-b。
      const rootA = all.find(item => item.id === "root-a")
      expect(rootA, "root-a 不在列举结果里").toBeDefined()
      const onlyA = await elsewhere.list({ cwd: (rootA as NonNullable<typeof rootA>).cwd }, context)
      expect(onlyA.map(item => item.id), "显式 cwd 未被如实透传（应只列 root-a）").toEqual(["root-a"])
      const onlyB = await elsewhere.list({ cwd: otherCwd }, context)
      expect(onlyB.map(item => item.id), "显式 cwd 未被如实透传（应只列 root-b）").toEqual(["root-b"])
    } finally {
      await here.close(context)
      await elsewhere.close(context)
      expectOk(await env.remove(crossRoot, { recursive: true, force: true }, context), "remove(crossRoot)")
    }
  })
})
