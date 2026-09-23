const frameRates = new Set([0, 5, 10, 15, 24, 30, 60]);
const videoBitratePresetsKbps = Object.freeze({
  high: 8000,
  balanced: 4000,
  low: 1500,
});

// VNC's lossless preset leaves the connection profile's VP8 target bitrate intact.
export function videoStreamOverrides(settings = {}) {
  const requestedFrameRate = Number(settings.frameRate);
  const frameRate = frameRates.has(requestedFrameRate)
    ? requestedFrameRate
    : 30;
  const overrides = { fps: frameRate === 0 ? 60 : frameRate };
  const bitrateKbps = videoBitratePresetsKbps[settings.bitrate];
  if (bitrateKbps) overrides.bitrateKbps = bitrateKbps;
  return overrides;
}
