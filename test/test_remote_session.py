"""Unit/supervisor tests using temporary files only; never access real QQ."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "remote_session", ROOT / "tools/remote-session.py"
)
REMOTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOTE)


class RemoteSessionTests(unittest.TestCase):
    def test_window_watcher_handles_only_lifecycle_events(self) -> None:
        for event_type, expected in [
            (16, "create"),
            (17, "destroy"),
            (18, "unmap"),
            (19, "map"),
            (21, "reparent"),
            (22, None),
        ]:
            event = REMOTE.XEvent()
            event.type = event_type
            self.assertEqual(REMOTE.window_event_kind(event), expected)

    def test_window_watcher_emits_initial_and_debounced_change_snapshots(self) -> None:
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        output = StringIO()
        reads = 0
        event_pending = True
        waits = 0

        class FakeX11:
            def __init__(self, _session: dict) -> None:
                pass

            def subscribe_window_tree(self) -> None:
                pass

            def windows(self, **_options: object) -> list[dict]:
                nonlocal reads
                reads += 1
                windows = [
                    {
                        "id": "0x1",
                        "mapped": True,
                        "depth": 1,
                        "x": 0,
                        "y": 0,
                        "width": 100,
                        "height": 100,
                    }
                ]
                if reads > 1:
                    windows.append(
                        {
                            "id": "0x2",
                            "mapped": True,
                            "depth": 2,
                            "x": 10,
                            "y": 20,
                            "width": 800,
                            "height": 600,
                        }
                    )
                return windows

            def pending_events(self) -> list[REMOTE.XEvent]:
                nonlocal event_pending
                if event_pending:
                    event_pending = False
                    event = REMOTE.XEvent()
                    event.type = 16
                    return [event]
                return []

            def close(self) -> None:
                pass

        def fake_select(
            readers: list[int], _writers: list, _errors: list, timeout: float
        ):
            nonlocal waits
            waits += 1
            if waits <= 2:
                time.sleep(timeout)
                return [], [], []
            return readers, [], []

        try:
            with (
                mock.patch.object(REMOTE, "X11", FakeX11),
                mock.patch.object(
                    REMOTE.sys, "stdin", SimpleNamespace(fileno=lambda: read_fd)
                ),
                mock.patch.object(REMOTE.select, "select", side_effect=fake_select),
                redirect_stdout(output),
            ):
                REMOTE.watch_windows(
                    {
                        "display": ":0",
                        "xauthority": "/tmp/xauth",
                        "mainWindow": "0x1",
                        "className": "QQ",
                    }
                )
            messages = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(
                [item["reason"] for item in messages], ["initial", "event"]
            )
            self.assertEqual(messages[0]["windows"], [])
            self.assertEqual(messages[1]["windows"][0]["id"], "0x2")
        finally:
            os.close(read_fd)

    def test_password_requires_private_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "vnc.pass"
            path.write_bytes(bytes(8))
            path.chmod(0o600)
            self.assertTrue(REMOTE.valid_password_file(str(path)))
            path.chmod(0o644)
            self.assertFalse(REMOTE.valid_password_file(str(path)))
            path.chmod(0o600)
            link = Path(directory) / "link"
            link.symlink_to(path)
            self.assertFalse(REMOTE.valid_password_file(str(link)))
            path.write_bytes(bytes(7))
            self.assertFalse(REMOTE.valid_password_file(str(path)))

    def test_blank_password_path_finds_runtime_default(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            password = runtime / "x11vnc.pass"
            password.write_bytes(bytes(8))
            password.chmod(0o600)
            with mock.patch.dict(
                os.environ, {"XDG_RUNTIME_DIR": str(runtime)}, clear=False
            ):
                self.assertEqual(REMOTE.select_password_file(""), password)

    def test_vp8_payload_type_follows_video_offer(self) -> None:
        offer = "m=audio 9\na=rtpmap:96 opus/48000\nm=video 9\na=rtpmap:107 VP8/90000\n"
        self.assertEqual(REMOTE.vp8_payload_type(offer), 107)
        self.assertIsNone(
            REMOTE.vp8_payload_type("m=video 9\na=rtpmap:107 H264/90000\n")
        )

    def test_final_answer_sdp_comes_from_gathered_local_description(self) -> None:
        gathered_sdp = (
            "v=0\r\n"
            "m=video 40000 UDP/TLS/RTP/SAVPF 96\r\n"
            "a=candidate:1 1 UDP 2122260223 192.0.2.1 40000 typ host\r\n"
        )
        description = SimpleNamespace(sdp=SimpleNamespace(as_text=lambda: gathered_sdp))

        class FakeWebRTC:
            def get_property(self, name: str) -> object:
                if name != "local-description":
                    raise AssertionError(f"unexpected property: {name}")
                return description

        self.assertEqual(REMOTE.local_description_sdp(FakeWebRTC()), gathered_sdp)
        self.assertIsNone(
            REMOTE.local_description_sdp(
                SimpleNamespace(get_property=lambda _name: None)
            )
        )

    def test_bootstrap_does_not_buffer_followup_control_input(self) -> None:
        bootstrap = (ROOT / "tools/remote-session-bootstrap.py").read_text()
        control = b'{"action":"offer"}\n'
        script = (
            b"import os, selectors, sys\n"
            b"selector = selectors.DefaultSelector()\n"
            b"selector.register(sys.stdin.fileno(), selectors.EVENT_READ)\n"
            b"ready = selector.select(3)\n"
            b"print(os.read(sys.stdin.fileno(), 4096).decode().strip() if ready else 'timeout', flush=True)\n"
        )
        payload = f"{len(script)}\n".encode() + script + control
        process = subprocess.Popen(
            [sys.executable, "-c", bootstrap],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            assert process.stdin is not None
            assert process.stdout is not None
            process.stdin.write(payload)
            process.stdin.flush()
            import select

            readable, _, _ = select.select([process.stdout], [], [], 5)
            self.assertTrue(readable, "bootstrap consumed the buffered control line")
            self.assertEqual(process.stdout.readline().strip(), control.strip())
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()

    def test_recycled_xid_is_not_same_window(self) -> None:
        target = {
            "id": "0x10",
            "pid": 12,
            "start": "123",
            "exe": "/opt/QQ/qq",
            "display": ":0",
            "xauthority": "/tmp/test-xauth",
        }
        self.assertTrue(REMOTE.same_window(target, target))
        for key, value in [
            ("start", "999"),
            ("pid", 13),
            ("display", ":1"),
            ("exe", "/tmp/qq"),
        ]:
            self.assertFalse(REMOTE.same_window(target, {**target, key: value}))

    def test_supervisor_terminates_only_its_child_on_stdin_eof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "x11vnc"
            executable.write_text(
                f"#!{sys.executable}\nimport time\nprint('PORT=5990', flush=True)\ntime.sleep(60)\n"
            )
            executable.chmod(0o700)
            # Replace the read-only probe with a fixture in the test process only.
            code = (
                f"exec(compile(open({str(ROOT / 'tools/remote-session.py')!r}).read(), 'fixture', 'exec'), "
                "scope := {'__name__': 'fixture'}); "
                "scope['probe'] = lambda options: {'passwordReady': True, 'windows': [{'normal': True, 'transient': False}]}; "
                "scope['same_window'] = lambda a, b: True; "
                "scope['X11'] = type('FakeX11', (), {"
                "'__init__': lambda self, target: None, "
                "'ensure_visible': lambda self, target: False, "
                "'activate': lambda self, target: False, "
                "'close': lambda self: None}); "
                "scope['serve']({'target': {'display': ':0', 'xauthority': '/tmp/test-auth', 'id': '0x10'}, "
                "'passwordFile': '/tmp/test-pass'})"
            )
            process = subprocess.Popen(
                [sys.executable, "-c", code],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}"},
            )
            try:
                # A bounded reader prevents a regression from hanging the test suite.
                import selectors

                selector = selectors.DefaultSelector()
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(
                    selector.select(5), "supervisor did not signal readiness"
                )
                selector.close()
                self.assertEqual(json.loads(process.stdout.readline()), {"port": 5990})
                process.stdin.close()
                self.assertEqual(process.wait(timeout=5), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
