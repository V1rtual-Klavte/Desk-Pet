// ==========================================
// 变量池工具 — var_read / var_write / var_list / var_delete
// §4.3: LLM 通过这 4 个工具管理角色变量
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import {
  buildVarReadHandler, buildVarWriteHandler,
  buildVarListHandler, buildVarDeleteHandler,
} from "@/services/personality/variable-pool"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolVar")

const varReadHandler = buildVarReadHandler()
const varWriteHandler = buildVarWriteHandler()
const varListHandler = buildVarListHandler()
const varDeleteHandler = buildVarDeleteHandler()

const varReadTool: ToolDef = {
  id: "local-var-read",
  name: "var_read",
  description: "读取指定变量的当前值。可读取系统变量或角色变量。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "变量名" },
    },
    required: ["name"],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  mode: "pet",
  actionCategory: "var.read",
  async handler(params) {
    return varReadHandler(params)
  },
}

const varWriteTool: ToolDef = {
  id: "local-var-write",
  name: "var_write",
  description: "更新已注册的 Card 变量。只能写 Card 中定义且 updateBy=llm 的变量。系统变量和互动状态不可写。值必须符合变量类型和约束。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "变量名" },
      value: { type: "string", description: "变量值（类型自动推断）" },
    },
    required: ["name", "value"],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  mode: "pet",
  actionCategory: "var.write",
  async handler(params) {
    return varWriteHandler(params)
  },
}

const varListTool: ToolDef = {
  id: "local-var-list",
  name: "var_list",
  description: "列出当前所有变量（系统+角色）及其值。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  mode: "pet",
  actionCategory: "var.read",
  async handler() {
    return varListHandler()
  },
}

const varDeleteTool: ToolDef = {
  id: "local-var-delete",
  name: "var_delete",
  description: "重置一个 Card 变量到其初始值。系统变量和互动状态不可重置。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "要删除的变量名" },
    },
    required: ["name"],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  mode: "pet",
  actionCategory: "var.write",
  async handler(params) {
    return varDeleteHandler(params)
  },
}

export function registerVarTools(): void {
  register(varReadTool)
  register(varWriteTool)
  register(varListTool)
  register(varDeleteTool)
  log.info("变量工具已注册 (var_read/write/list/delete)")
}
