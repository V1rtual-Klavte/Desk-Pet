// ==========================================
// 受控启动信息（src/services/host/connection.ts 的 readLaunchInfo）
// ==========================================
//
// Node 只能由原生宿主拉起：端点与一次性握手值只从环境变量 `DESKPET_HOST_LAUNCH`
// 读，缺失/损坏是致命错误，不许静默降级出默认端点 —— 否则 Node 会连到错误的
// 地址或带着空 token 握手，故障表现为超时而不是明确的接线错误。
//
// 真 socket 握手（connect/两条通道/背压）需要真连接，不在本文件覆盖。

import { afterEach, describe, expect, it } from "vitest"

import { LAUNCH_ENV_VAR, readLaunchInfo } from "@/services/host"

const VALID = {
  endpoint: "/tmp/deskpet-host.sock",
  handshake: "one-shot-token",
  entry: "/Applications/DeskPet/main.mjs",
  nodeBinary: "/Applications/DeskPet/node",
}

const restoreEnv = process.env[LAUNCH_ENV_VAR]
afterEach(() => {
  if (restoreEnv === undefined) delete process.env[LAUNCH_ENV_VAR]
  else process.env[LAUNCH_ENV_VAR] = restoreEnv
})

describe("readLaunchInfo", () => {
  it("缺失或空启动信息按 LAUNCH_INFO_MISSING 报错，不退化出默认端点", () => {
    expect(() => readLaunchInfo({})).toThrowError(
      expect.objectContaining({ name: "HostCommandError", code: "LAUNCH_INFO_MISSING" }),
    )
    expect(() => readLaunchInfo({ [LAUNCH_ENV_VAR]: "" })).toThrowError(
      expect.objectContaining({ code: "LAUNCH_INFO_MISSING" }),
    )
  })

  it("坏 JSON 与字段不完整按 LAUNCH_INFO_MALFORMED 报错", () => {
    expect(() => readLaunchInfo({ [LAUNCH_ENV_VAR]: "{not json" })).toThrowError(
      expect.objectContaining({ name: "HostCommandError", code: "LAUNCH_INFO_MALFORMED" }),
    )
    expect(() => readLaunchInfo({ [LAUNCH_ENV_VAR]: JSON.stringify({ endpoint: "/tmp/x.sock" }) })).toThrowError(
      expect.objectContaining({ code: "LAUNCH_INFO_MALFORMED" }),
    )
    expect(() =>
      readLaunchInfo({ [LAUNCH_ENV_VAR]: JSON.stringify({ ...VALID, handshake: 42 }) }),
    ).toThrowError(expect.objectContaining({ code: "LAUNCH_INFO_MALFORMED" }))
  })

  it("合法启动信息逐字段读出", () => {
    expect(readLaunchInfo({ [LAUNCH_ENV_VAR]: JSON.stringify(VALID) })).toEqual(VALID)
  })

  it("缺省读取进程环境变量（调用方不必自己传 env）", () => {
    process.env[LAUNCH_ENV_VAR] = JSON.stringify(VALID)
    expect(readLaunchInfo().handshake).toBe(VALID.handshake)
  })
})
