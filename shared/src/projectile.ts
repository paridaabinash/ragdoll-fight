import { launchVelocity, type Aim } from './aim';
import type { ArenaBounds } from './arena';
import { ARENA_MARGIN, ARROW, DT, GRAVITY_Y } from './constants';
import type { Vec2 } from './math';
import { launchPointFrom } from './ragdoll';

/**
 * One physics tick of arrow flight (semi-implicit Euler: speed first, then position).
 * The real arrows AND the aim preview both call this, so the preview is always exact.
 */
export function stepArrow(pos: Vec2, vel: Vec2, dt = DT, push: Vec2 = NO_PUSH): { pos: Vec2; vel: Vec2 } {
  const nextVel = { x: vel.x + push.x * dt, y: vel.y + (GRAVITY_Y + push.y) * dt };
  return { pos: { x: pos.x + nextVel.x * dt, y: pos.y + nextVel.y * dt }, vel: nextVel };
}

/** Extra acceleration on an arrow at a point (wind, S6), besides gravity. */
export type PushField = (p: Vec2) => Vec2;
const NO_PUSH: Vec2 = { x: 0, y: 0 };
const noField: PushField = () => NO_PUSH;

/** Past the arena's edges plus the margins (arrows there are deleted; players there are out). */
export function outOfArena(p: Vec2, bounds: ArenaBounds): boolean {
  return (
    p.x < -ARENA_MARGIN.side ||
    p.x > bounds.width + ARENA_MARGIN.side ||
    p.y > bounds.height + ARENA_MARGIN.bottom ||
    p.y < -ARENA_MARGIN.top
  );
}

/**
 * A whole shot from the bow shoulder: first the arm's length (shoulder -> bow hand), then normal flight from the hand.
 * If something is between shoulder and hand (a wall you stand against, an enemy right in front of you), the arrow
 * hits it at once (`ticks` 0). Without this check the arrow would start on the far side: shooting through walls.
 * The world (exact), the online preview and the stand-in arrow all use this, so they agree.
 */
export function traceShot<H extends { point: Vec2 }>(
  shoulder: Vec2,
  aim: Aim,
  raycast: (from: Vec2, to: Vec2) => H | null,
  bounds: ArenaBounds,
  field: PushField = noField,
): { points: Vec2[]; hit: H | null; ticks: number } {
  const hand = launchPointFrom(shoulder, aim);
  const blocked = raycast(shoulder, hand);
  if (blocked) return { points: [blocked.point], hit: blocked, ticks: 0 };
  return traceArrow(hand, launchVelocity(aim), raycast, bounds, field);
}

/**
 * Full flight path of an arrow: `stepArrow` each tick, then `raycast` from the old to the new position.
 * Used by the server/local world (exact) and by the online client's aim preview (against its own copy of the scene).
 */
export function traceArrow<H extends { point: Vec2 }>(
  start: Vec2,
  vel: Vec2,
  raycast: (from: Vec2, to: Vec2) => H | null,
  bounds: ArenaBounds,
  field: PushField = noField,
): { points: Vec2[]; hit: H | null; ticks: number } {
  let pos = start;
  let v = vel;
  const points = [pos];
  for (let tick = 1; tick <= ARROW.maxFlightTicks; tick++) {
    const next = stepArrow(pos, v, DT, field(pos));
    const hit = raycast(pos, next.pos);
    pos = hit ? hit.point : next.pos;
    v = next.vel;
    points.push(pos);
    if (hit) return { points, hit, ticks: tick };
    if (outOfArena(pos, bounds)) break;
  }
  return { points, hit: null, ticks: points.length - 1 };
}

/** The banana's three pieces: the same speed, turned left / not / right by `spread`. */
export function bananaVelocities(vel: Vec2, spread: number): [Vec2, Vec2, Vec2] {
  const turn = (a: number) => ({ x: vel.x * Math.cos(a) - vel.y * Math.sin(a), y: vel.x * Math.sin(a) + vel.y * Math.cos(a) });
  return [turn(-spread), vel, turn(spread)];
}

/**
 * A shot that splits into three after `splitTicks` (the banana), traced exactly like the real arrows: the middle
 * piece is `points` / `hit` / `ticks` (it is the same arrow), the outer two are `branches`. Splitting happens after
 * the arrow's `splitTicks`-th tick of flight, the same moment the world splits the real one.
 */
export function traceSplitShot<H extends { point: Vec2 }>(
  shoulder: Vec2,
  aim: Aim,
  raycast: (from: Vec2, to: Vec2) => H | null,
  bounds: ArenaBounds,
  splitTicks: number,
  spread: number,
  field: PushField = noField,
): { points: Vec2[]; hit: H | null; ticks: number; branches: Vec2[][] } {
  const hand = launchPointFrom(shoulder, aim);
  const blocked = raycast(shoulder, hand);
  if (blocked) return { points: [blocked.point], hit: blocked, ticks: 0, branches: [] };
  let pos = hand;
  let v = launchVelocity(aim);
  const points = [pos];
  for (let tick = 1; tick <= splitTicks; tick++) {
    const next = stepArrow(pos, v, DT, field(pos));
    const hit = raycast(pos, next.pos);
    pos = hit ? hit.point : next.pos;
    v = next.vel;
    points.push(pos);
    if (hit) return { points, hit, ticks: tick, branches: [] };
    if (outOfArena(pos, bounds)) return { points, hit: null, ticks: tick, branches: [] };
  }
  const [left, mid, right] = bananaVelocities(v, spread);
  const rest = traceArrow(pos, mid, raycast, bounds, field);
  const branch = (vel: Vec2) => traceArrow(pos, vel, raycast, bounds, field).points;
  return { points: [...points, ...rest.points.slice(1)], hit: rest.hit, ticks: splitTicks + rest.ticks, branches: [branch(left), branch(right)] };
}
