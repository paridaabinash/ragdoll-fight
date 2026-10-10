import Phaser from 'phaser';
import { DAMAGE, GUN, handOf, TRACER_COLOR, type Pose, type Vec2, type SpecialKind } from '@ragdoll/shared';
import { px } from './draw';
import { drawSpecialIcon } from './special-icons';

/**
 * L3 look: the gun, bullets (tracers) and bullet holes in walls. Drawing only: what a gun does is decided in shared/
 * (the server); this reads poses, reload ticks and events. Flat style like the bodies, but a real-looking gun.
 */

export const GUN_LOOK = {
  /** L7: where the muzzle is along the gun (m, before `scale`), and how big a loaded special round is drawn there (m). */
  muzzle: 0.63,
  specialIcon: 0.85,
  /**
   * Gun metal: a mid grey (darker than any player colour, lighter than every arena's sky and terrain), so the gun reads
   * both against the bright body and against the dark night arenas. (0x3a3f47 vanished on them in the L3 browser check.)
   */
  metal: 0x6b7480,
  dark: 0x4b525c,
  pumpColor: 0x2c3138,
  /** Drawn size (the outline below is in meters at 1x). */
  scale: 1.2,
  /** How far the pump/bolt slides back at the middle of the reload (m). */
  pumpTravel: 0.13,
  /** Bullet: bright tracer head (m) and a trail in the shooter's colour behind it (m). */
  tracer: 0.45,
  trail: 1.3,
  /** Bullet holes: radius (m). (How many stay is the server's DAMAGE.maxWallHoles: it keeps them for late joiners.) */
  holeRadius: 0.055,
} as const;

/**
 * Gun outline pieces in gun space: x forward along the barrel from the grip hand (m), y "down" (away from the top of
 * the gun). A pump-action shotgun: stock, receiver, barrel with the magazine tube under it, pump on the tube.
 */
const STOCK: Vec2[] = [
  { x: -0.12, y: -0.05 },
  { x: -0.5, y: -0.02 },
  { x: -0.52, y: 0.1 },
  { x: -0.42, y: 0.11 },
  { x: -0.12, y: 0.05 },
];
const RECEIVER: Vec2[] = [
  { x: -0.14, y: -0.07 },
  { x: 0.16, y: -0.07 },
  { x: 0.16, y: 0.05 },
  { x: -0.14, y: 0.05 },
];
const GRIP: Vec2[] = [
  { x: -0.08, y: 0.04 },
  { x: 0.0, y: 0.04 },
  { x: -0.03, y: 0.15 },
  { x: -0.11, y: 0.14 },
];
const BARREL: Vec2[] = [
  { x: 0.16, y: -0.06 },
  { x: 0.62, y: -0.06 },
  { x: 0.62, y: -0.015 },
  { x: 0.16, y: -0.015 },
];
const TUBE: Vec2[] = [
  { x: 0.16, y: -0.01 },
  { x: 0.54, y: -0.01 },
  { x: 0.54, y: 0.025 },
  { x: 0.16, y: 0.025 },
];
const PUMP: Vec2[] = [
  { x: 0.24, y: -0.025 },
  { x: 0.44, y: -0.025 },
  { x: 0.43, y: 0.05 },
  { x: 0.25, y: 0.05 },
];

/** How far back the pump is (0..1) when `ready` of the reload is done (0 = just fired, 1 = ready): back, then forward. */
export function pumpShare(ready: number): number {
  const t = Math.max(0, Math.min(1, ready));
  return t >= 1 ? 0 : Math.sin(Math.PI * t);
}

export interface GunView {
  /** The gun hand (end of the front forearm) and where the gun points (rad). */
  hand: Vec2;
  angle: number;
  /** Player colour (the stripe). */
  color: number;
  /** 0 = just fired .. 1 = ready (the pump moves in between). */
  ready: number;
  /** L7: the special round loaded in it, if any: drawn big at the muzzle (a glove sticking out, a balloon tied on...). */
  special?: SpecialKind | null;
  alpha?: number;
}

