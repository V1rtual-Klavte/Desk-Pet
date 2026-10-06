// ==========================================
// 设置页管理面（工具 / 外观 / 通用页）—— 参数校验、真分支与返回值形状（L2）
// ==========================================
//
// 归属 L2 的依据：这些处理器都是「读 CONFIG / 既有领域入口 → 组装行 → 经桥回执」的
// 编排；用记录型假桥（请求记录 + 可注入的 Profile / 文件 / 对话框应答）即可观测
// 「校验是否在领域调用前拒绝、写了什么、返回什么形状」，不启动 Harness、不用真实
// Provider、不需要真会话文件。文件系统类命令由假桥应答，真落盘行为属于 L3/L4。
//
// 被测行为：
//   · settings_defaults / config_export / config_import：默认值取自内置模板（不是运行时
//     覆写）、取消是正常结果、导入失败如实抛；
//   · MCP：列表行投影（命令摘要、白名单摘要）、开关写盘、CONFIG 直改条目的
//     逐字段 schema 拒绝、表单读数与保存（字段逐项校验、重名报错、改名换坐标、
//     删除）、测试的「关闭不连接」短路、导入导出成功与取消；
//   · Skill：索引不可用时列表为空但如实带 error；开关缺 frontmatter 时拒绝且不写盘；
//   · Profile：列表跳过 meta 读不到的目录；
//   · 音效：库/分配行与试听；分配非法事件与非法音效 ID 如实拒绝，合法写入落 CONFIG。

import { load as loadYaml } from "js-yaml"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { flushConfig, initConfig, setOverride } from "@/services/config"
import { soundEvents } from "@/services/audio"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { dispatchHostRequest } from "@/services/native-ui"
import { initPaths } from "@/services/paths"

/**
 * 最小合法 CONFIG：四根齐全；MCP 自定义服务器就位（用来走列表、文档与编辑分支），
 * 音效分配刻意只写一项（其余走默认值，验证「缺省补默认」的读法）。
 */
const CONFIG_YAML = `
general:
  popup:
    mode: cursor
    autoPopupOnMessage: false
    defaultSize: { w: 730, h: 450 }
    chatWidth: 220
  shortcut:
    key: P
    macModifiers: [Control, Command]
    winModifiers: [Control, Alt]
  logging: { level: info }
  errors: { overlay: auto }
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
  loop: { maxRetry: 3, subAgentRounds: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  plan: { enabled: false }
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { frequency: "off" }
tools:
  bash: { whitelist: [ls, cat] }
  mcp:
    servers:
      - { name: demo-custom, transport: http, url: "http://127.0.0.1:9/mcp", excludeTools: [noisy], enabled: true }
      - { name: off-server, transport: stdio, command: npx, args: ["-y", "off-mcp"], enabled: false }
appearance:
  activeProfile: demo-profile
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: "", size: 15 }
  chatImagePreview: false
  soundAssignments: { send: send_short }
`

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/** 假桥的可注入应答（每个用例前重置；只在用例内部改与会话相关的条目）。 */
const fixtures = {
  profileYaml: "meta: {name: Demo, description: 演示, version: 1}\n",
  profileIds: ["good", "broken"],
  profileFiles: new Map<string, string | null>(),
  fileReadContent: "正文没有 frontmatter",
  fileReadError: false,
  pickOpen: null as string | null,
  pickSave: null as string | null,
  fingerprintFails: true,
  /** MCP 凭据状态（只回变量名；Rust 侧同名命令只回名字、不回值）。 */
  credentialVars: [] as string[],
  credentialStatusError: false,
}

function createBridge() {
  const calls: RecordedCall[] = []
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      calls.push({ method, args })
      switch (method) {
        case "read_runtime_config":
          return CONFIG_YAML
        case "write_runtime_config":
          return null
        case "get_runtime_paths":
          return {
            data: "/fake/data",
            memory: "/fake/data/memory",
            sessions: "/fake/data/sessions",
            personality: "/fake/data/personality",
            profiles: "/fake/data/profiles",
            settings: "/fake/data/settings",
            configFile: "/fake/data/settings/CONFIG.yaml",
            runtimeMode: "development",
          }
        case "resolve_runtime_path":
          return `/${String(args.scope)}/${(args.segments as string[]).join("/")}`
        case "list_profiles":
          return fixtures.profileIds
        case "profile_file_read": {
          const profileId = String(args.profileId)
          if (fixtures.profileFiles.has(profileId)) {
            const content = fixtures.profileFiles.get(profileId)
            if (content === null) {
              throw Object.assign(new Error(`文件不存在: ${profileId}/profile.yaml`), { code: "PATH_NOT_FOUND" })
            }
            return new TextEncoder().encode(content!)
          }
          return new TextEncoder().encode(fixtures.profileYaml)
        }
        case "profile_file_write":
          return null
        case "file_read":
          if (fixtures.fileReadError) throw Object.assign(new Error("测试注入：读取失败"), { code: "IO" })
          return { content: fixtures.fileReadContent }
        case "file_write_atomic":
        case "file_write":
          return null
        case "pick_file_open":
          return fixtures.pickOpen
        case "pick_file_save":
          return fixtures.pickSave
        case "skill_catalog_fingerprint":
          if (fixtures.fingerprintFails) throw new Error("测试注入：Skill 目录不可读")
          return { fingerprint: "fp-1", truncated: false }
        case "mcp_credential_status":
          if (fixtures.credentialStatusError) {
            throw Object.assign(new Error("测试注入：凭据状态读取失败"), { code: "OTHER" })
          }
          return fixtures.credentialVars
        case "audio_play_wav":
          return null
        default:
          return null
      }
    },
    subscribe() {
      throw new Error("测试假桥没有事件通道")
    },
    async readBlob() {
      throw new Error("测试假桥不提供 blob")
    },
    async releaseBlob() {},
  } as unknown as HostBridge
  return { bridge, calls }
}

