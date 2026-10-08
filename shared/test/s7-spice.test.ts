import { beforeAll, describe, expect, it } from 'vitest';
import {
  BACKYARD,
  BIG_HEAD,
  buildArena,
  captureSnapshot,
  countProgress,
  CROWN,
  decodeSnapshot,
  encodeSnapshot,
  GameWorld,
  GRAVITY_Y,
  GROUND_Y,
  initPhysics,
  isHat,
  Logger,
  Match,
  MODIFIER,
  MODIFIER_KINDS,
  modifierOn,
  newProgress,
  newTally,
  NO_CONTROLS,
  parseClientMessage,
  pickAwards,
  readProgress,
  sampleSnapshots,
  unlockedHats,
  type GameEvent,
  type LogEntry,
  type ModifierKind,
} from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

function arena(ids: string[]) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildArena(world);
  ids.forEach((id, i) => world.addPlayer(id, { x: 4 + i * 7, y: GROUND_Y }, 1));
  for (let i = 0; i < 30; i++) world.step();
  return { world, log };
}

/** `by` kills `id` (through the normal damage path), then the world takes a step. */
function kill(world: GameWorld, id: string, by: string): GameEvent[] {
  world.hurt(id, by, 1000, world.player(id).center());
  world.step();
  return world.takeEvents();
}

describe('score and the bounty crown', () => {
  it('a kill scores 1; the leader wears the crown; killing the crown holder scores 2 and takes it', () => {
    const { world, log } = arena(['a', 'b', 'c']);
    kill(world, 'b', 'a');
    expect(world.playerStats('a').score).toBe(1);
    expect(world.crown).toBe('a');
    world.step();
    const events = kill(world, 'a', 'c');
    expect(world.playerStats('c').score).toBe(CROWN.bonus);
    expect(world.crown).toBe('c');
    expect(events).toContainEqual(expect.objectContaining({ type: 'crown', id: 'c', from: 'a' }));
    expect(log.filter((e) => e.ev === 'crown_change').map((e) => e.to)).toEqual(['a', 'c']);
    world.dispose();
  });

  it(`no crown with fewer than ${CROWN.minPlayers} players`, () => {
    const { world } = arena(['a', 'b']);
    kill(world, 'b', 'a');
    expect(world.crown).toBeNull();
    world.dispose();
  });
});

describe('callouts', () => {
  it('REVENGE, DOUBLE KILL, SELF-OWN', () => {
    const { world } = arena(['a', 'b', 'c']);
    const kinds = (evs: GameEvent[]) => evs.filter((e) => e.type === 'callout').map((e) => (e as { kind: string }).kind);
    kill(world, 'a', 'b'); // b kills a
    for (let i = 0; i < 200; i++) world.step(); // a respawns
    expect(kinds(kill(world, 'b', 'a'))).toContain('revenge'); // a kills b back
    expect(kinds(kill(world, 'c', 'a'))).toContain('double_kill'); // and c right after
    for (let i = 0; i < 200; i++) world.step();
    expect(kinds(kill(world, 'a', 'a'))).toContain('self_own'); // own bomb
    expect(world.playerStats('a').kills).toBe(2); // the self-own counted for nobody
    world.dispose();
  });

  it('HUMBLED: hit while taunting', () => {
    const { world } = arena(['a', 'b']); // a at x 4, b at x 11
    world.setControls('b', { ...NO_CONTROLS, taunt: true });
    for (let i = 0; i < 30; i++) world.step();
    let aim = null;
    for (let d = 10; d >= -40 && !aim; d -= 0.25) {
      const a = { angle: (d * Math.PI) / 180 };
      if (world.previewShot('a', a).hit?.label === 'b:torso') aim = a;
    }
    const arrow = shoot(world, 'a', aim!);
    const evs: GameEvent[] = [];
    for (let i = 0; i < 100 && arrow.state === 'flying'; i++) {
      world.step();
      evs.push(...world.takeEvents());
    }
    expect(evs.filter((e) => e.type === 'callout').map((e) => (e as { kind: string }).kind)).toContain('humbled');
    world.dispose();
  });
});

