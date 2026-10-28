import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectInstalledDataset, verifyConnectedDataset } from "../../sim/desk-pet-chat/external/connect.mjs";
import { verifyPublicDatasetInstall } from "../../sim/desk-pet-chat/external/beam-install.mjs";
import { resolveGaiaAssets, stageExternalAssets, validateExternalAsset } from "../../sim/desk-pet-chat/external/assets.mjs";
import { buildEnvironmentCase } from "../../sim/desk-pet-chat/external/environment-turn.mjs";
import { normalizeGaia } from "../../sim/desk-pet-chat/external/batch-one.mjs";
import { loadDataset } from "../../sim/desk-pet-chat/dataset.mjs";
import { EXTERNAL_DATASET_ROOT, type ExternalTask } from "../../sim/desk-pet-chat/external/index.mjs";

vi.mock("../../sim/desk-pet-chat/external/beam-install.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../../sim/desk-pet-chat/external/beam-install.mjs")>(),
  verifyPublicDatasetInstall: vi.fn(async () => ({ ready: true })),
}));

const ROOT = resolve(process.cwd());
const MC_REVISION = "670fd81f270314d0f8f82b34fcfe2187fd28f699";
const owned: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchRepo(label: string) {
  const parent = join(ROOT, "test/.tmp/external-eval");
  mkdirSync(parent, { recursive: true });
  const repo = mkdtempSync(join(parent, `${label}-`));
  owned.push(repo);
  for (const file of ["categories.json", "question-types.json"]) {
    const target = join(repo, "test/sim/desk-pet-chat", file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, readFileSync(join(ROOT, "test/sim/desk-pet-chat", file)));
  }
  cpSync(join(ROOT, "test/ideal-traces"), join(repo, "test/ideal-traces"), { recursive: true });
  return repo;
}

function mcTask(id: string, history: ExternalTask["history"] = [{ role: "user", content: "Remember the original appointment is at noon." }, { role: "assistant", content: "I will remember noon." }]): ExternalTask {
  return {
    schemaVersion: 1, dataset: "multichallenge", id, revision: MC_REVISION, split: "test",
    mode: "fixed-history", title: `MultiChallenge ${id}`, categories: ["chat", "context"],
    questionTypes: ["multi-turn"], difficulty: 3,
    history, turns: [{ id: `${id}-target`, prompt: `What time is the appointment for ${id}?` }],
    oracle: { referenceAnswers: [`The appointment ${id} is at noon.`], criteria: ["Use the fixed conversation context."] },
    assets: [], environment: { required: false }, readiness: { runnable: true, blockers: [] },
    adaptationNotes: ["Synthetic compile fixture for the compiler contract test."],
    source: { url: "https://huggingface.co/datasets/ScaleAI/MultiChallenge", license: "CC-BY-4.0" },
  };
}

function groupsWith(tasks: ReturnType<typeof mcTask>[][]) {
  return tasks;
}

function writeInstall(repoRoot: string, probes: number) {
  const dataRoot = join(repoRoot, EXTERNAL_DATASET_ROOT, "multichallenge");
  mkdirSync(dataRoot, { recursive: true });
  const sourceManifest = { dataset: "multichallenge", revision: MC_REVISION, files: [], counts: { probes } };
  writeFileSync(join(dataRoot, "install-manifest.json"), JSON.stringify({
    status: "complete", completeCounts: true, files: [], sourceManifest,
    expected: { probes },
  }));
}

async function compile(repoRoot: string, tasks: ReturnType<typeof mcTask>[][]) {
  const count = tasks.reduce((sum, group) => sum + group.length, 0);
  writeInstall(repoRoot, count);
  return connectInstalledDataset({
    dataset: "multichallenge", repoRoot, card: "Test Card", groups: groupsWith(tasks) as any,
  });
}

