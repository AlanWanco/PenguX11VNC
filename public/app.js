import QQRFB from "./qq-rfb.js";
import { ImeOverlay } from "./ime-overlay.js";

const $ = (id) => document.getElementById(id);
let rfb;
let connected = false;
let toastTimer;
let frameObserver;
let resizeObserver;
let imeOverlay;
let childTimer;
let childPollInFlight = false;
let clipboardTimer;
let token;
const sessionId = new URLSearchParams(location.search).get("session") || "main";
const isMainSession = sessionId === "main";
let localClipboardValue;
let remoteClipboardValue;
let hasSavedSettings = false;
let settingsReady = false;
let settingsStamp = 0;
let settingsSaveTimer;
let settingsSyncTimer;
const defaultSettings = {
  wheel: 25,
  viewOnly: false,
  scale: "fit",
  bitrate: "lossless",
  frameRate: 30,
  clipboardSync: false,
  autoChildOpen: true,
  uiCollapsed: false,
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
    uiCollapsed: value.uiCollapsed === true,
  };
}
try {
  const savedText =
    localStorage.getItem("qq-viewer-settings-main") ||
    localStorage.getItem("qq-viewer-settings") ||
    "";
  hasSavedSettings = Boolean(savedText);
  settings = normalizeSettings(JSON.parse(savedText || "{}"));
  const fragment = new URLSearchParams(location.hash.slice(1));
  token = fragment.get("token") || sessionStorage.getItem("qq-viewer-token");
  if (token) sessionStorage.setItem("qq-viewer-token", token);
} catch {
  token = new URLSearchParams(location.hash.slice(1)).get("token");
}
if (location.hash)
  history.replaceState(null, "", location.pathname + location.search);

