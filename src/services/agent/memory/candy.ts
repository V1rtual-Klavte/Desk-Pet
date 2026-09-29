import { invoke } from "@tauri-apps/api/core"
import { runtimePath } from "@/services/paths"
import { createLogger } from "@/services/logger"

const log = createLogger("Candy")
let candyInstructions = ""

export function getCandyInstructionsSync(): string {
  return candyInstructions ? `\n\n[用户自定义指令]\n${candyInstructions}` : ""
}

export async function loadCandy(): Promise<string> {
  try {
    const path = await runtimePath("memory", "CANDY.md")
    const result = await invoke<{ content: string }>("file_read", { path })
    const match = result.content.match(/##\s*指令\s*\n([\s\S]*?)(?:\n_最后更新|\n##|\n---|$)/i)
    candyInstructions = (match?.[1] ?? "").split("\n").filter(line => {
      const value = line.trim()
      return value.length > 0 && !value.startsWith("<!--")
    }).join("\n").trim()
  } catch (error) {
    log.warn("CANDY.md 读取失败:", error)
    candyInstructions = ""
  }
  return candyInstructions
}

export async function updateCandy(instructions: string): Promise<boolean> {
  const body = instructions.trim()
  const markdown = `# CANDY.md — 用户系统指令\n\n> 用户手写的系统级陪伴指令。\n\n---\n\n## 指令\n\n${body}\n\n_最后更新: ${new Date().toISOString()}_\n`
  try {
    const path = await runtimePath("memory", "CANDY.md")
    await invoke("file_write_atomic", { path, content: markdown })
    candyInstructions = body
    return true
  } catch (error) {
    log.error("CANDY.md 写入失败", error instanceof Error ? error : undefined)
    return false
  }
}

export function resetCandyForTest(): void { candyInstructions = "" }
