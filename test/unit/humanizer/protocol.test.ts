import { describe, expect, it } from "vitest"
import { SilenceGuard, transformHumanizerText } from "@/services/humanizer/protocol"

describe("humanizer protocol", () => {
  it("splits normalized standalone markers without a total part cap [humanizer-protocol-split-no-cap]", () => {
    const result = transformHumanizerText("one\n<<SPLIT>>\ntwo\n <<SPLIT>> \nthree\n<<SPLIT>>\nfour\n<<SPLIT>>\nfive")
    expect(result.parts).toEqual(["one", "two", "three", "four", "five"])
    expect(result.text).toBe("one\ntwo\nthree\nfour\nfive")
    expect(result.split).toBe(true)
  })

  it("normalizes attached, spaced, and case-varied split markers without touching fenced code [humanizer-protocol-marker-normalization]", () => {
    expect(transformHumanizerText("one<<SPLIT>>two << split >> three\n<<split>>\nfour").parts)
      .toEqual(["one", "two", "three", "four"])
    expect(transformHumanizerText("literal code:\n```text\n<<SPLIT>>\n```\n\nnext").parts)
      .toEqual(["literal code:\n```text\n<<SPLIT>>\n```", "next"])
    expect(transformHumanizerText("write `<<SPLIT>>` literally").parts)
      .toEqual(["write `<<SPLIT>>` literally"])
    expect(transformHumanizerText("literal code:\n```text\n<< split >>\n```\n\nnext").parts)
      .toEqual(["literal code:\n```text\n<< split >>\n```", "next"])
    expect(transformHumanizerText("write `<< split >>` literally").parts)
      .toEqual(["write `<< split >>` literally"])
    const task = transformHumanizerText("one<<split>>two", "task")
    expect(task.parts).toEqual(["one\ntwo"])
    expect(task.text).not.toContain("SPLIT")
    expect(transformHumanizerText("write `<<SPLIT>>` literally", "task").parts)
      .toEqual(["write `<<SPLIT>>` literally"])
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

  it("splits a long single-paragraph casual reply when the model emits no markers [humanizer-long-fallback]", () => {
    const result = transformHumanizerText("package.json 里写的是 \"@earendil-works/pi-ai\": \"0.85.1\"，跟 pi-agent-core 同版本，lock 文件也是 0.85.1(ws@8.21.3)。")
    expect(result.parts).toHaveLength(3)
    expect(result.split).toBe(true)
    expect(result.parts.every(part => !/[。，,；;]$/u.test(part))).toBe(true)
    expect(transformHumanizerText("嗯 交给我").parts).toEqual(["嗯 交给我"])
    expect(transformHumanizerText("今天先把简历的第一版写出来，不要卡在细节上。写完之后再回头补项目和数字，别一开始就追求完美。").parts)
      .toHaveLength(2)
    const multi = transformHumanizerText("简单说，HashMap 不是线程安全的，ConcurrentHashMap 是。它们底层都是数组、链表、红黑树\n多线程一起写 HashMap，轻则数据丢、size 记错，重则扩容时链成环、CPU 跑满；ConcurrentHashMap 用 CAS 加 synchronized 只锁单个桶，别的桶照常读写\n还有个小差别，ConcurrentHashMap 不允许 null 键和 null 值，HashMap 允许；它的 size 是估算值，迭代时拿到的也是弱一致快照")
    expect(multi.parts.length).toBeGreaterThan(3)
    const lineSplit = transformHumanizerText("回来啦\nhumanizer 那边结论还热着\n根因就一行\n工具一调 flow 就翻成 task\ntask 分支又把 SPLIT 直接滤掉\n所以看着像拟人化没起效\n要动就是 1432、1725、2938\n三处一起改\n我倾向先把工具历史那个条件摘掉\n跑一轮看看是不是就不再整段了")
    expect(lineSplit.parts.length).toBeGreaterThan(1)
    expect(lineSplit.parts.every(part => (part.match(/\n/g) ?? []).length <= 3)).toBe(true)
    // 代码围栏不冒险拆；task 流保持整条。
    expect(transformHumanizerText("这段够长了所以会触发兜底逻辑，但是里面有代码 ```ts\nconst a = 1\n``` 所以不拆。").parts).toHaveLength(1)
    expect(transformHumanizerText("package.json 里写的是 \"@earendil-works/pi-ai\": \"0.85.1\"，跟 pi-agent-core 同版本，lock 文件也是 0.85.1(ws@8.21.3)。", "task").parts).toHaveLength(1)
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