function save() {
  if (!isMainSession || !settingsReady) return;
  const serialized = JSON.stringify(settings);
  try {
    localStorage.setItem("qq-viewer-settings-main", serialized);
  } catch {
    /* Storage is optional. */
  }
  settingsChannel?.postMessage({ settings });
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
    if (!isMainSession && event.data?.settings)
      applySettings(event.data.settings);
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
  if (rfb) rfb.wheelSensitivity = settings.wheel / 100;
  setBitrate(settings.bitrate, false);
  setFrameRate(settings.frameRate, false);
  scale(settings.scale, false);
  setUiCollapsed(settings.uiCollapsed, false);
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
  settings.scale = mode;
  for (const id of ["fit", "actual"]) {
    $(id).classList.toggle("active", id === mode);
    $(id).setAttribute("aria-pressed", String(id === mode));
  }
  if (rfb) {
    rfb.resizeSession = false;
    rfb.scaleViewport = mode === "fit";
  }
  if (persist) save();
  geometry();
}
let aspectResizeKey;
function fitCollapsedScreen() {
  const screen = $("screen");
  const canvas = screen.querySelector("canvas");
  if (
    !document.body.classList.contains("ui-collapsed") ||
    settings.scale !== "fit" ||
    !canvas?.width ||
    !canvas.height
  ) {
    for (const property of [
      "inset",
      "left",
      "top",
      "width",
      "height",
      "transform",
    ])
      screen.style.removeProperty(property);
    return;
  }
  const gap = 8;
  const availableWidth = Math.max(1, screen.parentElement.clientWidth - gap);
  const availableHeight = Math.max(1, screen.parentElement.clientHeight - gap);
  const aspect = canvas.width / canvas.height;
  const width = Math.floor(Math.min(availableWidth, availableHeight * aspect));
  const height = Math.floor(width / aspect);
  screen.style.inset = "auto";
  screen.style.left = "50%";
  screen.style.top = "50%";
  screen.style.width = `${width}px`;
  screen.style.height = `${height}px`;
  screen.style.transform = "translate(-50%, -50%)";
}
function resizeWindowToAspect() {
  const canvas = $("screen").querySelector("canvas");
  if (
    !document.body.classList.contains("ui-collapsed") ||
    settings.scale !== "fit" ||
    !canvas?.width ||
    !canvas.height
  )
    return;
  const key = `${canvas.width}x${canvas.height}`;
  if (aspectResizeKey === key) return;
  aspectResizeKey = key;
  const innerWidth = window.innerWidth;
  const innerHeight = window.innerHeight;
  const maxInnerHeight = Math.max(
    450,
    (window.screen?.availHeight || innerHeight) - 48,
  );
  let targetWidth = innerWidth;
  let targetHeight = Math.round(targetWidth / (canvas.width / canvas.height));
  if (targetHeight > maxInnerHeight) {
    targetHeight = maxInnerHeight;
    targetWidth = Math.round(targetHeight * (canvas.width / canvas.height));
  }
  if (
    Math.abs(targetWidth - innerWidth) < 12 &&
    Math.abs(targetHeight - innerHeight) < 12
  )
    return;
  try {
    window.resizeTo(
      Math.max(
        520,
        (window.outerWidth || innerWidth) + targetWidth - innerWidth,
      ),
      Math.max(
        420,
        (window.outerHeight || innerHeight) + targetHeight - innerHeight,
      ),
    );
  } catch {
    // Browser app windows may refuse scripted resizing; CSS fitting still applies.
  }
}
function geometry() {
  const canvas = $("screen").querySelector("canvas");
  if (!canvas?.width) return;
  const percent = Math.round(
    (canvas.getBoundingClientRect().width / canvas.width) * 100,
  );
  $("geometry").textContent =
    `${canvas.width} × ${canvas.height} · ${percent}% · ${bitrateLabels[settings.bitrate]} · ${frameRateLabels[settings.frameRate]}`;
  fitCollapsedScreen();
  resizeWindowToAspect();
  imeOverlay?.position();
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-QQ-Token", token || "");
  return fetch(path, { ...options, headers });
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
        "collapse",
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
function setUiCollapsed(collapsed, persist = true) {
  settings.uiCollapsed = collapsed;
  document.body.classList.toggle("ui-collapsed", collapsed);
  document.body.classList.remove("ui-peek");
  $("collapse").setAttribute("aria-pressed", String(collapsed));
  if (collapsed) {
    panel(false);
    fitCollapsedScreen();
    resizeWindowToAspect();
  } else {
    aspectResizeKey = undefined;
    fitCollapsedScreen();
  }
  if (isMainSession) {
    try {
      localStorage.setItem("qq-viewer-ui-collapsed", String(collapsed));
    } catch {
      /* optional */
    }
  }
  if (persist) save();
}
function restoreUi() {
  setUiCollapsed(false);
}

const restoreBubble = $("restore-bubble");
let bubblePointer;
let bubbleWasDragged = false;
function clampBubblePosition(left, top) {
  const rect = restoreBubble.getBoundingClientRect();
  const width = rect.width || 42;
  const height = rect.height || 42;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  const maxTop = Math.max(8, window.innerHeight - height - 38);
  return {
    left: Math.max(8, Math.min(maxLeft, left)),
    top: Math.max(8, Math.min(maxTop, top)),
  };
}
function saveBubblePosition() {
  try {
    localStorage.setItem(
      `qq-viewer-bubble-${sessionId}`,
      JSON.stringify({
        left: restoreBubble.offsetLeft,
        top: restoreBubble.offsetTop,
      }),
    );
  } catch {
    /* Storage is optional. */
  }
}
function restoreBubblePosition() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`qq-viewer-bubble-${sessionId}`) || "null",
    );
    if (!Number.isFinite(saved?.left) || !Number.isFinite(saved?.top)) return;
    const position = clampBubblePosition(saved.left, saved.top);
    restoreBubble.style.left = `${position.left}px`;
    restoreBubble.style.top = `${position.top}px`;
    restoreBubble.style.right = "auto";
    restoreBubble.style.bottom = "auto";
  } catch {
    /* Storage is optional. */
  }
}
restoreBubble.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const rect = restoreBubble.getBoundingClientRect();
  bubblePointer = {
    id: event.pointerId,
    originX: event.clientX,
    originY: event.clientY,
    left: rect.left,
    top: rect.top,
    moved: false,
  };
  restoreBubble.dataset.dragging = "true";
  restoreBubble.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});
