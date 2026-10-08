import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestLevel,
  captureSnapshot,
  CALLOUT,
  decodeSnapshot,
  DUMMY_PLAYER,
  EFFECT,
  EFFECT_BIT,
  EffectSet,
  encodeSnapshot,
  GameWorld,
  initPhysics,
  LOCAL_PLAYER,
  Logger,
  NO_CONTROLS,
  parseClientMessage,
  pickCallout,
  type Aim,
  type GameEvent,
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

/** An aim from p1 whose preview hits a p2 part matching `want` (middle of the first run of hitting angles). */
function aimAt(world: GameWorld, want: (label: string) => boolean): Aim {
  const run: number[] = [];
  for (let deg = 0; deg >= -89; deg -= 0.1) {
    const hit = world.previewShot(LOCAL_PLAYER, { angle: (deg * Math.PI) / 180 }).hit;
    if (hit && want(hit.label)) run.push(deg);
    else if (run.length) break;
  }
  if (run.length) return { angle: (run[Math.floor(run.length / 2)] * Math.PI) / 180 };
  throw new Error('no aim found');
}

function shootUntilDone(world: GameWorld, aim: Aim): GameEvent[] {
  const arrow = shoot(world, LOCAL_PLAYER, aim);
  const events: GameEvent[] = [];
  for (let i = 0; i < 200 && arrow.state === 'flying'; i++) {
    world.step();
    events.push(...world.takeEvents());
  }
  return events;
}

describe('effect rules', () => {
  it('one effect per zone: a second hit restarts it, it ends on time', () => {
    const set = new EffectSet();
    set.add('arm', 'armFrontUpper', 100);
    const { refreshed, effect } = set.add('arm', 'armFrontLower', 200);
    expect(refreshed).toBe(true);
    expect(set.all().length).toBe(1);
    expect(effect).toEqual({ kind: 'arm', part: 'armFrontLower', start: 200, end: 200 + EFFECT.hitTicks });
    expect(set.bits()).toBe(EFFECT_BIT.arm);
    expect(set.takeExpired(effect.end - 1)).toEqual([]);
    expect(set.takeExpired(effect.end).map((e) => e.kind)).toEqual(['arm']);
    expect(set.bits()).toBe(0);
  });

  it('callouts: sniped > cracked > airball > ankle breaker > point blank', () => {
    const far = CALLOUT.snipedFrom + 1;
    const mid = 10;
    const near = CALLOUT.pointBlankWithin - 1;
    expect(pickCallout({ zone: 'torso', distance: far, victimAirborne: false })).toBe('sniped');
    expect(pickCallout({ zone: 'head', distance: mid, victimAirborne: true })).toBe('cracked');
    expect(pickCallout({ zone: 'torso', distance: mid, victimAirborne: true })).toBe('airball');
    expect(pickCallout({ zone: 'leg', distance: near, victimAirborne: false })).toBe('ankle_breaker');
    expect(pickCallout({ zone: 'arm', distance: near, victimAirborne: false })).toBe('point_blank');
    expect(pickCallout({ zone: 'torso', distance: mid, victimAirborne: false })).toBeNull();
  });

  it("L7: an old client's swing tick is ignored (the gun never wobbles)", () => {
    expect(parseClientMessage(JSON.stringify({ t: 'fire', seq: 1, angle: 0, swing: 30 }))).toEqual({ t: 'fire', seq: 1, angle: 0 });
    expect(parseClientMessage(JSON.stringify({ t: 'fire', seq: 1, angle: 'x' }))).toEqual({ error: 'bad_fire' });
  });

});

