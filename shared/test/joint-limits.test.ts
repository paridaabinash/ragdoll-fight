import { beforeAll, describe, expect, it } from 'vitest';
import { ARENAS, arenaLayout, buildArena, GameWorld, initPhysics, Logger, MOTOR, NO_CONTROLS, SOLVER_INTERNAL_ITERATIONS, TEST_LAB, type LogEntry } from '../src';
import { botFight } from '../../tools/fight';

beforeAll(async () => {
  await initPhysics();
});

function worldWithLog(): { world: GameWorld; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { world: new GameWorld(new Logger('test', (e) => entries.push(e))), entries };
}

describe('joint limits hold', () => {
  it('runs the solver with enough internal passes and caps the shoulder motors', () => {
    const { world } = worldWithLog();
    expect(world.physics.numInternalPgsIterations).toBe(SOLVER_INTERNAL_ITERATIONS);
    expect(SOLVER_INTERNAL_ITERATIONS).toBeGreaterThanOrEqual(5);
    expect(MOTOR.shoulderMaxTorque).toBeLessThanOrEqual(40);
    world.dispose();
  });

  // Forearms caught on a 1 m step while the shoulders swing up to aim (before: elbows 0.33 rad past straight).
  it('arms caught on a step while drawing do not bend the elbows backwards', () => {
    const { world } = worldWithLog();
    buildArena(world, arenaLayout(TEST_LAB, 'full'));
    const p = world.addPlayer('x', { x: 12, y: 22 }, 1);
    let worst = -Infinity;
    const steps = (c: Partial<typeof NO_CONTROLS>, n: number) => {
      world.setControls('x', { ...NO_CONTROLS, ...c });
      for (let i = 0; i < n; i++) {
        world.step();
        worst = Math.max(worst, p.worstLimitOver().over);
      }
    };
    steps({}, 30);
    steps({ move: 1 }, 70);
    steps({ aim: { angle: -0.4 } }, 18);
    steps({ aim: { angle: -0.4 } }, 40);
    expect(worst).toBeLessThan(0.1);
    world.dispose();
  });

  // Seeded bot fights that bent joints past their limits before the fix (see the `limits` sim scenario):
  // backyard #1 (a dead body's knee 0.47 rad back for seconds), test_lab #4 (elbows 1.05 rad on a step).
  it.each([
    ['backyard', 1, 3000],
    ['test_lab', 4, 3000],
  ] as const)('%s fight seed %i: no joint_over_limit', (arena, seed, ticks) => {
    const { world, entries } = worldWithLog();
    buildArena(world, arenaLayout(ARENAS[arena], 'full'));
    const ids = ['b0', 'b1', 'b2', 'b3'];
    for (const id of ids) world.spawnPlayer(id);
    botFight(world, ids, seed * 7919, ticks);
    expect(entries.filter((e) => e.ev === 'joint_over_limit')).toEqual([]);
    // the fight really knocks bodies over (falls, deaths); L2: with the faster bodies this seed no longer lands a leg
    // trip, but it still has 17 falls and 18 deaths
    expect(entries.filter((e) => e.ev === 'ragdoll_fall').length).toBeGreaterThan(5);
    world.dispose();
  }, 60_000);
});
