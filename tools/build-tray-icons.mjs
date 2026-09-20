// Regenerate the transparent monochrome tray assets; no running QQ is accessed.
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const icons = new URL("../src-tauri/icons/", import.meta.url);
const source = await readFile(new URL("tray.svg", icons), "utf8");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  for (const [name, color] of [
    ["black", "#000"],
    ["white", "#fff"],
  ]) {
    await page.setContent(
      `<style>body{margin:0;background:transparent}svg{display:block;width:64px;height:64px}</style>${source.replaceAll("#000", color)}`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL(`tray-${name}.png`, icons)),
      omitBackground: true,
    });
  }
} finally {
  await browser.close();
}
