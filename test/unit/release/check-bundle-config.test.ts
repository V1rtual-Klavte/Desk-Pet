import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
// 脚本是 Node 侧 ESM 工具（scripts/*.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// 按运行期契约导入，形状由下面的 CheckBundleConfig 钉住。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与形状检查照常生效。
import { checkBundleConfig as checkBundleConfigSource, resolveTag as resolveTagSource } from "../../../scripts/check-bundle-config.mjs"

/** 校验器的运行期契约（与 scripts/check-bundle-config.mjs 的导出一致）。 */
type CheckBundleConfig = (rootDir: string, options?: { tag?: string | null }) => string[]
const checkBundleConfig: CheckBundleConfig = checkBundleConfigSource

/** tag 解析器的运行期契约。 */
type ResolveTag = (env: Record<string, string | undefined>, argv: string[]) => string | null
const resolveTag: ResolveTag = resolveTagSource

interface FixtureOptions {
  config?: unknown
  icons?: string[]
  updaterPubkey?: string | null
}

function fixtureRoot(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "bundle-config-"))
  mkdirSync(join(root, "src-tauri", "icons"), { recursive: true })
  for (const name of options.icons ?? ["32x32.png", "128x128.png", "icon.icns", "icon.ico"]) {
    writeFileSync(join(root, "src-tauri", "icons", name), "x")
  }
  const config = options.config ?? {
    productName: "虚拟桌宠",
    version: "0.15.0",
    identifier: "com.v1rtual.deskpet",
    bundle: {
      active: true,
      targets: "all",
      icon: ["icons/32x32.png", "icons/128x128.png", "icons/icon.icns", "icons/icon.ico"],
      resources: { "resources/defaults": "defaults" },
    },
    plugins: {
      updater: {
        pubkey: options.updaterPubkey === undefined ? "dW50cnVzdGVkIGNvbW1lbnQ6" : options.updaterPubkey,
        endpoints: ["https://github.com/V1rtual-Klavte/Desk-Pet/releases/latest/download/latest.json"],
      },
    },
  }
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify(config, null, 2))
  return root
}

describe("checkBundleConfig", () => {
  it("合规配置零问题", () => {
    expect(checkBundleConfig(fixtureRoot())).toEqual([])
  })

  it("图标文件缺失被点名", () => {
    const root = fixtureRoot({ config: undefined, icons: ["32x32.png"] })
    const problems = checkBundleConfig(root)
    expect(problems.some(p => p.includes("128x128.png"))).toBe(true)
    expect(problems.some(p => p.includes("icon.icns"))).toBe(true)
  })

  it("targets 写死单一平台目标被拦（本次要修的原始 bug）", () => {
    const root = fixtureRoot({
      config: {
        productName: "虚拟桌宠", version: "0.15.0", identifier: "com.v1rtual.deskpet",
        bundle: { active: true, targets: ["nsis"], icon: ["icons/32x32.png"], resources: {} },
        plugins: { updater: { pubkey: "k", endpoints: ["https://example.com/latest.json"] } },
      },
    })
    const problems = checkBundleConfig(root)
    expect(problems.some(p => p.includes("targets"))).toBe(true)
  })

  it("identifier 不是反向域名被拦", () => {
    const root = fixtureRoot({
      config: {
        productName: "虚拟桌宠", version: "0.15.0", identifier: "deskpet",
        bundle: { active: true, targets: "all", icon: ["icons/32x32.png"], resources: {} },
        plugins: { updater: { pubkey: "k", endpoints: ["https://example.com/latest.json"] } },
      },
    })
    expect(checkBundleConfig(root).some(p => p.includes("identifier"))).toBe(true)
  })

  it("updater 公钥为空被拦", () => {
    const root = fixtureRoot({ updaterPubkey: "" })
    expect(checkBundleConfig(root).some(p => p.includes("pubkey"))).toBe(true)
  })

  it("tag 与 version 不一致被拦，一致则通过", () => {
    const root = fixtureRoot()
    expect(checkBundleConfig(root, { tag: "v0.15.0" })).toEqual([])
    const problems = checkBundleConfig(root, { tag: "v0.16.0" })
    expect(problems.some(p => p.includes("version:set"))).toBe(true)
  })

  it("tauri.conf.json 不是合法 JSON 时给出可读报错", () => {
    const root = fixtureRoot()
    writeFileSync(join(root, "src-tauri", "tauri.conf.json"), "{ 坏掉的 json")
    const problems = checkBundleConfig(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("tauri.conf.json")
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
