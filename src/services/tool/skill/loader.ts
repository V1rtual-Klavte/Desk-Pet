// ==========================================
// Skill Loader —— 加载 skills/ 目录下的 .md 文件
// 使用 Vite import.meta.glob 编译时导入
// 解析 YAML frontmatter + Markdown 体 → ToolDef
// ==========================================

import type { ToolDef, ToolResult } from "@/services/tool/types"
import type { ToolDeclaration } from "@/services/agent/types"
import { createLogger } from "@/services/logger"

const log = createLogger("SkillLoader")

// ── 类型 ──

export interface SkillMeta {
  id: string
  name: string
  description: string
  trigger_keywords?: string[]
  tools_needed?: string[]
  mode: "assistant"
  safety: "safe" | "normal" | "danger"
}

export interface SkillDef {
  meta: SkillMeta
  systemPrompt: string
  steps: string
}

// ── 解析 YAML frontmatter ──

function parseFrontmatter(raw: string): { meta: SkillMeta; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]
  const body = match[2].trim()
  const meta: Record<string, unknown> = {}

  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) {
      const key = kv[1].trim()
      const val = kv[2].trim().replace(/^["']|["']$/g, "")
      if (key === "trigger_keywords" || key === "tools_needed") {
        meta[key] = val.replace(/^\[|\]$/g, "").split(",").map(s => s.trim().replace(/^["']|["']$/g, ""))
      } else {
        meta[key] = val
      }
    }
  }

  return {
    meta: meta as unknown as SkillMeta,
    body,
  }
}

// ── 内置 Skill 定义 ──

const BUILTIN_SKILLS: string[] = [
  // 编译时注入技能文档
]

let loadedSkills: SkillDef[] = []

// ── 加载 Skill ──

/**
 * 加载所有内置 Skill。
 * Vite 编译时通过 ?raw 导入 skills/*.md，这里预留接口。
 * 当前使用硬编码的示例 Skill 以便测试。
 */
export function loadAllSkills(): SkillDef[] {
  if (loadedSkills.length > 0) return loadedSkills

  // 逐个解析内置 skill
  for (const raw of BUILTIN_SKILLS) {
    const parsed = parseFrontmatter(raw)
    if (parsed) {
      loadedSkills.push({
        meta: parsed.meta,
        systemPrompt: parsed.meta.description,
        steps: parsed.body,
      })
    }
  }

  // ── 内置测试 Skill（不依赖 Vite glob）──
  loadedSkills.push(
    createBuiltinSkill("summarize-code", "代码摘要", [
      "帮我看看代码", "分析这个项目", "这段代码做什么的",
    ]),
    createBuiltinSkill("organize-files", "文件整理", [
      "整理文件", "归类", "帮我把文件移一下",
    ]),
    createBuiltinSkill("check-weather", "天气查询", [
      "天气", "气温", "下雨",
    ]),
  )

  log.info(`已加载 ${loadedSkills.length} 个 Skill`)
  return loadedSkills
}

function createBuiltinSkill(id: string, name: string, keywords: string[]): SkillDef {
  return {
    meta: {
      id, name,
      description: `${name} Skill — 助手模式可用`,
      trigger_keywords: keywords,
      tools_needed: ["file_read", "file_list"],
      mode: "assistant",
      safety: "safe",
    },
    systemPrompt: `你正在使用 ${name} 技能。按照步骤执行并给出结果。`,
    steps: `1. 理解用户需求\n2. 调用必要工具\n3. 组织结果回复`,
  }
}

// ── 将 Skill 转换为 ToolDef ──

export function skillToToolDef(skill: SkillDef): ToolDef {
  const safetyMap: Record<string, "SAFE" | "NORMAL"> = {
    safe: "SAFE",
    normal: "NORMAL",
  }

  return {
    id: `skill-${skill.meta.id}`,
    name: `skill_${sanitizeName(skill.meta.id)}`,
    description: skill.meta.description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: `用户关于 ${skill.meta.name} 的原始请求` },
      },
      required: ["query"],
    },
    safetyLevel: safetyMap[skill.meta.safety] ?? "SAFE",
    source: "skill" as const,
    sourceId: skill.meta.id,
    mode: "assistant" as const,
    timeoutMs: 60000,
    personalityHint: {
      executing: `让我用"${skill.meta.name}"技能帮你...`,
      done: `${skill.meta.name} 完成啦～`,
    },
    async handler(params) {
      // Skill 执行：此阶段做简单透传，实际 skill 编排在 Phase 4 完善
      const query = String(params.query ?? "")
      return {
        success: true,
        content: `[Skill: ${skill.meta.name}]\n收到请求: ${query}\n\n此 Skill 将使用以下工具: ${(skill.meta.tools_needed ?? []).join(", ")}\n\n(完整 Skill 编排引擎 Phase 4 实现)`,
      }
    },
  }
}

/** 获取当前所有 Skill 转换的 ToolDef 列表 */
export function getSkillTools(): ToolDef[] {
  loadAllSkills()
  return loadedSkills.map(skillToToolDef)
}

function sanitizeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

// ── HMR ──
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    loadedSkills = []
    loadAllSkills()
    log.info("Skill HMR 完成")
  })
}
