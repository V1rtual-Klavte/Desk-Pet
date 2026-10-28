import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const bridgeProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async () => ({ ...await vi.importActual<typeof import("node:child_process")>("node:child_process"), spawn: bridgeProcess.spawn }));
import {
  MEMORYARENA_CONFIGS,
  MEMORYARENA_DATASET_REVISION,
  MEMORYARENA_OFFICIAL_REVISION,
  buildMemoryArenaSequence,
  buildMemoryArenaTravelSeries,
  memoryArenaMcpServer,
  runMemoryArenaShoppingEnvironment,
} from "../../sim/desk-pet-chat/external/memoryarena.mjs";

describe("MemoryArena pinned environment adapter", () => {
  it("locks all five configs and distinct upstream dataset/code revisions", () => {
    expect(MEMORYARENA_CONFIGS).toEqual([
      "bundled_shopping", "formal_reasoning_math", "formal_reasoning_phys", "group_travel_planner", "progressive_search",
    ]);
    expect(MEMORYARENA_DATASET_REVISION).toMatch(/^[a-f0-9]{40}$/);
    expect(MEMORYARENA_OFFICIAL_REVISION).toMatch(/^[a-f0-9]{40}$/);
    expect(MEMORYARENA_DATASET_REVISION).not.toBe(MEMORYARENA_OFFICIAL_REVISION);
  });

  it("creates separate ordered sessions in a shared memory scope without placing oracle plans in driver turns", () => {
    const group = {
      id: 23,
      base_person: { name: "Alex", query: "Plan Alex's trip.", daily_plans: [{ days: 1, transportation: "hidden baseline" }] },
      questions: ["I am Blair. Add a museum.", "I am Casey. Add a vegetarian meal."],
      answers: [[{ days: 1, transportation: "hidden answer" }], [{ days: 1, transportation: "hidden answer" }]],
    };
    const series = buildMemoryArenaTravelSeries({ group, runId: "unit-run" });

    expect(series.turns.map((turn) => turn.userMessage)).toEqual([group.base_person.query, ...group.questions]);
    expect(new Set(series.turns.map((turn) => turn.sessionId)).size).toBe(3);
    expect(new Set(series.turns.map((turn) => turn.expectedMemoryScope))).toEqual(new Set([series.memoryScopeId]));
    expect(series.turns.every((turn) => turn.memoryCheckpoint.allowed && !turn.memoryCheckpoint.automatic)).toBe(true);
    expect(series.memoryPolicy).toMatchObject({ shareAcrossSessions: true, automaticCheckpoint: false, idleWaterlineIsNotEvidenceOfExtraction: true });
    expect(JSON.stringify(series)).not.toContain("hidden answer");
    expect(JSON.stringify(series)).not.toContain("hidden baseline");
  });

  it("offers a local stdio MCP service with the pinned upstream identity", () => {
    const server = memoryArenaMcpServer({ repoRoot: process.cwd(), pythonExecutable: "python3" });
    expect(server).toMatchObject({
      transport: "stdio",
      server: { name: "memoryarena-travel-environment", upstream: "ZexueHe/MemoryArena", revision: MEMORYARENA_OFFICIAL_REVISION },
    });
    expect(server.args).toContain("mcp-server");
    expect(server.environmentRequirements).toContain("pandas");
  });

  it("keeps formal-reasoning prompts and judge-only answers separate while preserving ordered sessions", () => {
    const group = {
      id: 9,
      paper_name: "paper-9",
      backgrounds: ["Known theorem A.", "Known theorem B."],
      questions: ["Derive result one.", "Now extend result one."],
      answers: ["hidden answer one", "hidden answer two"],
    };
    const { driver, oracle } = buildMemoryArenaSequence({ config: "formal_reasoning_math", group, runId: "math-run" });

    expect(driver.turns.map((turn) => turn.personIndex)).toEqual([1, 2]);
    expect(driver.turns.map((turn) => turn.sessionId)).not.toEqual([driver.turns[1]!.sessionId, driver.turns[0]!.sessionId]);
    expect(driver.turns[0]!.userMessage).toContain("Known theorem A.");
    expect(driver.turns[1]!.userMessage).toContain("Now extend result one.");
    expect(driver.memoryPolicy.automaticCheckpoint).toBe(false);
    expect(JSON.stringify(driver)).not.toContain("hidden answer");
    expect(oracle.answers).toEqual(group.answers);
    expect(driver.environment?.codingIsolation).toContain("docker");
  });
});

