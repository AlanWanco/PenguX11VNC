const query = new URLSearchParams(location.search);
const sessionId = query.get("session") || "";
const scale = Number(query.get("vncScale"));
const startedAt = Number(query.get("startedAt"));
const debugEnabled = query.get("debug") === "1";
const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
const status = document.querySelector("#child-startup-status");
const validSession = /^window-[0-9a-f]+$/i.test(sessionId);
const validScale = Number.isFinite(scale) && scale >= 0.05 && scale <= 1;
let stopped = false;
let attempts = 0;

function reportFirstPaint() {
  if (!debugEnabled || !Number.isFinite(startedAt) || !token) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      fetch("/api/debug?session=main", {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "X-PenguX11VNC-Token": token,
        },
        body: JSON.stringify({
          event: "child-window-painted",
          details: { elapsedMs: Math.max(0, Date.now() - startedAt) },
        }),
      }).catch(() => {});
    }),
  );
}

function fail(message) {
  stopped = true;
  status.textContent = message;
  document.querySelector(".child-startup-spinner")?.setAttribute("hidden", "");
}

async function waitForSession() {
  if (stopped) return;
  attempts++;
  try {
    const response = await fetch(
      `/api/session?session=${encodeURIComponent(sessionId)}`,
      {
        cache: "no-store",
        headers: { "X-PenguX11VNC-Token": token },
      },
    );
    if (response.ok) {
      const data = await response.json();
      if (data.session?.id !== sessionId || data.session?.child !== true) {
        fail("子窗口会话校验失败，请关闭后重试。");
        return;
      }
      const viewer = new URL("./", location.href);
      viewer.searchParams.set("session", sessionId);
      viewer.searchParams.set("vncScale", scale.toFixed(6));
      viewer.searchParams.set("startedAt", String(startedAt));
      if (debugEnabled) viewer.searchParams.set("debug", "1");
      viewer.hash = new URLSearchParams({ token }).toString();
      location.replace(viewer);
      return;
    }
    if (response.status === 401 || response.status === 403) {
      fail("本地访问凭证无效，请关闭此窗口后重新连接。");
      return;
    }
  } catch {
    // The local session API can briefly be unavailable while it starts.
  }
  if (attempts === 80) status.textContent = "远端会话仍在准备，请稍候…";
  setTimeout(waitForSession, 120);
}

window.addEventListener(
  "pagehide",
  () => {
    stopped = true;
  },
  { once: true },
);

if (!validSession || !validScale || !token) {
  fail("子窗口启动参数无效，请关闭后重试。");
} else {
  reportFirstPaint();
  void waitForSession();
}
