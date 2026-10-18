/** Draft-capable tool schema. Required fields and cross-field constraints are checked by validation. */
export const taskDefinitionInputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    text: { type: "string", minLength: 1, maxLength: 1000 }, kind: { type: "string", enum: ["reminder", "agent_job"] },
    schedule: { type: "object", additionalProperties: false, properties: {
      calendar: { type: "object", additionalProperties: false, properties: {
        frequency: { type: "string", enum: ["once", "daily", "weekly", "monthly", "yearly"] }, timezone: { type: "string", description: "明确 IANA 时区，例如 Asia/Shanghai" },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "once 必须提供的当地日期" },
        weekdays: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 6 }, description: "weekly 必须提供；0 为周日，不推测真实工作日" },
        dayOfMonth: { type: "integer", minimum: 1, maximum: 31, description: "monthly/yearly 必须提供；月底沿用既有末日收拢规则" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "yearly 必须提供" },
        dates: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
      } },
      trigger: { type: "object", additionalProperties: false, properties: {
        kind: { type: "string", enum: ["at", "window", "confirmed_anchor", "observed_event"] },
        time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", description: "at 的固定当地时刻" },
        start: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, end: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", description: "window 的结束时刻，小于开始时归次日" },
        selection: { type: "string", enum: ["random", "spread"] },
        anchor: { type: "object", additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, localTime: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" } }, description: "仅用于已确认作息锚，不能凭画像自动创建" },
        offsetMinutes: { type: "integer", minimum: 0, maximum: 10080 }, windowMinutes: { type: "integer", minimum: 0, maximum: 1440 },
        event: { type: "string", enum: ["work_ended"] }, signal: { type: "string", enum: ["working_to_idle"] }, onUnavailable: { type: "string", enum: ["skip"] },
      } },
      count: { type: "object", additionalProperties: false, properties: {
        kind: { type: "string", enum: ["fixed", "random"] }, value: { type: "integer", minimum: 1, maximum: 100 },
        min: { type: "integer", minimum: 0, maximum: 100 }, max: { type: "integer", minimum: 1, maximum: 100 },
        per: { type: "string", enum: ["once", "day", "week", "month", "year"] }, allowZero: { type: "boolean", enum: [true], description: "仅用户明确接受零次时提供" },
      } },
      minGapMinutes: { type: "integer", minimum: 0, maximum: 10080 },
      validity: { type: "object", additionalProperties: false, properties: { from: { type: "number", minimum: 0 }, until: { type: ["number", "null"], description: "长期有效明确设 null，不能为用户凭空增设截止日" } } },
      missedPolicy: { type: "string", enum: ["within_window", "skip"] },
    } },
    execution: { type: "object", additionalProperties: false, properties: { thinkingEffort: { type: "string", enum: ["low", "medium", "high"] } } },
    work: { type: "object", additionalProperties: false, properties: {
      goal: { type: "string", minLength: 1 }, inputs: { type: "array", items: { type: "string", minLength: 1 } },
      capabilities: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 }, description: "已注册的只读 tool.name；创建与执行时双重核对" },
      output: { type: "string", minLength: 1 }, completion: { type: "string", minLength: 1 },
    } },
    delivery: { type: "object", additionalProperties: false, properties: {
      sessionId: { type: "string", minLength: 1 }, cardId: { type: "string", minLength: 1 }, cardHash: { type: "string", minLength: 1 }, windowMinutes: { type: "integer", minimum: 1, maximum: 10080 }, expression: { type: "string", minLength: 1 },
    } },
  },
}
