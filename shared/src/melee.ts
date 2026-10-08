import RAPIER from '@dimforge/rapier2d-compat';
import type { Aim } from './aim';
import { MELEE } from './constants';
import { dist, r2, rv, type Vec2 } from './math';
import { PART_ZONE, type PartName, type Side } from './ragdoll';
import type { Weapon } from './rules';
import { seededRandom } from './bot';
import type { GameWorld } from './world';

/** A melee swing in progress: the arm sweeps through its arc; the hit is checked once, at MELEE.swing.hitTick. */
interface Swing {
  start: number;
  /** The aim it was swung at, and the facing then (the arc sweeps toward the facing). */
  angle: number;
  facing: 1 | -1;
  done: boolean;
}

/**
 * Collision groups of a knocked-away gun (16 "I am" bits + 16 "I touch" bits): it is bit 0 and touches only bit 0.
 * Walls, floors and crates are every bit, so it lands on them; players are bits 1-15 (see the Ragdoll), so it never
 * touches a player: a prop nobody can pick up mustn't trip or pin anyone (the L5 bots sim had one land on a lying
 * player in a corner and keep them down). Bullets pass through it too (`GameWorld.raycast`).
 */
const DROPPED_GUN_GROUPS = ((1 << 16) | 1) >>> 0;

/** A gun a critical hit knocked away: a loose object on the floor until its owner respawns (nobody can pick it up). */
interface DroppedGun {
  id: number;
  owner: string;
  body: RAPIER.RigidBody;
}

/**
 * L5: critical hits and melee, decided on the server's world (clients draw what snapshots and events say).
 * - A critical hit knocks the gun away: from then on the player fights with a melee weapon (bat or mace, the same but
 *   for the look) until they die. Triggers: a bullet hitting you in the air (MELEE.critAirChance, seeded), or a boxing
 *   glove punching you into a wall (a SPLAT within MELEE.gloveSplatTicks of the glove hit: always).
 * - A melee swing (the same click / fire message as a shot) sweeps the arm through an arc; at its hit tick the nearest
 *   enemy body part within reach and the arc, with nothing fixed in between, is hit: damage, a push, and the limb is
 *   broken (it hangs; that player takes more damage). The MELEE.shatterAfter-th melee hit breaks the body into pieces.
 */
export class Melee {
  private readonly swings = new Map<string, Swing>();
  private readonly guns: DroppedGun[] = [];
  private readonly gloveAt = new Map<string, number>();
  private nextGun = 1;
  /** The crit dice (seeded, so sim runs repeat). Tests can replace it to force a result. */
  roll: () => number = seededRandom(4243);

  constructor(private readonly w: GameWorld) {}

  weaponOf(id: string): Weapon {
    return this.w.damage.get(id)?.weapon ?? 'gun';
  }

  /** The arm angle of a swing in progress (the world gives it to the body), or null. */
  swingAngle(id: string): number | null {
    const s = this.swings.get(id);
    if (!s) return null;
    const t = Math.min(1, (this.w.tick - s.start) / MELEE.swing.swingTicks);
    const rel = MELEE.swing.from + (MELEE.swing.to - MELEE.swing.from) * t;
    return s.angle + rel * s.facing;
  }

  // ---- critical hits ----

  /** A bullet hit a player who's still alive: in the air, a MELEE.critAirChance critical hit. */
  onBulletHit(victim: string, by: string): void {
    const p = this.w.players.get(victim);
    if (!p || p.grounded || this.weaponOf(victim) !== 'gun') return;
    const roll = this.roll();
    if (roll < MELEE.critAirChance) this.crit(victim, by, 'air_shot', { roll: r2(roll) });
  }

  /** A boxing glove hit someone: a wall SPLAT soon after is a critical hit. */
  onGlove(victim: string): void {
    this.gloveAt.set(victim, this.w.tick);
  }

  /** Someone splatted into a wall: punched there by a glove = a critical hit. */
  onSplat(victim: string, by: string | null): void {
    const at = this.gloveAt.get(victim);
    if (at === undefined || this.w.tick - at > MELEE.gloveSplatTicks || this.weaponOf(victim) !== 'gun') return;
    this.gloveAt.delete(victim);
    this.crit(victim, by, 'glove_splat', { afterTicks: this.w.tick - at });
  }

  /** The gun flies out of the hands; a melee weapon from now on (until death). */
  private crit(victim: string, by: string | null, trigger: string, why: Record<string, unknown>): void {
    const dmg = this.w.damage.get(victim);
    const st = this.w.stats.get(victim);
    const p = this.w.players.get(victim);
    if (!dmg || !st?.alive || !p) return;
    const weapon: Weapon = this.roll() < 0.5 ? 'bat' : 'mace';
    dmg.weapon = weapon;
    if (st.held) {
      this.w.log.info('held_lost', { id: victim, kind: st.held, why: 'crit' });
      st.held = null; // (a special round was in the gun)
    }
    this.dropGun(victim);
    this.w.log.info('crit', { who: victim, by, trigger, weapon, ...why });
    this.w.emit({ type: 'crit', id: victim, by, weapon, pos: { ...p.parts.head.translation() } });
    this.w.callout('disarmed', victim, by, p.parts.head.translation(), 1, { trigger });
  }

