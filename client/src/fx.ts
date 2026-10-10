import Phaser from 'phaser';
import { GRAVITY_Y, type Logger, type Vec2 } from '@ragdoll/shared';
import { px } from './draw';

/**
 * L1 hit feedback (cosmetic, client only): a white impact spark, a few small chips in the hit part's own colour,
 * a 2-frame white flash on the hit part, and a small screen shake on big hits that involve you.
 * No blood, no colour splashes. Particles are drawn into the scene's one Graphics each frame (no object per
 * particle) and capped; L2's dust puffs will share the same cap.
 */
export const FX = {
  /** Most particles alive at once; beyond it the oldest go and `fx_capped` is logged (at most once a second). */
  maxParticles: 160,
  spark: { rays: 6, life: 0.16, len: [0.25, 0.5] as const },
  chips: { count: 4, life: 0.55, size: 0.07, speed: [2.5, 5] as const },
  /** Frames the hit part is drawn white. */
  flashFrames: 2,
  /** Screen shake on a hit that involves you, from this much damage (or any headshot). */
  shake: { minDamage: 25, ms: 110, intensity: 0.004 },
} as const;

interface Particle {
  kind: 'ray' | 'chip' | 'puff';
  pos: Vec2;
  vel: Vec2;
  /** Ray: direction (rad). Chip: spin angle. */
  angle: number;
  spin: number;
  age: number;
  life: number;
  size: number;
  color: number;
}

