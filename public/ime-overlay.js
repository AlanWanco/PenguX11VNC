// A separate authenticated channel carries only the Fcitx popup, never the desktop.
export class ImeOverlay {
  constructor({ screen, image, status, token }) {
    this.screen = screen;
    this.image = image;
    this.status = status;
    this.socket = new WebSocket(
      `${location.origin.replace("http:", "ws:")}/ime?token=${encodeURIComponent(token)}`,
    );
    this.lastMessage = performance.now();
    this.watchdog = setInterval(() => {
      if (performance.now() - this.lastMessage > 12000) {
        this.socket.close();
        this.frame = null;
        image.hidden = true;
      }
    }, 3000);
    this.socket.addEventListener("message", (event) => {
      if (this.closed) return;
      this.lastMessage = performance.now();
      try {
        const frame = JSON.parse(event.data);
        if (frame.heartbeat) return;
        if (!frame.visible) {
          this.frame = null;
          image.hidden = true;
          status.textContent = "候选框补采集已连接；QQ 输入拼音时自动显示。";
          return;
        }
        for (const field of [
          "x",
          "y",
          "width",
          "height",
          "frameWidth",
          "frameHeight",
        ]) {
          if (!Number.isFinite(frame[field]) || Math.abs(frame[field]) > 16384)
            return;
        }
        if (
          frame.width < 1 ||
          frame.height < 1 ||
          frame.frameWidth < 1 ||
          frame.frameHeight < 1 ||
          typeof frame.png !== "string" ||
          !/^iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(frame.png) ||
          frame.png.length > 12 * 1024 * 1024
        )
          return;
        this.frame = frame;
        image.src = `data:image/png;base64,${frame.png}`;
        this.position();
        status.textContent = "正在显示远端候选框；优先使用数字键或空格选词。";
      } catch {
        /* Invalid helper frames are ignored. */
      }
    });
    this.socket.addEventListener("close", () => {
      clearInterval(this.watchdog);
      if (this.closed) return;
      this.frame = null;
      image.hidden = true;
      status.textContent = "候选框补采集未连接；QQ 主画面不受影响。";
    });
  }

  position() {
    const canvas = this.screen.querySelector("canvas");
    const frame = this.frame;
    if (
      !frame ||
      !canvas ||
      canvas.width !== frame.frameWidth ||
      canvas.height !== frame.frameHeight
    ) {
      this.image.hidden = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const bounds = this.image.parentElement.getBoundingClientRect();
    const scale = rect.width / canvas.width;
    Object.assign(this.image.style, {
      left: `${rect.left - bounds.left + frame.x * scale}px`,
      top: `${rect.top - bounds.top + frame.y * scale}px`,
      width: `${frame.width * scale}px`,
      height: `${frame.height * scale}px`,
    });
    this.image.hidden = false;
  }

  close() {
    this.closed = true;
    clearInterval(this.watchdog);
    this.frame = null;
    this.image.hidden = true;
    this.image.removeAttribute("src");
    this.socket.close();
  }
}
