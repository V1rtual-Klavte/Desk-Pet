// ==========================================
// V1RTUAL 落盘 —— 清空是一次真实修改
// ==========================================
//
// 保存路径若把空值当「没改过」跳过，用户清空文本框后旧指令仍留在文件里继续进
// prompt，界面上却显示「已保存」。这条只在真写盘上现形（解析层看不出），所以归 L3。

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { initPaths, runtimePath } from "@/services/paths"
import {
  getV1rtualInstructionsSync,
  loadV1rtualInstructions,
  resetV1rtualInstructionsForTest,
  updateV1rtualInstructions,
} from "@/services/context/instructions"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-v1rtual-write-"))
  setTestDataRoot(root)
  await initPaths()
})

beforeEach(() => {
  resetV1rtualInstructionsForTest()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("V1RTUAL 落盘", () => {
  it("空串把指令清干净，磁盘与提示块都不再留旧内容", async () => {
    const path = await runtimePath("memory", "V1RTUAL.md")

    expect(await updateV1rtualInstructions("叫我小明")).toBe(true)
    expect(readFileSync(path, "utf8"), "指令没有写进文件").toContain("叫我小明")
    expect(getV1rtualInstructionsSync(), "写入的指令没有进提示块").toContain("叫我小明")

    expect(await updateV1rtualInstructions("   ")).toBe(true)
    expect(readFileSync(path, "utf8"), "清空后文件里仍留着旧指令").not.toContain("叫我小明")
    expect(getV1rtualInstructionsSync(), "清空后旧指令还留在提示块里").toBe("")

    // 启动与进设置页走的都是这条读取路径：清空的结果必须能被它复现。
    await loadV1rtualInstructions()
    expect(getV1rtualInstructionsSync(), "重新读取又把旧指令读回来了").toBe("")
  })

  it("内容没变的重复保存不重写文件（_最后更新 不刷新）", async () => {
    const path = await runtimePath("memory", "V1RTUAL.md")

    await updateV1rtualInstructions("叫我小明")
    const first = readFileSync(path, "utf8")
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await updateV1rtualInstructions("叫我小明")).toBe(true)
    expect(readFileSync(path, "utf8"), "内容没变却重写了文件").toBe(first)
  })
})
