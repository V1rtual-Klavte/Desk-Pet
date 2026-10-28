"""Detached launcher and single result adjudicator for one selected Harbor trial."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from lhtb_install import REVISION

MAX_RESULT_BYTES = 4 * 1024 * 1024


def _write_status(path: Path, status: dict[str, Any]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".status-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(status, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read_object(path: Path) -> dict[str, Any]:
    with path.open("rb") as stream:
        raw = stream.read(MAX_RESULT_BYTES + 1)
    if len(raw) > MAX_RESULT_BYTES:
        raise ValueError("result JSON exceeds its byte limit")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def validate_request(request: dict[str, Any], run_root: Path) -> None:
    run_id = request.get("runId")
    task_id = request.get("taskId")
    if not isinstance(run_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,95}", run_id):
        raise ValueError("invalid run identity")
    if run_root.name != run_id or request.get("revision") != REVISION:
        raise ValueError("request identity mismatch")
    if not isinstance(task_id, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", task_id):
        raise ValueError("invalid task identity")
    task_path = Path(request["taskPath"])
    if not task_path.is_absolute() or task_path.name != task_id or not request.get("taskName"):
        raise ValueError("task path/name identity mismatch")


def adjudicate_result(request: dict[str, Any], run_root: Path, exit_code: int, error: str | None = None) -> dict[str, Any]:
    """Pinned Harbor schema: trial_name, LocalTaskId.path, config and finite rewards.

    completed means execution + verifier completion, never an official benchmark pass.
    Only the conventional scalar `reward` in [0, 1] has a derived passed flag.
    """
    outcome: dict[str, Any] = {"status": "failed", "error": error, "reward": None, "rewards": None, "passed": None, "trialResults": [], "taskResultCount": 0}
    try:
        validate_request(request, run_root)
        if type(exit_code) is not int or exit_code != 0:
            raise ValueError(error or f"Harbor process exited {exit_code}")
        trial_root = run_root / "trials" / request["runId"]
        result_path = trial_root / "result.json"
        # Never traverse another trial or a substituted/symlinked output directory.
        for path in (run_root / "trials", trial_root, result_path):
            if path.is_symlink():
                raise ValueError("trial result path must not be a symlink")
        result = _read_object(result_path)
        config = result["config"]
        task_path = str(Path(request["taskPath"]).resolve())
        agent = config["agent"]
        if (result["trial_name"] != request["runId"] or result["task_name"] != request["taskName"]
                or result["task_id"] != {"path": request["taskPath"]}
                or result["trial_uri"] != trial_root.resolve().as_uri()
                or config["trial_name"] != request["runId"]
                or str(Path(config["trials_dir"]).resolve()) != str((run_root / "trials").resolve())
                or str(Path(config["task"]["path"]).resolve()) != task_path
                or config["task"].get("git_url") is not None or config["task"].get("name") is not None
                or agent.get("import_path") != "lhtb_harbor_agent:DeskPetHarborAgent"
                or agent["kwargs"].get("task_id") != request["taskId"]
                or agent["kwargs"].get("run_id") != request["runId"]):
            raise ValueError("Harbor trial/task identity mismatch")
        UUID(result["id"])
        if result["exception_info"] is not None:
            raise ValueError("Harbor trial exception: " + str(result["exception_info"].get("exception_type", "unknown")))
        if not result["finished_at"] or config["verifier"].get("disable") is not False:
            raise ValueError("Harbor execution/verifier did not finish")
        datetime.fromisoformat(result["finished_at"].replace("Z", "+00:00"))
        steps = result.get("step_results")
        if steps is not None and (not isinstance(steps, list) or any(not isinstance(step, dict) or step.get("exception_info") is not None for step in steps)):
            raise ValueError("Harbor step exception or malformed step results")
        rewards = result["verifier_result"]["rewards"]
        if not isinstance(rewards, dict) or not rewards or len(rewards) > 256 or any(
            not isinstance(key, str) or not key or len(key) > 256 or isinstance(value, bool)
            or not isinstance(value, (float, int)) or not math.isfinite(value)
            for key, value in rewards.items()
        ):
            raise ValueError("Harbor verifier rewards are missing or invalid")
        reward = rewards.get("reward")
        passed = (reward == 1) if reward is not None and 0 <= reward <= 1 else None
        summary = {"runId": request["runId"], "taskId": request["taskId"], "taskPath": request["taskPath"],
                   "trialName": result["trial_name"], "resultPath": str(result_path), "rewards": rewards}
        outcome.update(status="completed", error=None, reward=reward, rewards=rewards, passed=passed, trialResults=[summary], taskResultCount=1)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as exc:
        # Single bounded error exit, persisted in status.json; never substitute another trial.
        outcome["error"] = str(exc)[:2000]
    return outcome


def main() -> int:
    inspect_only = len(sys.argv) == 3 and sys.argv[1] == "--status"
    if len(sys.argv) != 2 and not inspect_only:
        return 64
    request_path = Path(sys.argv[-1]).resolve()
    request = _read_object(request_path)
    run_root = request_path.parent
    validate_request(request, run_root)
    status_path = run_root / "status.json"
    if inspect_only:
        status = _read_object(status_path)
        if any(status.get(key) != request.get(key) for key in ("runId", "taskId", "revision")):
            raise ValueError("LHTB status identity mismatch")
        if status.get("status") in {"completed", "failed"}:
            status.update(adjudicate_result(request, run_root, status.get("exitCode"), status.get("error")))
        print(json.dumps(status, ensure_ascii=False, allow_nan=False))
        return 0
    log_path = Path(request["logPath"])
    status = {
        "schemaVersion": 1, "runId": request["runId"], "taskId": request["taskId"], "revision": request["revision"],
        "status": "running", "pid": os.getpid(), "startedAt": datetime.now(timezone.utc).isoformat(),
        "statusPath": str(status_path), "logPath": str(log_path),
    }
    _write_status(status_path, status)
    env = {**os.environ, **request.get("env", {})}
    error = None
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("ab", buffering=0) as log:
            child = subprocess.Popen([request["command"], *request["args"]], cwd=request["cwd"], env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, shell=False)
            status["harborPid"] = child.pid
            _write_status(status_path, status)
            return_code = child.wait()
    except Exception as exc:
        error = str(exc)[:2000]
        return_code = 127
    status.update(adjudicate_result(request, run_root, return_code, error))
    status.update(exitCode=return_code, finishedAt=datetime.now(timezone.utc).isoformat())
    _write_status(status_path, status)
    return 0 if status["status"] == "completed" else (return_code or 1)


if __name__ == "__main__":
    raise SystemExit(main())
