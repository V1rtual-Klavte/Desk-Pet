// ==========================================
// 系统字体枚举（src/services/font.ts）
// ==========================================
//
// 全局字体的真值在 CONFIG（appearance.font），本模块只是 Rust `list_system_fonts`
// 的 Node 取用口：成功的列表要缓存（设置页反复打开不重复全盘扫描），
// 失败要如实返回空列表**且不缓存失败**（否则一次抖动会让字体下拉永久为空）。
//
// 桥用记录型替身：只断言「命令名、调用次数、缓存语义」，不假装是真宿主字体枚举。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { listSystemFonts } from "@/services/font"

let root = ""
let mode: "fail" | "ok" = "fail"
const requests: string[] = []
const FONTS = ["Alibaba PuHuiTi", "PingFang SC"]

const bridge = {
  async request(method: string) {
    // 本用例的断言只关心字体枚举的请求次数：日志转发（log_messages）是后台
    // 缓冲的周期 flush，何时掺进来与时序有关，过滤掉以免精确序列断言偶发红。
    if (method !== "log_messages") requests.push(method)
    if (mode === "fail") throw Object.assign(new Error("枚举系统字体失败"), { code: "FONT" })
    return FONTS
  },
  subscribe: () => () => {},
  async readBlob() {
    return new Uint8Array()
  },
  async releaseBlob() {},
} as unknown as HostBridge

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-font-"))
  setTestDataRoot(root)
  setHostBridge(bridge)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("系统字体列表", () => {
  it("失败返回空列表且不缓存，成功结果缓存并只请求一次", async () => {
    expect(await listSystemFonts()).toEqual([])
    expect(await listSystemFonts()).toEqual([])
    // 失败若被缓存成 []，第二次调用不会再请求 —— 这里必须看到两次尝试
    expect(requests).toEqual(["list_system_fonts", "list_system_fonts"])

    mode = "ok"
    expect(await listSystemFonts()).toEqual(FONTS)
    expect(await listSystemFonts()).toEqual(FONTS)
    // 成功结果进缓存：不再新增请求
    expect(requests).toEqual(["list_system_fonts", "list_system_fonts", "list_system_fonts"])
  })
})
