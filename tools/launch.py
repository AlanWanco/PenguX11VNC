#!/usr/bin/env python3
"""Start/reuse the local viewer for a named connection profile."""

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
STATE = RUNTIME / "session.json"
DEFAULT_CONFIG = Path.home() / ".config/pengux11vnc/connections.json"
LEGACY_CONFIG = Path.home() / ".config/qq-window-viewer/connections.json"
OPENER = build_opener(ProxyHandler({}))
# Safe fallback for a first run. Configure a real profile in
# ~/.config/pengux11vnc/connections.json before connecting.
LEGACY = {
    "id": "remote-qq",
    "name": "Remote QQ",
    "ssh": {
        "user": "remote-user",
        "host": "remote.example",
        "port": 22,
        "privateKeyFile": "",
    },
    "tunnel": {"localPort": 15900, "remoteHost": "127.0.0.1", "remotePort": 5900},
    "vnc": {
        "passwordFile": "",
        "remotePasswordFile": "/run/user/1000/x11vnc.pass",
    },
    "window": {
        "display": ":0",
        "xauthority": "/run/user/1000/xauth",
        "id": "0x1",
        "className": "QQ",
    },
    "helpers": {
        "windowList": "/home/remote-user/.local/lib/pengux11vnc/list-qq-windows",
        "imeCapture": "/home/remote-user/.local/lib/pengux11vnc/capture-ime",
    },
    "children": {"enabled": True, "autoOpen": True, "minWidth": 80, "minHeight": 60},
    "clipboard": {"sync": False},
}


def resolve_config_path(path: Path) -> Path:
    if path == DEFAULT_CONFIG and not path.exists() and LEGACY_CONFIG.exists():
        return LEGACY_CONFIG
    return path


def profile_from_file(path: Path, selected: str | None) -> dict:
    if not path.exists():
        if selected or path != DEFAULT_CONFIG:
            raise SystemExit(f"找不到配置文件：{path}")
        return LEGACY
    try:
        document = json.loads(path.read_text())
        profiles = document.get("connections", {})
        name = selected or document.get("defaultConnection") or next(iter(profiles))
        profile = dict(profiles[name])
    except (OSError, ValueError, KeyError, StopIteration) as error:
        raise SystemExit(f"配置文件无效：{path}（{error}）") from error
    profile["id"] = name
    return profile


def nested(profile: dict, section: str, key: str, fallback):
    return profile.get(section, {}).get(key, fallback)


def check_tunnel(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=3) as sock:
            sock.settimeout(3)
            return sock.recv(12).startswith(b"RFB ")
    except OSError:
        return False


def check_server(url: str, profile_id: str) -> bool:
    parts = urlsplit(url)
    if parts.scheme != "http" or parts.hostname != "127.0.0.1":
        return False
    token = parse_qs(parts.fragment).get("token", [""])[0]
    if not token:
        return False
    req = Request(
        f"http://{parts.netloc}/api/status",
        headers={"X-PenguX11VNC-Token": token},
    )
    try:
        with OPENER.open(req, timeout=2) as response:
            data = json.load(response)
            return (
                data.get("app") == "PenguX11VNC"
                and data.get("profile") == profile_id
            )
    except (OSError, URLError, ValueError):
        return False


def ssh_command(profile: dict) -> list[str]:
    ssh = profile.get("ssh", {})
    args = [
        "ssh",
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
    ]
    key = os.path.expanduser(ssh.get("privateKeyFile", ""))
    if key:
        if not Path(key).is_file():
            raise SystemExit(f"SSH 私钥不存在：{key}")
        mode = Path(key).stat().st_mode & 0o777
        if mode & 0o077:
            raise SystemExit(f"SSH 私钥权限过宽，请执行 chmod 600 {key}")
        args += ["-i", key, "-o", "IdentitiesOnly=yes"]
    args += [
        "-L",
        f"127.0.0.1:{nested(profile, 'tunnel', 'localPort', 15900)}:{nested(profile, 'tunnel', 'remoteHost', '127.0.0.1')}:{nested(profile, 'tunnel', 'remotePort', 5900)}",
    ]
    args += [
        "-p",
        str(nested(profile, "ssh", "port", 22)),
        f"{ssh.get('user', '')}@{ssh.get('host', '')}",
    ]
    return args


