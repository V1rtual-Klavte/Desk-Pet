import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { invoke } from "@tauri-apps/api/core"
import { errorCode, formatError } from "@/services/error"
import { permitSnapshot } from "@/services/tool"
import { BaseDirs } from "@/services/paths"
import { isWindows } from "@/services/env"

/**
 * bash「取消 → spawn」竞态（TOOL-07）。
 *
 * Rust 侧把 `bash_exec` 的登记提前到任何阻塞动作之前（校验 execution_id 之后、spawn 之前），
 * 取消因此有了两个可判定的落点：命中已登记的槽 → 立案，spawn 后立即终止并以 `CANCELLED`
 * 结束本次运行；池里没有这个 id → 返回 `false`（此前是静默的成功），调用方据此区分
 * 「取消来晚了」与「取消成功」。
 *
 * 「取消正好落在登记与 spawn 之间」这个窗口无法从 JS 侧确定性复现（它在 Rust 函数体内，
 * 宽度是几十微秒），由 Rust 单测 `bash_cancel_lands_before_spawn` 用同一种槽状态直接钉住。
 * 本场景证明经真实 IPC 可见的部分：未命中的取消有明确结论；取消先发出、exec 后发出时
 * 这次运行被终止并很快收口（而不是跑到 120s 兜底超时）；被终止的运行不留副作用，额度回空闲。
 */

/** `bash_exec` 载荷里本场景用得到的字段。 */
type BashPayload = { exitCode: number; output: string }

/**
 * 取消后收口的预算。
 *
 * 命令的自然时长是 30s、Rust 兜底超时是 120s：收口只可能来自取消，3s 与两者都差一个量级，
 * 既不会被机器抖动穿透，又足以区分「被终止」与「跑到底」。
 */
const SETTLE_BUDGET_MS = 3_000

/** 探针命令的自然时长；比收口预算大一个量级，让「快」这个结论有信息量。 */
const PROBE_SECONDS = 30

/** 跨平台「先等一段时间、再留下探针文件」的命令。 */
function delayedProbe(seconds: number, sentinel: string): string {
  return isWindows
    ? `ping -n ${seconds + 1} 127.0.0.1 > nul && type nul > "${sentinel}"`
    : `sleep ${seconds}; touch "${sentinel}"`
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const 取消竞态: SceneDef = {
  meta: {
    caseId: "tool-cancel-before-spawn", module: "tool-execution", contractId: "te-18",
    description: "取消与 spawn 的竞态：未命中的取消返回 false，已立案的运行被立即终止且不留副作用",
    depth: "deep", suite: "regression", entry: "runtime",
    tags: ["tool-execution", "boundary", "error"],
  },
  // 回合本身不参与断言，只为让 runtime 入口有一个可重复的模型回复。
  setup: async () => { installFakeProvider([fakeText("你好呀～")]) },
  turns: [{
    index: 1,
    description: "经 IPC 复现取消与 spawn 的竞态",
    userText: "检查 bash 取消与 spawn 的竞态。",
    checks: [{
      type: "expectCancelBeforeSpawnContract",
      run: async () => {
        // ① 池里没有这个 id 的取消不再静默：返回值必须是 false。
        // 改动前这个命令返回 `Ok(())`（IPC 上就是 null），调用方无从分辨「取消成功」与「取消来晚了」。
        const missed = await invoke<boolean>("bash_cancel", { executionId: crypto.randomUUID() })
        if (missed !== false) {
          throw new Error(`未命中槽的 bash_cancel 应返回 false，实际 ${String(missed)}`)
        }

        // ② 正对照：同形态命令不加取消时必须跑完并留下探针。缺了它，下面的「探针不存在」
        // 可能只是命令没跑通（策略拒绝、路径不可写），而不是取消生效。
        const controlId = crypto.randomUUID()
        const control = `${BaseDirs.sessions()}/deskpet-cancel-control-${controlId}`
        const controlResult = await invoke<BashPayload>("bash_exec", {
          executionId: controlId,
          command: delayedProbe(0, control),
          timeoutMs: 60_000,
          policy: { scope: "assistant", whitelist: [] },
          maxBytes: 4096,
          maxLines: 100,
          spill: false,
        })
        if (controlResult.exitCode !== 0) throw new Error(`正对照命令退出码 ${controlResult.exitCode}`)
        if (!(await invoke<boolean>("file_exists", { path: control }))) {
          throw new Error("正对照没有留下探针：取消断言会退化成空断言")
        }
        await invoke("file_remove", { path: control, recursive: false, force: true })

        // ③ 竞态顺序：取消先发出（不 await，与 TS 侧 abort 监听器的顺序一致），exec 后发出。
        const id = crypto.randomUUID()
        const sentinel = `${BaseDirs.sessions()}/deskpet-cancel-race-${id}`
        const startedAt = Date.now()
        const cancelled = invoke<boolean>("bash_cancel", { executionId: id })
        let settled = false
        const run = invoke<BashPayload>("bash_exec", {
          executionId: id,
          command: delayedProbe(PROBE_SECONDS, sentinel),
          timeoutMs: 60_000,
          policy: { scope: "assistant", whitelist: [] },
          maxBytes: 4096,
          maxLines: 100,
          spill: false,
        }).then(
          value => { settled = true; return { kind: "ok" as const, value } },
          error => { settled = true; return { kind: "error" as const, error } },
        )

        // 取消先到时可能还看不到槽（登记在 Rust 内）——那是「取消来晚了」而不是成功，
        // 必须由后续取消收口，否则这次运行会占着额度跑到命令自然结束，后续工具全排队。
        let terminated = await cancelled
        const deadline = Date.now() + 2_000
        while (!terminated && !settled && Date.now() < deadline) {
          terminated = await invoke<boolean>("bash_cancel", { executionId: id })
          if (!terminated) await delay(20)
        }

        const outcome = await run
        const elapsed = Date.now() - startedAt
        if (!terminated) throw new Error("取消始终没有命中在跑的槽，竞态未被覆盖")
        if (elapsed >= SETTLE_BUDGET_MS) {
          throw new Error(`取消后运行没有及时收口: ${elapsed}ms（命令自然时长 ${PROBE_SECONDS}s、兜底超时 120s）`)
        }
        if (outcome.kind === "error") {
          // 取消产生的错误必须是稳定码：冒出的 IO/OTHER（超时、spawn 失败）说明中止走了别的路径。
          const code = errorCode(outcome.error)
          if (code !== "CANCELLED") {
            throw new Error(`取消后的 bash_exec 错误码不是 CANCELLED: ${code ?? "无码"} ${formatError(outcome.error)}`)
          }
        } else if (outcome.value.exitCode === 0) {
          throw new Error("取消后命令仍以 0 退出：子进程没有被终止")
        }
        // 探针在取消之后仍不存在：运行确实停在 30s 之前（收口预算已先一步证明这一点）。
        if (await invoke<boolean>("file_exists", { path: sentinel })) {
          throw new Error("取消后子进程仍留下探针：运行没有被终止")
        }

        // 额度回空闲。本场景直接走 IPC、不经许可域，这里证明的是取消没有把额度留在占用态。
        const idle = await permitSnapshot()
        if (idle.exclusiveActive || idle.sharedActive !== 0 || idle.queued !== 0) {
          throw new Error(`取消后额度没有回空闲: shared=${idle.sharedActive} exclusive=${idle.exclusiveActive} queued=${idle.queued}`)
        }
      },
    }],
  }],
}

export default 取消竞态
