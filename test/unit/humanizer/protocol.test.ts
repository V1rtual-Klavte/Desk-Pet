import { describe, expect, it } from "vitest"
import { humanizerRawVisibleText, SilenceGuard, transformHumanizerText } from "@/services/humanizer/protocol"

// 生产默认按文本哈希约 60% 走细切；单测固定成 normal，避免断言随哈希抖动。
const transform = (text: string, flow?: "casual" | "task") =>
  transformHumanizerText(text, flow, { split: "normal" })

describe("humanizer protocol", () => {
  it("splits normalized standalone markers without a total part cap [humanizer-protocol-split-no-cap]", () => {
    const result = transform("one\n<<SPLIT>>\ntwo\n <<SPLIT>> \nthree\n<<SPLIT>>\nfour\n<<SPLIT>>\nfive")
    expect(result.parts).toEqual(["one", "two", "three", "four", "five"])
    expect(result.text).toBe("one\ntwo\nthree\nfour\nfive")
    expect(result.split).toBe(true)
  })

  it("normalizes attached, spaced, and case-varied split markers without touching fenced code [humanizer-protocol-marker-normalization]", () => {
    expect(transform("one<<SPLIT>>two << split >> three\n<<split>>\nfour").parts)
      .toEqual(["one", "two", "three", "four"])
    expect(transform("literal code:\n```text\n<<SPLIT>>\n```\n\nnext").parts)
      .toEqual(["literal code:\n```text\n<<SPLIT>>\n```", "next"])
    expect(transform("write `<<SPLIT>>` literally").parts)
      .toEqual(["write `<<SPLIT>>` literally"])
    expect(transform("literal code:\n```text\n<< split >>\n```\n\nnext").parts)
      .toEqual(["literal code:\n```text\n<< split >>\n```", "next"])
    expect(transform("write `<< split >>` literally").parts)
      .toEqual(["write `<< split >>` literally"])
    const task = transform("one<<split>>two", "task")
    expect(task.parts).toEqual(["one two"])
    expect(task.text).not.toContain("SPLIT")
    expect(transform("write `<<SPLIT>>` literally", "task").parts)
      .toEqual(["write `<<SPLIT>>` literally"])
  })

  it("keeps pre-humanizer prose intact for the request view [humanizer-raw-visible-text]", () => {
    // 2026-10-21 用户口径：模型侧要看未拆原文，展示侧仍用拟人化泡。
    expect(humanizerRawVisibleText("第一泡，第二泡？ <<SPLIT>> 第三泡。"))
      .toBe("第一泡，第二泡？\n第三泡。")
    expect(humanizerRawVisibleText("line\n<<split>>\nnext")).toBe("line\nnext")
    expect(humanizerRawVisibleText("  \n<<SILENT>>\n  ")).toBe("")
    // 围栏与行内代码里的字面标记是正文，不能被当作控制语法删掉。
    expect(humanizerRawVisibleText("```text\n<<SPLIT>>\n```")).toBe("```text\n<<SPLIT>>\n```")
    expect(humanizerRawVisibleText("write `<<split>>` literally")).toBe("write `<<split>>` literally")
  })

  it("splits prose around fenced code even when the model emitted split markers [humanizer-split-marker-code-fence]", () => {
    // 2026-10-21 实机：带 <<SPLIT>> 的技术回答里，第四点、配置说明和 YAML 块
    // 被 `includes("```")` 整段留成一泡；标记段也要先按空行分段。
    const text = "一、第一点。\n<<SPLIT>>四、Hystrix 的超时和网关的 retry filter，它们也会再叠加一次。\n\n超时的配置，我用的是 2022 之后的版本：\n\n```yaml\nspring:\n  cloud:\n```\n\n后面的话"
    const result = transform(text)
    expect(result.parts.find(part => part.includes("```yaml"))).toBe("```yaml\nspring:\n  cloud:\n```")
    const prose = result.parts.filter(part => part.includes("超时的配置"))
    expect(prose.length).toBeGreaterThan(0)
    expect(prose.every(part => !part.includes("```"))).toBe(true)
    expect(result.parts.some(part => part.startsWith("四"))).toBe(true)
    expect(result.parts.some(part => part.includes("后面的话"))).toBe(true)
  })

  it("splits blank-line casual paragraphs into bubbles while single breaks stay together [humanizer-blank-line-split]", () => {
    const result = transform("看到了\n\n在改 Desk-Pet\n\n周末也这么拼")
    expect(result.parts).toEqual(["看到了", "在改 Desk-Pet", "周末也这么拼"])
    expect(result.split).toBe(true)
    // 30 字兜底粒度下，两个短英文分句并成一泡（不再按 15 字拆碎）。
    expect(transform("first line\nsecond line").parts).toEqual(["first line second line"])
    expect(transform("first line\nsecond line").split).toBe(false)
    // 代码块**整块不拆**（块内空行不是断点），但它前后的说话各自成泡 ——
    // 2026-10-08 用户裁定：「拟人化开了就像人发消息一样讲解，不会一大条过来」。
    // 原口径是「含 ``` 就整条不拆」，一刀切把代码前后的说话也冻成一大块。
    expect(transform("看这个\n\n```ts\nconst a = 1\n```").parts)
      .toEqual(["看这个", "```ts\nconst a = 1\n```"])
    // 判据：围栏**内部**的空行绝不能成为断点（否则代码会被劈成两泡）。
    expect(transform("看这个\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n完事").parts)
      .toEqual(["看这个", "```ts\nconst a = 1\n\nconst b = 2\n```", "完事"])
    // task 流保持一条消息；空行分段保留，段内普通文本合行。
    expect(transform("one\n\ntwo", "task").parts).toEqual(["one\ntwo"])
  })

  it("splits a long single-paragraph casual reply when the model emits no markers [humanizer-long-fallback]", () => {
    const result = transform("package.json 里写的是 \"@earendil-works/pi-ai\": \"0.85.1\"，跟 pi-agent-core 同版本，lock 文件也是 0.85.1(ws@8.21.3)。")
    // 2026-10-21：空格兜底只认「中文 中文」之间的空格，这条按逗号切成 3 泡。
    expect(result.parts).toHaveLength(3)
    expect(result.split).toBe(true)
    expect(result.parts.every(part => !/[。，,；;]$/u.test(part))).toBe(true)
    expect(transform("嗯 交给我").parts).toEqual(["嗯 交给我"])
    // 2026-10-21 用户口径：去掉并泡，按逗号切出几段就是几泡。
    expect(transform("今天先把简历的第一版写出来，不要卡在细节上。写完之后再回头补项目和数字，别一开始就追求完美。").parts)
      .toEqual(["今天先把简历的第一版写出来", "不要卡在细节上", "写完之后再回头补项目和数字", "别一开始就追求完美"])
    const multi = transform("简单说，HashMap 不是线程安全的，ConcurrentHashMap 是。它们底层都是数组、链表、红黑树\n多线程一起写 HashMap，轻则数据丢、size 记错，重则扩容时链成环、CPU 跑满；ConcurrentHashMap 用 CAS 加 synchronized 只锁单个桶，别的桶照常读写\n还有个小差别，ConcurrentHashMap 不允许 null 键和 null 值，HashMap 允许；它的 size 是估算值，迭代时拿到的也是弱一致快照")
    expect(multi.parts.length).toBeGreaterThan(3)
    const lineSplit = transform("回来啦\nhumanizer 那边结论还热着\n根因就一行\n工具一调 flow 就翻成 task\ntask 分支又把 SPLIT 直接滤掉\n所以看着像拟人化没起效\n要动就是 1432、1725、2938\n三处一起改\n我倾向先把工具历史那个条件摘掉\n跑一轮看看是不是就不再整段了")
    expect(lineSplit.parts.length).toBeGreaterThan(1)
    expect(lineSplit.parts.every(part => !part.includes("\n"))).toBe(true)
    // 代码围栏不冒险拆；task 流保持整条。
    expect(transform("这段够长了所以会触发兜底逻辑，但是里面有代码 ```ts\nconst a = 1\n``` 所以不拆。").parts).toHaveLength(1)
    expect(transform("package.json 里写的是 \"@earendil-works/pi-ai\": \"0.85.1\"，跟 pi-agent-core 同版本，lock 文件也是 0.85.1(ws@8.21.3)。", "task").parts).toHaveLength(1)
  })

  it("splits technical replies at safe boundaries without cutting words [humanizer-technical-split]", () => {
    // 2026-10-20 实机：技术回答整段一泡，原因是「含英文/数字/代码就不切」。
    // 现在按句读、空白切，英文词与代码标识保持完整。
    const result = transform("HashMap 不是线程安全的，ConcurrentHashMap 用 CAS 加 synchronized 只锁单个桶，别的桶照常读写，读基本不用锁")
    expect(result.parts.length).toBeGreaterThan(1)
    expect(result.parts.join("")).toContain("ConcurrentHashMap")
    expect(result.parts.every(part => part.length > 4)).toBe(true)
    // 不再自动补 CJK/英文空格；正文保持模型原样，避免和分泡抢边界。
    expect(transform("锁粒度HashMap").parts[0]).toBe("锁粒度HashMap")
    // 纯英文长句没有中英边界：保持完整，不切在单词中间。
    const english = "The reranker receives a query and a list of candidate documents and returns a relevance score for each candidate"
    expect(transform(english).parts).toEqual([english])
  })

  it("never leaves a single-word bubble or a leading comma in casual bubbles [humanizer-no-fragment]", () => {
    // 2026-10-20 实机：15 字硬切会留下「入口」「浮」这种孤字泡，模型也会把逗号留在行首。
    const parts = transform("现在 latest 是 1.3.0，10 月 15 号发的另外还有个 legacy-node20 tag 停在 0.74.2").parts
    expect(parts).not.toContain("另外")
    expect(parts.every(part => part.length > 4)).toBe(true)
    const comma = transform("滚动区也没给它让出位置再往上看\n，第一条消息还缺了半行").parts
    expect(comma.every(part => !part.startsWith("，"))).toBe(true)
    const cut = transform("跟面板里那个已展开的调试是两处入口，看不出状态有没有联动中间那块浮层要是能改成从侧边挤出").parts
    expect(cut).not.toContain("入口")
    expect(cut.every(part => !part.endsWith("浮"))).toBe(true)
  })

  it("uses finer bubbles when the split mode is fine [humanizer-fine-split]", () => {
    // 约 60% 的回复走细切（生产由文本哈希决定）；细切仍只落在自然边界上。
    const text = "这句我今天听第三遍了 看来是真累着了 今晚就别定什么计划了 躺着要紧 明天还得早起去公司开一个特别长的会"
    const normal = transformHumanizerText(text, "casual", { split: "normal" })
    const fine = transformHumanizerText(text, "casual", { split: "fine" })
    // 2026-10-21 用户口径：整段只用空格断句时也要分泡（此前两档都留成一大泡）；
    // 细切档目标更短，气泡数应当更多。
    expect(normal.parts.length).toBeGreaterThan(1)
    expect(fine.parts.length).toBeGreaterThan(normal.parts.length)
    expect(normal.parts.join("").replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""))
    // 细切档把所有全角标点也当边界；普通档同一句不拆。
    const punct = transformHumanizerText("先热身十分钟。再慢慢跑两圈、最后拉伸一下", "casual", { split: "fine" })
    expect(punct.parts).toEqual(["先热身十分钟", "再慢慢跑两圈", "最后拉伸一下"])
    const q = transformHumanizerText("真的假的？！你再多说两句我听听到底是怎么回事", "casual", { split: "fine" })
    expect(q.parts).toEqual(["真的假的？！", "你再多说两句我听听到底是怎么回事"])
  })

  it("uses fine bubbles for roughly 60% of replies [humanizer-fine-share]", () => {
    // 2026-10-21 用户口径：细切概率 60%（此前 40%）。顿号只有细切档当边界，
    // 所以 parts>1 等价于这一条走了细切；400 条样本的占比被钉在 0.6 附近。
    let fine = 0
    const total = 400
    for (let index = 0; index < total; index += 1) {
      const text = `第${index}项甲乙丙丁戊己庚辛壬癸子丑寅卯、第二项戊己庚辛壬癸子丑寅卯辰巳、第三项壬癸子丑寅卯辰巳午未申酉`
      if (transformHumanizerText(text, "casual").parts.length > 1) fine += 1
    }
    expect(fine / total).toBeGreaterThan(0.52)
    expect(fine / total).toBeLessThan(0.68)
  })

  it("splits a long reply that only uses spaces as separators [humanizer-space-only-split]", () => {
    // 2026-10-21 实机：模型整段用空格断句，一条 200 字挤成一个气泡。
    // 无标点时改为在中英边界空格处兜底切开，技术词保持完整。
    const text = "简历上一堆基于大模型的智能体记忆系统值钱的是你手里那些能接住追问的东西水位为什么只能在 commit 那个事务里推 租约过期为什么算审计位不算在飞 两条链撞同一分钟你怎么保证不写坏这些写进简历是加分 讲出来才是分"
    const result = transform(text)
    expect(result.parts.length).toBeGreaterThan(1)
    expect(result.split).toBe(true)
    // 切分不能吃掉或改写正文，也不能留下碎泡。
    expect(result.parts.join("").replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""))
    expect(result.parts.every(part => part.length > 4)).toBe(true)
    // 技术词不因空格被劈开。
    expect(result.parts.join(" ")).toContain("commit")
    // 没有中英边界的纯英文长句仍保持一泡（见 technical-split 用例）。
    expect(transform("嗯 交给我").parts).toEqual(["嗯 交给我"])
    // 2026-10-21 用户口径：只有「中文 中文」之间的空格是边界；
    // 中文与英文/数字相邻的空格不切，这类混排长句保持一泡。
    const runOn = transform("后端岗大多还是 Java 和 Go 的天下 rust 在简历上是加分项八股得按人家的路数来要是被问为什么不用")
    expect(runOn.parts).toHaveLength(1)
    // 前半句带句号、后半句只有空格且远超上限（2026-10-21 实机 13:28 那条 75 字长泡）：
    // 标点切分后必须对剩余片段再做一次空格兜底。
    const mixed = transform("这份 agent 项目在简历里挺值钱 现在懂 agent 记忆的后端候选人不多。写的时候别写负责记忆模块 要写你定的规则 分区存放 召回怎么命中 什么时候算不该记 怎么纠正和遗忘再配一个数字 比如条目量 命中率 整理轮次 面试官就有得追了你现在的面试多半就会往这儿问")
    expect(mixed.parts.length).toBeGreaterThan(2)
    expect(mixed.parts.every(part => part.length <= 38)).toBe(true)
  })

  it("splits list items written one per line without a split marker [humanizer-list-lines]", () => {
    // 2026-10-21：提示词不再要求 <<SPLIT>>，分点靠「行首编号/短横」这一硬边界。
    // 编号用点（1.），代码把点收成空格；裸数字+空格会误伤「10 月 15 号」这类句子，不做列表起始。
    const result = transform("建议这么写\n1. 记忆分层与写入门禁\n2. 候选隔离与单事务提交\n3. 可纠正与可遗忘")
    expect(result.parts).toEqual(["建议这么写", "1 记忆分层与写入门禁", "2 候选隔离与单事务提交", "3 可纠正与可遗忘"])
    // 短横是项目符号：分条时被收掉，气泡里不带「- 」。
    const dashes = transform("先做这三件\n- 看日志\n- 跑单测\n- 再提交")
    expect(dashes.parts).toEqual(["先做这三件", "看日志", "跑单测", "再提交"])
  })

  it("keeps each casual bubble on a single line and preserves fenced code [humanizer-bubble-single-line]", () => {
    // 2026-10-20 实机：模型按句一行输出，兜底并泡用换行连接，气泡里就显示成多行。
    const result = transform("查了一下，\n最新是 1.3.0，\n10 月 15 号发的，\n你项目里还停在 0.85.1")
    // 2026-10-21 用户口径：去掉并泡，逗号边界各自成泡。
    expect(result.parts).toEqual(["查了一下", "最新是 1.3.0", "10 月 15 号发的", "你项目里还停在 0.85.1"])
    expect(result.parts.every(part => !part.includes("\n"))).toBe(true)
    // 围栏代码块整块保留换行；块前后的说话各自成泡、泡内归并。
    const withCode = transform("先看这段\n用 createModels 就行\n\n```ts\nconst models = createModels()\n```\n\n再配 provider")
    expect(withCode.parts).toEqual([
      "先看这段 用 createModels 就行",
      "```ts\nconst models = createModels()\n```",
      "再配 provider",
    ])
  })

  it("strips decorative punctuation and semicolons but keeps question and exclamation marks [humanizer-punct-cleanup]", () => {
    // 2026-10-20 用户规则：破折号/省略号/中文引号/书名号代码侧去掉；分号换成空格；
    // 问号/叹号保留；泡尾不挂句号逗号。
    expect(transform("那就这样——明天见！").parts).toEqual(["那就这样明天见！"])
    expect(transform("他说“走吧”《书》").parts).toEqual(["他说走吧书"])
    expect(transform("好……啊？").parts).toEqual(["好啊？"])
    expect(transform("真的假的？！").parts).toEqual(["真的假的？！"])
    expect(transform("先这样；明天再说").parts).toEqual(["先这样 明天再说"])
    // 顿号也换成空格，但在分泡之后替换，不能被切成空泡。
    expect(transform("砂锅粥、清汤粉、关东煮").parts).toEqual(["砂锅粥 清汤粉 关东煮"])
    expect(transform("就粥、").parts).toEqual(["就粥"])
    // 逗号按文本+位置哈希随机换约 40%：这一句第一个逗号保留，第二个换成空格，
    // 同一句重复调用结果稳定。
    expect(transform("砂锅粥，清汤粉，关东煮").parts).toEqual(["砂锅粥，清汤粉 关东煮"])
    expect(transform("砂锅粥，清汤粉，关东煮").parts).toEqual(["砂锅粥，清汤粉 关东煮"])
    // 列表编号后的点换成空格，列表项是硬边界，不能黏进上一条。
    const list = transform("1. 自调用最常见。同一个类里 a() 直接调 b()，走的是 this 不是代理对象，b 上注解等于白写\n2. 方法不是 public。标准要求 public，非 public 官方不保证拦得住")
    expect(list.parts.some(part => part.startsWith("1 自调用最常见"))).toBe(true)
    expect(list.parts.some(part => part.startsWith("2 方法不是 public"))).toBe(true)
    expect(list.parts.some(part => part.includes("白写 2."))).toBe(false)
    expect(list.parts.every(part => !/^\d+\./u.test(part))).toBe(true)
    // 中文序号同样按项分开；短列表也不并成一泡。
    expect(transform("一、先热身\n二、再跑步").parts).toEqual(["一 先热身", "二 再跑步"])
    // 冒号换成空格；长句在冒号处断开，短句只换空格不额外拆。
    expect(transform("步骤是这样的：先热身十分钟再开始跑别急着上强度不然容易拉伤真的").parts)
      .toEqual(["步骤是这样的", "先热身十分钟再开始跑别急着上强度不然容易拉伤真的"])
    expect(transform("步骤：先热身").parts).toEqual(["步骤 先热身"])
    // ASCII 冒号保留给时间/URL/对象字面量。
    expect(transform("10:30 开会").parts).toEqual(["10:30 开会"])
    // 沿用原有粒度：短句不拆；长句在 ?! 处断开时，?! 跟着前一句留在泡尾。
    expect(transform("真的假的？！你再多说两句我听听到底是怎么回事我这边还没真的反应过来").parts)
      .toEqual(["真的假的？！", "你再多说两句我听听到底是怎么回事我这边还没真的反应过来"])
    // 代码里的符号是内容，原样保留（围栏与行内代码都不洗）。
    expect(transform("看这段\n```ts\nconst a = `x——y`\n```").parts)
      .toEqual(["看这段\n```ts\nconst a = `x——y`\n```"])
    expect(transform("写成 `a;b` 就行").parts).toEqual(["写成 `a;b` 就行"])
  })

  it("keeps English apostrophes inside words in both flows [humanizer-english-apostrophe]", () => {
    // 2026-10-28 实机：弯撇号既在细切边界集合又在装饰标点集合，`It’s` 裂成 `It` + 换行 + `s`，
    // 英文回复被拆碎后「不超过三句话」这类逐句判据失真。撇号先收成 ASCII `'` 再分泡/清洗。
    const contractions = "It’s important to note that the user’s preference was already stated. I’ll keep it that way."
    expect(transformHumanizerText(contractions, "casual", { split: "fine" }).parts)
      .toEqual(["It's important to note that the user's preference was already stated. I'll keep it that way."])
    // 细切档仍在自然边界（破折号）分泡，但不在缩写里分泡；复数所有格 `users’` 也不下刀。
    expect(transformHumanizerText("Don’t worry — I’ve already checked the plan. Let’s keep going.", "casual", { split: "fine" }).parts)
      .toEqual(["Don't worry", "I've already checked the plan. Let's keep going."])
    expect(transformHumanizerText("Don’t worry — I’ve already checked the plan. Let’s keep going.", "casual", { split: "normal" }).parts)
      .toEqual(["Don't worry I've already checked the plan. Let's keep going."])
    expect(transformHumanizerText("I think the team’s plan is fine, but we should double-check the users’ feedback before shipping. Don’t you agree?", "casual", { split: "fine" }).parts)
      .toEqual(["I think the team's plan is fine", "but we should double-check the users' feedback before shipping. Don't you agree?"])
    // task 流同样保留撇号（只清洗装饰标点，不减句子）。
    expect(transform("Don’t you agree? The user’s reply was clear.", "task").parts)
      .toEqual(["Don't you agree? The user's reply was clear."])
    // 中文单/双引号不是撇号：左边不是拉丁字母，照旧按装饰标点收掉。
    expect(transform("‘测试’的用法里中文引号还是要被收掉的，别担心").parts)
      .toEqual(["测试的用法里中文引号还是要被收掉的，别担心"])
    // 代码里的弯引号是内容，不改写（围栏与行内代码原样）。
    expect(transform("看这段\n```ts\nconst a = `It’s here`\n```").parts)
      .toEqual(["看这段\n```ts\nconst a = `It’s here`\n```"])
    expect(transform("写成 `It’s` 就行").parts).toEqual(["写成 `It’s` 就行"])
  })

  it("splits long punctuation-free casual replies without cutting connective words [humanizer-connective-split]", () => {
    // 2026-10-21 用户规则：整段只用空格断句时，按中英边界空格兜底分泡
    // （2026-10-20 的「没有标点宁可留长泡」已被实机一大段黏成一泡推翻）。
    // 仍不从连接词/语气词下刀：不产生「另外」这类孤泡。
    const text = "这句我今天听第三遍了 看来是真累着了 今晚就别定什么计划了 躺着要紧 明天还得早起去公司开一个特别长的会"
    const result = transform(text)
    expect(result.parts.length).toBeGreaterThan(1)
    expect(result.parts.join("").replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""))
    expect(result.parts.every(part => part.length > 4)).toBe(true)
    // 短到不需要兜底的句子原样保留。
    expect(transform("并发下它没法区分没有这个 key 和值就是 null 迭代也不一样").parts.join(""))
      .toContain("和值就是 null")
  })

  it("flattens task bubbles and strips trailing commas [humanizer-task-bubble-lines]", () => {
    // 2026-10-20 实机：task 流把模型逐行输出原样送进气泡，每行末尾挂着逗号。
    const task = transform("所以能砍的只剩 import 那条\n12 步一串 await 还各带一次动态 import，\n冷启动全叠在首帧之前，", "task")
    expect(task.parts).toEqual(["所以能砍的只剩 import 那条 12 步一串 await 还各带一次动态 import，冷启动全叠在首帧之前"])
  })

  it("keeps task output in one part and removes a stray split marker [humanizer-task-single-part]", () => {
    const result = transform("one\n<<SPLIT>>\ntwo", "task")
    expect(result.parts).toEqual(["one two"])
    expect(transform("<<SILENT>>", "task").silent).toBe(false)
  })

  it("recognizes silence only when it is the full visible reply [humanizer-silent-exact]", () => {
    expect(transform("  <<SILENT>>  ").silent).toBe(true)
    expect(transform("answer\n<<SILENT>>").silent).toBe(false)
  })

  it("allows one silence per session and replaces a consecutive second silence [humanizer-silence-guard]", () => {
    const guard = new SilenceGuard()
    const silent = transform("<<SILENT>>")
    expect(guard.resolve("s1", silent, "嗯嗯").silent).toBe(true)
    expect(guard.resolve("s1", silent, "嗯嗯")).toMatchObject({ silent: false, rejected: true, text: "嗯嗯", parts: ["嗯嗯"] })
    expect(guard.resolve("s2", silent, "嗯嗯").silent).toBe(true)
  })
})
