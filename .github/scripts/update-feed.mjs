#!/usr/bin/env node
/**
 * 发布更新清单（update.json）的构建工具 —— 只被 .github/workflows/release.yml 调用。
 *
 * 为什么放在 .github/scripts/：它是发布流水线自己的机制（scripts/ 是产品/测试脚本的落点），
 * 只有 release.yml 一个消费者。
 *
 * 两个子命令：
 *   fragment —— 每个平台的打包 job 末尾：对**刚打出的制品**算 size/sha256，组装被签名的
 *               release envelope（字段与 crates/native-host/src/update/manifest.rs 的
 *               ReleaseEnvelope 一一对应；envelope 以字符串进 feed，签名覆盖其原始字节），
 *               用 cargo-packager 的 minisign signer 签名（私钥/口令经环境变量传入、不落盘），
 *               再用仓库内嵌公钥**现场验签一次**——签名或格式不对就在这里 red，绝不把坏 feed 发出去。
 *   assemble —— 两个平台都成功后：把全部 fragment 合并成单一 update.json；缺平台、重复条目、
 *               tag 版本与 envelope 不一致都直接失败（fail closed，不发布半份 feed）。
 *
 * 用法（release.yml 是唯一调用方）：
 *   node .github/scripts/update-feed.mjs fragment --tag v0.16.0 --platform macos --arch aarch64 \
 *     --kind app --component packaging/dist/v1rtual-desk-pet_0.16.0_aarch64.app.tar.gz \
 *     --out release-assets/update-fragment-macos.json
 *   node .github/scripts/update-feed.mjs assemble --tag v0.16.0 --fragments release-assets \
 *     --out release-assets/update.json
 *
 * 签名密钥环境变量（由 release.yml 从既有 TAURI_SIGNING_* secrets 映射，密钥不进入仓库/日志）：
 *   CARGO_PACKAGER_SIGN_PRIVATE_KEY、CARGO_PACKAGER_SIGN_PRIVATE_KEY_PASSWORD
 */

import { spawnSync } from "node:child_process"
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))

/** 发布必须齐备的平台集合：缺一个就不发布（update.json 是双平台共用的单一 feed）。 */
const EXPECTED_TARGETS = [
  { platform: "macos", arch: "aarch64", kind: "app", suffix: ".tar.gz" },
  { platform: "windows", arch: "x86_64", kind: "installer", suffix: ".exe" },
]

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 极简参数解析：`--k v` 形式，全部参数都要求有值。 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`参数必须成对：收到 ${JSON.stringify(argv.slice(i))}`)
    }
    out[key.slice(2)] = value
  }
  return out
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"))
}

