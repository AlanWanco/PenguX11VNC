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
let starts = 0;
let stops = 0;
let polls = 0;
const profile = {
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
  else if (req.url === "/setup/preflight") {
    if (body.ssh.host === "fail.invalid") {
      code = 500;
      data = { error: "SSH 认证失败，请检查 agent" };
    } else
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
  } else if (req.url === "/setup/save") {
    assert.equal(body.consent, true);
    saved++;
    configured = true;
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
try {
  const unauthorized = await fetch(`${app.origin}/api/setup/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 403);
  const wrongOrigin = await fetch(`${app.origin}/api/main/prepare`, {
    method: "POST",
    headers: { "X-QQ-Token": app.token, Origin: "https://attacker.example" },
  });
  assert.equal(wrongOrigin.status, 403);
  const childMutation = await fetch(
    `${app.origin}/api/setup/save?session=window-1`,
    {
      method: "POST",
      headers: { "X-QQ-Token": app.token },
    },
  );
  assert.equal(childMutation.status, 403);
  await page.goto(app.url);
  await page.waitForURL("**/setup.html");
  assert.equal(starts, 0, "First run must not start SSH/VNC");
  await page.fill("#setup-host", "fail.invalid");
  await page.click("#setup-probe");
  await page.waitForFunction(() =>
    document.querySelector("#setup-status").textContent.includes("认证失败"),
  );
  assert(await page.locator("#setup-help").evaluate((el) => el.open));
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
  assert(await page.isDisabled("#setup-save"), "Consent is required");
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
  await page.check("#setup-consent");
  await page.click("#setup-save");
  await page.waitForURL(app.origin + "/");
  assert.equal(saved, 1);
  assert.equal(starts, 0, "Saving must not start a capture");
  await page.click("#connect");
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
  await page.click("#settings-toggle");
  await page.click("#disconnect");
  await page.waitForTimeout(300);
  assert.equal(stops, 1);
  const stoppedPolls = polls;
  await page.waitForTimeout(5500);
  assert.equal(polls, stoppedPolls, "User disconnect must cancel recovery");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: first-run wizard, SSH error help, read-only preflight, ambiguity/consent gate, save, recovery, explicit stop",
  );
} finally {
  await browser.close();
  await app.close();
  await mock.close();
  await new Promise((resolve) => manager.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
