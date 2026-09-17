// ==========================================
// Live Test shim — node:assert/strict 浏览器实现
// ==========================================
// 官方一致性套件（@earendil-works/pi-agent-core/harness/session/testing）
// 在模块顶层 import node:assert/strict，浏览器没有这个内建模块；见 vite.config.ts 的别名注释。
//
// 只实现套件实际用到的断言（ok / strictEqual / deepStrictEqual / rejects），语义对齐 Node
// 严格断言模式：通过时返回 undefined，失败抛 AssertionError。
// deepStrictEqual 只比较 JSON 形态的值（原型一致、键集合一致、数组长度一致）；
// 遇到日期、Map/Set 等非 JSON 类型会直接抛错而不是静默比较 —— 宁可失败得响亮。

class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AssertionError"
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function isPlainContainer(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === Array.prototype || prototype === null
}

function deepEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (!isPlainContainer(left) || !isPlainContainer(right)) {
    throw new Error("node-assert-strict shim 的 deepStrictEqual 只支持 JSON 形态的值")
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key)
    && deepEquals((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  )
}

export function ok(value: unknown, message?: string): void {
  if (!value) throw new AssertionError(message ?? `${describe(value)} 应为真值`)
}

export function strictEqual(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(message ?? `${describe(actual)} !== ${describe(expected)}`)
  }
}

export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void {
  if (!deepEquals(actual, expected)) {
    throw new AssertionError(message ?? `${describe(actual)} 深度不等于 ${describe(expected)}`)
  }
}

/** Node 的 rejects 还接受错误匹配器；套件只用单参数形态，这里不猜匹配语义。 */
export async function rejects(promiseOrFunction: Promise<unknown> | (() => Promise<unknown>)): Promise<void> {
  const promise = typeof promiseOrFunction === "function" ? promiseOrFunction() : promiseOrFunction
  try {
    await promise
  } catch {
    return
  }
  throw new AssertionError("Promise 应被拒绝，但成功完成了")
}
