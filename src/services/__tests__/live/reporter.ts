import type { SceneResult, TestReport } from "./types"

export function formatReport(report: TestReport, format: "terminal" | "json" | "markdown"): string {
  switch (format) {
    case "json": return JSON.stringify(report, null, 2)
    case "markdown": return formatMarkdown(report)
    default: return formatTerminal(report)
  }
}

function statusIcon(status: SceneResult["status"]): string {
  if (status === "pass") return "PASS"
  if (status === "skip") return "SKIP"
  if (status === "timeout") return "TIMEOUT"
  return "FAIL"
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatTerminal(report: TestReport): string {
  const lines: string[] = [
    "",
    `Live Test ${report.schemaVersion} | dataset ${report.datasetVersion}`,
    `run=${report.runId} | ${report.timestamp}`,
    `trials=${report.summary.totalTrials}, strictContracts=${report.options.strictContracts}, repeat=${report.options.repeat}`,
    "-".repeat(72),
  ]

  for (const error of report.datasetErrors) lines.push(`DATASET ERROR: ${error}`)
  for (const contract of report.contracts.filter(contract => !contract.valid)) {
    lines.push(`CONTRACT GAP: ${contract.module}: ${[...contract.missing, ...contract.gaps].join("; ")}`)
  }

  for (const scene of report.scenes) {
    lines.push(`${statusIcon(scene.status)} ${scene.caseId}#${scene.trial} [${scene.suite}/${scene.entry}] ${(scene.duration / 1000).toFixed(1)}s`)
    for (const turn of scene.turns) {
      const passed = turn.assertions.filter(assertion => assertion.pass).length
      lines.push(`  T${turn.index} ${passed}/${turn.assertions.length} assertions | ${turn.metrics.replyChars} chars | ${turn.metrics.toolCalls} tools | ${turn.metrics.duration}ms`)
      for (const assertion of turn.assertions.filter(assertion => !assertion.pass)) {
        lines.push(`    ${assertion.type}: ${assertion.error || "assertion failed"}`)
      }
    }
    if (scene.error) lines.push(`  ${scene.errorKind ?? "unknown"}: ${scene.error}`)
  }

  lines.push("-".repeat(72))
  lines.push(
    `pass=${report.summary.passed}/${report.summary.total} (${percent(report.summary.passRate)}) | ` +
    `pass@k=${percent(report.summary.passAtK)} | pass^k=${percent(report.summary.passPowerK)} | ` +
    `duration=${(report.summary.totalDuration / 1000).toFixed(1)}s`,
  )
  lines.push(`fail=${report.summary.failed}, timeout=${report.summary.timeout}, skip=${report.summary.skipped}`)
  return lines.join("\n")
}

function formatMarkdown(report: TestReport): string {
  const lines: string[] = [
    "# Live Test Report",
    "",
    `- Dataset: \`${report.datasetVersion}\``,
    `- Run: \`${report.runId}\``,
    `- Trials: ${report.summary.totalTrials}`,
    `- Pass rate: ${percent(report.summary.passRate)}`,
    `- pass@k: ${percent(report.summary.passAtK)}`,
    `- pass^k: ${percent(report.summary.passPowerK)}`,
    "",
    "| Status | Case | Trial | Suite | Entry | Duration |",
    "|---|---|---:|---|---|---:|",
  ]
  for (const scene of report.scenes) {
    lines.push(`| ${statusIcon(scene.status)} | ${scene.caseId} | ${scene.trial} | ${scene.suite} | ${scene.entry} | ${(scene.duration / 1000).toFixed(1)}s |`)
  }
  if (report.datasetErrors.length > 0) {
    lines.push("", "## Dataset errors", "")
    for (const error of report.datasetErrors) lines.push(`- ${error}`)
  }
  return lines.join("\n")
}
