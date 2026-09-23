import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startServer } from "../server.js";
import { startMock } from "./mock-rfb.mjs";
import { testTauriChildren } from "./tauri-children.mjs";

const mock = await startMock();
const settingsDirectory = await mkdtemp(
  path.join(tmpdir(), "pengux11vnc-browser-settings-"),
);
const app = await startServer({
  port: 0,
  targetPort: mock.port,
  settingsPath: path.join(settingsDirectory, "settings.json"),
  imeEnabled: true,
  imeCommand: [
    process.execPath,
    fileURLToPath(new URL("./ime-fixture.mjs", import.meta.url)),
  ],
});
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 1000, height: 760 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(app.url);
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  assert.equal(new URL(page.url()).hash, "");
  const textSelection = await page.evaluate(() => ({
    interface: getComputedStyle(document.body).userSelect,
    clipboard: getComputedStyle(document.querySelector("#clipboard"))
      .userSelect,
    report: getComputedStyle(document.querySelector("#disconnect-report"))
      .userSelect,
    status: getComputedStyle(document.querySelector("#video-status"))
      .userSelect,
  }));
  assert.equal(textSelection.interface, "none");
  assert.equal(textSelection.clipboard, "text");
  assert.equal(textSelection.report, "text");
  assert.equal(textSelection.status, "text");
  assert.equal(await page.locator("#tauri-close-hint").isHidden(), true);
  assert.equal(
    await page.locator("#window-close").getAttribute("aria-label"),
    "关闭窗口",
    "Chrome fallback must not advertise native tray behavior",
  );
  const fileUploadDialog = page.locator("#file-upload-dialog");
  assert.equal(await fileUploadDialog.isVisible(), false);
  await page.evaluate(() =>
    document.querySelector("#file-upload-dialog").showModal(),
  );
  assert.equal(await fileUploadDialog.isVisible(), true);
  await page.click("#file-upload-cancel");
  assert.equal(await fileUploadDialog.isVisible(), false);
  assert.equal(
    await fileUploadDialog.evaluate((dialog) => dialog.returnValue),
    "cancel",
  );
  await page.evaluate(() =>
    document.querySelector("#file-upload-dialog").showModal(),
  );
  await page.click("#file-upload-confirm");
  assert.equal(await fileUploadDialog.isVisible(), false);
  assert.equal(
    await fileUploadDialog.evaluate((dialog) => dialog.returnValue),
    "upload",
  );
  await mkdir(".runtime", { recursive: true, mode: 0o700 });
  await page.screenshot({ path: ".runtime/welcome.png" });
  await page.click("#connect");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "已连接",
  );
  await page.waitForFunction(
    () => document.querySelector("canvas")?.width === 1669,
  );
  await page.evaluate(() => {
    const toast = document.querySelector("#toast");
    toast.textContent = "文件已上传";
    toast.hidden = false;
  });
  const toastBox = await page.locator("#toast").boundingBox();
  const toastPoint = {
    x: toastBox.x + toastBox.width / 2,
    y: toastBox.y + toastBox.height / 2,
  };
  assert.equal(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("#screen")?.id || null,
      toastPoint,
    ),
    "screen",
    "Toast must not intercept pointer hit-testing over the remote screen",
  );
  const pointersBeforeToastClick = mock.events.pointers.length;
  await page.mouse.click(toastPoint.x, toastPoint.y);
  await page.waitForTimeout(50);
  assert(
    mock.events.pointers.length > pointersBeforeToastClick,
    "Pointer input must pass through the toast to the remote screen",
  );
  await page.locator("#toast").evaluate((toast) => (toast.hidden = true));
  assert.equal(
    await page.locator("#send-clipboard-files").isDisabled(),
    true,
    "Chrome fallback must not claim native file clipboard support",
  );
  assert(
    !mock.events.encodings.includes(7),
    "Tight/JPEG must not be advertised",
  );
  assert(!mock.events.encodings.includes(21), "JPEG must not be advertised");
  assert(!mock.events.encodings.includes(50), "H264 must not be advertised");
  assert(mock.events.encodings.includes(16), "ZRLE must be advertised");
  assert(mock.events.frameRequests >= 1, "Initial framebuffer request missing");
  await page.click("#settings-toggle");
  await page.selectOption("#bitrate", "low");
  await page.waitForTimeout(80);
  assert(mock.events.encodings.includes(7), "Low bitrate must advertise Tight");
  assert(mock.events.encodings.includes(21), "Low bitrate must advertise JPEG");
  await page.mouse.click(160, 180);
  await page.waitForTimeout(30);
  assert.equal(
    await page.locator("#settings").isHidden(),
    true,
    "Outside click must close settings",
  );
  await page.click("#settings-toggle");
  await page.selectOption("#bitrate", "lossless");
  await page.click("#settings-close");

  for (const size of [
    { width: 1000, height: 760 },
    { width: 820, height: 560 },
    { width: 1200, height: 700 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(180);
    const rect = await page.locator("#screen canvas").boundingBox();
    await page.waitForFunction(
      () => !document.querySelector("#ime-overlay").hidden,
    );
    const overlay = await page.locator("#ime-overlay").boundingBox();
    assert(
      Math.abs(overlay.x - rect.x - (400 * rect.width) / mock.width) < 2,
      "IME overlay x mismatch",
    );
    assert(
      Math.abs(overlay.y - rect.y - (900 * rect.width) / mock.width) < 2,
      "IME overlay y mismatch",
    );
    assert(
      Math.abs(overlay.width - (400 * rect.width) / mock.width) < 2,
      "IME overlay scale mismatch",
    );
    assert(
      Math.abs(rect.width / rect.height - mock.width / mock.height) < 0.005,
      "Aspect ratio changed",
    );
    await page.mouse.click(
      rect.x + rect.width * 0.3,
      rect.y + rect.height * 0.4,
    );
    await page.waitForTimeout(80);
    const click = mock.events.pointers
      .filter((event) => event.mask === 1)
      .at(-1);
    assert(
      Math.abs(click.x - mock.width * 0.3) < 3 &&
        Math.abs(click.y - mock.height * 0.4) < 3,
      "Scaled pointer mismatch",
    );
  }
  const originalCanvasStyle = await page
    .locator("#screen canvas")
    .getAttribute("style");
  await page.evaluate(() => {
    const canvas = document.querySelector("#screen canvas");
    canvas.style.width = `${canvas.width * 0.61}px`;
    canvas.style.height = `${canvas.height * 0.61}px`;
  });
  const resizedRect = await page.locator("#screen canvas").boundingBox();
  await page.mouse.click(
    resizedRect.x + resizedRect.width * 0.73,
    resizedRect.y + resizedRect.height * 0.27,
  );
  await page.waitForTimeout(80);
  const resizedClick = mock.events.pointers
    .filter((event) => event.mask === 1)
    .at(-1);
  assert(
    Math.abs(resizedClick.x - mock.width * 0.73) < 3 &&
      Math.abs(resizedClick.y - mock.height * 0.27) < 3,
    "Pointer mapping must follow the current canvas rectangle",
  );
  await page.evaluate((style) => {
    const canvas = document.querySelector("#screen canvas");
    if (style === null) canvas.removeAttribute("style");
    else canvas.setAttribute("style", style);
  }, originalCanvasStyle);
  const beforeKeys = mock.events.keys.length;
  await page.keyboard.press("F11");
  await page.keyboard.press("BracketLeft");
  assert(mock.events.keys.length >= beforeKeys);
  await page.waitForTimeout(100);
  assert(
    mock.events.keys.some((event) => event.sym === 0xffc8),
    "F11 not forwarded",
  );
  assert(
    mock.events.keys.some((event) => event.sym === 0x5b),
    "Bracket not forwarded",
  );

  for (const sensitivity of [25, 100]) {
    await page.click("#settings-toggle");
    await page.locator("#wheel").fill(String(sensitivity));
    await page.click("#settings-close");
    const rect = await page.locator("#screen canvas").boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const before = mock.events.pointers.filter(
      (event) => event.mask & 0x78,
    ).length;
    for (let i = 0; i < 20; i++) {
      await page.locator("#screen canvas").dispatchEvent("wheel", {
        deltaX: 0,
        deltaY: 40,
        deltaMode: 0,
        buttons: 0,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      });
      await page.waitForTimeout(42);
    }
    const emitted =
      mock.events.pointers.filter((event) => event.mask & 0x78).length - before;
    assert.equal(
      emitted,
      sensitivity === 25 ? 4 : 16,
      `Unexpected wheel steps at ${sensitivity}%`,
    );
  }

  await page.click("#settings-toggle");
  await page.locator("#wheel").fill("25");
  await page.fill("#clipboard", "中文");
  const beforeClipboard = mock.events.clipboard.length;
  await page.click("#send-clipboard");
  assert.equal(
    mock.events.clipboard.length,
    beforeClipboard,
    "Unsupported Unicode must not be corrupted",
  );
  await page.check("#view-only");
  await page.click("#settings-close");
  await page.waitForTimeout(60);
  const count = mock.events.pointers.length;
  const rect = await page.locator("#screen canvas").boundingBox();
  await page.mouse.click(rect.x + 30, rect.y + 30);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(100);
  assert.equal(
    mock.events.pointers.length,
    count,
    "View-only leaked pointer events",
  );
  await page.click("#settings-toggle");
  const beforeFrameRequests = mock.events.frameRequests;
  await page.selectOption("#frame-rate", "15");
  assert.equal(await page.locator("#frame-rate-value").textContent(), "15 FPS");
  await page.waitForTimeout(120);
  assert(
    mock.events.frameRequests > beforeFrameRequests,
    "Frame rate change stalled updates",
  );
  await page.click("#settings-close");
  assert.equal(await page.locator("#collapse").count(), 0);
  assert.equal(await page.locator("#restore-bubble").count(), 0);
  await page.click("#settings-toggle");
  await page.screenshot({ path: ".runtime/settings.png" });
  await page.click("#disconnect");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "已断开",
  );
  assert.equal(
    await page.locator("#disconnect-report-dialog").isVisible(),
    false,
    "A user-requested clean disconnect must not open an error report",
  );
  await page.click("#settings-close");
  await page.click("#connect");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "已连接",
  );
  assert.equal(
    await page.locator("#screen canvas").count(),
    1,
    "Reconnect duplicated canvas",
  );
  assert.deepEqual(errors, []);
  await testTauriChildren(browser, app, mock);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(app.url).origin,
  });
  const localToken = await page.evaluate(() =>
    sessionStorage.getItem("pengux11vnc-token"),
  );
  mock.disconnectClients();
  await page.locator("#disconnect-report-dialog").waitFor({ state: "visible" });
  const disconnectReport = await page
    .locator("#disconnect-report")
    .inputValue();
  const parsedDisconnectReport = JSON.parse(disconnectReport);
  assert.equal(parsedDisconnectReport.transport, "vnc");
  assert.equal(
    parsedDisconnectReport.disconnect.reason,
    parsedDisconnectReport.disconnect.clean
      ? "remote-closed-connection"
      : "unexpected-disconnect",
  );
  const vncDisconnect = parsedDisconnectReport.recentEvents.find(
    (event) => event.event === "vnc-disconnect",
  );
  assert(vncDisconnect, "Report must include the safe RFB disconnect event");
  assert.equal(typeof vncDisconnect.socketCloseCode, "number");
  assert.equal(typeof vncDisconnect.socketCloseWasClean, "boolean");
  assert.equal(typeof vncDisconnect.socketCloseReasonLength, "number");
  assert.equal(vncDisconnect.socketState, "connected");
  assert.equal(parsedDisconnectReport.autoRecovery, false);
  const transitionEvent = parsedDisconnectReport.recentEvents.find(
    (event) => event.event === "video-connection-state",
  );
  if (transitionEvent)
    assert.notEqual(transitionEvent.transition, "video-connection-state");
  assert(
    !disconnectReport.includes(localToken),
    "Report leaked the local token",
  );
  await page.click("#disconnect-report-copy");
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    disconnectReport,
    "The report copy action must write to the local clipboard",
  );
  assert.match(
    await page.locator("#disconnect-report-copy-status").textContent(),
    /不会发送到远端/,
  );
  await page.click("#disconnect-report-close");
  assert.equal(
    await page.locator("#disconnect-report-dialog").isVisible(),
    false,
  );
  const childStartupPage = await browser.newPage();
  let startupPolls = 0;
  let startupToken;
  await childStartupPage.route("**/api/debug**", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  const paintReportPromise = childStartupPage
    .waitForRequest(
      (request) => request.url().includes("/api/debug?session=main"),
      { timeout: 4000 },
    )
    .then((request) => request.postDataJSON());
  await childStartupPage.route("**/api/session**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.get("session") !== "window-2")
      return route.continue();
    startupPolls++;
    startupToken = route.request().headers()["x-pengux11vnc-token"];
    if (startupPolls < 3)
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "session-not-found" }),
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "window-2",
          child: true,
          windowId: "0x2",
          title: "QQ 子窗口",
        },
        profile: { id: "fixture", name: "Fixture", viewer: {} },
      }),
    });
  });
  await childStartupPage.goto(
    `${app.origin}/child-loading.html?session=window-2&vncScale=0.625&startedAt=${Date.now() - 250}&debug=1#token=${app.token}`,
  );
  await childStartupPage.waitForURL(
    (url) =>
      url.pathname === "/" &&
      url.searchParams.get("session") === "window-2" &&
      url.searchParams.get("vncScale") === "0.625000",
    { timeout: 4000 },
  );
  assert(
    startupPolls >= 3,
    "The loading window must wait for session readiness",
  );
  assert.equal(
    startupToken,
    app.token,
    "The loading page must authenticate locally",
  );
  await childStartupPage.waitForFunction(() =>
    sessionStorage.getItem("pengux11vnc-token"),
  );
  assert.equal(
    await childStartupPage.evaluate(() =>
      sessionStorage.getItem("pengux11vnc-token"),
    ),
    app.token,
    "The child viewer must receive the existing local session token",
  );
  const paintReport = await paintReportPromise;
  assert.equal(paintReport.event, "child-window-painted");
  assert(Number.isFinite(paintReport.details?.elapsedMs));
  assert.deepEqual(Object.keys(paintReport.details), ["elapsedMs"]);
  await childStartupPage.close();
  const closingPage = await browser.newPage();
  const closingPageErrors = [];
  closingPage.on("pageerror", (error) => closingPageErrors.push(error.message));
  await closingPage.goto(app.url);
  await closingPage.waitForFunction(
    () => !location.hash && !!sessionStorage.getItem("pengux11vnc-token"),
  );
  await closingPage.click("#connect");
  await closingPage.waitForFunction(
    () => document.querySelector("#status").textContent === "已连接",
  );
  await closingPage.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  mock.disconnectClients();
  await closingPage.waitForTimeout(350);
  assert.equal(
    await closingPage.locator("#disconnect-report-dialog").isVisible(),
    false,
    "Closing a window must cancel its pending disconnect dialog",
  );
  await closingPage.close();
  assert.deepEqual(closingPageErrors, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: video settings mapping, sanitized disconnect report, copy action, VNC controls, scaling, IME overlay, input, wheel, reconnect, clipboard guard",
  );
} finally {
  await browser.close();
  await app.close();
  await mock.close();
  await rm(settingsDirectory, { recursive: true, force: true });
}
