// 流式正文的瞬时展示过滤（H-3，方案 §6）。
//
// - 只处理 text_delta：thinking 在事件层就被丢弃，不进入这里；
// - 跨分片识别 <RUNTIME_DATA> 的起始标签，标签之后（含标签本身）不进入瞬时展示；
// - 缓冲可能是标签前缀的尾部（如 "<RUNTIME"），等后续分片到齐再判定；
// - 只服务瞬时展示，不提交正文、不写盘。

const RUNTIME_DATA_OPEN = "<RUNTIME_DATA>"

/** 逐分片喂入模型正文增量，返回本次可以展示的文本。 */
export class RuntimeDataStreamFilter {
  private pending = ""
  private stopped = false

  push(delta: string): string {
    if (!delta || this.stopped) return ""
    this.pending += delta
    const index = this.pending.toUpperCase().indexOf(RUNTIME_DATA_OPEN)
    if (index >= 0) {
      // 标签已出现：之前的内容可展示，其后内容（含标签）一律不展示。
      this.stopped = true
      const visible = this.pending.slice(0, index)
      this.pending = ""
      return visible
    }
    const hold = pendingTagPrefixLength(this.pending)
    if (hold === 0) {
      const visible = this.pending
      this.pending = ""
      return visible
    }
    const visible = this.pending.slice(0, this.pending.length - hold)
    this.pending = this.pending.slice(this.pending.length - hold)
    return visible
  }

  /** 一条消息结束时调用：未构成标签的缓冲按普通正文归还。 */
  flush(): string {
    if (this.stopped) return ""
    const visible = this.pending
    this.pending = ""
    return visible
  }
}

/** 返回 text 尾部与标签开头匹配的最长长度；0 表示没有未决的标签前缀。 */
function pendingTagPrefixLength(text: string): number {
  const max = Math.min(text.length, RUNTIME_DATA_OPEN.length - 1)
  for (let length = max; length > 0; length--) {
    if (text.slice(text.length - length).toUpperCase() === RUNTIME_DATA_OPEN.slice(0, length)) return length
  }
  return 0
}
