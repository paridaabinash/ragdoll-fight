import { describe, expect, it } from 'vitest';
import {
  ARENAS,
  arenaInfo,
  arenaLayout,
  backdropColors,
  BACKYARD,
  CALLOUT_KINDS,
  CALLOUT_SIZE,
  contrastRatio,
  DEFAULT_PALETTE,
  LOOK_RULES,
  luminance,
  paletteProblems,
  PLAYER_COLORS,
  PX_PER_M,
  TRACER_COLOR,
  validateArena,
  type ArenaPalette,
  type CalloutKind,
} from '../src';
// The silhouette generator is pure maths (no Phaser), so it can be tested here.
import { layerTile, TILE_W } from '../../client/src/silhouettes';

describe('L1 arena palettes', () => {
  for (const def of Object.values(ARENAS)) {
    it(`${def.id} has a palette that passes the readability check`, () => {
      expect(def.palette).toBeDefined();
      expect(paletteProblems(def.palette!)).toEqual([]);
      // every player colour and the tracer stand out against sky, glows, layers and terrain
      for (const b of backdropColors(def.palette!)) {
        for (const c of [...PLAYER_COLORS, TRACER_COLOR]) expect(contrastRatio(c, b.color)).toBeGreaterThanOrEqual(LOOK_RULES.minContrast);
      }
    });

    it(`${def.id}: the palette reaches clients at every size`, () => {
      for (const size of ['full', 'narrow'] as const) {
        const info = arenaInfo(arenaLayout(def, size));
        expect(info.palette).toEqual(def.palette);
        // it travels as JSON
        expect(JSON.parse(JSON.stringify(info)).palette).toEqual(def.palette);
      }
    });
  }

  it('the 8 player colours are all different and bright', () => {
    expect(new Set(PLAYER_COLORS).size).toBe(8);
    for (const c of PLAYER_COLORS) expect(luminance(c)).toBeGreaterThan(0.2);
  });

  it('an arena without a palette gets the default one (which passes too)', () => {
    const { palette: _, ...plain } = BACKYARD;
    expect(arenaInfo(arenaLayout(plain, 'full')).palette).toEqual(DEFAULT_PALETTE);
    expect(paletteProblems(DEFAULT_PALETTE)).toEqual([]);
  });

  it('the check catches unreadable palettes, and the arena validator runs it', () => {
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 5);
    const bad: ArenaPalette = {
      ...DEFAULT_PALETTE,
      sky: { top: 0x7a2030, bottom: 0x0b0e14 }, // a bright red sky: the red player vanishes
      layers: [
        { kind: 'hills', color: 0x101010, depth: 0.5, height: 5 },
        { kind: 'trees', color: 0x303030, depth: 0.3, height: 5 }, // nearer but lighter, and moves less
      ],
      glow: [{ color: 0xffffff, x: 0.5, y: 0.5, radius: 0.2, alpha: 0.9 }],
    };
    const problems = paletteProblems(bad).join('\n');
    expect(problems).toMatch(/player 7 #ff3355 on sky.top #7a2030: contrast/);
    expect(problems).toMatch(/layer 0 must move less than layer 1/);
    expect(problems).toMatch(/layer 0 .* is darker than the nearer layer 1/);
    expect(problems).toMatch(/glow 0 alpha 0.9/);
    expect(problems).toMatch(/glow 0 #[0-9a-f]+ is too bright/);
    expect(paletteProblems({ ...DEFAULT_PALETTE, layers: [DEFAULT_PALETTE.layers[0]] }).join()).toMatch(/1 parallax layers, needs 2-3/);
    expect(validateArena(arenaLayout({ ...BACKYARD, palette: bad }, 'full')).join('\n')).toMatch(/backyard\/full: palette: .*contrast/);
  });
});

describe('L1 two-size callouts', () => {
  it('every callout kind has a size, and the big moments are banners', () => {
    const kinds: CalloutKind[] = ['cracked', 'ankle_breaker', 'airball', 'sniped', 'point_blank', 'ring_out', 'outta_here', 'splat', 'slip', 'pinned', 'swapped', 'tickled', 'kaboom', 'bonk', 'revenge', 'double_kill', 'self_own', 'humbled', 'disarmed', 'shattered'];
    expect([...CALLOUT_KINDS].sort()).toEqual([...kinds].sort());
    for (const k of kinds) expect(['tag', 'banner']).toContain(CALLOUT_SIZE[k]);
    // modifications.md section 5
    expect(kinds.filter((k) => CALLOUT_SIZE[k] === 'banner').sort()).toEqual(['disarmed', 'double_kill', 'kaboom', 'outta_here', 'revenge', 'ring_out', 'shattered']);
  });
});

describe('L1 backdrop silhouettes', () => {
  const kinds = ['hills', 'trees', 'houses', 'factory', 'chains'] as const;

  it('the same seed draws the same skyline (every screen sees the same arena)', () => {
    for (const kind of kinds) {
      const layer = { kind, color: 0x202020, depth: 0.3, height: 6 };
      expect(layerTile(layer, 7, 1, PX_PER_M)).toEqual(layerTile(layer, 7, 1, PX_PER_M));
      expect(layerTile(layer, 7, 1, PX_PER_M)).not.toEqual(layerTile(layer, 8, 1, PX_PER_M));
    }
  });

  it('shapes stay inside their tile height and are finite; hills wrap without a seam', () => {
    for (const kind of kinds) {
      const tile = layerTile({ kind, color: 0x202020, depth: 0.3, height: 6 }, 3, 0, PX_PER_M);
      expect(tile.shapes.length).toBeGreaterThan(kind === 'hills' ? 0 : 5);
      for (const s of tile.shapes) {
        const ys = s.t === 'poly' ? s.pts.filter((_, i) => i % 2 === 1) : s.t === 'rect' ? [s.y, s.y + s.h] : [s.y - s.r, s.y + s.r];
        for (const y of ys) {
          expect(Number.isFinite(y)).toBe(true);
          expect(y).toBeGreaterThanOrEqual(-1);
          expect(y).toBeLessThanOrEqual(tile.h + 1);
        }
      }
    }
    const hills = layerTile({ kind: 'hills', color: 0, depth: 0.2, height: 8 }, 11, 0, PX_PER_M).shapes[0];
    if (hills.t !== 'poly') throw new Error('hills should be one polygon');
    // first point (x 0) and the point at x TILE_W have the same height
    const at = (x: number) => hills.pts[hills.pts.findIndex((v, i) => i % 2 === 0 && v === x) + 1];
    expect(at(TILE_W)).toBeCloseTo(at(0), 6);
  });
});
