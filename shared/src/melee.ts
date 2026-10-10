import RAPIER from '@dimforge/rapier2d-compat';
import type { Aim } from './aim';
import { ARM_REACH, MELEE } from './constants';
import { dist, r2, rv, type Vec2 } from './math';
import { PART_SHAPES, PART_ZONE, type PartName, type Side } from './ragdoll';
import type { Weapon } from './rules';
import { seededRandom } from './bot';
import type { GameWorld } from './world';

type MeleeWeapon = 'bat' | 'mace';

/** A melee swing in progress (L7): one of the two motions, toward the facing it started with. */
interface Swing {
  start: number;
  weapon: MeleeWeapon;
  /** Where the stroke starts (facing frame): the motion's `from`, or later if a wall behind leaves no room. */
  from: number;
  facing: 1 | -1;
  /** The weapon line on the last tick (the hit test sweeps from there to where it is now). */
  last: { hand: Vec2; tip: Vec2 } | null;
  /** It hit someone: no more hit tests this swing. */
  over: boolean;
  /** The first solid thing the weapon touched this swing (for the miss log), if any. */
  scraped?: string;
}

/** The hand: the far end of a lower arm (what holds the gun or the melee weapon; the client draws them from here). */
export function handOf(lowerArm: { x: number; y: number; a: number }): Vec2 {
  const hy = (PART_SHAPES.armFrontLower as { hy: number }).hy;
  return { x: lowerArm.x - Math.sin(lowerArm.a) * hy, y: lowerArm.y + Math.cos(lowerArm.a) * hy };
}

/**
 * L7: where a melee weapon is, from the lower arm holding it: the hand (the lower arm's end) and the weapon's far end,
 * along the arm. The client draws the weapon from the same numbers, so what you see is what hits.
 */
export function weaponLine(lowerArm: { x: number; y: number; a: number }, weapon: MeleeWeapon): { hand: Vec2; tip: Vec2 } {
  const hand = handOf(lowerArm);
  const along = lowerArm.a + Math.PI / 2;
  const len = MELEE.weaponLength[weapon];
  return { hand, tip: { x: hand.x + Math.cos(along) * len, y: hand.y + Math.sin(along) * len } };
}

