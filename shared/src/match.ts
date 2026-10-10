import { arenaLayout, arenaSizeFor, type ArenaDef, type ArenaSize } from './arena';
import { MODIFIER, ROOM, ROUND } from './constants';
import { modifierOrder, type Award, type BestMoment, type ModifierInfo } from './spice';
import { buildArena } from './level';
import type { Logger } from './log';
import { seededRandom } from './bot';
import { MODES, type ModeRules, type Team } from './modes';
import type { ArenaChoice, GameMode } from './room-settings';
import { GameWorld } from './world';

export interface MatchSettings {
  lengthTicks: number;
  /** Score target override (tests, sims); default: the mode's target (`MODES`). */
  killTarget?: number;
  resultsTicks: number;
  /** Chaos rounds (S7): one every `everyTicks`, lasting `ticks` (defaults: MODIFIER; the mode scales them). 0 = none. */
  modifierEveryTicks?: number;
  modifierTicks?: number;
}

/** M2/M3: what a room plays: the mode, how arenas are picked, which one first, and the seed for random picks. */
export interface MatchRules {
  mode?: GameMode;
  arenas?: ArenaChoice;
  /** First arena (and the only one for `one`); null/missing: the first of the rotation, or random. */
  first?: string | null;
  seed?: number;
}

export type MatchPhase = 'playing' | 'results';

export interface MatchScore {
  id: string;
  /** 1 per kill, more for killing the crown holder (S7); crown seconds (Crown Keeper); round wins (Last Standing). */
  score: number;
  kills: number;
  deaths: number;
}

export interface MatchResult {
  /** `kills`: someone reached the target (whatever the mode counts); `time`: the clock ran out. */
  reason: 'kills' | 'time';
  /** Highest score (more kills, then fewer deaths break a tie); null if still tied. Team Battle: the winning team's best. */
  winner: string | null;
  /** M3 Team Battle: the winning team (null: a draw, or not a team match). */
  winnerTeam: Team | null;
  /** Best first. */
  scores: MatchScore[];
  /** Fun awards (S7). */
  awards: Award[];
  /** The most exciting moment, replayed on the results screen (null if nothing happened). */
  best: BestMoment | null;
}

/** M2: the arena vote on the results screen: the options, and each player's pick (player id -> arena id). */
export interface ArenaVote {
  options: { id: string; name: string }[];
  votes: Record<string, string>;
}

/** M3 Last Standing: the round now. `over`: someone won it (or nobody); the next starts at `until`. */
export interface RoundInfo {
  number: number;
  phase: 'fighting' | 'over';
  startTick: number;
  winner: string | null;
  until: number | null;
}

/** Everything a client needs to show the match: timer, target, results. Sent in `welcome` and `match` messages. */
export interface MatchInfo {
  number: number;
  /** M3 */
  mode: GameMode;
  phase: MatchPhase;
  arena: string;
  arenaName: string;
  size: ArenaSize;
  startTick: number;
  /** Tick the time runs out. */
  endTick: number;
  /** The score that ends the match (what it counts depends on the mode: `MODES[mode].unit`). */
  killTarget: number;
  /** While in results: tick the next match starts. */
  resultsUntil: number | null;
  result: MatchResult | null;
  /** Name of the arena after this one; null while it's being voted on. */
  next: string | null;
  /** The chaos round announced / on now (S7), or null. */
  modifier: ModifierInfo | null;
  /** M2: the arena vote (results screen of a `vote` room), or null. */
  vote: ArenaVote | null;
  /** M3 Last Standing: the round, or null in other modes. */
  round: RoundInfo | null;
  /** M3 Team Battle: kills per team (red, blue), or null. */
  teamScores: [number, number] | null;
}

/** What `Match.step` changed (clients hear the new match info): results, a new world, a chaos round, a round, team scores. */
export type MatchChange = 'ended' | 'new_world' | 'modifier' | 'round' | 'score' | null;

/**
 * The match loop: one GameWorld per match. A match ends at the score target or when time runs out; then everyone is
 * frozen for the results screen (M2: and votes for the next arena in a `vote` room); then the next arena is built and
 * everyone is spawned in it. The arena size (full / narrow) is picked from the player count at that moment.
 *
 * M3: the game mode (`MODES`) sets the target, the crown rule, respawns and rounds, the starting weapon, power-ups,
 * teams and how often chaos rounds come.
 *
 * The tick keeps counting across matches (the new world starts at the old world's tick), so clients' smoothing and
 * event timing never jump backwards. Players keep their slot (clients know players by slot) and their team.
 */
