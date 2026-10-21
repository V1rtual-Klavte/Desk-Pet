export const HUMANIZER_SPLIT_MARKER = "<<SPLIT>>"
export const HUMANIZER_SILENT_MARKER = "<<SILENT>>"
const LITERAL_SPLIT_MARKER = "\u0000deskpet-literal-split\u0000"

/**
 * 全局拟人表达块。**只管形式与说话方式，不管人设**——「我是谁、我喜欢什么、我的口头禅」
 * 由当前 Card 自己声明（2026-10-08 用户裁定：职责分离，换 Card 就换口气，本块一字不改）。
 *
 * 三条纪律的来源与教训（改这段前先读）：
 * - 形式纪律（分泡 / markdown / 低频称呼）来自本体卡理想稿「零、规矩」第 6 条；
 *   标点交给模型自然生成，代码只做收口：分号和顿号换成空格，问号/叹号保留
 *   （2026-10-20 用户裁定：这两种分隔号像书面语，?! 是聊天语气的一部分）。
 * - 说话纪律（以我为主 / 不点评 / 不解释自己）来自第 7 条。
 * - 「讲知识也别讲课」是 2026-10-08 实机栽出来的：用户开了拟人化问「讲讲 feign 远程调用」，
 *   拿到的是 `## Feign 是什么` + 加粗术语 +「不是 Dubbo 那种二进制 RPC」的**课程笔记**。
 *   根因不是路由（那轮没用工具，flow 本就是 casual），是提示词只说了抽象的「不解释自己」，
 *   模型不认为「讲解一个概念」算解释；且**全文没提 markdown**。所以这里把翻车形态**点名禁用**：
 *   对模型来说「不要像那样写」远比「不要解释」有力。
 */
export const HUMANIZER_PROMPT = `[拟人表达]
仅约束可见闲聊正文；不改 RUNTIME_DATA 区块格式/位置。

内容优先（高于以下所有形式规则）：
- 准确回答，保留答案必需的事实、用户限制、条件、结论与必要步骤；不能为了简短或口语删掉这些内容。
- 先保证回答完整，再尽量自然简洁；形式与内容冲突时服从内容。

历史消息仅用于理解：
- 对话事实与上下文、用户偏好与明确约定、当前话题及语义连续性。
- 不得把历史消息的语言形式当作回复风格示例；尤其不得模仿历史 Assistant 消息里缺标点、连续短句或用换行代替断句的写法。

说话方式：
-【硬性】可见正文必须带标点：句子之间用逗号，句末用句号；不许用直接连写代替标点；少用括号。
- 像朋友聊天：用自己的口气，不写客服腔、不写文档腔。
- 不写 markdown 标题与加粗；步骤清单可以保留，但不套标题、不当文档写。
- 代码块整块保留，前后的说话照常写。
- 称呼低频。
- 分点说明时，每点前输出 ${HUMANIZER_SPLIT_MARKER}；编号用 1、2、3或 一、二、三，编号后面不要用点。
- 可见正文的句子之间必须有标点或空格，不许整段连成一串。

说话内容：
- 以「我」为主，可少量加自己的观点、喜好、小道理，不点评对方、不分析对方状态、不补充对方没说的事。
- 不解释自己的话，不加自我注解的尾巴。
- 闲聊不是咨询：用户没要方案时，先给态度，再给一句具体的；不列步骤、不写三点建议、不做总结段。
  用户明确要方案或步骤时，可以分条说，但每条仍然短，不写标题和总结段。
- 讲知识也像朋友聊天，不像讲课：不铺无关背景、不做总结段，但不能删掉回答所必需的信息。
- 接得住没头没尾，同频翻回去。

长度与沉默：
- 闲聊要短：日常、情绪、近况这类，40 字以内；技术、知识、资料、查询类问题才需要完整答案。
- 纯确认、接不上话时同档极短；好奇问题一个词可答，不追问。
- 仅纯符号、误触、重复等闲聊噪音整条输出 ${HUMANIZER_SILENT_MARKER}；正常话题接不上时短答。

本轮真的调了工具或执行了计划步骤时：
- 结果要准确、该说清的步骤不能省，这两条优先于形式纪律；但语气照旧，不切成文档腔、不突然变得一本正经。
- 偶发错字自行更正，引擎不改正文。`

