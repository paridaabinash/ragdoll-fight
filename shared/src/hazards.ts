import RAPIER from '@dimforge/rapier2d-compat';
import { windAt, type HazardDef } from './arena';
import { DT, HAZARD } from './constants';
import { add, dist, length, r2, rotate, rv, sub, type Vec2 } from './math';
import type { Arrow, GameWorld, Hit } from './world';

type Trampoline = Extract<HazardDef, { kind: 'trampoline' }>;
type Conveyor = Extract<HazardDef, { kind: 'conveyor' }>;

interface Seesaw {
  def: Extract<HazardDef, { kind: 'seesaw' }>;
  plank: RAPIER.RigidBody;
}
interface Wreck {
  def: Extract<HazardDef, { kind: 'wrecking_ball' }>;
  ball: RAPIER.RigidBody;
  /** Who swung it last, and when (kill credit). */
  swungBy: string | null;
  swungAt: number;
}

/**
 * Hazards (S6): built from the arena data, run every tick by the world. Everything here is decided on the server;
 * the moving parts (seesaw planks, wrecking balls) are ordinary dynamic bodies, so snapshots carry them.
 */
export class Hazards {
  private defs: HazardDef[] = [];
  private trampolines: Trampoline[] = [];
  private conveyors: Conveyor[] = [];
  private seesaws: Seesaw[] = [];
  private wrecks: Wreck[] = [];
  private readonly launchedAt = new Map<string, number>();
  private readonly bonkedAt = new Map<string, number>();
  private readonly insideTicks = new Map<string, number>();

  constructor(private readonly w: GameWorld) {}

