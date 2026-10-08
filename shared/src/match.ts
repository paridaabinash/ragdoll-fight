import { arenaLayout, arenaSizeFor, type ArenaDef, type ArenaSize } from './arena';
import { MATCH, MODIFIER } from './constants';
import { modifierOrder, type Award, type BestMoment, type ModifierInfo } from './spice';
import { buildArena } from './level';
import type { Logger } from './log';
import { GameWorld } from './world';

export interface MatchSettings {
  lengthTicks: number;
  /** Score target (1 per kill, more for the crown holder). */
  killTarget: number;
  resultsTicks: number;
  /** Chaos rounds (S7): one every `everyTicks`, lasting `ticks` (defaults: MODIFIER). 0 = none. */
  modifierEveryTicks?: number;
  modifierTicks?: number;
}

export type MatchPhase = 'playing' | 'results';

export interface MatchScore {
  id: string;
  /** 1 per kill, more for killing the crown holder (S7). */
  score: number;
  kills: number;
  deaths: number;
}

export interface MatchResult {
  reason: 'kills' | 'time';
  /** Highest score (more kills, then fewer deaths break a tie); null if still tied. */
  winner: string | null;
  /** Best first. */
  scores: MatchScore[];
  /** Fun awards (S7). */
  awards: Award[];
  /** The most exciting moment, replayed on the results screen (null if nothing happened). */
  best: BestMoment | null;
}

/** Everything a client needs to show the match: timer, target, results. Sent in `welcome` and `match` messages. */
export interface MatchInfo {
  number: number;
  phase: MatchPhase;
  arena: string;
  arenaName: string;
  size: ArenaSize;
  startTick: number;
  /** Tick the time runs out. */
  endTick: number;
  killTarget: number;
  /** While in results: tick the next match starts. */
  resultsUntil: number | null;
  result: MatchResult | null;
  /** Name of the arena after this one. */
  next: string;
  /** The chaos round announced / on now (S7), or null. */
  modifier: ModifierInfo | null;
}

/** What `Match.step` changed: the match ended (results), a new match started in a new world, or a chaos round changed. */
export type MatchChange = 'ended' | 'new_world' | 'modifier' | null;

/**
 * The match loop: one GameWorld per match. A match ends at the kill target or when time runs out; then everyone is
 * frozen for the results screen; then the next arena in the (fixed) rotation is built and everyone is spawned in it.
 * The arena size (full / narrow) is picked from the player count at that moment.
 *
 * The tick keeps counting across matches (the new world starts at the old world's tick), so clients' smoothing and
 * event timing never jump backwards. Players keep their slot (clients know players by slot).
 */
export class Match {
  world: GameWorld;
  info: MatchInfo;
  /** Everyone in the match (humans and bots) -> their slot. */
  private readonly members = new Map<string, number>();
  private rotationIndex = 0;

  constructor(
    private readonly log: Logger,
    private readonly rotation: ArenaDef[],
    /** How many players to size the first arena for (players usually arrive one by one, after it's built). */
    expectedPlayers: number,
    private readonly settings: MatchSettings = MATCH,
  ) {
    if (!rotation.length) throw new Error('empty arena rotation');
    const { world, info } = this.build(0, 1, expectedPlayers);
    this.world = world;
    this.info = info;
  }

  get players(): string[] {
    return [...this.members.keys()];
  }

  /** Adds a player to the current match (also mid-match or during results). */
  join(id: string): void {
    this.world.spawnPlayer(id, this.members.get(id));
    this.members.set(id, this.world.slotOf(id));
  }

  leave(id: string): void {
    this.members.delete(id);
    this.world.removePlayer(id);
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
    const every = this.settings.modifierEveryTicks ?? MODIFIER.everyTicks;
    const length = this.settings.modifierTicks ?? MODIFIER.ticks;
    if (!every) return false;
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
        const order = modifierOrder(this.info.number);
        const kind = order[(k - 1) % order.length];
        this.info = { ...this.info, modifier: { kind, announcedAt: tick, start, end: start + length } };
        this.log.info('modifier_announce', { kind, start, end: start + length });
        return true;
      }
    }
    return false;
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
    const top = Math.max(0, ...[...this.world.stats.values()].map((s) => s.score));
    if (top >= this.settings.killTarget) return 'kills';
    if (this.world.tick >= this.info.endTick) return 'time';
    return null;
  }

  private end(reason: MatchResult['reason']): void {
    const scores = this.scores();
    const [a, b] = scores;
    const ahead = a && (!b || a.score > b.score || (a.score === b.score && (a.kills > b.kills || (a.kills === b.kills && a.deaths < b.deaths))));
    const winner = ahead ? a.id : null;
    // a chaos round still on ends with the match (everything back to normal for the results)
    if (this.world.modifier) this.world.setModifier(this.world.modifier, false);
    this.world.frozen = true;
    const awards = this.world.awards();
    const best = this.world.best ? { tick: this.world.best.tick, kind: this.world.best.kind, id: this.world.best.id, by: this.world.best.by, pos: this.world.best.pos } : null;
    this.info = {
      ...this.info,
      phase: 'results',
      modifier: null,
      resultsUntil: this.world.tick + this.settings.resultsTicks,
      result: { reason, winner, scores, awards, best },
    };
    this.log.info('match_end', {
      match: this.info.number,
      arena: this.info.arena,
      reason,
      winner,
      ticks: this.world.tick - this.info.startTick,
      scores: Object.fromEntries(scores.map((s) => [s.id, [s.score, s.kills, s.deaths]])),
      awards: awards.map((x) => `${x.kind}:${x.id}:${x.value}`),
      best: best ? `${best.kind}@${best.tick}` : null,
    });
  }

  private nextMatch(): void {
    const old = this.world;
    this.rotationIndex = (this.rotationIndex + 1) % this.rotation.length;
    const { world, info } = this.build(old.tick, this.info.number + 1, this.members.size);
    old.dispose();
    this.world = world;
    this.info = info;
    // Everyone comes back, in slot order, each keeping their slot.
    for (const [id, slot] of [...this.members].sort((x, y) => x[1] - y[1])) {
      world.spawnPlayer(id, slot);
      if (world.slotOf(id) !== slot) world.anomaly('slot_changed', id, { want: slot, got: world.slotOf(id) }, 'error');
    }
  }

  private build(tick: number, number: number, players: number): { world: GameWorld; info: MatchInfo } {
    const def = this.rotation[this.rotationIndex];
    const size = arenaSizeFor(def, players);
    const world = new GameWorld(this.log);
    world.tick = tick;
    buildArena(world, arenaLayout(def, size));
    const next = this.rotation[(this.rotationIndex + 1) % this.rotation.length];
    const info: MatchInfo = {
      number,
      phase: 'playing',
      arena: def.id,
      arenaName: def.name,
      size,
      startTick: tick,
      endTick: tick + this.settings.lengthTicks,
      killTarget: this.settings.killTarget,
      resultsUntil: null,
      result: null,
      next: next.name,
      modifier: null,
    };
    this.log.info('match_start', { match: number, arena: def.id, size, players, endTick: info.endTick, killTarget: info.killTarget });
    return { world, info };
  }
}