export interface HumanizedText {
  /** Text parts persisted in the single assistant entry. Empty means a legitimate silent turn. */
  parts: string[]
  text: string
  silent: boolean
  split: boolean
}

export type HumanizerFlow = "casual" | "task"

/**
 * 按空行分段，但**围栏代码块内部的空行不算断点** —— 技术内容不拆散，而夹着代码的那段
 * 说话照样各自成泡（2026-10-08 实机：讲解带一段代码时整条一大块，用户要的是「像人发
 * 消息一样分成几条」。原实现是「含 ``` 就整条不拆」，一刀切把代码前后的说话也拦住了）。
 */
/**
 * 模型没按提示词分泡时的确定性兜底：casual 长段按行/句读切成多条。
 * 不设总条数上限，只限制单条别太长（短行可以并成一条）；代码围栏整段跳过。
 */
const CASUAL_FALLBACK_MIN_CHARS = 30
/// 单泡目标长度（2026-10-21 用户口径：30 → 24 字；2026-10-20 裁定不再 15 字硬切，
/// 「浮层」「老实」会被劈成两半）。兜底只按句读、逗号和空白等自然边界切，短片段按
/// 目标长度合并；没有安全边界时宁可留长泡，也不在词中间下刀。技术/中英混排同样按
/// 空白边界切，英文词、代码标识与数字保持完整。
const CASUAL_BUBBLE_TARGET_CHARS = 24
/// 短片段并泡时的上限：只为了让「另外」「CHM 两个都不允许」这类短句不要单独成泡，
/// 允许略微超出目标，但不能把两条完整长句硬凑成一大泡。
/// 2026-10-21 用户口径：上限 50 → 38（38–40 字的一条仍被视为「一大段」）。
const CASUAL_BUBBLE_MAX_CHARS = 38
/// 约 60% 的回复走更细的切分（2026-10-21 用户规则：细切可以再多，0.6 概率切得更碎）。
/// 用文本哈希决定，避免同一句每次刷新气泡数都变，也让单测可控。
const CASUAL_FINE_MIN_CHARS = 15
const CASUAL_FINE_TARGET_CHARS = 15
const CASUAL_FINE_MAX_CHARS = 25