describe('hit effects in the world', () => {
  it('a head hit starts a head effect + CRACKED, and the bullet is gone', () => {
    const { world, log } = makeWorld();
    world.setBigHeads(true); // (headshots do x2 instead of x5: one that doesn't kill)
    const events = shootUntilDone(world, aimAt(world, (l) => l === `${DUMMY_PLAYER}:head`));
    expect(world.playerStats(DUMMY_PLAYER).alive).toBe(true);
    expect(world.effects.get(DUMMY_PLAYER)!.get('head')).toBeDefined();
    expect(log.find((e) => e.ev === 'effect_start')).toMatchObject({ id: DUMMY_PLAYER, kind: 'head' });
    expect(events.find((e) => e.type === 'callout')).toMatchObject({ type: 'callout', kind: 'cracked', id: DUMMY_PLAYER, by: LOCAL_PLAYER });
    expect(world.arrows).toHaveLength(0);
    world.dispose();
  });

  it('an arm hit: nothing stays in the body, and the effect runs 5 s from the hit and ends on time', () => {
    const { world, log } = makeWorld();
    // L3: arms are always up holding the gun, so the dummy's gun arm sticks out toward p1
    world.setControls(DUMMY_PLAYER, { ...NO_CONTROLS, aim: { angle: Math.PI } });
    for (let i = 0; i < 40; i++) world.step();
    shootUntilDone(world, aimAt(world, (l) => l.startsWith(`${DUMMY_PLAYER}:arm`)));
    const effect = world.effects.get(DUMMY_PLAYER)!.get('arm')!;
    expect(effect).toBeDefined();
    expect(effect.end - effect.start).toBe(EFFECT.hitTicks);
    expect(world.arrows).toHaveLength(0);
    while (world.tick <= effect.end) world.step();
    expect(world.effects.get(DUMMY_PLAYER)!.has('arm')).toBe(false);
    expect(log.find((e) => e.ev === 'effect_end')).toMatchObject({ kind: 'arm', reason: 'time', ticks: EFFECT.hitTicks });
    world.dispose();
  });

  it('L7: an arm hit never moves the aim: the bullet goes exactly where you aim, as the preview said', () => {
    const { world, log } = makeWorld();
    world.effects.get(LOCAL_PLAYER)!.add('arm', 'armFrontUpper', world.tick);
    const aim = { angle: 0.35 }; // down into the ground, a fixed target
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, aim });
    for (let i = 0; i < 37; i++) world.step();
    const preview = world.previewShot(LOCAL_PLAYER, aim);
    const arrow = shoot(world, LOCAL_PLAYER, aim);
    expect(arrow.angle).toBeCloseTo(aim.angle, 9);
    for (let i = 0; i < 200 && arrow.state === 'flying'; i++) world.step();
    const hit = log.find((e) => e.ev === 'arrow_hit' && e.id === arrow.id);
    expect(hit?.predErr).toBe(0);
    expect(hit?.predTickErr).toBe(0);
    expect(preview.hit?.label).toBe(hit?.target);
    world.dispose();
  });

  it('effects end with death (no effect on a dead player)', () => {
    const { world, log } = makeWorld();
    // L3: at 32 m/s the thin wall hides p2's legs from p1's spot: step past it first
    world.relocate(LOCAL_PLAYER, { x: 18, y: 17 }, 1);
    for (let i = 0; i < 60; i++) world.step();
    // (L4: a leg hit climbs the lasting leg ladder; the head and arms still get short effects)
    world.effects.get(DUMMY_PLAYER)!.add('arm', 'armFrontUpper', world.tick);
    for (let i = 0; i < 30; i++) world.step();
    shootUntilDone(world, aimAt(world, (l) => l === `${DUMMY_PLAYER}:head`)); // headshot: dead
    expect(log.findLast((e) => e.ev === 'arrow_hit')?.target).toBe(`${DUMMY_PLAYER}:head`);
    expect(world.playerStats(DUMMY_PLAYER).alive).toBe(false);
    expect(world.effects.get(DUMMY_PLAYER)!.all()).toEqual([]);
    expect(log.find((e) => e.ev === 'effect_end' && e.reason === 'death')).toMatchObject({ id: DUMMY_PLAYER, kind: 'arm' });
    for (let i = 0; i < 30; i++) world.step();
    expect(log.some((e) => e.lvl === 'error' && e.ev === 'effect_on_dead')).toBe(false);
    world.dispose();
  });

  it('snapshots carry effect bits and stuck rounds (a bomb)', () => {
    const { world } = makeWorld();
    world.effects.get(DUMMY_PLAYER)!.add('head', 'head', world.tick);
    world.effects.get(DUMMY_PLAYER)!.add('arm', 'armBackUpper', world.tick);
    const snap = captureSnapshot(world, world.movableBodies());
    snap.arrows.push({ id: 7, ownerSlot: 1, stuck: true, kind: 'bomb', pose: { x: 1, y: 2, a: 0 } });
    const back = decodeSnapshot(encodeSnapshot(snap))!;
    const p2 = back.players.find((p) => p.slot === world.slotOf(DUMMY_PLAYER))!;
    expect(p2.fx).toBe(EFFECT_BIT.head | EFFECT_BIT.arm);
    expect(back.arrows.find((a) => a.id === 7)).toMatchObject({ stuck: true, kind: 'bomb' });
    world.dispose();
  });

  it('the world turns effects and damage into body changes; a dragging leg still jumps normally (no misfire)', () => {
    const { world, log } = makeWorld();
    const fx = world.effects.get(LOCAL_PLAYER)!;
    fx.add('head', 'head', world.tick);
    world.bodyHit(LOCAL_PLAYER, 'legFrontLower', 1, 'test'); // L4: 1st leg hit: a trip
    for (let i = 0; i < 150; i++) world.step();
    fx.add('head', 'head', world.tick);
    world.bodyHit(LOCAL_PLAYER, 'legBackLower', 1, 'test'); // 2nd: the FIRST leg hit drags
    world.step();
    expect(world.player(LOCAL_PLAYER).mods).toEqual({ headHeavy: true, armFlail: false, dragLeg: 'front', oiled: false, laughing: false, floatLeg: null, beltSpeed: 0, pinned: false, armsDown: false, swing: null, limpArms: [], fast: false });
    for (let i = 0; i < 60; i++) world.step();
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true });
    world.step();
    for (let i = 0; i < 90; i++) world.step();
    expect(log.some((e) => e.ev === 'jump' && e.id === LOCAL_PLAYER)).toBe(true);
    expect(log.some((e) => e.ev === 'jump_misfire')).toBe(false);
    expect(world.player(LOCAL_PLAYER).down).toBe(false);
    world.dispose();
  });

  it('no effects = the normal body (no mods)', () => {
    const { world } = makeWorld();
    world.step();
    expect(world.player(DUMMY_PLAYER).mods).toEqual({ headHeavy: false, armFlail: false, dragLeg: null, oiled: false, laughing: false, floatLeg: null, beltSpeed: 0, pinned: false, armsDown: false, swing: null, limpArms: [], fast: false });
    world.dispose();
  });
});