/** Smooth start and end (the arm winds up and slows into the follow-through). */
const ease = (t: number) => t * t * (3 - 2 * t);

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
  /** L7: after a disarm, the tick the melee weapon is out (hands empty until then). */
  private readonly drawUntil = new Map<string, number>();
  private nextGun = 1;
  /** The crit dice (seeded, so sim runs repeat). Tests can replace it to force a result. */
  roll: () => number = seededRandom(4243);

  constructor(private readonly w: GameWorld) {}

  weaponOf(id: string): Weapon {
    return this.w.damage.get(id)?.weapon ?? 'gun';
  }

  /** L7: hands empty right after a disarm (the bat/mace is being drawn): swings are refused. */
  drawing(id: string): boolean {
    return this.drawLeft(id) > 0;
  }

  drawLeft(id: string): number {
    return Math.max(0, (this.drawUntil.get(id) ?? -Infinity) - this.w.tick);
  }

  /** The arm angle of a swing in progress (the world gives it to the body), or null (none, or settling: arm loose). */
  swingAngle(id: string): number | null {
    const s = this.swings.get(id);
    if (!s) return null;
    const m = MELEE.motions[s.weapon];
    const t = this.w.tick - s.start - m.windup; // (wind-up: hold the start angle while the arm gets there)
    if (t >= m.ticks) return null;
    const th = s.from + (m.to - s.from) * ease(Math.max(0, t) / m.ticks);
    return s.facing > 0 ? th : Math.PI - th;
  }

  /** L7: after the swing the gun arm goes loose for a moment, so the weapon swings on with its momentum and settles. */
  settling(id: string): boolean {
    const s = this.swings.get(id);
    return !!s && this.w.tick - s.start >= MELEE.motions[s.weapon].windup + MELEE.motions[s.weapon].ticks;
  }

  // ---- critical hits ----

  /** A bullet hit a player who's still alive: in the air, a MELEE.critAirChance critical hit. */
  onBulletHit(victim: string, by: string): void {
    const p = this.w.players.get(victim);
    if (!p || p.grounded || this.weaponOf(victim) !== 'gun') return;
    // L7: only a real jump or fall counts, not the tiny hops while running
    const airTicks = p.airTicks(this.w.tick);
    if (airTicks < MELEE.critMinAirTicks) return;
    const roll = this.roll();
    if (roll < MELEE.critAirChance) this.crit(victim, by, 'air_shot', { roll: r2(roll), airTicks });
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

  /**
   * M3 Melee Mayhem: a bat or a mace in the hands from the start of a life (no gun to drop, nothing to draw). The world
   * calls it on every spawn and respawn.
   */
  arm(id: string): void {
    const dmg = this.w.damage.get(id);
    if (!dmg) return;
    const weapon: Weapon = this.roll() < 0.5 ? 'bat' : 'mace';
    dmg.weapon = weapon;
    this.drawUntil.delete(id);
    this.w.log.info('armed', { id, weapon });
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
    this.drawUntil.set(victim, this.w.tick + MELEE.drawTicks);
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
    this.w.twist(body, -p.facing * g.spin * body.principalInertia()); // L7: it tumbles away
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
    this.drawUntil.delete(id);
  }

  /** Knocked-away guns for the snapshot (props): where, which way, whose. */
  gunProps(): { id: number; owner: string; x: number; y: number; angle: number }[] {
    return this.guns.map((g) => ({ id: g.id, owner: g.owner, ...g.body.translation(), angle: g.body.rotation() }));
  }

  // ---- melee ----

  /**
   * A swing starts (the world checked it's allowed: alive, cooldown, stamina, weapon drawn). L7: toward where you face;
   * the click's aim isn't used (no pointer for melee).
   */
  startSwing(id: string, _aim: Aim): void {
    const p = this.w.player(id);
    const weapon = this.weaponOf(id);
    if (weapon === 'gun') return;
    const from = this.roomyStart(id, weapon, p.facing);
    this.swings.set(id, { start: this.w.tick, weapon, from, facing: p.facing, last: null, over: false });
    this.w.log.info('melee_swing', { who: id, weapon, motion: weapon === 'bat' ? 'upswing' : 'sweep', facing: p.facing, ...(from !== MELEE.motions[weapon].from ? { shortFrom: r2(from) } : {}) });
  }

  /**
   * L7: where the stroke can start. With a wall or a step behind you, the motion's wind-up spot (low behind) is inside it:
   * the arm jammed against the wall there and the weapon never came round to the front (play log: every swing in the
   * right corner missed). So the start moves along the motion toward the front until the weapon has room.
   */
  private roomyStart(id: string, weapon: MeleeWeapon, facing: 1 | -1): number {
    const m = MELEE.motions[weapon];
    const shoulder = this.w.player(id).jointPos('shoulderFront');
    const reach = ARM_REACH + MELEE.weaponLength[weapon];
    const step = Math.sign(m.to - m.from) * 0.2;
    for (let th = m.from; Math.sign(m.to - th) === Math.sign(step); th += step) {
      const a = facing > 0 ? th : Math.PI - th;
      const tip = { x: shoulder.x + Math.cos(a) * reach, y: shoulder.y + Math.sin(a) * reach };
      if (!this.w.castFixed(shoulder, tip)) return th;
    }
    return m.to;
  }

  /** Every tick (before physics): swings reach their hit tick, and finished ones end. */
  preStep(): void {
    // L7: the weapon is out: log the moment the empty-hands window ends
    for (const [id, until] of [...this.drawUntil]) {
      if (this.w.tick < until) continue;
      this.drawUntil.delete(id);
      if (this.w.stats.get(id)?.alive) this.w.log.info('disarm_draw', { id, weapon: this.weaponOf(id) });
    }
    for (const [id, s] of [...this.swings]) {
      const m = MELEE.motions[s.weapon];
      const t = this.w.tick - s.start;
      if (!this.w.stats.get(id)?.alive) this.swings.delete(id);
      else if (t >= m.windup + m.ticks + m.settleTicks) this.swings.delete(id);
      else this.testSwing(id, s, t);
    }
  }

  /**
   * L7: the hit test along the weapon as drawn. Between the weapon's place last tick and now, a few lines (hand to
   * tip) are cast; the first enemy part one meets is hit, and a wall or crate first stops the swing. Only during the
   * motion's active ticks, once per swing.
   */
  private testSwing(id: string, s: Swing, t: number): void {
    const p = this.w.players.get(id);
    if (!p || p.lost.has('armFrontLower')) return;
    const arm = p.parts.armFrontLower;
    const now = weaponLine({ ...arm.translation(), a: arm.rotation() }, s.weapon);
    const m = MELEE.motions[s.weapon];
    const from = m.windup + Math.round(m.activeFrom * m.ticks);
    const to = m.windup + m.ticks + m.activeAfter;
    if (!s.over && t >= from && t <= to && s.last) {
      const lerp = (a: Vec2, b: Vec2, k: number) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      for (let k = 1; k <= 4 && !s.over; k++) {
        const hand = lerp(s.last.hand, now.hand, k / 4);
        const tip = lerp(s.last.tip, now.tip, k / 4);
        const hit = this.w.meleeRay(hand, tip, id);
        if (!hit) continue;
        if (hit.ownerId && hit.part) {
          s.over = true;
          this.hit(id, hit.ownerId, hit.part, hit.point, s, { x: now.tip.x - s.last.tip.x, y: now.tip.y - s.last.tip.y }, t);
        } else s.scraped ??= hit.label;
        // A wall, step or the floor stops the weapon going THROUGH it (the line ends at what it touches first, so nobody
        // is hit behind a wall), but it doesn't end the swing: in a corner the bat's backswing touched the wall behind
        // and cancelled every swing before it came round to the enemy in front (play log: 15 of 27 swings).
      }
      if (!s.over && t === to) this.w.log.info('melee_miss', { who: id, weapon: s.weapon, scraped: s.scraped ?? null });
    }
    s.last = now;
  }

  private hit(by: string, victim: string, part: PartName, at: Vec2, s: Swing, swingDir: Vec2, t: number): void {
    const dmg = this.w.damage.get(victim)!;
    const zone = PART_ZONE[part];
    const v = this.w.player(victim);
    // knocked the way the weapon was moving (the bat's upswing lifts; the sweep shoves along the floor), a little up
    const len = Math.hypot(swingDir.x, swingDir.y) || 1;
    const dir = { x: swingDir.x / len, y: swingDir.y / len };
    for (const b of v.attached()) this.w.push(b, { x: dir.x * MELEE.push * b.mass(), y: (Math.min(0, dir.y) * MELEE.push - 1) * b.mass() });
    // the mace's low sweep takes the legs out; any other hit (body, head, arms) makes the victim stagger back
    if (this.w.stats.get(victim)?.alive) {
      if (MELEE.motions[s.weapon].trips && zone === 'leg') v.trip(this.w.tick, `melee_sweep:${by}`, Math.sign(dir.x) || s.facing);
      else v.staggerBack(this.w.tick, Math.sign(dir.x) || s.facing, `melee_hit:${by}`);
    }
    dmg.meleeHits++;
    const broke = (zone === 'arm' || zone === 'leg') && !dmg.broken.has(limbOf(part));
    if (broke) dmg.broken.add(limbOf(part));
    const amount = zone === 'head' ? MELEE.headDamage : MELEE.damage;
    this.w.log.info('melee_hit', { who: by, victim, part, zone, broke, weapon: s.weapon, tick: t, meleeHits: dmg.meleeHits, d: r2(dist(this.w.player(by).jointPos('shoulderFront'), at)) });
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