interface CasualLimits { min: number; target: number; max: number; allPunctuation: boolean }
const CASUAL_NORMAL_LIMITS: CasualLimits = { min: CASUAL_FALLBACK_MIN_CHARS, target: CASUAL_BUBBLE_TARGET_CHARS, max: CASUAL_BUBBLE_MAX_CHARS, allPunctuation: false }
const CASUAL_FINE_LIMITS: CasualLimits = { min: CASUAL_FINE_MIN_CHARS, target: CASUAL_FINE_TARGET_CHARS, max: CASUAL_FINE_MAX_CHARS, allPunctuation: true }
let casualLimits: CasualLimits = CASUAL_NORMAL_LIMITS
/// 普通档只按句末标点切；细切档把所有全角标点都当边界（2026-10-20 用户规则：
/// 随机细切可在所有符号分泡，该保留的 `！？` 仍保留；ASCII `. , :` 不切，保护技术 token）。
const NORMAL_SENTENCE_PATTERN = /[^。！？!?；;]+[。！？!?；;]*|[。！？!?；;]+/gu
const FINE_SENTENCE_PATTERN = /[^。！？!?；;：，、…—–”’」』》〉）】]+[。！？!?；;：，、…—–”’」』》〉）】]*|[。！？!?；;：，、…—–”’」』》〉）】]+/gu
/// FNV-1a；只用来决定粒度，不做安全用途。
function textHash(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/// 约 60% 的回复走细切；同一句稳定，不同句之间随机分布。
function shouldUseFineBubbles(text: string): boolean {
  return textHash(text) % 10 < 6
}

/// 装饰性标点（破折号 / 省略号 / 中文引号 / 书名号）：代码侧统一去掉。
/// 提示词不限制标点（限制会把句子黏成一串），这些「号」由代码清理；
/// 围栏代码块与行内代码原样保留。
const DECOR_PUNCTUATION = /[—–―…“”‘’「」『』《》〈〉]/gu
/// 分号、顿号、冒号在聊天里像书面语：代码侧换成空格（2026-10-20 用户裁定）。
/// 顿号不参与分泡边界，等分泡完成后再替换，避免在切分阶段被吃掉；
/// 冒号参与长句分泡（见 splitByCommas），ASCII `:` 保留给 URL/时间/对象字面量。
/// 问号/叹号不在此列 —— 它们保留。围栏代码块与行内代码原样保留。
const PROSE_SEPARATOR = /[；;、：]/gu
/// 列表项起始：阿拉伯数字/中文数字/圈号/项目符号。数字后的点必须不是小数点
/// （`1.5` 不算列表），后面可以是空格或直接接正文。
/// 列表起始只认**带分隔符**的编号（`1.` `1、`）与项目符号：裸数字 + 空格会把
/// 「10 月 15 号发的」这类句子误判成列表项（2026-10-21 实测），不再接受。
const LIST_MARKER_START = /^(?:[（(]?\d{1,2}(?:[）)、]|\.(?!\d))|[一二三四五六七八九十]{1,3}[、.]|[①-⑳]|[-*•]\s+)\s*/u
/// 逗号随机换空格的比例（40%，与细切概率同档）；按文本+位置哈希决定，同一句稳定不抖动。
const COMMA_TO_SPACE_PERCENT = 40
/// casual 气泡尾部不挂句号逗号分号；问号/叹号保留（2026-10-20 用户裁定）。
/// ``` 等代码标记不在集合内。
const CASUAL_TRAILING_PUNCTUATION = /[。，,；;：:、…—–“”‘’「」『』《》〈〉]+$/u
/// 模型有时把逗号留在下一行行首（2026-10-20 实机），气泡开头同样不能挂句读；
/// 问号/叹号保留。
const CASUAL_LEADING_PUNCTUATION = /^[。，,；;：:、…—–“”‘’「」『』《》〈〉]+/u

/// 分号、顿号换空格；逗号按文本+位置哈希随机换一部分（约 30%），
/// 同一句稳定不抖动。围栏与行内代码在调用方已排除。
function stripProseSeparators(segment: string): string {
  const text = segment
    .replace(DECOR_PUNCTUATION, "")
    .replace(PROSE_SEPARATOR, " ")
    // 列表编号后的点/括号换成空格，避免气泡以「1.」开头被渲染成 markdown 列表。
    .replace(/^[（(]?(\d{1,2})(?:[）)、]|\.(?!\d))\s*/u, "$1 ")
    .replace(/^([一二三四五六七八九十]{1,3})[、.]\s*/u, "$1 ")
    .replace(/^[-*•]\s+/u, "")
  let output = ""
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!
    if (ch === "，" && textHash(`${segment}#${index}`) % 100 < COMMA_TO_SPACE_PERCENT) {
      output += " "
    } else {
      output += ch
    }
  }
  return output.replace(/[ \t]{2,}/gu, " ")
}

