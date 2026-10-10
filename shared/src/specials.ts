import RAPIER from '@dimforge/rapier2d-compat';
import { GRAVITY_Y, PICKUP, PIN, SPECIAL, SPLAT } from './constants';
import { add, dist, length, normalize, r2, rotate, rv, scale, sub, type Vec2 } from './math';
import { bananaVelocities } from './projectile';
import { PART_NAMES, PART_ZONE, type PartName } from './ragdoll';
import { seededRandom } from './bot';
import type { Arrow, GameWorld, Hit } from './world';

/**
 * Power-ups (S5): bubbles you shoot to get ONE special arrow for your next shot, and what each special arrow does.
 * Also wall pins (normal arrows that nail a limb to a wall) and SPLAT! (hitting a wall fast). All decided here, on
 * the server's world; clients only draw what snapshots and events tell them.
 */
export type SpecialKind = 'glove' | 'balloon' | 'oil' | 'plunger' | 'bomb' | 'banana' | 'swap' | 'feather';
export type ArrowKind = 'normal' | SpecialKind;
export const SPECIAL_KINDS: SpecialKind[] = ['glove', 'balloon', 'oil', 'plunger', 'bomb', 'banana', 'swap', 'feather'];
/** Network codes (0 = none / normal). */
export const kindCode = (k: ArrowKind | null): number => (k && k !== 'normal' ? SPECIAL_KINDS.indexOf(k) + 1 : 0);
export const kindFromCode = (c: number): SpecialKind | null => SPECIAL_KINDS[c - 1] ?? null;

export interface Bubble {
  label: string;
  home: Vec2;
  kind: SpecialKind;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** Tick it was shot, or null while it's up. */
  takenAt: number | null;
}

/** Things in the world clients must draw that aren't bodies (sent in snapshots as "props"). */
export type PropType = 'puddle' | 'balloon' | 'rope' | 'gun';
export const PROP_CODE: Record<PropType, number> = { puddle: 1, balloon: 2, rope: 3, gun: 4 };
/** `a`, `b` mean: puddle: width ×10; balloon: victim slot, part index; rope: shooter slot, victim slot; gun (L5): owner
 * slot, angle byte. x/y: puddle top center / balloon center / where the rope is tied on the victim / the gun's center. */
export interface Prop {
  id: number;
  type: PropType;
  a: number;
  b: number;
  x: number;
  y: number;
}

interface Puddle {
  id: number;
  x: number;
  y: number;
  w: number;
  until: number;
  by: string;
}
interface Balloon {
  id: number;
  victim: string;
  part: PartName;
  arrow: number;
  by: string;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** L7: it reached the float cap once (logged once). */
  capped?: boolean;
}
interface Rope {
  id: number;
  shooter: string;
  victim: string;
  part: PartName;
  arrow: number;
  until: number;
}
interface Pin {
  part: PartName;
  joint: RAPIER.ImpulseJoint;
  point: Vec2;
}

/** What a special hit means for the normal hit handling in the world. */
export interface SpecialHitResult {
  /** Share of normal damage (0 = none, but it still counts as the last hit for kill credit). */
  damageShare: number;
  /** L3: the round stays on what it hit, as an object (a sticky bomb; a plunger that caught someone). Else it vanishes. */
  stick: boolean;
  /** Normal follow-ups (callouts by zone, trip, arrow effects) only for arrows that act like normal ones. */
  normal: boolean;
}

export class Specials {
  readonly bubbles: Bubble[] = [];
  private puddles: Puddle[] = [];
  private balloons: Balloon[] = [];
  private ropes: Rope[] = [];
  private readonly pins = new Map<string, Pin>();
  private nextProp = 1;
  /** Bubble contents in this order (tests, netsim); otherwise random (seeded, so sim runs repeat). */
  order: SpecialKind[] | null = null;
  private orderIndex = 0;
  private readonly rand = seededRandom(9157);
  private readonly lastVx = new Map<string, number>();
  private readonly splatAt = new Map<string, number>();

  constructor(private readonly w: GameWorld) {}

  // ---- bubbles ----

