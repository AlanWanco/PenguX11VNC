// noVNC adapter, based in part on noVNC's RFB implementation.
// Copyright (C) The noVNC authors; modifications (C) 2026 PenguX11VNC contributors.
// SPDX-License-Identifier: MPL-2.0
// Private hooks are tied to noVNC 1.7.0. Do not edit node_modules.
import RFB from "/vendor/core/rfb.js";
import { clientToElement } from "/vendor/core/util/element.js";
import { releaseCapture } from "/vendor/core/util/events.js";
import { encodings as e } from "/vendor/core/encodings.js";
import KeyTable from "/vendor/core/input/keysym.js";
import { WheelLimiter } from "./wheel.js";

const isMacPlatform = /Mac|iPhone|iPad/.test(
  `${navigator.platform || ""} ${navigator.userAgent || ""}`,
);
const controlShortcutKeys = {
  c: { keysym: 0x63, code: "KeyC" },
  v: { keysym: 0x76, code: "KeyV" },
  x: { keysym: 0x78, code: "KeyX" },
};

export default class QQRFB extends RFB {
  constructor(...args) {
    super(...args);
    this._frameRate = 30;
    this._frameRateTimer = undefined;
    this._debugPointerAt = 0;
    this._frameRequestInFlight = false;
    this._videoMode = false;
  }

  get videoMode() {
    return this._videoMode;
  }

  // WKWebView and browsers expose macOS Command as Meta. noVNC intentionally
  // maps that key to Alt for generic remote desktops, but the remote target is
  // Linux and its normal copy/paste shortcuts are Ctrl+C/Ctrl+V. Translate the
  // modifier at the RFB boundary so both native menu shortcuts and ordinary
  // key events behave like a Linux keyboard.
  _handleKeyEvent(keysym, code, down, numlock, capslock) {
    if (isMacPlatform && (code === "MetaLeft" || code === "MetaRight")) {
      const right = code === "MetaRight";
      keysym = right ? KeyTable.XK_Control_R : KeyTable.XK_Control_L;
      code = right ? "ControlRight" : "ControlLeft";
    }
    super._handleKeyEvent(keysym, code, down, numlock, capslock);
  }

  sendCtrlShortcut(key) {
    if (this._rfbConnectionState !== "connected" || this._viewOnly) return;
    const shortcut = controlShortcutKeys[String(key).toLowerCase()];
    if (!shortcut) return;
    this.sendKey(KeyTable.XK_Control_L, "ControlLeft", true);
    this.sendKey(shortcut.keysym, shortcut.code, true);
    this.sendKey(shortcut.keysym, shortcut.code, false);
    this.sendKey(KeyTable.XK_Control_L, "ControlLeft", false);
  }

  set videoMode(value) {
    this._videoMode = value === true;
    clearTimeout(this._frameRateTimer);
    this._frameRateTimer = undefined;
    if (this._rfbConnectionState !== "connected") return;
    if (this._videoMode) {
      this._enabledContinuousUpdates = false;
      return;
    }
    if (this._frameRate === 0) {
      this._enabledContinuousUpdates = false;
      if (!this._frameRequestInFlight) this._requestFrame();
    } else {
      this._enabledContinuousUpdates = true;
      if (!this._frameRequestInFlight) this._scheduleFrameRequest();
    }
  }

  get frameRate() {
    return this._frameRate;
  }

  set frameRate(value) {
    const frameRate = Number(value);
    if (![0, 5, 10, 15, 24, 30, 60].includes(frameRate)) return;
    this._frameRate = frameRate;
    clearTimeout(this._frameRateTimer);
    this._frameRateTimer = undefined;
    if (this._rfbConnectionState === "connected" && !this._videoMode) {
      if (frameRate === 0) {
        this._enabledContinuousUpdates = false;
        if (!this._frameRequestInFlight) this._requestFrame();
      } else {
        this._enabledContinuousUpdates = true;
        if (!this._frameRequestInFlight) this._scheduleFrameRequest();
      }
    }
  }

