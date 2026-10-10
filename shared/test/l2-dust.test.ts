import { describe, expect, it } from 'vitest';
import { DUST, DustTracker, type Puff } from '../../client/src/dust';

/**
 * Feeds the tracker one body for `frames` frames at 60 fps; `at(i)` gives feet x/y and grounded per frame, and
 * optionally each foot's height above the ground (`lift`: front, back; default both down).
 */
function feed(at: (i: number) => { x: number; y: number; grounded: boolean; alive?: boolean; lift?: [number, number]; spread?: number }, frames: number, tracker = new DustTracker(), t0 = 1000): Puff[] {
  const out: Puff[] = [];
  for (let i = 0; i < frames; i++) {
    const s = at(i);
    const [lf, lb] = s.lift ?? [0, 0];
    const half = (s.spread ?? 0) / 2;
    const soles: [{ x: number; y: number }, { x: number; y: number }] = [{ x: s.x + half, y: s.y - lf }, { x: s.x - half, y: s.y - lb }];
    out.push(...tracker.update([{ id: 'a', feet: { x: s.x, y: s.y }, soles, grounded: s.grounded, alive: s.alive ?? true }], t0 + (i * 1000) / 60));
  }
  return out;
}

describe('L2 dust puffs (client)', () => {
  it('standing still: nothing', () => {
    expect(feed(() => ({ x: 5, y: 17, grounded: true }), 120)).toEqual([]);
  });

  it('running: a small puff each time the foot behind pushes off (funny legs), drifting back', () => {
    // 5 m/s for 1 s; feet 0.6 m apart; the BACK foot lifts every 10 frames (a push-off), the front foot stays down
    const puffs = feed((i) => ({ x: 5 + (5 * i) / 60, y: 17, grounded: true, spread: 0.6, lift: [0, i % 10 < 5 ? 0 : 0.2] }), 60);
    const steps = puffs.filter((p) => p.why === 'step');
    expect(steps.length).toBe(6); // (lifts at frames 5, 15, ... 55)
    expect(steps.every((p) => p.dir === -1)).toBe(true); // moving right: dust goes left
    expect(steps.every((p) => p.at.x < 5 + (5 * 60) / 60)).toBe(true);
    // the FRONT foot lifting (stepping forward) is no push-off; walking slowly isn't either
    expect(feed((i) => ({ x: 5 + (5 * i) / 60, y: 17, grounded: true, spread: 0.6, lift: [i % 10 < 5 ? 0 : 0.2, 0] }), 60).filter((p) => p.why === 'step')).toEqual([]);
    expect(feed((i) => ({ x: 5 + (1 * i) / 60, y: 17, grounded: true, spread: 0.6, lift: [0, i % 10 < 5 ? 0 : 0.2] }), 60).filter((p) => p.why === 'step')).toEqual([]);
  });

  it('a real jump puffs on take-off and on landing; a mid-stride lift does neither', () => {
    // up at 7 m/s for 0.4 s, then down at 7 m/s until back
    const y = (i: number) => 17 - Math.max(0, 7 * (i / 60) - 4.9 * (i / 60) ** 2);
    const jump = feed((i) => ({ x: 5, y: i < 10 ? 17 : y(i - 10), grounded: i < 10 || (i > 12 && y(i - 10) >= 17 - 1e-9) }), 140);
    expect(jump.map((p) => p.why)).toEqual(['takeoff', 'landing']);
    // feet off the ground for 2 frames, barely moving: no dust
    const stride = feed((i) => ({ x: 5, y: 17 - (i === 30 || i === 31 ? 0.01 : 0), grounded: !(i === 30 || i === 31) }), 60);
    expect(stride).toEqual([]);
  });

  it('a hard landing makes a bigger puff than a soft one', () => {
    const land = (fallSpeed: number) => feed((i) => ({ x: 5, y: 10 + (fallSpeed * i) / 60, grounded: i >= 40 }), 41).find((p) => p.why === 'landing')!;
    expect(land(12).size).toBeGreaterThan(land(5).size);
  });

  it('a quick turn kicks up a skid puff the old way; a teleport (respawn) never puffs', () => {
    let x = 5;
    const turn = feed((i) => ({ x: (x += (i < 40 ? 5 : -5) / 60), y: 17, grounded: true }), 80);
    expect(turn.find((p) => p.why === 'turn')).toMatchObject({ dir: 1 });
    const tele = feed((i) => ({ x: i < 30 ? 5 : 5 + DUST.teleport + 5, y: 17, grounded: true }), 60);
    expect(tele).toEqual([]);
  });
});
