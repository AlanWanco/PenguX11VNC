export const VIDEO_DISCONNECT_GRACE_MS = 10_000;

export function shouldFailDisconnectedVideoPeer(peer, activePeer) {
  return (
    peer === activePeer &&
    ["failed", "disconnected"].includes(peer?.connectionState)
  );
}
