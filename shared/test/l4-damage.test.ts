import { beforeAll, describe, expect, it } from 'vitest';
import {
  BodyDamage,
  buildTestLevel,
  captureSnapshot,
  DAMAGE,
  decodeSnapshot,
  DUMMY_PLAYER,
  encodeSnapshot,
  GameWorld,
  hasPart,
  initPhysics,
  LOCAL_PLAYER,
  Logger,
  PART_NAMES,
  PIN,
  type GameEvent,
  type LogEntry,
} from '../src';
import { GameRoom, type Conn } from '../../server/src/room';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

function range(settle = 60) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildTestLevel(world);
  for (let i = 0; i < settle; i++) world.step();
  return { world, log };
}

/** n leg hits on p2 through the real ladder, a few seconds apart (trips settle). */
function legHits(world: GameWorld, parts: string[]) {
  for (const part of parts) {
    world.bodyHit(DUMMY_PLAYER, part as never, -1, 'test');
    for (let i = 0; i < 150; i++) world.step();
  }
}

describe('L4 damage ladders (rules)', () => {
  it('legs: one shared ladder; the damage goes to the first leg hit, then the other', () => {
    const d = new BodyDamage();
    expect(d.legHit('back')).toEqual({ kind: 'trip', side: 'back' }); // 1st: a trip
    expect(d.legStage).toBe(1);
    expect(d.legHit('front')).toEqual({ kind: 'drag', side: 'back' }); // either leg moves it; the first leg drags
    expect(d.draggingLeg).toBe('back');
    expect(d.legHit('front')).toEqual({ kind: 'stump', side: 'back' });
    expect(d.stumps).toEqual(['back']);
    expect(d.draggingLeg).toBeNull();
    expect(d.legHit('back')).toEqual({ kind: 'trip', side: 'front' }); // 4th: the other leg
    expect(d.legStage).toBe(3);
    expect(d.legHit('back')).toEqual({ kind: 'stump', side: 'front' }); // 5th: two stumps
    expect(d.legStage).toBe(4);
    expect(d.stumps).toEqual(['back', 'front']);
    expect(d.legHit('front')).toEqual({ kind: 'none' });
  });

  it('an apple repairs all but the holes; respawn resets (L7: arm/torso hits climb no ladder)', () => {
    const d = new BodyDamage();
    d.legHit('front');
    d.dents.add('torso');
    d.addHole({ part: 'torso', x: 0.1, y: 0 });
    expect(d.repairable).toBe(true);
    d.repair();
    expect([d.legStage, d.dents.size, d.repairable]).toEqual([0, 0, false]);
    expect(d.holes).toHaveLength(1); // holes stay through an apple
    d.reset();
    expect(d.holes).toHaveLength(0);
    for (let i = 0; i < DAMAGE.maxHoles + 5; i++) d.addHole({ part: 'head', x: 0, y: 0 });
    expect(d.holes).toHaveLength(DAMAGE.maxHoles);
  });
});

