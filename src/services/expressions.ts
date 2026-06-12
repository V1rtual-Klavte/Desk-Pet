// ==========================================
// 表情关键词映射配置
// 配置驱动：关键词 → 表情名称
// ==========================================

export interface ExpressionRule {
  /** 触发关键词列表 */
  keywords: string[];
  /** 对应的表情动画名 */
  expression: string;
}

/**
 * 表情规则列表，按优先级从高到低排列。
 * 匹配时取第一个命中，避免多个规则连续覆盖。
 * ASCII 关键词使用 \b 词边界匹配，避免 "youtube" 误触发 "you"。
 */
export const expressionRules: ExpressionRule[] = [
  { keywords: ["smile"],       expression: "smile" },
  { keywords: ["sleep", "困"], expression: "sleepy" },
  { keywords: ["gaoo"],        expression: "gaoo" },
  { keywords: ["superchat"],   expression: "superchat" },
  { keywords: ["business"],    expression: "business" },
  { keywords: ["you"],         expression: "you" },
  { keywords: ["chu"],         expression: "chu" },
];

/**
 * 判断字符是否为 ASCII（用于区分词边界匹配策略）
 */
function isAscii(ch: string): boolean {
  return ch.charCodeAt(0) <= 127;
}

/**
 * 判断关键词是否全部由 ASCII 字符组成
 */
function isAsciiWord(word: string): boolean {
  return [...word].every(isAscii);
}

/**
 * 在文本中匹配关键词。
 * - ASCII 关键词使用 \b 词边界，防止 "youtube" 误触发 "you"
 * - 非 ASCII（中文等）使用简单子串匹配
 */
function matchKeyword(text: string, keyword: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerKw = keyword.toLowerCase();
  if (isAsciiWord(lowerKw)) {
    // 转义正则特殊字符后加词边界
    const escaped = lowerKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(lowerText);
  }
  return lowerText.includes(lowerKw);
}

/**
 * 根据聊天文本匹配表情规则，返回第一个命中的表情名。
 * 无匹配时返回 null。
 */
export function matchExpression(text: string): string | null {
  for (const rule of expressionRules) {
    for (const kw of rule.keywords) {
      if (matchKeyword(text, kw)) {
        return rule.expression;
      }
    }
  }
  return null;
}
