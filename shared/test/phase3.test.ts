import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARROW,
  buildTestLevel,
  GUN,
  damageFor,
  DUMMY_PLAYER,
  GameWorld,
  GROUND_Y,
  HEALTH,
  initPhysics,
  killCredit,
  LOCAL_PLAYER,
  Logger,
  memorySink,
  NO_CONTROLS,
  PlayerStats,
  RESPAWN,
  STAMINA,
  WALK,
  type Aim,
  type Controls,
} from '../src';
import { shoot as fireReady } from './gun-helpers';

beforeAll(() => initPhysics());

const deg = (d: number) => (d * Math.PI) / 180;
const quietLog = () => new Logger('test', () => {});

function makeWorld(settleTicks = 120) {
  const sink = memorySink();
  const world = new GameWorld(new Logger('test', sink));
  buildTestLevel(world);
  for (let i = 0; i < settleTicks; i++) world.step();
  return { world, logs: sink.entries };
}

function hold(world: GameWorld, c: Partial<Controls>, ticks: number) {
  world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, ...c });
  for (let i = 0; i < ticks; i++) world.step();
}

/** Middle of the first run of angles whose preview hits `label`. */
function aimAt(world: GameWorld, label: string, minAngle = -89): Aim {
  const run: number[] = [];
  for (let a = 0; a >= minAngle; a -= 0.1) {
    if (world.previewShot(LOCAL_PLAYER, { angle: deg(a) }).hit?.label.startsWith(label)) run.push(a);
    else if (run.length) break;
  }
  if (!run.length) throw new Error(`no aim hits ${label}`);
  return { angle: deg(run[Math.floor(run.length / 2)]) };
}

function shoot(world: GameWorld, aim: Aim) {
  const arrow = fireReady(world, LOCAL_PLAYER, aim);
  for (let i = 0; i < ARROW.maxFlightTicks && arrow.state === 'flying'; i++) world.step();
  return arrow;
}

describe('damage rules', () => {
  it('a full-speed hit does 20 to the torso, 100 to the head, 12 to arms and legs', () => {
    expect(damageFor('torso', GUN.bulletSpeed)).toBe(20);
    expect(damageFor('head', GUN.bulletSpeed)).toBe(100);
    expect(damageFor('arm', GUN.bulletSpeed)).toBe(12);
    expect(damageFor('leg', GUN.bulletSpeed)).toBe(12);
  });
  it('slower bullets (a lob coming down slowly) do less; faster counts as full; never less than 1', () => {
    expect(damageFor('torso', GUN.bulletSpeed * 0.45)).toBe(10); // half of the full-damage speed
    expect(damageFor('torso', GUN.bulletSpeed * HEALTH.fullDamageSpeedShare)).toBe(20);
    expect(damageFor('head', GUN.bulletSpeed * 1.5)).toBe(100);
    expect(damageFor('leg', 0.1)).toBe(1);
  });
  it('a bullet that slowed a little climbing its arc is still a one-hit headshot', () => {
    expect(damageFor('head', 31.83)).toBe(HEALTH.max); // measured online: 99 before this rule
    expect(damageFor('head', 29)).toBe(HEALTH.max);
  });
  it('five full-speed torso hits kill', () => {
    const st = new PlayerStats('x', quietLog());
    for (let i = 0; i < 4; i++) st.takeDamage(damageFor('torso', GUN.bulletSpeed), 'y', i);
    expect(st.health).toBe(20);
    st.takeDamage(damageFor('torso', GUN.bulletSpeed), 'y', 5);
    expect(st.health).toBe(0);
  });
});

describe('kill credit', () => {
  it('goes to the last hitter within 3 s, and nobody after that', () => {
    expect(killCredit({ by: 'a', tick: 100 }, 100 + HEALTH.killCreditTicks)).toBe('a');
    expect(killCredit({ by: 'a', tick: 100 }, 101 + HEALTH.killCreditTicks)).toBeNull();
    expect(killCredit(null, 100)).toBeNull();
  });
});

describe('stamina', () => {
  it('aiming is free (L3); once empty, arms come back after the rest + refilling to 40', () => {
    const st = new PlayerStats('x', quietLog());
    let t = 0;
    for (; t < 600; t++) st.updateStamina(t); // aiming all along costs nothing
    expect(st.stamina).toBe(STAMINA.max);
    st.stamina = 5;
    st.shoot(t); // the last 5: empty, arms down
    expect(st.armsDown).toBe(true);
    const restFrom = st.readyAt; // the rest starts when the reload is done
    while (st.armsDown && t < 2000) st.updateStamina(t++);
    const wanted = STAMINA.refillDelayTicks + (STAMINA.recoverAt / STAMINA.refillPerSec) * 60;
    expect(Math.abs(t - restFrom - wanted)).toBeLessThanOrEqual(2);
  });
  it('a jump needs 20', () => {
    const st = new PlayerStats('x', quietLog());
    st.stamina = 19;
    expect(st.trySpend(STAMINA.jumpCost, 0)).toBe(false);
    st.stamina = 20;
    expect(st.trySpend(STAMINA.jumpCost, 0)).toBe(true);
    expect(st.stamina).toBe(0);
  });
  it('in the world: the shot that empties stamina drops the arms; the next is refused', () => {
    const { world, logs } = makeWorld(10);
    world.playerStats(LOCAL_PLAYER).stamina = 0.1;
    hold(world, { aim: { angle: 0 } }, 2);
    expect(world.fire(LOCAL_PLAYER, { angle: 0 }).arrow).not.toBeNull();
    expect(world.playerStats(LOCAL_PLAYER).armsDown).toBe(true);
    hold(world, { aim: { angle: 0 } }, GUN.reloadTicks + 1);
    expect(world.fire(LOCAL_PLAYER, { angle: 0 }).refused).toBe('arms_down');
    expect(logs.find((l) => l.ev === 'shot_blocked')?.reason).toBe('arms_down');
  });
});