/** 去掉装饰标点；围栏代码块与行内代码（成对反引号）原样保留。 */
function stripDecorPunctuation(text: string): string {
  let inFence = false
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    return line
      .split(/(`[^`]*`)/u)
      .map((segment, index) => (index % 2 === 1 ? segment : stripProseSeparators(segment)))
      .join("")
  }).join("\n")
}

function splitByCommas(text: string): string[] {
  const pieces: string[] = []
  let current = ""
  let inInline = false
  for (const ch of text) {
    if (ch === "`") inInline = !inInline
    current += ch
    if (!inInline && (ch === "，" || ch === "," || ch === "；" || ch === ";" || ch === "：")) {
      if (current.trim()) pieces.push(current.trim())
      current = ""
    }
  }
  if (current.trim()) pieces.push(current.trim())
  return pieces
}

function splitSentenceOrComma(text: string): string[] {
  // 连续的 ?! 是一个边界，别把「？！」拆成两泡（2026-10-20 用户规则）。
  // 用 match 吃掉整段句末标点，避免 lookbehind 在 ?! 的每个字符后都切一刀。
  const sentences = (text.match(casualLimits.allPunctuation ? FINE_SENTENCE_PATTERN : NORMAL_SENTENCE_PATTERN) ?? [text])
    .map(part => part.trim()).filter(Boolean)
  // 只按标点切；空格不再当分泡边界（2026-10-20 用户裁定：
  // 「JDK 8」这类技术词不能被空格切开，空格只留在泡内当观感）。
  return (sentences.length > 1 ? sentences : [text])
    .flatMap(segment => splitByCommas(segment))
}