describe('chaos rounds', () => {
  it('each one changes the world and puts everything back exactly when it ends', () => {
    const { world } = arena(['a', 'b']);
    const before = () => ({
      g: world.physics.gravity.y,
      share: world.gravityShare,
      head: world.headScale,
      mult: world.headMultiplier,
      forced: world.forcedKind,
      oiled: world.allOiled,
      modifier: world.modifier,
    });
    const normal = before();
    for (const kind of MODIFIER_KINDS) {
      world.setModifier(kind, true, 600);
      world.step();
      if (kind === 'moon') expect(world.physics.gravity.y).toBeCloseTo(GRAVITY_Y * MODIFIER.moonGravity, 6);
      if (kind === 'big_heads') expect(world.headMultiplier).toBe(BIG_HEAD.headMultiplier);
      if (kind === 'glove_only') expect(shoot(world, 'a', { angle: -0.5 }).kind).toBe('glove');
      if (kind === 'oil_floor') expect(world.player('a').mods.oiled).toBe(true);
      if (kind === 'balloons') expect(world.effects.get('a')!.has('balloon')).toBe(true);
      world.setModifier(kind, false);
      world.step();
      expect(before()).toEqual(normal);
    }
    world.dispose();
  });

  it('Moon Gravity: arrows fly in long slow arcs, and the preview is still exact', () => {
    const { world, log } = arena(['a']);
    world.setModifier('moon', true, 600);
    // a long lob that still lands inside the arena (L3: every shot is 32 m/s; many lobs leave it in Moon Gravity)
    let aim = { angle: 0 };
    for (let a = -0.2; a > -1.5; a -= 0.01) {
      const p = world.previewShot('a', { angle: a });
      if (p.hit && p.ticks > 60) {
        aim = { angle: a };
        break;
      }
    }
    const preview = world.previewShot('a', aim);
    expect(preview.hit).not.toBeNull();
    const a = shoot(world, 'a', aim);
    for (let i = 0; i < 600 && a.state === 'flying'; i++) world.step();
    const hit = log.find((e) => e.ev === 'arrow_hit' && e.id === a.id);
    expect(hit?.predErr).toBe(0);
    expect(hit?.predTickErr).toBe(0);
    expect(preview.ticks).toBeGreaterThan(60);
    world.dispose();
  });

  it('a match announces a round 3 s ahead, runs it, then ends it; clients see it in the match info', () => {
    const log: LogEntry[] = [];
    const match = new Match(new Logger('test', (e) => void log.push(e)), [BACKYARD], 2, {
      lengthTicks: 2000,
      killTarget: 99,
      resultsTicks: 60,
      modifierEveryTicks: 400,
      modifierTicks: 200,
    });
    match.join('a');
    match.join('b');
    const seen: { tick: number; kind: ModifierKind | null; on: boolean }[] = [];
    for (let i = 0; i < 700; i++) {
      match.step();
      const m = match.info.modifier;
      const last = seen.at(-1);
      const now = { tick: match.world.tick, kind: m?.kind ?? null, on: !!match.world.modifier };
      if (!last || last.kind !== now.kind || last.on !== now.on) seen.push(now);
    }
    const announce = log.find((e) => e.ev === 'modifier_announce')!;
    expect(Number(announce.tick)).toBe(400 - MODIFIER.announceTicks);
    expect(announce.start).toBe(400);
    // on from its start tick, exactly as the client's rule says
    const on = seen.find((s) => s.on)!;
    expect(on.tick).toBe(400);
    expect(modifierOn({ kind: on.kind!, announcedAt: 0, start: 400, end: 600 }, 400)).toBe(true);
    expect(seen.find((s, i) => i > 0 && !s.on && seen[i - 1].on)?.tick).toBe(600);
    expect(log.some((e) => e.lvl === 'error')).toBe(false);
    match.dispose();
  });
});

describe('awards, hats, network', () => {
  it('awards go to whoever has the most of each thing (nothing for zero)', () => {
    const t = new Map([
      ['a', { ...newTally(), splats: 3, longestShot: 22.5 }],
      ['b', { ...newTally(), splats: 1, selfOwns: 2, crownTicks: 600 }],
      ['c', newTally()],
    ]);
    const awards = pickAwards(t, ['a', 'b', 'c']);
    expect(awards).toEqual([
      { kind: 'most_splats', id: 'a', value: 3 },
      { kind: 'biggest_self_own', id: 'b', value: 2 },
      { kind: 'longest_shot', id: 'a', value: 22.5 },
      { kind: 'crown_holder', id: 'b', value: 10 },
    ]);
  });

  it('hats unlock from progress; the join message only takes real hats', () => {
    expect(unlockedHats(newProgress())).toEqual(['none', 'cap']);
    expect(unlockedHats({ ...newProgress(), pins: 10, wins: 3 })).toEqual(expect.arrayContaining(['viking', 'tophat']));
    expect(isHat('viking')).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: 'join', v: 9, name: 'x', hat: 'viking' }))).toMatchObject({ hat: 'viking' });
    expect(parseClientMessage(JSON.stringify({ t: 'join', v: 9, name: 'x', hat: '<script>' }))).toEqual({ error: 'bad_hat' });
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 1, aim: null, crouch: false, jump: false, move: 0, taunt: true }))).toMatchObject({ taunt: true });
  });

  it('snapshots carry score and the crown', () => {
    const { world } = arena(['a', 'b', 'c']);
    kill(world, 'b', 'a');
    const back = decodeSnapshot(encodeSnapshot(captureSnapshot(world, world.movableBodies())))!;
    const a = back.players.find((p) => p.slot === world.slotOf('a'))!;
    expect(a).toMatchObject({ score: 1, crown: true });
    expect(back.players.filter((p) => p.crown).length).toBe(1);
    world.dispose();
  });
});

