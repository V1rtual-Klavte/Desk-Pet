import { describe, expect, it } from "vitest";
import { normalizeBeam } from "../../sim/desk-pet-chat/external/batch-two.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

function message(role: "user" | "assistant", content: string, index: string | null) {
  return { role, content, index, id: 9876543210123456789n };
}

function batch(batchNumber: bigint, label: string) {
  return {
    batch_number: batchNumber,
    time_anchor: { day: Number(batchNumber) },
    turns: [[message("user", `${label} user`, `${batchNumber},1`)], [message("assistant", `${label} assistant`, null)]],
  };
}

describe("BEAM 10M grouped history adapter", () => {
  it("sorts plan and batch numbers numerically, preserves original roles, and drops BigInt-only metadata [beam-10m-numeric-plan-order]", () => {
    const tasks = normalizeBeam([{
      chatId: "10m-chat-1",
      upstreamSplit: "10M",
      chat: [
        { "plan-10": [batch(10n, "p10")], "plan-2": [batch(2n, "p2-b2"), batch(1n, "p2-b1")] },
        { "plan-1": [batch(1n, "p1")] },
      ],
      probingQuestions: {
        information_extraction: [{ question: "What is preserved in this story?", ideal_answer: "All history remains in temporal order.", rubric: ["Keep the original event sequence."] }],
      },
    }], { revision: REVISION, split: "10M" });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.history.map(({ role, content }) => [role, content])).toEqual([
      ["user", "p1 user"], ["assistant", "p1 assistant"],
      ["user", "p2-b1 user"], ["assistant", "p2-b1 assistant"],
      ["user", "p2-b2 user"], ["assistant", "p2-b2 assistant"],
      ["user", "p10 user"], ["assistant", "p10 assistant"],
    ]);
    expect(tasks[0]!.history.every(message => Object.keys(message).join(",") === "role,content")).toBe(true);
    expect(tasks[0]!.oracle.referenceAnswers).toEqual(["All history remains in temporal order."]);
  });

  it("rejects malformed 10M plan batch structures instead of dropping history [beam-10m-malformed-plan]", () => {
    expect(() => normalizeBeam([{
      id: "broken-10m-chat",
      chat: [{ "plan-1": [{ batch_number: 1n, turns: "not a turn list" }] }],
      probingQuestions: { information_extraction: [{ question: "Q", answer: "A" }] },
    }], { revision: REVISION, split: "10M" })).toThrow(/batch must contain a turns array/);
  });
});
