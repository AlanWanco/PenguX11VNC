import assert from "node:assert/strict";
import test from "node:test";
import { videoStreamOverrides } from "../public/video-settings.js";

test("video bitrate presets map to the VP8 target bitrate", () => {
  assert.deepEqual(videoStreamOverrides({ bitrate: "high", frameRate: 30 }), {
    fps: 30,
    bitrateKbps: 8000,
  });
  assert.deepEqual(
    videoStreamOverrides({ bitrate: "balanced", frameRate: 24 }),
    { fps: 24, bitrateKbps: 4000 },
  );
  assert.deepEqual(videoStreamOverrides({ bitrate: "low", frameRate: 5 }), {
    fps: 5,
    bitrateKbps: 1500,
  });
});

test("lossless VNC mode preserves the profile's VP8 bitrate and unlimited means max fps", () => {
  assert.deepEqual(
    videoStreamOverrides({ bitrate: "lossless", frameRate: 0 }),
    {
      fps: 60,
    },
  );
});

test("invalid viewer settings use bounded video defaults", () => {
  assert.deepEqual(
    videoStreamOverrides({ bitrate: "invalid", frameRate: 120 }),
    {
      fps: 30,
    },
  );
});
