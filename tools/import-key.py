#!/usr/bin/env python3
"""Copy an SSH private key into the per-user config directory with safe permissions."""

import argparse
import hashlib
import os
import stat
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="导入 SSH 私钥（不上传、不打印私钥内容）"
    )
    parser.add_argument("key", type=Path, help="已有私钥文件，例如 ~/.ssh/id_ed25519")
    parser.add_argument(
        "--config-dir", type=Path, default=Path.home() / ".config/qq-window-viewer"
    )
    parser.add_argument(
        "--name", default="id_remote", help="保存文件名，默认 id_remote"
    )
    args = parser.parse_args()
    source = args.key.expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"找不到私钥：{source}")
    if "/" in args.name or "\\" in args.name or args.name in {"", ".", ".."}:
        raise SystemExit("--name 只能是文件名")
    data = source.read_bytes()
    if not data or b"PRIVATE KEY" not in data:
        raise SystemExit("文件看起来不是 PEM/OpenSSH 私钥")
    destination_dir = args.config_dir.expanduser()
    destination_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination_dir.chmod(0o700)
    destination = destination_dir / "keys" / args.name
    destination.parent.mkdir(mode=0o700, exist_ok=True)
    destination.parent.chmod(0o700)
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")
    temporary.write_bytes(data)
    temporary.chmod(stat.S_IRUSR | stat.S_IWUSR)
    os.replace(temporary, destination)
    destination.chmod(stat.S_IRUSR | stat.S_IWUSR)
    fingerprint = ""
    try:
        result = subprocess.run(
            ["ssh-keygen", "-lf", str(destination), "-E", "sha256"],
            capture_output=True,
            text=True,
            check=True,
        )
        fingerprint = result.stdout.split()[1] if len(result.stdout.split()) > 1 else ""
    except (OSError, subprocess.CalledProcessError, IndexError):
        fingerprint = hashlib.sha256(data).hexdigest()[:16]
    print(f"已导入：{destination}")
    print(f"指纹：{fingerprint}")
    print("把下面路径填入 connections.json 的 ssh.privateKeyFile：")
    print(destination)
    print("如果私钥有口令，请先执行 ssh-add 让 SSH 使用 ssh-agent。")


if __name__ == "__main__":
    main()
