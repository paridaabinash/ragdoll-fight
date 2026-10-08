import { beforeAll, describe, expect, it } from 'vitest';
import { buildArena, GameWorld, GROUND_Y, initPhysics, Logger, NO_CONTROLS, RESPAWN, type LogEntry, type Ragdoll } from '../src';

beforeAll(() => initPhysics());

/** One player on flat ground (and a second one to shoot at them), settled. */
/**
 * These spike tests cut the body directly (the physics); L4's rules must agree with the body (else the world logs
 * `body_state_mismatch`), so the rules' record is set to match what was cut.
 */
function syncRules(world: GameWorld, p: Ragdoll): void {
  const dmg = world.damage.get(p.id)!;
  const order = (['front', 'back'] as const).filter((s) => p.stumps.has(s));
  dmg.firstLeg = order[0] ?? null;
  dmg.legHits = order.length === 2 ? 5 : order.length === 1 ? 3 : 0;
}

function setup(arena = false) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  // (the Backyard has spawn points, needed to respawn; plain ground has room to walk)
  if (arena) buildArena(world);
  else world.addBox('ground', 'fixed', { x: 16, y: GROUND_Y + 0.5 }, { x: 16, y: 0.5 });
  const p = world.addPlayer('a', { x: arena ? 4 : 8, y: GROUND_Y }, 1);
  world.addPlayer('b', { x: arena ? 8 : 14, y: GROUND_Y }, -1);
  for (let i = 0; i < 90; i++) world.step();
  return { world, p, log };
}

const upright = (r: { parts: { torso: { rotation(): number } } }) => Math.abs(r.parts.torso.rotation()) < 0.3;

describe('losing body parts (L0 spike)', () => {
  it('a leg shot to a stump: the shin falls off as a loose piece that is no longer the player', () => {
    const { world, p, log } = setup();
    const massBefore = p.attached().reduce((m, b) => m + b.mass(), 0);
    expect(p.stumpLeg('front')).toBe(true);
    syncRules(world, p);
    expect(p.stumpLeg('front')).toBe(false); // already a stump
    expect(p.lost.has('legFrontLower')).toBe(true);
    expect(p.legsLeft).toBe(1);
    expect(p.attached()).not.toContain(p.parts.legFrontLower);
    expect(p.attached().reduce((m, b) => m + b.mass(), 0)).toBeLessThan(massBefore);
    // the piece is relabelled: hits on it hurt nobody
    const shin = p.parts.legFrontLower;
    expect(world.isPlayerBody(shin)).toBe(false);
    expect(world.labelOf(shin.collider(0))).toBe('piece:a:legFrontLower');
    expect(log.some((e) => e.ev === 'part_lost' && e.part === 'legFrontLower' && e.legsLeft === 1)).toBe(true);
    // the knee is gone from the body report; nothing complains
    for (let i = 0; i < 180; i++) world.step();
    expect((p.snapshot().j as Record<string, number>).kneeFront).toBeUndefined();
    expect(log.filter((e) => e.lvl === 'error' || e.ev === 'joint_over_limit' || e.ev === 'joint_stretched')).toEqual([]);
    world.dispose();
  });

  it('one leg: stands, hops along at walking speed, the stump stays off the ground', () => {
    const { world, p } = setup();
    p.stumpLeg('back');
    syncRules(world, p);
    world.setControls('a', { ...NO_CONTROLS, move: 1 });
    for (let i = 0; i < 60; i++) world.step();
    const x = p.center().x;
    for (let i = 0; i < 60; i++) world.step();
    expect(p.center().x - x).toBeGreaterThan(2.5); // ~3 m/s, the normal walk
    expect(p.hops).toBeGreaterThan(0);
    world.setControls('a', NO_CONTROLS);
    for (let i = 0; i < 120; i++) world.step();
    expect(upright(p)).toBe(true);
    expect(p.grounded).toBe(true);
    world.dispose();
  });

  it('two stumps: still stands and walks, slower and lower', () => {
    const { world, p } = setup();
    const headBefore = p.parts.head.translation().y;
    p.stumpLeg('front');
    syncRules(world, p);
    p.stumpLeg('back');
    syncRules(world, p);
    for (let i = 0; i < 120; i++) world.step();
    expect(p.legsLeft).toBe(0);
    expect(p.parts.head.translation().y - headBefore).toBeGreaterThan(0.5); // much shorter now
    expect(upright(p)).toBe(true);
    expect(p.grounded).toBe(true);
    world.dispose();
  });

  it('respawning brings a whole body back and clears the loose pieces', () => {
    const { world, p } = setup(true);
    const bodies = world.physics.bodies.len();
    p.stumpLeg('front');
    syncRules(world, p);
    world.hurt('a', 'b', 1000, p.center());
    for (let i = 0; i < RESPAWN.delayTicks + 30; i++) world.step();
    const fresh = world.player('a');
    expect(fresh).not.toBe(p);
    expect(fresh.lost.size).toBe(0);
    expect(fresh.legsLeft).toBe(2);
    // the old body, shin included, is gone: the same number of bodies as before (the engine reuses handle numbers, so
    // looking the old shin up by its handle would find a part of the new body)
    expect(world.physics.bodies.len()).toBe(bodies);
    world.dispose();
  });
});
