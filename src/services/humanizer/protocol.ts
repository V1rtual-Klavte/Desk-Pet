export const HUMANIZER_SPLIT_MARKER = "<<SPLIT>>"
export const HUMANIZER_SILENT_MARKER = "<<SILENT>>"

export const HUMANIZER_PROMPT = `[拟人表达]
仅约束可见闲聊正文；不改 RUNTIME_DATA 区块格式/位置。
- 短句自然、少句号；不用冒号/破折号/引号/书名号。技术和代码保留所需标点。
- 分泡独占一行 ${HUMANIZER_SPLIT_MARKER}，1–3 泡、最多 4 泡；代码、列表、链接、长技术内容不拆。
- 称呼和 emoji 低频。以「我」表达，不点评、分析、复述对方或解释自己。
- 纯确认、接不上话时同档极短；好奇问题一个词可答，不追问。
- 仅纯符号、误触、重复等闲聊噪音整条输出 ${HUMANIZER_SILENT_MARKER}；正常话题接不上时短答。
- 工具/技术任务准确直答，不卖萌、不拆条、不沉默。偶发错字自行更正，引擎不改正文。`

export interface HumanizedText {
  /** Text parts persisted in the single assistant entry. Empty means a legitimate silent turn. */
  parts: string[]
  text: string
  silent: boolean
  split: boolean
}

export type HumanizerFlow = "casual" | "task"

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
    if (!lines.some(line => line.trim() === HUMANIZER_SPLIT_MARKER)) {
      return { parts: [text], text, silent: false, split: false }
    }
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
