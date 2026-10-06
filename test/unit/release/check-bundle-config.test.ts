import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
// 脚本是 Node 侧 ESM 工具（scripts/*.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// 按运行期契约导入，形状由下面的 CheckBundleConfig 钉住。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与形状检查照常生效。
import { checkBundleConfig as checkBundleConfigSource, resolveTag as resolveTagSource } from "../../../scripts/check-bundle-config.mjs"

/** 校验器的运行期契约（与 scripts/check-bundle-config.mjs 的导出一致）。 */
type CheckBundleConfig = (
  rootDir: string,
  options?: { tag?: string | null; requireStaging?: boolean },
) => string[]
const checkBundleConfig: CheckBundleConfig = checkBundleConfigSource

/** tag 解析器的运行期契约。 */
type ResolveTag = (env: Record<string, string | undefined>, argv: string[]) => string | null
const resolveTag: ResolveTag = resolveTagSource

const BASE_VERSION = "0.15.0"

interface FixtureOptions {
  /** 覆盖默认 config 的 productName（默认 ASCII；非 ASCII 会进产物文件名，被 GitHub 剥掉）。 */
  productName?: string
  /** 覆盖 identifier */
  identifier?: string
  /** 全部版本源的基数（默认 0.15.0）。单独漂移用 packageVersion / workspaceVersion。 */
  desktopVersion?: string
  /** desktop.json 的 binaries 覆盖（默认 [ { path: "native-host", main: true } ]） */
  binaries?: unknown
  /** desktop.json 的 resources 覆盖 */
  resources?: unknown
  /** desktop.json 整份原文（用于构造坏 JSON） */
  desktopRaw?: string
  /** 单独覆盖 package.json 的 version，用来构造「与主对象不一致」 */
  packageVersion?: string
  /** 单独覆盖根 Cargo.toml 的 [workspace.package] version */
  workspaceVersion?: string
  /** 根 Cargo.toml 整份原文（用于构造「缺 [workspace.package] 段」） */
  workspaceCargoRaw?: string
  /** packaging/node-runtime.json 整体覆盖；显式 null = 不写该文件 */
  nodeRuntime?: Record<string, unknown> | null
  /** 创建 packaging/dist/node 暂存 */
  stageNode?: boolean
  /** 创建 packaging/dist/harness 暂存：file = 含 main.mjs；empty = 空目录 */
  stageHarness?: "file" | "empty"
  /** 写入 packaging/dist/version-set.json（对象按 JSON 序列化） */
  versionSet?: unknown
  /** packaging/dist/version-set.json 整份原文（用于构造坏 JSON） */
  versionSetRaw?: string
}

/** 校验器期待的 version-set 形状：app / node 与各自锁定值一致，harness 是 64 位小写 hex。 */
function validVersionSet(): Record<string, unknown> {
  return { app: BASE_VERSION, node: validNodeRuntime().nodeVersion, harness: "a".repeat(64) }
}

function validNodeRuntime(): Record<string, unknown> {
  return {
    $schema: "desk-pet/node-runtime@1",
    nodeVersion: "22.22.3",
    nodeMajorLine: 22,
    minimumRequirement: ">=22.19.0",
    provisional: false,
    verification: { darwinArm64: { observedNodeVersion: "22.22.3" } },
  }
}

