"""Pinned MemoryArena travel tools/evaluator bridge.

Only the upstream deterministic environment and scorer are called here. No agent,
model client, credential loader, server, or external API is started.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import re
import sqlite3
import signal
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

from memoryarena_lifecycle import BoundedOutput, cancellation_scope, owned_popen, run_bounded, stop_owned

DATASET_REVISION = "da1a37c8b19280e18627ca01cf368195a5e1d92e"
OFFICIAL_REPO = "ZexueHe/MemoryArena"
HF_DATASET = "ZexueHe/memoryarena"
OFFICIAL_REVISION = "6cd9de14b71915e39ac742a20dc33785e14b6aab"
OFFICIAL_ARCHIVE_SHA256 = "91e32fbc5e6ee2a9b776b45650bfc1378d45b8d1799f44423cf5721550c7584b"
FLIGHT_FILE_ID = "1dNtxHFv7k0PeMHI0smZk8t-dBlWLA0Gz"
FLIGHT_BYTES = 304807007
FLIGHT_SHA256 = "8dafdb0e3f8b79ce599a1e612a772865295bc226b46e5fb278368f7255b11cee"
CODE_SANDBOX_IMAGE = "desk-pet-memoryarena-code:1"
MAX_CODE_BYTES = 32 * 1024
MAX_CODE_SECONDS = 20

DATASETS = {
    "bundled_shopping": ("bundled_shopping/data.jsonl", 1601723, "4411a2da528a33dc6aca519b49cc225895363f18b2d19b191fddb501200134ef", 150, 900),
    "formal_reasoning_math": ("formal_reasoning_math/data.jsonl", 829228, "ff5b0ad575847c7476a02d1e35661592a833bd0cff384cb54bc6f35b46de7803", 40, 354),
    "formal_reasoning_phys": ("formal_reasoning_phys/data.jsonl", 87070, "580862006af2ff2bfc8c5d2d2b9a60bf33a46cbb64f27d60a2bfe039aec61cf6", 20, 86),
    "group_travel_planner": ("group_travel_planner/data.jsonl", 6165901, "2f955d444f6f3ad3c5da2064359ab19f8fc1f90621ff9d00723a450a009c3732", 270, 1869),
    "progressive_search": ("progressive_search/data.jsonl", 3618343, "b445ee36fa3ccb9ad08eae9e7adda86bbc64f14f1e2a0682a8b2085cdb8e4c0e", 221, 1641),
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


ENVIRONMENT_LOCK = Path(__file__).with_name("memoryarena-environment-lock.json")
SEARCH_INDEX_NAME = "progressive-search-fts.sqlite"
SEARCH_RECEIPT_NAME = "progressive-search-index-receipt.json"
SHOPPING_URL_ENV = "DESKPET_MEMORYARENA_SHOPPING_URL"
SHOPPING_OWNER_ENV = "DESKPET_MEMORYARENA_SHOPPING_OWNER"
SHOPPING_RUN_ENV = "DESKPET_MEMORYARENA_SHOPPING_RUN_DIR"
SHOPPING_READY_SECONDS = 600
MAX_ENVIRONMENT_OUTPUT = 32 * 1024 * 1024


def _no_links(path: Path) -> None:
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise RuntimeError(f"Symbolic link/junction is not a pinned cache path: {part}")


def _safe_path(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise RuntimeError("Invalid path in pinned resource lock")
    parts = PurePosixPath(relative)
    if parts.is_absolute() or any(part in {"", ".", ".."} for part in relative.split("/")):
        raise RuntimeError("Unsafe path in pinned resource lock")
    path = root / relative
    _no_links(path)
    return path


def _environment_lock() -> dict[str, Any]:
    # Only the versioned lock is authoritative, never an install receipt or .data manifest.
    _no_links(ENVIRONMENT_LOCK)
    lock = json.loads(ENVIRONMENT_LOCK.read_text(encoding="utf-8"))
    directories = {"shoppingProductDb": "shopping-product-db", "browsecompCorpus": "search-corpus"}
    if lock.get("schemaVersion") != 1 or set(lock.get("sources", {})) != set(directories):
        raise RuntimeError("Invalid versioned MemoryArena environment lock")
    for name, source in lock["sources"].items():
        if source.get("directory") != directories[name] or not re.fullmatch(r"[\w.-]+/[\w.-]+", source.get("repo", "")) or not re.fullmatch(r"[a-f0-9]{40}", source.get("revision", "")):
            raise RuntimeError("Invalid upstream identity in environment lock")
        seen = set()
        for entry in source["files"]:
            relative = entry["path"]
            _safe_path(Path("."), relative)
            if relative in seen or type(entry["bytes"]) is not int or entry["bytes"] < 0 or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]):
                raise RuntimeError("Invalid file identity in environment lock")
            seen.add(relative)
        if not seen:
            raise RuntimeError("Empty pinned resource lock")
    return lock


def _checked_hash(path: Path, hashes: dict | None = None) -> str:
    _no_links(path)
    if not path.is_file():
        raise RuntimeError(f"Missing regular pinned cache file: {path}")
    before = path.stat()
    fingerprint = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
    key = (str(path), fingerprint)
    if hashes is not None and key in hashes:
        return hashes[key]
    digest = _sha256(path)
    after = path.stat()
    if fingerprint != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise RuntimeError(f"Pinned file changed during verification: {path}")
    if hashes is not None:
        hashes[key] = digest
    return digest


def _check_resource(path: Path, entry: dict, hashes: dict | None = None) -> None:
    if not _regular_file(path) or path.stat().st_size != entry["bytes"] or _checked_hash(path, hashes) != entry["sha256"]:
        raise RuntimeError(f"Cached file failed its pinned source lock: {path}")


def _corpus_identity() -> str:
    source = _environment_lock()["sources"]["browsecompCorpus"]
    # Keep the existing index identity format; its ordered hashes now come only
    # from the versioned source lock, never from a local installer declaration.
    return json.dumps({"revision": source["revision"], "files": [{"path": entry["path"], "sha256": entry["sha256"]} for entry in source["files"]]}, sort_keys=True)


def _corpus_files(root: Path, hashes: dict | None = None) -> list[dict[str, Any]]:
    source = _environment_lock()["sources"]["browsecompCorpus"]
    files = []
    for entry in source["files"]:
        path = _safe_path(root / "environments" / source["directory"], entry["path"])
        _check_resource(path, entry, hashes)
        files.append({"path": path, "relative": entry["path"], "sha256": entry["sha256"], "bytes": entry["bytes"]})
    return files


def _check_shopping_directory_entries(root: Path, source: dict) -> None:
    expected = {entry["path"] for entry in source["files"]}
    for folder, pattern in (("product_catalog", "*.json"), ("search_engine/indexes-full", "*")):
        directory = _safe_path(root, folder)
        for path in directory.glob(pattern):
            _no_links(path)
            relative = path.relative_to(root).as_posix()
            if relative.endswith(".part") and relative[:-5] in expected:
                continue  # Retained download partials are not Lucene/catalog inputs.
            if relative not in expected:
                raise RuntimeError(f"Unpinned shopping catalog/index entry: {path}")


def _environment_sources_status(root: Path, hashes: dict | None = None) -> dict[str, Any]:
    output = {}
    for name, source in _environment_lock()["sources"].items():
        blockers = []
        source_root = root / "environments" / source["directory"]
        if name == "shoppingProductDb":
            try:
                _check_shopping_directory_entries(source_root, source)
            except (OSError, RuntimeError) as exc:
                blockers.append(str(exc))
        for entry in source["files"]:
            try:
                _check_resource(_safe_path(source_root, entry["path"]), entry, hashes)
            except (OSError, RuntimeError) as exc:
                blockers.append(str(exc))
        output[name] = {"repository": source["repo"], "revision": source["revision"], "files": len(source["files"]), "bytes": sum(entry["bytes"] for entry in source["files"]), "ready": not blockers, "blockers": blockers}
    output["lockPath"] = str(ENVIRONMENT_LOCK)
    output["lockSha256"] = _sha256(ENVIRONMENT_LOCK)
    return output


def _install_environment_sources(root: Path, hashes: dict | None = None) -> dict[str, Any]:
    hashes = {} if hashes is None else hashes
    for source in _environment_lock()["sources"].values():
        for entry in source["files"]:
            destination = _safe_path(root / "environments" / source["directory"], entry["path"])
            url = f"https://huggingface.co/datasets/{source['repo']}/resolve/{source['revision']}/{entry['path']}"
            _download(url, destination, entry["bytes"], entry["sha256"], hashes)
    return _environment_sources_status(root, hashes)


def build_search_index(root: Path, hashes: dict | None = None) -> dict[str, Any]:
    hashes = {} if hashes is None else hashes
    files = _corpus_files(root, hashes)
    db_path = _safe_path(root / "environments", SEARCH_INDEX_NAME)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path = _safe_path(db_path.parent, SEARCH_RECEIPT_NAME)
    if receipt_path.exists():
        status = _verify_search_index(root, hashes)
        if not status["ready"]:
            raise RuntimeError("Existing search cache rejected; preserved unchanged: " + "; ".join(status["blockers"]))
        return json.loads(receipt_path.read_text(encoding="utf-8")) | {"receiptSha256": _sha256(receipt_path)}
    for suffix in ("-wal", "-shm"):
        _no_links(Path(str(db_path) + suffix))
    try:
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise RuntimeError("The managed MemoryArena runtime requires pyarrow to build the pinned local search index") from exc
    if db_path.exists():
        # Resume only our exact partial index; never erase/relabel an unknown cache.
        with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as prior_connection:
            metadata = dict(prior_connection.execute("SELECT key,value FROM source_meta"))
            shards = list(prior_connection.execute("SELECT path,sha256,rows FROM completed_shards"))
            expected = {entry["relative"]: entry["sha256"] for entry in files}
            if metadata.get("identity") != _corpus_identity() or any(expected.get(path) != sha or rows < 0 for path, sha, rows in shards):
                raise RuntimeError("Existing partial index failed its pinned corpus/shard lock; cache preserved")
            if sum(rows for _, _, rows in shards) != prior_connection.execute("SELECT count(*) FROM docs").fetchone()[0]:
                raise RuntimeError("Existing partial index row counts are inconsistent; cache preserved")
    connection = sqlite3.connect(db_path)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.execute("CREATE TABLE IF NOT EXISTS source_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        prior = dict(connection.execute("SELECT key, value FROM source_meta"))
        identity = _corpus_identity()
        if prior and prior.get("identity") != identity:
            raise RuntimeError("Existing search index has a different pinned corpus identity; cache preserved")
        connection.execute("CREATE TABLE IF NOT EXISTS docs (rowid INTEGER PRIMARY KEY, docid TEXT UNIQUE NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL)")
        connection.execute("CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, text, content='docs', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')")
        connection.execute("CREATE TABLE IF NOT EXISTS completed_shards (path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, rows INTEGER NOT NULL)")
        connection.execute("INSERT OR REPLACE INTO source_meta(key,value) VALUES('identity',?)", (identity,))
        connection.commit()
        indexed = {row[0] for row in connection.execute("SELECT path FROM completed_shards")}
        total_rows = int(connection.execute("SELECT count(*) FROM docs").fetchone()[0])
        for entry in files:
            if entry["relative"] in indexed:
                continue
            parquet_file = parquet.ParquetFile(entry["path"])
            shard_rows = 0
            connection.execute("BEGIN")
            try:
                for batch in parquet_file.iter_batches(batch_size=1024, columns=["docid", "url", "text"]):
                    for row in batch.to_pylist():
                        docid = str(row["docid"])
                        text = str(row["text"] or "")
                        url = str(row["url"] or "")
                        title = next((line.strip(" #\t") for line in text.splitlines() if line.strip(" #\t")), "")[:500]
                        cursor = connection.execute("INSERT INTO docs(docid,url,title,text) VALUES(?,?,?,?)", (docid, url, title, text))
                        connection.execute("INSERT INTO docs_fts(rowid,title,text) VALUES(?,?,?)", (cursor.lastrowid, title, text))
                        shard_rows += 1
                connection.execute("INSERT INTO completed_shards(path,sha256,rows) VALUES(?,?,?)", (entry["relative"], entry["sha256"], shard_rows))
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            total_rows += shard_rows
        connection.execute("INSERT OR REPLACE INTO source_meta(key,value) VALUES('indexKind','sqlite-fts5-bm25-adaptation')")
        connection.execute("INSERT OR REPLACE INTO source_meta(key,value) VALUES('sourceRevision',?)", (_environment_lock()["sources"]["browsecompCorpus"]["revision"],))
        connection.execute("INSERT OR REPLACE INTO source_meta(key,value) VALUES('tokenizer',?)", ("unicode61 remove_diacritics 2",))
        connection.execute("INSERT OR REPLACE INTO source_meta(key,value) VALUES('topK','5')")
        connection.commit()
        connection.execute("INSERT INTO docs_fts(docs_fts,rank) VALUES('integrity-check',1)")
        connection.commit()
        complete = int(connection.execute("SELECT count(*) FROM completed_shards").fetchone()[0])
        if complete != len(files) or total_rows != int(connection.execute("SELECT count(*) FROM docs").fetchone()[0]):
            raise RuntimeError("Local search index did not finish all pinned corpus shards")
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        receipt = {"path": str(db_path), "revision": _environment_lock()["sources"]["browsecompCorpus"]["revision"], "corpusIdentity": identity, "files": len(files), "documents": total_rows, "bytes": db_path.stat().st_size, "sha256": _checked_hash(db_path, hashes), "backend": "SQLite FTS5 BM25 adapted lexical retrieval", "tokenizer": "unicode61 remove_diacritics 2", "topK": 5}
        with receipt_path.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
        return receipt | {"receiptSha256": _sha256(receipt_path)}
    finally:
        connection.close()


def _verify_search_index(root: Path, hashes: dict | None = None) -> dict[str, Any]:
    try:
        path = _safe_path(root / "environments", SEARCH_INDEX_NAME)
        receipt_path = _safe_path(path.parent, SEARCH_RECEIPT_NAME)
        if not _regular_file(receipt_path):
            raise RuntimeError("Search index receipt missing; build/resume the pinned BM25 index")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        identity = _corpus_identity()
        if receipt.get("corpusIdentity") != identity or receipt.get("revision") != _environment_lock()["sources"]["browsecompCorpus"]["revision"]:
            raise RuntimeError("Search receipt is not bound to the pinned corpus identity")
        if receipt.get("path") != str(path) or receipt.get("bytes") != path.stat().st_size or receipt.get("sha256") != _checked_hash(path, hashes):
            raise RuntimeError("Search index failed receipt path/size/SHA-256 verification")
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(path) + suffix)
            _no_links(sidecar)
            if sidecar.exists() and sidecar.stat().st_size:
                raise RuntimeError("Search index has an unsealed SQLite sidecar")
        with sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True) as connection:
            metadata = dict(connection.execute("SELECT key,value FROM source_meta"))
            shards = {row[0]: (row[1], row[2]) for row in connection.execute("SELECT path,sha256,rows FROM completed_shards")}
            expected = _environment_lock()["sources"]["browsecompCorpus"]["files"]
            if metadata.get("identity") != identity or metadata.get("indexKind") != "sqlite-fts5-bm25-adaptation" or metadata.get("tokenizer") != "unicode61 remove_diacritics 2" or metadata.get("topK") != "5":
                raise RuntimeError("Search index metadata does not match the pinned BM25 adapter")
            if set(shards) != {entry["path"] for entry in expected} or any(shards[entry["path"]][0] != entry["sha256"] for entry in expected):
                raise RuntimeError("Search index shard receipts do not match the pinned corpus")
            documents = connection.execute("SELECT count(*) FROM docs").fetchone()[0]
            if not documents or documents != sum(row[1] for row in shards.values()) or documents != receipt.get("documents"):
                raise RuntimeError("Search index document count does not match its shard receipts")
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise RuntimeError("Search SQLite integrity check failed")
            connection.execute("SELECT rowid FROM docs_fts WHERE docs_fts MATCH 'test' LIMIT 1").fetchall()
        return {"ready": True, "blockers": [], "documents": documents, "receiptSha256": _sha256(receipt_path)}
    except (OSError, RuntimeError, ValueError, KeyError, sqlite3.Error) as exc:
        return {"ready": False, "blockers": [str(exc)], "documents": 0}


def _search_local(root: Path, query: str, top_k: int = 5) -> list[dict[str, Any]]:
    if not isinstance(query, str) or not query.strip() or len(query) > 4096:
        raise ValueError("query must be a non-empty string up to 4096 characters")
    if not 1 <= top_k <= 10:
        raise ValueError("top_k must be between 1 and 10")
    tokens = re.findall(r"[\w]+", query, flags=re.UNICODE)[:64]
    if not tokens:
        return []
    db_path = root / "environments" / "progressive-search-fts.sqlite"
    if not db_path.is_file():
        raise RuntimeError("Adapted local search index is not installed; run installMemoryArena")
    expression = " AND ".join('"' + token.replace('"', '""') + '"' for token in tokens)
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
        rows = connection.execute("SELECT docs.docid, docs.url, docs.title, substr(docs.text,1,2400), bm25(docs_fts) FROM docs_fts JOIN docs ON docs.rowid=docs_fts.rowid WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?", (expression, top_k)).fetchall()
        if not rows and len(tokens) > 1:
            expression = " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)
            rows = connection.execute("SELECT docs.docid, docs.url, docs.title, substr(docs.text,1,2400), bm25(docs_fts) FROM docs_fts JOIN docs ON docs.rowid=docs_fts.rowid WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?", (expression, top_k)).fetchall()
    return [{"docid": row[0], "url": row[1], "title": row[2], "snippet": row[3], "score": row[4]} for row in rows]


def _get_local_document(root: Path, docid: str) -> dict[str, Any] | None:
    if not isinstance(docid, str) or len(docid) > 256:
        raise ValueError("docid must be a string up to 256 characters")
    db_path = root / "environments" / "progressive-search-fts.sqlite"
    if not db_path.is_file():
        raise RuntimeError("Adapted local search index is not installed; run installMemoryArena")
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT docid,url,title,text FROM docs WHERE docid=?", (docid,)).fetchone()
    return {"docid": row[0], "url": row[1], "title": row[2], "text": row[3]} if row else None


def _regular_file(path: Path) -> bool:
    try:
        _no_links(path)
        return path.is_file()
    except RuntimeError:
        return False


def _ensure_code_sandbox(repo_root: Path) -> dict[str, Any]:
    dockerfile = repo_root / "test/sim/desk-pet-chat/external/memoryarena-code-sandbox.Dockerfile"
    inspect = _sandbox_readiness()
    if not inspect["ready"]:
        result = run_bounded(["docker", "build", "--file", str(dockerfile), "--tag", CODE_SANDBOX_IMAGE, str(repo_root)], cwd=repo_root, timeout=600, max_output=1024 * 1024)
        if result["exitCode"] != 0 or result["timedOut"] or result["outputLimited"]:
            raise RuntimeError("Cannot build the isolated coding sandbox image: " + result["stderr"][-4000:])
        inspect = _sandbox_readiness()
        if not inspect["ready"]:
            raise RuntimeError("Built sandbox image failed local readiness inspection")
    return {"image": CODE_SANDBOX_IMAGE, "imageId": inspect["imageId"], "dockerfile": str(dockerfile), "network": "none", "rootFilesystem": "read-only", "nonRootUid": 10001}


def _installed_jdk_homes() -> list[Path]:
    homes = []
    if sys.platform == "darwin":
        try:
            result = run_bounded(["/usr/libexec/java_home"], timeout=5, max_output=4096)
            if result["exitCode"] == 0 and not result["timedOut"] and not result["outputLimited"]:
                homes.append(Path(result["stdout"].strip()))
        except OSError:
            pass  # Optional system locator is absent; validated installed JDK paths below decide readiness.
        patterns = [(Path("/Library/Java/JavaVirtualMachines"), "*/Contents/Home"), (Path.home() / "Library/Java/JavaVirtualMachines", "*/Contents/Home"), (Path("/opt/homebrew/opt"), "openjdk*/libexec/openjdk.jdk/Contents/Home"), (Path("/usr/local/opt"), "openjdk*/libexec/openjdk.jdk/Contents/Home")]
    elif os.name == "nt":
        patterns = [(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / vendor, "*") for vendor in ("Java", "Eclipse Adoptium", "Microsoft")]
    else:
        patterns = [(Path("/usr/lib/jvm"), "*")]
    for directory, pattern in patterns:
        homes.extend(sorted(directory.glob(pattern)))
    return homes


def _resolve_java() -> dict[str, str] | None:
    candidates = []
    configured = os.environ.get("JAVA_HOME")
    if configured:
        candidates.append(Path(configured))
    binary = shutil.which("java")
    # /usr/bin/java on macOS is a launcher stub, not evidence of a JDK.
    if binary and not (sys.platform == "darwin" and Path(binary) == Path("/usr/bin/java")):
        candidates.append(Path(binary).resolve().parent.parent)
    candidates.extend(_installed_jdk_homes())
    for candidate in candidates:
        if not candidate.is_absolute():
            continue
        home = candidate.resolve()
        executable = home / "bin" / ("java.exe" if os.name == "nt" else "java")
        if not executable.is_file() or not os.access(executable, os.X_OK):
            continue
        libraries = ("bin/server/jvm.dll",) if os.name == "nt" else (("lib/server/libjvm.dylib", "jre/lib/server/libjvm.dylib") if sys.platform == "darwin" else ("lib/server/libjvm.so", "jre/lib/amd64/server/libjvm.so"))
        for relative in libraries:
            library = home / relative
            if library.is_file() and home in library.resolve().parents:
                return {"JAVA_HOME": str(home), "JVM_PATH": str(library.resolve())}
    return None


def _runtime_readiness(java: dict[str, str] | None) -> dict[str, Any]:
    # Isolated import probes: no bytecode writes, local spaCy model only, denied network.
    env = os.environ.copy()
    env.update(java or {})
    env.update({"PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    modules = {
        "travel": "import pandas, numpy, requests",
        "shopping": "import requests, spacy, torch, fastapi, uvicorn; import en_core_web_lg; from pyserini.search.lucene import LuceneSearcher",
        "search": "import sqlite3; c=sqlite3.connect(':memory:'); c.execute('CREATE VIRTUAL TABLE f USING fts5(text)')",
    }
    output = {}
    guard = """import socket, sys, os, tempfile
