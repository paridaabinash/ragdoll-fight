import type { ArenaDef } from '../arena';

/**
 * Windy Rooftop. Designed duel-first: the SMALL size (1-4 players, x 16-56) is a 40 m duel, two mirrored rooftops over
 * an alley (a little more than the camera's 36 m view: the far roof is one lean of the view away). The full size
 * (5-8 players) adds two lower rooftops outside.
 *
 * The wind is one fair, symmetric air flow: it rises out of the alley (updraft) and spills outward over both roofs up
 * high. Low, flat shots feel no wind but hit the AC units; high lobs float over the alley and get pushed back. Both
 * players face the same wind, mirrored. (Wind is always on, so the aim preview shows it exactly.)
 *
 * Heights: roof top y 15 (7 m above the street). L6 re-measure (sim `jump_reach`: an ordinary jump climbs 1.4 m, clears
 * 3.5 m): the stairwell hut is 1.3 m and the water tower deck 1 m above it (the draft's 2 m hut was out of reach); the
 * 6 m alley is too wide to jump: you cross on the plank (a seesaw, 0.5 m short of each roof) or not at all.
 */
const O = 16; // where the duel part starts in the full arena
const ROOF = 15;
const BOTTOM = 22;
/** Hut and water tower deck tops, above the roof (m). */
const HUT = 1.3;
const TOWER = 2.3;
/** x in duel coordinates (0-40) -> full arena x */
const X = (x: number) => O + x;
const roof = (label: string, x0: number, x1: number) => ({ label, x: X(x0), y: ROOF, w: x1 - x0, h: BOTTOM - ROOF });
/** Wind reaches up to here (10 m above the top edge): high bullets fly up there and must feel it too. */
const SKY = -10;
/** Skylight glass thickness (m). */
const SKYLIGHT = 0.3;

