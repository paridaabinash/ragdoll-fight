import { beforeAll, describe, expect, it } from 'vitest';
import { GameRoom, type Conn } from '../../server/src/room';
import {
  BACKYARD,
  CROWN,
  DEFAULT_ROOM_SETTINGS,
  initPhysics,
  Logger,
  Match,
  MODES,
  MODIFIER,
  RESPAWN,
  ROUND,
  type GameMode,
  type LogEntry,
} from '../src';

beforeAll(() => initPhysics());

const SETTINGS = { lengthTicks: 60 * 60 * 3, resultsTicks: 60 };

function makeMatch(mode: GameMode, players = ['a', 'b']) {
  const log: LogEntry[] = [];
  const match = new Match(new Logger('test', (e) => void log.push(e)), [BACKYARD], players.length, SETTINGS, { mode });
  for (const p of players) match.join(p);
  match.step();
  return { match, log };
}

/** `killer` kills `victim` (shield off first). */
function kill(match: Match, victim: string, killer: string): void {
  const w = match.world;
  w.playerStats(victim).endProtection(w.tick);
  w.hurt(victim, killer, 9999, w.player(victim).center());
}

function steps(match: Match, n: number): void {
  for (let i = 0; i < n; i++) match.step();
}

describe('M3 game modes', () => {
  it('every mode sets up its world: crown rule, respawns, weapon, power-ups', () => {
    for (const mode of Object.keys(MODES) as GameMode[]) {
      const { match } = makeMatch(mode);
      const r = MODES[mode];
      expect(match.world.crownRule).toBe(r.crown);
      expect(match.world.respawns).toBe(r.respawn);
      expect(match.world.startWeapon).toBe(r.weapon);
      expect(match.world.specials.bubbles.length > 0).toBe(r.pickups);
      expect(match.info.killTarget).toBe(r.target);
      expect(match.info.mode).toBe(mode);
      expect(match.info.round !== null).toBe(r.rounds);
      expect(match.info.teamScores !== null).toBe(r.teams);
      match.dispose();
    }
  });

  it('Crown Keeper: a kill takes the free crown, the holder scores 1 a second, killing them takes it, kills score nothing', () => {
    const { match, log } = makeMatch('crown');
    const w = match.world;
    expect(w.crown).toBeNull();
    kill(match, 'b', 'a');
    expect(w.crown).toBe('a');
    expect(w.playerStats('a').score).toBe(0); // (the kill itself: nothing)
    steps(match, CROWN.keeperTicksPerPoint * 3);
    expect(w.playerStats('a').score).toBe(3);
    steps(match, RESPAWN.delayTicks + 10); // b is back
    kill(match, 'a', 'b');
    expect(w.crown).toBe('b');
    expect(log.filter((e) => e.ev === 'crown_change').map((e) => e.why)).toEqual(['free crown', 'took it']);
    // the holder dying with nobody to credit drops it
    w.playerStats('b').endProtection(w.tick);
    w.hurt('b', 'b', 9999, w.player('b').center()); // (their own bomb)
    expect(w.crown).toBeNull();
    match.dispose();
  });

  it('Crown Keeper: the match ends when the holder reaches the target', () => {
    const { match } = makeMatch('crown');
    kill(match, 'b', 'a');
    let ended = false;
    for (let i = 0; i < CROWN.keeperTicksPerPoint * (MODES.crown.target + 1) && !ended; i++) ended = match.step() === 'ended';
    expect(ended).toBe(true);
    expect(match.info.result).toMatchObject({ reason: 'kills', winner: 'a' });
    match.dispose();
  });

  it('Last Standing: no respawns in a round; the last one alive wins it; then everyone comes back', () => {
    const { match, log } = makeMatch('last_standing', ['a', 'b', 'c']);
    const w = match.world;
    kill(match, 'b', 'a');
    steps(match, RESPAWN.delayTicks + 30);
    expect(w.playerStats('b').alive).toBe(false); // no respawn
    expect(match.info.round).toMatchObject({ number: 1, phase: 'fighting' });
    kill(match, 'c', 'a');
    expect(match.step()).toBe('round');
    expect(match.info.round).toMatchObject({ number: 1, phase: 'over', winner: 'a' });
    expect(w.playerStats('a').score).toBe(1);
    steps(match, ROUND.pauseTicks);
    expect(match.info.round).toMatchObject({ number: 2, phase: 'fighting' });
    expect(['a', 'b', 'c'].every((id) => match.world.playerStats(id).alive)).toBe(true);
    expect(log.filter((e) => e.ev === 'round_end')[0]).toMatchObject({ round: 1, winner: 'a', why: 'last_alive' });
    match.dispose();
  });

  it('Last Standing: a round that runs out of time goes to the most health left (a tie: nobody)', () => {
    const { match, log } = makeMatch('last_standing', ['a', 'b', 'c']);
    const w = match.world;
    w.playerStats('a').endProtection(w.tick);
    w.hurt('a', 'b', 30, w.player('a').center());
    w.playerStats('c').endProtection(w.tick);
    w.hurt('c', 'b', 10, w.player('c').center());
    steps(match, ROUND.maxTicks);
    expect(match.info.round).toMatchObject({ number: 1, phase: 'over', winner: 'b' });
    expect(log.find((e) => e.ev === 'round_end')).toMatchObject({ why: 'time_health', winner: 'b' });
    steps(match, ROUND.pauseTicks);
    steps(match, ROUND.maxTicks); // all full health: a tie
    expect(match.info.round).toMatchObject({ number: 2, phase: 'over', winner: null });
    match.dispose();
  });

  it('Last Standing: first to the target in round wins ends the match', () => {
    const { match } = makeMatch('last_standing');
    for (let round = 0; round < MODES.last_standing.target; round++) {
      kill(match, 'b', 'a');
      const change = match.step();
      if (round < MODES.last_standing.target - 1) {
        expect(change).toBe('round');
        steps(match, ROUND.pauseTicks);
      } else expect(change).toBe('ended');
    }
    expect(match.info.result).toMatchObject({ winner: 'a' });
    match.dispose();
  });

  it('Melee Mayhem: everyone holds a bat or a mace from the start and after respawning; a click swings', () => {
    const { match } = makeMatch('melee');
    const w = match.world;
    for (const id of ['a', 'b']) expect(['bat', 'mace']).toContain(w.melee.weaponOf(id));
    expect(w.fire('a', { angle: 0 })).toEqual({ arrow: null, swing: true });
    kill(match, 'b', 'a');
    steps(match, RESPAWN.delayTicks + 5);
    expect(w.playerStats('b').alive).toBe(true);
    expect(['bat', 'mace']).toContain(w.melee.weaponOf('b'));
    match.dispose();
  });

  it('Chaos: a chaos round is announced within the first 25 s, and never a glove round in Melee Mayhem', () => {
    const { match, log } = makeMatch('chaos');
    const every = Math.round(MODIFIER.everyTicks * MODES.chaos.chaosEvery);
    steps(match, every);
    expect(match.info.modifier).not.toBeNull();
    expect(log.some((e) => e.ev === 'modifier_announce')).toBe(true);
    match.dispose();
    const melee = makeMatch('melee');
    for (let i = 0; i < 5; i++) steps(melee.match, MODIFIER.everyTicks);
    expect(melee.log.filter((e) => e.ev === 'modifier_announce').map((e) => e.kind)).not.toContain('glove_only');
    melee.match.dispose();
  });

  it('Team Battle: players are split evenly; teammates can\'t hurt each other; kills count for the team; the team wins', () => {
    const { match, log } = makeMatch('teams', ['a', 'b', 'c', 'd']);
    const w = match.world;
    expect(match.teamCounts()).toEqual([2, 2]);
    const red = ['a', 'b', 'c', 'd'].filter((id) => match.teamOf(id) === 0);
    const blue = ['a', 'b', 'c', 'd'].filter((id) => match.teamOf(id) === 1);
    w.playerStats(red[1]).endProtection(w.tick);
    w.hurt(red[1], red[0], 50, w.player(red[1]).center());
    expect(w.playerStats(red[1]).health).toBe(100);
    expect(log.find((e) => e.ev === 'damage_blocked')).toMatchObject({ reason: 'teammate' });
    kill(match, blue[0], red[0]);
    match.step();
    expect(match.info.teamScores).toEqual([1, 0]);
    w.teamScores[0] = MODES.teams.target;
    expect(match.step()).toBe('ended');
    expect(match.info.result).toMatchObject({ winnerTeam: 0 });
    expect(red).toContain(match.info.result!.winner);
    match.dispose();
  });

  it('Team Battle: a bullet that meets a teammate stops there and does nothing', () => {
    const { match, log } = makeMatch('teams', ['a', 'b', 'c']);
    const w = match.world;
    const [shooter, mate] = ['a', 'b', 'c'].filter((id) => match.teamOf(id) === 0);
    w.relocate(shooter, { x: 6, y: 17 }, 1);
    w.relocate(mate, { x: 8.5, y: 17 }, 1);
    steps(match, 60);
    w.playerStats(mate).endProtection(w.tick);
    w.playerStats(shooter).endProtection(w.tick);
    const shot = w.fire(shooter, { angle: -0.02 });
    expect(shot.arrow).not.toBeNull();
    steps(match, 20);
    expect(log.some((e) => e.ev === 'damage_blocked' && e.reason === 'teammate' && e.id === mate)).toBe(true);
    expect(w.playerStats(mate).health).toBe(100);
    match.dispose();
  });

  it('Team Battle in a room: one person and three bots make 2 v 2; bots don\'t aim at teammates', () => {
    const log: LogEntry[] = [];
    const conn: Conn = { send() {}, close() {}, bufferedAmount: 0 };
    const r = new GameRoom('TEAM', (e) => void log.push(e), () => {}, { rotation: [BACKYARD], settings: { ...DEFAULT_ROOM_SETTINGS, mode: 'teams', arenas: 'rotation' } });
    r.join(conn, 'ann');
    expect(r.match.teamCounts()).toEqual([2, 2]);
    r.join(conn, 'bob');
    expect(r.match.teamCounts()).toEqual([2, 2]); // a bot left the bigger team
    for (let i = 0; i < 60 * 20; i++) r.tick();
    for (const e of log.filter((x) => x.ev === 'bot_fire')) expect(r.match.teamOf(String(e.id))).not.toBe(r.match.teamOf(String(e.target)));
    r.close();
  });
});
