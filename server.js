import http from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes, timingSafeEqual, createDecipheriv } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { WebSocketServer, createWebSocketStream } from "ws";
import { normalizeConnection, connectionFromJson } from "./config.js";
import { startImeBridge, imeCommandFor } from "./ime-bridge.js";

const execFileAsync = promisify(execFile);
const debugEnabled = process.env.PENGUX11VNC_DEBUG === "1";
function debugLog(event, details = {}) {
  if (!debugEnabled) return;
  const safe = (JSON.stringify(details) || "{}").slice(0, 12000);
  console.error(`[PenguX11VNC debug] ${event} ${safe}`);
}
const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, "public");
const vendorRoot = path.join(root, "node_modules/@novnc/novnc");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function matchesSecret(value, token) {
  const actual = Buffer.from(value || "");
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validSessionId(value) {
  return typeof value === "string" && /^(main|window-[0-9a-f]+)$/i.test(value);
}

function environment(primary, legacy) {
  return process.env[primary] || process.env[legacy];
}

const defaultViewerSettingsPath = path.join(
  homedir(),
  ".config/pengux11vnc/settings.json",
);
const legacyViewerSettingsPath = path.join(
  homedir(),
  ".config/qq-window-viewer/settings.json",
);
function normalizeViewerSettings(value = {}) {
  const vncScale = Number(value.vncScale);
  return {
    wheel: Math.max(5, Math.min(100, Number(value.wheel) || 25)),
    viewOnly: value.viewOnly === true,
    scale: value.scale === "actual" ? "actual" : "fit",
    vncScale:
      Number.isFinite(vncScale) && vncScale >= 0.05 && vncScale <= 1
        ? vncScale
        : null,
    bitrate: ["lossless", "high", "balanced", "low"].includes(value.bitrate)
      ? value.bitrate
      : "lossless",
    frameRate: [0, 5, 10, 15, 24, 30, 60].includes(Number(value.frameRate))
      ? Number(value.frameRate)
      : 30,
    clipboardSync:
      value.clipboardSync === true || value.clipboardImageSync === true,
    autoChildOpen: value.autoChildOpen !== false,
    systemTitlebar: value.systemTitlebar !== false,
    connectionMode:
      value.connectionMode === "video" || value.videoEnabled === true
        ? "video"
        : "vnc",
  };
}

async function migrateViewerSettingsPath(settingsPath) {
  if (settingsPath !== defaultViewerSettingsPath) return settingsPath;
  try {
    await stat(settingsPath);
    return settingsPath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await stat(legacyViewerSettingsPath);
    await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    await copyFile(legacyViewerSettingsPath, settingsPath);
    await chmod(settingsPath, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return settingsPath;
}

async function loadViewerSettings(settingsPath, profileId) {
  try {
    const document = JSON.parse(await readFile(settingsPath, "utf8"));
    const value = document?.profiles?.[profileId];
    return {
      settings: value ? normalizeViewerSettings(value) : null,
      updatedAt: Number(document?.updatedAt) || 0,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { settings: null, updatedAt: 0 };
    return { settings: null, updatedAt: 0 };
  }
}

function normalizeBubblePosition(value) {
  const left = Number(value?.left);
  const top = Number(value?.top);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    left < 0 ||
    top < 0 ||
    left > 100000 ||
    top > 100000
  )
    return null;
  return { left: Math.round(left), top: Math.round(top) };
}

async function saveViewerDocument(settingsPath, document) {
  await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(document, null, 2), {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, settingsPath);
}

async function saveViewerSettings(settingsPath, profileId, value) {
  let document = { version: 1, profiles: {} };
  try {
    const existing = JSON.parse(await readFile(settingsPath, "utf8"));
    if (existing && typeof existing === "object") document = existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!document.profiles || typeof document.profiles !== "object")
    document.profiles = {};
  document.version = 1;
  document.profiles[profileId] = normalizeViewerSettings(value);
  document.updatedAt = Date.now();
  await saveViewerDocument(settingsPath, document);
  return {
    settings: document.profiles[profileId],
    updatedAt: document.updatedAt,
  };
}

async function loadViewerLayout(settingsPath, profileId, sessionId) {
  try {
    const document = JSON.parse(await readFile(settingsPath, "utf8"));
    return {
      position: normalizeBubblePosition(
        document?.layouts?.[profileId]?.[sessionId],
      ),
      updatedAt: Number(document?.updatedAt) || 0,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { position: null, updatedAt: 0 };
    return { position: null, updatedAt: 0 };
  }
}

async function saveViewerLayout(settingsPath, profileId, sessionId, value) {
  const position = normalizeBubblePosition(value);
  if (!position) throw new Error("Invalid bubble position");
  let document = { version: 1, profiles: {}, layouts: {} };
  try {
    const existing = JSON.parse(await readFile(settingsPath, "utf8"));
    if (existing && typeof existing === "object") document = existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!document.layouts || typeof document.layouts !== "object")
    document.layouts = {};
  if (
    !document.layouts[profileId] ||
    typeof document.layouts[profileId] !== "object"
  )
    document.layouts[profileId] = {};
  document.version = 1;
  document.layouts[profileId][sessionId] = position;
  document.updatedAt = Date.now();
  await saveViewerDocument(settingsPath, document);
  return { position, updatedAt: document.updatedAt };
}

async function requestBody(req, limit = 64 * 1024) {
  const length = Number(req.headers["content-length"] || 0);
  if (!Number.isInteger(length) || length < 0 || length > limit)
    throw new Error("Invalid settings body");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limit)
      throw new Error("Settings body too large");
  }
  return body ? JSON.parse(body) : {};
}

// Standard VNC password files contain reversible DES obfuscation, not encryption.
// 3DES with three identical keys is equivalent to DES and works in modern Node.
export function decodePassword(data) {
  if (data.length !== 8 && data.length !== 16)
    throw new Error("Invalid VNC password file");
  // VNC's historical DES implementation reverses the bits in each key byte.
  const key = Buffer.from([232, 74, 214, 96, 196, 114, 26, 224]);
  const cipher = createDecipheriv(
    "des-ede3",
    Buffer.concat([key, key, key]),
    null,
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data.subarray(0, 8)), cipher.final()])
    .toString("latin1")
    .replace(/\0+$/, "");
}