/// 只有「中文 中文」之间的空格才是分泡边界（2026-10-21 用户口径）：
/// 中文与英文/数字/行内代码相邻的空格不切，避免把 `LoadBalancer 那边把
/// `spring...` 显式写成 false` 这类句子切成碎泡。
const SPACE_BETWEEN_HAN = /(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu

/**
 * 无标点长段兜底（2026-10-21 用户口径）：模型偶尔整段用空格断句，句读切分
 * 一条边界都找不到，整条就挤成一个气泡。只在两个汉字之间的空格切；
 * 中文与拉丁字母/数字相邻的空格不切（「JDK 8」「VS Code」这类技术词保持完整，
 * 行内代码与前后中文也不拆开）。
 */
function splitLongByHanSpaces(text: string): string[] {
  if (text.length <= casualLimits.max) return [text]
  const chunks = text.split(SPACE_BETWEEN_HAN).map(chunk => chunk.trim()).filter(Boolean)
  if (chunks.length <= 1) return [text]
  const pieces: string[] = []
  let current = ""
  for (const chunk of chunks) {
    if (!current) { current = chunk; continue }
    if (current.length + chunk.length + 1 <= casualLimits.target) {
      current += ` ${chunk}`
      continue
    }
    pieces.push(current)
    current = chunk
  }
  if (current) pieces.push(current)
  return pieces.length > 1 ? pieces : [text]
}

function splitLongCasual(text: string): string[] {
  const trimmed = text.trim()
  const lines = trimmed.split("\n").map(line => line.trim()).filter(Boolean)
  // 代码围栏整块不拆；短句默认不拆，但多行列表即使短也按项分开。
  if (trimmed.includes("```")) return [trimmed]
  if (trimmed.length <= casualLimits.min && !lines.some(line => LIST_MARKER_START.test(line))) return [trimmed]
  // 句读切不出边界的长段再走「中文 中文」空格兜底；短行不进兜底，避免无谓拆泡。
  const splitLine = (line: string): string[] => {
    const byPunctuation = line.length > casualLimits.target ? splitSentenceOrComma(line) : [line]
    // 标点切完不等于切够了：剩下的片段仍可能远超单泡上限（2026-10-21 实机：
    // 「…不多。写的时候…」前半句带句号切开后，后半句 75 字没有逗号、原样留成一大泡）。
    // 每个仍超上限的片段再走一次中文空格兜底。
    return byPunctuation.flatMap(piece =>
      piece.length > casualLimits.max ? splitLongByHanSpaces(piece) : [piece])
  }
  const pieces = lines.length > 1 ? lines.flatMap(splitLine) : splitLine(trimmed)
  if (pieces.length <= 1) return [trimmed]
  // 2026-10-21 用户口径：先去掉并泡，切出几段就是几泡（不再按目标长度合并）。
  return pieces
}

/**
 * 一个 part 就是一个气泡，泡内普通文本不换行（2026-10-20 实机：模型按句一行输出
 * 「查了一下，/最新是 1.3.0，/…」，兜底并泡用换行连接，气泡里就显示成多行）。
 * 围栏代码块整块保留原始换行 —— 代码不能被合成一行。
 */
function joinProseLines(lines: string[]): string {
  let result = ""
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (!result) { result = line; continue }
    // 中文标点结尾直接相连；其余情况（中英边界、两组中文行）补一个空格，
    // 免得并泡时粘成「先看这段用 createModels」这样的一串。
    const cjkPunctEnd = /[，。！？；：、]$/u.test(result)
    const asciiBoundary = /[A-Za-z0-9`)\]]$/u.test(result) || /^[A-Za-z0-9(`[]/u.test(line)
    const bothCjk = /[㐀-䶿一-鿿]$/u.test(result) && /^[㐀-䶿一-鿿]/u.test(line)
    result += !cjkPunctEnd && (asciiBoundary || bothCjk) ? ` ${line}` : line
  }
  return result
}

function flattenBubbleText(text: string): string {
  const lines = text.split("\n")
  if (!lines.some(line => /^\s*```/.test(line))) return joinProseLines(lines)
  const output: string[] = []
  let prose: string[] = []
  let inFence = false
  const flushProse = () => {
    const merged = joinProseLines(prose)
    if (merged) output.push(merged)
    prose = []
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) flushProse()
      output.push(line)
      inFence = !inFence
    } else if (inFence) {
      output.push(line)
    } else {
      prose.push(line)
    }
  }
  flushProse()
  return output.join("\n")
}

/// casual 气泡最终收口：去装饰标点 → 补 CJK/英文边界空格 → 泡内合行 → 去行首/行尾标点。
function finalizeCasualPiece(piece: string): string {
  return flattenBubbleText(stripDecorPunctuation(piece))
    .replace(CASUAL_LEADING_PUNCTUATION, "")
    .replace(CASUAL_TRAILING_PUNCTUATION, "")
    .trim()
}

function splitByParagraphs(text: string): string[] {
  const pieces: string[] = []
  let current: string[] = []
  let inFence = false
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && line.trim() === "") {
      const piece = current.join("\n").trim()
      if (piece) pieces.push(piece)
      current = []
      continue
    }
    current.push(line)
  }
  const tail = current.join("\n").trim()
  if (tail) pieces.push(tail)
  return pieces
}

/** Normalize model-emitted delimiter tokens before flow-specific splitting.
 * The prompt asks for a standalone line, but models sometimes attach it to prose
 * or vary whitespace/case. Treat that token as control syntax outside fenced code.
 */
function normalizeSplitMarkers(text: string): string {
  const normalizeLine = (line: string): string => {
    if (/^\s*<<\s*SPLIT\s*>>\s*$/iu.test(line)) return HUMANIZER_SPLIT_MARKER
    let output = ""
    let index = 0
    while (index < line.length) {
      if (line[index] === "`") {
        let tickEnd = index + 1
        while (line[tickEnd] === "`") tickEnd += 1
        const delimiter = line.slice(index, tickEnd)
        const close = line.indexOf(delimiter, tickEnd)
        if (close >= 0) {
          output += line.slice(index, close + delimiter.length).replaceAll(HUMANIZER_SPLIT_MARKER, LITERAL_SPLIT_MARKER)
          index = close + delimiter.length
          continue
        }
        output += delimiter
        index = tickEnd
        continue
      }
      const marker = line.slice(index).match(/^<<\s*SPLIT\s*>>/iu)?.[0]
      if (marker) {
        output = output.replace(/\s+$/u, "")
        output += `\n${HUMANIZER_SPLIT_MARKER}\n`
        index += marker.length
        while (/\s/u.test(line[index] ?? "")) index += 1
        continue
      }
      output += line[index]
      index += 1
    }
    return output
  }
  let inFence = false
  return text.split("\n").map(line => {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) return line.replaceAll(HUMANIZER_SPLIT_MARKER, LITERAL_SPLIT_MARKER)
    return normalizeLine(line)
  }).join("\n")
}