describe('L4 damage in the world', () => {
  it('each leg stage happens to the body at the right hit count, logged; the rules and the body agree', () => {
    const { world, log } = range();
    const p = () => world.player(DUMMY_PLAYER);
    legHits(world, ['legBackLower']);
    expect(log.some((e) => e.ev === 'trip' && e.id === DUMMY_PLAYER)).toBe(true);
    legHits(world, ['legFrontLower']);
    expect(p().mods.dragLeg).toBe('back');
    legHits(world, ['legFrontLower']);
    expect([...p().stumps]).toEqual(['back']);
    expect(p().mods.dragLeg).toBeNull();
    legHits(world, ['legFrontLower', 'legFrontLower']);
    expect([...p().stumps].sort()).toEqual(['back', 'front']);
    const stages = log.filter((e) => e.ev === 'damage_stage' && e.who === DUMMY_PLAYER).map((e) => [e.stage, e.did]);
    expect(stages).toEqual([[1, 'trip'], [2, 'drag'], [3, 'stump'], [3, 'trip'], [4, 'stump']]);
    expect(log.filter((e) => e.ev === 'part_lost' && e.id === DUMMY_PLAYER).map((e) => e.part)).toEqual(['legBackLower', 'legFrontLower']);
    expect(log.filter((e) => e.lvl === 'error')).toEqual([]);
    world.dispose();
  });

  it('L7: arm and torso hits never shoot a hand off (no hand ladder any more)', () => {
    const { world, log } = range();
    for (let i = 0; i < 6; i++) world.bodyHit(DUMMY_PLAYER, i % 2 ? 'torso' : 'armBackUpper', -1, 'test');
    expect(world.player(DUMMY_PLAYER).lost.size).toBe(0);
    expect(log.some((e) => e.ev === 'damage_stage')).toBe(false);
    world.dispose();
  });

  it('a bullet leaves a hole in the part it hit (in that part\'s frame, sent in the damage event)', () => {
    const { world } = range();
    world.relocate(LOCAL_PLAYER, { x: 20, y: 17 }, 1);
    for (let i = 0; i < 60; i++) world.step();
    const a = shoot(world, LOCAL_PLAYER, { angle: -0.05 });
    const events: GameEvent[] = [];
    for (let i = 0; i < 60 && a.state === 'flying'; i++) {
      world.step();
      events.push(...world.takeEvents());
    }
    const dmg = events.find((e) => e.type === 'damage' && e.id === DUMMY_PLAYER) as Extract<GameEvent, { type: 'damage' }>;
    expect(dmg.hole).toBeDefined();
    const hole = world.damage.get(DUMMY_PLAYER)!.holes[0];
    expect(PART_NAMES.indexOf(hole.part)).toBe(dmg.hole!.part);
    // the hole is on the part: within its shape (a box half-width ~0.1-0.2 m, half-length <= 0.4 m)
    expect(Math.abs(hole.x)).toBeLessThan(0.25);
    expect(Math.abs(hole.y)).toBeLessThan(0.45);
    world.dispose();
  });

  it('a red apple puts the body back together (legs, dents) where it stands; holes stay', () => {
    const { world, log } = range();
    legHits(world, ['legFrontLower', 'legFrontLower', 'legFrontLower']); // a thigh stump
    world.dent(DUMMY_PLAYER, 'head', LOCAL_PLAYER);
    world.damage.get(DUMMY_PLAYER)!.addHole({ part: 'torso', x: 0.05, y: 0.1 });
    for (let i = 0; i < 60; i++) world.step();
    const x = world.player(DUMMY_PLAYER).center().x;
    world.repairBody(DUMMY_PLAYER);
    const p = world.player(DUMMY_PLAYER);
    expect([p.lost.size, p.stumps.size]).toEqual([0, 0]);
    const d = world.damage.get(DUMMY_PLAYER)!;
    expect([d.legStage, d.dents.size, d.holes.length]).toEqual([0, 0, 1]);
    expect(Math.abs(p.center().x - x)).toBeLessThan(0.6); // where it stood
    expect(log.find((e) => e.ev === 'body_repaired')).toMatchObject({ id: DUMMY_PLAYER, by: 'apple' });
    expect(world.takeEvents()).toContainEqual({ type: 'repaired', id: DUMMY_PLAYER });
    for (let i = 0; i < 120; i++) world.step();
    expect(p.down).toBe(false);
    expect(log.filter((e) => e.lvl === 'error')).toEqual([]);
    world.dispose();
  });

  it('respawning resets everything and leaves no shot-off piece behind', () => {
    const { world, log } = range();
    legHits(world, ['legBackLower', 'legBackLower', 'legBackLower']);
    world.hurt(DUMMY_PLAYER, LOCAL_PLAYER, 1000, world.player(DUMMY_PLAYER).center());
    for (let i = 0; i < 200; i++) world.step();
    expect(world.playerStats(DUMMY_PLAYER).alive).toBe(true);
    expect(world.player(DUMMY_PLAYER).lost.size).toBe(0);
    expect(world.damage.get(DUMMY_PLAYER)!.legHits).toBe(0);
    expect(log.find((e) => e.ev === 'body_repaired' && e.by === 'respawn')).toBeDefined();
    expect([...world.physics.bodies.getAll()].some((b) => world.labelOf(b.collider(0)).startsWith(`piece:${DUMMY_PLAYER}:`))).toBe(false);
    expect(log.filter((e) => e.lvl === 'error')).toEqual([]);
    world.dispose();
  });

  it('a swap (body rebuilt elsewhere) keeps the stumps', () => {
    const { world, log } = range();
    legHits(world, ['legBackLower', 'legBackLower', 'legBackLower']);
    world.relocate(DUMMY_PLAYER, { x: 24, y: 17 }, -1);
    const p = world.player(DUMMY_PLAYER);
    expect([...p.stumps]).toEqual(['back']);
    for (let i = 0; i < 60; i++) world.step();
    expect(log.filter((e) => e.lvl === 'error')).toEqual([]);
    world.dispose();
  });

  it("a shot-off shin is not a foot any more (a shin lying on a trampoline kept launching its owner, sim chaos)", () => {
    const { world } = range();
    legHits(world, ['legFrontLower', 'legFrontLower', 'legFrontLower']);
    const p = world.player(DUMMY_PLAYER);
    const shin = p.parts.legFrontLower.translation();
    const feet = p.footPoints();
    expect(feet).toHaveLength(2);
    // the stump's end is up at the hip, nowhere near the shin lying on the floor
    expect(feet.every((f) => Math.hypot(f.x - shin.x, f.y - shin.y) > 0.15 || Math.abs(f.y - p.jointPos('hipFront').y) < 0.3)).toBe(true);
    expect(world.feetOf(DUMMY_PLAYER).y).toBeCloseTo(17, 0); // still standing on the ground (the good leg)
    world.dispose();
  });

  it('no wall pin on a body lying down (getting up nailed to a wall bent a knee backward, sim chaos)', () => {
    const tryIt = (down: boolean, flying = false) => {
      const { world, log } = range();
      world.relocate(DUMMY_PLAYER, { x: 31.5, y: 17 }, -1); // the thigh 0.5 m from the right wall: in pin reach
      for (let i = 0; i < 60; i++) world.step();
      const p = world.player(DUMMY_PLAYER);
      p.down = down; // (the same spot, only "lying down" differs)
      if (flying) {
        for (const b of p.attached()) world.push(b, { x: (PIN.maxSpeed + 1) * b.mass(), y: 0 }); // (or moving fast)
        world.step(); // (a push lands on the next physics step)
      }
      const thigh = p.parts.legFrontUpper;
      const hit = { point: { ...thigh.translation() }, collider: thigh.collider(0), label: `${DUMMY_PLAYER}:legFrontUpper` };
      world.specials.tryPin(shoot(world, LOCAL_PLAYER, { angle: 0 }), hit, { id: DUMMY_PLAYER, part: 'legFrontUpper' }, { x: 30, y: 0 });
      const pinned = log.some((e) => e.ev === 'pin_start');
      world.dispose();
      return pinned;
    };
    expect(tryIt(false)).toBe(true);
    expect(tryIt(true)).toBe(false);
    expect(tryIt(false, true)).toBe(false); // L6: a body flying past isn't nailed either (it yanked a knee past its limit)
  });

  it('a pin tears out when it forces a joint past its limit (a falling body nailed by a shin bent the knee backward, L5 bots sim)', () => {
    const { world, log } = range();
    world.relocate(DUMMY_PLAYER, { x: 31.5, y: 17 }, -1);
    for (let i = 0; i < 60; i++) world.step();
    const p = world.player(DUMMY_PLAYER);
    const thigh = p.parts.legFrontUpper;
    const hit = { point: { ...thigh.translation() }, collider: thigh.collider(0), label: `${DUMMY_PLAYER}:legFrontUpper` };
    world.specials.tryPin(shoot(world, LOCAL_PLAYER, { angle: 0 }), hit, { id: DUMMY_PLAYER, part: 'legFrontUpper' }, { x: 30, y: 0 });
    world.step();
    p.down = true; // lying down alone doesn't end it: only strain does
    world.step();
    expect(world.effects.get(DUMMY_PLAYER)?.has('pinned')).toBe(true);
    p.strainOn = () => PIN.tearOver + 0.1; // (the knee forced past its limit)
    world.step();
    expect(log.find((e) => e.ev === 'pin_end')).toMatchObject({ id: DUMMY_PLAYER, reason: 'torn' });
    expect(world.effects.get(DUMMY_PLAYER)?.has('pinned')).toBe(false);
    world.dispose();
  });

  it('a body cut without the rules knowing is an anomaly (body_state_mismatch)', () => {
    const { world, log } = range();
    world.player(DUMMY_PLAYER).stumpLeg('front');
    world.step();
    expect(log.find((e) => e.ev === 'body_state_mismatch')).toMatchObject({ lvl: 'error', who: DUMMY_PLAYER });
    world.dispose();
  });
});