const recorder = createBridge()
const calls = recorder.calls

function recorded(method: string): RecordedCall[] {
  return calls.filter(call => call.method === method)
}

/** 最后一次 `write_runtime_config` 的内容（没有写盘时直接红）。 */
function lastWrittenConfig(): Record<string, any> {
  const writes = recorded("write_runtime_config")
  expect(writes.length, "本用例应发生 CONFIG 写盘").toBeGreaterThan(0)
  return loadYaml(String(writes[writes.length - 1]!.args.content)) as Record<string, any>
}

/** 显式设定自定义服务器表：MCP 用例之间不靠先前的写盘残留互相耦合。 */
function setCustomServers(servers: Array<Record<string, unknown>>): void {
  setOverride("tools.mcp.servers", servers)
}

beforeAll(async () => {
  setHostBridge(recorder.bridge)
  await initPaths()
  await initConfig()
})

beforeEach(() => {
  calls.length = 0
  fixtures.profileYaml = "meta: {name: Demo, description: 演示, version: 1}\n"
  fixtures.profileIds = ["good", "broken"]
  fixtures.profileFiles = new Map<string, string | null>([["good", "meta: {name: Good, description: 好的}\n"], ["broken", null]])
  fixtures.fileReadContent = "正文没有 frontmatter"
  fixtures.fileReadError = false
  fixtures.pickOpen = null
  fixtures.pickSave = null
  fixtures.fingerprintFails = true
  fixtures.credentialVars = []
  fixtures.credentialStatusError = false
})

afterAll(() => {
  setHostBridge(null)
})

describe("通用页：默认值 / 导入导出", () => {
  it("settings_defaults 取内置模板而不是运行时覆写（默认值与现值分开）", async () => {
    setOverride("general.popup.chatWidth", 333)
    const payload = (await dispatchHostRequest("settings_defaults", {})) as { values: Record<string, unknown> }
    // 模板里 chatWidth=266；现值已被覆写成 333 —— 默认值面必须仍报模板值。
    expect(payload.values["general.popup.chatWidth"]).toBe(266)
    expect(payload.values["ai.conversation.defaultDelivery"]).toBe("steer")
    // 键 = CONFIG 路径（嵌套展开），与 settings_read 同形。
    expect(payload.values["general.popup.defaultSize.w"]).toBe(673)
  })

  it("config_export：保存取消是正常结果（saved=false），不写文件", async () => {
    fixtures.pickSave = null
    const payload = await dispatchHostRequest("config_export", {})
    expect(payload).toEqual({ saved: false, path: null })
    expect(recorded("pick_file_save")).toHaveLength(1)
    expect(recorded("file_write")).toHaveLength(0)
  })

  it("config_export：选定路径后经既有 file_write 落盘 YAML", async () => {
    fixtures.pickSave = "/fake/out/deskpet-config.yaml"
    const payload = await dispatchHostRequest("config_export", {})
    expect(payload).toEqual({ saved: true, path: "/fake/out/deskpet-config.yaml" })
    const writes = recorded("file_write")
    expect(writes).toHaveLength(1)
    expect(writes[0]!.args.path).toBe("/fake/out/deskpet-config.yaml")
    expect(String(writes[0]!.args.content)).toContain("general:")
  })

  it("config_import：取消返回 imported=false 且不读文件", async () => {
    fixtures.pickOpen = null
    const payload = await dispatchHostRequest("config_import", {})
    expect(payload).toEqual({ imported: false })
    expect(recorded("file_read")).toHaveLength(0)
    expect(recorded("write_runtime_config")).toHaveLength(0)
  })

  it("config_import：非法配置如实抛错，不替换内存配置、不写盘", async () => {
    fixtures.pickOpen = "/fake/bad.yaml"
    fixtures.fileReadContent = "general: {}\n"
    await expect(dispatchHostRequest("config_import", {})).rejects.toThrow(/general\/ai\/tools\/appearance/)
    expect(recorded("write_runtime_config")).toHaveLength(0)
  })
})

