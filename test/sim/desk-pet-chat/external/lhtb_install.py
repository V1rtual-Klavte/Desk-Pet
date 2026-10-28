"""Pinned, bounded installer for LHTB and its nested patched Harbor checkout."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


REVISION = "7ca0cacea9bf6a0694eaad7306bed794eaaaabce"
SOURCE_URL = "https://github.com/zli12321/LHTB"
ARCHIVE_SHA256 = "5280debd26c88f60c324603bf963605e89458980d0cb7177dfd023b91be0c0f3"
ARCHIVE_BYTES = 111233074
EXPECTED_TASK_COUNTS = {"tasks": 46, "tasks-2.0": 31}
MAX_ARCHIVE_BYTES = 350 * 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def is_runtime_artifact(name: str) -> bool:
    """Bytecode caches are derived by legitimate Harbor runs inside the editable checkout."""
    parts = PurePosixPath(name).parts
    return "__pycache__" in parts or name.endswith((".pyc", ".pyo"))


def tree_digest(root: Path) -> tuple[str, int, int]:
    digest = hashlib.sha256()
    total = 0
    count = 0
    for path in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.relative_to(root).as_posix()):
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("source tree contains an escaping symlink")
        name = path.relative_to(root).as_posix()
        if is_runtime_artifact(name):
            continue
        relative = name.encode("utf-8")
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
        total += len(content)
        count += 1
    return digest.hexdigest(), count, total


def safe_extract(archive: Path, destination: Path) -> Path:
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        roots: set[str] = set()
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not name.parts:
                raise ValueError("source archive contains an unsafe member path")
            roots.add(name.parts[0])
        if len(roots) != 1:
            raise ValueError("source archive has an unexpected root layout")
        bundle.extractall(destination, filter="data")
        extracted = destination / next(iter(roots))
        if not extracted.is_dir():
            raise ValueError("source archive did not contain a checkout directory")
        return extracted


def count_tasks(upstream: Path) -> tuple[dict[str, int], int, int]:
    counts: dict[str, int] = {}
    verifier_count = 0
    private_count = 0
    for family in EXPECTED_TASK_COUNTS:
        family_root = upstream / family
        tasks = [path for path in family_root.iterdir() if path.is_dir()] if family_root.is_dir() else []
        counts[family] = sum((task / "task.toml").is_file() and (task / "instruction.md").is_file() for task in tasks)
        for task in tasks:
            verifier_files = list((task / "tests").rglob("test.*")) if (task / "tests").is_dir() else []
            if any(path.name in {"test.sh", "test.bat", "test.ps1", "test.cmd"} for path in verifier_files):
                verifier_count += 1
            if (task / "tests" / "private").is_dir() and any(path.is_file() for path in (task / "tests" / "private").rglob("*")):
                private_count += 1
    if counts != EXPECTED_TASK_COUNTS:
        raise ValueError("checkout task counts do not match the pinned 46 + 31 layout: " + json.dumps(counts))
    if verifier_count != sum(EXPECTED_TASK_COUNTS.values()):
        raise ValueError("at least one pinned task is missing its official Harbor test entrypoint")
    trial = upstream / "harbor" / "src" / "harbor" / "trial" / "trial.py"
    if not trial.is_file() or "continue_until_timeout" not in trial.read_text(encoding="utf-8"):
        raise ValueError("pinned Harbor continue-until-timeout implementation is missing")
    return counts, verifier_count, private_count


def obtain_archive(cache_path: Path, url: str, expected_sha: str, expected_bytes: int) -> tuple[str, int, bool]:
    if cache_path.exists():
        actual_bytes = cache_path.stat().st_size
        actual_sha = sha256_file(cache_path)
        if actual_bytes != expected_bytes or actual_sha != expected_sha:
            raise ValueError("cached LHTB archive fails its pinned size/SHA-256 check; it was left untouched")
        return actual_sha, actual_bytes, True
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    partial = cache_path.with_suffix(cache_path.suffix + ".part")
    if partial.exists():
        raise FileExistsError("an incomplete LHTB archive download exists at " + str(partial) + "; inspect it before retrying")
    request = urllib.request.Request(url, headers={"User-Agent": "Desk-Pet-LHTB-installer"})
    digest = hashlib.sha256()
    total = 0
    try:
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_ARCHIVE_BYTES:
                    raise ValueError("LHTB source archive exceeded the 350 MiB download cap")
                digest.update(chunk)
                output.write(chunk)
        actual_sha = digest.hexdigest()
        if total != expected_bytes or actual_sha != expected_sha:
            raise ValueError("downloaded LHTB archive does not match its pinned byte count and SHA-256")
        os.replace(partial, cache_path)
        return actual_sha, total, False
    except Exception:
        try:
            partial.unlink()
        except FileNotFoundError:
            pass
        raise


def verify_archive(archive: Path) -> None:
    if not archive.is_file() or archive.is_symlink():
        raise ValueError("fixed LHTB source archive is missing or is a symlink")
    if archive.stat().st_size != ARCHIVE_BYTES or sha256_file(archive) != ARCHIVE_SHA256:
        raise ValueError("LHTB archive fails its fixed size/SHA-256 lock; left untouched")


def archive_tree(archive: Path) -> tuple[tuple[str, int, int], dict[str, tuple[str, str]]]:
    """Compute the same tree_digest directly from a verified tar, without extraction/cache writes."""
    digest = hashlib.sha256()
    total = count = 0
    layout: dict[str, tuple[str, str]] = {}
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        roots = {PurePosixPath(member.name).parts[0] for member in members}
        if len(roots) != 1:
            raise ValueError("unexpected source archive layout")
        for member in sorted(members, key=lambda item: item.name):
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("unsafe source archive path")
            relative = PurePosixPath(*path.parts[1:])
            if str(relative) == ".":
                continue
            name = relative.as_posix()
            if is_runtime_artifact(name):
                continue
            if name in layout:
                raise ValueError("duplicate source archive member")
            if member.isdir():
                layout[name] = ("directory", "")
                continue
            if not (member.isfile() or member.issym()):
                raise ValueError("unsupported source archive member")
            if member.issym() and (PurePosixPath(member.linkname).is_absolute() or ".." in PurePosixPath(member.linkname).parts):
                raise ValueError("unsafe source archive link")
            layout[name] = ("symlink", member.linkname) if member.issym() else ("file", "")
            stream = bundle.extractfile(member)
            if stream is None:
                raise ValueError("source archive file is unreadable")
            with stream:
                content = stream.read()
            encoded = name.encode("utf-8")
            digest.update(len(encoded).to_bytes(4, "big"))
            digest.update(encoded)
            digest.update(len(content).to_bytes(8, "big"))
            digest.update(content)
            total += len(content)
            count += 1
    # Some archives omit explicit directory entries; their implied parents are still expected.
    for name in list(layout):
        for parent in PurePosixPath(name).parents:
            if str(parent) != ".":
                layout.setdefault(parent.as_posix(), ("directory", ""))
    return (digest.hexdigest(), count, total), layout


def verify_source(data_root: Path, archive: Path) -> dict[str, Any]:
    verify_archive(archive)
    expected, layout = archive_tree(archive)
    upstream = data_root / "upstream"
    if not upstream.is_dir() or upstream.is_symlink():
        raise ValueError("upstream checkout is missing or is a symlink")
    actual_layout = {}
    for path in upstream.rglob("*"):
        name = path.relative_to(upstream).as_posix()
        if is_runtime_artifact(name):
            continue
        actual_layout[name] = (("symlink", os.readlink(path)) if path.is_symlink() else
                               ("directory", "") if path.is_dir() else ("file", ""))
    if actual_layout != layout:
        raise ValueError("existing upstream checkout differs from fixed archive layout; left untouched")
    actual = tree_digest(upstream)
    if actual != expected:
        raise ValueError("existing upstream checkout differs from fixed archive tree; left untouched")
    counts, verifier_count, private_count = count_tasks(upstream)
    return {
        "sourceTreeSha256": "sha256:" + actual[0], "sourceFileCount": actual[1], "sourceTreeBytes": actual[2],
        "taskCounts": {"1.0": counts["tasks"], "2.0": counts["tasks-2.0"]},
        "verifierTaskCount": verifier_count, "privateVerifierTaskCount": private_count,
        "containerImagesPrePulled": False,
        "containerImageReadiness": "not checked; each official task image is acquired on demand",
    }


def install_source(data_root: Path, archive: Path) -> tuple[Path, dict[str, Any]]:
    upstream = data_root / "upstream"
    if upstream.exists() or upstream.is_symlink():
        # A crash after extraction needs no receipt: trust only a fresh fixed-archive comparison.
        source = verify_source(data_root, archive)
        return upstream, {**source, "sourceReused": True}
    verify_archive(archive)
    with tempfile.TemporaryDirectory(prefix=".extract-lhtb-", dir=data_root) as temporary:
        extracted_root = safe_extract(archive, Path(temporary))
        count_tasks(extracted_root)
        if tree_digest(extracted_root) != archive_tree(archive)[0]:
            raise ValueError("extracted tree differs from fixed archive")
        # Never replace an unknown directory created by a concurrent installer.
        if upstream.exists() or upstream.is_symlink():
            raise FileExistsError("upstream appeared during extraction; left untouched")
        extracted_root.rename(upstream)
    return upstream, {**verify_source(data_root, archive), "sourceReused": False}


def verify_runtime(data_root: Path) -> dict[str, Any]:
    """Inspect imports/entrypoint in the isolated venv; do not run Harbor or any task."""
    python = data_root / "venv/bin/python"
    cli = data_root / "venv/bin/harbor"
    if not python.is_file() or not cli.is_file() or cli.is_symlink():
        raise ValueError("isolated Harbor runner is missing")
    code = """
