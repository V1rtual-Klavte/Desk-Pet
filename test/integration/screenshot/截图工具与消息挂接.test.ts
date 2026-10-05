// ==========================================
// 截图工具与助手消息挂接 —— 隐私闸、模型可见、show_to_user 落条目
// ==========================================
//
// 被测语义（四条，真实 agent loop + 真 JSONL 落盘，只替换桌面截图命令与 Provider）：
// ① 隐私总闸（ai.silentAccess.enabled）关闭时：工具返回中性说明、不触达 capture/save，
//    也不产生 details（与 window_info 同一口径，不是报错）；
// ② show_to_user=true：截图先经 save_screenshot 落盘拿到路径，随后该路径并入本回合
//    提交的助手条目（`deskpetImagePaths`），读模型重载后仍能带回；工具结果同时带图片块
//    给模型（模型看得见自己在看什么）；
// ③ show_to_user 缺省（false）：工具照常执行、模型照样看得见图，但条目不带路径、
//    结算不回传界面图片路径；
// ④ 文件被删除：条目与读模型保留原路径（不缓存、不复制副本），由界面按「不可用」呈现。
//
// 归属 L3（不是 L2）的理由：import `@/services/tool`（工具 barrel 会带出执行许可，规则 6）
// 并跑真实 runtime / JSONL 落盘。
//
// 诚实边界：Node 适配层没有 Rust 截图能力（capture_screenshot / save_screenshot 是
// Rust-only，见 host/unsupported.ts），本文件用 `vi.mock` 只替换这两个命令的返回值与
// 「落盘后给路径」的次序，其余命令仍走 node-ipc 真适配；Rust 的采集、缩放、原子写与
// mtime 淘汰（200 上限）不在本文件覆盖内（Rust 侧有内联单测选择逻辑）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { sessionEntries, sessionMessages } from "../../host/session-entries"
import { runRuntimeTurn } from "../agent-runtime/_runtime-turn"
import { executeToolDefinition, getToolByName } from "@/services/tool"
import { resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import { flushConfig, setOverrides } from "@/services/config"
import { initPaths } from "@/services/paths"
import type { HostBridge, HostCommandMap } from "@/services/host"

/** 1×1 PNG：只用于形状与流转断言，不解释图像内容。 */
const HOISTED = vi.hoisted(() => ({
  pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/NuoAAAAASUVORK5CYII=",
  captureCalls: 0,
  saveCalls: 0,
  savedPath: "",
  saveArgs: [] as Array<Record<string, unknown>>,
  invoked: [] as string[],
}))

vi.mock("@/services/host", async importOriginal => {
  // 在实际 HostBridge request 边界只替换截图两个 Rust-only 命令，其余真实调用继续交给
  // setupFiles 注入的 NodeHostBridge；不安装旧 Tauri 命令面或兼容 transport。
  const actual = await importOriginal<typeof import("@/services/host")>()
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const { dirname } = await import("node:path")
  return {
    ...actual,
    getHostBridge: () => {
      const bridge = actual.getHostBridge()
      const wrapped = {
        ...bridge,
        request: async <K extends keyof HostCommandMap>(method: K, args: HostCommandMap[K]["args"], options?: { signal?: AbortSignal; scope?: import("@/services/host").RunScope }) => {
          HOISTED.invoked.push(String(method))
          if (method === "capture_screenshot") {
        HOISTED.captureCalls += 1
            return { data: HOISTED.pngBase64, mimeType: "image/png", width: 2, height: 2 } as HostCommandMap[K]["result"]
          }
          if (method === "save_screenshot") {
        HOISTED.saveCalls += 1
            HOISTED.saveArgs.push(args as Record<string, unknown>)
            // 与 Rust 侧同口径：落盘发生在返回路径之前（先文件、后条目）。
            mkdirSync(dirname(HOISTED.savedPath), { recursive: true })
            writeFileSync(HOISTED.savedPath, Buffer.from(HOISTED.pngBase64, "base64"))
            return { path: HOISTED.savedPath } as HostCommandMap[K]["result"]
          }
          return bridge.request(method, args, options)
        },
      }
      return wrapped as HostBridge
    },
  }
})

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }),
  releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4,
  permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {},
  retryBorrowerAttachIfPending: async () => {},
  failNextReleasesForTest: () => {},
}))

