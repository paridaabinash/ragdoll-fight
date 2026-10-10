import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestLevel,
  DUMMY_PLAYER,
  GameWorld,
  HEALTH,
  initPhysics,
  LOCAL_PLAYER,
  Logger,
  RESPAWN,
  type Aim,
  type GameEvent,
  type LogEntry,
} from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

/** The test range (p1 at x 4 facing p2 at x 29), settled. */
function range() {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildTestLevel(world);
  for (let i = 0; i < 60; i++) world.step();
  return { world, log };
}

/** An aim from p1 whose preview hits p2 (scanned like a player would, with the real preview). */
function aimAtDummy(world: GameWorld): Aim {
  for (let a = -0.4; a <= 0.2; a += 0.005) {
    const aim = { angle: a };
    if (world.previewShot(LOCAL_PLAYER, aim).hit?.label.startsWith(`${DUMMY_PLAYER}:`)) return aim;
  }
  throw new Error('no aim hits the dummy');
}

describe('L7 step 3: headshots, the spawn shield', () => {
  it('the spawn shield lasts 2 s', () => {
    expect(RESPAWN.protectTicks).toBe(120);
  });

  it('a bullet on a shielded player does no damage and sparks off the shield (impact on "shield")', () => {
    const { world, log } = range();
    const aim = aimAtDummy(world);
    const st = world.stats.get(DUMMY_PLAYER)!;
    st.protectedUntil = world.tick + RESPAWN.protectTicks;
    shoot(world, LOCAL_PLAYER, aim);
    const events: GameEvent[] = [];
    for (let i = 0; i < 90; i++) {
      world.step();
      events.push(...world.takeEvents());
    }
    expect(st.health).toBe(HEALTH.max);
    expect(events.some((e) => e.type === 'impact' && e.on === 'shield')).toBe(true);
    expect(log.some((e) => e.ev === 'damage_blocked' && e.reason === 'protected')).toBe(true);
  });

  it('shooting ends your own shield at once (logged shield_end why "shot")', () => {
    const { world, log } = range();
    const st = world.stats.get(LOCAL_PLAYER)!;
    st.protectedUntil = world.tick + RESPAWN.protectTicks;
    shoot(world, LOCAL_PLAYER, { angle: 0.6 });
    expect(st.isProtected(world.tick)).toBe(false);
    const end = log.find((e) => e.ev === 'shield_end');
    expect(end?.why).toBe('shot');
    expect(Number(end?.leftTicks)).toBe(RESPAWN.protectTicks);
  });

  it('the shield runs out by itself (logged shield_end why "time"), then bullets hurt again', () => {
    const { world, log } = range();
    const st = world.stats.get(DUMMY_PLAYER)!;
    st.protectedUntil = world.tick + 5;
    for (let i = 0; i < 8; i++) world.step();
    expect(log.filter((e) => e.ev === 'shield_end' && e.why === 'time' && e.id === DUMMY_PLAYER)).toHaveLength(1);
    expect(st.isProtected(world.tick)).toBe(false);
    shoot(world, LOCAL_PLAYER, aimAtDummy(world));
    for (let i = 0; i < 90; i++) world.step();
    expect(st.health).toBeLessThan(HEALTH.max);
  });
});
