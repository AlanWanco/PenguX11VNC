import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv } from "node:crypto";
import { WebSocket } from "ws";
import { startServer, decodePassword } from "../server.js";
import { connectionFromJson } from "../config.js";
import { WheelLimiter } from "../public/wheel.js";

function count(sensitivity) {
  const wheel = new WheelLimiter(sensitivity);
  let total = 0;
  for (let i = 0; i < 20; i++)
    total += wheel.consume({ deltaY: 40 }, i * 40).length;
  return total;
}
test("25% wheel sensitivity emits a quarter as many steps for a fixed pixel stream", () => {
  assert.equal(count(1), 16);
  assert.equal(count(0.25), 4);
});
test("wheel direction, horizontal axis, line and page units", () => {
  for (const [event, button] of [
    [{ deltaY: -50 }, 8],
    [{ deltaY: 50 }, 16],
    [{ deltaX: -50 }, 32],
    [{ deltaX: 50 }, 64],
  ]) {
    assert.deepEqual(new WheelLimiter(1).consume(event, 0), [button]);
  }
  assert.deepEqual(
    new WheelLimiter(1).consume({ deltaY: 3, deltaMode: 1 }, 0),
    [16],
  );
  assert.deepEqual(
    new WheelLimiter(0.25).consume({ deltaY: 1, deltaMode: 2 }, 0, 400),
    [16, 16],
  );
});
test("bursts are bounded, no timer backlog, reset on reversal and idle", () => {
  const wheel = new WheelLimiter(1);
  assert.equal(wheel.consume({ deltaY: 1e6 }, 0).length, 2);
  assert.equal(wheel.consume({ deltaY: 1e6 }, 1).length, 0);
  assert.deepEqual(wheel.consume({ deltaY: -50 }, 40), [8]);
  wheel.consume({ deltaY: 40 }, 80);
  assert.deepEqual(wheel.consume({ deltaY: 20 }, 1000), []);
  wheel.setSensitivity(0.25);
  assert.deepEqual(wheel.consume({ deltaY: 40 }, 1040), []);
  assert.deepEqual(wheel.consume({ deltaY: NaN }, 1080), []);
});
test("connection profiles validate ports, window IDs and viewer defaults", () => {
  const profile = connectionFromJson(
    JSON.stringify({
      id: "tablet-linux",
      name: "Tablet",
      ssh: {
        user: "user",
        host: "linux.example",
        port: 22,
        privateKeyFile: "~/.ssh/id_ed25519",
      },
      tunnel: { localPort: 15901, remoteHost: "127.0.0.1", remotePort: 5901 },
      window: {
        display: ":1",
        xauthority: "/run/user/1000/xauth",
        id: "0xabc",
        className: "QQ",
      },
      viewer: {
        wheel: 12,
        bitrate: "low",
        frameRate: 15,
        clipboardSync: true,
        autoOpen: false,
      },
    }),
  );
  assert.equal(profile.id, "tablet-linux");
  assert.equal(profile.tunnel.localPort, 15901);
  assert.equal(profile.viewer.wheel, 12);
  assert.equal(profile.viewer.bitrate, "low");
  assert.equal(profile.viewer.frameRate, 15);
  assert.equal(profile.viewer.clipboardSync, true);
  assert.throws(() =>
    connectionFromJson(
      JSON.stringify({ id: "bad", window: { id: "not-an-xid" } }),
    ),
  );
});

test("viewer settings persist for the main session", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pengux11vnc-settings-"));
  const settingsPath = path.join(directory, "settings.json");
  const app = await startServer({ port: 0, settingsPath });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const headers = {
    "X-PenguX11VNC-Token": app.token,
    "Content-Type": "application/json",
  };
  const saved = await fetch(`${app.origin}/api/settings?session=main`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      settings: { wheel: 55, bitrate: "low", frameRate: 15 },
    }),
  });
  assert.equal(saved.status, 200);
  const loaded = await fetch(`${app.origin}/api/settings?session=main`, {
    headers,
  });
  assert.equal(loaded.status, 200);
  assert.deepEqual((await loaded.json()).settings, {
    wheel: 55,
    viewOnly: false,
    scale: "fit",
    bitrate: "low",
    frameRate: 15,
    clipboardSync: false,
    autoChildOpen: true,
    systemTitlebar: true,
  });
  const layoutSaved = await fetch(`${app.origin}/api/layout?session=main`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ position: { left: 321.4, top: 654.6 } }),
  });
  assert.equal(layoutSaved.status, 200);
  const layoutLoaded = await fetch(`${app.origin}/api/layout?session=main`, {
    headers,
  });
  assert.deepEqual((await layoutLoaded.json()).position, {
    left: 321,
    top: 655,
  });
});

test("VNC password decoding works without exposing the password", () => {
  // Independently apply the VNC bit-order convention to the historical key.
  const key = Buffer.from(
    [23, 82, 107, 6, 35, 78, 88, 7].map((byte) =>
      parseInt(
        byte.toString(2).padStart(8, "0").split("").reverse().join(""),
        2,
      ),
    ),
  );
  const cipher = createCipheriv(
    "des-ede3",
    Buffer.concat([key, key, key]),
    null,
  );
  cipher.setAutoPadding(false);
  const encoded = Buffer.concat([
    cipher.update(Buffer.from("test123\0")),
    cipher.final(),
  ]);
  assert.equal(decodePassword(encoded), "test123");
  assert.throws(() => decodePassword(Buffer.alloc(7)));
});

