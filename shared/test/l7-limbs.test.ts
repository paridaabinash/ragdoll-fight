import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestLevel, DUMMY_PLAYER, GameWorld, initPhysics, LIMB, LOCAL_PLAYER, Logger, newTally, pickAwards, type GameEvent, type LogEntry } from '../src';

beforeAll(() => initPhysics());

function range() {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildTestLevel(world);
  for (let i = 0; i < 60; i++) world.step();
  return { world, log };
}

describe('L7 step 7: a lost leg you notice', () => {
  it('the 3rd leg hit: LEG OFF! for everyone (with who did it), the shin flies off along the bullet and lands with a thud', () => {
    const { world, log } = range();
    const events: GameEvent[] = [];
    const steps = (n: number) => {
      for (let i = 0; i < n; i++) {
        world.step();
        events.push(...world.takeEvents());
      }
    };
    for (let i = 0; i < 2; i++) {
      world.bodyHit(DUMMY_PLAYER, 'legFrontLower', -1, 'test', LOCAL_PLAYER);
      steps(150);
    }
    events.push(...world.takeEvents());
    world.bodyHit(DUMMY_PLAYER, 'legFrontLower', -1, 'test', LOCAL_PLAYER); // shot down to a stump
    events.push(...world.takeEvents());
    expect(events).toContainEqual(expect.objectContaining({ type: 'callout', kind: 'leg_off', id: DUMMY_PLAYER, by: LOCAL_PLAYER }));
    const p = world.player(DUMMY_PLAYER);
    const shin = p.lost.has('legFrontLower') ? p.parts.legFrontLower : p.parts.legBackLower;
    steps(1);
    expect(shin.linvel().x).toBeLessThan(-LIMB.lostLeg.along * 0.5); // along the bullet (it came from the right)
    expect(shin.linvel().y).toBeLessThan(0); // up
    steps(180);
    expect(events.some((e) => e.type === 'thud')).toBe(true);
    expect(log.some((e) => e.ev === 'piece_thud')).toBe(true);
    expect(world.tally.get(DUMMY_PLAYER)!.limbsLost).toBe(1);
    expect(world.tally.get(DUMMY_PLAYER)!.stumpTicks).toBeGreaterThan(100);
  });

  it('awards: Flesh Wound (longest alive on a stump) and Most Limbs Lost', () => {
    const a = { ...newTally(), stumpTicks: 600, limbsLost: 1 };
    const b = { ...newTally(), stumpTicks: 120, limbsLost: 3 };
    const awards = pickAwards(new Map([['a', a], ['b', b]]), ['a', 'b']);
    expect(awards).toContainEqual({ kind: 'flesh_wound', id: 'a', value: 10 });
    expect(awards).toContainEqual({ kind: 'most_limbs_lost', id: 'b', value: 3 });
  });
});
