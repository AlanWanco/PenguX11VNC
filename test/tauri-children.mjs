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
    focusCalls: 0,
    decorationCalls: [],
    dragCalls: 0,
    invokeCalls: [],
    clipboardText: "fixture local text",
    clipboardWrites: [],
    createdUrls: [],
    eventListeners: new Map(),
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
    async setFocus() {
      fixture.focusCalls++;
    },
    async setDecorations(value) {
      fixture.decorationCalls.push(value);
    },
    async startDragging() {
      fixture.dragCalls++;
    },
    async close() {},
  };
  const event = {
    async listen(name, callback) {
      const listeners = fixture.eventListeners.get(name) || new Set();
      listeners.add(callback);
      fixture.eventListeners.set(name, listeners);
      return () => listeners.delete(callback);
    },
  };
  fixture.emitEvent = async (name, payload) => {
    for (const callback of fixture.eventListeners.get(name) || [])
      await callback({ payload });
  };
  window.__TAURI__ = {
    core: {
      async invoke(command, args) {
        fixture.invokeCalls.push({ command, args });
        if (command === "read_clipboard_files")
          throw new Error("本机剪贴板中没有可用文件");
        if (command === "read_clipboard_text")
          return window.tauriFixture.clipboardText;
        if (command === "write_clipboard_text") {
          window.tauriFixture.clipboardText = args.text;
          window.tauriFixture.clipboardWrites.push(args.text);
          return undefined;
        }
        if (command === "inspect_files")
          return [{ path: args.paths[0], name: "drop.txt", size: 5 }];
        if (command === "upload_files")
          return {
            files: [
              { name: "drop.txt", path: "/home/test/Downloads/drop.txt" },
            ],
          };
        return undefined;
      },
    },
    event,
    webviewWindow: { WebviewWindow },
    window: {
      LogicalSize,
      getCurrentWindow: () => currentWindow,
    },
  };
  window.tauriFixture = fixture;
}