function request(origin, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${origin}${path}`, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
  });
}
test("VNC credentials are shared in memory and cleared on request", async (t) => {
  const app = await startServer({ port: 0 });
  t.after(() => app.close());
  const headers = {
    "X-PenguX11VNC-Token": app.token,
    "Content-Type": "application/json",
  };
  const saved = await fetch(
    `${app.origin}/api/credentials/cache?session=main`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "test123" }),
    },
  );
  assert.equal(saved.status, 200);
  const loaded = await fetch(`${app.origin}/api/credentials?session=main`, {
    headers,
  });
  assert.equal(loaded.status, 200);
  assert.deepEqual(await loaded.json(), { password: "test123" });
  const cleared = await fetch(
    `${app.origin}/api/credentials/cache?session=main`,
    { method: "DELETE", headers },
  );
  assert.equal(cleared.status, 200);
  const empty = await fetch(`${app.origin}/api/credentials?session=main`, {
    headers,
  });
  assert.deepEqual(await empty.json(), {});
});

test("closing a child VNC websocket reclaims its remote session", async (t) => {
  const managerToken = "test-manager-token";
  const deleted = [];
  const activated = [];
  const manager = http.createServer((req, res) => {
    if (req.headers["x-pengux11vnc-token"] !== managerToken) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/windows") {
      res.end(
        JSON.stringify({
          windows: [
            {
              id: "0x2",
              mapped: true,
              depth: 24,
              x: 0,
              y: 0,
              width: 100,
              height: 100,
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/windows/0x2/open") {
      const session = {
        id: "window-2",
        title: "QQ 子窗口 · 0x2",
        windowId: "0x2",
        child: true,
        targetPort: rfbPort,
        localPort: rfbPort,
        remotePort: 5901,
        geometry: {
          id: "0x2",
          mapped: true,
          depth: 24,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        },
      };
      res.end(JSON.stringify({ session }));
      return;
    }
    if (req.url === "/sessions/window-2/activate" && req.method === "POST") {
      activated.push(req.url);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/sessions/window-2" && req.method === "DELETE") {
      deleted.push(req.url);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  const rfbServer = net.createServer(() => {});
  await new Promise((resolve) => rfbServer.listen(0, "127.0.0.1", resolve));
  const rfbPort = rfbServer.address().port;
  await new Promise((resolve) => manager.listen(0, "127.0.0.1", resolve));
  const managerPort = manager.address().port;
  const app = await startServer({
    port: 0,
    targetPort: rfbPort,
    manager: {
      url: `http://127.0.0.1:${managerPort}`,
      token: managerToken,
    },
    connection: {
      id: "test-child",
      children: { enabled: true },
      window: { id: "0x1", className: "QQ" },
    },
  });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => manager.close(resolve));
    await new Promise((resolve) => rfbServer.close(resolve));
  });
  const headers = { "X-PenguX11VNC-Token": app.token };
  const opened = await fetch(
    `${app.origin}/api/windows/0x2/open?session=main`,
    { method: "POST", headers },
  );
  assert.equal(opened.status, 200);
  const child = await opened.json();
  const activatedResponse = await fetch(
    `${app.origin}/api/sessions/${child.session.id}/activate`,
    { method: "POST", headers },
  );
  assert.equal(activatedResponse.status, 200);
  assert.deepEqual(activated, ["/sessions/window-2/activate"]);
  const ws = new WebSocket(
    `${app.origin.replace("http:", "ws:")}/vnc?session=${child.session.id}`,
    { headers: { Origin: app.origin, "X-PenguX11VNC-Token": app.token } },
  );
  await once(ws, "open");
  ws.close();
  await once(ws, "close");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(deleted, ["/sessions/window-2"]);
});

test("local server restricts API, Origin, Host, static files and WebSocket access", async (t) => {
  const app = await startServer({ port: 0 });
  t.after(() => app.close());
  const page = await request(app.origin, "/");
  assert.equal(page.status, 200);
  assert.match(
    page.headers["content-security-policy"],
    /frame-ancestors 'none'/,
  );
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal((await request(app.origin, "/api/credentials")).status, 403);
  const credentials = await request(app.origin, "/api/credentials", {
    "X-PenguX11VNC-Token": app.token,
  });
  assert.equal(credentials.status, 200);
  assert.deepEqual(JSON.parse(credentials.body), {});
  for (const headers of [
    { Host: "attacker.example" },
    { Origin: "https://attacker.example" },
  ]) {
    assert.equal((await request(app.origin, "/", headers)).status, 403);
  }
  for (const file of [
    "/server.js",
    "/package.json",
    "/vendor/package.json",
    "/vendor/core/%2e%2e/%2e%2e/%2e%2e/ws/index.js",
    "/%2e%2e/server.js",
  ]) {
    assert.equal((await request(app.origin, file)).status, 404, file);
  }
  assert.equal((await request(app.origin, "/vendor/core/rfb.js")).status, 200);
  for (const [token, origin] of [
    ["wrong", app.origin],
    [app.token, "https://attacker.example"],
    [app.token, undefined],
  ]) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `${app.origin.replace("http:", "ws:")}/vnc?token=${token}`,
        { origin },
      );
      ws.on("open", () => {
        ws.close();
        reject(new Error("Unauthorized websocket accepted"));
      });
      ws.on("error", (error) => {
        assert.match(error.message, /403/);
        resolve();
      });
    });
  }
});
