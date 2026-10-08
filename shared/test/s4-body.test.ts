import { beforeAll, describe, expect, it } from 'vitest';
import {
  BIG_HEAD,
  buildTestLevel,
  captureSnapshot,
  damageFor,
  decodeSnapshot,
  DUMMY_PLAYER,
  encodeSnapshot,
  GameWorld,
  GROUND_Y,
  HEALTH,
  initPhysics,
  launchPointFrom,
  LOCAL_PLAYER,
  Logger,
  NO_CONTROLS,
  RAGDOLL,
  type LogEntry,
} from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

function makeWorld() {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildTestLevel(world);
  for (let i = 0; i < 120; i++) world.step();
  return { world, log };
}

describe('body', () => {
  it('clown boots: the lower legs are heavier than the upper legs; the head hitbox is the S4 size', () => {
    const { world } = makeWorld();
    const p = world.player(LOCAL_PLAYER);
    expect(p.parts.legFrontLower.mass()).toBeGreaterThan(p.parts.legFrontUpper.mass() * 1.5);
    expect(p.parts.head.collider(0).radius()).toBeCloseTo(RAGDOLL.head.r, 6);
    world.dispose();
  });

  it('spaghetti arms: loose arms swing around, but shots still start at the shoulder + arm length (preview = arrow)', () => {
    const { world, log } = makeWorld();
    const p = world.player(LOCAL_PLAYER);
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
    for (let i = 0; i < 40; i++) world.step(); // arms flopping while running
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    world.step();
    const aim = { angle: 0.3 }; // into the ground: a fixed target
    const preview = world.previewShot(LOCAL_PLAYER, aim);
    expect(preview.points[0].x).toBeCloseTo(launchPointFrom(p.jointPos('shoulderFront'), aim).x, 9);
    const arrow = shoot(world, LOCAL_PLAYER, aim);
    expect(arrow.from).toEqual(preview.points[0]);
    for (let i = 0; i < 100 && arrow.state === 'flying'; i++) world.step();
    expect(log.find((e) => e.ev === 'arrow_hit' && e.id === arrow.id)?.predErr).toBe(0);
    world.dispose();
  });
});

describe('Big Head Mode hook (used by S7)', () => {
  it('bigger head hitbox (same weight) and a smaller headshot multiplier; off restores both exactly', () => {
    const { world, log } = makeWorld();
    const head = world.player(DUMMY_PLAYER).parts.head;
    const mass = head.mass();
    world.setBigHeads(true);
    expect(head.collider(0).radius()).toBeCloseTo(RAGDOLL.head.r * BIG_HEAD.hitboxScale, 6);
    expect(head.mass()).toBeCloseTo(mass, 6);
    expect(world.headMultiplier).toBe(BIG_HEAD.headMultiplier);
    expect(log.find((e) => e.ev === 'big_heads')).toMatchObject({ on: true });
    // a player who joins during the round gets the big head too
    world.spawnPlayer('late');
    expect(world.player('late').parts.head.collider(0).radius()).toBeCloseTo(RAGDOLL.head.r * BIG_HEAD.hitboxScale, 6);
    // clients learn the size from snapshots (for their preview and drawing)
    expect(decodeSnapshot(encodeSnapshot(captureSnapshot(world, world.movableBodies())))!.headScale).toBe(BIG_HEAD.hitboxScale);
    world.setBigHeads(false);
    expect(head.collider(0).radius()).toBeCloseTo(RAGDOLL.head.r, 6);
    expect(head.mass()).toBeCloseTo(mass, 6);
    expect(world.headMultiplier).toBe(HEALTH.zoneMultiplier.head);
    world.dispose();
  });

  it('headshot damage uses the multiplier', () => {
    expect(damageFor('head', 32)).toBe(HEALTH.baseDamage * HEALTH.zoneMultiplier.head);
    expect(damageFor('head', 32, BIG_HEAD.headMultiplier)).toBe(HEALTH.baseDamage * BIG_HEAD.headMultiplier);
    expect(damageFor('torso', 32, BIG_HEAD.headMultiplier)).toBe(HEALTH.baseDamage);
  });
});

describe('dash feel', () => {
  it('a normal stop never stumbles; with a head arrow, a stop from running always does', () => {
    for (const head of [false, true]) {
      const log: LogEntry[] = [];
      const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
      world.addBox('ground', 'fixed', { x: 16, y: GROUND_Y + 0.5 }, { x: 16, y: 0.5 });
      world.addPlayer(LOCAL_PLAYER, { x: 8, y: GROUND_Y }, 1);
      for (let i = 0; i < 90; i++) world.step();
      const keep = () => head && world.effects.get(LOCAL_PLAYER)!.add('head', 'head', world.tick);
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
      for (let i = 0; i < 90; i++) {
        keep();
        world.step();
      }
      world.setControls(LOCAL_PLAYER, NO_CONTROLS);
      for (let i = 0; i < 60; i++) {
        keep();
        world.step();
      }
      const stumbles = log.filter((e) => e.ev === 'stumble');
      // (a head arrow can also make a standing body wobble into a stumble on its own; the stop one is what's checked)
      if (head) expect(stumbles.find((e) => e.cause === 'head_stop')).toMatchObject({ dir: 1 });
      else expect(stumbles).toEqual([]);
      expect(log.some((e) => e.ev === 'ragdoll_fall')).toBe(false);
      world.dispose();
    }
  });
});
