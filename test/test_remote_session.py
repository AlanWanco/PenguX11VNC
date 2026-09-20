"""Unit/supervisor tests using temporary files only; never access real QQ."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "remote_session", ROOT / "tools/remote-session.py"
)
REMOTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOTE)


class RemoteSessionTests(unittest.TestCase):
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