let root = ""

function resetCommandSpies(): void {
  HOISTED.captureCalls = 0
  HOISTED.saveCalls = 0
  HOISTED.saveArgs = []
  HOISTED.invoked = []
  HOISTED.savedPath = join(root, "screenshots", "1700000000000.png")
}

/** 某条条目上的 `deskpetImagePaths`（没有该字段返回 undefined）。 */
function entryImagePaths(entry: unknown): string[] | undefined {
  return (entry as { message?: { deskpetImagePaths?: string[] } } | undefined)?.message?.deskpetImagePaths
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-screenshot-tool-"))
  setTestDataRoot(root)
  await initPaths()
})

beforeEach(async () => {
  await standardSetup()
  resetCommandSpies()
})

afterEach(() => {
  resetPiRuntimeProviderForTest()
  rmSync(HOISTED.savedPath, { force: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("截图工具与助手消息挂接", () => {
  it("总闸关闭：中性说明、不触达采集与落盘 [screenshot-gate-neutral]", async () => {
    setOverrides({ "ai.silentAccess.enabled": false })
    await flushConfig()
    const tool = getToolByName("screenshot")
    expect(tool, "截图工具未注册，断言没有前提").toBeDefined()

    const result = await executeToolDefinition(tool!, { show_to_user: true }, {})
    expect(result.success, "总闸关闭不是执行失败").toBe(true)
    expect(result.content, "总闸关闭没有给出中性说明").toContain("静默访问未开启")
    expect(result.content, "中性说明不应声称已完成截图").not.toContain("已截取")
    // 执行层会在 details 里附审计块，这里断言的是「没有可挂接的截图路径」——
    // 挂接链只认 screenshotPath，它缺席即不会产生任何助手条目图片。
    expect((result.details as { screenshotPath?: unknown } | undefined)?.screenshotPath, "总闸关闭时不应产生截图挂接路径").toBeUndefined()
    expect(HOISTED.invoked, "总闸关闭仍调用了 Rust 命令").not.toContain("capture_screenshot")
    expect(HOISTED.captureCalls, "总闸关闭仍执行了采集").toBe(0)
    expect(HOISTED.saveCalls, "总闸关闭仍执行了落盘").toBe(0)
  })

  it("show_to_user：先落盘后条目，路径随条目重载、模型收到图片 [screenshot-show-to-user-attach]", async () => {
    setOverrides({ "ai.silentAccess.enabled": true })
    await flushConfig()

    const provider = installFakeProvider([
      fakeToolCall("screenshot", { show_to_user: true }, "call-shot"),
      fakeText("你看这个画面"),
    ])
    const output = await runRuntimeTurn("帮我看看现在的画面")

    // ① 工具真实跑通采集 + 落盘，落盘拿到的是采集输出的同一份 base64。
    expect(HOISTED.captureCalls, "截图工具没有执行采集").toBe(1)
    expect(HOISTED.saveCalls, "截图工具没有执行落盘").toBe(1)
    expect(HOISTED.saveArgs[0]?.imageBase64, "落盘命令没有拿到实际采集的 base64").toBe(HOISTED.pngBase64)

    // ② 模型收到图片结果块（她自己看得见）。
    const toolResultMessage = provider.payloads[1]?.messages.find(message =>
      message.role === "toolResult" && (message as { toolName?: string }).toolName === "screenshot")
    const imagePart = Array.isArray(toolResultMessage?.content)
      ? toolResultMessage.content.find(part => part.type === "image")
      : undefined
    expect(imagePart, "后续请求里没有截图工具结果的图片块").toMatchObject({ type: "image", mimeType: "image/png", data: HOISTED.pngBase64 })

    // ③ 条目只记路径元数据；base64 不进助手条目。
    const entries = await sessionEntries()
    const assistantEntries = entries.filter((entry): entry is Extract<typeof entry, { type: "message" }> =>
      entry.type === "message" && entry.message.role === "assistant")
    const withImage = assistantEntries.filter(entry => entryImagePaths(entry)?.length)
    expect(withImage.length, "带图助手条目不是恰好一条").toBe(1)
    expect(withImage[0]?.id, "带图条目不是本回合提交的最终助手条目").toBe(output.committedAssistantEntryId)
    expect(entryImagePaths(withImage[0]), "条目缺少落盘返回的截图路径").toEqual([HOISTED.savedPath])
    expect(JSON.stringify(withImage[0]?.message).includes(HOISTED.pngBase64),
      "截图 base64 不得进入助手条目").toBe(false)

    // ④ 结算回传与重载投影带回同一份路径。
    expect(output.userImagePaths, "结算没有回传界面展示所需的路径").toEqual([HOISTED.savedPath])
    const reloaded = (await sessionMessages()).find(message => message.eventId === output.committedAssistantEntryId)
    expect(reloaded?.imagePaths, "重载没有从 JSONL 带回截图路径").toEqual([HOISTED.savedPath])

    // ⑤ 下一回合不携带上一回合的截图路径（路径按回合状态取走，不跨 run 泄漏）。
    const second = installFakeProvider([fakeText("那继续吧")])
    const secondOutput = await runRuntimeTurn("继续")
    expect(secondOutput.userImagePaths, "截图路径泄漏到了下一个回合").toBeUndefined()
    const secondEntries = await sessionEntries()
    const secondEntry = secondEntries.find(entry => entry.type === "message" && entry.id === secondOutput.committedAssistantEntryId)
    expect(entryImagePaths(secondEntry), "下一个回合的条目被挂上了上一回合的截图").toBeUndefined()
    expect(second.payloads.length, "第二个回合没有发起请求").toBe(1)

    // ⑥ 文件被删除：条目与读模型保留原路径（不缓存、不复制），界面据此显示不可用。
    rmSync(HOISTED.savedPath, { force: true })
    const afterDelete = (await sessionMessages()).find(message => message.eventId === output.committedAssistantEntryId)
    expect(afterDelete?.imagePaths, "原文件删除后路径消失（应保留并显示不可用）").toEqual([HOISTED.savedPath])
  }, 60_000)

  it("show_to_user 缺省：工具照常执行、模型看得见，但条目与界面不带路径 [screenshot-default-private]", async () => {
    setOverrides({ "ai.silentAccess.enabled": true })
    await flushConfig()

    const provider = installFakeProvider([
      fakeToolCall("screenshot", {}, "call-shot-private"),
      fakeText("好的"),
    ])
    const output = await runRuntimeTurn("你自己看一眼就好")

    expect(HOISTED.captureCalls, "缺省 show_to_user 时没有执行采集").toBe(1)
    const toolResultMessage = provider.payloads[1]?.messages.find(message =>
      message.role === "toolResult" && (message as { toolName?: string }).toolName === "screenshot")
    const imagePart = Array.isArray(toolResultMessage?.content)
      ? toolResultMessage.content.find(part => part.type === "image")
      : undefined
    expect(imagePart, "缺省时模型没有收到图片（她应该自己看得见）").toMatchObject({ type: "image", data: HOISTED.pngBase64 })

    expect(output.userImagePaths, "缺省 show_to_user 仍宣称要展示给用户").toBeUndefined()
    const entries = await sessionEntries()
    const attached = entries.filter(entry => entry.type === "message" && entry.message.role === "assistant" && entryImagePaths(entry)?.length)
    expect(attached.length, "缺省 show_to_user 的截图被挂进了聊天条目").toBe(0)
  }, 60_000)
})
