"""Authorized, pinned GAIA snapshot downloader. Token stays in this child process only."""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPOSITORY = "gaia-benchmark/GAIA"
REVISION = "682dd723ee1e1697e00360edccf2366dc8418dd9"
LICENSE = "No license declared in upstream card; gated data must not be redistributed"
USER_AGENT = "Desk-Pet authorized GAIA local data installer"
MAX_API_PAGES = 10
CHUNK_BYTES = 1024 * 1024


def report(event, **fields):
    # Emit only dataset metadata; never include auth headers, usernames, or exception messages.
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), file=sys.stderr, flush=True)


def repo_url(path):
    return f"https://huggingface.co/datasets/{REPOSITORY}/resolve/{REVISION}/{urllib.parse.quote(path, safe='/')}"


def valid_hf_host(url):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (host == "huggingface.co" or host.endswith(".huggingface.co") or host == "hf.co" or host.endswith(".hf.co"))


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        if not valid_hf_host(new_url):
            raise urllib.error.HTTPError(request.full_url, code, "untrusted Hugging Face redirect", headers, fp)
        redirected = super().redirect_request(request, fp, code, message, headers, new_url)
        if redirected is not None:
            redirected.remove_header("Authorization")
        return redirected


def make_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies()), SafeRedirectHandler())


def tree_files(opener, token):
    next_url = f"https://huggingface.co/api/datasets/{REPOSITORY}/tree/{REVISION}?recursive=true&expand=true&limit=100"
    all_files = []
    for _ in range(MAX_API_PAGES):
        if not next_url.startswith("https://huggingface.co/api/datasets/"):
            raise RuntimeError("HF tree pagination escaped the pinned dataset API")
        request = urllib.request.Request(next_url, headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT})
        with opener.open(request, timeout=30) as response:
            page = json.load(response)
            link_header = response.headers.get("Link", "")
        all_files.extend(item for item in page if item.get("type") == "file")
        match = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
        next_url = match.group(1) if match else None
        if next_url is None:
            return all_files
    raise RuntimeError("HF dataset tree exceeded the bounded pagination limit")


def selected_plan(files):
    by_path = {item["path"]: item for item in files}
    selected = []
    omitted = []
    for item in files:
        path = item.get("path", "")
        if not (path.startswith("2023/validation/") or path.startswith("2023/test/")):
            continue
        if path.rsplit("/", 1)[-1].startswith("metadata.level") and path.endswith(".parquet"):
            omitted.append({"path": path, "bytes": item.get("size"), "sourceOid": item.get("oid"), "reason": "derived per-level Parquet duplicates; aggregate metadata.parquet is retained"})
            continue
        if not (path.endswith("/metadata.parquet") or path.startswith("2023/validation/") or path.startswith("2023/test/")):
            continue
        if not isinstance(item.get("size"), int) or not isinstance(item.get("oid"), str):
            raise RuntimeError(f"Pinned HF tree omitted size or Git object id for {path}")
        lfs = item.get("lfs") or {}
        selected.append({
            "path": path,
            "split": "validation" if path.startswith("2023/validation/") else "test",
            "bytes": item["size"],
            "sourceOid": item["oid"],
            "sourceShaAlgorithm": "sha256" if isinstance(lfs.get("oid"), str) else "git-blob-sha1",
            "sourceSha": lfs.get("oid") or item["oid"],
            "url": repo_url(path),
            "license": LICENSE,
        })
    expected_files = {"validation": 39, "test": 72}
    observed = {split: sum(item["split"] == split for item in selected) for split in expected_files}
    if observed != expected_files:
        raise RuntimeError(f"Pinned GAIA source tree file count changed: {observed}")
    for split in ("validation", "test"):
        if f"2023/{split}/metadata.parquet" not in by_path:
            raise RuntimeError(f"Pinned GAIA tree is missing {split} aggregate metadata.parquet")
    selected.sort(key=lambda item: item["path"])
    omitted.sort(key=lambda item: item["path"])
    return selected, omitted


def safe_target(raw_root, upstream_path):
    candidate = raw_root.joinpath(*upstream_path.split("/"))
    resolved_root = raw_root.resolve()
    resolved = candidate.resolve(strict=False)
    if resolved == resolved_root or resolved_root not in resolved.parents:
        raise RuntimeError("GAIA upstream path escaped the raw data root")
    current = candidate.parent
    while current != current.parent:
        if current.exists() and current.is_symlink():
            raise RuntimeError("GAIA install path cannot pass through a symlink")
        if current == raw_root:
            break
        current = current.parent
    return candidate


def calculate_hashes(path, size):
    sha256 = hashlib.sha256()
    git_sha1 = hashlib.sha1()
    git_sha1.update(f"blob {size}\0".encode("ascii"))
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(CHUNK_BYTES)
            if not chunk:
                break
            sha256.update(chunk)
            git_sha1.update(chunk)
    return sha256.hexdigest(), git_sha1.hexdigest()


def matches_source(path, item):
    if not path.is_file() or path.stat().st_size != item["bytes"]:
        return False, None
    actual_sha256, actual_git_sha1 = calculate_hashes(path, item["bytes"])
    actual_source_sha = actual_sha256 if item["sourceShaAlgorithm"] == "sha256" else actual_git_sha1
    return actual_source_sha == item["sourceSha"], actual_sha256


