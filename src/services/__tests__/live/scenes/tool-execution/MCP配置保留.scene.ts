import type { SceneDef } from "../../types"
import { setOverride, toolsConfig } from "@/services/config"
import { setBuiltinMcpConfig } from "@/services/tool/mcp"

const SERVER = "live-mcp-config-preserve"

export const MCP配置字段保留: SceneDef = {
  meta: {
    caseId: "tool-mcp-config-preserve",
    module: "tool-execution",
    contractId: "te-14",
    description: "内置 MCP 常规设置保存不得清除 include/exclude 过滤字段",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["tool-execution", "mcp", "boundary"],
  },
  turns: [{
    index: 1,
    description: "覆盖 args/env 后保留源过滤配置",
    userText: "校验 MCP 配置保留。",
    checks: [{
      type: "expectBuiltinMcpFilterPreserved",
      run: async () => {
        const previous = toolsConfig.builtinMcpServers
        try {
          setOverride("tools.mcp.builtin", {
            [SERVER]: {
              enabled: true,
              command: "npx",
              args: ["old"],
              description: "live test",
              includeTools: ["read"],
              excludeTools: ["write"],
              env: { TOKEN: "old" },
            },
          })
          setBuiltinMcpConfig(SERVER, { args: ["new"], env: { TOKEN: "new" } })
          const saved = toolsConfig.builtinMcpServers[SERVER]!
          if (JSON.stringify(saved.includeTools) !== JSON.stringify(["read"]) || JSON.stringify(saved.excludeTools) !== JSON.stringify(["write"])) {
            throw new Error("保存内置 MCP 常规字段时丢失 include/exclude")
          }
          if (JSON.stringify(saved.args) !== JSON.stringify(["new"]) || (saved.env as Record<string, string>)?.TOKEN !== "new") {
            throw new Error("内置 MCP 编辑字段没有写入")
          }
        } finally {
          setOverride("tools.mcp.builtin", previous)
        }
      },
    }],
  }],
}

export default MCP配置字段保留
