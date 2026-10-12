import { MODIFIER } from './constants';
import { seededRandom } from './bot';
import type { GameEvent } from './world';

/**
 * Match spice (S7): chaos rounds, awards and hats. Pure data + rules; the match and the world apply them.
 */

// ---- chaos rounds ----

export type ModifierKind = 'moon' | 'big_heads' | 'glove_only' | 'oil_floor' | 'balloons';
export const MODIFIER_KINDS: ModifierKind[] = ['moon', 'big_heads', 'glove_only', 'oil_floor', 'balloons'];
export const MODIFIER_NAMES: Record<ModifierKind, string> = {
  moon: 'MOON GRAVITY',
  big_heads: 'BIG HEAD MODE',
  glove_only: 'BOXING GLOVES ONLY',
  oil_floor: 'OIL FLOOR',
  balloons: 'EVERYONE HAS BALLOONS',
};

/** A chaos round: announced at `announcedAt`, on from `start` until `end` (ticks). */
export interface ModifierInfo {
  kind: ModifierKind;
  announcedAt: number;
  start: number;
  end: number;
}

/** Is it on at this tick? (Clients use the same rule for their aim preview in Moon Gravity.) */
export const modifierOn = (m: ModifierInfo | null | undefined, tick: number): boolean => !!m && tick >= m.start && tick < m.end;

/** Gravity share at a tick (1 normally, less in Moon Gravity). */
export const gravityShareAt = (m: ModifierInfo | null | undefined, tick: number): number =>
  m?.kind === 'moon' && modifierOn(m, tick) ? MODIFIER.moonGravity : 1;

/** The order of chaos rounds in a match: each kind once (shuffled by the match number), then again. */
export function modifierOrder(matchNumber: number): ModifierKind[] {
  const rand = seededRandom(7919 * matchNumber + 13);
  const kinds = [...MODIFIER_KINDS];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  return kinds;
}

/** M3: the chaos rounds a mode plays in a match, in order (`modifierOrder` without the mode's `skip`ped kinds). */
export function modeChaosOrder(matchNumber: number, skip: readonly ModifierKind[]): ModifierKind[] {
  return modifierOrder(matchNumber).filter((x) => !skip.includes(x));
}

// ---- awards ----

/** Per player, per match: what the awards are made of. */
export interface Tally {
  /** Times they hit a wall hard (SPLAT!). */
  splats: number;
  /** Deaths by their own bomb / glove bounce. */
  selfOwns: number;
  /** Longest distance (m) one of their arrows hit someone from. */
  longestShot: number;
  /** Ticks wearing the crown. */
  crownTicks: number;
  /** Times they were pinned to a wall. */
  pinned: number;
  /** L7: legs they lost (shot down to stumps). */
  limbsLost: number;
  /** L7: ticks alive on at least one stump. */
  stumpTicks: number;
}
export const newTally = (): Tally => ({ splats: 0, selfOwns: 0, longestShot: 0, crownTicks: 0, pinned: 0, limbsLost: 0, stumpTicks: 0 });

export type AwardKind = 'most_splats' | 'biggest_self_own' | 'longest_shot' | 'crown_holder' | 'most_pinned' | 'flesh_wound' | 'most_limbs_lost';
export const AWARD_NAMES: Record<AwardKind, string> = {
  most_splats: 'Most Splats',
  biggest_self_own: 'Biggest Self-Own',
  longest_shot: 'Longest Shot',
  crown_holder: 'Crown Holder',
  most_pinned: 'Most Pinned',
  flesh_wound: 'Flesh Wound',
  most_limbs_lost: 'Most Limbs Lost',
};
export interface Award {
  kind: AwardKind;
  id: string;
  /** Count, meters or seconds (see the kind). */
  value: number;
}

/** The awards for a finished match: one per kind, to whoever has the most of it (nobody if it's 0). Ties: first in `order`. */
export function pickAwards(tallies: Map<string, Tally>, order: string[]): Award[] {
  const out: Award[] = [];
  const best = (kind: AwardKind, value: (t: Tally) => number) => {
    let top: { id: string; v: number } | null = null;
    for (const id of order) {
      const t = tallies.get(id);
      const v = t ? value(t) : 0;
      if (v > 0 && (!top || v > top.v)) top = { id, v };
    }
    if (top) out.push({ kind, id: top.id, value: Math.round(top.v * 10) / 10 });
  };
  best('most_splats', (t) => t.splats);
  best('biggest_self_own', (t) => t.selfOwns);
  best('longest_shot', (t) => t.longestShot);
  best('crown_holder', (t) => t.crownTicks / 60);
  best('most_pinned', (t) => t.pinned);
  // L7: the longest alive on a stump (seconds), and the most legs lost
  best('flesh_wound', (t) => t.stumpTicks / 60);
  best('most_limbs_lost', (t) => t.limbsLost);
  return out;
}

