// noVNC adapter, based in part on noVNC's RFB implementation.
// Copyright (C) The noVNC authors; modifications (C) 2026 PenguX11VNC contributors.
// SPDX-License-Identifier: MPL-2.0
// Private hooks are tied to noVNC 1.7.0. Do not edit node_modules.
import RFB from "/vendor/core/rfb.js";
import { clientToElement } from "/vendor/core/util/element.js";
import { encodings as e } from "/vendor/core/encodings.js";
import { WheelLimiter } from "./wheel.js";

export default class QQRFB extends RFB {
  constructor(...args) {
    super(...args);
    this._frameRate = 30;
    this._frameRateTimer = undefined;
    this._frameRequestInFlight = false;
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
    if (this._rfbConnectionState === "connected") {
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

  _framebufferUpdate() {
    const result = super._framebufferUpdate();
    if (result) this._frameRequestInFlight = false;
    if (result && this._frameRate !== 0) {
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
