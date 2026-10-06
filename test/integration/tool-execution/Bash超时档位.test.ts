// ==========================================
// Bash 超时档位 —— 声明 5 分钟窗口 + 生效值一路下传到 Rust 的 bash_exec
// ==========================================
//
// 用户裁决（2026-10-06）：不动全局超时语义，bash 单独一档 —— `sleep 60`、慢构建、
// 下载这类合法长命令不该被全局默认（30s）掐死。本文件钉住三件事：
// ① 注册表里的策略声明值（`policy.execution.timeoutMs`，router 的请求视图超时）；
// ② 模型可见口径（工具描述 + timeout 参数说明）与生效值夹取真的挂在生产注册表上；
// ③ 生效超时以毫秒下传到 Rust（旧链路模型不传值是 null → 吃 Rust 的 120s 兜底，
//    5 分钟档名存实亡；见 .superpowers/sdd/turn-gov/timeout-research.md）。
//
// 归属 L3（不是 L2）的理由：import `@/services/tool`（工具 barrel 会带出执行许可，
// 规则 6 的 L2 禁入清单）与 `NativeExecutionEnv`（文件/命令全经 HostBridge）。
// 不驱动任何模型与回合；`bash_exec` 由 vi.mock 包一层观测（其余命令照旧委托
// setupFiles 注入的 NodeHostBridge，与「会话删除与托管图片清理」同款手法）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { setTestDataRoot } from "../../host/node-ipc"
import { getToolByName, registerDefaultTools } from "@/services/tool"
import { NativeExecutionEnv } from "@/services/tool/pi/native-execution-env"

const HOISTED = vi.hoisted(() => ({
  bashCalls: [] as Array<{ command: string; timeoutMs: number | null }>,
}))

vi.mock("@/services/host", async importOriginal => {
  // 只替换 Rust 专属命令 `bash_exec`（观测下传参数），其余命令原样委托 setupFiles
  // 注入的 NodeHostBridge。
  const actual = await importOriginal<typeof import("@/services/host")>()
  return {
    ...actual,
    getHostBridge: () => {
      const bridge = actual.getHostBridge()
      const wrapped = {
        ...bridge,
        request: async <K extends keyof import("@/services/host").HostCommandMap>(
          method: K,
          args: import("@/services/host").HostCommandMap[K]["args"],
          options?: { signal?: AbortSignal; scope?: import("@/services/host").RunScope },
        ) => {
          if (method === "bash_exec") {
            const call = args as { command: string; timeoutMs?: number | null }
            HOISTED.bashCalls.push({ command: call.command, timeoutMs: call.timeoutMs ?? null })
            // 空回执：本用例只观测下传参数，不消费真实输出。
            return {
              output: "", exitCode: 0, totalBytes: 0, totalLines: 0, outputBytes: 0,
              outputLines: 0, truncated: false, truncatedBy: null, lastLinePartial: false,
              spillPath: null, maxBytes: 51200, maxLines: 2000,
            } as import("@/services/host").HostCommandMap[K]["result"]
          }
          return bridge.request(method, args, options)
        },
      }
      return wrapped as import("@/services/host").HostBridge
    },
  }
})

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-bash-timeout-tier-"))
  setTestDataRoot(root)
  // L3 没有宿主启动面兜底：生产工具由本文件自己注册（与安全等级边界 / 子代理工具面同款）。
  await registerDefaultTools()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Bash 超时档位", () => {
  it("bash 声明 5 分钟执行窗口，不吃全局 30s 默认 [tool-bash-timeout-tier]", () => {
    const bash = getToolByName("bash")
    expect(bash, "bash 工具未注册").toBeDefined()
    // 字面值钉 5 分钟（300000ms）：删除声明（undefined）或改回吃全局默认（30000ms）都会红。
    expect(bash!.policy.execution.timeoutMs, "bash 没有声明自己的 5 分钟超时档").toBe(5 * 60 * 1000)
  })

  it("注册后的 pi-bash 暴露档位口径，并把模型参数夹成生效超时 [tool-bash-timeout-registration]", () => {
    const bash = getToolByName("bash")
    expect(bash, "bash 工具未注册").toBeDefined()

    // 模型可见口径：描述与 timeout 参数说明都必须说清档位（工具描述里的数字必须与实现
    // 一致 —— 上游参数说明「no default timeout」与生效行为不符，本层把它钉成已覆盖）。
    expect(bash!.description, "工具描述没有档位口径（模型看不到 300 秒默认/上限）").toContain("300")
    const timeoutParam = bash!.parameters.properties.timeout as { description?: string } | undefined
    expect(timeoutParam?.description, "timeout 参数说明没有档位口径").toContain("300")

    // 生效值夹取真的接在生产定义上：不传 → 300；下调 → 原样；越界 → 300。
    // 缺了 prepareArguments，模型不传值时 Rust 会吃自己的兜底（旧故障的隐藏天花板）。
    expect(bash!.prepareArguments, "prepareArguments 未接上（生效值不会下传 Rust）").toBeTypeOf("function")
    expect(bash!.prepareArguments!({ command: "sleep 1" }).timeout).toBe(300)
    expect(bash!.prepareArguments!({ command: "sleep 1", timeout: 45 }).timeout).toBe(45)
    expect(bash!.prepareArguments!({ command: "sleep 1", timeout: 600 }).timeout).toBe(300)
  })

  it("生效超时以毫秒下传到 Rust 的 bash_exec [tool-bash-timeout-downlink]", async () => {
    const bash = getToolByName("bash")!
    const env = new NativeExecutionEnv(root)
    HOISTED.bashCalls.length = 0

    // 主路径：模型不传值 → 夹取后的 300 秒 → bash_exec 收到 300000ms
    // （旧链路这里是 null，Rust 吃 120s 兜底）。
    const prepared = bash.prepareArguments!({ command: "sleep 1" })
    const result = await env.exec("sleep 1", { timeout: prepared.timeout as number, cwd: root }, BACKGROUND_CONTEXT)
    expect(result.ok, "bash_exec 的假回执应被正常消费").toBe(true)
    expect(HOISTED.bashCalls, "bash_exec 未被调用").toHaveLength(1)
    expect(HOISTED.bashCalls[0]!.timeoutMs, "生效超时没有以毫秒下传").toBe(300_000)

    // 模型下调的值同样按秒 → 毫秒换算下传。
    const lowered = bash.prepareArguments!({ command: "sleep 1", timeout: 45 })
    await env.exec("sleep 1", { timeout: lowered.timeout as number, cwd: root }, BACKGROUND_CONTEXT)
    expect(HOISTED.bashCalls[1]!.timeoutMs).toBe(45_000)

    // 不经 pi-bash 的直调仍传 null —— 由 Rust 的同值兜底接管（两侧同值由 Rust 单测钉）。
    await env.exec("sleep 1", { cwd: root }, BACKGROUND_CONTEXT)
    expect(HOISTED.bashCalls[2]!.timeoutMs).toBe(null)
  })
})
