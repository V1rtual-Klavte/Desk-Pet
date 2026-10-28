import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { downloadPinnedExternalFile, getExternalSource } from "../../sim/desk-pet-chat/external/prepare.mjs"

const ROOT = resolve(import.meta.dirname, "../../..")
const owned: string[] = []
function outputRoot() {
  const base = join(ROOT, "test/.tmp/external-eval")
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(join(base, "download-test-"))
  owned.push(directory)
  return directory
}
function url() {
  const source = getExternalSource("multichallenge")
  return `https://huggingface.co/datasets/${source.repository}/resolve/${source.revision}/data/sample.bin`
}
afterEach(() => {
  vi.unstubAllGlobals()
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("公开评测显式下载", () => {
  it("固定版本和内容散列校验后才写入，保持上游相对目录 [external-download-pinned-hash]", async () => {
    const fetch = vi.fn(async () => new Response("abc"))
    vi.stubGlobal("fetch", fetch)
    const outputDir = outputRoot()
    const result = await downloadPinnedExternalFile({
      dataset: "multichallenge", url: url(), outputDir, repoRoot: ROOT,
      expectedSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    })
    expect(result.path).toBe(join(outputDir, "data/sample.bin"))
    expect(readFileSync(result.path, "utf8")).toBe("abc")
    expect(result.sha256).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(result.cached).toBe(false)
    const cached = await downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir, repoRoot: ROOT })
    expect(cached.cached).toBe(true)
    expect(cached.path).toBe(result.path)
    expect(cached.sha256).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("默认下载目录紧邻适配器且复用时不依赖网络 [external-download-persistent-default]", async () => {
    const fetch = vi.fn(async () => new Response("abc"))
    vi.stubGlobal("fetch", fetch)
    const repoRoot = outputRoot()
    const result = await downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), repoRoot })
    expect(result.path).toBe(join(repoRoot, "test/sim/desk-pet-chat/external/.data/multichallenge/raw/data/sample.bin"))
    fetch.mockRejectedValue(new Error("offline"))
    const cached = await downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), repoRoot })
    expect(cached.cached).toBe(true)
    expect(cached.bytes).toBe(3)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("缓存内容损坏时拒绝复用或联网覆盖 [external-download-cache-integrity]", async () => {
    const fetch = vi.fn(async () => new Response("abc"))
    vi.stubGlobal("fetch", fetch)
    const outputDir = outputRoot()
    const result = await downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir })
    writeFileSync(result.path, "corrupt")
    await expect(downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir })).rejects.toThrow(/Cached file SHA-256 mismatch/)
    expect(readFileSync(result.path, "utf8")).toBe("corrupt")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("缓存收据不能冒充不同来源或掩盖缺失校验依据 [external-download-cache-provenance]", async () => {
    const fetch = vi.fn(async () => new Response("abc"))
    vi.stubGlobal("fetch", fetch)
    const outputDir = outputRoot()
    const result = await downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir })
    const receiptPath = `${result.path}.source.json`
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"))
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, revision: "0".repeat(40) }))
    await expect(downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir })).rejects.toThrow(/provenance does not match/)
    rmSync(receiptPath)
    await expect(downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir })).rejects.toThrow(/no SHA-256 lock or source receipt/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("不获取 gated GAIA，拒绝可变 revision 和外域下载 [external-download-source-gate]", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const outputDir = outputRoot()
    await expect(downloadPinnedExternalFile({ dataset: "gaia", url: "https://huggingface.co/file", outputDir })).rejects.toThrow(/cannot be downloaded/)
    await expect(downloadPinnedExternalFile({ dataset: "multichallenge", url: url().replace(getExternalSource("multichallenge").revision, "main"), outputDir })).rejects.toThrow(/pinned revision/)
    await expect(downloadPinnedExternalFile({ dataset: "multichallenge", url: "https://example.com/data", outputDir })).rejects.toThrow(/pinned revision/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("散列不符或超出字节预算时不落下可用输入 [external-download-integrity-gate]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("abc")))
    const outputDir = outputRoot()
    await expect(downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir, expectedSha256: "0".repeat(64) })).rejects.toThrow(/SHA-256/)
    await expect(downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir, maxBytes: 2 })).rejects.toThrow(/byte limit/)
    expect(existsSync(join(outputDir, "data/sample.bin"))).toBe(false)
  })

  it("不跟随跳往任意站点的重定向 [external-download-redirect-gate]", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.com/leak" } }))
    vi.stubGlobal("fetch", fetch)
    await expect(downloadPinnedExternalFile({ dataset: "multichallenge", url: url(), outputDir: outputRoot() })).rejects.toThrow(/trusted dataset download hosts/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("跟随上游当前官方 CDN，同时保留内容散列校验 [external-download-trusted-redirect]", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://us.aws.cdn.hf.co/public-object" } }))
      .mockResolvedValueOnce(new Response("abc"))
    vi.stubGlobal("fetch", fetch)
    const result = await downloadPinnedExternalFile({
      dataset: "multichallenge", url: url(), outputDir: outputRoot(),
      expectedSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(String(fetch.mock.calls[1]![0])).toBe("https://us.aws.cdn.hf.co/public-object")
    expect(result.sha256).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})