export const WINDY_ROOFTOP: ArenaDef = {
  id: 'windy_rooftop',
  name: 'Windy Rooftop',
  width: 72,
  height: BOTTOM,
  narrow: { from: X(0), to: X(40) },
  solids: [
    // ---- the duel: left roof (x 0-17), alley (17-23), right roof (23-40), mirrored ----
    roof('roof_l', 0, 8),
    // skylights: a strip of glass (slippery) in the roof, flush with it
    { label: 'skylight_l', x: X(8), y: ROOF, w: 3.5, h: SKYLIGHT, surface: 'ice' },
    { label: 'roof_l_under', x: X(8), y: ROOF + SKYLIGHT, w: 3.5, h: BOTTOM - ROOF - SKYLIGHT },
    roof('roof_l_edge', 11.5, 17),
    roof('roof_r_edge', 23, 28.5),
    { label: 'skylight_r', x: X(28.5), y: ROOF, w: 3.5, h: SKYLIGHT, surface: 'ice' },
    { label: 'roof_r_under', x: X(28.5), y: ROOF + SKYLIGHT, w: 3.5, h: BOTTOM - ROOF - SKYLIGHT },
    roof('roof_r', 32, 40),
    { label: 'alley_floor', x: X(17), y: BOTTOM - 1, w: 6, h: 1 },
    // stairwell hut -> water tower deck: one ordinary jump each
    { label: 'hut_l', x: X(4), y: ROOF - HUT, w: 3, h: HUT },
    { label: 'tower_l', x: X(7), y: ROOF - TOWER, w: 4, h: 0.4 },
    { label: 'hut_r', x: X(33), y: ROOF - HUT, w: 3, h: HUT },
    { label: 'tower_r', x: X(29), y: ROOF - TOWER, w: 4, h: 0.4 },
    // AC units: low cover near the alley (a crate sits on each: shoot it off their cover)
    { label: 'ac_l', x: X(12), y: ROOF - 1, w: 1.4, h: 1 },
    { label: 'ac_r', x: X(26.6), y: ROOF - 1, w: 1.4, h: 1 },
    // ---- full size only: lower rooftops outside, 3 m gaps (a run and a jump: 2 m down, up to 5 m clears) ----
    { label: 'roof_far_l', x: 0, y: ROOF + 2, w: 13, h: BOTTOM - ROOF - 2 },
    { label: 'roof_far_r', x: 59, y: ROOF + 2, w: 13, h: BOTTOM - ROOF - 2 },
    // roof vents at the lower roofs' inner edges: the way back up (1 m up across the 3 m gap; 2 m was out of reach)
    { label: 'vent_l', x: 10.5, y: ROOF + 1, w: 2.5, h: 1 },
    { label: 'vent_r', x: 59, y: ROOF + 1, w: 2.5, h: 1 },
    { label: 'gap_l_floor', x: 13, y: BOTTOM - 1, w: 3, h: 1 },
    { label: 'gap_r_floor', x: 56, y: BOTTOM - 1, w: 3, h: 1 },
  ],
  crates: [
    { label: 'crate_ac_l', x: X(12.7), y: ROOF - 1.4, size: 0.8 },
    { label: 'crate_ac_r', x: X(27.3), y: ROOF - 1.4, size: 0.8 },
    { label: 'crate_far_l', x: 6, y: ROOF + 1.5, size: 1 },
    { label: 'crate_far_r', x: 66, y: ROOF + 1.5, size: 1 },
  ],
  pits: [
    // falling into the alley / a gap between buildings = ring out
    { label: 'alley', x: X(17), y: ROOF + 1.2, w: 6, h: BOTTOM - 1 - ROOF - 1.2 },
    { label: 'gap_l', x: 13, y: ROOF + 3.2, w: 3, h: BOTTOM - 1 - ROOF - 3.2 },
    { label: 'gap_r', x: 56, y: ROOF + 3.2, w: 3, h: BOTTOM - 1 - ROOF - 3.2 },
  ],
  spawns: [
    // duel: back of each roof, and on each stairwell hut
    { x: X(2), y: ROOF, facing: 1 },
    { x: X(38), y: ROOF, facing: -1 },
    { x: X(5.5), y: ROOF - HUT, facing: 1 },
    { x: X(34.5), y: ROOF - HUT, facing: -1 },
    // and each water tower deck (a duel of 4 needs more spawns than players, so a respawn finds a free one)
    { x: X(9), y: ROOF - TOWER, facing: 1 },
    { x: X(31), y: ROOF - TOWER, facing: -1 },
    // full size: the lower roofs
    { x: 3, y: ROOF + 2, facing: 1 },
    { x: 69, y: ROOF + 2, facing: -1 },
    { x: 10, y: ROOF + 2, facing: 1 },
    { x: 62, y: ROOF + 2, facing: -1 },
  ],
  apples: [
    { kind: 'red', x: X(20), y: 9 }, // floating in the updraft over the alley
    { kind: 'gold', x: X(4), y: 6 }, // high, in the spill wind
    { kind: 'gold', x: X(36), y: 6 },
    { kind: 'red', x: 6.5, y: 12 },
    { kind: 'red', x: 65.5, y: 12 },
  ],
  pickups: [{ x: X(20), y: 5.5 }], // top of the updraft: lob into it
  hazards: [
    // air rising out of the alley: bullets float (gravity 20 - 7), people fall in slower
    { kind: 'wind', label: 'updraft', x: X(17), y: SKY, w: 6, h: BOTTOM - 1 - SKY, ax: 0, ay: -7 },
    // ...spilling outward over both roofs, from 4 m above the roof up into the sky (the water tower decks are just under it)
    { kind: 'wind', label: 'gust_l', x: X(0), y: SKY, w: 17, h: ROOF - 4 - SKY, ax: -5, ay: 0 },
    { kind: 'wind', label: 'gust_r', x: X(23), y: SKY, w: 17, h: ROOF - 4 - SKY, ax: 5, ay: 0 },
    // a loose plank across the alley: 0.5 m short of each roof, tips under you
    { kind: 'seesaw', label: 'plank', x: X(20), y: ROOF, length: 5 },
  ],
  // A city roof at night: a far skyline, nearer office blocks, water tanks and roof huts; neon-teal roof edges.
  palette: {
    sky: { top: 0x070a14, bottom: 0x1a1a2e },
    horizon: ROOF,
    layers: [
      { kind: 'factory', color: 0x262a40, depth: 0.12, height: 16 },
      { kind: 'houses', color: 0x1a1d2e, depth: 0.3, height: 11 },
      { kind: 'factory', color: 0x10121d, depth: 0.55, height: 6 },
    ],
    terrain: 0x0b0d16,
    accent: 0x1de9b6,
    glow: [
      { color: 0xff4081, x: 0.15, y: 0.35, radius: 0.12, alpha: 0.1 },
      { color: 0x80deea, x: 0.82, y: 0.2, radius: 0.08, alpha: 0.12 },
    ],
    dust: 0x5c6378,
    seed: 41,
  },
};