/**
 * 请求视图用的历史原文：只去掉控制标记，保留模型原始标点与换行，不剥标点、不切泡。
 *
 * 2026-10-21 实机：历史里只留拟人化后的短泡，会让模型把自己的历史当成无标点短句范例，
 * 连续产出无法切分的连写长串。原文进请求、拟人化泡只给展示侧看。
 */
export function humanizerRawVisibleText(input: string): string {
  const text = normalizeSplitMarkers(input.replace(/\r\n/g, "\n"))
  return text
    .split("\n")
    .filter(line => line.trim() !== HUMANIZER_SPLIT_MARKER)
    .join("\n")
    .replaceAll(HUMANIZER_SPLIT_MARKER, "")
    .replaceAll(HUMANIZER_SILENT_MARKER, "")
    .replaceAll(LITERAL_SPLIT_MARKER, HUMANIZER_SPLIT_MARKER)
    .trim()
}

export interface HumanizerOptions {
  /** auto: 约 60% 文本走细切；normal/fine 仅供测试固定粒度。 */
  split?: "auto" | "normal" | "fine"
}

/**
 * Interpret protocol markers after RUNTIME_DATA has already been removed.
 * Markers are recognized only when the caller has frozen the feature as enabled.
 */
export function transformHumanizerText(
  input: string,
  flow: HumanizerFlow = "casual",
  options: HumanizerOptions = {},
): HumanizedText {
  const text = normalizeSplitMarkers(input.replace(/\r\n/g, "\n"))
  // 同一段文本的粒度稳定（哈希决定），不同文本约 60% 走细切；
  // 测试可用 options.split 固定成 normal/fine。
  casualLimits = flow === "casual" &&
    (options.split === "fine" || (options.split !== "normal" && shouldUseFineBubbles(text)))
    ? CASUAL_FINE_LIMITS
    : CASUAL_NORMAL_LIMITS
  const restoreLiteralMarkers = (value: string): string => value.replaceAll(LITERAL_SPLIT_MARKER, HUMANIZER_SPLIT_MARKER)
  if (text.trim() === HUMANIZER_SILENT_MARKER) {
    return flow === "casual"
      ? { parts: [], text: "", silent: true, split: false }
      : { parts: [], text: "", silent: false, split: false }
  }

  let pieces: string[]
  let split = false
  if (flow === "casual") {
    const lines = text.split("\n")
    if (lines.some(line => line.trim() === HUMANIZER_SPLIT_MARKER)) {
      pieces = []
      let current: string[] = []
      for (const line of lines) {
        if (line.trim() === HUMANIZER_SPLIT_MARKER) {
          split = true
          pieces.push(current.join("\n").trim())
          current = []
        } else {
          current.push(line)
        }
      }
      pieces.push(current.join("\n").trim())
      // 模型已经给了泡，但单泡仍长时再按句读细切；短泡原样保留。
      // 标记段内部还可能夹着空行与代码围栏：先按空行分段（围栏内空行不算断点），
      // 再逐段细切，保证代码块前后的说话各自成泡（2026-10-21 实机：带 <<SPLIT>>
      // 的技术回答里，第四点、配置说明和 YAML 块被 `includes("```")` 整段留成一泡）。
      pieces = pieces.flatMap(piece =>
        splitByParagraphs(piece).flatMap(paragraph => splitLongCasual(paragraph)))
    } else {
      // 空行分段兜底（2026-10-05 用户规则「开启拟人化后回车消息要分成几条」）：
      // 模型没发 SPLIT 标记、用空行分段时按段分泡，每个空行段独立成一条气泡；
      // 单个换行（同一段内的折行）不分。**围栏代码块整块保留**（块内空行不是断点），
      // 但它前后的说话照常分泡 —— 见 `splitByParagraphs` 的注释。
      const paragraphs = splitByParagraphs(text)
      if (paragraphs.length <= 1) {
        const fallback = splitLongCasual(text)
        if (fallback.length <= 1) {
          const restored = finalizeCasualPiece(restoreLiteralMarkers(text))
          return { parts: [restored], text: restored, silent: false, split: false }
        }
        split = true
        pieces = fallback
      } else {
        split = true
        // 每个空行段再按句读细切：长段不整块发，短段保持一条。
        pieces = paragraphs.flatMap(paragraph => splitLongCasual(paragraph))
      }
    }
  } else {
    // Task replies remain one message even if the model emits a stray split marker.
    const lines = text.split("\n")
    const body = lines.some(line => line.trim() === HUMANIZER_SPLIT_MARKER)
      ? lines.filter(line => line.trim() !== HUMANIZER_SPLIT_MARKER).join("\n").trim()
      : text
    // 任务结果同样按气泡规则收口（2026-10-20 实机：task 流把模型的逐行输出原样
    // 送进气泡，每行末尾挂着逗号）：段内普通文本合行，段间（空行）保留；
    // 段尾的逗号/分号去掉，句号保留（任务结果需要完整句子）。代码块不减行。
    pieces = [splitByParagraphs(body)
      .map(paragraph => stripDecorPunctuation(flattenBubbleText(paragraph))
        .replace(/^[，,；;]+/u, "")
        .replace(/[，,；;]\s*$/u, "")
        .trim())
      .filter(Boolean)
      .join("\n")]
  }

  pieces = pieces.filter(Boolean).map(restoreLiteralMarkers)
  // casual 气泡去掉末尾句读：像微信一条条发，不在每条末尾挂「，」「。」「；」。
  // 泡内普通文本归并为一行，一个气泡不显示多行；围栏代码块保留换行。
  // task 流保留原标点（任务结果需要完整句子）。代码内容在分泡前已保护。
  if (flow === "casual") {
    pieces = pieces.map(piece => finalizeCasualPiece(piece)).filter(Boolean)
  }
  if (pieces.length === 0) return { parts: [], text: "", silent: false, split }
  return { parts: pieces, text: pieces.join("\n"), silent: false, split }
}

