// ==========================================
// 测试 Fixtures — 共用测试数据
// ==========================================

import type { CardVariableDef } from "@/services/personality/types"

/** angelkawaii 的变量定义（精简版，供测试用） */
export const ANGELKAWAII_DEFS: CardVariableDef[] = [
  {
    scope: "card", name: "亲密度", type: "number", initial: 3,
    min: 0, max: 10, updateBy: "llm", persistent: true, reset: "never",
    description: "用户与 KAngel 的亲密程度",
  },
  {
    scope: "card", name: "心情", type: "string", initial: "平静",
    enum: ["开心", "平静", "失落", "生气", "害羞"],
    updateBy: "llm", persistent: true, reset: "never",
    description: "KAngel 当前主观心情",
  },
  {
    scope: "card", name: "用户今天是否夸过我", type: "boolean", initial: false,
    updateBy: "llm", persistent: true, reset: "daily",
    description: "用户今天是否夸奖过 KAngel",
  },
  {
    scope: "interaction", name: "unansweredCount", type: "number", initial: 0,
    min: 0, updateBy: "system", persistent: true, reset: "never",
    description: "用户连续未回应次数",
  },
]

/** ame 的变量定义（精简版） */
export const AME_DEFS: CardVariableDef[] = [
  {
    scope: "card", name: "当前任务数", type: "number", initial: 0,
    min: 0, updateBy: "llm", persistent: true, reset: "never",
    description: "当前会话中用户请求的任务数量",
  },
  {
    scope: "card", name: "上次任务类型", type: "string", initial: "",
    updateBy: "llm", persistent: true, reset: "never",
    description: "用户最近一次请求的任务类型",
  },
  {
    scope: "interaction", name: "unansweredCount", type: "number", initial: 0,
    min: 0, updateBy: "system", persistent: true, reset: "never",
    description: "用户连续未回应次数",
  },
]

/** ame 的 When 规则 */
export const AME_WHEN_RULES = [
  { name: "深夜执勤", when: "hour >= 23 OR hour <= 5", tone: "语气更温和" },
  { name: "长时间沉默", when: "unansweredCount >= 3", tone: "极简冷淡" },
  { name: "轻微提醒", when: "unansweredCount >= 1 AND unansweredCount <= 2", tone: "克制提醒" },
  { name: "默认", when: "true", tone: "冷静高效" },
]

/** 通用变量集 */
export const GENERIC_DEFS: CardVariableDef[] = [
  {
    scope: "card", name: "score", type: "number", initial: 0,
    min: 0, max: 100, updateBy: "llm", persistent: true, reset: "session",
    description: "会话得分",
  },
  {
    scope: "card", name: "status", type: "string", initial: "idle",
    enum: ["idle", "active", "busy", "away"],
    updateBy: "llm", persistent: true, reset: "never",
    description: "当前状态",
  },
]
