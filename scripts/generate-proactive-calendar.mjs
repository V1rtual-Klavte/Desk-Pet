#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

// Build-time only. Product runtime uses the generated local table and never fetches calendars.
const firstYear = 2026, lastYear = 2035
const monthNames = ["正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"]
const dayNames = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"]
const festivals = new Map([["1/1", "春节"], ["1/15", "元宵节"], ["5/5", "端午节"], ["7/7", "七夕"],
  ["8/15", "中秋节"], ["9/9", "重阳节"], ["12/8", "腊八节"]])
const pad = value => String(value).padStart(2, "0")
const root = resolve(import.meta.dirname, "..")
const sourceIndex = process.argv.indexOf("--source-dir")
const sourceDir = sourceIndex >= 0 ? resolve(process.argv[sourceIndex + 1]) : null
const sources = [], events = []
for (let year = firstYear; year <= lastYear; year++) {
  const url = `https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T${year}c.txt`
  const bytes = sourceDir ? await readFile(resolve(sourceDir, `${year}.txt`)) : new Uint8Array(await (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`calendar source ${year}: HTTP ${response.status}`)
    return response.arrayBuffer()
  })())
  const text = new TextDecoder().decode(bytes)
  sources.push({ year, url, sha256: createHash("sha256").update(bytes).digest("hex") })
  const rows = [...text.matchAll(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\S+)\s+星期\S+(?:\s+(\S+))?\s*$/gm)]
  const expected = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365
  if (rows.length !== expected) throw new Error(`calendar ${year}: ${rows.length} dates, expected ${expected}`)
  const firstMonth = rows.find(row => monthNames.includes(row[4].replace("閏", "")))?.[4]
  if (!firstMonth) throw new Error(`calendar ${year}: lunar month marker missing`)
  let month = (monthNames.indexOf(firstMonth.replace("閏", "")) + 11) % 12 + 1
  let leap = false, solarCount = 0
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const date = `${row[1]}-${pad(row[2])}-${pad(row[3])}`
    const token = row[4]
    let day = dayNames.indexOf(token) + 1
    const marker = monthNames.indexOf(token.replace("閏", ""))
    if (marker >= 0) { month = marker + 1; day = 1; leap = token.startsWith("閏") }
    if (!day) throw new Error(`calendar ${year}: unsupported lunar date ${token}`)
    const name = !leap ? festivals.get(`${month}/${day}`) : undefined
    if (name) events.push({ localDate: date, kind: "lunar_festival", name, key: `lunar:${month}:${day}` })
    if (!leap && month === 1 && day === 1 && index > 0) {
      const prior = rows[index - 1]
      events.push({ localDate: `${prior[1]}-${pad(prior[2])}-${pad(prior[3])}`, kind: "lunar_festival", name: "除夕", key: "lunar:new-year-eve" })
    }
    if (row[5]) { events.push({ localDate: date, kind: "solar_term", name: row[5], key: `term:${row[5]}` }); solarCount++ }
  }
  if (solarCount !== 24) throw new Error(`calendar ${year}: ${solarCount} solar terms, expected 24`)
}
const output = { coverage: { from: firstYear, until: lastYear, sourceTimezone: "Asia/Hong_Kong" }, sources,
  events: events.sort((a, b) => a.localDate.localeCompare(b.localDate) || a.key.localeCompare(b.key)) }
await mkdir(resolve(root, "src/services/proactive/content"), { recursive: true })
await writeFile(resolve(root, "src/services/proactive/content/calendar.json"), `${JSON.stringify(output, null, 2)}\n`)
process.stdout.write(`calendar ${firstYear}–${lastYear}: ${events.length} source-backed events\n`)
