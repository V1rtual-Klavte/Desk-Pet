#!/usr/bin/env node
// 缺陷注入（W7）：往产品源码植入已知缺陷，跑一遍快层（unit + integration），
// 看快层能不能抓到 —— 抓不到 = 该处行为没有测试覆盖，或覆盖它的断言没有区分力。
//
//   用法：
//     node scripts/mutate.mjs            注入 + 跑快层，输出命中率与逐条漏掉清单
//     node scripts/mutate.mjs --dry-run  只打印每条注入点（位置 + 改动），不写盘、不跑测试
//
// 安全约束（Global Constraints / 契约）：
//   · 每条注入在跑之前把原文件读进内存，跑完立即还原；任何异常路径都要经过 finally 还原。
//   · SIGINT / SIGTERM 时还原所有「在途」文件再退出 —— Ctrl-C 不能留残留。
//   · 全部跑完后逐文件核对内容与运行前一致；不一致即按失败退出（注入残留是产品缺陷）。
//   · 注入产物一律不进 commit：本脚本不做任何 git 操作，也不新增文件。
//
// 命中率口径：一条注入让快层变红即「抓到」。语法都改坏了的注入不计入分母（单独列为无效注入）；
// 测试前置/超时/工具失败等"并非断言抓到"的红不算抓到（按运行失败单独报告，不计分母）。
//
// 算子与计划 Task 4 Step 1 的算子集一致：条件反转 / 边界值偏移 / 分支删除 / 返回常数。
// 两处实现收窄（本仓代码无分号、注释里也常出现 `if (…)` 与 `return …` 字样）：
//   · 匹配只在「代码区」进行 —— 注释与字符串/模板字面量里的字节参与匹配即误伤；
//     --dry-run 会报告「朴素匹配被收窄掉」的位置，便于核对。
//   · 返回常数优先翻转布尔字面量（true ↔ false），没有布尔返回才退化为 return <标识符> → undefined；
//     直接拿 `return false` 换 `return undefined` 这类同义改写在布尔上下文里是无法观测的假漏。
// [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "test", "mutation-baseline.json");
const dryRun = process.argv.includes("--dry-run");

// ── 代码区掩码 ──

/**
 * 标记每个字符是否在「代码区」：注释、单/双引号字符串、模板字面量一律标 0。
 * 模板字面量整体按不透明字符串处理（`${}` 内部也标 0）—— 宁可少注入，不在字符串里改字节。
 * 正则字面量不建模（现有目标文件里没有含引号歧义的正则；新增目标先看 --dry-run 输出）。
 */
function codeMask(src) {
  const mask = new Uint8Array(src.length); // 默认 0 = 非代码
  let i = 0;
  let state = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; i += 2; continue; }
      if (c === "'") { state = "single"; i += 1; continue; }
      if (c === '"') { state = "double"; i += 1; continue; }
      if (c === "`") { state = "template"; i += 1; continue; }
      mask[i] = 1;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i += 2; continue; }
      i += 1;
      continue;
    }
    // single / double / template
    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (c === "\\") { i += 2; continue; }
    if (c === quote) { state = "code"; i += 1; continue; }
    i += 1;
  }
  return mask;
}

const isCode = (mask, index) => mask === null || mask[index] === 1;

