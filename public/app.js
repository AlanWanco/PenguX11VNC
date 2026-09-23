import QQRFB from "./qq-rfb.js";
import { ImeOverlay } from "./ime-overlay.js";
import {
  buildDisconnectReport,
  sanitizeDiagnosticEvent,
} from "./disconnect-report.js";
import { videoStreamOverrides } from "./video-settings.js";

const $ = (id) => document.getElementById(id);
let rfb;
let videoPeer;
let videoEpoch = 0;
let videoActive = false;
let videoReceiverTimer;
let videoFailureMessage;
let videoFailureDetails;
let videoSettingsRestartTimer;
let connectionStartedAt;
let disconnectReportTimer;
let pageLeaving = false;
const connectionDiagnostics = [];
let manualDisconnectPending = false;
let activeConnectionMode = "vnc";
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
let remoteActivationTimer;
let remoteActivationInFlight = false;
let clipboardPasteShortcutInFlight = false;
let fileUploadInFlight = false;
let replayingClipboardPasteShortcut = false;
let remoteFilePasteSignature;
let token;
let setupAvailable = false;
let connectionWanted = false;
let recoveryTimer;
let recoveryEpoch = 0;
let childRecoveryTimer;
let childRecoveryEpoch = 0;
let remoteWindowId;
let debugClientEnabled = false;
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
let settingsSaveInFlight;
let settingsSaveAgain = false;
let settingsSaveKeepalive = false;
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
  vncScale: null,
  bitrate: "lossless",
  frameRate: 30,
  clipboardSync: false,
  autoChildOpen: true,
  systemTitlebar: true,
  connectionMode: "vnc",
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
function normalizeVncScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= 0.05 && scale <= 1
    ? Number(scale.toFixed(6))
    : null;
}
function normalizeSettings(value = {}) {
  return {
    wheel: Math.max(5, Math.min(100, Number(value.wheel) || 25)),
    viewOnly: value.viewOnly === true,
    scale: value.scale === "actual" ? "actual" : "fit",
    vncScale: normalizeVncScale(value.vncScale),
    bitrate: ["lossless", "high", "balanced", "low"].includes(value.bitrate)
      ? value.bitrate
      : "lossless",
    frameRate: [0, 5, 10, 15, 24, 30, 60].includes(Number(value.frameRate))
      ? Number(value.frameRate)
      : 30,
    clipboardSync: value.clipboardSync === true,
    autoChildOpen: value.autoChildOpen !== false,
    systemTitlebar: value.systemTitlebar !== false,
    connectionMode:
      value.connectionMode === "video" || value.videoEnabled === true
        ? "video"
        : "vnc",
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
  if (isMainSession && !requestedTauriScale && settings.vncScale !== null) {
    tauriVncScaleFactor = settings.vncScale;
    preferredTauriScale = settings.vncScale;
  }
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

async function persistSettings(options = {}) {
  if (!isMainSession || !settingsReady) return;
  try {
    const response = await api("/api/settings?session=main", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
      keepalive: options.keepalive === true,
    });
    if (response.ok) {
      const data = await response.json();
      settingsStamp = Number(data.updatedAt) || settingsStamp;
    }
  } catch {
    // localStorage and BroadcastChannel still keep this running session in sync.
  }
}
function queuePersistSettings(options = {}) {
  if (settingsSaveInFlight) {
    settingsSaveAgain = true;
    settingsSaveKeepalive ||= options.keepalive === true;
    return settingsSaveInFlight;
  }
  settingsSaveInFlight = (async () => {
    let keepalive = options.keepalive === true;
    do {
      settingsSaveAgain = false;
      keepalive ||= settingsSaveKeepalive;
      settingsSaveKeepalive = false;
      await persistSettings({ keepalive });
      keepalive = false;
    } while (settingsSaveAgain);
  })().finally(() => {
    settingsSaveInFlight = undefined;
  });
  return settingsSaveInFlight;
}
function save(immediate = false) {
  if (!isMainSession || !settingsReady) return;
  const serialized = JSON.stringify(settings);
  try {
    localStorage.setItem(SETTINGS_MAIN_KEY, serialized);
  } catch {
    /* Storage is optional. */
  }
  settingsChannel?.postMessage({ settings, tauriScale: tauriVncScaleFactor });
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = undefined;
  if (immediate) {
    queuePersistSettings();
  } else {
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = undefined;
      queuePersistSettings();
    }, 120);
  }
}
async function flushSettings() {
  if (!isMainSession || !settingsReady) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = undefined;
  if (settingsSaveInFlight) await settingsSaveInFlight;
  await queuePersistSettings();
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
const connectionModeLabels = {
  vnc: "标准 VNC",
  video: "WebRTC 视频流",
};
const videoBitrateLabels = {
  lossless: "默认",
  high: "高",
  balanced: "均衡",
  low: "低",
};
const vncBitrateOptions = {
  lossless: "无损 · 画质优先",
  high: "高 · 约 8 级 JPEG",
  balanced: "均衡 · 约 6 级 JPEG",
  low: "低 · 约 3 级 JPEG",
};
const videoBitrateOptions = {
  lossless: "默认 · 配置目标码率",
  high: "高 · 8 Mbps 目标",
  balanced: "均衡 · 4 Mbps 目标",
  low: "低 · 1.5 Mbps 目标",
};
const videoBitrateTargets = {
  lossless: "配置默认目标码率",
  high: "8 Mbps 目标",
  balanced: "4 Mbps 目标",
  low: "1.5 Mbps 目标",
};
function selectedTransportMode() {
  return connected ? activeConnectionMode : settings.connectionMode;
}
function currentBitrateLabel() {
  return selectedTransportMode() === "video"
    ? videoBitrateLabels[settings.bitrate]
    : bitrateLabels[settings.bitrate];
}
function currentFrameRateLabel() {
  if (settings.frameRate === 0 && selectedTransportMode() === "video")
    return "最高 · 60 FPS";
  return frameRateLabels[settings.frameRate];
}
function updateTransportSettingsPresentation() {
  const video = selectedTransportMode() === "video";
  const bitrate = $("bitrate");
  $("bitrate-label").textContent = video ? "视频码率档位" : "VNC 图像质量";
  bitrate.setAttribute("aria-label", video ? "视频码率档位" : "VNC 图像质量");
  for (const option of bitrate.options)
    option.textContent = (video ? videoBitrateOptions : vncBitrateOptions)[
      option.value
    ];
  $("bitrate-value").textContent = currentBitrateLabel();
  $("bitrate-help").textContent = video
    ? "VP8 始终为有损编码。默认档沿用配置的目标码率；高、均衡、低档分别使用 8、4、1.5 Mbps 目标。实际占用随画面变化。"
    : "VNC 按画面变化压缩，不能承诺固定 Mbps；默认无损，其余档启用 JPEG/Tight 有损编码。";
  const unlimitedFrameRate = $("frame-rate").querySelector('option[value="0"]');
  unlimitedFrameRate.textContent = video ? "最高（视频上限 60 FPS）" : "不限";
  $("frame-rate-value").textContent = currentFrameRateLabel();
  $("frame-rate-help").textContent = video
    ? "视频流会按此上限限制 VP8 编码帧率；0 表示尽可能快，最高 60 FPS。实际帧率取决于编码器和网络。"
    : "限制 VNC 帧请求频率；0 表示不限。远端分辨率不会改变。";
  $("transport-mode").textContent = video
    ? `VP8 · ${videoBitrateTargets[settings.bitrate]}`
    : settings.bitrate === "lossless"
      ? "无损 · ZRLE 优先"
      : `${bitrateLabels[settings.bitrate]} · JPEG/Tight`;
}
function syncSettingsControls() {
  $("wheel").value = settings.wheel;
  $("wheel-value").textContent = `${settings.wheel}%`;
  $("view-only").checked = settings.viewOnly;
  $("clipboard-sync").checked = settings.clipboardSync;
  $("connection-mode").value = settings.connectionMode;
  $("connection-mode-settings").textContent =
    connectionModeLabels[
      connected ? activeConnectionMode : settings.connectionMode
    ];
  $("connection-mode").disabled =
    connected || !isMainSession || !isTauriShell();
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
  const previousVideoSettings = `${settings.bitrate}:${settings.frameRate}`;
  settings = normalizeSettings({ ...settings, ...value });
  const videoSettingsChanged =
    previousVideoSettings !== `${settings.bitrate}:${settings.frameRate}`;
  if (!isMainSession && isTauriShell() && settings.vncScale !== null) {
    inheritedTauriScale = settings.vncScale;
    preferredTauriScale = settings.vncScale;
    tauriVncScaleFactor = settings.vncScale;
    tauriVncResizeKey = undefined;
  }
  if (isMainSession && !requestedTauriScale && settings.vncScale !== null) {
    tauriVncScaleFactor = settings.vncScale;
    preferredTauriScale = settings.vncScale;
    tauriVncResizeKey = undefined;
  }
  syncSettingsControls();
  setInteractive();
  if (connected && previousClipboardSync !== settings.clipboardSync)
    startClipboardSync();
  if (videoSettingsChanged && connected && activeConnectionMode === "video")
    scheduleVideoSettingsRestart();
}
function setFrameRate(value, persist = true) {
  const frameRate = Number(value);
  const previousFrameRate = settings.frameRate;
  settings.frameRate = Object.hasOwn(frameRateLabels, frameRate)
    ? frameRate
    : 30;
  $("frame-rate").value = String(settings.frameRate);
  updateTransportSettingsPresentation();
  if (rfb && activeConnectionMode !== "video")
    rfb.frameRate = settings.frameRate;
  geometry();
  if (previousFrameRate !== settings.frameRate) scheduleVideoSettingsRestart();
  if (persist) save();
}
function setBitrate(mode, persist = true) {
  const previousBitrate = settings.bitrate;
  settings.bitrate = bitrateLabels[mode] ? mode : "lossless";
  $("bitrate").value = settings.bitrate;
  updateTransportSettingsPresentation();
  if (rfb && activeConnectionMode !== "video")
    rfb.bitrateMode = settings.bitrate;
  geometry();
  if (previousBitrate !== settings.bitrate) scheduleVideoSettingsRestart();
  if (persist) save();
}
function scale(mode, persist = true) {
  const changed = settings.scale !== mode;
  settings.scale = mode;
  if (mode === "actual") pendingTauriWindowSize = undefined;
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
    const savedMainScale =
      isMainSession && !persist
        ? normalizeVncScale(settings.vncScale)
        : undefined;
    const forcedScale =
      inheritedChildScale ?? (mode === "actual" ? 1 : savedMainScale);
    if (forcedScale !== undefined && forcedScale !== null) {
      preferredTauriScale = forcedScale;
      tauriVncScaleFactor = forcedScale;
    } else if (isMainSession && persist && mode === "fit") {
      preferredTauriScale = undefined;
      tauriVncScaleFactor = undefined;
    }
    if (
      isMainSession &&
      persist &&
      forcedScale !== undefined &&
      forcedScale !== null
    )
      rememberMainTauriScale(forcedScale);
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
let pendingTauriWindowSize;
let disconnectedTauriWindowResized = false;
let trackDisconnectedTauriResize = false;
function currentTauriWindow() {
  return globalThis.__TAURI__?.window?.getCurrentWindow?.();
}
function refocusMainViewerAfterChildClose() {
  if (!isMainSession || !isTauriShell()) return;
  const current = currentTauriWindow();
  const canvas = $("screen").querySelector("canvas");
  debugClient("main-refocus-start", {
    connected,
    focused: document.hasFocus(),
    canvas: canvas
      ? {
          width: canvas.width,
          height: canvas.height,
          cssWidth: canvas.getBoundingClientRect().width,
          cssHeight: canvas.getBoundingClientRect().height,
        }
      : null,
  });
  setTimeout(() => {
    void Promise.resolve(current?.setFocus?.())
      .catch((error) => {
        debugClient("main-refocus-error", {
          message: error?.message || String(error),
        });
      })
      .finally(() => {
        if (!connected) return;
        rfb?.resetPointerState?.();
        rfb?.focus({ preventScroll: true });
        debugClient("main-refocus-done", {
          focused: document.hasFocus(),
          active: document.activeElement?.tagName || null,
        });
        requestRemoteWindowActivation();
      });
  }, 0);
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
  const pendingScale =
    isMainSession &&
    settings.scale !== "actual" &&
    pendingTauriWindowSize &&
    pendingTauriWindowSize.width > 0 &&
    pendingTauriWindowSize.height > 0
      ? Math.max(
          0.05,
          Math.min(
            1,
            (pendingTauriWindowSize.width - chromeWidth) / canvas.width,
            (pendingTauriWindowSize.height - chromeHeight) / canvas.height,
          ),
        )
      : undefined;
  const scaleFactor =
    pendingScale ??
    preferredTauriScale ??
    tauriVncScaleFactor ??
    autoScaleFactor;
  if (isMainSession) {
    const changed =
      tauriVncScaleFactor === undefined ||
      Math.abs(tauriVncScaleFactor - scaleFactor) > 0.001;
    tauriVncScaleFactor = scaleFactor;
    if (pendingScale !== undefined) preferredTauriScale = scaleFactor;
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
    if (pendingScale !== undefined) {
      rememberMainTauriScale(scaleFactor);
      pendingTauriWindowSize = undefined;
    }
  } catch (error) {
    tauriVncResizeKey = undefined;
    if (settingsReady)
      toast(`自动调整窗口失败：${error.message || "权限不足"}`);
  } finally {
    tauriVncResizeInFlight = false;
  }
}
function rememberMainTauriScale(value) {
  if (!isTauriShell() || !isMainSession) return;
  const normalized = normalizeVncScale(value);
  if (normalized === null) return;
  const changed =
    tauriVncScaleFactor === undefined ||
    Math.abs(tauriVncScaleFactor - normalized) > 0.002;
  tauriVncScaleFactor = normalized;
  preferredTauriScale = normalized;
  if (settings.vncScale === normalized && !changed) return;
  settings.vncScale = normalized;
  debugClient("scale-remembered", {
    scale: normalized,
    settingsReady,
    connected,
  });
  if (settingsReady) {
    save(true);
  } else {
    try {
      localStorage.setItem(SETTINGS_MAIN_KEY, JSON.stringify(settings));
    } catch {
      /* Storage is optional. */
    }
  }
}
function syncMainTauriScaleFromViewport(canvas) {
  if (!isTauriShell() || !isMainSession || !canvas?.width)
    return tauriVncScaleFactor;
  const screenRect = $("screen").getBoundingClientRect();
  // During a native resize noVNC may update the canvas style one animation
  // frame after the WebView resize event. Use the actual VNC area instead of
  // the stale canvas rectangle so the user's native window size is persisted.
  const displayedWidth = screenRect.width;
  const displayedHeight = screenRect.height;
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
  rememberMainTauriScale(normalized);
  return normalized;
}
function geometry(resizeWindow = false) {
  const canvas = $("screen").querySelector("canvas");
  if (!canvas?.width) return;
  const percent = Math.round(
    (canvas.getBoundingClientRect().width / canvas.width) * 100,
  );
  $("geometry").textContent =
    `${canvas.width} × ${canvas.height} · ${percent}% · ${currentBitrateLabel()} · ${currentFrameRateLabel()}`;
  const video = $("video-stream");
  if (!video.hidden) {
    const screenRect = $("screen").getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    video.style.left = `${canvasRect.left - screenRect.left}px`;
    video.style.top = `${canvasRect.top - screenRect.top}px`;
    video.style.right = "auto";
    video.style.bottom = "auto";
    video.style.width = `${canvasRect.width}px`;
    video.style.height = `${canvasRect.height}px`;
  }
  if (resizeWindow) {
    if (
      isTauriShell() &&
      isMainSession &&
      tauriVncScaleFactor === undefined &&
      preferredTauriScale === undefined
    )
      syncMainTauriScaleFromViewport(canvas);
    void resizeTauriWindowToVnc();
  } else syncMainTauriScaleFromViewport(canvas);
  imeOverlay?.position();
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-PenguX11VNC-Token", token || "");
  return fetch(path, { ...options, headers });
}
function recordConnectionDiagnostic(event, details = {}) {
  const record = sanitizeDiagnosticEvent(event, details);
  if (!record) return;
  connectionDiagnostics.push(record);
  if (connectionDiagnostics.length > 30) connectionDiagnostics.shift();
}
function coarsePlatform() {
  const platform = String(navigator.platform || "").toLowerCase();
  if (platform.includes("mac")) return "macOS";
  if (platform.includes("win")) return "Windows";
  if (platform.includes("linux")) return "Linux";
  return "unknown";
}
function showDisconnectReport({ transport, clean, reason, videoFailure }) {
  clearTimeout(disconnectReportTimer);
  if (pageLeaving) return;
  disconnectReportTimer = setTimeout(() => {
    disconnectReportTimer = undefined;
    if (pageLeaving) return;
    const generatedAt = new Date().toISOString();
    $("disconnect-report").value = buildDisconnectReport({
      generatedAt,
      connectionStartedAt,
      runtime: isTauriShell() ? "Tauri" : "Browser",
      platform: coarsePlatform(),
      transport,
      sessionType: isMainSession ? "main" : "child",
      frameRate: settings.frameRate,
      bitrateMode: settings.bitrate,
      autoRecovery: isMainSession && connectionWanted,
      clean,
      reason,
      videoFailure,
      events: connectionDiagnostics,
    });
    $("disconnect-report-copy-status").textContent =
      "报告仅保留连接状态与统计信息；不会自动发送。";
    const dialog = $("disconnect-report-dialog");
    if (!dialog.open) {
      void setMacRemoteShortcuts(false);
      dialog.showModal();
      $("disconnect-report").focus();
      updateMacRemoteShortcuts();
    }
  }, 250);
}
function debugClient(event, details = {}) {
  recordConnectionDiagnostic(event, details);
  if (!debugClientEnabled) return;
  void api(`/api/debug?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, details }),
  }).catch(() => {});
}
globalThis.penguX11VNCLog = debugClient;
async function activateRemoteWindow() {
  if (
    !isTauriShell() ||
    !connected ||
    settings.viewOnly ||
    remoteActivationInFlight
  )
    return;
  remoteActivationInFlight = true;
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/activate`, {
      method: "POST",
    });
  } catch {
    // Activation is a convenience; it must not interrupt the VNC session.
  } finally {
    remoteActivationInFlight = false;
  }
}
function requestRemoteWindowActivation() {
  if (!isTauriShell() || !connected || settings.viewOnly) return;
  clearTimeout(remoteActivationTimer);
  remoteActivationTimer = setTimeout(() => {
    remoteActivationTimer = undefined;
    void activateRemoteWindow();
  }, 60);
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
    const loaded = { ...data.settings };
    if (loaded.vncScale == null && settings.vncScale !== null)
      loaded.vncScale = settings.vncScale;
    applySettings(loaded);
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
    debugClientEnabled = data.debug === true;
    globalThis.penguX11VNCDebug = debugClientEnabled;
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
    remoteWindowId = data.session?.windowId;
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
        "connection-mode",
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
    if (isMainSession) {
      setTimeout(() => {
        trackDisconnectedTauriResize = true;
      }, 250);
      if (settings.vncScale !== null) await flushSettings();
    }
  }
}

