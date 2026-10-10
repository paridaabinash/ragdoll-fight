import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestLevel, DUMMY_PLAYER, GameWorld, HIT_REACTION, initPhysics, LOCAL_PLAYER, Logger, type LogEntry } from '../src';

beforeAll(() => initPhysics());

function range() {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildTestLevel(world);
  for (let i = 0; i < 60; i++) world.step();
  return { world, log };
}

describe('L7 step 5: hits you can feel', () => {
  it('a torso hit knocks the whole body along the bullet (not just the part), and is logged', () => {
    const { world, log } = range();
    const p = world.player(DUMMY_PLAYER);
    const before = p.speedX();
    world.hitReaction(DUMMY_PLAYER, 'torso', { x: 32, y: 0 }); // from the left: knocked to the right
    world.step();
    expect(p.speedX() - before).toBeGreaterThan(HIT_REACTION.knock.torso * 0.6);
    expect(log.find((e) => e.ev === 'hit_knock')).toMatchObject({ id: DUMMY_PLAYER, zone: 'torso', dir: 1 });
  });

  it('a hit flinches the body for a moment (weak walk and air control), then it ends', () => {
    const { world } = range();
    const p = world.player(DUMMY_PLAYER);
    world.hitReaction(DUMMY_PLAYER, 'leg', { x: -32, y: 0 });
    world.step();
    expect(p.mods.flinch).toBe(true);
    for (let i = 0; i < HIT_REACTION.flinchTicks + 1; i++) world.step();
    expect(p.mods.flinch).toBe(false);
  });

  it('a head hit pitches the torso back, away from the shooter', () => {
    const { world } = range();
    const torso = world.player(LOCAL_PLAYER).parts.torso;
    const a0 = torso.rotation();
    world.hitReaction(LOCAL_PLAYER, 'head', { x: -32, y: 0 }); // from the right: pitched back to the left
    let least = 0;
    for (let i = 0; i < 30; i++) {
      world.step();
      least = Math.min(least, torso.rotation() - a0);
    }
    expect(least).toBeLessThan(-0.1);
  });

  it('nothing happens to the dead (the shield blocks the hit before it gets here)', () => {
    const { world, log } = range();
    world.stats.get(DUMMY_PLAYER)!.health = 1;
    world.hurt(DUMMY_PLAYER, LOCAL_PLAYER, 5, { x: 0, y: 0 });
    world.hitReaction(DUMMY_PLAYER, 'torso', { x: 32, y: 0 });
    expect(log.some((e) => e.ev === 'hit_knock')).toBe(false);
  });
});
