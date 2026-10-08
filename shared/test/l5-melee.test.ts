import { beforeAll, describe, expect, it } from 'vitest';
import {
  captureSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  GameWorld,
  GROUND_Y,
  initPhysics,
  Logger,
  MELEE,
  NO_CONTROLS,
  type GameEvent,
  type LogEntry,
} from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

/** Flat ground; 'a' at x 10 facing right, 'b' at `gap` m to its right facing left. Settled. */
function duel(gap = 1.2) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  world.addBox('ground', 'fixed', { x: 20, y: GROUND_Y + 0.5 }, { x: 20, y: 0.5 });
  world.spawnPoints = [{ x: 4, y: GROUND_Y, facing: 1 }, { x: 30, y: GROUND_Y, facing: -1 }];
  world.addPlayer('a', { x: 10, y: GROUND_Y }, 1);
  world.addPlayer('b', { x: 10 + gap, y: GROUND_Y }, -1);
  for (let i = 0; i < 60; i++) world.step();
  return { world, log };
}

const steps = (world: GameWorld, n: number) => {
  const events: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    world.step();
    events.push(...world.takeEvents());
  }
  return events;
};

/** Knocks 'a''s gun away (a forced air-shot crit). */
function disarm(world: GameWorld, id = 'a') {
  world.melee.roll = () => 0; // the dice say crit
  const p = world.player(id);
  for (const b of p.attached()) world.push(b, { x: 0, y: -6 * b.mass() }); // up in the air
  for (let i = 0; i < 10 && p.grounded; i++) world.step(); // (grounded is checked at the start of a step)
  expect(p.grounded).toBe(false);
  world.melee.onBulletHit(id, 'b');
}

describe('L5 critical hits', () => {
  it('a bullet in the air can crit (dice < MELEE.critAirChance): the gun is knocked away, a melee weapon instead', () => {
    const { world, log } = duel(6);
    disarm(world);
    expect(['bat', 'mace']).toContain(world.damage.get('a')!.weapon);
    expect(log.find((e) => e.ev === 'crit')).toMatchObject({ who: 'a', by: 'b', trigger: 'air_shot' });
    expect(world.takeEvents()).toContainEqual(expect.objectContaining({ type: 'callout', kind: 'disarmed', id: 'a' }));
    // the knocked-away gun is a loose thing in the world, sent as a prop
    expect(world.specials.props().filter((p) => p.type === 'gun')).toHaveLength(1);
    world.dispose();
  });

  it('the knocked-away gun lands on the floor but never touches a player (it pinned a lying player in the bots sim), and bullets pass through it', () => {
    const { world } = duel(1.2);
    disarm(world);
    let touches = 0;
    for (let i = 0; i < 120; i++) {
      world.step();
      world.physics.forEachCollider((c) => {
        if (!world.labelOf(c).startsWith('dropped_gun:')) return;
        world.physics.contactPairsWith(c, (o) => {
          if (/^[ab]:/.test(world.labelOf(o))) touches++;
        });
      });
    }
    expect(touches).toBe(0);
    const g = world.melee.gunProps()[0];
    expect(g.y).toBeGreaterThan(GROUND_Y - 0.3); // it fell to the floor
    expect(g.y).toBeLessThan(GROUND_Y);
    expect(world.raycast({ x: g.x, y: g.y - 2 }, { x: g.x, y: g.y + 0.5 }, 'b')?.label).toBe('ground');
    world.dispose();
  });

  it('nothing else crits: on the ground, or the dice say no', () => {
    const { world, log } = duel(6);
    world.melee.roll = () => 0;
    world.melee.onBulletHit('a', 'b'); // standing on the ground
    world.melee.roll = () => MELEE.critAirChance; // in the air, but the dice say no
    for (const b of world.player('a').attached()) world.push(b, { x: 0, y: -6 * b.mass() });
    for (let i = 0; i < 10 && world.player('a').grounded; i++) world.step();
    expect(world.player('a').grounded).toBe(false);
    world.melee.onBulletHit('a', 'b');
    expect(log.some((e) => e.ev === 'crit')).toBe(false);
    expect(world.damage.get('a')!.weapon).toBe('gun');
    world.dispose();
  });

  it('a glove punch into a wall (SPLAT) is always a crit; a splat without a glove is not', () => {
    const { world, log } = duel(6);
    world.melee.onSplat('a', 'b'); // no glove
    expect(log.some((e) => e.ev === 'crit')).toBe(false);
    world.melee.onGlove('a');
    world.melee.onSplat('a', 'b');
    expect(log.find((e) => e.ev === 'crit')).toMatchObject({ who: 'a', trigger: 'glove_splat' });
    world.dispose();
  });

  it('a knocked-away gun can\'t be used: the click swings the melee weapon (no bullet); respawn brings the gun back', () => {
    const { world, log } = duel(6);
    disarm(world);
    steps(world, 60);
    const res = world.fire('a', { angle: 0 });
    expect(res).toEqual({ arrow: null, swing: true });
    expect(world.arrows).toHaveLength(0);
    expect(log.some((e) => e.ev === 'gun_while_melee')).toBe(false);
    world.hurt('a', 'b', 1000, world.player('a').center());
    steps(world, 200);
    expect(world.damage.get('a')!.weapon).toBe('gun');
    expect(world.specials.props().filter((p) => p.type === 'gun')).toHaveLength(0); // the dropped one is gone
    expect(world.fire('a', { angle: 0.5 }).arrow).not.toBeNull();
    world.dispose();
  });
});

