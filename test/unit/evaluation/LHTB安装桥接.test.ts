import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildLhtbTrialCommand, getLhtbRunStatus, inspectLhtbInstall, LHTB_REVISION, listLhtbTasks, planLhtbRun } from "../../sim/desk-pet-chat/external/lhtb.mjs";

const roots: string[] = [];
const external = resolve("test/sim/desk-pet-chat/external");

function python(code: string, args: string[] = []) {
  const result = spawnSync(process.env.PYTHON ?? "python3", ["-B", "-c", code, ...args], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: external, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout.trim());
}

function fixture() {
  const temporary = resolve("test/.tmp");
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "lhtb-adapter-test-"));
  roots.push(root);
  for (const [family, id] of [["tasks", "legacy-task"], ["tasks-2.0", "long-task"]]) {
    const task = join(root, "upstream", family, id);
    mkdirSync(join(task, "tests"), { recursive: true });
    writeFileSync(join(task, "instruction.md"), "Run the required scientific workflow.\n");
    writeFileSync(join(task, "task.toml"), `[task]\nname = "${id}"\n\n[agent]\ntimeout_sec = 12\ncontinue_until_timeout = true\n\n[verifier]\ntimeout_sec = 3\n\n[environment]\ndocker_image = "registry.example/${id}@sha256:${"a".repeat(64)}"\n`);
    writeFileSync(join(task, "tests", "test.sh"), "#!/bin/sh\nexit 0\n");
  }
  return join(root, "upstream");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LHTB 本地安装与运行计划", () => {
  it("保留 1.0 与 2.0 两个任务布局并只纳入有官方 verifier 的目录 [external-lhtb-list-separates-task-families]", () => {
    const dataRoot = dirname(fixture());
    const tasks = listLhtbTasks({ dataRoot });
    expect(tasks.map((task) => [task.id, task.family])).toEqual([["legacy-task", "1.0"], ["long-task", "2.0"]]);
    expect(tasks.every((task) => task.verifierAvailable)).toBe(true);
    expect(tasks.every((task) => task.continueUntilTimeout)).toBe(true);
  });

  it("要求显式挑选任务并以 Harbor agent/verifier 的上限计算序列化预算 [external-lhtb-plan-requires-explicit-bounded-work]", () => {
    const dataRoot = dirname(fixture());
    expect(() => planLhtbRun({ dataRoot } as never)).toThrow(/taskIds/);
    const plan = planLhtbRun({ dataRoot, taskIds: ["long-task"], trials: 2, checkImages: false });
    expect(plan.taskIds).toEqual(["long-task"]);
    expect(plan.parallelism).toBe(1);
    expect(plan.totalMaxSeconds).toBe(30);
    expect(plan.scoreSource).toContain("pinned LHTB task verifier");
    expect(plan.containerImageReadiness).toContain("not checked");
    expect(plan.tasks[0].dockerImage).toBe(`registry.example/long-task@sha256:${"a".repeat(64)}`);
    expect(plan.tasks[0].imageReadiness).toBe("not-checked");
    expect(() => planLhtbRun({ dataRoot, taskIds: ["long-task"], parallelism: 2, checkImages: false } as never)).toThrow(/parallelism/);
    expect(() => planLhtbRun({ dataRoot, taskIds: ["long-task"], trials: 4, checkImages: false })).toThrow(/trials/);
  });

  it.skipIf(process.platform === "win32")("计划读取所选 digest 镜像的本地精确引用状态 [external-lhtb-plan-checks-exact-local-image]", () => {
    const dataRoot = dirname(fixture());
    const docker = join(dataRoot, "fake-docker.mjs");
    const image = `registry.example/long-task@sha256:${"a".repeat(64)}`;
    writeFileSync(docker, `#!/usr/bin/env node\nif (process.argv.at(-1) !== ${JSON.stringify(image)}) process.exit(17);\nconsole.log("sha256:fixture-image-id");\n`);
    chmodSync(docker, 0o755);

    const plan = planLhtbRun({ dataRoot, taskIds: ["long-task"], dockerPath: docker });
    expect(plan.tasks[0].imageReadiness).toBe("available-locally");
    expect(plan.tasks[0].imageId).toBe("sha256:fixture-image-id");
  });

  it("把没有固定镜像引用的 Dockerfile 任务标为按需构建并说明网络依赖 [external-lhtb-dockerfile-image-is-on-demand]", () => {
    const dataRoot = dirname(fixture());
    const task = join(dataRoot, "upstream", "tasks-2.0", "build-only-task");
    mkdirSync(join(task, "tests"), { recursive: true });
    writeFileSync(join(task, "instruction.md"), "Use the supplied environment.\n");
    writeFileSync(join(task, "task.toml"), `[task]\nname = "build-only-task"\n\n[agent]\ntimeout_sec = 12\n\n[verifier]\ntimeout_sec = 3\n`);
    writeFileSync(join(task, "Dockerfile"), "FROM python:3.12-slim\n");
    writeFileSync(join(task, "tests", "test.sh"), "#!/bin/sh\nexit 0\n");

    const plan = planLhtbRun({ dataRoot, taskIds: ["build-only-task"], checkImages: false });
    expect(plan.tasks[0].dockerImage).toBeNull();
    expect(plan.tasks[0].imageReadiness).toBe("build-on-demand");
    expect(plan.tasks[0].imageReason).toContain("build-time network dependencies");
  });

  it("在官方测试入口缺失时拒绝生成可运行计划 [external-lhtb-plan-requires-official-verifier]", () => {
    const dataRoot = dirname(fixture());
    const task = join(dataRoot, "upstream", "tasks-2.0", "long-task", "tests", "test.sh");
    rmSync(task);
    expect(listLhtbTasks({ dataRoot }).find((item) => item.id === "long-task")?.verifierAvailable).toBe(false);
    expect(() => planLhtbRun({ dataRoot, taskIds: ["long-task"] })).toThrow(/verifier entrypoint/);
  });

  it.each([
    { kind: "exception", expected: "failed", caseId: "external-lhtb-exception-exit-zero" },
    { kind: "wrong-id", expected: "failed", caseId: "external-lhtb-wrong-trial-identity" },
    { kind: "wrong-task", expected: "failed", caseId: "external-lhtb-wrong-task-identity" },
    { kind: "zero", expected: "completed", caseId: "external-lhtb-valid-zero-reward" },
    { kind: "missing", expected: "failed", caseId: "external-lhtb-missing-result" },
    { kind: "malformed", expected: "failed", caseId: "external-lhtb-malformed-result" },
    { kind: "invalid-reward", expected: "failed", caseId: "external-lhtb-invalid-verifier" },
  ])("Harbor结果独立于进程退出码：$kind [$caseId]", ({ kind, expected }) => {
    const dataRoot = dirname(fixture());
    const runId = "unit-harbor-result";
    const taskPath = join(dataRoot, "upstream/tasks-2.0/long-task");
    const runRoot = join(dataRoot, "runs", runId);
    const trialRoot = join(runRoot, "trials", runId);
    mkdirSync(trialRoot, { recursive: true });
    const requestPath = join(runRoot, "request.json");
    writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, runId, taskId: "long-task", taskPath, taskName: "long-task", revision: LHTB_REVISION,
      command: "not-executed", args: [], cwd: dataRoot, logPath: join(runRoot, "harbor.log") }));
    const result = {
      id: "11111111-1111-4111-8111-111111111111", trial_name: kind === "wrong-id" ? "unrelated-trial" : runId,
      task_name: "long-task", trial_uri: pathToFileURL(trialRoot).href,
      task_id: { path: kind === "wrong-task" ? join(dataRoot, "other-task") : taskPath },
      config: { trial_name: runId, trials_dir: join(runRoot, "trials"), task: { path: taskPath },
        agent: { import_path: "lhtb_harbor_agent:DeskPetHarborAgent", kwargs: { task_id: "long-task", run_id: runId } }, verifier: { disable: false } },
      task_checksum: "fixture", agent_info: { name: "desk-pet-lhtb", version: "1.0.0" },
      started_at: "2026-10-01T00:00:00Z", finished_at: "2026-10-01T00:00:01Z",
      exception_info: kind === "exception" ? { exception_type: "RuntimeError", exception_message: "fixture failure", exception_traceback: "", occurred_at: "2026-10-01T00:00:01Z" } : null,
      verifier_result: { rewards: { reward: kind === "invalid-reward" ? "0" : 0 } },
    };
    if (kind !== "missing") writeFileSync(join(trialRoot, "result.json"), kind === "malformed" ? "{" : JSON.stringify(result));
    // A different directory must never rescue the expected trial's missing/invalid result.
    mkdirSync(join(runRoot, "trials", "unrelated"));
    writeFileSync(join(runRoot, "trials", "unrelated", "result.json"), JSON.stringify(result));
    const exit = python(`import json, sys\nimport lhtb_run as r\nclass Child:\n    pid = 123\n    def wait(self): return 0\nr.subprocess.Popen = lambda *a, **k: Child()\nsys.argv = ['runner', sys.argv[1]]\nprint(json.dumps({'code': r.main()}))`, [requestPath]);
    const status = getLhtbRunStatus({ runId, dataRoot });
    expect(status.status).toBe(expected);
    expect(status.exitCode).toBe(0);
    expect(exit.code).toBe(expected === "completed" ? 0 : 1);
    if (kind === "zero") {
      expect(status.reward).toBe(0);
      expect(status.passed).toBe(false);
      expect(status.taskResultCount).toBe(1);
    } else {
      expect(status.passed).toBeNull();
      expect(status.error).toEqual(expect.any(String));
    }
    const persisted = JSON.parse(readFileSync(join(runRoot, "status.json"), "utf8"));
    persisted.taskId = "another-task";
    writeFileSync(join(runRoot, "status.json"), JSON.stringify(persisted));
    expect(() => getLhtbRunStatus({ runId, dataRoot })).toThrow(/identity mismatch/);
  });

  it.skipIf(process.platform === "win32")("run id 为 Harbor 相位后缀预留 48 字符运行上限 [external-lhtb-run-id-phase-budget]", () => {
    const dataRoot = dirname(fixture());
    mkdirSync(join(dataRoot, "venv/bin"), { recursive: true });
    writeFileSync(join(dataRoot, "venv/bin/python"), "");
    writeFileSync(join(dataRoot, "venv/bin/harbor"), "");
    const cardPath = join(dataRoot, "fixture-card.md");
    const authorizationPath = join(dataRoot, "fixture-authorization.json");
    writeFileSync(cardPath, "fixture card\n");
    writeFileSync(authorizationPath, "{}\n");
    const runId = "r".repeat(39);
    const plan = buildLhtbTrialCommand({ taskId: "long-task", runId, dataRoot, cardPath, authorizationPath });
    expect(plan.runId).toBe(runId);
    expect(`${plan.runId}-phase-10`).toHaveLength(48);
    expect(() => buildLhtbTrialCommand({ taskId: "long-task", runId: "r".repeat(40), dataRoot, cardPath, authorizationPath })).toThrow(/3-39/);
  });

  it("metadata不能单独声明源码与运行器ready [external-lhtb-receipt-cannot-prove-install]", () => {
    const dataRoot = dirname(fixture());
    writeFileSync(join(dataRoot, "installation.json"), JSON.stringify({ revision: LHTB_REVISION, harborVersion: "0.7.0", sourceTreeSha256: "sha256:forged" }));
    const result = inspectLhtbInstall({ dataRoot });
    expect(result.ready).toBe(false);
    expect(result.blockers.join("\n")).toMatch(/archive|unsupported|Python|verification/i);
  });

  it("中断解包只复用固定archive一致的源码，verify离线且拒篡改 [external-lhtb-interrupted-install-reuse]", () => {
    const dataRoot = dirname(fixture());
    const result = python(`
import io, json, sys, tarfile
from pathlib import Path
from unittest.mock import patch
import lhtb_install as m
root = Path(sys.argv[1])
# Small archive stands in for the fixed download boundary; digest comparison stays real.
archive = root / 'fixture.tar.gz'
with tarfile.open(archive, 'w:gz') as tar:
    for path in sorted((root / 'upstream').rglob('*')):
        if path.is_file(): tar.add(path, arcname='LHTB/' + path.relative_to(root / 'upstream').as_posix(), recursive=False)
with patch.object(m, 'ARCHIVE_SHA256', m.sha256_file(archive)), patch.object(m, 'ARCHIVE_BYTES', archive.stat().st_size), patch.object(m, 'EXPECTED_TASK_COUNTS', {'tasks': 1, 'tasks-2.0': 1}):
    # Missing Harbor patch must fail even with the exact archived tree.
    try: m.install_source(root, archive)
    except ValueError as error: patch_rejected = 'continue-until-timeout' in str(error)
    else: patch_rejected = False
    harbor = root / 'upstream/harbor/src/harbor/trial'
    harbor.mkdir(parents=True)
    (harbor / 'trial.py').write_text('continue_until_timeout = True')
    with tarfile.open(archive, 'w:gz') as tar:
        for path in sorted((root / 'upstream').rglob('*')):
            if path.is_file(): tar.add(path, arcname='LHTB/' + path.relative_to(root / 'upstream').as_posix(), recursive=False)
    m.ARCHIVE_SHA256 = m.sha256_file(archive)
    m.ARCHIVE_BYTES = archive.stat().st_size
    before = sorted(str(p.relative_to(root)) for p in root.rglob('*'))
    with patch.object(m.urllib.request, 'urlopen', side_effect=AssertionError('network forbidden')):
        _, reused = m.install_source(root, archive)
        verified = m.verify_source(root, archive)
    after = sorted(str(p.relative_to(root)) for p in root.rglob('*'))
    cache = root / 'upstream/harbor/src/harbor/__pycache__'
    cache.mkdir(parents=True)
    (cache / 'trial.cpython-313.pyc').write_bytes(b'bytecode')
    cache_verified = m.verify_source(root, archive)
    target = root / 'upstream/tasks-2.0/long-task/tests/test.sh'
    target.write_text('tampered')
    (root / 'installation.json').write_text(json.dumps({'revision': m.REVISION, 'sourceTreeSha256': 'sha256:' + m.tree_digest(root / 'upstream')[0]}))
    try: m.install_source(root, archive)
    except ValueError: tamper_rejected = True
    else: tamper_rejected = False
    print(json.dumps({'reused': reused['sourceReused'], 'verifiers': verified['verifierTaskCount'], 'unchanged': before == after, 'cacheIgnored': cache_verified['sourceTreeSha256'] == verified['sourceTreeSha256'], 'patchRejected': patch_rejected, 'tamperRejected': tamper_rejected, 'content': target.read_text()}))
`, [dataRoot]);
    expect(result).toEqual({ reused: true, verifiers: 2, unchanged: true, cacheIgnored: true, patchRejected: true, tamperRejected: true, content: "tampered" });
  });

  it.each([
    { mode: "graceful", killed: false, caseId: "external-lhtb-agent-cancel-reaps-child" },
    { mode: "forced", killed: true, caseId: "external-lhtb-agent-cancel-kill-bound" },
  ])("外层取消$mode仍回收唯一Node且保持取消语义 [$caseId]", ({ mode, killed }) => {
    const result = python(`
import asyncio, json, sys, types
from pathlib import Path
for module, symbol in [('harbor.agents.base', 'BaseAgent'), ('harbor.environments.base', 'BaseEnvironment'), ('harbor.models.agent.context', 'AgentContext')]:
    stub = types.ModuleType(module)
    setattr(stub, symbol, type(symbol, (), {}))
    sys.modules[module] = stub
import lhtb_harbor_agent as m
async def exercise():
    ready, exited = asyncio.Event(), asyncio.Event()
    events = []
    class Input:
        def write(self, data): ready.set()
        async def drain(self): return None
        def close(self): return None
    class Process:
        returncode = None
        def __init__(self):
            self.stdin = Input()
            self.stdout, self.stderr = asyncio.StreamReader(), asyncio.StreamReader()
        async def wait(self):
            await exited.wait()
            events.append('reaped')
            return self.returncode
        def finish(self, code):
            self.returncode = code
            self.stdout.feed_eof()
            self.stderr.feed_eof()
            exited.set()
        def terminate(self):
            events.append('terminate')
            if sys.argv[1] == 'graceful': self.finish(-15)
        def kill(self):
            events.append('kill')
            self.finish(-9)
    class Server:
        def close(self): events.append('server-close')
        async def wait_closed(self): events.append('server-closed')
    class WaitingWriter:
        def close(self): events.append('connection-close')
        async def wait_closed(self): return None
    async def launch(*a, **k): return Process()
    async def listen(callback, **kwargs):
        callback(asyncio.StreamReader(), WaitingWriter())
        return Server()
    m.asyncio.create_subprocess_exec = launch
    m.asyncio.start_unix_server = listen
    m.os.chmod = lambda *a: None
    m.require_unix = lambda: None
    m.STOP_GRACE_SECONDS = 0.01
    agent = m.DeskPetHarborAgent(task_id='fake-task', card_path='fake-card', authorization_path='fake-authorization', run_id='unit-cancel', timeout_seconds=100)
    context = types.SimpleNamespace(metadata={})
    task = asyncio.create_task(agent.run('fixture', object(), context))
    await asyncio.wait_for(ready.wait(), 1)
    task.cancel()
    try: await asyncio.wait_for(task, 2)
    except asyncio.CancelledError: cancelled = True
    else: cancelled = False
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    return {'cancelled': cancelled, 'terminated': events.count('terminate'), 'killed': 'kill' in events, 'reaped': 'reaped' in events, 'serverClosed': 'server-closed' in events, 'connectionClosed': 'connection-close' in events, 'pending': len(pending), 'metadata': context.metadata}
print(json.dumps(asyncio.run(exercise())))
`, [mode]);
    expect(result).toEqual({ cancelled: true, terminated: 1, killed, reaped: true, serverClosed: true, connectionClosed: true, pending: 0, metadata: {} });
  });

  it("broker断线取消exec并限制UTF8/JSON转义后的发送字节 [external-lhtb-broker-disconnect-byte-bounds]", () => {
    const result = python(`
import asyncio, json, sys, types
for module, symbol in [('harbor.agents.base', 'BaseAgent'), ('harbor.environments.base', 'BaseEnvironment'), ('harbor.models.agent.context', 'AgentContext')]:
    stub = types.ModuleType(module)
    setattr(stub, symbol, type(symbol, (), {}))
    sys.modules[module] = stub
import lhtb_harbor_agent as a
import lhtb_mcp_server as m
async def exercise():
    started, cancelled = asyncio.Event(), asyncio.Event()
    calls = []
    class Environment:
        async def exec(self, command, timeout_sec):
            calls.append(command)
            if command == 'large':
                return types.SimpleNamespace(stdout='终' * 120000, stderr='\\x00' * 120000, return_code=0)
            started.set()
            try: await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.set()
                raise
    agent = a.DeskPetHarborAgent(task_id='fake', card_path='card', authorization_path='auth')
    owned = set()
    async def handle(reader, writer):
        task = asyncio.current_task()
        owned.add(task)
        try: await agent._serve_broker(Environment(), 'token', reader, writer)
        finally: owned.discard(task)
    server = await asyncio.start_server(handle, '127.0.0.1', 0, limit=m.MAX_LINE_BYTES)
    port = server.sockets[0].getsockname()[1]
    reader, writer = await asyncio.open_connection('127.0.0.1', port, limit=m.MAX_LINE_BYTES)
    writer.write(m.encode_line({'token': 'token', 'command': 'large', 'timeoutSec': 10}))
    await writer.drain()
    raw = await m.read_line(reader)
    reply = json.loads(raw)
    writer.close()
    await writer.wait_closed()
    reader, writer = await asyncio.open_connection('127.0.0.1', port, limit=m.MAX_LINE_BYTES)
    writer.write(m.encode_line({'token': 'token', 'command': 'wait', 'timeoutSec': 10}))
    await writer.drain()
    await asyncio.wait_for(started.wait(), 1)
    writer.close()
    await writer.wait_closed()
    await asyncio.wait_for(cancelled.wait(), 1)
    server.close()
    await server.wait_closed()
    await asyncio.gather(*list(owned))
    try: m.encode_line({'text': 'x' * 1048576})
    except ValueError: oversized_rejected = True
    else: oversized_rejected = False
    return {'calls': calls, 'cancelled': cancelled.is_set(), 'stdoutCut': reply['stdoutTruncated'], 'stderrCut': reply['stderrTruncated'], 'stdoutMarker': reply['stdout'].endswith('[output truncated]'), 'stderrMarker': reply['stderr'].endswith('[output truncated]'), 'utf8Valid': '\\ufffd' not in reply['stdout'], 'stdoutBytes': len(json.dumps(reply['stdout'], ensure_ascii=False).encode()), 'stderrBytes': len(json.dumps(reply['stderr'], ensure_ascii=False).encode()), 'frameBytes': len(raw), 'oversizeRejected': oversized_rejected, 'busy': agent._broker_busy}
print(json.dumps(asyncio.run(exercise())))
`);
    expect(result).toMatchObject({ calls: ["large", "wait"], cancelled: true, stdoutCut: true, stderrCut: true, stdoutMarker: true, stderrMarker: true, utf8Valid: true, oversizeRejected: true, busy: false });
    expect(result.stdoutBytes).toBeLessThanOrEqual(256 * 1024);
    expect(result.stderrBytes).toBeLessThanOrEqual(256 * 1024);
    expect(result.frameBytes).toBeLessThanOrEqual(1_048_576);
  });

  it("job保留与poll等待都有硬上限 [external-lhtb-job-retention-poll-bounds]", () => {
    const result = python(`
import asyncio, json
import lhtb_mcp_server as m
async def execute(command, timeout): return {'returnCode': 0, 'stdout': 'done', 'stderr': ''}
m._broker_call = execute
async def exercise():
    jobs = m.TerminalJobs()
    first = None
    for index in range(17):
        start = await jobs.call('terminal_exec', {'command': 'fixture'})
        job_id = json.loads(start['content'][0]['text'])['jobId']
        if first is None: first = job_id
        await jobs.call('terminal_poll', {'jobId': job_id, 'wait_seconds': 1})
    failures = []
    for name, args in [('terminal_poll', {'jobId': first, 'wait_seconds': 0}), ('terminal_poll', {'jobId': job_id, 'wait_seconds': 41}), ('terminal_exec', {'command': 'x' * 16385})]:
        try: await jobs.call(name, args)
        except ValueError: failures.append(name)
    retained = json.loads((await jobs.call('terminal_poll', {'jobId': job_id, 'wait_seconds': 0}))['content'][0]['text'])
    await jobs.close()
    return {'rejected': failures, 'latest': retained['status'], 'remaining': len(jobs.jobs)}
print(json.dumps(asyncio.run(exercise())))
`);
    expect(result).toEqual({ rejected: ["terminal_poll", "terminal_poll", "terminal_exec"], latest: "completed", remaining: 0 });
  });

  it("运行器身份必须指向隔离venv及固定Harbor源码 [external-lhtb-runner-identity-verification]", () => {
    const dataRoot = dirname(fixture());
    const result = python(`
import json, sys, types
from pathlib import Path
from unittest.mock import patch
import lhtb_install as m
root = Path(sys.argv[1])
venv = root / 'venv/bin'
venv.mkdir(parents=True)
(venv / 'python').write_text('fixture interpreter, never executed')
(venv / 'harbor').write_text('#!' + str(venv / 'python') + '\\nfrom harbor.cli.main import app\\n')
info = {'prefix': str(root / 'venv'), 'version': '0.7.0', 'entrypoint': ['harbor.cli.main:app'], 'cli': str(root / 'upstream/harbor/src/harbor/cli/main.py'), 'trial': str(root / 'upstream/harbor/src/harbor/trial/trial.py')}
with patch.object(m.subprocess, 'run', side_effect=lambda *a, **k: types.SimpleNamespace(returncode=0, stdout=json.dumps(info))):
    verified = m.verify_runtime(root)
    info['trial'] = str(root / 'unrelated/trial.py')
    try: m.verify_runtime(root)
    except ValueError: rejected = True
    else: rejected = False
print(json.dumps({'verified': verified['runtimeVerified'], 'wrongRunnerRejected': rejected}))
`, [dataRoot]);
    expect(result).toEqual({ verified: true, wrongRunnerRejected: true });
  });

  it("Windows在任何Unix连接前明确拒绝支持 [external-lhtb-windows-unsupported]", () => {
    const result = python(`
import json
from unittest.mock import patch
import lhtb_mcp_server as m
with patch.object(m.os, 'name', 'nt'):
    try: m.require_unix()
    except RuntimeError as error: print(json.dumps({'error': str(error)}))
    else: print(json.dumps({'error': None}))
`);
    expect(result.error).toMatch(/unsupported on Windows.*Unix sockets/);
  });
});