describe('protection and death', () => {
  it('no damage while protected after respawn, or once dead', () => {
    const st = new PlayerStats('x', quietLog());
    st.revive(100);
    expect(st.takeDamage(50, 'y', 100 + RESPAWN.protectTicks - 1)).toBe(0);
    expect(st.takeDamage(50, 'y', 100 + RESPAWN.protectTicks)).toBe(50);
    st.markDead(200);
    expect(st.takeDamage(10, 'y', 201)).toBe(0);
  });

  it('full-power headshot: one-hit kill, limp body, respawn 3 s later at full health, score counted', () => {
    const { world, logs } = makeWorld();
    shoot(world, aimAt(world, `${DUMMY_PLAYER}:head`));
    const death = logs.find((l) => l.ev === 'death')!;
    expect(death).toMatchObject({ id: DUMMY_PLAYER, killer: LOCAL_PLAYER, cause: 'arrow' });
    expect(world.player(DUMMY_PLAYER).limp).toBe(true);
    expect(world.playerStats(LOCAL_PLAYER).alive).toBe(true);
    for (let i = 0; i < RESPAWN.delayTicks + 120; i++) world.step();
    const st = world.playerStats(DUMMY_PLAYER);
    expect(st.alive).toBe(true);
    expect(st.health).toBe(HEALTH.max);
    expect(world.player(DUMMY_PLAYER).limp).toBe(false);
    expect(world.player(DUMMY_PLAYER).down).toBe(false);
    expect(world.playerStats(LOCAL_PLAYER).kills).toBe(1);
    expect(st.deaths).toBe(1);
    expect(logs.filter((l) => l.lvl === 'error')).toEqual([]);
  });
});

describe('bad input', () => {
  it('NaN or out-of-range aims never create an arrow or reach the ragdoll', () => {
    const { world, logs } = makeWorld(10);
    expect(world.fire(LOCAL_PLAYER, { angle: NaN }).arrow).toBeNull();
    expect(world.fire(LOCAL_PLAYER, { angle: -Infinity }).arrow).toBeNull();
    expect(world.previewShot(LOCAL_PLAYER, { angle: Infinity }).points).toEqual([]);
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, aim: { angle: NaN }, move: 7 as never });
    for (let i = 0; i < 30; i++) world.step();
    expect(world.arrows).toEqual([]);
    expect(logs.some((l) => l.ev === 'walk_start')).toBe(false); // move: 7 was treated as standing still
    expect(logs.some((l) => l.ev === 'shot_blocked' && l.reason === 'invalid_aim')).toBe(true);
    expect(logs.some((l) => l.ev === 'invalid_controls')).toBe(true);
  });
});

describe('apples', () => {
  it('red apple: +30 health (capped), used up, back after 10 s', () => {
    const { world, logs } = makeWorld(30);
    const st = world.playerStats(LOCAL_PLAYER);
    st.health = 90;
    const arrow = shoot(world, aimAt(world, 'apple:red'));
    expect(arrow.state).toBe('gone'); // the bullet is used up
    expect(st.health).toBe(HEALTH.max);
    expect(logs.find((l) => l.ev === 'apple_hit')?.gained).toBe(10);
    const label = world.apples.find((a) => a.kind === 'red')!.label;
    expect(world.outlines().some((o) => o.label === label)).toBe(false);
    for (let i = 0; i < 605; i++) world.step();
    expect(world.outlines().some((o) => o.label === label)).toBe(true);
  });
});

describe('walking', () => {
  it('reaches full speed upright, keeps it while aiming (L2), stops without sliding back', () => {
    const { world, logs } = makeWorld();
    const p = () => world.player(LOCAL_PLAYER);
    // (p1 starts 8 m from the Backyard's thin wall: at the L2 speed, short runs)
    hold(world, { move: 1 }, 40);
    expect(p().speedX()).toBeGreaterThan(WALK.speed * 0.9);
    expect(GROUND_Y - p().parts.head.translation().y).toBeGreaterThan(1.8);
    hold(world, { move: 1, aim: { angle: deg(-20) } }, 30);
    expect(p().speedX()).toBeCloseTo(WALK.speed, 0);
    const x = p().center().x;
    // After a stop from aiming-while-walking the body sways back (up to ~0.5 m/s around 50 ticks) and settles
    // by ~120 ticks. Checking at 90 ticks only passed while the sway happened to be slow at that moment.
    hold(world, {}, 150);
    expect(Math.abs(p().center().x - x)).toBeLessThan(0.5);
    expect(Math.abs(p().speedX())).toBeLessThan(0.1);
    expect(p().down).toBe(false);
    expect(logs.filter((l) => l.lvl === 'warn' || l.lvl === 'error').filter((l) => l.ev !== 'slow_step')).toEqual([]);
  });

  it('turns to face the walking direction with no aim input', () => {
    const { world } = makeWorld();
    hold(world, { move: -1 }, 40);
    expect(world.player(LOCAL_PLAYER).facing).toBe(-1);
  });
});
