import { describe, expect, it, vi } from "vitest"

import {
  buildFetchRequest,
  formatFetchResult,
  normalizeFetchUrl,
  parseFetchPayload,
  runWebFetch,
  WEB_FETCH_MAX_CONTENT_CHARS,
  type WebFetchDeps,
} from "@/services/tool/local-extra/webfetch-core"
import { webFetchTool } from "@/services/tool/local-extra/webfetch"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const DEPS: WebFetchDeps = {
  fetch: async () => jsonResponse({ title: "Docs", content: "# Hello" }),
  endpoint: "https://api.deepseek.com",
  apiKey: "sk-test",
}

describe("网页抓取 URL 准入", () => {
  it("接受公网 http/https 并规范化", () => {
    expect(normalizeFetchUrl("https://example.com")).toBe("https://example.com/")
    expect(normalizeFetchUrl(" http://example.com/docs?q=1 ")).toBe("http://example.com/docs?q=1")
  })

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://example.com/a",
  ])("拒绝非网页协议：%s", url => {
    expect(() => normalizeFetchUrl(url)).toThrow("只支持 http/https")
  })

  it("拒绝带凭据的地址", () => {
    expect(() => normalizeFetchUrl("https://user:pass@example.com/")).toThrow("不能包含用户名或密码")
  })

  it.each([
    "http://localhost:3000/",
    "http://app.localhost/",
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://10.0.0.5/",
    "http://172.16.3.4/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://metadata.google.internal/computeMetadata",
    "http://router.local/",
    "http://intranet/",
  ])("拒绝本机与内网地址：%s", url => {
    expect(() => normalizeFetchUrl(url)).toThrow("本机或内网")
  })

  it("拒绝空地址与超长地址", () => {
    expect(() => normalizeFetchUrl("   ")).toThrow("不能为空")
    expect(() => normalizeFetchUrl(`https://example.com/${"a".repeat(8192)}`)).toThrow("过长")
  })
})

describe("DeepSeek Fetch 请求", () => {
  it("按 endpoint 拼出 /v1/tools/fetch 并带 Bearer", () => {
    const { requestUrl, init } = buildFetchRequest("https://api.deepseek.com", "sk-test", "https://example.com/a")
    expect(requestUrl).toBe("https://api.deepseek.com/v1/tools/fetch")
    expect(init).toMatchObject({ method: "POST", redirect: "error" })
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://example.com/a" })
  })

  it("endpoint 末尾斜杠或已含 /v1 时不重复版本段", () => {
    expect(buildFetchRequest("https://api.deepseek.com/", "k", "https://example.com/a").requestUrl)
      .toBe("https://api.deepseek.com/v1/tools/fetch")
    expect(buildFetchRequest("https://proxy.example.com/v1", "k", "https://example.com/a").requestUrl)
      .toBe("https://proxy.example.com/v1/tools/fetch")
  })
})

describe("DeepSeek Fetch 响应", () => {
  it("去空白并格式化标题、来源与正文", () => {
    const payload = parseFetchPayload({ title: " 标题 ", content: "\n正文\n" })
    expect(payload).toEqual({ title: "标题", content: "正文", truncated: false })
    const text = formatFetchResult("https://example.com/a", payload)
    expect(text).toContain("标题：标题")
    expect(text).toContain("来源：https://example.com/a")
    expect(text).toContain("正文")
  })

  it("无标题时省略标题行", () => {
    const text = formatFetchResult("https://example.com/a", { title: "", content: "正文", truncated: false })
    expect(text).not.toContain("标题：")
    expect(text).toContain("来源：https://example.com/a")
  })

  it("正文超长时截断并标明", () => {
    const long = "字".repeat(WEB_FETCH_MAX_CONTENT_CHARS + 10)
    const payload = parseFetchPayload({ content: long })
    expect(payload.content.length).toBe(WEB_FETCH_MAX_CONTENT_CHARS)
    expect(payload.truncated).toBe(true)
    expect(formatFetchResult("https://example.com/a", payload)).toContain("仅保留前")
  })

  it("拒绝非对象与空正文", () => {
    expect(() => parseFetchPayload(null)).toThrow("无效响应")
    expect(() => parseFetchPayload({ title: "只有标题" })).toThrow("没有可读正文")
  })
})

