// ==========================================
// MCP headers 展开 —— 零依赖叶子
//
// 服务器配置里的 headers 模板（值可含 `${VAR}`）只从**该服务器自己的 env** 展开：
// 不读 process.env、不做全局回落 —— 凭据来源必须留在它自己的配置里，
// 否则「这台服务器的 token 配在哪」就说不清，排障时也无从追值。
//
// 凭据纪律：本文件不写日志；抛错只点名变量，不回显值（调用方同样不得把值写进日志）。
// ==========================================

/** 值里的变量引用 `${NAME}`；NAME 收任意非 `}` 字符（env 键不只有 [A-Za-z_] 一种形状）。 */
const PLACEHOLDER = /\$\{([^}]+)\}/g

/**
 * headers 模板 → 实际请求头。
 *
 * - `template` 为 undefined → undefined（未配 headers，不生成空对象）；
 * - 值里每个 `${VAR}` 都必须在 `env` 里有非空值：缺失或为空即抛错点名变量；
 *   不要求全值就是变量 —— `Bearer ${TOKEN}` 这类前后缀原样保留。
 */
export function expandHeaders(
  template: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!template) return undefined
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(template)) {
    headers[name] = value.replace(PLACEHOLDER, (_match, variable: string) => {
      const resolved = env?.[variable]
      if (resolved === undefined || resolved === "") {
        throw new Error(`MCP header 变量 ${variable} 在该服务器的 env 里缺失或为空（只从本服务器 env 展开）`)
      }
      return resolved
    })
  }
  return headers
}
