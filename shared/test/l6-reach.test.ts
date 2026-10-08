import { describe, expect, it } from 'vitest';
import { ARENAS, arenaLayout, arenaReach, describeSurface, jumpReach, ABILITY, REACH, ROTATION, type ArenaDef, type ArenaLayout } from '../src';

/** A bare layout: ground from x 0-40 at y 20 plus `solids`, spawns on the ground. */
function layout(solids: ArenaDef['solids'], extra: Partial<ArenaLayout> = {}): ArenaLayout {
  return {
    id: 't',
    name: 't',
    size: 'full',
    width: 40,
    height: 22,
    solids: [{ label: 'ground', x: 0, y: 20, w: 40, h: 2 }, ...solids],
    spawns: [{ x: 2, y: 20, facing: 1 }],
    crates: [],
    pits: [],
    apples: [],
    pickups: [],
    hazards: [],
    ...extra,
  };
}

describe('L6 arena reach check', () => {
  for (const def of Object.values(ARENAS)) {
    for (const size of def.narrow ? (['narrow', 'full'] as const) : (['full'] as const)) {
      it(`${def.id}/${size}: every place leads to every other (no unreachable place, no island, no pocket without a way out)`, () => {
        const r = arenaReach(arenaLayout(def, size));
        expect(r.unreachable.map(describeSurface)).toEqual([]);
        expect(r.traps.map(describeSurface)).toEqual([]);
        expect(r.blockedTrampolines).toEqual([]);
      });
    }
  }

  it('the rotation has the final arenas first, then the placeholders (kept by choice)', () => {
    expect(ROTATION.map((a) => a.id)).toEqual(['windy_rooftop', 'construction_site', 'test_lab', 'backyard']);
  });

  it('jump reach follows the measured numbers: level gap, shorter going up, longer going down, nothing past the climb', () => {
    expect(jumpReach(ABILITY.whole, 0)).toBeCloseTo(REACH.gap);
    expect(jumpReach(ABILITY.whole, 1)).toBeCloseTo(REACH.gapUp1);
    expect(jumpReach(ABILITY.whole, REACH.climb)).toBeCloseTo(0);
    expect(jumpReach(ABILITY.whole, REACH.climb + 0.1)).toBeLessThan(0);
    expect(jumpReach(ABILITY.whole, -2)).toBeGreaterThan(REACH.gap * 1.2); // more time falling
    expect(jumpReach(ABILITY.stumps, 1)).toBeLessThan(0); // two stumps don't climb 1 m
  });

  it('finds a ledge too high to climb, and a gap too wide to jump', () => {
    const tooHigh = arenaReach(layout([{ label: 'wall', x: 20, y: 18, w: 20, h: 2 }]));
    expect(tooHigh.unreachable.map((s) => s.labels[0])).toEqual(['wall']);
    const climbable = arenaReach(layout([{ label: 'step', x: 20, y: 20 - REACH.climb + 0.1, w: 20, h: REACH.climb - 0.1 }]));
    expect(climbable.unreachable).toEqual([]);
    const gap = (w: number) =>
      arenaReach(
        layout([], {
          solids: [
            { label: 'left', x: 0, y: 20, w: 10, h: 2 },
            { label: 'right', x: 10 + w, y: 20, w: 30 - w, h: 2 },
          ],
        }),
      );
    expect(gap(REACH.gap - 0.2).unreachable).toEqual([]);
    expect(gap(REACH.gap + 0.5).unreachable.map((s) => s.labels[0])).toEqual(['right']); // an island
  });

  it('finds a pocket you can drop into but not leave (Test Lab had two, between its stairs and the pit)', () => {
    // a 2 m deep hole in the floor: you fall in, the 2 m walls are too high to climb back out
    const r = arenaReach(
      layout([], {
        solids: [
          { label: 'left', x: 0, y: 20, w: 15, h: 2 },
          { label: 'hole', x: 15, y: 22, w: 2, h: 0.5 },
          { label: 'right', x: 17, y: 20, w: 23, h: 2 },
        ],
        height: 23,
      }),
    );
    expect(r.traps.map((s) => s.labels[0])).toEqual(['hole']);
  });

  it('a solid marked decor is scenery, not a place; a seesaw plank is a place (Windy Rooftop is crossed on one)', () => {
    expect(arenaReach(layout([{ label: 'shelf', x: 20, y: 12, w: 4, h: 0.4, decor: true }])).surfaces.map((s) => s.labels[0])).toEqual(['ground']);
    const bridged = (withPlank: boolean) =>
      arenaReach(
        layout([], {
          solids: [
            { label: 'left', x: 0, y: 20, w: 10, h: 2 },
            { label: 'right', x: 16, y: 20, w: 24, h: 2 },
          ],
          hazards: withPlank ? [{ kind: 'seesaw', label: 'plank', x: 13, y: 20, length: 5 }] : [],
        }),
      );
    expect(bridged(false).unreachable.length).toBeGreaterThan(0);
    expect(bridged(true).unreachable).toEqual([]);
  });

  it('a trampoline leads up to what is beside it, and is flagged when something hangs over it (it throws you into its underside)', () => {
    const high = { label: 'high', x: 20, y: 14, w: 10, h: 0.4 };
    const beside = arenaReach(layout([high], { hazards: [{ kind: 'trampoline', label: 'pad', x: 17, y: 20, w: 1.6, power: 19 }] }));
    expect(beside.unreachable).toEqual([]);
    expect(beside.blockedTrampolines).toEqual([]);
    const under = arenaReach(layout([high], { hazards: [{ kind: 'trampoline', label: 'pad', x: 24, y: 20, w: 1.6, power: 19 }] }));
    expect(under.blockedTrampolines).toMatchObject([{ label: 'pad', by: 'high' }]);
    expect(arenaReach(layout([high])).unreachable.map((s) => s.labels[0])).toEqual(['high']); // and without it: out of reach
  });
});
