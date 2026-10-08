import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildArena,
  captureSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  GameWorld,
  GROUND_Y,
  initPhysics,
  LOCAL_PLAYER,
  Logger,
  NO_CONTROLS,
  parseClientMessage,
  PICKUP,
  PIN,
  SPECIAL,
  type Aim,
  type GameEvent,
  type LogEntry,
  type SpecialKind,
} from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

/** Backyard: p1 at `from`, victim 'v' at `at` (walls at 0 and 32, thin wall at 12). */
function duel(from: number, at: number) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildArena(world);
  world.addPlayer(LOCAL_PLAYER, { x: from, y: GROUND_Y }, from < at ? 1 : -1);
  world.addPlayer('v', { x: at, y: GROUND_Y }, from < at ? -1 : 1);
  for (let i = 0; i < 60; i++) world.step();
  return { world, log };
}

/** An aim (either side, slightly down to steep up) whose preview hits a label that passes `want`. */
function aimAt(world: GameWorld, want: (l: string) => boolean): Aim {
  for (const side of [1, -1]) {
    const hits: number[] = [];
    for (let d = 30; d >= -89; d -= 0.1) {
      const angle = side === 1 ? (d * Math.PI) / 180 : -Math.PI - (d * Math.PI) / 180;
      const hit = world.previewShot(LOCAL_PLAYER, { angle }).hit;
      if (hit && want(hit.label)) hits.push(angle);
      else if (hits.length) break;
    }
    if (hits.length) return { angle: hits[Math.floor(hits.length / 2)] };
  }
  throw new Error('no aim');
}

/** Fires (ready gun) and steps until the bullet is done; returns the events on the way. */
function shootFlight(world: GameWorld, aim: Aim): GameEvent[] {
  const events: GameEvent[] = [];
  const a = shoot(world, LOCAL_PLAYER, aim);
  for (let i = 0; i < 300 && a.state === 'flying'; i++) {
    world.step();
    events.push(...world.takeEvents());
  }
  return events;
}

function special(world: GameWorld, kind: SpecialKind, want: (l: string) => boolean): GameEvent[] {
  world.playerStats(LOCAL_PLAYER).held = kind;
  return shootFlight(world, aimAt(world, want));
}

describe('power-up bubbles', () => {
  it('shoot the bubble: you hold its arrow, the next shot is that arrow, the bubble comes back with a new one', () => {
    const { world, log } = duel(8, 29);
    world.specials.setOrder(['oil', 'swap']);
    const events = shootFlight(world, aimAt(world, (l) => l.startsWith('bubble:')));
    expect(events).toContainEqual(expect.objectContaining({ type: 'pickup', kind: 'oil', by: LOCAL_PLAYER }));
    expect(world.playerStats(LOCAL_PLAYER).held).toBe('oil');
    const bubble = world.specials.bubbles[0];
    expect(bubble.collider.isEnabled()).toBe(false);
    const arrow = shoot(world, LOCAL_PLAYER, { angle: 0.3 });
    expect(arrow.kind).toBe('oil');
    expect(world.playerStats(LOCAL_PLAYER).held).toBeNull();
    for (let i = 0; i < PICKUP.respawnTicks + 1; i++) world.step();
    expect(bubble.collider.isEnabled()).toBe(true);
    expect(bubble.kind).toBe('swap');
    expect(log.filter((e) => e.ev === 'pickup_spawn').map((e) => e.kind).slice(-2)).toEqual(['oil', 'swap']);
    world.dispose();
  });

  it('a held arrow is lost on death', () => {
    const { world, log } = duel(14, 22);
    world.playerStats('v').held = 'bomb';
    world.playerStats(LOCAL_PLAYER).held = null;
    shootFlight(world, aimAt(world, (l) => l === 'v:head')); // headshot
    expect(world.playerStats('v').alive).toBe(false);
    expect(world.playerStats('v').held).toBeNull();
    expect(log.find((e) => e.ev === 'held_lost')).toMatchObject({ id: 'v', kind: 'bomb' });
    world.dispose();
  });

  it('a client cannot claim a special round: the fire message has no such field, the server uses what you hold', () => {
    const msg = parseClientMessage(JSON.stringify({ t: 'fire', seq: 1, angle: 0, special: 'glove', kind: 'glove' }));
    expect(msg).toEqual({ t: 'fire', seq: 1, angle: 0 });
    const { world } = duel(14, 22);
    expect(shoot(world, LOCAL_PLAYER, { angle: 0 }).kind).toBe('normal');
    world.dispose();
  });
});

