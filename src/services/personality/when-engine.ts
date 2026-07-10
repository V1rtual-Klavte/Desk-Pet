// ==========================================
// When 引擎 — 行为进阶条件求值
// §5: 完备表达式语法 + AST + 求值器
// ==========================================

import { createLogger } from "@/services/logger"
import type { VariablePool } from "./variable-pool"

const log = createLogger("WhenEng")

// ── 类型 ──

export interface WhenRule {
  name: string
  when: string
  tone: string
}

// ── AST ──

type AstNode =
  | { type: "literal"; value: boolean }
  | { type: "compare"; variable: string; op: string; value: number | string | boolean }
  | { type: "not"; child: AstNode }
  | { type: "and"; left: AstNode; right: AstNode }
  | { type: "or"; left: AstNode; right: AstNode }

// ── Tokenizer ──

type Token =
  | { type: "lparen" | "rparen" }
  | { type: "op"; value: "AND" | "OR" }
  | { type: "not" }
  | { type: "compare"; variable: string; operator: string; value: string }
  | { type: "literal"; value: string }

function tokenize(raw: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < raw.length) {
    if (/\s/.test(raw[i])) { i++; continue }

    if (raw[i] === "(") { tokens.push({ type: "lparen" }); i++; continue }
    if (raw[i] === ")") { tokens.push({ type: "rparen" }); i++; continue }

    const rest = raw.slice(i)
    const word = rest.match(/^(AND|OR|NOT)\b/)
    if (word) {
      if (word[1] === "NOT") tokens.push({ type: "not" })
      else tokens.push({ type: "op", value: word[1] as "AND" | "OR" })
      i += word[1].length
      continue
    }

    const bool = rest.match(/^(true|false)\b/)
    if (bool) {
      tokens.push({ type: "literal", value: bool[1] })
      i += bool[1].length
      continue
    }

    const compare = rest.match(/^([\w一-鿿]+)\s*(>=|<=|!=|==|>|<)\s*("[^"]*"|true\b|false\b|-?\d+(?:\.\d+)?|[\w一-鿿]+)/)
    if (compare) {
      tokens.push({
        type: "compare",
        variable: compare[1],
        operator: compare[2],
        value: compare[3],
      })
      i += compare[0].length
      continue
    }

    throw new Error(`无法解析表达式片段: ${rest.slice(0, 20)}`)
  }

  return tokens
}

// ── 递归下降 Parser ──

let pos = 0
let curTokens: Token[] = []

function parse(raw: string): AstNode | null {
  curTokens = tokenize(raw)
  pos = 0

  if (curTokens.length === 1 && curTokens[0].type === "literal" && curTokens[0].value === "true") {
    return { type: "literal", value: true }
  }

  try {
    const node = parseOr()
    if (pos < curTokens.length) throw new Error(`未消费令牌: ${curTokens[pos].type}`)
    return node
  } catch (e) {
    log.error("When 解析失败:", raw, e)
    return null
  }
}

function parseOr(): AstNode {
  let left = parseAnd()
  while (pos < curTokens.length && curTokens[pos].type === "op" && (curTokens[pos] as { value: string }).value === "OR") {
    pos++
    const right = parseAnd()
    left = { type: "or", left, right }
  }
  return left
}

function parseAnd(): AstNode {
  let left = parseUnary()
  while (pos < curTokens.length && curTokens[pos].type === "op" && (curTokens[pos] as { value: string }).value === "AND") {
    pos++
    const right = parseUnary()
    left = { type: "and", left, right }
  }
  return left
}

function parseUnary(): AstNode {
  if (pos < curTokens.length && curTokens[pos].type === "not") {
    pos++
    const child = parseUnary()
    return { type: "not", child }
  }
  return parsePrimary()
}

function parsePrimary(): AstNode {
  const tok = curTokens[pos]
  if (tok.type === "literal") {
    pos++
    return { type: "literal", value: (tok as { value: string }).value === "true" }
  }
  if (tok.type === "compare") {
    pos++
    const c = tok as { variable: string; operator: string; value: string }
    return { type: "compare", variable: c.variable, op: c.operator, value: parseLiteral(c.value) }
  }
  if (tok.type === "lparen") {
    pos++
    const node = parseOr()
    if (pos < curTokens.length && curTokens[pos].type === "rparen") pos++
    return node
  }
  throw new Error(`未预期令牌: ${curTokens[pos]?.type}`)
}

function parseLiteral(raw: string): number | string | boolean {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw === "true") return true
  if (raw === "false") return false
  const num = parseFloat(raw)
  if (!isNaN(num)) return num
  return raw
}

// ── Evaluator ──

function evaluate(ast: AstNode | null, pool: VariablePool): boolean {
  if (!ast) return false

  switch (ast.type) {
    case "literal": return ast.value

    case "compare": {
      const varVal = pool.system[ast.variable] ?? pool.card[ast.variable] ?? pool.interaction[ast.variable]
      if (varVal === undefined) return false
      return compareValues(varVal, ast.op, ast.value)
    }

    case "not": return !evaluate(ast.child, pool)
    case "and": return evaluate(ast.left, pool) && evaluate(ast.right, pool)
    case "or": return evaluate(ast.left, pool) || evaluate(ast.right, pool)
  }
}

function compareValues(left: unknown, op: string, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") {
    if (op === "==") return left === right
    if (op === "!=") return left !== right
    return false
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    if (op === "==") return left === right
    if (op === "!=") return left !== right
    return false
  }
  const ln = Number(left), rn = Number(right)
  if (!isNaN(ln) && !isNaN(rn)) {
    switch (op) {
      case ">": return ln > rn
      case "<": return ln < rn
      case ">=": return ln >= rn
      case "<=": return ln <= rn
      case "==": return ln === rn
      case "!=": return ln !== rn
    }
  }
  return false
}

// ── 公共 API ──

export function evaluateWhenEngine(rules: WhenRule[], pool: VariablePool): WhenRule | null {
  for (const rule of rules) {
    const ast = parse(rule.when)
    if (evaluate(ast, pool)) {
      log.debug("命中规则:", rule.name)
      return rule
    }
  }
  log.warn("无规则命中，缺少 when:true 兜底")
  return null
}

export function evaluateWhen(raw: string, pool: VariablePool): boolean {
  return evaluate(parse(raw), pool)
}
