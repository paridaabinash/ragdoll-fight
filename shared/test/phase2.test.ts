import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARROW,
  buildTestLevel,
  DUMMY_PLAYER,
  GameWorld,
  GROUND_Y,
  initPhysics,
  LOCAL_PLAYER,
  Logger,
  memorySink,
  NO_CONTROLS,
  wrapAngle,
  type Aim,
  type Ragdoll,
} from '../src';
import { shoot as fireReady } from './gun-helpers';

beforeAll(() => initPhysics());

function makeWorld(settleTicks = 120) {
  const sink = memorySink();
  const world = new GameWorld(new Logger('test', sink));
  buildTestLevel(world);
  for (let i = 0; i < settleTicks; i++) world.step();
  return { world, logs: sink.entries, p1: world.player(LOCAL_PLAYER), p2: world.player(DUMMY_PLAYER) };
}

const run = (world: GameWorld, ticks: number) => {
  for (let i = 0; i < ticks; i++) world.step();
};
const deg = (d: number) => (d * Math.PI) / 180;
const tilt = (r: Ragdoll) => Math.abs(wrapAngle(r.parts.torso.rotation()));
const headHeight = (r: Ragdoll) => GROUND_Y - r.parts.head.translation().y;
const problems = (logs: { lvl: string; ev: string }[]) => logs.filter((l) => (l.lvl === 'warn' || l.lvl === 'error') && l.ev !== 'slow_step');

function aimAt(world: GameWorld, want: (label: string) => boolean): Aim {
  for (let a = 0; a >= -89; a -= 0.1) {
    const aim = { angle: deg(a) };
    const hit = world.previewShot(LOCAL_PLAYER, aim).hit;
    if (hit && want(hit.label)) return aim;
  }
  throw new Error('no aim hits the target');
}

function shoot(world: GameWorld, aim: Aim) {
  const arrow = fireReady(world, LOCAL_PLAYER, aim);
  for (let i = 0; i < ARROW.maxFlightTicks && arrow.state === 'flying'; i++) world.step();
  return arrow;
}

describe('ragdoll standing', () => {
  it('stands upright and still for 10 s, at full height', () => {
    const { world, logs, p1, p2 } = makeWorld();
    const x0 = p1.center().x;
    let maxTilt = 0;
    for (let i = 0; i < 600; i++) {
      world.step();
      maxTilt = Math.max(maxTilt, tilt(p1), tilt(p2));
    }
    expect(maxTilt).toBeLessThan(0.1);
    expect(Math.abs(p1.center().x - x0)).toBeLessThan(0.05);
    expect(headHeight(p1)).toBeGreaterThan(1.9);
    expect(problems(logs)).toEqual([]);
  });
});

describe('moves', () => {
  it('crouch lowers the head and standing up restores it', () => {
    const { world, p1 } = makeWorld();
    const standing = headHeight(p1);
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, crouch: true });
    run(world, 60);
    expect(standing - headHeight(p1)).toBeGreaterThan(0.4);
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    run(world, 90);
    expect(Math.abs(headHeight(p1) - standing)).toBeLessThan(0.05);
  });

  it('jump only works from the ground and lands upright', () => {
    const { world, logs, p1 } = makeWorld();
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true });
    run(world, 20); // held: a full jump (L2: a one-tick tap is a short hop)
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    run(world, 10);
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true }); // second press, mid-air (too early to be buffered)
    run(world, 140);
    expect(logs.filter((l) => l.ev === 'jump')).toHaveLength(1);
    expect(logs.find((l) => l.ev === 'jump_blocked')?.reason).toBe('in_air');
    const land = logs.find((l) => l.ev === 'land')!;
    expect(land.rise).toBeGreaterThan(0.8);
    expect(p1.down).toBe(false);
  });
});

describe('aiming', () => {
  it('the gun arm points along the aim, and the body turns to face it', () => {
    const { world, p1 } = makeWorld();
    for (const a of [0, -45, -135, 180]) {
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, aim: { angle: deg(a) } });
      run(world, 30);
      const pointing = p1.parts.armFrontUpper.rotation() + Math.PI / 2;
      expect(Math.abs(wrapAngle(pointing - deg(a))), `aim ${a}°`).toBeLessThan(0.15);
      expect(p1.facing).toBe(Math.cos(deg(a)) > 0 ? 1 : -1);
    }
  });

  it('bullets launch from the gun hand, one arm length from the shoulder', () => {
    const { p1 } = makeWorld();
    const aim = { angle: deg(-30) };
    const from = p1.launchPoint(aim);
    const shoulder = p1.jointPos('shoulderFront');
    expect(Math.hypot(from.x - shoulder.x, from.y - shoulder.y)).toBeCloseTo(0.8, 5);
  });
});

describe('getting hit', () => {
  it('a leg hit trips the ragdoll; it falls, gets back up, and knees never bend backwards', () => {
    const { world, logs, p2 } = makeWorld();
    // L3: at 32 m/s the thin wall hides p2's legs from p1's spot (lobs land on the head): step past it first
    world.relocate(LOCAL_PLAYER, { x: 18, y: 17 }, 1);
    run(world, 60);
    shoot(world, aimAt(world, (l) => l.startsWith(`${DUMMY_PLAYER}:leg`)));
    let worstBackwards = 0;
    for (let i = 0; i < 360; i++) {
      world.step();
      for (const k of ['kneeFront', 'kneeBack'] as const) worstBackwards = Math.max(worstBackwards, -p2.jointAngle(k) * p2.facing); // knees bend forward = +angle when facing right
    }
    expect(logs.some((l) => l.ev === 'trip' && l.id === DUMMY_PLAYER)).toBe(true);
    expect(logs.some((l) => l.ev === 'ragdoll_fall' && l.id === DUMMY_PLAYER)).toBe(true);
    expect(p2.down).toBe(false);
    expect(worstBackwards).toBeLessThan(0.15);
    expect(problems(logs)).toEqual([]);
  });

  it('a head hit is logged as zone head and pushes the head', () => {
    const { world, logs, p2 } = makeWorld();
    const before = { ...p2.parts.head.translation() };
    shoot(world, aimAt(world, (l) => l === `${DUMMY_PLAYER}:head`));
    run(world, 2);
    const hit = logs.find((l) => l.ev === 'arrow_hit')!;
    expect(hit.zone).toBe('head');
    expect(p2.parts.head.translation().x).not.toBeCloseTo(before.x, 2);
  });
});