/** How exciting each callout is (for the match's best moment, replayed on the results screen). */
export const EXCITEMENT: Record<string, number> = {
  shattered: 45,
  disarmed: 30,
  leg_off: 28,
  double_kill: 40,
  ring_out: 35,
  revenge: 30,
  kaboom: 30,
  sniped: 30,
  splat: 25,
  outta_here: 20,
  cracked: 20,
  bonk: 20,
  self_own: 20,
  pinned: 15,
  airball: 15,
  humbled: 15,
  swapped: 10,
  slip: 10,
  ankle_breaker: 10,
  tickled: 5,
  point_blank: 5,
};

/** The best moment of a match (the client replays the seconds around `tick`). */
export interface BestMoment {
  tick: number;
  kind: string;
  id: string;
  by: string | null;
  pos: { x: number; y: number };
}

// ---- hats (cosmetic) ----

/** What a player has done over all their games (kept on their device). Hats unlock from it. */
export interface Progress {
  kills: number;
  pins: number;
  selfOwns: number;
  splats: number;
  ringOuts: number;
  crownSeconds: number;
  wins: number;
}
export const newProgress = (): Progress => ({ kills: 0, pins: 0, selfOwns: 0, splats: 0, ringOuts: 0, crownSeconds: 0, wins: 0 });

export type HatKind = 'none' | 'cap' | 'party' | 'tophat' | 'viking' | 'chef' | 'propeller' | 'traffic_cone';
export const HATS: { kind: HatKind; name: string; how: string; unlocked: (p: Progress) => boolean }[] = [
  { kind: 'none', name: 'No hat', how: 'always', unlocked: () => true },
  { kind: 'cap', name: 'Cap', how: 'always', unlocked: () => true },
  { kind: 'party', name: 'Party hat', how: 'get 10 kills', unlocked: (p) => p.kills >= 10 },
  { kind: 'viking', name: 'Viking helmet', how: 'pin 10 players to walls', unlocked: (p) => p.pins >= 10 },
  { kind: 'traffic_cone', name: 'Traffic cone', how: 'self-own 5 times', unlocked: (p) => p.selfOwns >= 5 },
  { kind: 'chef', name: 'Chef hat', how: 'splat 10 players into walls', unlocked: (p) => p.splats >= 10 },
  { kind: 'propeller', name: 'Propeller cap', how: 'ring out 5 players', unlocked: (p) => p.ringOuts >= 5 },
  { kind: 'tophat', name: 'Top hat', how: 'win 3 matches', unlocked: (p) => p.wins >= 3 },
];
export const HAT_KINDS = HATS.map((h) => h.kind);
export const isHat = (v: unknown): v is HatKind => typeof v === 'string' && (HAT_KINDS as string[]).includes(v);
export const unlockedHats = (p: Progress): HatKind[] => HATS.filter((h) => h.unlocked(p)).map((h) => h.kind);

/**
 * Counts one game event into `me`'s progress (the client calls this for every event it shows).
 * True if something changed. Crown time and wins are added by the caller (they come from snapshots / match info).
 */
export function countProgress(p: Progress, ev: GameEvent, me: string): boolean {
  if (ev.type === 'death' && ev.killer === me && ev.id !== me) {
    p.kills++;
    if (ev.cause !== 'arrow') p.ringOuts++;
    return true;
  }
  if (ev.type !== 'callout') return false;
  if (ev.kind === 'self_own' && ev.id === me) p.selfOwns++;
  else if (ev.kind === 'pinned' && ev.by === me && ev.id !== me) p.pins++;
  else if (ev.kind === 'splat' && ev.by === me && ev.id !== me) p.splats++;
  else return false;
  return true;
}

/** Turns stored progress (from the device; may be old or broken) into a clean Progress. */
export function readProgress(raw: unknown): Progress {
  const p = newProgress();
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(p) as (keyof Progress)[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) p[k] = Math.floor(v);
    }
  }
  return p;
}