export class Match {
  world: GameWorld;
  info: MatchInfo;
  readonly mode: GameMode;
  readonly rules: ModeRules;
  readonly choice: ArenaChoice;
  /** Everyone in the match (humans and bots) -> their slot. */
  private readonly members = new Map<string, number>();
  /** M3 Team Battle: everyone's team (kept across matches), and which members are bots (team balance counts people). */
  private readonly teams = new Map<string, Team>();
  private readonly botIds = new Set<string>();
  private readonly rand: () => number;
  /** The arena being played, and the next one if it's already known (not in a vote). */
  private current: ArenaDef;
  private upcoming: ArenaDef | null = null;
  /** M2 `random` / vote options: a shuffle bag (each arena once, then a fresh shuffle). */
  private bag: ArenaDef[] = [];

  constructor(
    private readonly log: Logger,
    /** The arenas this room can play, in rotation order. */
    private readonly pool: ArenaDef[],
    /** How many players to size the first arena for (players usually arrive one by one, after it's built). */
    expectedPlayers: number,
    private readonly settings: MatchSettings,
    rules: MatchRules = {},
  ) {
    if (!pool.length) throw new Error('empty arena pool');
    this.mode = rules.mode ?? 'ffa';
    this.rules = MODES[this.mode];
    this.choice = rules.arenas ?? 'rotation';
    this.rand = seededRandom(rules.seed ?? 1);
    const first = rules.first ? pool.find((a) => a.id === rules.first) : undefined;
    if (rules.first && !first) log.warn('arena_not_in_pool', { arena: rules.first, pool: pool.map((a) => a.id) });
    if (this.choice === 'one') this.pool = [first ?? pool[0]];
    this.current = first ?? (this.choice === 'random' || this.choice === 'vote' ? this.draw(new Set()) : this.pool[0]);
    const { world, info } = this.build(0, 1, expectedPlayers);
    this.world = world;
    this.info = info;
  }

  get players(): string[] {
    return [...this.members.keys()];
  }

  /** M3 Team Battle: this player's team (undefined outside team matches). */
  teamOf(id: string): Team | undefined {
    return this.teams.get(id);
  }

  /** M3 Team Battle: players per team, people and bots. */
  teamCounts(): [number, number] {
    const n: [number, number] = [0, 0];
    for (const id of this.members.keys()) {
      const t = this.teams.get(id);
      if (t !== undefined) n[t]++;
    }
    return n;
  }

  /** Adds a player to the current match (also mid-match or during results). Team Battle: onto the smaller team. */
  join(id: string, bot = false): void {
    if (bot) this.botIds.add(id);
    if (this.rules.teams && !this.teams.has(id)) {
      const n = this.teamCounts();
      const people: [number, number] = [0, 0];
      for (const m of this.members.keys()) if (!this.botIds.has(m) && this.teams.has(m)) people[this.teams.get(m)!]++;
      // the smaller team; a tie goes to the team with fewer people (friends get spread, bots fill the rest)
      const team: Team = n[0] !== n[1] ? (n[0] < n[1] ? 0 : 1) : people[0] <= people[1] ? 0 : 1;
      this.teams.set(id, team);
      this.log.info('team_join', { id, team, bot, counts: n });
    }
    const team = this.teams.get(id);
    if (team !== undefined) this.world.teams.set(id, team);
    this.world.spawnPlayer(id, this.members.get(id));
    this.members.set(id, this.world.slotOf(id));
  }

  leave(id: string): void {
    this.members.delete(id);
    this.teams.delete(id);
    this.botIds.delete(id);
    this.world.removePlayer(id);
    if (this.info.vote && id in this.info.vote.votes) {
      const votes = { ...this.info.vote.votes };
      delete votes[id];
      this.info = { ...this.info, vote: { ...this.info.vote, votes } };
    }
  }

