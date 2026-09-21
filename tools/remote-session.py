#!/usr/bin/env python3
"""SSH-only probe/supervisor. Never reads window titles, pixels or clipboard.

The desktop embeds this file and runs it with python3 -c; no installation is
needed. probe is read-only. serve requires explicit client consent and owns only
its newly spawned x11vnc. Closing SSH stdin terminates that child.
"""

import ctypes as C
import ctypes.util
import json
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

DEBUG_WINDOWS = os.environ.get("PENGUX11VNC_DEBUG_WINDOWS") == "1"


def debug_log(event: str, **details: object) -> None:
    if not DEBUG_WINDOWS:
        return
    payload = json.dumps(details, ensure_ascii=False, separators=(",", ":"))
    print(
        f"[PenguX11VNC window-debug] {event} {payload[:8000]}",
        file=sys.stderr,
        flush=True,
    )


class Attributes(C.Structure):
    _fields_ = [
        ("x", C.c_int),
        ("y", C.c_int),
        ("width", C.c_int),
        ("height", C.c_int),
        ("border_width", C.c_int),
        ("depth", C.c_int),
        ("visual", C.c_void_p),
        ("root", C.c_ulong),
        ("klass", C.c_int),
        ("bit_gravity", C.c_int),
        ("win_gravity", C.c_int),
        ("backing_store", C.c_int),
        ("backing_planes", C.c_ulong),
        ("backing_pixel", C.c_ulong),
        ("save_under", C.c_int),
        ("colormap", C.c_ulong),
        ("map_installed", C.c_int),
        ("map_state", C.c_int),
        ("all_event_masks", C.c_long),
        ("your_event_mask", C.c_long),
        ("do_not_propagate_mask", C.c_long),
        ("override_redirect", C.c_int),
        ("screen", C.c_void_p),
    ]


class ClassHint(C.Structure):
    _fields_ = [("name", C.c_void_p), ("klass", C.c_void_p)]


def process_identity(pid: int) -> dict | None:
    try:
        directory = Path(f"/proc/{pid}")
        if directory.stat().st_uid != os.getuid():
            return None
        exe = os.readlink(directory / "exe")
        if Path(exe).name.lower() not in ("qq", "linuxqq"):
            return None
        # /proc/stat comm may contain spaces and closing parentheses.
        start = (directory / "stat").read_text().rsplit(")", 1)[1].split()[19]
        return {"pid": pid, "start": start, "exe": exe}
    except (OSError, ValueError, IndexError):
        return None


def sessions() -> tuple[bool, list[dict]]:
    found = {}
    running = False
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or not process_identity(int(entry.name)):
            continue
        running = True
        try:
            # Only these two values leave this function; never return environ.
            env = dict(
                part.split(b"=", 1)
                for part in (entry / "environ").read_bytes().split(b"\0")
                if b"=" in part
            )
            display = env.get(b"DISPLAY", b"").decode()
            auth = env.get(b"XAUTHORITY", b"").decode() or str(
                Path.home() / ".Xauthority"
            )
            if display.startswith(":") and Path(auth).is_file():
                found[(display, auth)] = {"display": display, "xauthority": auth}
        except (OSError, UnicodeError):
            pass
    return running, list(found.values())[:8]


