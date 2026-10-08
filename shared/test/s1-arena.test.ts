import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARENA_SIZE,
  ARENAS,
  arenaLayout,
  arenaSizeFor,
  BACKYARD,
  buildArena,
  captureSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  GameWorld,
  initPhysics,
  Logger,
  NET,
  outOfArena,
  PART_NAMES,
  TEST_LAB,
  validateArena,
  type ArenaDef,
  type GameEvent,
  type LogEntry,
} from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

function worldWith(def: ArenaDef, size: 'full' | 'narrow' = 'full') {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildArena(world, arenaLayout(def, size));
  return { world, log };
}

describe('arena files', () => {
  // Every arena in ARENAS, at every size it has: a new arena file is checked here without writing a new test.
  for (const def of Object.values(ARENAS)) {
    for (const size of def.narrow ? (['full', 'narrow'] as const) : (['full'] as const)) {
      it(`${def.id} (${size}) passes the arena checks`, () => {
        expect(validateArena(arenaLayout(def, size))).toEqual([]);
      });
    }
  }

  it('the checks catch broken arenas', () => {
    const bad: ArenaDef = {
      ...BACKYARD,
      id: 'bad',
      solids: [...BACKYARD.solids, { label: 'pillar', x: 3.8, y: 15, w: 0.4, h: 2 }],
      spawns: [
        { x: 4, y: 17, facing: 1 }, // inside the pillar
        { x: 10, y: 15, facing: 1 }, // floating, nothing under the feet
        { x: 10.5, y: 17, facing: 1 }, // fine
        { x: 11, y: 17, facing: 1 }, // too close to the one before
      ],
      apples: [{ kind: 'red', x: 40, y: 5 }], // outside the arena
      pits: [{ label: 'pit', x: 25, y: 20, w: 2, h: 1 }], // outside the arena, no floor under it
    };
    const problems = validateArena(arenaLayout(bad, 'full')).join('\n');
    expect(problems).toMatch(/spawn 0 .*no room to stand \(inside pillar\)/);
    expect(problems).toMatch(/spawn 1 .*not standing on top of a solid/);
    expect(problems).toMatch(/spawn 2 .*closer than/);
    expect(problems).toMatch(/4 spawns, needs at least 8/);
    expect(problems).toMatch(/apple 0 is outside the arena/);
    expect(problems).toMatch(/pit pit is outside the arena/);
    expect(problems).toMatch(/pit pit has no solid floor/);
  });

  it('building a broken arena logs every problem as an error', () => {
    const { log } = worldWith({ ...BACKYARD, id: 'bad', spawns: BACKYARD.spawns.slice(0, 3) });
    expect(log.filter((e) => e.ev === 'arena_invalid' && e.lvl === 'error').length).toBeGreaterThan(0);
    expect(log.find((e) => e.ev === 'arena_loaded')?.problems).toBeGreaterThan(0);
  });
});

describe('arena size by player count', () => {
  it(`few players get the narrow size, ${ARENA_SIZE.fullFromPlayers}+ get the full size; one-size arenas never change`, () => {
    expect(arenaSizeFor(TEST_LAB, 3)).toBe('narrow');
    expect(arenaSizeFor(TEST_LAB, ARENA_SIZE.fullFromPlayers - 1)).toBe('narrow');
    expect(arenaSizeFor(TEST_LAB, ARENA_SIZE.fullFromPlayers)).toBe('full');
    expect(arenaSizeFor(TEST_LAB, 8)).toBe('full');
    expect(arenaSizeFor(BACKYARD, 2)).toBe('full');
  });

  it('the narrow size keeps the middle, cuts what crosses its edge, and starts at x 0', () => {
    const full = arenaLayout(TEST_LAB, 'full');
    const narrow = arenaLayout(TEST_LAB, 'narrow');
    expect(full.width).toBe(64);
    expect(narrow.width).toBe(40);
    for (const s of narrow.solids) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w).toBeLessThanOrEqual(40 + 1e-9);
    }
    expect(narrow.crates).toEqual([]); // the crates are all in the outer yards
    expect(narrow.spawns.length).toBe(6);
    expect(narrow.spawns.every((s) => s.x > 0 && s.x < 40)).toBe(true);
    // the pit (x 28-36 in the full arena) is shifted by 12
    expect(narrow.pits[0].x).toBe(16);
  });

  it('a built world uses the arena size for its limits and walls', () => {
    const { world } = worldWith(TEST_LAB, 'full');
    expect(world.bounds).toEqual({ width: 64, height: 26 });
    const walls = world.staticShapes().filter((s) => s.label.startsWith('wall_'));
    expect(walls.map((w) => Math.round(w.pos.x) + 0).sort((a, b) => a - b)).toEqual([0, 64]);
    world.dispose();
  });
});