def no_network(*args, **kwargs):
 raise RuntimeError('Network prohibited during readiness probe')
socket.socket.connect=no_network
socket.socket.connect_ex=no_network
socket.create_connection=no_network
_temp = os.path.realpath(tempfile.gettempdir())
_fd_positions = {'os.remove': (1,), 'os.rename': (2, 3), 'os.rmdir': (1,), 'os.symlink': (2,), 'os.link': (3, 4), 'os.chmod': (2,), 'os.utime': (3,)}
def _in_temp(path):
 try:
  resolved = os.path.realpath(os.fspath(path))
 except (TypeError, ValueError):
  return False
 return resolved == _temp or resolved.startswith(_temp + os.sep)
def readonly(event, args):
 if event in _fd_positions and any(len(args) > index and isinstance(args[index], int) and args[index] >= 0 for index in _fd_positions[event]):
  return
 if event in {'os.mkdir', 'os.remove', 'os.rename', 'os.rmdir', 'os.symlink', 'os.link', 'os.truncate', 'os.chmod', 'os.utime'}:
  paths = [value for value in args[:2] if isinstance(value, (str, bytes, os.PathLike))]
  if not paths or not all(_in_temp(value) for value in paths):
   raise RuntimeError('Filesystem mutation prohibited during readiness probe')
 if event == 'open':
  mode, flags = args[1], args[2]
  writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
  if writing and not _in_temp(args[0]):
   raise RuntimeError('File write prohibited during readiness probe')
