import type { ArenaDef } from '../arena';

/**
 * The original test range (Phases 1-4), one size (32 x 18 m, fits one screen). Ground top at y 17.
 * - thin_wall: 0.1 m thick, thinner than one tick of a full-power arrow -> proves no pass-through
 * - crates: dynamic, so hits visibly push them and stuck arrows must ride along
 * - apples: red (health) and gold (stamina), floating mid-air between the players
 * Tests and sim scenarios rely on these exact positions.
 */
export const BACKYARD: ArenaDef = {
  id: 'backyard',
  name: 'Backyard',
  width: 32,
  height: 18,
  solids: [
    { label: 'ground', x: 0, y: 17, w: 32, h: 1 },
    { label: 'thin_wall', x: 11.95, y: 14, w: 0.1, h: 3 },
    // (a shelf for the crates, 5.2 m up with no way onto it: scenery, out of reach on purpose)
    { label: 'platform', x: 20, y: 11.8, w: 4, h: 0.4, decor: true },
  ],
  crates: [
    { label: 'crate_1', x: 21.5, y: 11.3, size: 1 },
    { label: 'crate_2', x: 21.5, y: 10.3, size: 1 },
    { label: 'crate_3', x: 26, y: 16.5, size: 1 },
  ],
  // 8 spots (one per player in a full room), facing the middle, clear of the thin wall (x 12) and crate_3 (x 26).
  spawns: [4, 29, 16, 8, 23, 2, 19, 30.5].map((x) => ({ x, y: 17, facing: x < 16 ? 1 : -1 }) as const),
  apples: [
    { kind: 'red', x: 13, y: 9 },
    { kind: 'gold', x: 19, y: 6 },
  ],
  // S5: one power-up bubble, high in the middle (shoot it for a special arrow)
  pickups: [{ x: 16, y: 4 }],
  // L1: a backyard at night: far hills, a tree line, the neighbours' roofs; crimson grass.
  palette: {
    sky: { top: 0x0a0b16, bottom: 0x1e1830 },
    horizon: 17,
    // L7 clean look: no silhouettes (buildings, chains, trees made the screen busy); the sky and glows set the mood
    layers: [],
    terrain: 0x0c0a12,
    accent: 0xd81b60,
    glow: [{ color: 0xc5cae9, x: 0.8, y: 0.16, radius: 0.07, alpha: 0.14 }],
    dust: 0x6b5a7a,
    seed: 7,
  },
};
