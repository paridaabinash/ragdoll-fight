import type { ArenaDef } from '../arena';

/**
 * Frozen Lake (L7), the aurora arena. Duel-first like Windy Rooftop: the SMALL size
 * (1-4 players, x 12-52) is a 40 m duel across a frozen lake; the full size (5-8) adds a snowy cliff on each side.
 *
 * The idea: the middle is slippery ice (no grip: you slide when you stop, a knock sends you skating) with a hole in
 * it at the centre. The hole is 3 m (an ordinary jump clears 3.5 m) and falling in is a ring-out, so a fight on the ice
 * is about not sliding into it. Each side: a snowy bank 1 m above the ice, a frozen rock as low cover out on the ice,
 * a snow mound with pines and above it an ice shelf hanging out over the lake (slippery, a sniper's perch you can slide off).
 * The health apple floats over the hole: greed pulls you out onto the ice.
 *
 * Heights follow the reach rules (an ordinary jump climbs 1.4 m): bank 1 m above the ice, snow mound 1.3 m above the bank,
 * shelf 1.3 m above the ledge.
 */
const O = 12; // where the duel part starts in the full arena
const LAKE = 18; // the ice top
const BANK = 17; // the snowy banks, 1 m above the ice
const BOTTOM = 22;
const LEDGE = BANK - 1.3;
const SHELF = LEDGE - 1.3;
const X = (x: number) => O + x;

export const FROZEN_LAKE: ArenaDef = {
  id: 'frozen_lake',
  name: 'Frozen Lake',
  width: 64,
  height: BOTTOM,
  narrow: { from: X(0), to: X(40) },
  solids: [
    // ---- the duel: left bank (0-8), the lake (8-32) with the hole (18.5-21.5), right bank (32-40), mirrored ----
    { label: 'bank_l', x: X(0), y: BANK, w: 8, h: BOTTOM - BANK },
    { label: 'ice_l', x: X(8), y: LAKE, w: 10.5, h: BOTTOM - LAKE, surface: 'ice' },
    { label: 'ice_r', x: X(21.5), y: LAKE, w: 10.5, h: BOTTOM - LAKE, surface: 'ice' },
    { label: 'bank_r', x: X(32), y: BANK, w: 8, h: BOTTOM - BANK },
    { label: 'lake_bed', x: X(18.5), y: BOTTOM - 1, w: 3, h: 1 },
    // frozen rocks: low cover out on the ice
    { label: 'rock_l', x: X(12.5), y: LAKE - 1.2, w: 1.4, h: 1.2 },
    { label: 'rock_r', x: X(26.1), y: LAKE - 1.2, w: 1.4, h: 1.2 },
    // snow mounds with pines on the banks, and ice shelves above them hanging out over the lake
    { label: 'pine_ledge_l', x: X(2), y: LEDGE, w: 4, h: BANK - LEDGE },
    // (each shelf starts 0.5 m out past its mound: right over the mound's edge it left a 0.9 m slot a body got wedged in;
    // 1 m out was too far to jump at 1.3 m up)
    { label: 'ice_shelf_l', x: X(6.5), y: SHELF, w: 4.5, h: 0.4, surface: 'ice' },
    { label: 'pine_ledge_r', x: X(34), y: LEDGE, w: 4, h: BANK - LEDGE },
    { label: 'ice_shelf_r', x: X(29), y: SHELF, w: 4.5, h: 0.4, surface: 'ice' },
    // ---- full size only: snowfields outside, with snow steps up to a cliff on each side ----
    { label: 'snowfield_l', x: 0, y: BANK, w: O, h: BOTTOM - BANK },
    { label: 'snowfield_r', x: X(40), y: BANK, w: 64 - X(40), h: BOTTOM - BANK },
    { label: 'snow_step_l', x: 5, y: LEDGE, w: 3, h: BANK - LEDGE },
    { label: 'cliff_l', x: 0, y: SHELF, w: 5, h: BANK - SHELF },
    { label: 'snow_step_r', x: 56, y: LEDGE, w: 3, h: BANK - LEDGE },
    { label: 'cliff_r', x: 59, y: SHELF, w: 5, h: BANK - SHELF },
  ],
  crates: [
    { label: 'crate_bank_l', x: X(7), y: BANK - 0.5, size: 1 },
    { label: 'crate_bank_r', x: X(33), y: BANK - 0.5, size: 1 },
  ],
  pits: [
    // the hole in the ice: fall in = ring out
    { label: 'ice_hole', x: X(18.5), y: LAKE + 1.2, w: 3, h: BOTTOM - 1 - LAKE - 1.2 },
  ],
  spawns: [
    // duel: back of each bank, the pine ledges, the ice shelves
    { x: X(1), y: BANK, facing: 1 },
    { x: X(39), y: BANK, facing: -1 },
    { x: X(4), y: LEDGE, facing: 1 },
    { x: X(36), y: LEDGE, facing: -1 },
    { x: X(8), y: SHELF, facing: 1 },
    { x: X(32), y: SHELF, facing: -1 },
    // full size: the snowfields and cliffs
    { x: 9, y: BANK, facing: 1 },
    { x: 55, y: BANK, facing: -1 },
    { x: 2.5, y: SHELF, facing: 1 },
    { x: 61.5, y: SHELF, facing: -1 },
  ],
  apples: [
    { kind: 'red', x: X(20), y: 15.6 }, // over the hole: greed pulls you onto the ice
    { kind: 'gold', x: X(8), y: SHELF - 2.5 },
    { kind: 'gold', x: X(32), y: SHELF - 2.5 },
    { kind: 'red', x: 2.5, y: SHELF - 2 },
    { kind: 'red', x: 61.5, y: SHELF - 2 },
  ],
  pickups: [{ x: X(20), y: 10 }],
  hazards: [],
  // An arctic night: teal-black sky, aurora curtains (green rays fading to violet), pale-green edges.
  palette: {
    sky: { top: 0x06100f, bottom: 0x040808 },
    horizon: LAKE,
    layers: [],
    terrain: 0x0a1110,
    accent: 0x4fdc8c,
    glow: [
      { color: 0x3cc896, x: 0.3, y: 0.15, radius: 0.16, alpha: 0.12 },
      { color: 0x7c5cc8, x: 0.78, y: 0.1, radius: 0.12, alpha: 0.08 },
    ],
    aurora: [
      { color: 0x50eba5, top: 0x6e5abe, y: 0.3, height: 0.22, fold: 0.07, alpha: 0.16, phase: 0.4 },
      { color: 0x3cbe96, top: 0x6e5abe, y: 0.2, height: 0.15, fold: 0.05, alpha: 0.1, phase: 2.3 },
      { color: 0x46aa96, top: 0x7c5cc8, y: 0.12, height: 0.1, fold: 0.035, alpha: 0.06, phase: 4.1 },
    ],
    dust: 0x5f7a78,
    seed: 61,
  },
};
