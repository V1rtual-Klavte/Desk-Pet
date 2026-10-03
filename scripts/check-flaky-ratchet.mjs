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
// 两种用法：
//   · `node scripts/check-flaky-ratchet.mjs` —— 读基线/观测并判定，新增即非零退出
//   · `import { compareFlaky }` —— 守卫自身的测试用（守卫失效必须被测出来，而不是假定生效）
//
// [保留已登记 §4.2] Node 侧工具用 console，避免污染 data_root/logs/deskpet.log

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "test", "flaky-baseline.json");
const observedPath = join(root, "test", "reports", "flaky.json");

/**
 * 核心比对：观测中基线没有的条目 = 新 FLAKY（ok=false，带名称与累计次数）；
 * 基线中观测未复现的条目 = 可回收（只提示，不失败）。
 *
 * 键判断用 hasOwnProperty：用例名可能恰好叫 `constructor` / `toString` 这类
 * Object.prototype 上的名字，`name in baseline` 会把它们当成已有基线放行。
 */
export function compareFlaky(baseline, observed) {
  const newFlaky = Object.keys(observed)
    .filter(name => !Object.prototype.hasOwnProperty.call(baseline, name))
    .sort()
    .map(name => ({ name, count: observed[name] }));
  const resolved = Object.keys(baseline).filter(name => !Object.prototype.hasOwnProperty.call(observed, name));
  return { newFlaky, resolved, ok: newFlaky.length === 0 };
}

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

function isMain() {
  // 用真实路径比较：macOS 的 /tmp 是 /private/tmp 的符号链接，Node 默认把主模块解析为
  // 真实路径写进 import.meta.url，而 process.argv[1] 保留符号链接形态 —— 直接比较会在
  // 符号链接路径下**静默跳过 main**（守卫什么都没做却以 0 退出）。vitest 导入时
  // argv[1] 是 vitest 自己的入口，真实路径不同，不会误触发。
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const baseline = readObject(baselinePath, `基线 ${relative(root, baselinePath)}`);
  if (baseline === undefined) {
    console.error(`FLAKY 棘轮：缺少基线 ${relative(root, baselinePath)} —— 拦不了任何东西，按失败处理；首次创建写入空对象 {}`);
    process.exit(1);
  }
  const observed = readObject(observedPath, `观测 ${relative(root, observedPath)}`) ?? {};

  const { newFlaky, resolved, ok } = compareFlaky(baseline, observed);
  if (!ok) {
    console.error("新增 FLAKY（棘轮只缩不放，要么修掉波动，要么在下一次提交里显式写进基线）：");
    for (const { name, count } of newFlaky) console.error(`  · ${name}（累计 ${count} 次）`);
    process.exit(1);
  }

  console.log(`FLAKY 棘轮：未新增（基线 ${Object.keys(baseline).length} 条，本次观测 ${Object.keys(observed).length} 条）`);
  if (resolved.length > 0) {
    console.log(`基线中本次未复现（可在下一次提交里回收）：${resolved.join(" / ")}`);
  }
}

if (isMain()) main();