function fail(message) {
  console.error(`update-feed: ${message}`)
  process.exit(1)
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

// ─────────────────────────────── minisign 验签 ───────────────────────────────
// 与 crates/native-host/src/update/verify.rs 的 MinisignVerifier 同口径：minisign 签名块
// 为四行文本（untrusted comment / 签名 base64 / trusted comment / 全局签名 base64）；
// prehashed（alg "ED"）签名覆盖 BLAKE2b-512(数据)，全局签名覆盖 签名字节 ‖ trusted comment 文本。
// 这里复刻一遍是为了在 CI 内做 fail-closed 自检；错的是这一层只会让发布失败，而不是发出坏 feed。

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

function ed25519Key(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" })
}

function parsePublicKey(b64) {
  let blob = Buffer.from(b64, "base64")
  if (blob.length !== 42) {
    // 兼容 minisign 公钥文件全文（untrusted comment 行 + base64 行）被整体 base64 的包装
    const lines = blob.toString("utf8").replace(/\r\n/g, "\n").split("\n")
    if (!lines[0]?.startsWith("untrusted comment: ")) throw new Error("公钥块格式非法")
    blob = Buffer.from(lines[1], "base64")
  }
  if (blob.length !== 42) throw new Error(`公钥 blob 长度应是 42，收到 ${blob.length}`)
  return { keynum: blob.subarray(2, 10), pk: blob.subarray(10, 42) }
}

function parseSignatureBlock(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const [untrusted, sigB64, trusted, globalB64] = lines
  if (!untrusted?.startsWith("untrusted comment: ")) throw new Error("签名块第一行不是 untrusted comment")
  if (!trusted?.startsWith("trusted comment: ")) throw new Error("签名块第三行不是 trusted comment")
  const blob = Buffer.from(sigB64 ?? "", "base64")
  if (blob.length !== 74) throw new Error(`签名 blob 长度应是 74，收到 ${blob.length}`)
  const alg = blob.subarray(0, 2).toString("latin1")
  const globalSig = Buffer.from(globalB64 ?? "", "base64")
  if (globalSig.length !== 64) throw new Error("全局签名长度不是 64")
  return {
    alg,
    keynum: blob.subarray(2, 10),
    sig: blob.subarray(10, 74),
    globalSig,
    trustedText: trusted.slice("trusted comment: ".length),
  }
}

/**
 * 验签成功返回，失败即 fail closed（失败信息直接进 CI 日志）。
 *
 * 失败信息附**定位指纹**：数据长度与 sha256、签名算法、keynum 与公钥是否一致。三项合起来
 * 足以把「密钥不是这把」「签的不是这份字节」「签名块形状不对」分开——只回一句「验签失败」，
 * 远端 CI 上就只能靠重跑猜。指纹不含密钥材料：keynum 只报是否一致，不打印其值。
 */
function verifyOrFail(publicKeyB64, data, signatureBlock, context) {
  try {
    verifyMinisign(publicKeyB64, data, signatureBlock)
  } catch (error) {
    const parts = [`数据 ${data.length} 字节 sha256=${sha256Hex(data)}`]
    try {
      const sig = parseSignatureBlock(signatureBlock)
      const pub = parsePublicKey(publicKeyB64)
      parts.push(`alg=${JSON.stringify(sig.alg)}`, `keynum 与公钥${sig.keynum.equals(pub.keynum) ? "一致" : "不一致"}`)
    } catch {
      // 有意静默：形状问题本身已由 error.message 说明，指纹能算多少算多少，没有第二留痕点。
    }
    fail(`${context} 验签失败: ${error.message}（${parts.join(" · ")}）`)
  }
}

/** 验签成功返回 true，失败抛错（调用方直接 fail closed）。 */
function verifyMinisign(publicKeyB64, data, signatureBlock) {
  const pub = parsePublicKey(publicKeyB64)
  const sig = parseSignatureBlock(signatureBlock)
  if (sig.alg !== "ED" && sig.alg !== "Ed") throw new Error(`未知签名算法 ${JSON.stringify(sig.alg)}`)
  if (!sig.keynum.equals(pub.keynum)) throw new Error("签名 keynum 与公钥不匹配（不是这把密钥签的）")
  const message = sig.alg === "ED" ? createHash("blake2b512").update(data).digest() : data
  if (!cryptoVerify(null, message, ed25519Key(pub.pk), sig.sig)) throw new Error("envelope 主签名验签失败")
  const globalMessage = Buffer.concat([sig.sig, Buffer.from(sig.trustedText, "utf8")])
  if (!cryptoVerify(null, globalMessage, ed25519Key(pub.pk), sig.globalSig)) throw new Error("trusted comment 全局签名验签失败")
}

// ─────────────────────────────── fragment ───────────────────────────────

function runFragment(args) {
  const tag = args.tag
  const version = String(tag ?? "").replace(/^v/, "")
  if (!SEMVER.test(version)) fail(`--tag 必须是 vX.Y.Z 形式，收到 ${JSON.stringify(tag)}`)
  const target = EXPECTED_TARGETS.find(item => item.platform === args.platform && item.arch === args.arch)
  if (!target) {
    fail(`--platform/--arch 只能是 ${EXPECTED_TARGETS.map(t => `${t.platform}/${t.arch}`).join(" / ")}`)
  }
  if (args.kind !== target.kind) fail(`--kind 对 ${args.platform} 必须是 ${target.kind}`)
  if (!args.component || !existsSync(resolve(args.component))) fail(`--component 不存在: ${JSON.stringify(args.component)}`)
  if (!args.out) fail("缺少 --out")

  const config = readJson("packaging/update.json")
  const nodeVersion = readJson("packaging/node-runtime.json").nodeVersion
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY
  if (!repo) fail("需要 --repo（或 GITHUB_REPOSITORY 环境变量）来生成资产 URL")
  if (!process.env.CARGO_PACKAGER_SIGN_PRIVATE_KEY) {
    fail("缺少 CARGO_PACKAGER_SIGN_PRIVATE_KEY（release.yml 从 TAURI_SIGNING_PRIVATE_KEY secret 映射）")
  }

  const componentPath = resolve(args.component)
  const name = basename(componentPath)
  if (!name.endsWith(target.suffix)) fail(`组件 ${name} 必须以 ${target.suffix} 结尾（manifest 侧的硬校验）`)
  const bytes = readFileSync(componentPath)
  if (bytes.length === 0) fail(`组件 ${name} 是空文件`)
  const url = `https://github.com/${repo}/releases/download/${tag}/${name}`

  // 字段顺序固定 = serde camelCase 的 ReleaseEnvelope；envelope 的这一串字节就是签名对象，
  // 中间不做任何规范化/重排（消除 canonicalization 歧义，见 W10b 契约）。
  const envelope = {
    appIdentifier: config.appIdentifier,
    version,
    platform: target.platform,
    arch: target.arch,
    publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    versionSet: { app: version, node: nodeVersion },
    components: [{ kind: target.kind, name, url, size: bytes.length, sha256: sha256Hex(bytes) }],
  }
  const envelopeBytes = JSON.stringify(envelope)

  const outPath = resolve(args.out)
  mkdirSync(dirname(outPath), { recursive: true })
  const envelopePath = join(dirname(outPath), `.envelope-${target.platform}.json`)
  writeFileSync(envelopePath, envelopeBytes)

  const signed = spawnSync("cargo", ["packager", "signer", "sign", envelopePath], {
    stdio: "inherit",
    env: process.env,
  })
  if (signed.error) fail(`无法执行 cargo packager signer：${signed.error.message}`)
  if (signed.status !== 0) fail(`cargo packager signer sign 退出码 ${signed.status}`)

  const sigPath = `${envelopePath}.sig`
  if (!existsSync(sigPath)) fail(`签名文件未生成: ${sigPath}`)
  const raw = readFileSync(sigPath, "utf8").trim()
  // signer 写的是「签名块全文的 base64」；同时容忍直接的签名块文本。
  const decoded = Buffer.from(raw, "base64").toString("utf8")
  const signature = decoded.startsWith("untrusted comment: ") ? decoded.trim() : raw

  // 验签对象取**磁盘上那份字节**：签名覆盖的是文件，不是内存里的字符串。读回来验才是
  // 「签了什么就验什么」，两者若因编码或换行处理分叉，这里当场就能说清而不只是「验签失败」。
  const signedBytes = readFileSync(envelopePath)
  const inMemoryBytes = Buffer.from(envelopeBytes, "utf8")
  if (!signedBytes.equals(inMemoryBytes)) {
    fail(`写盘 envelope 与内存字节不一致（${signedBytes.length} vs ${inMemoryBytes.length} 字节）：签名对象不可信`)
  }
  verifyOrFail(config.releasePublicKey, signedBytes, signature, "新签名")

  writeFileSync(outPath, JSON.stringify({ envelope: envelopeBytes, signature }, null, 2))
  rmSync(envelopePath, { force: true })
  rmSync(sigPath, { force: true })
  console.log(`update-feed: ${target.platform}/${target.arch} 片段已签名并验签（${name}, ${bytes.length} bytes）`)
}

// ─────────────────────────────── assemble ───────────────────────────────

function readFragments(dir) {
  const fragments = []
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("update-fragment-") || !entry.endsWith(".json")) continue
    const fragment = JSON.parse(readFileSync(join(dir, entry), "utf8"))
    if (typeof fragment.envelope !== "string" || typeof fragment.signature !== "string") {
      fail(`${entry} 不是 { envelope, signature } 形状`)
    }
    fragments.push(fragment)
  }
  return fragments
}