restoreBubble.addEventListener("pointermove", (event) => {
  if (!bubblePointer || event.pointerId !== bubblePointer.id) return;
  const dx = event.clientX - bubblePointer.originX;
  const dy = event.clientY - bubblePointer.originY;
  if (Math.hypot(dx, dy) > 4) bubblePointer.moved = true;
  if (!bubblePointer.moved) return;
  const position = clampBubblePosition(
    bubblePointer.left + dx,
    bubblePointer.top + dy,
  );
  restoreBubble.style.left = `${position.left}px`;
  restoreBubble.style.top = `${position.top}px`;
  restoreBubble.style.right = "auto";
  restoreBubble.style.bottom = "auto";
});
function finishBubblePointer(event) {
  if (!bubblePointer || event.pointerId !== bubblePointer.id) return;
  bubbleWasDragged = bubblePointer.moved;
  if (bubblePointer.moved) saveBubblePosition();
  restoreBubble.releasePointerCapture?.(event.pointerId);
  restoreBubble.removeAttribute("data-dragging");
  bubblePointer = undefined;
}
restoreBubble.addEventListener("pointerup", finishBubblePointer);
restoreBubble.addEventListener("pointercancel", finishBubblePointer);
restoreBubble.addEventListener("click", (event) => {
  if (bubbleWasDragged) {
    bubbleWasDragged = false;
    event.preventDefault();
    return;
  }
  restoreUi();
});
window.addEventListener("resize", () => {
  fitCollapsedScreen();
  if (!restoreBubble.style.left) return;
  const rect = restoreBubble.getBoundingClientRect();
  const position = clampBubblePosition(rect.left, rect.top);
  restoreBubble.style.left = `${position.left}px`;
  restoreBubble.style.top = `${position.top}px`;
  saveBubblePosition();
});
restoreBubblePosition();

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
async function createTauriChildWindow(info, url) {
  const WebviewWindow = tauriWebviewWindowClass();
  const label = `qq-child-${info.id.replace(/^0x/i, "")}`;
  const child = new WebviewWindow(label, {
    url: new URL(url, location.origin).toString(),
    title: `PenguX11VNC · QQ 子窗口 · ${info.id}`,
    width: Math.max(500, Math.min(1600, info.width + 50)),
    height: Math.max(400, Math.min(1200, info.height + 100)),
    minWidth: 500,
    minHeight: 400,
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
    const opened = await api(
      `/api/windows/${encodeURIComponent(info.id)}/open?session=main`,
      { method: "POST" },
    );
    if (!opened.ok) throw new Error("子窗口 VNC 会话启动失败");
    const data = await opened.json();
    if (tauri) child = await createTauriChildWindow(info, data.url);
    else child.location.href = data.url;
    const entry = {
      window: child,
      tauri,
      closed: false,
      sessionId: data.session.id,
      info,
    };
    if (tauri)
      child.once("tauri://destroyed", () => {
        entry.closed = true;
      });
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
    (!settings.autoChildOpen && !force) ||
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
      window.openedChildWindows.delete(key);
      if (remoteClosed && !childClosed) {
        try {
          entry.window.close();
        } catch {
          // The native/browser child may already be closing.
        }
      }
      await api(
        `/api/sessions/${encodeURIComponent(entry.sessionId)}?session=main`,
        { method: "DELETE" },
      ).catch(() => {});
    }
    $("child-status").textContent = windows.length
      ? `发现 ${windows.length} 个 QQ 子窗口。`
      : "没有可见的 QQ 子窗口。";
    renderChildWindows(windows);
    if (!settings.autoChildOpen && force) return;
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
    await pollChildWindows();
    if (connected && isMainSession) childTimer = setTimeout(tick, 1000);
  };
  tick();
}
function stopChildMonitor() {
  clearTimeout(childTimer);
  childTimer = undefined;
  childPollInFlight = false;
}

