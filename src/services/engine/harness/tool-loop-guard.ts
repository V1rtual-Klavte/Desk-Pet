// ==========================================
// 工具循环病理检测（纯逻辑，零依赖叶子；每回合重置）
//
// 主聊天回合没有「工具调用次数」的计数硬上限（对齐主流 harness：自然出口 = 模型不再调工具）；
// 死循环的兜底防线是**病理模式检测**，不是总量计数：
//   · 同参重复：同工具 + 同参数（键排序 JSON 签名）连续 3 次 → 软提示；连续 5 次 → 硬终止
//     （出现不同签名即重置连击）；
//   · 连续失败：连续 3 次工具失败 → 软提示；连续 5 次 → 硬终止（一次成功打断连击）。
// 阈值取 Cline 的默认值（契约《回合治理与图片生命周期》§1.1 调研表：同工具同参数 3 次警告 /
// 5 次中止；连续错误 3 次询问或停止），写成具名常量，不做可调旋钮 —— 没有第二个消费点。
//
// 本模块只产出判据与中性文案，不投递、不持有回合状态：
//   · 软提示由 runtime 挂进工具结果正文（与回读地址同一出口 `annotateToolResultText`），
//     不加 Card key、不进用户可见文案；
//   · 硬终止两条路都汇总到 runtime：同参连击在调用门复用既有 `block + terminate` 机制；
//     失败连击在结果侧经 `after_tool` 的 `terminate` 立即终止（收尾文案仍走 Card 的
//     `toolLoopMaxRounds`）。
//
// 连续失败的一次调用可能同时是同参重复的第 N 次（例如同一个坏调用连打三遍）：两个连击各自
// 记账，判据取更强的一档；同级时以失败连击为准（工具坏掉比模型原地打转更需要收手）。
// ==========================================

/** 同参重复的软/硬阈值（连续调用次数，含当前这次）。 */
export const REPEATED_CALL_SOFT_LIMIT = 3
export const REPEATED_CALL_HARD_LIMIT = 5

/** 连续失败的软/硬阈值（连续失败次数）。 */
export const CONSECUTIVE_FAILURE_SOFT_LIMIT = 3
export const CONSECUTIVE_FAILURE_HARD_LIMIT = 5

export type ToolLoopVerdictLevel = "none" | "soft" | "hard"

/** 命中的病理模式与连击计数（计数用于生成中性文案，不用于阈值判定之外的分支）。 */
export interface ToolLoopReason {
  kind: "repeated_call" | "consecutive_failures"
  count: number
}

/** `none` 之外必带原因；硬终止的 block 原因与软提示文案都由原因派生。 */
export type ToolLoopVerdict =
  | { level: "none" }
  | { level: "soft"; reason: ToolLoopReason }
  | { level: "hard"; reason: ToolLoopReason }

const VERDICT_RANK: Record<ToolLoopVerdictLevel, number> = { none: 0, soft: 1, hard: 2 }

/**
 * 稳定的 JSON 序列化：对象键按键排序，数组保序。参数等价性只看这里产出的字符串 ——
 * 模型两次给出键序不同的同一参数必须算同一个签名（这是「同参重复」判据的前提）。
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    return `{${entries.join(",")}}`
  }
  // undefined / 函数等 JSON.stringify 不产出字符串的值按字面标记入签名（两者不等于任何 JSON 值）。
  const json = JSON.stringify(value)
  return json === undefined ? `"<${typeof value}>"` : json
}

/** 工具调用签名：工具名 + 键排序参数 JSON。同工具不同参数 → 不同签名（连击重置）。 */
export function toolCallSignature(toolName: string, args: unknown): string {
  return `${toolName}\n${stableJson(args)}`
}

function verdictFor(kind: ToolLoopReason["kind"], count: number, softLimit: number, hardLimit: number): ToolLoopVerdict {
  if (count >= hardLimit) return { level: "hard", reason: { kind, count } }
  if (count >= softLimit) return { level: "soft", reason: { kind, count } }
  return { level: "none" }
}

/**
 * 一回合内的病理状态。调用方每回合新建一个实例（`createTurnSpec` 的回合闭包），
 * 不跨回合、不跨运行复用 —— 重置点就是「新建实例」，没有第二个重置入口。
 *
 * 喂入顺序与工具生命周期对齐：`noteCall` 在调用**发起前**（beforeTool），
 * `noteResult` 在结果**返回后**（afterTool）。两个入口的返回口径不同，按各自的用途定义：
 * 调用门需要「此刻该不该终止」的整回合判据；结果侧只判失败连击（同参连击的调用账在调用门
 * 已记过，不在这条结果上重复入账），硬档由 runtime 经 `after_tool` 的 `terminate` 终止。
 */
export class ToolLoopGuard {
  private repeatedSignature: string | undefined
  private repeatedCount = 0
  private failureCount = 0

  /**
   * 记一次工具调用（在执行/权限门禁之前），返回整回合判据（两条连击取更强的一档；
   * 同级时取失败连击 —— 工具坏掉的解释比「模型原地打转」更具体）。
   */
  noteCall(toolName: string, args: unknown): ToolLoopVerdict {
    const signature = toolCallSignature(toolName, args)
    if (signature === this.repeatedSignature) this.repeatedCount += 1
    else {
      this.repeatedSignature = signature
      this.repeatedCount = 1
    }
    return this.strongest()
  }

  /**
   * 记一次工具结果：成功清零失败连击，失败累计（同参连击不受成败影响）。
   * 返回**失败连击**的判据（不合并同参连击）：软档用于决定「要不要给这条结果附软提示」，
   * 硬档由 runtime 在结果侧经 `after_tool` 的 `terminate` 立即终止。
   */
  noteResult(isError: boolean): ToolLoopVerdict {
    this.failureCount = isError ? this.failureCount + 1 : 0
    return verdictFor("consecutive_failures", this.failureCount, CONSECUTIVE_FAILURE_SOFT_LIMIT, CONSECUTIVE_FAILURE_HARD_LIMIT)
  }

  private strongest(): ToolLoopVerdict {
    const repeated = verdictFor("repeated_call", this.repeatedCount, REPEATED_CALL_SOFT_LIMIT, REPEATED_CALL_HARD_LIMIT)
    const failures = verdictFor("consecutive_failures", this.failureCount, CONSECUTIVE_FAILURE_SOFT_LIMIT, CONSECUTIVE_FAILURE_HARD_LIMIT)
    return VERDICT_RANK[repeated.level] > VERDICT_RANK[failures.level] ? repeated : failures
  }
}

/**
 * 软提示文案（中性系统提示，不是角色台词、不占 Card key）：
 * 由 runtime 附到触发工具的结果正文上，模型在下一次请求里读到它。
 */
export function toolLoopNotice(reason: ToolLoopReason): string {
  return reason.kind === "repeated_call"
    ? `[工具循环检测：同一工具与参数已连续调用 ${reason.count} 次；若没有新进展，请改变做法或直接给出结论]`
    : `[工具循环检测：工具已连续失败 ${reason.count} 次；请检查失败原因，若无法恢复请如实说明并给出结论]`
}

/**
 * 硬终止的 block 原因（内部诊断文案：进工具历史与运行结果，不是用户可见台词）。
 * 与子运行的计数上限原因（`工具调用次数达到上限`）并列，两者语义不同、不共用文案。
 */
export function toolLoopBlockReason(reason: ToolLoopReason): string {
  return reason.kind === "repeated_call"
    ? `工具循环病理检测：同一工具与参数连续调用 ${reason.count} 次，终止回合`
    : `工具循环病理检测：工具连续失败 ${reason.count} 次，终止回合`
}
