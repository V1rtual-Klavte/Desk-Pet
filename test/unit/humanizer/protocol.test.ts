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
    // 代码块**整块不拆**（块内空行不是断点），但它前后的说话各自成泡 ——
    // 2026-10-08 用户裁定：「拟人化开了就像人发消息一样讲解，不会一大条过来」。
    // 原口径是「含 ``` 就整条不拆」，一刀切把代码前后的说话也冻成一大块。
    expect(transformHumanizerText("看这个\n\n```ts\nconst a = 1\n```").parts)
      .toEqual(["看这个", "```ts\nconst a = 1\n```"])
    // 判据：围栏**内部**的空行绝不能成为断点（否则代码会被劈成两泡）。
    expect(transformHumanizerText("看这个\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n完事").parts)
      .toEqual(["看这个", "```ts\nconst a = 1\n\nconst b = 2\n```", "完事"])
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
