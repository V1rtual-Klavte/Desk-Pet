// ==========================================
// Node IPC 适配层自身的测试
// ==========================================
//
// 适配层是「第二个 Tauri 实现」，它自己失真会让上层所有 L3 场景一起失真，
// 所以这里断言的都是**真实证据**：回读文件、比对返回体、钉住错误码，
// 不用「没报错」代替验证（测试纪律 rule 1）。
//
// 位置：`test/unit/host/` —— vitest 的两个 project 只 include `test/unit/**` 与
// `test/integration/**`，放在别处的测试不会被执行。
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename as pathBasename, join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

import { UnsupportedInNodeError, RUST_ONLY_COMMANDS } from "../../host/unsupported"
import { getNodeLogLevel, getTestDataRoot, invoke, setTestDataRoot } from "../../host/node-ipc"
import {
  basename,
  dirname,
  homeDir,
  isAbsolute,
  join as joinPath,
  normalize,
  resolve as resolvePath,
  tempDir,
} from "../../host/node-path"
import { emit as eventEmit, listen } from "../../host/node-event"

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-node-ipc-"))
  setTestDataRoot(root)
})

describe("分发与抛错", () => {
  it("未登记的命令抛 UnsupportedInNodeError，而不是返回 null", async () => {
    const failure = await invoke("no_such_command_at_all").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UnsupportedInNodeError)
    expect(failure).toMatchObject({ name: "UnsupportedInNodeError", command: "no_such_command_at_all" })
  })

  it("抛错表里的每条 Rust 专用命令都真的抛错，并带上命令名", async () => {
    const failures: string[] = []
    for (const command of RUST_ONLY_COMMANDS) {
      const failure = await invoke(command).catch((error: unknown) => error)
      const ok =
        failure instanceof UnsupportedInNodeError &&
        failure.command === command &&
        failure.message.includes(command)
      if (!ok) failures.push(command)
    }
    expect(failures).toEqual([])
  })

  it("必填参数缺失时抛错，不把 undefined 当成合法值静默写错路径", async () => {
    const failure = await invoke("file_write", { content: "hi" }).catch((error: unknown) => error)
    expect(String(failure)).toMatch(/IPC 参数缺失: path/)
  })

  it("Rust 的 unit 返回类型在 IPC 边界归一成 null（Tauri 协议如此，不是兜底）", async () => {
    await expect(
      invoke("file_remove", { path: join(root, "absent.txt"), recursive: false, force: true }),
    ).resolves.toBeNull()
  })

  it("数据根只接受绝对路径：空串与相对路径都抛错，不允许写入落在进程 CWD", () => {
    expect(() => setTestDataRoot("")).toThrowError(/必须是绝对路径/)
    expect(() => setTestDataRoot("relative/root")).toThrowError(/必须是绝对路径/)
    setTestDataRoot(root)
    expect(getTestDataRoot()).toBe(root)
  })
})

