"""Load the embedded remote session script without buffering its control pipe."""

# The persistent service/video handlers watch stdin's OS file descriptor. A
# BufferedReader can prefetch following JSON commands and hide them from those
# readiness watchers, so consume exactly the framed source bytes with os.read.
import os
import sys

fd = sys.stdin.fileno()
header = bytearray()
while True:
    chunk = os.read(fd, 1)
    if not chunk:
        raise EOFError("remote helper length missing")
    if chunk == b"\n":
        break
    header.extend(chunk)

remaining = int(header)
source = bytearray()
while len(source) < remaining:
    chunk = os.read(fd, remaining - len(source))
    if not chunk:
        raise EOFError("remote helper source incomplete")
    source.extend(chunk)

exec(compile(bytes(source), "<pengux11vnc-remote-session>", "exec"))  # noqa: S102
