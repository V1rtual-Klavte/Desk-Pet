#!/usr/bin/env node
/**
 * 与 dev app 的聊天控制通道交互。
 *
 * 用法：
 *   node scripts/desk-pet-chat.mjs chat "刚回来，搞杯咖啡又坐下了。"
 *   node scripts/desk-pet-chat.mjs send "先发出去，不等待回复"
 *   node scripts/desk-pet-chat.mjs cmd observe|dream|proactive|task|report|stop
 *   node scripts/desk-pet-chat.mjs observe [--screenshot]
 *   node scripts/desk-pet-chat.mjs humanize on|off|status
 *   node scripts/desk-pet-chat.mjs choice list|pick <下标>|other|cancel
 *   node scripts/desk-pet-chat.mjs confirm list|allow|session|deny
 *   node scripts/desk-pet-chat.mjs context
 *   node scripts/desk-pet-chat.mjs window
 *   node scripts/desk-pet-chat.mjs sessions
 *   node scripts/desk-pet-chat.mjs tasks
 *   node scripts/desk-pet-chat.mjs proactive-state
 *   node scripts/desk-pet-chat.mjs understanding
 *   node scripts/desk-pet-chat.mjs dataset validate|list|types|review|driver|approve ...
 *   node scripts/desk-pet-chat.mjs eval prepare|start|drive|status|finish|batch|compare|holdout|judge|report|review|stop|rescue ...
 *   node scripts/desk-pet-chat.mjs capture status|sessions
 *   node scripts/desk-pet-chat.mjs wait <id>
 *   node scripts/desk-pet-chat.mjs ready
 *   node scripts/desk-pet-chat.mjs tail [条数]
 *
 * 控制目录默认 data/desk-pet/logs/sim/control；可用 DESKPET_SIM_CONTROL 覆盖。
 * 这不是产品入口：只供开发期演练。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import {
  DEFAULT_DATASET_ROOT,
  buildDriverPackage,
  buildReviewPackage,
  formatReviewPackage,
  loadDataset,
  summarizeDataset,
  writeApprovalRecords,
} from "../test/sim/desk-pet-chat/dataset.mjs";

const root = resolve(import.meta.dirname, "..");
const control = process.env.DESKPET_SIM_CONTROL ?? join(root, "data/desk-pet/logs/sim/control");
const inbox = join(control, "inbox.jsonl");
const outbox = join(control, "outbox.jsonl");
const categoriesPath = join(root, "test/sim/desk-pet-chat/categories.json");

const json = (value) => JSON.stringify(value, null, 2);
const now = () => Date.now();

function append(event) {
  mkdirSync(control, { recursive: true });
  appendFileSync(inbox, `${JSON.stringify(event)}\n`, "utf8");
}

function events() {
  if (!existsSync(outbox)) return [];
  return readFileSync(outbox, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function lastReady() {
  return [...events()].reverse().find((event) => event.type === "ready");
}

async function waitFor(id, timeoutMs = 300_000) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const hit = [...events()].reverse().find((event) => event.id === id
      && ["message", "error", "host", "plan", "choice", "confirm", "context", "clock", "memory_state", "window", "sessions", "tasks", "proactive_state", "understanding", "observe", "dream", "proactive", "task", "report", "capture_started", "capture_trial", "capture_sessions", "capture_finished", "capture_status", "stopped"].includes(event.type));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待回复超时：${id}`);
}

function commandId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function parseFlagArgs(args) {
  const values = new Map();
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const part = args[index];
    if (part === "--json") continue;
    if (!part.startsWith("--")) {
      positional.push(part);
      continue;
    }
    const key = part.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数缺少值：${part}`);
    values.set(key, value);
    index += 1;
  }
  return { values, positional };
}

function printReply(event, asJson) {
  if (asJson) { console.log(json(event)); return; }
  if (event.type === "message") {
    console.log(event.reply ?? "");
    if (event.note) console.error(`note: ${event.note}`);
    return;
  }
  console.log(json(event));
}

function loadCategories() {
  const data = JSON.parse(readFileSync(categoriesPath, "utf8"));
  return Array.isArray(data.categories) ? data.categories : [];
}

async function sendCommand(event) {
  const id = commandId(event.type);
  append({ id, ...event });
  return waitFor(id, 360_000);
}

const [command, ...rest] = process.argv.slice(2);
const asJson = rest.includes("--json");

try {
  switch (command) {
    case "chat": {
      const text = rest.filter((part) => part !== "--json").join(" ").trim();
      if (!text) throw new Error("缺少消息正文");
      const id = commandId("chat");
      append({ id, type: "message", text });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "send": {
      const text = rest.filter((part) => part !== "--json").join(" ").trim();
      if (!text) throw new Error("缺少消息正文");
      const id = commandId("msg");
      append({ id, type: "message", text });
      console.log(id);
      break;
    }
    case "cmd": {
      const type = rest.find((part) => part !== "--json" && !part.startsWith("--"));
      if (!type) throw new Error("缺少命令类型");
      const id = commandId(type);
      append({ id, type, ...(type === "observe" && rest.includes("--screenshot") ? { screenshot: true } : {}) });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "observe": {
      const id = commandId("observe");
      append({ id, type: "observe", ...(rest.includes("--screenshot") ? { screenshot: true } : {}), ...(rest.includes("--force") ? { force: true } : {}) });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "plan": {
      const mode = rest.find((part) => part !== "--json") ?? "auto";
      const id = commandId("plan");
      append({ id, type: "plan", mode });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "task": {
      const argText = rest.filter((part) => part !== "--json").join(" ").trim();
      const options = argText ? JSON.parse(argText) : {};
      const id = commandId("task");
      append({ id, type: "task", ...options });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "host": {
      const method = rest.find((part) => part !== "--json");
      if (!method) throw new Error("缺少 host method");
      const argText = rest.filter((part) => part !== "--json" && part !== method).join(" ").trim();
      const args = argText ? JSON.parse(argText) : {};
      const id = commandId("host");
      append({ id, type: "host", method, args });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "humanize": {
      const mode = rest.find((part) => part !== "--json") ?? "status";
      if (!["on", "off", "status"].includes(mode)) throw new Error("用法：humanize on|off|status");
      const read = await sendCommand({ type: "host", method: "settings_read", args: {} });
      if (read.type === "error") throw new Error(read.error ?? "读取拟人化开关失败");
      const before = read?.result?.values?.["ai.humanizer.enabled"];
      if (mode === "status") {
        console.log(`ai.humanizer.enabled = ${before ?? "未配置（默认 true）"}`);
        break;
      }
      const value = mode === "on";
      if (before !== value) {
        const commit = await sendCommand({ type: "host", method: "settings_commit", args: { changes: [{ key: "ai.humanizer.enabled", value }] } });
        if (commit.type === "error") throw new Error(commit.error ?? "保存拟人化开关失败");
      }
      const afterRead = await sendCommand({ type: "host", method: "settings_read", args: {} });
      if (afterRead.type === "error") throw new Error(afterRead.error ?? "回读拟人化开关失败");
      const after = afterRead?.result?.values?.["ai.humanizer.enabled"];
      console.log(json({ before: before ?? null, after: after ?? null }));
      break;
    }
    case "choice": {
      const action = rest.find((part) => !part.startsWith("--")) ?? "list";
      let event;
      if (action === "list") event = { type: "choice" };
      else if (action === "other") event = { type: "choice", action: "other" };
      else if (action === "cancel") event = { type: "choice", action: "cancel" };
      else if (action === "pick") {
        const index = Number(rest[rest.indexOf("pick") + 1]);
        if (!Number.isInteger(index) || index < 0) throw new Error("用法：choice pick <下标>");
        event = { type: "choice", action: "pick", index };
      } else throw new Error("用法：choice list|pick <下标>|other|cancel");
      const id = commandId("choice");
      append({ id, ...event });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "confirm": {
      const action = rest.find((part) => !part.startsWith("--")) ?? "list";
      const decision = action === "allow" ? "allow_once"
        : action === "session" ? "allow_session"
        : action === "deny" ? "deny" : undefined;
      if (action !== "list" && !decision) throw new Error("用法：confirm list|allow|session|deny");
      const id = commandId("confirm");
      append({ id, type: "confirm", ...(decision ? { decision } : {}) });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "context": {
      const id = commandId("context");
      append({ id, type: "context" });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "window": {
      const id = commandId("window");
      append({ id, type: "window" });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "sessions": {
      const id = commandId("sessions");
      append({ id, type: "sessions" });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "tasks": {
      const id = commandId("tasks");
      append({ id, type: "tasks" });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "proactive-state": {
      const id = commandId("proactive_state");
      append({ id, type: "proactive_state" });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "understanding": {
      const id = commandId("understanding");
      append({ id, type: "understanding" });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "capture": {
      const action = rest.find((part) => !part.startsWith("--")) ?? "status";
      if (!["status", "sessions"].includes(action)) throw new Error("用法：capture status|sessions");
      const id = commandId("capture");
      append({ id, type: action === "sessions" ? "capture_sessions" : "capture_status" });
      printReply(await waitFor(id), asJson);
      break;
    }
    case "dataset": {
      const parsedDatasetArgs = parseFlagArgs(rest);
      const [action = "list", target] = parsedDatasetArgs.positional;
      if (action === "external") {
        const [, externalAction = "catalog", datasetId] = parsedDatasetArgs.positional;
        const { prepareExternalSource, getExternalSource, listExternalSources, downloadPinnedExternalFile } = await import("../test/sim/desk-pet-chat/external/prepare.mjs");
        if (externalAction === "catalog") {
          console.log(json(listExternalSources()));
          break;
        }
        if (["install", "status", "verify", "connect"].includes(externalAction)) {
          const { installExternalDatasets, inspectExternalDatasets } = await import("../test/sim/desk-pet-chat/external/install.mjs");
          const dataset = datasetId ?? "all";
          const values = parsedDatasetArgs.values;
          if (externalAction === "install") {
            const result = await installExternalDatasets({ dataset, repoRoot: root, card: values.get("card-name"), onProgress: event => { if (event.imported || event.phase) console.error(json(event)); } });
            console.log(json(result));
            if (!result.complete) process.exitCode = 1;
          } else if (externalAction === "connect") {
            const { connectInstalledDataset } = await import("../test/sim/desk-pet-chat/external/connect.mjs");
            const datasets = dataset === "all" ? ["multichallenge", "beam", "gaia", "memoryarena"] : [dataset];
            if (!values.get("card-name")) throw new Error("connect 需要 --card-name <运行时Card名称>");
            const results = [];
            for (const id of datasets) {
              if (id === "memoryarena") {
                const { connectMemoryArena } = await import("../test/sim/desk-pet-chat/external/memoryarena-connect.mjs");
                results.push(connectMemoryArena({ repoRoot: root, card: values.get("card-name") }));
              } else results.push(await connectInstalledDataset({ dataset: id, repoRoot: root, card: values.get("card-name") }));
            }
            console.log(json({ results }));
          } else {
            const result = await inspectExternalDatasets({ dataset, repoRoot: root });
            console.log(json(result));
            if (externalAction === "verify" && !result.complete) process.exitCode = 1;
          }
          break;
        }
        if (externalAction === "run" && datasetId === "lhtb") {
          const { startLhtbRun } = await import("../test/sim/desk-pet-chat/external/lhtb.mjs");
          const values = parsedDatasetArgs.values;
          console.log(json(await startLhtbRun({
            taskId: values.get("task"), cardPath: values.get("card"), authorizationPath: values.get("authorization"),
            runId: values.get("run-id") ?? `lhtb-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
            repoRoot: root, modelCallsAuthorized: true,
          })));
          break;
        }
        if (externalAction === "run" && datasetId === "memoryarena") {
          const { runMemoryArenaGroup } = await import("../test/sim/desk-pet-chat/external/memoryarena-connect.mjs");
          const values = parsedDatasetArgs.values;
          const result = await runMemoryArenaGroup({ config: values.get("config"), groupId: Number(values.get("task")), cardPath: values.get("card"), authorizationPath: values.get("authorization"), modelSettingsPath: values.get("model-settings"), runId: values.get("run-id"), repoRoot: root });
          console.log(json(result));
          if (!result.executionComplete) process.exitCode = 1;
          break;
        }
        if (externalAction === "smoke") {
          const { runExternalNativeSmoke } = await import("../test/sim/desk-pet-chat/external/native-smoke.mjs");
          console.log(json(await runExternalNativeSmoke({ repoRoot: root })));
          break;
        }
        if (["tasks", "plan", "run-status"].includes(externalAction) && datasetId === "lhtb") {
          const { listLhtbTasks, planLhtbRun, getLhtbRunStatus } = await import("../test/sim/desk-pet-chat/external/lhtb.mjs");
          const { externalCaseId } = await import("../test/sim/desk-pet-chat/external/index.mjs");
          const values = parsedDatasetArgs.values;
          if (externalAction === "run-status") console.log(json(getLhtbRunStatus({ runId: values.get("run-id") })));
          else if (externalAction === "tasks") console.log(json(listLhtbTasks({ family: values.get("family") ?? "all" })));
          else {
            const taskIds = (values.get("task") ?? "").split(",").filter(Boolean);
            const plan = planLhtbRun({ taskIds, trials: Number(values.get("trials") ?? 1), maxWallSeconds: values.has("max-seconds") ? Number(values.get("max-seconds")) : null });
            console.log(json({ ...plan, caseIds: taskIds.map(id => externalCaseId({ dataset: "lhtb", id, split: "environment" })) }));
          }
          break;
        }
        if (["tasks", "plan"].includes(externalAction) && datasetId === "memoryarena") {
          const { EXTERNAL_DATASET_ROOT, externalCaseId } = await import("../test/sim/desk-pet-chat/external/index.mjs");
          const values = parsedDatasetArgs.values;
          const manifest = JSON.parse(readFileSync(join(root, EXTERNAL_DATASET_ROOT, "memoryarena/dataset/import.json"), "utf8"));
          const tasks = manifest.cases.filter(item => !values.get("config") || item.config === values.get("config"));
          if (externalAction === "tasks") console.log(json({ tasks }));
          else {
            const target = tasks.find(item => item.groupId === Number(values.get("task")));
            if (!values.get("config") || !target) throw new Error("plan memoryarena 需要 --config <配置名> --task <组id>");
            console.log(json({ ...target, caseId: externalCaseId({ dataset: "memoryarena", id: `${target.config}-${target.groupId}`, split: target.config }), sameDataRoot: true, newSessionPerSubtask: true, extractMemory: manifest.extractMemory, requiresExplicitRunAuthorization: true }));
          }
          break;
        }
        if (externalAction === "fetch" && datasetId) {
          const source = getExternalSource(datasetId);
          const values = parsedDatasetArgs.values;
          const selectedUrl = values.get("url") ?? source.files?.[0]?.url;
          if (!selectedUrl) throw new Error("该来源需 --url <固定 revision 的单个公开文件地址>；GAIA 不代取");
          const locked = source.files?.find(file => file.url === selectedUrl);
          const downloaded = await downloadPinnedExternalFile({
            dataset: datasetId, url: selectedUrl,
            outputDir: values.get("output"),
            repoRoot: root, expectedSha256: locked?.sha256,
          });
          console.log(json(downloaded));
          break;
        }
        if (!["prepare", "import"].includes(externalAction) || !datasetId) {
          throw new Error("用法：dataset external catalog | prepare|import <dataset> --input <path> [--revision <commit>] [--split <split>] [--limit <n>] [--output <path>] [--card-name <name>]");
        }
        const values = parsedDatasetArgs.values;
        const inputPath = values.get("input");
        if (!inputPath) throw new Error("外部集需要 --input <已获准访问的本地文件或任务目录>；CLI 不读取账号凭据或绕过数据访问条件");
        getExternalSource(datasetId);
        if (externalAction === "import" && !values.get("card-name")) throw new Error("import 需要 --card-name <运行时 Card 名称>");
        const rawLimit = values.get("limit");
        const limit = rawLimit === undefined ? undefined : Number(rawLimit);
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("--limit 必须是正整数");
        const prepared = await prepareExternalSource({
          dataset: datasetId, inputPath: resolve(inputPath),
          revision: values.get("revision"), split: values.get("split"), limit,
          ...(externalAction === "prepare" ? { outputDir: values.get("output") } : {}),
        });
        if (externalAction === "prepare") {
          console.log(json(prepared.manifest));
          break;
        }
        const { importExternalTasks } = await import("../test/sim/desk-pet-chat/external/index.mjs");
        const imported = importExternalTasks(prepared.tasks, {
          repoRoot: root, root: values.get("output"), card: values.get("card-name"),
          profile: values.get("profile"), clock: values.get("clock"), rawSha256: prepared.manifest.rawSha256,
        });
        console.log(json(imported));
        break;
      }
      if (action === "approve") {
        const { values, positional: approvePositional } = parseFlagArgs(rest.slice(1));
        const caseId = values.get("case") ?? approvePositional[0];
        if (!caseId) {
          throw new Error(
            "用法：dataset approve <caseId> --reviewer-name <name> --session-id <id> --message-id <id> --quote <text> [--decision approved|rejected] [--notes <text>] [--reviewed-at <iso>] [--dataset-root <path>] [--json]",
          );
        }
        const reviewerName = values.get("reviewer-name");
        const sessionId = values.get("session-id");
        const messageId = values.get("message-id");
        const quote = values.get("quote");
        const missing = [
          ["--reviewer-name", reviewerName],
          ["--session-id", sessionId],
          ["--message-id", messageId],
          ["--quote", quote],
        ]
          .filter(([, value]) => !value)
          .map(([flag]) => flag);
        if (missing.length > 0) throw new Error(`缺少审批来源参数：${missing.join(", ")}`);

        const datasetRoot = values.get("dataset-root") ?? DEFAULT_DATASET_ROOT;
        const dataset = loadDataset({ repoRoot: root, root: datasetRoot });
        if (dataset.errors.length > 0) {
          for (const problem of dataset.errors) {
            console.error(`${problem.code}${problem.file ? ` ${problem.file}` : ""}: ${problem.message}`);
          }
          throw new Error("数据集存在结构错误，拒绝写入审批");
        }
        const entry = dataset.cases.find((candidate) => candidate.caseId === caseId);
        if (!entry) throw new Error(`找不到用例：${caseId}`);

        const decision = values.get("decision") ?? "approved";
        const result = writeApprovalRecords({
          repoRoot: root,
          datasetRoot,
          entries: [entry],
          decisions: [{ caseId, decision, notes: values.get("notes") ?? "" }],
          reviewer: { role: "user", name: reviewerName },
          feedbackSource: { kind: "session_message", sessionId, messageId, quote },
          reviewedAt: values.get("reviewed-at") ?? new Date().toISOString(),
        });
        if (result.errors.length > 0) {
          for (const problem of result.errors) console.error(`${problem.code}: ${problem.message}`);
          process.exitCode = 1;
          break;
        }

        const reloaded = loadDataset({ repoRoot: root, root: datasetRoot });
        const label = reloaded.cases.find((candidate) => candidate.caseId === caseId)?.label ?? null;
        const payload = { approval: result.records[0], written: result.written, label };
        if (asJson) {
          console.log(json(payload));
        } else {
          console.log(`审批已写入：${result.written[0]?.path ?? "（无）"}`);
          console.log(`标签：${label ? `${label.tier}/${label.status}` : "未回读"}（${label?.approvalId ?? "无"}）`);
        }
        const expectedTier = decision === "approved" ? "gold" : "silver";
        const expectedStatus = decision === "approved" ? "approved" : "rejected";
        if (!label || label.tier !== expectedTier || label.status !== expectedStatus) {
          console.error(`审批写入后标签不符合预期：期望 ${expectedTier}/${expectedStatus}`);
          process.exitCode = 1;
        }
        break;
      }
      const dataset = loadDataset({
        repoRoot: root,
        root: parsedDatasetArgs.values.get("dataset-root"),
        ...(["review", "driver"].includes(action) && target ? { caseIds: [target] } : {}),
      });
      if (action === "types") {
        const summary = summarizeDataset(dataset);
        const rows = dataset.questionTypes.map((type) => ({
          id: type.id,
          family: type.family,
          name: type.name,
          goal: type.goal,
          capabilities: type.capabilities,
          probeCount: summary.questionTypeCounts[type.id] ?? 0,
          caseCount: summary.caseQuestionTypeCounts[type.id] ?? 0,
        }));
        if (asJson) {
          console.log(
            json({
              path: dataset.questionTypesPath,
              families: dataset.questionTypeFamilies,
              questionTypes: rows,
            }),
          );
        } else {
          console.log(`题型注册表：${dataset.questionTypesPath ?? "（未加载）"}`);
          for (const family of dataset.questionTypeFamilies) {
            const types = rows.filter((row) => row.family === family.id);
            console.log("");
            console.log(`${family.name}（${family.id}） ${types.length} 类：${family.goal}`);
            for (const row of types) {
              console.log(
                `  ${row.id} ${row.name} [${row.capabilities.join(", ")}] 探针 ${row.probeCount} · 用例 ${row.caseCount} — ${row.goal}`,
              );
            }
          }
        }
        if (dataset.questionTypes.length === 0) {
          for (const problem of dataset.errors) {
            console.error(`${problem.code}${problem.file ? ` ${problem.file}` : ""}: ${problem.message}`);
          }
          process.exitCode = 1;
        }
        break;
      }
      if (action === "validate") {
        if (target && !dataset.suites.some((suite) => suite.suiteId === target)) {
          throw new Error(`找不到套件：${target}`);
        }
        const errors = target
          ? dataset.errors.filter((problem) => problem.suiteId === undefined || problem.suiteId === target)
          : dataset.errors;
        const warnings = target
          ? dataset.warnings.filter((warning) => warning.suiteId === undefined || warning.suiteId === target)
          : dataset.warnings;
        const scoped = target
          ? {
              ...dataset,
              suites: dataset.suites.filter((suite) => suite.suiteId === target),
              cases: dataset.cases.filter((entry) => entry.suiteId === target),
            }
          : dataset;
        const summary = summarizeDataset(scoped);
        if (asJson) {
          console.log(json({
            datasetRoot: relative(root, dataset.root),
            errors,
            warnings,
            summary,
          }));
        } else {
          console.log(`数据集：${relative(root, dataset.root)}`);
          console.log(
            `套件 ${summary.suiteCount} · 用例 ${summary.caseCount} · 探针 ${summary.probeCount}（关键 ${summary.criticalProbeCount}） · gold ${summary.goldCount} · silver ${summary.silverCount}`,
          );
          const usedTypes = Object.entries(summary.questionTypeCounts).filter(([, count]) => count > 0);
          if (usedTypes.length > 0) {
            console.log(`题型：${usedTypes.map(([id, count]) => `${id} ${count}`).join(" · ")}`);
          }
          console.log(
            `难度：${Object.entries(summary.difficultyCounts)
              .map(([level, count]) => `L${level} ${count}`)
              .join(" · ")}`,
          );
          for (const problem of errors) {
            console.error(`${problem.code}${problem.file ? ` ${problem.file}` : ""}: ${problem.message}`);
          }
          for (const warning of warnings) {
            console.error(`warning ${warning.code}: ${warning.message}`);
          }
          console.log(errors.length === 0 ? "结构校验通过（不证明测试或评测通过）" : `失败：${errors.length} 个错误`);
        }
        if (errors.length > 0) process.exitCode = 1;
        break;
      }
      if (action === "list") {
        if (target && !dataset.suites.some((suite) => suite.suiteId === target)) {
          throw new Error(`找不到套件：${target}`);
        }
        const rows = (target ? dataset.cases.filter((entry) => entry.suiteId === target) : dataset.cases).map(
          (entry) => ({
            caseId: entry.caseId,
            suiteId: entry.suiteId,
            revision: entry.case.revision,
            tier: entry.label.tier,
            status: entry.label.status,
            categories: entry.case.categories,
            questionTypes: entry.case.questionTypes,
            probeCount: entry.case.probes.length,
            criticalProbeCount: entry.case.probes.filter((probe) => probe.critical).length,
            difficultyCounts: [1, 2, 3, 4, 5].map(
              (level) => entry.case.probes.filter((probe) => probe.difficulty === level).length,
            ),
          }),
        );
        if (asJson) console.log(json(rows));
        else {
          for (const row of rows) {
            const difficulty = row.difficultyCounts.map((count, index) => `L${index + 1} ${count}`).join(" · ");
            console.log(
              `${row.caseId}  ${row.tier}/${row.status}  r${row.revision}  ${row.suiteId}  探针 ${row.probeCount}（关键 ${row.criticalProbeCount}）  难度 ${difficulty}  题型 ${row.questionTypes.length} [${row.questionTypes.join(", ")}]  [${row.categories.join(", ")}]`,
            );
          }
        }
        break;
      }
      if (action === "review") {
        if (!target) throw new Error("用法：dataset review <caseId> [--json]");
        const entry = dataset.cases.find((candidate) => candidate.caseId === target);
        if (!entry) throw new Error(`找不到用例：${target}`);
        const review = buildReviewPackage(entry);
        console.log(asJson ? json(review) : formatReviewPackage(review));
        break;
      }
      if (action === "driver") {
        if (!target) throw new Error("用法：dataset driver <caseId>");
        const entry = dataset.cases.find((candidate) => candidate.caseId === target);
        if (!entry) throw new Error(`找不到用例：${target}`);
        console.log(json(buildDriverPackage(entry)));
        break;
      }
      throw new Error(
        "用法：dataset validate [suiteId] | list [suiteId] | review <caseId> | driver <caseId> | types",
      );
    }
    case "eval": {
      const result = spawnSync(process.execPath, [join(root, "scripts", "sim-eval-run.mjs"), ...rest], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = result.status ?? 1;
      break;
    }
    case "wait": {
      const id = rest.find((part) => part !== "--json");
      if (!id) throw new Error("缺少 id");
      printReply(await waitFor(id), asJson);
      break;
    }
    case "ready": {
      const ready = lastReady();
      if (!ready) throw new Error("控制通道还没有 ready 事件；先启动 DESKPET_SIM_CHAT=1 pnpm dev");
      console.log(json(ready));
      break;
    }
    case "tail": {
      const count = Number(rest.find((part) => part !== "--json") ?? 10);
      for (const event of events().slice(-count)) console.log(JSON.stringify(event));
      break;
    }
    case "suite": {
      const run = rest.includes("--run");
      const roundsIndex = rest.indexOf("--rounds");
      const rawRounds = roundsIndex >= 0 ? rest[roundsIndex + 1] : undefined;
      const roundsValue = Number(rawRounds);
      const rounds = Number.isFinite(roundsValue) && roundsValue > 0 ? Math.round(roundsValue) : 1;
      const ids = rest.filter((part, index) =>
        part !== "--run" && part !== "--json" && part !== "--rounds" && index !== roundsIndex + 1)
        .join(",").split(",").map((part) => part.trim()).filter(Boolean);
      const categories = loadCategories();
      if (ids.length === 0) {
        console.log("可用类别：");
        for (const category of categories) console.log(`- ${category.id} (${category.name}) auto=${category.auto}`);
        break;
      }
      const unknown = ids.filter((id) => !categories.some((category) => category.id === id));
      if (unknown.length) throw new Error(`未知类别：${unknown.join(", ")}；可用：${categories.map((category) => category.id).join(", ")}`);
      const selected = ids.map((id) => categories.find((category) => category.id === id));
      console.log(`轮数：${rounds}（由调用方显式指定，不截断）`);
      for (const category of selected) {
        console.log(`\n## ${category.id} · ${category.name}`);
        console.log(`目标：${category.goal}`);
        console.log(`方式：${category.auto ? "可自动跑组件" : "Claude 驱动对话"}`);
        if (category.dependsOn?.length) console.log(`依赖：${category.dependsOn.join(", ")}`);
        for (const step of category.steps ?? []) console.log(`- ${step}`);
        console.log(`证据：${(category.evidence ?? []).join("、")}`);
      }
      if (!run) {
        console.log("\n提示：加 --run 只跑有 autoCommands 的组件类别；聊天/plan/tools 等仍由 Claude 按步骤驱动。");
        break;
      }
      for (let round = 1; round <= rounds; round += 1) {
        console.log(`\n===== round ${round}/${rounds} =====`);
        for (const category of selected) {
          const commands = category.autoCommands ?? [];
          if (commands.length === 0) {
            console.log(`\n[skip] ${category.id} 没有自动命令，按上面的步骤由 Claude 驱动`);
            continue;
          }
          console.log(`\n[run] ${category.id}`);
          for (const cmd of commands) {
            const result = await sendCommand(cmd);
            console.log(JSON.stringify({ round, step: cmd.type, result }));
          }
        }
      }
      break;
    }
    default:
      console.error("用法：chat <text> | send <text> | cmd <type> [--screenshot] | observe [--screenshot] [--force] | host <method> [json] | humanize on|off|status | choice list|pick N|other|cancel | confirm list|allow|session|deny | context | window | sessions | tasks | proactive-state | understanding | capture status|sessions | plan <mode> | task [json] | dataset validate [suiteId] | dataset list [suiteId] | dataset types | dataset review <caseId> | dataset driver <caseId> | dataset approve <caseId> --reviewer-name <name> --session-id <id> --message-id <id> --quote <text> | eval prepare|start|drive|status|finish|batch|compare|holdout|judge|report|review|stop|rescue ... | suite <ids> [--rounds N] [--run] | wait <id> | ready | tail [n]");
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
