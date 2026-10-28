"""Bounded MCP stdio jobs for a Harbor-owned terminal environment (no host shell)."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
from collections import OrderedDict
from typing import Any

# Shared with the Harbor broker. Limits include JSON escaping and UTF-8 bytes.
MAX_LINE_BYTES = 1_048_576
MAX_COMMAND_CHARS = 16_384
MAX_OUTPUT_CHARS = 120_000
MAX_OUTPUT_JSON_BYTES = 256 * 1024
DEFAULT_TIMEOUT_SECONDS = 300
MAX_TIMEOUT_SECONDS = 900
MAX_POLL_SECONDS = 40
MAX_JOBS = 16
MAX_REQUESTS = 16
CLOSE_TIMEOUT_SECONDS = 5
TRUNCATION_MARKER = "\n[output truncated]"


def require_unix() -> None:
    if os.name == "nt":
        raise RuntimeError("LHTB terminal bridge is unsupported on Windows: Unix sockets are required")


def encode_line(message: dict[str, Any]) -> bytes:
    raw = (json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    if len(raw) > MAX_LINE_BYTES:
        raise ValueError("JSON line exceeds the byte limit")
    return raw


def bounded_output(value: Any) -> tuple[str, bool]:
    text = str(value or "")
    candidate = text[:MAX_OUTPUT_CHARS]
    if len(candidate) == len(text) and len(json.dumps(candidate, ensure_ascii=False).encode("utf-8")) <= MAX_OUTPUT_JSON_BYTES:
        return candidate, False
    low, high = 0, len(candidate)
    while low < high:
        mid = (low + high + 1) // 2
        size = len(json.dumps(candidate[:mid] + TRUNCATION_MARKER, ensure_ascii=False).encode("utf-8"))
        if size <= MAX_OUTPUT_JSON_BYTES:
            low = mid
        else:
            high = mid - 1
    return candidate[:low] + TRUNCATION_MARKER, True


async def read_line(reader: asyncio.StreamReader) -> bytes:
    try:
        line = await reader.readline()
    except ValueError as error:
        raise ValueError("JSON line exceeds the byte limit") from error
    if not line or len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
        raise ValueError("invalid or oversized JSON line")
    return line


async def close_writer(writer: asyncio.StreamWriter) -> None:
    writer.close()
    try:
        await asyncio.wait_for(writer.wait_closed(), CLOSE_TIMEOUT_SECONDS)
    except (ConnectionError, OSError, asyncio.TimeoutError) as error:
        # Connection closure is best effort after close(); diagnostics never use MCP stdout.
        print(f"LHTB broker close: {type(error).__name__}", file=sys.stderr)


def _emit(message: dict[str, Any]) -> None:
    sys.stdout.buffer.write(encode_line(message))
    sys.stdout.buffer.flush()


async def _broker_call(command: str, timeout_seconds: int) -> dict[str, Any]:
    socket_path = os.environ.get("DESKPET_LHTB_BROKER_SOCKET")
    token = os.environ.get("DESKPET_LHTB_BROKER_TOKEN")
    if not socket_path or not token:
        raise RuntimeError("Harbor terminal broker is not configured")
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(socket_path, limit=MAX_LINE_BYTES), CLOSE_TIMEOUT_SECONDS)
    try:
        writer.write(encode_line({"token": token, "command": command, "timeoutSec": timeout_seconds}))
        await asyncio.wait_for(writer.drain(), CLOSE_TIMEOUT_SECONDS)
        line = await asyncio.wait_for(read_line(reader), timeout=timeout_seconds + CLOSE_TIMEOUT_SECONDS)
        response = json.loads(line)
        if not isinstance(response, dict):
            raise ValueError("invalid broker response object")
        if response.get("ok") is not True:
            raise RuntimeError(str(response.get("error", "Harbor terminal command failed"))[:1000])
        if type(response.get("returnCode")) is not int or any(not isinstance(response.get(key), str) for key in ("stdout", "stderr")):
            raise ValueError("invalid broker terminal result")
        return response
    finally:
        # Cancellation closes this one job's connection. The broker observes EOF and cancels exec.
        await close_writer(writer)


def _tool_result(value: dict[str, Any], error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, separators=(",", ":"))}], "isError": error}


def _integer(value: Any, name: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} must be an integer from {low} to {high}")
    return value


class TerminalJobs:
    """One active command per MCP session; bounded terminal-result retention."""

    def __init__(self) -> None:
        self.jobs: OrderedDict[str, dict[str, Any]] = OrderedDict()

    async def _execute(self, job: dict[str, Any], command: str, timeout: int) -> None:
        try:
            result = await _broker_call(command, timeout)
            stdout, out_cut = bounded_output(result["stdout"])
            stderr, err_cut = bounded_output(result["stderr"])
            job["result"] = {"jobId": job["id"], "status": "completed", "exitCode": result["returnCode"],
                             "stdout": stdout, "stderr": stderr,
                             "stdoutTruncated": out_cut or result.get("stdoutTruncated", False),
                             "stderrTruncated": err_cut or result.get("stderrTruncated", False)}
        except asyncio.CancelledError:
            job["result"] = {"jobId": job["id"], "status": "cancelled"}
            raise
        except Exception as error:
            job["result"] = {"jobId": job["id"], "status": "failed", "error": str(error)[:1000]}

    async def cancel(self, job: dict[str, Any]) -> None:
        task = job["task"]
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        # Cancellation before _execute's first instruction still has an explicit terminal state.
        if task.cancelled():
            job["result"] = {"jobId": job["id"], "status": "cancelled"}

    async def close(self) -> None:
        await asyncio.gather(*(self.cancel(job) for job in self.jobs.values()))
        self.jobs.clear()

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(arguments, dict):
            raise ValueError("tool arguments must be an object")
        allowed = {"terminal_exec": {"command", "timeout_seconds"}, "terminal_poll": {"jobId", "wait_seconds"}, "terminal_cancel": {"jobId"}}
        if name not in allowed or set(arguments) - allowed[name]:
            raise ValueError("unknown MCP tool or arguments")
        if name == "terminal_exec":
            command = arguments.get("command")
            if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_CHARS:
                raise ValueError(f"command must be a non-empty string up to {MAX_COMMAND_CHARS} characters")
            timeout = _integer(arguments.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS), "timeout_seconds", 1, MAX_TIMEOUT_SECONDS)
            if any(not job["task"].done() for job in self.jobs.values()):
                raise ValueError("one terminal job is already running; poll or cancel it first")
            if len(self.jobs) == MAX_JOBS:
                self.jobs.popitem(last=False)
            job_id = secrets.token_hex(16)
            job: dict[str, Any] = {"id": job_id, "result": {"jobId": job_id, "status": "running"}}
            self.jobs[job_id] = job
            job["task"] = asyncio.create_task(self._execute(job, command, timeout))
            return _tool_result({"jobId": job_id, "status": "running"})
        job_id = arguments.get("jobId")
        if not isinstance(job_id, str) or job_id not in self.jobs:
            raise ValueError("unknown or expired jobId in this MCP session")
        job = self.jobs[job_id]
        if name == "terminal_cancel":
            await self.cancel(job)
        else:
            wait = _integer(arguments.get("wait_seconds", MAX_POLL_SECONDS), "wait_seconds", 0, MAX_POLL_SECONDS)
            try:
                if wait and not job["task"].done():
                    # A normal poll deadline never cancels a job. A cancelled MCP request does.
                    await asyncio.wait({job["task"]}, timeout=wait)
            except asyncio.CancelledError:
                await self.cancel(job)
                raise
        result = job["result"]
        return _tool_result(result, result["status"] in {"failed", "cancelled"} or result.get("exitCode", 0) != 0)


def tools() -> list[dict[str, Any]]:
    def tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
        return {"name": name, "description": description, "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}
    job_id = {"type": "string", "description": "jobId returned by terminal_exec in this MCP session."}
    return [
        tool("terminal_exec", "Start one command in the isolated LHTB Harbor environment; returns jobId/running immediately. Use terminal_poll until it finishes, or terminal_cancel. One active job per session; last 16 results retained. Only the official verifier determines reward.", {
            "command": {"type": "string", "maxLength": MAX_COMMAND_CHARS, "description": "Shell command in the task container, never the host."},
            "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": MAX_TIMEOUT_SECONDS, "default": DEFAULT_TIMEOUT_SECONDS},
        }, ["command"]),
        tool("terminal_poll", "Poll a job for at most 40 seconds. Returns running or terminal status, exitCode/stdout/stderr and truncation flags. Repeat for long commands; cancelling this request also cancels its job.", {
            "jobId": job_id, "wait_seconds": {"type": "integer", "minimum": 0, "maximum": MAX_POLL_SECONDS, "default": MAX_POLL_SECONDS},
        }, ["jobId"]),
        tool("terminal_cancel", "Cancel only the specified job owned by this MCP session; closes its broker execution connection.", {"jobId": job_id}, ["jobId"]),
    ]


async def _serve() -> None:
    jobs = TerminalJobs()
    requests: dict[str | int, asyncio.Task] = {}

    async def respond(request: dict[str, Any]) -> None:
        request_id = request["id"]
        try:
            method = request["method"]
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise ValueError("params must be an object")
            if method == "initialize":
                result = {"protocolVersion": params.get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {}}, "serverInfo": {"name": "desk-pet-lhtb-terminal", "version": "1.0.0"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": tools()}
            elif method == "tools/call":
                try:
                    result = await jobs.call(params.get("name"), params.get("arguments", {}))
                except Exception as error:
                    result = _tool_result({"status": "failed", "error": str(error)[:1000]}, True)
            else:
                _emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method not found"}})
                return
            _emit({"jsonrpc": "2.0", "id": request_id, "result": result})
        except asyncio.CancelledError:
            # MCP cancellation deliberately has no response; jobs.call performs owned cleanup.
            raise
        except Exception as error:
            _emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": str(error)[:500]}})
        finally:
            requests.pop(request_id, None)

    try:
        while True:
            # A single bounded reader thread keeps stdin available while poll requests await jobs.
            raw = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_LINE_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
                _emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "request too large or unterminated"}})
                break
            try:
                request = json.loads(raw)
            except (ValueError, UnicodeError):
                _emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "invalid JSON"}})
                continue
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
                _emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}})
                continue
            if "id" not in request:
                params = request.get("params", {})
                if request["method"] == "notifications/cancelled" and isinstance(params, dict):
                    target = params.get("requestId")
                    if type(target) in (str, int) and target in requests:
                        requests[target].cancel()
                continue
            request_id = request["id"]
            if type(request_id) not in (str, int) or request_id in requests or len(requests) >= MAX_REQUESTS:
                _emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid/duplicate id or too many in-flight requests"}})
                continue
            task = asyncio.create_task(respond(request))
            requests[request_id] = task
            # A task cancelled before its first instruction never enters respond's finally.
            def forget(done: asyncio.Task, key: str | int = request_id) -> None:
                if requests.get(key) is done:
                    requests.pop(key, None)
            task.add_done_callback(forget)
    finally:
        pending = list(requests.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await jobs.close()


if __name__ == "__main__":
    try:
        require_unix()
        asyncio.run(_serve())
    except Exception as error:
        print(str(error)[:1000], file=sys.stderr)
        raise SystemExit(1)
