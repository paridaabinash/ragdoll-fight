import { beforeAll, describe, expect, it } from 'vitest';
import { GameWorld, initPhysics, LOCAL_PLAYER, Logger, NO_CONTROLS, type LogEntry } from '../src';

beforeAll(() => initPhysics());

const GROUND_Y = 18;
function flat() {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  world.bounds = { width: 100, height: GROUND_Y + 1 };
  world.addBox('ground', 'fixed', { x: 50, y: GROUND_Y + 0.5 }, { x: 50, y: 0.5 });
  world.addPlayer(LOCAL_PLAYER, { x: 10, y: GROUND_Y }, 1);
  for (let i = 0; i < 90; i++) world.step();
  return { world, log, p: world.player(LOCAL_PLAYER) };
}

describe('funny legs: Big Scissor walk + Split Leap jump', () => {
  it('running, the hips swing much wider than before (was about -0.24..0.26 rad), at the same top speed', () => {
    const { world, p } = flat();
    const hip = (n: 'hipFront' | 'hipBack') => p.jointAngle(n) * p.facing;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 150; i++) {
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
      world.step();
      if (i < 40) continue;
      lo = Math.min(lo, hip('hipFront'), hip('hipBack'));
      hi = Math.max(hi, hip('hipFront'), hip('hipBack'));
    }
    expect(lo).toBeLessThan(-0.6); // a leg well forward
    expect(hi).toBeGreaterThan(0.5); // a leg well back
    expect(p.speedX()).toBeGreaterThan(5);
  });

  it('a jump opens the legs into the splits around the top, and rises 1.52 m (was 1.33 m before the jump power 7.5 -> 8)', () => {
    const { world, p } = flat();
    const y0 = p.center().y;
    let split = 0;
    let rise = 0;
    for (let i = 0; i < 120; i++) {
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: i < 20 });
      world.step();
      if (!p.grounded) split = Math.max(split, (p.jointAngle('hipBack') - p.jointAngle('hipFront')) * p.facing);
      rise = Math.max(rise, y0 - p.center().y);
    }
    expect(split).toBeGreaterThan(0.8);
    expect(rise).toBeGreaterThan(1.47);
    expect(rise).toBeLessThan(1.57);
  });

  it('letting go mid-stride (even mid-bound, both feet in the air) still stops quickly, no stumble', () => {
    for (let late = 0; late < 16; late += 3) {
      const { world, log, p } = flat();
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
      for (let i = 0; i < 100 + late; i++) world.step();
      const mark = log.length;
      world.setControls(LOCAL_PLAYER, NO_CONTROLS);
      let stop = -1;
      for (let i = 0; i < 120; i++) {
        world.step();
        if (stop < 0 && Math.abs(p.speedX()) < 0.1) stop = i;
      }
      expect(stop, `let go ${late} ticks later`).toBeGreaterThanOrEqual(0);
      expect(stop, `let go ${late} ticks later`).toBeLessThan(25);
      expect(log.slice(mark).filter((e) => e.ev === 'stumble' || e.ev === 'ragdoll_fall')).toEqual([]);
      world.dispose();
    }
  });

  it('a jump keeps its sideways speed when you let go in the air (only a stride bound brakes on landing)', () => {
    // (every run-up: the jump lands at a different point of the stride. 2026-10-11: with the feet still brushing the
    // floor the tick after a jump, some run-ups counted as a bound and braked in mid-air; see MOVE.liftoffTicks)
    for (let runup = 70; runup <= 100; runup += 5) {
      const { world, p } = flat();
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
      for (let i = 0; i < runup; i++) world.step();
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1, jump: true });
      for (let i = 0; i < 8; i++) world.step();
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true });
      const vx = p.speedX();
      for (let i = 0; i < 12; i++) world.step();
      expect(p.grounded, `run-up ${runup}`).toBe(false);
      expect(p.speedX(), `run-up ${runup}`).toBeGreaterThan(vx * 0.85);
      world.dispose();
    }
  });
});