// L2: run only stdlib Python with tiny fixtures; never load the installed datasets,
// Java, Docker, a provider or a native runner. Python failures remain test failures.
function assertPythonCase(body: string) {
  const repo = process.cwd();
  const parent = join(repo, "test/.tmp");
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, "memoryarena-unit-"));
  try {
    const script = `import sys, json, os, io, hashlib, sqlite3, subprocess, signal, types\nfrom pathlib import Path\nfrom unittest.mock import patch, MagicMock\nsys.path.insert(0, ${JSON.stringify(resolve(repo, "test/sim/desk-pet-chat/external"))})\nimport memoryarena_bridge as b\nimport memoryarena_lifecycle as life\nroot = Path(${JSON.stringify(temporary)})\n${body}\n`;
    const python = process.env.DESK_PET_MEMORYARENA_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const result = spawnSync(python, ["-B", "-c", script], { cwd: repo, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const tinyLock = `
payload = b"tiny pinned resource"
entry = {"path": "data/a.bin", "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
lock = {"schemaVersion": 1, "sources": {name: {"repo": "owner/data", "revision": "a" * 40, "directory": directory, "files": [entry]} for name, directory in [("shoppingProductDb", "shopping-product-db"), ("browsecompCorpus", "search-corpus")]}}
`;

describe("MemoryArena offline environment recovery", () => {
  it("运行按配置检查环境就绪，购物走预热包装器而其它配置直连 [external-memoryarena-run-config-gate]", async () => {
    vi.resetModules();
    const verification = vi.fn((): { verified: boolean; environment: { configs: Record<string, { ready: boolean; blockers: string[] }> } } => ({ verified: true, environment: { configs: { bundled_shopping: { ready: false, blockers: ["jdk missing"] } } } }));
    const wrapper = vi.fn(async () => ({ executionComplete: true }));
    const direct = vi.fn(async () => ({ executionComplete: true }));
    vi.doMock("../../sim/desk-pet-chat/external/memoryarena.mjs", () => ({
      MEMORYARENA_CONFIGS: ["bundled_shopping", "formal_reasoning_math"],
      buildMemoryArenaSequence: () => ({ driver: { turns: [] }, oracle: {} }),
      memoryArenaMcpServer: () => ({ command: "fixture-python", args: ["bridge"], environmentRequirements: [] }),
      verifyMemoryArenaInstall: verification,
      loadMemoryArenaGroup: () => ({ id: 1, questions: ["Use the installed environment."], answers: ["ok"] }),
      runMemoryArenaShoppingEnvironment: wrapper,
    }));
    vi.doMock("../../sim/desk-pet-chat/external/environment-turn.mjs", () => ({ runEnvironmentTurn: direct }));
    const { runMemoryArenaGroup } = await import("../../sim/desk-pet-chat/external/memoryarena-connect.mjs");
    const base = { groupId: 1, cardPath: "fixture-card.md", authorizationPath: "fixture-authorization.json", repoRoot: process.cwd() };
    await expect(runMemoryArenaGroup({ ...base, config: "bundled_shopping" })).rejects.toThrow(/not ready: jdk missing/);
    expect(wrapper).not.toHaveBeenCalled();
    verification.mockReturnValue({ verified: true, environment: { configs: { bundled_shopping: { ready: true, blockers: [] }, formal_reasoning_math: { ready: true, blockers: [] } } } });
    await expect(runMemoryArenaGroup({ ...base, config: "bundled_shopping" })).resolves.toEqual({ executionComplete: true });
    await expect(runMemoryArenaGroup({ ...base, config: "formal_reasoning_math" })).resolves.toEqual({ executionComplete: true });
    expect(wrapper).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    vi.doUnmock("../../sim/desk-pet-chat/external/memoryarena.mjs");
    vi.doUnmock("../../sim/desk-pet-chat/external/environment-turn.mjs");
    vi.resetModules();
  });

  it("异步购物入口传明确Node路径和原请求且取消走包装器 [external-memoryarena-shopping-node-wrapper]", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const request = { dataset: "memoryarena", turns: [{ environmentStep: { config: "bundled_shopping", groupId: 1, subtaskIndex: 0 } }] };
    let input = "";
    child.stdin.on("data", chunk => { input += chunk.toString(); });
    child.kill.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ executionComplete: false, error: "cancelled" })}\n`);
        child.emit("close", 1);
      });
      return true;
    });
    bridgeProcess.spawn.mockReturnValueOnce(child);
    const controller = new AbortController();
    const result = runMemoryArenaShoppingEnvironment(request, { repoRoot: process.cwd(), pythonExecutable: "fixture-python", signal: controller.signal });
    controller.abort();
    expect(await result).toEqual({ executionComplete: false, error: "cancelled" });
    expect(JSON.parse(input)).toEqual(request);
    expect(bridgeProcess.spawn.mock.lastCall?.[1]).toEqual([
      resolve(process.cwd(), "test/sim/desk-pet-chat/external/memoryarena_bridge.py"), "--action", "run-shopping-environment", "--repo-root", process.cwd(), "--node-executable", process.execPath,
    ]);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("固定锁可恢复空缓存且有效缓存不下载 [external-memoryarena-lock-recovery]", () => assertPythonCase(`${tinyLock}
class Response(io.BytesIO):
    headers = {"Content-Type": "application/octet-stream"}
    status = 200
urls = []
def fetch(request, **kwargs):
    urls.append(request.full_url)
    return Response(payload)
with patch.object(b, "_environment_lock", return_value=lock), patch.object(b.urllib.request, "urlopen", side_effect=fetch):
    first = b._install_environment_sources(root)
    second = b._install_environment_sources(root)
    assert len(urls) == 2, urls
    assert all("/resolve/" + "a" * 40 + "/data/a.bin" in url for url in urls)
    assert first["shoppingProductDb"]["ready"] is True
    assert second["browsecompCorpus"]["ready"] is True
    assert (root / "environments/shopping-product-db/data/a.bin").read_bytes() == payload
`));

  it("不信本地manifest且拒绝等长篡改与路径链接 [external-memoryarena-lock-tamper]", () => assertPythonCase(`${tinyLock}
for source in lock["sources"].values():
    path = root / "environments" / source["directory"] / entry["path"]
    path.parent.mkdir(parents=True)
    path.write_bytes(payload)
(root / "environments/environment-source-manifest.json").write_text('{"sources": {}}')
with patch.object(b, "_environment_lock", return_value=lock):
    path = root / "environments/shopping-product-db/data/a.bin"
    path.write_bytes(b"X" * len(payload))
    status = b._environment_sources_status(root)
    assert status["shoppingProductDb"]["ready"] is False
    with patch.object(b.urllib.request, "urlopen", side_effect=AssertionError("must not replace bad cache")):
        try:
            b._install_environment_sources(root)
            raise AssertionError("accepted corrupt resource")
        except RuntimeError as exc:
            assert "lock" in str(exc)
    assert path.read_bytes() == b"X" * len(payload)
    with patch.object(Path, "is_symlink", lambda self: self.name == "data"):
        assert b._environment_sources_status(root)["browsecompCorpus"]["ready"] is False
    lock["sources"]["browsecompCorpus"]["files"] = [{**entry, "path": "../outside"}]
    try:
        b._corpus_files(root)
        raise AssertionError("accepted escaping path")
    except RuntimeError:
        pass
`));

  it("验证复用同轮哈希但文件变化立即失效 [external-memoryarena-hash-reuse]", () => assertPythonCase(`
path = root / "asset"
path.write_bytes(b"first")
hashes = {}
original = b._sha256
with patch.object(b, "_sha256", wraps=original) as digest:
    first = b._checked_hash(path, hashes)
    assert b._checked_hash(path, hashes) == first
    assert digest.call_count == 1
    path.write_bytes(b"changed bytes")
    assert b._checked_hash(path, hashes) != first
    assert digest.call_count == 2
`));

  it("固定官方归档校验源码而非本地自报身份 [external-memoryarena-source-archive-tamper]", () => assertPythonCase(`
import tarfile
source = root / "source" / ("MemoryArena-" + b.OFFICIAL_REVISION)
source.mkdir(parents=True)
(source / "tool.py").write_bytes(b"answer = 1\\n")
archive = source.parent / ("memoryarena-" + b.OFFICIAL_REVISION + ".tar.gz")
with tarfile.open(archive, "w:gz") as tar:
    tar.add(source / "tool.py", arcname="ZexueHe-MemoryArena-" + b.OFFICIAL_REVISION[:7] + "/tool.py")
with patch.object(b, "OFFICIAL_ARCHIVE_SHA256", hashlib.sha256(archive.read_bytes()).hexdigest()):
    assert b._verify_official_source(root) == source
    (source / "tool.py").write_bytes(b"answer = 2\\n")
    try:
        b._verify_official_source(root)
        raise AssertionError("accepted modified source")
    except RuntimeError as exc:
        assert "differs from fixed archive" in str(exc)
`));

  it("Java stub不足以ready且JAVA_HOME必须带libjvm [external-memoryarena-jdk-resolution]", () => assertPythonCase(`
jdk = root / "jdk"
(jdk / "bin").mkdir(parents=True)
java = jdk / "bin" / ("java.exe" if os.name == "nt" else "java")
java.write_text("fixture")
java.chmod(0o755)
with patch.object(b.shutil, "which", return_value="/usr/bin/java"), patch.object(b, "_installed_jdk_homes", return_value=[]), patch.dict(os.environ, {"JAVA_HOME": str(jdk)}, clear=True):
    assert b._resolve_java() is None
    lib = jdk / ("bin/server/jvm.dll" if os.name == "nt" else ("lib/server/libjvm.dylib" if sys.platform == "darwin" else "lib/server/libjvm.so"))
    lib.parent.mkdir(parents=True)
    lib.write_text("fixture library")
    found = b._resolve_java()
    assert found["JAVA_HOME"] == str(jdk.resolve())
    assert found["JVM_PATH"] == str(lib.resolve())
`));

  it("沙箱限流与超时均只清理自己的容器 [external-memoryarena-sandbox-owned-cleanup]", () => assertPythonCase(`
for outcome in [{"exitCode": None, "timedOut": True, "outputLimited": False, "stdout": "", "stderr": ""}, {"exitCode": None, "timedOut": False, "outputLimited": True, "stdout": "x", "stderr": ""}]:
    commands = []
    def execute(command, **kwargs):
        commands.append(command)
        return outcome if command[1] == "run" else {"exitCode": 0, "stdout": "", "stderr": "", "timedOut": False, "outputLimited": False}
    with patch.object(b, "run_bounded", side_effect=execute):
        result = b._run_sandboxed_code("print(1)")
    assert result == outcome
    run, cleanup = commands
    name = run[run.index("--name") + 1]
    assert name.startswith("desk-pet-memoryarena-")
    assert cleanup == ["docker", "rm", "-f", name]
    assert "--network=none" in run and "--read-only" in run and "10001:10001" in run
commands = []
def cancel(command, **kwargs):
    commands.append(command)
    if command[1] == "run":
        raise KeyboardInterrupt()
    return {"exitCode": 0, "stdout": "", "stderr": "", "timedOut": False, "outputLimited": False}
with patch.object(b, "run_bounded", side_effect=cancel):
    try:
        b._run_sandboxed_code("pass")
    except KeyboardInterrupt:
        pass
assert commands[1][-1] == commands[0][commands[0].index("--name") + 1]
`));

  it("输出洪流限制保留量且超时终止子进程 [external-memoryarena-process-bounds]", () => assertPythonCase(`
result = life.run_bounded([sys.executable, "-B", "-c", "import os; os.write(1, b'x' * 1000000)"], timeout=3, max_output=1024)
assert result["outputLimited"] is True
assert len(result["stdout"].encode()) <= 1024
result = life.run_bounded([sys.executable, "-B", "-c", "import time; time.sleep(30)"], timeout=0.05, max_output=1024)
assert result["timedOut"] is True
assert result["exitCode"] is not None
`));

  it("购物预热完成才启动runner且异常取消都释放自有服务 [external-memoryarena-shopping-prewarm-order]", () => assertPythonCase(`
request = {"dataset": "memoryarena", "turns": [{"environmentStep": {"config": "bundled_shopping", "groupId": 1, "subtaskIndex": 0}}]}
for cancelled in [False, True]:
    events = []
    class Service:
        def __enter__(self):
            events.append("warm")
            return {"DESKPET_MEMORYARENA_SHOPPING_URL": "http://127.0.0.1:4567", "DESKPET_MEMORYARENA_SHOPPING_OWNER": "owned"}
        def __exit__(self, *args):
            events.append("clean")
    def runner(command, **kwargs):
        events.append("runner")
        assert events[:2] == ["warm", "runner"]
        assert command[0] == str(Path(sys.executable).resolve())
        assert json.loads(kwargs["input_data"]) == request
        assert kwargs["env"]["DESKPET_MEMORYARENA_SHOPPING_OWNER"] == "owned"
        if cancelled:
            raise KeyboardInterrupt()
        return {"exitCode": 0, "timedOut": False, "outputLimited": False, "stdout": '{"executionComplete":true}\\n', "stderr": ""}
    with patch.object(b, "_prewarm_shopping_service", return_value=Service()), patch.object(b, "run_bounded", side_effect=runner):
        try:
            result = b.run_shopping_environment(root, request, sys.executable)
            assert result == {"executionComplete": True}
        except KeyboardInterrupt:
            assert cancelled
    assert events == ["warm", "runner", "clean"]
`));

  it("begin_task真正reset而observe不reset且MCP结束清理 [external-memoryarena-shopping-reset-finally]", () => assertPythonCase(`
step = root / "step.json"
step.write_text(json.dumps({"config": "bundled_shopping", "groupId": 1, "subtaskIndex": 0}))
client = MagicMock()
client.episode_done = False
client.observe.return_value = "initial"
state = {"key": (1, 0), "client": client}
b._shopping_environment(root, step, state)
assert client.reset.call_count == 0
b._shopping_environment(root, step, state, reset=True)
assert client.reset.call_args.args == (0,)
assert client.reset.call_count == 1
reset_flags = []
def environment(root, step_file, state, reset=False):
    reset_flags.append(reset)
    return client, {}
messages = [{"jsonrpc": "2.0", "id": n, "method": "tools/call", "params": {"name": name}} for n, name in enumerate(["begin_task", "observe", "begin_task"])]
with patch.dict(os.environ, {"DESKPET_MEMORYARENA_STEP_FILE": str(step)}), patch.object(b, "_shopping_environment", side_effect=environment), patch.object(b, "_cleanup_shopping") as cleanup, patch.object(sys, "stdin", io.StringIO("\\n".join(map(json.dumps, messages)))), patch.object(sys, "stdout", io.StringIO()) as output:
    b._serve_mcp(root, "bundled_shopping")
    assert reset_flags == [True, False, True]
    assert len(output.getvalue().splitlines()) == 3
    assert cleanup.call_count == 1
`));

  it("固定锁不含FAISS或pickle且BM25拒绝篡改收据 [external-memoryarena-index-receipt-binding]", () => assertPythonCase(`
actual = b._environment_lock()
assert set(actual["sources"]) == {"shoppingProductDb", "browsecompCorpus"}
assert len(actual["sources"]["browsecompCorpus"]["files"]) == 7
assert all(not entry["path"].endswith((".pkl", ".index")) for source in actual["sources"].values() for entry in source["files"])
${tinyLock}
with patch.object(b, "_environment_lock", return_value=lock):
    folder = root / "environments"
    folder.mkdir()
    db = folder / b.SEARCH_INDEX_NAME
    identity = b._corpus_identity()
    with sqlite3.connect(db) as connection:
        connection.execute("CREATE TABLE source_meta (key TEXT, value TEXT)")
        connection.executemany("INSERT INTO source_meta VALUES (?,?)", [("identity", identity), ("indexKind", "sqlite-fts5-bm25-adaptation"), ("tokenizer", "unicode61 remove_diacritics 2"), ("topK", "5")])
        connection.execute("CREATE TABLE completed_shards (path TEXT, sha256 TEXT, rows INTEGER)")
        connection.execute("INSERT INTO completed_shards VALUES (?,?,1)", (entry["path"], entry["sha256"]))
        connection.execute("CREATE TABLE docs (rowid INTEGER PRIMARY KEY, text TEXT)")
        connection.execute("INSERT INTO docs VALUES (1,'test')")
        connection.execute("CREATE VIRTUAL TABLE docs_fts USING fts5(text)")
        connection.execute("INSERT INTO docs_fts VALUES ('test')")
    receipt = {"path": str(db), "bytes": db.stat().st_size, "sha256": hashlib.sha256(db.read_bytes()).hexdigest(), "revision": "a" * 40, "corpusIdentity": identity, "documents": 1}
    path = folder / b.SEARCH_RECEIPT_NAME
    path.write_text(json.dumps(receipt))
    assert b._verify_search_index(root)["ready"] is True
    receipt["corpusIdentity"] = "forged-local-claim"
    path.write_text(json.dumps(receipt))
    rejected = b._verify_search_index(root)
    assert rejected["ready"] is False and "corpus identity" in rejected["blockers"][0]
    receipt["corpusIdentity"] = identity
    path.write_text(json.dumps(receipt))
    with sqlite3.connect(db) as connection:
        connection.execute("UPDATE docs SET text='tampered'")
    rejected = b._verify_search_index(root)
    assert rejected["ready"] is False and "SHA-256" in rejected["blockers"][0]
`));

  it("来源验证不等于Docker或购物运行就绪 [external-memoryarena-readiness-per-config]", () => assertPythonCase(`
data = root / "tiny.jsonl"
data.write_text('{"questions":["one"]}\\n')
configs = {name: ("tiny.jsonl", data.stat().st_size, hashlib.sha256(data.read_bytes()).hexdigest(), 1, 1) for name in b.DATASETS}
(root / "install-manifest.json").write_text('{"progressiveSearchIndex":{"receiptSha256":"receipt"}}')
sources = {name: {"ready": True, "blockers": []} for name in ["shoppingProductDb", "browsecompCorpus"]}
runtime = {"travel": {"ready": True, "blockers": []}, "search": {"ready": True, "blockers": []}, "shopping": {"ready": False, "blockers": ["jdk missing"]}}
with patch.object(b, "DATASETS", configs), patch.object(b, "_dataset_path", return_value=data), patch.object(b, "_verify_official_source", return_value=root), patch.object(b, "_check_resource"), patch.object(b, "_environment_sources_status", return_value=sources), patch.object(b, "_verify_search_index", return_value={"ready": True, "blockers": [], "documents": 1, "receiptSha256": "receipt"}), patch.object(b, "_resolve_java", return_value=None), patch.object(b, "_runtime_readiness", return_value=runtime), patch.object(b, "_sandbox_readiness", return_value={"ready": False, "blockers": ["docker missing"]}):
    result = b.verify(root)
assert result["verified"] is True and result["sourceVerified"] is True
assert result["environment"]["ready"] is False
assert result["environment"]["configs"]["group_travel_planner"] == {"ready": True, "blockers": []}
assert result["environment"]["configs"]["formal_reasoning_math"] == {"ready": False, "blockers": ["docker missing"]}
assert result["environment"]["configs"]["bundled_shopping"]["blockers"] == ["jdk missing"]
`));

  it("只读探测有界且从不build或联网恢复 [external-memoryarena-readiness-readonly]", () => assertPythonCase(`
commands = []
def probe(command, **kwargs):
    commands.append((command, kwargs))
    if command[0] == "docker":
        return {"exitCode": 1, "stdout": "", "stderr": "unavailable", "timedOut": False, "outputLimited": False}
    return {"exitCode": 0, "stdout": "runtime-ready\\n", "stderr": "", "timedOut": False, "outputLimited": False}
with patch.object(b, "run_bounded", side_effect=probe):
    assert b._runtime_readiness(None)["shopping"]["ready"] is False
    assert b._sandbox_readiness()["ready"] is False
assert commands[-1][0][:3] == ["docker", "image", "inspect"]
assert all(options["timeout"] <= 45 and options["max_output"] <= 16384 for command, options in commands)
for command, options in commands[:-1]:
    assert "-B" in command and "socket.socket.connect=no_network" in command[-1]
    assert options["env"]["HF_HUB_OFFLINE"] == "1"
`));

  it("官方入口适配器先create预热并强制回环且复用自有槽位 [external-memoryarena-shopping-loopback-adapter]", () => assertPythonCase(`
events = []
server = types.SimpleNamespace(create=lambda: events.append("warm") or 47)
class App:
    def get(self, path):
        assert path == "/__deskpet_owner"
        return lambda handler: handler
app = App()
def run(app, **kwargs):
    events.append("listen")
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 4123 and kwargs["workers"] == 1 and kwargs["reload"] is False
    assert server.create() == 47 and server.create() == 47
    assert server.close(47) is True and server.close(9) is False
uvicorn = types.ModuleType("uvicorn")
uvicorn.run = run
launch = types.SimpleNamespace(webshop_env_server_lite=server, main=lambda: uvicorn.run(app, host="0.0.0.0", port=9999))
service = types.ModuleType("env.env_systems.web_shopping_env.runtime.service")
service.launch_lite = launch
with patch.dict(sys.modules, {"uvicorn": uvicorn, "env.env_systems.web_shopping_env.runtime.service": service}), patch.dict(os.environ, {b.SHOPPING_OWNER_ENV: "a" * 32}), patch.object(b, "_shopping_variables", return_value={}), patch.object(b, "_installed_source", return_value=root):
    b._launch_shopping_service(root, 4123)
assert events == ["warm", "listen"]
assert uvicorn.run is run
`));

  it("服务句柄在预热超时取消时清理且每run任务目录隔离 [external-memoryarena-shopping-owned-service-lifetime]", () => assertPythonCase(`${tinyLock}
owned = types.SimpleNamespace(poll=lambda: None)
closed = []
finished = []
started = []
def start(command, **kwargs):
    started.append((command, kwargs))
    assert kwargs["env"][b.SHOPPING_URL_ENV].startswith("http://127.0.0.1:")
    assert "SECRET_FOR_TEST" not in kwargs["env"]
    return owned
capture = types.SimpleNamespace(exceeded=life.threading.Event(), result=lambda: ["", ""], finish=lambda process: finished.append(process))
paths = []
with patch.object(b, "_environment_lock", return_value=lock), patch.object(b, "_verify_official_source", return_value=root), patch.object(b, "_check_resource"), patch.object(b, "_resolve_java", return_value={"JAVA_HOME": str(root), "JVM_PATH": str(root / "lib")}), patch.object(b, "_shopping_variables", return_value={}), patch.object(b, "owned_popen", side_effect=start), patch.object(b, "BoundedOutput", return_value=capture), patch.object(b, "stop_owned", side_effect=lambda process, **kwargs: closed.append(process)), patch.dict(os.environ, {"SECRET_FOR_TEST": "not-a-real-secret"}):
    for cancelled in [False, True]:
        with patch.object(b, "_shopping_owner_at", return_value=True):
            try:
                with b._prewarm_shopping_service(root) as lease:
                    path = Path(lease[b.SHOPPING_RUN_ENV])
                    paths.append(path)
                    (path / "task.json").write_text("{}")
                    if cancelled:
                        raise KeyboardInterrupt()
            except KeyboardInterrupt:
                assert cancelled
            assert not path.exists()
    with patch.object(b, "_shopping_owner_at", return_value=False), patch.object(b, "SHOPPING_READY_SECONDS", 0):
        try:
            with b._prewarm_shopping_service(root):
                raise AssertionError("unready service yielded")
        except RuntimeError as exc:
            assert "prewarm timed out" in str(exc)
assert paths[0] != paths[1]
assert len(started) == len(closed) == len(finished) == 3
assert all(process is owned for process in closed)
`));

  it("信号取消会退出MCP循环而非被工具错误吞掉 [external-memoryarena-shopping-signal-cleanup]", () => assertPythonCase(`
step = root / "step.json"
step.write_text("{}")
message = {"id": 1, "method": "tools/call", "params": {"name": "begin_task"}}
handlers = {}
def register(sig, handler):
    old = handlers.get(sig, signal.SIG_DFL)
    handlers[sig] = handler
    return old
def cancel(*args, **kwargs):
    handlers[signal.SIGTERM](signal.SIGTERM, None)
with patch.object(life.signal, "signal", side_effect=register), patch.object(b, "_shopping_environment", side_effect=cancel), patch.object(b, "_cleanup_shopping") as cleanup, patch.dict(os.environ, {"DESKPET_MEMORYARENA_STEP_FILE": str(step)}), patch.object(sys, "stdin", io.StringIO(json.dumps(message))), patch.object(sys, "stdout", io.StringIO()) as output:
    try:
        b._serve_mcp(root, "bundled_shopping")
        raise AssertionError("signal swallowed by tool error handler")
    except KeyboardInterrupt:
        pass
    assert cleanup.call_count == 1
    assert output.getvalue() == ""
`));
});