function panel(open) {
  $("settings").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
  if (open) rfb?.blur();
  else if (connected) rfb?.focus();
}
async function readSystemClipboardText() {
  if (isTauriShell()) return tauriInvoke("read_clipboard_text");
  if (!navigator.clipboard?.readText)
    throw new Error("当前环境不支持剪贴板读取");
  return navigator.clipboard.readText();
}
async function writeSystemClipboardText(text) {
  if (isTauriShell()) return tauriInvoke("write_clipboard_text", { text });
  if (!navigator.clipboard?.writeText)
    throw new Error("当前环境不支持剪贴板写入");
  return navigator.clipboard.writeText(text);
}
function stopClipboardSync() {
  clearInterval(clipboardTimer);
  clipboardTimer = undefined;
  localClipboardValue = undefined;
  remoteClipboardValue = undefined;
}
async function pollClipboard() {
  if (!connected || !settings.clipboardSync) return;
  try {
    const text = await readSystemClipboardText();
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
  } catch (error) {
    $("clipboard-status").textContent = isTauriShell()
      ? `无法读取本机剪贴板：${error?.message || error}`
      : "浏览器未授予剪贴板权限；点击页面后可重试。";
  }
}
async function startClipboardSync() {
  stopClipboardSync();
  if (!settings.clipboardSync) {
    $("clipboard-status").textContent = "当前关闭：不会读取或写入本机剪贴板。";
    return;
  }
  if (!isTauriShell() && !navigator.clipboard) {
    $("clipboard-status").textContent = "当前浏览器不支持剪贴板 API。";
    return;
  }
  $("clipboard-status").textContent = isTauriShell()
    ? "同步已开启；通过系统剪贴板接口读取本机内容。"
    : "同步已开启；正在请求本页剪贴板权限。";
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
const isMacPlatform = /Mac|iPhone|iPad/.test(
  `${navigator.platform || ""} ${navigator.userAgent || ""}`,
);
let macRemoteShortcutsEnabled = false;
let macRemoteShortcutRequest = 0;
async function setMacRemoteShortcuts(enabled) {
  if (!isMacPlatform || !isTauriShell()) return;
  if (macRemoteShortcutsEnabled === enabled) return;
  const request = ++macRemoteShortcutRequest;
  try {
    await tauriInvoke("set_macos_remote_shortcuts", { enabled });
    if (request === macRemoteShortcutRequest)
      macRemoteShortcutsEnabled = enabled;
  } catch (error) {
    debugClient("macos-shortcut-menu-unavailable", {
      name: error?.name || "Error",
      message: error?.message || String(error),
    });
  }
}
function updateMacRemoteShortcuts() {
  const target = document.activeElement;
  const onScreen = target instanceof Element && !!target.closest("#screen");
  void setMacRemoteShortcuts(onScreen && connected && !settings.viewOnly);
}
function activeEditableElement() {
  const target = document.activeElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable
  )
    return target;
  return undefined;
}
function insertTextIntoEditable(target, text) {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, "end");
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  if (target?.isContentEditable) {
    return document.execCommand("insertText", false, text);
  }
  return false;
}
async function handleNativeEditableShortcut(key, target) {
  if (key === "v") {
    try {
      const text = await readSystemClipboardText();
      if (typeof text === "string") insertTextIntoEditable(target, text);
    } catch (error) {
      toast(`无法读取本机文字剪贴板：${error?.message || error}`);
    }
    return;
  }
  if (key === "c" || key === "x") {
    if (document.execCommand(key === "c" ? "copy" : "cut")) return;
    const selection = target?.value?.slice(
      target.selectionStart ?? 0,
      target.selectionEnd ?? 0,
    );
    if (selection) {
      try {
        await writeSystemClipboardText(selection);
      } catch (error) {
        toast(`无法写入本机文字剪贴板：${error?.message || error}`);
        return;
      }
      if (key === "x") {
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? start;
        target.setRangeText("", start, end, "start");
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }
}
function nativeViewerPasteEvent() {
  const canvas = $("screen").querySelector("canvas");
  return {
    key: "v",
    code: "KeyV",
    location: 0,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: true,
    repeat: false,
    nativeShortcut: true,
    target: canvas,
    preventDefault() {},
    stopPropagation() {},
  };
}
async function setupTauriNativeShortcuts() {
  if (!isTauriShell()) return;
  const listen = globalThis.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  try {
    await listen("pengux11vnc://native-shortcut", (event) => {
      const key = String(event.payload?.key || "").toLowerCase();
      if (!(key === "c" || key === "v" || key === "x")) return;
      const target = activeEditableElement();
      if (target) {
        // Native menu shortcuts in all local inputs (especially VNC passwords)
        // use the host clipboard and never become remote Ctrl shortcuts.
        void handleNativeEditableShortcut(key, target);
        return;
      }
      if (event.payload?.localOnly || !connected || settings.viewOnly) return;
      if (key === "v") void handleViewerPasteShortcut(nativeViewerPasteEvent());
      else rfb?.sendCtrlShortcut?.(key);
    });
  } catch (error) {
    debugClient("native-shortcut-unavailable", {
      name: error?.name || "Error",
      message: error?.message || String(error),
    });
  }
}
async function setupTauriFileDrop() {
  if (!isTauriShell() || !isMainSession) return;
  const listen = globalThis.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  const setDropActive = (active) =>
    document.body.classList.toggle("file-drop-active", active);
  try {
    await listen("tauri://drag-enter", (event) => {
      setDropActive(true);
      debugClient("file-drop-enter", {
        count: Array.isArray(event.payload?.paths)
          ? event.payload.paths.length
          : 0,
      });
    });
    await listen("tauri://drag-over", () => setDropActive(true));
    await listen("tauri://drag-leave", () => setDropActive(false));
    await listen("tauri://drag-drop", (event) => {
      setDropActive(false);
      const paths = Array.isArray(event.payload?.paths)
        ? event.payload.paths.filter((path) => typeof path === "string")
        : [];
      if (!paths.length) {
        const pasteShortcut = isMacPlatform ? "Cmd+V" : "Ctrl+V";
        const message = `已收到文件拖放事件，但系统没有提供文件路径；可尝试复制文件后按 ${pasteShortcut}。`;
        $("clipboard-files-status").textContent = message;
        toast(message);
        debugClient("file-drop-empty", {
          payloadType: typeof event.payload,
          pathCount: Array.isArray(event.payload?.paths)
            ? event.payload.paths.length
            : 0,
        });
        return;
      }
      debugClient("file-drop", { count: paths.length });
      void sendDroppedFiles(paths);
    });
  } catch (error) {
    debugClient("file-drop-unavailable", {
      name: error?.name || "Error",
      message: error?.message || String(error),
    });
  }
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
  if (!entry || entry.cleanupInFlight) return false;
  entry.cleanupInFlight = true;
  try {
    const response = await api(
      `/api/sessions/${encodeURIComponent(entry.sessionId)}?session=main`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404)
      throw new Error("子窗口会话清理失败");
    if (window.openedChildWindows?.get(key) === entry) {
      clearTimeout(entry.cleanupRetryTimer);
      entry.cleanupRetryTimer = undefined;
      window.openedChildWindows.delete(key);
    }
    return true;
  } catch {
    // Keep the entry so the next poll or reconnect can retry cleanup.
    if (
      window.openedChildWindows?.get(key) === entry &&
      !entry.cleanupRetryTimer
    ) {
      entry.cleanupRetryTimer = setTimeout(() => {
        entry.cleanupRetryTimer = undefined;
        void cleanupChildEntry(key, entry);
      }, 1000);
    }
    return false;
  } finally {
    entry.cleanupInFlight = false;
  }
}
async function closeChildEntry(key, entry) {
  if (!entry) return false;
  // Await native IPC before forgetting the window. A rejected close must leave
  // the entry available for the next poll; requesting close is not destruction.
  if (!entry.closed && !entry.closeInFlight && !entry.closeRequested) {
    entry.closeInFlight = true;
    try {
      entry.closeRequested = true;
      await entry.window.close();
    } catch (error) {
      entry.closeRequested = false;
      throw error;
    } finally {
      entry.closeInFlight = false;
    }
  }
  // Native close() acknowledges the request before Destroyed is delivered.
  // Keep tracking the window until that event; its handler performs cleanup.
  if (!entry.tauri || entry.closed) return cleanupChildEntry(key, entry);
  return false;
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
  let childSessionId;
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
    childSessionId = data.session?.id;
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
        entry.closeRequested = false;
        debugClient("child-destroyed", {
          key,
          sessionId: entry.sessionId,
          windowId: info.id,
        });
        refocusMainViewerAfterChildClose();
        void cleanupChildEntry(key, entry);
      };
      // Do not register onCloseRequested: Tauri then prevents the OS close
      // and relies on JS destroy(). Native Rust cleanup already runs off-thread.
      await child.once("tauri://destroyed", markClosed);
    }
    window.openedChildWindows.set(key, entry);
    renderChildWindows(window.lastChildWindows || []);
  } catch (error) {
    if (childSessionId)
      await api(
        `/api/sessions/${encodeURIComponent(childSessionId)}?session=main`,
        { method: "DELETE" },
      ).catch(() => {});
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
    const visibleWindows = windows.filter((info) => info.mapped !== false);
    window.lastChildWindows = visibleWindows;
    window.openedChildWindows ??= new Map();
    const knownKeys = new Set(windows.map((info) => info.id.toLowerCase()));
    for (const [key, entry] of window.openedChildWindows) {
      const childClosed =
        entry.closed === true ||
        (!entry.tauri && entry.window?.closed === true);
      const remoteClosed = !knownKeys.has(key);
      if (!childClosed && !remoteClosed) continue;
      if (childClosed) await cleanupChildEntry(key, entry);
      else await closeChildEntry(key, entry);
    }
    $("child-status").textContent = visibleWindows.length
      ? `发现 ${visibleWindows.length} 个 QQ 子窗口。`
      : "没有可见的 QQ 子窗口。";
    renderChildWindows(visibleWindows);
    if (!settings.autoChildOpen) return;
    for (const info of visibleWindows) {
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
  if (event.nativeShortcut) {
    rfb?.sendCtrlShortcut?.("v");
    return;
  }
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
function confirmFileUpload(files, total) {
  const dialog = $("file-upload-dialog");
  const summary = $("file-upload-summary");
  const list = $("file-upload-list");
  summary.textContent = `将 ${files.length} 个文件（${formatFileSize(total)}）上传到远端 Downloads？`;
  list.replaceChildren(
    ...files.map((file) => {
      const item = document.createElement("li");
      item.textContent = `${file.name}（${formatFileSize(Number(file.size) || 0)}）`;
      return item;
    }),
  );
  dialog.returnValue = "";
  const confirmed = new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "upload"),
      { once: true },
    );
  });
  dialog.showModal();
  return confirmed;
}

