import QQRFB from "./qq-rfb.js";
import { ImeOverlay } from "./ime-overlay.js";

const $ = (id) => document.getElementById(id);
let rfb;
let connected = false;
let connecting = false;
let connectEpoch = 0;
let toastTimer;
let frameObserver;
let resizeObserver;
let imeOverlay;
let childTimer;
let childPollInFlight = false;
const childPollIntervalMs = 1000;
let clipboardTimer;
let clipboardPasteShortcutInFlight = false;
let replayingClipboardPasteShortcut = false;
let remoteFilePasteSignature;
let token;
let setupAvailable = false;
let connectionWanted = false;
let recoveryTimer;
let recoveryEpoch = 0;
let sessionReady;
const queryParameters = new URLSearchParams(location.search);
const sessionId = queryParameters.get("session") || "main";
const isMainSession = sessionId === "main";
const requestedTauriScale = (() => {
  const value = Number(queryParameters.get("vncScale"));
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
})();
let tauriVncScaleFactor = requestedTauriScale;
let preferredTauriScale = requestedTauriScale;
let inheritedTauriScale = requestedTauriScale;
let localClipboardValue;
let remoteClipboardValue;
let hasSavedSettings = false;
let settingsReady = false;
let settingsStamp = 0;
let settingsSaveTimer;
let settingsSyncTimer;
const SETTINGS_MAIN_KEY = "pengux11vnc-settings-main";
const SETTINGS_LEGACY_MAIN_KEY = "qq-viewer-settings-main";
const SETTINGS_LEGACY_KEY = "qq-viewer-settings";
const SESSION_TOKEN_KEY = "pengux11vnc-token";
const SESSION_LEGACY_TOKEN_KEY = "qq-viewer-token";
const defaultSettings = {
  wheel: 25,
  viewOnly: false,
  scale: "fit",
  bitrate: "lossless",
  frameRate: 30,
  clipboardSync: false,
  autoChildOpen: true,
  systemTitlebar: true,
};
let settings = { ...defaultSettings };
let settingsChannel;
try {
  settingsChannel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel("pengux11vnc-settings")
      : undefined;
} catch {
  settingsChannel = undefined;
}
function normalizeSettings(value = {}) {
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
    systemTitlebar: value.systemTitlebar !== false,
  };
}
try {
  const savedText =
    localStorage.getItem(SETTINGS_MAIN_KEY) ||
    localStorage.getItem(SETTINGS_LEGACY_MAIN_KEY) ||
    localStorage.getItem(SETTINGS_LEGACY_KEY) ||
    "";
  hasSavedSettings = Boolean(savedText);
  settings = normalizeSettings(JSON.parse(savedText || "{}"));
  if (savedText && !localStorage.getItem(SETTINGS_MAIN_KEY))
    localStorage.setItem(SETTINGS_MAIN_KEY, savedText);
  localStorage.removeItem(SETTINGS_LEGACY_MAIN_KEY);
  localStorage.removeItem(SETTINGS_LEGACY_KEY);
  const fragment = new URLSearchParams(location.hash.slice(1));
  token =
    fragment.get("token") ||
    sessionStorage.getItem(SESSION_TOKEN_KEY) ||
    sessionStorage.getItem(SESSION_LEGACY_TOKEN_KEY);
  if (token) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.removeItem(SESSION_LEGACY_TOKEN_KEY);
  }
} catch {
  token = new URLSearchParams(location.hash.slice(1)).get("token");
}
if (location.hash)
  history.replaceState(null, "", location.pathname + location.search);

