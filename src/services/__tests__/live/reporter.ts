// ==========================================
// Reporter — 测试报告格式化
// ==========================================

import type { TestReport, SceneResult } from "./types"

export function formatReport(report: TestReport, format: "terminal" | "json" | "markdown"): string {
  switch (format) {
    case "json": return JSON.stringify(report, null, 2)
    case "markdown": return formatMarkdown(report)
    default: return formatTerminal(report)
  }
}

function formatTerminal(report: TestReport): string {
  const lines: string[] = []
  const { summary } = report

  lines.push("")
  lines.push(`📋 Live Test Report — ${report.timestamp}`)
  lines.push("━".repeat(50))
  lines.push("")

  for (const scene of report.scenes) {
    const icon = scene.status === "pass" ? "✅" : scene.status === "skip" ? "⏭️" : "❌"
    lines.push(`${icon} ${scene.module} / ${scene.contractId} / ${scene.scene}    ${(scene.duration / 1000).toFixed(1)}s`)

    for (const turn of scene.turns) {
      const turnIcon = turn.assertions.every(a => a.pass) ? "✓" : "✗"
      lines.push(`   ${turnIcon} T${turn.index} "${turn.userText.slice(0, 40)}${turn.userText.length > 40 ? "…" : ""}" — ${turn.assertions.filter(a => a.pass).length}/${turn.assertions.length} checks pass`)

      for (const a of turn.assertions.filter(a => !a.pass)) {
        lines.push(`      ✗ ${a.type}: ${a.error || "assertion failed"}`)
      }
    }

    if (scene.error) {
      lines.push(`   ⚠ ${scene.error}`)
    }
    lines.push("")
  }

  lines.push("━".repeat(50))
  const passRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(0) : "0"
  lines.push(`Scenes: ${summary.passed}/${summary.total} pass (${passRate}%)  ` +
    `⏱ ${(summary.totalDuration / 1000).toFixed(1)}s`)
  if (summary.failed > 0) lines.push(`❌ ${summary.failed} failed  ⏭️ ${summary.skipped} skipped  ⏰ ${summary.timeout} timeout`)
  lines.push("")

  return lines.join("\n")
}

function formatMarkdown(report: TestReport): string {
  const lines: string[] = []
  lines.push(`# Live Test Report — ${report.timestamp}`)
  lines.push("")
  lines.push("| Status | Module | Scene | Duration | Turns |")
  lines.push("|--------|--------|-------|----------|-------|")

  for (const scene of report.scenes) {
    const icon = scene.status === "pass" ? "✅" : "❌"
    lines.push(`| ${icon} | ${scene.module} | ${scene.scene} | ${(scene.duration / 1000).toFixed(1)}s | ${scene.turns.length} |`)
  }

  lines.push("")
  lines.push(`**Summary:** ${report.summary.passed}/${report.summary.total} passed | ` +
    `${report.summary.failed} failed | ${report.summary.totalDuration}ms`)

  return lines.join("\n")
}
