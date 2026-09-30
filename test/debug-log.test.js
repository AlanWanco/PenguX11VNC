import assert from "node:assert/strict";
import test from "node:test";
import { formatDebugLog } from "../server.js";

test("VNC upstream debug errors include an unambiguous UTC occurrence timestamp", () => {
  assert.equal(
    formatDebugLog(
      "vnc-upstream-error",
      { session: "main", message: "read ECONNRESET" },
      "2026-09-30T10:59:48.500Z",
    ),
    '[PenguX11VNC debug] 2026-09-30T10:59:48.500Z vnc-upstream-error {"session":"main","message":"read ECONNRESET"}',
  );
});

test("debug log formatting uses the current time by default and keeps payloads bounded", () => {
  const before = Date.now();
  const line = formatDebugLog("vnc-upstream-close", { websocketState: 2 });
  const timestamp = line.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
  )[0];
  assert(Date.parse(timestamp) >= before);
  assert(Date.parse(timestamp) <= Date.now());

  const bounded = formatDebugLog(
    "fixture",
    { message: "x".repeat(20_000) },
    timestamp,
  );
  assert(bounded.length <= 12_000 + 100);
});