class X11:
    def __init__(self, session: dict) -> None:
        self.session = session
        os.environ["XAUTHORITY"] = session["xauthority"]
        self.lib = C.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
        signatures = {
            "XOpenDisplay": ([C.c_char_p], C.c_void_p),
            "XCloseDisplay": ([C.c_void_p], C.c_int),
            "XDefaultRootWindow": ([C.c_void_p], C.c_ulong),
            "XRaiseWindow": ([C.c_void_p, C.c_ulong], C.c_int),
            "XMapRaised": ([C.c_void_p, C.c_ulong], C.c_int),
            "XSetInputFocus": (
                [C.c_void_p, C.c_ulong, C.c_int, C.c_ulong],
                C.c_int,
            ),
            "XFlush": ([C.c_void_p], C.c_int),
            "XInternAtom": ([C.c_void_p, C.c_char_p, C.c_int], C.c_ulong),
            "XGetWindowProperty": (
                [
                    C.c_void_p,
                    C.c_ulong,
                    C.c_ulong,
                    C.c_long,
                    C.c_long,
                    C.c_int,
                    C.c_ulong,
                    C.POINTER(C.c_ulong),
                    C.POINTER(C.c_int),
                    C.POINTER(C.c_ulong),
                    C.POINTER(C.c_ulong),
                    C.POINTER(C.c_void_p),
                ],
                C.c_int,
            ),
            "XQueryTree": (
                [
                    C.c_void_p,
                    C.c_ulong,
                    C.POINTER(C.c_ulong),
                    C.POINTER(C.c_ulong),
                    C.POINTER(C.POINTER(C.c_ulong)),
                    C.POINTER(C.c_uint),
                ],
                C.c_int,
            ),
            "XGetClassHint": ([C.c_void_p, C.c_ulong, C.POINTER(ClassHint)], C.c_int),
            "XGetWindowAttributes": (
                [C.c_void_p, C.c_ulong, C.POINTER(Attributes)],
                C.c_int,
            ),
            "XGetTransientForHint": (
                [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong)],
                C.c_int,
            ),
            "XFree": ([C.c_void_p], C.c_int),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result
        self.error_handler = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p)(lambda *_: 0)
        self.lib.XSetErrorHandler(self.error_handler)
        self.display = self.lib.XOpenDisplay(session["display"].encode())
        if not self.display:
            raise RuntimeError("display-unavailable")

    def property(self, window: int, name: str) -> list[int]:
        actual, count, remaining = C.c_ulong(), C.c_ulong(), C.c_ulong()
        fmt, data = C.c_int(), C.c_void_p()
        atom = self.lib.XInternAtom(self.display, name.encode(), 0)
        self.lib.XGetWindowProperty(
            self.display,
            window,
            atom,
            0,
            16,
            0,
            0,
            C.byref(actual),
            C.byref(fmt),
            C.byref(count),
            C.byref(remaining),
            C.byref(data),
        )
        try:
            if fmt.value == 32 and data.value:
                values = C.cast(data, C.POINTER(C.c_ulong))
                return [values[i] for i in range(min(count.value, 16))]
            return []
        finally:
            if data.value:
                self.lib.XFree(data)

    def _target_window(self, target: dict) -> tuple[int, Attributes, bool]:
        value = str(target.get("id") or "")
        if not value.lower().startswith("0x"):
            raise RuntimeError("invalid-window-id")
        try:
            window = int(value, 16)
        except ValueError as error:
            raise RuntimeError("invalid-window-id") from error
        if window <= 0:
            raise RuntimeError("invalid-window-id")
        attrs = Attributes()
        if not self.lib.XGetWindowAttributes(
            self.display, window, C.byref(attrs)
        ):
            raise RuntimeError("window-unavailable")
        hint = ClassHint()
        if not self.lib.XGetClassHint(self.display, window, C.byref(hint)):
            raise RuntimeError("window-class-unavailable")
        try:
            klass = (
                C.string_at(hint.klass).decode(errors="replace")
                if hint.klass
                else ""
            )
        finally:
            if hint.name:
                self.lib.XFree(hint.name)
            if hint.klass:
                self.lib.XFree(hint.klass)
        expected_class = str(target.get("className") or "QQ")
        if klass.lower() != expected_class.lower():
            raise RuntimeError("window-class-mismatch")
        pids = self.property(window, "_NET_WM_PID")
        identity = process_identity(pids[0]) if pids else None
        if not identity:
            raise RuntimeError("window-process-unavailable")
        for key in ("pid", "start", "exe"):
            expected = target.get(key)
            if expected is not None and str(identity.get(key)) != str(expected):
                raise RuntimeError("window-identity-mismatch")
        hidden_atom = self.lib.XInternAtom(
            self.display, b"_NET_WM_STATE_HIDDEN", 0
        )
        hidden = hidden_atom in self.property(window, "_NET_WM_STATE")
        return window, attrs, hidden

    def ensure_visible(self, target: dict) -> bool:
        window, attrs, hidden = self._target_window(target)
        debug_log(
            "ensure-visible",
            id=target.get("id"),
            mapped=attrs.map_state == 2,
            hidden=hidden,
        )
        if attrs.map_state == 2 and not hidden:
            return False
        self.lib.XMapRaised(self.display, window)
        self.lib.XFlush(self.display)
        return True

    def activate(self, target: dict) -> bool:
        window, attrs, hidden = self._target_window(target)
        restored = attrs.map_state != 2 or hidden
        debug_log(
            "activate",
            id=target.get("id"),
            mapped=attrs.map_state == 2,
            hidden=hidden,
            restored=restored,
        )
        if restored:
            self.lib.XMapRaised(self.display, window)
        else:
            self.lib.XRaiseWindow(self.display, window)
        # RevertToParent=2, CurrentTime=0. This is issued only after a local
        # viewer focus/click or by the connection-owned visibility watchdog.
        self.lib.XSetInputFocus(self.display, window, 2, 0)
        self.lib.XFlush(self.display)
        return restored

    def windows(self) -> list[dict]:
        root_window = self.lib.XDefaultRootWindow(self.display)
        queue = [(root_window, 0)]
        result = []
        normal = self.lib.XInternAtom(self.display, b"_NET_WM_WINDOW_TYPE_NORMAL", 0)
        visited = set()
        debug_log("scan-start", root=hex(root_window), display=self.session.get("display"))
        while queue and len(visited) < 10000 and len(result) < 32:
            window, depth = queue.pop()
            if window in visited:
                continue
            visited.add(window)
            attrs, hint, transient = Attributes(), ClassHint(), C.c_ulong()
            if window != root_window and self.lib.XGetClassHint(
                self.display, window, C.byref(hint)
            ):
                try:
                    klass = (
                        C.string_at(hint.klass).decode(errors="replace")
                        if hint.klass
                        else ""
                    )
                    name = (
                        C.string_at(hint.name).decode(errors="replace")
                        if hint.name
                        else ""
                    )
                finally:
                    if hint.name:
                        self.lib.XFree(hint.name)
                    if hint.klass:
                        self.lib.XFree(hint.klass)
                if klass.lower() == "qq" and self.lib.XGetWindowAttributes(
                    self.display, window, C.byref(attrs)
                ):
                    pids = self.property(window, "_NET_WM_PID")
                    identity = process_identity(pids[0]) if pids else None
                    types = self.property(window, "_NET_WM_WINDOW_TYPE")
                    self.lib.XGetTransientForHint(
                        self.display, window, C.byref(transient)
                    )
                    if identity and attrs.width >= 80 and attrs.height >= 60:
                        result.append(
                            {
                                **identity,
                                "id": hex(window),
                                "mapped": attrs.map_state == 2,
                                "width": attrs.width,
                                "height": attrs.height,
                                "className": klass,
                                "instance": name,
                                "normal": not types or normal in types,
                                "transient": bool(
                                    transient.value or attrs.override_redirect
                                ),
                            }
                        )
            if depth < 32:
                root, parent, children, count = (
                    C.c_ulong(),
                    C.c_ulong(),
                    C.POINTER(C.c_ulong)(),
                    C.c_uint(),
                )
                if self.lib.XQueryTree(
                    self.display,
                    window,
                    C.byref(root),
                    C.byref(parent),
                    C.byref(children),
                    C.byref(count),
                ):
                    queue.extend(
                        (children[i], depth + 1) for i in range(min(count.value, 10000))
                    )
                if children:
                    self.lib.XFree(children)
        if queue:
            debug_log("scan-too-large", visited=len(visited), returned=len(result))
            raise RuntimeError("window-scan-too-large")
        debug_log(
            "scan-done",
            visited=len(visited),
            count=len(result),
            windows=[
                {
                    "id": item["id"],
                    "mapped": item["mapped"],
                    "width": item["width"],
                    "height": item["height"],
                }
                for item in result
            ],
        )
        return result

    def close(self) -> None:
        self.lib.XCloseDisplay(self.display)


