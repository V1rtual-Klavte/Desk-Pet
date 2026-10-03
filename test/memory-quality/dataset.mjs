/**
 * AI-drafted synthetic Chinese fixtures for independent human audit. The evaluator
 * never derives gold facts from model output. Gold status stays pending until review.
 */
const addressFacts = [
  ["称呼", "叫我阿澄", "阿澄", "你平时应该怎么称呼我？"],
  ["称呼", "请称呼我小满", "小满", "我希望你怎么叫我？"],
  ["称呼", "以后叫我林队", "林队", "称呼我什么比较合适？"],
  ["称呼", "我喜欢你喊我北北", "北北", "你记得我喜欢的称呼吗？"],
  ["称呼", "叫我一一就好", "一一", "请问我希望被怎么称呼？"],
  ["称呼", "我想用昵称橘子", "橘子", "我常用的昵称是什么？"],
  ["称呼", "以后喊我周老师", "周老师", "我希望你叫我什么？"],
  ["称呼", "朋友都叫我小岚，你也这样叫吧", "小岚", "我让你怎么称呼我来着？"],
  ["称呼", "叫我阿禾吧", "阿禾", "我的称呼偏好是什么？"],
  ["称呼", "请叫我Mia", "Mia", "你应该怎么叫我？"],
  ["偏好", "我喝咖啡只加燕麦奶", "咖啡加燕麦奶", "我喝咖啡有什么固定偏好？"],
  ["偏好", "写说明时请先给结论，再讲理由", "先结论后理由", "我喜欢怎样的说明结构？"],
  ["偏好", "我不吃香菜", "不吃香菜", "点餐时要记住什么？"],
  ["偏好", "周末散步我更喜欢安静的路线", "安静路线", "我周末散步偏好什么路线？"],
  ["偏好", "代码示例默认用 TypeScript", "TypeScript 示例", "我希望代码例子用什么语言？"],
  ["偏好", "提醒我时请简短一点，不要连续催", "简短且不连续催促", "我偏好的提醒方式是什么？"],
  ["偏好", "我习惯用公制单位", "公制单位", "展示长度和重量时用什么单位？"],
  ["偏好", "我更喜欢无糖茶", "无糖茶", "我平时喜欢喝什么茶？"],
  ["偏好", "讨论方案时先列风险，再给选项", "先风险后选项", "讨论方案时我喜欢什么顺序？"],
  ["偏好", "我读长文更习惯分段，不要整页大段文字", "分段短文", "我读长文有什么格式偏好？"],
]

const episodes = [
  ["上周", "第一次独自完成了木工小凳", "木工小凳", "上周我完成了什么手工作品？"],
  ["去年夏天", "和姐姐去了青岛看海", "青岛看海", "去年夏天我和谁去了哪里？"],
  ["三月", "参加了第一次半程马拉松", "半程马拉松", "我三月参加了什么活动？"],
  ["昨天", "把阳台的薄荷分盆了", "薄荷分盆", "我昨天整理了什么植物？"],
  ["上个月", "读完了《海边的卡夫卡》", "读完《海边的卡夫卡》", "上个月我读完了哪本书？"],
  ["去年冬天", "第一次带家人去滑雪", "带家人滑雪", "去年冬天那次家庭活动是什么？"],
  ["上周五", "给社区流浪猫搭了避雨棚", "给猫搭避雨棚", "我上周五做了件什么社区小事？"],
  ["四月", "在朋友婚礼上弹了钢琴", "婚礼弹钢琴", "我四月在哪个场合弹过琴？"],
  ["昨天晚上", "试做了柠檬磅蛋糕", "柠檬磅蛋糕", "我昨晚试做了什么甜点？"],
  ["两周前", "第一次坐夜船去了舟山", "夜船去舟山", "两周前我怎么去的舟山？"],
  ["今年春天", "报名学了陶艺", "报名学陶艺", "今年春天我开始学什么？"],
  ["上个月", "修好了用了多年的胶片相机", "修好胶片相机", "上个月修好的旧物是什么？"],
  ["前天", "和同事完成了办公室搬迁", "办公室搬迁", "前天我和同事完成了什么？"],
  ["去年九月", "第一次去敦煌看壁画", "敦煌看壁画", "我去年九月去哪里看了什么？"],
  ["最近", "开始练习每天写一页手账", "每天写手账", "我最近开始坚持什么习惯？"],
  ["上周末", "陪外婆整理了老照片", "整理老照片", "上周末我陪外婆做了什么？"],
  ["六月", "在公司分享了无障碍设计经验", "分享无障碍设计", "我六月在公司分享了什么？"],
  ["昨天下午", "把自行车送去换了刹车线", "更换刹车线", "我昨天下午维修了自行车哪里？"],
  ["去年春天", "和大学同学重走了校园", "重走校园", "去年春天我和谁重走了哪里？"],
  ["上个月", "第一次参加了旧物交换集市", "参加旧物交换集市", "我上个月参加了什么集市？"],
]

