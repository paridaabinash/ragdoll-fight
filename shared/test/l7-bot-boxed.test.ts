import { beforeAll, describe, expect, it } from 'vitest';
import { arenaLayout, BotBrain, buildArena, GameWorld, initPhysics, Logger, NO_CONTROLS, TEST_LAB, type Controls, type LogEntry } from '../src';

beforeAll(() => initPhysics());

/**
 * The narrow Test Lab's first spawn is a 2 m pocket between the left wall and a 1 m step (step_l1). A whole body jumps
 * the step; two stumps can't (sim jump_reach: 0.7 m). Sim stump_survival found a two-stump bot walking back and forth
 * in there for minutes (bot_stuck): its look-ahead measured from 1.4 m under the torso (0.65 m underground on stumps)
 * and it remembered only the last blocked way, so the wall and the step took turns.
 */
function pocket(stumps: number) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  const layout = arenaLayout(TEST_LAB, 'narrow');
  buildArena(world, layout);
  const spawn = layout.spawns[0];
  const p = world.addPlayer('bot', { x: spawn.x, y: spawn.y }, 1);
  for (let i = 0; i < 60; i++) world.step();
  // the real leg ladder (5 hits: two stumps), so the rules and the body agree
  for (let i = 0; i < 8 && p.stumps.size < stumps; i++) world.bodyHit('bot', 'legFrontLower', 1, 'test');
  const brain = new BotBrain('bot', 7);
  let controls: Controls = NO_CONTROLS;
  let maxX = -Infinity;
  for (let t = 0; t < 30 * 60; t++) {
    for (const a of brain.think(world)) if (a.t === 'input') controls = { aim: a.aim === null ? null : { angle: a.aim }, crouch: a.crouch, jump: a.jump, move: a.move };
    world.setControls('bot', controls);
    world.step();
    maxX = Math.max(maxX, world.player('bot').center().x);
  }
  const step = layout.solids.find((s) => s.label === 'step_l1')!;
  const legsLeft = p.legsLeft;
  world.dispose();
  return { log, legsLeft, maxX, step };
}

describe('L7: a bot boxed in by obstacles its body can not pass', () => {
  it('two stumps in the pocket: sees the step as a wall, stands instead of walking back and forth (no bot_stuck)', () => {
    const { log, legsLeft, maxX, step } = pocket(2);
    expect(legsLeft).toBe(0);
    expect(maxX).toBeLessThan(step.x); // never got up the 1 m step
    expect(log.some((e) => e.ev === 'bot_turn' && e.why === 'wall' && e.blockedDir === 1)).toBe(true); // the step is a wall for stumps
    expect(log.some((e) => e.ev === 'bot_boxed_in')).toBe(true);
    expect(log.some((e) => e.ev === 'bot_stuck')).toBe(false);
    // the look-ahead's knee ray no longer starts underground: no jump on every landing
    expect(log.filter((e) => e.ev === 'jump').length).toBeLessThan(10);
    expect(log.filter((e) => e.lvl === 'error')).toEqual([]);
  });

  it('a whole body in the same pocket jumps the step and gets out', () => {
    const { log, maxX, step } = pocket(0);
    expect(maxX).toBeGreaterThan(step.x + 1);
    expect(log.some((e) => e.ev === 'bot_stuck')).toBe(false);
  });

  it('one leg (hopping) jumps as high as a whole body: it gets out too', () => {
    const { log, legsLeft, maxX, step } = pocket(1);
    expect(legsLeft).toBe(1);
    expect(maxX).toBeGreaterThan(step.x + 1);
    expect(log.some((e) => e.ev === 'bot_stuck')).toBe(false);
  });

  it('two stumps on open flat ground: no phantom walls or steps (the look-ahead measures from the real soles)', () => {
    const log: LogEntry[] = [];
    const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
    world.bounds = { width: 200, height: 30 };
    world.addBox('floor', 'fixed', { x: 100, y: 29.5 }, { x: 100, y: 0.5 });
    const p = world.addPlayer('bot', { x: 100, y: 29 }, 1);
    for (let i = 0; i < 60; i++) world.step();
    for (let i = 0; i < 8 && p.stumps.size < 2; i++) world.bodyHit('bot', 'legFrontLower', 1, 'test');
    const brain = new BotBrain('bot', 3);
    let controls: Controls = NO_CONTROLS;
    for (let t = 0; t < 10 * 60; t++) {
      for (const a of brain.think(world)) if (a.t === 'input') controls = { aim: a.aim === null ? null : { angle: a.aim }, crouch: a.crouch, jump: a.jump, move: a.move };
      world.setControls('bot', controls);
      world.step();
    }
    expect(p.legsLeft).toBe(0);
    expect(log.filter((e) => e.ev === 'walk_start').length).toBeGreaterThan(0); // it did walk
    expect(log.filter((e) => e.ev === 'bot_turn')).toEqual([]);
    expect(log.filter((e) => e.ev === 'jump')).toEqual([]);
    world.dispose();
  });
});
