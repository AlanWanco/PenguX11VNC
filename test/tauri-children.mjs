import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Model Tauri 2's close contract, not an unconditional window.close() stub:
// a JS CloseRequested listener prevents the OS close and needs destroy IPC.
// core:default grants neither close nor destroy (tauri/src/manager/window.rs).
function installTauriFixture(permissions) {
  const windows = new Map();
  const fixture = {
    windows,
    denyClose: false,
    denied: 0,
    destroyCalls: 0,
    holdDestruction: false,
    pending: new Set(),
    sizeCalls: [],
    decorationCalls: [],
    dragCalls: 0,
    createdUrls: [],
  };
  class WebviewWindow {
    constructor(label, options = {}) {
      this.label = label;
      fixture.createdUrls.push({ label, url: options.url });
      this.listeners = new Map();
      windows.set(label, this);
      queueMicrotask(() => this.emit("tauri://created"));
    }
    async once(event, callback) {
      this.listeners.set(event, callback);
      return () => this.listeners.delete(event);
    }
    emit(event) {
      const callback = this.listeners.get(event);
      this.listeners.delete(event);
      callback?.({ payload: null });
    }
    async onCloseRequested(callback) {
      this.closeListener = callback;
      return () => {
        this.closeListener = undefined;
      };
    }
    async requestNativeClose() {
      if (this.closeListener) {
        await this.closeListener({});
        await this.destroy();
      } else {
        fixture.pending.add(this.label);
        if (!fixture.holdDestruction) setTimeout(() => this.finishClose(), 10);
      }
    }
    async close() {
      if (
        fixture.denyClose ||
        !permissions.includes("core:window:allow-close")
      ) {
        fixture.denied++;
        throw new Error("window.close not allowed");
      }
      await this.requestNativeClose();
    }
    async destroy() {
      fixture.destroyCalls++;
      if (!permissions.includes("core:window:allow-destroy"))
        throw new Error("window.destroy not allowed");
      this.finishClose();
    }
    finishClose() {
      fixture.pending.delete(this.label);
      windows.delete(this.label);
      this.emit("tauri://destroyed");
    }
  }
  class LogicalSize {
    constructor(width, height) {
      this.type = "Logical";
      this.width = width;
      this.height = height;
    }
  }
  const currentWindow = {
    async setSize(size) {
      fixture.sizeCalls.push({ width: size.width, height: size.height });
    },
    async setDecorations(value) {
      fixture.decorationCalls.push(value);
    },
    async startDragging() {
      fixture.dragCalls++;
    },
    async close() {},
  };
  window.__TAURI__ = {
    webviewWindow: { WebviewWindow },
    window: {
      LogicalSize,
      getCurrentWindow: () => currentWindow,
    },
  };
  window.tauriFixture = fixture;
}