describe('L4 snapshots', () => {
  it('carry lost parts, dents and the leg stage for every client (a late joiner gets them too)', () => {
    const { world } = range();
    legHits(world, ['legFrontLower', 'legFrontLower', 'legFrontLower']);
    world.dent(DUMMY_PLAYER, 'torso', LOCAL_PLAYER);
    const back = decodeSnapshot(encodeSnapshot(captureSnapshot(world, world.movableBodies())))!;
    const p2 = back.players.find((p) => p.slot === world.slotOf(DUMMY_PLAYER))!;
    expect(hasPart(p2.lost, 'legFrontLower')).toBe(true);
    expect(hasPart(p2.lost, 'legBackLower')).toBe(false);
    expect(hasPart(p2.dents, 'torso')).toBe(true);
    expect(p2.legStage).toBe(3);
    world.dispose();
  });
});

describe('L4 late joiners', () => {
  it("someone joining mid-match gets what lasts in the welcome: bullet holes in bodies and walls, hats knocked off", () => {
    const msgs: string[] = [];
    const conn = (keep: boolean): Conn => ({ send: (d) => void (keep && typeof d === 'string' && msgs.push(d)), close() {}, bufferedAmount: 0 });
    const room = new GameRoom('t1', () => {}, () => {}, { bots: false });
    const first = room.join(conn(false), 'first');
    room.world.damage.get(first)!.addHole({ part: 'torso', x: 0.05, y: -0.1 });
    room.world.damage.get(first)!.hatOff = true;
    room.world.impact({ x: 3, y: 17 }, 0.5, 'wall');
    room.world.impact({ x: 4, y: 16 }, 0.5, 'object'); // (a crate: dust only, nothing lasts)
    room.join(conn(true), 'late');
    const welcome = msgs.map((m) => JSON.parse(m)).find((m) => m.t === 'welcome');
    expect(welcome.holes).toEqual([{ id: first, holes: [{ part: PART_NAMES.indexOf('torso'), x: 0.05, y: -0.1 }] }]);
    expect(welcome.wallHoles).toEqual([{ x: 3, y: 17, angle: 0.5 }]);
    expect(welcome.hatsOff).toEqual([first]);
    room.close();
  });
});