describe('special arrows', () => {
  it('boxing glove: a little damage (L4) and a dent; the hit counts as the last hit (a ring-out after it credits the shooter)', () => {
    // (that the last hitter gets a pit kill is tested in s1-arena.test.ts; a glove often launches people right over
    // a gap, so a real flight into the pit isn't a reliable test)
    const { world, log } = duel(14, 29);
    const events = special(world, 'glove', (l) => l === 'v:torso');
    for (let i = 0; i < 60; i++) {
      world.step();
      events.push(...world.takeEvents());
    }
    expect(events).toContainEqual(expect.objectContaining({ type: 'callout', kind: 'outta_here', id: 'v', by: LOCAL_PLAYER }));
    expect(log.find((e) => e.ev === 'damage' && e.id === 'v')?.amount).toBe(Math.round(20 * SPECIAL.damageShare.glove));
    expect(world.playerStats('v').health).toBe(100 - Math.round(20 * SPECIAL.damageShare.glove));
    expect([...world.damage.get('v')!.dents]).toEqual(['torso']); // dented in the shape of a fist
    expect(log.find((e) => e.ev === 'dent')).toMatchObject({ who: 'v', part: 'torso', by: LOCAL_PLAYER });
    expect(world.playerStats('v').lastHit?.by).toBe(LOCAL_PLAYER);
    expect(events).toContainEqual(expect.objectContaining({ type: 'wall_splat', id: 'v' })); // flew into the right wall
    world.dispose();
  });

  it('oil: a puddle on the floor under the hit; feet in it are oiled; it dries up', () => {
    const { world } = duel(14, 22);
    special(world, 'oil', (l) => l.startsWith('v:leg'));
    const puddle = world.specials.props().find((p) => p.type === 'puddle')!;
    expect(puddle.y).toBeCloseTo(GROUND_Y, 1);
    expect(Math.abs(puddle.x - 22)).toBeLessThan(1);
    world.step();
    expect(world.player('v').mods.oiled).toBe(true);
    for (let i = 0; i < SPECIAL.oil.ticks; i++) world.step();
    expect(world.specials.props().some((p) => p.type === 'puddle')).toBe(false);
    world.dispose();
  });

  it('feather: no damage; the victim cannot aim or shoot while laughing', () => {
    const { world } = duel(14, 22);
    special(world, 'feather', (l) => l === 'v:torso');
    world.setControls('v', { ...NO_CONTROLS, aim: { angle: Math.PI } });
    world.step();
    expect(world.player('v').mods.armsDown).toBe(true); // L3: the arms drop (they flail)
    expect(world.player('v').mods.laughing).toBe(true);
    expect(world.fire('v', { angle: Math.PI }).refused).toBe('laughing');
    expect(world.playerStats('v').health).toBe(100);
    world.dispose();
  });

  it('swap: shooter and victim trade places', () => {
    const { world } = duel(14, 28);
    special(world, 'swap', (l) => l === 'v:torso');
    expect(Math.abs(world.player(LOCAL_PLAYER).center().x - 28)).toBeLessThan(0.6);
    expect(Math.abs(world.player('v').center().x - 14)).toBeLessThan(0.6);
    world.dispose();
  });

  it('sticky bomb: sticks, goes off after the fuse, pushes and hurts everyone near', () => {
    const { world, log } = duel(14, 22);
    world.addPlayer('w', { x: 24.5, y: GROUND_Y }, -1);
    const events = special(world, 'bomb', (l) => l === 'v:torso');
    // L3: the one round that stays (an object): stuck on the victim until it goes off
    expect(world.arrows.filter((a) => a.state === 'stuck').map((a) => a.kind)).toEqual(['bomb']);
    for (let i = 0; i < SPECIAL.bomb.fuseTicks + 2; i++) {
      world.step();
      events.push(...world.takeEvents());
    }
    expect(events).toContainEqual(expect.objectContaining({ type: 'explosion' }));
    expect(log.find((e) => e.ev === 'bomb_explode')?.players).toBeGreaterThanOrEqual(2);
    expect(world.playerStats('v').health).toBeLessThan(100);
    expect(world.arrows).toHaveLength(0);
    world.dispose();
  });

  it('banana: the shot splits into three pieces after the split tick', () => {
    const { world, log } = duel(14, 29);
    world.playerStats(LOCAL_PLAYER).held = 'banana';
    const preview = world.previewShot(LOCAL_PLAYER, { angle: -0.2 });
    expect(preview.branches?.length).toBe(2);
    const a = shoot(world, LOCAL_PLAYER, { angle: -0.2 });
    for (let i = 0; i < SPECIAL.banana.splitTicks + 1; i++) world.step();
    expect(log.filter((e) => e.ev === 'fire' && e.of === a.id).length).toBe(2);
    expect(a.kind).toBe('normal');
    world.dispose();
  });
});

