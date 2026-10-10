import { beforeAll, describe, expect, it } from 'vitest';
import { GameWorld, initPhysics, Logger, MELEE, NO_CONTROLS, weaponLine, type LogEntry } from '../src';

beforeAll(() => initPhysics());

const GROUND_Y = 18;
/** Long enough for any swing to wind up, strike and pass its last hit tick. */
const SWING_TICKS = Math.max(...Object.values(MELEE.motions).map((m) => m.windup + m.ticks + m.activeAfter)) + 2;

/** Flat ground; 'a' at x 10 facing right holding `weapon` (drawn, ready); 'b' at `bx`. Settled. */
function arena(weapon: 'bat' | 'mace', bx: number, wall = false) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  world.addBox('ground', 'fixed', { x: 20, y: GROUND_Y + 0.5 }, { x: 20, y: 0.5 });
  if (wall) world.addBox('wall', 'fixed', { x: 11, y: GROUND_Y - 2 }, { x: 0.1, y: 2 });
  world.spawnPoints = [{ x: 4, y: GROUND_Y, facing: 1 }, { x: 30, y: GROUND_Y, facing: -1 }];
  world.addPlayer('a', { x: 10, y: GROUND_Y }, 1);
  world.addPlayer('b', { x: bx, y: GROUND_Y }, bx > 10 ? -1 : 1);
  for (let i = 0; i < 60; i++) world.step();
  world.damage.get('a')!.weapon = weapon;
  world.setControls('a', { ...NO_CONTROLS, aim: { angle: 0 } }); // facing right
  for (let i = 0; i < 20; i++) world.step();
  return { world, log };
}

function swing(world: GameWorld, angle = 0) {
  const st = world.playerStats('a');
  st.readyAt = world.tick;
  st.lastShotTick = -Infinity;
  st.refill(100);
  expect(world.fire('a', { angle }).swing).toBe(true);
  for (let i = 0; i < SWING_TICKS; i++) world.step();
}

