/**
 * 记忆条目引用解析。
 *
 * 记忆块里给模型的条目身份是 `id@version`（provider 的 `sourceId = id@version`），
 * 而写操作按**裸 id** 定位条目、版本单独做并发校验。模型把 `id@version` 原样回传时
 * 必须在这里拆开 —— 否则工具会把它当成不存在的条目（2026-10-21 实机：纠正 100% 失败
 * 并退化成新增，库里同一事实留下多条互相矛盾的版本）。
 *
 * 零依赖叶子：只做字符串解析，不 import 任何运行时模块。
 */
export interface MemoryItemRef {
  id: string
  /** 引用里携带的版本；缺省表示调用方没有指定，按当前版本处理。 */
  version?: number
}

const VERSIONED_REF = /^(.+?)@(\d+)$/u

/** 接受 `id` 或 `id@version`；只把**纯数字尾巴**当版本，其余原样当 id。 */
export function parseMemoryItemRef(raw: string): MemoryItemRef {
  const value = raw.trim()
  const match = VERSIONED_REF.exec(value)
  if (!match) return { id: value }
  const id = match[1]!.trim()
  if (!id) return { id: value }
  return { id, version: Number(match[2]) }
}