function fixtureRoot(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "bundle-config-"))
  mkdirSync(join(root, "packaging"), { recursive: true })
  mkdirSync(join(root, "resources", "defaults"), { recursive: true })
  writeFileSync(join(root, "resources", "defaults", "sentinel.txt"), "seed")

  const baseVersion = options.desktopVersion ?? BASE_VERSION
  const productName = options.productName ?? "v1rtual-desk-pet"
  const identifier = options.identifier ?? "com.v1rtual.deskpet"

  // 根 Cargo.toml：版本的单一真相源在 [workspace.package]；段外故意放一条行首
  // `version = "9.9.9"` 干扰行 —— 按「首个行首 version」读取会读错，本夹具钉住按段定位。
  writeFileSync(join(root, "Cargo.toml"), options.workspaceCargoRaw ?? [
    "[workspace]",
    'resolver = "2"',
    'members = ["crates/native-host"]',
    "",
    "[workspace.package]",
    `version = "${options.workspaceVersion ?? baseVersion}"`,
    'edition = "2021"',
    "",
    "# 段外干扰行：不能按「首个行首 version」误读成真相源",
    "[workspace.metadata.demo]",
    'version = "9.9.9"',
    "",
  ].join("\n"))

  writeFileSync(join(root, "package.json"), JSON.stringify(
    {
      name: "deskpet-fixture",
      version: options.packageVersion ?? baseVersion,
    },
    null,
    2,
  ))

  if (options.desktopRaw !== undefined) {
    writeFileSync(join(root, "packaging", "desktop.json"), options.desktopRaw)
  } else {
    writeFileSync(join(root, "packaging", "desktop.json"), JSON.stringify(
      {
        $schema: "https://raw.githubusercontent.com/crabnebula-dev/cargo-packager/@crabnebula/packager-v0.11.8/crates/packager/schema.json",
        name: "v1rtual-desk-pet",
        productName,
        version: baseVersion,
        identifier,
        outDir: "dist",
        binariesDir: "../target/release",
        binaries: options.binaries ?? [{ path: "native-host", main: true }],
        resources: options.resources ?? [
          { src: "dist/node", target: "node" },
          { src: "dist/harness", target: "harness" },
          { src: "../resources/defaults", target: "defaults" },
        ],
      },
      null,
      2,
    ))
  }

  if (options.nodeRuntime !== null) {
    writeFileSync(join(root, "packaging", "node-runtime.json"),
      JSON.stringify(options.nodeRuntime ?? validNodeRuntime(), null, 2))
  }

  if (options.stageNode) {
    mkdirSync(join(root, "packaging", "dist", "node", "bin"), { recursive: true })
    writeFileSync(join(root, "packaging", "dist", "node", "bin", "node"), "x")
  }
  if (options.stageHarness === "file") {
    mkdirSync(join(root, "packaging", "dist", "harness"), { recursive: true })
    writeFileSync(join(root, "packaging", "dist", "harness", "main.mjs"), "x")
  } else if (options.stageHarness === "empty") {
    mkdirSync(join(root, "packaging", "dist", "harness"), { recursive: true })
  }
  if (options.versionSet !== undefined || options.versionSetRaw !== undefined) {
    mkdirSync(join(root, "packaging", "dist"), { recursive: true })
    const raw = options.versionSetRaw ?? JSON.stringify(options.versionSet ?? validVersionSet(), null, 2)
    writeFileSync(join(root, "packaging", "dist", "version-set.json"), raw)
  }
  return root
}

