import http from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual, createDecipheriv } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import {
  chmod,
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

const defaultViewerSettingsPath = path.join(
  homedir(),
  ".config/qq-window-viewer/settings.json",
);
function normalizeViewerSettings(value = {}) {
  return {
    wheel: Math.max(5, Math.min(100, Number(value.wheel) || 25)),
    viewOnly: value.viewOnly === true,
    scale: value.scale === "actual" ? "actual" : "fit",
    bitrate: ["lossless", "high", "balanced", "low"].includes(value.bitrate)
      ? value.bitrate
      : "lossless",
    frameRate: [0, 5, 10, 15, 24, 30, 60].includes(Number(value.frameRate))
      ? Number(value.frameRate)
      : 30,
    clipboardSync: value.clipboardSync === true,
    autoChildOpen: value.autoChildOpen !== false,
    uiCollapsed: value.uiCollapsed === true,
  };
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
  await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(document, null, 2), {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, settingsPath);
  return {
    settings: document.profiles[profileId],
    updatedAt: document.updatedAt,
  };
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
  const { stdout } = await execFileAsync(
    "ssh",
    [...sshArgs(connection), command],
    {
      timeout,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    },
  );
  return stdout.trim();
}

async function managerRequest(manager, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-PenguX11VNC-Token", manager.token);
  const response = await fetch(new URL(pathname, `${manager.url}/`), {
    ...options,
    headers,
  });
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
  if (info.uid !== process.getuid() || info.mode & 0o077 || !info.isFile())
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
  settingsPath = process.env.QQ_VIEWER_SETTINGS_PATH ||
    defaultViewerSettingsPath,
} = {}) {
  const profile = normalizeConnection(
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
  const rustManager =
    manager ||
    (process.env.QQ_RUST_MANAGER_URL && process.env.QQ_RUST_MANAGER_TOKEN
      ? {
          url: process.env.QQ_RUST_MANAGER_URL,
          token: process.env.QQ_RUST_MANAGER_TOKEN,
        }
      : undefined);
  const canManageRemoteWindows =
    Boolean(rustManager) || (Boolean(connection) && profile.children.enabled);
  const childProcesses = new Map();

  function validRequest(req) {
    return (
      req.headers.host === new URL(origin).host &&
      (!req.headers.origin || req.headers.origin === origin)
    );
  }
  function authorized(req, url) {
    return matchesSecret(
      req.headers["x-qq-token"] || url.searchParams.get("token"),
      token,
    );
  }
  function getSession(id = "main") {
    if (!validSessionId(id)) return undefined;
    return sessions.get(id);
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
    if (rustManager)
      return (await managerRequest(rustManager, "/windows")).windows;
    const env = `env DISPLAY=${shellQuote(profile.window.display)} XAUTHORITY=${shellQuote(profile.window.xauthority)}`;
    const command = `${env} ${shellQuote(profile.helpers.windowList)} ${shellQuote(profile.window.id)} ${shellQuote(profile.window.className)}`;
    const output = await runSsh(profile, command, 7000);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (item) =>
          /^0x[0-9a-f]+$/i.test(item.id) &&
          item.id.toLowerCase() !== profile.window.id.toLowerCase() &&
          item.mapped === true &&
          Number(item.width) >= profile.children.minWidth &&
          Number(item.height) >= profile.children.minHeight,
      );
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
    const existing = [...sessions.values()].find(
      (session) =>
        session.windowId.toLowerCase() === windowInfo.id.toLowerCase(),
    );
    if (existing) return existing;
    if (rustManager) {
      const data = await managerRequest(
        rustManager,
        `/windows/${encodeURIComponent(windowInfo.id)}/open`,
        { method: "POST" },
      );
      const child = data.session;
      const session = {
        kind: "child",
        ...child,
        targetPort: child.targetPort,
        localPort: child.localPort,
        remotePort: child.remotePort,
        lastSeen: Date.now(),
      };
      sessions.set(session.id, session);
      childProcesses.set(session.id, session);
      return session;
    }
    const sessionId = `window-${windowInfo.id.slice(2).toLowerCase()}`;
    const remotePort = await findRemotePort();
    const localPort = await allocatePort();
    const logPath = `/tmp/qq-window-viewer-${windowInfo.id.slice(2).toLowerCase()}.log`;
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
    };
    sessions.set(sessionId, session);
    childProcesses.set(sessionId, session);
    tunnel.once("exit", () => {
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      childProcesses.delete(sessionId);
    });
    return session;
  }

  async function cleanupSession(session) {
    if (!session || session.id === "main") return;
    sessions.delete(session.id);
    childProcesses.delete(session.id);
    if (rustManager) {
      await managerRequest(rustManager, `/sessions/${session.id}`, {
        method: "DELETE",
      }).catch(() => {});
      return;
    }
    if (session.tunnel && !session.tunnel.killed)
      session.tunnel.kill("SIGTERM");
    if (session.remotePid)
      await runSsh(profile, `kill ${session.remotePid}`, 5000).catch(() => {});
  }

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
      if (url.pathname === "/api/status") {
        const session = getSession(sessionId);
        return session
          ? json(res, 200, {
              app: "PenguX11VNC",
              version: "0.1.0",
              profile: profile.id,
              session: publicSession(session),
              clipboardSync: profile.clipboard.sync,
            })
          : json(res, 404, { error: "session-not-found" });
      }
      if (url.pathname === "/api/credentials") {
        const session = getSession(sessionId);
        if (!session) return json(res, 404, { error: "session-not-found" });
        let password;
        if (passwordFile || profile.vnc.passwordFile)
          password = await readVncPassword(
            passwordFile || profile.vnc.passwordFile,
          );
        return json(res, 200, password === undefined ? {} : { password });
      }
      if (url.pathname === "/api/session") {
        const session = getSession(sessionId);
        return session
          ? json(res, 200, {
              session: publicSession(session),
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
        return json(res, 200, saved);
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
      session.lastSeen = Date.now();
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
      upstream.on("error", () => ws.close(1011, "VNC tunnel unavailable"));
      stream.on("error", () => upstream.destroy());
      ws.on("close", () => upstream.destroy());
      upstream.on("close", () => ws.close());
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
      for (const session of childProcesses.values())
        await cleanupSession(session);
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      wss.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const connection = process.env.QQ_CONNECTION_JSON
    ? connectionFromJson(process.env.QQ_CONNECTION_JSON)
    : undefined;
  const app = await startServer({
    port: Number(process.env.QQ_VIEWER_PORT || 6088),
    targetPort: Number(process.env.QQ_VNC_PORT || 0) || undefined,
    passwordFile: process.env.QQ_VNC_PASSWORD_FILE || undefined,
    connection,
    imeEnabled: process.env.QQ_IME_ENABLED === "1",
    manager:
      process.env.QQ_RUST_MANAGER_URL && process.env.QQ_RUST_MANAGER_TOKEN
        ? {
            url: process.env.QQ_RUST_MANAGER_URL,
            token: process.env.QQ_RUST_MANAGER_TOKEN,
          }
        : undefined,
  });
  console.log(app.url);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.close();
    });
}
