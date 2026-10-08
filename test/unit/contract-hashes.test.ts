import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

// @ts-expect-error TS7016 —— Node ESM 脚本没有 .d.ts，按运行期导出直接回归。
import { checkContractHashes } from "../../scripts/check-contract-hashes.mjs"

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/check-contract-hashes.mjs", import.meta.url))
const TEST_TMP = fileURLToPath(new URL("../.tmp/contract-hashes/", import.meta.url))
const roots: string[] = []

function createFixture(): string {
  mkdirSync(TEST_TMP, { recursive: true })
  const root = mkdtempSync(join(TEST_TMP, "repo-"))
  roots.push(root)
  mkdirSync(join(root, "test", "contracts"), { recursive: true })
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "alpha", "utf8")
  writeFileSync(join(root, "src", "z.ts"), "beta", "utf8")
  writeFileSync(join(root, "src", "secret.ts"), "SECRET_SOURCE_CONTENT", "utf8")
  writeFileSync(join(root, "src", "secret-two.ts"), "SECOND_SECRET_SOURCE_CONTENT", "utf8")
  const expected = createHash("sha256").update("alpha").update("beta").digest("hex")
  writeFileSync(
    join(root, "test", "contracts", "alpha.contract.ts"),
    `export const contract = {\n  module: "alpha",\n  sourceFiles: ["src/z.ts", "src/a.ts"],\n  sourceHash: "${expected}",\n}\n`,
    "utf8",
  )
  writeFileSync(
    join(root, "test", "contracts", "beta.contract.ts"),
    `export const contract = {\n  module: "beta",\n  sourceFiles: ["src/secret.ts"],\n  sourceHash: "",\n}\n`,
    "utf8",
  )
  writeFileSync(
    join(root, "test", "contracts", "gamma.contract.ts"),
    `export const contract = {\n  module: "gamma",\n  sourceFiles: ["src/secret-two.ts"],\n  sourceHash: "${"0".repeat(64)}",\n}\n`,
    "utf8",
  )
  writeFileSync(
    join(root, "test", "contracts", "delta.contract.ts"),
    `export const contract = {\n  module: "delta",\n  sourceFiles: ["src/missing.ts"],\n  sourceHash: "deadbeef",\n}\n`,
    "utf8",
  )
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Contract sourceHash 校验", () => {
  it("按排序后的 sourceFiles 内容生成与 E2E 相同的 attestation", () => {
    const root = createFixture()
    const expected = createHash("sha256").update("alpha").update("beta").digest("hex")

    expect(checkContractHashes({ root, contracts: "selected", module: "alpha" })).toEqual({ alpha: expected })
  })

  it("selected 未提供模块时仍全量校验，stale 报模块和两种 hash 且 CLI 非零退出、不打印源码", () => {
    const root = createFixture()
    const currentBeta = createHash("sha256").update("SECRET_SOURCE_CONTENT").digest("hex")
    const currentGamma = createHash("sha256").update("SECOND_SECRET_SOURCE_CONTENT").digest("hex")

    let failure: unknown
    try {
      checkContractHashes({ root, contracts: "selected" })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    const failureMessage = (failure as Error).message
    expect(failureMessage).toContain(
      `[STALE] module=beta contract=beta.contract.ts: sourceHash=<empty>, current=${currentBeta}`,
    )
    expect(failureMessage).toContain(
      `[STALE] module=gamma contract=gamma.contract.ts: sourceHash=${"0".repeat(64)}, current=${currentGamma}`,
    )
    expect(failureMessage).toContain(
      "[STALE] module=delta contract=delta.contract.ts: sourceHash=deadbeef, current=<unavailable>",
    )
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--contracts=all"],
      { cwd: root, encoding: "utf8" },
    )
    const output = `${result.stdout}${result.stderr}`
    expect(result.status).toBe(1)
    expect(output).toContain(`module=beta contract=beta.contract.ts: sourceHash=<empty>, current=${currentBeta}`)
    expect(output).toContain(`module=gamma contract=gamma.contract.ts: sourceHash=${"0".repeat(64)}, current=${currentGamma}`)
    expect(output).toContain("module=delta contract=delta.contract.ts: sourceHash=deadbeef, current=<unavailable>")
    expect(output).not.toContain("SECRET_SOURCE_CONTENT")
    expect(output).not.toContain("SECOND_SECRET_SOURCE_CONTENT")
  })
})
