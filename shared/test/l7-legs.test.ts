import { beforeAll, describe, expect, it } from 'vitest';
import { GameWorld, initPhysics, LEGS, LOCAL_PLAYER, Logger, NO_CONTROLS, type LogEntry } from '../src';

beforeAll(() => initPhysics());

const GROUND_Y = 18;
function flat() {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  world.bounds = { width: 100, height: GROUND_Y + 1 };
  world.addBox('ground', 'fixed', { x: 50, y: GROUND_Y + 0.5 }, { x: 50, y: 0.5 });
  world.addPlayer(LOCAL_PLAYER, { x: 10, y: GROUND_Y }, 1);
  for (let i = 0; i < 90; i++) world.step();
  return { world, log, p: world.player(LOCAL_PLAYER) };
}
const knee = (w: GameWorld) => {
  const p = w.player(LOCAL_PLAYER);
  return Math.max(p.jointAngle('kneeFront'), p.jointAngle('kneeBack')) * p.facing;
};

describe('L7 step 8: springy legs', () => {
  it('running, the swing leg bends much more at the knee (it was ~0.6 rad)', () => {
    const { world } = flat();
    let most = 0;
    for (let i = 0; i < 120; i++) {
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
      world.step();
      if (i > 40) most = Math.max(most, knee(world));
    }
    expect(most).toBeGreaterThan(0.8);
  });

  it('a landing sinks the knees by the landing speed, then they spring back; the body stays up', () => {
    const { world, log, p } = flat();
    for (let i = 0; i < 150; i++) {
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: i < 20 });
      world.step();
    }
    const land = log.find((e) => e.ev === 'land');
    expect(Number(land?.sink)).toBeGreaterThan(0.3);
    expect(Number(land?.sink)).toBeLessThanOrEqual(LEGS.sinkMax);
    expect(log.some((e) => e.ev === 'ragdoll_fall')).toBe(false);
    expect(p.down).toBe(false);
  });

  it('jumps rise as high as before (the legs change nothing on the way up)', () => {
    const { world, log } = flat();
    for (let i = 0; i < 120; i++) {
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: i < 20 });
      world.step();
    }
    // (the torso rises 1.196 m in this standing jump (sim `jump`);
    // 1.031 m before the jump power 7.5 -> 8)
    expect(Number(log.find((e) => e.ev === 'land')?.rise)).toBeCloseTo(1.196, 2);
  });
});
