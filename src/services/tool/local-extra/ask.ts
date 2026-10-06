// ==========================================
// 本地工具：向用户提问并请求选择（NORMAL）
// ask_user —— 模型需要用户做决定时，给出问题与若干选项，走桌宠自己的选择面板
// ==========================================
//
// 背景（2026-10-06 用户实测）：模型需要用户拍板时只能**打字问**（「你确认要删的话我就删」），
// 确认与否被淹没在正文里。本工具把「提问 → 选择 → 答复」接回桌面面板（与 propose_plan
// 同款：确认走既有 UI 通道，结果作为工具结果如实返回模型）：
//   · 面板显示问题与选项；用户点选 → 工具结果 = 所选项原文；
//   · **「其它」**：用户选择用自己的话回答 → 结果说明「用户将在下一条消息里说明」，
//     不再由模型追问；用户的自由原文以正常消息到达，不会丢；
//   · 用户取消 / 提问未能送达界面 / 会话切换 / 用户停止回合 → 一律如实返回
//     （`choiceDeclineText` 与通道的取消原因同源），**不假装用户选了任何一项**。
//     等待本身**没有超时**（2026-10-06 用户裁决：选择类弹窗不留超时，用户想多久想多久；
//     等待期豁免回合墙钟，见 `engine/user-wait.ts`）。
// 权限类确认（危险动作）不走这里：那仍由权限面板在动作发生时当场确认。
// 通道在 `engine/choice-confirmation.ts`（会话键控的待答表、超时与发射失败归宿）；
// 本文件只负责模型参数准入与归宿 → 工具结果的如实映射。
//
// 子代理面：声明 `isolation: "delegate"` —— 它是需要用户在场的交互工具，按「子代理不派生」
// 的既有剥离规则不下放到子代理与计划步骤（fork/team 白名单本就不含它）；「其它」的
// 自由回答以下一条用户消息为准到达**主回合**，无人值守的子运行收不到这条消息，
// 放进去只会让它挂到超时并拿到一个需要用户在场的假答复。

import type { ToolDef, ToolResult } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolAsk")

/** 模型可见的工具名（系统提示的工具指引也引用它，唯一命令名定义点）。 */
export const ASK_USER_TOOL = "ask_user"

/** 选项数量准入（Schema 同界；这里给出可读的拒绝理由，模型据此改参再试）。 */
const MIN_OPTIONS = 2
const MAX_OPTIONS = 6

/** 准入结果：`ok` 时给出规范化后的问题与选项，`reason` 是给模型的中性诊断。 */
type AskAdmission =
  | { ok: true; question: string; options: string[] }
  | { ok: false; reason: string }

/**
 * 参数准入（Schema 校验之后的语义校验）。拒绝理由必须点名到项，模型据此改参再试：
 *   · question 非空；
 *   · options 为 2..6 个非空字符串（超出不静默截断 —— 截断会让模型以为用户能看到全部选项）；
 *   · 选项之间不得重复（重复项在面板上是两个点哪个都一样的按钮，只会制造歧义）。
 */
function admitAsk(params: Record<string, unknown>): AskAdmission {
  const question = typeof params.question === "string" ? params.question.trim() : ""
  if (question === "") {
    return { ok: false, reason: "question 不能为空：给用户的问题必须是一句可读的话" }
  }
  const raw = params.options
  if (!Array.isArray(raw) || raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) {
    return { ok: false, reason: `options 必须是 ${MIN_OPTIONS} 到 ${MAX_OPTIONS} 个选项（收到 ${Array.isArray(raw) ? raw.length : typeof raw} 个）` }
  }
  const options: string[] = []
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      return { ok: false, reason: `第 ${index + 1} 个选项为空：每个选项都要是一句可读的话` }
    }
    options.push(item.trim())
  }
  const seen = new Set<string>()
  for (const option of options) {
    if (seen.has(option)) {
      return { ok: false, reason: `选项重复：「${option}」出现了两次；面板上两个一样的按钮用户没法区分` }
    }
    seen.add(option)
  }
  return { ok: true, question, options }
}