import importlib.metadata, importlib.util, json, sys
package = importlib.metadata.distribution('harbor')
print(json.dumps({'prefix': sys.prefix, 'version': package.version,
'entrypoint': [e.value for e in package.entry_points if e.group == 'console_scripts' and e.name == 'harbor'],
'cli': importlib.util.find_spec('harbor.cli.main').origin,
'trial': importlib.util.find_spec('harbor.trial.trial').origin}))
"""
    inspected = subprocess.run([str(python), "-I", "-B", "-c", code], cwd=data_root, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                               capture_output=True, text=True, timeout=30, check=False)
    if inspected.returncode != 0:
        raise ValueError("isolated Harbor runner import verification failed")
    info = json.loads(inspected.stdout)
    harbor = data_root / "upstream/harbor/src/harbor"
    if (Path(info["prefix"]).resolve() != (data_root / "venv").resolve()
            or info["entrypoint"] != ["harbor.cli.main:app"] or info["version"] != "0.7.0"
            or Path(info["cli"]).resolve() != (harbor / "cli/main.py").resolve()
            or Path(info["trial"]).resolve() != (harbor / "trial/trial.py").resolve()):
        raise ValueError("Harbor runner does not resolve to the pinned isolated source")
    launcher = cli.read_text(encoding="utf-8")
    if str(python) not in launcher or "from harbor.cli.main import app" not in launcher:
        raise ValueError("Harbor CLI launcher identity mismatch")
    return {"harborVersion": info["version"], "harborContinueUntilTimeout": True, "runtimeVerified": True}


def verify_installation(data_root: Path) -> dict[str, Any]:
    if os.name == "nt":
        raise RuntimeError("LHTB is unsupported on Windows: Unix socket terminal bridge required")
    archive = data_root / "cache" / ("LHTB-" + REVISION + ".tar.gz")
    source = verify_source(data_root, archive)
    manifest = json.loads((data_root / "installation.json").read_text(encoding="utf-8"))
    if (manifest.get("revision") != REVISION or manifest.get("harborRevision") != REVISION
            or manifest.get("archiveSha256") != "sha256:" + ARCHIVE_SHA256 or manifest.get("sourceUrl") != SOURCE_URL):
        raise ValueError("installation receipt does not identify the fixed source pin")
    return {"ready": True, "revision": REVISION, "archiveSha256": "sha256:" + ARCHIVE_SHA256,
            "taskCount": sum(source["taskCounts"].values()), **source, **verify_runtime(data_root)}


def run_harbor_install(data_root: Path, upstream: Path, uv_path: str | None, log_path: Path) -> tuple[str, str, int]:
    uv = uv_path or shutil.which("uv")
    if not uv:
        raise FileNotFoundError("uv is required to install pinned Harbor")
    home = data_root / "home"
    environment = {
        **os.environ,
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "UV_PROJECT_ENVIRONMENT": str(data_root / "venv"),
        "UV_CACHE_DIR": str(data_root / "uv-cache"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as log:
        result = subprocess.run([uv, "sync", "--locked", "--no-dev", "--project", str(upstream / "harbor")], cwd=upstream / "harbor", env=environment, stdout=log, stderr=subprocess.STDOUT, text=True, check=False)
    if result.returncode:
        raise RuntimeError("uv Harbor installation failed; see " + str(log_path))
    harbor = data_root / "venv" / ("Scripts/harbor.exe" if os.name == "nt" else "bin/harbor")
    version = subprocess.run([str(harbor), "--version"], cwd=upstream / "harbor", env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
    if version.returncode:
        raise RuntimeError("installed Harbor CLI did not start; see " + str(log_path))
    uv_version = subprocess.run([uv, "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False).stdout.strip()
    venv_python = data_root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    count_code = "import importlib.metadata; print(len(list(importlib.metadata.distributions())))"
    count = subprocess.run([str(venv_python), "-c", count_code], env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
    if count.returncode:
        raise RuntimeError("could not inspect the isolated Harbor dependency set; see " + str(log_path))
    return version.stdout.strip().splitlines()[-1], uv_version, int(count.stdout.strip())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["install", "verify"], default="install")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--revision", default=REVISION)
    parser.add_argument("--source-url", default=SOURCE_URL)
    parser.add_argument("--archive-sha256", default=ARCHIVE_SHA256)
    parser.add_argument("--archive-bytes", default=ARCHIVE_BYTES, type=int)
    parser.add_argument("--uv-path")
    args = parser.parse_args()
    if os.name == "nt":
        raise RuntimeError("LHTB is unsupported on Windows: Unix socket terminal bridge required")
    if (args.revision, args.source_url, args.archive_sha256, args.archive_bytes) != (REVISION, SOURCE_URL, ARCHIVE_SHA256, ARCHIVE_BYTES):
        raise ValueError("only the fixed LHTB revision and archive lock are supported")
    data_root = Path(args.data_root).resolve()
    if args.action == "verify":
        print(json.dumps(verify_installation(data_root), ensure_ascii=False))
        return 0
    if sys.version_info < (3, 12):
        raise RuntimeError("LHTB installer requires Python 3.12+ (pinned Harbor requirement)")
    data_base = Path(__file__).resolve().parent / ".data"
    try:
        data_root.relative_to(data_base)
    except ValueError as error:
        raise ValueError("installation path must remain inside the external module .data directory") from error
    data_root.mkdir(parents=True, exist_ok=True)
    archive = data_root / "cache" / ("LHTB-" + REVISION + ".tar.gz")
    archive_sha, archive_bytes, archive_reused = obtain_archive(
        archive,
        "https://codeload.github.com/zli12321/LHTB/tar.gz/" + REVISION,
        args.archive_sha256,
        args.archive_bytes,
    )
    upstream, source = install_source(data_root, archive)
    harbor_version, uv_version, package_count = run_harbor_install(data_root, upstream, args.uv_path, data_root / "install.log")
    counts = source["taskCounts"]
    manifest = {
        "schemaVersion": 1,
        "sourceUrl": args.source_url,
        "revision": REVISION,
        "installedAt": datetime.now(timezone.utc).isoformat(),
        "archivePath": str(archive),
        "archiveBytes": archive_bytes,
        "archiveSha256": "sha256:" + archive_sha,
        "sourceTreeSha256": source["sourceTreeSha256"],
        "sourceFileCount": source["sourceFileCount"],
        "sourceTreeBytes": source["sourceTreeBytes"],
        "taskCount": sum(counts.values()),
        "taskCounts": counts,
        "verifierTaskCount": source["verifierTaskCount"],
        "privateVerifierTaskCount": source["privateVerifierTaskCount"],
        "containerImagesPrePulled": False,
        "containerImageReadiness": "not checked; each official task image is acquired on demand",
        "harborRevision": REVISION,
        "harborVersion": harbor_version,
        "uvVersion": uv_version,
        "installedPackageCount": package_count,
        "pythonVersion": sys.version.split()[0],
        "sourceArchiveReused": archive_reused,
        "sourceCheckoutReused": source["sourceReused"],
        "installScope": "test/sim/desk-pet-chat/external/.data/lhtb only",
        "modelCalls": 0,
        "installLog": str(data_root / "install.log"),
    }
    manifest_path = data_root / "installation.json"
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
