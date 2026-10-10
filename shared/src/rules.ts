import { DAMAGE, GUN, HEALTH, RESPAWN, STAMINA, TICK_SECONDS } from './constants';
import type { Logger } from './log';
import { r2 } from './math';
import type { PartName, Side, Zone } from './ragdoll';
import type { SpecialKind } from './specials';

/**
 * Damage for a hit on `zone` at `impactSpeed` (m/s), in whole points (at least 1).
 * Full damage from HEALTH.fullDamageSpeedShare of top speed up; slower arrows do proportionally less.
 */
export function damageFor(zone: Zone, impactSpeed: number, headMultiplier: number = HEALTH.zoneMultiplier.head): number {
  const speedShare = Math.min(1, impactSpeed / (GUN.bulletSpeed * HEALTH.fullDamageSpeedShare));
  const mult = zone === 'head' ? headMultiplier : HEALTH.zoneMultiplier[zone];
  return Math.max(1, Math.round(HEALTH.baseDamage * speedShare * mult));
}

/** Who gets the kill: the last hitter, if they hit within the credit window before `tick`. */
export function killCredit(lastHit: { by: string; tick: number } | null, tick: number): string | null {
  return lastHit && tick - lastHit.tick <= HEALTH.killCreditTicks ? lastHit.by : null;
}

/**
 * One player's game state: health, stamina, death/respawn timers and score.
 * Pure rules, no physics. The world calls these and moves the ragdoll accordingly.
 */
export class PlayerStats {
  health: number = HEALTH.max;
  stamina: number = STAMINA.max;
  /** Out of stamina: arms down, can't shoot until stamina is back to STAMINA.recoverAt. */
  armsDown = false;
  /** L3: the gun can fire again from this tick on (the pump/bolt reload after each shot). */
  readyAt = -Infinity;
  /** L3: tick of the last shot (the anomaly check: never two shots closer than the reload). */
  lastShotTick = -Infinity;
  lastHit: { by: string; tick: number } | null = null;
  deadSince: number | null = null;
  protectedUntil = -Infinity;
  kills = 0;
  deaths = 0;
  /** Match score (S7): 1 per kill, more for killing the crown holder. Matches end on it. */
  score = 0;
  /** A special arrow from a power-up, used by the next shot (S5). Lost on death. */
  held: SpecialKind | null = null;
  private lastSpendTick = -Infinity;

  constructor(
    readonly id: string,
    private readonly log: Logger,
  ) {}

  get alive(): boolean {
    return this.deadSince === null;
  }

  isProtected(tick: number): boolean {
    return tick < this.protectedUntil;
  }

  /** L7: ends the spawn shield now (you shot or swung). Returns how many ticks it had left (0: it wasn't on). */
  endProtection(tick: number): number {
    const left = Math.max(0, this.protectedUntil - tick);
    if (left > 0) this.protectedUntil = tick;
    return left;
  }

  /** Every tick: refill after a short rest (L3: aiming is free; shots and jumps cost). */
  updateStamina(tick: number): void {
    if (!this.alive) return;
    if (tick - this.lastSpendTick >= STAMINA.refillDelayTicks && this.stamina < STAMINA.max) {
      // (real seconds: like the reload, stamina keeps real time at any game speed)
      this.stamina = Math.min(STAMINA.max, this.stamina + STAMINA.refillPerSec * TICK_SECONDS);
    }
    if (this.armsDown && this.stamina >= STAMINA.recoverAt) {
      this.armsDown = false;
      this.log.info('stamina_recovered', { id: this.id, stamina: r2(this.stamina) });
    }
  }

  /** L3: why this player can't shoot at `tick` right now (null = they can). The world adds the match/laugh checks. */
  fireBlock(tick: number): 'dead' | 'arms_down' | 'fire_too_soon' | null {
    return !this.alive ? 'dead' : this.armsDown ? 'arms_down' : tick < this.readyAt ? 'fire_too_soon' : null;
  }

  /** Ticks until the gun is ready (0 = ready). */
  reloadLeft(tick: number): number {
    return Math.max(0, this.readyAt - tick);
  }

  /**
   * L3: a shot. Starts the reload and costs GUN.staminaPerShot (all that's left if less: at 0 the arms drop). The
   * stamina rest starts only after the reload, so holding fire never refills (see STAMINA.refillDelayTicks).
   */
  shoot(tick: number, reloadTicks: number = GUN.reloadTicks, cost: number = GUN.staminaPerShot): void {
    this.lastShotTick = tick;
    this.readyAt = tick + reloadTicks;
    this.spend(Math.min(this.stamina, cost), this.readyAt);
  }

  /** Spends a fixed amount (e.g. a jump) only if there is enough. */
  trySpend(amount: number, tick: number): boolean {
    if (this.stamina < amount) return false;
    this.spend(amount, tick);
    return true;
  }

  /** Lowers health. Returns the damage actually done (0 if dead or protected). */
  takeDamage(amount: number, by: string, tick: number): number {
    if (!this.alive || this.isProtected(tick)) return 0;
    const done = Math.min(this.health, amount);
    this.health -= done;
    this.lastHit = { by, tick };
    return done;
  }

  /** A hit that does no damage (glove, feather...) still makes you the last hitter (kill credit). */
  markHit(by: string, tick: number): void {
    if (!this.alive || this.isProtected(tick)) return;
    this.lastHit = { by, tick };
  }

  heal(amount: number): number {
    const before = this.health;
    this.health = Math.min(HEALTH.max, this.health + amount);
    return this.health - before;
  }

  refill(amount: number): number {
    const before = this.stamina;
    this.stamina = Math.min(STAMINA.max, this.stamina + amount);
    return this.stamina - before;
  }