// Half-open intervals preserve source precision: a month never becomes an invented day.
const episodeIntervals = [["2026-09-21", "2026-09-28"], ["2025-06-01", "2025-09-01"],
  ["2026-03-01", "2026-04-01"], ["2026-10-01", "2026-10-02"], ["2026-09-01", "2026-10-01"],
  ["2025-12-01", "2026-03-01"], ["2026-09-25", "2026-09-26"], ["2026-04-01", "2026-05-01"],
  ["2026-10-01", "2026-10-02"], ["2026-09-18", "2026-09-19"], ["2026-03-01", "2026-06-01"],
  ["2026-09-01", "2026-10-01"], ["2026-09-30", "2026-10-01"], ["2025-09-01", "2025-10-01"],
  [null, null], ["2026-09-26", "2026-09-28"], ["2026-06-01", "2026-07-01"],
  ["2026-10-01", "2026-10-02"], ["2025-03-01", "2025-06-01"], ["2026-09-01", "2026-10-01"]]

const corrections = [
  ["我现在住在苏州", "我已经搬到无锡了", "无锡", "我现在住在哪座城市？"],
  ["我以前用安卓手机", "换机后我现在用 iPhone", "iPhone", "我现在用什么手机？"],
  ["我的猫叫团子", "更正一下，猫咪名字是豆包", "豆包", "我家猫现在叫什么？"],
  ["我在公司做测试", "我转岗了，现在负责产品设计", "产品设计", "我现在负责什么工作？"],
  ["我通常坐地铁通勤", "新家离公司近，我现在骑车通勤", "骑车通勤", "我现在怎么通勤？"],
  ["我把生日记成了5月12日", "之前说错了，生日是5月21日", "5月21日", "我的生日是哪一天？"],
  ["我在学法语", "更正：我最近改学日语了", "日语", "我最近在学哪门语言？"],
  ["我负责后端开发", "现在调整为负责数据分析", "数据分析", "我现在的工作方向是什么？"],
  ["我周三有空", "日程更新，周三不行，周四有空", "周四有空", "我哪天有空？"],
  ["我最喜欢蓝色", "想更正一下，现在最喜欢的是绿色", "绿色", "我目前最喜欢什么颜色？"],
  ["我的狗叫Lucky", "登记错了，它的名字是Loki", "Loki", "我的狗叫什么？"],
  ["我住在浦东", "最近搬家到徐汇了", "徐汇", "我现在住在哪个区？"],
  ["我的项目代号是白鹭", "项目改名了，现在叫云杉", "云杉", "项目现在叫什么？"],
  ["我每月15号交房租", "房东改了日期，现在每月10号交", "每月10号", "房租现在几号交？"],
  ["我用的是 Windows 笔记本", "我换成 MacBook 了", "MacBook", "我现在用哪种电脑？"],
  ["我周末会游泳", "最近膝盖恢复中，暂时改成散步", "散步", "我近期周末做什么运动？"],
  ["我养了两只兔子", "更正，现在只养一只兔子", "一只兔子", "我现在养几只兔子？"],
  ["会议安排在上午九点", "会议改到下午两点", "下午两点", "会议现在几点开始？"],
  ["我在准备教师资格考试", "考试通过了，现在准备的是普通话测试", "普通话测试", "我现在准备什么考试？"],
  ["我每周二去办公室", "团队调整后改成每周四", "每周四", "我现在每周哪天去办公室？"],
]

