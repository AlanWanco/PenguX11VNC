import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDisconnectReport,
  sanitizeDiagnosticEvent,
} from "../public/disconnect-report.js";

test("disconnect events retain only safe, useful diagnostics", () => {
  const event = sanitizeDiagnosticEvent(
    "video-connection-state",
    {
      event: "connection",
      state: "failed",
      ice: "disconnected",
      token: "secret-token",
      password: "secret-password",
      host: "192.0.2.10",
      clipboard: "private text",
      message: "raw failure message",
    },
    "2026-09-23T12:00:00.000Z",
  );
  assert.deepEqual(event, {
    at: "2026-09-23T12:00:00.000Z",
    event: "video-connection-state",
    transition: "connection",
    state: "failed",
    ice: "disconnected",
  });
  assert.doesNotMatch(
    JSON.stringify(event),
    /secret-token|secret-password|192\.0\.2\.10|private text|raw failure/,
  );
});

test("video statistics are reduced to counters and protocol states", () => {
  const event = sanitizeDiagnosticEvent("video-stats", {
    peerState: "connected/connected",
    inbound: {
      inbound: [
        { packetsReceived: 10, bytesReceived: 2000, framesDecoded: 8 },
        { packetsReceived: 2, bytesReceived: 400, framesDecoded: 2 },
      ],
      transport: [
        {
          dtlsState: "connected",
          iceState: "connected",
          selectedCandidatePairId: "private-candidate-id",
        },
      ],
      candidatePairs: [
        {
          state: "succeeded",
          nominated: true,
          bytesSent: 100,
          bytesReceived: 200,
          localAddress: "192.0.2.20",
        },
      ],
    },
  });
  assert.deepEqual(event.inbound, {
    packetsReceived: 12,
    bytesReceived: 2400,
    framesReceived: 0,
    framesDecoded: 10,
    keyFramesDecoded: 0,
  });
  assert.equal(event.transport[0].iceState, "connected");
  assert.equal(event.candidatePairs[0].state, "succeeded");
  assert.doesNotMatch(
    JSON.stringify(event),
    /private-candidate-id|192\.0\.2\.20/,
  );
});

test("copyable report omits credentials and raw clipboard/error data", () => {
  const event = sanitizeDiagnosticEvent("vnc-disconnect", {
    clean: false,
    child: false,
    token: "token-value",
    host: "remote.example",
  });
  const transitionEvent = sanitizeDiagnosticEvent(
    "video-connection-state",
    { event: "connection", state: "connected" },
    "2026-09-23T12:00:02.000Z",
  );
  const report = buildDisconnectReport({
    generatedAt: "2026-09-23T12:00:05.000Z",
    connectionStartedAt: "2026-09-23T12:00:00.000Z",
    runtime: "Tauri",
    platform: "macOS",
    transport: "video",
    autoRecovery: true,
    clean: false,
    reason: "unexpected-disconnect",
    videoFailure: {
      name: "OperationError",
      message: "raw error text",
      connectionState: "failed",
      iceConnectionState: "disconnected",
      password: "secret",
    },
    events: [
      event,
      transitionEvent,
      {
        at: "token-value",
        event: "vnc-disconnect",
        clean: false,
        child: false,
        token: "token-value",
        clipboard: "private text",
      },
    ],
  });
  const parsed = JSON.parse(report);
  assert.equal(parsed.durationMs, 5000);
  assert.equal(parsed.transport, "video");
  assert.equal(parsed.autoRecovery, true);
  assert.match(parsed.disconnect.cleanMeaning, /不代表用户主动断开/);
  assert.equal(parsed.recentEvents[1].transition, "connection");
  assert.equal(parsed.videoFailure.name, "OperationError");
  assert.doesNotMatch(
    report,
    /token-value|remote\.example|raw error text|secret|private text/i,
  );
});