export class HitFx {
  private parts: Particle[] = [];
  /** Hit part flashing white: player key -> part index + frames left. */
  private flashes = new Map<string, { part: number; frames: number }>();
  private capped = { lastLogAt: -Infinity, dropped: 0 };

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly log: Logger,
  ) {}

  /** A hit on a player: spark + chips in `color` at `at`, and part `part` of `who` flashes. */
  hit(at: Vec2, color: number, who: string, part: number, strength: number): void {
    const s = Math.max(0.3, Math.min(1, strength));
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < FX.spark.rays; i++) {
      const len = FX.spark.len[0] + (FX.spark.len[1] - FX.spark.len[0]) * s;
      this.add({ kind: 'ray', pos: { ...at }, vel: { x: 0, y: 0 }, angle: base + (i / FX.spark.rays) * Math.PI * 2, spin: 0, age: 0, life: FX.spark.life, size: len, color: 0xffffff });
    }
    for (let i = 0; i < FX.chips.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = FX.chips.speed[0] + Math.random() * (FX.chips.speed[1] - FX.chips.speed[0]);
      this.add({ kind: 'chip', pos: { ...at }, vel: { x: Math.cos(a) * v, y: Math.sin(a) * v - 2 }, angle: a, spin: (Math.random() - 0.5) * 20, age: 0, life: FX.chips.life, size: FX.chips.size * (0.6 + Math.random() * 0.6), color });
    }
    this.flashes.set(who, { part, frames: FX.flashFrames });
  }

  /** L7: a bullet sparking off a spawn shield: a white star of rays, no chips, nothing flashes. */
  spark(at: Vec2): void {
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < FX.spark.rays; i++) this.add({ kind: 'ray', pos: { ...at }, vel: { x: 0, y: 0 }, angle: base + (i / FX.spark.rays) * Math.PI * 2, spin: 0, age: 0, life: FX.spark.life, size: FX.spark.len[0], color: 0xffffff });
  }

  /**
   * L2 dust puff (see dust.ts): a few soft circles in the arena's dust colour that grow, drift and fade.
   * `dir` = which way they drift (-1 / 1), 0 = both ways; `size` 1 = a normal landing.
   */
  puff(at: Vec2, color: number, size: number, dir: -1 | 0 | 1): void {
    const n = 3 + Math.round(size * 2);
    for (let i = 0; i < n; i++) {
      const side = dir || (i % 2 ? 1 : -1);
      const vx = side * (0.6 + Math.random() * 0.8) * (0.5 + size);
      this.add({ kind: 'puff', pos: { x: at.x + side * 0.05, y: at.y - 0.05 }, vel: { x: vx, y: -(0.2 + Math.random() * 0.4) }, angle: 0, spin: 0, age: 0, life: 0.4 + 0.15 * size, size: (0.1 + Math.random() * 0.08) * (0.6 + 0.6 * size), color });
    }
  }

  /** Small screen shake (only call it for big hits that involve you). */
  shake(damage: number, headshot: boolean): void {
    if (damage < FX.shake.minDamage && !headshot) return;
    this.scene.cameras.main.shake(FX.shake.ms, FX.shake.intensity);
  }

  /** Which part of `who` flashes white this frame (or undefined). */
  flashOf(who: string): number | undefined {
    return this.flashes.get(who)?.part;
  }

  /** Steps and draws every particle; ends one frame of the flashes. Call once per frame, after drawing bodies. */
  draw(g: Phaser.GameObjects.Graphics, dt: number): void {
    for (const [who, f] of this.flashes) if (--f.frames <= 0) this.flashes.delete(who);
    this.parts = this.parts.filter((p) => (p.age += dt) < p.life);
    for (const p of this.parts) {
      const k = 1 - p.age / p.life;
      if (p.kind === 'puff') {
        // a soft dust circle: drifts, slows, grows and fades
        p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt };
        p.vel = { x: p.vel.x * (1 - 3 * dt), y: p.vel.y * (1 - 3 * dt) };
        g.fillStyle(p.color, 0.5 * k).fillCircle(px(p.pos.x), px(p.pos.y), px(p.size * (1 + 1.5 * (1 - k))));
        continue;
      }
      if (p.kind === 'ray') {
        // a white ray shooting out from the hit point and shrinking
        const from = 0.08 + (1 - k) * p.size * 0.6;
        const to = from + p.size * k;
        const c = Math.cos(p.angle);
        const s = Math.sin(p.angle);
        g.lineStyle(3, p.color, 1).lineBetween(px(p.pos.x + c * from), px(p.pos.y + s * from), px(p.pos.x + c * to), px(p.pos.y + s * to));
        continue;
      }
      p.vel.y += GRAVITY_Y * dt;
      p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt };
      p.angle += p.spin * dt;
      const h = px(p.size) / 2;
      const c = Math.cos(p.angle) * h;
      const s = Math.sin(p.angle) * h;
      const x = px(p.pos.x);
      const y = px(p.pos.y);
      g.fillStyle(p.color, Math.min(1, k * 2)).fillPoints([new Phaser.Math.Vector2(x - c + s, y - s - c), new Phaser.Math.Vector2(x + c + s, y + s - c), new Phaser.Math.Vector2(x + c - s, y + s + c), new Phaser.Math.Vector2(x - c - s, y - s + c)], true);
    }
  }

  get count(): number {
    return this.parts.length;
  }

  private add(p: Particle): void {
    this.parts.push(p);
    if (this.parts.length <= FX.maxParticles) return;
    const drop = this.parts.length - FX.maxParticles;
    this.parts.splice(0, drop);
    this.capped.dropped += drop;
    const now = performance.now();
    if (now - this.capped.lastLogAt >= 1000) {
      this.log.warn('fx_capped', { max: FX.maxParticles, dropped: this.capped.dropped });
      this.capped = { lastLogAt: now, dropped: 0 };
    }
  }
}

/** Index of the part whose center is nearest to `at`: which part a hit landed on (for the flash and chip colour). */
export function nearestPart(parts: Vec2[], at: Vec2): number {
  let best = Infinity;
  let index = 0;
  parts.forEach((q, i) => {
    const d = Math.hypot(q.x - at.x, q.y - at.y);
    if (d < best) [best, index] = [d, i];
  });
  return index;
}
