import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const processes: ReturnType<typeof spawn>[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const connections = new Set<Socket>();

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  for (const connection of connections) connection.destroy();
  connections.clear();
  for (const server of servers.splice(0)) if (server.listening) await new Promise<void>((done) => server.close(() => done()));
});

async function session(onCommand: (request: { token: string; command: string; timeoutSec: number }, socket: Socket) => void) {
  const token = `test-${randomUUID()}`;
  const broker = createServer((connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", (error: NodeJS.ErrnoException) => {
      // Oversized-frame rejection/owned session teardown may reset the fixture connection.
      if (error.code !== "ECONNRESET" && error.code !== "EPIPE") throw error;
    });
    const lines = createInterface({ input: connection });
    lines.once("line", (line) => onCommand(JSON.parse(line), connection));
  });
  servers.push(broker);
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("TCP fixture address missing");
  // Only replace the OS transport primitive: identical byte limits, broker calls and MCP loop on Windows/macOS.
  const child = spawn(process.env.PYTHON ?? "python3", ["-B", "-c", `
import asyncio, sys
import lhtb_mcp_server as m
async def connect(path, **kwargs):
    return await asyncio.open_connection('127.0.0.1', int(sys.argv[1]), **kwargs)
m.asyncio.open_unix_connection = connect
asyncio.run(m._serve())
`, String(address.port)], {
    cwd: resolve("."),
    env: { ...process.env, PYTHONPATH: resolve("test/sim/desk-pet-chat/external"), PYTHONDONTWRITEBYTECODE: "1", DESKPET_LHTB_BROKER_SOCKET: "test-transport", DESKPET_LHTB_BROKER_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  processes.push(child);
  const responses = new Map<number, (value: any) => void>();
  const received: number[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    received.push(message.id);
    responses.get(message.id)?.(message);
    responses.delete(message.id);
  });
  let sequence = 0;
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++sequence;
    const reply = new Promise<any>((done) => responses.set(id, done));
    send({ id, method, params });
    return { id, reply };
  };
  const call = async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args }).reply).result;
  const close = async () => { const exited = once(child, "exit"); child.stdin.end(); await exited; expect(child.exitCode).toBe(0); };
  return { token, child, request, call, send, received, close };
}

const payload = (result: any) => JSON.parse(result.content[0].text);

describe("LHTB terminal MCP broker", () => {
  it("启动job立即返回，poll保留结果和令牌边界 [external-lhtb-mcp-broker-roundtrip]", async () => {
    const calls: unknown[] = [];
    const client = await session((request, socket) => {
      calls.push(request);
      socket.end(`${JSON.stringify({ ok: true, returnCode: 0, stdout: "sandbox-output", stderr: "" })}\n`);
    });
    const initialized = await client.request("initialize", { protocolVersion: "2024-11-05" }).reply;
    expect(initialized.result.serverInfo.name).toBe("desk-pet-lhtb-terminal");
    client.send({ method: "notifications/initialized" });
    const listed = await client.request("tools/list").reply;
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["terminal_exec", "terminal_poll", "terminal_cancel"]);
    const started = payload(await client.call("terminal_exec", { command: "sandbox-witness", timeout_seconds: 7 }));
    expect(started).toEqual({ jobId: expect.any(String), status: "running" });
    const done = await client.call("terminal_poll", { jobId: started.jobId, wait_seconds: 2 });
    expect(done.isError).toBe(false);
    expect(payload(done)).toMatchObject({ jobId: started.jobId, status: "completed", exitCode: 0, stdout: "sandbox-output", stderr: "" });
    expect((await client.call("host_shell", { command: "id" })).isError).toBe(true);
    expect(calls).toEqual([{ token: client.token, command: "sandbox-witness", timeoutSec: 7 }]);
    await client.close();
  }, 15_000);

  it.each([
    { label: "ascii", text: "a".repeat(70 * 1024), caseId: "external-lhtb-mcp-seventy-kib" },
    { label: "utf8", text: "终端结果".repeat(20_000), caseId: "external-lhtb-mcp-utf-eight" },
  ])("传输大于64KiB的$label输出 [$caseId]", async ({ text }) => {
    const client = await session((_request, socket) => socket.end(`${JSON.stringify({ ok: true, returnCode: 0, stdout: text, stderr: "" })}\n`));
    const job = payload(await client.call("terminal_exec", { command: "output-fixture" }));
    const result = await client.call("terminal_poll", { jobId: job.jobId, wait_seconds: 2 });
    expect(result.isError).toBe(false);
    expect(payload(result).stdout).toBe(text);
    await client.close();
  }, 15_000);

  it("超界broker帧明确失败而非断线假成功 [external-lhtb-mcp-reject-oversize]", async () => {
    const client = await session((_request, socket) => socket.end(`${JSON.stringify({ ok: true, returnCode: 0, stdout: "x".repeat(1_048_576), stderr: "" })}\n`));
    const job = payload(await client.call("terminal_exec", { command: "oversize-fixture" }));
    const result = await client.call("terminal_poll", { jobId: job.jobId, wait_seconds: 2 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ status: "failed", error: expect.stringMatching(/limit|large|invalid/i) });
    await client.close();
  }, 15_000);

  it("poll不阻塞通知；取消请求会断开对应broker且只影响自有job [external-lhtb-mcp-async-poll-cancel]", async () => {
    let connected!: (socket: Socket) => void;
    const connection = new Promise<Socket>((done) => { connected = done; });
    const client = await session((_request, socket) => connected(socket));
    const job = payload(await client.call("terminal_exec", { command: "wait-fixture" }));
    const socket = await connection;
    const disconnected = once(socket, "end");
    expect(payload(await client.call("terminal_poll", { jobId: job.jobId, wait_seconds: 0 })).status).toBe("running");
    expect((await client.call("terminal_exec", { command: "second-job" })).isError).toBe(true);
    expect((await client.call("terminal_cancel", { jobId: "not-owned" })).isError).toBe(true);
    const pending = client.request("tools/call", { name: "terminal_poll", arguments: { jobId: job.jobId, wait_seconds: 40 } });
    expect((await client.request("ping").reply).result).toEqual({});
    client.send({ method: "notifications/cancelled", params: { requestId: pending.id } });
    await disconnected;
    const terminal = payload(await client.call("terminal_poll", { jobId: job.jobId, wait_seconds: 0 }));
    expect(terminal.status).toBe("cancelled");
    await client.close();
    expect(client.received).not.toContain(pending.id);
  }, 15_000);

  it("显式cancel与stdin关闭都关闭自有job连接 [external-lhtb-mcp-session-cleanup]", async () => {
    const accepted: Socket[] = [];
    const waiters: Array<(socket: Socket) => void> = [];
    const client = await session((_request, socket) => { accepted.push(socket); waiters.shift()?.(socket); });
    const next = () => new Promise<Socket>((done) => { if (accepted.length) done(accepted.shift()!); else waiters.push((socket) => { accepted.shift(); done(socket); }); });
    const job = payload(await client.call("terminal_exec", { command: "first" }));
    const first = await next();
    const firstEnd = once(first, "end");
    expect(payload(await client.call("terminal_cancel", { jobId: job.jobId })).status).toBe("cancelled");
    await firstEnd;
    await client.call("terminal_exec", { command: "second" });
    const second = await next();
    const secondEnd = once(second, "end");
    await client.close();
    await secondEnd;
  }, 15_000);
});
