import { describe, expect, it } from 'vitest';
import { AIM_POINT, aimAlong, moveAimPoint, type Vec2 } from '../src';

describe('L7 character-relative aim point', () => {
  it('moves by the mouse movement and points the gun at it', () => {
    const p = moveAimPoint({ x: 3, y: 0 }, 0, -3);
    expect(p).toEqual({ x: 3, y: -3 });
    expect(aimAlong(p)!.angle).toBeCloseTo(-Math.PI / 4);
  });

  it('never goes further than maxDistance, and keeps its direction at the limit', () => {
    const p = moveAimPoint({ x: 3, y: 0 }, 100, 0);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(AIM_POINT.maxDistance);
    expect(aimAlong(p)!.angle).toBeCloseTo(0);
    // at the limit, moving sideways turns the aim instead of getting stuck
    const q = moveAimPoint(p, 0, 2);
    expect(Math.hypot(q.x, q.y)).toBeCloseTo(AIM_POINT.maxDistance);
    expect(aimAlong(q)!.angle).toBeGreaterThan(0.3);
  });

  it('turns around by passing through the body (a mouse move of start + a bit flips the side)', () => {
    let p: Vec2 = { x: AIM_POINT.start, y: 0 };
    p = moveAimPoint(p, -(AIM_POINT.start + 1), 0);
    expect(p.x).toBeLessThan(0);
    expect(Math.abs(aimAlong(p)!.angle)).toBeCloseTo(Math.PI);
  });

  it('ignores broken movement and has no direction on the shoulder itself', () => {
    const p = { x: 2, y: 1 };
    expect(moveAimPoint(p, NaN, 0)).toBe(p);
    expect(moveAimPoint(p, 0, Infinity)).toBe(p);
    expect(aimAlong({ x: 0, y: 0 })).toBeNull();
  });
});
