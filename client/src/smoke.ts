import Phaser from 'phaser';
import { PX_PER_M, type Logger, type Vec2 } from '@ragdoll/shared';
import type { Puff } from './dust';

/**
 * Funny legs, T6 cartoon smoke (picked from funny-legs-mock.html, "a little more than subtle" = 60% of the mock's first
 * size). Cosmetic only, from what's drawn (the dust tracker's moments), nothing over the network:
 * - step: two little cloud balls kicked up behind a running foot as it pushes off, hopping back;
 * - jump: two clouds bursting sideways from under the feet + three speed lines shooting down;
 * - land: a low cloud bank rolling out both ways (bigger after a harder landing) + a small impact star;
 * - turn: a step puff, a bit bigger.
 * Clouds POP in (overshoot), hold, then shrink away (cartoons don't fade). Every cloud is one of a few pre-drawn
 * pictures (outline and shine baked in), shown by a fixed pool of images (the GPU draws them together): at most
 * `perPlayer` per player (its oldest reused) and `maxTotal` in all.
 */
export const SMOKE = {
  /** The user's size: 60% of the mock's first, chunky version. */
  size: 0.6,
  perPlayer: 24,
  maxTotal: 160,
  variants: 4,
  /** Texture: cloud radius unit (px) and canvas size. */
  unitPx: 20,
  texPx: 72,
  fill: '#dfe7f0',
  outline: '#141a26',
  shine: '#ffffff',
  lineColor: 0xffffff,
  starColor: 0xffea00,
  /** In front of bodies (they're small and low; behind, the ground block hid their lower half). */
  depth: 1,
} as const;

interface Cloud {
  img: Phaser.GameObjects.Image;
  owner: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius (m) at full size. */
  r: number;
  sy: number;
  drag: number;
  lift: number;
  age: number;
  life: number;
  born: number;
}

const rnd = Math.random;
const backOut = (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
/** Pop in with an overshoot, hold, shrink away. */
function popScale(t: number): number {
  if (t < 0.18) return backOut(t / 0.18);
  if (t < 0.55) return 1;
  return Math.max(0, 1 - (t - 0.55) / 0.45);
}

/** One cloud picture: 3-5 round blobs around a middle one, a single dark outline around them all, a shine. */
function drawCloud(ctx: CanvasRenderingContext2D, seed: number): void {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const u = SMOKE.unitPx;
  const c = SMOKE.texPx / 2;
  const n = 3 + (seed % 3);
  const blobs = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + rand() * 0.6;
    return { x: c + Math.cos(a) * 0.55 * u, y: c + Math.sin(a) * 0.4 * u, r: (0.55 + rand() * 0.35) * u };
  });
  blobs.push({ x: c, y: c, r: 0.8 * u });
  const fill = (color: string, grow: number) => {
    ctx.fillStyle = color;
    for (const b of blobs) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r + grow, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  fill(SMOKE.outline, 2.5);
  fill(SMOKE.fill, 0);
  ctx.fillStyle = SMOKE.shine;
  ctx.beginPath();
  ctx.arc(c - 0.25 * u, c - 0.25 * u, 0.22 * u, 0, Math.PI * 2);
  ctx.fill();
}

