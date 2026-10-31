#!/usr/bin/env node
// 引擎四层方向守门：protocol ← state ← harness ← runtime；plan 只静态依赖 protocol/state。
// 只看值 import；`import type` 编译期擦除，不产生运行时边，因此不限制。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const engine = join(repo, "src/services/engine")

const PREFIXES = [
  ["protocol/", "protocol"],
  ["state/", "state"],
  ["harness/", "harness"],
  ["runtime/", "runtime"],
  ["plan/", "plan"],
]
const PLAN_FILES = new Set(["planner.ts", "plan-confirmation.ts"])

// 未归入四层的引擎文件（每项注明职责）。未分类不是默认豁免：不在此清单的引擎文件
// 按「未分类」报错，避免新文件静默落到门禁之外。以 `/` 结尾的条目按目录前缀匹配。
const UNCLASSIFIED_ALLOW = new Set([
  // 引擎公开 barrel：只再导出四层入口与既有无层模块，不持有逻辑。
  "index.ts",
  // 输入预处理：slash 命令识别与空/重复消息过滤，ingress 的无层入口。
  "preprocessor.ts",
  // before_compaction 摘要内核：摘要调用、分片规划与素材度量（调度归 harness）。
  "compactor.ts",
  // 结构化摘要的解析与格式化：compactor 的私有纯函数，不对外成层。
  "compaction/",
  // slash 命令注册表与各命令实现：由 preprocessor 与 ingress 使用，不参与层间依赖。
  "slash/",
  // ask_user 的提问确认通道：与 plan-confirmation 同款骨架的提问回执桥。
  "choice-confirmation.ts",
])

function isUnclassifiedAllowed(rel) {
  for (const entry of UNCLASSIFIED_ALLOW) {
    if (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry) return true
  }
  return false
}

function layerOfPath(file) {
  const rel = relative(engine, file).split("\\").join("/")
  for (const [prefix, layer] of PREFIXES) if (rel.startsWith(prefix)) return layer
  if (PLAN_FILES.has(rel)) return "plan"
  return null
}

const ALLOWED = {
  protocol: new Set(["protocol"]),
  state: new Set(["protocol", "state"]),
  plan: new Set(["protocol", "state", "plan"]),
  harness: new Set(["protocol", "state", "harness"]),
  runtime: new Set(["protocol", "state", "harness", "plan", "runtime"]),
}

// plan → harness 仅允许两条按需边：步骤子代理内核与一次性文本调用（planner 调模型生成计划）。
// plan 的静态图仍只依赖 protocol/state —— 这两条 import() 都不产生静态边。
const DYNAMIC_ALLOW = new Map([
  ["planner.ts", new Set(["@/services/engine/harness/subagent", "@/services/engine/harness/model-gateway"])],
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith(".ts")) out.push(p)
  }
  return out
}

function targetLayer(fromFile, spec) {
  if (spec === "@/services/engine") return "engine-barrel"
  if (spec.startsWith("@/services/engine/")) {
    const sub = spec.slice("@/services/engine/".length)
    for (const [prefix, layer] of PREFIXES) {
      if (sub === prefix.slice(0, -1) || sub.startsWith(prefix)) return layer
    }
    if (sub === "planner" || sub === "plan-confirmation") return "plan"
    return null
  }
  if (spec.startsWith(".")) {
    const base = resolve(dirname(fromFile), spec)
    for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
      if (!existsSync(candidate)) continue
      const layer = layerOfPath(candidate)
      if (layer) return layer
    }
  }
  return null
}

const STATIC_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^"'();]*?\sfrom\s*)?["']([^"']+)["']/g
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g
const errors = []

/** `match.index` 换算为 1 基行号（静态正则的匹配含前导换行，先跳过前导空白）。 */
function lineOfMatch(text, match) {
  const start = match.index + (match[0].length - match[0].trimStart().length)
  return text.slice(0, start).split("\n").length
}

for (const file of walk(engine)) {
  const rel = relative(engine, file).split("\\").join("/")
  const from = layerOfPath(file)
  if (!from) {
    if (!isUnclassifiedAllowed(rel)) errors.push(`未分类的引擎文件：${rel}`)
    continue
  }
  const text = readFileSync(file, "utf8")
  for (const [re, dynamic] of [[STATIC_RE, false], [DYNAMIC_RE, true]]) {
    re.lastIndex = 0
    for (const match of text.matchAll(re)) {
      const spec = match[1]
      const line = lineOfMatch(text, match)
      const to = targetLayer(file, spec)
      if (to === "engine-barrel") {
        errors.push(`${rel}:${line}: 引用引擎顶层 barrel（${spec}）会重新引入环`)
        continue
      }
      if (!to || to === from) continue
      if (dynamic && DYNAMIC_ALLOW.get(rel)?.has(spec)) continue
      if (!ALLOWED[from].has(to)) errors.push(`${rel}:${line}: ${from} → ${to}（${spec}）`)
    }
  }
}

if (errors.length > 0) {
  // 排序输出：违规顺序不随目录遍历顺序变化，跨平台基线可直接比对。
  errors.sort()
  console.error("引擎分层违规：\n  " + errors.join("\n  "))
  process.exit(1)
}
console.log("引擎分层守门通过")
