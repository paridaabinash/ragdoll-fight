import type { ParallaxLayer } from '@ragdoll/shared';

/**
 * L1 backdrop shapes, drawn by code from a seed (no image files). Pure maths (no Phaser, no DOM), so a test can
 * check that the same seed always gives the same skyline and that a tile wraps without a seam.
 *
 * One layer = one horizontal TILE, `TILE_W` px wide, that repeats forever. Coordinates are tile pixels, y down;
 * the silhouettes stand on the tile's bottom edge (y = h), except `chains`, which hang from its top edge (y = 0).
 * Every shape is drawn at x and at x ± TILE_W, so anything crossing a tile edge continues on the other side.
 */
export const TILE_W = 1024;

export type Shape =
  | { t: 'poly'; pts: number[] }
  | { t: 'rect'; x: number; y: number; w: number; h: number }
  | { t: 'circle'; x: number; y: number; r: number };

export interface LayerTile {
  /** Tile height (px). */
  h: number;
  shapes: Shape[];
}

/** Small fast seeded random numbers (mulberry32): the same seed gives the same sequence on every screen. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The shapes of one layer. `pxPerM` turns the layer's height (m) into pixels. */
export function layerTile(layer: ParallaxLayer, seed: number, index: number, pxPerM: number): LayerTile {
  const rnd = seeded(seed * 7919 + index * 104729 + 1);
  const range = (a: number, b: number) => a + (b - a) * rnd();
  const H = Math.ceil(layer.height * pxPerM) + 4;
  const shapes: Shape[] = [];
  const rect = (x: number, y: number, w: number, h: number) => shapes.push({ t: 'rect', x, y, w, h });
  const base = (h: number) => rect(0, H - h, TILE_W, h);

  switch (layer.kind) {
    case 'hills': {
      // two sine waves with whole numbers of periods per tile, so the ends meet
      const k1 = 1 + Math.floor(range(0, 2));
      const k2 = 3 + Math.floor(range(0, 3));
      const p1 = range(0, Math.PI * 2);
      const p2 = range(0, Math.PI * 2);
      const pts: number[] = [];
      for (let x = 0; x <= TILE_W; x += 16) {
        const u = (x / TILE_W) * Math.PI * 2;
        const top = 0.6 + 0.25 * Math.sin(k1 * u + p1) + 0.15 * Math.sin(k2 * u + p2);
        pts.push(x, H - (H - 4) * top);
      }
      pts.push(TILE_W, H, 0, H);
      shapes.push({ t: 'poly', pts });
      break;
    }
    case 'trees': {
      base(H * 0.18);
      for (let x = range(0, 30); x < TILE_W; x += range(28, 70)) {
        const tall = range(0.45, 1) * (H - 4);
        if (rnd() < 0.5) {
          // pine: a tall triangle
          const w = tall * range(0.3, 0.42);
          shapes.push({ t: 'poly', pts: [x - w / 2, H, x, H - tall, x + w / 2, H] });
        } else {
          // round tree: a trunk and two or three blobs
          const r = tall * range(0.22, 0.3);
          rect(x - 3, H - tall + r, 6, tall - r);
          shapes.push({ t: 'circle', x, y: H - tall + r, r });
          shapes.push({ t: 'circle', x: x - r * 0.7, y: H - tall + r * 1.6, r: r * 0.8 });
          if (rnd() < 0.6) shapes.push({ t: 'circle', x: x + r * 0.7, y: H - tall + r * 1.5, r: r * 0.75 });
        }
      }
      break;
    }
    case 'houses': {
      base(H * 0.12);
      for (let x = range(0, 20); x < TILE_W; x += range(10, 40)) {
        const w = range(70, 150);
        const wall = (H - 4) * range(0.3, 0.55);
        const roof = (H - 4) * range(0.25, 0.42);
        rect(x, H - wall, w, wall);
        shapes.push({ t: 'poly', pts: [x - 8, H - wall, x + w / 2, H - wall - roof, x + w + 8, H - wall] });
        if (rnd() < 0.5) rect(x + w * range(0.6, 0.75), H - wall - roof * 0.9, 12, roof * 0.6);
        // a fence to the next house
        const gap = range(10, 40);
        rect(x + w, H - (H - 4) * 0.18, gap + 2, 4);
        x += w;
      }
      break;
    }
    case 'factory': {
      base(H * 0.1);
      for (let x = range(0, 30); x < TILE_W; x += range(20, 60)) {
        const roll = rnd();
        if (roll < 0.3) {
          // chimney: tall and thin, with a lip
          const w = range(14, 26);
          const tall = (H - 4) * range(0.6, 1);
          rect(x, H - tall, w, tall);
          rect(x - 3, H - tall, w + 6, 6);
          x += w;
        } else if (roll < 0.55) {
          // tank: a round top on a block
          const r = range(26, 50);
          const body = (H - 4) * range(0.2, 0.4);
          rect(x, H - body, r * 2, body);
          shapes.push({ t: 'circle', x: x + r, y: H - body, r });
          x += r * 2;
        } else {
          // hall with a saw-tooth roof
          const w = range(90, 180);
          const tall = (H - 4) * range(0.25, 0.5);
          rect(x, H - tall, w, tall);
          const teeth = Math.max(2, Math.round(w / 40));
          const tw = w / teeth;
          for (let i = 0; i < teeth; i++) shapes.push({ t: 'poly', pts: [x + i * tw, H - tall, x + (i + 1) * tw, H - tall - 18, x + (i + 1) * tw, H - tall] });
          x += w;
        }
      }
      break;
    }
    case 'chains': {
      // chains hang from the top edge: links every 14 px, a hook at the end
      for (let x = range(10, 60); x < TILE_W; x += range(60, 160)) {
        const len = (H - 24) * range(0.35, 1);
        for (let y = 0; y < len; y += 14) rect(x - (Math.floor(y / 14) % 2 ? 2 : 4), y, Math.floor(y / 14) % 2 ? 4 : 8, 11);
        shapes.push({ t: 'poly', pts: [x - 2, len, x + 2, len, x + 2, len + 12, x + 10, len + 12, x + 10, len + 6, x + 14, len + 6, x + 14, len + 16, x - 2, len + 16] });
      }
      break;
    }
  }
  return { h: H, shapes };
}