def valid_password_file(name: str) -> bool:
    try:
        info = Path(name).lstat()
        return (
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.getuid()
            and not info.st_mode & 0o077
            and info.st_size in (8, 16)
        )
    except OSError:
        return False


def default_password_files() -> list[Path]:
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    candidates = [
        Path(runtime_dir) / "x11vnc.pass",
        Path.home() / ".config/pengux11vnc/vnc.pass",
        Path.home() / ".config/qq-window-viewer/vnc.pass",
    ]
    unique: list[Path] = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
    return unique


def helper_directory() -> Path:
    candidates = [
        Path.home() / ".local/lib/pengux11vnc",
        Path.home() / ".local/lib/qq-window-viewer",
    ]
    for candidate in candidates:
        if any((candidate / name).is_file() for name in ("list-qq-windows", "capture-ime")):
            return candidate
    return candidates[0]


def select_password_file(requested: str) -> Path:
    explicit = requested.strip()
    if explicit:
        return Path(explicit).expanduser()
    candidates = default_password_files()
    for candidate in candidates:
        if valid_password_file(str(candidate)):
            return candidate
    return candidates[0]


def probe(options: dict) -> dict:
    running, displays = sessions()
    debug_log("probe-start", displays=[session.get("display") for session in displays])
    windows, accessible = [], 0
    for session in displays:
        try:
            x11 = X11(session)
            try:
                windows.extend({**item, **session} for item in x11.windows())
                accessible += 1
            finally:
                x11.close()
        except (OSError, RuntimeError):
            continue
    password_file = select_password_file(str(options.get("passwordFile") or ""))
    helper = helper_directory()
    debug_log(
        "probe-done",
        running=running,
        accessible=accessible,
        windowCount=len(windows[:32]),
        helper=str(helper),
    )
    return {
        "processes": [
            identity
            for entry in Path("/proc").iterdir()
            if entry.name.isdigit() and (identity := process_identity(int(entry.name)))
        ][:256],
        "running": running,
        "displayAccessible": accessible > 0,
        "windowScanComplete": accessible == len(displays),
        "x11vnc": bool(shutil.which("x11vnc")),
        "windows": windows[:32],
        "passwordFile": str(password_file),
        "passwordReady": valid_password_file(password_file),
        "helpers": {
            "windowList": str(helper / "list-qq-windows"),
            "imeCapture": str(helper / "capture-ime"),
        },
        "imeReady": os.access(helper / "capture-ime", os.X_OK),
    }