export async function testTauriChildren(browser, app) {
  const capability = JSON.parse(
    await readFile(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  );
  assert(capability.permissions.includes("core:window:allow-close"));
  const page = await browser.newPage();
  const errors = [];
  const deleted = [];
  let visible = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(installTauriFixture, capability.permissions);
  await page.route("**/api/windows**", (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.match(/^\/api\/windows\/(0x[0-9a-f]+)\/open$/)?.[1];
    const body = id
      ? {
          session: { id: `window-${id.slice(2)}`, windowId: id, child: true },
          url: `/?session=window-${id.slice(2)}`,
        }
      : { windows: visible };
    return route.fulfill({ json: body });
  });
  await page.route("**/api/sessions/**", (route) => {
    assert.equal(route.request().method(), "DELETE");
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    deleted.push(id);
    visible = visible.filter((info) => `window-${info.id.slice(2)}` !== id);
    return route.fulfill({ json: { ok: true } });
  });
  const info = (id) => ({ id, mapped: true, width: 900, height: 700 });
  const waitOpen = async (id) => {
    await page.waitForFunction(
      (key) => window.openedChildWindows?.has(key),
      id,
    );
  };
  const waitClosed = async () => {
    await page.waitForFunction(
      () =>
        window.tauriFixture.windows.size === 0 &&
        window.openedChildWindows.size === 0,
    );
  };
  try {
    await page.goto(app.url);
    await page.waitForFunction(
      () => !location.hash && !!sessionStorage.getItem("qq-viewer-token"),
    );
    await page.click("#connect");
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "已连接",
    );
    await page.waitForFunction(() => window.tauriFixture.sizeCalls.length > 0);
    const fitted = await page.evaluate(() => {
      const size = window.tauriFixture.sizeCalls.at(-1);
      const canvas = document.querySelector("canvas");
      const titlebar = document.querySelector(".titlebar").offsetHeight;
      const footer = document.querySelector("footer").offsetHeight;
      return {
        size,
        contentHeight: size.height - titlebar - footer,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        decorations: window.tauriFixture.decorationCalls.at(-1),
      };
    });
    assert.equal(fitted.decorations, true);
    assert(
      Math.abs(
        fitted.size.width / fitted.contentHeight -
          fitted.canvasWidth / fitted.canvasHeight,
      ) < 0.01,
      "Tauri VNC client area must preserve the framebuffer aspect ratio",
    );
    await page.click("#settings-toggle");
    await page.uncheck("#system-titlebar");
    await page.waitForFunction(
      () => window.tauriFixture.decorationCalls.at(-1) === false,
    );
    assert.equal(
      await page.evaluate(() =>
        document.body.classList.contains("no-system-titlebar"),
      ),
      true,
    );
    assert(
      (await page.locator(".titlebar").boundingBox()).height <= 20,
      "Collapsed custom titlebar must remain a thin bar",
    );
    await page.click("#titlebar-toggle");
    assert.equal(
      await page.evaluate(() =>
        document.body.classList.contains("titlebar-expanded"),
      ),
      true,
    );
    assert(
      (await page.locator(".titlebar").boundingBox()).height >= 34,
      "Expanded custom titlebar must reveal the controls",
    );
    await page.click("#titlebar-toggle");
    await page.check("#system-titlebar");
    await page.waitForFunction(
      () => window.tauriFixture.decorationCalls.at(-1) === true,
    );
    await page.click("#settings-close");

    // Linux QQ disappears: the main viewer closes the corresponding native window.
    visible = [info("0x2")];
    await waitOpen("0x2");
    const childUrl = await page.evaluate(
      () =>
        window.tauriFixture.createdUrls.find(
          (item) => item.label === "qq-child-2",
        ).url,
    );
    assert(
      Math.abs(
        Number(new URL(childUrl).searchParams.get("vncScale")) -
          fitted.size.width / fitted.canvasWidth,
      ) < 0.002,
      "Child Tauri window must inherit the main VNC scale",
    );
    visible = [];
    await waitClosed();

    // Native title-bar X: no JS listener may intercept the OS close. Cleanup is
    // driven by Destroyed, not by treating a close request as successful destruction.
    visible = [info("0x3")];
    await waitOpen("0x3");
    await page.evaluate(() =>
      window.tauriFixture.windows.get("qq-child-3").requestNativeClose(),
    );
    await waitClosed();

    // Rejected async IPC: retain the entry, do not silently lose the native window.
    visible = [info("0x4")];
    await waitOpen("0x4");
    await page.evaluate(() => {
      window.tauriFixture.denyClose = true;
    });
    visible = [];
    await page.waitForFunction(() => window.tauriFixture.denied > 0);
    assert.equal(
      await page.evaluate(() => window.openedChildWindows.has("0x4")),
      true,
    );
    assert(!deleted.includes("window-4"));
    await page.evaluate(() => {
      window.tauriFixture.denyClose = false;
    });
    await waitClosed();

    // IPC success is only an acknowledgement: keep tracking until Destroyed.
    visible = [info("0x8")];
    await waitOpen("0x8");
    await page.evaluate(() => {
      window.tauriFixture.holdDestruction = true;
    });
    visible = [];
    await page.waitForFunction(() =>
      window.tauriFixture.pending.has("qq-child-8"),
    );
    assert.equal(
      await page.evaluate(() => window.openedChildWindows.has("0x8")),
      true,
    );
    assert(!deleted.includes("window-8"));
    await page.evaluate(() => {
      window.tauriFixture.holdDestruction = false;
      window.tauriFixture.windows.get("qq-child-8").finishClose();
    });
    await waitClosed();

    // Auto-open toggle only controls opening; existing native windows still close.
    visible = [info("0x5")];
    await waitOpen("0x5");
    await page.click("#settings-toggle");
    await page.uncheck("#child-auto-open");
    visible = [info("0x6")];
    await waitClosed();
    assert.equal(
      await page.evaluate(() => window.tauriFixture.windows.size),
      0,
    );
    await page.click("#child-refresh");
    await page.locator(".child-open").click();
    await waitOpen("0x6");
    visible = [];
    await waitClosed();

    // Disconnect the main viewer while a child is open.
    await page.check("#child-auto-open");
    visible = [info("0x7")];
    await waitOpen("0x7");
    await page.click("#disconnect");
    await waitClosed();
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "已断开",
    );
    assert.deepEqual(deleted, [
      "window-2",
      "window-3",
      "window-4",
      "window-8",
      "window-5",
      "window-6",
      "window-7",
    ]);
    assert.equal(
      await page.evaluate(() => window.tauriFixture.destroyCalls),
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Tauri close contract (simulated IPC), remote/native close, async rejection retry, manual children, main disconnect",
    );
  } finally {
    await page.close();
  }
}