describe("checkBundleConfig", () => {
  it("合规夹具零问题（暂存缺席也通过 —— CI 的 checkout 里没有 gitignore 的 dist/）", () => {
    expect(checkBundleConfig(fixtureRoot())).toEqual([])
  })

  it("productName 含非 ASCII 字符被拦，点名 GitHub 剥名、更新清单被静默跳过的后果", () => {
    // v0.15.0 发布事故：productName 是中文 → 产物文件名带中文 → GitHub 上传时剥掉非 ASCII →
    // 发布侧匹配不到自己的产物名，静默跳过更新清单（update.json）的组件条目：CI 全绿，更新永久失效。
    const problems = checkBundleConfig(fixtureRoot({ productName: "虚拟桌宠" }))
    expect(problems.some(p => p.includes("productName") && p.includes("update.json"))).toBe(true)
    // 判据必须是「纯 ASCII」而不是「有没有中文」：重音字母同样会被 GitHub 剥掉，只有 ASCII 才安全
    const accented = checkBundleConfig(fixtureRoot({ productName: "café-desk-pet" }))
    expect(accented.some(p => p.includes("productName"))).toBe(true)
  })

  it("identifier 不是反向域名被拦", () => {
    const problems = checkBundleConfig(fixtureRoot({ identifier: "deskpet" }))
    expect(problems.some(p => p.includes("packaging/desktop.json") && p.includes("identifier"))).toBe(true)
  })

  it("binaries 形状：空数组、main 数量不是 1、path 为空都被拦", () => {
    const empty = checkBundleConfig(fixtureRoot({ binaries: [] }))
    expect(empty.some(p => p.includes("binaries") && p.includes("非空数组"))).toBe(true)

    // cargo-packager 的 main_binary() 找不到 main: true 会直接报 MainBinaryNotFound 打包失败
    const noMain = checkBundleConfig(fixtureRoot({ binaries: [{ path: "native-host", main: false }] }))
    expect(noMain.some(p => p.includes("main: true"))).toBe(true)

    const badPath = checkBundleConfig(fixtureRoot({ binaries: [{ path: "", main: true }] }))
    expect(badPath.some(p => p.includes("path"))).toBe(true)

    // cargo-packager 不支持字符串简写（schema 里 Binary 是对象）
    const shorthand = checkBundleConfig(fixtureRoot({ binaries: ["native-host"] }))
    expect(shorthand.some(p => p.includes("binaries[0]"))).toBe(true)
  })

  it("resources 形状：缺 target 的对象被拦", () => {
    const resources = [{ src: "dist/harness" }]
    const problems = checkBundleConfig(fixtureRoot({ resources }))
    expect(problems.some(p => p.includes("resources[0]") && p.includes("target"))).toBe(true)
  })

  it("resources 非暂存 src 不存在被拦（repo 内资源被改名不能留到打包才炸）", () => {
    const resources = [{ src: "../resources/missing", target: "missing" }]
    const problems = checkBundleConfig(fixtureRoot({ resources }))
    expect(problems.some(p => p.includes("src 不存在") && p.includes("missing"))).toBe(true)
  })

  it("发布闭包不得含测试 / trace 常驻资产", () => {
    const resources = [{ src: "../test/.tmp/fixture-bundle", target: "fixture" }]
    const problems = checkBundleConfig(fixtureRoot({ resources }))
    expect(problems.some(p => p.includes("发布闭包"))).toBe(true)
  })

  it("resources 暂存 src：requireStaging 打开时缺失被拦；默认不拦（CI 无暂存）", () => {
    const root = fixtureRoot()
    expect(checkBundleConfig(root)).toEqual([])
    const problems = checkBundleConfig(root, { requireStaging: true })
    expect(problems.some(p => p.includes("暂存") && p.includes("dist/node"))).toBe(true)
    expect(problems.some(p => p.includes("暂存") && p.includes("dist/harness"))).toBe(true)
  })

  it("resources 暂存 src 存在但为空目录被拦（默认口径也拦 —— 空暂存 = 包树缺组件）", () => {
    const problems = checkBundleConfig(fixtureRoot({ stageHarness: "empty" }))
    expect(problems.some(p => p.includes("dist/harness") && p.includes("空目录"))).toBe(true)
  })

  it("暂存齐备时 requireStaging 通过", () => {
    const root = fixtureRoot({ stageNode: true, stageHarness: "file" })
    // requireStaging 也要求 version-set.json 已由暂存步骤产出，且 app / node 与锁定值一致
    writeFileSync(join(root, "packaging", "dist", "version-set.json"), JSON.stringify({
      app: BASE_VERSION,
      node: validNodeRuntime().nodeVersion,
      harness: "a".repeat(64),
    }, null, 2))
    expect(checkBundleConfig(root, { requireStaging: true })).toEqual([])
  })

  it("version-set.json 的 app / node 与各自锁定值不一致时逐项被拦（暂存集漂移不能留到打包）", () => {
    const appDrift = checkBundleConfig(fixtureRoot({ versionSet: { ...validVersionSet(), app: "0.16.0" } }))
    expect(
      appDrift.some(p => p.includes("version-set.json") && p.includes(".app") && p.includes("0.16.0")),
      `app 与 desktop.json 不一致未被拦: ${JSON.stringify(appDrift)}`,
    ).toBe(true)

    const nodeDrift = checkBundleConfig(fixtureRoot({ versionSet: { ...validVersionSet(), node: "22.19.9" } }))
    expect(
      nodeDrift.some(p => p.includes("version-set.json") && p.includes(".node") && p.includes("22.19.9")),
      `node 与 node-runtime.json 不一致未被拦: ${JSON.stringify(nodeDrift)}`,
    ).toBe(true)
  })

  it("version-set.json 的 harness 必须是 64 位小写十六进制（长度与大小写两种坏形态都拦）", () => {
    // 长度不足：正则若被放宽成 [a-f0-9]+ 这条立即红
    const short = checkBundleConfig(fixtureRoot({ versionSet: { ...validVersionSet(), harness: "a".repeat(63) } }))
    expect(short.some(p => p.includes("version-set.json") && p.includes("harness"))).toBe(true)
    // 大写 hex：等值文本但不是指纹形态，正则若被改成大小写不敏感这条立即红
    const upper = checkBundleConfig(fixtureRoot({ versionSet: { ...validVersionSet(), harness: "A".repeat(64) } }))
    expect(upper.some(p => p.includes("version-set.json") && p.includes("harness"))).toBe(true)
  })

  it("version-set.json 不是合法 JSON（或顶层不是对象）被拦，其余检查继续而不是整体短路", () => {
    const root = fixtureRoot({ versionSetRaw: "{ 坏掉的 version-set" })
    const problems = checkBundleConfig(root)
    expect(problems.some(p => p.includes("version-set.json") && p.includes("不是合法 JSON"))).toBe(true)
    // 其余检查仍在跑：desktop.json 等其余文件合规时，version-set 是唯一的报错项
    expect(problems).toHaveLength(1)

    // 合法 JSON 但不是对象：同一守卫的另一半（数组也算顶层形状错）
    const array = checkBundleConfig(fixtureRoot({ versionSetRaw: "[]" }))
    expect(array.some(p => p.includes("version-set.json") && p.includes("顶层必须是对象"))).toBe(true)
  })

  it("node-runtime 实测记录与锁定 nodeVersion 分叉被拦", () => {
    const runtime = validNodeRuntime()
    runtime.verification = { darwinArm64: { observedNodeVersion: "22.19.9" } }
    const problems = checkBundleConfig(fixtureRoot({ nodeRuntime: runtime }))
    expect(problems.some(p => p.includes("observedNodeVersion") && p.includes("22.19.9"))).toBe(true)
  })

  it("node-runtime provisional 未定稿被拦", () => {
    const runtime = validNodeRuntime()
    runtime.provisional = true
    const problems = checkBundleConfig(fixtureRoot({ nodeRuntime: runtime }))
    expect(problems.some(p => p.includes("provisional"))).toBe(true)
  })

  it("node-runtime 锁定版本低于 minimumRequirement 被拦", () => {
    const runtime = validNodeRuntime()
    runtime.minimumRequirement = ">=23.1.0"
    const problems = checkBundleConfig(fixtureRoot({ nodeRuntime: runtime }))
    expect(problems.some(p => p.includes("minimumRequirement"))).toBe(true)
  })

  it("node-runtime 文件缺失被拦", () => {
    const problems = checkBundleConfig(fixtureRoot({ nodeRuntime: null }))
    expect(problems.some(p => p.includes("packaging/node-runtime.json") && p.includes("不存在"))).toBe(true)
  })

  it("package.json 的 version 与 desktop.json 不一致被拦，点名文件并给出 version:set 修法", () => {
    const problems = checkBundleConfig(fixtureRoot({ packageVersion: "0.16.0" }))
    expect(problems.some(p => p.includes("package.json") && p.includes("version:set"))).toBe(true)
  })

  it("根 Cargo.toml 的 [workspace.package] version 与 desktop.json 不一致被拦", () => {
    const problems = checkBundleConfig(fixtureRoot({ workspaceVersion: "0.16.0" }))
    expect(problems.some(p => p.startsWith("Cargo.toml 的 version") && p.includes("version:set"))).toBe(true)
  })

  it("根 Cargo.toml 缺 [workspace.package] 段被拦（单一真相源不存在）", () => {
    const problems = checkBundleConfig(fixtureRoot({ workspaceCargoRaw: '[workspace]\nmembers = []\n' }))
    expect(problems.some(p => p.includes("workspace.package"))).toBe(true)
  })

  it("tag 与三处 version 一致则通过；不一致时逐文件报出（不能只查某一处）", () => {
    expect(checkBundleConfig(fixtureRoot(), { tag: "v0.15.0" })).toEqual([])

    // 三处全部漂到 0.16.0：两两对照无话可说，只有 tag 逐文件核对能报出，必须各报一条
    const problems = checkBundleConfig(fixtureRoot({ desktopVersion: "0.16.0" }), { tag: "v0.15.0" })
    expect(problems.filter(p => p.includes("tag v0.15.0"))).toHaveLength(3)
    for (const file of ["packaging/desktop.json", "package.json", "Cargo.toml"]) {
      expect(
        problems.some(p => p.includes(`tag v0.15.0 与 ${file} 的 version`) && p.includes("version:set")),
      ).toBe(true)
    }
  })

  it("desktop.json 不是合法 JSON 时给出可读报错，其余检查继续而不是整体短路", () => {
    const root = fixtureRoot({ desktopRaw: "{ 坏掉的 json" })
    const problems = checkBundleConfig(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("packaging/desktop.json")
  })
})

describe("resolveTag", () => {
  it("GITHUB_REF_TYPE 是 branch 时忽略 GITHUB_REF_NAME —— 否则每次 push/PR 都会误报版本不一致", () => {
    expect(resolveTag({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "master" }, ["node", "script.mjs"])).toBe(null)
    expect(resolveTag({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "123/merge" }, ["node", "script.mjs"])).toBe(null)
  })

  it("GITHUB_REF_TYPE 是 tag 时取 GITHUB_REF_NAME", () => {
    expect(resolveTag({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.15.0" }, ["node", "script.mjs"])).toBe("v0.15.0")
  })

  it("没有 GITHUB_REF_TYPE 时回退到位置参数；两者都没有则为 null", () => {
    expect(resolveTag({}, ["node", "script.mjs", "v0.15.0"])).toBe("v0.15.0")
    expect(resolveTag({}, ["node", "script.mjs"])).toBe(null)
  })
})
