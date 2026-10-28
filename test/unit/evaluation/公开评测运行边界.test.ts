import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildEnvironmentCase, runEnvironmentTurn } from "../../sim/desk-pet-chat/external/environment-turn.mjs";
import { buildDriverPackage, escapeDriverText, validateCaseSpec } from "../../sim/desk-pet-chat/dataset.mjs";
import { renderDriverText } from "../../sim/desk-pet-chat/workflow.mjs";
// @ts-expect-error TS7016 —— 开发脚本没有声明文件，运行期形状由本文件的断言钉住。
import { initialExternalEnvironmentStep, validateExternalEnvironmentStep } from "../../../scripts/sim-eval-run.mjs";

describe("公开任务的原文和环境边界", () => {
  it("未安装数据时 status 可查看，但 verify 必须非零退出 [external-cli-verify-exit-status]", () => {
    const repo = resolve(process.cwd());
    const parent = join(repo, "test/.tmp/external-eval");
    mkdirSync(parent, { recursive: true });
    const scratch = mkdtempSync(join(parent, "verify-cli-"));
    try {
      mkdirSync(join(scratch, "scripts"), { recursive: true });
      cpSync(join(repo, "scripts/desk-pet-chat.mjs"), join(scratch, "scripts/desk-pet-chat.mjs"));
      cpSync(join(repo, "test/sim/desk-pet-chat"), join(scratch, "test/sim/desk-pet-chat"), {
        recursive: true,
        filter: path => ![".data", "__pycache__"].some(part => path.split(/[\\/]/).includes(part)),
      });
      for (const action of ["status", "verify"]) {
        const result = spawnSync(process.execPath, [join(scratch, "scripts/desk-pet-chat.mjs"), "dataset", "external", action, "multichallenge"], { encoding: "utf8", timeout: 15_000 });
        expect(result.status, result.stderr).toBe(action === "verify" ? 1 : 0);
        expect(JSON.parse(result.stdout)).toMatchObject({ complete: false, results: [{ dataset: "multichallenge", installed: false }] });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("环境运行在写入前复用隔离runner的运行标识边界 [external-runtime-run-id-boundary]", async () => {
    const parent = join(process.cwd(), "test/.tmp/external-eval");
    mkdirSync(parent, { recursive: true });
    const repoRoot = mkdtempSync(join(parent, "environment-id-"));
    try {
      const cardPath = join(repoRoot, "card.md");
      writeFileSync(cardPath, "---\nid: run-id-test\nname: Test Card\nversion: 1\n---\nA scratch Card.\n");
      const request = { dataset: "lhtb", taskId: "run-id-boundary", cardPath, planOnly: true, instruction: "Inspect the task." };
      const runs = join(repoRoot, "test/sim/desk-pet-chat/external/.data/lhtb/runs");
      await expect(runEnvironmentTurn({ ...request, runId: "a".repeat(49) }, { repoRoot })).rejects.toThrow(/最长 48/);
      expect(existsSync(runs)).toBe(false);
      const result = await runEnvironmentTurn({ ...request, runId: "a".repeat(48) }, { repoRoot });
      expect(result).toMatchObject({ runId: "a".repeat(48), prepared: true, executionComplete: false });
      expect(existsSync(join(runs, "a".repeat(48), "plan.json"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("上游 TeX 与同名模板字面量在实际发送时完整还原 [external-runtime-literal-braces]", () => {
    const original = "Prove {{#1}} and preserve the literal {{dataRoot}} in this source.";
    const entry = buildEnvironmentCase({ dataset: "memoryarena", taskId: "math-literal", instruction: original }, { card: "Test Card" });
    const driver = buildDriverPackage({ case: entry.case, fixture: entry.fixture, binding: { specHash: "sha256:" + "a".repeat(64) } } as any);
    expect(driver.driver[0]!.kind).toBe("message");
    expect(renderDriverText((driver.driver[0] as any).text, { dataRoot: "/isolated/root" })).toBe(original);
    expect(renderDriverText(`${escapeDriverText(original)}\nRead {{dataRoot}}/inputs/source.pdf`, { dataRoot: "/isolated/root" })).toBe(`${original}\nRead /isolated/root/inputs/source.pdf`);
  });

  it("未转义的未知占位符仍拒绝，不能放宽内部用例校验 [external-runtime-unknown-placeholder]", () => {
    expect(() => renderDriverText("{{secretRoot}}/file", { dataRoot: "/isolated/root" })).toThrow(/未登记占位符/);
    const entry = buildEnvironmentCase({ dataset: "memoryarena", taskId: "bad-placeholder", instruction: "ordinary source" }, { card: "Test Card" });
    (entry.case.driver[0] as any).text = "{{secretRoot}}";
    expect(() => validateCaseSpec(entry.case)).toThrow(/未登记占位符/);
  });

  it("环境重置身份绑定会话边界，驱动不携带参考答案 [external-runtime-environment-step-binding]", () => {
    const entry = buildEnvironmentCase({
      dataset: "memoryarena", taskId: "shopping-state", turns: [
        { userMessage: "Buy the camera body.", environmentStep: { config: "bundled_shopping", groupId: 3, subtaskIndex: 0 } },
        { userMessage: "Buy a compatible lens.", environmentStep: { config: "bundled_shopping", groupId: 3, subtaskIndex: 1 } },
      ], expectations: [{ referenceAnswers: ["hidden-body-id"], criteria: [] }, { referenceAnswers: ["hidden-lens-id"], criteria: [] }],
    }, { card: "Test Card" });
    const sessions = entry.case.driver.filter(step => step.kind === "host" && step.method === "chat_new_session") as any[];
    expect(sessions.map(session => session.args.externalEnvironmentStep)).toEqual([
      { config: "bundled_shopping", groupId: 3, subtaskIndex: 0 },
      { config: "bundled_shopping", groupId: 3, subtaskIndex: 1 },
    ]);
    expect(entry.case.driver.map(step => step.id)).toEqual(["session-1", "target-1", "session-2", "target-2"]);
    expect(JSON.stringify(entry.case.driver)).not.toContain("hidden-body-id");
    expect(JSON.stringify(entry.case.driver)).not.toContain("hidden-lens-id");
    expect(entry.case.probes.map(probe => probe.after)).toEqual(["target-1", "target-2"]);
  });

  it("首轮环境绑定缺失、MCP缺失或跨组切换在启动前拒绝 [external-runtime-initial-environment-gate]", () => {
    const entry = buildEnvironmentCase({ dataset: "memoryarena", taskId: "initial-binding", turns: [
      { userMessage: "Find the document.", environmentStep: { config: "progressive_search", groupId: 2, subtaskIndex: 0 } },
      { userMessage: "Read its sources.", environmentStep: { config: "progressive_search", groupId: 2, subtaskIndex: 1 } },
    ] }, { card: "Test Card" });
    const mcp = { transport: "stdio", enabled: true };
    expect(initialExternalEnvironmentStep(entry.case.driver, mcp)).toEqual({ config: "progressive_search", groupId: 2, subtaskIndex: 0 });
    expect(initialExternalEnvironmentStep([{ kind: "message", text: "Ordinary chat" }], null)).toBeNull();
    expect(() => initialExternalEnvironmentStep(entry.case.driver, null)).toThrow(/必须绑定已启用的 stdio MCP/);
    expect(() => initialExternalEnvironmentStep(entry.case.driver, { ...mcp, enabled: false })).toThrow(/必须绑定已启用的 stdio MCP/);
    expect(() => initialExternalEnvironmentStep(entry.case.driver.slice(1), mcp)).toThrow(/首条消息前/);
    (entry.case.driver[2] as any).args.externalEnvironmentStep.groupId = 3;
    expect(() => initialExternalEnvironmentStep(entry.case.driver, mcp)).toThrow(/不能跨配置或任务组/);
    expect(validateExternalEnvironmentStep({ config: "group_travel_planner", groupId: 0, subtaskIndex: -1 })).toEqual({ config: "group_travel_planner", groupId: 0, subtaskIndex: -1 });
    for (const step of [null, { config: "unknown", groupId: 0, subtaskIndex: 0 }, { config: "bundled_shopping", groupId: 0, subtaskIndex: -1 }, { config: "progressive_search", groupId: 0.5, subtaskIndex: 0 }]) {
      expect(() => validateExternalEnvironmentStep(step)).toThrow("非法环境子任务身份");
    }
  });
});
