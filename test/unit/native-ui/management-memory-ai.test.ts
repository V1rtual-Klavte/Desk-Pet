// ==========================================
// 设置页管理面（记忆 / AI 页）—— 参数校验、行投影与失败归宿（L2）
// ==========================================
//
// 归属 L2 的依据：处理器只做「入参校验 → 既有记忆 ipc / 人格域入口 → 组装展示投影」；
// 记录型假桥（可注入的 `memory_*` 应答与文件应答）即可观测校验顺序、透传参数与返回
// 形状。真 SQLite / 真 JSONL 语义属于 L4（Node 适配层对 `memory_*` 如实抛
// UnsupportedInNodeError），本文件不伪造那些后端。
//
// 被测行为：
//   · memory_overview 的 scope 值域校验与 scopeId 补全失败的如实拒绝；行投影
//     （截断、pinned 标记、派生条目的来源标记、作业行）；
//   · memory_item_detail 的详情/历史投影与两类来源审计文案（派生条目含来源类别行）；
//   · memory_item_change 的 actor 固定 user_ui、update 合并与「没有改动」拒绝、
//     forget 的提交与 revision 发布；
//   · memory_source_evidence / memory_maintenance / memory_restore 的成功与拒绝分支
//     （含备份选择按 mtime 取最新 .sqlite3）；
//   · V1RTUAL 读取的整份正文回退与写入的既有落盘入口；
//   · 阶段文案 / 变量池 / 主动开关的形状守卫与无卡时的如实拒绝。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { initConfig } from "@/services/config"
import { DERIVED_PROVENANCE_MARK, subscribeMemoryRevision } from "@/services/agent/memory"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { dispatchHostRequest } from "@/services/native-ui"
import { initPaths } from "@/services/paths"

/** 最小合法 CONFIG（四根齐全；本文件不依赖其中大多数值）。 */
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
  mcp: { servers: [] }
appearance:
  activeProfile: ""
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: "", size: 15 }
  chatImagePreview: false