  /** A real loose gun, kicked out of the front hand; it lies around until its owner respawns. */
  private dropGun(owner: string): void {
    const p = this.w.player(owner);
    const hand = p.parts.armFrontLower.translation();
    const g = MELEE.gun;
    const body = this.w.physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(hand.x, hand.y - 0.2).setRotation(p.parts.armFrontLower.rotation() + Math.PI / 2));
    const collider = this.w.physics.createCollider(RAPIER.ColliderDesc.cuboid(g.hx, g.hy).setDensity(6).setFriction(0.8).setCollisionGroups(DROPPED_GUN_GROUPS), body);
    const id = this.nextGun++;
    this.w.registerCollider(collider, body, `dropped_gun:${owner}:${id}`);
    this.w.push(body, { x: -p.facing * g.kick * body.mass(), y: -g.kick * body.mass() });
    this.guns.push({ id, owner, body });
    this.w.log.info('gun_dropped', { id: owner, at: rv(hand) });
  }

  /** The owner respawned or left: their knocked-away gun goes. */
  clearOwner(id: string): void {
    for (const g of this.guns.filter((x) => x.owner === id)) {
      this.w.removeBody(g.body);
      this.guns.splice(this.guns.indexOf(g), 1);
    }
    this.swings.delete(id);
    this.gloveAt.delete(id);
  }

  /** Knocked-away guns for the snapshot (props): where, which way, whose. */
  gunProps(): { id: number; owner: string; x: number; y: number; angle: number }[] {
    return this.guns.map((g) => ({ id: g.id, owner: g.owner, ...g.body.translation(), angle: g.body.rotation() }));
  }

  // ---- melee ----

  /** A swing starts (the world checked it's allowed: alive, cooldown, stamina). */
  startSwing(id: string, aim: Aim): void {
    const p = this.w.player(id);
    this.swings.set(id, { start: this.w.tick, angle: aim.angle, facing: p.facing, done: false });
    this.w.log.info('melee_swing', { who: id, weapon: this.weaponOf(id), angleDeg: Math.round((aim.angle * 180) / Math.PI), facing: p.facing });
  }

  /** Every tick (before physics): swings reach their hit tick, and finished ones end. */
  preStep(): void {
    for (const [id, s] of [...this.swings]) {
      const t = this.w.tick - s.start;
      if (!this.w.stats.get(id)?.alive) this.swings.delete(id);
      else if (!s.done && t >= MELEE.swing.hitTick) {
        s.done = true;
        this.resolveSwing(id, s);
      } else if (t >= MELEE.swing.swingTicks) this.swings.delete(id);
    }
  }

  /** The nearest enemy part within reach and the arc, with no wall in between, takes the hit. */
  private resolveSwing(id: string, s: Swing): void {
    const p = this.w.players.get(id);
    if (!p) return;
    const shoulder = p.jointPos('shoulderFront');
    let best: { victim: string; part: PartName; at: Vec2; d: number } | null = null;
    for (const [vid, v] of this.w.players) {
      if (vid === id || !this.w.stats.get(vid)?.alive) continue;
      for (const part of Object.keys(v.parts) as PartName[]) {
        if (v.lost.has(part)) continue;
        const at = v.parts[part].translation();
        const d = dist(shoulder, at);
        const toward = Math.atan2(at.y - shoulder.y, at.x - shoulder.x) - s.angle;
        const off = Math.abs(Math.atan2(Math.sin(toward), Math.cos(toward))); // how far off the aim (rad)
        if (d > MELEE.reach || off > MELEE.arc || (best && d >= best.d)) continue;
        if (this.w.castFixed(shoulder, at)) continue; // a wall in between
        best = { victim: vid, part, at: { ...at }, d };
      }
    }
    if (!best) {
      this.w.log.info('melee_miss', { who: id });
      return;
    }
    if (best.d > MELEE.reach + 0.01) this.w.anomaly('melee_too_far', id, { d: r2(best.d), reach: MELEE.reach }, 'error');
    this.hit(id, best.victim, best.part, best.at, s);
  }

  private hit(by: string, victim: string, part: PartName, at: Vec2, s: Swing): void {
    const dmg = this.w.damage.get(victim)!;
    const zone = PART_ZONE[part];
    const v = this.w.player(victim);
    // knocked along the swing
    const dir = { x: Math.cos(s.angle), y: Math.sin(s.angle) };
    for (const b of v.attached()) this.w.push(b, { x: dir.x * MELEE.push * b.mass(), y: (dir.y * MELEE.push - 1) * b.mass() });
    dmg.meleeHits++;
    const broke = (zone === 'arm' || zone === 'leg') && !dmg.broken.has(limbOf(part));
    if (broke) dmg.broken.add(limbOf(part));
    const amount = zone === 'head' ? MELEE.headDamage : MELEE.damage;
    this.w.log.info('melee_hit', { who: by, victim, part, zone, broke, meleeHits: dmg.meleeHits, d: r2(dist(this.w.player(by).jointPos('shoulderFront'), at)) });
    this.w.emit({ type: 'melee_hit', id: victim, by, part, pos: { ...at }, broke });
    if (dmg.meleeHits >= MELEE.shatterAfter) {
      this.w.shatter(victim, by);
      return;
    }
    this.w.hurt(victim, by, amount, at, { zone, part, cause: 'melee' });
  }
}

/** The limb a part belongs to, by its upper part (a broken lower arm breaks the arm). */
function limbOf(part: PartName): PartName {
  return part === 'armFrontLower' ? 'armFrontUpper' : part === 'armBackLower' ? 'armBackUpper' : part === 'legFrontLower' ? 'legFrontUpper' : part === 'legBackLower' ? 'legBackUpper' : part;
}

/** Which arms / legs are broken (for the body's mods). */
export function brokenSides(broken: Set<PartName>): { arms: Side[]; legs: Side[] } {
  return {
    arms: (['front', 'back'] as const).filter((s) => broken.has(s === 'front' ? 'armFrontUpper' : 'armBackUpper')),
    legs: (['front', 'back'] as const).filter((s) => broken.has(s === 'front' ? 'legFrontUpper' : 'legBackUpper')),
  };
}

