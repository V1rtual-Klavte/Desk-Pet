// ==========================================
// 重排结果校验 —— 模型输出不能越过宿主的白名单
// ==========================================
//
// 重排是「让模型在候选里挑选」，不是「让模型决定还有什么」。
// 这个用例钉住判据：未知 id、重复 id、非字符串、坏 JSON 一律不进入结果，
// 合法子集保序通过；空数组是合法答案（表示这次不需要召回）。

import { describe, expect, it } from "vitest"

import { parseRerankIds, parseRerankSelection } from "@/services/agent/memory/rerank"

const CANDIDATES = ["mem-a", "mem-b", "mem-c"]

describe("重排结果校验", () => {
  it("只接受候选内的 id，去重保序，坏输入一律回退 [memory-rerank-fallback]", () => {
    // 合法子集：顺序由模型决定，原样保留。
    expect(parseRerankIds('["mem-c","mem-a"]', CANDIDATES), "合法子集没有按模型给的顺序取回").toEqual(["mem-c", "mem-a"])
    // 未知 id 必须被丢掉，且不能因为出现未知 id 就把整份结果作废。
    expect(parseRerankIds('["mem-ghost","mem-b"]', CANDIDATES), "未知 id 未被拦下").toEqual(["mem-b"])
    // 重复 id 只保留一次。
    expect(parseRerankIds('["mem-a","mem-a","mem-b"]', CANDIDATES), "重复 id 没有被折叠").toEqual(["mem-a", "mem-b"])
    // 非字符串元素丢弃；对象形态 {ids:[...]} 同样支持。
    expect(parseRerankIds('["mem-a",7,null]', CANDIDATES), "非字符串元素进入了结果").toEqual(["mem-a"])
    expect(parseRerankIds('{"ids":["mem-b"]}', CANDIDATES), "对象形态没有取 ids 字段").toEqual(["mem-b"])
    // 空数组是合法答案：这次不需要召回。
    expect(parseRerankIds("[]", CANDIDATES), "空数组被当成了无效结果").toEqual([])
    expect(parseRerankSelection("[]", CANDIDATES), "合法空集未与坏响应区分").toEqual({ valid: true, ids: [] })
    // 坏 JSON、散文解释、空串一律回退成空结果，绝不去猜。
    expect(parseRerankIds("这是我认为最相关的三条", CANDIDATES), "散文被当成了结构化结果").toEqual([])
    expect(parseRerankIds('["mem-a"', CANDIDATES), "截断的 JSON 没有被判为无效").toEqual([])
    expect(parseRerankIds("", CANDIDATES), "空输出没有被判为无效").toEqual([])
    expect(parseRerankSelection("not-json", CANDIDATES).valid, "坏JSON未标成无效响应").toBe(false)
  })
})