`

/** 记忆条目夹具：pinned 一条 + 普通一条（截断用例用长摘要）。 */
function memoryItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    version: 3,
    status: "active",
    draft: {
      content: "用户喜欢喝美式咖啡",
      summary: "喜欢美式",
      kind: "preference",
      scope: "user",
      aliases: [],
      pinned: true,
      importance: 7,
      confidence: 0.9,
      sourceIds: ["src-1", "src-2"],
      observedAt: 1000,
    },
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

const fixtures = {
  fileReadContent: "",
  backups: [] as Array<{ name: string; path: string; kind: string; mtimeMs: number }>,
  listItems: [] as unknown[],
  detail: memoryItem() as unknown,
  history: [] as unknown[],
  sourceEvidence: null as unknown,
}

/** 记录型假桥：`memory_*` 按夹具应答；失败面用「返回 null → 处理器如实拒绝」表达。 */
function createBridge() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
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
        case "init_memory_files":
          return "/fake/data/memory"
        case "file_read":
          return { content: fixtures.fileReadContent }
        case "file_write_atomic":
          // 假文件系统记住写入内容：v1rtual 写入 → 读回的真实往返才成立。
          fixtures.fileReadContent = String(args.content)
          return null
        case "file_list":
          return { entries: fixtures.backups }
        case "memory_status":
          return { revision: 5, forgetEpoch: 0, schemaVersion: 1, itemCount: 2, candidateCount: 0, jobCount: 1 }
        case "memory_list":
          return fixtures.listItems
        case "memory_job_list":
          return [
            { id: "job-1", phase: "light", status: "completed", revision: 5, forgetEpoch: 0, leaseUntil: null, processed: 12, createdAt: 0, updatedAt: 0 },
          ]
        case "memory_detail":
          return fixtures.detail
        case "memory_history":
          return fixtures.history
        case "memory_apply_change":
          return 42
        case "memory_source_evidence":
          return fixtures.sourceEvidence
        case "memory_backup":
          return "/fake/backups/mem.sqlite3"
        case "memory_export":
          return "/fake/exports/mem.sqlite3"
        case "memory_rebuild":
          return 77
        case "memory_restore_preview":
          return { schemaVersion: 2, revision: 9, forgetEpoch: 0, itemCount: 4, jobCount: 1 }
        case "memory_restore":
          return 88
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

function recorded(method: string): Array<{ method: string; args: Record<string, unknown> }> {
  return calls.filter(call => call.method === method)
}

beforeAll(async () => {
  setHostBridge(recorder.bridge)
  await initPaths()
  await initConfig()
})

beforeEach(() => {
  calls.length = 0
  fixtures.fileReadContent = ""
  fixtures.backups = []
  fixtures.listItems = [
    memoryItem(),
    memoryItem({ id: "mem-2", version: 1, draft: { ...memoryItem().draft, summary: "", pinned: false } }),
  ]
  fixtures.detail = memoryItem()
  fixtures.history = []
  fixtures.sourceEvidence = null
})

afterAll(() => {
  setHostBridge(null)
})

describe("memory_overview（库总览）", () => {
  it("未知 scope / 非字符串 scopeId 以 CONFIG 拒绝（不静默回「全部范围」）", async () => {
    await expect(dispatchHostRequest("memory_overview", { scope: "bogus" })).rejects.toMatchObject({
      code: "CONFIG",
    })
    await expect(dispatchHostRequest("memory_overview", { scope: "user", scopeId: 5 })).rejects.toMatchObject({
      code: "CONFIG",
    })
  })

  it("scope=card / session 补不出激活身份时如实拒绝（不静默查空列表）", async () => {
    await expect(dispatchHostRequest("memory_overview", { scope: "card" })).rejects.toMatchObject({
      code: "CONFIG",
    })
    await expect(dispatchHostRequest("memory_overview", { scope: "session" })).rejects.toMatchObject({
      code: "CONFIG",
    })
  })

  it("合法 scope 透传给 memory_list（查询与界面筛选一致），行投影含截断与 pinned 标记", async () => {
    const payload = (await dispatchHostRequest("memory_overview", { scope: "user" })) as {
      revision: number
      statusText: string
      items: Array<{ id: string; title: string; subtitle: string; action: string; enabled: boolean }>
      jobs: Array<{ id: string; title: string; subtitle: string }>
    }
    const listed = recorded("memory_list")
    expect(listed).toHaveLength(1)
    expect(listed[0]!.args.scope).toBe("user")
    expect(listed[0]!.args.limit).toBe(200)

    expect(payload.revision).toBe(5)
    expect(payload.statusText).toBe("库版本 revision 5 · 2 条当前记忆 · 1 个整理作业")
    expect(payload.items[0]).toMatchObject({
      id: "mem-1",
      title: "喜欢美式",
      subtitle: "preference · user · v3 · 核心画像",
      action: "select",
      enabled: true,
    })
    expect(payload.items[1]).toMatchObject({ id: "mem-2", title: "用户喜欢喝美式咖啡", enabled: false })
    expect(payload.items[1]!.subtitle).not.toContain("核心画像")
    expect(payload.jobs[0]!.title.startsWith("light · completed · "), "作业行带阶段/状态/时间").toBe(true)
    expect(payload.jobs[0]!.subtitle).toBe("作业 job-1 · revision 5 · 已处理 12 条")
  })

  it("派生条目（系统观察）在行副标题带来源标记，用户条目原样 [native-ui-memory-derived-label]", async () => {
    fixtures.listItems = [
      memoryItem({
        id: "mem-derived",
        version: 1,
        origin: "derived_behavior",
        draft: { ...memoryItem().draft, kind: "fact", summary: "常在深夜活跃", pinned: false },
      }),
      memoryItem({ id: "mem-user", origin: "user" }),
    ]
    const payload = (await dispatchHostRequest("memory_overview", { scope: "user" })) as {
      items: Array<{ id: string; subtitle: string }>
    }
    expect(payload.items[0]!.subtitle).toBe(`fact · user · v1 · ${DERIVED_PROVENANCE_MARK}`)
    expect(payload.items[1]!.subtitle).toBe("preference · user · v3 · 核心画像")
  })

  it("标题截断：超长摘要截到 160 字符带省略号，空白折叠；短文本原样", async () => {
    const longSummary = "长".repeat(200)
    fixtures.listItems = [
      memoryItem({ draft: { ...memoryItem().draft, summary: longSummary } }),
      memoryItem({ id: "mem-2", draft: { ...memoryItem().draft, summary: "第一行\n\n第二行  ", pinned: false } }),
    ]
    const payload = (await dispatchHostRequest("memory_overview", { scope: "user" })) as {
      items: Array<{ title: string }>
    }
    const long = payload.items[0]!.title
    expect(long.length).toBe(160)
    expect(long).toBe(`${"长".repeat(159)}…`)
    expect(payload.items[1]!.title, "空白折叠后原样显示（不无谓截断）").toBe("第一行 第二行")
  })
})

describe("memory_item_detail（条目详情与历史）", () => {
  it("缺 id 拒绝；未知条目以 PATH_NOT_FOUND 拒绝", async () => {
    await expect(dispatchHostRequest("memory_item_detail", {})).rejects.toMatchObject({ code: "CONFIG" })
    fixtures.detail = null
    await expect(dispatchHostRequest("memory_item_detail", { id: "no-such" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
  })

  it("详情字段逐项投影；历史含来源审计，空审计如实标不可用", async () => {
    const historyItem = memoryItem({ id: "mem-1", version: 2, status: "superseded" })
    fixtures.history = [
      {
        item: historyItem,
        sourceAudits: [
          {
            sourceId: "src-1",
            sessionId: "s-1",
            entryId: "e-1",
            eventId: "ev-1",
            seq: 4,
            contentHash: "abc123",
            origin: "user",
            taint: "trusted_user",
            observedAt: 1000,
          },
        ],
      },
      { item: memoryItem({ id: "mem-1", version: 1 }), sourceAudits: [] },
    ]
    const payload = (await dispatchHostRequest("memory_item_detail", { id: "mem-1" })) as {
      itemId: string
      version: number
      pinned: boolean
      info: string
      content: string
      sourceIds: string[]
      history: Array<{ id: string; title: string; subtitle: string }>
    }
    expect(payload.itemId).toBe("mem-1")
    expect(payload.version).toBe(3)
    expect(payload.pinned).toBe(true)
    expect(payload.content).toBe("用户喜欢喝美式咖啡")
    expect(payload.sourceIds).toEqual(["src-1", "src-2"])
    expect(payload.info).toContain("类型：preference　范围：user　状态：active　版本：3")
    expect(payload.info).toContain("来源：src-1, src-2")
    expect(payload.info).toContain("重要性：7　置信度：0.9")
    expect(payload.info).toContain("发生时间：未记录")
    expect(payload.info).toContain("事项状态：不适用")

    expect(payload.history).toHaveLength(2)
    expect(payload.history[0]!.id).toBe("mem-1:2")
    expect(payload.history[0]!.title.startsWith("v2 · superseded · ")).toBe(true)
    expect(payload.history[0]!.subtitle).toContain("user/trusted_user · event ev-1 · session s-1 · entry e-1 · seq 4")
    expect(payload.history[0]!.subtitle).toContain("sha256 abc123")
    expect(payload.history[1]!.subtitle).toContain("来源审计已不可用。")
  })

  it("派生条目（系统观察）详情带来源类别行，用户条目不带 [native-ui-memory-derived-detail]", async () => {
    fixtures.detail = memoryItem({
      id: "mem-1",
      version: 1,
      origin: "derived_behavior",
      draft: { ...memoryItem().draft, kind: "fact", content: "常在深夜活跃", summary: "常在深夜活跃", pinned: false },
    })
    const derived = (await dispatchHostRequest("memory_item_detail", { id: "mem-1" })) as { info: string }
    expect(derived.info.split("\n")).toContain(`来源类别：${DERIVED_PROVENANCE_MARK}`)

    fixtures.detail = memoryItem({ origin: "user" })
    const user = (await dispatchHostRequest("memory_item_detail", { id: "mem-1" })) as { info: string }
    expect(user.info).not.toContain("来源类别")
  })
})

describe("memory_item_change（纠正 / 遗忘）", () => {
  it("未知 action / 缺 expectedVersion|baseRevision 以 CONFIG 拒绝", async () => {
    await expect(
      dispatchHostRequest("memory_item_change", { action: "explode", id: "mem-1", expectedVersion: 3, baseRevision: 5 }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("memory_item_change", { action: "forget", id: "mem-1", baseRevision: 5 }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("memory_item_change", { action: "forget", id: "mem-1", expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: "CONFIG" })
  })

  it("update：以当前草稿为底只应用显式字段，提交 actor 固定 user_ui 并发布 revision", async () => {
    const revisions: number[] = []
    const unsubscribe = subscribeMemoryRevision(revision => {
      revisions.push(revision)
    })
    try {
      const payload = await dispatchHostRequest("memory_item_change", {
        action: "update",
        id: "mem-1",
        expectedVersion: 3,
        baseRevision: 5,
        content: "新正文",
      })
      expect(payload).toEqual({ revision: 42 })
    } finally {
      unsubscribe()
    }

    const applied = recorded("memory_apply_change")
    expect(applied).toHaveLength(1)
    expect(applied[0]!.args).toMatchObject({
      action: "update",
      itemId: "mem-1",
      expectedVersion: 3,
      baseRevision: 5,
      actor: "user_ui",
    })
    const draft = applied[0]!.args.draft as { content: string; summary: string; pinned: boolean }
    expect(draft.content).toBe("新正文")
    expect(draft.summary, "正文变化时摘要同步为新正文的前缀").toBe("新正文")
    expect(draft.pinned, "未显式切换时保持原 pinned").toBe(true)
    expect(revisions, "提交成功后必须发布 revision（运行期记忆同步）").toEqual([42])
  })

  it("update：没有任何实际改动时以 CONFIG 拒绝，且不提交（不制造空变更）", async () => {
    await expect(
      dispatchHostRequest("memory_item_change", {
        action: "update",
        id: "mem-1",
        expectedVersion: 3,
        baseRevision: 5,
        pinned: true, // 与当前值相同
      }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    expect(recorded("memory_apply_change")).toHaveLength(0)
  })

  it("update：未知条目以 PATH_NOT_FOUND 拒绝；forget 不需要读取当前草稿", async () => {
    fixtures.detail = null
    await expect(
      dispatchHostRequest("memory_item_change", { action: "update", id: "no-such", expectedVersion: 1, baseRevision: 5, content: "x" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })

    fixtures.detail = memoryItem()
    fixtures.history = []
    const payload = await dispatchHostRequest("memory_item_change", {
      action: "forget",
      id: "mem-1",
      expectedVersion: 3,
      baseRevision: 5,
    })
    expect(payload).toEqual({ revision: 42 })
    const applied = recorded("memory_apply_change")
    expect(applied[0]!.args).toMatchObject({ action: "forget", itemId: "mem-1", actor: "user_ui" })
    expect(applied[0]!.args.draft, "遗忘不带草稿").toBeUndefined()
  })
})

describe("memory_source_evidence（原话回看）", () => {
  it("缺 sourceId 拒绝；来源不可用以 PATH_NOT_FOUND 拒绝", async () => {
    await expect(dispatchHostRequest("memory_source_evidence", {})).rejects.toMatchObject({ code: "CONFIG" })
    fixtures.sourceEvidence = null
    await expect(
      dispatchHostRequest("memory_source_evidence", { sourceId: "src-x" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
  })

  it("有界证据可用时如实返回；会话正文读取不可用只影响 original 一栏", async () => {
    fixtures.sourceEvidence = {
      sourceId: "src-1",
      sessionId: "s-1",
      entryId: "e-1",
      eventId: "ev-1",
      seq: 4,
      contentHash: "abc123",
      evidence: "用户说喜欢美式",
      sourceLength: 1200,
      eligibleForMemory: true,
      taint: "trusted_user",
      origin: "user",
      observedAt: 1000,
    }
    const payload = (await dispatchHostRequest("memory_source_evidence", { sourceId: "src-1" })) as {
      sourceId: string
      available: boolean
      info: string
      evidence: string
      original: string | null
    }
    expect(payload).toMatchObject({ sourceId: "src-1", available: true, evidence: "用户说喜欢美式" })
    expect(payload.info).toContain("来源：user/trusted_user　资格：可记忆")
    expect(payload.info).toContain("会话：s-1　条目：e-1　序：4")
    expect(payload.info).toContain("证据长度：1200 字符")
    // 假桥没有会话文件：原话一栏读不到是环境事实，有界证据仍然可用（两栏分开）。
    expect(payload.original).toBeNull()
  })
})

describe("memory_maintenance（备份 / 导出 / 重建索引）", () => {
  it("未知 op 以 CONFIG 拒绝", async () => {
    await expect(dispatchHostRequest("memory_maintenance", { op: "explode" })).rejects.toMatchObject({
      code: "CONFIG",
    })
  })

  it("backup / export 返回宿主写的路径；rebuild_index 返回 revision 并发布", async () => {
    const backup = (await dispatchHostRequest("memory_maintenance", { op: "backup" })) as {
      message: string
      path: string | null
      revision: number | null
    }
    expect(backup.path).toBe("/fake/backups/mem.sqlite3")
    expect(backup.message).toContain("/fake/backups/mem.sqlite3")
    expect(backup.revision).toBeNull()

    const exported = (await dispatchHostRequest("memory_maintenance", { op: "export" })) as {
      message: string
      path: string | null
    }
    expect(exported.path).toBe("/fake/exports/mem.sqlite3")
    expect(exported.message).toContain("不是可回写的数据源")

    const revisions: number[] = []
    const unsubscribe = subscribeMemoryRevision(revision => {
      revisions.push(revision)
    })
    try {
      const rebuilt = (await dispatchHostRequest("memory_maintenance", { op: "rebuild_index" })) as {
        message: string
        path: string | null
        revision: number | null
      }
      expect(rebuilt).toMatchObject({ path: null, revision: 77 })
      expect(rebuilt.message).toContain("revision 77")
    } finally {
      unsubscribe()
    }
    expect(revisions).toEqual([77])
  })
})

describe("memory_restore（恢复预览 / 应用）", () => {
  const entry = (name: string, mtimeMs: number, kind = "file") => ({
    name,
    path: `/fake/data/memory/backups/${name}`,
    kind,
    mtimeMs,
  })

  it("没有备份 / 备份目录里没有 .sqlite3 时给中性指引（不静默）", async () => {
    fixtures.backups = []
    await expect(dispatchHostRequest("memory_restore", { op: "preview" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
    fixtures.backups = [entry("notes.txt", 999), entry("sub", 999, "dir")]
    await expect(dispatchHostRequest("memory_restore", { op: "preview" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
  })

  it("预览取 mtime 最新的 .sqlite3，并在结果里显示实际使用的文件", async () => {
    fixtures.backups = [entry("old.sqlite3", 100), entry("note.txt", 500), entry("new.sqlite3", 300)]
    const payload = (await dispatchHostRequest("memory_restore", { op: "preview" })) as {
      message: string
      path: string | null
      revision: number | null
    }
    expect(payload.path).toBe("/fake/data/memory/backups/new.sqlite3")
    expect(payload.message).toContain("预检通过（未应用）：/fake/data/memory/backups/new.sqlite3")
    expect(payload.message).toContain("schema v2 · revision 9 · 4 条记忆 · 1 个作业")
    expect(recorded("memory_restore_preview")[0]!.args.backupPath).toBe("/fake/data/memory/backups/new.sqlite3")
    expect(payload.revision).toBeNull()
  })

  it("应用返回新 revision；未知 op 在有备份时仍以 CONFIG 拒绝", async () => {
    fixtures.backups = [entry("new.sqlite3", 300)]
    const applied = (await dispatchHostRequest("memory_restore", { op: "apply" })) as {
      message: string
      path: string | null
      revision: number | null
    }
    expect(applied.revision).toBe(88)
    expect(applied.path).toBe("/fake/data/memory/backups/new.sqlite3")
    expect(applied.message).toContain("新 revision 88")
    expect(recorded("memory_restore")[0]!.args.backupPath).toBe("/fake/data/memory/backups/new.sqlite3")

    await expect(dispatchHostRequest("memory_restore", { op: "explode" })).rejects.toMatchObject({
      code: "CONFIG",
    })
  })
})

describe("V1RTUAL 指令文本", () => {
  it("读取：有小节时只取小节正文；没有小节时按整份正文处理", async () => {
    fixtures.fileReadContent = "# V1RTUAL.md — 用户系统指令\n\n## 指令\n\n只喝美式\n\n_最后更新: x_\n"
    expect(await dispatchHostRequest("v1rtual_read", {})).toEqual({ content: "只喝美式" })

    fixtures.fileReadContent = "手写指令\n第二行"
    expect(await dispatchHostRequest("v1rtual_read", {})).toEqual({ content: "手写指令\n第二行" })
  })

  it("写入：缺 content 拒绝；合法文本经 file_write_atomic 落到 V1RTUAL.md 并可读回", async () => {
    await expect(dispatchHostRequest("v1rtual_write", {})).rejects.toMatchObject({ code: "CONFIG" })

    await dispatchHostRequest("v1rtual_write", { content: "请叫我小 V" })
    const writes = recorded("file_write_atomic")
    expect(writes).toHaveLength(1)
    expect(String(writes[0]!.args.path)).toContain("V1RTUAL.md")
    expect(String(writes[0]!.args.content)).toContain("请叫我小 V")
    expect(String(writes[0]!.args.content)).toContain("## 指令")

    // 假文件系统记住写入：读回的就是刚写下的指令（写-读同源）。
    expect(await dispatchHostRequest("v1rtual_read", {})).toEqual({ content: "请叫我小 V" })
  })
})

describe("AI 页：阶段文案 / 变量池", () => {
  it("card_stages_read：未知卡与没有激活卡都以 PATH_NOT_FOUND 拒绝（不返回空文档）", async () => {
    await expect(
      dispatchHostRequest("card_stages_read", { cardId: "no-such-card" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    await expect(dispatchHostRequest("card_stages_read", {})).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
  })

  it("card_stages_write / regenerate：缺 text / 未知卡都以结构化错误拒绝", async () => {
    await expect(dispatchHostRequest("card_stages_write", { cardId: "no-such-card" })).rejects.toMatchObject({
      code: "CONFIG",
    })
    await expect(
      dispatchHostRequest("card_stages_write", { cardId: "no-such-card", text: "## thinking\n想法" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    await expect(
      dispatchHostRequest("card_stages_regenerate", { cardId: "no-such-card" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    expect(recorded("personality_file_write")).toHaveLength(0)
  })

  it("card_variable_pool：cardId 形状非法拒绝；空池按「无」如实显示", async () => {
    await expect(dispatchHostRequest("card_variable_pool", { cardId: 42 })).rejects.toMatchObject({
      code: "CONFIG",
    })

    const empty = (await dispatchHostRequest("card_variable_pool", {})) as { cardId: string | null; text: string }
    expect(empty.cardId).toBeNull()
    expect(empty.text).toContain("池所属 Card：（无）")
    expect(empty.text).toContain("【系统变量】")
    expect(empty.text).toContain("【角色变量】")
    expect(empty.text).toContain("【互动变量】")

    const other = (await dispatchHostRequest("card_variable_pool", { cardId: "other-card" })) as {
      cardId: string | null
      text: string
    }
    expect(other.cardId).toBe("other-card")
    expect(other.text, "预览的不是该卡的池时必须如实标注").toContain("不是 other-card")
  })
})