describe('L7 step 6: melee, redesigned', () => {
  it('the bat swings toward where you face, whatever the click aimed at', () => {
    const { world, log } = arena('bat', 11.2);
    swing(world, Math.PI); // the click "aims" behind: ignored
    expect(log.find((e) => e.ev === 'melee_hit')).toMatchObject({ who: 'a', victim: 'b', weapon: 'bat' });
    expect(world.playerStats('b').health).toBeLessThan(100);
  });

  it('the hit is where the drawn weapon is: a body past the weapon tip is missed', () => {
    const { world, log } = arena('bat', 13);
    const arm = world.player('a').parts.armFrontLower;
    const line = weaponLine({ ...arm.translation(), a: arm.rotation() }, 'bat');
    expect(Math.hypot(line.tip.x - line.hand.x, line.tip.y - line.hand.y)).toBeCloseTo(MELEE.weaponLength.bat, 5);
    swing(world);
    expect(log.some((e) => e.ev === 'melee_hit')).toBe(false);
    expect(log.some((e) => e.ev === 'melee_miss')).toBe(true);
    expect(world.playerStats('b').health).toBe(100);
  });

  it('a wall between stops the swing (no hits through walls)', () => {
    const { world, log } = arena('bat', 11.6, true);
    swing(world);
    expect(log.some((e) => e.ev === 'melee_hit')).toBe(false);
    expect(world.playerStats('b').health).toBe(100);
  });

  it('in a corner, the wall behind does not cancel the swing: the enemy in front is still hit (play log bug)', () => {
    const log: LogEntry[] = [];
    const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
    world.addBox('ground', 'fixed', { x: 20, y: GROUND_Y + 0.5 }, { x: 20, y: 0.5 });
    world.addBox('wall_right', 'fixed', { x: 30.2, y: GROUND_Y - 3 }, { x: 0.2, y: 3 });
    world.spawnPoints = [{ x: 4, y: GROUND_Y, facing: 1 }];
    world.addPlayer('a', { x: 29.4, y: GROUND_Y }, -1); // back to the wall, facing left
    world.addPlayer('b', { x: 28.2, y: GROUND_Y }, 1);
    for (let i = 0; i < 60; i++) world.step();
    world.damage.get('a')!.weapon = 'bat';
    world.setControls('a', { ...NO_CONTROLS, aim: { angle: Math.PI } });
    for (let i = 0; i < 20; i++) world.step();
    swing(world, Math.PI);
    expect(log.find((e) => e.ev === 'melee_hit')).toMatchObject({ who: 'a', victim: 'b' });
  });

  it('the mace sweeps low along the floor (the floor does not stop it) and trips who it hits', () => {
    const { world, log } = arena('mace', 11.2);
    swing(world);
    const hit = log.find((e) => e.ev === 'melee_hit');
    expect(hit).toMatchObject({ victim: 'b', weapon: 'mace' });
    expect(log.some((e) => e.ev === 'trip' && e.id === 'b' && String(e.cause).startsWith('melee_sweep'))).toBe(true);
  });

  it('a bat hit on the body: the victim staggers back 2-3 steps leaning back, keeps facing the hitter, stays up', () => {
    const { world, log } = arena('bat', 11.2);
    const b = world.player('b');
    const x0 = b.center().x;
    const a0 = b.parts.torso.rotation();
    const st = world.playerStats('a');
    st.readyAt = world.tick;
    st.refill(100);
    world.fire('a', { angle: 0 });
    let leanBack = 0;
    for (let i = 0; i < 90; i++) {
      world.step();
      leanBack = Math.max(leanBack, b.parts.torso.rotation() - a0); // + = the top tipped toward +x: away from 'a'
    }
    expect(log.find((e) => e.ev === 'stagger')).toMatchObject({ id: 'b', dir: 1 });
    expect(b.center().x - x0).toBeGreaterThan(0.6);
    expect(b.center().x - x0).toBeLessThan(2.5);
    expect(leanBack).toBeGreaterThan(0.15);
    expect(b.facing).toBe(-1); // still facing the hitter
    expect(log.some((e) => e.ev === 'ragdoll_fall' && e.id === 'b')).toBe(false);
  });

  it('staggering into a wall right behind: the stagger ends there (no running on the spot), no fall', () => {
    const log: LogEntry[] = [];
    const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
    world.addBox('ground', 'fixed', { x: 20, y: GROUND_Y + 0.5 }, { x: 20, y: 0.5 });
    world.addBox('wall', 'fixed', { x: 12.75, y: GROUND_Y - 2 }, { x: 0.2, y: 2 });
    world.addPlayer('a', { x: 10.8, y: GROUND_Y }, 1);
    world.addPlayer('b', { x: 12, y: GROUND_Y }, -1);
    for (let i = 0; i < 60; i++) world.step();
    world.damage.get('a')!.weapon = 'bat';
    world.setControls('a', { ...NO_CONTROLS, aim: { angle: 0 } });
    for (let i = 0; i < 20; i++) world.step();
    swing(world);
    for (let i = 0; i < 40; i++) world.step();
    expect(log.some((e) => e.ev === 'stagger' && e.id === 'b')).toBe(true);
    expect(log.some((e) => e.ev === 'stagger_bumped' && e.id === 'b')).toBe(true);
    expect(log.some((e) => e.ev === 'ragdoll_fall' && e.id === 'b')).toBe(false);
    expect(world.player('b').center().x).toBeLessThan(12.6); // (against the wall, not through it)
  });

  it('staggering off a 1 m drop behind: it steps off and lands on its feet', () => {
    const log: LogEntry[] = [];
    const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
    world.addBox('ledge', 'fixed', { x: 6.2, y: GROUND_Y + 0.5 }, { x: 6.2, y: 0.5 });
    world.addBox('low', 'fixed', { x: 26, y: GROUND_Y + 1.5 }, { x: 13.6, y: 0.5 });
    world.addPlayer('a', { x: 10.8, y: GROUND_Y }, 1);
    world.addPlayer('b', { x: 12, y: GROUND_Y }, -1);
    for (let i = 0; i < 60; i++) world.step();
    world.damage.get('a')!.weapon = 'bat';
    world.setControls('a', { ...NO_CONTROLS, aim: { angle: 0 } });
    for (let i = 0; i < 20; i++) world.step();
    swing(world);
    for (let i = 0; i < 120; i++) world.step();
    expect(world.player('b').center().x).toBeGreaterThan(12.5); // off the ledge
    expect(world.player('b').down).toBe(false);
    expect(world.player('b').grounded).toBe(true);
  });

  it('after the swing the weapon arm is let go (damped) for the settle, then back to normal', () => {
    const { world } = arena('bat', 20);
    const st = world.playerStats('a');
    st.readyAt = world.tick;
    st.refill(100);
    world.fire('a', { angle: 0 });
    const m = MELEE.motions.bat;
    for (let i = 0; i < m.windup + m.ticks + 1; i++) world.step();
    expect(world.player('a').mods.swingSettle).toBe(true);
    for (let i = 0; i < m.settleTicks + 1; i++) world.step();
    expect(world.player('a').mods.swingSettle).toBe(false);
  });
});
