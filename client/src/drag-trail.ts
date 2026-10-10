import type Phaser from 'phaser';
import type { Vec2 } from '@ragdoll/shared';
import { px } from './draw';

/**
 * L7: what a dragged (limp) foot leaves behind as it scrapes along the ground: a small dust puff every so often and a
 * short scuff mark that fades. Cosmetic, from what's drawn (the foot's pose and the body's grounded flag).
 */
const TRAIL = {
  /** The foot must slide at least this fast (m/s) and be on the ground. */
  minSpeed: 0.6,
  /** A puff at most this often (ms), this big (dust puff size), and a scuff this long (m) that fades over `fadeMs`. */
  puffMs: 120,
  puffSize: 0.25,
  scuff: 0.25,
  fadeMs: 1500,
  maxScuffs: 40,
} as const;

export class DragTrail {
  private readonly feet = new Map<string, { at: Vec2; ms: number; lastPuff: number }>();
  private scuffs: { from: Vec2; to: Vec2; born: number }[] = [];

  /**
   * One frame of one body: `foot` = the dragged foot's end (null: not dragging). Calls `puff(at, dir)` when a dust
   * puff is due (dir: the way it drifts, behind the foot).
   */
  update(id: string, foot: Vec2 | null, grounded: boolean, nowMs: number, puff: (at: Vec2, dir: -1 | 1) => void): void {
    if (!foot) {
      this.feet.delete(id);
      return;
    }
    const last = this.feet.get(id);
    this.feet.set(id, { at: { ...foot }, ms: nowMs, lastPuff: last?.lastPuff ?? 0 });
    if (!last || !grounded) return;
    const dt = (nowMs - last.ms) / 1000;
    if (dt <= 0) return;
    const vx = (foot.x - last.at.x) / dt;
    if (Math.abs(vx) < TRAIL.minSpeed) return;
    const state = this.feet.get(id)!;
    if (nowMs - last.lastPuff < TRAIL.puffMs) return;
    state.lastPuff = nowMs;
    const dir = (vx > 0 ? -1 : 1) as -1 | 1;
    puff(foot, dir);
    this.scuffs.push({ from: { x: foot.x + dir * TRAIL.scuff, y: foot.y }, to: { ...foot }, born: nowMs });
    if (this.scuffs.length > TRAIL.maxScuffs) this.scuffs.splice(0, this.scuffs.length - TRAIL.maxScuffs);
  }

  /** The fading scuff marks on the ground. */
  draw(g: Phaser.GameObjects.Graphics, nowMs: number): void {
    this.scuffs = this.scuffs.filter((s) => nowMs - s.born < TRAIL.fadeMs);
    for (const s of this.scuffs) {
      const a = 1 - (nowMs - s.born) / TRAIL.fadeMs;
      g.lineStyle(2, 0xa0aab4, 0.35 * a).lineBetween(px(s.from.x), px(s.from.y + 0.03), px(s.to.x), px(s.to.y + 0.03));
    }
  }

  /** A new arena / world: nothing carries over. */
  clear(): void {
    this.feet.clear();
    this.scuffs = [];
  }
}

/** The end of a dragged shin (its lower end), from the part's pose (center, angle; a hanging part has angle 0). */
export function shinEnd(pose: { x: number; y: number; a: number }, hy: number): Vec2 {
  return { x: pose.x - Math.sin(pose.a) * hy, y: pose.y + Math.cos(pose.a) * hy };
}