async function sendFiles(loadFiles, uploadCommand, rememberClipboard) {
  if (fileUploadInFlight) return;
  fileUploadInFlight = true;
  const status = $("clipboard-files-status");
  try {
    const files = await loadFiles();
    if (!Array.isArray(files) || files.length === 0) {
      status.textContent = "没有检测到可用文件。";
      return;
    }
    const total = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const summary = files
      .map(
        (file) => `${file.name}（${formatFileSize(Number(file.size) || 0)}）`,
      )
      .join("、");
    if (!(await confirmFileUpload(files, total))) {
      status.textContent = "已取消文件上传。";
      return;
    }
    status.textContent = `正在上传 ${files.length} 个文件（${formatFileSize(total)}），请稍候……`;
    const result = await tauriInvoke(uploadCommand, {
      paths: files.map((file) => file.path),
    });
    const names = result.files?.map((file) => file.name).join("、") || summary;
    status.textContent = `已上传到远端 Downloads：${names}。请在 QQ 中手动粘贴。`;
    if (rememberClipboard)
      remoteFilePasteSignature = clipboardFilesSignature(files);
    toast("文件已上传并写入远端 Linux 文件剪贴板，请在 QQ 中按 Ctrl+V。 ");
  } catch (error) {
    reportClipboardFileError(error);
  } finally {
    fileUploadInFlight = false;
    setInteractive();
  }
}
function sendClipboardFiles(preloadedFiles) {
  return sendFiles(
    () => preloadedFiles ?? tauriInvoke("read_clipboard_files"),
    "upload_clipboard_files",
    true,
  );
}
function sendDroppedFiles(paths) {
  if (!connected || settings.viewOnly || !isTauriShell() || !isMainSession) {
    if (!connected) toast("请先连接后再拖放文件。");
    return;
  }
  return sendFiles(
    () => tauriInvoke("inspect_files", { paths }),
    "upload_files",
    false,
  );
}
function waitForIceGathering(peer, timeoutMs = 5000) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    peer.addEventListener("icegatheringstatechange", onStateChange);
    timer = setTimeout(done, timeoutMs);
  });
}
function scheduleVideoSettingsRestart() {
  if (!connected || activeConnectionMode !== "video" || !videoPeer) return;
  clearTimeout(videoSettingsRestartTimer);
  videoSettingsRestartTimer = setTimeout(() => {
    videoSettingsRestartTimer = undefined;
    if (!connected || activeConnectionMode !== "video" || !videoPeer) return;
    $("video-status").textContent = "正在重新协商视频码率与帧率……";
    void (async () => {
      await stopVideoStream("正在应用视频设置", false);
      if (connected && activeConnectionMode === "video")
        await startVideoStream();
    })();
  }, 300);
}
async function stopVideoStream(reason = "", resumeRfb = true) {
  clearTimeout(videoSettingsRestartTimer);
  videoSettingsRestartTimer = undefined;
  videoEpoch++;
  videoActive = false;
  clearInterval(videoReceiverTimer);
  videoReceiverTimer = undefined;
  document.body.classList.remove("video-active");
  if (resumeRfb) document.body.classList.remove("video-pending");
  else document.body.classList.add("video-pending");
  const peer = videoPeer;
  videoPeer = undefined;
  peer?.close();
  const video = $("video-stream");
  video.hidden = true;
  video.srcObject = null;
  if (rfb) rfb.videoMode = !resumeRfb;
  if (reason && connected) $("connection-method").textContent = reason;
  if (isTauriShell() && token) {
    await api(`/api/video/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }).catch(() => {});
  }
}
function summarizeVideoSdp(sdp) {
  const lines = String(sdp || "").split(/\r?\n/);
  const find = (prefix) =>
    lines.find((line) => line.startsWith(prefix)) || null;
  return {
    media: find("m=video "),
    direction:
      find("a=sendrecv") ||
      find("a=sendonly") ||
      find("a=recvonly") ||
      find("a=inactive"),
    setup: find("a=setup:"),
    mid: find("a=mid:"),
    candidateCount: lines.filter((line) => line.startsWith("a=candidate:"))
      .length,
    codecs: lines
      .filter((line) => line.startsWith("a=rtpmap:"))
      .map((line) => line.replace(/^a=rtpmap:/, "")),
  };
}
async function collectVideoStats(peer) {
  try {
    const report = await peer.getStats();
    const stats = { inbound: [], transport: [], candidatePairs: [] };
    report.forEach((stat) => {
      if (
        stat.type === "inbound-rtp" &&
        (stat.kind || stat.mediaType) === "video"
      ) {
        stats.inbound.push({
          packetsReceived: stat.packetsReceived || 0,
          bytesReceived: stat.bytesReceived || 0,
          framesReceived: stat.framesReceived || 0,
          framesDecoded: stat.framesDecoded || 0,
          keyFramesDecoded: stat.keyFramesDecoded || 0,
        });
      } else if (stat.type === "transport") {
        stats.transport.push({
          dtlsState: stat.dtlsState || null,
          iceState: stat.iceState || null,
          selectedCandidatePairId: stat.selectedCandidatePairId || null,
        });
      } else if (
        stat.type === "candidate-pair" &&
        (stat.nominated || stat.selected)
      ) {
        stats.candidatePairs.push({
          state: stat.state || null,
          nominated: stat.nominated === true,
          bytesSent: stat.bytesSent || 0,
          bytesReceived: stat.bytesReceived || 0,
        });
      }
    });
    return stats;
  } catch {
    return { inbound: [], transport: [], candidatePairs: [] };
  }
}
async function failVideoStream(error, peerState = "unknown/unknown") {
  if (videoFailureMessage) return;
  const message = `视频流不可用：${error?.message || String(error)}（${peerState}）。未自动回退 VNC，请切换“标准 VNC”后重新连接。`;
  videoFailureDetails = {
    name: error?.name || "Error",
    connectionState: videoPeer?.connectionState || "unknown",
    iceConnectionState: videoPeer?.iceConnectionState || "unknown",
  };
  debugClient("video-failure", {
    sessionId,
    ...videoFailureDetails,
  });
  videoFailureMessage = message;
  await stopVideoStream("视频流失败 · 未连接", false);
  if (rfb) rfb.disconnect();
}
function formatVideoBitrate(kbps) {
  const value = Number(kbps);
  if (!Number.isFinite(value) || value <= 0) return "配置码率";
  const mbps = value / 1000;
  return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mbps`;
}
async function startVideoStream() {
  if (
    activeConnectionMode !== "video" ||
    !isTauriShell() ||
    !connected ||
    videoPeer
  )
    return;
  if (typeof RTCPeerConnection !== "function") {
    await failVideoStream(new Error("当前 WebView 不支持 WebRTC"));
    return;
  }
  const epoch = ++videoEpoch;
  const streamOptions = videoStreamOverrides(settings);
  if (rfb) rfb.videoMode = true;
  document.body.classList.add("video-pending");
  debugClient("video-start", { sessionId, epoch, ...streamOptions });
  const video = $("video-stream");
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  const peer = new RTCPeerConnection({ iceServers: [] });
  let resolveFirstFrame;
  const firstFrame = new Promise((resolve) => {
    resolveFirstFrame = resolve;
  });
  const activateVideo = () => {
    if (epoch !== videoEpoch || videoActive) return;
    videoActive = true;
    debugClient("video-first-frame", {
      sessionId,
      width: video.videoWidth,
      height: video.videoHeight,
      readyState: video.readyState,
    });
    video.hidden = false;
    document.body.classList.remove("video-pending");
    document.body.classList.add("video-active");
    rfb.videoMode = true;
    geometry(false);
    $("connection-method").textContent = "WebRTC/VP8 视频 · RFB 输入";
    resolveFirstFrame();
  };
  videoPeer = peer;
  video.hidden = false;
  peer.addTransceiver("video", { direction: "recvonly" });
  let mediaAttached = false;
  const attachVideoStream = (stream, source) => {
    if (
      mediaAttached ||
      epoch !== videoEpoch ||
      !stream ||
      typeof stream.getVideoTracks !== "function" ||
      stream.getVideoTracks().length === 0
    )
      return;
    mediaAttached = true;
    debugClient("video-track", {
      sessionId,
      source,
      streams: 1,
      track: stream.getVideoTracks()[0]?.kind || null,
    });
    const markFirstFrame = () => activateVideo();
    let playStarted = false;
    const play = () => {
      if (playStarted || epoch !== videoEpoch || video.srcObject !== stream)
        return;
      playStarted = true;
      void video
        .play()
        .then(() => {
          if (typeof video.requestVideoFrameCallback === "function")
            video.requestVideoFrameCallback(markFirstFrame);
          else setTimeout(markFirstFrame, 100);
        })
        .catch((error) => {
          const cleanupAbort =
            error?.name === "AbortError" &&
            (epoch !== videoEpoch || video.srcObject !== stream);
          if (!cleanupAbort)
            debugClient("video-play-error", {
              sessionId,
              name: error?.name || "Error",
            });
          if (error?.name === "AbortError" && !cleanupAbort) {
            playStarted = false;
            setTimeout(play, 250);
          }
        });
    };
    video.addEventListener("loadeddata", markFirstFrame, { once: true });
    video.addEventListener("playing", markFirstFrame, { once: true });
    video.addEventListener("loadedmetadata", play, { once: true });
    video.srcObject = null;
    video.srcObject = stream;
    play();
  };
  peer.addEventListener("track", (event) => {
    if (epoch !== videoEpoch) return;
    attachVideoStream(
      event.streams?.[0] || new MediaStream([event.track]),
      "track",
    );
  });
  peer.addEventListener("addstream", (event) => {
    if (epoch !== videoEpoch) return;
    attachVideoStream(event.stream, "addstream");
  });
  const logPeerState = (event) => {
    if (videoPeer !== peer) return;
    debugClient("video-connection-state", {
      sessionId,
      event,
      state: peer.connectionState,
      ice: peer.iceConnectionState,
      gathering: peer.iceGatheringState,
      signaling: peer.signalingState,
    });
  };
  peer.addEventListener("connectionstatechange", () => {
    logPeerState("connection");
    if (peer.connectionState === "failed")
      void failVideoStream(
        new Error("WebRTC 连接失败"),
        `${peer.connectionState}/${peer.iceConnectionState}`,
      );
    else if (peer.connectionState === "disconnected")
      setTimeout(() => {
        if (
          videoPeer === peer &&
          ["failed", "disconnected"].includes(peer.connectionState)
        )
          void failVideoStream(
            new Error("WebRTC 连接断开"),
            `${peer.connectionState}/${peer.iceConnectionState}`,
          );
      }, 1500);
  });
  peer.addEventListener("iceconnectionstatechange", () => logPeerState("ice"));
  peer.addEventListener("signalingstatechange", () =>
    logPeerState("signaling"),
  );
  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    if (epoch !== videoEpoch || !peer.localDescription?.sdp) return;
    const response = await api(
      `/api/video/${encodeURIComponent(sessionId)}/offer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: peer.localDescription.type,
          sdp: peer.localDescription.sdp,
          ...streamOptions,
        }),
      },
    );
    if (!response.ok)
      throw new Error((await response.text()) || "视频流启动失败");
    const result = await response.json();
    if (epoch !== videoEpoch || videoPeer !== peer) return;
    debugClient("video-answer", {
      sessionId,
      codec: result.codec || "unknown",
      sdpLength: result.answer?.sdp?.length || 0,
      hasVideo: /(^|\n)m=video /m.test(result.answer?.sdp || ""),
      fps: result.fps,
      bitrateKbps: result.bitrateKbps,
      local: summarizeVideoSdp(peer.localDescription?.sdp),
      remote: summarizeVideoSdp(result.answer?.sdp),
    });
    await peer.setRemoteDescription(result.answer);
    videoReceiverTimer = setInterval(() => {
      if (epoch !== videoEpoch || mediaAttached || videoPeer !== peer) {
        clearInterval(videoReceiverTimer);
        videoReceiverTimer = undefined;
        return;
      }
      const tracks = (peer.getReceivers?.() || [])
        .map((receiver) => receiver.track)
        .filter(
          (track) => track?.kind === "video" && track.readyState === "live",
        );
      if (tracks.length) attachVideoStream(new MediaStream(tracks), "receiver");
    }, 100);
    await Promise.race([
      firstFrame,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("视频首帧超时")), 10000),
      ),
    ]);
    if (epoch !== videoEpoch) return;
    const effectiveFrameRate = Number(result.fps) || streamOptions.fps;
    const effectiveBitrate = Number(result.bitrateKbps);
    $("video-status").textContent =
      `WebRTC / ${result.codec || "VP8"} · ${effectiveFrameRate} FPS · ${formatVideoBitrate(effectiveBitrate)} · UDP ${result.portMin}-${result.portMax}`;
    $("transport-mode").textContent =
      `VP8 · ${formatVideoBitrate(effectiveBitrate)} · ${effectiveFrameRate} FPS`;
  } catch (error) {
    if (epoch !== videoEpoch) return;
    debugClient("video-error", {
      sessionId,
      name: error?.name || "Error",
    });
    const peerState = `${peer.connectionState || "unknown"}/${peer.iceConnectionState || "unknown"}`;
    debugClient("video-stats", {
      sessionId,
      peerState,
      inbound: await collectVideoStats(peer),
    });
    await failVideoStream(error, peerState);
  }
}
function setInteractive() {
  $("connection-mode").disabled =
    connected || !isMainSession || !isTauriShell();
  $("disconnect").disabled = !connected && !connectionWanted;
  $("send-clipboard").disabled = !connected || settings.viewOnly;
  $("send-clipboard-files").disabled =
    !connected || settings.viewOnly || !isTauriShell() || fileUploadInFlight;
  if (rfb) rfb.viewOnly = settings.viewOnly;
}

async function connect(prepare = true) {
  await sessionReady;
  if (rfb || connecting) return;
  if (isTauriShell() && isMainSession) {
    const width = Math.round(window.innerWidth);
    const height = Math.round(window.innerHeight);
    if (
      width > 0 &&
      height > 0 &&
      (preferredTauriScale === undefined || disconnectedTauriWindowResized)
    )
      pendingTauriWindowSize = { width, height };
    else pendingTauriWindowSize = undefined;
    disconnectedTauriWindowResized = false;
  }
  if (!token) {
    toast("请使用“启动 PenguX11VNC.command”打开，获取本次本地访问凭证。");
    return;
  }
  connecting = true;
  const attempt = ++connectEpoch;
  $("connect").disabled = true;
  state("正在连接", "connecting");
  activeConnectionMode = settings.connectionMode;
  videoFailureMessage = undefined;
  videoFailureDetails = undefined;
  connectionStartedAt = new Date().toISOString();
  connectionDiagnostics.length = 0;
  recordConnectionDiagnostic("connect-attempt", { mode: activeConnectionMode });
  updateTransportSettingsPresentation();
  $("connection-mode-settings").textContent =
    connectionModeLabels[activeConnectionMode];
  $("connection-method").textContent =
    activeConnectionMode === "video" ? "视频模式 · 协商中" : "标准 VNC";
  $("video-status").textContent =
    activeConnectionMode === "video"
      ? "视频模式正在等待首帧，RFB 仅负责控制。"
      : "本次连接使用标准 VNC。";
  $("connection-mode").disabled = true;
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
    if (activeConnectionMode !== "video") {
      client.bitrateMode = settings.bitrate;
      client.frameRate = settings.frameRate;
    }
    client.addEventListener("credentialsrequired", () => {
      void setMacRemoteShortcuts(false).finally(() => {
        if (client !== rfb) return;
        $("password-dialog").showModal();
        $("password").focus();
      });
    });
    client.addEventListener("securityfailure", () => {
      void clearVncPasswordCache();
      stopMainConnection().catch(() => {});
      toast("VNC 认证失败，已停止自动重试。请检查密码后重新连接。");
    });
    client.addEventListener("connect", () => {
      stopChildRecoveryMonitor();
      connected = true;
      debugClient("vnc-connect", { sessionId, child: !isMainSession });
      state("已连接", "connected");
      $("connection-method").textContent =
        activeConnectionMode === "video" ? "视频模式 · 等待首帧" : "标准 VNC";
      if (activeConnectionMode === "video") {
        rfb.videoMode = true;
        document.body.classList.add("video-pending");
      }
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
      updateMacRemoteShortcuts();
      requestRemoteWindowActivation();
      if (activeConnectionMode === "video") void startVideoStream();
    });
    client.addEventListener("disconnect", (event) => {
      const socketClose = client.socketCloseInfo || {};
      debugClient("vnc-disconnect", {
        sessionId,
        clean: event.detail.clean,
        child: !isMainSession,
        socketCloseCode: socketClose.code,
        socketCloseWasClean: socketClose.wasClean,
        socketCloseReasonLength: socketClose.reasonLength,
        socketState: socketClose.state,
      });
      connected = false;
      void setMacRemoteShortcuts(false);
      const disconnectedMode = activeConnectionMode;
      const failure = videoFailureMessage;
      const failureDetails = videoFailureDetails;
      videoFailureMessage = undefined;
      videoFailureDetails = undefined;
      const skipVideoStop = manualDisconnectPending;
      const showReport = !skipVideoStop;
      activeConnectionMode = settings.connectionMode;
      manualDisconnectPending = false;
      if (!skipVideoStop) void stopVideoStream();
      remoteFilePasteSignature = undefined;
      if (isMainSession) void cleanupOpenedChildSessions();
      else if (!event.detail.clean) startChildRecoveryMonitor();
      stopClipboardSync();
      stopChildMonitor();
      clearTimeout(remoteActivationTimer);
      remoteActivationTimer = undefined;
      if (!isMainSession && event.detail.clean) stopChildRecoveryMonitor();
      rfb = undefined;
      resizeObserver?.disconnect();
      frameObserver?.disconnect();
      tauriVncResizeKey = undefined;
      const resetScale = isMainSession
        ? (requestedTauriScale ?? normalizeVncScale(settings.vncScale))
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
      $("connection-method").textContent = failure
        ? "视频流失败 · 未连接"
        : "未连接";
      $("connection-mode-settings").textContent =
        connectionModeLabels[settings.connectionMode];
      updateTransportSettingsPresentation();
      $("video-status").textContent = failure || "连接方式可在主页选择。";
      $("geometry").textContent = "原始像素 · 等比例缩放";
      setInteractive();
      if (showReport)
        showDisconnectReport({
          transport: disconnectedMode,
          clean: event.detail.clean,
          reason: failure
            ? "video-stream-failure"
            : event.detail.clean
              ? "remote-closed-connection"
              : "unexpected-disconnect",
          videoFailure: failureDetails,
        });
      if (showReport && disconnectedMode === "video")
        toast("视频流连接中断，已生成错误报告。");
      else if (!event.detail.clean)
        toast("连接中断，请检查 SSH 隧道或远端 x11vnc。");
    });
    client.addEventListener("clipboard", async (event) => {
      if (!settings.clipboardSync) return;
      const text = event.detail?.text || "";
      remoteClipboardValue = text;
      localClipboardValue = text;
      try {
        await writeSystemClipboardText(text);
        $("clipboard-status").textContent = "已将远端剪贴板写入本机。";
      } catch (error) {
        $("clipboard-status").textContent = isTauriShell()
          ? `远端剪贴板已到达，但系统拒绝写入：${error?.message || error}`
          : "远端剪贴板已到达，但浏览器拒绝写入本机。";
      }
    });
  } catch (error) {
    state("未连接", "disconnected");
    $("connection-method").textContent = "未连接";
    $("video-status").textContent = "连接方式可在主页选择。";
    $("connect").disabled = false;
    setInteractive();
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
function stopChildRecoveryMonitor() {
  childRecoveryEpoch++;
  clearTimeout(childRecoveryTimer);
  childRecoveryTimer = undefined;
}
function startChildRecoveryMonitor() {
  if (isMainSession || !isTauriShell() || !remoteWindowId) return;
  stopChildRecoveryMonitor();
  const epoch = childRecoveryEpoch;
  const tick = async () => {
    if (epoch !== childRecoveryEpoch || connected) return;
    if (connecting) {
      childRecoveryTimer = setTimeout(tick, 250);
      return;
    }
    try {
      debugClient("child-recovery-attempt", { sessionId, remoteWindowId });
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/activate`, {
        method: "POST",
      });
      const response = await api(
        `/api/windows/${encodeURIComponent(remoteWindowId)}/open?session=main`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("子窗口 VNC 尚未恢复");
      await connect(false);
      if (rfb) return;
    } catch {
      // Keep retrying while the native child window remains open.
    }
    if (epoch === childRecoveryEpoch && !connected)
      childRecoveryTimer = setTimeout(tick, 1000);
  };
  childRecoveryTimer = setTimeout(tick, 250);
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
  const client = rfb;
  manualDisconnectPending = Boolean(client);
  void stopVideoStream();
  connectEpoch++;
  stopChildRecoveryMonitor();
  $("connect").disabled = false;
  connectionWanted = false;
  recoveryEpoch++;
  clearTimeout(recoveryTimer);
  client?.disconnect();
  await flushSettings();
  const childrenCleanup = isMainSession
    ? cleanupOpenedChildSessions()
    : Promise.resolve(
        api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        }).catch(() => {}),
      );
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
$("connect").addEventListener("click", () => void connect());
$("bitrate").value = settings.bitrate;
$("frame-rate").value = String(settings.frameRate);
updateTransportSettingsPresentation();
$("bitrate").addEventListener("change", () => setBitrate($("bitrate").value));
$("frame-rate").addEventListener("change", () =>
  setFrameRate($("frame-rate").value),
);
$("connection-mode").addEventListener("change", () => {
  if (connected || !isMainSession) return;
  settings.connectionMode =
    $("connection-mode").value === "video" ? "video" : "vnc";
  $("connection-mode-settings").textContent =
    connectionModeLabels[settings.connectionMode];
  updateTransportSettingsPresentation();
  save();
});
$("disconnect-report-dialog").addEventListener("close", () =>
  updateMacRemoteShortcuts(),
);
$("disconnect-report-copy").addEventListener("click", async () => {
  const report = $("disconnect-report").value;
  const previousClipboardValue = localClipboardValue;
  localClipboardValue = report;
  try {
    await writeSystemClipboardText(report);
    $("disconnect-report-copy-status").textContent =
      "错误报告已复制到本机剪贴板；不会发送到远端。";
  } catch {
    if (localClipboardValue === report)
      localClipboardValue = previousClipboardValue;
    $("disconnect-report").focus();
    $("disconnect-report").select();
    $("disconnect-report-copy-status").textContent =
      "自动复制失败，报告已选中；请按 Ctrl+C（macOS：⌘C）复制。";
  }
});
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
  const closingChild = !isMainSession;
  if (closingChild && rfb) manualDisconnectPending = true;
  currentTauriWindow()
    ?.close()
    .catch(() => {
      if (closingChild) manualDisconnectPending = false;
      toast("窗口关闭失败，请重试。");
    });
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
  updateMacRemoteShortcuts();
  save();
});
$("settings-toggle").addEventListener("click", () =>
  panel($("settings").hidden),
);
$("settings-close").addEventListener("click", () => panel(false));
window.addEventListener("focus", requestRemoteWindowActivation);
document.addEventListener(
  "pointerdown",
  (event) => {
    const onScreen =
      event.target instanceof Element && !!event.target.closest("#screen");
    if (onScreen) requestRemoteWindowActivation();
    void setMacRemoteShortcuts(onScreen && connected && !settings.viewOnly);
  },
  true,
);
document.addEventListener("focusin", (event) => {
  const onScreen =
    event.target instanceof Element && !!event.target.closest("#screen");
  void setMacRemoteShortcuts(onScreen && connected && !settings.viewOnly);
});
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
  if (!connected) {
    if (
      isTauriShell() &&
      isMainSession &&
      settingsReady &&
      trackDisconnectedTauriResize
    )
      disconnectedTauriWindowResized = true;
    return;
  }
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
$("password-dialog").addEventListener("close", updateMacRemoteShortcuts);
$("file-upload-dialog").addEventListener("close", updateMacRemoteShortcuts);
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
  pageLeaving = true;
  clearTimeout(disconnectReportTimer);
  disconnectReportTimer = undefined;
  if (!isMainSession && rfb) manualDisconnectPending = true;
  connectionWanted = false;
  recoveryEpoch++;
  clearTimeout(recoveryTimer);
  stopChildRecoveryMonitor();
  stopClipboardSync();
  stopChildMonitor();
  clearTimeout(settingsSyncTimer);
  if (isMainSession && settingsReady && token) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = undefined;
    void queuePersistSettings({ keepalive: true });
  } else {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = undefined;
  }
  settingsChannel?.close();
  if (!isMainSession && token) {
    fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`,
      { method: "DELETE", keepalive: true },
    ).catch(() => {});
  }
});
document.addEventListener(
  "dragover",
  (event) => {
    if (isTauriShell()) event.preventDefault();
  },
  true,
);
document.addEventListener(
  "drop",
  (event) => {
    if (isTauriShell()) event.preventDefault();
  },
  true,
);
void setupTauriNativeShortcuts();
void setupTauriFileDrop();
sessionReady = loadSessionInfo();
scale(settings.scale, false);
