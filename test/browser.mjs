import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startServer } from "../server.js";
import { startMock } from "./mock-rfb.mjs";

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
  await mkdir(".runtime", { recursive: true, mode: 0o700 });
  await page.screenshot({ path: ".runtime/welcome.png" });
  await page.click("#connect");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "已连接",
  );
  await page.waitForFunction(
    () => document.querySelector("canvas")?.width === 1669,
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
  await page.click("#collapse");
  assert.equal(
    await page
      .locator("footer")
      .boundingBox()
      .then((box) => box.height),
    30,
  );
  assert.equal(await page.locator("#restore-bubble").isVisible(), true);
  const bubble = await page.locator("#restore-bubble").boundingBox();
  await page.mouse.move(
    bubble.x + bubble.width / 2,
    bubble.y + bubble.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bubble.x + bubble.width / 2 + 40,
    bubble.y + bubble.height / 2 + 20,
  );
  await page.mouse.up();
  assert.equal(
    await page
      .locator("body")
      .evaluate((node) => node.classList.contains("ui-collapsed")),
    true,
  );
  await page.locator("#restore-bubble").click();
  assert.equal(
    await page
      .locator("body")
      .evaluate((node) => node.classList.contains("ui-collapsed")),
    false,
  );
  await page.click("#settings-toggle");
  await page.screenshot({ path: ".runtime/settings.png" });
  await page.click("#disconnect");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "已断开",
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
  console.log(
    "PASS: lossless negotiation, frame rate, 3 aspect ratios, scaled pointer/IME overlay, F11/brackets, 25% wheel, view-only, reconnect, Unicode guard",
  );
} finally {
  await browser.close();
  await app.close();
  await mock.close();
  await rm(settingsDirectory, { recursive: true, force: true });
}
