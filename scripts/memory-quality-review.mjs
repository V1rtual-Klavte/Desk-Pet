#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { applyMemoryQualityReviews, createMemoryQualityReviewTemplate } from "../test/memory-quality/index.mjs"

function usage() {
  return [
    "Usage:",
    "  node scripts/memory-quality-review.mjs prepare --report <run.json> [--out <review.json>]",
    "  node scripts/memory-quality-review.mjs apply --report <run.json> --review <review.json> [--out <scored.json>]",
  ].join("\n")
}

function options(args) {
  const result = { command: args[0] }
  for (let index = 1; index < args.length; index += 1) {
    const key = args[index]
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    result[key.slice(2)] = value
    index += 1
  }
  return result
}

async function json(path) {
  const text = await readFile(resolve(path), "utf8")
  // e2e_complete reports have an explicit status line; retain plain JSON support for review packets.
  return JSON.parse(text.replace(/^(?:PASS|FAIL)\r?\n/, ""))
}

async function main() {
  const args = options(process.argv.slice(2).filter(arg => arg !== "--"))
  if (!args.report || !["prepare", "apply"].includes(args.command) || (args.command === "apply" && !args.review)) {
    process.stderr.write(`${usage()}\n`)
    process.exitCode = 2
    return
  }
  const report = await json(args.report)
  const output = args.command === "prepare"
    ? await createMemoryQualityReviewTemplate(report)
    : await applyMemoryQualityReviews(report, await json(args.review))
  const defaultPath = args.command === "prepare" ? `${args.report}.review.json` : `${args.report}.scored.json`
  const target = resolve(args.out ?? defaultPath)
  await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  process.stdout.write(`${target}\n`)
  process.exitCode = args.command === "prepare" || output.gates?.complete !== true || output.gates?.eachCapabilityAnswerAtLeast90 === null ? 2 : output.gates?.qualityThresholdsPassed === true ? 0 : 1
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
