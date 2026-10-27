// ==========================================
// /clear —— 新建会话并清空当前对话（L3）
// ==========================================
//
// 命令层只把 `/clear` 交给 `createNewSession`；真正要证的是用户看得见的结果：
// 活跃会话换了一条新会话、旧会话文件仍在（清空不是删除）、当前对话视图与未回复计数归零、
// 给用户的回执来自命令而不是「命令执行出错…」。用真实临时数据根与真会话仓库：
// 只断言返回值会把「换了指针但没落盘」「旧会话被删掉」这类偏差放过去。
//
// 命令注册走 `initSlashCommands`（产品同一入口），preProcess 是唯一执行入口；
// 不直接调 clearCommand.execute，否则「命令真能在输入链上被找到」没有被验证。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import type { Message } from "@/services/agent/types"
import { preProcess } from "@/services/engine/preprocessor"
import { initPaths } from "@/services/paths"
import {
  chatHistory,
  createNewSession,
  getActiveSessionId,
  listPiSessionMetadata,
  sessions,
  unansweredCount,
} from "@/services/session"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-slash-clear-"))
  setTestDataRoot(root)
  await initPaths()
  // 真实命令表的装配会拉起各命令所属域；数据根就绪后再加载。
  const { initSlashCommands } = await import("@/services/engine/slash/commands")
  initSlashCommands()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("/clear 命令", () => {
  it("新建会话、清空当前对话，旧会话文件保留 [slash-clear-new-session]", async () => {
    const first = await createNewSession()
    const stale: Message = {
      id: "clear-probe-message",
      role: "user",
      text: "清空前的探针消息",
      timestamp: Date.now(),
    }
    chatHistory.push(stale)
    unansweredCount.value = 2

    const result = await preProcess("/clear")

    expect(result.handled, "/clear 没有被命令表识别").toBe(true)
    expect(result.response, "/clear 没有给出可展示的回执").toBeTruthy()
    expect(result.response ?? "", "/clear 落到了命令异常兜底").not.toBe("命令执行出错…")

    const activeId = getActiveSessionId()
    expect(activeId, "/clear 没有建立新的活跃会话").not.toBe("")
    expect(activeId, "/clear 后活跃会话仍是原来那条").not.toBe(first.id)
    expect(sessions.map(session => session.id), "旧会话被从列表里移除（清空不是删除）").toContain(first.id)

    const persisted = (await listPiSessionMetadata()).map(meta => meta.id)
    expect(persisted, "旧会话文件没有保留在会话仓库里").toContain(first.id)
    expect(persisted, "新会话没有真正落盘").toContain(activeId)

    expect(chatHistory, "/clear 没有清空当前对话视图").toHaveLength(0)
    expect(unansweredCount.value, "/clear 没有清零未回复计数").toBe(0)
  })
})