  /**
   * M2: a vote for the next arena (results screen only, one of the options; changing it is fine). Returns why it was
   * refused, or null when the vote counts (the caller tells everyone the new match info).
   */
  vote(id: string, arena: string): string | null {
    const v = this.info.vote;
    if (this.info.phase !== 'results' || !v) return 'no_vote_now';
    if (!this.members.has(id)) return 'not_a_player';
    if (!v.options.some((o) => o.id === arena)) return 'not_an_option';
    if (v.votes[id] === arena) return 'same_vote';
    this.info = { ...this.info, vote: { ...v, votes: { ...v.votes, [id]: arena } } };
    this.log.info('arena_vote', { id, arena, votes: this.voteCounts() });
    return null;
  }

  /** One tick: maybe start the next match, step the world, maybe end the match. */
  step(): MatchChange {
    let change: MatchChange = null;
    if (this.info.phase === 'results' && this.world.tick >= this.info.resultsUntil!) {
      this.nextMatch();
      change = 'new_world';
    }
    this.world.step();
    // (after the step: shots are handled between ticks, so at tick `start` the round must already be on, matching
    // the client's rule `modifierOn`: start <= tick < end)
    if (this.info.phase === 'playing' && this.updateModifier()) change = change ?? 'modifier';
    if (this.info.phase === 'playing' && this.updateRound()) change = change ?? 'round';
    if (this.info.teamScores && this.info.phase === 'playing') {
      const [a, b] = this.world.teamScores;
      if (a !== this.info.teamScores[0] || b !== this.info.teamScores[1]) {
        this.info = { ...this.info, teamScores: [a, b] };
        change = change ?? 'score';
      }
    }
    if (this.info.phase === 'playing') {
      const reason = this.endReason();
      if (reason) {
        this.end(reason);
        change = 'ended';
      }
    }
    const m = this.info.modifier;
    if (this.world.modifier && (!m || this.world.tick > m.end + 1)) this.world.anomaly('modifier_stuck', 'match', { kind: this.world.modifier, end: m?.end ?? null }, 'error');
    return change;
  }

  /** Chaos rounds: announce, switch on, switch off. True when something changed that clients should hear. */
  private updateModifier(): boolean {
    const every = Math.round((this.settings.modifierEveryTicks ?? MODIFIER.everyTicks) * this.rules.chaosEvery);
    const length = Math.round((this.settings.modifierTicks ?? MODIFIER.ticks) * this.rules.chaosLength);
    if (!every || !length) return false;
    const tick = this.world.tick;
    const m = this.info.modifier;
    if (m && tick === m.start) {
      this.world.setModifier(m.kind, true, m.end - m.start);
      return false; // (clients already know the start tick)
    }
    if (m && tick >= m.end) {
      this.world.setModifier(m.kind, false);
      this.info = { ...this.info, modifier: null };
      return true;
    }
    if (!m) {
      const since = tick - this.info.startTick + MODIFIER.announceTicks;
      const k = since / every;
      if (since > 0 && Number.isInteger(k)) {
        const start = tick + MODIFIER.announceTicks;
        if (start + length > this.info.endTick) return false; // not enough match left
        const order = modifierOrder(this.info.number).filter((x) => !this.rules.chaosSkip.includes(x));
        const kind = order[(k - 1) % order.length];
        this.info = { ...this.info, modifier: { kind, announcedAt: tick, start, end: start + length } };
        this.log.info('modifier_announce', { kind, start, end: start + length });
        return true;
      }
    }
    return false;
  }

  /**
   * M3 Last Standing: a round ends when at most one player is alive (they win it: +1 score) or it ran too long (the
   * most health left wins it; a tie: nobody); after a short pause everyone comes back for the next. True when clients
   * should hear it.
   */
  private updateRound(): boolean {
    const r = this.info.round;
    if (!r) return false;
    const tick = this.world.tick;
    if (r.phase === 'fighting') {
      const ids = this.players;
      if (ids.length < 2) return false;
      const alive = ids.filter((id) => this.world.stats.get(id)?.alive);
      const timeUp = tick - r.startTick >= ROUND.maxTicks;
      if (alive.length > 1 && !timeUp) return false;
      const health = (id: string) => this.world.stats.get(id)!.health;
      const byHealth = [...alive].sort((a, b) => health(b) - health(a));
      const winner = alive.length <= 1 ? (alive[0] ?? null) : health(byHealth[0]) > health(byHealth[1]) ? byHealth[0] : null;
      if (winner) this.world.stats.get(winner)!.score++;
      this.info = { ...this.info, round: { ...r, phase: 'over', winner, until: tick + ROUND.pauseTicks } };
      this.log.info('round_end', {
        match: this.info.number,
        round: r.number,
        winner,
        why: alive.length <= 1 ? 'last_alive' : 'time_health',
        alive: alive.length,
        ...(alive.length > 1 ? { health: Object.fromEntries(byHealth.map((id) => [id, Math.round(health(id))])) } : {}),
        ticks: tick - r.startTick,
      });
      return true;
    }
    if (tick < r.until!) return false;
    this.world.respawnAll();
    this.info = { ...this.info, round: { number: r.number + 1, phase: 'fighting', startTick: tick, winner: null, until: null } };
    this.log.info('round_start', { match: this.info.number, round: r.number + 1, players: this.members.size });
    return true;
  }