function sshArgs(connection, forwards = [], noCommand = false) {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=6",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
  ];
  if (connection.ssh.privateKeyFile)
    args.push("-i", connection.ssh.privateKeyFile, "-o", "IdentitiesOnly=yes");
  args.push("-p", String(connection.ssh.port));
  for (const forward of forwards)
    args.push("-L", `${forward.local}:127.0.0.1:${forward.remote}`);
  if (noCommand) args.push("-N");
  args.push(`${connection.ssh.user}@${connection.ssh.host}`);
  return args;
}

async function runSsh(connection, command, timeout = 10000) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "ssh",
      [...sshArgs(connection), command],
      {
        timeout,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
    );
    if (stderr?.trim())
      debugLog("ssh-stderr", { text: stderr.trim().slice(0, 8000) });
    return stdout.trim();
  } catch (error) {
    if (error.stderr?.trim())
      debugLog("ssh-stderr-error", {
        text: error.stderr.trim().slice(0, 8000),
      });
    throw error;
  }
}

async function managerRequest(manager, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-PenguX11VNC-Token", manager.token);
  const response = await fetch(new URL(pathname, `${manager.url}/`), {
    ...options,
    headers,
  });
  debugLog("manager-response", { pathname, status: response.status });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Rust manager HTTP ${response.status}`);
  return data;
}

function waitForPort(port, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timer;
    const tryConnect = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started >= timeout) {
          clearTimeout(timer);
          reject(new Error(`Local forward ${port} did not open`));
        }
      });
    };
    timer = setInterval(tryConnect, 120);
    tryConnect();
  });
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function readVncPassword(passwordFile) {
  if (!passwordFile) return undefined;
  const info = await stat(passwordFile);
  if (!info.isFile()) throw new Error("Password file must be a regular file");
  if (
    typeof process.getuid === "function" &&
    (info.uid !== process.getuid() || info.mode & 0o077)
  )
    throw new Error("Password file must be owned by you and chmod 600");
  return decodePassword(await readFile(passwordFile));
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function startServer({
  port = 6088,
  targetPort,
  passwordFile,
  token = randomBytes(32).toString("base64url"),
  connection,
  imeCommand,
  imeEnabled = false,
  manager,
  settingsPath = environment(
    "PENGUX11VNC_SETTINGS_PATH",
    "QQ_VIEWER_SETTINGS_PATH",
  ) || defaultViewerSettingsPath,
} = {}) {
  settingsPath = await migrateViewerSettingsPath(settingsPath);
  let profile = normalizeConnection(
    connection || { vnc: { passwordFile: "" }, children: { enabled: false } },
    connection?.id || "runtime",
  );
  const mainPort = targetPort || profile.tunnel.localPort;
  const sockets = new Set();
  const sessions = new Map([
    [
      "main",
      {
        id: "main",
        kind: "main",
        title: profile.name,
        targetPort: mainPort,
        windowId: profile.window.id,
        lastSeen: Date.now(),
        viewerCount: 0,
        child: false,
      },
    ],
  ]);
  let origin;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  const rustManagerUrl = environment(
    "PENGUX11VNC_RUST_MANAGER_URL",
    "QQ_RUST_MANAGER_URL",
  );
  const rustManagerToken = environment(
    "PENGUX11VNC_RUST_MANAGER_TOKEN",
    "QQ_RUST_MANAGER_TOKEN",
  );
  const rustManager =
    manager ||
    (rustManagerUrl && rustManagerToken
      ? { url: rustManagerUrl, token: rustManagerToken }
      : undefined);
  const canManageRemoteWindows =
    Boolean(rustManager) || (Boolean(connection) && profile.children.enabled);
  const childProcesses = new Map();
  // Session-only VNC credential cache. Never persist or log this value.
  let cachedVncPassword;

  function validRequest(req) {
    return (
      req.headers.host === new URL(origin).host &&
      (!req.headers.origin || req.headers.origin === origin)
    );
  }
  function authorized(req, url) {
    return matchesSecret(
      req.headers["x-pengux11vnc-token"] ||
        req.headers["x-qq-token"] ||
        url.searchParams.get("token"),
      token,
    );
  }
  function getSession(id = "main") {
    if (!validSessionId(id)) return undefined;
    const session = sessions.get(id);
    if (session) session.lastSeen = Date.now();
    return session;
  }
  function publicSession(session) {
    return {
      id: session.id,
      kind: session.kind,
      title: session.title,
      windowId: session.windowId,
      child: session.child === true,
    };
  }
  function reply(res, code, body, type = "text/plain") {
    res.writeHead(code, {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  async function listRemoteWindows() {
    if (!canManageRemoteWindows) return [];
    if (rustManager) {
      const windows = (await managerRequest(rustManager, "/windows")).windows;
      debugLog("windows-discovered", {
        count: windows?.length || 0,
        windows: (windows || []).map(
          ({ id, mapped, width, height, x, y, depth }) => ({
            id,
            mapped,
            width,
            height,
            x,
            y,
            depth,
          }),
        ),
      });
      return windows;
    }
    const env = `env DISPLAY=${shellQuote(profile.window.display)} XAUTHORITY=${shellQuote(profile.window.xauthority)}`;
    const command = `${debugEnabled ? "PENGUX11VNC_DEBUG_WINDOWS=1 " : ""}${env} ${shellQuote(profile.helpers.windowList)} ${shellQuote(profile.window.id)} ${shellQuote(profile.window.className)}`;
    const output = await runSsh(profile, command, 7000);
    const windows = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (item) =>
          /^0x[0-9a-f]+$/i.test(item.id) &&
          item.id.toLowerCase() !== profile.window.id.toLowerCase() &&
          Number(item.width) >= profile.children.minWidth &&
          Number(item.height) >= profile.children.minHeight,
      );
    debugLog("windows-discovered", {
      count: windows.length,
      windows: windows.map(({ id, mapped, width, height, x, y, depth }) => ({
        id,
        mapped,
        width,
        height,
        x,
        y,
        depth,
      })),
    });
    return windows;
  }

  async function streamWindowWatch(req, res) {
    if (rustManager) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      try {
        const headers = new Headers({
          "X-PenguX11VNC-Token": rustManager.token,
        });
        const response = await fetch(
          new URL("/windows/watch", `${rustManager.url}/`),
          { headers, signal: controller.signal },
        );
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          return json(res, response.status, error);
        }
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        await pipeline(Readable.fromWeb(response.body), res);
      } catch (error) {
        if (!res.headersSent)
          json(res, 502, {
            error: error.message || "window-watch-unavailable",
          });
        else if (!res.destroyed) res.destroy();
      } finally {
        res.off("close", abort);
        controller.abort();
      }
      return;
    }

    const [bootstrap, source] = await Promise.all([
      readFile(path.join(root, "tools/remote-session-bootstrap.py"), "utf8"),
      readFile(path.join(root, "tools/remote-session.py"), "utf8"),
    ]);
    const options = {
      display: profile.window.display,
      xauthority: profile.window.xauthority,
      mainWindow: profile.window.id,
      className: profile.window.className,
      minWidth: profile.children.minWidth,
      minHeight: profile.children.minHeight,
    };
    const command = `python3 -c ${shellQuote(bootstrap)} watch ${shellQuote(JSON.stringify(options))}`;
    const child = spawn("ssh", [...sshArgs(profile), command], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let childClosed = false;
    const stopChild = () => {
      if (!childClosed) child.kill();
    };
    res.once("close", stopChild);
    child.once("close", () => {
      childClosed = true;
      if (!res.writableEnded) res.end();
    });
    child.once("error", (error) => {
      childClosed = true;
      if (!res.headersSent)
        json(res, 502, { error: error.message || "window-watch-unavailable" });
      else if (!res.writableEnded) res.end();
    });
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    child.stdin.on("error", () => {});
    child.stdout.pipe(res);
    child.stdin.write(`${Buffer.byteLength(source)}\n${source}`);
  }

  async function findRemotePort() {
    const used = new Set(
      [...sessions.values()]
        .map((session) => session.remotePort)
        .filter(Boolean),
    );
    const candidates = [];
    for (let port = 5901; port < 5999; port++)
      if (!used.has(port)) candidates.push(port);
    const command = `for p in ${candidates.join(" ")}; do if ! ss -H -ltn | grep -q "[.:]$p "; then printf "%s" "$p"; exit 0; fi; done; exit 1`;
    return Number(await runSsh(profile, command, 7000));
  }

  async function startChildSession(windowInfo) {
    debugLog("child-open-request", {
      id: windowInfo.id,
      mapped: windowInfo.mapped,
      width: windowInfo.width,
      height: windowInfo.height,
    });
    const existing = [...sessions.values()].find(
      (session) =>
        session.windowId.toLowerCase() === windowInfo.id.toLowerCase(),
    );
    if (existing && !rustManager) return existing;
    if (rustManager) {
      const data = await managerRequest(
        rustManager,
        `/windows/${encodeURIComponent(windowInfo.id)}/open`,
        { method: "POST" },
      );
      const child = data.session;
      if (existing) {
        Object.assign(existing, {
          targetPort: child.targetPort,
          localPort: child.localPort,
          remotePort: child.remotePort,
          geometry: child.geometry,
          lastSeen: Date.now(),
        });
        return existing;
      }
      const session = {
        kind: "child",
        ...child,
        targetPort: child.targetPort,
        localPort: child.localPort,
        remotePort: child.remotePort,
        lastSeen: Date.now(),
        viewerCount: 0,
      };
      sessions.set(session.id, session);
      childProcesses.set(session.id, session);
      return session;
    }
    const sessionId = `window-${windowInfo.id.slice(2).toLowerCase()}`;
    const remotePort = await findRemotePort();
    const localPort = await allocatePort();
    const logPath = `/tmp/pengux11vnc-${windowInfo.id.slice(2).toLowerCase()}.log`;
    const env = `env DISPLAY=${shellQuote(profile.window.display)} XAUTHORITY=${shellQuote(profile.window.xauthority)}`;
    const args = [
      "nohup",
      "x11vnc",
      "-display",
      profile.window.display,
      "-auth",
      profile.window.xauthority,
      "-id",
      windowInfo.id,
      "-localhost",
      "-rfbport",
      String(remotePort),
      "-forever",
      "-shared",
      "-noxdamage",
      "-noshm",
      "-rfbauth",
      profile.vnc.remotePasswordFile,
      "-rfbversion",
      "3.3",
      "-xwarppointer",
      "-o",
      logPath,
    ];
    const command = `${env} ${args.map(shellQuote).join(" ")} >/dev/null 2>&1 </dev/null & echo $!`;
    const remotePid = Number(await runSsh(profile, command, 7000));
    if (!Number.isInteger(remotePid) || remotePid < 1)
      throw new Error("Remote child VNC did not start");
    const tunnel = spawn(
      "ssh",
      sshArgs(profile, [{ local: localPort, remote: remotePort }], true),
      {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      },
    );
    try {
      await waitForPort(localPort);
    } catch (error) {
      tunnel.kill("SIGTERM");
      await runSsh(profile, `kill ${remotePid}`, 5000).catch(() => {});
      throw error;
    }
    const session = {
      id: sessionId,
      kind: "child",
      child: true,
      title: `QQ 子窗口 · ${windowInfo.id}`,
      targetPort: localPort,
      localPort,
      remotePort,
      remotePid,
      tunnel,
      windowId: windowInfo.id,
      geometry: windowInfo,
      lastSeen: Date.now(),
      viewerCount: 0,
    };
    sessions.set(sessionId, session);
    childProcesses.set(sessionId, session);
    tunnel.once("exit", () => {
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      childProcesses.delete(sessionId);
    });
    return session;
  }

  function scheduleUnviewedCleanup(session) {
    if (!session || session.id === "main" || session.viewerCount > 0) return;
    clearTimeout(session.viewerCleanupTimer);
    const lastSeen = session.lastSeen;
    const delay = session.reconnectGrace ? 3000 : 250;
    session.reconnectGrace = false;
    session.reconnectGraceUntil = delay > 250 ? Date.now() + delay : 0;
    session.viewerCleanupTimer = setTimeout(() => {
      if (session.viewerCount !== 0 || !childProcesses.has(session.id)) return;
      if (session.lastSeen !== lastSeen) {
        scheduleUnviewedCleanup(session);
        return;
      }
      void cleanupSession(session);
    }, delay);
    session.viewerCleanupTimer.unref?.();
  }
  async function cleanupSession(session) {
    if (!session || session.id === "main" || !childProcesses.has(session.id))
      return;
    debugLog("session-cleanup", {
      id: session.id,
      windowId: session.windowId,
      remotePid: session.remotePid,
      remotePort: session.remotePort,
      viewerCount: session.viewerCount,
    });
    clearTimeout(session.viewerCleanupTimer);
    session.reconnectGraceUntil = 0;
    sessions.delete(session.id);
    childProcesses.delete(session.id);
    if (rustManager) {
      await managerRequest(rustManager, `/sessions/${session.id}`, {
        method: "DELETE",
      }).catch(() => {});
      return;
    }
    if (session.windowId) {
      const closeWindow = `if command -v xdotool >/dev/null 2>&1; then xdotool windowclose --sync ${shellQuote(session.windowId)}; elif command -v wmctrl >/dev/null 2>&1; then wmctrl -ic ${shellQuote(session.windowId)}; fi`;
      const env = `env DISPLAY=${shellQuote(profile.window.display)} XAUTHORITY=${shellQuote(profile.window.xauthority)}`;
      await runSsh(
        profile,
        `${env} sh -c ${shellQuote(closeWindow)}`,
        5000,
      ).catch(() => {});
    }
    if (session.tunnel && !session.tunnel.killed)
      session.tunnel.kill("SIGTERM");
    if (session.remotePid)
      await runSsh(
        profile,
        `if [ -r /proc/${session.remotePid}/comm ] && [ "$(tr -d '\\n' </proc/${session.remotePid}/comm 2>/dev/null)" = x11vnc ]; then kill -TERM ${session.remotePid} 2>/dev/null || true; sleep 0.2; kill -KILL ${session.remotePid} 2>/dev/null || true; fi`,
        5000,
      ).catch(() => {});
  }
  const sessionSweep = setInterval(() => {
    const now = Date.now();
    const cutoff = now - 3000;
    for (const session of childProcesses.values()) {
      if (
        session.lastSeen < cutoff &&
        !(session.reconnectGraceUntil && session.reconnectGraceUntil > now)
      )
        void cleanupSession(session);
    }
  }, 500);
  sessionSweep.unref?.();

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    if (!validRequest(req)) return reply(res, 403, "Forbidden");
    if (
      req.method !== "GET" &&
      req.method !== "POST" &&
      req.method !== "PUT" &&
      req.method !== "DELETE"
    )
      return reply(res, 405, "Method not allowed");
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      return reply(res, 400, "Bad URL");
    }
    try {
      const sessionId = url.searchParams.get("session") || "main";
      if (url.pathname.startsWith("/api/") && !authorized(req, url))
        return reply(res, 403, "Forbidden");
      if (url.pathname === "/api/setup" && req.method === "GET") {
        if (sessionId !== "main") return json(res, 403, { error: "main-only" });
        return json(
          res,
          200,
          rustManager
            ? await managerRequest(rustManager, "/setup")
            : { available: false, configured: true },
        );
      }
      if (
        [
          "/api/setup/preflight",
          "/api/setup/save",
          "/api/main/prepare",
          "/api/main/poll",
          "/api/main/stop",
        ].includes(url.pathname)
      ) {
        if (sessionId !== "main") return json(res, 403, { error: "main-only" });
        if (req.method !== "POST")
          return json(res, 405, { error: "method-not-allowed" });
        if (!rustManager) return json(res, 404, { error: "requires-tauri" });
        if (
          url.pathname.startsWith("/api/setup/") &&
          [...wss.clients].some((ws) => ws.viewerSession)
        )
          return json(res, 409, { error: "请先断开连接，再修改连接配置" });
        const body = await requestBody(req, 32 * 1024);
        const data = await managerRequest(rustManager, url.pathname.slice(4), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (data.profile) {
          profile = normalizeConnection(data.profile, data.profile.id);
          passwordFile = undefined;
          if (url.pathname === "/api/setup/save") {
            cachedVncPassword = undefined;
            if (rustManager)
              await managerRequest(rustManager, "/credentials", {
                method: "DELETE",
              }).catch(() => {});
          }
        }
        const main = getSession("main");
        if (data.state === "ready") {
          const changed =
            main.targetPort !== data.targetPort ||
            main.windowId !== profile.window.id;
          if (changed) {
            for (const ws of wss.clients)
              ws.close(1000, "Window session changed");
            for (const id of childProcesses.keys()) sessions.delete(id);
            childProcesses.clear();
          }
          Object.assign(main, {
            targetPort: data.targetPort,
            windowId: profile.window.id,
            title: profile.name,
          });
        } else if (data.state || url.pathname === "/api/main/stop") {
          for (const ws of wss.clients)
            ws.close(1000, "Window session stopped");
          for (const id of childProcesses.keys()) sessions.delete(id);
          childProcesses.clear();
        }
        // Only the setup endpoint returns the editable private profile.
        if (!url.pathname.startsWith("/api/setup/")) delete data.profile;
        return json(res, 200, data);
      }
      const activateMatch = url.pathname.match(
        /^\/api\/sessions\/(main|window-[0-9a-f]+)\/activate$/i,
      );
      if (activateMatch && req.method === "POST") {
        const id = activateMatch[1];
        const session = getSession(id);
        if (!session) return json(res, 404, { error: "session-not-found" });
        if (!rustManager)
          return json(res, 501, { error: "requires-managed-session" });
        const result = await managerRequest(
          rustManager,
          `/sessions/${encodeURIComponent(id)}/activate`,
          { method: "POST" },
        );
        return json(res, 200, result);
      }
      const videoOfferMatch = url.pathname.match(
        /^\/api\/video\/(main|window-[0-9a-f]+)\/offer$/i,
      );
      if (videoOfferMatch && req.method === "POST") {
        const id = videoOfferMatch[1];
        const session = getSession(id);
        if (!session) return json(res, 404, { error: "session-not-found" });
        if (!rustManager)
          return json(res, 501, { error: "requires-managed-session" });
        const body = await requestBody(req, 256 * 1024);
        const result = await managerRequest(
          rustManager,
          `/video/${encodeURIComponent(id)}/offer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        return json(res, 200, result);
      }
      const videoStopMatch = url.pathname.match(
        /^\/api\/video\/(main|window-[0-9a-f]+)$/i,
      );
      if (videoStopMatch && req.method === "DELETE") {
        const id = videoStopMatch[1];
        if (rustManager)
          await managerRequest(
            rustManager,
            `/video/${encodeURIComponent(id)}`,
            { method: "DELETE" },
          );
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/status") {
        const session = getSession(sessionId);
        return session
          ? json(res, 200, {
              app: "PenguX11VNC",
              version: "0.2.0",
              profile: profile.id,
              session: publicSession(session),
              clipboardSync: profile.clipboard.sync,
            })
          : json(res, 404, { error: "session-not-found" });
      }
      if (url.pathname === "/api/credentials/cache") {
        const session = getSession(sessionId);
        if (!session) return json(res, 404, { error: "session-not-found" });
        if (req.method === "DELETE") {
          cachedVncPassword = undefined;
          if (rustManager)
            await managerRequest(rustManager, "/credentials", {
              method: "DELETE",
            }).catch(() => {});
          return json(res, 200, { ok: true });
        }
        if (req.method !== "POST")
          return json(res, 405, { error: "method-not-allowed" });
        const body = await requestBody(req, 4096);
        const password = body.password;
        if (
          typeof password !== "string" ||
          !password ||
          password.includes("\0") ||
          Buffer.byteLength(password, "utf8") > 128
        )
          return json(res, 400, { error: "invalid-vnc-password" });
        cachedVncPassword = password;
        let persisted = false;
        if (rustManager) {
          try {
            const result = await managerRequest(rustManager, "/credentials", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                password,
                persist: body.persist !== false,
              }),
            });
            persisted = result.persisted === true;
          } catch {
            // The memory cache still serves this run if the OS vault is unavailable.
          }
        }
        return json(res, 200, { ok: true, persisted });
      }
      if (url.pathname === "/api/credentials") {
        const session = getSession(sessionId);
        if (!session) return json(res, 404, { error: "session-not-found" });
        let password;
        if (passwordFile || profile.vnc.passwordFile)
          password = await readVncPassword(
            passwordFile || profile.vnc.passwordFile,
          );
        if (
          password === undefined &&
          cachedVncPassword === undefined &&
          rustManager
        ) {
          try {
            const stored = await managerRequest(rustManager, "/credentials");
            if (typeof stored.password === "string" && stored.password)
              cachedVncPassword = stored.password;
          } catch {
            // No OS credential is available; prompt once for this run.
          }
        }
        if (password === undefined) password = cachedVncPassword;
        return json(res, 200, password === undefined ? {} : { password });
      }
      if (url.pathname === "/api/debug" && req.method === "POST") {
        if (!debugEnabled) return json(res, 404, { error: "debug-disabled" });
        const body = await requestBody(req, 8192);
        debugLog("frontend", {
          session: sessionId,
          event:
            typeof body.event === "string"
              ? body.event.slice(0, 80)
              : "unknown",
          details:
            body.details && typeof body.details === "object"
              ? body.details
              : {},
        });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/session") {
        const session = getSession(sessionId);
        return session
          ? json(res, 200, {
              session: publicSession(session),
              debug: debugEnabled,
              setupAvailable: Boolean(rustManager),
              profile: {
                id: profile.id,
                name: profile.name,
                clipboardSync: profile.clipboard.sync,
                viewer: profile.viewer,
              },
            })
          : json(res, 404, { error: "session-not-found" });
      }
      if (url.pathname === "/api/settings") {
        const session = getSession(sessionId);
        if (!session) return json(res, 404, { error: "session-not-found" });
        if (req.method === "GET") {
          const saved = await loadViewerSettings(settingsPath, profile.id);
          return json(res, 200, saved);
        }
        if (sessionId !== "main")
          return json(res, 403, { error: "settings-owned-by-main" });
        if (req.method !== "PUT" && req.method !== "POST")
          return json(res, 405, { error: "method-not-allowed" });
        const body = await requestBody(req);
        const saved = await saveViewerSettings(
          settingsPath,
          profile.id,
          body.settings || body,
        );
        debugLog("settings-saved", {
          profile: profile.id,
          vncScale: saved.settings.vncScale,
          scale: saved.settings.scale,
        });
        return json(res, 200, saved);
      }
      if (url.pathname === "/api/layout") {
        const session = getSession(sessionId);
        if (!session) return json(res, 404, { error: "session-not-found" });
        if (req.method === "GET")
          return json(
            res,
            200,
            await loadViewerLayout(settingsPath, profile.id, sessionId),
          );
        if (req.method !== "PUT")
          return json(res, 405, { error: "method-not-allowed" });
        const body = await requestBody(req);
        return json(
          res,
          200,
          await saveViewerLayout(
            settingsPath,
            profile.id,
            sessionId,
            body.position,
          ),
        );
      }
      if (url.pathname === "/api/windows/watch" && req.method === "GET") {
        if (sessionId !== "main")
          return json(res, 400, { error: "children-only-from-main" });
        if (!canManageRemoteWindows)
          return json(res, 503, { error: "window-watch-unavailable" });
        await streamWindowWatch(req, res);
        return;
      }
      if (url.pathname === "/api/windows" && req.method === "GET") {
        if (sessionId !== "main")
          return json(res, 400, { error: "children-only-from-main" });
        const windows = await listRemoteWindows();
        return json(res, 200, { windows });
      }
      const openMatch = url.pathname.match(
        /^\/api\/windows\/(0x[0-9a-f]+)\/open$/i,
      );
      if (openMatch && req.method === "POST") {
        if (sessionId !== "main")
          return json(res, 400, { error: "children-only-from-main" });
        const windows = await listRemoteWindows();
        const info = windows.find(
          (item) => item.id.toLowerCase() === openMatch[1].toLowerCase(),
        );
        if (!info) return json(res, 404, { error: "window-not-found" });
        if (info.mapped !== true)
          return json(res, 409, { error: "window-not-visible" });
        const child = await startChildSession(info);
        return json(res, 200, {
          url: `/?session=${encodeURIComponent(child.id)}#token=${token}`,
          session: publicSession(child),
        });
      }
      const closeMatch = url.pathname.match(
        /^\/api\/sessions\/(main|window-[0-9a-f]+)$/i,
      );
      if (closeMatch && req.method === "DELETE") {
        const session = getSession(closeMatch[1]);
        if (session && session.id !== "main") await cleanupSession(session);
        return json(res, 200, { ok: true });
      }
      const pathname = decodeURIComponent(url.pathname);
      const vendor = pathname.startsWith("/vendor/");
      const base = vendor ? vendorRoot : publicRoot;
      const relative = vendor
        ? pathname.slice(8)
        : pathname === "/"
          ? "index.html"
          : pathname.slice(1);
      if (vendor && !/^(core|vendor)\/.+\.js$/.test(relative))
        return reply(res, 404, "Not found");
      const candidate = path.resolve(base, relative);
      const resolved = await realpath(candidate);
      if (
        !resolved.startsWith(`${base}${path.sep}`) ||
        !types[path.extname(resolved)]
      )
        return reply(res, 404, "Not found");
      return reply(
        res,
        200,
        await readFile(resolved),
        types[path.extname(resolved)],
      );
    } catch (error) {
      if (url?.pathname.startsWith("/api/"))
        return json(res, 503, { error: "unavailable", detail: error.message });
      return reply(res, 404, "Unavailable");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      socket.destroy();
      return;
    }
    const session = getSession(url.searchParams.get("session") || "main");
    if (
      !validRequest(req) ||
      req.headers.origin !== origin ||
      !["/vnc", "/ime"].includes(url.pathname) ||
      !authorized(req, url) ||
      !session
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname === "/ime") {
      if (session.id !== "main" || !imeEnabled) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        startImeBridge(ws, rustManager || imeCommand || imeCommandFor(profile)),
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.viewerSession = session.id;
      clearTimeout(session.viewerCleanupTimer);
      session.reconnectGrace = false;
      session.reconnectGraceUntil = 0;
      session.viewerCount = (session.viewerCount || 0) + 1;
      session.lastSeen = Date.now();
      let released = false;
      const releaseViewer = (code) => {
        if (released) return;
        released = true;
        session.viewerCount = Math.max(0, (session.viewerCount || 1) - 1);
        if (code !== 1000 && code !== 1001 && code !== 1005)
          session.reconnectGrace = true;
        debugLog("viewer-close", {
          session: session.id,
          code,
          viewerCount: session.viewerCount,
          reconnectGrace: session.reconnectGrace === true,
        });
        scheduleUnviewedCleanup(session);
      };
      ws.once("close", releaseViewer);
      const upstream = net.createConnection({
        host: "127.0.0.1",
        port: session.targetPort,
      });
      const stream = createWebSocketStream(ws);
      upstream.setNoDelay(true);
      upstream.setTimeout(8000, () =>
        upstream.destroy(new Error("Connect timeout")),
      );
      upstream.once("connect", () => upstream.setTimeout(0));
      upstream.pipe(stream).pipe(upstream);
      upstream.on("error", (error) => {
        debugLog("vnc-upstream-error", {
          session: session.id,
          message: error.message,
        });
        ws.close(1011, "VNC tunnel unavailable");
      });
      stream.on("error", (error) => {
        debugLog("vnc-stream-error", {
          session: session.id,
          message: error.message,
        });
        upstream.destroy();
      });
      ws.on("close", () => upstream.destroy());
      upstream.on("close", () => {
        debugLog("vnc-upstream-close", {
          session: session.id,
          websocketState: ws.readyState,
        });
        if (ws.readyState === 1) ws.close(1011, "VNC tunnel closed");
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    token,
    url: `${origin}/#token=${token}`,
    async close() {
      clearInterval(sessionSweep);
      for (const session of childProcesses.values())
        await cleanupSession(session);
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      cachedVncPassword = undefined;
      await new Promise((resolve) => server.close(resolve));
      wss.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const connectionJson = environment(
    "PENGUX11VNC_CONNECTION_JSON",
    "QQ_CONNECTION_JSON",
  );
  const managerUrl = environment(
    "PENGUX11VNC_RUST_MANAGER_URL",
    "QQ_RUST_MANAGER_URL",
  );
  const managerToken = environment(
    "PENGUX11VNC_RUST_MANAGER_TOKEN",
    "QQ_RUST_MANAGER_TOKEN",
  );
  const connection = connectionJson
    ? connectionFromJson(connectionJson)
    : undefined;
  const app = await startServer({
    port: Number(environment("PENGUX11VNC_PORT", "QQ_VIEWER_PORT") || 6088),
    targetPort:
      Number(environment("PENGUX11VNC_VNC_PORT", "QQ_VNC_PORT") || 0) ||
      undefined,
    passwordFile:
      environment("PENGUX11VNC_VNC_PASSWORD_FILE", "QQ_VNC_PASSWORD_FILE") ||
      undefined,
    connection,
    imeEnabled:
      environment("PENGUX11VNC_IME_ENABLED", "QQ_IME_ENABLED") === "1",
    manager:
      managerUrl && managerToken
        ? { url: managerUrl, token: managerToken }
        : undefined,
  });
  console.log(app.url);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.close();
    });
}