const forgetting = [
  ["称呼", "不要再记得我叫小鹿", "小鹿", "我叫什么？"],
  ["偏好", "请忘掉我不吃辣这个偏好", "不吃辣", "我吃辣吗？"],
  ["经历", "那次去厦门的旅行请忘记", "去厦门旅行", "我去厦门做过什么？"],
  ["称呼", "撤回之前的昵称阿布，不要再用它", "阿布", "你会怎么称呼我？"],
  ["偏好", "忘记我喜欢黑咖啡这件事", "喜欢黑咖啡", "我喜欢喝什么咖啡？"],
  ["经历", "请忘记我参加过编程马拉松", "参加编程马拉松", "我参加过什么编程活动？"],
  ["偏好", "删除我偏好早起的记忆", "偏好早起", "我喜欢几点起床？"],
  ["称呼", "以后别再记小鱼这个称呼了", "小鱼", "你知道我的昵称吗？"],
  ["经历", "忘记我曾在南京实习的记录", "南京实习", "我在哪座城市实习过？"],
  ["偏好", "请移除我喜欢看恐怖片的偏好", "喜欢恐怖片", "我爱看什么类型的电影？"],
  ["经历", "把我参加过合唱团的事情忘掉", "参加合唱团", "我以前参加过什么社团？"],
  ["称呼", "不再保留昵称栗子", "栗子", "我希望你怎么叫我？"],
  ["偏好", "忘掉我习惯用深色主题", "深色主题", "我喜欢什么界面主题？"],
  ["经历", "请忘记我养过金鱼", "养过金鱼", "我以前养过什么宠物？"],
  ["偏好", "撤销我喜欢辣味火锅的记录", "喜欢辣味火锅", "我喜欢什么口味的火锅？"],
  ["经历", "忘记我去年修过老收音机", "修老收音机", "去年我修过什么？"],
  ["称呼", "把小队长这个称呼从记忆里删掉", "小队长", "我以前让你怎么称呼我？"],
  ["偏好", "请忘掉我喜欢坐靠窗的位置", "喜欢靠窗", "我选座位有什么偏好？"],
  ["经历", "那次在成都学做面请忘记", "在成都学做面", "我在成都学过什么？"],
  ["偏好", "删除我喜欢语音消息的偏好", "喜欢语音消息", "我偏好哪种消息形式？"],
]

const scopes = ["user", "card", "session", "user", "card"]
const cards = ["card-amber", "card-lilac", "card-pine", "card-sand", "card-ink"]
const variants = ["原句复述", "同义表达", "中文短词", "第三方隔离", "假设/无关干扰"]

function fixtureFact(id, content, scope, sourceMessageId, validFrom = "2026-01-01T00:00:00Z", validUntil = null, scopeIdOverride) {
  return { factId: id, content, scope, scopeId: scope === "card" ? scopeIdOverride ?? "card-amber" : scope === "session" ? "session-fixture" : null,
    sourceMessageIds: [sourceMessageId], validFrom, validUntil }
}

export const MEMORY_QUALITY_DATASET_VERSION = "2026-10-02.1"
export const MEMORY_QUALITY_STRATEGIES = ["no-memory", "local", "always", "adaptive", "gold-evidence"]

function caseRow(group, index, capability, sourceText, factText, question, options = {}) {
  const caseId = `mq-${group}-${String(index + 1).padStart(2, "0")}`
  const scope = scopes[(index + (group === "forgetting" ? 1 : 0)) % scopes.length]
  const cardId = scope === "card" ? cards[index % cards.length] : undefined
  const primary = fixtureFact(`${caseId}-fact`, factText, scope, `${caseId}-source`, "2026-01-01T00:00:00Z", null, cardId)
  const decoyScope = scope === "user" ? "card" : "user"
  const decoy = fixtureFact(`${caseId}-decoy`, `第三方资料：同事称${factText}`, decoyScope, `${caseId}-third-party`,
    "2026-01-01T00:00:00Z", null, "card-other")
  const sourceMessages = [
    { id: `${caseId}-source`, role: "user", scope, cardId, text: sourceText, createdAt: primary.validFrom },
    { id: `${caseId}-third-party`, role: "user", scope: decoyScope, cardId: decoyScope === "card" ? "card-other" : undefined,
      text: `我同事说${factText}，这是同事的情况，不是我的事实。`, createdAt: "2026-01-02T00:00:00Z" },
    { id: `${caseId}-irrelevant`, role: "user", scope: "user", text: `无关备注：今天看到一只橘猫。${variants[index % variants.length]}`, createdAt: "2026-01-03T00:00:00Z" },
  ]
  const allowedScopes = scope === "user" ? ["user"] : scope === "card" ? ["user", "card"] : ["user", "session"]
  return {
    caseId, group, capability, variant: variants[index % variants.length],
    fixture: { sessionId: `${caseId}-session`, cardId, sourceMessages, activeFacts: options.activeFacts ?? [primary, decoy],
      tombstones: options.tombstones ?? [], currentAt: "2026-10-02T12:00:00Z", emptyPriorConversation: true },
    question, gold: {
      allowedEvidence: options.allowedEvidence ?? [primary.factId],
      allowedSourceMessageIds: options.allowedSourceMessageIds ?? [primary.sourceMessageIds[0]],
      forbiddenEvidence: options.forbiddenEvidence ?? [decoy.factId],
      forbiddenSourceMessageIds: options.forbiddenSourceMessageIds ?? [decoy.sourceMessageIds[0]],
      expectedFactIds: options.expectedFactIds ?? [primary.factId],
      answerFacts: options.answerFacts ?? [factText], expectedAbstention: options.expectedAbstention ?? false,
      requiredScope: scope, requiredScopes: allowedScopes, requiredCardId: cardId ?? null, validAt: "2026-10-02T12:00:00Z",
      extractGoldFactIds: options.extractGoldFactIds ?? [primary.factId],
      extractForbiddenFactIds: options.extractForbiddenFactIds ?? [decoy.factId],
      answerRubric: options.answerRubric ?? `仅在允许证据支持时回答：${factText}`,
    },
  }
}