  /** Current scores, best first. */
  scores(): MatchScore[] {
    return [...this.world.stats.values()]
      .filter((s) => this.members.has(s.id))
      .map((s) => ({ id: s.id, score: s.score, kills: s.kills, deaths: s.deaths }))
      .sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
  }

  dispose(): void {
    this.world.dispose();
  }

  // ---- internals ----

  private endReason(): MatchResult['reason'] | null {
    const top = this.rules.teams ? Math.max(...this.world.teamScores) : Math.max(0, ...[...this.world.stats.values()].map((s) => s.score));
    if (top >= this.info.killTarget) return 'kills';
    if (this.world.tick >= this.info.endTick) return 'time';
    return null;
  }

  private end(reason: MatchResult['reason']): void {
    const scores = this.scores();
    let winner: string | null;
    let winnerTeam: Team | null = null;
    if (this.rules.teams) {
      const [a, b] = this.world.teamScores;
      winnerTeam = a > b ? 0 : b > a ? 1 : null;
      winner = winnerTeam === null ? null : (scores.find((s) => this.teams.get(s.id) === winnerTeam)?.id ?? null);
    } else {
      const [a, b] = scores;
      const ahead = a && (!b || a.score > b.score || (a.score === b.score && (a.kills > b.kills || (a.kills === b.kills && a.deaths < b.deaths))));
      winner = ahead ? a.id : null;
    }
    // a chaos round still on ends with the match (everything back to normal for the results)
    if (this.world.modifier) this.world.setModifier(this.world.modifier, false);
    this.world.frozen = true;
    const awards = this.world.awards();
    const best = this.world.best ? { tick: this.world.best.tick, kind: this.world.best.kind, id: this.world.best.id, by: this.world.best.by, pos: this.world.best.pos } : null;
    const vote = this.choice === 'vote' ? this.voteOptions() : null;
    this.info = {
      ...this.info,
      phase: 'results',
      modifier: null,
      resultsUntil: this.world.tick + this.settings.resultsTicks,
      result: { reason, winner, winnerTeam, scores, awards, best },
      vote,
    };
    this.log.info('match_end', {
      match: this.info.number,
      mode: this.mode,
      arena: this.info.arena,
      reason,
      winner,
      ...(this.rules.teams ? { winnerTeam, teamScores: [...this.world.teamScores] } : {}),
      ticks: this.world.tick - this.info.startTick,
      scores: Object.fromEntries(scores.map((s) => [s.id, [s.score, s.kills, s.deaths]])),
      awards: awards.map((x) => `${x.kind}:${x.id}:${x.value}`),
      best: best ? `${best.kind}@${best.tick}` : null,
      ...(vote ? { voteOptions: vote.options.map((o) => o.id) } : {}),
    });
  }

  /** M2: the arenas to vote between: the next few from the shuffle bag, never the one just played (if there's another). */
  private voteOptions(): ArenaVote {
    const n = Math.min(ROOM.voteOptions, Math.max(1, this.pool.length - 1));
    const taken = new Set(this.pool.length > 1 ? [this.current.id] : []);
    const options: ArenaDef[] = [];
    while (options.length < n) {
      const a = this.draw(taken);
      taken.add(a.id);
      options.push(a);
    }
    return { options: options.map((a) => ({ id: a.id, name: a.name })), votes: {} };
  }

