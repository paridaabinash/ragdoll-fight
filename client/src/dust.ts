import { PART_NAMES, RAGDOLL, type Pose, type Vec2 } from '@ragdoll/shared';

/**
 * L2 dust puffs (cosmetic, client only): a puff when a body takes off, a bigger one when it lands hard, (funny legs) a
 * small one each time a running foot pushes off behind the body, and a skid puff on a quick turn. Worked out from what's already drawn (feet positions and the
 * snapshot's `grounded` flag), so it needs nothing new from the network. No Phaser here: the scene turns each puff
 * into particles (HitFx.puff, sharing the L1 particle cap).
 */
export const DUST = {
  /** Take-off: leaving the ground going up at least this fast (m/s). Mid-stride both feet leave the ground for a
   * moment too; that's slow upward motion, so it doesn't count. */
  takeoffSpeed: 2.5,
  /** ...within this long (s) after the feet leave the ground (the measured speed lags behind a little). */
  takeoffWindow: 0.12,
  /** Landing: only after this long in the air (s), sized by the fall speed (puff size = speed / landingScale). */
  landingAir: 0.25,
  landingScale: 10,
  /**
   * Funny legs (T6 smoke): running faster than `stepSpeed` m/s, a puff each time a foot pushes off: it was down (within
   * `soleUp` m of the lower foot) and lifts while behind the other one. Was: a puff every 1.2 m of running.
   */
  stepSpeed: 2,
  soleUp: 0.06,
  /** A turn from at least this speed (m/s) into the other direction kicks up a skid puff. */
  turnSpeed: 2.5,
  /** Moved further than this (m) in one frame: a respawn/teleport, not motion. */
  teleport: 3,
  /** Smoothing of the measured speed (per second). */
  smoothing: 12,
} as const;

export interface DustSample {
  id: string;
  /** Bottom of the feet (midpoint of the two shin ends, at the lower one's height). */
  feet: Vec2;
  /** Each foot's bottom (front, back): the shin ends (`solesOf`). */
  soles: [Vec2, Vec2];
  grounded: boolean;
  alive: boolean;
}

/** One puff to draw: whose, where, how big (1 = a normal landing), and which way it drifts (-1 / 1, 0 = both ways). */
export interface Puff {
  id: string;
  at: Vec2;
  size: number;
  dir: -1 | 0 | 1;
  why: 'takeoff' | 'landing' | 'step' | 'turn';
}

interface Track {
  pos: Vec2;
  vx: number;
  vy: number;
  grounded: boolean;
  airSince: number;
  /** Where the feet left the ground, until the take-off is decided (null: decided or not airborne). */
  liftoff: Vec2 | null;
  /** Each foot down on the ground last frame (front, back). */
  down: [boolean, boolean];
  fastDir: -1 | 0 | 1;
}

const SHIN_FRONT = PART_NAMES.indexOf('legFrontLower');
const SHIN_BACK = PART_NAMES.indexOf('legBackLower');

/** Each foot's bottom (the shin ends: front, back) from a body's part poses (PART_NAMES order). */
export function solesOf(parts: Pose[]): [Vec2, Vec2] {
  const end = (p: Pose) => ({ x: p.x - Math.sin(p.a) * RAGDOLL.lowerLeg.hy, y: p.y + Math.cos(p.a) * RAGDOLL.lowerLeg.hy });
  return [end(parts[SHIN_FRONT]), end(parts[SHIN_BACK])];
}

/** Bottom of the feet from a body's part poses (PART_NAMES order). */
export function feetOf(parts: Pose[]): Vec2 {
  const [a, b] = solesOf(parts);
  return { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) };
}

export class DustTracker {
  private tracks = new Map<string, Track>();
  private lastMs = 0;

  /** Call once per frame with every body on screen; returns the puffs that frame. */
  update(samples: DustSample[], nowMs: number): Puff[] {
    const dt = this.lastMs ? Math.min(0.1, (nowMs - this.lastMs) / 1000) : 0;
    this.lastMs = nowMs;
    const out: Puff[] = [];
    const seen = new Set<string>();
    for (const s of samples) {
      seen.add(s.id);
      const t = this.tracks.get(s.id);
      if (!t || !s.alive || dt <= 0 || Math.hypot(s.feet.x - t.pos.x, s.feet.y - t.pos.y) > DUST.teleport) {
        this.tracks.set(s.id, { pos: { ...s.feet }, vx: 0, vy: 0, grounded: s.grounded, airSince: nowMs, liftoff: null, down: [true, true], fastDir: 0 });
        continue;
      }
      const k = Math.min(1, dt * DUST.smoothing);
      const dx = s.feet.x - t.pos.x;
      t.vx += (dx / dt - t.vx) * k;
      t.vy += ((s.feet.y - t.pos.y) / dt - t.vy) * k;
      t.pos = { ...s.feet };
      if (t.grounded && !s.grounded) {
        t.airSince = nowMs;
        t.liftoff = { ...s.feet };
      }
      if (t.liftoff && !s.grounded) {
        if (t.vy < -DUST.takeoffSpeed) {
          out.push({ id: s.id, at: t.liftoff, size: 0.6, dir: 0, why: 'takeoff' });
          t.liftoff = null;
        } else if ((nowMs - t.airSince) / 1000 > DUST.takeoffWindow) t.liftoff = null;
      }
      if (s.grounded) t.liftoff = null;
      if (!t.grounded && s.grounded && (nowMs - t.airSince) / 1000 >= DUST.landingAir) {
        out.push({ id: s.id, at: { ...s.feet }, size: Math.max(0.4, Math.min(1.4, Math.abs(t.vy) / DUST.landingScale)), dir: 0, why: 'landing' });
      }
      t.grounded = s.grounded;
      const fast = Math.abs(t.vx) >= DUST.turnSpeed ? (Math.sign(t.vx) as -1 | 1) : 0;
      if (s.grounded && fast && t.fastDir && fast !== t.fastDir) out.push({ id: s.id, at: { ...s.feet }, size: 0.7, dir: t.fastDir, why: 'turn' });
      if (fast) t.fastDir = fast;
      // a running foot pushing off: it was down and lifts while behind the other foot (the moving way)
      for (const i of [0, 1] as const) {
        const sole = s.soles[i];
        const down = s.grounded && sole.y >= s.feet.y - DUST.soleUp;
        const behind = (sole.x - s.soles[1 - i].x) * Math.sign(t.vx) < 0;
        if (t.down[i] && !down && behind && Math.abs(t.vx) >= DUST.stepSpeed) out.push({ id: s.id, at: { x: sole.x, y: s.feet.y }, size: 0.35, dir: -Math.sign(t.vx) as -1 | 1, why: 'step' });
        t.down[i] = down;
      }
    }
    for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id);
    return out;
  }
}
