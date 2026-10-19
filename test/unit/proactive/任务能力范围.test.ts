import { describe, expect, it, vi } from "vitest"

vi.mock("@/services/config", () => ({
  enabledMcpServerNames: () => ["news", "foo", "foo_bar"],
}))

import { taskMcpServers } from "@/services/user-tasks/capabilities"
import type { UserTaskDefinition } from "@/services/user-tasks/types"

function definition(capabilities: string[]): UserTaskDefinition {
  return {
    text: "整理资料",
    kind: "agent_job",
    execution: { thinkingEffort: "low" },
    schedule: {
      calendar: { frequency: "daily", timezone: "UTC" },
      trigger: { kind: "at", time: "09:00" },
      count: { kind: "fixed", value: 1, per: "day" },
      minGapMinutes: 0,
      validity: { from: 0, until: null },
      missedPolicy: "within_window",
    },
    work: { goal: "整理资料", inputs: [], capabilities, output: "摘要", completion: "完成" },
  }
}

describe("用户任务 MCP 借用范围", () => {
  it("只借任务声明的 MCP server，最长 server 名优先，未知能力不外借 [schedule-task-mcp-scope]", () => {
    expect(taskMcpServers(definition(["mcp_foo_bar_search", "mcp_news_read", "local_read", "mcp_missing_x"]))).toEqual(["foo_bar", "news"])
    expect(taskMcpServers(definition([]))).toEqual([])
  })
})
