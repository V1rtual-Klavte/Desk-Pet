#!/usr/bin/env node
// 快层（L2/L3）重试入口 —— W6「波动与假绿」的机制，CI 门禁用的就是它：
//
//   首次未通过 → 原样重试一次 → 仍失败 = 真失败（退出码 1）
//   重试才通过 = 波动，逐条标记 `⚠ FLAKY` 并**累计**写入 test/reports/flaky.json；
//   棘轮脚本（scripts/check-flaky-ratchet.mjs）拿它与 test/flaky-baseline.json
//   比对，观测到基线之外的新 FLAKY 即失败 —— 不允许「标了 FLAKY 就没人管」。
//
// 「跳过与超时永远不算通过」（契约「测试纪律」规则 8）是本脚本的硬约束，
// 不能被重试逻辑冲掉：恢复的唯一判据是重试运行里 status === "passed"，
// skipped / pending / todo 都不算恢复，仍失败者（超时表现为 failed）直接判真失败。
// 首跑以非零退出、却没有可归因的失败用例（进程级 / 收集器错误）时同样判失败：
// 这类失败没有名字可以进棘轮，静默放行等于让它下次以同样方式消失。
//
// 结果文件由 vitest.config.ts 的 DESKPET_VITEST_JSON_OUT 钩子写出 —— reporter
// 清单只在配置里定义一份（CLI `--reporter=` 会整体替换 reporters，把 caseId
// 收集器这条层契约门禁挤掉，所以这里不用 CLI）。
//
// 用法：node scripts/run-vitest-with-retry.mjs unit|integration [vitest 过滤参数…]
// 过滤参数只给本地用（带过滤时不落 caseId、不做层覆盖判定，与直接跑 vitest 一致）。
//
// [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECTS = new Set(["unit", "integration"]);
const project = process.argv[2] ?? "unit";
const extraArgs = process.argv.slice(3);
if (!PROJECTS.has(project)) {
  console.error(`[重试入口] 未知层 "${project}"：只覆盖 L2/L3（unit / integration）；L4 走 pnpm run test:e2e`);
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = join(root, "test", "reports");
const flakyPath = join(reportsDir, "flaky.json");
// 直连 vitest 的 bin 入口而不是 spawn("pnpm")：Windows 上 .cmd shim 不经 shell 无法解析，
// 而走 node + vitest.mjs 两端一致、也不需要 shell。
const vitestEntry = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

function attemptPath(attempt) {
  return join(reportsDir, `vitest-${project}-attempt${attempt}.json`);
}

function runVitest(attempt) {
  mkdirSync(reportsDir, { recursive: true });
  const outFile = attemptPath(attempt);
  const result = spawnSync(
    process.execPath,
    [vitestEntry, "run", "--project", project, ...extraArgs],
    { cwd: root, env: { ...process.env, DESKPET_VITEST_JSON_OUT: outFile }, stdio: "inherit" },
  );
  if (result.error) {
    console.error(`[重试入口] 无法启动 vitest：${result.error.message}`);
    process.exit(1);
  }
  return { status: result.status, outFile };
}

/** 逐用例状态表：key = 归一化相对路径 :: 测试全名，值 = vitest 的 status。 */
function readRunStatuses(file) {
  if (!existsSync(file)) return undefined;
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`[重试入口] 无法解析 ${relative(root, file)}：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const statuses = new Map();
  for (const testFile of report.testResults ?? []) {
    const path = isAbsolute(testFile.name) ? relative(root, testFile.name) : testFile.name;
    const normalized = path.split(sep).join("/");
    for (const assertion of testFile.assertionResults ?? []) {
      statuses.set(`${normalized} :: ${assertion.fullName}`, assertion.status);
    }
  }
  return statuses;
}

const first = runVitest(1);
if (first.status === 0) {
  // 绿跑不需要比对；json 缺失不影响结论，但说明配置钩子坏了，留痕别装看不见。
  if (!existsSync(first.outFile)) {
    console.error(`[重试入口] 提示：${relative(root, first.outFile)} 未生成 —— vitest.config.ts 的 DESKPET_VITEST_JSON_OUT 钩子可能失效`);
  }
  process.exit(0);
}

console.error(`\n[重试] ${project} 首次未通过（exit=${first.status}），重试一次以区分「真失败」与「波动」`);
const second = runVitest(2);

const firstStatuses = readRunStatuses(first.outFile);
const secondStatuses = readRunStatuses(second.outFile);

if (second.status !== 0) {
  console.error(`[${project}] 重试仍失败 —— 真失败，不是波动`);
  process.exit(1);
}

// 重试绿了：恢复的判据是「首跑 failed 且重试 passed」。先确认首跑确实有失败用例可归因。
if (firstStatuses === undefined) {
  console.error(`[${project}] 首次以 exit=${first.status} 退出，但没有可读的逐用例结果 —— 失败无法归因，不判为波动`);
  process.exit(1);
}
const firstFailed = [...firstStatuses].filter(([, status]) => status === "failed").map(([key]) => key);
if (firstFailed.length === 0) {
  console.error(`[${project}] 首次以 exit=${first.status} 退出，但没有任何失败用例（进程级 / 收集器错误）—— 不判为波动`);
  process.exit(1);
}
if (secondStatuses === undefined) {
  console.error(`[重试入口] 重试通过但结果文件缺失/不可读，无法定位波动用例 —— 检查 vitest.config.ts 的 DESKPET_VITEST_JSON_OUT 钩子`);
  process.exit(1);
}

const recovered = [];
const unrecovered = [];
for (const key of firstFailed) {
  // 规则 8：只有明确的 passed 才算恢复；skipped / pending / todo 不算通过。
  if (secondStatuses.get(key) === "passed") recovered.push(key);
  else unrecovered.push(key);
}
if (unrecovered.length > 0) {
  console.error(`[${project}] 首跑失败的用例在重试里没有全部通过（含被跳过 / 未执行），不判为波动：`);
  for (const key of unrecovered) console.error(`  · ${key}（重试状态：${secondStatuses.get(key) ?? "未出现"}）`);
  process.exit(1);
}

// 重试才过 → 波动。记下来，别让它悄悄过去。
let prev = {};
if (existsSync(flakyPath)) {
  try {
    prev = JSON.parse(readFileSync(flakyPath, "utf8"));
  } catch (error) {
    console.error(`[重试入口] ${relative(root, flakyPath)} 无法解析（${error instanceof Error ? error.message : String(error)}），从空清单重新累计`);
    prev = {};
  }
}
for (const key of recovered) prev[key] = (prev[key] ?? 0) + 1;
// 累计次数高的排前面（计划要求），同数按名字稳定排序。
const sorted = Object.fromEntries(
  Object.entries(prev).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);
writeFileSync(flakyPath, `${JSON.stringify(sorted, null, 2)}\n`);

for (const [name, count] of Object.entries(sorted)) {
  console.error(`⚠ FLAKY  ${name}  （累计 ${count} 次）`);
}
console.error(`[${project}] 重试通过：${recovered.length} 条 FLAKY 已累计进 ${relative(root, flakyPath)}；新增项会被 scripts/check-flaky-ratchet.mjs 拦下`);
process.exit(0);
