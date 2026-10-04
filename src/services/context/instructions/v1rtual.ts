import { invoke } from "@tauri-apps/api/core"
import { runtimePath } from "@/services/paths"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("V1rtual")
let v1rtualInstructions = ""

/** 应用模板的 `## 指令` 小节：到 `_最后更新`、下一个 `##`、分隔线或文末为止。 */
const INSTRUCTIONS_SECTION = /(?:^|\r?\n)##[ \t]*指令[ \t]*\r?\n([\s\S]*?)(?:\r?\n_最后更新|\r?\n##|\r?\n---|$)/i

/**
 * 文件正文 → 指令文本。
 *
 * 没有 `## 指令` 小节时按**整份正文**处理：用户手写时常不留标题，只认小节会让写下的
 * 指令静默失效（文件在、读得到，却不进 prompt）。HTML 注释是模板占位，始终剔除。
 */
export function parseV1rtualInstructions(content: string): string {
  const body = content.match(INSTRUCTIONS_SECTION)?.[1] ?? content
  return body.split("\n").filter(line => {
    const value = line.trim()
    return value.length > 0 && !value.startsWith("<!--")
  }).join("\n").trim()
}

export function getV1rtualInstructionsSync(): string {
  return v1rtualInstructions ? `\n\n[用户自定义指令]\n${v1rtualInstructions}` : ""
}

export async function loadV1rtualInstructions(): Promise<string> {
  try {
    const path = await runtimePath("memory", "V1RTUAL.md")
    const result = await invoke<{ content: string }>("file_read", { path })
    v1rtualInstructions = parseV1rtualInstructions(result.content)
  } catch (error) {
    log.warn("V1RTUAL.md 读取失败:", formatError(error))
    v1rtualInstructions = ""
  }
  return v1rtualInstructions
}

export async function updateV1rtualInstructions(instructions: string): Promise<boolean> {
  const body = instructions.trim()
  // 空串是「清空指令」这个真实意图，不能当「没改过」跳过：跳过等于设置页显示已保存、
  // 旧指令却继续进 prompt。这里只跳过内容完全相同的重复写盘。
  if (body === v1rtualInstructions) return true
  const markdown = `# V1RTUAL.md — 用户系统指令\n\n> 用户手写的系统级陪伴指令。\n\n---\n\n## 指令\n\n${body}\n\n_最后更新: ${new Date().toISOString()}_\n`
  try {
    const path = await runtimePath("memory", "V1RTUAL.md")
    await invoke("file_write_atomic", { path, content: markdown })
    // 缓存存「重新读一遍会得到的结果」，与 loadV1rtualInstructions 同源，
    // 上面那条相等判断才对得上磁盘实际内容。
    v1rtualInstructions = parseV1rtualInstructions(markdown)
    return true
  } catch (error) {
    log.error("V1RTUAL.md 写入失败", error instanceof Error ? error : undefined)
    return false
  }
}

export function resetV1rtualInstructionsForTest(): void { v1rtualInstructions = "" }
