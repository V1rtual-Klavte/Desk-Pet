import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
// 脚本是 Node 侧 ESM 工具（scripts/*.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与运行期契约照常生效。
import { applyVersion, parseVersion } from "../../../scripts/set-version.mjs"

function fixtureRoot(tauriVersion = '"0.1.0"', cargoVersion = '"0.1.0"', pkgVersion = '"0.1.0"') {
  const root = mkdtempSync(join(tmpdir(), "set-version-"))
  mkdirSync(join(root, "src-tauri"), { recursive: true })
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"),
    `{\n  "productName": "虚拟桌宠",\n  "version": ${tauriVersion},\n  "identifier": "com.v1rtual.deskpet"\n}\n`)
  writeFileSync(join(root, "src-tauri", "Cargo.toml"),
    `[package]\nname = "v1rtual-desk-pet"\nversion = ${cargoVersion}\nedition = "2021"\n\n[lib]\nname = "v1rtual_desk_pet_lib"\ncrate-type = ["rlib"]\n`)
  writeFileSync(join(root, "package.json"),
    `{\n  "name": "v1rtual-desk-pet",\n  "version": ${pkgVersion}\n}\n`)
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
  it("三处同时改写，且不动其它字段", () => {
    const root = fixtureRoot()
    const written = applyVersion(root, "0.15.0")
    expect(written).toHaveLength(3)

    const tauri = readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
    expect(tauri).toContain('"version": "0.15.0"')
    expect(tauri).toContain('"identifier": "com.v1rtual.deskpet"')

    const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8")
    expect(cargo).toContain('version = "0.15.0"')
    // [lib] 段不能被误伤
    expect(cargo).toContain('crate-type = ["rlib"]')
    expect(cargo.match(/^version = /gm)).toHaveLength(1)

    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"version": "0.15.0"')
  })

  it("任一处缺字段时整体不落盘（原子性）", () => {
    const root = fixtureRoot()
    // 抹掉 package.json 的 version，制造第三处失败
    writeFileSync(join(root, "package.json"), `{\n  "name": "v1rtual-desk-pet"\n}\n`)
    expect(() => applyVersion(root, "0.15.0")).toThrowError(/version/)

    // 前两处必须保持原值 —— 这一条是原子性的判据
    expect(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).toContain('"0.1.0"')
    expect(readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8")).toContain('"0.1.0"')
  })
})