  /** The arena's hazards: wind/conveyor are data; pads, planks and balls get bodies. */
  build(defs: HazardDef[]): void {
    this.defs = defs.map((d) => ({ ...d }));
    for (const d of this.defs) {
      if (d.kind === 'trampoline') {
        // A marked strip of the floor, no body of its own: even an 8 cm lip stopped walking feet in front of it.
        this.trampolines.push(d);
      } else if (d.kind === 'conveyor') {
        this.conveyors.push(d);
      } else if (d.kind === 'seesaw') {
        const s = HAZARD.seesaw;
        const pivot = this.w.addBox(`${d.label}_pivot`, 'fixed', { x: d.x, y: d.y + 0.3 }, { x: 0.2, y: 0.3 });
        const plank = this.w.addBox(d.label, 'dynamic', { x: d.x, y: d.y - s.thickness / 2 }, { x: d.length / 2, y: s.thickness / 2 });
        plank.collider(0).setDensity(s.density);
        const j = RAPIER.JointData.revolute({ x: 0, y: s.thickness / 2 }, { x: 0, y: -0.3 });
        const joint = this.w.physics.createImpulseJoint(j, plank, pivot, true) as RAPIER.RevoluteImpulseJoint;
        joint.setLimits(-s.limit, s.limit);
        // the plank rests on its own pivot block: without this the block holds it level and a person's weight can't tip it
        joint.setContactsEnabled(false);
        this.seesaws.push({ def: d, plank });
      } else if (d.kind === 'wrecking_ball') {
        const anchor = this.w.addBox(`${d.label}_anchor`, 'fixed', { x: d.x, y: d.y }, { x: 0.15, y: 0.15 });
        const ball = this.w.physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(d.x, d.y + d.length).setAngularDamping(0.5));
        const collider = this.w.physics.createCollider(RAPIER.ColliderDesc.ball(d.radius).setDensity(HAZARD.wreck.density), ball);
        this.w.registerCollider(collider, ball, d.label);
        this.w.physics.createImpulseJoint(RAPIER.JointData.revolute({ x: 0, y: -d.length }, { x: 0, y: 0 }), ball, anchor, true);
        this.wrecks.push({ def: d, ball, swungBy: null, swungAt: -Infinity });
      }
    }
    if (this.defs.length) this.w.log.info('hazards_built', { count: this.defs.length, kinds: this.defs.map((d) => d.kind) });
  }

  /** Wind push (m/s²) on arrows at a point (the preview uses the same). */
  windAt = (p: Vec2): Vec2 => windAt(this.defs, p);

  /** Conveyor speed under a player's feet (0 if none). */
  beltUnder(id: string): number {
    if (!this.conveyors.length) return 0;
    for (const c of this.conveyors) if (this.feetOn(id, c.x, c.w, c.y)) return c.speed;
    return 0;
  }

  /** An arrow hit something: a wrecking ball swings, a seesaw end gets kicked. Any arrow, normal or special. */
  onArrowHit(arrow: Arrow, hit: Hit, impactVel: Vec2): void {
    const body = hit.collider.parent();
    const wreck = this.wrecks.find((x) => x.ball === body);
    if (wreck) {
      const dir = Math.sign(impactVel.x) || 1;
      const m = wreck.ball.mass();
      this.w.push(wreck.ball, { x: dir * HAZARD.wreck.shotSpeed * m, y: 0 });
      wreck.swungBy = arrow.ownerId;
      wreck.swungAt = this.w.tick;
      this.w.log.info('hazard_shot', { kind: 'wrecking_ball', label: wreck.def.label, by: arrow.ownerId, dir });
      return;
    }
    const seesaw = this.seesaws.find((x) => x.plank === body);
    if (seesaw) {
      // Press the end that was hit straight into the plank (an arrow mostly flies sideways; a sideways push at the
      // pivot's height barely turns a seesaw: measured 0.01 m lift for the player on the other end).
      const r = seesaw.plank.rotation();
      const normal = { x: -Math.sin(r), y: Math.cos(r) }; // the plank's "down"
      const side = Math.sign(impactVel.x * normal.x + impactVel.y * normal.y) || 1;
      const k = HAZARD.seesaw.shotImpulse * side;
      this.w.push(seesaw.plank, { x: normal.x * k, y: normal.y * k }, hit.point);
      this.w.log.info('hazard_shot', { kind: 'seesaw', label: seesaw.def.label, by: arrow.ownerId, at: rv(hit.point) });
    }
  }

  /** Before the physics step: wind on players, trampoline launches, wrecking-ball knockdowns, stuck checks. */
  preStep(): void {
    const tick = this.w.tick;
    for (const [id, p] of this.w.players) {
      const st = this.w.stats.get(id);
      if (!st?.alive) continue;
      const wind = this.windAt(p.center());
      if (wind.x || wind.y) {
        const k = HAZARD.wind.playerShare * DT;
        for (const b of p.attached()) this.w.push(b, { x: wind.x * k * b.mass(), y: wind.y * k * b.mass() });
      }
      for (const t of this.trampolines) {
        if (tick - (this.launchedAt.get(id) ?? -Infinity) < HAZARD.trampoline.cooldownTicks || !this.feetOn(id, t.x, t.w, t.y)) continue;
        this.launchedAt.set(id, tick);
        for (const b of p.attached()) this.w.push(b, { x: 0, y: -(t.power + b.linvel().y) * b.mass() });
        this.w.log.info('hazard_hit', { kind: 'trampoline', label: t.label, id, speed: t.power });
      }
      for (const wk of this.wrecks) this.checkBonk(id, wk, tick);
    }
    this.checkStuck();
  }

  // ---- internals ----

  /** Both soles on top of this strip (x..x+w, top y)? */
  private feetOn(id: string, x: number, w: number, y: number): boolean {
    const p = this.w.players.get(id);
    if (!p) return false;
    return p.footPoints().some((sole) => sole.x > x && sole.x < x + w && Math.abs(sole.y - y) < 0.25);
  }

  private checkBonk(id: string, wk: Wreck, tick: number): void {
    const p = this.w.player(id);
    const c = wk.ball.translation();
    const v = wk.ball.linvel();
    const speed = length(v);
    if (speed < HAZARD.wreck.hitSpeed || tick - (this.bonkedAt.get(id) ?? -Infinity) < 30) return;
    const touching = p.attached().some((b) => dist(b.translation(), c) < wk.def.radius + 0.3);
    if (!touching) return;
    this.bonkedAt.set(id, tick);
    for (const b of p.attached()) this.w.push(b, { x: v.x * HAZARD.wreck.push * b.mass(), y: (v.y * HAZARD.wreck.push - 2) * b.mass() });
    p.stun(tick, HAZARD.wreck.stunTicks, `wrecking_ball:${wk.def.label}`);
    const by = wk.swungBy && tick - wk.swungAt <= HAZARD.wreck.creditTicks ? wk.swungBy : null;
    if (by && by !== id) this.w.stats.get(id)?.markHit(by, tick);
    this.w.log.info('hazard_hit', { kind: 'wrecking_ball', label: wk.def.label, id, speed: r2(speed), by });
    this.w.callout('bonk', id, by, add(c, { x: 0, y: -wk.def.radius }), Math.min(1, speed / 10), { speed: r2(speed) });
  }

  /** A body center inside a plank or ball for a while means the physics let it through: flag it. */
  private checkStuck(): void {
    for (const [id, p] of this.w.players) {
      const c = p.center();
      const inside =
        this.wrecks.some((wk) => dist(c, wk.ball.translation()) < wk.def.radius * 0.7) ||
        this.seesaws.some((s) => {
          const local = rotate(sub(c, s.plank.translation()), -s.plank.rotation());
          return Math.abs(local.x) < s.def.length / 2 && Math.abs(local.y) < HAZARD.seesaw.thickness / 2;
        });
      const n = inside ? (this.insideTicks.get(id) ?? 0) + 1 : 0;
      this.insideTicks.set(id, n);
      if (n >= HAZARD.stuckTicks) this.w.anomaly('stuck_in_hazard', id, { at: rv(c), ticks: n });
    }
  }
}