describe("网页抓取执行", () => {
  it("成功时返回带来源的正文", async () => {
    const fetch = vi.fn<WebFetchDeps["fetch"]>(async () => jsonResponse({ title: "Docs", content: "# Hello" }))
    const result = await runWebFetch({ url: "https://example.com/a" }, { ...DEPS, fetch })
    expect(result.success).toBe(true)
    expect(result.content).toContain("来源：https://example.com/a")
    expect(result.content).toContain("# Hello")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("认证失败映射为 denied", async () => {
    const result = await runWebFetch(
      { url: "https://example.com/a" },
      { ...DEPS, fetch: async () => jsonResponse({}, 401) },
    )
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("denied")
    expect(result.error).toContain("HTTP 401")
  })

  it("403 安全拒绝与 402 余额不足不冒充认证失败 [web-fetch-error-semantics]", async () => {
    const rejected = await runWebFetch({ url: "https://example.com/a" }, { ...DEPS, fetch: async () => jsonResponse({}, 403) })
    expect(rejected).toEqual({ success: false, content: "", error: "网页抓取被安全策略拒绝（HTTP 403），请调整目标地址", errorCode: "denied" })
    const balance = await runWebFetch({ url: "https://example.com/a" }, { ...DEPS, fetch: async () => jsonResponse({}, 402) })
    expect(balance).toEqual({ success: false, content: "", error: "网页抓取余额不足（HTTP 402），请充值后重试", errorCode: "failed" })
    const missing = await runWebFetch({ url: "https://example.com/a" }, { ...DEPS, fetch: async () => jsonResponse({}, 404) })
    expect(missing.error).toBe("网页抓取未获得可用正文（HTTP 404），目标可能不可访问、被站点策略阻止或不支持正文提取")
  })

  it("在途请求接到同一个取消信号并结束为 cancelled [web-fetch-inflight-cancel]", async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | null | undefined
    let aborted = false
    const request = runWebFetch({ url: "https://example.com/a" }, {
      ...DEPS, signal: controller.signal,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        receivedSignal = init.signal
        init.signal!.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")) }, { once: true })
      }),
    })
    expect(receivedSignal).toBe(controller.signal)
    expect(aborted).toBe(false)
    controller.abort()
    expect(await request).toEqual({ success: false, content: "", error: "网页抓取已取消", errorCode: "cancelled" })
    expect(aborted).toBe(true)
  })

  it("限流与服务端错误映射为 failed", async () => {
    const limited = await runWebFetch(
      { url: "https://example.com/a" },
      { ...DEPS, fetch: async () => jsonResponse({}, 429) },
    )
    expect(limited.errorCode).toBe("failed")
    expect(limited.error).toContain("限流")
    const broken = await runWebFetch(
      { url: "https://example.com/a" },
      { ...DEPS, fetch: async () => jsonResponse({}, 503) },
    )
    expect(broken.errorCode).toBe("failed")
  })

  it("非法 URL 不发起请求", async () => {
    const fetch = vi.fn<WebFetchDeps["fetch"]>(async () => jsonResponse({ content: "x" }))
    const result = await runWebFetch({ url: "http://127.0.0.1/" }, { ...DEPS, fetch })
    expect(result.success).toBe(false)
    expect(result.error).toContain("本机或内网")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("请求抛错时返回 failed，已取消时返回 cancelled", async () => {
    const failed = await runWebFetch(
      { url: "https://example.com/a" },
      { ...DEPS, fetch: async () => { throw new TypeError("network down") } },
    )
    expect(failed.errorCode).toBe("failed")
    expect(failed.error).toContain("network down")

    const controller = new AbortController()
    controller.abort()
    const cancelled = await runWebFetch(
      { url: "https://example.com/a" },
      {
        ...DEPS,
        fetch: async () => { throw new DOMException("aborted", "AbortError") },
        signal: controller.signal,
      },
    )
    expect(cancelled.errorCode).toBe("cancelled")
  })

  it("非 JSON 响应返回 failed", async () => {
    const result = await runWebFetch(
      { url: "https://example.com/a" },
      { ...DEPS, fetch: async () => new Response("not-json", { status: 200 }) },
    )
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("failed")
    expect(result.error).toContain("JSON")
  })
})

describe("web_fetch 工具声明", () => {
  it("策略为只读共享、默认放行、可回读投影", () => {
    expect(webFetchTool.name).toBe("web_fetch")
    expect(webFetchTool.actionCategory).toBe("net.fetch")
    expect(webFetchTool.safetyLevel).toBe("NORMAL")
    expect(webFetchTool.policy.permission.defaultDecision).toBe("allow")
    expect(webFetchTool.policy.execution).toMatchObject({
      effect: "read",
      isolation: "shared_read",
      replay: "never",
      timeoutMs: 20_000,
    })
    expect(webFetchTool.policy.context.resultProjection).toBe("reference")
  })
})
