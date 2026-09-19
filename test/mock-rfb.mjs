import net from "node:net";

export async function startMock() {
  const events = {
    pointers: [],
    keys: [],
    encodings: [],
    resizeRequests: 0,
    frameRequests: 0,
    clipboard: [],
  };
  const clients = new Set();
  const width = 1669;
  const height = 1147;
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    socket.write("RFB 003.003\n");
    let state = "version";
    let buffer = Buffer.alloc(0);
    let sentFrame = false;
    function frame() {
      const header = Buffer.alloc(16);
      header.writeUInt16BE(1, 2);
      header.writeUInt16BE(width, 8);
      header.writeUInt16BE(height, 10);
      const pixels = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const grid = x % 160 < 2 || y % 160 < 2;
          pixels[i] = grid ? 200 : x < 380 ? 38 : 28;
          pixels[i + 1] = grid ? 170 : x < 380 ? 31 : 25;
          pixels[i + 2] = grid ? 150 : x < 380 ? 33 : 24;
        }
      }
      socket.write(header);
      socket.write(pixels);
    }
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (state === "version") {
          if (buffer.length < 12) return;
          buffer = buffer.subarray(12);
          socket.write(Buffer.from([0, 0, 0, 1]));
          state = "init";
        } else if (state === "init") {
          buffer = buffer.subarray(1);
          const name = Buffer.from("QQ test fixture");
          const init = Buffer.alloc(24);
          init.writeUInt16BE(width, 0);
          init.writeUInt16BE(height, 2);
          init.set(
            [32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0],
            4,
          );
          init.writeUInt32BE(name.length, 20);
          socket.write(Buffer.concat([init, name]));
          state = "messages";
        } else {
          const type = buffer[0];
          let size;
          if (type === 0) size = 20;
          else if (type === 2) {
            if (buffer.length < 4) return;
            size = 4 + buffer.readUInt16BE(2) * 4;
          } else if (type === 3) size = 10;
          else if (type === 4) size = 8;
          else if (type === 5) size = 6;
          else if (type === 6) {
            if (buffer.length < 8) return;
            size = 8 + Math.abs(buffer.readInt32BE(4));
          } else {
            socket.destroy(new Error(`Unexpected message ${type}`));
            return;
          }
          if (buffer.length < size) return;
          const message = buffer.subarray(0, size);
          buffer = buffer.subarray(size);
          if (type === 2)
            for (let offset = 4; offset < size; offset += 4)
              events.encodings.push(message.readInt32BE(offset));
          if (type === 3) {
            events.frameRequests += 1;
            if (!sentFrame) {
              sentFrame = true;
              frame();
            } else {
              socket.write(Buffer.from([0, 0, 0, 0]));
            }
          }
          if (type === 4)
            events.keys.push({
              down: message[1],
              sym: message.readUInt32BE(4),
            });
          if (type === 5)
            events.pointers.push({
              mask: message[1],
              x: message.readUInt16BE(2),
              y: message.readUInt16BE(4),
            });
          if (type === 6) events.clipboard.push(message.subarray(8).toString());
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    events,
    width,
    height,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
