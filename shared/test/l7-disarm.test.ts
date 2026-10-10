import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestLevel, DUMMY_PLAYER, GameWorld, initPhysics, LOCAL_PLAYER, Logger, MELEE, STAMINA, type LogEntry } from '../src';

beforeAll(() => initPhysics());

function range() {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildTestLevel(world);
  for (let i = 0; i < 60; i++) world.step();
  world.melee.roll = () => 0; // every roll is a crit, so only the rules decide
  return { world, log };
}

/** Throws the dummy up (a big jump) and steps until it has left the ground. */
function launch(world: GameWorld): void {
  for (const b of world.player(DUMMY_PLAYER).attached()) world.push(b, { x: 0, y: -7 * b.mass() });
  for (let i = 0; i < 20 && world.player(DUMMY_PLAYER).grounded; i++) world.step();
  expect(world.player(DUMMY_PLAYER).grounded).toBe(false);
}

/** A swing attempt with the reload done and full stamina (only the disarm rules can refuse it). */
function trySwing(world: GameWorld) {
  const st = world.stats.get(DUMMY_PLAYER)!;
  st.readyAt = world.tick;
  st.lastShotTick = -Infinity;
  st.refill(STAMINA.max);
  return world.fire(DUMMY_PLAYER, { angle: Math.PI });
}

describe('L7 step 4: disarms are rarer and clearly shown', () => {
  it('the crit chance is 8% and needs 0.25 s in the air', () => {
    expect(MELEE.critAirChance).toBe(0.08);
    expect(MELEE.critMinAirTicks).toBe(15);
  });

  it('a hit during a tiny hop (under 0.25 s in the air) never knocks the gun away', () => {
    const { world } = range();
    launch(world);
    expect(world.player(DUMMY_PLAYER).airTicks(world.tick)).toBeLessThan(MELEE.critMinAirTicks);
    world.melee.onBulletHit(DUMMY_PLAYER, LOCAL_PLAYER);
    expect(world.melee.weaponOf(DUMMY_PLAYER)).toBe('gun');
  });

  it('after a real jump it can; the hands are empty for 0.6 s (swings refused), then the weapon is out', () => {
    const { world, log } = range();
    launch(world);
    for (let i = 0; i < MELEE.critMinAirTicks; i++) world.step();
    expect(world.player(DUMMY_PLAYER).grounded).toBe(false);
    world.melee.onBulletHit(DUMMY_PLAYER, LOCAL_PLAYER);
    expect(world.melee.weaponOf(DUMMY_PLAYER)).not.toBe('gun');
    expect(log.find((e) => e.ev === 'crit')?.airTicks).toBeGreaterThanOrEqual(MELEE.critMinAirTicks);
    expect(trySwing(world).refused).toBe('drawing_weapon');
    for (let i = 0; i < MELEE.drawTicks; i++) world.step();
    expect(trySwing(world).swing).toBe(true); // the weapon is out
    world.step(); // (logged by the next step's melee update)
    expect(log.some((e) => e.ev === 'disarm_draw' && e.id === DUMMY_PLAYER)).toBe(true);
  });
});
