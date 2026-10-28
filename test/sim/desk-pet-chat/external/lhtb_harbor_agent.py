"""Harbor BaseAgent adapter that delegates the agent loop to Desk-Pet."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import sys
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from lhtb_mcp_server import (
    CLOSE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS, MAX_COMMAND_CHARS, MAX_LINE_BYTES,
    MAX_REQUESTS, MAX_TIMEOUT_SECONDS, bounded_output, close_writer, encode_line, read_line, require_unix,
)


STOP_GRACE_SECONDS = 70
KILL_WAIT_SECONDS = 5


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    """Signal only the Node child owned by this phase; Node owns native-host cleanup."""
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        pass  # Child exited concurrently; process.wait below still reaps our handle.
    try:
        await asyncio.wait_for(process.wait(), STOP_GRACE_SECONDS)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass  # The same owned child may have exited just before kill.
        await asyncio.wait_for(process.wait(), KILL_WAIT_SECONDS)


async def _finish_cleanup(awaitable: Any) -> None:
    # Repeated Harbor cancellation must not interrupt owned-process/connection cleanup.
    task = asyncio.create_task(awaitable)
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError


async def _communicate_bounded(process: asyncio.subprocess.Process, request: bytes) -> tuple[bytes, bytes]:
    async def collect(reader: asyncio.StreamReader, cap: int, tail: bool) -> bytes:
        output = bytearray()
        while chunk := await reader.read(16 * 1024):
            if not tail and len(output) + len(chunk) > cap:
                raise RuntimeError("Desk-Pet environment turn response exceeded 1 MiB")
            output.extend(chunk)
            if tail and len(output) > cap:
                del output[:-cap]
        return bytes(output)

    stdout = asyncio.create_task(collect(process.stdout, MAX_LINE_BYTES, False))
    stderr = asyncio.create_task(collect(process.stderr, 64 * 1024, True))
    try:
        process.stdin.write(request)
        await process.stdin.drain()
        process.stdin.close()
        result = await asyncio.gather(stdout, stderr)
        await process.wait()
        return result[0], result[1]
    finally:
        for task in (stdout, stderr):
            if not task.done():
                task.cancel()
        await asyncio.gather(stdout, stderr, return_exceptions=True)


class DeskPetHarborAgent(BaseAgent):
    """A Harbor custom agent whose actual reasoning/tool loop is Desk-Pet's harness."""

    def __init__(
        self,
        *args: Any,
        task_id: str,
        card_path: str,
        authorization_path: str,
        run_id: str | None = None,
        node_path: str | None = None,
        timeout_seconds: int | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        if not task_id or not card_path or not authorization_path:
            raise ValueError("task_id, card_path, and authorization_path are required")
        self.task_id = task_id
        self.card_path = str(Path(card_path).resolve())
        self.authorization_path = str(Path(authorization_path).resolve())
        self.run_id = run_id
        self.node_path = node_path or os.environ.get("DESKPET_NODE", "node")
        self.timeout_seconds = timeout_seconds
        self._phase = 0
        self._broker_busy = False

    @staticmethod
    def name() -> str:
        return "desk-pet-lhtb"

    def version(self) -> str:
        return "1.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        # Harbor owns the task container lifecycle; Desk-Pet reaches it only through environment.exec.
        return None

    async def _serve_broker(self, environment: BaseEnvironment, expected_token: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        execution = None
        disconnected = None
        admitted = False
        try:
            try:
                line = await asyncio.wait_for(read_line(reader), CLOSE_TIMEOUT_SECONDS)
                request = json.loads(line)
                token = request.get("token")
                command = request.get("command")
                timeout_sec = request.get("timeoutSec", DEFAULT_TIMEOUT_SECONDS)
                if not isinstance(token, str) or not hmac.compare_digest(token, expected_token):
                    raise PermissionError("broker authorization failed")
                if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_CHARS:
                    raise ValueError("command is empty or exceeds its size limit")
                if type(timeout_sec) is not int or not 1 <= timeout_sec <= MAX_TIMEOUT_SECONDS:
                    raise ValueError(f"timeoutSec must be an integer from 1 to {MAX_TIMEOUT_SECONDS}")
                if self._broker_busy:
                    raise ValueError("another terminal job is already executing")
                self._broker_busy = admitted = True
                execution = asyncio.create_task(environment.exec(command=command, timeout_sec=timeout_sec))
                # One request per connection: EOF (or extra bytes) cancels exactly this exec.
                disconnected = asyncio.create_task(reader.read(1))
                done, _ = await asyncio.wait({execution, disconnected}, timeout=timeout_sec, return_when=asyncio.FIRST_COMPLETED)
                if disconnected in done:
                    return
                if execution not in done:
                    raise TimeoutError("Harbor terminal execution exceeded its deadline")
                result = execution.result()
                self._broker_busy = admitted = False
                stdout, stdout_cut = bounded_output(result.stdout)
                stderr, stderr_cut = bounded_output(result.stderr)
                response = {"ok": True, "returnCode": int(result.return_code), "stdout": stdout, "stderr": stderr,
                            "stdoutTruncated": stdout_cut, "stderrTruncated": stderr_cut}
            except Exception as error:
                response = {"ok": False, "error": str(error)[:1000]}
            writer.write(encode_line(response))
            await asyncio.wait_for(writer.drain(), CLOSE_TIMEOUT_SECONDS)
        finally:
            owned = [task for task in (execution, disconnected) if task is not None]
            for task in owned:
                if not task.done():
                    task.cancel()
            try:
                if owned:
                    await asyncio.wait_for(asyncio.gather(*owned, return_exceptions=True), CLOSE_TIMEOUT_SECONDS)
            finally:
                if admitted:
                    self._broker_busy = False
                await close_writer(writer)

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        from tempfile import gettempdir

        require_unix()
        if type(self.timeout_seconds) is not int or self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be a positive bounded phase timeout")
        # macOS limits AF_UNIX paths; use a random short socket name and remove it after the turn.
        token = secrets.token_urlsafe(32)
        socket_path = str(Path(gettempdir()) / f"dp-lhtb-{secrets.token_hex(6)}.sock")
        self._phase += 1
        base_run_id = self.run_id if self.run_id and self.run_id.islower() and all(ch.isalnum() or ch == "-" for ch in self.run_id) else "lhtb-" + secrets.token_hex(8)
        runtime_run_id = f"{base_run_id}-phase-{self._phase}"
        connections: dict[asyncio.Task, asyncio.StreamWriter] = {}

        async def connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                await self._serve_broker(environment, token, reader, writer)
            except (ConnectionError, OSError, ValueError, asyncio.TimeoutError) as error:
                print(f"LHTB broker connection: {type(error).__name__}", file=sys.stderr)
            finally:
                connections.pop(asyncio.current_task(), None)

        def accept(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            if len(connections) >= MAX_REQUESTS:
                writer.close()
                return
            task = asyncio.create_task(connection(reader, writer))
            connections[task] = writer

        server = await asyncio.start_unix_server(accept, path=socket_path, limit=MAX_LINE_BYTES)
        process = None
        communication = None
        cancelled = False
        try:
            os.chmod(socket_path, 0o600)
            external_dir = Path(__file__).resolve().parent
            python_path = sys.executable
            mcp_server = {
                "name": "lhtb_terminal",
                "transport": "stdio",
                "command": python_path,
                "args": [str(external_dir / "lhtb_mcp_server.py")],
                "env": {},
                "includeTools": ["terminal_exec", "terminal_poll", "terminal_cancel"],
                "enabled": True,
            }
            request = {
                "schemaVersion": 1,
                "dataset": "lhtb",
                "taskId": self.task_id,
                "instruction": instruction,
                "cardPath": self.card_path,
                "authorizationPath": self.authorization_path,
                "timeoutSeconds": self.timeout_seconds,
                "runId": runtime_run_id,
                "mcpServer": mcp_server,
                # Runtime-only routing values. The Node/host boundary must never persist or hash them.
                "brokerEnv": {
                    "DESKPET_LHTB_BROKER_SOCKET": socket_path,
                    "DESKPET_LHTB_BROKER_TOKEN": token,
                },
            }
            node_script = external_dir / "environment-turn.mjs"
            if not node_script.is_file():
                raise RuntimeError("Desk-Pet environment-turn.mjs integration hook is missing")
            repo_root = Path(__file__).resolve().parents[4]
            process = await asyncio.create_subprocess_exec(
                self.node_path,
                str(node_script),
                cwd=str(repo_root),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, **request["brokerEnv"]},
            )
            communication = asyncio.create_task(_communicate_bounded(process, encode_line(request)))
            try:
                stdout, stderr = await asyncio.wait_for(asyncio.shield(communication), timeout=self.timeout_seconds)
            except asyncio.CancelledError:
                cancelled = True
                # The finally block uses the same bounded stop as the timeout path, then rethrows cancellation.
                raise
            if len(stdout) > 1_048_576:
                raise RuntimeError("Desk-Pet environment turn response exceeded 1 MiB")
            if process.returncode != 0:
                safe_stderr = stderr.decode("utf-8", errors="replace")[-4000:]
                raise RuntimeError(f"Desk-Pet environment turn failed ({process.returncode}): {safe_stderr}")
            lines = stdout.decode("utf-8", errors="strict").strip().splitlines()
            if not lines:
                raise RuntimeError("Desk-Pet environment turn returned no result")
            result = json.loads(lines[-1])
            if result.get("executionComplete") is not True:
                raise RuntimeError("Desk-Pet reported incomplete execution; Harbor verifier will still determine the trial result")
            context.metadata = {
                **(context.metadata or {}),
                "deskpetRunId": result.get("runId"),
                "deskpetEvidenceRoot": result.get("evidenceRoot"),
                "deskpetExecutionComplete": True,
                "deskpetTaskId": self.task_id,
                "deskpetRuntime": "Desk-Pet Harness + Harbor environment.exec MCP broker",
            }
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            (self.logs_dir / "deskpet-runtime.json").write_text(
                json.dumps({key: value for key, value in context.metadata.items() if not key.lower().endswith("token")}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        finally:
            async def cleanup() -> None:
                server.close()
                await server.wait_closed()
                try:
                    if process is not None:
                        await _stop_process(process)
                finally:
                    pending = list(connections)
                    # Also close writers whose connection coroutine has not started yet.
                    for writer in list(connections.values()):
                        writer.close()
                    if communication is not None:
                        pending.append(communication)
                    for task in pending:
                        if not task.done():
                            task.cancel()
                    try:
                        await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), CLOSE_TIMEOUT_SECONDS * 2)
                    finally:
                        try:
                            os.unlink(socket_path)
                        except FileNotFoundError:
                            pass  # Server may remove its own socket on newer Python versions.
            try:
                await _finish_cleanup(cleanup())
            except Exception as error:
                if not cancelled:
                    raise
                # Cleanup failure is visible but must not replace Harbor's cancellation signal.
                print(f"LHTB cancelled phase cleanup failed: {type(error).__name__}: {str(error)[:500]}", file=sys.stderr)