  _requestFrame() {
    if (
      this._videoMode ||
      !this._sock ||
      this._rfbConnectionState !== "connected" ||
      this._sock.readyState !== "open"
    )
      return;
    this._frameRequestInFlight = true;
    this._enabledContinuousUpdates = false;
    RFB.messages.fbUpdateRequest(
      this._sock,
      true,
      0,
      0,
      this._fbWidth,
      this._fbHeight,
    );
  }

  _scheduleFrameRequest() {
    clearTimeout(this._frameRateTimer);
    if (this._frameRate === 0 || !this._sock || this._frameRequestInFlight)
      return;
    const delay = Math.ceil(1000 / this._frameRate);
    this._frameRateTimer = setTimeout(() => {
      this._frameRateTimer = undefined;
      this._requestFrame();
    }, delay);
  }

  get socketCloseInfo() {
    return this._socketCloseInfo;
  }

  _socketClose(event) {
    this._socketCloseInfo = {
      code: Number.isInteger(event?.code) ? event.code : null,
      wasClean: event?.wasClean === true,
      reasonLength: typeof event?.reason === "string" ? event.reason.length : 0,
      state: this._rfbConnectionState || "unknown",
    };
    super._socketClose(event);
  }

  _framebufferUpdate() {
    const result = super._framebufferUpdate();
    if (result) this._frameRequestInFlight = false;
    if (result && this._frameRate !== 0 && !this._videoMode) {
      // The upstream handler immediately requests the next update. Mark this
      // one as continuous until our timer sends the next incremental request.
      this._enabledContinuousUpdates = true;
      this._scheduleFrameRequest();
    }
    return result;
  }

  disconnect() {
    clearTimeout(this._frameRateTimer);
    this._frameRateTimer = undefined;
    this._frameRequestInFlight = false;
    super.disconnect();
  }

  set wheelSensitivity(value) {
    this.wheelLimiter ??= new WheelLimiter();
    this.wheelLimiter.setSensitivity(value);
  }

  set bitrateMode(mode) {
    const settings = {
      lossless: { quality: null, compression: 6 },
      high: { quality: 8, compression: 2 },
      balanced: { quality: 6, compression: 5 },
      low: { quality: 3, compression: 9 },
    }[mode] || { quality: null, compression: 6 };
    this._bitrateMode = settings.quality === null ? "lossless" : mode;
    this.compressionLevel = settings.compression;
    if (settings.quality !== null) this.qualityLevel = settings.quality;
    if (this._rfbConnectionState === "connected") this._sendEncodings();
  }

  _handleWheel(event) {
    event.preventDefault();
    event.stopPropagation();
    if (this._rfbConnectionState !== "connected" || this._viewOnly) {
      this.wheelLimiter?.reset();
      return;
    }
    this.wheelLimiter ??= new WheelLimiter();
    const pos = clientToElement(event.clientX, event.clientY, this._canvas);
    const held = RFB._convertButtonMask(event.buttons);
    const steps = this.wheelLimiter.consume(
      event,
      performance.now(),
      this._canvas.clientHeight,
    );
    for (const button of steps) {
      // Upstream maps canvas coordinates through its own display scale exactly once.
      this._handleMouseButton(pos.x, pos.y, held | button);
      this._handleMouseButton(pos.x, pos.y, held);
    }
  }

  resetPointerState() {
    releaseCapture();
    clearTimeout(this._mouseMoveTimer);
    this._mouseMoveTimer = null;
    this._mouseButtonMask = 0;
    this._debugPointerAt = 0;
    this._viewportDragging = false;
    this._viewportHasMoved = false;
  }