function externalTaskFixture() {
  const secretAnswer = "EXPECTED: the small island is north of the harbor.";
  const entry = buildEnvironmentCase({
    dataset: "memoryarena", taskId: "travel-plan-01", split: "group_travel_planner",
    turns: [
      { sessionId: "preferences", userMessage: "I prefer quiet hotels and vegetarian food.", environmentStep: { config: "group_travel_planner", groupId: 42, subtaskIndex: -1 } },
      { sessionId: "itinerary", userMessage: "Plan the first day around the museum and park.", environmentStep: { config: "group_travel_planner", groupId: 42, subtaskIndex: 0 } },
    ],
    extractMemory: true,
    expectations: [
      { referenceAnswers: [secretAnswer], criteria: ["Use the actual travel environment state."] },
      { referenceAnswers: ["Do not invent a reservation."], criteria: ["Keep the ordered subtask context."] },
    ],
  }, { card: "Test Card" });
  return { entry, secretAnswer };
}

describe("公开集完整接入与隔离", () => {
  it("固定来源校验失败时禁止新编译和复用已有套件 [external-connect-source-verification-gate]", async () => {
    const repoRoot = scratchRepo("connect-source-gate");
    const groups = [[mcTask("source-gate")]];
    writeInstall(repoRoot, 1);
    const options = { dataset: "multichallenge" as const, repoRoot, card: "Test Card", groups };
    const output = join(repoRoot, EXTERNAL_DATASET_ROOT, "multichallenge/dataset");
    vi.mocked(verifyPublicDatasetInstall).mockResolvedValueOnce({ ready: false, reason: "incomplete-install", error: "Source receipt missing" });
    await expect(connectInstalledDataset(options)).rejects.toThrow("Source installation verification failed: Source receipt missing");
    expect(existsSync(output)).toBe(false);
    await connectInstalledDataset(options);
    const before = readFileSync(join(output, "import.json"));
    vi.mocked(verifyPublicDatasetInstall).mockResolvedValueOnce({ ready: false, reason: "incomplete-install", error: "Pinned file changed" });
    await expect(connectInstalledDataset(options)).rejects.toThrow("Source installation verification failed: Pinned file changed");
    expect(readFileSync(join(output, "import.json"))).toEqual(before);
  });

  it("编译完整 MultiChallenge 规模时按对话共享 fixture，不复制每个 probe 的历史 [external-connect-mc266-shared-fixture]", async () => {
    const repo = scratchRepo("connect-mc266");
    const common = Array.from({ length: 265 }, (_, index) => mcTask(`mc-${index + 1}`));
    const other = mcTask("mc-266", [
      { role: "user", content: "The train leaves at 09:40." },
      { role: "assistant", content: "I have the departure time." },
    ]);
    const result = await compile(repo, [common, [other]]);
    expect(result).toMatchObject({ ready: true, imported: 266, fixtures: 2, blocked: [] });
    const manifest = JSON.parse(readFileSync(join(result.datasetRoot, "import.json"), "utf8"));
    expect(manifest.cases).toHaveLength(266);
    expect(new Set(manifest.cases.slice(0, 265).map((item: any) => item.fixtureId)).size).toBe(1);
    expect(manifest.cases[265]!.fixtureId).not.toBe(manifest.cases[0]!.fixtureId);
    expect(manifest.fixtures).toBe(2);
    const full = loadDataset({ repoRoot: repo, root: result.datasetRoot });
    expect(full.errors).toEqual([]);
    expect(full.cases).toHaveLength(266);
    expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot: repo })).toMatchObject({ ready: true, imported: 266, fixtures: 2 });
    const taskRows = JSON.parse(readFileSync(join(result.datasetRoot, "tasks.json"), "utf8"));
    expect(taskRows).toHaveLength(266);
    expect(taskRows.every((row: any) => !("history" in row) && row.historyRef && row.historyMessages === 2)).toBe(true);
  });

  it("按目标 case 载入时不会读取另一对话的损坏或超大 fixture [external-connect-selected-case-skips-other-fixture]", async () => {
    const repo = scratchRepo("connect-select");
    const result = await compile(repo, [[mcTask("selected")], [mcTask("unselected", [{ role: "user", content: "different history" }])]]);
    const all = loadDataset({ repoRoot: repo, root: result.datasetRoot });
    expect(all.errors).toEqual([]);
    const selectedId = all.cases[0]!.caseId;
    const unselectedPath = join(repo, all.cases[1]!.fixturePath);
    writeFileSync(unselectedPath, `${"x".repeat(2 * 1024 * 1024)}\n`);
    const selected = loadDataset({ repoRoot: repo, root: result.datasetRoot, caseIds: [selectedId] });
    expect(selected.errors).toEqual([]);
    expect(selected.cases.map(entry => entry.caseId)).toEqual([selectedId]);
    expect(loadDataset({ repoRoot: repo, root: result.datasetRoot }).errors.length).toBeGreaterThan(0);
  });

  it("原始数据哈希或文件收据漂移会失效；审批存在时拒绝重编译覆盖 [external-connect-receipt-and-approval-protection]", async () => {
    const repo = scratchRepo("connect-approval");
    const groups = [[mcTask("approval-protected")]];
    const result = await compile(repo, groups);
    const manifestPath = join(result.datasetRoot, "import.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const casePath = join(result.datasetRoot, manifest.files.find((item: any) => item.path.endsWith(".case.json")).path);
    const original = readFileSync(casePath);
    writeFileSync(casePath, Buffer.concat([original, Buffer.from(" ")]));
    expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot: repo }).ready).toBe(false);
    writeFileSync(casePath, original);
    manifest.files[0].sha256 = "sha256:" + "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot: repo }).ready).toBe(false);
    manifest.files[0].sha256 = "sha256:" + createHash("sha256").update(readFileSync(join(result.datasetRoot, manifest.files[0].path)).toString()).digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const approvalDir = join(result.datasetRoot, "suites/multichallenge/approvals");
    mkdirSync(approvalDir, { recursive: true });
    const approvalPath = join(approvalDir, "review.json");
    writeFileSync(approvalPath, "approved-for-review");
    writeFileSync(casePath, "corrupted after approval");
    await expect(connectInstalledDataset({ dataset: "multichallenge", repoRoot: repo, card: "Test Card", groups })).rejects.toThrow(/approvals; refusing to replace/);
    expect(readFileSync(approvalPath, "utf8")).toBe("approved-for-review");
  });

  it("空文件集合、缺失收据或重复用例不能借 imported 数量伪装完整 [external-connect-complete-file-set]", async () => {
    const repo = scratchRepo("connect-files");
    const result = await compile(repo, [[mcTask("file-set")]]);
    const path = join(result.datasetRoot, "import.json");
    const original = JSON.parse(readFileSync(path, "utf8"));
    for (const patch of [{ files: [] }, { files: original.files.slice(1) }, { fixtures: 0 }, { cases: [], imported: 1 }, { cases: [original.cases[0], original.cases[0]], imported: 2 }]) {
      writeFileSync(path, JSON.stringify({ ...original, ...patch }));
      expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot: repo }).ready).toBe(false);
    }
    writeFileSync(path, JSON.stringify(original));
    expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot: repo }).ready).toBe(true);
  });

  it("删除用例和对应收据并调整计数仍须匹配套件全集 [external-connect-suite-manifest-consistency]", async () => {
    const repoRoot = scratchRepo("connect-suite");
    const result = await compile(repoRoot, [[mcTask("retained")], [mcTask("removed", [{ role: "user", content: "Another conversation." }])]]);
    const path = join(result.datasetRoot, "import.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const removed = manifest.cases.pop();
    const removedPaths = new Set([
      `suites/multichallenge/cases/${removed.caseId}.case.json`,
      `suites/multichallenge/fixtures/${removed.fixtureId}.json`,
    ]);
    manifest.files = manifest.files.filter((item: any) => !removedPaths.has(item.path));
    manifest.imported -= 1;
    manifest.fixtures -= 1;
    for (const file of removedPaths) rmSync(join(result.datasetRoot, file));
    writeFileSync(path, JSON.stringify(manifest));
    expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot })).toMatchObject({
      ready: false, issues: expect.arrayContaining(["suite case identities differ from import manifest"]),
    });
  });

  it("用例身份或 fixture 改绑即使更新文件哈希仍失效 [external-connect-case-fixture-consistency]", async () => {
    const repoRoot = scratchRepo("connect-case-identity");
    const result = await compile(repoRoot, [[mcTask("case-identity")]]);
    const path = join(result.datasetRoot, "import.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const receipt = manifest.files.find((item: any) => item.path.endsWith(".case.json"));
    const casePath = join(result.datasetRoot, receipt.path);
    const original = JSON.parse(readFileSync(casePath, "utf8"));
    for (const spec of [
      { ...original, caseId: "different-case" },
      { ...original, precondition: { ...original.precondition, fixtureId: "different-fixture" } },
    ]) {
      const content = JSON.stringify(spec);
      writeFileSync(casePath, content);
      receipt.sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      writeFileSync(path, JSON.stringify(manifest));
      expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot })).toMatchObject({
        ready: false, issues: expect.arrayContaining([`case identity or fixture differs: ${receipt.path}`]),
      });
    }
  });

  it("拒绝导入清单中的目录逃逸或指向仓库外的符号链接 [external-connect-path-and-symlink-guard]", async () => {
    const repo = scratchRepo("connect-path");
    const result = await compile(repo, [[mcTask("path-guard")]]);
    const manifestPath = join(result.datasetRoot, "import.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const outside = join(repo, "outside.json");
    writeFileSync(outside, "outside");
    manifest.files[0].path = "../outside.json";
    manifest.files[0].sha256 = `sha256:${createHash("sha256").update(readFileSync(outside)).digest("hex")}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot: repo }).ready).toBe(false);

    const freshRepo = scratchRepo("connect-symlink");
    const fresh = await compile(freshRepo, [[mcTask("symlink-guard")]]);
    const freshManifestPath = join(fresh.datasetRoot, "import.json");
    const freshManifest = JSON.parse(readFileSync(freshManifestPath, "utf8"));
    const item = freshManifest.files.find((row: any) => row.path.endsWith(".case.json"));
    const target = join(fresh.datasetRoot, item.path);
    const linkedPayload = join(freshRepo, "payload-outside.json");
    writeFileSync(linkedPayload, readFileSync(target));
    rmSync(target);
    symlinkSync(linkedPayload, target);
    expect(verifyConnectedDataset({ dataset: "multichallenge", repoRoot: freshRepo }).ready).toBe(false);
  });

  it("GAIA 附件只有通过本地 SHA-256 与路径检查才会复制到隔离 run 目录 [external-assets-pin-stage-and-path-guard]", () => {
    const repo = scratchRepo("gaia-assets");
    const raw = join(repo, EXTERNAL_DATASET_ROOT, "gaia/raw/2023/validation");
    mkdirSync(raw, { recursive: true });
    const source = join(raw, "chart.pdf");
    writeFileSync(source, "authorized local attachment");
    const task = normalizeGaia([{
      task_id: "gaia-asset-1", Question: "Read the chart.", Level: 2, "Final answer": "blue",
      file_path: "2023/validation/chart.pdf", file_name: "chart.pdf",
    }], { revision: "682dd723ee1e1697e00360edccf2366dc8418dd9", split: "validation" })[0]!;
    const resolved = resolveGaiaAssets([task], { repoRoot: repo })[0]!;
    expect(resolved.readiness).toEqual({ runnable: true, blockers: [] });
    const assets = resolved.assets.map(validateExternalAsset);
    const runDataRoot = join(repo, "test/.tmp/sim-eval-assets");
    const staged = stageExternalAssets(assets, { repoRoot: repo, dataRoot: runDataRoot });
    expect(staged).toHaveLength(1);
    expect(readFileSync(join(runDataRoot, "inputs/chart.pdf"), "utf8")).toBe("authorized local attachment");
    expect(staged[0]!.sha256).toBe(assets[0]!.sha256);
    writeFileSync(source, "changed after input binding");
    expect(() => stageExternalAssets(assets, { repoRoot: repo, dataRoot: join(repo, "test/.tmp/sim-eval-assets-2") })).toThrow(/has changed/);
    const escape = normalizeGaia([{
      task_id: "gaia-asset-escape", Question: "Read outside.", Level: 1, "Final answer": "blocked",
      file_path: "../../outside.pdf", file_name: "outside.pdf",
    }], { revision: "682dd723ee1e1697e00360edccf2366dc8418dd9", split: "validation" })[0]!;
    expect(resolveGaiaAssets([escape], { repoRoot: repo })[0]!.readiness.runnable).toBe(false);
  });

  it("环境适配保留有序多会话、逐轮 expectation 只进 oracle，不伪装成 driver 消息 [environment-case-ordered-oracle-isolation]", () => {
    const { entry, secretAnswer } = externalTaskFixture();
    expect(entry.case.driver.map(step => step.kind === "message" ? step.text : step.method)).toEqual([
      "chat_new_session", "I prefer quiet hotels and vegetarian food.", "memory_dreaming_sweep", "chat_new_session",
      "Plan the first day around the museum and park.",
    ]);
    expect(entry.case.checkpoints.map(point => point.wait)).toEqual([
      "session_created", "assistant_message", "memory_extraction_end", "session_created", "assistant_message",
    ]);
    expect(entry.case.probes.map((probe: any) => probe.expectation?.referenceAnswers?.[0])).toContain(secretAnswer);
    expect(JSON.stringify(entry.case.driver)).not.toContain(secretAnswer);
    expect(entry.case.pathConstraints.requiredOrder).toEqual(entry.case.driver.map(step => step.id));
  });

  it("prepare 把 MCP 与超时覆盖写入本次隔离 CONFIG，不改仓库 CONFIG [environment-mcp-timeout-isolated-config]", () => {
    const base = join(ROOT, "test/.tmp/external-eval");
    mkdirSync(base, { recursive: true });
    const sandbox = mkdtempSync(join(base, "environment-prepare-"));
    owned.push(sandbox);
    const beforeTemplate = readFileSync(join(ROOT, "CONFIG.yaml"), "utf8");
    const { entry } = externalTaskFixture();
    const datasetRoot = join(sandbox, "dataset");
    const suite = join(datasetRoot, "suites/memoryarena");
    for (const dir of ["cases", "fixtures", "approvals"]) mkdirSync(join(suite, dir), { recursive: true });
    writeFileSync(join(suite, "cases", `${entry.case.caseId}.case.json`), JSON.stringify(entry.case));
    writeFileSync(join(suite, "fixtures", `${entry.fixture.fixtureId}.json`), JSON.stringify(entry.fixture));
    writeFileSync(join(suite, "suite.json"), JSON.stringify({ schemaVersion: 4, suiteId: "memoryarena", revision: 1, purpose: "development", title: "Env test", caseIds: [entry.case.caseId] }));
    const cardPath = join(sandbox, "card.md");
    writeFileSync(cardPath, "---\nid: env-test-card\nname: Test Card\nversion: 1\n---\nA scratch Card.\n");
    const authorizationPath = join(sandbox, "authorization.json");
    writeFileSync(authorizationPath, JSON.stringify({
      schemaVersion: 1, approvedBy: "unit-test", approvedAt: "2026-01-01T00:00:00.000Z",
      scope: { caseIds: [entry.case.caseId], purpose: "development", models: ["provider/model-under-test"], data: "isolated" },
      budget: { messages: 5, tokens: 1000, minutes: 20, trials: 1, repairs: 0 }, holdout: false,
    }));
    const mcpServer = { name: "isolated-trip-tools", enabled: true, transport: "stdio", command: "node", args: ["scratch-mcp.js"] };
    const mcpPath = join(sandbox, "mcp-server.json");
    writeFileSync(mcpPath, JSON.stringify(mcpServer));
    const runId = `external-env-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const runRoot = join(ROOT, "test/.tmp", `sim-eval-${runId}`);
    owned.push(runRoot);
    const result = spawnSync(process.execPath, [
      join(ROOT, "scripts/sim-eval-run.mjs"), "prepare", "--dataset-root", datasetRoot,
      "--case", entry.case.caseId, "--card", cardPath, "--authorization", authorizationPath,
      "--mcp-server", mcpPath, "--run-id", runId,
    ], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(readFileSync(join(runRoot, "runner.json"), "utf8"));
    const isolatedConfig = yaml.load(readFileSync(state.configPath, "utf8")) as any;
    expect(isolatedConfig.tools.mcp.servers).toEqual([mcpServer]);
    expect(isolatedConfig.ai.loop.turnTimeoutMs).toBeGreaterThanOrEqual(20 * 60_000);
    expect(state.externalMcpServer).toEqual(mcpServer);
    expect(JSON.parse(readFileSync(join(runRoot, "external-environment.json"), "utf8"))).toEqual({ config: "group_travel_planner", groupId: 42, subtaskIndex: -1 });
    expect(state.configPath).toContain(join("test", ".tmp", `sim-eval-${runId}`));
    expect(readFileSync(join(ROOT, "CONFIG.yaml"), "utf8")).toBe(beforeTemplate);
  });
});