const cases = []
for (let i = 0; i < 20; i += 1) {
  const [kind, source, fact, question] = addressFacts[i]
  const row = caseRow("address-preference", i, kind === "称呼" ? "memory-quality-address" : "memory-quality-preference", source, fact, question)
  row.gold.answerFacts = [fact]
  cases.push(row)
}
for (let i = 0; i < 20; i += 1) {
  const [when, event, fact, question] = episodes[i]
  const row = caseRow("temporal-episode", i, "memory-quality-temporal-episode",
    `以2026年10月2日为时间参照：${when}，我${event}。`, fact, `以2026年10月2日为时间参照，${question}`)
  row.fixture.sourceMessages[0].createdAt = row.fixture.currentAt
  row.fixture.activeFacts[0].content = `${when}（参照日期2026-10-02），我${event}。`
  row.fixture.activeFacts[0].validFrom = `${episodeIntervals[i][0] ?? "2026-01-01"}T00:00:00Z`
  row.gold.temporal = { statedTime: when, sourceSaidAt: row.fixture.currentAt,
    eventInterval: episodeIntervals[i], precision: episodeIntervals[i][0] === null ? "unknown" : "source-expression",
    validFrom: row.fixture.activeFacts[0].validFrom, validUntil: null, mustRespectAsOf: true }
  cases.push(row)
}
for (let i = 0; i < 20; i += 1) {
  const [oldValue, newValue, current, question] = corrections[i]
  const caseId = `mq-correction-${String(i + 1).padStart(2, "0")}`
  const row = caseRow("correction", i, "memory-quality-correction", newValue, current, question)
  const old = fixtureFact(`${caseId}-old-fact`, oldValue, row.gold.requiredScope,
    `${caseId}-old-source`, "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z", row.gold.requiredCardId ?? undefined)
  row.fixture.sourceMessages.unshift({ id: `${caseId}-old-source`, role: "user", scope: old.scope, cardId: row.fixture.cardId,
    text: oldValue, createdAt: old.validFrom })
  row.fixture.activeFacts = [old, ...row.fixture.activeFacts]
  row.gold.forbiddenEvidence.push(old.factId)
  row.gold.forbiddenSourceMessageIds.push(`${caseId}-old-source`)
  row.gold.expectedFactIds = [`${caseId}-fact`]
  row.gold.extractGoldFactIds = [`${caseId}-fact`]
  row.gold.extractForbiddenFactIds.push(old.factId)
  row.gold.supersededFactIds = [old.factId]
  row.gold.temporal = { oldValidUntil: old.validUntil, currentValidFrom: row.fixture.activeFacts[1].validFrom, correctionWins: true }
  cases.push(row)
}
for (let i = 0; i < 20; i += 1) {
  const [kind, instruction, forgotten, question] = forgetting[i]
  const caseId = `mq-forgetting-${String(i + 1).padStart(2, "0")}`
  const forgottenFact = fixtureFact(`${caseId}-forgotten`, forgotten, "user", `${caseId}-remember-source`, "2025-01-01T00:00:00Z", "2026-02-01T00:00:00Z")
  const tombstone = { factId: forgottenFact.factId, scope: "user", scopeId: null, forgottenAt: "2026-02-01T00:00:00Z", forgetEpoch: 1 }
  const active = fixtureFact(`${caseId}-active-decoy`, "用户今天心情不错", "user", `${caseId}-active-source`)
  const row = caseRow("forgetting", i, "memory-quality-forgetting", instruction, forgotten, question, {
    activeFacts: [active], tombstones: [tombstone], allowedEvidence: [], allowedSourceMessageIds: [],
    forbiddenEvidence: [forgottenFact.factId], forbiddenSourceMessageIds: [forgottenFact.sourceMessageIds[0]],
    expectedFactIds: [], answerFacts: [], expectedAbstention: true, extractGoldFactIds: [active.factId],
    extractForbiddenFactIds: [forgottenFact.factId], answerRubric: "不得复述已遗忘事实；应明确表示没有可用记忆或谨慎拒答",
  })
  const originalStatement = kind === "称呼" ? `请叫我${forgotten}`
    : kind === "偏好" ? `我有这个偏好：${forgotten}` : `我以前有过这段经历：${forgotten}`
  row.fixture.sourceMessages = [
    { id: `${caseId}-remember-source`, role: "user", scope: "user", text: originalStatement, createdAt: forgottenFact.validFrom },
    { id: `${caseId}-old-source`, role: "user", scope: "user", text: instruction, createdAt: "2026-02-01T00:00:00Z" },
    ...row.fixture.sourceMessages.filter(message => ![`${caseId}-remember-source`, `${caseId}-old-source`].includes(message.id)),
    { id: `${caseId}-active-source`, role: "user", scope: "user", text: active.content, createdAt: "2026-02-02T00:00:00Z" },
  ]
  row.fixture.forgottenFacts = [forgottenFact]
  row.gold.forgottenFactId = forgottenFact.factId
  row.gold.forgetEpoch = 1
  row.gold.forbiddenEvidence.push(active.factId) // unrelated facts cannot answer the forgotten question
  row.gold.extractGoldFactIds = [active.factId]
  row.gold.extractForbiddenFactIds.push(forgottenFact.factId)
  cases.push(row)
}

