import { describe, expect, it } from 'vitest';
import { LagLine } from '../src';

// (S3. The room's draw-time check that also lived here became the L3 swing-tick check: see l3-gun.test.ts.)

/**
 * Fake clock + timers that run in expiry order, with ties run newest-first (the worst order a real timer queue
 * can pick). The old fake-lag code (one setTimeout per message) reordered messages exactly like this.
 */
function fakeTimers() {
  let now = 0;
  let order = 0;
  const timers: { at: number; order: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => void timers.push({ at: now + ms, order: order++, fn }),
    /** Moves time forward, running timers as they come due. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || b.order - a.order);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift()!;
        now = Math.max(now, t.at);
        t.fn();
      }
      now = end;
    },
  };
}

describe('fake lag keeps message order (LagLine)', () => {
  it('messages sent in the same moment with random delays arrive in the order sent, never early', () => {
    const clock = fakeTimers();
    const line = new LagLine(clock.now, clock.schedule);
    const arrived: { i: number; at: number; due: number }[] = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) {
      // bursts: several messages in the same moment (like `fire` then `input(null)`), then a short gap
      const delay = 60 + rand() * 40;
      const due = clock.now() + delay;
      line.push(delay, () => arrived.push({ i, at: clock.now(), due }));
      if (i % 3 === 2) clock.advance(rand() * 30);
    }
    clock.advance(1000);
    expect(arrived.map((a) => a.i)).toEqual([...Array(200).keys()]);
    for (const a of arrived) expect(a.at).toBeGreaterThanOrEqual(a.due - 1);
    expect(line.size).toBe(0);
  });
});