def stop_known_server(state: dict) -> None:
    try:
        command = subprocess.check_output(
            ["ps", "-p", str(state["pid"]), "-o", "command="], text=True
        ).strip()
        if command.endswith(str(ROOT / "server.js")):
            os.kill(state["pid"], signal.SIGTERM)
    except (OSError, subprocess.CalledProcessError, KeyError):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="启动 PenguX11VNC 窗口连接前端")
    parser.add_argument(
        "--config",
        type=Path,
        default=Path(
            os.environ.get(
                "PENGUX11VNC_CONFIG",
                os.environ.get("QQ_VIEWER_CONFIG", DEFAULT_CONFIG),
            )
        ),
    )
    parser.add_argument("--profile", help="配置档名称")
    parser.add_argument("--no-open", action="store_true", help="只启动服务，不打开窗口")
    args = parser.parse_args()
    profile = profile_from_file(
        resolve_config_path(args.config.expanduser()), args.profile
    )
    profile_id = profile.get("id", args.profile or "linux-qq")
    local_port = int(nested(profile, "tunnel", "localPort", 15900))
    os.umask(0o077)
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    RUNTIME.chmod(0o700)
    state = {}
    if STATE.exists():
        try:
            state = json.loads(STATE.read_text())
        except (OSError, ValueError):
            pass

    owned_tunnel = None
    if not check_tunnel(local_port):
        with open(RUNTIME / "tunnel.log", "ab") as log:
            tunnel = subprocess.Popen(
                ssh_command(profile),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        for _ in range(30):
            if tunnel.poll() is not None:
                break
            if check_tunnel(local_port):
                owned_tunnel = tunnel
                break
            time.sleep(0.3)
        if owned_tunnel is None:
            if tunnel.poll() is None:
                tunnel.terminate()
            raise SystemExit(
                "SSH 隧道未就绪。请检查主机、私钥、QQ 与远端 x11vnc；没有重启它们。"
            )

    if not check_server(state.get("url", ""), profile_id):
        if state.get("pid"):
            stop_known_server(state)
        node = shutil.which("node") or "/opt/homebrew/bin/node"
        env = os.environ.copy()
        env["PENGUX11VNC_PORT"] = "0"
        env["PENGUX11VNC_VNC_PORT"] = str(local_port)
        env["PENGUX11VNC_IME_ENABLED"] = "1"
        env["PENGUX11VNC_CONNECTION_JSON"] = json.dumps(
            profile, ensure_ascii=False
        )
        password_file = nested(
            profile, "vnc", "passwordFile", "/tmp/pengux11vnc-vnc.pass"
        )
        if password_file and Path(os.path.expanduser(password_file)).is_file():
            env["PENGUX11VNC_VNC_PASSWORD_FILE"] = os.path.expanduser(password_file)
        log_path = RUNTIME / "server.log"
        with log_path.open("wb") as log:
            server = subprocess.Popen(
                [node, str(ROOT / "server.js")],
                cwd=ROOT,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        url = ""
        for _ in range(60):
            if server.poll() is not None:
                break
            lines = log_path.read_text(errors="replace").splitlines()
            if lines and check_server(lines[0], profile_id):
                url = lines[0]
                break
            time.sleep(0.1)
        if not url:
            if server.poll() is None:
                server.terminate()
            if owned_tunnel is not None:
                owned_tunnel.terminate()
            raise SystemExit(
                "前端服务启动失败，请检查私有的 .runtime/server.log（不要公开其中的访问链接）。"
            )
        state = {
            "url": url,
            "pid": server.pid,
            "profile": profile_id,
            "created": time.time(),
        }
        if owned_tunnel is not None:
            state["tunnelPid"] = owned_tunnel.pid
        STATE.write_text(json.dumps(state))
        STATE.chmod(0o600)

    print(
        f"前端已就绪：{profile.get('name', profile_id)}（仅监听 127.0.0.1）；QQ、输入法及远端 VNC 未重启。"
    )
    if args.no_open:
        return
    chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if not chrome.exists():
        raise SystemExit(
            "当前启动器需要 Google Chrome；请使用受信任浏览器打开 .runtime/session.json 中的本地链接。"
        )
    with open(RUNTIME / "chrome.log", "ab") as log:
        subprocess.run(
            [
                "open",
                "-n",
                "-a",
                "/Applications/Google Chrome.app",
                "--args",
                f"--user-data-dir={RUNTIME / 'chrome-profile'}",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=1000,780",
                f"--app={state['url']}",
            ],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            check=True,
        )
    print("已打开独立窗口，点击“连接窗口”。设置中可调整 UI、剪贴板和滚轮。")


if __name__ == "__main__":
    main()
