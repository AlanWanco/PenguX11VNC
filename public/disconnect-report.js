const eventFields = Object.freeze({
  "connect-attempt": ["mode"],
  "vnc-connect": ["child"],
  "vnc-disconnect": [
    "clean",
    "child",
    "socketCloseCode",
    "socketCloseWasClean",
    "socketCloseReasonLength",
    "socketState",
  ],
  "video-start": ["epoch", "fps", "bitrateKbps"],
  "video-first-frame": ["width", "height", "readyState"],
  "video-track": ["source", "streams", "track"],
  "video-connection-state": ["event", "state", "ice", "gathering", "signaling"],
  "video-answer": ["codec", "sdpLength", "hasVideo", "fps", "bitrateKbps"],
  "video-play-error": ["name"],
  "video-error": ["name"],
  "video-failure": ["name", "connectionState", "iceConnectionState"],
  "video-stats": ["peerState"],
});
const safeAtom = /^[A-Za-z0-9_.:/-]{1,80}$/;
const countFields = [
  "packetsReceived",
  "bytesReceived",
  "framesReceived",
  "framesDecoded",
  "keyFramesDecoded",
];

function safeScalar(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && safeAtom.test(value)) return value;
  return undefined;
}

function safeTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

export function sanitizeDiagnosticEvent(
  event,
  details = {},
  at = new Date().toISOString(),
) {
  const fields = Object.hasOwn(eventFields, event) ? eventFields[event] : null;
  if (!fields) return null;
  const safe = { at: safeTimestamp(at) || new Date().toISOString(), event };
  for (const field of fields) {
    const sourceField =
      field === "event" && Object.hasOwn(details, "transition")
        ? "transition"
        : field;
    const value = safeScalar(details[sourceField]);
    if (value !== undefined) {
      safe[field === "event" ? "transition" : field] = value;
    }
  }
  if (event === "video-stats") {
    const inbound = details.inbound || {};
    const totals = Object.fromEntries(countFields.map((field) => [field, 0]));
    for (const stream of Array.isArray(inbound.inbound)
      ? inbound.inbound
      : []) {
      for (const field of countFields) {
        const value = Number(stream?.[field]);
        if (Number.isFinite(value) && value > 0) totals[field] += value;
      }
    }
    if (Object.values(totals).some((value) => value > 0)) safe.inbound = totals;
    const transport = (
      Array.isArray(inbound.transport) ? inbound.transport : []
    )
      .map((item) => ({
        dtlsState: safeScalar(item?.dtlsState),
        iceState: safeScalar(item?.iceState),
      }))
      .filter((item) => item.dtlsState || item.iceState);
    if (transport.length) safe.transport = transport;
    const pairs = (
      Array.isArray(inbound.candidatePairs) ? inbound.candidatePairs : []
    )
      .map((item) => ({
        state: safeScalar(item?.state),
        nominated: item?.nominated === true,
        bytesSent: Number.isFinite(Number(item?.bytesSent))
          ? Number(item.bytesSent)
          : 0,
        bytesReceived: Number.isFinite(Number(item?.bytesReceived))
          ? Number(item.bytesReceived)
          : 0,
      }))
      .slice(0, 4);
    if (pairs.length) safe.candidatePairs = pairs;
  }
  return safe;
}

export function buildDisconnectReport({
  generatedAt = new Date().toISOString(),
  connectionStartedAt,
  runtime = "unknown",
  platform = "unknown",
  transport = "vnc",
  sessionType = "main",
  frameRate = 30,
  bitrateMode = "lossless",
  autoRecovery = false,
  clean = false,
  reason = "unexpected-disconnect",
  videoFailure,
  events = [],
}) {
  const safeGeneratedAt =
    safeTimestamp(generatedAt) || new Date().toISOString();
  const safeConnectionStartedAt = safeTimestamp(connectionStartedAt);
  const started = Date.parse(safeConnectionStartedAt || "");
  const ended = Date.parse(safeGeneratedAt);
  const safeFailure = videoFailure
    ? {
        name: safeScalar(videoFailure.name) || "Error",
        connectionState: safeScalar(videoFailure.connectionState) || "unknown",
        iceConnectionState:
          safeScalar(videoFailure.iceConnectionState) || "unknown",
      }
    : null;
  return JSON.stringify(
    {
      format: "PenguX11VNC disconnect report v1",
      generatedAt: safeGeneratedAt,
      connectionStartedAt: Number.isFinite(started)
        ? new Date(started).toISOString()
        : null,
      durationMs:
        Number.isFinite(started) && Number.isFinite(ended)
          ? Math.max(0, ended - started)
          : null,
      runtime: safeScalar(runtime) || "unknown",
      platform: safeScalar(platform) || "unknown",
      transport: transport === "video" ? "video" : "vnc",
      sessionType: sessionType === "child" ? "child" : "main",
      frameRate: [0, 5, 10, 15, 24, 30, 60].includes(Number(frameRate))
        ? Number(frameRate)
        : 30,
      bitrateMode: ["lossless", "high", "balanced", "low"].includes(bitrateMode)
        ? bitrateMode
        : "unknown",
      autoRecovery: autoRecovery === true,
      disconnect: {
        clean: clean === true,
        cleanMeaning: "noVNC 协议状态标志；true 不代表用户主动断开。",
        reason: safeScalar(reason) || "unknown",
      },
      videoFailure: safeFailure,
      recentEvents: (Array.isArray(events) ? events : [])
        .slice(-30)
        .map((event) =>
          event && typeof event.event === "string"
            ? sanitizeDiagnosticEvent(
                event.event,
                event,
                safeTimestamp(event.at),
              )
            : null,
        )
        .filter(Boolean),
      redaction:
        "Excludes credentials, host addresses, clipboard contents, file paths, and raw error messages.",
    },
    null,
    2,
  );
}