  _sendMouse(x, y, mask) {
    if (this._rfbConnectionState !== "connected" || this._viewOnly) return;
    if (mask & 0x8000)
      throw new Error(`Illegal mouse button mask (mask: ${mask})`);

    // noVNC normally uses one cached Display scale for both axes. A native
    // Tauri resize can briefly leave that cache one layout tick behind, which
    // makes a click land at the old position. Derive the coordinates from the
    // actual canvas rectangle and the current viewport on every event.
    const bounds = this._canvas?.getBoundingClientRect?.();
    const viewport = this._display?._viewportLoc;
    const viewportWidth = viewport?.w || this._fbWidth;
    const viewportHeight = viewport?.h || this._fbHeight;
    let pointerX = x;
    let pointerY = y;
    if (
      bounds?.width > 0 &&
      bounds?.height > 0 &&
      viewportWidth > 0 &&
      viewportHeight > 0
    ) {
      pointerX = (x / bounds.width) * viewportWidth + (viewport?.x || 0);
      pointerY = (y / bounds.height) * viewportHeight + (viewport?.y || 0);
    }
    const maxX = Math.max(0, (this._fbWidth || viewportWidth) - 1);
    const maxY = Math.max(0, (this._fbHeight || viewportHeight) - 1);
    pointerX = Math.max(0, Math.min(maxX, Math.round(pointerX)));
    pointerY = Math.max(0, Math.min(maxY, Math.round(pointerY)));

    if (globalThis.penguX11VNCDebug) {
      const now = performance.now();
      if (now - this._debugPointerAt >= 500) {
        this._debugPointerAt = now;
        globalThis.penguX11VNCLog?.("pointer-map", {
          inputX: x,
          inputY: y,
          mappedX: pointerX,
          mappedY: pointerY,
          mask,
          framebuffer: { width: this._fbWidth, height: this._fbHeight },
          viewport: viewport
            ? {
                x: viewport.x,
                y: viewport.y,
                width: viewport.w,
                height: viewport.h,
              }
            : null,
          canvas: bounds
            ? { width: bounds.width, height: bounds.height }
            : null,
        });
      }
    }

    const extendedMouseButtons = mask & 0x7f80;
    if (this._extendedPointerEventSupported && extendedMouseButtons) {
      RFB.messages.extendedPointerEvent(this._sock, pointerX, pointerY, mask);
    } else {
      RFB.messages.pointerEvent(this._sock, pointerX, pointerY, mask);
    }
  }

  _sendEncodings() {
    // The default is lossless. Lower bitrate modes opt into JPEG/Tight and the
    // standard RFB quality pseudo-encoding; they never resize the remote QQ.
    const mode = this._bitrateMode || "lossless";
    const encs = [e.encodingCopyRect];
    if (this._fbDepth === 24) {
      if (mode !== "lossless") encs.push(e.encodingTight, e.encodingJPEG);
      encs.push(
        e.encodingZRLE,
        e.encodingHextile,
        e.encodingRRE,
        e.encodingZlib,
      );
    }
    encs.push(
      e.encodingRaw,
      ...(mode !== "lossless"
        ? [e.pseudoEncodingQualityLevel0 + this._qualityLevel]
        : []),
      e.pseudoEncodingCompressLevel0 + this._compressionLevel,
      e.pseudoEncodingDesktopSize,
      e.pseudoEncodingLastRect,
      e.pseudoEncodingQEMUExtendedKeyEvent,
      e.pseudoEncodingQEMULedEvent,
      e.pseudoEncodingExtendedDesktopSize,
      e.pseudoEncodingFence,
      e.pseudoEncodingDesktopName,
      e.pseudoEncodingExtendedClipboard,
      e.pseudoEncodingExtendedMouseButtons,
    );
    if (this._fbDepth === 24)
      encs.push(e.pseudoEncodingVMwareCursor, e.pseudoEncodingCursor);
    RFB.messages.clientEncodings(this._sock, encs);
  }

  get unicodeClipboard() {
    return Boolean(
      this._clipboardServerCapabilitiesFormats[1] &&
      this._clipboardServerCapabilitiesActions[1 << 27],
    );
  }
}
