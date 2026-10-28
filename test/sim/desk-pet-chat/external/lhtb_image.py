"""Fetch and cache one explicitly selected LHTB task image through pinned crane."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any

CRANE_VERSION = "0.22.1"
CRANE_RELEASE_SHA256 = "889e6996ef939c12d613f4cae657cc2ecce822e69ea74a58a453a95d723a857d"
CRANE_ASSETS = {
    ("Darwin", "arm64"): ("go-containerregistry_Darwin_arm64.tar.gz", "2231fc8df8806d20d680ff1225db44e095a55dd6ac1ae8eced4faf4b278b78fb"),
    ("Darwin", "x86_64"): ("go-containerregistry_Darwin_x86_64.tar.gz", "6fedd06a648c11335f0e8b9547e4783002c30e9336047fec292942cd518bb799"),
    ("Linux", "aarch64"): ("go-containerregistry_Linux_arm64.tar.gz", "898c0cff975f898a33e8c4580bdafb0e7c02c7faa33374e946762f97c4ab7110"),
    ("Linux", "x86_64"): ("go-containerregistry_Linux_x86_64.tar.gz", "0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0"),
    ("Windows", "AMD64"): ("go-containerregistry_Windows_x86_64.tar.gz", "0e073ea8192c3b8442ec8aaf44d53c1050a09084669fae3a6ceb0f2026cf8b21"),
    ("Windows", "ARM64"): ("go-containerregistry_Windows_arm64.tar.gz", "bec68b29b18d3f0fb1938739e241006960168c748166d0370111bdc730979584"),
}
MAX_CRANE_ASSET_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024 * 1024
MAX_IMAGE_PULL_SECONDS = 3600
IMAGE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:@sha256:[0-9a-f]{64})?$")
TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def system_proxy_env(data_root: Path) -> dict[str, str]:
    """Pass system proxy settings and isolated Docker auth only to crane."""
    proxies = urllib.request.getproxies()
    isolated_home = data_root / "home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    docker_config = data_root / "docker-config"
    docker_config.mkdir(parents=True, exist_ok=True)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(isolated_home),
        "DOCKER_CONFIG": str(docker_config),
        "XDG_CONFIG_HOME": str(isolated_home / ".config"),
    }
    for key in ("SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    if proxies.get("https"):
        env["HTTPS_PROXY"] = env["https_proxy"] = proxies["https"]
    if proxies.get("http"):
        env["HTTP_PROXY"] = env["http_proxy"] = proxies["http"]
    return env


def fetch(url: str, destination: Path, expected_sha256: str, max_bytes: int) -> int:
    request = urllib.request.Request(url, headers={"User-Agent": "Desk-Pet-LHTB-image-preflight"})
    digest = hashlib.sha256()
    total = 0
    partial = destination.with_suffix(destination.suffix + ".part")
    if partial.exists():
        raise FileExistsError("an incomplete pinned release asset exists; inspect it before retrying")
    try:
        with urllib.request.urlopen(request, timeout=90) as response, partial.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("official crane asset exceeded the 32 MiB size cap")
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected_sha256:
            raise ValueError("official crane asset failed its pinned SHA-256 check")
        os.replace(partial, destination)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    return total


def ensure_crane(root: Path) -> tuple[Path, dict[str, Any]]:
    os_name = platform.system()
    machine = platform.machine()
    asset = CRANE_ASSETS.get((os_name, machine))
    if asset is None:
        raise RuntimeError(f"pinned crane release has no supported asset for {os_name}/{machine}")
    filename, expected_sha = asset
    bin_dir = root / "bin"
    cache_dir = root / "cache"
    bin_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    executable = bin_dir / ("crane.exe" if os_name == "Windows" else "crane")
    archive = bin_dir / f"{filename[:-7]}-v{CRANE_VERSION}.tar.gz"
    if archive.exists() and sha256_file(archive) != expected_sha:
        raise ValueError("cached crane release archive failed SHA-256 verification; it was left untouched")
    if not archive.exists():
        checksums = cache_dir / f"go-containerregistry-checksums-v{CRANE_VERSION}.txt"
        if checksums.exists() and sha256_file(checksums) != CRANE_RELEASE_SHA256:
            raise ValueError("cached official crane checksum list failed SHA-256 verification; it was left untouched")
        if not checksums.exists():
            fetch(
                f"https://github.com/google/go-containerregistry/releases/download/v{CRANE_VERSION}/checksums.txt",
                checksums,
                CRANE_RELEASE_SHA256,
                MAX_CRANE_ASSET_BYTES,
            )
        checksum_line = next((line.split() for line in checksums.read_text(encoding="utf-8").splitlines() if line.split() and line.split()[-1] == filename), None)
        if not checksum_line or checksum_line[0] != expected_sha:
            raise ValueError("official crane checksum list does not match the pinned platform asset")
        fetch(f"https://github.com/google/go-containerregistry/releases/download/v{CRANE_VERSION}/{filename}", archive, expected_sha, MAX_CRANE_ASSET_BYTES)
    with tarfile.open(archive, "r:gz") as bundle:
        matches = [member for member in bundle.getmembers() if PurePosixPath(member.name).name == executable.name and member.isfile()]
        if len(matches) != 1 or matches[0].size > 64 * 1024 * 1024:
            raise ValueError("official crane asset has an unexpected executable layout")
        stream = bundle.extractfile(matches[0])
        if stream is None:
            raise ValueError("could not read crane executable from the pinned archive")
        pinned_binary = stream.read()
    pinned_binary_sha = hashlib.sha256(pinned_binary).hexdigest()
    if executable.exists() and sha256_file(executable) != pinned_binary_sha:
        raise ValueError("cached crane executable does not match the pinned release archive; it was left untouched")
    if not executable.exists():
        temporary = executable.with_suffix(executable.suffix + ".part")
        temporary.write_bytes(pinned_binary)
        temporary.chmod(0o755)
        os.replace(temporary, executable)
    version = subprocess.run([str(executable), "version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=15, check=False)
    if version.returncode or version.stdout.strip() != CRANE_VERSION:
        raise RuntimeError("pinned crane executable did not report version " + CRANE_VERSION)
    return executable, {"version": CRANE_VERSION, "asset": filename, "assetSha256": "sha256:" + expected_sha, "binary": str(executable), "binarySha256": "sha256:" + sha256_file(executable)}


def safe_tar_members(bundle: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = bundle.getmembers()
    for member in members:
        name = PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
            raise ValueError("OCI image archive contains an unsafe tar member")
    return members


def verify_oci_tar(path: Path, expected_digest: str | None) -> dict[str, Any] | None:
    try:
        with tarfile.open(path, "r:") as bundle:
            members = safe_tar_members(bundle)
            files = {
                str(PurePosixPath(member.name)).removeprefix("./"): member
                for member in members
                if member.isfile() and not PurePosixPath(member.name).name.startswith("._")
            }
            index_member = files.get("index.json")
            if index_member is None:
                return None
            if index_member.size > 1024 * 1024:
                return None
            stream = bundle.extractfile(index_member)
            if stream is None:
                return None
            index = json.loads(stream.read())
            descriptors = index.get("manifests")
            if not isinstance(descriptors, list) or not descriptors:
                return None
            if expected_digest and not any(item.get("digest") == expected_digest for item in descriptors if isinstance(item, dict)):
                return None
            blob_hashes = {}
            total = 0
            for name, member in files.items():
                if not name.startswith("blobs/sha256/"):
                    continue
                digest = name.rsplit("/", 1)[-1]
                if not re.fullmatch(r"[0-9a-f]{64}", digest):
                    return None
                total += member.size
                if total > MAX_IMAGE_BYTES:
                    raise ValueError("OCI image archive exceeds the 12 GiB safety cap")
                source = bundle.extractfile(member)
                if source is None:
                    return None
                h = hashlib.sha256()
                while chunk := source.read(1024 * 1024):
                    h.update(chunk)
                if h.hexdigest() != digest:
                    return None
                blob_hashes[digest] = member.size
            if not blob_hashes:
                return None
            visited: set[str] = set()
            def verify_descriptor(descriptor: dict[str, Any]) -> None:
                digest = descriptor.get("digest", "")
                if not digest.startswith("sha256:") or digest[7:] not in blob_hashes:
                    raise ValueError("OCI index references a missing content-addressed blob")
                if descriptor.get("size") != blob_hashes[digest[7:]]:
                    raise ValueError("OCI descriptor size does not match its content-addressed blob")
                if digest in visited:
                    return
                visited.add(digest)
                media_type = descriptor.get("mediaType", "")
                if media_type not in {
                    "application/vnd.oci.image.index.v1+json",
                    "application/vnd.docker.distribution.manifest.list.v2+json",
                    "application/vnd.oci.image.manifest.v1+json",
                    "application/vnd.docker.distribution.manifest.v2+json",
                }:
                    return
                member = files.get("blobs/sha256/" + digest[7:])
                source = bundle.extractfile(member) if member else None
                document = json.loads(source.read()) if source is not None else None
                children = document.get("manifests", []) if media_type.endswith("index.v1+json") or media_type.endswith("manifest.list.v2+json") else []
                if isinstance(document, dict) and "config" in document:
                    children = [document["config"], *document.get("layers", [])]
                if not isinstance(children, list):
                    raise ValueError("OCI image manifest has an invalid descriptor list")
                for child in children:
                    if not isinstance(child, dict):
                        raise ValueError("OCI image manifest contains an invalid descriptor")
                    verify_descriptor(child)
            for descriptor in descriptors:
                if not isinstance(descriptor, dict):
                    raise ValueError("OCI index contains an invalid descriptor")
                verify_descriptor(descriptor)
            return {"index": index, "blobCount": len(blob_hashes), "blobBytes": total, "indexDigest": expected_digest or descriptors[0].get("digest")}
    except (OSError, tarfile.TarError, json.JSONDecodeError):
        return None


def docker_call(docker: str, docker_config: Path, args: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DOCKER_CONFIG"] = str(docker_config)
    return subprocess.run([docker, *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout, check=False)


def local_image(docker: str, docker_config: Path, image: str) -> dict[str, Any] | None:
    result = docker_call(docker, docker_config, ["image", "inspect", "--format", "{{json .}}", image], timeout=20)
    if result.returncode:
        return None
    try:
        record = json.loads(result.stdout.strip())
    except json.JSONDecodeError:
        return None
    requested_digest = image.rsplit("@", 1)[1] if "@sha256:" in image else None
    if requested_digest:
        repo_digests = record.get("RepoDigests") or []
        if image not in repo_digests and record.get("Id") != requested_digest:
            return None
    else:
        if image not in (record.get("RepoTags") or []):
            return None
    return record


def cache_key(image: str) -> str:
    return hashlib.sha256(image.encode("utf-8")).hexdigest()


def load_oci_image(path: Path, image: str, task_id: str, docker: str, docker_config: Path) -> dict[str, Any]:
    if not verify_oci_tar(path, image.rsplit("@", 1)[1] if "@sha256:" in image else None):
        raise ValueError("cached OCI archive did not match the selected task image and its blob digests")
    loaded = docker_call(docker, docker_config, ["load", "--input", str(path)], timeout=900)
    if loaded.returncode:
        raise RuntimeError("docker load failed for the verified OCI image archive: " + loaded.stderr[-1500:])
    match = re.search(r"Loaded image ID:\s*(sha256:[0-9a-f]{64})", loaded.stdout)
    loaded_id = match.group(1) if match else None
    if not loaded_id:
        # Some Docker versions print a repository tag instead of an image ID.
        loaded_id = image
    target = image if "@sha256:" not in image else image.split("@", 1)[0] + ":deskpet-lhtb-" + re.sub(r"[^a-zA-Z0-9_.-]", "-", task_id)
    if target != loaded_id:
        tagged = docker_call(docker, docker_config, ["tag", loaded_id, target], timeout=60)
        if tagged.returncode:
            raise RuntimeError("could not register the verified image under its official task reference: " + tagged.stderr[-1500:])
    record = local_image(docker, docker_config, image)
    if record is None:
        raise RuntimeError("Docker loaded the archive but the exact task image reference is still unavailable")
    return {"imageId": record.get("Id"), "repoDigests": record.get("RepoDigests") or [], "repoTags": record.get("RepoTags") or [], "dockerLoadOutput": loaded.stdout.strip()}


def directory_size(path: Path) -> int:
    total = 0
    for item in path.rglob("*"):
        if item.is_file() and not item.is_symlink():
            total += item.stat().st_size
            if total > MAX_IMAGE_BYTES:
                return total
    return total


def fetch_with_crane(crane: Path, image: str, destination: Path, log_path: Path, data_root: Path) -> None:
    command = [str(crane), "pull", "--format=oci", image, str(destination)]
    env = system_proxy_env(data_root)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with log_path.open("w", encoding="utf-8") as log:
        child = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT, text=True)
        while child.poll() is None:
            if time.monotonic() - started > MAX_IMAGE_PULL_SECONDS:
                child.kill()
                child.wait()
                raise TimeoutError("crane task image pull exceeded one hour")
            if destination.exists() and directory_size(destination) > MAX_IMAGE_BYTES:
                child.kill()
                child.wait()
                raise ValueError("task image pull exceeded the 12 GiB safety cap")
            time.sleep(2)
        if child.returncode:
            raise RuntimeError("pinned crane could not fetch the selected image; inspect " + str(log_path))


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    image = args.image
    task_id = args.task_id
    if not TASK_ID.fullmatch(task_id) or not IMAGE_REF.fullmatch(image):
        raise ValueError("invalid task id or Docker image reference")
    data_root = Path(args.data_root).resolve()
    data_base = Path(__file__).resolve().parent / ".data"
    try:
        data_root.relative_to(data_base)
    except ValueError as error:
        raise ValueError("LHTB image preparation must remain inside external/.data") from error
    docker_config = Path(args.docker_config).resolve()
    if not local_image(args.docker, docker_config, image):
        cache_root = data_root / "cache"
        image_cache = cache_root / "task-images" / cache_key(image)
        image_cache.mkdir(parents=True, exist_ok=True)
        archive = image_cache / "image.oci.tar"
        manifest_path = image_cache / "image.json"
        cached = archive if archive.is_file() else None
        if cached is not None:
            cache_record = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
            archive_sha = "sha256:" + sha256_file(archive)
            requested_digest = image.rsplit("@", 1)[1] if "@sha256:" in image else None
            if cache_record.get("image") != image or cache_record.get("archiveSha256") != archive_sha or (requested_digest and not verify_oci_tar(archive, requested_digest)):
                raise ValueError("cached task image provenance or content digest does not match the selected task reference")
        if cached is None:
            # Reuse the previously verified pinned smoke archive if it contains this exact manifest digest.
            expected_digest = image.rsplit("@", 1)[1] if "@sha256:" in image else None
            if expected_digest:
                for candidate in sorted(cache_root.glob("*.tar")):
                    if candidate.is_file() and verify_oci_tar(candidate, expected_digest):
                        cached = candidate
                        break
        if cached is not None:
            verified = verify_oci_tar(cached, image.rsplit("@", 1)[1] if "@sha256:" in image else None)
            if not verified:
                raise ValueError("cached OCI image failed its manifest or layer digest verification")
            if cached != archive:
                shutil.copyfile(cached, archive)
            provenance = {"source": "verified-oci-cache", "sourceArchive": str(cached), "archive": str(archive), "image": image, "archiveSha256": "sha256:" + sha256_file(archive), "archiveBytes": archive.stat().st_size, "manifest": verified}
            manifest_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
        else:
            crane, crane_info = ensure_crane(data_root)
            with tempfile.TemporaryDirectory(prefix=".lhtb-image-stage-", dir=cache_root) as temporary:
                stage = Path(temporary)
                oci_dir = stage / "oci"
                log_path = image_cache / "crane-pull.log"
                fetch_with_crane(crane, image, oci_dir, log_path, data_root)
                temporary_archive = stage / "image.oci.tar"
                with tarfile.open(temporary_archive, "w") as bundle:
                    for item in sorted(oci_dir.rglob("*")):
                        if item.is_symlink():
                            raise ValueError("crane OCI layout unexpectedly contains a symlink")
                        bundle.add(item, arcname=item.relative_to(oci_dir).as_posix())
                expected_digest = image.rsplit("@", 1)[1] if "@sha256:" in image else None
                verified = verify_oci_tar(temporary_archive, expected_digest)
                if not verified:
                    raise ValueError("crane output did not match the requested image digest or valid OCI blob hashes")
                os.replace(temporary_archive, archive)
            provenance = {"source": "official-crane-via-system-proxy", "image": image, "crane": crane_info, "archive": str(archive), "archiveSha256": "sha256:" + sha256_file(archive), "archiveBytes": archive.stat().st_size, "manifest": verified, "registryTransport": "proxy settings passed only to crane subprocess; no daemon/system proxy settings changed"}
            manifest_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
        loaded = load_oci_image(archive, image, task_id, args.docker, docker_config)
        return {"ready": True, "taskId": task_id, "image": image, "source": provenance["source"], "archive": str(archive), "loaded": loaded}
    return {"ready": True, "taskId": task_id, "image": image, "source": "local-docker-image", "loaded": local_image(args.docker, docker_config, image)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--docker-config", required=True)
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # Do not dump proxy environment, auth material, or command environments.
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
