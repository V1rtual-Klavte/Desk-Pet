// 2026-10-06 计划提议工具批次（本批刷新）：sourceFiles 变化仅限 src/services/tool/registry.ts
// （registerDefaultTools 增一行 registerPlanTool()：把 propose_plan 纳入内置工具注册）。
// 本契约登记的是 Card 管理域的行为（pc-01..pc-19），工具注册清单的增删不改这些覆盖点；
// 逐点核对实现点仍在、覆盖描述与当前实现一致，未修订覆盖点，sourceHash 按当前源码复算。
// 2026-10-06 提问选择批次（本批刷新）：sourceFiles 变化仅限
// `src/services/tool/registry.ts`（registerDefaultTools 增注册 ask_user 一行；与上一批
// propose_plan 注册同一位置，非人格域行为变化）。各覆盖点逐条核对实现点仍在、描述与当前
// 实现一致；sourceHash 按当前源码复算。
import type { ModuleContract } from "../host/types"

export const personalityCardContract: ModuleContract = {
  module: "personality-card",
  // 2026-10-05 Card 管理域登记：新增 pc-13–pc-19 七个覆盖点，登记
  // test/unit/personality-card/卡片管理.test.ts（L2）的 17 条 caseId ——
  // 新建 / 模板读取 / 重命名 / 编辑保存 / 删除 / 导出 / 导入各成一条；
  // sourceFiles 增加 src/services/personality/card-manage.ts（id→文件名清洗规则
  // safeCardFileName 的唯一真相源在 loader.ts，已在表中，两处共用同一规则），
  // 并按当前源码重刷 sourceHash。复查范围：loader / registry / stages 既有覆盖点
  // （pc-01–pc-12）的行为描述与 caseId 未变，本轮不改动它们的职责边界。
  // 2026-10-04 W11b 事实修正（原生宿主迁移过程记录 §9.4 第 21 条登记项）：pc-09/pc-10 的 commands 键数 13 → 17
  // （13 非 skill + 4 个 /skill 终态键，与 COMMAND_KEYS 及 /skill 加入后的校验一致）；
  // pc-09 的 getSimpleStage 补注第五个值 typing 的取用路径（顶栏，由 humanizer 组件场景覆盖），
  // 并按当前源码重刷 sourceHash。
  // stages-prompt.md 是生成侧的另一半契约：它决定模型输出哪些键，validateStages 决定哪些键算齐。
  // 两边漂移会让新 key 永远取不到 Card 文案，所以提示词纳入 sourceFiles，改动必须触发重审。
  sourceFiles: ["src/services/personality/registry.ts", "src/services/personality/loader.ts", "src/services/personality/card-manage.ts", "src/services/personality/stages-cache.ts", "src/services/personality/stages-file.ts", "src/services/personality/stages-prompt.md", "src/services/tool/registry.ts"],
  sourceHash: "4a1bd43d4f2916687d7f02487fba6413371c35b4b1ca64c2fd01b1bb35e486b9",
  coverage: [
    { id: "pc-01", feature: "Card 解析", description: "importUserCard 把 Card markdown 解析成 PersonalityCard：frontmatter 的 id/name/version 与各区块的 sections 都要落到字段上，source 恒为 runtime，hash 非空", why: "人格卡系统基础", layer: "unit", depth: "shallow", scenarios: ["card-parse"] },
    { id: "pc-02", feature: "注册表的非法切换守卫", description: "switchPersonality(null) 与切换到不存在的人格都返回 ok:false 并给出原因，且失败的切换不得改动 activeId（拒绝必须原子）", why: "人格切换失败回滚是运行时核心约束", layer: "unit", depth: "shallow", scenarios: ["card-registry-guard"] },
    { id: "pc-03", feature: "Card 变量定义解析", description: "variableDefs 解析为 CardVariableDef[]：card 与 interaction 的 scope、type、initial、min/max、updateBy 都要正确", why: "变量池初始化依赖", layer: "unit", depth: "shallow", scenarios: ["card-variable-defs"] },
    { id: "pc-04", feature: "Card 语气指引", description: "「行为进阶」区块以原文存入 sections.whenText —— 它是自然语言语气指引，不是可执行的条件 DSL", why: "语气指引要原样进 prompt，不能被解析成会漂移的结构", layer: "unit", depth: "shallow", scenarios: ["card-when-text"] },
    { id: "pc-06", feature: "切卡后变量池重建", description: "换一套 variableDefs 重建后，上一张卡的变量消失、新变量按 def 初始化，system.activeCardId 同步更新", why: "不同 Card 不同变量", layer: "unit", depth: "deep", scenarios: ["card-switch-resets-pool"] },
    // pc-07「激活 Card 驱动系统提示词」（caseId `card-active-prompt`）已删除：它断言的
    // `getSystemPrompt()` 无生产消费者（实现即 `return card?.sections.roleSetting`，只有 F12 调试对象与
    // barrel 再导出），断言是同一字段与自己的比对，不构成测试 —— W2 Task 3 审视结论（2026-09-29），
    // 场景与 caseId 一并删除。删除后覆盖点 9 个、deep 3 个（当时的 rules 下限未受影响）；
    // 现在的两个下限见文件末尾 —— 它们已按 W0–W7 迁移后的 L4 侧实际值重标定。
    { id: "pc-08", feature: "生产入口下的 Card", description: "sendMessage 走完生产链路后仍有回复、激活 Card 未丢失、activeId 与之一致、会话记录已推进", why: "单元场景只能证明解析正确，证明不了加载好的 Card 真的接进了生产回合", layer: "e2e", depth: "deep", scenarios: ["card-production-turn"] },
    { id: "pc-09", feature: "阶段文案链路", description: "用户可见的阶段与兜底文案只有 Card 一个来源，四个 getter 各自到达取用点：工具类别由 ToolDef.actionCategory 经 actionCategoryOf 解析（对活动注册表的一次按名查找，未知名字与已释放的 MCP 工具同形回 _default —— 技能不再是工具，不进这张表），getStagePrompt 返回当前 Card 的 executing/done/blocked 文案（缺类别/缺缓存回退 _default）；getSimpleStage 覆盖 thinking/planning/error/retry 四条标量（`SimpleStageKey` 实际五个值：第五个 typing 的 Card 文案只走顶栏、组件状态位刻意跳过，其取用与展示由 humanizer 契约的生产入口场景 `humanizer-real-component-reveal`（服务级口径）断言，本场景不重复）；getCommandReply 覆盖 commands 段的全部 17 个键（13 非 skill + `/skill` 的 skillStarted/skillUnknown/skillEmpty/skillDisabled 四个终态键；技能名与「未知 / 无正文 / 被关闭」的诊断事实由命令层作中性明细附在 Card 终态句之后，不写进 key）；getFallbackReply 覆盖 fallbacks 段全部兜底键（数组型按元素命中）。逐 key 比对探针 Card 与中性常量的差异，Card 完全不可用时全部回非空常量 —— 空串会让 UI 静默显示空框", why: "Card 定制的过程语气是产品原则，链路静默变空或退回中性常量时界面看不出差别，全套 Live Test 不容易发现", layer: "integration", depth: "shallow", scenarios: ["stage-prompt-link"] },
    { id: "pc-10", feature: "阶段文案失效判定", description: "阶段文案缓存按 `validateStagesForCard` 判过期，它是三项的合取：cardId 归属 ∧ sourceHash（= SHA-256(角色设定 + 语言风格)，定义点 stageSourceHash）∧ 形态合法（error/retry 是字符串、greetings 非空、commands 的 17 个键（13 非 skill + `/skill` 四个终态键）都是非空字符串、fallbacks 除 llmUnavailable 外键齐且非空、llmUnavailable 是非空数组）；形态检查看**原始文件形态**（不能先 normalize —— 补齐默认值后就分不清旧新模板产物）；因此覆盖缺 greetings、缺 commands 段（旧模板产物根本没有这个键）、commands 有键但缺后加的键或全为空串、fallbacks 缺后加的键四种形状 —— 这是新 key 能被 Card 覆盖的唯一机制：`stageSourceHash` 只哈希角色设定与语言风格、**不覆盖 stages-prompt.md**，模板加键不改 hash。旧文件被判有效会让新场景永远取中性常量；cardVersion 是元数据、不参与判定；只改非生成输入（行为进阶、变量定义）不改变失效键，改角色设定或语言风格必变", why: "失效键必须与生成输入严格同源：宽了会触发多余的生成调用，窄了会把旧文案（或中性常量）继续用在换了人设的 Card 上", layer: "unit", depth: "shallow", scenarios: ["card-stages-staleness"] },
    { id: "pc-11", feature: "切换失败回滚", description: "切换在阶段文案生成不可用时失败，且不产生部分应用：activeId、变量注册表与变量池逐项保持失败前的状态（目标卡与活动卡的变量定义不同，注册表一旦泄漏目标卡 schema 立即可观测；本场景的失败点先于变量池初始化，注册表还原机制本身由 variable-pool 的 vp-16 单独钉住）", why: "VAR-02 的根因：回滚只还原变量池、不还原注册表，失败后后续写入会按目标卡的 schema 校验、Prompt 里的变量元数据整块消失", layer: "integration", depth: "deep", scenarios: ["card-switch-failure-rollback"] },
    { id: "pc-12", feature: "用户给角色起的名字", description: "Card 以 frontmatter nameVar 声明承载用户起的名字的 Card 变量：声明解析进 PersonalityCard.nameVar；registry.activeCardName 优先显示该变量值（起名 / 改名后跟随），变量为空时返回空串交界面兜底而不回落卡标签；未声明 nameVar 的 Card 仍显示卡标签；名字随卡持久化 —— 切走再切回原卡后名字仍在", why: "名字由用户指定是本体卡的设计（理想 trace 第 2 条）：回落卡标签会把产品标签「默认」演成她的名字；名字只进 Card 变量，不进用户记忆", layer: "unit", depth: "deep", scenarios: ["card-name-display", "card-name-var"] },
    { id: "pc-13", feature: "新建 Card", description: "createCard 以运行时 cards/_template.md 为骨架新建卡：除 frontmatter 的 id/name 两行外骨架正文与其余字段逐字保留（不内置硬编码骨架）；id 由显示名经 safeCardFileName 清洗推导，清洗后为空回落 `card`，与已有 id 撞名时加 -2 / -3 后缀避让、绝不覆盖已有卡文件；模板缺失时如实失败并指向「恢复默认资源」，磁盘上不得凭空出现新卡", why: "新建是用户创造角色的入口，骨架必须取用户可编辑的运行时模板而不是内嵌副本；撞名覆盖会静默毁掉用户已有的卡", layer: "unit", depth: "shallow", scenarios: ["card-manage-create", "card-manage-create-collision", "card-manage-create-no-template"] },
    { id: "pc-14", feature: "新建模板读取", description: "readCardTemplate 返回运行时 cards/_template.md 的全文（用户改过就读改动后的那份，不是随仓副本），新建与「恢复模板」入口共用这一份唯一正文来源；模板缺失时如实抛错，错误文案带「恢复默认资源」的找回入口", why: "内嵌副本或读取随仓副本会让用户对模板的编辑静默失效，模板面板展示什么就必须是新建真正用的什么", layer: "unit", depth: "shallow", scenarios: ["card-manage-template-read", "card-manage-template-missing"] },
    { id: "pc-15", feature: "重命名 Card", description: "renameCard 只替换 frontmatter 块内的 name 行：id、文件名与正文（含正文里以 `name:` 开头的同名行）一字不动，显示名更新后注册表同步；显示名 trim 后为空则拒绝且文件一个字节不动 —— 改名不换身份，stages 与变量归属都挂在 id 上", why: "改名牵连文件名 / 阶段文案 / 变量任何一处错位都会丢用户的既有状态；正文里的同名行被顺手改掉是静默的正文损坏", layer: "unit", depth: "shallow", scenarios: ["card-manage-rename", "card-manage-rename-blank"] },
    { id: "pc-16", feature: "编辑保存 Card 正文", description: "saveCardText 校验先行、落盘在后：解析不出有效 id、或解析出的 id 与目标卡不一致（id 就是文件名，改 id 等于换卡，阶段文案与变量会按 id 全部错位）都拒绝且文件一个字节不动；合法内容按原文件名写回并重载注册表，回执说明「下一个回合生效」；cardId 为 null 表示当前激活卡，无激活卡时拒绝而不是猜一张来写", why: "id 是阶段文案与变量状态的归属键；写坏一张卡等于用户丢失角色定义，拒绝路径必须保证磁盘零改动", layer: "unit", depth: "shallow", scenarios: ["card-manage-save", "card-manage-save-reject", "card-manage-save-active"] },
    { id: "pc-17", feature: "删除 Card", description: "deleteCard 把卡文件与 stages 文件两份一起删：激活卡拒删（须先切换），拒绝时两份文件与注册表原封不动；stages 文件不存在（从未激活过）视为已清理不是失败，卡文件不存在则如实失败、不把「什么都没删」伪装成成功；删除成功后注册表移除该卡、激活状态不受影响", why: "删卡必须连阶段文案缓存一起清理，留下孤儿 stages 会让同 id 的下一张卡继承旧文案；删掉激活卡会让 activeId 悬空", layer: "unit", depth: "deep", scenarios: ["card-manage-delete", "card-manage-delete-active", "card-manage-delete-missing"] },
    { id: "pc-18", feature: "导出 Card", description: "exportCardText 返回 Card 的 markdown 原文（与落盘内容逐字一致），未知 id 返回 null 而不抛错 —— 「卡不存在」是调用方要处理的正常分支", why: "导出必须是可再导入的原样文本；对未知 id 抛错会把界面的正常分支演成故障", layer: "unit", depth: "shallow", scenarios: ["card-manage-export"] },
    { id: "pc-19", feature: "导入 Card", description: "importCardText 以「能解析出有效 id」为唯一准入门槛：无 frontmatter 或 id 为空的内容整份拒绝且不落盘（目录与注册表逐项不变）；合法内容按 safeCardFileName 落 cards/{safeName(id)}.md、正文原样保存，id 含空格一类字符按命名规则清洗到文件名；同名导入按「以这份内容为准」覆盖，回执必须说清是覆盖而不是新增", why: "导入是外部内容进入 Card 目录的唯一入口，校验先行才能不写坏磁盘；覆盖不说清会让用户不知道自己的卡被换掉了", layer: "unit", depth: "shallow", scenarios: ["card-manage-import", "card-manage-import-invalid", "card-manage-import-safe-name"] },
  ],
  // W0–W7 把本契约迁出 L4 的场景按 L4 侧当前值重标定：门槛=当前 rules 声明值
  // （pc-08 `card-production-turn` 留在 L4），只缩不放（数字由 checker 报错提供）；
  // 跨层完整性由 checkLayerCoverage 负责。事实登记：本契约 L4 侧已无带 boundary/error
  // tag 的场景（pc-11 `card-switch-failure-rollback` 等原属的场景已迁 L3），
  // L4仅核验生产Card回合；boundary/error由已迁L3的切卡失败/回滚用例承担，
  // 不要求正常生产回合假贴错误标签。跨层MISSING/ORPHAN门禁保持开启。
  rules: { minScenarios: 1, minDeepScenarios: 1, requireBoundary: false, requireErrorPath: false },
}
