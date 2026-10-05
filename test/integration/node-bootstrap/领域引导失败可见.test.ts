// ==========================================
// 领域引导失败可见 —— 失败向上抛、不吞、不重试（W4）
// ==========================================
//
// 归属 L3 的依据：失败发生在真实引导链的第一步（记忆/会话文件系统真建目录，
// 经 Node 适配层走真 fs），不是纯逻辑；断言的是引导对真实 IO 失败的处置。
//
// 被测语义（契约 proactive pr-08 的声明；也是 harness 侧「启动失败要可见」的上游）：
//   · 任何一步失败都向上抛给调用方（harness 记录并以引导失败退出；旧壳 reportError），
//     不吞掉继续跑后续步骤；
//   · 失败保留真实错误码（EEXIST），不降级成笼统错误；
//   · 已失败的引导不可重来：修复环境后同一进程再调用仍是那次失败的结果 ——
//     领域引导会碰到不可逆副作用（挂调度器、注册工具、落盘欢迎语），半初始化状态
//     不能靠重试恢复，只能由宿主重启进程。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { errorCode } from "@/services/error"
import { initDomainBootstrap } from "@/services/init"
import { initPaths } from "@/services/paths"
import { isPersonalityRuntimeReady } from "@/services/personality/registry"
import { getActiveSessionId } from "@/services/session"

let root = ""

/** 合成 CONFIG（四根齐全）：领域引导的 initConfig 会读它，缺失即 ENOENT 中止引导。 */
const SYNTHETIC_CONFIG_YAML = `
general:
  popup: { mode: cursor, autoPopupOnMessage: false, defaultSize: { w: 730, h: 450 }, fixedPosition: null, chatWidth: 220 }
  logging: { level: debug }
ai:
  provider: test
  endpoint: http://127.0.0.1:0
  apiKey: ""
  requireApiKey: false
  model: test-model
  auxModel: ""
  contextMaxTokens: 131072
  thinking: { effort: auto }
  conversation: { defaultDelivery: steer, steeringMode: all, followUpMode: all }
  loop: { maxRetry: 3, maxToolCallsPerTurn: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  plan: { enabled: false }
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { frequency: "off" }
tools:
  bash: { whitelist: [ls, cat] }
  mcp: { servers: [] }
appearance:
  activeProfile: sugar-pink
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: "", size: 15 }
  chatImagePreview: false
`

function sessionsDir(): string {
  return join(root, "sessions")
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-bootstrap-fail-"))
  setTestDataRoot(root)
  mkdirSync(join(root, "settings"), { recursive: true })
  writeFileSync(join(root, "settings", "CONFIG.yaml"), SYNTHETIC_CONFIG_YAML, "utf8")
  await initPaths()

  // 把 sessions 目录换成普通文件：引导第一步 init_memory_files 的建目录
  // （mkdirSync recursive）会以 EEXIST 失败 —— 确定性的真实 IO 故障。
  rmSync(sessionsDir(), { recursive: true, force: true })
  writeFileSync(sessionsDir(), "")
}, 30_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("领域引导失败可见", () => {
  it("首步失败向上抛且后续不执行；修复环境后仍是同一次失败（不重试） [init-domain-failure-visible]", async () => {
    expect(isPersonalityRuntimeReady(), "前置：人格已是就绪态，本用例无法区分失败被吞").toBe(false)

    const first = initDomainBootstrap()
    const failure = await first.then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure, "引导失败了但 Promise 却成功（失败被吞成继续运行）").not.toBeNull()
    // 底层 OS 错误码经 Node 测试宿主直传（node-ipc 的等价实现不裹 IO）——断言
    // 「以 EEXIST 上抛、未被吞或改写为成功」。
    expect(errorCode(failure), "失败原因被改写（应保留底层 EEXIST）").toBe("EEXIST")

    // 首步失败后不得继续后续步骤（后续步骤会建立会话、注册工具、挂调度器）
    expect(isPersonalityRuntimeReady(), "首步失败后人格注册仍在执行").toBe(false)
    expect(getActiveSessionId(), "首步失败后会话仍被建立").toBe("")

    // 修复环境后再次调用：若实现允许对失败重试，这次会成功 —— 半初始化状态不可恢复，
    // 必须仍以同一次失败结果收场（单次闩把失败也锁住）。
    rmSync(sessionsDir(), { force: true })
    mkdirSync(sessionsDir(), { recursive: true })
    const again = initDomainBootstrap()
    const againFailure = await again.then(
      () => null,
      (error: unknown) => error,
    )
    expect(againFailure, "已失败的引导被重跑/重试（半初始化状态被当成可重来）").not.toBeNull()
    expect(againFailure, "重试拿到的是另一次运行的结果（不是同一次失败）").toBe(failure)
  })
})
