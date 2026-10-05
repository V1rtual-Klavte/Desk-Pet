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
//   · MCP：列表行投影（命令摘要、白名单摘要）、开关写盘、文档渲染与
//     编辑/删除的分支（按 name 增改删、非法字段逐个拒绝）、
//     测试的「关闭不连接」短路、导入导出成功与取消；
//   · Skill：索引不可用时列表为空但如实带 error；开关缺 frontmatter 时拒绝且不写盘；
//   · Profile：列表跳过 meta 读不到的目录；
//   · 音效：库/分配行与试听；分配非法事件与非法音效 ID 如实拒绝，合法写入落 CONFIG。

import { load as loadYaml } from "js-yaml"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { initConfig, setOverride } from "@/services/config"
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
  loop: { maxRetry: 3, maxToolCallsPerTurn: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  plan: { enabled: false }
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { enabled: false }
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

/** MCP 行编辑文档（与处理器的 `## 小节` 格式同形；测试侧组装输入，非复刻实现）。 */
function mcpDoc(fields: Record<string, string | string[]>): string {
  return `${Object.entries(fields)
    .map(([key, value]) => `## ${key}\n${Array.isArray(value) ? value.join("\n") : value}`)
    .join("\n\n")}\n`
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
})

afterAll(() => {
  setHostBridge(null)
})

describe("通用页：默认值 / 导入导出", () => {
  it("settings_defaults 取内置模板而不是运行时覆写（默认值与现值分开）", async () => {
    setOverride("general.popup.chatWidth", 333)
    const payload = (await dispatchHostRequest("settings_defaults", {})) as { values: Record<string, unknown> }
    // 模板里 chatWidth=220；现值已被覆写成 333 —— 默认值面必须仍报模板值。
    expect(payload.values["general.popup.chatWidth"]).toBe(220)
    expect(payload.values["ai.conversation.defaultDelivery"]).toBe("steer")
    // 键 = CONFIG 路径（嵌套展开），与 settings_read 同形。
    expect(payload.values["general.popup.defaultSize.w"]).toBe(730)
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

describe("工具页：MCP 文档 / 编辑 / 测试 / 导入导出", () => {
  it("mcp_server_doc：缺省给新建模板；未知名拒绝；已有服务器按当前配置渲染且回执只有 text", async () => {
    const template = (await dispatchHostRequest("mcp_server_doc", {})) as { text: string }
    expect(Object.keys(template), "回执字段集变了（线协议两侧需逐字一致）").toEqual(["text"])
    expect(template.text).toContain("## name\n")
    expect(template.text).toContain("## transport\nstdio")

    await expect(dispatchHostRequest("mcp_server_doc", { name: "nope" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
    await expect(dispatchHostRequest("mcp_server_doc", { name: 42 })).rejects.toMatchObject({ code: "CONFIG" })

    // 本用例自带服务器表：文档渲染不与其他用例留下的 override 状态耦合。
    setCustomServers([{
      name: "demo-custom",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { "X-Api-Key": "demo-token" },
      excludeTools: ["noisy"],
      enabled: true,
    }])
    const custom = (await dispatchHostRequest("mcp_server_doc", { name: "demo-custom" })) as { text: string }
    expect(custom.text).toContain("## name\ndemo-custom")
    expect(custom.text).toContain("## transport\nhttp")
    expect(custom.text).toContain("## url\nhttp://127.0.0.1:9/mcp")
    // headers 与 env 同款 KEY=VALUE 行格式（渲染与解析共用 manager 的 formatEnvText/parseEnvText）。
    expect(custom.text).toContain("## headers\nX-Api-Key=demo-token")
  })

  it("mcp_edit：文档渲染 → 解析 → 落盘往返保留 headers（同一套 KEY=VALUE 格式）", async () => {
    setCustomServers([{
      name: "roundtrip-headers",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
      env: { TOKEN: "abc" },
      headers: { "X-Api-Key": "demo-token", "X-Trace": "on" },
      enabled: true,
    }])
    const doc = (await dispatchHostRequest("mcp_server_doc", { name: "roundtrip-headers" })) as { text: string }
    await dispatchHostRequest("mcp_edit", { op: "text", text: doc.text })
    const servers = lastWrittenConfig().tools.mcp.servers as Array<{
      name: string
      env?: Record<string, string>
      headers?: Record<string, string>
    }>
    const saved = servers.find(server => server.name === "roundtrip-headers")
    expect(saved?.headers).toEqual({ "X-Api-Key": "demo-token", "X-Trace": "on" })
    expect(saved?.env).toEqual({ TOKEN: "abc" })
  })

  it("mcp_edit：未知 op / 缺字段 / 非法 transport / 缺 command|url / 非法 enabled 逐个拒绝", async () => {
    await expect(dispatchHostRequest("mcp_edit", { op: "explode" })).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("mcp_edit", { op: "delete" })).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("mcp_edit", { op: "text" })).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("mcp_edit", { op: "text", text: mcpDoc({ transport: "stdio", command: "npx" }) }),
      "缺 name 小节",
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("mcp_edit", { op: "text", text: mcpDoc({ name: "x", transport: "ws", command: "npx" }) }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("mcp_edit", { op: "text", text: mcpDoc({ name: "x", transport: "stdio" }) }),
      "stdio 必须有 command",
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("mcp_edit", { op: "text", text: mcpDoc({ name: "x", transport: "http" }) }),
      "http 必须有 url",
    ).rejects.toThrow(/http 服务器必须有 url/)
    await expect(
      dispatchHostRequest("mcp_edit", {
        op: "text",
        text: mcpDoc({ name: "x", transport: "sse", url: "http://127.0.0.1:9/mcp" }),
      }),
      "sse 已弃用：必须显式拒绝并给迁移指引（不静默映射）",
    ).rejects.toThrow(/sse 已弃用/)
    await expect(
      dispatchHostRequest("mcp_edit", {
        op: "text",
        text: mcpDoc({ name: "x", transport: "stdio", command: "npx", enabled: "yes" }),
      }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    // 全部拒绝路径都不得写盘。
    expect(recorded("write_runtime_config")).toHaveLength(0)
  })

  it("mcp_edit：新增/改写/删除都经 setMcpServers 写回 CONFIG", async () => {
    setCustomServers([
      { name: "demo-custom", transport: "http", url: "http://127.0.0.1:9/mcp", enabled: true },
      { name: "off-server", transport: "stdio", command: "npx", enabled: false },
    ])
    await dispatchHostRequest("mcp_edit", {
      op: "text",
      text: mcpDoc({ name: "new-server", transport: "stdio", command: "npx", args: ["-y", "new-mcp"], enabled: "true" }),
    })
    let servers = lastWrittenConfig().tools.mcp.servers as Array<{ name: string; enabled?: boolean }>
    expect(servers.map(server => server.name)).toContain("new-server")

    await dispatchHostRequest("mcp_edit", {
      op: "text",
      text: mcpDoc({ name: "demo-custom", transport: "http", url: "http://127.0.0.1:8/mcp", enabled: "false" }),
    })
    servers = lastWrittenConfig().tools.mcp.servers as Array<{ name: string; enabled?: boolean }>
    expect(servers.find(server => server.name === "demo-custom")?.enabled).toBe(false)

    await dispatchHostRequest("mcp_edit", { op: "delete", name: "off-server" })
    servers = lastWrittenConfig().tools.mcp.servers as Array<{ name: string; enabled?: boolean }>
    expect(servers.map(server => server.name)).not.toContain("off-server")
  })

  it("mcp_edit.delete：未知名字以 PATH_NOT_FOUND 拒绝；mcp_test：关闭的服务器短路为 ok=false", async () => {
    await expect(dispatchHostRequest("mcp_edit", { op: "delete", name: "no-such" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })

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