export class CartoonSmoke {
  private readonly clouds: Cloud[] = [];
  private readonly free: Phaser.GameObjects.Image[] = [];
  private lines: { x: number; y: number; len: number; age: number; life: number }[] = [];
  private stars: { x: number; y: number; age: number; size: number }[] = [];
  private born = 0;
  private recycled = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly log: Logger,
  ) {
    for (let v = 0; v < SMOKE.variants; v++) {
      const key = `smoke:cloud${v}`;
      if (scene.textures.exists(key)) continue;
      const tex = scene.textures.createCanvas(key, SMOKE.texPx, SMOKE.texPx)!;
      drawCloud(tex.context, 7919 * (v + 1));
      tex.refresh();
    }
  }

  /** One dust moment from the dust tracker, as cartoon smoke. */
  puff(p: Puff): void {
    if (p.why === 'step') this.step(p.id, p.at, p.dir);
    else if (p.why === 'turn') this.step(p.id, p.at, p.dir, 1.3);
    else if (p.why === 'takeoff') this.jump(p.id, p.at);
    else this.land(p.id, p.at, p.size);
  }

  /** A running foot pushed off (`dir`: the way the dust goes, opposite to running). */
  step(owner: string, at: Vec2, dir: -1 | 0 | 1, size = 1): void {
    const d = dir || 1;
    for (let i = 0; i < 2; i++) {
      this.add(owner, { x: at.x + d * (0.08 + i * 0.1), y: at.y - 0.07, vx: d * (0.4 + rnd() * 0.4), vy: -(0.3 + rnd() * 0.3), r: (0.1 + rnd() * 0.04) * size, sy: 1, drag: 3, lift: -0.9, life: 0.42 + rnd() * 0.12 });
    }
  }

  /** A jump took off: two clouds burst sideways + speed lines shooting down. */
  jump(owner: string, at: Vec2): void {
    for (const side of [-1, 1]) this.add(owner, { x: at.x + side * 0.15, y: at.y - 0.08, vx: side * (1.0 + rnd() * 0.4), vy: -0.15, r: 0.18, sy: 0.8, drag: 5, lift: 0, life: 0.5 });
    for (const dx of [-0.12, 0, 0.12]) this.lines.push({ x: at.x + dx, y: at.y - 0.35 - Math.abs(dx), len: 0.3, age: 0, life: 0.25 });
  }

  /** A landing: a low cloud bank rolling out both ways (`size` 0.4-1.4 from the fall speed) + an impact star. */
  land(owner: string, at: Vec2, size: number): void {
    const k = 0.7 + 0.3 * size;
    for (let i = 0; i < 4; i++) {
      const side = i % 2 ? 1 : -1;
      const far = Math.floor(i / 2);
      this.add(owner, { x: at.x + side * (0.12 + far * 0.12), y: at.y - 0.06, vx: side * (1.3 + far * 0.8) * k, vy: -0.08 - far * 0.06, r: (0.24 - far * 0.04) * k, sy: 0.65, drag: 3.8, lift: 0, life: 0.6 + far * 0.08 });
    }
    this.stars.push({ x: at.x, y: at.y, age: 0, size: k });
  }

  /** Steps and draws everything (`g`: the scene's world graphics, for the speed lines and stars). */
  update(dtSec: number, g: Phaser.GameObjects.Graphics): void {
    const dt = Math.min(dtSec, 0.1);
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.age += dt;
      if (c.age >= c.life) {
        this.release(i);
        continue;
      }
      const damp = 1 - Math.min(1, dt * c.drag);
      c.vx *= damp;
      c.vy = c.vy * damp - c.lift * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      const s = popScale(c.age / c.life) * ((c.r * SMOKE.size * PX_PER_M) / SMOKE.unitPx);
      c.img.setPosition(c.x * PX_PER_M, c.y * PX_PER_M).setScale(s, s * c.sy);
    }
    this.lines = this.lines.filter((l) => (l.age += dt) < l.life);
    for (const l of this.lines) {
      const t = l.age / l.life;
      g.lineStyle(2, SMOKE.lineColor, 1 - t);
      g.lineBetween(l.x * PX_PER_M, (l.y + t * 0.3) * PX_PER_M, l.x * PX_PER_M, (l.y + l.len * (1 - t) + t * 0.3) * PX_PER_M);
    }
    this.stars = this.stars.filter((s) => (s.age += dt) < 0.14);
    for (const st of this.stars) {
      const k = 1 - st.age / 0.14;
      const pts: Phaser.Math.Vector2[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const r = (i % 2 ? 0.12 : 0.34) * (0.6 + 0.6 * (1 - k)) * SMOKE.size * st.size;
        pts.push(new Phaser.Math.Vector2((st.x + Math.cos(a) * r * 1.6) * PX_PER_M, (st.y - 0.05 + Math.sin(a) * r * 0.7) * PX_PER_M));
      }
      g.fillStyle(SMOKE.starColor, k).fillPoints(pts, true);
    }
  }

  /** For the client's perf report: clouds alive, made, and reused early (the pool was full). */
  report(): { smoke: number; smokeMade: number; smokeReused: number } {
    return { smoke: this.clouds.length, smokeMade: this.born, smokeReused: this.recycled };
  }

  clear(): void {
    while (this.clouds.length) this.release(this.clouds.length - 1);
    this.lines = [];
    this.stars = [];
  }

  private add(owner: string, c: Omit<Cloud, 'img' | 'owner' | 'age' | 'born'>): void {
    // the pool: this player's oldest cloud, else anyone's oldest, is reused when full
    const mine = this.clouds.filter((x) => x.owner === owner);
    if (mine.length >= SMOKE.perPlayer) this.reuse(this.clouds.indexOf(mine[0]));
    else if (this.clouds.length >= SMOKE.maxTotal) this.reuse(0);
    const img = this.free.pop() ?? this.scene.add.image(0, 0, 'smoke:cloud0').setDepth(SMOKE.depth);
    img.setTexture(`smoke:cloud${Math.floor(rnd() * SMOKE.variants)}`).setVisible(true).setScale(0);
    if (rnd() < 0.5) img.setFlipX(!img.flipX);
    this.clouds.push({ ...c, img, owner, age: 0, born: this.born++ });
  }

  private reuse(i: number): void {
    this.recycled++;
    if (this.recycled === 1 || this.recycled % 100 === 0) this.log.info('smoke_pool_full', { reused: this.recycled, alive: this.clouds.length });
    this.release(i);
  }

  private release(i: number): void {
    const [c] = this.clouds.splice(i, 1);
    c.img.setVisible(false);
    this.free.push(c.img);
  }
}