export interface SilenceResolution {
  silent: boolean
  text: string
  parts: string[]
  rejected: boolean
}

/** Per-session consecutive-silence guard shared by normal and proactive replies. */
export class SilenceGuard {
  private readonly consecutive = new Map<string, number>()

  seed(sessionId: string, committedConsecutiveCount: number): void {
    if (committedConsecutiveCount > 0) this.consecutive.set(sessionId, committedConsecutiveCount)
    else this.consecutive.delete(sessionId)
  }

  resolve(sessionId: string, result: HumanizedText, rejectedSilenceReply: string): SilenceResolution {
    if (result.silent) {
      const count = this.consecutive.get(sessionId) ?? 0
      if (count === 0) {
        this.consecutive.set(sessionId, 1)
        return { silent: true, text: "", parts: [], rejected: false }
      }
      this.consecutive.delete(sessionId)
      return { silent: false, text: rejectedSilenceReply, parts: [rejectedSilenceReply], rejected: true }
    }
    this.consecutive.delete(sessionId)
    return { silent: false, text: result.text, parts: result.parts, rejected: false }
  }

  clear(sessionId?: string): void {
    if (sessionId) this.consecutive.delete(sessionId)
    else this.consecutive.clear()
  }
}

export const humanizerSilenceGuard = new SilenceGuard()
