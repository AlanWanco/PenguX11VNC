import { spawn } from "node:child_process";

function startLocalImeBridge(ws, command) {
  const child = spawn(command[0], command.slice(1), {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    buffer += data;
    if (buffer.length > 16 * 1024 * 1024) {
      child.kill();
      ws.close(1009, "IME frame too large");
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (ws.readyState === 1 && ws.bufferedAmount < 2 * 1024 * 1024)
        ws.send(line);
    }
  });
  child.on("error", () => ws.close(1011, "IME helper unavailable"));
  child.on("exit", () => ws.close(1000, "IME helper stopped"));
  ws.on("error", () => child.kill());
  ws.on("close", () => child.kill());
}

async function startRustImeBridge(ws, manager) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  ws.on("error", stop);
  ws.on("close", stop);
  try {
    const response = await fetch(new URL("/ime", `${manager.url}/`), {
      headers: { "X-PenguX11VNC-Token": manager.token },
      signal: controller.signal,
    });
    if (!response.ok || !response.body)
      throw new Error("Rust IME manager unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (ws.readyState === 1) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (ws.readyState === 1 && ws.bufferedAmount < 2 * 1024 * 1024)
          ws.send(line);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted && ws.readyState === 1)
      ws.close(1011, error.message || "IME manager unavailable");
  } finally {
    controller.abort();
  }
}

export function startImeBridge(ws, source) {
  if (!source) {
    ws.close(1000, "IME overlay not configured");
    return;
  }
  if (source.url && source.token) {
    void startRustImeBridge(ws, source);
    return;
  }
  startLocalImeBridge(ws, source);
}

function sshCommandFor(connection, helper, windowId) {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
  ];
  if (connection.ssh.privateKeyFile)
    args.push("-i", connection.ssh.privateKeyFile, "-o", "IdentitiesOnly=yes");
  args.push(
    "-p",
    String(connection.ssh.port),
    `${connection.ssh.user}@${connection.ssh.host}`,
  );
  args.push(
    `env DISPLAY='${connection.window.display}' XAUTHORITY='${connection.window.xauthority}' ${helper} ${windowId}`,
  );
  return ["ssh", ...args];
}

export function imeCommandFor(connection) {
  return sshCommandFor(
    connection,
    connection.helpers.imeCapture,
    connection.window.id,
  );
}
