// ==========================================
// E2E 合成 CONFIG（替代「复制真实 CONFIG-DEV.yaml」）
// ==========================================
//
// 执行契约 §8 W11：启动器不再复制真实开发配置；隔离根的 settings/CONFIG.yaml 由
// 「随仓模板 + 显式覆盖」在启动器进程内合成：
//
//   基底 = 仓库根的 CONFIG.yaml（进 git 的模板，凭据字段为空，不是真实开发配置）
//   覆盖 = test/host/native/fixtures/config-overrides.yaml（测试专属字段，进 git）
//   守卫 = 合成后仍按凭据键名扫描整棵树，任何非空凭据值直接报错（防未来有人把
//          真实 key 写进模板或覆盖文件）
//
// 明确不读：CONFIG-DEV.yaml 与任何真实运行时 CONFIG（本模块不引用它们的路径，
// 并拒绝把名为 CONFIG-DEV.yaml 的文件当输入）。
//
// 真实 Provider 凭据只经测试侧凭据入口（test/eval-models.local.json / DESKPET_EVAL_*
// 环境变量）在运行期写进隔离副本，永不回写真实配置 —— 与本模块无关。
//
// 本文件是开发工具（Node 脚本），直接 console 输出错误；不进产品构建。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import yaml from "js-yaml"

/** 合成 CONFIG 的模板（唯一基底）。 */
export const CONFIG_TEMPLATE_NAME = "CONFIG.yaml"
/** 测试专属覆盖文件（相对仓库根）。 */
export const CONFIG_OVERRIDES_PATH = join("test", "host", "native", "fixtures", "config-overrides.yaml")
/** 真实开发配置：任何情况下都不得作为本模块的输入。 */
const FORBIDDEN_SOURCE = "CONFIG-DEV.yaml"

/**
 * 凭据键名（与 scripts/e2e-test.mjs 的 seedHash 脱敏、src/services/config 无关，
 * 只是本模块的防呆扫描）。命中即要求空值。
 */
const CREDENTIAL_KEY = /(api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|authorization|credential|private[_-]?key|bearer)/i

/**
 * 纯占位符引用（`${VAR}`；可带 `Bearer ` 之类单个字面前缀）不算凭据：值本体只是一段引用，
 * 运行期才从环境或应用自有凭据存储解析（如携带 MCP 出厂条目的 `Bearer ${GITHUB_TOKEN}`），
 * 模板与覆盖文件里并不存在真实值。含任何其它字符（例如一段真实 key）依旧命中守卫。
 */
const PLACEHOLDER_ONLY = /^(?:[A-Za-z][A-Za-z0-9_-]*\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

function assertNotRealConfig(filePath) {
  if (basename(filePath) === FORBIDDEN_SOURCE) {
    throw new Error(`合成 CONFIG 不得以真实开发配置为输入（${filePath}）；基底只用 ${CONFIG_TEMPLATE_NAME}`)
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 深合并：对象逐键递归，其余类型整值替换（数组按覆盖方的整段替换）。 */
function deepMerge(base, override, path) {
  if (!isRecord(override)) return override
  const out = isRecord(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(override)) {
    const keyPath = path ? `${path}.${key}` : key
    out[key] = isRecord(value) ? deepMerge(out[key], value, keyPath) : value
  }
  return out
}

/**
 * 凭据守卫：凭据键名的**非空字符串**值即报错，错误里只写键路径、不回显值
 * （避免把疑似凭据打进终端/日志）。
 *
 * 只判字符串：`requireApiKey: true` 这类开关是 boolean、`maxDailyTokens: 72000`
 * 这类预算含 "token" 但是数字，都不可能携带凭据；而任何真的 key/secret 一定是
 * 非空字符串。空串 / null / undefined 一律放行（模板的占位形态）；纯占位符引用
 * （`PLACEHOLDER_ONLY`，如 `Bearer ${GITHUB_TOKEN}`）同样放行——值本体是引用，
 * 运行期才解析，模板里不存在真实凭据。
 */
export function assertCredentialFree(tree, path = "") {
  if (isRecord(tree)) {
    for (const [key, value] of Object.entries(tree)) {
      const keyPath = path ? `${path}.${key}` : key
      if (
        CREDENTIAL_KEY.test(key)
        && typeof value === "string"
        && value.trim() !== ""
        && !PLACEHOLDER_ONLY.test(value.trim())
      ) {
        throw new Error(`合成 CONFIG 出现非空凭据字段：${keyPath}（凭据只经 test/eval-models.local.json / DESKPET_EVAL_* 注入）`)
      }
      assertCredentialFree(value, keyPath)
    }
    return
  }
  if (Array.isArray(tree)) {
    tree.forEach((item, index) => assertCredentialFree(item, `${path}[${index}]`))
  }
}

/**
 * 合成并序列化 CONFIG 文本。返回写入文件的同一份字节 —— seedHash 覆盖的就是它
 * （报告摘要必须描述本次运行真正加载的配置，而不是某个真实开发配置）。
 */
export function buildSyntheticConfig({ repoRoot = process.cwd() } = {}) {
  const templatePath = join(repoRoot, CONFIG_TEMPLATE_NAME)
  const overridesPath = join(repoRoot, CONFIG_OVERRIDES_PATH)
  assertNotRealConfig(templatePath)
  assertNotRealConfig(overridesPath)

  const template = yaml.load(readFileSync(templatePath, "utf8"))
  if (!isRecord(template)) {
    throw new Error(`CONFIG 模板不是 YAML 映射：${templatePath}`)
  }
  const rawOverrides = yaml.load(readFileSync(overridesPath, "utf8"))
  const overrides = rawOverrides === undefined || rawOverrides === null ? {} : rawOverrides
  if (!isRecord(overrides)) {
    throw new Error(`CONFIG 覆盖文件不是 YAML 映射：${overridesPath}`)
  }

  const merged = deepMerge(template, overrides, "")
  assertCredentialFree(merged, "")
  return yaml.dump(merged, { lineWidth: 120, noRefs: true })
}

/** 把合成 CONFIG 写进隔离根（AppPaths 在 E2E 模式加载 settings/CONFIG.yaml）。 */
export function writeSyntheticConfig(dataRoot, text) {
  const settingsDir = join(dataRoot, "settings")
  mkdirSync(settingsDir, { recursive: true })
  const target = join(settingsDir, "CONFIG.yaml")
  writeFileSync(target, text)
  return target
}