describe('wall pins', () => {
  function pinned() {
    const log: LogEntry[] = [];
    const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
    buildArena(world);
    world.addPlayer(LOCAL_PLAYER, { x: 18, y: GROUND_Y }, -1);
    world.addPlayer('v', { x: 12.45, y: GROUND_Y }, 1); // back against the thin wall
    for (let i = 0; i < 60; i++) world.step();
    const events = shootFlight(world, aimAt(world, (l) => l.startsWith('v:leg')));
    return { world, log, events };
  }

  it('a leg shot with a wall right behind it nails the leg there for 2 s (PINNED!), from the hit itself', () => {
    const { world, log, events } = pinned();
    const start = log.find((e) => e.ev === 'pin_start')!;
    expect(start).toBeDefined();
    // L3: the bullet is gone; the limb is held against a bullet hole in the wall (an impact there)
    expect(world.arrows).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'impact', on: 'wall' }));
    expect(world.effects.get('v')!.has('pinned')).toBe(true);
    for (let i = 0; i < PIN.ticks + 2; i++) world.step();
    expect(log.find((e) => e.ev === 'pin_end')).toMatchObject({ reason: 'time' });
    expect(world.effects.get('v')!.has('pinned')).toBe(false);
    world.dispose();
  });

  it('each jump press shortens it, and a pinned player does not jump', () => {
    const { world, log } = pinned();
    const until = world.effects.get('v')!.get('pinned')!.end;
    for (let i = 0; i < 4; i++) {
      world.setControls('v', { ...NO_CONTROLS, jump: true });
      world.step();
      world.setControls('v', NO_CONTROLS);
      world.step();
    }
    expect(world.effects.get('v')!.get('pinned')!.end).toBe(until - 4 * PIN.mashTicks);
    expect(log.filter((e) => e.ev === 'jump' && e.id === 'v').length).toBe(0);
    world.dispose();
  });

  it('the pin is removed with the body (respawn), so nothing is left joined to the wall', () => {
    const { world, log } = pinned();
    world.playerStats('v').takeDamage(1000, LOCAL_PLAYER, world.tick); // (dies on the next hit check; force it:)
    shootFlight(world, aimAt(world, (l) => l.startsWith('v:')));
    for (let i = 0; i < 200; i++) world.step();
    expect(log.some((e) => e.ev === 'pin_end')).toBe(true);
    expect(log.filter((e) => e.lvl === 'error')).toEqual([]);
    world.dispose();
  });
});

describe('snapshot', () => {
  it('carries held rounds, bubble contents, round kinds and props', () => {
    const { world } = duel(14, 22);
    world.specials.setOrder(['plunger']);
    world.playerStats('v').held = 'feather';
    special(world, 'oil', (l) => l.startsWith('v:leg'));
    world.playerStats(LOCAL_PLAYER).held = 'glove';
    shoot(world, LOCAL_PLAYER, { angle: -1.2 });
    world.step();
    const snap = captureSnapshot(world, world.movableBodies());
    const back = decodeSnapshot(encodeSnapshot(snap))!;
    expect(back.players.find((p) => p.slot === world.slotOf('v'))!.held).toBe('feather');
    expect(back.bodies.some((b) => b.holds === 'plunger')).toBe(true);
    expect(back.arrows.some((a) => a.kind === 'glove')).toBe(true);
    expect(back.props.find((p) => p.type === 'puddle')).toMatchObject({ a: SPECIAL.oil.width * 10 });
    world.dispose();
  });
});
