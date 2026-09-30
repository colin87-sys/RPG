/**
 * Fixed-timestep clock. Simulation always advances in FIXED_DT steps.
 * Real-time mode: accumulate wall time and run whole steps (capped).
 * Deterministic mode: wall time is ignored; only explicit step(n) advances.
 */
export const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;

export class Clock {
  /** simulation frames since boot/reset */
  frame = 0;
  /** unscaled simulation seconds (frame * FIXED_DT) */
  get time(): number {
    return this.frame * FIXED_DT;
  }
  private acc = 0;
  private last = -1;

  constructor(public deterministic: boolean) {}

  /** Returns how many fixed steps to run for this animation frame. */
  stepsFor(nowMs: number): number {
    if (this.deterministic) return 0;
    if (this.last < 0) {
      this.last = nowMs;
      return 0;
    }
    let dt = (nowMs - this.last) / 1000;
    this.last = nowMs;
    if (dt > 0.25) dt = 0.25; // tab was hidden or a long hitch: do not spiral
    this.acc += dt;
    let n = Math.floor(this.acc / FIXED_DT);
    if (n > MAX_STEPS_PER_FRAME) {
      n = MAX_STEPS_PER_FRAME;
      this.acc = 0;
    } else {
      this.acc -= n * FIXED_DT;
    }
    return n;
  }

  /** Interpolation alpha for rendering between steps (0 in deterministic mode). */
  get alpha(): number {
    return this.deterministic ? 0 : this.acc / FIXED_DT;
  }

  resetWall(): void {
    this.last = -1;
    this.acc = 0;
  }

  tick(): void {
    this.frame++;
  }
}