describe('hat progress and replays (client helpers)', () => {
  it('counts my kills, ring-outs, pins, splats and self-owns, and nothing of anyone else', () => {
    const p = newProgress();
    const pos = { x: 0, y: 0 };
    const evs: GameEvent[] = [
      { type: 'death', id: 'b', killer: 'me', cause: 'arrow', pos },
      { type: 'death', id: 'b', killer: 'me', cause: 'pit', pos },
      { type: 'death', id: 'me', killer: 'b', cause: 'arrow', pos },
      { type: 'callout', kind: 'pinned', id: 'b', by: 'me', pos, size: 1 },
      { type: 'callout', kind: 'splat', id: 'b', by: 'me', pos, size: 1 },
      { type: 'callout', kind: 'splat', id: 'me', by: 'b', pos, size: 1 },
      { type: 'callout', kind: 'self_own', id: 'me', by: 'me', pos, size: 1 },
      { type: 'callout', kind: 'sniped', id: 'b', by: 'me', pos, size: 1 },
    ];
    const changed = evs.map((e) => countProgress(p, e, 'me'));
    expect(changed).toEqual([true, true, false, true, true, false, true, false]);
    expect(p).toEqual({ ...newProgress(), kills: 2, ringOuts: 1, pins: 1, splats: 1, selfOwns: 1 });
    // stored progress from the device is cleaned
    expect(readProgress({ kills: 3.7, pins: -1, wins: 'x', extra: 5 })).toEqual({ ...newProgress(), kills: 3 });
    expect(readProgress(null)).toEqual(newProgress());
  });

  it('a replay frame at any tick blends the saved snapshots around it', () => {
    const { world } = arena(['a']);
    const snaps = [];
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 3; k++) world.step();
      snaps.push(decodeSnapshot(encodeSnapshot(captureSnapshot(world, world.movableBodies())))!);
    }
    expect(sampleSnapshots([], 5)).toBeNull();
    expect(sampleSnapshots(snaps, 0)).toBe(snaps[0]);
    expect(sampleSnapshots(snaps, 1e9)).toBe(snaps[3]);
    expect(sampleSnapshots(snaps, snaps[1].tick)!.tick).toBe(snaps[1].tick);
    const mid = sampleSnapshots(snaps, snaps[1].tick + 1.5)!;
    expect(mid.tick).toBeCloseTo(snaps[1].tick + 1.5, 6);
    const y = (s: typeof mid) => s.players[0].parts[0].y;
    expect(y(mid)).toBeCloseTo((y(snaps[1]) + y(snaps[2])) / 2, 6);
    world.dispose();
  });
});

describe('point-blank shots (L2 regression)', () => {
  it('shooting your own balloon from inside arm\'s reach pops it (it used to stick, and ending the round then crashed)', () => {
    const { world, log } = arena(['a', 'b']);
    world.setModifier('balloons', true, 600);
    for (let i = 0; i < 20; i++) world.step();
    // an aim whose shot reaches a balloon at once (the arrow would leave the bow already inside it)
    let aim = null;
    for (let d = -40; d >= -140 && !aim; d -= 1) {
      const a = { angle: (d * Math.PI) / 180 };
      const pv = world.previewShot('a', a);
      if (pv.ticks === 0 && pv.hit?.label.startsWith('balloon:')) aim = a;
    }
    expect(aim).not.toBeNull();
    world.fire('a', aim!);
    world.step();
    expect(log.some((e) => e.ev === 'balloon_pop' && e.id === 'a')).toBe(true);
    world.setModifier('balloons', false);
    for (let i = 0; i < 30; i++) world.step(); // (used to crash here: an arrow stuck in a removed balloon)
    expect(log.some((e) => e.ev === 'arrow_on_removed_body')).toBe(false);
    world.dispose();
  });
});

describe('balloons never carry anyone out of the arena (L7)', () => {
  it('a balloon nobody pops floats up to the top edge and pops there; the player drops back alive', () => {
    const { world, log } = arena(['a', 'b']);
    world.specials.giveBalloon('a', 3000);
    for (let i = 0; i < 2400 && !log.some((e) => e.ev === 'balloon_pop'); i++) world.step();
    expect(log.find((e) => e.ev === 'balloon_pop')).toMatchObject({ id: 'a', reason: 'ceiling' });
    for (let i = 0; i < 300; i++) world.step();
    expect(world.playerStats('a').alive).toBe(true);
    expect(log.some((e) => e.ev === 'left_arena' || (e.ev === 'death' && e.cause === 'out_of_arena'))).toBe(false);
    world.dispose();
  });
});
