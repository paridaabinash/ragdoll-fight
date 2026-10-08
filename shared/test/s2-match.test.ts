import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARENA_SIZE,
  BACKYARD,
  BOT,
  BotBrain,
  botsWanted,
  buildArena,
  GameWorld,
  GUN,
  initPhysics,
  Logger,
  Match,
  NET,
  NO_CONTROLS,
  parseClientMessage,
  solveAim,
  TEST_LAB,
  type BotAction,
  type Controls,
  type LogEntry,
} from '../src';

beforeAll(() => initPhysics());

const SHORT = { lengthTicks: 600, killTarget: 2, resultsTicks: 60 };

function makeMatch(settings = SHORT) {
  const log: LogEntry[] = [];
  const match = new Match(new Logger('test', (e) => void log.push(e)), [BACKYARD, TEST_LAB], 2, settings);
  return { match, log };
}

describe('match loop', () => {
  it('ends when someone reaches the kill target: results, frozen world, no damage, winner named', () => {
    const { match, log } = makeMatch();
    match.join('a');
    match.join('b');
    match.step();
    match.world.playerStats('a').score = 2; // matches end on score (S7)
    expect(match.step()).toBe('ended');
    expect(match.info.phase).toBe('results');
    expect(match.info.result).toMatchObject({ reason: 'kills', winner: 'a' });
    expect(match.info.resultsUntil).toBe(match.world.tick + SHORT.resultsTicks);
    expect(match.world.frozen).toBe(true);
    expect(match.world.fire('b', { angle: 0 })).toEqual({ arrow: null, refused: 'match_over' });
    expect(log.find((e) => e.ev === 'shot_blocked')?.reason).toBe('match_over');
    expect(log.find((e) => e.ev === 'match_end')).toMatchObject({ match: 1, reason: 'kills', winner: 'a' });
    match.dispose();
  });

  it('ends when time runs out; a tie has no winner', () => {
    const { match } = makeMatch();
    match.join('a');
    match.join('b');
    let change = null;
    for (let i = 0; i < SHORT.lengthTicks + 1 && !change; i++) change = match.step();
    expect(change).toBe('ended');
    expect(match.info.result).toMatchObject({ reason: 'time', winner: null });
    match.dispose();
  });

  it('after the results: next arena in the rotation, same players and slots, scores reset, tick keeps counting', () => {
    const { match } = makeMatch();
    for (const id of ['a', 'b', 'c']) match.join(id);
    match.leave('b'); // a gap in the slots: c must keep slot 3, not take 2
    const slots = { a: match.world.slotOf('a'), c: match.world.slotOf('c') };
    match.world.fire('a', { angle: -0.4 });
    match.world.playerStats('a').score = 2; // matches end on score (S7)
    match.step();
    const endTick = match.world.tick;
    const old = match.world;
    let change = null;
    for (let i = 0; i < SHORT.resultsTicks + 1 && change !== 'new_world'; i++) change = match.step();
    expect(change).toBe('new_world');
    expect(match.world).not.toBe(old);
    expect(match.info).toMatchObject({ number: 2, phase: 'playing', arena: TEST_LAB.id, result: null });
    expect(match.info.size).toBe(2 < ARENA_SIZE.fullFromPlayers ? 'narrow' : 'full');
    expect(match.info.startTick).toBe(endTick + SHORT.resultsTicks);
    expect(match.world.tick).toBe(match.info.startTick + 1);
    expect(match.world.frozen).toBe(false);
    expect(match.world.slotOf('a')).toBe(slots.a);
    expect(match.world.slotOf('c')).toBe(slots.c);
    expect(match.world.players.has('b')).toBe(false);
    expect(match.world.playerStats('a').kills).toBe(0);
    expect(match.world.arrows).toEqual([]);
    expect(match.info.next).toBe(BACKYARD.name);
    match.dispose();
  });

  it('players can join mid-match and during the results (they are in the next match too)', () => {
    const { match } = makeMatch();
    match.join('a');
    for (let i = 0; i < 30; i++) match.step();
    match.join('late');
    expect(match.world.players.has('late')).toBe(true);
    match.world.playerStats('a').score = 2; // matches end on score (S7)
    match.step();
    match.join('later');
    for (let i = 0; i < SHORT.resultsTicks + 1; i++) match.step();
    expect([...match.world.players.keys()].sort()).toEqual(['a', 'late', 'later']);
    match.dispose();
  });
});

describe('filler bots', () => {
  it(`fill the room to ${BOT.fillTo}, fewer as people join, none for an empty room`, () => {
    expect(botsWanted(0)).toBe(0);
    expect(botsWanted(1)).toBe(BOT.fillTo - 1);
    expect(botsWanted(BOT.fillTo - 1)).toBe(1);
    expect(botsWanted(BOT.fillTo)).toBe(0);
    expect(botsWanted(NET.maxPlayers)).toBe(0);
  });

  it('the aim solver lands on the target in open space (checked with the real preview)', () => {
    const world = new GameWorld(new Logger('test', () => {}));
    buildArena(world);
    world.addPlayer('a', { x: 4, y: 17 }, 1);
    world.addPlayer('b', { x: 29, y: 17 }, -1);
    for (let i = 0; i < 60; i++) world.step();
    const angle = solveAim(world.player('a').jointPos('shoulderFront'), world.player('b').center(), GUN.bulletSpeed, true)!;
    expect(world.previewShot('a', { angle }).hit?.label.startsWith('b:')).toBe(true);
    world.dispose();
  });

  it('a bot only sends valid messages, never fires before its reload (L3), and hits a standing target', () => {
    const log: LogEntry[] = [];
    const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
    buildArena(world);
    world.addPlayer('bot', { x: 15, y: 17 }, 1); // right of the thin wall: an open line to the target
    world.addPlayer('target', { x: 29, y: 17 }, -1);
    const brain = new BotBrain('bot', 42);
    // Same handling as the server room: the message check, then the world decides (reload, stamina).
    let controls: Controls = NO_CONTROLS;
    let seq = 0;
    const bad: string[] = [];
    const refused: string[] = [];
    let shots = 0;
    const handle = (a: BotAction) => {
      const msg = parseClientMessage(JSON.stringify({ ...a, seq: seq++ }));
      if ('error' in msg) return void bad.push(msg.error);
      if (msg.t === 'input') {
        controls = { aim: msg.aim === null ? null : { angle: msg.aim }, crouch: msg.crouch, jump: msg.jump, move: msg.move };
      } else if (msg.t === 'fire') {
        const res = world.fire('bot', { angle: msg.angle });
        if (res.arrow) shots++;
        else if (res.refused) refused.push(res.refused);
      }
    };
    for (let t = 0; t < 1500; t++) {
      for (const a of brain.think(world)) handle(a);
      world.setControls('bot', controls);
      world.step();
    }
    const hits = log.filter((e) => e.ev === 'damage' && e.by === 'bot').length + log.filter((e) => e.ev === 'damage_blocked' && e.by === 'bot').length;
    expect(bad).toEqual([]);
    expect(refused).toEqual([]); // never too soon, never with its arms down
    expect(shots).toBeGreaterThan(5);
    expect(hits).toBeGreaterThan(0);
    expect(log.some((e) => e.ev === 'bot_stuck')).toBe(false);
    world.dispose();
  });
});
