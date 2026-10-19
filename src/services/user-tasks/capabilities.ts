import { createHash } from "node:crypto"
import { posix, win32 } from "node:path"
import { enabledMcpServerNames } from "@/services/config"
import type { ToolDef } from "@/services/tool/types"
import { toolPolicyFingerprint } from "@/services/tool/policy"
import type { UserTaskDefinition } from "./types"

/**
 * MCP tools are named `mcp_<server>_<tool>`; a task may only borrow the servers
 * named by its persisted capability grants. Unknown capability names stay out of
 * the borrow set and are reported as missing before any work starts.
 */
export function taskMcpServers(definition: UserTaskDefinition): string[] {
  const capabilities = definition.work?.capabilities ?? []
  if (!capabilities.length) return []
  const servers = enabledMcpServerNames()
  const selected = new Set<string>()
  for (const capability of capabilities) {
    const matches = servers.filter(server => capability.startsWith(`mcp_${server}_`))
    if (!matches.length) continue
    // Prefer the longest server name so `foo` cannot shadow `foo_bar`.
    matches.sort((left, right) => right.length - left.length)
    selected.add(matches[0]!)
  }
  return [...selected]
}

/** An MCP hint is eligibility metadata; persisted consent plus PermissionKernel still grant execution. */
export function isTaskReadCapability(tool: ToolDef): boolean {
  if (tool.policy.execution.isolation === "delegate" || tool.policy.permission.defaultDecision === "deny" || tool.safetyLevel === "NOWAY") return false
  return tool.source === "mcp" ? tool.mcpAnnotations?.readOnlyHint === true && tool.mcpAnnotations.destructiveHint !== true
    : tool.policy.execution.effect === "read"
}
export function taskCapabilityFingerprint(tool: ToolDef): string {
  return createHash("sha256").update(toolPolicyFingerprint(tool)).digest("hex")
}
function publicUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
    if (!hostname || hostname === "localhost" || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname)) return false
    if (hostname.includes(":")) {
      if (!/^[23]/.test(hostname) || /^2001:(?:db8|2|10|20)(?::|$)/.test(hostname)) return false
      if (hostname.startsWith("::ffff:")) return false
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      const [a, b, c] = hostname.split(".").map(Number) as [number, number, number]
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
        || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false
    } else if (!hostname.includes(".")) return false
    return true
  } catch { return false }
}
function pathWithin(value: string, inputs: readonly string[]): boolean {
  if (value.includes("\0") || value.split(/[\\/]/).includes("..")) return false
  const implementation = /^[a-z]:[\\/]|^\\\\/i.test(value) ? win32 : posix
  if (!implementation.isAbsolute(value)) return false
  const resolved = implementation.normalize(value)
  return inputs.some(input => {
    if (!implementation.isAbsolute(input)) return false
    const relative = implementation.relative(implementation.normalize(input), resolved)
    return relative === "" || (!relative.startsWith(`..${implementation.sep}`) && relative !== ".." && !implementation.isAbsolute(relative))
  })
}
/** Recursively covers nested objects/arrays; tool-returned paths never expand the persisted input scope. */
export function taskCapabilityScopeAllows(tool: ToolDef, params: Record<string, unknown>, definition: UserTaskDefinition): boolean {
  if (!definition.work?.capabilities.includes(tool.name) || !isTaskReadCapability(tool)) return false
  const grant = definition.authorization?.capabilityGrants.find(row => row.toolName === tool.name)
  if (!grant || grant.descriptorHash !== taskCapabilityFingerprint(tool)) return false
  const visit = (value: unknown, key: string): boolean => {
    if (Array.isArray(value)) return value.every(child => visit(child, key))
    if (value && typeof value === "object") return Object.entries(value).every(([childKey, child]) => visit(child, childKey))
    if (typeof value !== "string") return true
    if (/^(?:paths?|files?|file_?paths?|directories|directory|cwd|root|filename)$/i.test(key) || /(?:Path|Paths|Directory|Root)$/.test(key)) return pathWithin(value, definition.work!.inputs)
    if (/\b(?:file|ftp|ssh|smb|data|javascript):/i.test(value)) return false
    const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? []
    return urls.every(publicUrl)
  }
  return visit(params, "")
}
