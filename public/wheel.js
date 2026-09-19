// Pure, testable normalization of high-resolution wheel input into RFB steps.
export class WheelLimiter {
  constructor(sensitivity = 0.25) {
    this.setSensitivity(sensitivity);
  }

  setSensitivity(value) {
    this.sensitivity = Math.max(0.05, Math.min(1, Number(value) || 0.25));
    this.reset();
  }

  reset() {
    this.remainder = { x: 0, y: 0 };
    this.lastInput = -Infinity;
    this.lastOutput = -Infinity;
  }

  consume({ deltaX = 0, deltaY = 0, deltaMode = 0 }, now, pageHeight = 600) {
    if (now - this.lastInput > 800) this.remainder = { x: 0, y: 0 };
    this.lastInput = now;
    const unit =
      deltaMode === 1 ? 19 : deltaMode === 2 ? Math.max(1, pageHeight) : 1;
    for (const [axis, delta] of [
      ["x", deltaX],
      ["y", deltaY],
    ]) {
      if (!Number.isFinite(delta)) continue;
      if (delta && Math.sign(delta) !== Math.sign(this.remainder[axis]))
        this.remainder[axis] = 0;
      this.remainder[axis] +=
        Math.max(-2000, Math.min(2000, delta * unit)) * this.sensitivity;
      // No unbounded backlog from trackpad momentum / smooth-wheel drivers.
      this.remainder[axis] = Math.max(
        -100,
        Math.min(100, this.remainder[axis]),
      );
    }
    if (now - this.lastOutput < 32) return [];
    const steps = [];
    for (const axis of ["y", "x"]) {
      while (Math.abs(this.remainder[axis]) >= 50 && steps.length < 2) {
        const sign = Math.sign(this.remainder[axis]);
        steps.push(axis === "y" ? (sign < 0 ? 8 : 16) : sign < 0 ? 32 : 64);
        this.remainder[axis] -= sign * 50;
      }
    }
    if (steps.length) this.lastOutput = now;
    return steps;
  }
}
