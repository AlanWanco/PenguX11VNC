#!/usr/bin/env python3
"""Normalize one Tauri installer into the single CI artifact to upload."""

from __future__ import annotations

import argparse
import hashlib
import shutil
from pathlib import Path

EXTENSIONS = {
    "dmg": ".dmg",
    "appimage": ".AppImage",
    "nsis": ".exe",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-root", type=Path, required=True)
    parser.add_argument("--bundle", choices=sorted(EXTENSIONS), required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--output", type=Path, default=Path("dist"))
    args = parser.parse_args()

    suffix = EXTENSIONS[args.bundle]
    candidates = sorted(
        path
        for path in args.bundle_root.rglob(f"*{suffix}")
        if path.is_file() and not path.name.endswith(".sig")
    )
    if len(candidates) != 1:
        raise SystemExit(
            f"Expected exactly one {args.bundle} bundle, found {len(candidates)}: "
            + ", ".join(str(path) for path in candidates)
        )
    args.output.mkdir(parents=True, exist_ok=True)
    destination = args.output / f"{args.name}{suffix}"
    shutil.copy2(candidates[0], destination)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    print(f"artifact={destination}")
    print(f"sha256={digest}")
    print(f"size={destination.stat().st_size}")


if __name__ == "__main__":
    main()