describe("工具页：MCP 服务器行与开关", () => {
  it("tools_mcp_servers：行按服务器表顺序投影；命令摘要与白名单摘要逐字段组装", async () => {
    const payload = (await dispatchHostRequest("tools_mcp_servers", {})) as {
      rows: Array<{ id: string; title: string; subtitle: string; action: string; action2?: string; enabled: boolean }>
    }
    expect(payload.rows.map(row => row.id)).toEqual(["demo-custom", "off-server"])
    expect(payload.rows[0]).toMatchObject({
      title: "demo-custom",
      subtitle: "http http://127.0.0.1:9/mcp · 排除 1 项",
      action: "toggle",
      action2: "edit",
      enabled: true,
    })
    expect(payload.rows[1]).toMatchObject({ title: "off-server", subtitle: "npx -y off-mcp", enabled: false })
  })

  it("CONFIG 直改条目非法即拒（不再 String()/默认 true 收拢）[native-ui-mcp-config-strict]", async () => {
    // 「enabled: "false"」是旧实现最危险的一类：字符串被收成 true（静默启用）。现在读取期拒绝。
    setCustomServers([{ name: "strict", transport: "stdio", command: "npx", enabled: "false" }])
    await expect(
      dispatchHostRequest("tools_mcp_servers", {}),
      "enabled 非布尔必须拒绝，不能静默读成启用",
    ).rejects.toMatchObject({ code: "CONFIG", message: expect.stringMatching(/enabled/) })

    // transport 缺失 / 非法：不再「非 http 一律按 stdio」，sse 点名拒绝。
    setCustomServers([{ name: "strict", command: "npx", enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toMatchObject({ code: "CONFIG" })
    setCustomServers([{ name: "strict", transport: "ws", command: "npx", enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toMatchObject({ code: "CONFIG" })
    setCustomServers([{ name: "strict", transport: "sse", url: "http://127.0.0.1:9/mcp", enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toThrow(/sse 已弃用/)

    // 跨字段一致性同样在读取期拒绝：stdio 必须有 command、http 必须有 url。
    setCustomServers([{ name: "strict", transport: "stdio", enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toThrow(/command/)
    setCustomServers([{ name: "strict", transport: "http", enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toThrow(/url/)

    // 逐字段类型：args 标量不静默包成单元素数组；env 值必须是字符串；名字必填。
    setCustomServers([{ name: "strict", transport: "stdio", command: "npx", args: "-y pkg", enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toMatchObject({ code: "CONFIG" })
    setCustomServers([{ name: "strict", transport: "stdio", command: "npx", env: { PORT: 3000 }, enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toMatchObject({ code: "CONFIG" })
    setCustomServers([{ transport: "stdio", command: "npx", enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toMatchObject({ code: "CONFIG" })

    // 错误信息点名条目与字段（直改 CONFIG 的用户能直接定位）。
    setCustomServers([{ name: "named-entry", transport: "ws", command: "npx", enabled: true }])
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toThrow(/named-entry/)

    // 修正后读取恢复（报错不留「过期列表」缓存）。
    setCustomServers([{ name: "strict", transport: "stdio", command: "npx", enabled: true }])
    const fixed = (await dispatchHostRequest("tools_mcp_servers", {})) as { rows: Array<{ id: string }> }
    expect(fixed.rows.map(row => row.id)).toEqual(["strict"])
  })

  it("tools_mcp_toggle：按名改 enabled 并经 setMcpServers 写回 CONFIG；未知 id 以 PATH_NOT_FOUND 拒绝", async () => {
    setCustomServers([
      { name: "demo-custom", transport: "http", url: "http://127.0.0.1:9/mcp", enabled: true },
      { name: "off-server", transport: "stdio", command: "npx", args: ["-y", "off-mcp"], enabled: false },
    ])
    await dispatchHostRequest("tools_mcp_toggle", { id: "demo-custom", enabled: false })
    let servers = lastWrittenConfig().tools.mcp.servers as Array<{ name: string; enabled: boolean; args?: string[] }>
    expect(servers.find(server => server.name === "demo-custom")?.enabled).toBe(false)
    // 同一列表的其它服务器与其字段原样保留（开关只改目标项的 enabled）。
    expect(servers.find(server => server.name === "off-server")?.args).toEqual(["-y", "off-mcp"])

    await dispatchHostRequest("tools_mcp_toggle", { id: "off-server", enabled: true })
    servers = lastWrittenConfig().tools.mcp.servers as Array<{ name: string; enabled: boolean }>
    expect(servers.find(server => server.name === "off-server")?.enabled).toBe(true)
    expect(servers.find(server => server.name === "demo-custom")?.enabled).toBe(false)

    await expect(
      dispatchHostRequest("tools_mcp_toggle", { id: "no-such-server", enabled: true }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    await expect(
      dispatchHostRequest("tools_mcp_toggle", { id: "demo-custom" }),
      "缺 enabled 布尔字段应拒绝",
    ).rejects.toMatchObject({ code: "CONFIG" })
  })
})

describe("工具页：MCP 凭据（GitHub 令牌）", () => {
  const GITHUB_ENTRY = {
    name: "github",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    enabled: false,
  }

  it("tools_mcp_servers：github 条目存在时附令牌行，状态取 mcp_credential_status（只有名单、没有值） [native-ui-mcp-credential-row]", async () => {
    setCustomServers([GITHUB_ENTRY])
    fixtures.credentialVars = []
    const unset = (await dispatchHostRequest("tools_mcp_servers", {})) as {
      rows: Array<{ id: string; title: string; subtitle: string; action: string }>
    }
    // 服务器行在前、凭据行在后（凭据设置的是 github 服务器的 GITHUB_TOKEN）。
    expect(unset.rows.map(row => row.id)).toEqual(["github", "credential:github:GITHUB_TOKEN"])
    expect(unset.rows[1]).toMatchObject({ title: "GitHub 令牌", action: "credential" })
    expect(unset.rows[1]?.subtitle).toContain("未设置")
    // 状态只经宿主命令读（坐标固定为内置 github 的 GITHUB_TOKEN）。
    expect(recorded("mcp_credential_status")).toEqual([
      { method: "mcp_credential_status", args: { server: "github" } },
    ])

    // 已设置：状态翻转，行里仍然只有变量名、没有值。
    fixtures.credentialVars = ["GITHUB_TOKEN"]
    const set = (await dispatchHostRequest("tools_mcp_servers", {})) as {
      rows: Array<{ title: string; subtitle: string }>
    }
    expect(set.rows[1]?.subtitle).toContain("已设置")
    expect(set.rows[1]?.subtitle).toContain("不回显")

    // github 条目被删掉：不产出令牌行（没有条目引用该变量，设置了也不生效）。
    setCustomServers([{ name: "demo-custom", transport: "http", url: "http://127.0.0.1:9/mcp", enabled: true }])
    const absent = (await dispatchHostRequest("tools_mcp_servers", {})) as { rows: Array<{ id: string }> }
    expect(absent.rows.map(row => row.id)).toEqual(["demo-custom"])

    // 状态读取失败如实抛出（面板呈现「列表读取失败」），不把故障画成「未设置」。
    setCustomServers([GITHUB_ENTRY])
    fixtures.credentialStatusError = true
    await expect(dispatchHostRequest("tools_mcp_servers", {})).rejects.toMatchObject({ code: "OTHER" })
  })

  it("mcp_credential_write：行坐标解析回 server/var 定向写宿主存储；空值/未知坐标拒绝且不写 CONFIG [native-ui-mcp-credential-write]", async () => {
    // 非法输入全部在发出宿主命令之前拦下：空值、未知坐标、缺 id。
    await expect(
      dispatchHostRequest("mcp_credential_write", { id: "credential:github:GITHUB_TOKEN", value: "   " }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("mcp_credential_write", { id: "credential:nope", value: "probe" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("mcp_credential_write", { value: "probe" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    expect(recorded("mcp_credential_set")).toHaveLength(0)

    await dispatchHostRequest("mcp_credential_write", {
      id: "credential:github:GITHUB_TOKEN",
      value: "probe-token",
    })
    // 值定向交给宿主命令（→ 应用自有存储），坐标由行 id 解析。
    expect(recorded("mcp_credential_set")).toEqual([
      { method: "mcp_credential_set", args: { server: "github", var: "GITHUB_TOKEN", value: "probe-token" } },
    ])
    // 凭据不写配置文件。
    expect(recorded("write_runtime_config")).toHaveLength(0)
  })
})

describe("工具页：MCP 表单 / 测试 / 导入导出", () => {
  it("mcp_server_form：缺省给新建模板；未知名拒绝；已有服务器逐字段渲染（env/headers 多行 KEY=VALUE）", async () => {
    const template = await dispatchHostRequest("mcp_server_form", {})
    expect(template).toEqual({
      name: "",
      transport: "stdio",
      command: "",
      args: "",
      url: "",
      env: "",
      headers: "",
      enabled: true,
    })

    await expect(dispatchHostRequest("mcp_server_form", { name: "nope" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
    await expect(dispatchHostRequest("mcp_server_form", { name: 42 })).rejects.toMatchObject({ code: "CONFIG" })

    // 本用例自带服务器表：表单渲染不与其他用例留下的 override 状态耦合。
    setCustomServers([{
      name: "demo-custom",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
      args: ["-y", "pkg"],
      env: { TOKEN: "abc" },
      headers: { "X-Api-Key": "demo-token", "X-Trace": "on" },
      excludeTools: ["noisy"],
      enabled: false,
    }])
    const custom = await dispatchHostRequest("mcp_server_form", { name: "demo-custom" })
    expect(custom).toEqual({
      name: "demo-custom",
      transport: "http",
      command: "",
      args: "-y\npkg",
      url: "http://127.0.0.1:9/mcp",
      env: "TOKEN=abc",
      // headers 与 env 同款 KEY=VALUE 行格式（与解析共用 manager 的 formatEnvText/parseEnvText）。
      headers: "X-Api-Key=demo-token\nX-Trace=on",
      enabled: false,
    })
    // 高级过滤字段不在表单里（表单不展示 includeTools/excludeTools）：渲染面即字段控件面。
    expect(Object.keys(custom as Record<string, unknown>)).not.toContain("excludeTools")
  })

  it("mcp_save：表单读数原样保存往返一致（含 env/headers）；改名换坐标保留原条目字段", async () => {
    setCustomServers([{
      name: "roundtrip",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
      env: { TOKEN: "abc" },
      headers: { "X-Api-Key": "demo-token" },
      includeTools: ["read"],
      enabled: true,
    }])
    const before = (await dispatchHostRequest("mcp_server_form", { name: "roundtrip" })) as {
      name: string
      transport: string
      command: string
      args: string
      url: string
      env: string
      headers: string
      enabled: boolean
    }
    await dispatchHostRequest("mcp_save", {
      originalName: "roundtrip",
      name: before.name,
      transport: before.transport,
      command: before.command,
      args: before.args,
      url: before.url,
      env: before.env,
      headers: before.headers,
      enabled: before.enabled,
    })
    const saved = (lastWrittenConfig().tools.mcp.servers as Array<Record<string, unknown>>).find(
      server => server.name === "roundtrip",
    )
    expect(saved?.env).toEqual({ TOKEN: "abc" })
    expect(saved?.headers).toEqual({ "X-Api-Key": "demo-token" })
    // 表单不覆盖的高级过滤字段在保存后原样保留。
    expect(saved?.includeTools).toEqual(["read"])
    // 再读一次：与保存前逐字段一致（导出配置再导入往返语义的读侧对照）。
    const after = await dispatchHostRequest("mcp_server_form", { name: "roundtrip" })
    expect(after).toEqual(before)

    // 改名：坐标换成新名字、老名字消失，条目字段（含过滤字段）随行走。
    await dispatchHostRequest("mcp_save", {
      originalName: "roundtrip",
      name: "roundtrip-2",
      transport: before.transport,
      command: before.command,
      args: before.args,
      url: before.url,
      env: before.env,
      headers: before.headers,
      enabled: before.enabled,
    })
    const renamed = lastWrittenConfig().tools.mcp.servers as Array<Record<string, unknown>>
    expect(renamed.map(server => server.name)).toContain("roundtrip-2")
    expect(renamed.map(server => server.name)).not.toContain("roundtrip")
    expect(renamed.find(server => server.name === "roundtrip-2")?.includeTools).toEqual(["read"])
  })

  it("mcp_save：字段逐项校验（缺字段 / 非法 transport / sse / stdio 缺 command / http 缺 url / 非法 enabled）", async () => {
    const base = {
      originalName: "",
      name: "probe",
      transport: "stdio",
      command: "npx",
      args: "",
      url: "",
      env: "",
      headers: "",
      enabled: true,
    }
    await expect(
      dispatchHostRequest("mcp_save", { ...base, transport: "ws" }),
      "transport 只认 stdio/http",
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("mcp_save", { ...base, transport: "sse", url: "http://127.0.0.1:9/mcp" }),
      "sse 已弃用：显式拒绝并给迁移指引",
    ).rejects.toThrow(/sse 已弃用/)
    await expect(
      dispatchHostRequest("mcp_save", { ...base, command: "" }),
      "stdio 必须有 command",
    ).rejects.toThrow(/stdio 服务器必须提供 command/)
    await expect(
      dispatchHostRequest("mcp_save", { ...base, transport: "http", command: "" }),
      "http 必须有 url",
    ).rejects.toThrow(/http 服务器必须提供 url/)
    await expect(
      dispatchHostRequest("mcp_save", { ...base, name: "   " }),
      "空名字拒绝",
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("mcp_save", { ...base, enabled: "yes" }),
      "enabled 非布尔拒绝",
    ).rejects.toMatchObject({ code: "CONFIG" })
    const { enabled: _enabled, ...withoutEnabled } = base
    await expect(
      dispatchHostRequest("mcp_save", withoutEnabled),
      "缺 enabled 字段拒绝",
    ).rejects.toMatchObject({ code: "CONFIG" })
    const { headers: _headers, ...withoutHeaders } = base
    await expect(
      dispatchHostRequest("mcp_save", withoutHeaders),
      "缺 headers 字段拒绝",
    ).rejects.toMatchObject({ code: "CONFIG" })
    // 全部拒绝路径都不得写盘。
    expect(recorded("write_runtime_config")).toHaveLength(0)
  })

  it("mcp_save：新增落盘（args 每行一个、env 行格式复用）；原条目不存在 PATH_NOT_FOUND [native-ui-mcp-form-save]", async () => {
    setCustomServers([{ name: "keep", transport: "stdio", command: "npx", enabled: false }])
    await dispatchHostRequest("mcp_save", {
      originalName: "",
      name: "brand-new",
      transport: "stdio",
      command: "npx",
      args: "-y\nnew-mcp",
      url: "",
      env: "A=1\nB=2",
      headers: "",
      enabled: true,
    })
    const servers = lastWrittenConfig().tools.mcp.servers as Array<{
      name: string
      args?: string[]
      env?: Record<string, string>
      enabled?: boolean
    }>
    const added = servers.find(server => server.name === "brand-new")
    expect(added?.args, "args 每行一个参数").toEqual(["-y", "new-mcp"])
    expect(added?.env, "env 复用 KEY=VALUE 行解析").toEqual({ A: "1", B: "2" })
    expect(added?.enabled).toBe(true)
    // 同一列表的其它条目原样保留。
    expect(servers.find(server => server.name === "keep")?.enabled).toBe(false)

    await expect(
      dispatchHostRequest("mcp_save", {
        originalName: "ghost",
        name: "whatever",
        transport: "stdio",
        command: "npx",
        args: "",
        url: "",
        env: "",
        headers: "",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
  })

  it("mcp_save：重名保存明确报错、不静默覆盖（新增撞名与改名撞名同一判据） [native-ui-mcp-form-duplicate-name]", async () => {
    setCustomServers([
      { name: "taken", transport: "stdio", command: "npx", args: ["old"], enabled: true },
      { name: "other", transport: "stdio", command: "npx", enabled: false },
    ])
    // 夹具自身的 setOverride 会排队写一次配置（queueConfigSave 的微任务）——先让它落定、
    // 再把调用记录清零；否则断言会把夹具产物当「拒绝路径写了盘」的证据（首跑即红的原因）。
    await flushConfig()
    calls.length = 0
    const fields = { transport: "stdio", command: "npx", args: "", url: "", env: "", headers: "", enabled: true }
    await expect(
      dispatchHostRequest("mcp_save", { originalName: "", name: "taken", ...fields }),
      "新增撞名：明确报错（旧行为是静默 Object.assign 覆盖）",
    ).rejects.toMatchObject({
      code: "CONFIG",
      message: expect.stringMatching(/已被占用.*taken/),
    })
    await expect(
      dispatchHostRequest("mcp_save", { originalName: "other", name: "taken", ...fields }),
      "改名撞名：同一判据",
    ).rejects.toMatchObject({ code: "CONFIG" })
    // 全部拒绝路径不得写盘；原条目字段保持原样（没有被静默覆盖）。
    expect(recorded("write_runtime_config")).toHaveLength(0)
    const untouched = await dispatchHostRequest("mcp_server_form", { name: "taken" })
    expect((untouched as { args: string }).args).toBe("old")
  })

  it("mcp_delete：未知名字以 PATH_NOT_FOUND 拒绝、缺 name 拒绝；mcp_test：关闭的服务器短路为 ok=false", async () => {
    await expect(dispatchHostRequest("mcp_delete", { name: "no-such" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
    await expect(dispatchHostRequest("mcp_delete", {})).rejects.toMatchObject({ code: "CONFIG" })

    await expect(dispatchHostRequest("mcp_test", {})).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("mcp_test", { name: "no-such" })).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    setCustomServers([{ name: "off-server", transport: "stdio", command: "npx", enabled: false }])
    const disabled = await dispatchHostRequest("mcp_test", { name: "off-server" })
    expect(disabled).toMatchObject({ ok: false })
    expect((disabled as { message: string }).message).toContain("关闭")
  })

  it("mcp_import：取消与导入 0 条分开；非法 JSON 与 sse 条目如实拒绝；http/headers 认 type 字段导入", async () => {
    fixtures.pickOpen = null
    expect(await dispatchHostRequest("mcp_import", {})).toEqual({ imported: 0, canceled: true })

    fixtures.pickOpen = "/fake/mcp.json"
    fixtures.fileReadContent = "这不是 JSON"
    await expect(dispatchHostRequest("mcp_import", {})).rejects.toMatchObject({ code: "CONFIG" })
    expect(recorded("write_runtime_config")).toHaveLength(0)

    // 外部客户端导出的 JSON 常用 item.type 表达传输方式：http 认它，headers 一并落盘。
    fixtures.fileReadContent = JSON.stringify([
      { name: "imported-server", transport: "stdio", command: "npx" },
      { name: "imported-http", type: "http", url: "http://127.0.0.1:9/mcp", headers: { "X-Api-Key": "tok" } },
    ])
    const imported = await dispatchHostRequest("mcp_import", {})
    expect(imported).toEqual({ imported: 2, canceled: false })
    const servers = lastWrittenConfig().tools.mcp.servers as Array<{
      name: string
      transport?: string
      headers?: Record<string, string>
    }>
    expect(servers.map(server => server.name)).toContain("imported-server")
    const httpEntry = servers.find(server => server.name === "imported-http")
    expect(httpEntry?.transport, "item.type=http 没有被认成 http").toBe("http")
    expect(httpEntry?.headers).toEqual({ "X-Api-Key": "tok" })

    // sse 已弃用：点名条目拒绝、不静默映射成 stdio、不写盘。
    const writesBefore = recorded("write_runtime_config").length
    fixtures.fileReadContent = JSON.stringify([{ name: "legacy-sse", transport: "sse", url: "http://127.0.0.1:9/mcp" }])
    await expect(dispatchHostRequest("mcp_import", {})).rejects.toMatchObject({
      code: "CONFIG",
      message: expect.stringMatching(/已弃用.*legacy-sse/),
    })
    expect(recorded("write_runtime_config")).toHaveLength(writesBefore)
  })

  it("mcp_export：取消返回 saved=false；选定路径后写出的 JSON 就是自定义服务器表", async () => {
    fixtures.pickSave = null
    expect(await dispatchHostRequest("mcp_export", {})).toEqual({ saved: false, path: null })
    expect(recorded("file_write")).toHaveLength(0)

    fixtures.pickSave = "/fake/mcp-servers.json"
    setCustomServers([
      { name: "demo-custom", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { "X-Api-Key": "tok" }, enabled: true },
      { name: "off-server", transport: "stdio", command: "npx", enabled: false },
    ])
    const exported = await dispatchHostRequest("mcp_export", {})
    expect(exported).toEqual({ saved: true, path: "/fake/mcp-servers.json" })
    const writes = recorded("file_write")
    expect(writes).toHaveLength(1)
    const parsed = JSON.parse(String(writes[0]!.args.content)) as Array<{ name: string; headers?: Record<string, string> }>
    expect(parsed.map(server => server.name)).toEqual(["demo-custom", "off-server"])
    expect(parsed[0]?.headers, "导出丢了 http 服务器的 headers").toEqual({ "X-Api-Key": "tok" })
  })
})

describe("工具页：Skill 清单与开关", () => {
  it("tools_skills：索引核对失败时列表为空但如实带 error（不把失败画成没有 Skill）", async () => {
    fixtures.fingerprintFails = true
    const payload = (await dispatchHostRequest("tools_skills", {})) as {
      rows: unknown[]
      indexError: string | null
    }
    expect(payload.rows).toEqual([])
    expect(payload.indexError).toContain("Skill 索引不可用")
  })

  it("tools_skill_toggle：文件没有可用 frontmatter 时以 CONFIG 拒绝，且不做任何写入", async () => {
    fixtures.fileReadContent = "正文没有 frontmatter"
    await expect(
      dispatchHostRequest("tools_skill_toggle", { id: "demo", enabled: false }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    expect(recorded("file_write_atomic"), "未写入不得留下半份文件").toHaveLength(0)
  })

  it("tools_skill_toggle：合法 frontmatter 只改 enabled 行并原子写回", async () => {
    fixtures.fileReadContent = "---\nname: demo\ndescription: 演示\n---\n正文\n"
    await dispatchHostRequest("tools_skill_toggle", { id: "demo", enabled: false })
    const writes = recorded("file_write_atomic")
    expect(writes).toHaveLength(1)
    const written = String(writes[0]!.args.content)
    expect(written).toContain("enabled: false")
    expect(written, "正文与其它 frontmatter 字段原样保留").toContain("description: 演示")
    expect(written).toContain("正文")
  })

  it("skill_delete：坐标经既有的域内相对路径入口传给宿主；缺 id 拒绝", async () => {
    await expect(dispatchHostRequest("skill_delete", {})).rejects.toMatchObject({ code: "CONFIG" })
    await dispatchHostRequest("skill_delete", { id: "demo-skill" })
    expect(recorded("skill_delete")).toHaveLength(1)
    expect(recorded("skill_delete")[0]!.args.relativePath).toBe("demo-skill")
  })
})

describe("外观页：Profile 列表与管理", () => {
  it("profile_list：meta 读不到的目录不进选项（不提供切向坏 Profile 的入口）", async () => {
    fixtures.profileIds = ["good", "broken"]
    fixtures.profileFiles = new Map<string, string | null>([
      ["good", "meta: {name: Good, description: 好的}\n"],
      ["broken", null],
    ])
    const payload = (await dispatchHostRequest("profile_list", {})) as {
      active: string | null
      profiles: Array<{ id: string; name: string; description: string }>
    }
    expect(payload.profiles).toEqual([{ id: "good", name: "Good", description: "好的" }])
    expect(payload.active, "本进程未装载 Profile：active 如实为 null").toBeNull()
  })

  it("profile_manage：未知 op / 缺 profileId 以结构化 CONFIG 拒绝", async () => {
    await expect(dispatchHostRequest("profile_manage", { op: "explode" })).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("profile_manage", { op: "rename", name: "小雨" })).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("profile_manage", { op: "delete" })).rejects.toMatchObject({ code: "CONFIG" })
  })
})

describe("外观页：音效库 / 分配 / 试听", () => {
  it("sound_library：每个登记事件一行；行内下拉带全表选项与当前分配", async () => {
    setOverride("appearance.soundAssignments", { send: "none" })
    const payload = (await dispatchHostRequest("sound_library", {})) as {
      rows: Array<{
        id: string
        title: string
        action: string
        action2?: string
        pick?: { options: Array<{ value: string; label: string }>; selected: string }
      }>
    }
    expect(payload.rows).toHaveLength(soundEvents.length)
    const sendRow = payload.rows.find(row => row.id === "send")
    expect(sendRow, "send 事件行缺失").toBeDefined()
    expect(sendRow).toMatchObject({ action: "pick" })
    expect(sendRow?.pick?.selected, "显式分配覆盖默认值").toBe("none")
    expect(sendRow?.action2, "静音行不提供试听次动作").toBeUndefined()
    const popupRow = payload.rows.find(row => row.id === "popup")
    expect(popupRow?.pick?.selected, "未分配的事件取登记默认音效").toBe("popup_up")
    expect(popupRow?.action2, "非静音行带试听次动作").toBe("preview")
    const { getSoundLibrary } = await import("@/services/audio")
    const options = popupRow?.pick?.options ?? []
    expect(options[0], "选项表首项是静音").toEqual({ value: "none", label: "静音" })
    expect(options.length, "选项表 = 静音 + 全部内置预设").toBe(getSoundLibrary().length + 1)
    expect(options.some(option => option.value === "popup_up")).toBe(true)
  })

  it("sound_set_assignment：未知事件 / 未知音效 / 缺参逐个拒绝，不写 CONFIG", async () => {
    await expect(dispatchHostRequest("sound_set_assignment", {})).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("sound_set_assignment", { event: "bogus_event", soundId: "none" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("sound_set_assignment", { event: "send", soundId: "no_such_sound" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    expect(recorded("write_runtime_config")).toHaveLength(0)
  })

  it("sound_set_assignment：只改一个事件，其余保持原分配（不整表重写）", async () => {
    setOverride("appearance.soundAssignments", {})
    await dispatchHostRequest("sound_set_assignment", { event: "send", soundId: "none" })
    const assignments = lastWrittenConfig().appearance.soundAssignments as Record<string, string>
    expect(assignments.send).toBe("none")
    expect(assignments.welcome, "未点名的事件保持默认分配").toBe("welcome_chord")
    expect(assignments.popup).toBe("popup_up")
    expect(recorded("ui_set_sound_cues"), "宿主生命周期提示音需要重推").toHaveLength(1)
  })

  it("sound_reset：清空分配覆盖并重推宿主提示音 [native-ui-sound-reset-defaults]", async () => {
    // 全部事件都显式改过：清空覆盖后必须回到登记默认，而不是保留现值。
    const muted = Object.fromEntries(soundEvents.map(event => [event.key, "none"]))
    setOverride("appearance.soundAssignments", muted)
    const { getSoundAssignments } = await import("@/services/audio")
    expect(getSoundAssignments().send, "前置：当前是显式静音").toBe("none")

    await dispatchHostRequest("sound_reset", {})
    const assignments = lastWrittenConfig().appearance.soundAssignments as Record<string, string>
    expect(assignments, "恢复默认 = 清空分配覆盖").toEqual({})
    expect(getSoundAssignments().send, "清空后回落到登记默认").toBe("send_short")
    expect(recorded("ui_set_sound_cues"), "宿主生命周期提示音需要重推").toHaveLength(1)
  })

  it("sound_preview：缺 soundId / 未登记 ID 拒绝；合法 ID 编译后交宿主播放", async () => {
    await expect(dispatchHostRequest("sound_preview", {})).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("sound_preview", { soundId: "no_such_sound" })).rejects.toThrow(/未登记的音效/)

    await dispatchHostRequest("sound_preview", { soundId: "send_short" })
    const played = recorded("audio_play_wav")
    expect(played).toHaveLength(1)
    expect(typeof played[0]!.args.data).toBe("string")
    expect(String(played[0]!.args.data).length, "编译产物应是非空 WAV 数据").toBeGreaterThan(0)
  })
})
