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
 *   node scripts/desk-pet-chat.mjs wait <id>
 *   node scripts/desk-pet-chat.mjs ready
 *   node scripts/desk-pet-chat.mjs tail [条数]
 *
 * 控制目录默认 data/desk-pet/logs/sim/control；可用 DESKPET_SIM_CONTROL 覆盖。
 * 这不是产品入口：只供开发期演练。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const control = process.env.DESKPET_SIM_CONTROL ?? join(root, "data/desk-pet/logs/sim/control");
const inbox = join(control, "inbox.jsonl");
const outbox = join(control, "outbox.jsonl");
const categoriesPath = join(root, "test/sim/desk-pet-chat/categories.json");
mkdirSync(control, { recursive: true });

const json = (value) => JSON.stringify(value, null, 2);
const now = () => Date.now();

function append(event) {
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
      && ["message", "error", "host", "plan", "choice", "confirm", "context", "window", "sessions", "tasks", "proactive_state", "understanding", "observe", "dream", "proactive", "task", "report", "stopped"].includes(event.type));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待回复超时：${id}`);
}

function commandId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
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
      console.error("用法：chat <text> | send <text> | cmd <type> [--screenshot] | observe [--screenshot] [--force] | host <method> [json] | humanize on|off|status | choice list|pick N|other|cancel | confirm list|allow|session|deny | context | window | sessions | tasks | proactive-state | understanding | plan <mode> | task [json] | suite <ids> [--rounds N] [--run] | wait <id> | ready | tail [n]");
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
