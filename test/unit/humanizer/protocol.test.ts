import { describe, expect, it } from "vitest"
import { SilenceGuard, transformHumanizerText } from "@/services/humanizer/protocol"

describe("humanizer protocol", () => {
  it("splits only exact standalone markers and merges overflow into the fourth bubble [humanizer-protocol-split-merge]", () => {
    const result = transformHumanizerText("one\n<<SPLIT>>\ntwo\n <<SPLIT>> \nthree\n<<SPLIT>>\nfour\n<<SPLIT>>\nfive")
    expect(result.parts).toEqual(["one", "two", "three", "four\nfive"])
    expect(result.text).toBe("one\ntwo\nthree\nfour\nfive")
    expect(result.split).toBe(true)
  })

  it("splits blank-line casual paragraphs into bubbles while single breaks stay together [humanizer-blank-line-split]", () => {
    const result = transformHumanizerText("看到了\n\n在改 Desk-Pet\n\n周末也这么拼")
    expect(result.parts).toEqual(["看到了", "在改 Desk-Pet", "周末也这么拼"])
    expect(result.split).toBe(true)
    // 段内单个换行（同一段折行）不分条。
    expect(transformHumanizerText("first line\nsecond line").parts).toEqual(["first line\nsecond line"])
    expect(transformHumanizerText("first line\nsecond line").split).toBe(false)
    // 含代码块的消息不拆（技术内容保持整条）。
    expect(transformHumanizerText("看这个\n\n```ts\nconst a = 1\n```").parts).toEqual(["看这个\n\n```ts\nconst a = 1\n```"])
    // task 流不受空行分段影响，保持整条。
    expect(transformHumanizerText("one\n\ntwo", "task").parts).toEqual(["one\n\ntwo"])
  })

  it("keeps task output in one part and removes a stray split marker [humanizer-task-single-part]", () => {
    const result = transformHumanizerText("one\n<<SPLIT>>\ntwo", "task")
    expect(result.parts).toEqual(["one\ntwo"])
    expect(transformHumanizerText("<<SILENT>>", "task").silent).toBe(false)
  })

  it("recognizes silence only when it is the full visible reply [humanizer-silent-exact]", () => {
    expect(transformHumanizerText("  <<SILENT>>  ").silent).toBe(true)
    expect(transformHumanizerText("answer\n<<SILENT>>").silent).toBe(false)
  })

  it("allows one silence per session and replaces a consecutive second silence [humanizer-silence-guard]", () => {
    const guard = new SilenceGuard()
    const silent = transformHumanizerText("<<SILENT>>")
    expect(guard.resolve("s1", silent, "嗯嗯").silent).toBe(true)
    expect(guard.resolve("s1", silent, "嗯嗯")).toMatchObject({ silent: false, rejected: true, text: "嗯嗯", parts: ["嗯嗯"] })
    expect(guard.resolve("s2", silent, "嗯嗯").silent).toBe(true)
  })
})
