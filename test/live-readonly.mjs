import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const session = JSON.parse(
  await readFile(new URL("../.runtime/session.json", import.meta.url)),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 760 },
    deviceScaleFactor: 2,
  });
  await context.addInitScript(() =>
    localStorage.setItem(
      "qq-viewer-settings",
      JSON.stringify({ viewOnly: true, wheel: 25, scale: "fit" }),
    ),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(session.url);
  await page.waitForFunction(() => !location.hash);
  await page.click("#connect");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "已连接",
    null,
    { timeout: 15000 },
  );
  await page.waitForFunction(() => {
    const canvas = document.querySelector("#screen canvas");
    if (!canvas || canvas.width < 100) return false;
    const data = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 1024)
      if (data[i] + data[i + 1] + data[i + 2] > 30) return true;
    return false;
  });
  await page.waitForTimeout(1500);
  const result = await page.evaluate(() => {
    const canvas = document.querySelector("#screen canvas");
    const bounds = canvas.getBoundingClientRect();
    return {
      width: canvas.width,
      height: canvas.height,
      aspectError: Math.abs(
        bounds.width / bounds.height - canvas.width / canvas.height,
      ),
      viewOnly: document.querySelector("#view-only").checked,
      overlayBridgeReady: document
        .querySelector("#ime-status")
        .textContent.includes("已连接"),
    };
  });
  assert(result.viewOnly);
  assert(result.aspectError < 0.005);
  assert.deepEqual(errors, []);
  console.log("Live readonly connection:", JSON.stringify(result));
  console.log(
    "No remote input, message sending, clipboard reading or screenshots performed.",
  );
} finally {
  await browser.close();
}
