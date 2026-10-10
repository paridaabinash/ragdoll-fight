import { beforeAll, describe, expect, it } from 'vitest';
import { GameWorld, initPhysics, Logger, NO_CONTROLS, type LogEntry } from '../src';

beforeAll(() => initPhysics());

describe('L7: a body hung in the air on something can still jump', () => {
  it('legs down a slot narrower than the torso (feet touching nothing): after a moment it may jump out', () => {
    const log: LogEntry[] = [];
    const w = new GameWorld(new Logger('test', (e) => void log.push(e)));
    w.bounds = { width: 40, height: 30 };
    w.addBox('floor', 'fixed', { x: 20, y: 29.5 }, { x: 20, y: 0.5 });
    // two blocks with a 0.3 m slot between them: the legs drop in, the torso rests on the edges
    w.addBox('block_l', 'fixed', { x: 18.85, y: 22 }, { x: 1, y: 4 });
    w.addBox('block_r', 'fixed', { x: 21.15, y: 22 }, { x: 1, y: 4 });
    const p = w.addPlayer('a', { x: 20, y: 17.6 }, 1);
    for (let i = 0; i < 120; i++) {
      w.setControls('a', NO_CONTROLS);
      w.step();
    }
    expect(p.grounded).toBe(false); // (only the feet count as ground: this used to mean no jump, ever)
    for (let i = 0; i < 25; i++) {
      w.setControls('a', { ...NO_CONTROLS, jump: i < 20 });
      w.step();
    }
    expect(log.some((e) => e.ev === 'jump_unstuck')).toBe(true);
    expect(log.some((e) => e.ev === 'jump')).toBe(true);
  });
});