/** A flat pump-action gun at the hand, pointing along `angle`; upright whichever way it points. */
export function drawGun(g: Phaser.GameObjects.Graphics, v: GunView): void {
  const c = Math.cos(v.angle);
  const s = Math.sin(v.angle);
  // aiming left: mirror "down" so the gun isn't upside down
  const side = c < 0 ? -1 : 1;
  const k = GUN_LOOK.scale;
  const at = (p: Vec2, dx = 0) => new Phaser.Math.Vector2(px(v.hand.x + ((p.x + dx) * c - p.y * side * s) * k), px(v.hand.y + ((p.x + dx) * s + p.y * side * c) * k));
  const poly = (pts: Vec2[], color: number, dx = 0) => g.fillStyle(color, v.alpha ?? 1).fillPoints(pts.map((p) => at(p, dx)), true);
  poly(STOCK, GUN_LOOK.metal);
  poly(GRIP, GUN_LOOK.dark);
  poly(TUBE, GUN_LOOK.dark);
  poly(BARREL, GUN_LOOK.metal);
  poly(RECEIVER, GUN_LOOK.metal);
  // the player's colour: a stripe along the receiver and stock
  const a = at({ x: -0.44, y: 0.02 });
  const b = at({ x: 0.12, y: -0.02 });
  g.lineStyle(px(0.035 * k), v.color, v.alpha ?? 1).lineBetween(a.x, a.y, b.x, b.y);
  // the pump slides back and forward during the reload: the gun itself shows when it's ready
  poly(PUMP, GUN_LOOK.pumpColor, -GUN_LOOK.pumpTravel * pumpShare(v.ready));
  if (v.special) {
    // L7: the loaded special round, big and detailed at the muzzle, so everyone sees it at a glance
    const muzzle = { x: v.hand.x + c * GUN_LOOK.muzzle * k, y: v.hand.y + s * GUN_LOOK.muzzle * k };
    drawSpecialIcon(g, v.special, muzzle, v.angle, GUN_LOOK.specialIcon, v.alpha ?? 1, performance.now());
  }
}

/** Where a player's gun hand is and where the gun points, from the front forearm's pose (a hanging arm: rotation 0). */
export function gunOf(lowerArm: Pose): { hand: Vec2; angle: number } {
  // (the shared hand: the server's melee hit test uses the same point, so what's drawn is what hits)
  return { hand: handOf(lowerArm), angle: lowerArm.a + Math.PI / 2 };
}

/** A bullet in flight: a bright tracer head plus a short trail in the shooter's colour. `pos` = the bullet's front. */
export function drawBullet(g: Phaser.GameObjects.Graphics, pos: Vec2, angle: number, color: number, alpha = 1): void {
  const back = (d: number) => ({ x: pos.x - Math.cos(angle) * d, y: pos.y - Math.sin(angle) * d });
  const head = back(GUN_LOOK.tracer);
  const tail = back(GUN_LOOK.tracer + GUN_LOOK.trail);
  g.lineStyle(3, color, 0.35 * alpha).lineBetween(px(tail.x), px(tail.y), px(head.x), px(head.y));
  g.lineStyle(3, TRACER_COLOR, alpha).lineBetween(px(head.x), px(head.y), px(pos.x), px(pos.y));
}

/**
 * Bullet holes left in walls and floors (from `impact` events on fixed things): small dark see-through holes with a
 * faint light rim. They stay for the match (the oldest go past DAMAGE.maxWallHoles; the server keeps the same list for late joiners); a new arena clears them.
 */
export class BulletHoles {
  private holes: Vec2[] = [];

  /** `angle`: the way the bullet flew; the hole sits just inside the surface it hit. */
  add(pos: Vec2, angle: number): void {
    this.holes.push({ x: pos.x + Math.cos(angle) * 0.03, y: pos.y + Math.sin(angle) * 0.03 });
    if (this.holes.length > DAMAGE.maxWallHoles) this.holes.splice(0, this.holes.length - DAMAGE.maxWallHoles);
  }

  clear(): void {
    this.holes = [];
  }

  get count(): number {
    return this.holes.length;
  }

  draw(g: Phaser.GameObjects.Graphics): void {
    const r = px(GUN_LOOK.holeRadius);
    for (const h of this.holes) {
      g.fillStyle(0xffffff, 0.12).fillCircle(px(h.x), px(h.y), r * 1.6);
      g.fillStyle(0x020203, 0.95).fillCircle(px(h.x), px(h.y), r);
    }
  }
}