  addBubble(home: Vec2): Bubble {
    const body = this.w.physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(home.x, home.y));
    const collider = this.w.physics.createCollider(RAPIER.ColliderDesc.ball(PICKUP.radius).setSensor(true), body);
    const label = `bubble:${this.bubbles.length + 1}`;
    this.w.registerCollider(collider, body, label);
    const bubble: Bubble = { label, home, kind: this.nextKind(), body, collider, takenAt: null };
    this.bubbles.push(bubble);
    this.w.log.info('pickup_spawn', { pickup: label, kind: bubble.kind, p: rv(home) });
    return bubble;
  }

  private nextKind(): SpecialKind {
    if (this.order?.length) return this.order[this.orderIndex++ % this.order.length];
    return SPECIAL_KINDS[Math.floor(this.rand() * SPECIAL_KINDS.length)];
  }

  /** Sets what bubbles hold from now on (in this order), and refills the ones that are up. Tests and netsim use it. */
  setOrder(order: SpecialKind[]): void {
    this.order = order;
    this.orderIndex = 0;
    for (const b of this.bubbles) {
      if (b.takenAt !== null) continue;
      b.kind = this.nextKind();
      this.w.log.info('pickup_spawn', { pickup: b.label, kind: b.kind, p: rv(b.home), refill: true });
    }
  }

  /** The shootable sensor this collider belongs to: a bubble or a balloon. */
  targetOf(c: RAPIER.Collider): { bubble?: Bubble; balloon?: Balloon } | null {
    const bubble = this.bubbles.find((b) => b.collider.handle === c.handle);
    if (bubble) return { bubble };
    const balloon = this.balloons.find((b) => b.collider.handle === c.handle);
    return balloon ? { balloon } : null;
  }

  /** An arrow hit a bubble (the shooter gets its arrow) or a balloon (pop!). The arrow is used up either way. */
  shootTarget(arrow: Arrow, t: { bubble?: Bubble; balloon?: Balloon }, point: Vec2): void {
    arrow.state = 'gone';
    if (t.bubble) {
      const b = t.bubble;
      b.takenAt = this.w.tick;
      b.collider.setEnabled(false);
      const st = this.w.stats.get(arrow.ownerId);
      const got = st?.alive ? b.kind : null;
      if (st && got) st.held = got;
      this.w.log.info('pickup_taken', { pickup: b.label, kind: b.kind, by: arrow.ownerId, arrow: arrow.id, held: got });
      this.w.emit({ type: 'pickup', label: b.label, kind: b.kind, by: arrow.ownerId, pos: point });
    } else if (t.balloon) {
      this.popBalloon(t.balloon, `shot:${arrow.ownerId}`);
    }
  }

  // ---- special hits ----

  /**
   * What a special arrow does when it hits. `victim`: the player and part it hit, if any.
   * Normal arrows (and banana pieces) return null: the world handles them as usual.
   */
  onHit(arrow: Arrow, hit: Hit, victim: { id: string; part: PartName } | null): SpecialHitResult | null {
    const kind = arrow.kind;
    if (kind === 'normal' || kind === 'banana') return null;
    const dir = normalize(arrow.vel);
    const tick = this.w.tick;
    const share = SPECIAL.damageShare[kind];
    const alive = victim ? this.w.stats.get(victim.id)?.alive && !this.w.frozen && !this.w.stats.get(victim.id)!.isProtected(tick) : false;
    switch (kind) {
      case 'glove': {
        if (victim && alive) {
          const p = this.w.player(victim.id);
          const g = SPECIAL.glove;
          const dx = Math.sign(dir.x) || 1;
          for (const b of p.attached()) this.w.push(b, { x: (dir.x * g.speed + dx * 2) * b.mass(), y: (dir.y * g.speed * 0.4 - g.lift) * b.mass() });
          p.stun(tick, g.stunTicks, `glove:${arrow.id}`);
          this.w.dent(victim.id, victim.part, arrow.ownerId); // L4: the part stays dented in the shape of a fist
          this.w.melee.onGlove(victim.id); // L5: punched into a wall now = a critical hit
          this.w.callout('outta_here', victim.id, arrow.ownerId, hit.point, 1, { arrow: arrow.id });
        } else {
          const body = hit.collider.parent();
          if (body?.isDynamic()) this.w.push(body, scale(dir, SPECIAL.glove.speed * body.mass()), hit.point);
        }
        this.w.log.info('special_hit', { kind, arrow: arrow.id, by: arrow.ownerId, target: hit.label });
        return { damageShare: share, stick: false, normal: false };
      }
      case 'balloon': {
        // the round vanishes; the balloon itself (a prop) is the object that stays
        if (victim && alive) this.attachBalloon(victim.id, victim.part, arrow.id, arrow.ownerId);
        return { damageShare: share, stick: false, normal: false };
      }
      case 'oil': {
        this.spillOil(hit.point, arrow.ownerId);
        return { damageShare: share, stick: false, normal: false };
      }
      case 'plunger': {
        // the plunger stays stuck on the victim while its rope pulls; missed (a wall, nobody to pull): it vanishes
        const pulls = !!victim && !!alive && victim.id !== arrow.ownerId && this.w.players.has(arrow.ownerId);
        if (pulls) {
          const until = tick + SPECIAL.plunger.ticks;
          for (const old of this.ropes.filter((r) => r.victim === victim.id)) this.dropArrow(old.arrow);
          this.ropes = this.ropes.filter((r) => r.victim !== victim.id);
          this.ropes.push({ id: this.nextProp++, shooter: arrow.ownerId, victim: victim.id, part: victim.part, arrow: arrow.id, until });
          this.w.log.info('rope_start', { shooter: arrow.ownerId, victim: victim.id, part: victim.part, until });
        }
        return { damageShare: share, stick: pulls, normal: false };
      }
      case 'bomb': {
        arrow.fuseAt = tick + SPECIAL.bomb.fuseTicks;
        this.w.log.info('bomb_stuck', { arrow: arrow.id, by: arrow.ownerId, on: hit.label, fuseAt: arrow.fuseAt });
        return { damageShare: share, stick: true, normal: false };
      }
      case 'swap': {
        if (victim && alive && victim.id !== arrow.ownerId && this.w.stats.get(arrow.ownerId)?.alive) this.swap(arrow.ownerId, victim.id);
        return { damageShare: share, stick: false, normal: false };
      }
      case 'feather': {
        if (victim && alive) {
          const { effect } = this.w.effects.get(victim.id)!.add('laugh', victim.part, tick);
          this.w.log.info('effect_start', { id: victim.id, kind: 'laugh', part: victim.part, arrow: arrow.id, until: effect.end, refreshed: false });
          this.w.callout('tickled', victim.id, arrow.ownerId, hit.point, 0.5, { arrow: arrow.id });
        }
        return { damageShare: share, stick: false, normal: false };
      }
    }
  }

  /**
   * Wall pin: a normal bullet through an arm or leg with a wall right behind the hit nails that limb there (L3: the
   * bullet is gone; the limb is held against a bullet hole in the wall, sent as an `impact` there).
   */
  tryPin(arrow: Arrow, hit: Hit, victim: { id: string; part: PartName }, impactVel: Vec2): void {
    const zone = PART_ZONE[victim.part];
    if ((zone !== 'arm' && zone !== 'leg') || !this.w.stats.get(victim.id)?.alive) return;
    // (L4: not a body lying down: getting up with a leg nailed to a wall bent the knee 0.2 rad backward, sim chaos;
    // the pin is for someone standing, and is tested that way)
    if (this.w.player(victim.id).down) return;
    // (L6: nor a body flying past: nailing a shin of a body moving 3.8 m/s off a trampoline yanked the knee 0.5 rad past
    // its limit in one tick, before the pin could tear out; sim arena_fights)
    const speed = length(this.w.player(victim.id).parts.torso.linvel());
    if (speed > PIN.maxSpeed) {
      this.w.log.info('pin_refused', { id: victim.id, part: victim.part, why: 'moving', speed: r2(speed) });
      return;
    }
    const dir = normalize(impactVel); // (the bullet's own velocity is already 0: it's gone)
    const wall = this.w.castFixed(hit.point, add(hit.point, scale(dir, PIN.reach)));
    if (!wall) return;
    const part = this.w.player(victim.id).parts[victim.part];
    const wallBody = wall.collider.parent()!;
    this.unpin(victim.id, 'replaced');
    const p = wall.point;
    const local = (b: RAPIER.RigidBody) => rotate(sub(p, b.translation()), -b.rotation());
    const joint = this.w.physics.createImpulseJoint(RAPIER.JointData.revolute(local(part), local(wallBody)), part, wallBody, true);
    this.pins.set(victim.id, { part: victim.part, joint, point: p });
    const { effect } = this.w.effects.get(victim.id)!.add('pinned', victim.part, this.w.tick);
    this.w.impact(p, Math.atan2(dir.y, dir.x), 'wall');
    this.w.log.info('pin_start', { id: victim.id, part: victim.part, wall: wall.label, at: rv(p), until: effect.end, arrow: arrow.id });
    this.w.callout('pinned', victim.id, arrow.ownerId, p, 0.8, { part: victim.part });
  }

  /** A jump press while pinned: struggle free a bit sooner. */
  mash(id: string): void {
    const e = this.w.effects.get(id)?.get('pinned');
    if (!e) return;
    e.end = Math.max(this.w.tick + 1, e.end - PIN.mashTicks);
    this.w.log.info('pin_mash', { id, until: e.end });
  }

  /** The world says an effect ended (time, death, removal): clean up what belongs to it. */
  onEffectEnd(id: string, kind: string): void {
    if (kind === 'pinned') this.unpin(id, 'time');
    if (kind === 'balloon') {
      const b = this.balloons.find((x) => x.victim === id);
      if (b) this.removeBalloon(b, 'time');
    }
  }

  // ---- every tick ----

  /** Before the physics step: bubbles, balloon lift, rope pulls, puddles, bombs. */
  preStep(): void {
    const tick = this.w.tick;
    for (const b of this.bubbles) {
      if (b.takenAt !== null && tick - b.takenAt >= PICKUP.respawnTicks) {
        b.takenAt = null;
        b.kind = this.nextKind();
        b.collider.setEnabled(true);
        this.w.log.info('pickup_spawn', { pickup: b.label, kind: b.kind, p: rv(b.home) });
      }
      const bob = PICKUP.bobAmplitude * Math.sin((2 * Math.PI * tick) / PICKUP.bobPeriodTicks);
      b.body.setNextKinematicTranslation({ x: b.home.x, y: b.home.y + bob });
    }
    for (const b of this.balloons) {
      const p = this.w.players.get(b.victim);
      if (!p) continue;
      const part = p.parts[b.part];
      const mass = p.attached().reduce((m, x) => m + x.mass(), 0);
      const B = SPECIAL.balloon;
      const floating = b.part === 'torso' || b.part === 'head';
      const full = floating ? B.torsoLift : B.limbLift;
      // Ease off near the top rising speed: from the full lift when still, to just holding the weight at riseSpeed.
      const torso = p.parts.torso;
      const up = -torso.linvel().y;
      const ease = Math.max(0, Math.min(1, 1 - up / B.riseSpeed));
      let share = Math.min(full, 1) + (full - Math.min(full, 1)) * ease;
      if (floating) {
        // L7 swimming: jump swims up, crouch swims down
        if (p.controls.jump) share += B.swimUp;
        if (p.controls.crouch) share -= B.swimDown;
        // L7 max float: at most topMargin under the arena's top, hovering there (more than holding the weight above
        // it would carry the body off the top of the screen); the higher over the cap, the less lift, damped
        const over = B.topMargin - torso.translation().y;
        if (over > -0.5) share = Math.min(share, 1 - Math.max(0, over + 0.5) * 1.5 - up * 0.6);
        if (over > -0.5 && !b.capped) { // (logged when the cap starts holding it: it settles just under the cap)
          b.capped = true;
          this.w.log.info('balloon_float_cap', { id: b.victim, y: r2(torso.translation().y), cap: B.topMargin });
        }
        // ...and in from the sides: a soft push back toward the middle
        const x = torso.translation().x;
        const side = x < B.sideMargin ? B.sideMargin - x : x > this.w.bounds.width - B.sideMargin ? this.w.bounds.width - B.sideMargin - x : 0;
        if (side !== 0) {
          const vx = torso.linvel().x;
          for (const pb of p.attached()) this.w.push(pb, { x: (side * B.sideSpring - vx * 2) * pb.mass() * (1 / 60), y: 0 });
        }
      }
      this.w.push(part, { x: 0, y: -share * mass * GRAVITY_Y * (1 / 60) });
      const at = part.translation();
      b.body.setNextKinematicTranslation({ x: at.x, y: at.y - SPECIAL.balloon.string });
    }
    // a balloon that reaches the arena's top edge pops (the arena's top is y 0): nobody floats away out of the arena
    for (const b of this.balloons.filter((x) => x.body.translation().y < SPECIAL.balloon.popBelowTop)) this.popBalloon(b, 'ceiling');
    this.ropes = this.ropes.filter((r) => {
      const v = this.w.players.get(r.victim);
      const s = this.w.players.get(r.shooter);
      const ok = tick < r.until && v && s && this.w.stats.get(r.victim)?.alive && this.w.stats.get(r.shooter)?.alive;
      if (!ok) {
        this.dropArrow(r.arrow);
        this.w.log.info('rope_end', { shooter: r.shooter, victim: r.victim, reason: tick >= r.until ? 'time' : 'gone' });
        return false;
      }
      const to = normalize(sub(s.center(), v.center()));
      const along = v.speedX() * to.x; // speed already toward the shooter (sideways is what matters most)
      if (along < SPECIAL.plunger.maxSpeed) {
        const dv = SPECIAL.plunger.accel * (1 / 60);
        for (const b of v.attached()) this.w.push(b, { x: to.x * dv * b.mass(), y: to.y * dv * b.mass() });
      }
      return true;
    });
    this.puddles = this.puddles.filter((p) => {
      if (tick < p.until) return true;
      this.w.log.info('oil_end', { id: p.id });
      return false;
    });
    for (const a of this.w.arrows) if (a.fuseAt !== undefined && a.state !== 'gone' && tick >= a.fuseAt) this.explode(a);
  }

  /** After the physics step: SPLAT! checks and oil-slide callouts. */
  postStep(): void {
    const tick = this.w.tick;
    for (const [id, p] of this.w.players) {
      const vx = p.speedX();
      const prev = this.lastVx.get(id) ?? 0;
      this.lastVx.set(id, vx);
      if (p.slippedAt === tick - 1) this.w.callout('slip', id, this.w.stats.get(id)?.lastHit?.by ?? null, p.center(), 0.8, { why: 'oil' });
      if (!this.w.stats.get(id)?.alive || Math.abs(prev) < SPLAT.minSpeed) continue;
      const kept = Math.sign(vx) === Math.sign(prev) ? Math.abs(vx) : 0;
      if (kept > Math.abs(prev) * (1 - SPLAT.dropShare) || tick - (this.splatAt.get(id) ?? -Infinity) < SPLAT.cooldownTicks) continue;
      const c = p.center();
      const wall = this.w.castFixed(c, { x: c.x + Math.sign(prev) * 1.3, y: c.y });
      if (!wall) continue;
      this.splatAt.set(id, tick);
      this.w.log.info('wall_splat', { id, speed: r2(Math.abs(prev)), after: r2(vx), wall: wall.label, at: rv(wall.point) });
      this.w.emit({ type: 'wall_splat', id, pos: wall.point, speed: r2(Math.abs(prev)) });
      this.w.callout('splat', id, this.w.stats.get(id)?.lastHit?.by ?? null, wall.point, Math.min(1, Math.abs(prev) / 14), { speed: r2(Math.abs(prev)) });
      this.w.melee.onSplat(id, this.w.stats.get(id)?.lastHit?.by ?? null);
    }
  }

  /** Feet in a puddle? (the world turns this into the ragdoll's `oiled`). */
  isOiled(id: string): boolean {
    const p = this.w.players.get(id);
    if (!p || !this.puddles.length) return false;
    return p.footPoints().some((sole) => this.puddles.some((d) => sole.x > d.x - d.w / 2 && sole.x < d.x + d.w / 2 && Math.abs(sole.y - d.y) < 0.3));
  }

  /** Death: the held arrow is lost; their balloon pops (ropes end next tick; pins end with the effects). */
  onDeath(id: string): void {
    const st = this.w.stats.get(id);
    if (st?.held) {
      this.w.log.info('held_lost', { id, kind: st.held });
      st.held = null;
    }
    const b = this.balloons.find((x) => x.victim === id);
    if (b) this.popBalloon(b, 'death');
  }

  /** The body is about to be removed (respawn, swap, leaving): drop everything tied to it. */
  onBodyRemoved(id: string): void {
    this.unpin(id, 'removed');
    for (const b of this.balloons.filter((x) => x.victim === id)) this.removeBalloon(b, 'removed');
    this.ropes = this.ropes.filter((r) => r.victim !== id && r.shooter !== id);
  }

  /** Puddles, balloons and ropes for the snapshot. */
  props(): Prop[] {
    const out: Prop[] = [];
    for (const d of this.puddles) out.push({ id: d.id, type: 'puddle', a: Math.round(d.w * 10), b: 0, x: d.x, y: d.y });
    for (const b of this.balloons) {
      if (!this.w.players.has(b.victim)) continue;
      const at = b.body.translation();
      out.push({ id: b.id, type: 'balloon', a: this.w.slotOf(b.victim), b: PART_NAMES.indexOf(b.part), x: at.x, y: at.y });
    }
    for (const r of this.ropes) {
      const v = this.w.players.get(r.victim);
      if (!v || !this.w.players.has(r.shooter)) continue;
      const at = v.parts[r.part].translation();
      out.push({ id: r.id, type: 'rope', a: this.w.slotOf(r.shooter), b: this.w.slotOf(r.victim), x: at.x, y: at.y });
    }
    // L5: knocked-away guns lying around (a = the owner's slot, b = its angle as 0..255 of a full turn)
    for (const g of this.w.melee.gunProps()) {
      if (!this.w.players.has(g.owner)) continue;
      out.push({ id: 10000 + g.id, type: 'gun', a: this.w.slotOf(g.owner), b: angleByte(g.angle), x: g.x, y: g.y });
    }
    return out;
  }

  /** Banana: after its split tick, the flying banana becomes the middle piece and two more pieces appear. */
  splitBananas(newArrow: (from: Arrow, vel: Vec2) => void): void {
    for (const a of this.w.arrows) {
      if (a.kind !== 'banana' || a.state !== 'flying' || this.w.tick - a.firedTick !== SPECIAL.banana.splitTicks) continue;
      const [left, , right] = bananaVelocities(a.vel, SPECIAL.banana.spread);
      a.kind = 'normal';
      newArrow(a, left);
      newArrow(a, right);
      this.w.log.info('banana_split', { arrow: a.id, at: rv(a.pos) });
    }
  }

  // ---- internals ----

  /** Chaos round "Everyone Has Balloons": a balloon on the torso, no arrow, for `ticks`. */
  giveBalloon(id: string, ticks: number): void {
    if (!this.w.stats.get(id)?.alive || this.balloons.some((b) => b.victim === id)) return;
    this.attachBalloon(id, 'torso', -1, null, ticks);
  }

  private attachBalloon(victim: string, hitPart: PartName, arrowId: number, by: string | null, ticks?: number): void {
    // A leg balloon pulls the foot (the end of the leg), an arm balloon the hand: that's what lifts a limb.
    const end: PartName = hitPart === 'legFrontUpper' ? 'legFrontLower' : hitPart === 'legBackUpper' ? 'legBackLower' : hitPart === 'armFrontUpper' ? 'armFrontLower' : hitPart === 'armBackUpper' ? 'armBackLower' : hitPart;
    // (L4: not a shot-off piece: then the stump / upper arm it came off)
    const part: PartName = this.w.player(victim).lost.has(end) ? hitPart : end;
    const old = this.balloons.find((x) => x.victim === victim);
    if (old) this.removeBalloon(old, 'replaced');
    const p = this.w.player(victim);
    const at = p.parts[part].translation();
    const body = this.w.physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y - SPECIAL.balloon.string));
    const collider = this.w.physics.createCollider(RAPIER.ColliderDesc.ball(SPECIAL.balloon.radius).setSensor(true), body);
    const id = this.nextProp++;
    this.w.registerCollider(collider, body, `balloon:${id}`);
    this.balloons.push({ id, victim, part, arrow: arrowId, by: by ?? '', body, collider });
    const { effect } = this.w.effects.get(victim)!.add('balloon', part, this.w.tick, ticks);
    this.w.log.info('balloon_start', { id: victim, part, by, until: effect.end });
  }

  private popBalloon(b: Balloon, reason: string): void {
    const at = { ...b.body.translation() };
    this.removeBalloon(b, reason);
    this.w.effects.get(b.victim)?.remove('balloon');
    this.w.emit({ type: 'balloon_pop', id: b.victim, pos: at });
    this.w.log.info('balloon_pop', { id: b.victim, reason });
  }

  private removeBalloon(b: Balloon, reason: string): void {
    this.balloons = this.balloons.filter((x) => x !== b);
    this.w.dropArrowsOn(b.body, 'balloon_removed');
    this.w.physics.removeRigidBody(b.body);
    this.dropArrow(b.arrow);
    this.w.log.info('balloon_end', { id: b.victim, reason });
  }

  private spillOil(point: Vec2, by: string): void {
    // the puddle lands on the floor under the hit
    const floor = this.w.castFixed({ x: point.x, y: point.y - 0.05 }, { x: point.x, y: point.y + 12 });
    if (!floor) {
      this.w.log.info('oil_lost', { at: rv(point) });
      return;
    }
    const d: Puddle = { id: this.nextProp++, x: point.x, y: floor.point.y, w: SPECIAL.oil.width, until: this.w.tick + SPECIAL.oil.ticks, by };
    this.puddles.push(d);
    this.w.log.info('oil_spawn', { id: d.id, at: rv({ x: d.x, y: d.y }), w: d.w, until: d.until, by });
  }

  private explode(a: Arrow): void {
    const c = { ...a.pos };
    a.state = 'gone';
    a.fuseAt = undefined;
    const bomb = SPECIAL.bomb;
    let hitPlayers = 0;
    for (const [id, p] of this.w.players) {
      const st = this.w.stats.get(id);
      const d = dist(p.center(), c);
      if (!st || d > bomb.radius) continue;
      const k = 1 - d / bomb.radius;
      const away = d > 0.01 ? normalize(sub(p.center(), c)) : { x: 0, y: -1 };
      for (const b of p.attached()) this.w.push(b, { x: away.x * bomb.push * k * b.mass(), y: (away.y * bomb.push * k - bomb.lift * k) * b.mass() });
      if (st.alive && k > 0.3) p.stun(this.w.tick, Math.round(40 + 60 * k), `bomb:${a.id}`);
      if (st.alive) this.w.hurt(id, a.ownerId, Math.round(bomb.damage * k), c);
      hitPlayers++;
    }
    this.w.physics.forEachRigidBody((b) => {
      if (!b.isDynamic() || this.w.isPlayerBody(b)) return;
      const d = dist(b.translation(), c);
      if (d < bomb.radius) this.w.push(b, scale(normalize(sub(b.translation(), c)), bomb.push * (1 - d / bomb.radius) * b.mass()));
    });
    this.w.log.info('bomb_explode', { arrow: a.id, by: a.ownerId, at: rv(c), players: hitPlayers });
    this.w.emit({ type: 'explosion', pos: c, radius: bomb.radius, by: a.ownerId });
    this.w.callout('kaboom', a.ownerId, a.ownerId, c, 1, { players: hitPlayers });
  }

  private swap(a: string, b: string): void {
    const pa = this.w.player(a);
    const pb = this.w.player(b);
    const fa = this.w.feetOf(a);
    const fb = this.w.feetOf(b);
    if (!this.w.roomToStand(fb) || !this.w.roomToStand(fa)) {
      this.w.log.info('swap_blocked', { a, b });
      return;
    }
    const facingA = pa.facing;
    const facingB = pb.facing;
    this.w.relocate(a, fb, facingA);
    this.w.relocate(b, fa, facingB);
    this.w.log.info('swap', { a, b, aTo: rv(fb), bTo: rv(fa) });
    this.w.emit({ type: 'swap', a, b });
    this.w.callout('swapped', b, a, { x: fa.x, y: fa.y - 2 }, 0.7, {});
  }

  unpin(id: string, reason: string): void {
    const pin = this.pins.get(id);
    if (!pin) return;
    this.pins.delete(id);
    if (pin.joint.isValid()) this.w.physics.removeImpulseJoint(pin.joint, true);
    if (reason !== 'time') this.w.effects.get(id)?.remove('pinned');
    this.w.log.info('pin_end', { id, part: pin.part, reason });
  }

  /** A stuck plunger lets go (its rope ended): it's gone. */
  private dropArrow(arrowId: number): void {
    const a = this.w.arrows.find((x) => x.id === arrowId && x.state === 'stuck');
    if (a) a.state = 'gone';
  }
}

/** An angle as one byte (0..255 = a full turn), for props. */
export const angleByte = (a: number): number => Math.round((((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 256) % 256;
export const byteAngle = (b: number): number => (b / 256) * 2 * Math.PI;