// Negative questions change the actual fixture and gold, never just its variant label.
function noAnswer(row, reason) {
  row.gold.forbiddenEvidence = [...new Set([...row.gold.forbiddenEvidence, ...row.gold.allowedEvidence])]
  row.gold.allowedEvidence = []; row.gold.allowedSourceMessageIds = []
  row.gold.expectedFactIds = []; row.gold.answerFacts = []; row.gold.expectedAbstention = true
  row.gold.answerRubric = reason
}
for (const row of cases.filter(item => item.group !== "forgetting")) {
  const ordinal = Number(row.caseId.split("-").at(-1))
  if (ordinal === 4) {
    row.variant = "无关查询"
    row.question = "你记得我的银行卡开户行是哪一家吗？"
    noAnswer(row, "原始来源没有开户行信息，须表示不知道或询问，不能硬填已有事实")
  }
  if (ordinal === 5 && row.group === "address-preference") {
    row.variant = "假设"
    row.fixture.sourceMessages[0].text = "假设以后我想叫一一，现在还没有决定，这不代表我的称呼偏好"
    const fact = row.fixture.activeFacts.shift()
    row.gold.extractGoldFactIds = []
    row.gold.extractForbiddenFactIds.push(fact.factId)
    noAnswer(row, "假设不能记成用户事实；没有明确偏好时须询问")
  }
  if (ordinal === 8 && row.group === "address-preference") {
    row.variant = "第三方"
    row.fixture.sourceMessages[0].text = "我朋友让大家叫她小岚，这是她的昵称，我还没告诉你我的昵称"
    const fact = row.fixture.activeFacts.shift()
    row.gold.extractGoldFactIds = []
    row.gold.extractForbiddenFactIds.push(fact.factId)
    noAnswer(row, "朋友的昵称不能当作用户昵称")
  }
  if (ordinal === 10 && row.group === "address-preference") {
    row.variant = "跨Card"
    row.fixture.activeFacts[0].scopeId = "card-other"
    row.fixture.sourceMessages[0].cardId = "card-other"
    noAnswer(row, "该称呼仅属另一Card，当前Card不能复述")
  }
  if (ordinal === 12 && row.group === "temporal-episode") {
    row.variant = "时效过期"
    row.fixture.activeFacts[0].validUntil = "2026-10-01T00:00:00Z"
    row.gold.temporal.validUntil = row.fixture.activeFacts[0].validUntil
    noAnswer(row, "有效期结束的事实不能作为当前记忆回答")
  }
  if (ordinal === 19 && row.group === "address-preference") {
    row.variant = "歧义"
    row.fixture.sourceMessages[0].text = "讨论方案可能先列风险，也可能先列选项，我没决定固定顺序"
    const fact = row.fixture.activeFacts.shift()
    row.gold.extractGoldFactIds = []
    row.gold.extractForbiddenFactIds.push(fact.factId)
    noAnswer(row, "未决定的两种选项不能记成确定偏好，应询问澄清")
  }
}

export const MEMORY_QUALITY_CASES = Object.freeze(cases.map(item => Object.freeze(item)))
