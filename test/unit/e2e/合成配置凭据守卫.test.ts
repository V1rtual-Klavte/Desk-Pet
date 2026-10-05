// ==========================================
// 合成 CONFIG 凭据守卫（test/host/native/synthetic-config.mjs）
// ==========================================
//
// 守卫自身的测试：把豁免改宽（真实形态的 key 也放行）或改没（出厂 MCP 条目的
// `Bearer ${VAR}` 占位被拒、E2E 起不来）时，这些断言必须变红。
import { describe, expect, it } from "vitest"
// 合成器是 Node 侧 ESM 工具（test/host/native/*.mjs）：不进 tsconfig include、无 .d.ts。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，运行期形状由下面签名钉住。
import { assertCredentialFree } from "../../host/native/synthetic-config.mjs"

/** 运行期契约：凭据键名 + 非空字符串 + 非纯占位符 → 抛错；其余放行。 */
const assertFree: (tree: unknown, path?: string) => void = assertCredentialFree

describe("合成 CONFIG 凭据守卫", () => {
  it("真实形态的凭据值（键名命中、非纯占位符）被拒绝，且错误只报键路径不回显值", () => {
    expect(() => assertFree({ headers: { Authorization: "Bearer sk-real-not-a-placeholder" } })).toThrow(/非空凭据字段/)
    expect(() => assertFree({ ai: { apiKey: "sk-very-real-key" } })).toThrow(/非空凭据字段/)
    // 混合形态（占位符外还有字面内容）不得借豁免漏过
    expect(() => assertFree({ x: { MY_TOKEN: "abc${NOPE}def" } })).toThrow(/非空凭据字段/)
    try {
      assertFree({ headers: { Authorization: "Bearer sk-hidden" } })
    } catch (error) {
      expect(String(error)).not.toContain("sk-hidden")
    }
  })

  it("纯占位符引用放行（出厂 MCP 条目的 `Bearer ${VAR}` 与裸 `${VAR}` 形态）", () => {
    expect(() => assertFree({ headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } })).not.toThrow()
    expect(() => assertFree({ headers: { authorization: "${TOKEN}" } })).not.toThrow()
  })

  it("空值、非字符串与数字预算照旧放行（占位形态 / 开关 / 含 token 的数值）", () => {
    const tree = { ai: { apiKey: "" }, budget: { maxDailyTokens: 72000 }, flags: { requireApiKey: true }, none: { token: null } }
    expect(() => assertFree(tree)).not.toThrow()
  })

  it("数组内的对象被递归扫描（MCP servers 形态）", () => {
    const tree = { tools: { mcp: { servers: [{ name: "github", headers: { Authorization: "Bearer sk-real" } }] } } }
    expect(() => assertFree(tree)).toThrow(/servers\[0\]\.headers\.Authorization/)
    const ok = { tools: { mcp: { servers: [{ name: "github", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } }] } } }
    expect(() => assertFree(ok)).not.toThrow()
  })
})
