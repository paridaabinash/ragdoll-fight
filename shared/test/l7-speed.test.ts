import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DT, GAME_SPEED, GameWorld, GROUND_Y, initPhysics, Logger, NO_CONTROLS, setGameSpeed, STAMINA, TICK_SECONDS, type LogEntry } from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());
afterEach(() => setGameSpeed(1)); // (the dial is module state: never leak a slow speed into the next test)

/** p1 and a target box on a long floor, settled. */
function world() {
  const log: LogEntry[] = [];
  const w = new GameWorld(new Logger('test', (e) => void log.push(e)));
  w.bounds = { width: 100, height: GROUND_Y + 1 };
  w.addBox('ground', 'fixed', { x: 50, y: GROUND_Y + 0.5 }, { x: 50, y: 0.5 });
  w.addBox('target', 'fixed', { x: 30, y: GROUND_Y - 4 }, { x: 0.5, y: 4 });
  const p = w.addPlayer('p1', { x: 10, y: GROUND_Y }, 1);
  for (let i = 0; i < 90; i++) w.step();
  return { w, p, log };
}

/** A held jump: how high the torso rises and how many ticks until the feet are back. */
function jump() {
  const { w, p } = world();
  const y0 = p.center().y;
  let peak = y0;
  let ticks = 0;
  w.setControls('p1', { ...NO_CONTROLS, jump: true });
  for (let i = 0; i < 400; i++) {
    if (i === 20) w.setControls('p1', NO_CONTROLS);
    w.step();
    peak = Math.min(peak, p.center().y);
    if (i > 5 && p.grounded) {
      ticks = i;
      break;
    }
  }
  w.dispose();
  return { rise: y0 - peak, ticks };
}

describe('L7 game-speed dial', () => {
  it('only takes a sane number, and scales the game time per tick (not the real tick)', () => {
    for (const bad of [Number.NaN, Infinity, 0, 0.2, 2]) expect(setGameSpeed(bad)).toBe(false);
    expect(GAME_SPEED).toBe(1);
    expect(setGameSpeed(0.85)).toBe(true);
    expect(DT).toBeCloseTo(TICK_SECONDS * 0.85, 12);
    expect(TICK_SECONDS).toBeCloseTo(1 / 60, 12);
  });

  it('slower: the same jump height, more ticks in the air', () => {
    const normal = jump();
    setGameSpeed(0.85);
    const slow = jump();
    expect(slow.rise).toBeCloseTo(normal.rise, 1);
    expect(slow.ticks / normal.ticks).toBeGreaterThan(1.1);
    expect(slow.ticks / normal.ticks).toBeLessThan(1.3); // about 1 / 0.85
  });

  it('slower: the aim preview is still exactly where the bullet lands', () => {
    setGameSpeed(0.85);
    const { w, log } = world();
    const aim = { angle: -0.15 };
    const preview = w.previewShot('p1', aim);
    const arrow = shoot(w, 'p1', aim);
    for (let i = 0; i < 300 && arrow.state === 'flying'; i++) w.step();
    const hit = log.find((e) => e.ev === 'arrow_hit' && e.id === arrow.id);
    expect(hit?.target).toBe(preview.hit?.label);
    expect(hit?.predErr).toBe(0);
    expect(hit?.predTickErr).toBe(0);
    w.dispose();
  });

  it('timers keep real time: stamina refills as fast at any speed', () => {
    const refill = () => {
      const { w } = world();
      const st = w.stats.get('p1')!;
      st.stamina = 10;
      for (let i = 0; i < 120; i++) w.step();
      const got = st.stamina;
      w.dispose();
      return got;
    };
    const normal = refill();
    setGameSpeed(0.75);
    expect(refill()).toBeCloseTo(normal, 6);
    expect(normal).toBeLessThanOrEqual(STAMINA.max);
  });
});