describe('arrows follow the arena size', () => {
  it('out-of-arena depends on the arena', () => {
    const far = { x: 50, y: 10 };
    expect(outOfArena(far, { width: 64, height: 26 })).toBe(false);
    expect(outOfArena(far, { width: 32, height: 18 })).toBe(true);
  });

  it('a bullet in the Test Lab flies past x 36 (the old arena edge + margin) and lands', () => {
    const { world, log } = worldWith(TEST_LAB, 'full');
    world.addPlayer('a', { x: 19, y: 14 }, 1); // left perch
    for (let i = 0; i < 60; i++) world.step();
    const arrow = shoot(world, 'a', { angle: -0.6 });
    let maxX = 0;
    for (let i = 0; i < 400 && arrow.state === 'flying'; i++) {
      world.step();
      maxX = Math.max(maxX, arrow.pos.x);
    }
    expect(maxX).toBeGreaterThan(36);
    expect(arrow.state).toBe('gone'); // L3: it vanished where it hit
    expect(log.some((e) => e.ev === 'arrow_hit' && e.id === arrow.id)).toBe(true);
    expect(log.some((e) => e.ev === 'arrow_lost' && e.id === arrow.id)).toBe(false);
    world.dispose();
  });
});

describe('pits', () => {
  it('a player in a pit dies; the kill goes to the last hitter (within 3 s); the body stays in the pit', () => {
    const { world, log } = worldWith(TEST_LAB, 'full');
    world.addPlayer('shooter', { x: 13, y: 22 }, 1);
    // standing on the pit floor (3 m deep): the body center is inside the kill zone
    world.addPlayer('victim', { x: 32, y: 25 }, 1);
    world.playerStats('victim').takeDamage(10, 'shooter', world.tick);
    world.step();
    const events: GameEvent[] = world.takeEvents();
    const death = events.find((e) => e.type === 'death');
    expect(death).toMatchObject({ type: 'death', id: 'victim', killer: 'shooter', cause: 'pit' });
    expect(world.playerStats('shooter').kills).toBe(1);
    expect(log.find((e) => e.ev === 'ring_out')).toMatchObject({ id: 'victim', pit: 'pit_1', lastHitBy: 'shooter' });
    for (let i = 0; i < 120; i++) world.step(); // lying at the bottom, not falling out of the world
    expect(world.player('victim').center().y).toBeLessThan(26);
    expect(log.filter((e) => (e.lvl === 'warn' || e.lvl === 'error') && e.ev !== 'slow_step')).toEqual([]); // slow_step = a busy test machine
    world.dispose();
  });

  it('with no recent hit, nobody gets the kill', () => {
    const { world } = worldWith(TEST_LAB, 'full');
    world.addPlayer('victim', { x: 32, y: 25 }, 1);
    world.step();
    expect(world.takeEvents().find((e) => e.type === 'death')).toMatchObject({ killer: null, cause: 'pit' });
    world.dispose();
  });
});

describe('snapshots in big arenas', () => {
  it(`positions at the far corners of the biggest arena (+ arrow margins) survive packing (${1000 / NET.posScale} mm steps)`, () => {
    const biggest = Math.max(...Object.values(ARENAS).map((a) => a.width));
    const { world } = worldWith(TEST_LAB, 'full');
    world.addPlayer('a', { x: 30, y: 22 }, 1);
    const snap = captureSnapshot(world, world.movableBodies());
    const corners = [
      { x: -4, y: -30, a: 0 },
      { x: biggest + 4, y: -30, a: 0 },
      { x: biggest + 4, y: 30, a: 0 },
      { x: -4, y: 30, a: 0 },
    ];
    snap.players[0].parts = PART_NAMES.map((_, i) => corners[i % corners.length]);
    const back = decodeSnapshot(encodeSnapshot(snap))!;
    back.players[0].parts.forEach((p, i) => {
      const want = corners[i % corners.length];
      expect(Math.abs(p.x - want.x)).toBeLessThan(1 / NET.posScale);
      expect(Math.abs(p.y - want.y)).toBeLessThan(1 / NET.posScale);
    });
    world.dispose();
  });
});
