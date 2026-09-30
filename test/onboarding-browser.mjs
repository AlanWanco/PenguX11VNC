import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../server.js";
import { startMock } from "./mock-rfb.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "pengux-setup-"));
const mock = await startMock();
let configured = false;
let multiple = false;
let remoteState = "ready";
let saved = 0;
let draftSaves = 0;
let preflights = 0;
let starts = 0;
let stops = 0;
const stopReasons = [];
let polls = 0;
let pendingProfile;
let profile = {
  id: "onboarding-test",
  name: "Test QQ",
  ssh: { user: "user", host: "linux.example", port: 22 },
  window: { id: "0x123" },
  children: { enabled: false },
  vnc: { passwordFile: "" },
};
const manager = http.createServer(async (req, res) => {
  assert.equal(req.headers["x-pengux11vnc-token"], "fixture-token");
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : {};
  let data = {};
  let code = 200;
  if (req.url === "/setup") data = { available: true, configured, profile };
  else if (req.url === "/setup/draft") {
    draftSaves++;
    profile = {
      ...profile,
      name: body.name,
      ssh: body.ssh,
      vnc: { ...profile.vnc, remotePasswordFile: body.remotePasswordFile },
      managed: { ...profile.managed, setupPending: true },
    };
    configured = false;
    data = { savedLocally: true, configured, profile };
  } else if (req.url === "/setup/preflight") {
    preflights++;
    if (body.ssh.host === "fail.invalid") {
      code = 500;
      data = { error: "SSH 认证失败，请检查 agent" };
    } else {
      pendingProfile = {
        ...profile,
        name: body.name,
        ssh: body.ssh,
        vnc: { ...profile.vnc, remotePasswordFile: body.remotePasswordFile },
      };
      data = {
        running: true,
        displayAccessible: true,
        x11vnc: true,
        passwordReady: true,
        imeReady: false,
        windows: [
          { key: "0", id: "0x123", width: 900, height: 700, display: ":0" },
          ...(multiple
            ? [
                {
                  key: "1",
                  id: "0x456",
                  width: 800,
                  height: 600,
                  display: ":0",
                },
              ]
            : []),
        ],
      };
    }
  } else if (req.url === "/setup/save") {
    saved++;
    configured = true;
    profile = {
      ...pendingProfile,
      managed: { enabled: true },
    };
    data = { available: true, configured, profile };
  } else if (req.url === "/main/prepare" || req.url === "/main/poll") {
    if (req.url === "/main/prepare") starts++;
    else polls++;
    data = {
      state: remoteState,
      autoRecover: true,
      managed: true,
      targetPort: mock.port,
      profile,
      generation: 1,
    };
  } else if (req.url === "/main/stop") {
    stops++;
    stopReasons.push(body.reason);
    data = { ok: true };
  } else if (req.url === "/windows") data = { windows: [] };
  else {
    code = 404;
    data = { error: "not found" };
  }
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
});
await new Promise((resolve) => manager.listen(0, "127.0.0.1", resolve));
const app = await startServer({
  port: 0,
  connection: profile,
  settingsPath: path.join(directory, "settings.json"),
  manager: {
    url: `http://127.0.0.1:${manager.address().port}`,
    token: "fixture-token",
  },
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => {
  errors.push(`Unexpected native browser dialog: ${dialog.type()}`);
  void dialog.dismiss();
});
// The wizard runs in the main window. Model a frameless window so the in-page
// top bar must supply both dragging and closing.
await page.addInitScript(() => {
  if (!location.pathname.endsWith("/setup.html")) return;
  const fixture = { dragCalls: 0, closeCalls: 0 };
  window.__setupChrome = fixture;
  window.__TAURI__ = {
    window: {
      getCurrentWindow: () => ({
        async isDecorated() {
          return false;
        },
        async startDragging() {
          fixture.dragCalls++;
        },
        async close() {
          fixture.closeCalls++;
        },
      }),
    },
  };
});
const setupChrome = () =>
  page.evaluate(() => ({
    ...window.__setupChrome,
    frameless: document.body.classList.contains("no-system-titlebar"),
    closeVisible: getComputedStyle(document.getElementById("setup-close"))
      .display,
  }));
try {
  const unauthorized = await fetch(`${app.origin}/api/setup/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 403);
  const wrongOrigin = await fetch(`${app.origin}/api/main/prepare`, {
    method: "POST",
    headers: {
      "X-PenguX11VNC-Token": app.token,
      Origin: "https://attacker.example",
    },
  });
  assert.equal(wrongOrigin.status, 403);
  const childMutation = await fetch(
    `${app.origin}/api/setup/save?session=window-1`,
    {
      method: "POST",
      headers: { "X-PenguX11VNC-Token": app.token },
    },
  );
  assert.equal(childMutation.status, 403);
  await page.goto(app.url);
  await page.waitForSelector("#setup-open", { state: "visible" });
  assert(
    await page.isDisabled("#connect"),
    "Unconfigured profiles cannot connect",
  );
  await page.click("#setup-open");
  await page.waitForURL("**/setup.html");
  assert(await page.locator("#setup-topbar").isVisible());
  assert.equal(await page.locator("#setup-topbar #setup-back").count(), 1);
  assert.equal(await page.locator(".setup-card #setup-back").count(), 0);
  assert.equal(starts, 0, "Opening setup must not start SSH/VNC");
  const initialChrome = await setupChrome();
  assert.equal(
    initialChrome.frameless,
    true,
    "The wizard must detect a frameless window",
  );
  assert.notEqual(
    initialChrome.closeVisible,
    "none",
    "A frameless wizard must stay closable",
  );
  assert.equal(initialChrome.dragCalls, 0);
  await page.locator("#setup-topbar .identity").dispatchEvent("pointerdown", {
    button: 0,
  });
  assert.equal(
    (await setupChrome()).dragCalls,
    1,
    "The wizard top bar must drag the window when frameless",
  );
  await page.locator("#setup-topbar #setup-back").dispatchEvent("pointerdown", {
    button: 0,
  });
  assert.equal(
    (await setupChrome()).dragCalls,
    1,
    "Top bar buttons must stay clickable instead of dragging the window",
  );
  await page.click("#setup-close");
  assert.equal(
    (await setupChrome()).closeCalls,
    1,
    "A frameless wizard must be closable",
  );
  await page.fill("#setup-host", "fail.invalid");
  await page.click("#setup-probe");
  await page.waitForFunction(() =>
    document.querySelector("#setup-status").textContent.includes("认证失败"),
  );
  assert(await page.locator("#setup-help").evaluate((el) => el.open));
  await page.click("#setup-save");
  await page.waitForURL(app.origin + "/");
  assert.equal(draftSaves, 1);
  assert.equal(profile.ssh.host, "fail.invalid");
  assert.equal(profile.managed.setupPending, true);
  assert.equal(preflights, 1, "Saving must not rerun remote preflight");
  assert.equal(starts, 0, "Saving a draft must not attempt to connect");
  assert(await page.isDisabled("#connect"));
  assert.equal(await page.textContent("#setup-open"), "继续设置连接");
  await page.reload();
  assert.equal(
    new URL(page.url()).pathname,
    "/",
    "Saved drafts must not redirect-loop",
  );
  await page.click("#setup-open");
  await page.waitForURL("**/setup.html");
  assert.equal(
    await page.inputValue("#setup-host"),
    "fail.invalid",
    "Saved connection draft must survive navigation and reload",
  );
  await page.fill("#setup-host", "linux.example");
  multiple = true;
  await page.click("#setup-probe");
  await page.waitForSelector("#setup-result", { state: "visible" });
  assert.equal(
    await page.inputValue("#setup-window"),
    "",
    "Ambiguous windows must require selection",
  );
  await page.selectOption("#setup-window", "0");
  assert(
    await page.isEnabled("#setup-save"),
    "Saving must not require connection consent",
  );
  assert.equal(starts, 0, "Preflight must remain read-only");
  await page.fill("#setup-name", "Changed");
  assert(
    await page.isHidden("#setup-result"),
    "Editing draft must invalidate the probe",
  );
  multiple = false;
  await page.click("#setup-probe");
  await page.waitForSelector("#setup-result", { state: "visible" });
  assert.equal(await page.inputValue("#setup-window"), "0");
  await page.click("#setup-save");
  await page.waitForURL(app.origin + "/");
  assert.equal(saved, 1);
  assert.equal(starts, 0, "Saving must not start a capture");

  const configuredSetupPage = await browser.newPage();
  const configuredSetupErrors = [];
  configuredSetupPage.on("pageerror", (error) =>
    configuredSetupErrors.push(error.message),
  );
  await configuredSetupPage.goto(
    `${app.origin}/setup.html#token=${encodeURIComponent(app.token)}`,
  );
  await configuredSetupPage.waitForFunction(
    () => document.querySelector("#setup-status").textContent !== "读取配置中…",
  );
  assert.equal(
    await configuredSetupPage.inputValue("#setup-host"),
    "linux.example",
    "An existing connection must load its current address before editing",
  );
  const preflightsBeforeLocalSave = preflights;
  const startsBeforeLocalSave = starts;
  await configuredSetupPage.fill("#setup-host", "unsaved.invalid");
  await configuredSetupPage.click("#setup-back");
  await configuredSetupPage.waitForURL(app.origin + "/");
  assert.equal(
    profile.ssh.host,
    "linux.example",
    "Back must discard unsaved edits",
  );
  await configuredSetupPage.click("#setup-open");
  await configuredSetupPage.waitForURL("**/setup.html");
  assert.equal(
    await configuredSetupPage.inputValue("#setup-host"),
    "linux.example",
  );

  await configuredSetupPage.fill("#setup-host", "192.168.10.231");
  await configuredSetupPage.click("#setup-save");
  await configuredSetupPage.waitForURL(app.origin + "/");
  assert.equal(
    draftSaves,
    2,
    "The single save action persists unverified edits",
  );
  assert.equal(profile.ssh.host, "192.168.10.231");
  assert.equal(configured, false, "Unverified profile must require setup");
  assert.equal(preflights, preflightsBeforeLocalSave);
  assert.equal(starts, startsBeforeLocalSave);
  assert(await configuredSetupPage.isDisabled("#connect"));
  assert.equal(
    await configuredSetupPage.textContent("#setup-open"),
    "继续设置连接",
  );
  await configuredSetupPage.reload();
  assert.equal(new URL(configuredSetupPage.url()).pathname, "/");
  await configuredSetupPage.click("#setup-open");
  await configuredSetupPage.waitForURL("**/setup.html");
  assert.equal(
    await configuredSetupPage.inputValue("#setup-host"),
    "192.168.10.231",
    "Updated address must persist for an already-configured installation",
  );
  await configuredSetupPage.click("#setup-probe");
  await configuredSetupPage.waitForSelector("#setup-result", {
    state: "visible",
  });
  await configuredSetupPage.click("#setup-save");
  await configuredSetupPage.waitForURL(app.origin + "/");
  assert.equal(saved, 2);
  assert.equal(configured, true);
  assert.equal(profile.ssh.host, "192.168.10.231");
  await configuredSetupPage.close();
  assert.deepEqual(configuredSetupErrors, []);

  await page.waitForFunction(
    () => document.querySelector("#setup-open").textContent === "编辑连接配置",
  );
  const consent = page.locator("#connection-consent-dialog");
  await page.click("#connect");
  await consent.waitFor({ state: "visible" });
  assert.equal(starts, 0, "Showing the modal must not start SSH/VNC");
  assert(
    await page.isDisabled("#connect"),
    "Pending consent must block duplicate attempts",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "connection-consent-cancel",
    "Remote startup consent must default focus to cancel",
  );
  await page.click("#connection-consent-cancel");
  await consent.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => !document.querySelector("#connect").disabled,
  );
  assert.equal(starts, 0, "Canceling connection consent must not start VNC");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "connect",
  );

  await page.click("#connect");
  await consent.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await consent.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => !document.querySelector("#connect").disabled,
  );
  assert.equal(starts, 0, "Esc must deny consent without starting VNC");

  await page.click("#connect");
  await consent.waitFor({ state: "visible" });
  await page.keyboard.press("Enter");
  await consent.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => !document.querySelector("#connect").disabled,
  );
  assert.equal(
    starts,
    0,
    "Enter on the default cancel action must not grant consent",
  );

  const leavingPage = await browser.newPage();
  leavingPage.on("pageerror", (error) => errors.push(error.message));
  await leavingPage.goto(app.url);
  await leavingPage.waitForFunction(
    () => !document.querySelector("#connect").disabled,
  );
  await leavingPage.click("#connect");
  await leavingPage
    .locator("#connection-consent-dialog")
    .waitFor({ state: "visible" });
  await leavingPage.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await leavingPage
    .locator("#connection-consent-dialog")
    .waitFor({ state: "hidden" });
  assert.equal(
    starts,
    0,
    "Leaving the page must cancel pending remote-start consent",
  );
  await leavingPage.close();

  await page.click("#connect");
  await consent.waitFor({ state: "visible" });
  await page.evaluate(() => {
    const button = document.querySelector("#connect");
    for (let i = 0; i < 4; i++) button.dispatchEvent(new Event("click"));
  });
  assert.equal(await page.locator("dialog[open]").count(), 1);
  assert.equal(
    starts,
    0,
    "Duplicate requests must remain blocked until explicit consent",
  );
  await page.setViewportSize({ width: 320, height: 568 });
  const modalBox = await consent.boundingBox();
  assert(modalBox.x >= 0 && modalBox.x + modalBox.width <= 320);
  const cancelBox = await page
    .locator("#connection-consent-cancel")
    .boundingBox();
  const allowBox = await page
    .locator("#connection-consent-allow")
    .boundingBox();
  assert(
    Math.abs(cancelBox.width - allowBox.width) < 1,
    "Modal actions must have equal widths",
  );
  assert.equal(
    cancelBox.height,
    allowBox.height,
    "Modal actions must have equal heights",
  );
  assert.equal(cancelBox.y, allowBox.y, "Modal actions must share a baseline");
  await page.click("#connection-consent-allow");
  await consent.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "已连接",
  );
  assert.equal(starts, 1);
  remoteState = "waiting-qq";
  await page.waitForFunction(
    () =>
      document
        .querySelector("#recovery-status")
        .textContent.includes("QQ 未运行"),
    null,
    { timeout: 12000 },
  );
  remoteState = "ready";
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "已连接",
    null,
    { timeout: 15000 },
  );
  assert.equal(
    starts,
    1,
    "Recovery must not duplicate explicit prepare requests",
  );
  if (await page.locator("#disconnect-report-dialog").isVisible())
    await page.click("#disconnect-report-close");
  await page.click("#settings-toggle");
  await page.click("#disconnect");
  await page.waitForTimeout(300);
  assert.equal(stops, 1);
  assert.deepEqual(stopReasons, ["user-disconnect"]);
  const stoppedPolls = polls;
  await page.waitForTimeout(5500);
  assert.equal(polls, stoppedPolls, "User disconnect must cancel recovery");
  await page.click("#settings-close");
  await page.click("#connect");
  await consent.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await consent.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => !document.querySelector("#connect").disabled,
  );
  assert.equal(
    starts,
    1,
    "Esc must not reuse affirmative consent from an earlier connection",
  );

  assert.deepEqual(errors, []);
  console.log(
    "PASS: single save action, discard navigation, pending-profile home, read-only preflight, themed consent modal, cancel/Esc/pagehide safety, duplicate guard, equal actions, recovery, explicit stop",
  );
} finally {
  await browser.close();
  await app.close();
  await mock.close();
  await new Promise((resolve) => manager.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
