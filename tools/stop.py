#!/usr/bin/env python3
"""Stop this viewer's bridge only, never kill QQ, Fcitx, x11vnc or shared tunnels."""

import json
import os
import signal
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".runtime" / "session.json"


def main() -> None:
    if not STATE.exists():
        print("没有本项目的运行记录。")
        return
    state = json.loads(STATE.read_text())
    try:
        command = subprocess.check_output(
            ["ps", "-p", str(state["pid"]), "-o", "command="], text=True
        ).strip()
    except subprocess.CalledProcessError:
        print("本地前端服务已经退出。")
        return
    if not command.endswith(str(ROOT / "server.js")):
        raise SystemExit("PID 已被其他程序使用，未停止任何进程。")
    os.kill(state["pid"], signal.SIGTERM)
    print("已停止本项目前端服务；远端 QQ、输入法、VNC 和原 SSH 隧道保持运行。")


if __name__ == "__main__":
    main()
