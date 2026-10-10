// ==========================================
// 外部评测 judge 提示模板（纯函数）
// ==========================================
//
// LongMemEval 的 5 套题型模板逐字移植自官方 src/evaluation/evaluate_qa.py（2026-10-03 核对，
// 文件 SHA-256 见 prepare 注册表）。判定语义保持官方口径：`'yes' in response.lower()`。
// MemoryBank 没有官方判分脚本，这里给出仓内自适配模板（对照整段角色历史判一致性），
// 报告口径记为 adapter，不冒充官方。
//
// 纪律：judge 模型必须不同于被测模型（由 bench-adapter 强制），本模块只负责提示与解析。

export const LME_JUDGE_TEMPLATES = Object.freeze([
  "generic", "temporal-reasoning", "knowledge-update", "single-session-preference", "abstention",
])

const GENERIC_TEMPLATE = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

const TEMPORAL_TEMPLATE = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

const KNOWLEDGE_UPDATE_TEMPLATE = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

const PREFERENCE_TEMPLATE = "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

const ABSTENTION_TEMPLATE = "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only."

export function judgeTemplateId(questionType, abstention) {
  if (abstention) return "abstention"
  if (questionType === "temporal-reasoning") return "temporal-reasoning"
  if (questionType === "knowledge-update") return "knowledge-update"
  if (questionType === "single-session-preference") return "single-session-preference"
  if (questionType === "single-session-user" || questionType === "single-session-assistant" || questionType === "multi-session")
    return "generic"
  throw new Error(`LongMemEval 未登记的题型: ${questionType}`)
}

/** 官方 get_anscheck_prompt 的移植；abstention=true 时走弃权模板（官方按 `_abs` 判定）。 */
export function buildLongMemEvalJudgePrompt({ questionType, question, answer, response, abstention = false }) {
  const templateId = judgeTemplateId(questionType, abstention)
  const template = templateId === "abstention" ? ABSTENTION_TEMPLATE
    : templateId === "temporal-reasoning" ? TEMPORAL_TEMPLATE
      : templateId === "knowledge-update" ? KNOWLEDGE_UPDATE_TEMPLATE
        : templateId === "single-session-preference" ? PREFERENCE_TEMPLATE : GENERIC_TEMPLATE
  // 按槽位拼接而不是逐个 replace（"{}"）：回答正文可能自带花括号，逐个替换会串位。
  const slots = template.split("{}")
  if (slots.length !== 4) throw new Error(`judge 模板槽位不是 3 个: ${templateId}`)
  return { templateId, prompt: `${slots[0]}${question}${slots[1]}${answer}${slots[2]}${response}${slots[3]}` }
}

/**
 * MemoryBank 自适配判分：以整段角色历史为参照判回答一致性。
 * 上游无金标，也没有官方模板；本模板只回答「回答是否与历史一致且答到了问题」。
 */
export function buildMemoryBankJudgePrompt({ question, history, response }) {
  return {
    templateId: "memorybank-consistency",
    prompt: `你将看到一段用户与 AI 助手的历史对话、一个关于这段历史的问题，以及 AI 助手对问题的回答。请判断回答是否正确：回答与历史对话一致、且给出了问题所问的信息时为 yes；回答与历史矛盾、凭空编造、答非所问，或声称无法回答时为 no。不要求固定措辞，同义表达也算正确。\n\n历史对话：\n${String(history)}\n\n问题：${String(question)}\n\n回答：${String(response)}\n\n回答是否正确？只回答 yes 或 no。`,
  }
}

/** 官方语义：`label = 'yes' in eval_response.lower()`；空文本由调用方判为未裁决。 */
export function parseJudgeVerdict(text) {
  return String(text ?? "").toLowerCase().includes("yes")
}

/**
 * Judge 输出上限受两项约束：解析后的模型输出上限，以及扣除本次输入后实际剩余的窗口。
 * reasoning 也计入 `maxTokens`；不能再用固定 4096 cap 截掉模型自身可用的思考预算。
 */
export function judgeOutputBudget(modelMaxTokens, availableContextTokens = modelMaxTokens) {
  if (!Number.isSafeInteger(modelMaxTokens) || modelMaxTokens < 1)
    throw new Error("judge 模型缺少有效的 maxTokens 上限")
  if (!Number.isFinite(availableContextTokens) || availableContextTokens < 1)
    throw new Error("judge 输入已耗尽上下文，无法保留完整判分输出空间")
  return Math.min(modelMaxTokens, Math.floor(availableContextTokens))
}
