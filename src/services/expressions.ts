// ==========================================
// 表情关键词映射配置 v2 — 从 Profile 驱动
// ==========================================
import { getActiveProfile, type ExpressionRule } from "@/services/profile";

/**
 * 获取当前 Profile 的表情规则列表
 */
function getRules(): ExpressionRule[] {
  const profile = getActiveProfile();
  return profile?.expressions || [];
}

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
  for (const rule of getRules()) {
    for (const kw of rule.kw) {
      if (matchKeyword(text, kw)) {
        return rule.anim;
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════
// 向后兼容：保留旧接口类型
// ══════════════════════════════════════════
export type { ExpressionRule };
