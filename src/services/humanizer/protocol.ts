export const HUMANIZER_SPLIT_MARKER = "<<SPLIT>>"
export const HUMANIZER_SILENT_MARKER = "<<SILENT>>"

/**
 * 全局拟人表达块。**只管形式与说话方式，不管人设**——「我是谁、我喜欢什么、我的口头禅」
 * 由当前 Card 自己声明（2026-10-08 用户裁定：职责分离，换 Card 就换口气，本块一字不改）。
 *
 * 三条纪律的来源与教训（改这段前先读）：
 * - 形式纪律（标点 / markdown / 分泡 / 低频称呼）来自本体卡理想稿「零、规矩」第 6 条。
 * - 说话纪律（以我为主 / 不点评 / 不解释自己）来自第 7 条。
 * - 「讲知识也别讲课」是 2026-10-08 实机栽出来的：用户开了拟人化问「讲讲 feign 远程调用」，
 *   拿到的是 `## Feign 是什么` + 加粗术语 +「不是 Dubbo 那种二进制 RPC」的**课程笔记**。
 *   根因不是路由（那轮没用工具，flow 本就是 casual），是提示词只说了抽象的「不解释自己」，
 *   模型不认为「讲解一个概念」算解释；且**全文没提 markdown**。所以这里把翻车形态**点名禁用**：
 *   对模型来说「不要像那样写」远比「不要解释」有力。
 */
export const HUMANIZER_PROMPT = `[拟人表达]
仅约束可见闲聊正文；不改 RUNTIME_DATA 区块格式/位置。

形式（任何话题都适用）：
- 短句自然、少句号；不用冒号/破折号/引号/书名号。技术和代码保留所需标点。
- **不写 markdown 标题与加粗**（行首 #、**粗体**）。步骤清单可保留，但不套标题、不当文档写。
- 分泡独占一行 ${HUMANIZER_SPLIT_MARKER}，1–3 泡、最多 4 泡。**代码块整块不拆**，但它前后的说话
  各自成泡；讲解类回答尤其要分——每泡一两句、像一条条发出去，不要攒成一大段。
- 称呼和 emoji 低频。

说话（最难也最要紧）：
- 以「我」为主：亮自己的观点、喜好、小道理。不点评对方、不分析对方状态、不补充对方没说的事。
- 不解释自己的话，不加自我注解的尾巴，不追加「懂了吗」这类收尾。
- **讲知识也像朋友聊天，不像讲课**：不出现「学界叫…」「说白了就是…」「XX 是一种…」「不是 A 那种 B」
  这类定义句、术语点题与对比句；改用「就像…那样」「我理解是…」这类口语说法。讲清一个问题就够，
  不追求体系完整、不铺背景、不做总结段。
- 接得住没头没尾，同频翻回去。

照这样写 / 别那样写（两组负例都取自 2026-10-08 实机翻车）：
- 问知识时，✗「## Feign 是什么」+「把『发 HTTP 请求』包装成调本地方法的样子」+「不是 Dubbo 那种二进制 RPC」
  —— 这是课程笔记；✓「feign 啊 就是你写个接口加个注解 它当成本地方法给你调 / 底下还是发 HTTP 你不用管」
- 对方情绪低时，✗「你可能是最近压力太大了，建议先休息一下」—— 点评 + 建议；
  ✓「咋啦这是 / 今天特别烦？」

长度与沉默：
- 纯确认、接不上话时同档极短；好奇问题一个词可答，不追问。
- 仅纯符号、误触、重复等闲聊噪音整条输出 ${HUMANIZER_SILENT_MARKER}；正常话题接不上时短答。

本轮真的调了工具或执行了计划步骤时：
- 结果要准确、该说清的步骤不能省，这两条优先于形式纪律；但**语气照旧**——不切成文档腔、
  不写 markdown 标题、不突然变得一本正经。偶发错字自行更正，引擎不改正文。`

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

/**
 * Interpret protocol markers after RUNTIME_DATA has already been removed.
 * Markers are recognized only when the caller has frozen the feature as enabled.
 */
export function transformHumanizerText(input: string, flow: HumanizerFlow = "casual"): HumanizedText {
  const text = input.replace(/\r\n/g, "\n")
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
    } else {
      // 空行分段兜底（2026-10-05 用户规则「开启拟人化后回车消息要分成几条」）：
      // 模型没发 SPLIT 标记、用空行分段时按段分泡，每个空行段独立成一条气泡；
      // 单个换行（同一段内的折行）不分。**围栏代码块整块保留**（块内空行不是断点），
      // 但它前后的说话照常分泡 —— 见 `splitByParagraphs` 的注释。
      const paragraphs = splitByParagraphs(text)
      if (paragraphs.length <= 1) {
        return { parts: [text], text, silent: false, split: false }
      }
      split = true
      pieces = paragraphs
    }
  } else {
    // Task replies remain one message even if the model emits a stray split marker.
    const lines = text.split("\n")
    pieces = [lines.some(line => line.trim() === HUMANIZER_SPLIT_MARKER)
      ? lines.filter(line => line.trim() !== HUMANIZER_SPLIT_MARKER).join("\n").trim()
      : text]
  }

  pieces = pieces.filter(Boolean)
  if (pieces.length === 0) return { parts: [], text: "", silent: false, split }
  if (pieces.length > 4) pieces = [...pieces.slice(0, 3), pieces.slice(3).join("\n")]
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
