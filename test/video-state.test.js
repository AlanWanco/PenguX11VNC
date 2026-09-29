import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldFailDisconnectedVideoPeer,
  VIDEO_DISCONNECT_GRACE_MS,
} from "../public/video-state.js";

test("video disconnect grace allows ICE to recover without failing the session", () => {
  assert.equal(VIDEO_DISCONNECT_GRACE_MS, 10_000);
  const peer = { connectionState: "disconnected" };
  assert.equal(shouldFailDisconnectedVideoPeer(peer, peer), true);

  peer.connectionState = "connected";
  assert.equal(shouldFailDisconnectedVideoPeer(peer, peer), false);
});

test("stale video peers cannot fail a replacement session", () => {
  const oldPeer = { connectionState: "disconnected" };
  const activePeer = { connectionState: "connected" };
  assert.equal(shouldFailDisconnectedVideoPeer(oldPeer, activePeer), false);
});
