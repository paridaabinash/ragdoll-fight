/**
 * Fake lag that keeps message order, like a real connection (TCP never reorders).
 *
 * One queue and one timer per direction. The old way (one `setTimeout` per message, each due no earlier than the
 * one before) could reorder: two messages sent in the same moment got the same due time, but the second timer was
 * measured from a slightly later "now", so it expired first. In netsim that let `input(null)` overtake `fire`, the
 * server saw a shot with no draw (`drawn_clamped`, server 0).
 */
export class LagLine {
  private readonly queue: { due: number; fn: () => void }[] = [];
  private lastDue = 0;
  private armed = false;

  /** `now`: clock in ms. `schedule`: run `fn` after about `ms` (setTimeout; tests pass a fake). */
  constructor(
    private readonly now: () => number,
    private readonly schedule: (fn: () => void, ms: number) => void,
  ) {}

  /** Runs `fn` after `delayMs`, but never before anything pushed earlier. */
  push(delayMs: number, fn: () => void): void {
    const due = Math.max(this.lastDue, this.now() + Math.max(0, delayMs));
    this.lastDue = due;
    this.queue.push({ due, fn });
    if (!this.armed) this.arm();
  }

  /** Messages waiting. */
  get size(): number {
    return this.queue.length;
  }

  private arm(): void {
    this.armed = true;
    this.schedule(() => this.run(), Math.max(0, this.queue[0].due - this.now()));
  }

  private run(): void {
    this.armed = false;
    // Timers can wake up to ~1 ms early or late; anything due by now goes out, always in push order.
    const t = this.now() + 1;
    while (this.queue.length && this.queue[0].due <= t) this.queue.shift()!.fn();
    if (this.queue.length) this.arm();
  }
}
