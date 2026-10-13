/** Injectable wall clock: live uses the system clock, replay uses block timestamps. */
export interface Clock {
  /** Unix seconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

export class FixedClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  advance(s: number): void {
    this.t += s;
  }
}