def write_receipt(path, item, sha256):
    receipt = {"schemaVersion": 1, "repository": REPOSITORY, "revision": REVISION, "path": item["path"], "bytes": item["bytes"], "sourceShaAlgorithm": item["sourceShaAlgorithm"], "sourceSha": item["sourceSha"], "sha256": sha256, "url": item["url"]}
    temporary = path.with_name(path.name + f".{os.getpid()}.receipt.tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(receipt, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    os.replace(temporary, Path(str(path) + ".source.json"))


def download_one(opener, raw_root, token, item, on_progress):
    target = safe_target(raw_root, item["path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    receipt_path = Path(str(target) + ".source.json")
    if target.exists():
        if target.is_symlink():
            raise RuntimeError(f"GAIA cached path is a symlink: {item['path']}")
        ok, actual_sha256 = matches_source(target, item)
        receipt = json.loads(receipt_path.read_text(encoding="utf-8")) if receipt_path.exists() else None
        if not ok or (receipt is not None and (receipt.get("revision") != REVISION or receipt.get("path") != item["path"] or receipt.get("sourceSha") != item["sourceSha"])):
            raise RuntimeError(f"GAIA cached file failed its pinned source hash; refusing overwrite: {item['path']}")
        if receipt is None:
            write_receipt(target, item, actual_sha256)
        return {**item, "sha256": actual_sha256, "cached": True}

    partial = Path(str(target) + ".part")
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > item["bytes"]:
        raise RuntimeError(f"GAIA partial exceeds pinned source size: {item['path']}")
    if offset == item["bytes"]:
        ok, actual_sha256 = matches_source(partial, item)
        if ok:
            os.replace(partial, target)
            write_receipt(target, item, actual_sha256)
            return {**item, "sha256": actual_sha256, "cached": False}
        partial.unlink()
        offset = 0

    headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity", "Authorization": f"Bearer {token}"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(item["url"], headers=headers)
    with opener.open(request, timeout=60) as response:
        status = getattr(response, "status", response.getcode())
        if offset and status != 206:
            if status != 200:
                raise RuntimeError(f"Unexpected HTTP status for pinned GAIA download ({status})")
            offset = 0
        elif not offset and status != 200:
            raise RuntimeError(f"Unexpected HTTP status for pinned GAIA download ({status})")
        if status == 206:
            expected_range = f"bytes {offset}-"
            content_range = response.headers.get("Content-Range", "")
            if not content_range.startswith(expected_range) or not content_range.endswith(f"/{item['bytes']}"):
                raise RuntimeError(f"Invalid range response for pinned GAIA file: {item['path']}")
        mode = "ab" if status == 206 else "wb"
        received = offset
        with partial.open(mode) as output:
            while True:
                chunk = response.read(CHUNK_BYTES)
                if not chunk:
                    break
                received += len(chunk)
                if received > item["bytes"]:
                    output.close()
                    partial.unlink(missing_ok=True)
                    raise RuntimeError(f"GAIA response exceeded pinned byte size: {item['path']}")
                output.write(chunk)
                if received - on_progress[0] >= 8 * 1024 * 1024 or received == item["bytes"]:
                    report("file-progress", path=item["path"], receivedBytes=received, expectedBytes=item["bytes"])
                    on_progress[0] = received
    if received != item["bytes"]:
        raise RuntimeError(f"Incomplete pinned GAIA file: {item['path']} ({received}/{item['bytes']})")
    ok, actual_sha256 = matches_source(partial, item)
    if not ok:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Pinned GAIA source hash mismatch: {item['path']}")
    os.replace(partial, target)
    write_receipt(target, item, actual_sha256)
    return {**item, "sha256": actual_sha256, "cached": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    if args.revision != REVISION:
        raise RuntimeError("Refusing a non-catalog GAIA revision")
    from huggingface_hub import get_token

    token = get_token()
    if not token:
        raise RuntimeError("No authorized local Hugging Face token is available")
    repo_root = Path(args.repo_root).resolve()
    raw_root = repo_root / "test/sim/desk-pet-chat/external/.data/gaia/raw"
    raw_root.mkdir(parents=True, exist_ok=True)
    opener = make_opener()
    report("listing-start", revision=REVISION)
    selected, omitted = selected_plan(tree_files(opener, token))
    source_manifest = {"schemaVersion": 1, "dataset": "gaia", "repository": REPOSITORY, "revision": REVISION, "url": f"https://huggingface.co/datasets/{REPOSITORY}/tree/{REVISION}", "license": LICENSE, "authorizedLocalAccess": True, "personalIdentityRecorded": False, "files": selected, "omittedDerivedFiles": omitted, "counts": {"files": len(selected), "validationFiles": sum(item["split"] == "validation" for item in selected), "testFiles": sum(item["split"] == "test" for item in selected), "expectedQuestions": {"validation": 165, "test": 301}, "actualQuestions": None}}
    manifest_path = repo_root / "test/sim/desk-pet-chat/external/.data/gaia/source-manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temp_manifest = manifest_path.with_name(manifest_path.name + f".{os.getpid()}.tmp")
    temp_manifest.write_text(json.dumps(source_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp_manifest, manifest_path)
    installed = []
    for index, item in enumerate(selected, start=1):
        report("file-start", index=index, total=len(selected), path=item["path"], expectedBytes=item["bytes"])
        installed.append(download_one(opener, raw_root, token, item, [0]))
    report("install-files-complete", files=len(installed), bytes=sum(item["bytes"] for item in installed), cached=all(item["cached"] for item in installed))
    print(json.dumps({"sourceManifest": source_manifest, "files": installed}, ensure_ascii=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report("error", type=type(error).__name__)
        raise SystemExit(1)
