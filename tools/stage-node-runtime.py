#!/usr/bin/env python3
"""Download and verify the Node.js runtime embedded in a Tauri bundle."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

PLATFORMS = {
    "darwin": {"archive": "tar.gz", "binary": "bin/node"},
    "linux": {"archive": "tar.xz", "binary": "bin/node"},
    "win32": {"archive": "zip", "binary": "node.exe"},
}
ARCHES = {"x64", "arm64"}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "PenguX11VNC-ci"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--version", required=True, help="Node version without the v prefix"
    )
    parser.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    parser.add_argument("--arch", choices=sorted(ARCHES), required=True)
    parser.add_argument("--output", type=Path, default=Path("runtime/node"))
    args = parser.parse_args()

    platform = {"win32": "win", "darwin": "darwin", "linux": "linux"}[args.platform]
    archive_kind = PLATFORMS[args.platform]["archive"]
    archive_name = f"node-v{args.version}-{platform}-{args.arch}.{archive_kind}"
    base = f"https://nodejs.org/dist/v{args.version}"
    archive_url = f"{base}/{archive_name}"
    checksums = fetch(f"{base}/SHASUMS256.txt").decode("ascii")
    expected = next(
        (
            line.split()[0]
            for line in checksums.splitlines()
            if line.endswith(archive_name)
        ),
        None,
    )
    if not expected:
        raise SystemExit(f"Node archive checksum not found: {archive_name}")
    data = fetch(archive_url)
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise SystemExit(f"Node archive checksum mismatch for {archive_name}")

    with tempfile.TemporaryDirectory(prefix="pengux11vnc-node-") as temporary:
        root = Path(temporary)
        archive = root / archive_name
        archive.write_bytes(data)
        extract = root / "extract"
        extract.mkdir()
        if archive_kind == "zip":
            with zipfile.ZipFile(archive) as bundle:
                for member in bundle.infolist():
                    destination = (extract / member.filename).resolve()
                    if not destination.is_relative_to(extract.resolve()):
                        raise SystemExit("Unsafe Node archive path")
                bundle.extractall(extract)
        else:
            mode = "r:gz" if archive_kind == "tar.gz" else "r:xz"
            with tarfile.open(archive, mode) as bundle:
                for member in bundle.getmembers():
                    destination = (extract / member.name).resolve()
                    if not destination.is_relative_to(extract.resolve()):
                        raise SystemExit("Unsafe Node archive path")
                bundle.extractall(extract)
        folders = [item for item in extract.iterdir() if item.is_dir()]
        if len(folders) != 1:
            raise SystemExit("Unexpected Node archive layout")
        source = folders[0] / PLATFORMS[args.platform]["binary"]
        if not source.is_file():
            raise SystemExit(f"Node executable not found in {archive_name}")

        args.output.mkdir(parents=True, exist_ok=True)
        binary_name = "pengu-node.exe" if args.platform == "win32" else "pengu-node"
        destination = args.output / binary_name
        temporary_destination = args.output / f".{binary_name}.{os.getpid()}.tmp"
        shutil.copyfile(source, temporary_destination)
        if args.platform != "win32":
            temporary_destination.chmod(0o755)
        os.replace(temporary_destination, destination)

        license_source = folders[0] / "LICENSE"
        if license_source.is_file():
            shutil.copyfile(license_source, args.output / "LICENSE.node")

    print(
        f"staged {destination} sha256={hashlib.sha256(destination.read_bytes()).hexdigest()}"
    )


if __name__ == "__main__":
    main()
