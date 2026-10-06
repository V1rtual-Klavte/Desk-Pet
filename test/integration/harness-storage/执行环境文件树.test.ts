// ==========================================
// 执行环境文件树 —— 从 test/e2e/scenes/harness-storage/执行环境文件树.scene.ts 迁到 L3（W2）
//
// 被测：NativeExecutionEnv 的 append / rename / createDir / remove / createTempDir / listDir
// 命令语义。L3 里 IPC 由 test/host/node-ipc.ts 顶替（真实 Rust 命令的 Node 等价实现，
// 只实现机制，不做路径裁决）；除错误码映射的两条策略探针外，语义与 L4 同源。
//
// 另含一条 2026-10-06 折叠批次新增的用例（`harness-session-write-limit`）：会话根写入上限 ——
// 会话根内走 `session_write_text` 的专用放宽（`SESSION_WRITE_MAX_BYTES`）、根外仍受工具面
// `MAX_TOOL_FILE_BYTES`（5 MiB）；覆盖 hs-02 的写侧边界（Rust 侧的 base 边界裁决留 L4）。
//
// 迁移时的审视修正（对应契约「审计线索」的复核结论）：
//   · 原 :50 / :94 用 `fileOk` 解包 Result 后**丢弃了布尔值** —— exists 返回 ok(false)
//     也照样通过（D1 恒真）。迁移后显式断言布尔值：目录存在、拒绝删除后目录仍在。
//   · 原 check 5 的四条错误码探针里有两条依赖 Rust 侧的**路径裁决**：
//     SENSITIVE_PATH（`.ssh` 词法拒绝）与 NOT_ABSOLUTE（拒绝相对路径）。适配层按设计不做
//     路径裁决，实测这两条在 Node 下分别落成 not_found 与「写入成功且落在进程 CWD」，L3
//     无从复现 —— 已从本用例删除，覆盖缺口登记在契约的 harness-storage 迁移登记段。
//   · 原 check 6 断言 `file.path === 规范化会话根 + 文件名`：Rust 的 file_list 经
//     `validate_file_path` canonicalize，而适配层的 file_list 不 canonicalize（macOS 上
//     /var 与 /private/var 必然不等）。迁移后先把临时根 canonicalize 再用，两种实现下
//     同一条断言都成立。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, Result } from "@earendil-works/pi-agent-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { SESSION_WRITE_MAX_BYTES } from "@/services/engine/harness"
import { SessionFileSystem } from "@/services/engine/harness/session-file-system"
import { BaseDirs, initPaths, runtimePath } from "@/services/paths"
import { MAX_TOOL_FILE_BYTES, NativeExecutionEnv } from "@/services/tool/pi/native-execution-env"

/**
 * 解包 Result（夹具解码器，不是断言）：失败时先经 expect 记一条带错误码的失败，再中止本用例
 * —— 后面的断言依赖这个值，继续跑只会产生一串噪声。
 */
function expectOk<T>(result: Result<T, FileError>, label: string): T {
  expect(result.ok, `${label}: ${result.ok ? "" : `${result.error.code}: ${result.error.message}`}`).toBe(true)
  if (!result.ok) throw new Error(`${label}: ${result.error.message}`)
  return result.value
}

/** 失败结果的结构化错误码；调用成功即判失败（这些探针都要求被拒绝）。 */
function failureCode<T>(result: Result<T, FileError>, label: string): FileError["code"] {
  expect(result.ok, `${label}: 期望被拒绝，实际成功`).toBe(false)
  if (result.ok) throw new Error(`${label}: 期望被拒绝，实际成功`)
  return result.error.code
}

let dataRoot = ""
let env: NativeExecutionEnv

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-harness-env-"))
  setTestDataRoot(dataRoot)
  await initPaths()
  env = new NativeExecutionEnv(await runtimePath("data"))
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