  private voteCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const o of this.info.vote?.options ?? []) counts[o.id] = 0;
    for (const a of Object.values(this.info.vote?.votes ?? {})) if (a in counts) counts[a]++;
    return counts;
  }

  /** The arena for the next match: decided at build (rotation / random / one), or by the vote (no votes: random). */
  private pickNext(): ArenaDef {
    const v = this.info.vote;
    if (this.choice !== 'vote' || !v) return this.upcoming ?? this.current;
    const counts = this.voteCounts();
    const most = Math.max(...Object.values(counts));
    // nobody voted: any option; a tie: any of the tied ones
    const pool = v.options.filter((o) => counts[o.id] === most);
    const picked = pool[Math.floor(this.rand() * pool.length)];
    // the options not picked go back in the bag (they come up again soon)
    for (const o of v.options) if (o.id !== picked.id) this.bag.push(this.pool.find((a) => a.id === o.id)!);
    this.log.info('arena_pick', { how: most > 0 ? (pool.length > 1 ? 'vote_tie' : 'vote') : 'random_no_votes', picked: picked.id, counts, voters: Object.keys(v.votes).length });
    return this.pool.find((a) => a.id === picked.id)!;
  }

  /** M2 shuffle bag: the next arena not in `exclude`; the bag is refilled (shuffled) when it runs out. */
  private draw(exclude: Set<string>): ArenaDef {
    for (let pass = 0; pass < 2; pass++) {
      const i = this.bag.findIndex((a) => !exclude.has(a.id));
      if (i >= 0) return this.bag.splice(i, 1)[0];
      const fresh = [...this.pool];
      for (let k = fresh.length - 1; k > 0; k--) {
        const j = Math.floor(this.rand() * (k + 1));
        [fresh[k], fresh[j]] = [fresh[j], fresh[k]];
      }
      this.bag.push(...fresh);
    }
    return this.pool[Math.floor(this.rand() * this.pool.length)];
  }

  private nextMatch(): void {
    const old = this.world;
    this.current = this.pickNext();
    if (this.choice === 'random' || this.choice === 'rotation') this.log.info('arena_pick', { how: this.choice, picked: this.current.id });
    const { world, info } = this.build(old.tick, this.info.number + 1, this.members.size);
    old.dispose();
    this.world = world;
    this.info = info;
    // Everyone comes back, in slot order, each keeping their slot (and team).
    for (const [id, slot] of [...this.members].sort((x, y) => x[1] - y[1])) {
      const team = this.teams.get(id);
      if (team !== undefined) world.teams.set(id, team);
      world.spawnPlayer(id, slot);
      if (world.slotOf(id) !== slot) world.anomaly('slot_changed', id, { want: slot, got: world.slotOf(id) }, 'error');
    }
  }

  private build(tick: number, number: number, players: number): { world: GameWorld; info: MatchInfo } {
    const def = this.current;
    const size = arenaSizeFor(def, players);
    const world = new GameWorld(this.log);
    world.tick = tick;
    world.crownRule = this.rules.crown;
    world.respawns = this.rules.respawn;
    world.killsScore = this.rules.killsScore;
    world.startWeapon = this.rules.weapon;
    buildArena(world, arenaLayout(def, size), { pickups: this.rules.pickups });
    // the next arena, when it's known now (a vote decides it on the results screen)
    if (this.choice === 'rotation') this.upcoming = this.pool[(this.pool.indexOf(def) + 1) % this.pool.length];
    else if (this.choice === 'random') this.upcoming = this.draw(new Set(this.pool.length > 1 ? [def.id] : []));
    else if (this.choice === 'one') this.upcoming = def;
    else this.upcoming = null;
    const info: MatchInfo = {
      number,
      mode: this.mode,
      phase: 'playing',
      arena: def.id,
      arenaName: def.name,
      size,
      startTick: tick,
      endTick: tick + this.settings.lengthTicks,
      killTarget: this.settings.killTarget ?? this.rules.target,
      resultsUntil: null,
      result: null,
      next: this.upcoming?.name ?? null,
      modifier: null,
      vote: null,
      round: this.rules.rounds ? { number: 1, phase: 'fighting', startTick: tick, winner: null, until: null } : null,
      teamScores: this.rules.teams ? [0, 0] : null,
    };
    this.log.info('match_start', { match: number, mode: this.mode, arena: def.id, size, players, endTick: info.endTick, killTarget: info.killTarget, next: info.next, arenas: this.choice });
    return { world, info };
  }
}
