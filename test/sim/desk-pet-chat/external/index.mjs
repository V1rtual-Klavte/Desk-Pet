/** Public benchmark input → existing schema-4 suites. No model calls or grading. */
import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DATASET_SCHEMA_VERSION, hashCanonical, loadDataset, validateCaseSpec,
  validateFixtureSpec, validateCaseAgainstFixture,
  escapeDriverText,
} from "../dataset.mjs";

const DEFAULT_CLOCK = "2026-01-01T00:00:00.000Z";
export const EXTERNAL_DATASET_ROOT = "test/sim/desk-pet-chat/external/.data";
const TEST_OUTPUT_ROOT = "test/.tmp/external-eval";

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

export function externalCaseId(task) {
  return `${task.dataset}-${hashCanonical({ id: task.id, split: task.split }).slice(7, 23)}`;
}

/** A locked hash covers every normalized input, including references and readiness gates. */
export function buildExternalCase(task, { card, profile = "default", clock = DEFAULT_CLOCK, rawSha256, fixtureKey, fixtureTitle } = {}) {
  requireText(card, "card");
  for (const key of ["dataset", "id", "revision", "split", "title"]) requireText(task[key], key);
  if (task.schemaVersion !== 1) throw new Error("外部任务 schemaVersion 必须为 1");
  if (!task.readiness?.runnable || task.readiness.blockers?.length) {
    throw new Error(`外部任务尚不可运行：${(task.readiness?.blockers ?? ["readiness 未确认"]).join("；")}`);
  }
  // Stateful environments and external assets need their actual isolation/staging adapter.
  // A caller cannot turn them into runnable tasks by just flipping readiness.runnable.
  if (task.mode === "environment" || task.environment?.required) throw new Error("环境型任务需要环境执行适配器，不能转换成静态聊天题");
  const assets = task.assets ?? [];
  if (assets.some(asset => !asset.sourcePath || !asset.targetPath || !asset.sha256 || !Number.isSafeInteger(asset.bytes))) throw new Error("带附件任务需要隔离资产装载，不能只导入题面");
  if (!["task", "fixed-history"].includes(task.mode)) throw new Error(`未知外部任务模式：${task.mode}`);
  if (!Array.isArray(task.turns) || task.turns.length !== 1) throw new Error("静态适配只接受一个待测目标回合；依赖任务不能拆平");
  if (!Array.isArray(task.history)) throw new Error("外部任务 history 必须是数组");
  const originalPrompt = requireText(task.turns[0].prompt, "turns[0].prompt");
  const escaped = escapeDriverText(originalPrompt);
  const prompt = assets.length ? `${escaped}\n\n附件已放入本次隔离工作目录：\n${assets.map(asset => `- {{dataRoot}}/${asset.targetPath}`).join("\n")}` : escaped;
  const referenceAnswers = task.oracle?.referenceAnswers;
  const criteria = task.oracle?.criteria;
  if (!Array.isArray(referenceAnswers) || !Array.isArray(criteria)) throw new Error("外部任务缺少参考答案或判据数组");
  for (const value of [...referenceAnswers, ...criteria]) requireText(value, "oracle");
  if (referenceAnswers.length + criteria.length === 0) throw new Error("外部任务不能没有可核对的参考结果");
  const sourceUrl = new URL(requireText(task.source?.url, "source.url"));
  if (sourceUrl.protocol !== "https:") throw new Error("外部来源必须是 https URL");
  const caseId = externalCaseId(task);
  const fixtureId = fixtureKey ? `${task.dataset}-${fixtureKey}-history` : `${caseId}-history`;
  const base = Date.parse(clock);
  if (!Number.isFinite(base)) throw new Error("clock 不是有效时间");
  const history = task.history.length ? task.history : [{ role: "user", content: "准备接收下一项任务。" }];
  const adaptationNotes = [...(task.adaptationNotes ?? []), "沿用产品 Card、工具与权限链；由独立 coding-agent judge 判分，结果只作外部适配观测。"];
  if (!task.history.length) adaptationNotes.push("无上游历史；初始会话只预置一条中性的任务准备消息。");
  if (task.mode === "fixed-history") adaptationNotes.push("上游历史按原角色 direct-seed；只运行目标回合，不评历史生成、在线记忆抽取或全程连续执行。");
  const fixture = {
    schemaVersion: DATASET_SCHEMA_VERSION, fixtureId, card, profile, clock: new Date(base).toISOString(),
    loading: { mode: "direct-seed", note: "仅预置固定历史，不预置期望答案或已抽取记忆；目标回答走真实产品链。" },
    initialSession: {
      id: fixtureKey ? `${fixtureId}-session` : `${caseId}-session`, title: fixtureTitle ?? task.title,
      messages: history.map((message, index) => {
        if (!["user", "assistant"].includes(message.role)) throw new Error("历史角色必须保留为 user / assistant");
        return { id: `history-${index + 1}`, role: message.role, content: requireText(message.content, "history.content"), at: new Date(base - history.length + index).toISOString() };
      }),
    },
    initialMemory: [], allowedPreparation: ["seed_session"],
  };
  const questionType = task.questionTypes?.[0] ?? "execution";
  const spec = {
    schemaVersion: DATASET_SCHEMA_VERSION, caseId, revision: 1, familyId: task.dataset,
    title: task.title, categories: task.categories ?? ["chat"], questionTypes: [questionType],
    source: {
      kind: "external", ref: sourceUrl.href, excerpt: originalPrompt,
      note: "锁定的公开上游输入；本地导入保持 silver，不能自动晋级用户 gold。",
      upstream: {
        dataset: task.dataset, id: task.id, revision: task.revision, split: task.split,
        sha256: rawSha256 ?? hashCanonical(task), license: requireText(task.source.license, "source.license"),
        protocol: "adapted", adaptationNotes,
        ...(assets.length ? { assets } : {}),
      },
    },
    precondition: { card, profile, fixtureId, time: { mode: "fixed" }, hostCapabilities: ["chat", "session", ...(task.categories?.includes("tools") ? ["tools"] : [])] },
    userRole: { knownFacts: [], goal: originalPrompt, tone: "保留上游用户要求", allowedActions: ["发送原始目标请求"], mustNotReveal: ["参考答案与判分条件"] },
    driver: [{ id: "target", kind: "message", text: prompt, at: new Date(base + 1).toISOString() }],
    probes: [{
      id: "upstream-result", after: "target", window: "last-assistant", rubric: "external.expected-result",
      questionType, polarity: "required", critical: true, difficulty: task.difficulty ?? 3,
      description: "实际目标回答满足上游题目、参考结果与判据；不能用自述完成代替证据。",
      expectation: { referenceAnswers: [...referenceAnswers], criteria: [...criteria] }, evidence: ["target-answer"],
    }],
    checkpoints: [{ id: "target-finished", after: "target", wait: "assistant_message" }],
    oracle: { allowedAlternatives: ["在不改变题意与事实的前提下接受语义等价表述；明确格式约束仍按上游判据核对。"] },
    pathConstraints: { requiredOrder: ["target"], forbiddenSideEffects: [], allowedToolSubstitutions: ["产品实际可用的 bash、文件与 MCP 工具"] },
    evidence: [{ id: "target-answer", kind: "session_entry", source: "target", description: "真实目标回合与产品回复" }],
    governance: { purpose: "development", unresolvedPoints: [], notes: adaptationNotes },
  };
  validateCaseSpec(spec);
  validateFixtureSpec(fixture);
  validateCaseAgainstFixture(spec, fixture);
  return { case: spec, fixture };
}