sys.addaudithook(readonly)
"""
    for name, imports in modules.items():
        if name == "shopping" and java is None:
            output[name] = {"ready": False, "blockers": ["No valid installed JDK/libjvm (java launcher stubs do not qualify)"]}
            continue
        try:
            result = run_bounded([sys.executable, "-B", "-c", guard + imports + "; print('runtime-ready')"], env=env, timeout=45, max_output=16384)
            ready = result["exitCode"] == 0 and not result["timedOut"] and not result["outputLimited"] and result["stdout"].strip() == "runtime-ready"
            output[name] = {"ready": ready, "blockers": [] if ready else [f"{name} runtime import probe failed or exceeded its bound"]}
        except OSError as exc:
            output[name] = {"ready": False, "blockers": [f"{name} runtime probe unavailable: {exc}"]}
    return output


def _sandbox_readiness() -> dict[str, Any]:
    try:
        result = run_bounded(["docker", "image", "inspect", CODE_SANDBOX_IMAGE, "--format", "{{.Id}}"], timeout=10, max_output=4096)
        ready = result["exitCode"] == 0 and not result["timedOut"] and not result["outputLimited"] and bool(re.fullmatch(r"sha256:[a-f0-9]{64}", result["stdout"].strip()))
        return {"ready": ready, "blockers": [] if ready else ["Docker daemon or local coding sandbox image unavailable"], "image": CODE_SANDBOX_IMAGE, "imageId": result["stdout"].strip() if ready else None}
    except OSError:
        return {"ready": False, "blockers": ["Docker CLI unavailable; host execution fallback prohibited"], "image": CODE_SANDBOX_IMAGE}


def ensure_runtime(repo_root: Path) -> dict[str, Any]:
    root = repo_root / "test/sim/desk-pet-chat/external/.data/memoryarena"
    runtime = root / "runtime"
    python_install = runtime / "python"
    venv = runtime / "venv"
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError("uv is required to create the isolated MemoryArena Python runtime")
    env = os.environ.copy()
    env["UV_CACHE_DIR"] = str(runtime / "uv-cache")
    env["UV_PYTHON_INSTALL_DIR"] = str(python_install)
    env["PYTHONPYCACHEPREFIX"] = str(root / "pycache")
    env["UV_NO_PROGRESS"] = "1"
    runtime.mkdir(parents=True, exist_ok=True)
    base_python = next((path for path in python_install.rglob("python.exe" if os.name == "nt" else "python3.10") if path.is_file() and os.access(path, os.X_OK)), None)
    if base_python is None:
        result = subprocess.run([uv, "python", "install", "3.10.20", "--install-dir", str(python_install)], cwd=repo_root, env=env, text=True, capture_output=True, check=False)
        if result.returncode != 0:
            raise RuntimeError("Unable to install the pinned Python 3.10.20 runtime under MemoryArena .data")
        base_python = next((path for path in python_install.rglob("python.exe" if os.name == "nt" else "python3.10") if path.is_file() and os.access(path, os.X_OK)), None)
    if base_python is None:
        raise RuntimeError("uv completed without producing the expected managed Python 3.10.20 executable")
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        result = subprocess.run([uv, "venv", "--python", str(base_python), str(venv)], cwd=repo_root, env=env, text=True, capture_output=True, check=False)
        if result.returncode != 0:
            raise RuntimeError("Unable to create the isolated MemoryArena Python virtual environment")
    requirements = repo_root / "test/sim/desk-pet-chat/external/memoryarena-runtime-requirements.txt"
    result = subprocess.run([uv, "pip", "install", "--python", str(python), "--requirement", str(requirements)], cwd=repo_root, env=env, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError("Unable to install the pinned MemoryArena runtime dependency set")
    wheel = runtime / "en_core_web_lg-3.3.0-py3-none-any.whl"
    wheel_receipt = _download(
        "https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.3.0/en_core_web_lg-3.3.0-py3-none-any.whl",
        wheel, 400651786, "6ce19d37dfe5280400f80a5954d41afca10cbc742b97bfcf4b0e452b6eb24273",
    )
    result = subprocess.run([uv, "pip", "install", "--python", str(python), str(wheel)], cwd=repo_root, env=env, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError("Unable to install the pinned spaCy en_core_web_lg model")
    java = _resolve_java()
    check_env = env | (java or {}) | {"PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    check = run_bounded([str(python), "-B", str(Path(__file__)), "--action", "runtime-readiness", "--repo-root", str(repo_root)], input_data="{}", cwd=repo_root, env=check_env, timeout=150, max_output=16384)
    if check["exitCode"] != 0 or check["timedOut"] or check["outputLimited"]:
        raise RuntimeError("Managed MemoryArena runtime failed its bounded import readiness check")
    readiness = json.loads(check["stdout"])
    return {"pythonExecutable": str(python), "pythonVersion": "3.10.20", "venvPath": str(venv), "requirements": str(requirements), "spaCyModel": wheel_receipt, "cachePath": str(runtime / "uv-cache"), "javaAvailable": java is not None, "readiness": readiness, "verified": all(item["ready"] for item in readiness.values())}


def _download(url: str, destination: Path, expected_size: int | None, expected_sha: str, hashes: dict | None = None) -> dict[str, Any]:
    _no_links(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    _no_links(partial)
    if partial.exists() and not _regular_file(partial):
        raise RuntimeError(f"Refusing non-regular partial cache path: {partial}")
    if destination.exists():
        if not _regular_file(destination):
            raise RuntimeError(f"Refusing non-regular cache path: {destination}")
        actual_sha = _checked_hash(destination, hashes)
        if actual_sha != expected_sha or (expected_size is not None and destination.stat().st_size != expected_size):
            raise RuntimeError(f"Cached file failed its lock: {destination}")
        return {"url": url, "path": str(destination), "bytes": destination.stat().st_size, "sha256": actual_sha, "cached": True}

    offset = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": "Desk-Pet-MemoryArena-installer/1.0"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=180) as response:
        content_type = (response.headers.get("Content-Type") or "").lower()
        if "text/html" in content_type:
            raise RuntimeError(f"Upstream returned HTML instead of a data file: {url}")
        append = offset > 0 and response.status == 206
        if not append:
            offset = 0
        with partial.open("ab" if append else "wb") as output:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                output.write(block)
    actual_size = partial.stat().st_size
    if expected_size is not None and actual_size != expected_size:
        raise RuntimeError(f"Downloaded size mismatch for {destination}: {actual_size} != {expected_size}; partial retained for resume")
    actual_sha = _sha256(partial)
    if actual_sha != expected_sha:
        raise RuntimeError(f"Downloaded SHA-256 mismatch for {destination}; partial retained")
    _no_links(destination)
    if destination.exists():
        raise RuntimeError(f"Cache destination appeared during download; neither file was replaced: {destination}")
    partial.replace(destination)
    if hashes is not None:
        stat = destination.stat()
        hashes[(str(destination), (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))] = actual_sha
    return {"url": url, "path": str(destination), "bytes": actual_size, "sha256": actual_sha, "cached": False}


def _safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        prefix = f"ZexueHe-MemoryArena-{OFFICIAL_REVISION[:7]}/"
        payload = []
        for member in members:
            if member.name.rstrip("/") == prefix.rstrip("/"):
                continue
            if not member.name.startswith(prefix):
                raise RuntimeError("Pinned MemoryArena source archive has an unexpected top-level path")
            relative = member.name[len(prefix):]
            if not relative:
                continue
            target = (destination / relative).resolve()
            if destination.resolve() not in target.parents:
                raise RuntimeError("Unsafe path in official source archive")
            if member.issym() or member.islnk() or member.isdev():
                raise RuntimeError("Unexpected link/device in official source archive")
            payload.append((member, relative))
        for member, relative in payload:
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:
                raise RuntimeError(f"Cannot extract pinned source file: {relative}")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output)


def install(repo_root: Path) -> dict[str, Any]:
    root = repo_root / "test/sim/desk-pet-chat/external/.data/memoryarena"
    _no_links(root)
    root.mkdir(parents=True, exist_ok=True)
    hashes: dict = {}
    data_root = root / "raw" / DATASET_REVISION
    files = []
    for config, (relative, size, sha, groups, subtasks) in DATASETS.items():
        url = f"https://huggingface.co/datasets/{HF_DATASET}/resolve/{DATASET_REVISION}/{relative}"
        output = data_root / relative
        receipt = _download(url, output, size, sha)
        receipt.update({"config": config, "groups": groups, "subtasks": subtasks})
        files.append(receipt)

    archive_url = f"https://api.github.com/repos/{OFFICIAL_REPO}/tarball/{OFFICIAL_REVISION}"
    archive = root / "source" / f"memoryarena-{OFFICIAL_REVISION}.tar.gz"
    source_receipt = _download(archive_url, archive, 1036643, OFFICIAL_ARCHIVE_SHA256)
    official_root = root / "source" / f"MemoryArena-{OFFICIAL_REVISION}"
    _no_links(official_root)
    if not official_root.exists():
        # Do not delete a cache/staging directory left by another interrupted run.
        staging = Path(tempfile.mkdtemp(prefix=official_root.name + ".staging-", dir=official_root.parent))
        _safe_extract(archive, staging)
        if official_root.exists():
            raise RuntimeError("Official source destination appeared during extraction; caches preserved")
        staging.replace(official_root)

    flight_url = f"https://drive.usercontent.google.com/download?id={FLIGHT_FILE_ID}&export=download&confirm=t"
    flight_path = official_root / "env/env_systems/travel_planner_env/database/flights/clean_Flights_2022.csv"
    flight_receipt = _download(flight_url, flight_path, FLIGHT_BYTES, FLIGHT_SHA256, hashes)
    _verify_official_source(root, hashes)
    environment_sources = _install_environment_sources(root, hashes)
    search_index_receipt = build_search_index(root, hashes)
    sandbox_receipt = _ensure_code_sandbox(repo_root)

    manifest = {
        "schemaVersion": 1,
        "dataset": HF_DATASET,
        "datasetRevision": DATASET_REVISION,
        "officialRepository": OFFICIAL_REPO,
        "officialRevision": OFFICIAL_REVISION,
        "totals": {"groups": sum(x[3] for x in DATASETS.values()), "subtasks": sum(x[4] for x in DATASETS.values())},
        "files": files,
        "officialSource": source_receipt,
        "travelFlightDatabase": flight_receipt,
        "progressiveSearchIndex": search_index_receipt,
        "codingSandbox": sandbox_receipt,
        "environmentSources": environment_sources,
        "limitations": [
            "group_travel_planner uses the pinned official deterministic tool environment and evaluator.",
            "progressive_search uses an explicitly adapted SQLite FTS5 BM25 index over the complete pinned BrowseComp-Plus corpus; its upstream FAISS encoder identity could not be verified and the downloaded index is not used.",
            "formal reasoning answers are judged by the independent coding-agent judge; the upstream evaluator requires model calls.",
            "No MemoryArena agent/model API or private credential is used.",
        ],
    }
    manifest_path = _safe_path(root, "install-manifest.json")
    temp = manifest_path.with_suffix(".json.tmp")
    _no_links(temp)
    temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(manifest_path)
    return manifest


def _verify_official_source(root: Path, hashes: dict | None = None) -> Path:
    source = _installed_source(root)
    archive = _safe_path(root / "source", f"memoryarena-{OFFICIAL_REVISION}.tar.gz")
    if _checked_hash(archive, hashes) != OFFICIAL_ARCHIVE_SHA256:
        raise RuntimeError("Official source archive failed its fixed SHA-256 lock")
    prefix = f"ZexueHe-MemoryArena-{OFFICIAL_REVISION[:7]}/"
    expected_code = set()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            if member.isdir():
                continue
            if not member.isfile() or not member.name.startswith(prefix):
                raise RuntimeError("Non-regular or unexpected official source archive member")
            relative = member.name[len(prefix):]
            target = _safe_path(source, relative)
            stream = tar.extractfile(member)
            if stream is None:
                raise RuntimeError("Official archive member cannot be read")
            with stream:
                expected = hashlib.sha256(stream.read()).hexdigest()
            if not _regular_file(target) or target.stat().st_size != member.size or _checked_hash(target, hashes) != expected:
                raise RuntimeError(f"Installed official source differs from fixed archive: {relative}")
            if target.suffix in {".py", ".pyc", ".pyd", ".so"}:
                expected_code.add(relative)
    for target in source.rglob("*"):
        _no_links(target)
        if target.is_file() and target.suffix in {".py", ".pyd", ".so"} and target.relative_to(source).as_posix() not in expected_code:
            raise RuntimeError(f"Unexpected executable file in official source: {target}")
    return source


def verify(cache_root: Path) -> dict[str, Any]:
    hashes: dict = {}
    counts = []
    for config, (_, _, expected_sha, groups, subtasks) in DATASETS.items():
        path = _dataset_path(cache_root, config)
        actual_groups = 0
        actual_subtasks = 0
        with path.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"Invalid JSONL at {path}:{line_number}: {exc}") from exc
                if not isinstance(row.get("questions"), list):
                    raise RuntimeError(f"{config} row has no questions array")
                actual_groups += 1
                actual_subtasks += len(row["questions"])
        if actual_groups != groups or actual_subtasks != subtasks:
            raise RuntimeError(f"{config} count mismatch")
        counts.append({"config": config, "groups": actual_groups, "subtasks": actual_subtasks, "sha256": expected_sha})

    source_blockers = []
    try:
        source = _verify_official_source(cache_root, hashes)
    except (OSError, RuntimeError, tarfile.TarError) as exc:
        source_blockers.append(str(exc))
        source = cache_root / "source" / f"MemoryArena-{OFFICIAL_REVISION}"
    flight_blockers = []
    try:
        _check_resource(source / "env/env_systems/travel_planner_env/database/flights/clean_Flights_2022.csv", {"bytes": FLIGHT_BYTES, "sha256": FLIGHT_SHA256}, hashes)
    except (OSError, RuntimeError) as exc:
        flight_blockers.append(str(exc))
    environment_sources = _environment_sources_status(cache_root, hashes)
    search = _verify_search_index(cache_root, hashes)
    # Receipt hashes are evidence of the derived index, not authority for corpus origin.
    manifest_path = cache_root / "install-manifest.json"
    manifest: dict = {}
    try:
        _no_links(manifest_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if search["ready"] and manifest.get("progressiveSearchIndex", {}).get("receiptSha256") != search["receiptSha256"]:
            search = {"ready": False, "documents": 0, "blockers": ["Install receipt does not bind the current search index receipt hash"]}
    except (OSError, RuntimeError, ValueError):
        search = {"ready": False, "documents": 0, "blockers": ["Install receipt unavailable or unsafe"]}
    java = _resolve_java()
    runtime = _runtime_readiness(java)
    sandbox = _sandbox_readiness()
    if sandbox["ready"] and manifest.get("codingSandbox", {}).get("imageId") != sandbox["imageId"]:
        sandbox = sandbox | {"ready": False, "blockers": ["Local sandbox image differs from its installation receipt"]}
    config_blockers = {
        "group_travel_planner": source_blockers + flight_blockers + runtime["travel"]["blockers"],
        "bundled_shopping": source_blockers + environment_sources["shoppingProductDb"]["blockers"] + runtime["shopping"]["blockers"],
        "progressive_search": source_blockers + environment_sources["browsecompCorpus"]["blockers"] + search["blockers"] + runtime["search"]["blockers"],
        "formal_reasoning_math": source_blockers + sandbox["blockers"],
        "formal_reasoning_phys": source_blockers + sandbox["blockers"],
    }
    configs = {config: {"ready": not blockers, "blockers": blockers} for config, blockers in config_blockers.items()}
    configs["bundled_shopping"]["prewarmRequired"] = True
    source_verified = not source_blockers and not flight_blockers and all(environment_sources[name]["ready"] for name in _environment_lock()["sources"])
    return {
        "verified": source_verified,
        "sourceVerified": source_verified,
        "datasetRevision": DATASET_REVISION,
        "officialRevision": OFFICIAL_REVISION,
        "totals": {"groups": sum(item["groups"] for item in counts), "subtasks": sum(item["subtasks"] for item in counts)},
        "configs": counts,
        "environment": {"ready": all(item["ready"] for item in configs.values()), "blockers": list(dict.fromkeys(reason for reasons in config_blockers.values() for reason in reasons)), "configs": configs, "python": sys.version.split()[0], "runtime": runtime, "java": java, "codingSandbox": sandbox, "travelToolsReady": configs["group_travel_planner"]["ready"], "progressiveSearchReady": configs["progressive_search"]["ready"], "progressiveSearchDocuments": search["documents"], "shoppingAssetsReady": environment_sources["shoppingProductDb"]["ready"], "browsecompCorpusReady": environment_sources["browsecompCorpus"]["ready"], "environmentSources": environment_sources},
    }


def _dataset_path(root: Path, config: str) -> Path:
    if config not in DATASETS:
        raise ValueError(f"Unknown MemoryArena config: {config}")
    relative = DATASETS[config][0]
    path = root / "raw" / DATASET_REVISION / relative
    if not _regular_file(path) or _sha256(path) != DATASETS[config][2]:
        raise RuntimeError(f"MemoryArena input is missing or fails SHA-256 lock: {path}")
    return path


def load_group(root: Path, config: str, group_id: int) -> dict[str, Any]:
    path = _dataset_path(root, config)
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("id") == group_id:
                return row
    raise KeyError(f"No group id {group_id} in {config}")


def _installed_source(root: Path) -> Path:
    source = root / "source" / f"MemoryArena-{OFFICIAL_REVISION}"
    _no_links(source)
    if not source.is_dir():
        raise RuntimeError("Official MemoryArena source is not installed; run installMemoryArena first")
    return source


def _travel_tool(root: Path, name: str, arguments: dict[str, Any]) -> str:
    source = _installed_source(root)
    sys.path.insert(0, str(source))
    from env.env_systems.travel_planner_env.tool_executor import ToolExecutor
    with contextlib.redirect_stdout(io.StringIO()):
        executor = ToolExecutor(db_path=str(source / "env/env_systems/travel_planner_env/database"))
        return executor.execute(name, arguments)


def _official_evaluate(root: Path, submission: list[dict[str, Any]]) -> dict[str, Any]:
    source = _installed_source(root)
    # The upstream evaluator imports datasets only to fetch its reference rows. Supply
    # the exact, SHA-locked local snapshot instead; no network dataset resolution occurs.
    path = _dataset_path(root, "group_travel_planner")
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    import types
    datasets_module = types.ModuleType("datasets")
    def load_dataset(name: str, config: str, split: str) -> list[dict[str, Any]]:
        if name != HF_DATASET or config != "group_travel_planner" or split != "test":
            raise RuntimeError("Official evaluator requested an unexpected dataset identity")
        return rows
    datasets_module.load_dataset = load_dataset  # type: ignore[attr-defined]
    sys.modules["datasets"] = datasets_module
    sys.path.insert(0, str(source))
    from env.env_systems.travel_planner_env.eval import evaluate
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".jsonl", dir=root, delete=False) as handle:
            temp_path = Path(handle.name)
            for item in submission:
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = evaluate(str(temp_path), model_name="desk-pet", memory_system="product-memory")
        result["upstream"] = {"repository": OFFICIAL_REPO, "revision": OFFICIAL_REVISION, "evaluator": "env/env_systems/travel_planner_env/eval.py", "datasetRevision": DATASET_REVISION, "datasetSha256": DATASETS["group_travel_planner"][2]}
        result["console"] = output.getvalue()
        return result
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def _evaluate_shopping_diagnostic(root: Path, request: dict[str, Any]) -> dict[str, Any]:
    group_id, subtask_index = request.get("groupId"), request.get("subtaskIndex")
    if not isinstance(group_id, int) or not isinstance(subtask_index, int) or subtask_index < 0:
        raise ValueError("shopping diagnostic requires integer groupId and non-negative subtaskIndex")
    purchased_asin = request.get("purchasedAsin")
    purchased_price = request.get("purchasedPrice")
    if purchased_asin is not None and not isinstance(purchased_asin, str):
        raise ValueError("purchasedAsin must be a string or null")
    if purchased_price is not None and not isinstance(purchased_price, (int, float)):
        raise ValueError("purchasedPrice must be numeric or null")
    source = _installed_source(root)
    data_root = root / "environments" / "shopping-product-db"
    os.environ.update(_shopping_variables(root))
    sys.path.insert(0, str(source))
    from env.env_systems.web_shopping_env.runtime.reward_helpers import load_catalog
    from env.env_systems.web_shopping_env.compute_reward import compute_reward_for_step
    from env.env_systems.web_shopping_env.runtime.runner.task_files import _reconstruct_task_def_from_hf_row
    row = load_group(root, "bundled_shopping", group_id)
    task = _reconstruct_task_def_from_hf_row(row)
    if subtask_index >= len(task["steps"]):
        raise IndexError("Shopping diagnostic subtaskIndex is outside the pinned source group")
    target_step = task["steps"][subtask_index]
    catalog = load_catalog(data_root / "product_catalog")
    result = compute_reward_for_step(
        {"step": subtask_index + 1, "target_asin": target_step["target_asin"], "purchased_asin": purchased_asin, "purchased_price": purchased_price},
        target_step,
        catalog,
        attribute_judge=None,
    )
    return {"diagnostic": "official-memoryarena-shopping-no-llm-string-match", "primaryJudge": "independent-coding-agent", "modelApiCalled": False, "upstream": {"repository": OFFICIAL_REPO, "revision": OFFICIAL_REVISION, "evaluator": "env/env_systems/web_shopping_env/compute_reward.py::compute_reward_for_step"}, "result": result}


def _dispatch(root: Path, request: dict[str, Any]) -> Any:
    action = request.get("action")
    if action == "load-group":
        return load_group(root, str(request.get("config")), int(request.get("groupId")))
    if action == "verify":
        return verify(root)
    if action == "runtime-readiness":
        return _runtime_readiness(_resolve_java())
    if action == "build-search-index":
        return build_search_index(root)
    if action == "install-runtime":
        repo_root = root.parents[5]
        return ensure_runtime(repo_root)
    if action == "tool":
        name = request.get("name")
        arguments = request.get("arguments", {})
        if not isinstance(name, str) or not isinstance(arguments, dict):
            raise ValueError("tool requires name and object arguments")
        return {"content": _travel_tool(root, name, arguments)}
    if action == "evaluate-travel":
        submission = request.get("submission")
        if not isinstance(submission, list):
            raise ValueError("submission must be an array of official-format group results")
        return _official_evaluate(root, submission)
    if action == "evaluate-shopping-diagnostic":
        return _evaluate_shopping_diagnostic(root, request)
    if action == "mcp-server":
        _serve_mcp(root)
        return None
    raise ValueError(f"Unknown MemoryArena bridge action: {action}")


def _mcp_response(request_id: Any, result: Any = None, error: dict[str, Any] | None = None) -> dict[str, Any]:
    response: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        response["error"] = error
    else:
        response["result"] = result
    return response


def _run_sandboxed_code(code: str) -> dict[str, Any]:
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code must be a non-empty Python program")
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise ValueError(f"code exceeds the {MAX_CODE_BYTES}-byte limit")
    name = "desk-pet-memoryarena-" + uuid.uuid4().hex
    command = [
        "docker", "run", "--name", name, "--rm", "-i", "--pull=never", "--network=none", "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--memory=512m", "--memory-swap=512m",
        "--cpus=1", "--pids-limit=64", "--user", "10001:10001",
        "--workdir", "/tmp", "--entrypoint", "python", CODE_SANDBOX_IMAGE, "-I", "-",
    ]
    with cancellation_scope():
        try:
            return run_bounded(command, input_data=code, timeout=MAX_CODE_SECONDS, max_output=65536)
        except FileNotFoundError as exc:
            raise RuntimeError("Docker CLI is required; host execution fallback is prohibited") from exc
        finally:
            # Killing docker's client is not sufficient: remove ONLY this randomly named container.
            try:
                cleanup = run_bounded(["docker", "rm", "-f", name], timeout=10, max_output=4096)
                if cleanup["exitCode"] != 0 and "No such container" not in cleanup["stderr"]:
                    sys.stderr.write(f"MemoryArena owned container cleanup failed: {name}\n")
            except OSError as exc:
                sys.stderr.write(f"MemoryArena owned container cleanup unavailable: {type(exc).__name__}\n")


def _shopping_variables(root: Path) -> dict[str, str]:
    data_root = root / "environments" / "shopping-product-db"
    # Upstream has no cache-disable flag. Its documented mkdir-failure branch reads
    # JSON directly; an existing regular resource file can never be a pickle cache dir.
    no_pickle_cache = data_root / "domain_data.json"
    if not _regular_file(no_pickle_cache):
        raise RuntimeError("Shopping domain resource missing or unsafe")
    return {
        "MEMORYARENA_WEBSHOP_DATA_ROOT": str(data_root),
        "MEMORYARENA_WEBSHOP_ITEMS_FILE": str(data_root / "items_shuffle.json"),
        "MEMORYARENA_WEBSHOP_ATTR_FILE": str(data_root / "items_ins_v2.json"),
        "MEMORYARENA_WEBSHOP_SEARCH_ROOT": str(data_root / "search_engine"),
        "MEMORYARENA_WEBSHOP_PRODUCT_CATALOG_DIR": str(data_root / "product_catalog"),
        "MEMORYARENA_WEBSHOP_DOMAIN_DATA_PATH": str(no_pickle_cache),
        "WEBSHOP_CATALOG_CACHE_DIR": str(no_pickle_cache),
        "PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    }


def _shopping_owner_at(base_url: str, owner: str) -> bool:
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError("Shopping service address must be an explicit loopback-only HTTP origin")
    if not re.fullmatch(r"[a-f0-9]{32}", owner):
        raise RuntimeError("Shopping service run owner is missing or invalid")
    # No proxies or redirects: readiness must never contact a remote address.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(base_url + "/__deskpet_owner", timeout=1) as response:
            payload = response.read(4097)
            if len(payload) > 4096:
                return False
            return json.loads(payload) == {"owner": owner, "ready": True}
    except (OSError, ValueError):
        return False  # Not ready is observed by the owner's bounded startup deadline.


def _launch_shopping_service(root: Path, port: int) -> None:
    """Controlled invocation of the fixed official entrypoint, without patching its files."""
    owner = os.environ.get(SHOPPING_OWNER_ENV, "")
    if not re.fullmatch(r"[a-f0-9]{32}", owner) or not 1 <= port <= 65535:
        raise RuntimeError("Shopping service requires a valid owner and port")
    os.environ.update(_shopping_variables(root))
    sys.path.insert(0, str(_installed_source(root)))
    import uvicorn
    from env.env_systems.web_shopping_env.runtime.service import launch_lite
    original_run = uvicorn.run
    def loopback_run(app, **kwargs):
        # Heavy loading occurs in create(), not the health endpoint. Complete it
        # before listening or launching DeskPet, then keep a single run-owned slot.
        server = launch_lite.webshop_env_server_lite
        env_id = server.create()
        server.create = lambda: env_id
        # An MCP reconnect borrows the same warmed slot; only this process owns it.
        server.close = lambda requested_id: requested_id == env_id
        @app.get("/__deskpet_owner")
        async def run_owner():
            return {"owner": owner, "ready": True}
        kwargs.update(host="127.0.0.1", port=port, workers=1, reload=False)
        return original_run(app, **kwargs)
    uvicorn.run = loopback_run
    sys.argv = [str(Path(__file__)), "--port", str(port), "--limit_goals", "1000"]
    try:
        launch_lite.main()
    finally:
        uvicorn.run = original_run


@contextlib.contextmanager
def _prewarm_shopping_service(root: Path):
    hashes: dict = {}
    _verify_official_source(root, hashes)
    source = _environment_lock()["sources"]["shoppingProductDb"]
    _check_shopping_directory_entries(root / "environments" / source["directory"], source)
    for entry in source["files"]:
        _check_resource(_safe_path(root / "environments" / source["directory"], entry["path"]), entry, hashes)
    java = _resolve_java()
    if java is None:
        raise RuntimeError("Shopping requires an installed JDK with valid libjvm; automatic JDK installation is prohibited")
    runtime = root / "runtime"
    _no_links(runtime)
    runtime.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="shopping-run-", dir=runtime) as temporary:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        owner = uuid.uuid4().hex
        lease = {SHOPPING_URL_ENV: f"http://127.0.0.1:{port}", SHOPPING_OWNER_ENV: owner, SHOPPING_RUN_ENV: temporary}
        env = os.environ | _shopping_variables(root) | java | lease
        # Service never needs model/provider/broker variables; start with only OS/runtime inputs.
        service_env = {key: value for key, value in env.items() if key in {"PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "JAVA_HOME", "JVM_PATH", "PYTHONDONTWRITEBYTECODE", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "WEBSHOP_CATALOG_CACHE_DIR", SHOPPING_URL_ENV, SHOPPING_OWNER_ENV, SHOPPING_RUN_ENV} or key.startswith("MEMORYARENA_WEBSHOP_")}
        process = owned_popen([sys.executable, "-B", str(Path(__file__)), "--action", "shopping-service", "--repo-root", str(root.parents[5]), "--port", str(port)],
                              cwd=root.parents[5], env=service_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        capture = BoundedOutput(process, 1024 * 1024)
        try:
            deadline = time.monotonic() + SHOPPING_READY_SECONDS
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Owned shopping service exited before prewarm completed: " + capture.result()[1][-2000:])
                if capture.exceeded.is_set():
                    raise RuntimeError("Shopping service exceeded its startup output bound")
                if _shopping_owner_at(lease[SHOPPING_URL_ENV], owner):
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Shopping service prewarm timed out; native runner was not started")
                capture.exceeded.wait(min(0.1, remaining))
            yield lease
        finally:
            try:
                stop_owned(process, grace_seconds=5)
            finally:
                capture.finish(process)


def run_shopping_environment(repo_root: Path, request: dict[str, Any], node_executable: str) -> dict[str, Any]:
    if request.get("dataset") != "memoryarena" or not request.get("turns") or any(turn.get("environmentStep", {}).get("config") != "bundled_shopping" for turn in request["turns"]):
        raise ValueError("Shopping wrapper requires a standard MemoryArena shopping environment-turn request")
    if request.get("brokerEnv") or request.get("mcpServer", {}).get("env"):
        raise ValueError("Shopping requests must not contain credentials or transient environment values")
    node = Path(node_executable)
    if not node.is_absolute() or not node.is_file() or not os.access(node, os.X_OK):
        raise ValueError("Shopping wrapper requires an explicit existing absolute Node executable")
    root = repo_root / "test/sim/desk-pet-chat/external/.data/memoryarena"
    command = [str(node.resolve()), str(repo_root / "test/sim/desk-pet-chat/external/environment-turn.mjs")]
    with cancellation_scope():
        # Planning never starts a service. Execution always prewarms before even
        # spawning the native-runner hook; neither path creates judge verdicts.
        service = contextlib.nullcontext({}) if request.get("planOnly") is True else _prewarm_shopping_service(root)
        with service as lease:
            result = run_bounded(command, input_data=json.dumps(request, ensure_ascii=False) + "\n", cwd=repo_root, env=os.environ | lease,
                                 timeout=24 * 60 * 60, max_output=MAX_ENVIRONMENT_OUTPUT, grace_seconds=30, graceful_tree=False)
            if result["timedOut"] or result["outputLimited"]:
                raise RuntimeError("Shopping environment runner exceeded its time/output bound")
            lines = result["stdout"].strip().splitlines()
            if len(lines) != 1:
                raise RuntimeError("Shopping environment runner returned invalid JSONL")
            response = json.loads(lines[0])
            if not isinstance(response, dict) or "executionComplete" not in response:
                raise RuntimeError("Shopping environment runner returned an invalid response")
            if result["exitCode"] != 0 and response.get("executionComplete") is not False:
                raise RuntimeError("Shopping environment runner failed without a failure response")
            return response


def _shopping_environment(root: Path, step_file: Path, state: dict[str, Any], reset: bool = False) -> tuple[Any, dict[str, Any]]:
    _no_links(step_file)
    step = json.loads(step_file.read_text(encoding="utf-8"))
    if step.get("config") != "bundled_shopping":
        raise RuntimeError("Shopping MCP received a non-shopping environment step")
    group_id, subtask_index = step.get("groupId"), step.get("subtaskIndex")
    if type(group_id) is not int or type(subtask_index) is not int or subtask_index < 0:
        raise RuntimeError("Shopping MCP requires integer groupId and non-negative subtaskIndex")
    key = (group_id, subtask_index)
    if state.get("key") == key:
        if reset:
            with contextlib.redirect_stdout(io.StringIO()):
                state["client"].reset(subtask_index)
        return state["client"], step
    base_url, owner = os.environ.get(SHOPPING_URL_ENV, ""), os.environ.get(SHOPPING_OWNER_ENV, "")
    run_dir = Path(os.environ.get(SHOPPING_RUN_ENV, ""))
    _no_links(run_dir)
    if not run_dir.is_absolute() or not run_dir.is_dir() or run_dir.parent != root / "runtime" or not run_dir.name.startswith("shopping-run-"):
        raise RuntimeError("Shopping MCP requires its wrapper-owned per-run directory")
    if not _shopping_owner_at(base_url, owner):
        raise RuntimeError("Shopping service not prewarmed by this run; use run-shopping-environment before starting DeskPet")
    data_root = root / "environments" / "shopping-product-db"
    os.environ.update(_shopping_variables(root))
    sys.path.insert(0, str(_installed_source(root)))
    from env.env_systems.web_shopping_env.runtime.runner.task_files import _reconstruct_task_def_from_hf_row, build_instruction_for_step, build_single_step_task, split_agent_instruction
    from env.env_systems.web_shopping_env.webshop_plus_client import WebshopPlusEnvClient
    with contextlib.redirect_stdout(io.StringIO()):
        row = load_group(root, "bundled_shopping", group_id)
        task = _reconstruct_task_def_from_hf_row(row)
        if subtask_index >= len(task["steps"]):
            raise IndexError("Shopping subtaskIndex is outside the pinned source group")
        prefix, sections = split_agent_instruction(task["agent_instruction"])
        instruction = build_instruction_for_step(prefix, sections, subtask_index + 1, {}, include_history=False)
        step_task = build_single_step_task(task, subtask_index, instruction, total_steps=len(task["steps"]))
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=f"group-{group_id}-step-{subtask_index}-", suffix=".json", dir=run_dir, delete=False) as handle:
            task_file = Path(handle.name)
            state.setdefault("taskFiles", []).append(task_file)
            handle.write(json.dumps(step_task, ensure_ascii=False) + "\n")
        client = state.get("client")
        if client is None:
            client = WebshopPlusEnvClient(base_url, str(task_file), 1, action_format="react", timeout=5, max_rounds=40,
                                          product_catalog_dir=str(data_root / "product_catalog"), domain_data_path=str(data_root / "domain_data.json"), enable_feedback=False)
            state["client"] = client
        else:
            client._init_task_state(str(task_file), 40, False, str(data_root / "product_catalog"), str(data_root / "domain_data.json"))
        client.reset(subtask_index)
    state.update({"key": key, "lastStep": step})
    return client, step


def _cleanup_shopping(root: Path, state: dict[str, Any]) -> None:
    # The MCP only borrows a prewarmed environment. Never stop/close another
    # process or its slot; the wrapper's Popen owner releases the service.
    state.pop("client", None)
    state.pop("key", None)
    for task_file in state.pop("taskFiles", []):
        try:
            task_file.unlink(missing_ok=True)
        except OSError as exc:
            sys.stderr.write(f"MemoryArena owned task cleanup failed: {type(exc).__name__}\n")


def _serve_mcp(root: Path, config: str = "group_travel_planner") -> None:
    if config != "bundled_shopping":
        return _serve_mcp_protocol(root, config)
    state: dict[str, Any] = {}
    with cancellation_scope():
        try:
            _serve_mcp_protocol(root, config, state)
        finally:
            _cleanup_shopping(root, state)


def _serve_mcp_protocol(root: Path, config: str, shopping_state: dict[str, Any] | None = None) -> None:
    if config == "progressive_search":
        step_file_text = os.getenv("DESKPET_MEMORYARENA_STEP_FILE")
        if not step_file_text or not Path(step_file_text).is_absolute():
            raise RuntimeError("Progressive Search MCP requires an absolute DESKPET_MEMORYARENA_STEP_FILE")
        step_file = Path(step_file_text)
        tools = [
            {"name": "search", "description": "Search the pinned BrowseComp-Plus corpus using the installed local lexical BM25 adapter; results include corpus docids and snippets.", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"], "additionalProperties": False}},
            {"name": "get_document", "description": "Read one complete document by docid from the same pinned corpus used by search.", "inputSchema": {"type": "object", "properties": {"docid": {"type": "string"}}, "required": ["docid"], "additionalProperties": False}},
        ]
        for line in sys.stdin:
            try:
                request = json.loads(line)
                method, params, request_id = request.get("method"), request.get("params", {}), request.get("id")
                if method == "initialize":
                    response = _mcp_response(request_id, {"protocolVersion": params.get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "memoryarena-local-search-adapter", "version": "browsecomp-plus-bm25-v1"}})
                elif method == "ping":
                    response = _mcp_response(request_id, {})
                elif method == "tools/list":
                    response = _mcp_response(request_id, {"tools": tools})
                elif method == "tools/call":
                    step = json.loads(step_file.read_text(encoding="utf-8"))
                    if step.get("config") != "progressive_search" or not isinstance(step.get("groupId"), int) or not isinstance(step.get("subtaskIndex"), int):
                        raise RuntimeError("Progressive Search MCP received an invalid environment step")
                    group = load_group(root, "progressive_search", step["groupId"])
                    if not 0 <= step["subtaskIndex"] < len(group["questions"]):
                        raise RuntimeError("Progressive Search subtaskIndex is outside the pinned source group")
                    name, arguments = params.get("name"), params.get("arguments", {})
                    if name == "search":
                        result = _search_local(root, arguments.get("query"))
                    elif name == "get_document":
                        result = _get_local_document(root, arguments.get("docid"))
                    else:
                        response = _mcp_response(request_id, error={"code": -32602, "message": "Only search and get_document are available"})
                        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                        sys.stdout.flush()
                        continue
                    response = _mcp_response(request_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "isError": False})
                elif method == "notifications/initialized" or request_id is None:
                    continue
                else:
                    response = _mcp_response(request_id, error={"code": -32601, "message": f"Method not found: {method}"})
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            except Exception as exc:
                if "request" in locals() and isinstance(request, dict) and "id" in request:
                    sys.stdout.write(json.dumps(_mcp_response(request.get("id"), error={"code": -32000, "message": str(exc)}), ensure_ascii=False) + "\n")
                    sys.stdout.flush()
        return
    if config == "bundled_shopping":
        step_file_text = os.getenv("DESKPET_MEMORYARENA_STEP_FILE")
        if not step_file_text:
            raise RuntimeError("Shopping MCP requires DESKPET_MEMORYARENA_STEP_FILE from the isolated evaluation runner")
        step_file = Path(step_file_text)
        if shopping_state is None:
            raise RuntimeError("Shopping MCP requires an explicit lifecycle owner")
        state = shopping_state
        if not step_file.is_absolute():
            raise RuntimeError("DESKPET_MEMORYARENA_STEP_FILE must be absolute")
        tools = [
            {"name": "begin_task", "description": "Begin or reset the official WebShop task selected by the current isolated evaluation turn.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
            {"name": "observe", "description": "Read the current official WebShop state and allowed click targets for this subtask.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
            {"name": "search", "description": "Search the official WebShop catalog using keywords.", "inputSchema": {"type": "object", "properties": {"keywords": {"type": "string"}}, "required": ["keywords"], "additionalProperties": False}},
            {"name": "click", "description": "Click one of the exact target values offered by the official WebShop observation.", "inputSchema": {"type": "object", "properties": {"item": {"type": "string"}}, "required": ["item"], "additionalProperties": False}},
        ]
        for line in sys.stdin:
            try:
                request = json.loads(line)
                method, params, request_id = request.get("method"), request.get("params", {}), request.get("id")
                if method == "initialize":
                    response = _mcp_response(request_id, {"protocolVersion": params.get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "memoryarena-shopping-environment", "version": OFFICIAL_REVISION[:12]}})
                elif method == "ping":
                    response = _mcp_response(request_id, {})
                elif method == "tools/list":
                    response = _mcp_response(request_id, {"tools": tools})
                elif method == "tools/call":
                    name, arguments = params.get("name"), params.get("arguments", {})
                    if name not in {"begin_task", "observe", "search", "click"}:
                        response = _mcp_response(request_id, error={"code": -32602, "message": "Only begin_task, observe, search, and click are available"})
                    else:
                        client, _step = _shopping_environment(root, step_file, state, reset=name == "begin_task")
                        with contextlib.redirect_stdout(io.StringIO()):
                            if name in {"begin_task", "observe"}:
                                result = {"state": client.observe(), "done": bool(client.episode_done)}
                            else:
                                value_key = "keywords" if name == "search" else "item"
                                value = arguments.get(value_key)
                                if not isinstance(value, str) or not value.strip() or "]" in value:
                                    raise ValueError(f"{value_key} must be a non-empty action value without closing bracket")
                                action = f"{name}[{value}]"
                                output = client.step(action)
                                result = {"state": output.state, "done": bool(output.done)}
                        response = _mcp_response(request_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "isError": False})
                elif method == "notifications/initialized" or request_id is None:
                    continue
                else:
                    response = _mcp_response(request_id, error={"code": -32601, "message": f"Method not found: {method}"})
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            except Exception as exc:
                if "request" in locals() and isinstance(request, dict) and "id" in request:
                    sys.stdout.write(json.dumps(_mcp_response(request.get("id"), error={"code": -32000, "message": str(exc)}), ensure_ascii=False) + "\n")
                    sys.stdout.flush()
        return
    if config in {"formal_reasoning_math", "formal_reasoning_phys"}:
        tools = [{
            "name": "coding",
            "description": "Execute a short Python calculation inside the isolated, network-disabled MemoryArena coding sandbox. No host files are mounted.",
            "inputSchema": {"type": "object", "properties": {"code": {"type": "string", "description": "Python source code to execute in the isolated sandbox"}}, "required": ["code"], "additionalProperties": False},
        }]
        for line in sys.stdin:
            try:
                request = json.loads(line)
                method, params, request_id = request.get("method"), request.get("params", {}), request.get("id")
                if method == "initialize":
                    response = _mcp_response(request_id, {"protocolVersion": params.get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "memoryarena-code-sandbox", "version": OFFICIAL_REVISION[:12]}})
                elif method == "ping":
                    response = _mcp_response(request_id, {})
                elif method == "tools/list":
                    response = _mcp_response(request_id, {"tools": tools})
                elif method == "tools/call":
                    if params.get("name") != "coding":
                        response = _mcp_response(request_id, error={"code": -32602, "message": "Only the isolated coding tool is available"})
                    else:
                        result = _run_sandboxed_code(params.get("arguments", {}).get("code"))
                        response = _mcp_response(request_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "isError": result["exitCode"] not in (0, None) or result["timedOut"] or result["outputLimited"]})
                elif method == "notifications/initialized" or request_id is None:
                    continue
                else:
                    response = _mcp_response(request_id, error={"code": -32601, "message": f"Method not found: {method}"})
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            except Exception as exc:
                if "request" in locals() and isinstance(request, dict) and "id" in request:
                    sys.stdout.write(json.dumps(_mcp_response(request.get("id"), error={"code": -32000, "message": str(exc)}), ensure_ascii=False) + "\n")
                    sys.stdout.flush()
        return
    source = _installed_source(root)
    sys.path.insert(0, str(source))
    from env.env_systems.travel_planner_env.tool_schemas import TOOLS
    executor = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request.get("method")
            params = request.get("params", {})
            request_id = request.get("id")
            response = None
            if method == "initialize":
                response = _mcp_response(request_id, {
                    "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "memoryarena-travel-environment", "version": OFFICIAL_REVISION[:12]},
                })
            elif method == "ping":
                response = _mcp_response(request_id, {})
            elif method == "tools/list":
                response = _mcp_response(request_id, {"tools": [
                    {
                        "name": tool["function"]["name"],
                        "description": tool["function"]["description"],
                        "inputSchema": tool["function"]["parameters"],
                    }
                    for tool in TOOLS
                ]})
            elif method == "tools/call":
                name = params.get("name")
                arguments = params.get("arguments", {})
                if executor is None:
                    from env.env_systems.travel_planner_env.tool_executor import ToolExecutor
                with contextlib.redirect_stdout(io.StringIO()):
                    if executor is None:
                        executor = ToolExecutor(db_path=str(source / "env/env_systems/travel_planner_env/database"))
                    result = executor.execute(name, arguments)
                response = _mcp_response(request_id, {"content": [{"type": "text", "text": result}], "isError": str(result).startswith("Error")})
            elif method == "notifications/initialized" or request_id is None:
                continue
            else:
                response = _mcp_response(request_id, error={"code": -32601, "message": f"Method not found: {method}"})
            if response is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()
        except Exception as exc:  # The protocol boundary returns errors; no secrets are logged.
            if "request" in locals() and isinstance(request, dict) and "id" in request:
                sys.stdout.write(json.dumps(_mcp_response(request.get("id"), error={"code": -32000, "message": str(exc)}), ensure_ascii=False) + "\n")
                sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", required=True)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--config", choices=tuple(DATASETS), default="group_travel_planner")
    parser.add_argument("--node-executable")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    repo_root = Path(args.repo_root).resolve()
    cache_root = repo_root / "test/sim/desk-pet-chat/external/.data/memoryarena"
    os.environ.setdefault("PYTHONPYCACHEPREFIX", str(cache_root / "pycache"))
    if args.action == "shopping-service":
        _launch_shopping_service(cache_root, args.port)
        return
    if args.action == "run-shopping-environment":
        try:
            raw = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
            if len(raw) > 20 * 1024 * 1024:
                raise ValueError("Environment request exceeds its byte limit")
            result = run_shopping_environment(repo_root, json.loads(raw), args.node_executable or "")
        except (Exception, KeyboardInterrupt) as exc:
            result = {"executionComplete": False, "error": str(exc) or "Shopping environment cancelled"}
            sys.stderr.write(result["error"] + "\n")
            sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
            raise SystemExit(1)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return
    request = json.load(sys.stdin) if not sys.stdin.isatty() and args.action not in {"mcp-server", "install", "install-runtime", "build-search-index"} else {"action": args.action}
    if args.action == "mcp-server":
        _serve_mcp(cache_root, args.config)
        raise SystemExit(0)
    request["action"] = args.action
    if args.action == "install":
        result = install(repo_root)
    else:
        result = _dispatch(cache_root, request)
    if result is not None:
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
