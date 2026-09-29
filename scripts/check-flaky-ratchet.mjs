#!/usr/bin/env node
// FLAKY 棘轮守卫：清单只允许变小或持平 —— 观测到基线之外的新 FLAKY 即失败。
//
//   基线 test/flaky-baseline.json（提交进仓库）= 已接受的波动清单；
//   观测 test/reports/flaky.json（scripts/run-vitest-with-retry.mjs 累计写入，gitignore 排除）
//   = 本次运行实际看到的波动。
//
// 失败即「要么把波动修掉，要么在下一次提交里显式写进基线」—— 不允许它无声消失。
// 缺基线视为守卫失效（什么都拦不住），按失败处理；观测文件缺失视为本次没有 FLAKY。
// 基线里本次未复现的条目只提示、不失败：棘轮管的是「不放」，回收可以随下一次提交做。
//
// [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "test", "flaky-baseline.json");
const observedPath = join(root, "test", "reports", "flaky.json");

function readObject(path, what) {
  if (!existsSync(path)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`FLAKY 棘轮：${what} 无法解析（${error instanceof Error ? error.message : String(error)}）—— 守卫失效，按失败处理`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`FLAKY 棘轮：${what} 不是 JSON 对象 —— 守卫失效，按失败处理`);
    process.exit(1);
  }
  return parsed;
}

const baseline = readObject(baselinePath, `基线 ${relative(root, baselinePath)}`);
if (baseline === undefined) {
  console.error(`FLAKY 棘轮：缺少基线 ${relative(root, baselinePath)} —— 拦不了任何东西，按失败处理；首次创建写入空对象 {}`);
  process.exit(1);
}
const observed = readObject(observedPath, `观测 ${relative(root, observedPath)}`) ?? {};

const added = Object.keys(observed).filter(name => !Object.prototype.hasOwnProperty.call(baseline, name));
if (added.length > 0) {
  console.error("新增 FLAKY（棘轮只缩不放，要么修掉波动，要么在下一次提交里显式写进基线）：");
  for (const name of added.sort()) console.error(`  · ${name}（累计 ${observed[name]} 次）`);
  process.exit(1);
}

console.log(`FLAKY 棘轮：未新增（基线 ${Object.keys(baseline).length} 条，本次观测 ${Object.keys(observed).length} 条）`);
const stale = Object.keys(baseline).filter(name => !Object.prototype.hasOwnProperty.call(observed, name));
if (stale.length > 0) {
  console.log(`基线中本次未复现（可在下一次提交里回收）：${stale.join(" / ")}`);
}