/** 从 openIndex 处的 open 符号找到配对的 close 符号；跳过非代码区（字符串/模板里的括号不算数）。 */
function findMatching(src, mask, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (!isCode(mask, i)) continue;
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

// ── 注入算子 ──
// 每个算子 plan(src, mask) 返回 { start, end, replacement } | null。mask === null 表示不做
// 代码区过滤（--dry-run 用它对比「朴素匹配」与「收窄后匹配」，报告误伤）。

const OPERATORS = [
  {
    id: "条件反转",
    what: "if (x) ↔ if (!x)：只反转「条件整体就是一个标识符（可带点链、可带一个前导 !）」的 if",
    plan(src, mask) {
      const re = /\bif\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (!isCode(mask, m.index)) continue;
        const open = m.index + m[0].length - 1; // "(" 的下标
        const close = findMatching(src, mask, open, "(", ")");
        if (close < 0) continue;
        const raw = src.slice(open + 1, close);
        const cond = raw.trim();
        if (!/^!?\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(cond)) continue;
        const start = open + 1 + (raw.length - raw.trimStart().length);
        const replacement = cond.startsWith("!") ? cond.slice(1).trimStart() : `!${cond}`;
        if (replacement === cond) continue;
        return { start, end: start + cond.length, replacement };
      }
      return null;
    },
  },
  {
    id: "边界值偏移",
    what: "第一个「比较 + 整数字面量」的常数 +1（差一错误）；排除 => 箭头与 << / >> 的第二个符号",
    plan(src, mask) {
      const re = /(<=|>=|<|>)(\s*)(0[xX][0-9a-fA-F]+|\d[\d_]*)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (!isCode(mask, m.index)) continue;
        const before = src[m.index - 1] ?? "";
        if (before === "=") continue; // => 箭头
        if (before === m[1][0]) continue; // << / >>
        const literal = m[3];
        const hex = literal.startsWith("0x") || literal.startsWith("0X");
        const numeric = hex ? parseInt(literal, 16) : Number(literal.replaceAll("_", ""));
        if (!Number.isFinite(numeric)) continue;
        const start = m.index + m[1].length + m[2].length;
        return {
          start,
          end: start + literal.length,
          replacement: hex ? `0x${(numeric + 1).toString(16)}` : `${numeric + 1}`,
        };
      }
      return null;
    },
  },
  {
    id: "分支删除",
    what: "第一个「if (...) { return ... }」单语句块整体删除（守卫消失）",
    plan(src, mask) {
      const re = /\bif\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (!isCode(mask, m.index)) continue;
        const open = m.index + m[0].length - 1;
        const close = findMatching(src, mask, open, "(", ")");
        if (close < 0) continue;
        let brace = close + 1;
        while (brace < src.length && /\s/.test(src[brace])) brace += 1;
        if (src[brace] !== "{") continue;
        const braceEnd = findMatching(src, mask, brace, "{", "}");
        if (braceEnd < 0) continue;
        // 块体必须恰好是一条 return（分号可省，本仓代码无分号）；多条语句的块不猜。
        if (!/^\s*return\b[^;]*(?:;)?\s*$/.test(src.slice(brace + 1, braceEnd))) continue;
        return { start: m.index, end: braceEnd + 1, replacement: "" };
      }
      return null;
    },
  },
  {
    id: "返回常数",
    what: "return true ↔ return false；没有布尔返回才退化为 return <标识符> → undefined",
    plan(src, mask) {
      const boolRe = /\breturn\s+(true|false)(?=\s*(?:;|\n|$))/g;
      let m;
      while ((m = boolRe.exec(src)) !== null) {
        if (!isCode(mask, m.index)) continue;
        const start = m.index + m[0].length - m[1].length;
        return { start, end: start + m[1].length, replacement: m[1] === "true" ? "false" : "true" };
      }
      const identRe = /\breturn\s+(!?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?=\s*(?:;|\n|$))/g;
      while ((m = identRe.exec(src)) !== null) {
        if (!isCode(mask, m.index)) continue;
        if (m[1] === "undefined" || m[1] === "null") continue; // 换成同值常量不算注入
        const start = m.index + m[0].length - m[1].length;
        return { start, end: start + m[1].length, replacement: "undefined" };
      }
      return null;
    },
  },
];

// ── 注入执行 ──

