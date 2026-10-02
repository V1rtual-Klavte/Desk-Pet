import { invoke } from "@tauri-apps/api/core"
import { runtimePath } from "@/services/paths"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("V1rtual")
let v1rtualInstructions = ""

export function getV1rtualInstructionsSync(): string {
  return v1rtualInstructions ? `\n\n[用户自定义指令]\n${v1rtualInstructions}` : ""
}

export async function loadV1rtualInstructions(): Promise<string> {
  try {
    const path = await runtimePath("memory", "V1RTUAL.md")
    const result = await invoke<{ content: string }>("file_read", { path })
    const match = result.content.match(/##\s*指令\s*\n([\s\S]*?)(?:\n_最后更新|\n##|\n---|$)/i)
    v1rtualInstructions = (match?.[1] ?? "").split("\n").filter(line => {
      const value = line.trim()
      return value.length > 0 && !value.startsWith("<!--")
    }).join("\n").trim()
  } catch (error) {
    log.warn("V1RTUAL.md 读取失败:", formatError(error))
    v1rtualInstructions = ""
  }
  return v1rtualInstructions
}

export async function updateV1rtualInstructions(instructions: string): Promise<boolean> {
  const body = instructions.trim()
  const markdown = `# V1RTUAL.md — 用户系统指令\n\n> 用户手写的系统级陪伴指令。\n\n---\n\n## 指令\n\n${body}\n\n_最后更新: ${new Date().toISOString()}_\n`
  try {
    const path = await runtimePath("memory", "V1RTUAL.md")
    await invoke("file_write_atomic", { path, content: markdown })
    v1rtualInstructions = body
    return true
  } catch (error) {
    log.error("V1RTUAL.md 写入失败", error instanceof Error ? error : undefined)
    return false
  }
}

export function resetV1rtualInstructionsForTest(): void { v1rtualInstructions = "" }
