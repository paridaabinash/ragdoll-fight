import { AIM_POINT, GRAVITY_Y, GUN } from './constants';
import type { Vec2 } from './math';

/**
 * L3: where the gun points. Only a direction: every bullet leaves at the same speed (GUN.bulletSpeed), so how far
 * away the mouse pointer is doesn't matter. (The bow's `power` is gone.)
 */
export interface Aim {
  /** Shot direction in radians (0 = right, +PI/2 = down, because y points down). */
  angle: number;
}

/** The aim from a point (your shoulder) toward another (the mouse pointer in the world). */
export function aimAt(from: Vec2, to: Vec2): Aim {
  return { angle: Math.atan2(to.y - from.y, to.x - from.x) };
}

/**
 * L7 character-relative aim: the mouse moves an aim point that is attached to your shoulder (an offset in m), not a
 * spot on the screen, so walking, jumping and the camera never change your aim. It can't go further than
 * `AIM_POINT.maxDistance` (so a small mouse move always turns you), and it can pass through your body (that's how you
 * turn around). Non-finite moves are ignored.
 */
export function moveAimPoint(offset: Vec2, dx: number, dy: number, max = AIM_POINT.maxDistance): Vec2 {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return offset;
  const x = offset.x + dx;
  const y = offset.y + dy;
  const d = Math.hypot(x, y);
  return d > max ? { x: (x * max) / d, y: (y * max) / d } : { x, y };
}

/** The aim along an aim-point offset; null when it sits exactly on the shoulder (no direction). */
export function aimAlong(offset: Vec2): Aim | null {
  return Math.hypot(offset.x, offset.y) > 1e-6 ? { angle: Math.atan2(offset.y, offset.x) } : null;
}

/** A real number. Anything else (NaN, Infinity) is refused; this guards network input too. */
export const isValidAim = (aim: Aim): boolean => !!aim && Number.isFinite(aim.angle);

export function launchVelocity(aim: Aim): Vec2 {
  return { x: Math.cos(aim.angle) * GUN.bulletSpeed, y: Math.sin(aim.angle) * GUN.bulletSpeed };
}

/**
 * The aim angle that lands a bullet of `speed` (m/s) from `from` on `to`, under gravity (no walls considered).
 * `high`: the steep lob instead of the flat shot. Null if `to` is out of reach at that speed.
 */
export function solveAim(from: Vec2, to: Vec2, speed: number = GUN.bulletSpeed, high = false): number | null {
  const dx = to.x - from.x;
  const up = from.y - to.y; // y points down
  const g = GRAVITY_Y;
  const v2 = speed * speed;
  if (Math.abs(dx) < 1e-6) return up >= 0 ? -Math.PI / 2 : Math.PI / 2;
  const disc = v2 * v2 - g * (g * dx * dx + 2 * up * v2);
  if (disc < 0) return null;
  const elev = Math.atan((v2 + (high ? 1 : -1) * Math.sqrt(disc)) / (g * Math.abs(dx)));
  return Math.atan2(-Math.sin(elev), Math.sign(dx) * Math.cos(elev));
}