describe("文件命令", () => {
  it("file_write / file_read / file_exists / file_info / file_canonical_path 落在临时根内", async () => {
    const target = join(root, "probe", "a.txt")
    await invoke("dir_create", { path: join(root, "probe"), recursive: true })
    await expect(
      invoke("file_write", { path: target, content: "hello 世界" }),
    ).resolves.toEqual({ success: true })

    await expect(invoke<boolean>("file_exists", { path: target })).resolves.toBe(true)
    await expect(invoke("file_read", { path: target })).resolves.toEqual({
      content: "hello 世界",
      size: Buffer.byteLength("hello 世界", "utf8"),
    })
    await expect(invoke("file_info", { path: target })).resolves.toMatchObject({
      name: "a.txt",
      kind: "file",
      path: target,
    })
    // canonical 路径与 Node realpath 同口径（macOS 的 /var → /private/var 这类链接会被解析）。
    await expect(invoke<string>("file_canonical_path", { path: target })).resolves.toBe(
      realpathSync(target),
    )
    expect(target.startsWith(root)).toBe(true)
  })

  it("file_append 追加而不是覆盖，且 file_read 回读的是追加后的全文", async () => {
    const target = join(root, "log.jsonl")
    await invoke("file_append", { path: target, content: "line-1\n", maxBytes: 1024 })
    await invoke("file_append", { path: target, content: "line-2\n", maxBytes: 1024 })
    await expect(invoke("file_read", { path: target })).resolves.toMatchObject({
      content: "line-1\nline-2\n",
    })
  })

  it("file_write_atomic 写入最终内容且不留下临时文件", async () => {
    const dir = join(root, "atomic")
    const target = join(dir, "config.yaml")
    await invoke("file_write_atomic", { path: target, content: "a: 1\n", maxBytes: 1024 })
    await invoke("file_write_atomic", { path: target, content: "a: 2\n", maxBytes: 1024 })
    expect(readFileSync(target, "utf8")).toBe("a: 2\n")
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  it("file_rename 移动文件，源消失、目标有新内容", async () => {
    const source = join(root, "from.txt")
    const destination = join(root, "nested", "to.txt")
    await invoke("file_write", { path: source, content: "payload" })
    // 目标的父目录 Rust 侧同样不创建（会话存储先 write 临时文件再 rename），先建出来。
    await invoke("dir_create", { path: join(root, "nested"), recursive: true })
    await invoke("file_rename", { sourcePath: source, destinationPath: destination })
    await expect(invoke<boolean>("file_exists", { path: source })).resolves.toBe(false)
    expect(readFileSync(destination, "utf8")).toBe("payload")
  })

  it("file_rename 目标父目录缺失时失败（Rust 不替调用方建目录），源缺失报 PATH_NOT_FOUND", async () => {
    const source = join(root, "again.txt")
    await invoke("file_write", { path: source, content: "payload" })
    await expect(
      invoke("file_rename", { sourcePath: source, destinationPath: join(root, "absent-dir", "x.txt") }),
    ).rejects.toMatchObject({ code: "IO" })
    expect(readFileSync(source, "utf8")).toBe("payload")
    await expect(
      invoke("file_rename", { sourcePath: join(root, "ghost.txt"), destinationPath: join(root, "y.txt") }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
  })

  it("file_remove 删文件、按 recursive 删目录，缺失目标按 force 分流", async () => {
    const file = join(root, "gone.txt")
    const dir = join(root, "tree", "deep")
    await invoke("file_write", { path: file, content: "x" })
    await invoke("dir_create", { path: dir, recursive: true })
    await invoke("file_remove", { path: file, recursive: false, force: false })
    await invoke("file_remove", { path: join(root, "tree"), recursive: true, force: false })
    await expect(invoke<boolean>("file_exists", { path: file })).resolves.toBe(false)
    await expect(invoke<boolean>("file_exists", { path: dir })).resolves.toBe(false)

    await expect(
      invoke("file_remove", { path: join(root, "never.txt"), recursive: false, force: false }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
    await expect(
      invoke("file_remove", { path: join(root, "never.txt"), recursive: false, force: true }),
    ).resolves.toBeNull()
  })

  it("file_remove 对目录要求 recursive = true", async () => {
    const dir = join(root, "keep")
    await invoke("dir_create", { path: dir, recursive: true })
    await expect(
      invoke("file_remove", { path: dir, recursive: false, force: false }),
    ).rejects.toMatchObject({ code: "OTHER" })
    await expect(invoke<boolean>("file_exists", { path: dir })).resolves.toBe(true)
  })

  it("dir_create 的 recursive=false 在目录已存在时报错，recursive=true 幂等", async () => {
    const dir = join(root, "once")
    await invoke("dir_create", { path: dir, recursive: true })
    await expect(invoke("dir_create", { path: dir, recursive: true })).resolves.toBeNull()
    await expect(invoke("dir_create", { path: dir, recursive: false })).rejects.toMatchObject({
      code: "IO",
    })
  })

  it("file_list 列出条目，目录在前、符号链接在最后，字段与 Rust 一致", async () => {
    await invoke("dir_create", { path: join(root, "list", "sub"), recursive: true })
    await invoke("file_write", { path: join(root, "list", "b.txt"), content: "b" })
    await invoke("file_write", { path: join(root, "list", "a.txt"), content: "a" })
    const result = await invoke<{ entries: Array<{ name: string; kind: string; path: string }> }>(
      "file_list",
      { path: join(root, "list") },
    )
    expect(result.entries.map((entry) => entry.name)).toEqual(["sub", "a.txt", "b.txt"])
    expect(result.entries.map((entry) => entry.kind)).toEqual(["directory", "file", "file"])
    expect(result.entries.every((entry) => entry.path.startsWith(root))).toBe(true)
  })

  it("file_read_binary 返回 number[] 且能原样还原非 UTF-8 字节", async () => {
    const target = join(root, "blob.bin")
    // 直接落盘二进制：file_write 走 UTF-8 文本，不适合造二进制夹具。
    const raw = Buffer.from([0xff, 0x00, 0x80, 0x41])
    writeFileSync(target, raw)
    const binary = await invoke<number[]>("file_read_binary", { path: target })
    expect(Buffer.from(binary)).toEqual(raw)
    await expect(invoke<number[]>("file_read_binary", { path: target, maxBytes: 2 })).rejects.toMatchObject(
      { code: "OTHER" },
    )
  })

  it("file_read 对缺失路径报 PATH_NOT_FOUND，超过 maxBytes 时报错而不截断", async () => {
    await expect(invoke("file_read", { path: join(root, "absent.txt") })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
    const target = join(root, "big.txt")
    await invoke("file_write", { path: target, content: "0123456789" })
    await expect(invoke("file_read", { path: target, maxBytes: 3 })).rejects.toMatchObject({
      code: "OTHER",
    })
    await expect(
      invoke("file_write", { path: join(root, "big2.txt"), content: "0123456789", maxBytes: 3 }),
    ).rejects.toMatchObject({ code: "OTHER" })
  })
})

describe("运行时路径与配置", () => {
  it("get_runtime_paths 的每个目录都在临时根下，且 skills/logs 不在返回体里", async () => {
    const paths = await invoke<Record<string, string>>("get_runtime_paths")
    expect(paths.data).toBe(root)
    expect(paths.memory).toBe(join(root, "memory"))
    expect(paths.sessions).toBe(join(root, "sessions"))
    expect(paths.personality).toBe(join(root, "personality"))
    expect(paths.profiles).toBe(join(root, "profiles"))
    expect(paths.settings).toBe(join(root, "settings"))
    expect(paths.configFile).toBe(join(root, "settings", "CONFIG.yaml"))
    expect(paths.runtimeMode).toBe("development")
    expect(Object.keys(paths).sort()).toEqual([
      "configFile",
      "data",
      "memory",
      "personality",
      "profiles",
      "runtimeMode",
      "sessions",
      "settings",
    ])
  })

  it("resolve_runtime_path 按域拼接，拒绝越界段与未知域", async () => {
    await expect(
      invoke<string>("resolve_runtime_path", { scope: "sessions", segments: ["s1", "entries.jsonl"] }),
    ).resolves.toBe(join(root, "sessions", "s1", "entries.jsonl"))
    await expect(
      invoke("resolve_runtime_path", { scope: "sessions", segments: ["..", "escape"] }),
    ).rejects.toMatchObject({ code: "PATH_ESCAPE" })
    await expect(
      invoke("resolve_runtime_path", { scope: "no_such_scope", segments: [] }),
    ).rejects.toMatchObject({ code: "OTHER" })
  })

  it("读写运行时配置往返，缺失时读取报 IO（Rust 侧就是 Io，不是 PATH_NOT_FOUND）", async () => {
    await expect(invoke("read_runtime_config")).rejects.toMatchObject({ code: "IO" })
    await invoke("write_runtime_config", { content: "general:\n  loggingLevel: info\n" })
    await expect(invoke<string>("read_runtime_config")).resolves.toBe(
      "general:\n  loggingLevel: info\n",
    )
    expect(readFileSync(join(root, "settings", "CONFIG.yaml"), "utf8")).toContain("loggingLevel")
  })

  it("会话 UI 状态：缺失时是 null（Rust Option::None），写入后原样回读", async () => {
    await expect(invoke("read_session_ui_state")).resolves.toBeNull()
    await invoke("write_session_ui_state", { content: '{"activeSessionId":"s1"}' })
    await expect(invoke<string>("read_session_ui_state")).resolves.toBe(
      '{"activeSessionId":"s1"}',
    )
  })
})

describe("personality / profile 域命令", () => {
  it("personality_file_write 返回写入的绝对路径，内容按字节回读", async () => {
    const written = await invoke<string>("personality_file_write", {
      path: "cards/糖.md",
      content: Array.from(new TextEncoder().encode("# 糖\n")),
    })
    expect(written).toBe(join(root, "personality", "cards", "糖.md"))
    const raw = await invoke<number[]>("personality_file_read", { path: "cards/糖.md" })
    expect(new TextDecoder().decode(new Uint8Array(raw))).toBe("# 糖\n")
  })

  it("personality_file_list 列出目录，目录不存在时是空数组", async () => {
    await invoke("personality_file_write", {
      path: "stages/a.json",
      content: Array.from(new TextEncoder().encode("{}")),
    })
    await invoke("personality_file_write", {
      path: "stages/b.json",
      content: Array.from(new TextEncoder().encode("{}")),
    })
    await expect(invoke<string[]>("personality_file_list", { dirPath: "stages" })).resolves.toEqual([
      "a.json",
      "b.json",
    ])
    await expect(invoke<string[]>("personality_file_list", { dirPath: "absent" })).resolves.toEqual(
      [],
    )
  })

  it("personality 域拒绝域前缀、缺失文件报 PATH_NOT_FOUND", async () => {
    await expect(invoke("personality_file_read", { path: "personality/cards/x.md" })).rejects.toMatchObject(
      { code: "OTHER" },
    )
    await expect(invoke("personality_file_read", { path: "cards/x.md" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
  })

  it("profile 文件读写与素材目录：无 profile.yaml 时 profile_asset_base 是空串", async () => {
    await invoke("profile_file_write", {
      profileId: "sugar-pink",
      relativePath: "assets/layer.png",
      content: [1, 2, 3],
    })
    await expect(
      invoke<number[]>("profile_file_read", { profileId: "sugar-pink", relativePath: "assets/layer.png" }),
    ).resolves.toEqual([1, 2, 3])
    await expect(invoke<string>("profile_asset_base", { profileId: "sugar-pink" })).resolves.toBe("")
    await invoke("profile_file_write", {
      profileId: "sugar-pink",
      relativePath: "profile.yaml",
      content: Array.from(new TextEncoder().encode("id: sugar-pink\n")),
    })
    await expect(invoke<string>("profile_asset_base", { profileId: "sugar-pink" })).resolves.toBe(
      join(root, "profiles", "sugar-pink"),
    )
    await expect(
      invoke("profile_file_read", { profileId: "sugar-pink", relativePath: "assets/missing.png" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })
  })

  it("list_profiles 只列目录并按字节序升序", async () => {
    await invoke("profile_file_write", { profileId: "b", relativePath: "profile.yaml", content: [1] })
    await invoke("profile_file_write", { profileId: "a", relativePath: "profile.yaml", content: [1] })
    await invoke("file_write", { path: join(root, "profiles", "loose.txt"), content: "x" })
    await expect(invoke<string[]>("list_profiles")).resolves.toEqual(["a", "b"])
  })
})

describe("skill 目录指纹", () => {
  it("指纹覆盖根级 .md 与嵌套 SKILL.md，目录变化后指纹变化", async () => {
    const empty = await invoke<{ fingerprint: string; count: number; truncated: boolean }>(
      "skill_catalog_fingerprint",
    )
    expect(empty).toMatchObject({ count: 0, truncated: false })

    await invoke("file_write", {
      path: join(root, "skills", "alpha", "SKILL.md"),
      content: "---\nname: alpha\n---\n",
    })
    await invoke("file_write", {
      path: join(root, "skills", "loose.md"),
      content: "---\ndescription: 单文件技能\n---\n",
    })
    // 非候选：下钻层级里的普通 .md 与 txt 都不进指纹。
    await invoke("file_write", { path: join(root, "skills", "alpha", "notes.md"), content: "x" })
    await invoke("file_write", { path: join(root, "skills", "alpha", "raw.txt"), content: "x" })

    const filled = await invoke<{ fingerprint: string; count: number; truncated: boolean }>(
      "skill_catalog_fingerprint",
    )
    expect(filled.count).toBe(2)
    expect(filled.fingerprint).not.toBe(empty.fingerprint)

    await invoke("file_write", {
      path: join(root, "skills", "beta", "SKILL.md"),
      content: "---\nname: beta\n---\n",
    })
    const grown = await invoke<{ fingerprint: string; count: number }>("skill_catalog_fingerprint")
    expect(grown.count).toBe(3)
    expect(grown.fingerprint).not.toBe(filled.fingerprint)

    // 再扫一次同样的磁盘状态，指纹必须稳定（同一状态同一指纹）。
    await expect(invoke<{ fingerprint: string }>("skill_catalog_fingerprint")).resolves.toMatchObject({
      fingerprint: grown.fingerprint,
    })
  })

  it("skill_delete 按域内相对路径删除，缺失目标报 PATH_NOT_FOUND", async () => {
    await invoke("file_write", {
      path: join(root, "skills", "alpha", "SKILL.md"),
      content: "---\nname: alpha\n---\n",
    })
    await invoke("skill_delete", { relativePath: "alpha" })
    await expect(invoke<boolean>("file_exists", { path: join(root, "skills", "alpha") })).resolves.toBe(
      false,
    )
    await expect(invoke("skill_delete", { relativePath: "alpha" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    })
    await expect(invoke("skill_delete", { relativePath: "../escape" })).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    })
  })
})

describe("记忆文件与日志", () => {
  it("init_memory_files 只生成 CANDY 指令文件并返回 memory 目录", async () => {
    const memory = await invoke<string>("init_memory_files")
    expect(memory).toBe(join(root, "memory"))
    expect(readdirSync(memory).sort()).toEqual(["CANDY.md"])
    expect(readFileSync(join(memory, "CANDY.md"), "utf8")).toContain("## 指令")
    // 已存在的人工指令不被覆盖（模板只在缺失时写）。
    await invoke("file_write", { path: join(memory, "CANDY.md"), content: "我的指令" })
    await invoke("init_memory_files")
    expect(readFileSync(join(memory, "CANDY.md"), "utf8")).toBe("我的指令")
  })

  it("log_messages 原样落到 {logs}/deskpet.log", async () => {
    await invoke("log_messages", { msgs: ["[10:00:00.000] INFO  [App] 第一条"] })
    await invoke("log_messages", { msgs: ["[10:00:01.000] WARN  [App] 第二条"] })
    const content = readFileSync(join(root, "logs", "deskpet.log"), "utf8")
    expect(content).toBe("[10:00:00.000] INFO  [App] 第一条\n[10:00:01.000] WARN  [App] 第二条\n")
  })

  it("set_log_config 生效级别可回读，report_frontend_error 带来源与消息落盘", async () => {
    await invoke("set_log_config", { level: 1 })
    expect(getNodeLogLevel()).toBe(1)
    await invoke("report_frontend_error", {
      source: "window.onerror",
      message: "boom",
      stack: "at foo (app.js:1:1)",
    })
    const content = readFileSync(join(root, "logs", "deskpet.log"), "utf8")
    expect(content).toContain("[前端异常][window.onerror] boom")
    expect(content).toContain("at foo (app.js:1:1)")
  })
})

describe("node-path / node-event 适配", () => {
  it("路径函数与真实 @tauri-apps/api/path 的导出名与语义一致", async () => {
    await expect(joinPath("a", "b", "c.txt")).resolves.toBe(join("a", "b", "c.txt"))
    await expect(resolvePath("a", "..", "b")).resolves.toBe(join(process.cwd(), "b"))
    await expect(isAbsolute("/tmp/x")).resolves.toBe(true)
    await expect(isAbsolute("tmp/x")).resolves.toBe(false)
    await expect(basename(join(root, "y.txt"))).resolves.toBe("y.txt")
    await expect(dirname(join(root, "y.txt"))).resolves.toBe(root)
    await expect(normalize(`${root}//x/./y`)).resolves.toBe(join(root, "x", "y"))
    await expect(homeDir()).resolves.toBe(homedir())
    await expect(tempDir()).resolves.toBe(tmpdir())
  })

  it("事件订阅与发送抛错，不做「订阅成功但永不触发」的空实现", async () => {
    await expect(listen("deskpet://tick", () => {})).rejects.toMatchObject({
      name: "UnsupportedInNodeError",
      command: "event.listen(deskpet://tick)",
    })
    await expect(eventEmit("deskpet://tick", {})).rejects.toMatchObject({
      name: "UnsupportedInNodeError",
      command: "event.emit(deskpet://tick)",
    })
  })

  it("适配层的根就是临时目录，删除它不影响仓库工作区", () => {
    expect(getTestDataRoot()).toBe(root)
    expect(root.startsWith(tmpdir())).toBe(true)
    rmSync(root, { recursive: true, force: true })
    // 用 node:path 的 basename 而不是 split("/")：Windows 的分隔符是反斜杠，
    // split 取不到末段会让断言恒真（假绿），而不是失败。
    expect(readdirSync(tmpdir()).includes(pathBasename(root))).toBe(false)
  })
})