/** Persistent local data and explicit test scratch outputs share the same path checks. */
export function resolveExternalOutput(repoRoot, root) {
  const output = resolve(repoRoot, root);
  const permitted = [EXTERNAL_DATASET_ROOT, TEST_OUTPUT_ROOT].some(root => {
    const rel = relative(resolve(repoRoot, root), output);
    return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
  });
  if (!permitted) {
    throw new Error(`外部数据集只写入 ${EXTERNAL_DATASET_ROOT} 或测试临时目录 ${TEST_OUTPUT_ROOT} 下，避免原始数据进入受跟踪题库`);
  }
  for (let current = output; current !== dirname(current); current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("外部数据集输出路径不能经过符号链接");
    if (current === resolve(repoRoot)) break;
  }
  return output;
}

/** Write one immutable suite under the ignored persistent data directory. */
export function importExternalTasks(tasks, { repoRoot = process.cwd(), root, card, profile, clock, rawSha256 } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("没有可导入的外部任务");
  const datasets = new Set(tasks.map(task => task.dataset));
  if (datasets.size !== 1) throw new Error("一次导入只接受同一个数据集");
  const dataset = tasks[0].dataset;
  if (!/^[a-z][a-z0-9-]*$/.test(dataset)) throw new Error("外部数据集 id 非法");
  const output = resolveExternalOutput(repoRoot, root ?? `${EXTERNAL_DATASET_ROOT}/${dataset}/dataset`);
  if (existsSync(output)) throw new Error(`导入目录已存在，拒绝覆盖：${output}`);
  const registry = loadDataset({ repoRoot });
  const entries = [];
  const blocked = [];
  const seen = new Set();
  for (const task of tasks) {
    const key = externalCaseId(task);
    if (seen.has(key)) throw new Error(`上游任务身份重复：${task.id}`);
    seen.add(key);
    if (!task.readiness?.runnable || task.readiness.blockers?.length || task.environment?.required || task.mode === "environment" || task.assets?.some(asset => !asset.sourcePath || !asset.targetPath || !asset.sha256)) {
      blocked.push({ id: task.id, mode: task.mode, blockers: [...(task.readiness?.blockers ?? []), ...(task.environment?.required || task.mode === "environment" ? ["需要环境执行适配器"] : []), ...(task.assets?.length ? ["需要隔离附件装载"] : [])] });
      continue;
    }
    const entry = buildExternalCase(task, { card, profile, clock, rawSha256 });
    validateCaseSpec(entry.case, { categoryIds: registry.categories.map(item => item.id), questionTypeIds: registry.questionTypes.map(item => item.id) });
    entries.push(entry);
  }
  const temporary = `${output}.staging-${crypto.randomUUID()}`;
  const suiteDir = join(temporary, "suites", dataset);
  mkdirSync(temporary, { recursive: true });
  const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  if (entries.length) {
    mkdirSync(join(suiteDir, "cases"), { recursive: true });
    mkdirSync(join(suiteDir, "fixtures"));
    mkdirSync(join(suiteDir, "approvals"));
    for (const entry of entries) {
      write(join(suiteDir, "cases", `${entry.case.caseId}.case.json`), entry.case);
      write(join(suiteDir, "fixtures", `${entry.fixture.fixtureId}.json`), entry.fixture);
    }
    write(join(suiteDir, "suite.json"), { schemaVersion: DATASET_SCHEMA_VERSION, suiteId: dataset, revision: 1, purpose: "development", title: `${dataset} 公开集适配`, caseIds: entries.map(entry => entry.case.caseId) });
  }
  const manifest = { schemaVersion: 1, dataset, protocol: "adapted", inputHash: hashCanonical(tasks), rawSha256: rawSha256 ?? null, imported: entries.length, blocked, cases: entries.map(entry => ({ upstreamId: entry.case.source.upstream.id, caseId: entry.case.caseId })) };
  write(join(temporary, "import.json"), manifest);
  write(join(temporary, "tasks.json"), tasks);
  if (entries.length) {
    const checked = loadDataset({ repoRoot, root: temporary });
    if (checked.errors.length) throw new Error(`导入结构校验失败（暂存保留）：${checked.errors.map(error => error.message).join("；")}`);
  }
  renameSync(temporary, output);
  return { ...manifest, datasetRoot: output };
}
