/**
 * 演练报告落盘：统一走数据根 `logs/sim/`，不新增仓库外路径。
 *
 * 只写演练产物；业务状态仍在原模块（SQLite / understanding.json），报告不成为第二份真相。
 */
import { getHostBridge } from "@/services/host"
import { runtimePath } from "@/services/paths"

export interface SimReportFiles {
  reportPath: string
  markdownPath: string
  tracePath: string
}

export async function writeSimFiles(input: {
  prefix: string
  report: unknown
  markdown: string
  events: readonly unknown[]
}): Promise<SimReportFiles> {
  const dir = await runtimePath("data", "logs", "sim")
  await getHostBridge().request("dir_create", { path: dir, recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const reportPath = `${dir}/${input.prefix}-${stamp}.json`
  const markdownPath = `${dir}/${input.prefix}-${stamp}.md`
  const tracePath = `${dir}/${input.prefix}-${stamp}.trace.jsonl`
  const bridge = getHostBridge()
  await bridge.request("file_write", {
    path: reportPath, maxBytes: 16 * 1024 * 1024, content: JSON.stringify(input.report, null, 2),
  })
  await bridge.request("file_write", {
    path: tracePath, maxBytes: 64 * 1024 * 1024,
    content: input.events.map(event => JSON.stringify(event)).join("\n"),
  })
  await bridge.request("file_write", {
    path: markdownPath, maxBytes: 4 * 1024 * 1024, content: input.markdown,
  })
  return { reportPath, markdownPath, tracePath }
}