describe("执行环境文件树", () => {
  it("NativeExecutionEnv 的 append/rename/createDir/remove/createTempDir 真实命令语义 [harness-execution-env-filetree]", async () => {
    const context = BACKGROUND_CONTEXT

    // ── createDir 默认 recursive：一次建多层；append 创建缺失文件（含缺失父目录）并在末尾追加 ──
    {
      const root = expectOk(await env.createTempDir("deskpet-live-env-", context), "createTempDir")
      expectOk(await env.createDir(`${root}/nested/deep`, undefined, context), "createDir(recursive)")
      // 布尔值必须被断言：只解包 Result 时 ok(false) 也静默通过（原 :50 的 D1）
      expect(expectOk(await env.exists(`${root}/nested/deep`, context), "exists(nested/deep)")).toBe(true)

      expectOk(await env.appendFile(`${root}/nested/deep/data.txt`, "AB", context), "appendFile(AB)")
      expectOk(await env.appendFile(`${root}/nested/deep/data.txt`, "CD", context), "appendFile(CD)")
      expect(expectOk(await env.readTextFile(`${root}/nested/deep/data.txt`, context), "readTextFile")).toBe("ABCD")

      expectOk(await env.remove(root, { recursive: true, force: true }, context), "remove(root)")
    }

    // ── rename 替换已存在目标，源文件消失 ──
    {
      const root = expectOk(await env.createTempDir("deskpet-live-env-", context), "createTempDir")
      try {
        expectOk(await env.writeFile(`${root}/a.txt`, "A", context), "writeFile(a.txt)")
        expectOk(await env.writeFile(`${root}/b.txt`, "B", context), "writeFile(b.txt)")
        // 契约：替换已存在目标
        expectOk(await env.renameFile(`${root}/a.txt`, `${root}/b.txt`, context), "renameFile")
        expect(expectOk(await env.readTextFile(`${root}/b.txt`, context), "readTextFile(b.txt)")).toBe("A")
        expect(expectOk(await env.exists(`${root}/a.txt`, context), "exists(a.txt)")).toBe(false)
      } finally {
        expectOk(await env.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }

    // ── remove 遵守 recursive / force ──
    {
      const root = expectOk(await env.createTempDir("deskpet-live-env-", context), "createTempDir")
      try {
        expectOk(await env.createDir(`${root}/tree/child`, undefined, context), "createDir(tree/child)")
        expectOk(await env.appendFile(`${root}/tree/child/f.txt`, "x", context), "appendFile(f.txt)")

        // 目录 + recursive=false：失败编码进 Result，不 throw（failureCode 内部断言「被拒绝」）
        failureCode(await env.remove(`${root}/tree`, undefined, context), "remove 目录 recursive=false")
        // 拒绝之后目录必须仍在（原 :94 只解包了 Result，布尔值被丢弃 —— D1）
        expect(expectOk(await env.exists(`${root}/tree`, context), "exists(tree)")).toBe(true)

        // 缺失路径：force=false 失败、force=true 成功
        failureCode(await env.remove(`${root}/missing`, undefined, context), "remove 缺失路径 force=false")
        expectOk(await env.remove(`${root}/missing`, { force: true }, context), "remove(缺失路径, force=true)")

        expectOk(await env.remove(`${root}/tree`, { recursive: true }, context), "remove(tree, recursive=true)")
        expect(expectOk(await env.exists(`${root}/tree`, context), "exists(tree) 递归删除后")).toBe(false)
      } finally {
        expectOk(await env.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }

    // ── createTempDir：产出目录、不落在会话目录下 ──
    {
      const root = expectOk(await env.createTempDir(undefined, context), "createTempDir")
      try {
        const info = expectOk(await env.fileInfo(root, context), "fileInfo(临时目录)")
        expect(info.kind).toBe("directory")
        expect(root.startsWith(BaseDirs.sessions()), "临时目录不应落在会话目录下").toBe(false)
      } finally {
        expectOk(await env.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }

    // ── 失败归类按 Rust 结构化错误码（error.rs 的 code），不拿 message 做正则 ──
    // 适配层能如实复现的两条：
    //   · PATH_NOT_FOUND → not_found（旧实现按文案也能猜对）
    //   · TOOL（「只允许操作常规文件」）不在映射表里 → 如实保持 unknown，不猜成 not_directory
    // 原场景另外两条（SENSITIVE_PATH → permission_denied、NOT_ABSOLUTE → invalid）依赖
    // Rust 侧的词法/绝对路径裁决，适配层不做策略、无出口 —— 已删除并登记覆盖缺口。
    {
      const root = expectOk(await env.createTempDir("deskpet-live-err-", context), "createTempDir")
      try {
        expect(failureCode(await env.remove(`${root}/missing.txt`, undefined, context), "缺失路径 remove(force=false)")).toBe("not_found")
        expect(failureCode(await env.readTextFile(root, context), "目录作为文件 readTextFile")).toBe("unknown")
      } finally {
        expectOk(await env.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }

    // ── listDir 直接返回 FileInfo 全字段（绝对 path、kind 三值、size、mtimeMs）──
    // 前端不用 file_info 回填短条目 —— 缺字段会让 JsonlSessionRepo.list 直接失效。
    {
      // 先把临时根 canonicalize：Rust 的 file_list 经 validate_file_path 规范化条目 path，
      // 适配层不规范化（macOS 上 /var 与 /private/var 是同一目录的两个写法）。
      // 在规范化后的根上比较，两种实现下「条目 path = 根 + 名字」这条断言都成立。
      const root = expectOk(
        await env.canonicalPath(
          expectOk(await env.createTempDir("deskpet-live-listdir-", context), "createTempDir"),
          context,
        ),
        "canonicalPath(root)",
      )
      try {
        expectOk(await env.createDir(`${root}/sub`, undefined, context), "createDir(sub)")
        expectOk(await env.writeFile(`${root}/a.txt`, "abc", context), "writeFile(a.txt)")
        const entries = expectOk(await env.listDir(root, context), "listDir")
        const file = entries.find(entry => entry.name === "a.txt")
        const dir = entries.find(entry => entry.name === "sub")
        expect(file, `listDir 缺少 a.txt: ${JSON.stringify(entries)}`).toBeDefined()
        expect(dir, `listDir 缺少 sub: ${JSON.stringify(entries)}`).toBeDefined()
        expect([file?.kind, dir?.kind]).toEqual(["file", "directory"])

        const expectedPath = expectOk(await env.joinPath([root, "a.txt"], context), "joinPath")
        expect(isAbsolute(expectedPath)).toBe(true)
        expect(file?.path, "listDir 的 path 应是根下的绝对路径").toBe(expectedPath)
        expect(file?.size).toBe(3)
        expect(file?.mtimeMs).toBeGreaterThan(0)
        expect(dir?.mtimeMs).toBeGreaterThan(0)
      } finally {
        expectOk(await env.remove(root, { recursive: true, force: true }, context), "remove(root)")
      }
    }
  })

  it("会话根内的写入放宽到会话专用上限，会话根外的写入仍受工具面 5 MiB 上限 [harness-session-write-limit]", async () => {
    const context = BACKGROUND_CONTEXT
    const utf8 = new TextEncoder()
    const sessionsRoot = await runtimePath("sessions")
    const dataRootPath = await runtimePath("data")
    // 会话读写的生产形态：边界内走宿主会话命令，边界外回落到通用文件命令。
    const sessionEnv = new SessionFileSystem(dataRootPath, sessionsRoot)

    /**
     * >5 MiB 的探针载荷：中英混合，UTF-8 字节数 > 上限而 UTF-16 字符数 < 上限 ——
     * 按 `String.length` 判上限的实现会被这条钉住（与折叠夹具同一口径）。
     */
    const unit = "会话写上限探针x" // 7 CJK + 1 ASCII = 22 UTF-8 字节
    const payload = unit.repeat(Math.ceil((MAX_TOOL_FILE_BYTES + 1024) / utf8.encode(unit).byteLength))
    expect(utf8.encode(payload).byteLength, "探针载荷未超过工具面 5 MiB 上限：用例失去区分力").toBeGreaterThan(MAX_TOOL_FILE_BYTES)
    expect(payload.length, "探针载荷的字符数未低于字节上限：字符口径的实现不会被这条钉住").toBeLessThan(MAX_TOOL_FILE_BYTES)

    const insideDir = `${sessionsRoot}/session-write-limit-${crypto.randomUUID()}`
    const insidePath = `${insideDir}/--cwd--/probe.jsonl.tmp-1`
    const outsideDir = `${dataRootPath}/session-write-limit-${crypto.randomUUID()}`
    const outsidePath = `${outsideDir}/probe.jsonl`
    try {
      // ① 会话根内：超过工具面 5 MiB 的写入放行，内容逐字节落在盘上（放宽真实生效）。
      expectOk(await sessionEnv.writeFile(insidePath, payload, context), "writeFile(会话根内 >5 MiB)")
      const insideInfo = expectOk(await sessionEnv.fileInfo(insidePath, context), "fileInfo(会话根内)")
      expect(insideInfo.size, "会话根内写入的字节数 ≠ 载荷字节数").toBe(utf8.encode(payload).byteLength)
      expect(expectOk(await sessionEnv.readTextFile(insidePath, context), "readTextFile(会话根内)")).toBe(payload)

      // ② 同一实例、同一载荷、会话根外：回落通用 file_write，仍被工具面 5 MiB 上限拒绝，
      //    且不落盘（Rust 侧在同一条命令上只放大 maxBytes，不改变拒绝语义）。
      const rejected = await sessionEnv.writeFile(outsidePath, payload, context)
      expect(rejected.ok, "会话根外的 >5 MiB 写入被放行了：工具面上限被会话路径污染").toBe(false)
      if (!rejected.ok) {
        // OTHER（「写入内容过大」）不在 FileError 映射表里，如实保持 unknown（不猜成别的类别）。
        expect(rejected.error.code, `会话根外超限应报 unknown/OTHER，实际 ${rejected.error.code}: ${rejected.error.message}`).toBe("unknown")
      }
      expect(expectOk(await sessionEnv.exists(outsidePath, context), "exists(会话根外)")).toBe(false)

      // ③ 对照：会话根外的小载荷照常成功 —— 上限不是「会话根外一律拒绝」。
      expectOk(await sessionEnv.writeFile(outsidePath, "小载荷", context), "writeFile(会话根外 小载荷)")
      expect(expectOk(await sessionEnv.readTextFile(outsidePath, context), "readTextFile(会话根外 小载荷)")).toBe("小载荷")

      // ④ 阈值关系：会话写上限必须 ≥ 折叠读取守卫（折叠只删不增 ⇒ 折叠结果 ≤ 输入），
      //    否则会出现「能折、写不回去」的区间（结果守卫与读守卫的契约见会话日志折叠用例）。
      expect(SESSION_WRITE_MAX_BYTES, "会话写上限必须 ≥ 5 MiB 的工具面上限（放宽方向不能反）").toBeGreaterThan(MAX_TOOL_FILE_BYTES)
    } finally {
      expectOk(await sessionEnv.remove(insideDir, { recursive: true, force: true }, context), "remove(会话根内)")
      expectOk(await sessionEnv.remove(outsideDir, { recursive: true, force: true }, context), "remove(会话根外)")
    }
  })
})
