import { describe, expect, it } from "vitest";
import {
  normalizeGaia,
  normalizeMemoryArenaTravel,
  normalizeMultiChallenge,
} from "../../sim/desk-pet-chat/external/batch-one.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

describe("公开评测首批适配器", () => {
  it("GAIA 只消费调用方提供的 validation 行，并把答案与附件留在 oracle/assets [external-batch-one-gaia-local-only]", () => {
    const [task] = normalizeGaia([{
      task_id: "gaia-1", Question: "Read the attached chart.", Level: 1,
      "Final answer": "42", file_name: "chart.png", file_path: "2023/validation/chart.png",
      "Annotator Metadata": { steps: ["inspect image"] },
    }], { revision: REVISION, split: "validation" });

    expect(task).toMatchObject({ dataset: "gaia", id: "gaia-1", revision: REVISION, split: "validation", mode: "task", difficulty: 3 });
    expect(task.turns).toEqual([{ id: "gaia-1-question", prompt: "Read the attached chart." }]);
    expect(task.oracle.referenceAnswers).toEqual(["42"]);
    expect(task.turns[0]!.prompt).not.toContain("42");
    expect(task.assets).toEqual([{ path: "2023/validation/chart.png", fileName: "chart.png", upstreamPath: "2023/validation/chart.png" }]);
    expect(task.readiness).toMatchObject({ runnable: false, blockers: [expect.stringContaining("attachment")] });
    expect(task.source.license).toContain("Gated");
  });

  it("拒绝 GAIA 私有 test split 和无来源 revision [external-batch-one-gaia-gated-split]", () => {
    const row = { task_id: "g", Question: "Q", Level: 1, "Final answer": "A" };
    expect(() => normalizeGaia([row], { revision: REVISION, split: "test" })).toThrow(/dev\/validation/);
    expect(() => normalizeGaia([row], { revision: "  " })).toThrow(/revision is required/);
  });

  it("MultiChallenge 用原始最后一条 user turn 作 live prompt，target_question 只留在 judge oracle [external-batch-one-multichallenge-history]", () => {
    const [task] = normalizeMultiChallenge([{
      question_id: "mc-1", axis: "INFERENCE_MEMORY",
      conversation: {
        role: ["user", "assistant", "user"],
        content: ["My train leaves at 8.", "Understood.", "Remember the train time."],
      },
      target_question: "When does my train leave?", pass_criteria: "8", num_turns: 3,
    }], { revision: REVISION, split: "test" });

    expect(task.mode).toBe("fixed-history");
    expect(task.history).toEqual([
      { role: "user", content: "My train leaves at 8." },
      { role: "assistant", content: "Understood." },
    ]);
    expect(task.turns).toEqual([{ id: "mc-1-target", prompt: "Remember the train time." }]);
    expect(task.oracle).toMatchObject({
      referenceAnswers: [],
      criteria: [
        "Official judge question: When does my train leave?",
        "Expected judge result: 8",
      ],
      raw: { targetQuestion: "When does my train leave?", passCriteria: "8" },
    });
    const rawOracle = task.oracle.raw as { targetQuestion: string; passCriteria: string };
    expect(task.history.some((turn) => turn.role === "assistant")).toBe(true);
    expect(task.turns[0]!.prompt).not.toBe(rawOracle.targetQuestion);
    expect(task.turns[0]!.prompt).not.toBe(rawOracle.passCriteria);
  });

  it("MemoryArena travel 保留多 session 顺序与环境契约，不伪装成可运行的独立 QA [external-batch-one-memoryarena-dependencies]", () => {
    const row = {
      id: 7,
      base_person: { name: "Jennifer", query: "Plan a 3 day trip.", daily_plans: [{ days: 1, current_city: "A", transportation: "train" }] },
      questions: ["I am Eric joining Jennifer.", "I am Emma joining Eric and Jennifer."],
      answers: [[{ days: 1, transportation: "train" }], [{ days: 1, transportation: "train" }]],
    };
    const [task] = normalizeMemoryArenaTravel([row], { revision: REVISION, split: "test" });

    expect(task).toMatchObject({ dataset: "memoryarena", id: "7", mode: "environment", readiness: { runnable: false } });
    expect(task.turns.map((turn) => turn.prompt)).toEqual(row.questions);
    expect(task.turns.map((turn) => turn.id)).toEqual(["subtask-1", "subtask-2"]);
    expect(task.environment.dependencies).toEqual([
      { index: 0, dependsOn: ["base_person"], previousSubtasksAvailable: 0 },
      { index: 1, dependsOn: ["base_person"], previousSubtasksAvailable: 1 },
    ]);
    expect(task.environment.dailyPlans).toBe(row.base_person.daily_plans);
    expect((task.oracle.raw as { answers: unknown }).answers).toBe(row.answers);
    expect(task.oracle.referenceAnswers).toEqual([]);
    expect(task.readiness.blockers.length).toBeGreaterThan(0);
  });

  it("拒绝非 group_travel_planner 形状和错位 oracle [external-batch-one-memoryarena-shape]", () => {
    expect(() => normalizeMemoryArenaTravel([{ id: 1, questions: ["Q"], answers: ["A"] }], { revision: REVISION })).toThrow(/base_person/);
    expect(() => normalizeMemoryArenaTravel([{
      id: 2, base_person: { query: "Trip", daily_plans: [] }, questions: ["Q"], answers: [],
    }], { revision: REVISION })).toThrow(/align with questions/);
  });
});
