import { CALLOUT, EFFECT, MODIFIER, PIN, SPECIAL } from './constants';
import type { PartName, Zone } from './ragdoll';

/**
 * Status effects: what a hit does to a player for a few seconds (S3). One effect per body zone: a second hit on the
 * same zone restarts its timer (it doesn't get stronger). L3: the bullet itself vanishes on impact; the effect runs on
 * from the hit. Pure rules; the world applies them to the ragdoll each tick (the ragdoll stays pure physics).
 */
export type EffectKind = 'head' | 'arm' | 'balloon' | 'laugh' | 'pinned';

export interface Effect {
  kind: EffectKind;
  /** The body part the (latest) hit was on, e.g. which arm. */
  part: PartName;
  start: number;
  end: number;
}

/** Which zones give a short effect: head and arms (L4: legs climb the lasting leg ladder instead; torso only damage). */
export const effectKindOf = (zone: Zone): EffectKind | null => (zone === 'head' || zone === 'arm' ? zone : null);

/** Snapshot bits for active effects. */
/** (4 was the S3 leg effect: L4 moved legs to the lasting ladder, sent as the leg stage.) */
export const EFFECT_BIT: Record<EffectKind, number> = { head: 1, arm: 2, balloon: 8, laugh: 16, pinned: 32 };
/** Snapshot bit (not an effect): feet in an oil puddle. */
export const OILED_BIT = 64;

/** How long each effect lasts unless told otherwise (ticks). */
const DEFAULT_TICKS: Record<EffectKind, number> = {
  head: EFFECT.hitTicks,
  arm: EFFECT.hitTicks,
  balloon: SPECIAL.balloon.ticks,
  laugh: SPECIAL.feather.ticks,
  pinned: PIN.ticks,
};

/** Longest each effect can last (ticks), for the anomaly check. */
export const EFFECT_MAX_TICKS: Record<EffectKind, number> = {
  head: EFFECT.hitTicks,
  arm: EFFECT.hitTicks,
  balloon: Math.max(SPECIAL.balloon.ticks, MODIFIER.ticks), // (a chaos-round balloon lasts the round)
  laugh: SPECIAL.feather.ticks,
  pinned: PIN.ticks,
};

export class EffectSet {
  private readonly active = new Map<EffectKind, Effect>();

  /** Starts (or restarts) an effect. Returns it and whether it was already running. */
  add(kind: EffectKind, part: PartName, tick: number, ticks: number = DEFAULT_TICKS[kind]): { effect: Effect; refreshed: boolean } {
    const old = this.active.get(kind);
    const effect: Effect = { kind, part, start: tick, end: tick + ticks };
    this.active.set(kind, effect);
    return { effect, refreshed: !!old };
  }

  /** Ends one effect now (e.g. a popped balloon). Returns it, if it was on. */
  remove(kind: EffectKind): Effect | undefined {
    const e = this.active.get(kind);
    this.active.delete(kind);
    return e;
  }

  get(kind: EffectKind): Effect | undefined {
    return this.active.get(kind);
  }

  has(kind: EffectKind): boolean {
    return this.active.has(kind);
  }

  all(): Effect[] {
    return [...this.active.values()];
  }

  /** Removes and returns the effects that have run out. */
  takeExpired(tick: number): Effect[] {
    const out = this.all().filter((e) => tick >= e.end);
    for (const e of out) this.active.delete(e.kind);
    return out;
  }

  /** Removes and returns everything (death). */
  clear(): Effect[] {
    const out = this.all();
    this.active.clear();
    return out;
  }

  bits(): number {
    let b = 0;
    for (const k of this.active.keys()) b |= EFFECT_BIT[k];
    return b;
  }
}

export type CalloutKind =
  | 'cracked'
  | 'ankle_breaker'
  | 'airball'
  | 'sniped'
  | 'point_blank'
  | 'ring_out'
  // S5
  | 'outta_here'
  | 'splat'
  | 'slip'
  | 'pinned'
  | 'swapped'
  | 'tickled'
  | 'kaboom'
  // S6
  | 'bonk'
  // S7
  | 'revenge'
  | 'double_kill'
  | 'self_own'
  | 'humbled'
  // L5
  | 'disarmed'
  | 'shattered'
  // L7
  | 'leg_off';

/**
 * L1: how big each callout is shown. `tag` = small text above the victim's head that follows it (most of them);
 * `banner` = the big moments, at the top of the screen in the HUD. A Record, so a new kind can't be added without
 * a size (and a test checks the banner list against the plan).
 */
export const CALLOUT_SIZE: Record<CalloutKind, 'tag' | 'banner'> = {
  cracked: 'tag',
  ankle_breaker: 'tag',
  airball: 'tag',
  sniped: 'tag',
  point_blank: 'tag',
  splat: 'tag',
  slip: 'tag',
  pinned: 'tag',
  swapped: 'tag',
  tickled: 'tag',
  bonk: 'tag',
  self_own: 'tag',
  humbled: 'tag',
  outta_here: 'banner',
  kaboom: 'banner',
  ring_out: 'banner',
  revenge: 'banner',
  double_kill: 'banner',
  disarmed: 'banner',
  shattered: 'banner',
  leg_off: 'banner',
};

export const CALLOUT_KINDS = Object.keys(CALLOUT_SIZE) as CalloutKind[];

/**
 * The banner for a hit, or null for an ordinary one. One per hit; the rarest/most impressive wins:
 * sniped > cracked (headshot) > airball (victim in the air) > ankle breaker (leg trip) > point blank.
 */
export function pickCallout(hit: { zone: Zone; distance: number; victimAirborne: boolean }): CalloutKind | null {
  if (hit.distance >= CALLOUT.snipedFrom) return 'sniped';
  if (hit.zone === 'head') return 'cracked';
  if (hit.victimAirborne) return 'airball';
  if (hit.zone === 'leg') return 'ankle_breaker';
  if (hit.distance <= CALLOUT.pointBlankWithin) return 'point_blank';
  return null;
}
