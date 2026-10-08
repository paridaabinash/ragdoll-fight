import { beforeAll, describe, expect, it } from 'vitest';
import { aimAt, ARROW, buildTestLevel, GameWorld, initPhysics, LOCAL_PLAYER, Logger, memorySink, stepArrow, type Aim } from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

function makeWorld() {
  const sink = memorySink();
  const world = new GameWorld(new Logger('test', sink));
  buildTestLevel(world);
  return { world, logs: sink.entries };
}

/** Steps until the arrow is no longer flying. */
function flyUntilDone(world: GameWorld, id: number) {
  for (let i = 0; i < ARROW.maxFlightTicks + 5; i++) {
    const a = world.arrows.find((x) => x.id === id);
    if (!a || a.state !== 'flying') return a;
    world.step();
  }
  throw new Error('arrow never landed');
}

const deg = (d: number) => (d * Math.PI) / 180;

describe('aim (L3: the gun points at the pointer)', () => {
  it('points from the shoulder toward the pointer', () => {
    expect(aimAt({ x: 5, y: 5 }, { x: 9, y: 5 }).angle).toBeCloseTo(0); // right
    expect(aimAt({ x: 5, y: 5 }, { x: 5, y: 9 }).angle).toBeCloseTo(Math.PI / 2); // down (y points down)
  });
  it('how far away the pointer is does not matter', () => {
    expect(aimAt({ x: 0, y: 0 }, { x: 1, y: -1 }).angle).toBeCloseTo(aimAt({ x: 0, y: 0 }, { x: 300, y: -300 }).angle, 12);
  });
});

describe('arrow flight', () => {
  it('gravity bends the path down (y grows)', () => {
    let s = { pos: { x: 0, y: 0 }, vel: { x: 10, y: 0 } };
    for (let i = 0; i < 30; i++) s = stepArrow(s.pos, s.vel);
    expect(s.pos.y).toBeGreaterThan(0);
    expect(s.vel.x).toBe(10);
  });

  it('aim preview matches the real arrow exactly against fixed targets', () => {
    const { world, logs } = makeWorld();
    let compared = 0;
    for (let angle = -5; angle >= -85; angle -= 5) {
      const aim: Aim = { angle: deg(angle) };
      const preview = world.previewShot(LOCAL_PLAYER, aim);
      // (L3: every shot is 32 m/s, so some lobs fly out over the Backyard's walls and hit nothing; both agree on that)
      if (!preview.hit) continue;
      const arrow = shoot(world, LOCAL_PLAYER, aim);
      flyUntilDone(world, arrow.id);
      const hit = logs.find((l) => l.ev === 'arrow_hit' && l.id === arrow.id);
      // no hit line: it was used up on an apple or a power-up bubble (which bob, so they're "moving" targets anyway)
      if (!hit || hit.moving || hit.predMoving) continue; // crates, ragdolls and apples may have moved since the preview
      expect(hit.target).toBe(preview.hit!.label);
      expect(hit.predErr).toBe(0);
      expect(hit.predTickErr).toBe(0);
      compared++;
    }
    expect(compared).toBeGreaterThan(5);
  });

  it('aim preview sees the level before the first physics step', () => {
    const { world } = makeWorld();
    expect(world.previewShot(LOCAL_PLAYER, { angle: deg(90) }).hit?.label).toBe('ground');
  });

  it('a bullet cannot pass through the 0.1 m thin wall', () => {
    const { world, logs } = makeWorld();
    const arrow = shoot(world, LOCAL_PLAYER, { angle: deg(-2) });
    flyUntilDone(world, arrow.id);
    expect(logs.find((l) => l.ev === 'arrow_hit')?.target).toBe('thin_wall');
  });

  it('arrows never hit their own shooter', () => {
    const { world, logs } = makeWorld();
    const arrow = shoot(world, LOCAL_PLAYER, { angle: deg(90) }); // straight down through own legs
    flyUntilDone(world, arrow.id);
    expect(logs.find((l) => l.ev === 'arrow_hit')?.target).toBe('ground');
  });

  it('a broken aim (NaN) is refused and logged', () => {
    const { world, logs } = makeWorld();
    expect(world.fire(LOCAL_PLAYER, { angle: NaN })).toEqual({ arrow: null, refused: 'invalid_aim' });
    expect(logs.some((l) => l.ev === 'shot_blocked' && l.reason === 'invalid_aim')).toBe(true);
  });
});

describe('hits on moving things', () => {
  it('pushes a crate, and the bullet is gone (L3: nothing stays stuck)', () => {
    const { world } = makeWorld();
    for (let i = 0; i < 120; i++) world.step(); // let crates settle
    const crate = world.bodyByLabel('crate_3')!;
    const before = { ...crate.translation() };

    let aim: Aim | null = null;
    for (let a = -5; a >= -89 && !aim; a -= 0.1) {
      const candidate = { angle: deg(a) };
      if (world.previewShot(LOCAL_PLAYER, candidate).hit?.label === 'crate_3') aim = candidate;
    }
    expect(aim).not.toBeNull();
    const arrow = shoot(world, LOCAL_PLAYER, aim!);
    flyUntilDone(world, arrow.id);
    expect(arrow.state).toBe('gone');
    expect(world.arrows).toHaveLength(0);
    expect(world.takeEvents().some((e) => e.type === 'impact' && e.on === 'object')).toBe(true);
    for (let i = 0; i < 60; i++) world.step();
    expect(crate.translation().x).not.toBeCloseTo(before.x, 2);
  });
});

describe('stability', () => {
  it('10 s idle produces no warnings or errors', () => {
    const { world, logs } = makeWorld();
    for (let i = 0; i < 600; i++) world.step();
    const bad = logs.filter((l) => (l.lvl === 'warn' || l.lvl === 'error') && l.ev !== 'slow_step');
    expect(bad).toEqual([]);
  });
});