export async function testTauriChildren(browser, app, mock) {
  const capability = JSON.parse(
    await readFile(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  );
  assert(capability.permissions.includes("core:window:allow-close"));
  assert(capability.permissions.includes("allow-read-clipboard-text"));
  assert(capability.permissions.includes("allow-write-clipboard-text"));
  const page = await browser.newPage();
  const errors = [];
  const deleted = [];
  let visible = [];
  let delayedOpenId;
  let delayedOpenReached = false;
  let releaseDelayedOpen;
  const readViewerSettings = () =>
    fetch(`${app.origin}/api/settings?session=main`, {
      headers: { "X-PenguX11VNC-Token": app.token },
    }).then((response) => response.json());
  const waitForSavedScale = async () => {
    const deadline = Date.now() + 2000;
    let data;
    do {
      data = await readViewerSettings();
      if (Number.isFinite(data.settings?.vncScale)) return data;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return data;
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(installTauriFixture, capability.permissions);
  await page.route("**/api/windows**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/watch"))
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({
          type: "snapshot",
          reason: "initial",
          windows: visible,
        })}\n`,
      });
    const id = url.pathname.match(/^\/api\/windows\/(0x[0-9a-f]+)\/open$/)?.[1];
    if (id && id === delayedOpenId) {
      delayedOpenReached = true;
      await new Promise((resolve) => {
        releaseDelayedOpen = resolve;
      });
    }
    const body = id
      ? {
          session: { id: `window-${id.slice(2)}`, windowId: id, child: true },
          url: `/?session=window-${id.slice(2)}`,
        }
      : { windows: visible };
    return route.fulfill({ json: body });
  });
  await page.route("**/api/sessions/**", (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
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
      () => !location.hash && !!sessionStorage.getItem("pengux11vnc-token"),
    );
    await page.waitForFunction(
      () => !document.querySelector("#connection-mode").disabled,
    );
    await page.selectOption("#connection-mode", "video");
    assert.equal(
      await page.locator("#connection-mode option:checked").textContent(),
      "WebRTC 视频流（VP8 / UDP）",
    );
    await page.click("#settings-toggle");
    await page.selectOption("#bitrate", "high");
    assert.equal(await page.locator("#bitrate-value").textContent(), "高");
    assert.match(await page.locator("#bitrate-help").textContent(), /VP8.*8/);
    await page.selectOption("#frame-rate", "0");
    assert.equal(
      await page.locator("#frame-rate-value").textContent(),
      "最高 · 60 FPS",
    );
    await page.selectOption("#bitrate", "lossless");
    await page.selectOption("#frame-rate", "30");
    await page.click("#settings-close");
    await page.selectOption("#connection-mode", "vnc");
    await page.waitForTimeout(180);
    await page.click("#connect");
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "已连接",
    );
    await page.waitForFunction(() => window.tauriFixture.sizeCalls.length > 0);
    const initialPersistedSettings = await waitForSavedScale();
    assert(
      Number.isFinite(initialPersistedSettings.settings?.vncScale),
      "Initial Tauri VNC scale must be persisted",
    );
    assert.match(
      await page.locator("#window-close").getAttribute("aria-label"),
      /隐藏到(菜单栏|系统托盘)/,
      "Main-window close must explain the native tray behavior",
    );
    await page.waitForFunction(
      () =>
        window.tauriFixture.eventListeners.has(
          "pengux11vnc://native-shortcut",
        ) && window.tauriFixture.eventListeners.has("tauri://drag-drop"),
    );
    await page.click("#settings-toggle");
    if (await page.locator("#view-only").isChecked())
      await page.uncheck("#view-only");
    if (!(await page.locator("#clipboard-sync").isChecked()))
      await page.check("#clipboard-sync");
    await page.waitForFunction(() =>
      window.tauriFixture.invokeCalls.some(
        (call) => call.command === "read_clipboard_text",
      ),
    );
    assert.match(
      await page.locator("#clipboard-status").textContent(),
      /通过系统剪贴板接口/,
      "Tauri should report using the native clipboard bridge",
    );
    await page.click("#settings-close");
    mock.sendClipboard("remote clipboard fixture");
    await page.waitForFunction(() =>
      window.tauriFixture.clipboardWrites.includes("remote clipboard fixture"),
    );
    assert(
      await page.evaluate(() =>
        window.tauriFixture.invokeCalls.some(
          (call) =>
            call.command === "write_clipboard_text" &&
            call.args.text === "remote clipboard fixture",
        ),
      ),
      "remote RFB clipboard text must be written with the native Tauri command",
    );
    const beforeNativeCopy = mock.events.keys.length;
    await page.evaluate(() =>
      window.tauriFixture.emitEvent("pengux11vnc://native-shortcut", {
        key: "c",
      }),
    );
    await page.waitForTimeout(80);
    const nativeCopyKeys = mock.events.keys.slice(beforeNativeCopy);
    assert.deepEqual(
      nativeCopyKeys.slice(-4).map(({ down, sym }) => [down, sym]),
      [
        [1, 0xffe3],
        [1, 0x63],
        [0, 0x63],
        [0, 0xffe3],
      ],
      "macOS native Copy must become remote Ctrl+C",
    );
    const beforeNativePaste = mock.events.keys.length;
    await page.evaluate(() =>
      window.tauriFixture.emitEvent("pengux11vnc://native-shortcut", {
        key: "v",
      }),
    );
    await page.waitForTimeout(80);
    const nativePasteKeys = mock.events.keys.slice(beforeNativePaste);
    assert.deepEqual(
      nativePasteKeys.slice(-4).map(({ down, sym }) => [down, sym]),
      [
        [1, 0xffe3],
        [1, 0x76],
        [0, 0x76],
        [0, 0xffe3],
      ],
      "macOS native Paste must become remote Ctrl+V when no file is present",
    );
    const beforePasswordShortcut = mock.events.keys.length;
    await page.evaluate(async () => {
      const dialog = document.querySelector("#password-dialog");
      dialog.showModal();
      document.querySelector("#password").focus();
      await window.tauriFixture.emitEvent("pengux11vnc://native-shortcut", {
        key: "v",
        localOnly: true,
      });
    });
    await page.waitForFunction(
      () =>
        document.querySelector("#password").value ===
        "remote clipboard fixture",
    );
    assert.equal(
      mock.events.keys.length,
      beforePasswordShortcut,
      "password entry must paste locally without sending remote Ctrl+V",
    );
    await page.evaluate(() => {
      document.querySelector("#password").value = "";
      document.querySelector("#password-dialog").close();
    });
    await page.evaluate(() =>
      window.tauriFixture.emitEvent("tauri://drag-drop", { paths: [] }),
    );
    assert.match(
      await page.locator("#clipboard-files-status").textContent(),
      /没有提供文件路径/,
      "empty native drops must report the missing file path instead of failing silently",
    );
    await page.evaluate(() =>
      window.tauriFixture.emitEvent("tauri://drag-drop", {
        paths: ["/tmp/drop.txt"],
      }),
    );
    await page.waitForFunction(
      () => document.querySelector("#file-upload-dialog").open,
    );
    assert.match(
      await page.locator("#file-upload-summary").textContent(),
      /1 个文件/,
    );
    await page.click("#file-upload-confirm");
    await page.waitForFunction(() =>
      window.tauriFixture.invokeCalls.some(
        (call) => call.command === "upload_files",
      ),
    );
    const uploadCall = await page.evaluate(() =>
      window.tauriFixture.invokeCalls.find(
        (call) => call.command === "upload_files",
      ),
    );
    assert.deepEqual(uploadCall.args.paths, ["/tmp/drop.txt"]);
    await page.click("#settings-toggle");
    assert.match(
      await page.locator("#tauri-close-hint").textContent(),
      /连接继续保持/,
    );
    assert.equal(await page.locator("#tauri-close-hint").isVisible(), true);
    await page.click("#settings-close");
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
    const aspectCall = await page.evaluate(() =>
      window.tauriFixture.invokeCalls.find(
        (call) =>
          call.command === "set_main_window_aspect" &&
          Number(call.args?.width) > 0 &&
          Number(call.args?.height) > 0,
      ),
    );
    assert(
      aspectCall && aspectCall.args.width / aspectCall.args.height > 1,
      "Tauri main window aspect ratio must be registered natively",
    );
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

    // The native child window appears while remote VNC setup is still pending.
    delayedOpenId = "0x2";
    delayedOpenReached = false;
    visible = [info("0x2")];
    const openDeadline = Date.now() + 1500;
    while (!delayedOpenReached && Date.now() < openDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(
      delayedOpenReached,
      "The child-session request must reach the test gate",
    );
    let appearedBeforeSessionReady = false;
    try {
      await page.waitForFunction(
        () =>
          window.tauriFixture.createdUrls.some(
            (item) => item.label === "qq-child-2",
          ) && window.openingChildWindows?.has("0x2"),
        undefined,
        { timeout: 1500 },
      );
      appearedBeforeSessionReady = true;
    } catch {
      // Release the mocked remote operation below before failing the assertion.
    }
    releaseDelayedOpen?.();
    delayedOpenId = undefined;
    assert(
      appearedBeforeSessionReady,
      "The native child window must appear before remote session setup finishes",
    );
    await waitOpen("0x2");
    const childUrl = await page.evaluate(
      () =>
        window.tauriFixture.createdUrls.find(
          (item) => item.label === "qq-child-2",
        ).url,
    );
    assert.equal(new URL(childUrl).pathname, "/child-loading.html");
    assert.equal(
      new URL(childUrl).searchParams.get("session"),
      "window-2",
      "The early child window must wait for its matching VNC session",
    );
    const currentScale = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return canvas.getBoundingClientRect().width / canvas.width;
    });
    assert(
      Math.abs(
        Number(new URL(childUrl).searchParams.get("vncScale")) - currentScale,
      ) < 0.002,
      "Child Tauri window must inherit the main VNC scale",
    );
    visible = [];
    await waitClosed();

    // A minimized child remains a known remote window. It must not be treated
    // as destroyed merely because it is temporarily unmapped.
    visible = [info("0x9")];
    await waitOpen("0x9");
    visible = [{ ...info("0x9"), mapped: false }];
    await page.waitForTimeout(1200);
    assert.equal(
      await page.evaluate(() => window.openedChildWindows.has("0x9")),
      true,
    );
    assert(!deleted.includes("window-9"));
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
    await page.setViewportSize({ width: 900, height: 620 });
    await page.waitForTimeout(40);
    const scaleBeforeDisconnect = await page.evaluate(() => {
      const canvas = document.querySelector("#screen canvas");
      return canvas.getBoundingClientRect().width / canvas.width;
    });
    await page.click("#disconnect");
    await waitClosed();
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "已断开",
    );
    const persistedSettings = await readViewerSettings();
    assert(
      Math.abs(persistedSettings.settings.vncScale - scaleBeforeDisconnect) <
        0.003,
      "Disconnect must persist the latest Tauri window scale",
    );
    await page.waitForFunction(() => window.tauriFixture.focusCalls > 0);
    assert.deepEqual(deleted, [
      "window-2",
      "window-9",
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

    // A fresh app launch must prefer the persisted scale over the default
    // native window size. A disconnected resize is tested separately above.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.waitForFunction(
      () => !location.hash && !!sessionStorage.getItem("pengux11vnc-token"),
    );
    await page.click("#connect");
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "已连接",
    );
    const restartedScale = await page.evaluate(() => {
      const canvas = document.querySelector("#screen canvas");
      const screen = document.querySelector("#screen").getBoundingClientRect();
      const call = window.tauriFixture.sizeCalls.at(-1);
      return {
        width: (call.width - (window.innerWidth - screen.width)) / canvas.width,
        height:
          (call.height - (window.innerHeight - screen.height)) / canvas.height,
      };
    });
    assert(
      Math.abs(restartedScale.width - persistedSettings.settings.vncScale) <
        0.003,
      "A fresh Tauri launch must reuse the persisted VNC scale",
    );
    assert(
      Math.abs(restartedScale.height - persistedSettings.settings.vncScale) <
        0.003,
      "A fresh Tauri launch must reuse the persisted VNC scale on height",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Tauri close contract (simulated IPC), remote/native close, async rejection retry, manual children, main disconnect",
    );
  } finally {
    await page.close();
  }
}
