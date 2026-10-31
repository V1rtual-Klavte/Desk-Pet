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

// 唯一允许的 plan → harness 动态边：子代理内核按需加载。
const DYNAMIC_ALLOW = new Map([
  ["planner.ts", new Set(["@/services/engine/harness/subagent"])],
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

for (const file of walk(engine)) {
  const from = layerOfPath(file)
  if (!from) continue
  const rel = relative(engine, file).split("\\").join("/")
  const text = readFileSync(file, "utf8")
  for (const [re, dynamic] of [[STATIC_RE, false], [DYNAMIC_RE, true]]) {
    re.lastIndex = 0
    for (const match of text.matchAll(re)) {
      const spec = match[1]
      const to = targetLayer(file, spec)
      if (to === "engine-barrel") {
        errors.push(`${rel}: 引用引擎顶层 barrel（${spec}）会重新引入环`)
        continue
      }
      if (!to || to === from) continue
      if (dynamic && DYNAMIC_ALLOW.get(rel)?.has(spec)) continue
      if (!ALLOWED[from].has(to)) errors.push(`${rel}: ${from} → ${to}（${spec}）`)
    }
  }
}

if (errors.length > 0) {
  console.error("引擎分层违规：\n  " + errors.join("\n  "))
  process.exit(1)
}
console.log("引擎分层守门通过")
