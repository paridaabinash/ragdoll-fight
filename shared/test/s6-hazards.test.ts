import RAPIER from '@dimforge/rapier2d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  arenaInfo,
  arenaLayout,
  BACKYARD,
  buildArena,
  GameWorld,
  HAZARD,
  initPhysics,
  LOCAL_PLAYER,
  Logger,
  TEST_LAB,
  raycastShapes,
  shoulderFrontFrom,
  traceShot,
  validateArena,
  windAt,
  type ArenaDef,
  type PlacedShape,
  type LogEntry,
} from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

function lab(size: 'full' | 'narrow' = 'full') {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildArena(world, arenaLayout(TEST_LAB, size));
  return { world, log };
}

describe('hazard data', () => {
  it('the checks catch a trampoline in the air and a wrecking ball that can swing out of the arena', () => {
    const bad: ArenaDef = {
      ...BACKYARD,
      id: 'bad',
      hazards: [
        { kind: 'trampoline', label: 't', x: 5, y: 10, w: 1, power: 15 },
        { kind: 'wrecking_ball', label: 'b', x: 2, y: 5, length: 6, radius: 0.5 },
      ],
    };
    const problems = validateArena(arenaLayout(bad, 'full')).join('\n');
    expect(problems).toMatch(/trampoline t is not lying on top of a solid/);
    expect(problems).toMatch(/wrecking_ball b can swing outside/);
  });

  it('the narrow Test Lab keeps the middle hazards and drops the outer-yard ones; clients get hazards + surfaces', () => {
    const narrow = arenaLayout(TEST_LAB, 'narrow');
    expect(narrow.hazards.map((h) => h.kind).sort()).toEqual(['conveyor', 'trampoline', 'trampoline', 'wind']);
    const info = arenaInfo(arenaLayout(TEST_LAB, 'full'));
    expect(info.hazards.length).toBe(6);
    expect(info.surfaces).toEqual(expect.arrayContaining([{ label: 'bridge_r', surface: 'ice' }, { label: 'bouncer_l', surface: 'bouncy' }]));
  });

  it('wind is the sum of the boxes a point is in', () => {
    const hz = TEST_LAB.hazards!;
    expect(windAt(hz, { x: 32, y: 14 })).toEqual({ x: 8, y: 0 });
    expect(windAt(hz, { x: 20, y: 14 })).toEqual({ x: 0, y: 0 });
  });
});

describe('hazards in the world', () => {
  it('ice and bouncy floors really apply (their combine rules win over the feet)', () => {
    const { world } = lab();
    const collider = (label: string) => {
      let found: RAPIER.Collider | null = null;
      world.physics.forEachCollider((c) => {
        if (world.labelOf(c) === label) found = c;
      });
      return found! as RAPIER.Collider;
    };
    const ice = collider('bridge_r');
    expect(ice.friction()).toBeCloseTo(HAZARD.surface.iceFriction, 6); // (stored as a 32-bit float)
    expect(ice.frictionCombineRule()).toBe(RAPIER.CoefficientCombineRule.Min);
    const bouncy = collider('bouncer_l');
    expect(bouncy.restitution()).toBeCloseTo(HAZARD.surface.bouncyRestitution, 6);
    expect(bouncy.restitutionCombineRule()).toBe(RAPIER.CoefficientCombineRule.Max);
    world.dispose();
  });

  it('wind bends arrows, and the preview bends them exactly the same (preview = reality)', () => {
    const { world, log } = lab();
    world.addPlayer(LOCAL_PLAYER, { x: 24, y: 18 }, 1);
    for (let i = 0; i < 60; i++) world.step();
    const aim = { angle: -0.15 };
    const preview = world.previewShot(LOCAL_PLAYER, aim);
    const a = shoot(world, LOCAL_PLAYER, aim);
    for (let i = 0; i < 300 && a.state === 'flying'; i++) world.step();
    const hit = log.find((e) => e.ev === 'arrow_hit' && e.id === a.id)!;
    expect(hit.predErr).toBe(0);
    expect(hit.predTickErr).toBe(0);
    expect(hit.target).toBe(preview.hit?.label);
    world.dispose();
  });

  it('a trampoline launches whoever stands on it (at its power), at most once per cooldown', () => {
    const { world, log } = lab();
    const p = world.addPlayer(LOCAL_PLAYER, { x: 15, y: 20.95 }, 1);
    world.step();
    world.step();
    expect(log.filter((e) => e.ev === 'hazard_hit' && e.kind === 'trampoline').length).toBe(1);
    expect(-p.parts.torso.linvel().y).toBeGreaterThan(15);
    world.dispose();
  });

  it('a conveyor carries a player standing on it at its speed', () => {
    const { world } = lab();
    const p = world.addPlayer(LOCAL_PLAYER, { x: 27, y: 18 }, 1);
    for (let i = 0; i < 90; i++) world.step();
    expect(p.mods.beltSpeed).toBe(1.5);
    expect(p.speedX()).toBeCloseTo(1.5, 0);
    world.dispose();
  });

  it('a shot swings the wrecking ball; it knocks a player down and the shooter gets the hit', () => {
    const { world, log } = lab();
    world.addPlayer('v', { x: 58.6, y: 22 }, -1);
    world.addPlayer(LOCAL_PLAYER, { x: 51.5, y: 22 }, 1);
    for (let i = 0; i < 60; i++) world.step();
    let aim = null;
    for (let d = 0; d >= -70 && !aim; d -= 0.25) {
      const a = { angle: (d * Math.PI) / 180 };
      if (world.previewShot(LOCAL_PLAYER, a).hit?.label === 'wreck_r') aim = a;
    }
    const arrow = shoot(world, LOCAL_PLAYER, aim!);
    for (let i = 0; i < 200; i++) world.step();
    expect(arrow.state).not.toBe('flying');
    expect(log.find((e) => e.ev === 'hazard_hit' && e.kind === 'wrecking_ball')).toMatchObject({ id: 'v', by: LOCAL_PLAYER });
    expect(world.playerStats('v').lastHit?.by).toBe(LOCAL_PLAYER);
    world.dispose();
  });

  it("the online client's preview (plain shapes + wind from the arena info) agrees with the server's through the wind", () => {
    const { world } = lab();
    world.addPlayer(LOCAL_PLAYER, { x: 24, y: 18 }, 1);
    for (let i = 0; i < 60; i++) world.step();
    const info = arenaInfo(world.arena!);
    const shapes: PlacedShape[] = world.staticShapes().map((x) => ({ ...x }));
    for (const m of world.movableBodies()) if (m.collider.isEnabled()) shapes.push({ label: m.label, shape: m.shape, pos: { ...m.body.translation() }, angle: m.body.rotation() });
    const t = world.player(LOCAL_PLAYER).parts.torso;
    for (const angle of [-0.1, -0.25, -0.4]) {
      const aim = { angle, power: 0.75 };
      const server = world.previewShot(LOCAL_PLAYER, aim);
      const client = traceShot(shoulderFrontFrom(t.translation(), t.rotation()), aim, (a, b) => raycastShapes(a, b, shapes), info, (p) => windAt(info.hazards, p));
      expect(client.hit?.label).toBe(server.hit?.label);
      expect(client.ticks).toBe(server.ticks);
    }
    world.dispose();
  });
});