describe('L5 melee', () => {
  it('a swing in reach hits the nearest part, knocks the victim, breaks the limb; swings have a cooldown', () => {
    const { world, log } = duel(1.2);
    disarm(world);
    steps(world, 90);
    world.setControls('a', { ...NO_CONTROLS, aim: { angle: 0.2 } });
    expect(world.fire('a', { angle: 0.2 }).swing).toBe(true);
    expect(world.fire('a', { angle: 0.2 }).refused).toBe('fire_too_soon'); // the cooldown
    const events = steps(world, MELEE.swing.swingTicks + 2);
    const hit = log.find((e) => e.ev === 'melee_hit');
    expect(hit).toMatchObject({ who: 'a', victim: 'b' });
    expect(Number(hit!.d)).toBeLessThanOrEqual(MELEE.reach);
    expect(events).toContainEqual(expect.objectContaining({ type: 'melee_hit', id: 'b', by: 'a' }));
    expect(world.playerStats('b').health).toBeLessThan(100);
    if (hit!.broke) expect(world.damage.get('b')!.broken.size).toBe(1);
    world.dispose();
  });

  it('out of reach, or behind a wall: a miss', () => {
    const { world, log } = duel(4);
    disarm(world);
    steps(world, 90);
    world.fire('a', { angle: 0 });
    steps(world, MELEE.swing.swingTicks + 2);
    expect(log.some((e) => e.ev === 'melee_miss')).toBe(true);
    expect(world.playerStats('b').health).toBe(100);
    world.dispose();
  });

  it(`the ${MELEE.shatterAfter}rd melee hit breaks the body into pieces: a death credited to the hitter; pieces stay until respawn`, () => {
    const { world, log } = duel(1.2);
    disarm(world);
    steps(world, 90);
    for (let i = 0; i < MELEE.shatterAfter && world.playerStats('b').alive; i++) {
      world.relocate('b', { x: 11.2, y: GROUND_Y }, -1); // (back in reach after each knock)
      steps(world, 30);
      while (world.playerStats('a').fireBlock(world.tick)) steps(world, 1);
      world.playerStats('a').refill(100);
      world.fire('a', { angle: 0.1 });
      steps(world, MELEE.swing.swingTicks + 2);
    }
    expect(log.filter((e) => e.ev === 'melee_hit' && e.victim === 'b')).toHaveLength(MELEE.shatterAfter);
    expect(world.playerStats('b').alive).toBe(false);
    expect(log.find((e) => e.ev === 'death' && e.id === 'b')).toMatchObject({ killer: 'a', cause: 'shattered' });
    expect(world.player('b').lost.size).toBe(9); // every part but the torso is a loose piece
    expect(log.filter((e) => e.lvl === 'error')).toEqual([]);
    steps(world, 200); // respawn
    expect(world.player('b').lost.size).toBe(0);
    world.dispose();
  });

  it('melee players run faster and take less bullet damage; a broken limb takes more', () => {
    const { world } = duel(6);
    disarm(world);
    steps(world, 30);
    expect(world.player('a').mods.fast).toBe(true);
    const before = world.playerStats('a').health;
    shoot(world, 'b', { angle: Math.PI - 0.05 });
    steps(world, 30);
    const took = before - world.playerStats('a').health;
    expect(took).toBeGreaterThan(0);
    expect(took).toBeLessThanOrEqual(Math.ceil(20 * MELEE.bulletShare)); // a torso-ish hit: 20 -> 14
    world.dispose();
  });

  it('snapshots carry the weapon, broken limbs and the knocked-away gun', () => {
    const { world } = duel(6);
    disarm(world);
    world.damage.get('a')!.broken.add('legFrontUpper');
    const back = decodeSnapshot(encodeSnapshot(captureSnapshot(world, world.movableBodies())))!;
    const a = back.players.find((p) => p.slot === world.slotOf('a'))!;
    expect(a.weapon).toBe(world.damage.get('a')!.weapon);
    expect(a.broken).toBe(1 << 6); // legFrontUpper
    expect(back.props.find((p) => p.type === 'gun')).toMatchObject({ a: world.slotOf('a') });
    world.dispose();
  });
});