/** Reload progress for a gun with `ticksLeft` to go out of `total` (L4: longer one-handed): 0 = just fired, 1 = ready. */
export const readyShare = (ticksLeft: number, total: number = GUN.reloadTicks): number => 1 - Math.max(0, Math.min(1, ticksLeft / total));

/** L5 melee weapons (drawing only: bat and mace hit the same; the look is the difference). Meters. */
export const MELEE_LOOK = {
  bat: { length: 0.85, grip: 0.028, end: 0.07, wood: 0xc68a4a, grain: 0x9c6a35 },
  mace: { length: 0.76, handle: 0x5d4037, handleWidth: 0.05, ball: 0.12, spikes: 8, spike: 0.07, head: 0x8d99a6 },
  /** A broken limb: a white zigzag across its elbow / knee. */
  crack: 0xffffff,
} as const;

/** A bat or mace in the front hand, pointing along `angle` (the arm's direction; a swing moves the arm). */
export function drawMelee(g: Phaser.GameObjects.Graphics, v: { hand: Vec2; angle: number; weapon: 'bat' | 'mace'; color: number; alpha?: number }): void {
  const c = Math.cos(v.angle);
  const s = Math.sin(v.angle);
  const a = v.alpha ?? 1;
  const at = (x: number, y: number) => new Phaser.Math.Vector2(px(v.hand.x + x * c - y * s), px(v.hand.y + x * s + y * c));
  if (v.weapon === 'bat') {
    const L = MELEE_LOOK.bat;
    g.fillStyle(L.wood, a).fillPoints([at(-0.1, -L.grip), at(L.length, -L.end), at(L.length, L.end), at(-0.1, L.grip)], true);
    const tip = at(L.length, 0);
    g.fillStyle(L.wood, a).fillCircle(tip.x, tip.y, px(L.end));
    // grip tape in the player's colour
    const t0 = at(-0.1, 0);
    const t1 = at(0.12, 0);
    g.lineStyle(px(L.grip * 2.4), v.color, a).lineBetween(t0.x, t0.y, t1.x, t1.y);
    const g0 = at(0.35, 0);
    const g1 = at(L.length - 0.08, 0);
    g.lineStyle(1.5, L.grain, a).lineBetween(g0.x, g0.y, g1.x, g1.y);
  } else {
    const L = MELEE_LOOK.mace;
    const h0 = at(-0.08, 0);
    const h1 = at(L.length, 0);
    g.lineStyle(px(L.handleWidth), L.handle, a).lineBetween(h0.x, h0.y, h1.x, h1.y);
    const band = at(0.04, 0);
    g.fillStyle(v.color, a).fillCircle(band.x, band.y, px(L.handleWidth * 0.75));
    const ballAt = { x: L.length + L.ball * 0.8, y: 0 };
    for (let i = 0; i < L.spikes; i++) {
      const k = (i / L.spikes) * Math.PI * 2;
      const dx = Math.cos(k);
      const dy = Math.sin(k);
      const side = 0.35;
      g.fillStyle(L.head, a).fillPoints(
        [
          at(ballAt.x + (dx * Math.cos(side) - dy * Math.sin(side)) * L.ball * 0.8, ballAt.y + (dx * Math.sin(side) + dy * Math.cos(side)) * L.ball * 0.8),
          at(ballAt.x + dx * (L.ball + L.spike), ballAt.y + dy * (L.ball + L.spike)),
          at(ballAt.x + (dx * Math.cos(-side) - dy * Math.sin(-side)) * L.ball * 0.8, ballAt.y + (dx * Math.sin(-side) + dy * Math.cos(-side)) * L.ball * 0.8),
        ],
        true,
      );
    }
    const ball = at(ballAt.x, ballAt.y);
    g.fillStyle(L.head, a).fillCircle(ball.x, ball.y, px(L.ball));
    g.fillStyle(0xffffff, 0.25 * a).fillCircle(ball.x - px(L.ball) * 0.3, ball.y - px(L.ball) * 0.3, px(L.ball) * 0.3);
  }
}

