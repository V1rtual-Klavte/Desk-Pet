// ==========================================
// Bash 超时档位 —— 声明 5 分钟窗口 + 生效值一路下传到 Rust 的 bash_exec + 超时转后台
// ==========================================
//
// 2026-10-06 后台化批次后的口径（见 .superpowers/sdd/turn-gov/tool-timeout-impl-report.md）：
// ① `policy.execution.timeoutMs` 显式 **null** —— router 计时器不承载 bash 死线（若同值，
//    router 会先到点 abort、取消链把命令杀掉，后台化失效；见 pi-tools 注册点注释）；
// ② 模型可见口径（工具描述 + timeout 参数说明）与生效值夹取仍挂在生产注册表上；
// ③ 生效超时以毫秒下传到 Rust（Rust 是唯一执行死线：到点**不杀**、转后台继续跑）；
// ④ 发起会话随 bash_exec 下传（完成通知按它回投正确会话）；
// ⑤ backgrounded 回执按「未完成」如实结算成 timeout 错误，文本带转后台说明 + 输出尾部。
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
  bashCalls: [] as Array<{ command: string; timeoutMs: number | null; sessionId: string | null }>,
  /** 下一次 bash_exec 的回执覆盖（后台化用例注入 backgrounded 结果用）。 */
  nextResult: null as Record<string, unknown> | null,
}))

vi.mock("@/services/host", async importOriginal => {
  // 只替换 Rust 专属命令 `bash_exec`（观测下传参数 / 注入后台化回执），其余命令原样
  // 委托 setupFiles 注入的 NodeHostBridge。
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
            const call = args as { command: string; timeoutMs?: number | null; sessionId?: string | null }
            HOISTED.bashCalls.push({ command: call.command, timeoutMs: call.timeoutMs ?? null, sessionId: call.sessionId ?? null })
            if (HOISTED.nextResult) {
              const injected = HOISTED.nextResult
              HOISTED.nextResult = null
              return injected as import("@/services/host").HostCommandMap[K]["result"]
            }
            // 空回执：只观测下传参数，不消费真实输出。
            return {
              output: "", exitCode: 0, totalBytes: 0, totalLines: 0, outputBytes: 0,
              outputLines: 0, truncated: false, truncatedBy: null, lastLinePartial: false,
              spillPath: null, maxBytes: 51200, maxLines: 2000,
              timedOut: false, backgrounded: false, elapsedMs: 1, silentMs: 0, producedBytes: 0,
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
  it("bash 不在 router 计时器上设超时（死线由 Rust 执行端承载，超时转后台） [tool-bash-timeout-tier]", () => {
    const bash = getToolByName("bash")
    expect(bash, "bash 工具未注册").toBeDefined()
    // 显式 null：不是「删除声明吃全局 30s 默认」（undefined，那会在 30s 先 abort），
    // 也不是 300000（router 与 Rust 死线竞速，router 先到点会 abort 杀掉命令、后台化失效）。
    expect(bash!.policy.execution.timeoutMs, "bash 的 router 计时器口径不对").toBeNull()
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

  it("生效超时与会话归属以毫秒下传到 Rust 的 bash_exec [tool-bash-timeout-downlink]", async () => {
    const bash = getToolByName("bash")!
    // 带会话归属的实例：完成通知回投正确会话的链路起点（bash_exec.sessionId）。
    const env = new NativeExecutionEnv(root, "session-downlink")
    HOISTED.bashCalls.length = 0

    // 主路径：模型不传值 → 夹取后的 300 秒 → bash_exec 收到 300000ms
    // （旧链路这里是 null，Rust 吃 120s 兜底）。
    const prepared = bash.prepareArguments!({ command: "sleep 1" })
    const result = await env.exec("sleep 1", { timeout: prepared.timeout as number, cwd: root }, BACKGROUND_CONTEXT)
    expect(result.ok, "bash_exec 的假回执应被正常消费").toBe(true)
    expect(HOISTED.bashCalls, "bash_exec 未被调用").toHaveLength(1)
    expect(HOISTED.bashCalls[0]!.timeoutMs, "生效超时没有以毫秒下传").toBe(300_000)
    expect(HOISTED.bashCalls[0]!.sessionId, "会话归属没有随 bash_exec 下传").toBe("session-downlink")

    // 模型下调的值同样按秒 → 毫秒换算下传。
    const lowered = bash.prepareArguments!({ command: "sleep 1", timeout: 45 })
    await env.exec("sleep 1", { timeout: lowered.timeout as number, cwd: root }, BACKGROUND_CONTEXT)
    expect(HOISTED.bashCalls[1]!.timeoutMs).toBe(45_000)

    // 不经 pi-bash 的直调仍传 null —— 由 Rust 的同值兜底接管（两侧同值由 Rust 单测钉）。
    await env.exec("sleep 1", { cwd: root }, BACKGROUND_CONTEXT)
    expect(HOISTED.bashCalls[2]!.timeoutMs).toBe(null)
    // 无会话归属的实例：sessionId 为 null（完成通知没有展示位，宿主侧如实跳过）。
    const anonymous = new NativeExecutionEnv(root)
    await anonymous.exec("sleep 1", { cwd: root }, BACKGROUND_CONTEXT)
    expect(HOISTED.bashCalls[3]!.sessionId).toBe(null)
  })

  it("超时转后台回执：按 timeout 如实结算，模型文本带背景说明与输出尾部 [tool-bash-timeout-backgrounded]", async () => {
    const env = new NativeExecutionEnv(root, "session-bg")
    HOISTED.bashCalls.length = 0
    HOISTED.nextResult = {
      output: "step 1 ok\nstep 2 ok", exitCode: -1, totalBytes: 18, totalLines: 2, outputBytes: 18,
      outputLines: 2, truncated: false, truncatedBy: null, lastLinePartial: false,
      spillPath: null, maxBytes: 51200, maxLines: 2000,
      timedOut: true, backgrounded: true, elapsedMs: 300_100, silentMs: 8_200, producedBytes: 18,
    }
    let streamed = ""
    const result = await env.exec("npm run build", {
      timeout: 300,
      cwd: root,
      onUpdate: update => {
        if (update.kind === "replace") streamed = update.output.text
      },
    }, BACKGROUND_CONTEXT)
    expect(result.ok, "转后台不该按成功结算（命令未完成）").toBe(false)
    if (result.ok) return
    expect(result.error.code, "转后台的归宿是执行端超时（timeout），不是普通失败").toBe("timeout")
    // 模型可见文本：转后台说明（含 L1 证据）+ 输出尾部 —— 旧行为是超时即杀且无现场。
    expect(streamed, "流式视图没有转后台说明").toContain("已转入后台")
    expect(streamed, "转后台说明缺少静默时长证据").toContain("8.2")
    expect(streamed, "转后台说明缺少产出字节证据").toContain("18 字节")
    expect(streamed, "输出尾部没有带进模型文本").toContain("step 2 ok")
    expect(result.error.message, "结算错误文本应说明已转后台").toContain("已转入后台")
  })
})