  markDead(tick: number): void {
    this.deadSince = tick;
    this.held = null;
    this.deaths++;
  }

  respawnDue(tick: number): boolean {
    return this.deadSince !== null && tick - this.deadSince >= RESPAWN.delayTicks;
  }

  revive(tick: number): void {
    this.health = HEALTH.max;
    this.stamina = STAMINA.max;
    this.armsDown = false;
    this.readyAt = tick; // a fresh gun, ready at once
    this.lastHit = null;
    this.deadSince = null;
    this.protectedUntil = tick + RESPAWN.protectTicks;
  }

  /** `restFrom`: the rest before refilling counts from this tick (a shot: when its reload is done). */
  private spend(amount: number, restFrom: number): void {
    this.stamina = Math.max(0, this.stamina - amount);
    this.lastSpendTick = Math.max(this.lastSpendTick, restFrom);
    if (this.stamina === 0 && !this.armsDown) {
      this.armsDown = true;
      this.log.info('stamina_empty', { id: this.id });
    }
  }
}

/** L5: what a player fights with. Bat and mace play the same (a look); a knocked-away gun doesn't come back until respawn. */
export type Weapon = 'gun' | 'bat' | 'mace';
export const WEAPONS: Weapon[] = ['gun', 'bat', 'mace'];

/** L4 leg stages: whole, hit once (tripped), dragging limp, one thigh stump, two thigh stumps. */
export type LegStage = 0 | 1 | 2 | 3 | 4;
export const LEG_STAGE_NAMES = ['whole', 'tripped', 'dragging', 'one_stump', 'two_stumps'] as const;

/** What a leg hit does to the body (the world turns it into physics). */
export type LegHitResult =
  | { kind: 'trip'; side: Side }
  | { kind: 'drag'; side: Side }
  | { kind: 'stump'; side: Side }
  | { kind: 'none' };

/** A bullet hole: on which part, where in that part's own frame (m). */
export interface Hole {
  part: PartName;
  x: number;
  y: number;
}

/**
 * L4: the lasting damage of one life (pure rules, no physics). Legs climb ONE shared ladder: a hit on either leg moves
 * it one step, and the damage goes to the first leg hit until it's a stump, then to the other:
 *   1st leg hit: a trip; 2nd: that leg drags (limp); 3rd: it's shot to a thigh stump; 4th: a trip on the other leg;
 *   5th: two stumps. (L7: no more hand ladder.)
 * A red apple repairs legs and dents (holes stay); respawning resets everything.
 */
export class BodyDamage {
  legHits = 0;
  /** The leg the damage goes to first (the first leg hit). */
  firstLeg: Side | null = null;
  readonly dents = new Set<PartName>();
  holes: Hole[] = [];
  /** A headshot knocked the hat off (cosmetic; back at respawn, not with an apple). */
  hatOff = false;
  /** L5: the gun, or the melee weapon you got when a critical hit knocked the gun away (until you die). */
  weapon: Weapon = 'gun';
  /** L5: limbs broken by melee hits (they hang loose; you take MELEE.brokenDamage more), and melee hits taken. */
  readonly broken = new Set<PartName>();
  meleeHits = 0;

  get legStage(): LegStage {
    const h = this.legHits;
    return h >= 5 ? 4 : h >= 3 ? 3 : h === 2 ? 2 : h === 1 ? 1 : 0;
  }

  /** The leg that drags (stage 2), or null. */
  get draggingLeg(): Side | null {
    return this.legStage === 2 ? this.firstLeg : null;
  }

  /** Thigh stumps so far, in the order they happened. */
  get stumps(): Side[] {
    const first = this.firstLeg;
    if (!first) return [];
    return this.legHits >= 5 ? [first, other(first)] : this.legHits >= 3 ? [first] : [];
  }

  /** A hit on a leg (`side`: which one was hit; the ladder decides which leg it hurts). */
  legHit(side: Side): LegHitResult {
    if (this.legHits >= 5) return { kind: 'none' };
    this.firstLeg ??= side;
    const a = this.firstLeg;
    this.legHits++;
    switch (this.legHits) {
      case 1:
        return { kind: 'trip', side };
      case 2:
        return { kind: 'drag', side: a };
      case 3:
        return { kind: 'stump', side: a };
      case 4:
        return { kind: 'trip', side: other(a) };
      default:
        return { kind: 'stump', side: other(a) };
    }
  }

  addHole(h: Hole): void {
    this.holes.push(h);
    if (this.holes.length > DAMAGE.maxHoles) this.holes.splice(0, this.holes.length - DAMAGE.maxHoles);
  }

  /** Anything a red apple can fix? */
  get repairable(): boolean {
    return this.legHits > 0 || this.dents.size > 0 || this.broken.size > 0;
  }

  /** Red apple: legs and dents are fixed; the bullet holes stay. */
  repair(): void {
    this.legHits = 0;
    this.firstLeg = null;
    this.dents.clear();
    // (L5: broken limbs mend too; the melee weapon stays: no gun back until you die)
    this.broken.clear();
    this.meleeHits = 0;
  }

  /** Respawn: a fresh body. */
  reset(): void {
    this.repair();
    this.holes = [];
    this.hatOff = false;
    this.weapon = 'gun';
  }

  /** For logs: the whole state in a few numbers. */
  summary(): Record<string, unknown> {
    return { legStage: this.legStage, legHits: this.legHits, firstLeg: this.firstLeg, dents: [...this.dents], holes: this.holes.length, weapon: this.weapon, broken: [...this.broken], meleeHits: this.meleeHits };
  }
}

const other = (s: Side): Side => (s === 'front' ? 'back' : 'front');