function setInteractive() {
  $("disconnect").disabled = !connected;
  $("send-clipboard").disabled = !connected || settings.viewOnly;
  if (rfb) rfb.viewOnly = settings.viewOnly;
}

async function connect() {
  if (rfb) return;
  if (!token) {
    toast("请使用“启动 PenguX11VNC.command”打开，获取本次本地访问凭证。");
    return;
  }
  $("connect").disabled = true;
  state("正在连接", "connecting");
  try {
    const response = await api(
      `/api/credentials?session=${encodeURIComponent(sessionId)}`,
    );
    if (response.status === 403)
      throw new Error("本地访问凭证已过期，请重新运行启动器。");
    let credentials = {};
    if (response.ok) credentials = await response.json();
    const client = new QQRFB(
      $("screen"),
      `${location.origin.replace("http:", "ws:")}/vnc?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`,
      { credentials, shared: true },
    );
    // noVNC retains its own credentials only for this live connection.
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
    client.addEventListener("securityfailure", () =>
      toast("VNC 认证失败，请检查密码后重新连接。"),
    );
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
      startChildMonitor();
      const canvas = $("screen").querySelector("canvas");
      resizeObserver = new ResizeObserver(geometry);
      resizeObserver.observe(canvas);
      frameObserver = new MutationObserver(geometry);
      frameObserver.observe(canvas, {
        attributes: true,
        attributeFilter: ["width", "height"],
      });
      geometry();
      if ($("settings").hidden) client.focus();
    });
    client.addEventListener("disconnect", (event) => {
      connected = false;
      stopClipboardSync();
      stopChildMonitor();
      rfb = undefined;
      resizeObserver?.disconnect();
      frameObserver?.disconnect();
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
  }
}

$("connect").addEventListener("click", connect);
$("bitrate").value = settings.bitrate;
$("bitrate-value").textContent = bitrateLabels[settings.bitrate];
$("bitrate").addEventListener("change", () => setBitrate($("bitrate").value));
$("frame-rate").value = String(settings.frameRate);
$("frame-rate-value").textContent = frameRateLabels[settings.frameRate];
$("frame-rate").addEventListener("change", () =>
  setFrameRate($("frame-rate").value),
);
$("disconnect").addEventListener("click", () => rfb?.disconnect());
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
$("clipboard-sync").addEventListener("change", () => {
  settings.clipboardSync = $("clipboard-sync").checked;
  save();
  startClipboardSync();
});
$("child-auto-open").addEventListener("change", () => {
  settings.autoChildOpen = $("child-auto-open").checked;
  save();
  if (settings.autoChildOpen) startChildMonitor();
  else {
    stopChildMonitor();
    $("child-status").textContent =
      "自动打开已关闭；仍可在配置档中手动管理子窗口。";
  }
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
    event.target !== $("settings-toggle") &&
    !event.target.closest("#settings-toggle")
  )
    panel(false);
});
$("collapse").addEventListener("click", () => setUiCollapsed(true));
let peekTimer;
document.addEventListener("mousemove", (event) => {
  if (!document.body.classList.contains("ui-collapsed")) return;
  if (event.clientY <= 16) {
    document.body.classList.add("ui-peek");
    clearTimeout(peekTimer);
  } else if (!event.target.closest(".titlebar")) {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(
      () => document.body.classList.remove("ui-peek"),
      700,
    );
  }
});
$("fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("浏览器未允许全屏，请使用浏览器的全屏菜单。");
  }
});
document.addEventListener("fullscreenchange", () =>
  document.body.classList.toggle(
    "immersive",
    Boolean(document.fullscreenElement),
  ),
);
$("password-form").addEventListener("submit", (event) => {
  event.preventDefault();
  rfb?.sendCredentials({ password: $("password").value });
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
try {
  if (
    settings.uiCollapsed ||
    (isMainSession && localStorage.getItem("qq-viewer-ui-collapsed") === "true")
  )
    setUiCollapsed(true, false);
} catch {
  /* optional */
}
loadSessionInfo();
scale(settings.scale, false);
