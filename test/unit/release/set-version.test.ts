import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
// 脚本是 Node 侧 ESM 工具（scripts/*.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与运行期契约照常生效。
import { applyVersion, parseVersion } from "../../../scripts/set-version.mjs"

/**
 * 根 Cargo.toml（虚拟清单）：真相源在 [workspace.package] 段内。
 * 段外故意放一条行首 `version = "9.9.9"`（[workspace.metadata.demo]）：旧的
 * 「首个行首 version」口径会误伤它 —— 原生宿主迁移过程记录 §9.4 第 33 条登记的地雷。
 */
function rootCargoToml(workspaceVersion = '"0.1.0"') {
  return [
    "[workspace]",
    'resolver = "2"',
    'members = ["crates/native-host"]',
    "",
    "[workspace.package]",
    `version = ${workspaceVersion}`,
    'edition = "2021"',
    "",
    "# 段外干扰行：行首 version 不在 [workspace.package] 段内，不能被误伤",
    "[workspace.metadata.demo]",
    'version = "9.9.9"',
    "",
    "[profile.release]",
    "strip = true",
    "",
  ].join("\n")
}

function fixtureRoot(
  workspaceVersion = '"0.1.0"',
  desktopVersion = '"0.1.0"',
  packageVersion = '"0.1.0"',
) {
  const root = mkdtempSync(join(tmpdir(), "set-version-"))
  mkdirSync(join(root, "packaging"), { recursive: true })
  writeFileSync(join(root, "Cargo.toml"), rootCargoToml(workspaceVersion))
  writeFileSync(join(root, "package.json"),
    `{\n  "name": "v1rtual-desk-pet",\n  "version": ${packageVersion}\n}\n`)
  writeFileSync(join(root, "packaging", "desktop.json"),
    `{\n  "productName": "v1rtual-desk-pet",\n  "version": ${desktopVersion},\n  "identifier": "com.v1rtual.deskpet"\n}\n`)
  return root
}

describe("parseVersion", () => {
  it("接受裸 semver 与 v 前缀，并剥掉前缀", () => {
    expect(parseVersion("0.15.0")).toBe("0.15.0")
    expect(parseVersion(" v0.15.0 ")).toBe("0.15.0")
    expect(parseVersion("0.15.0-rc.1")).toBe("0.15.0-rc.1")
  })

  it("拒绝非 semver", () => {
    for (const bad of ["0.15", "abc", "", "1.2.3.4", "v"]) {
      expect(() => parseVersion(bad), `应拒绝 ${JSON.stringify(bad)}`).toThrowError(/semver/)
    }
  })
})

describe("applyVersion", () => {
  it("真相源与全部投影同时改写：根 Cargo.toml 的 [workspace.package]、package.json、desktop.json", () => {
    const root = fixtureRoot()
    const written = applyVersion(root, "0.15.0")
    expect(written).toEqual([
      "Cargo.toml",
      "package.json",
      "packaging/desktop.json",
    ])

    const cargo = readFileSync(join(root, "Cargo.toml"), "utf8")
    expect(cargo).toContain('[workspace.package]\nversion = "0.15.0"')
    // 段外的干扰行（行首 version）不能被误伤 —— 这是与旧「首个行首」口径的分界线
    expect(cargo).toContain('version = "9.9.9"')
    expect(cargo).toContain('edition = "2021"')
    expect(cargo).toContain("strip = true")

    const pkg = readFileSync(join(root, "package.json"), "utf8")
    expect(pkg).toContain('"version": "0.15.0"')
    expect(pkg).toContain('"name": "v1rtual-desk-pet"')

    const desktop = readFileSync(join(root, "packaging", "desktop.json"), "utf8")
    expect(desktop).toContain('"version": "0.15.0"')
    expect(desktop).toContain('"identifier": "com.v1rtual.deskpet"')
  })

  it("根 Cargo.toml 找不到 [workspace.package] 段时报错，而不是退回「首个行首 version」误伤段外行", () => {
    const root = fixtureRoot()
    // 段被删掉，只剩段外的行首 version 干扰行
    writeFileSync(join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/native-host"]\n\n[workspace.metadata.demo]\nversion = "9.9.9"\n')
    expect(() => applyVersion(root, "0.15.0")).toThrowError(/workspace\.package/)
    // 干扰行保持原值
    expect(readFileSync(join(root, "Cargo.toml"), "utf8")).toContain('version = "9.9.9"')
  })

  it("段内找不到 version 行时报错", () => {
    const root = fixtureRoot()
    writeFileSync(join(root, "Cargo.toml"), '[workspace.package]\nedition = "2021"\n')
    expect(() => applyVersion(root, "0.15.0")).toThrowError(/version/)
  })

  it("段内多行 version 时报错，不做「改第一行」的猜测", () => {
    const root = fixtureRoot()
    writeFileSync(join(root, "Cargo.toml"), '[workspace.package]\nversion = "0.1.0"\nversion = "0.2.0"\n')
    expect(() => applyVersion(root, "0.15.0")).toThrowError(/多行 version/)
  })

  it("任一处渲染失败时整体不落盘（原子性）：最后一处失败，前两处保持原值", () => {
    const root = fixtureRoot()
    // 抹掉最后一处（packaging/desktop.json）的 version 字段，制造「第三处失败」
    writeFileSync(join(root, "packaging", "desktop.json"),
      '{\n  "productName": "v1rtual-desk-pet",\n  "identifier": "com.v1rtual.deskpet"\n}\n')
    expect(() => applyVersion(root, "0.15.0")).toThrowError(/version/)

    expect(readFileSync(join(root, "Cargo.toml"), "utf8")).toContain('"0.1.0"')
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"0.1.0"')
  })
})
