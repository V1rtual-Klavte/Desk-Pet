import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBeam, normalizeLhtb } from "../../sim/desk-pet-chat/external/batch-two.mjs";
import { getExternalSource, listExternalSources, prepareExternalSource } from "../../sim/desk-pet-chat/external/prepare.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

describe("公开评测长程适配器", () => {
  it("BEAM 展开每个 probe，保留双方历史角色、问型、参考答案和 rubric [external-batch-two-beam-roles-oracle]", () => {
    const tasks = normalizeBeam([{
      id: "conversation-7",
      chat: [{ batch_number: 1, turns: [[
        { role: "user", content: "I prefer tea.", question_type: "main_question" },
        { role: "assistant", content: "Understood." },
        { role: "user", content: "What did I say?", question_type: "follow_up" },
      ]] }],
      probingQuestions: {
        information_extraction: [{ question: "What drink do I prefer?", answer: "Tea.", difficulty: "easy", question_type: "preference", rubric: ["Tea"] }],
        abstention: [{ question: "What is my shoe size?", ideal_response: "No information is provided.", difficulty: "medium", rubric: ["No information is provided"] }],
      },
    }], { revision: REVISION });

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ dataset: "beam", split: "100K", mode: "fixed-history", id: "conversation-7-information_extraction-1", categories: ["chat", "memory", "context"], questionTypes: ["fact"] });
    expect(tasks[0].history).toEqual([
      { role: "user", content: "I prefer tea." },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "What did I say?" },
    ]);
    expect(tasks[0].turns).toEqual([{ id: `${tasks[0].id}-probe`, prompt: "What drink do I prefer?" }]);
    expect(tasks[0].questionTypes).toEqual(["fact"]);
    expect(tasks[0].oracle.raw).toMatchObject({ ability: "information_extraction", upstreamQuestionTypes: { question_type: "preference" } });
    expect(tasks[0].oracle).toMatchObject({ referenceAnswers: ["Tea."], criteria: ["Tea"] });
    expect(tasks[1].oracle.referenceAnswers).toEqual(["No information is provided."]);
    expect(tasks[0].history.some((message) => message.content === "Understood.")).toBe(true);
    expect(tasks[0].adaptationNotes.join(" ")).toMatch(/does not reproduce BEAM batch ingestion/i);
  });

  it("BEAM 保持原生嵌套 turn 的 user/assistant 次序，并拒绝破损角色 [external-batch-two-beam-role-validation]", () => {
    expect(() => normalizeBeam([{
      id: "x", chat: [{ turns: [[{ role: "tool", content: "not user data" }]] }],
      probingQuestions: { information_extraction: [{ question: "Q", answer: "A" }] },
    }], { revision: REVISION })).toThrow(/preserve a user\/assistant role/);
  });

  it("LHTB 保留完整任务 prompt、镜像、timeout 和网络条件，并在缺 verifier 时阻断 [external-batch-two-lhtb-task-contract]", () => {
    const taskToml = [
      'name = "silrlab/task-a"',
      "[agent]", "continue_until_timeout = true", "timeout_sec = 5400",
      "[verifier]", "timeout_sec = 900",
      "[environment]", 'docker_image = "example/image@sha256:abc"', "network = false", "cpus = 2", "memory_mb = 4096",
    ].join("\n");
    const [task] = normalizeLhtb([{
      taskId: "task-a", category: "geospatial-cartography", difficulty: "hard",
      instruction: "# Rebuild the task\nKeep working until timeout.", taskToml,
      assets: ["environment/Dockerfile", "environment/app/data.csv"],
      hiddenVerifierAvailable: false, officialHarnessAvailable: false,
    }], { revision: REVISION, split: "2.0" });

    expect(task).toMatchObject({ dataset: "lhtb", split: "2.0", mode: "environment", difficulty: 4, readiness: { runnable: false } });
    expect(task.turns[0].prompt).toContain("Keep working until timeout");
    expect(task.assets.map((asset) => asset.path)).toEqual(["environment/Dockerfile", "environment/app/data.csv"]);
    expect(task.environment).toMatchObject({ dockerImage: "example/image@sha256:abc", allowInternet: false, agentTimeoutSec: 5400, verifierTimeoutSec: 900, continueUntilTimeout: true });
    expect(task.readiness.blockers.join(" ")).toMatch(/hidden verifier/i);
    expect(task.adaptationNotes.join(" ")).toMatch(/not an official score/i);
  });

  it("LHTB verifier 文件存在也需要 modified Harbor，完整任务元数据不被改写 [external-batch-two-lhtb-verifier-gate]", () => {
    const taskToml = '[task]\nname = "org/task-b"\n[agent]\ntimeout_sec = 180\n[verifier]\ntimeout_sec = 60\n[environment]\ndocker_image = "org/image:tag"\nnetwork = true';
    const [task] = normalizeLhtb([{
      taskId: "task-b", instruction: "Do work.", taskToml,
      hiddenVerifierAvailable: true, officialHarnessAvailable: false,
    }], { revision: REVISION });
    expect(task.readiness.runnable).toBe(false);
    expect(task.readiness.blockers.join(" ")).toMatch(/modified official Harbor/i);
    expect(task.environment).toMatchObject({ agentTimeoutSec: 180, allowInternet: true, rawTaskToml: taskToml });
  });

  it("catalog 提供固定 revision 和 gated/public 状态，准备入口拒绝无本地路径与不安全 SHA [external-batch-two-catalog-pinning]", async () => {
    expect(listExternalSources().map((source) => source.id)).toEqual(["gaia", "multichallenge", "memoryarena", "beam", "lhtb"]);
    expect(getExternalSource("gaia").availability).toMatch(/gated/i);
    expect(getExternalSource("lhtb").readiness).toMatch(/tests\/private verifier/i);
    await expect(prepareExternalSource({ dataset: "beam" } as never)).rejects.toThrow(/inputPath is required/);
    await expect(prepareExternalSource({ dataset: "beam", inputPath: "unused", revision: "main" })).rejects.toThrow(/full pinned/);
  });

  it("准备本地 LHTB 任务目录时散列输入元数据、保留任务树路径且默认不写文件 [external-batch-two-prepare-local-provenance]", async () => {
    const root = mkdtempSync(join(tmpdir(), "deskpet-lhtb-"));
    try {
      const taskDir = join(root, "tasks-2.0", "example__01");
      mkdirSync(join(taskDir, "environment", "app"), { recursive: true });
      writeFileSync(join(taskDir, "task.toml"), [
        'artifacts = ["/app/workspace"]', '[task]', 'name = "silrlab/example__01"', '[agent]', 'timeout_sec = 90',
        '[verifier]', 'timeout_sec = 30', '[environment]', 'docker_image = "example/image:latest"', 'network = false',
      ].join("\n"));
      writeFileSync(join(taskDir, "instruction.md"), "# Keep working\nComplete the task.");
      writeFileSync(join(taskDir, "environment", "Dockerfile"), "FROM scratch");
      const result = await prepareExternalSource({ dataset: "lhtb", inputPath: root, revision: REVISION });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].assets).toContainEqual({ path: "environment/Dockerfile" });
      expect(result.tasks[0].environment.artifacts).toEqual(["/app/workspace"]);
      expect(result.tasks[0].readiness).toMatchObject({ runnable: false });
      expect(result.manifest.executionTaskCount).toBe(0);
      expect(result.manifest.rawSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.manifest.inputHashScope).toContain("not read or hashed");
      expect(result).not.toHaveProperty("outputDir");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepare limit 在 probe 展开后限制执行题数且不改变原始输入散列 [external-batch-two-prepare-expanded-limit]", async () => {
    const root = mkdtempSync(join(tmpdir(), "deskpet-beam-"));
    try {
      const inputPath = join(root, "beam.json");
      writeFileSync(inputPath, JSON.stringify([{
        id: "chat-1",
        chat: [{ turns: [[{ role: "user", content: "I prefer tea." }, { role: "assistant", content: "Noted." }]] }],
        probingQuestions: {
          information_extraction: [{ question: "What do I prefer?", answer: "Tea." }],
          temporal_reasoning: [{ question: "When?", answer: "Today." }],
        },
      }]));
      const result = await prepareExternalSource({ dataset: "beam", inputPath, revision: REVISION, limit: 1 });
      expect(result.tasks).toHaveLength(1);
      expect(result.manifest).toMatchObject({ recordCount: 1, normalizedTaskCount: 2, taskCount: 1, executionTaskCount: 1 });
      expect(result.manifest.rawSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