function save() {
  if (!isMainSession || !settingsReady) return;
  const serialized = JSON.stringify(settings);
  try {
    localStorage.setItem(SETTINGS_MAIN_KEY, serialized);
  } catch {
    /* Storage is optional. */
  }
  settingsChannel?.postMessage({ settings, tauriScale: tauriVncScaleFactor });
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(async () => {
    try {
      const response = await api("/api/settings?session=main", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (response.ok) {
        const data = await response.json();
        settingsStamp = Number(data.updatedAt) || settingsStamp;
      }
    } catch {
      // localStorage and BroadcastChannel still keep this running session in sync.
    }
  }, 120);
}
if (settingsChannel) {
  settingsChannel.onmessage = (event) => {
    if (isMainSession) return;
    if (event.data?.settings) applySettings(event.data.settings);
    const scale = Number(event.data?.tauriScale);
    if (Number.isFinite(scale) && scale > 0 && scale <= 1) {
      inheritedTauriScale = scale;
      preferredTauriScale = scale;
      tauriVncResizeKey = undefined;
      if (connected) geometry(true);
    }
  };
}

function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 6000);
}
function state(label, value) {
  $("status").textContent = label;
  $("status-dot").dataset.state = value;
}
const bitrateLabels = {
  lossless: "无损",
  high: "高",
  balanced: "均衡",
  low: "低",
};
const frameRateLabels = {
  0: "不限",
  5: "5 FPS",
  10: "10 FPS",
  15: "15 FPS",
  24: "24 FPS",
  30: "30 FPS",
  60: "60 FPS",
};
function syncSettingsControls() {
  $("wheel").value = settings.wheel;
  $("wheel-value").textContent = `${settings.wheel}%`;
  $("view-only").checked = settings.viewOnly;
  $("clipboard-sync").checked = settings.clipboardSync;
  $("child-auto-open").checked = settings.autoChildOpen;
  $("system-titlebar").checked = settings.systemTitlebar;
  void applyTauriTitlebar(settings.systemTitlebar);
  if (rfb) rfb.wheelSensitivity = settings.wheel / 100;
  setBitrate(settings.bitrate, false);
  setFrameRate(settings.frameRate, false);
  scale(settings.scale, false);
}
function applySettings(value) {
  const previousClipboardSync = settings.clipboardSync;
  settings = normalizeSettings({ ...settings, ...value });
  syncSettingsControls();
  setInteractive();
  if (connected && previousClipboardSync !== settings.clipboardSync)
    startClipboardSync();
}
function setFrameRate(value, persist = true) {
  const frameRate = Number(value);
  settings.frameRate = Object.hasOwn(frameRateLabels, frameRate)
    ? frameRate
    : 30;
  $("frame-rate").value = String(settings.frameRate);
  $("frame-rate-value").textContent = frameRateLabels[settings.frameRate];
  if (rfb) rfb.frameRate = settings.frameRate;
  geometry();
  if (persist) save();
}
function setBitrate(mode, persist = true) {
  settings.bitrate = bitrateLabels[mode] ? mode : "lossless";
  $("bitrate").value = settings.bitrate;
  $("bitrate-value").textContent = bitrateLabels[settings.bitrate];
  $("transport-mode").textContent =
    settings.bitrate === "lossless"
      ? "无损 · ZRLE 优先"
      : `${bitrateLabels[settings.bitrate]} · JPEG/Tight`;
  if (rfb) rfb.bitrateMode = settings.bitrate;
  geometry();
  if (persist) save();
}
function scale(mode, persist = true) {
  const changed = settings.scale !== mode;
  settings.scale = mode;
  for (const id of ["fit", "actual"]) {
    $(id).classList.toggle("active", id === mode);
    $(id).setAttribute("aria-pressed", String(id === mode));
  }
  if (rfb) {
    rfb.resizeSession = false;
    rfb.scaleViewport = mode === "fit";
  }
  if (isTauriShell() && (persist || changed || mode === "actual")) {
    const inheritedChildScale =
      !isMainSession && !persist ? inheritedTauriScale : undefined;
    const forcedScale =
      inheritedChildScale ?? (mode === "actual" ? 1 : undefined);
    preferredTauriScale = forcedScale;
    tauriVncScaleFactor = forcedScale;
    tauriVncResizeKey = undefined;
  }
  if (persist) save();
  geometry(true);
}
let tauriDecorationsState;
let tauriVncResizeKey;
function setTitlebarExpanded(expanded, resize = true) {
  const enabled =
    Boolean(expanded) && document.body.classList.contains("no-system-titlebar");
  document.body.classList.toggle("titlebar-expanded", enabled);
  const toggle = $("titlebar-toggle");
  if (toggle) {
    toggle.dataset.expanded = String(enabled);
    toggle.title = enabled ? "收起工具栏" : "展开工具栏";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(enabled));
  }
  if (resize && connected) {
    // Expanding the custom titlebar changes only the available VNC viewport.
    // Keep the user's current native window size; do not rebuild it from the
    // original VNC scale factor.
    geometry(false);
    updateTauriAspectForCurrentSize();
  }
}
let tauriVncResizeInFlight = false;
function currentTauriWindow() {
  return globalThis.__TAURI__?.window?.getCurrentWindow?.();
}
function tauriInvoke(command, args) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function")
    return Promise.reject(new Error("Tauri 命令不可用"));
  return invoke(command, args);
}
function tauriLogicalSize(width, height) {
  const LogicalSize =
    globalThis.__TAURI__?.window?.LogicalSize ||
    globalThis.__TAURI__?.dpi?.LogicalSize;
  return typeof LogicalSize === "function"
    ? new LogicalSize(width, height)
    : { type: "Logical", width, height };
}
function updateTauriAspectForCurrentSize() {
  if (!isTauriShell() || !isMainSession || document.fullscreenElement) return;
  const width = Math.round(window.innerWidth);
  const height = Math.round(window.innerHeight);
  if (width <= 0 || height <= 0) return;
  void tauriInvoke("set_main_window_aspect", { width, height }).catch(
    (error) => {
      if (settingsReady)
        toast(`原生窗口比例锁定失败：${error?.message || error}`);
    },
  );
}
async function applyTauriTitlebar(decorated, notify = false) {
  const current = currentTauriWindow();
  const supported = isTauriShell() && Boolean(current?.setDecorations);
  document.body.classList.toggle("no-system-titlebar", supported && !decorated);
  setTitlebarExpanded(false, false);
  if (!supported) return true;
  if (tauriDecorationsState === decorated) return true;
  try {
    await current.setDecorations(decorated);
    tauriDecorationsState = decorated;
    tauriVncResizeKey = undefined;
    geometry(false);
    updateTauriAspectForCurrentSize();
    return true;
  } catch (error) {
    if (notify) toast(`系统标题栏设置失败：${error.message || "权限不足"}`);
    return false;
  }
}
async function resizeTauriWindowToVnc() {
  const canvas = $("screen").querySelector("canvas");
  const current = currentTauriWindow();
  if (
    !isTauriShell() ||
    !current?.setSize ||
    !canvas?.width ||
    !canvas.height ||
    document.fullscreenElement
  ) {
    document.body.classList.remove("tauri-vnc-frame");
    tauriVncResizeKey = undefined;
    if (isMainSession && isTauriShell())
      void tauriInvoke("set_main_window_aspect", { width: 0, height: 0 });
    return;
  }
  document.body.classList.add("tauri-vnc-frame");
  const screenRect = $("screen").getBoundingClientRect();
  const chromeWidth = Math.max(0, window.innerWidth - screenRect.width);
  const chromeHeight = Math.max(0, window.innerHeight - screenRect.height);
  const availableWidth = Math.max(
    320,
    (window.screen?.availWidth || window.innerWidth) - chromeWidth - 24,
  );
  const availableHeight = Math.max(
    240,
    (window.screen?.availHeight || window.innerHeight) - chromeHeight - 24,
  );
  const autoScaleFactor =
    settings.scale === "actual"
      ? 1
      : Math.min(
          1,
          availableWidth / canvas.width,
          availableHeight / canvas.height,
        );
  const scaleFactor =
    preferredTauriScale ?? tauriVncScaleFactor ?? autoScaleFactor;
  if (isMainSession) {
    const changed =
      tauriVncScaleFactor === undefined ||
      Math.abs(tauriVncScaleFactor - scaleFactor) > 0.001;
    tauriVncScaleFactor = scaleFactor;
    if (changed)
      settingsChannel?.postMessage({ tauriScale: tauriVncScaleFactor });
  }
  const width = Math.max(1, Math.round(canvas.width * scaleFactor));
  const height = Math.max(1, Math.round(canvas.height * scaleFactor));
  const innerWidth = Math.max(1, Math.round(width + chromeWidth));
  const innerHeight = Math.max(1, Math.round(height + chromeHeight));
  const key = `${canvas.width}x${canvas.height}:${innerWidth}x${innerHeight}:${settings.systemTitlebar}:${document.body.classList.contains("titlebar-expanded")}`;
  if (tauriVncResizeKey === key || tauriVncResizeInFlight) return;
  tauriVncResizeKey = key;
  tauriVncResizeInFlight = true;
  try {
    if (isMainSession)
      await tauriInvoke("set_main_window_aspect", {
        width: innerWidth,
        height: innerHeight,
      }).catch((error) => {
        if (settingsReady)
          toast(`原生窗口比例锁定失败：${error?.message || error}`);
      });
    await current.setSize(tauriLogicalSize(innerWidth, innerHeight));
  } catch (error) {
    tauriVncResizeKey = undefined;
    if (settingsReady)
      toast(`自动调整窗口失败：${error.message || "权限不足"}`);
  } finally {
    tauriVncResizeInFlight = false;
  }
}
function syncMainTauriScaleFromViewport(canvas) {
  if (!isTauriShell() || !isMainSession || !canvas?.width)
    return tauriVncScaleFactor;
  const canvasRect = canvas.getBoundingClientRect();
  const screenRect = $("screen").getBoundingClientRect();
  const displayedWidth = Math.min(canvasRect.width, screenRect.width);
  const displayedHeight = Math.min(canvasRect.height, screenRect.height);
  const scale = Math.min(
    displayedWidth / canvas.width,
    displayedHeight / canvas.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return tauriVncScaleFactor;
  const normalized = Math.min(1, scale);
  if (
    tauriVncScaleFactor !== undefined &&
    Math.abs(tauriVncScaleFactor - normalized) < 0.002
  )
    return tauriVncScaleFactor;
  tauriVncScaleFactor = normalized;
  settingsChannel?.postMessage({ tauriScale: normalized });
  return normalized;
}
function geometry(resizeWindow = false) {
  const canvas = $("screen").querySelector("canvas");
  if (!canvas?.width) return;
  const percent = Math.round(
    (canvas.getBoundingClientRect().width / canvas.width) * 100,
  );
  $("geometry").textContent =
    `${canvas.width} × ${canvas.height} · ${percent}% · ${bitrateLabels[settings.bitrate]} · ${frameRateLabels[settings.frameRate]}`;
  if (resizeWindow) void resizeTauriWindowToVnc();
  else syncMainTauriScaleFromViewport(canvas);
  imeOverlay?.position();
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-PenguX11VNC-Token", token || "");
  return fetch(path, { ...options, headers });
}
function credentialCachePath() {
  return `/api/credentials/cache?session=${encodeURIComponent(sessionId)}`;
}
async function cacheVncPassword(password) {
  const response = await api(credentialCachePath(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password,
      persist: $("password-remember").checked,
    }),
  });
  if (!response.ok) throw new Error("本次运行无法缓存 VNC 密码");
  return response.json().catch(() => ({}));
}
async function clearVncPasswordCache() {
  try {
    await api(credentialCachePath(), { method: "DELETE" });
  } catch {
    /* The cache is still cleared when the local server exits. */
  }
}

