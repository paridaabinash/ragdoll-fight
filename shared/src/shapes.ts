import { add, rotate, vec, type Vec2 } from './math';
import type { Shape } from './ragdoll';

/** World-space outline of a shape at a pose: corners for a box, center + radius for a ball. */
export function outlineOf(shape: Shape, pos: Vec2, angle: number): { points: Vec2[]; circle?: { center: Vec2; radius: number } } {
  if ('r' in shape) return { points: [], circle: { center: { x: pos.x, y: pos.y }, radius: shape.r } };
  const { hx, hy } = shape;
  return { points: [vec(-hx, -hy), vec(hx, -hy), vec(hx, hy), vec(-hx, hy)].map((p) => add(pos, rotate(p, angle))) };
}

/** A shape placed in the world (what the online client knows about the scene from snapshots). */
export interface PlacedShape {
  label: string;
  shape: Shape;
  pos: Vec2;
  angle: number;
}

/**
 * First shape hit on the segment from -> to (like Rapier's castRay with solid shapes:
 * starting inside a shape counts as a hit at the start). Pure math, so the online client
 * can preview shots without its own physics engine.
 */
export function raycastShapes(from: Vec2, to: Vec2, shapes: PlacedShape[]): { point: Vec2; label: string } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let best = Infinity;
  let label = '';
  for (const s of shapes) {
    const t = 'r' in s.shape ? segmentCircle(from, dx, dy, s.pos, s.shape.r) : segmentBox(from, dx, dy, s.pos, s.angle, s.shape.hx, s.shape.hy);
    if (t !== null && t < best) [best, label] = [t, s.label];
  }
  return best === Infinity ? null : { point: { x: from.x + dx * best, y: from.y + dy * best }, label };
}

/** Fraction 0..1 along the segment where it enters the circle, or null. */
function segmentCircle(o: Vec2, dx: number, dy: number, c: Vec2, r: number): number | null {
  const fx = o.x - c.x;
  const fy = o.y - c.y;
  const cc = fx * fx + fy * fy - r * r;
  if (cc <= 0) return 0; // starts inside
  const a = dx * dx + dy * dy;
  if (a === 0) return null;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

/** Same for a rotated box: move the segment into the box's own frame, then clip against its sides. */
function segmentBox(o: Vec2, dx: number, dy: number, c: Vec2, angle: number, hx: number, hy: number): number | null {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const lx = (o.x - c.x) * cos - (o.y - c.y) * sin;
  const ly = (o.x - c.x) * sin + (o.y - c.y) * cos;
  const ldx = dx * cos - dy * sin;
  const ldy = dx * sin + dy * cos;
  let tMin = 0;
  let tMax = 1;
  const axes: [number, number, number][] = [
    [lx, ldx, hx],
    [ly, ldy, hy],
  ];
  for (const [p, d, h] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (p < -h || p > h) return null;
      continue;
    }
    let t1 = (-h - p) / d;
    let t2 = (h - p) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}
