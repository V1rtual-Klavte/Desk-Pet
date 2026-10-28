"""Owned subprocess lifetimes and bounded pipes; no provider or system installation."""
from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
import threading
import time
from typing import Any


@contextlib.contextmanager
def cancellation_scope():
    """Turn cancellation into unwinding; repeated signals cannot interrupt cleanup."""
    previous = {}
    def cancelled(signum, _frame):
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        raise KeyboardInterrupt(f"MemoryArena operation cancelled by signal {signum}")
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, cancelled)
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def process_options() -> dict[str, Any]:
    return {"start_new_session": True} if os.name != "nt" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}


def owned_popen(command, **kwargs) -> subprocess.Popen:
    process = subprocess.Popen(command, **kwargs, **process_options())
    if os.name == "nt":
        # Windows SIGTERM terminates Python without unwinding. A run-owned Job
        # closes with its owning process and kills only its assigned descendants.
        import ctypes
        from ctypes import wintypes
        class BasicLimits(ctypes.Structure):
            _fields_ = [("per_process", ctypes.c_int64), ("per_job", ctypes.c_int64), ("flags", wintypes.DWORD),
                        ("min_working", ctypes.c_size_t), ("max_working", ctypes.c_size_t), ("active", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("basic", BasicLimits), ("io", IoCounters), ("process_memory", ctypes.c_size_t),
                        ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.SetInformationJobObject.restype = wintypes.BOOL
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        job = kernel.CreateJobObjectW(None, None)
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, wintypes.HANDLE(int(process._handle))):
            if job:
                kernel.CloseHandle(job)
            process.kill()
            process.wait(timeout=5)
            raise RuntimeError("Cannot establish the owned MemoryArena Windows process job")
        process._memoryarena_job = (kernel, job)
    return process


def stop_owned(process: subprocess.Popen, grace_seconds: float = 3, *, graceful_tree: bool = True) -> None:
    """Only accepts the live handle created by this owner; never enumerates processes."""
    job = getattr(process, "_memoryarena_job", None)
    if job is not None:
        kernel, handle = job
        kernel.CloseHandle(handle)
        process._memoryarena_job = None
        process.wait(timeout=5)
        return
    if process.poll() is None:
        try:
            if os.name == "nt":
                # TerminateProcess on the parent first loses the tree. Target the
                # still-owned live PID and descendants before reaping its handle.
                killed = subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
                if killed.returncode != 0 and process.poll() is None:
                    raise RuntimeError("Could not stop the owned MemoryArena process tree")
            elif graceful_tree:
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
            process.wait(timeout=grace_seconds)
        except ProcessLookupError:
            pass  # Already exited; the handle wait below is the single reap point.
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL)
            process.kill()
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # Owned group is gone; no global process-name/port cleanup is allowed.
    process.wait(timeout=5)


class BoundedOutput:
    """Drain both pipes without ever retaining more than limit bytes in total."""
    def __init__(self, process: subprocess.Popen, limit: int):
        self.limit = limit
        self.data = [bytearray(), bytearray()]
        self.lock = threading.Lock()
        self.exceeded = threading.Event()
        self.finished = [threading.Event(), threading.Event()]
        self.threads = []
        for index, pipe in enumerate((process.stdout, process.stderr)):
            thread = threading.Thread(target=self._read, args=(index, pipe), daemon=True)
            thread.start()
            self.threads.append(thread)

    def _read(self, index, pipe):
        try:
            while True:
                block = os.read(pipe.fileno(), 8192)
                if not block:
                    break
                with self.lock:
                    remaining = self.limit - sum(map(len, self.data))
                    self.data[index].extend(block[:remaining])
                    if len(block) > remaining:
                        self.exceeded.set()
        except (OSError, ValueError):
            # Owner closes pipes after bounded termination; result/exit status records failure.
            self.exceeded.set()
        finally:
            self.finished[index].set()

    def result(self):
        with self.lock:
            return [bytes(value).decode("utf-8", errors="replace") for value in self.data]

    def finish(self, process):
        for thread in self.threads:
            thread.join(timeout=1)
        for pipe in (process.stdout, process.stderr):
            pipe.close()


def run_bounded(command, *, input_data: str | bytes | None = None, timeout: float,
                max_output: int = 65536, cwd=None, env=None, grace_seconds: float = 3,
                graceful_tree: bool = True) -> dict[str, Any]:
    process = owned_popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    capture = BoundedOutput(process, max_output)
    writer = None
    if input_data is not None:
        payload = input_data.encode("utf-8") if isinstance(input_data, str) else input_data
        def feed():
            try:
                process.stdin.write(payload)
                process.stdin.flush()
            except (BrokenPipeError, OSError, ValueError):
                pass  # Early child exit is reported by exitCode; do not turn it into success.
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    pass  # Child closed stdin during cancellation; exitCode records it.
        writer = threading.Thread(target=feed, daemon=True)
        writer.start()
    deadline = time.monotonic() + timeout
    timed_out = False
    try:
        while process.poll() is None or not all(event.is_set() for event in capture.finished):
            if capture.exceeded.is_set():
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            capture.exceeded.wait(min(0.05, remaining))
    finally:
        try:
            stop_owned(process, grace_seconds, graceful_tree=graceful_tree)
        finally:
            capture.finish(process)
            if writer is not None:
                writer.join(timeout=1)
    stdout, stderr = capture.result()
    return {"exitCode": process.returncode, "timedOut": timed_out, "outputLimited": capture.exceeded.is_set(), "stdout": stdout, "stderr": stderr}