def same_window(expected: dict, actual: dict) -> bool:
    return all(
        expected.get(key) == actual.get(key)
        for key in ("id", "pid", "start", "exe", "display", "xauthority")
    )


def activate(options: dict) -> dict:
    target = options.get("target") or options
    if not isinstance(target, dict):
        raise TypeError("invalid-target")
    display = str(target.get("display") or "")
    xauthority = str(target.get("xauthority") or "")
    if not display.startswith(":") or not xauthority:
        raise RuntimeError("invalid-display")
    x11 = X11({"display": display, "xauthority": xauthority})
    try:
        restored = x11.activate(target)
        return {"ok": True, "restored": restored, "id": target.get("id")}
    finally:
        x11.close()


def serve(options: dict) -> None:
    def interrupted(_signal: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    target, password = options["target"], options["passwordFile"]
    debug_log("serve-start", target_id=target.get("id"), display=target.get("display"))
    report = probe({"passwordFile": password})
    if not report["passwordReady"] or not any(
        same_window(target, item)
        and item.get("mapped", True)
        and item["normal"]
        and not item["transient"]
        for item in report["windows"]
    ):
        raise RuntimeError("target-unavailable")
    # The VNC process chooses its own free localhost port and reports PORT=n.
    args = [
        "x11vnc",
        "-display",
        target["display"],
        "-auth",
        target["xauthority"],
        "-id",
        target["id"],
        "-localhost",
        "-autoport",
        "5900",
        "-forever",
        "-shared",
        "-noxdamage",
        "-noshm",
        "-rfbauth",
        password,
        "-rfbversion",
        "3.3",
        "-xwarppointer",
    ]
    x11 = X11(target)
    child = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    debug_log("vnc-spawn", target_id=target.get("id"), pid=child.pid)
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin, selectors.EVENT_READ, "owner")
    selector.register(child.stdout, selectors.EVENT_READ, "vnc")
    ready, buffer = False, b""
    owner_buffer = b""
    deadline = time.monotonic() + 10
    next_visibility_check = time.monotonic()
    try:
        while child.poll() is None:
            if not ready and time.monotonic() > deadline:
                raise RuntimeError("vnc-start-timeout")
            for key, _ in selector.select(0.5):
                if key.data == "owner":
                    data = os.read(sys.stdin.fileno(), 4096)
                    if not data:
                        return
                    owner_buffer = (owner_buffer + data)[-8192:]
                    while b"\n" in owner_buffer:
                        line, owner_buffer = owner_buffer.split(b"\n", 1)
                        try:
                            command = json.loads(line.decode())
                            if command.get("action") == "activate":
                                x11.activate(target)
                            elif command.get("action") == "restore":
                                x11.ensure_visible(target)
                        except (UnicodeError, ValueError, KeyError, RuntimeError):
                            pass
                else:
                    data = os.read(child.stdout.fileno(), 4096)
                    if not data:
                        return
                    buffer = (buffer + data)[-8192:]
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not ready and line.startswith(b"PORT="):
                            port = int(line[5:])
                            if not 1024 <= port <= 65535:
                                raise RuntimeError("invalid-port")
                            ready = True
                            debug_log("vnc-ready", pid=child.pid, port=port)
                            print(json.dumps({"port": port}), flush=True)
            if time.monotonic() >= next_visibility_check:
                try:
                    x11.ensure_visible(target)
                except RuntimeError:
                    pass
                next_visibility_check = time.monotonic() + 1
    finally:
        debug_log(
            "vnc-stop",
            pid=child.pid,
            ready=ready,
            returncode=child.poll(),
        )
        selector.close()
        x11.close()
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def main() -> None:
    try:
        action, options = sys.argv[1], json.loads(sys.argv[2])
        if action == "probe":
            print(json.dumps(probe(options)), flush=True)
        elif action == "activate":
            print(json.dumps(activate(options)), flush=True)
        elif action == "serve":
            serve(options)
        else:
            raise RuntimeError("invalid-action")
    except (OSError, ValueError, KeyError, RuntimeError):
        # Do not echo subprocess arguments, environment or credentials.
        print(json.dumps({"error": "remote-probe-or-service-failed"}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