function runAssemble(args) {
  const tag = args.tag
  const version = String(tag ?? "").replace(/^v/, "")
  if (!SEMVER.test(version)) fail(`--tag 必须是 vX.Y.Z 形式，收到 ${JSON.stringify(tag)}`)
  if (!args.fragments || !args.out) fail("assemble 需要 --fragments <dir> 与 --out <file>")

  const config = readJson("packaging/update.json")
  const fragments = readFragments(resolve(args.fragments))
  const releases = []
  for (const target of EXPECTED_TARGETS) {
    const matches = fragments.filter((fragment) => {
      const envelope = JSON.parse(fragment.envelope)
      return envelope.platform === target.platform && envelope.arch === target.arch
    })
    if (matches.length !== 1) {
      fail(`期望恰好一条 ${target.platform}/${target.arch} 的 fragment（实际 ${matches.length} 条）：两个平台的打包必须都成功后才发布`)
    }
    const fragment = matches[0]
    const envelope = JSON.parse(fragment.envelope)
    if (envelope.appIdentifier !== config.appIdentifier) fail(`envelope 的 appIdentifier 与 packaging/update.json 不一致`)
    if (envelope.version !== version) fail(`envelope 版本 ${envelope.version} 与 tag ${tag} 不一致`)
    if (envelope.versionSet?.app !== version) fail(`envelope versionSet.app 必须是 ${version}`)
    verifyOrFail(config.releasePublicKey, Buffer.from(fragment.envelope, "utf8"), fragment.signature, `${target.platform} fragment`)
    releases.push({ envelope: fragment.envelope, signature: fragment.signature })
  }

  const feed = {
    schemaVersion: 1,
    appIdentifier: config.appIdentifier,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    releases,
  }
  writeFileSync(resolve(args.out), JSON.stringify(feed, null, 2) + "\n")
  console.log(`update-feed: update.json 已生成（${releases.length} 条 release，version ${version}）`)
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === "fragment") runFragment(args)
  else if (command === "assemble") runAssemble(args)
  else fail(`未知子命令 ${JSON.stringify(command)}（可用：fragment / assemble）`)
}

main()