async function loadPersistentSettings() {
  try {
    const response = await api(
      `/api/settings?session=${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok) return false;
    const data = await response.json();
    settingsStamp = Number(data.updatedAt) || 0;
    if (!data.settings) return false;
    hasSavedSettings = true;
    applySettings(data.settings);
    return true;
  } catch {
    return false;
  }
}
function startInheritedSettingsSync() {
  if (isMainSession) return;
  clearTimeout(settingsSyncTimer);
  const tick = async () => {
    try {
      const response = await api(
        `/api/settings?session=${encodeURIComponent(sessionId)}`,
      );
      if (response.ok) {
        const data = await response.json();
        const stamp = Number(data.updatedAt) || 0;
        if (data.settings && stamp !== settingsStamp) {
          settingsStamp = stamp;
          applySettings(data.settings);
        }
      }
    } catch {
      // The child will retry while its VNC session is alive.
    }
    settingsSyncTimer = setTimeout(tick, 1000);
  };
  tick();
}
async function loadSessionInfo() {
  try {
    const response = await api(
      `/api/session?session=${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok) return;
    const data = await response.json();
    setupAvailable = data.setupAvailable === true && isMainSession;
    $("setup-open").hidden = !setupAvailable;
    $("setup-edit").hidden = !setupAvailable;
    if (setupAvailable) {
      const setupResponse = await api("/api/setup");
      if (setupResponse.ok && !(await setupResponse.json()).configured) {
        location.replace(`./setup.html#token=${encodeURIComponent(token)}`);
        return;
      }
    }
    const title = data.session?.title || data.profile?.name || "QQ";
    document.title = `${title} · PenguX11VNC`;
    document.querySelector(".identity strong").lastElementChild.textContent =
      `· ${title}`;
    $("profile-name").lastElementChild.textContent =
      data.profile?.name || title;
    $("profile-ssh").lastElementChild.textContent =
      data.profile?.id || "配置文件";
    const loadedPersistentSettings = await loadPersistentSettings();
    if (data.session?.child) {
      $("children-section").hidden = true;
      $("welcome-hint").textContent = "QQ 子窗口 · 独立 VNC 会话";
      for (const id of [
        "fit",
        "actual",
        "bitrate",
        "frame-rate",
        "wheel",
        "view-only",
        "clipboard-sync",
        "child-auto-open",
        "system-titlebar",
      ])
        $(id).disabled = true;
      $("settings-toggle").title = "子窗口遵循主窗口设置";
      setTimeout(() => {
        if (!rfb && !connected) connect();
      }, 0);
      startInheritedSettingsSync();
    }
    if (!loadedPersistentSettings && data.profile?.viewer && !hasSavedSettings)
      applySettings(data.profile.viewer);
    if (data.profile?.clipboardSync && !settings.clipboardSync) {
      $("clipboard-status").textContent =
        "配置档允许同步；仍需在本页手动开启。";
    }
  } catch {
    // The connection button provides the visible failure state.
  } finally {
    settingsReady = true;
  }
}

function panel(open) {
  $("settings").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
  if (open) rfb?.blur();
  else if (connected) rfb?.focus();
}
function stopClipboardSync() {
  clearInterval(clipboardTimer);
  clipboardTimer = undefined;
  localClipboardValue = undefined;
  remoteClipboardValue = undefined;
}
async function pollClipboard() {
  if (!connected || !settings.clipboardSync || !navigator.clipboard?.readText)
    return;
  try {
    const text = await navigator.clipboard.readText();
    if (localClipboardValue === undefined) {
      localClipboardValue = text;
      return;
    }
    if (
      text !== localClipboardValue &&
      text !== remoteClipboardValue &&
      !settings.viewOnly
    ) {
      rfb?.clipboardPasteFrom(text);
      localClipboardValue = text;
      $("clipboard-status").textContent = "已将本机剪贴板发送到远端。";
    }
  } catch {
    $("clipboard-status").textContent =
      "浏览器未授予剪贴板权限；点击页面后可重试。";
  }
}
async function startClipboardSync() {
  stopClipboardSync();
  if (!settings.clipboardSync) {
    $("clipboard-status").textContent = "当前关闭：不会读取或写入本机剪贴板。";
    return;
  }
  if (!navigator.clipboard) {
    $("clipboard-status").textContent = "当前浏览器不支持剪贴板 API。";
    return;
  }
  $("clipboard-status").textContent = "同步已开启；正在请求本页剪贴板权限。";
  await pollClipboard();
  clipboardTimer = setInterval(pollClipboard, 1200);
}

function childWindowFeatures(info) {
  return `popup=yes,width=${Math.max(500, Math.min(1600, info.width + 50))},height=${Math.max(400, Math.min(1200, info.height + 100))}`;
}
function tauriWebviewWindowClass() {
  return globalThis.__TAURI__?.webviewWindow?.WebviewWindow;
}
function isTauriShell() {
  return typeof tauriWebviewWindowClass() === "function";
}
async function createTauriChildWindow(info, url, scaleFactor = 1) {
  const WebviewWindow = tauriWebviewWindowClass();
  const label = `qq-child-${info.id.replace(/^0x/i, "").toLowerCase()}`;
  const scale = Number.isFinite(Number(scaleFactor))
    ? Math.max(0.05, Math.min(1, Number(scaleFactor)))
    : 1;
  const child = new WebviewWindow(label, {
    url: new URL(url, location.origin).toString(),
    title: `PenguX11VNC · QQ 子窗口 · ${info.id}`,
    width: Math.max(320, Math.min(1600, Math.round(info.width * scale))),
    height: Math.max(240, Math.min(1200, Math.round(info.height * scale))),
    minWidth: 320,
    minHeight: 200,
    resizable: true,
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    child.once("tauri://created", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    child.once("tauri://error", (event) => {
      if (!settled) {
        settled = true;
        reject(new Error(event.payload || "Tauri 子窗口创建失败"));
      }
    });
  });
  return child;
}
async function cleanupChildEntry(key, entry) {
  if (!entry || entry.cleanupStarted) return;
  entry.cleanupStarted = true;
  if (window.openedChildWindows?.get(key) === entry)
    window.openedChildWindows.delete(key);
  await api(
    `/api/sessions/${encodeURIComponent(entry.sessionId)}?session=main`,
    { method: "DELETE" },
  ).catch(() => {});
}
async function closeChildEntry(key, entry) {
  // Await native IPC before forgetting the window. A rejected close must leave
  // the entry available for the next poll; requesting close is not destruction.
  if (!entry.closed) await entry.window.close();
  // Native close() acknowledges the request before Destroyed is delivered.
  // Keep tracking the window until that event; its handler performs cleanup.
  if (!entry.tauri || entry.closed) await cleanupChildEntry(key, entry);
}
function renderChildWindows(windows) {
  const list = $("child-list");
  list.replaceChildren();
  const pending = windows.filter(
    (info) => !window.openedChildWindows?.has(info.id.toLowerCase()),
  );
  list.hidden = pending.length === 0;
  for (const info of pending) {
    const key = info.id.toLowerCase();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "child-open";
    button.innerHTML = `打开子窗口 <small>${info.id} · ${info.width} × ${info.height}</small>`;
    button.addEventListener("click", () => openChildWindow(info, true));
    list.append(button);
  }
}
async function openChildWindow(info, userInitiated = false) {
  const key = info.id.toLowerCase();
  const tauri = isTauriShell();
  window.openedChildWindows ??= new Map();
  if (window.openedChildWindows.has(key)) return;
  let child;
  if (!tauri) {
    // Chrome requires this synchronous placeholder before the async SSH/API
    // request. Tauri creates a native WebviewWindow after the request instead.
    child = window.open("about:blank", `qq-${key}`, childWindowFeatures(info));
    if (!child) {
      if (userInitiated)
        toast("浏览器仍阻止了子窗口，请允许本地页面打开弹出窗口。");
      return;
    }
  }
  try {
    const inheritedScale = tauri
      ? syncMainTauriScaleFromViewport($("screen").querySelector("canvas")) ||
        tauriVncScaleFactor ||
        1
      : 1;
    const opened = await api(
      `/api/windows/${encodeURIComponent(info.id)}/open?session=main`,
      { method: "POST" },
    );
    if (!opened.ok) throw new Error("子窗口 VNC 会话启动失败");
    const data = await opened.json();
    let childUrl = data.url;
    if (tauri && Number.isFinite(inheritedScale)) {
      const url = new URL(data.url, location.origin);
      url.searchParams.set("vncScale", inheritedScale.toFixed(6));
      childUrl = url.toString();
    }
    if (tauri)
      child = await createTauriChildWindow(info, childUrl, inheritedScale);
    else child.location.href = childUrl;
    const entry = {
      window: child,
      tauri,
      closed: false,
      sessionId: data.session.id,
      info,
    };
    if (tauri) {
      const markClosed = () => {
        entry.closed = true;
        void cleanupChildEntry(key, entry);
      };
      // Do not register onCloseRequested: Tauri then prevents the OS close
      // and relies on JS destroy(). Native Rust cleanup already runs off-thread.
      await child.once("tauri://destroyed", markClosed);
    }
    window.openedChildWindows.set(key, entry);
    renderChildWindows(window.lastChildWindows || []);
  } catch (error) {
    try {
      if (tauri) await child?.close();
      else child?.close();
    } catch {
      // The child may already have been destroyed.
    }
    toast(error.message || "子窗口 VNC 会话启动失败");
  }
}
async function pollChildWindows(force = false) {
  if (
    !isMainSession ||
    !connected ||
    (!settings.autoChildOpen && !force && !window.openedChildWindows?.size) ||
    childPollInFlight
  )
    return;
  childPollInFlight = true;
  try {
    const response = await api("/api/windows?session=main");
    if (!response.ok) throw new Error("子窗口服务不可用");
    const data = await response.json();
    const windows = data.windows || [];
    window.lastChildWindows = windows;
    window.openedChildWindows ??= new Map();
    const visibleKeys = new Set(windows.map((info) => info.id.toLowerCase()));
    for (const [key, entry] of window.openedChildWindows) {
      const childClosed =
        entry.closed === true ||
        (!entry.tauri && entry.window?.closed === true);
      const remoteClosed = !visibleKeys.has(key);
      if (!childClosed && !remoteClosed) continue;
      if (childClosed) await cleanupChildEntry(key, entry);
      else await closeChildEntry(key, entry);
    }
    $("child-status").textContent = windows.length
      ? `发现 ${windows.length} 个 QQ 子窗口。`
      : "没有可见的 QQ 子窗口。";
    renderChildWindows(windows);
    if (!settings.autoChildOpen) return;
    for (const info of windows) {
      if (window.openedChildWindows.has(info.id.toLowerCase())) continue;
      await openChildWindow(info);
    }
  } catch {
    $("child-status").textContent = "子窗口检查暂不可用；主 QQ 连接不受影响。";
  } finally {
    childPollInFlight = false;
  }
}
function startChildMonitor() {
  clearTimeout(childTimer);
  if (!isMainSession) return;
  const tick = async () => {
    if (!connected || !isMainSession) return;
    const startedAt = performance.now();
    await pollChildWindows();
    if (connected && isMainSession) {
      const elapsed = performance.now() - startedAt;
      childTimer = setTimeout(tick, Math.max(0, childPollIntervalMs - elapsed));
    }
  };
  tick();
}
function stopChildMonitor() {
  clearTimeout(childTimer);
  childTimer = undefined;
  childPollInFlight = false;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function clipboardFilesSignature(files) {
  return JSON.stringify(
    files.map((file) => [
      String(file.path || ""),
      String(file.name || ""),
      Number(file.size) || 0,
    ]),
  );
}
function clipboardFileErrorMessage(error) {
  return error?.message || String(error);
}
function isNoFileClipboardError(error) {
  const message = clipboardFileErrorMessage(error);
  return (
    message.includes("本机剪贴板中没有可用文件") ||
    message.includes("剪贴板中没有文件")
  );
}
function reportClipboardFileError(error) {
  const message = clipboardFileErrorMessage(error);
  $("clipboard-files-status").textContent = `文件剪贴板失败：${message}`;
  toast(`文件剪贴板失败：${message}`);
}
function isViewerPasteShortcut(event) {
  if (
    !isTauriShell() ||
    !connected ||
    settings.viewOnly ||
    replayingClipboardPasteShortcut ||
    event.repeat ||
    event.altKey ||
    (!event.ctrlKey && !event.metaKey) ||
    String(event.key).toLowerCase() !== "v"
  )
    return false;
  const target = event.target instanceof Element ? event.target : undefined;
  if (
    !target?.closest("#screen") ||
    target.closest("input, textarea, select, [contenteditable='true']")
  )
    return false;
  return true;
}
function replayClipboardPasteShortcut(event) {
  const canvas = $("screen").querySelector("canvas");
  if (!canvas) return;
  replayingClipboardPasteShortcut = true;
  const init = {
    bubbles: true,
    cancelable: true,
    key: "v",
    code: "KeyV",
    location: event.location,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  };
  try {
    canvas.dispatchEvent(new KeyboardEvent("keydown", init));
    canvas.dispatchEvent(new KeyboardEvent("keyup", init));
  } finally {
    replayingClipboardPasteShortcut = false;
  }
}
async function handleViewerPasteShortcut(event) {
  if (!isViewerPasteShortcut(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (clipboardPasteShortcutInFlight) return;
  clipboardPasteShortcutInFlight = true;
  try {
    let files;
    try {
      files = await tauriInvoke("read_clipboard_files");
    } catch (error) {
      if (isNoFileClipboardError(error)) {
        remoteFilePasteSignature = undefined;
        replayClipboardPasteShortcut(event);
      } else {
        reportClipboardFileError(error);
      }
      return;
    }
    if (
      Array.isArray(files) &&
      remoteFilePasteSignature &&
      clipboardFilesSignature(files) === remoteFilePasteSignature
    ) {
      replayClipboardPasteShortcut(event);
      return;
    }
    await sendClipboardFiles(files);
  } finally {
    clipboardPasteShortcutInFlight = false;
  }
}
async function sendClipboardFiles(preloadedFiles) {
  const status = $("clipboard-files-status");
  try {
    const files = preloadedFiles ?? (await tauriInvoke("read_clipboard_files"));
    if (!Array.isArray(files) || files.length === 0) {
      status.textContent = "本机剪贴板中没有文件。";
      return;
    }
    const total = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const summary = files
      .map(
        (file) => `${file.name}（${formatFileSize(Number(file.size) || 0)}）`,
      )
      .join("、");
    if (
      !window.confirm(
        `将 ${files.length} 个文件（${formatFileSize(total)}）上传到远端 Downloads？\n\n${summary}\n\n上传后远端 Linux 剪贴板会包含这些文件；不会自动发送 QQ 消息。`,
      )
    ) {
      status.textContent = "已取消文件上传。";
      return;
    }
    status.textContent = `正在上传 ${files.length} 个文件（${formatFileSize(total)}），请稍候……`;
    const result = await tauriInvoke("upload_clipboard_files", {
      paths: files.map((file) => file.path),
    });
    const names = result.files?.map((file) => file.name).join("、") || summary;
    status.textContent = `已上传到远端 Downloads：${names}。请在 QQ 中手动粘贴。`;
    remoteFilePasteSignature = clipboardFilesSignature(files);
    toast("文件已上传并写入远端 Linux 文件剪贴板，请在 QQ 中按 Ctrl+V。 ");
  } catch (error) {
    reportClipboardFileError(error);
  } finally {
    setInteractive();
  }
}
function setInteractive() {
  $("disconnect").disabled = !connected && !connectionWanted;
  $("send-clipboard").disabled = !connected || settings.viewOnly;
  $("send-clipboard-files").disabled =
    !connected || settings.viewOnly || !isTauriShell();
  if (rfb) rfb.viewOnly = settings.viewOnly;
}

async function connect(prepare = true) {
  await sessionReady;
  if (rfb || connecting) return;
  if (!token) {
    toast("请使用“启动 PenguX11VNC.command”打开，获取本次本地访问凭证。");
    return;
  }
  connecting = true;
  const attempt = ++connectEpoch;
  $("connect").disabled = true;
  state("正在连接", "connecting");
  try {
    if (setupAvailable && prepare) {
      connectionWanted = true;
      const response = await api("/api/main/prepare", { method: "POST" });
      const main = await response.json();
      if (attempt !== connectEpoch) return;
      if (!response.ok)
        throw new Error(main.detail || main.error || "远端预检失败");
      if (main.managed) startRecoveryMonitor();
      if (main.state !== "ready") {
        showRecoveryState(main.state);
        $("connect").disabled = false;
        return;
      }
    }
    const response = await api(
      `/api/credentials?session=${encodeURIComponent(sessionId)}`,
    );
    if (response.status === 403)
      throw new Error("本地访问凭证已过期，请重新运行启动器。");
    let credentials = {};
    if (response.ok) credentials = await response.json();
    if (attempt !== connectEpoch) return;
    const client = new QQRFB(
      $("screen"),
      `${location.origin.replace("http:", "ws:")}/vnc?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`,
      { credentials, shared: true },
    );
    // The local server may provide the session-only credential to child RFB sessions.
    credentials = null;
    rfb = client;
    client.background = "#131217";
    client.resizeSession = false;
    client.scaleViewport = settings.scale === "fit";
    client.viewOnly = settings.viewOnly;
    client.wheelSensitivity = settings.wheel / 100;
    client.bitrateMode = settings.bitrate;
    client.frameRate = settings.frameRate;
    client.addEventListener("credentialsrequired", () => {
      $("password-dialog").showModal();
      $("password").focus();
    });
    client.addEventListener("securityfailure", () => {
      void clearVncPasswordCache();
      stopMainConnection().catch(() => {});
      toast("VNC 认证失败，已停止自动重试。请检查密码后重新连接。");
    });
    client.addEventListener("connect", () => {
      connected = true;
      state("已连接", "connected");
      if (isMainSession) {
        imeOverlay = new ImeOverlay({
          screen: $("screen"),
          image: $("ime-overlay"),
          status: $("ime-status"),
          token,
        });
      }
      $("welcome").hidden = true;
      setInteractive();
      startClipboardSync();
      const canvas = $("screen").querySelector("canvas");
      resizeObserver = new ResizeObserver(() => geometry(false));
      resizeObserver.observe(canvas);
      frameObserver = new MutationObserver(() => geometry(true));
      frameObserver.observe(canvas, {
        attributes: true,
        attributeFilter: ["width", "height"],
      });
      geometry(true);
      startChildMonitor();
      if ($("settings").hidden) client.focus();
    });
    client.addEventListener("disconnect", (event) => {
      connected = false;
      remoteFilePasteSignature = undefined;
      if (isMainSession) void cleanupOpenedChildSessions();
      stopClipboardSync();
      stopChildMonitor();
      rfb = undefined;
      resizeObserver?.disconnect();
      frameObserver?.disconnect();
      tauriVncResizeKey = undefined;
      const resetScale = isMainSession
        ? requestedTauriScale
        : (inheritedTauriScale ?? requestedTauriScale);
      tauriVncScaleFactor = resetScale;
      preferredTauriScale = resetScale;
      if (isMainSession && isTauriShell())
        void tauriInvoke("set_main_window_aspect", { width: 0, height: 0 });
      document.body.classList.remove("tauri-vnc-frame");
      imeOverlay?.close();
      imeOverlay = undefined;
      $("password-dialog").close();
      $("password").value = "";
      $("welcome").hidden = false;
      $("connect").disabled = false;
      state("已断开", "disconnected");
      $("geometry").textContent = "原始像素 · 等比例缩放";
      setInteractive();
      if (!event.detail.clean)
        toast("连接中断，请检查 SSH 隧道或远端 x11vnc。");
    });
    client.addEventListener("clipboard", async (event) => {
      if (!settings.clipboardSync || !navigator.clipboard?.writeText) return;
      const text = event.detail?.text || "";
      remoteClipboardValue = text;
      localClipboardValue = text;
      try {
        await navigator.clipboard.writeText(text);
        $("clipboard-status").textContent = "已将远端剪贴板写入本机。";
      } catch {
        $("clipboard-status").textContent =
          "远端剪贴板已到达，但浏览器拒绝写入本机。";
      }
    });
  } catch (error) {
    state("未连接", "disconnected");
    $("connect").disabled = false;
    toast(error.message || "无法建立连接");
  } finally {
    connecting = false;
  }
}

const recoveryLabels = {
  "waiting-qq":
    "远端 QQ 未运行：请在远端打开已有 QQ，程序不会替你启动第二个实例。",
  "waiting-window":
    "QQ 已运行，但窗口隐藏或当前图形会话不可访问。请显示 QQ 主窗口。",
  "choose-window":
    "发现多个候选窗口，无法安全自动选择。请打开配置向导重新选择。",
  disconnected: "自动恢复未开启，请点击连接重试。",
};
function showRecoveryState(value) {
  $("recovery-status").textContent = recoveryLabels[value] || value;
  state("等待远端", "disconnected");
  setInteractive();
}
function startRecoveryMonitor() {
  clearTimeout(recoveryTimer);
  const epoch = ++recoveryEpoch;
  const tick = async () => {
    if (!connectionWanted || epoch !== recoveryEpoch) return;
    try {
      const response = await api("/api/main/poll", { method: "POST" });
      const result = await response.json();
      if (!connectionWanted || epoch !== recoveryEpoch) return;
      if (!response.ok)
        throw new Error("远端暂不可达，正在等待重连；可打开配置向导检查 SSH。");
      if (result.state === "ready") {
        $("recovery-status").textContent = "";
        if (!rfb) await connect(false);
      } else {
        rfb?.disconnect();
        showRecoveryState(result.state);
        if (!result.autoRecover) {
          connectionWanted = false;
          recoveryEpoch++;
          setInteractive();
        }
      }
    } catch (error) {
      showRecoveryState(error.message);
    }
    if (connectionWanted && epoch === recoveryEpoch)
      recoveryTimer = setTimeout(tick, 5000);
  };
  recoveryTimer = setTimeout(tick, 5000);
}
async function cleanupOpenedChildSessions() {
  const entries = [...(window.openedChildWindows?.entries() || [])];
  for (const [key, entry] of entries) {
    try {
      await closeChildEntry(key, entry);
    } catch {
      // Keep the entry so it can be retried after reconnecting.
      toast("子窗口关闭失败，请重试或使用窗口标题栏关闭。");
    }
  }
}
async function stopMainConnection() {
  connectEpoch++;
  $("connect").disabled = false;
  connectionWanted = false;
  recoveryEpoch++;
  clearTimeout(recoveryTimer);
  const childrenCleanup = isMainSession
    ? cleanupOpenedChildSessions()
    : Promise.resolve(
        api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        }).catch(() => {}),
      );
  rfb?.disconnect();
  await childrenCleanup;
  if (setupAvailable) await api("/api/main/stop", { method: "POST" });
  setInteractive();
}
async function openSetup() {
  try {
    await stopMainConnection();
    location.href = `./setup.html#token=${encodeURIComponent(token)}`;
  } catch {
    toast("无法停止当前会话，请稍后重试。");
  }
}
$("setup-open").addEventListener("click", openSetup);
$("setup-edit").addEventListener("click", openSetup);
$("connect").addEventListener("click", () => connect());
$("bitrate").value = settings.bitrate;
$("bitrate-value").textContent = bitrateLabels[settings.bitrate];
$("bitrate").addEventListener("change", () => setBitrate($("bitrate").value));
$("frame-rate").value = String(settings.frameRate);
$("frame-rate-value").textContent = frameRateLabels[settings.frameRate];
$("frame-rate").addEventListener("change", () =>
  setFrameRate($("frame-rate").value),
);
$("disconnect").addEventListener("click", () =>
  stopMainConnection().catch(() => toast("会话清理失败，请检查 SSH。")),
);
$("fit").addEventListener("click", () => scale("fit"));
$("actual").addEventListener("click", () => scale("actual"));
$("wheel").value = settings.wheel;
$("wheel-value").textContent = `${settings.wheel}%`;
$("wheel").addEventListener("input", () => {
  settings.wheel = Number($("wheel").value);
  $("wheel-value").textContent = `${settings.wheel}%`;
  if (rfb) rfb.wheelSensitivity = settings.wheel / 100;
  save();
});
$("view-only").checked = settings.viewOnly;
$("clipboard-sync").checked = settings.clipboardSync;
$("child-auto-open").checked = settings.autoChildOpen;
$("system-titlebar").checked = settings.systemTitlebar;
$("titlebar-toggle").addEventListener("click", () => {
  if (!document.body.classList.contains("no-system-titlebar")) return;
  setTitlebarExpanded(!document.body.classList.contains("titlebar-expanded"));
});
$("system-titlebar").addEventListener("change", async () => {
  const enabled = $("system-titlebar").checked;
  settings.systemTitlebar = enabled;
  if (await applyTauriTitlebar(enabled, true)) save();
  else {
    settings.systemTitlebar = !enabled;
    $("system-titlebar").checked = !enabled;
  }
});
document.body.classList.toggle("tauri-shell", isTauriShell());
if (isTauriShell() && isMainSession) {
  const trayName = /Mac/.test(navigator.platform) ? "菜单栏" : "系统托盘";
  $("window-close").title = `隐藏到${trayName}`;
  $("window-close").setAttribute("aria-label", `隐藏到${trayName}`);
  $("tauri-close-hint").textContent =
    `${trayName}可用时，关闭主窗口只会隐藏，连接继续保持；从图标菜单恢复或退出。QQ 子窗口仍正常关闭。`;
  $("tauri-close-hint").hidden = false;
}
$("window-close").addEventListener("click", () => {
  currentTauriWindow()
    ?.close()
    .catch(() => toast("窗口关闭失败，请重试。"));
});
document.querySelector(".titlebar").addEventListener("pointerdown", (event) => {
  if (
    !document.body.classList.contains("no-system-titlebar") ||
    event.button !== 0 ||
    event.target.closest("button, input, select, textarea, a")
  )
    return;
  currentTauriWindow()
    ?.startDragging?.()
    .catch(() => {});
});
$("clipboard-sync").addEventListener("change", () => {
  settings.clipboardSync = $("clipboard-sync").checked;
  save();
  startClipboardSync();
});
$("child-auto-open").addEventListener("change", () => {
  settings.autoChildOpen = $("child-auto-open").checked;
  save();
  // Disabling auto-open must not disable cleanup of existing child windows.
  startChildMonitor();
  if (!settings.autoChildOpen)
    $("child-status").textContent =
      "自动打开已关闭；已打开的子窗口仍会自动回收。";
});
$("child-refresh").addEventListener("click", () => pollChildWindows(true));
$("view-only").addEventListener("change", () => {
  settings.viewOnly = $("view-only").checked;
  rfb?.wheelLimiter?.reset();
  setInteractive();
  save();
});
$("settings-toggle").addEventListener("click", () =>
  panel($("settings").hidden),
);
$("settings-close").addEventListener("click", () => panel(false));
document.addEventListener("pointerdown", (event) => {
  const settingsPanel = $("settings");
  if (
    !settingsPanel.hidden &&
    !settingsPanel.contains(event.target) &&
    !event.target.closest(".titlebar") &&
    event.target !== $("settings-toggle") &&
    !event.target.closest("#settings-toggle")
  )
    panel(false);
});
$("fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("浏览器未允许全屏，请使用浏览器的全屏菜单。");
  }
});
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle(
    "immersive",
    Boolean(document.fullscreenElement),
  );
  if (connected) geometry(true);
});
window.addEventListener("resize", () => {
  if (!connected) return;
  geometry(false);
});
$("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("password").value;
  const client = rfb;
  if (password) {
    try {
      const result = await cacheVncPassword(password);
      if ($("password-remember").checked && result.persisted === false)
        toast("系统凭据库不可用；本次运行仍会复用密码，但重启后需重新输入。");
    } catch {
      // Still authenticate this connection if the optional cache is unavailable.
    }
  }
  client?.sendCredentials({ password });
  $("password").value = "";
  $("password-dialog").close();
});
function cancelPassword() {
  $("password").value = "";
  $("password-dialog").close();
  rfb?.disconnect();
}
$("password-cancel").addEventListener("click", cancelPassword);
$("password-dialog").addEventListener("cancel", cancelPassword);
document.addEventListener("keydown", handleViewerPasteShortcut, true);
$("send-clipboard-files").addEventListener("click", () => {
  if (!connected || settings.viewOnly || !isTauriShell()) return;
  $("send-clipboard-files").disabled = true;
  void sendClipboardFiles();
});
$("send-clipboard").addEventListener("click", () => {
  if (!rfb || !connected || settings.viewOnly) return;
  const text = $("clipboard").value;
  if (/[^\u0000-\u00ff]/u.test(text) && !rfb.unicodeClipboard) {
    toast("当前 x11vnc 未协商 Unicode 剪贴板，已阻止传送，避免中文变成问号。");
    return;
  }
  rfb.clipboardPasteFrom(text);
  toast("已请求写入远端剪贴板；请在 QQ 中手动粘贴并确认。");
});
$("screen").addEventListener("scroll", () => imeOverlay?.position(), true);
window.addEventListener("pagehide", () => {
  connectionWanted = false;
  recoveryEpoch++;
  clearTimeout(recoveryTimer);
  stopClipboardSync();
  stopChildMonitor();
  clearTimeout(settingsSyncTimer);
  if (isMainSession && settingsReady && token) {
    clearTimeout(settingsSaveTimer);
    fetch(`/api/settings?session=main&token=${encodeURIComponent(token)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
      keepalive: true,
    }).catch(() => {});
  } else {
    clearTimeout(settingsSaveTimer);
  }
  settingsChannel?.close();
  if (!isMainSession && token) {
    fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`,
      { method: "DELETE", keepalive: true },
    ).catch(() => {});
  }
});
sessionReady = loadSessionInfo();
scale(settings.scale, false);