const askUserTool: ToolDef = defineTool({
  id: "local-ask-user",
  name: ASK_USER_TOOL,
  description:
    "向用户提出一个需要用户决定的问题并给出若干选项（2 到 6 个）：用户在你的选择面板点选后，结果作为工具结果返回所选项原文；用户也可以选「其它」用自己的话回答 —— 那时结果会说明用户将在下一条消息里说明，你据此等待并回应用户的下一条消息，不要重复提问。需要用户做决定时必须用本工具提问（**仅限信息、偏好、路线这类真正需要用户拿主意的选择；你自己就能做完的事不要拿来问**——那只会让用户多打一遍字），不要用文字在回复里先征求同意，也不要用 osascript / display dialog 等 GUI 弹窗命令等待用户输入（弹窗会因工具超时而变成孤儿窗口）。权限类确认（危险动作要不要执行）不走本工具：那由确认面板在动作发生时当场向用户确认。用户取消、提问没能送达界面或会话切换时不假装用户选了任何一项，结果会如实说明。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "要用户决定的问题（一句话，说清在决定什么）" },
      options: {
        type: "array",
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        items: { type: "string" },
        description: `可选项（${MIN_OPTIONS} 到 ${MAX_OPTIONS} 个，各自独立成句）；用户也可以选面板上的「其它」自由回答`,
      },
    },
    required: ["question", "options"],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  // 提问不改变系统状态：阶段文案按默认类别（`_default`）匹配就够，不为它新增
  // `actionCategory` 值（那要连带重生成 Card 的阶段文案表）。
  actionCategory: "_default",
  // delegate：需要用户在场的交互工具，不进子代理与计划步骤（见文件头）；也因此不占
  // 父批次执行许可。重放资格 never：崩溃恢复不自动重问（用户当时不一定在场）。
  // 执行超时 `null`：handler 的相位就是「等用户回答」（想多久想多久，2026-10-06 用户
  // 裁决不留超时），没有有限的预算可言；归宿只来自面板回执 / 取消信号 / 会话生命周期，
  // 外层兜底是回合墙钟（等待期已豁免，见 engine/user-wait.ts）。
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    execution: { effect: "read", isolation: "delegate", replay: "never", timeoutMs: null },
    // preserve：用户的选择是模型后续动作的直接依据，请求视图不得二次缩短/清空。
    context: { resultProjection: "preserve", historyCompaction: "summarize" },
  },
}, async (params, ctx): Promise<ToolResult> => {
  // 绑定当前会话与运行代际：没有身份就没有面板归属，也没有可结算的等待。
  if (!ctx.sessionId || ctx.runGeneration === undefined) {
    return { success: false, content: "", error: "提问必须绑定当前会话与运行代际", errorCode: "failed" }
  }
  if ((ctx.isCurrent && !ctx.isCurrent()) || ctx.signal?.aborted) {
    return { success: false, content: "", error: "回合已取消", errorCode: "cancelled" }
  }
  const admission = admitAsk(params)
  if (!admission.ok) {
    log.warn("提问参数被拒绝:", admission.reason)
    return { success: false, content: "", error: admission.reason, errorCode: "failed" }
  }

  const requestId = `choice-${ctx.toolCallId ?? crypto.randomUUID()}`
  try {
    // 动态导入避免跨域模块循环：确认通道在引擎域。指名具体模块、不导桶（理由见
    // propose_plan 侧注释与 build.mjs 的 assertNoDynamicBarrelImports 守门）。
    const { requestChoice, choiceDeclineText } = await import("@/services/engine/choice-confirmation")
    const outcome = await requestChoice({
      sessionId: ctx.sessionId,
      requestId,
      question: admission.question,
      options: admission.options,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })

    if (outcome.answered) {
      if (outcome.answer.kind === "picked") {
        // 如实返回所选项原文（用户看到的就是这句，模型不必猜索引）。
        return { success: true, content: `用户选择了：「${outcome.answer.option}」` }
      }
      // 「其它」：用户选择用自己的话回答。自由原文以下一条消息到达；这里只说清楚
      // 「发生了什么、接下来怎么办」，不替用户编内容。
      return {
        success: true,
        content: "用户选择了「其它」：希望用自己的话回答，不采用你给出的选项。用户会在下一条消息里说明自己的选择；请等待并回应用户的下一条消息，不要重复提问。",
      }
    }
    // 非答复归宿（取消/超时/切会话/会话关闭/发射失败/面板不可用）：一律如实说明，
    // 不假装用户选了任何一项（文案与通道的取消原因同源，唯一组装点在 choiceDeclineText）。
    return { success: false, content: "", error: choiceDeclineText(outcome.reason), errorCode: "cancelled" }
  } catch (error) {
    // 异常不静默、不冒充成功；消息里带 requestId 便于对账。
    const message = formatError(error)
    log.error("提问失败:", requestId, message)
    return { success: false, content: "", error: `提问失败: ${message}`, errorCode: "failed" }
  }
})

export function registerAskUserTool(): void {
  register(askUserTool)
  log.info("提问选择工具已注册 (ask.user)")
}
