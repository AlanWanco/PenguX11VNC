import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const defaultConfigPath = path.join(
  homedir(),
  ".config/pengux11vnc/connections.json",
);
export const legacyConfigPath = path.join(
  homedir(),
  ".config/qq-window-viewer/connections.json",
);

// Safe fallback for installations that have not created their private config yet.
// A real connection should always be supplied through connections.json.
const legacyConnection = {
  id: "remote-qq",
  name: "Remote QQ",
  ssh: {
    user: "remote-user",
    host: "remote.example",
    port: 22,
    privateKeyFile: "",
  },
  tunnel: { localPort: 15900, remoteHost: "127.0.0.1", remotePort: 5900 },
  vnc: {
    passwordFile: "",
    remotePasswordFile: "/run/user/1000/x11vnc.pass",
  },
  window: {
    display: ":0",
    xauthority: "/run/user/1000/xauth",
    id: "0x1",
    className: "QQ",
  },
  helpers: {
    windowList: "/home/remote-user/.local/lib/pengux11vnc/list-qq-windows",
    imeCapture: "/home/remote-user/.local/lib/pengux11vnc/capture-ime",
  },
  children: { enabled: true, autoOpen: true, minWidth: 80, minHeight: 60 },
  clipboard: { sync: false },
  viewer: {
    wheel: 25,
    bitrate: "lossless",
    frameRate: 30,
    clipboardSync: false,
    autoChildOpen: true,
    systemTitlebar: true,
  },
};

function expand(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}
function text(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function port(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error(`Invalid port: ${value}`);
  return number;
}
function host(value, fallback) {
  const result = text(value, fallback);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result))
    throw new Error(`Invalid host: ${result}`);
  return result;
}
function safeRemotePath(value, fallback) {
  const result = text(value, fallback);
  if (!/^[/~][A-Za-z0-9_./:-]*$/.test(result))
    throw new Error(`Invalid remote path: ${result}`);
  return result;
}
function windowId(value, fallback) {
  const result = text(value, fallback);
  if (!/^0x[0-9a-f]+$/i.test(result))
    throw new Error(`Invalid X11 window id: ${result}`);
  return result;
}

export function normalizeConnection(raw = {}, id = "connection") {
  const source = { ...legacyConnection, ...raw };
  const ssh = { ...legacyConnection.ssh, ...(raw.ssh || {}) };
  const tunnel = { ...legacyConnection.tunnel, ...(raw.tunnel || {}) };
  const vnc = { ...legacyConnection.vnc, ...(raw.vnc || {}) };
  const window = { ...legacyConnection.window, ...(raw.window || {}) };
  const helpers = { ...legacyConnection.helpers, ...(raw.helpers || {}) };
  const children = { ...legacyConnection.children, ...(raw.children || {}) };
  const clipboard = { ...legacyConnection.clipboard, ...(raw.clipboard || {}) };
  const viewer = { ...legacyConnection.viewer, ...(raw.viewer || {}) };
  if (!/^[A-Za-z0-9._-]+$/.test(id))
    throw new Error(`Invalid connection id: ${id}`);
  const user = text(ssh.user, legacyConnection.ssh.user);
  if (!/^[A-Za-z0-9._-]+$/.test(user))
    throw new Error(`Invalid SSH user: ${user}`);
  const sshHost = host(ssh.host, legacyConnection.ssh.host);
  const keyFile = ssh.privateKeyFile ? expand(ssh.privateKeyFile) : "";
  if (keyFile && (!path.isAbsolute(keyFile) || keyFile.includes("\0")))
    throw new Error("Invalid private key path");
  const remoteHost = host(tunnel.remoteHost, "127.0.0.1");
  const remotePasswordFile = safeRemotePath(
    vnc.remotePasswordFile,
    legacyConnection.vnc.remotePasswordFile,
  );
  return {
    id,
    name: text(source.name, id),
    ssh: {
      user,
      host: sshHost,
      port: port(ssh.port, 22),
      privateKeyFile: keyFile,
    },
    tunnel: {
      localPort: port(tunnel.localPort, 15900),
      remoteHost,
      remotePort: port(tunnel.remotePort, 5900),
    },
    vnc: {
      passwordFile: vnc.passwordFile ? expand(vnc.passwordFile) : "",
      remotePasswordFile,
    },
    window: {
      display: text(window.display, ":0"),
      xauthority: safeRemotePath(
        window.xauthority,
        legacyConnection.window.xauthority,
      ),
      id: windowId(window.id, legacyConnection.window.id),
      className: text(window.className, "QQ"),
    },
    helpers: {
      windowList: safeRemotePath(
        helpers.windowList,
        legacyConnection.helpers.windowList,
      ),
      imeCapture: safeRemotePath(
        helpers.imeCapture,
        legacyConnection.helpers.imeCapture,
      ),
    },
    children: {
      enabled: children.enabled !== false,
      autoOpen: children.autoOpen !== false,
      minWidth: Math.max(40, Math.min(4096, Number(children.minWidth) || 80)),
      minHeight: Math.max(40, Math.min(4096, Number(children.minHeight) || 60)),
    },
    clipboard: { sync: clipboard.sync === true },
    viewer: {
      wheel: Math.max(5, Math.min(100, Number(viewer.wheel) || 25)),
      bitrate: ["lossless", "high", "balanced", "low"].includes(viewer.bitrate)
        ? viewer.bitrate
        : "lossless",
      frameRate: [0, 5, 10, 15, 24, 30, 60].includes(Number(viewer.frameRate))
        ? Number(viewer.frameRate)
        : 30,
      clipboardSync: viewer.clipboardSync === true,
      autoChildOpen: viewer.autoChildOpen !== false,
      systemTitlebar: viewer.systemTitlebar !== false,
    },
  };
}

export async function loadConnection({
  configPath = defaultConfigPath,
  profile,
} = {}) {
  try {
    let target = expand(configPath);
    let raw;
    try {
      raw = JSON.parse(await readFile(target, "utf8"));
    } catch (error) {
      if (
        error.code !== "ENOENT" ||
        profile ||
        configPath !== defaultConfigPath
      )
        throw error;
      target = legacyConfigPath;
      raw = JSON.parse(await readFile(target, "utf8"));
    }
    const profiles = raw.connections || {};
    const selected =
      profile || raw.defaultConnection || Object.keys(profiles)[0];
    if (!selected || !profiles[selected])
      throw new Error(`Connection profile not found: ${selected}`);
    return normalizeConnection(profiles[selected], selected);
  } catch (error) {
    if (error.code === "ENOENT" && !profile && configPath === defaultConfigPath)
      return normalizeConnection(legacyConnection, legacyConnection.id);
    throw error;
  }
}

export function connectionFromJson(value) {
  const raw = JSON.parse(value);
  return normalizeConnection(raw, raw.id || "runtime");
}