/** 语法校验（只查解析错误）：语法都坏了的注入不算一次有效注入，不计入分母。 */
function parses(file, content) {
  const result = ts.transpileModule(content, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length === 0;
}

const applyEdit = (src, { start, end, replacement }) => src.slice(0, start) + replacement + src.slice(end);

/** 在途注入：Ctrl-C 等信号路径也要还原。 */
const inFlight = new Map();
let restoredBySignal = false;
function restoreAll() {
  for (const [file, original] of inFlight) {
    try {
      writeFileSync(file, original);
      console.error(`[还原] 信号退出，已还原 ${relative(root, file)}`);
    } catch (error) {
      console.error(`[还原失败] ${relative(root, file)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  inFlight.clear();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (restoredBySignal) return;
    restoredBySignal = true;
    restoreAll();
    process.exit(130);
  });
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
if (!Array.isArray(baseline.files) || baseline.files.length === 0) {
  console.error(`缺陷注入：${relative(root, baselinePath)} 的 files 为空 —— 没有目标就没有观测，按失败处理`);
  process.exit(1);
}
const targets = baseline.files.map(f => join(root, f));

const origins = new Map();
for (const target of targets) {
  origins.set(target, readFileSync(target, "utf8"));
}

const rows = []; // { file, op, caught, detail }
const skipped = []; // 该文件没有此算子的可注入点
const invalid = []; // 语法改坏，不计入分母
const narrowed = []; // 朴素匹配落在注释/字符串里，被收窄掉

for (const target of targets) {
  const original = origins.get(target);
  const mask = codeMask(original);
  const rel = relative(root, target);

  for (const op of OPERATORS) {
    const naive = op.plan(original, null);
    const point = op.plan(original, mask);
    if (naive && (!point || naive.start !== point.start)) {
      narrowed.push(`${rel} :: ${op.id}（朴素匹配在第 ${lineOf(original, naive.start)} 行，落在注释/字符串内，已忽略）`);
    }
    if (!point) {
      const reason = naive
        ? "匹配只出现在注释/字符串里"
        : "文件里没有此算子的可注入点";
      skipped.push(`${rel} :: ${op.id}（${reason}）`);
      continue;
    }

    const mutant = applyEdit(original, point);
    const line = lineOf(original, point.start);
    const before = original.slice(point.start, point.end);
    const detail = `第 ${line} 行：${before.trim()} → ${point.replacement.trim() || "(删除整块)"}`;

    if (!parses(target, mutant)) {
      invalid.push(`${rel} :: ${op.id}（${detail}；语法不通过，未计入分母）`);
      continue;
    }

    if (dryRun) {
      rows.push({ rel, op: op.id, verdict: "dry-run", detail });
      continue;
    }

    let status = -1;
    let output = "";
    inFlight.set(target, original);
    try {
      writeFileSync(target, mutant);
      if (readFileSync(target, "utf8") !== mutant) {
        console.error(`[注入失败] ${rel} 写入后内容不符 —— 结果不可信，立即停止`);
        process.exit(1);
      }
      const r = spawnSync(
        "pnpm",
        ["exec", "vitest", "run", "--project", "unit", "--project", "integration", "--reporter=dot"],
        { cwd: root, stdio: "pipe", encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
      );
      status = r.status ?? -1;
      output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    } finally {
      writeFileSync(target, original);
      inFlight.delete(target);
    }

    if (readFileSync(target, "utf8") !== original) {
      console.error(`[还原失败] ${rel} 与运行前不一致 —— 立即停止，先修还原路径`);
      writeFileSync(target, original);
      process.exit(1);
    }

    if (status === -1) {
      invalid.push(`${rel} :: ${op.id}（${detail}；快层未正常退出：运行失败/超时，不计入分母）${output.trim().split("\n").slice(-1)[0] ?? ""}`);
    } else if (/Transform failed|Parse error|SyntaxError/.test(output)) {
      invalid.push(`${rel} :: ${op.id}（${detail}；快层在解析期就红了，不计入分母）`);
    } else if (status !== 0) {
      rows.push({ rel, op: op.id, verdict: "抓到", detail });
    } else {
      rows.push({ rel, op: op.id, verdict: "漏掉", detail });
    }
  }
}

// ── 还原完整性核对（快层也可能留下运行期产物，这里只管被注入的源码文件）──
let leftovers = 0;
for (const target of targets) {
  if (readFileSync(target, "utf8") !== origins.get(target)) {
    console.error(`[还原失败] ${relative(root, target)} 在整轮结束后仍有残留`);
    writeFileSync(target, origins.get(target));
    leftovers += 1;
  }
}

// ── 汇总 ──
if (dryRun) {
  console.log(`缺陷注入 --dry-run：${targets.length} 个目标文件，${rows.length} 条可注入点（未写盘、未跑测试）`);
} else {
  const caught = rows.filter(r => r.verdict === "抓到").length;
  const missed = rows.filter(r => r.verdict === "漏掉");
  const total = caught + missed.length;
  console.log(`\n缺陷注入：${targets.length} 个目标文件，有效注入 ${total} 条 —— 抓到 ${caught}，漏掉 ${missed.length}`);
  console.log(`\n缺陷注入命中率：${caught}/${total} = ${total ? ((100 * caught) / total).toFixed(1) : "n/a"}%`);
}

console.log("\n逐条结果：");
for (const row of rows) console.log(`  ${row.verdict}  ${row.rel} :: ${row.op}  （${row.detail}）`);

if (skipped.length > 0) {
  console.log("\n跳过的算子（该文件无此注入点，不计入分母）：");
  for (const s of skipped) console.log(`  · ${s}`);
}
if (narrowed.length > 0) {
  console.log("\n收窄记录（算子朴素匹配落在注释/字符串里，已忽略 —— 防误伤）：");
  for (const n of narrowed) console.log(`  · ${n}`);
}
if (invalid.length > 0) {
  console.log("\n无效注入（未计入分母）：");
  for (const i of invalid) console.log(`  · ${i}`);
}

if (!dryRun) {
  const missed = rows.filter(r => r.verdict === "漏掉");
  if (missed.length > 0) {
    console.log("\n漏掉的注入（= 这些行为没有可区分的断言）：");
    for (const m of missed) console.log(`  · ${m.rel} :: ${m.op}  （${m.detail}）`);
  }
  console.log("\n本轮只记录观测值，不设阈值（契约：稳定后再设棘轮）。");
}

// 还原失败按失败退出；命中率本身不设阈值。
process.exit(leftovers > 0 ? 1 : 0);
