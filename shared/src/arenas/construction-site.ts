import { groundWithPits, type ArenaDef } from '../arena';

/**
 * Construction Site (L6). 64 x 27 m; the small size (1-4 players) is the middle 40 m (x 12-52). Ground top at y 23;
 * "h" below = meters above the ground. Mirrored around x 32, so both sides are the same.
 *
 *                 crane deck (h14.4, over the pit)  <- scaffold boards from the girders (slow, exposed)
 *     girder (h10.8)  <- trampoline on the mid deck     girder (h10.8)
 *   mid deck (h6)  <- ground trampoline (fast) or pallets + a board (slow)
 *   ground ...... pallets |  pit (x 28-36) + wrecking ball  | pallets ...... ground
 *
 * Sized with the L6 numbers (sim `jump_reach`): every climb is one ordinary jump (1.2 m: an ordinary jump climbs 1.4 m),
 * trampolines (power 19: about 7 m up) sit beside what they lead to, never under it (the L2 lesson), and the ground
 * ones can be reached on two stumps (the L4 note). The reach check (`arenaReach`) proves every place leads to every other.
 */
const FLOOR = 23;
const BOTTOM = 27;
const W = 64;
const ground = groundWithPits(W, FLOOR, BOTTOM, [{ x: 28, w: 8, depth: 3 }]);

type Solid = ArenaDef['solids'][number];
/** A block standing on the ground, `h` tall. */
const block = (label: string, x: number, w: number, h: number): Solid => ({ label, x, y: FLOOR - h, w, h });
/** A thin platform whose top is `h` above the ground. */
const ledge = (label: string, x: number, w: number, h: number, thick = 0.4): Solid => ({ label, x, y: FLOOR - h, w, h: thick });
/** The right side's copy of a left-side solid (mirrored around the middle). */
const mirror = (s: Solid): Solid => ({ ...s, label: s.label.replace(/_l(\d*)$/, '_r$1'), x: W - s.x - s.w });

const MID = 6;
const GIRDER = 10.8;
const CRANE = 14.4;

/** The left half; the right half is its mirror. */
const LEFT: Solid[] = [
  // slow way up to the mid deck: stacked pallets, then a scaffold board (each 1.2 m higher). 3 m of ground between
  // the pallets and the pit: room for a run-up (a 1 m strip let a bot back its legs over the pit edge and hang there)
  block('pallets_l1', 20, 5, 1.2),
  block('pallets_l2', 20, 3.5, 2.4),
  block('pallets_l3', 20, 2, 3.6),
  ledge('board_l1', 18, 3, 4.8, 0.3),
  // the mid deck (the ground trampoline at its outer end throws you up beside it)
  ledge('deck_l', 14, 6, MID, 0.5),
  // the girder (the mid deck's trampoline throws you up beside it)
  ledge('girder_l', 20, 6, GIRDER),
  // scaffold boards from the girder up to the crane deck
  ledge('board_l2', 21, 2.5, GIRDER + 1.2, 0.3),
  ledge('board_l3', 23, 3, GIRDER + 2.4, 0.3),
  // concrete blocks: low cover (one under the mid deck, one in the outer yard)
  block('block_l1', 16.5, 1.2, 1),
  block('block_l2', 6, 1.2, 1.2),
];

export const CONSTRUCTION_SITE: ArenaDef = {
  id: 'construction_site',
  name: 'Construction Site',
  width: W,
  height: BOTTOM,
  narrow: { from: 12, to: 52 },
  solids: [
    ...ground.solids,
    ...LEFT,
    ...LEFT.map(mirror),
    // the crane deck across the middle, over the pit: sees everything, hides nothing
    ledge('crane_deck', 26, 12, CRANE, 0.5),
  ],
  crates: [
    // (cover on the ground under each mid deck; not on the pallet stairs: one there blocked the slow way up, sim arena_fights)
    { label: 'crate_l1', x: 18.8, y: FLOOR - 0.5, size: 1 },
    { label: 'crate_r1', x: 45.2, y: FLOOR - 0.5, size: 1 },
    { label: 'crate_l2', x: 3, y: FLOOR - 0.5, size: 1 },
    { label: 'crate_r2', x: 61, y: FLOOR - 0.5, size: 1 },
  ],
  pits: ground.pits,
  spawns: [
    // middle part (also the small size): the ground under each mid deck, and each mid deck
    { x: 15.5, y: FLOOR, facing: 1 },
    { x: 48.5, y: FLOOR, facing: -1 },
    { x: 15.5, y: FLOOR - MID, facing: 1 },
    { x: 48.5, y: FLOOR - MID, facing: -1 },
    // and the first pallet step each side (more spawns than a small room's players, so a respawn finds a free one)
    { x: 24.3, y: FLOOR - 1.2, facing: 1 },
    { x: W - 24.3, y: FLOOR - 1.2, facing: -1 },
    // outer yards (full size only)
    { x: 2, y: FLOOR, facing: 1 },
    { x: 62, y: FLOOR, facing: -1 },
    { x: 9, y: FLOOR, facing: 1 },
    { x: 55, y: FLOOR, facing: -1 },
  ],
  apples: [
    { kind: 'red', x: 32, y: FLOOR - CRANE - 2.5 }, // over the crane deck: the most exposed spot
    { kind: 'gold', x: 23, y: FLOOR - GIRDER - 4.5 },
    { kind: 'gold', x: 41, y: FLOOR - GIRDER - 4.5 },
    { kind: 'red', x: 4, y: FLOOR - 4 },
    { kind: 'red', x: 60, y: FLOOR - 4 },
  ],
  // the power-up bubble floats over the pit, under the wrecking ball
  pickups: [{ x: 32, y: FLOOR - 4 }],
  hazards: [
    // fast (and exposed) ways up: ground -> mid deck, mid deck -> girder (beside what they lead to, never under it)
    { kind: 'trampoline', label: 'tramp_l', x: 12.2, y: FLOOR, w: 1.6, power: 19 },
    { kind: 'trampoline', label: 'tramp_r', x: W - 12.2 - 1.6, y: FLOOR, w: 1.6, power: 19 },
    { kind: 'trampoline', label: 'tramp_deck_l', x: 18.2, y: FLOOR - MID, w: 1.6, power: 19 },
    { kind: 'trampoline', label: 'tramp_deck_r', x: W - 18.2 - 1.6, y: FLOOR - MID, w: 1.6, power: 19 },
    // a wrecking ball hanging from the crane over the pit: shoot it to swing it into whoever's on the pallets
    { kind: 'wrecking_ball', label: 'wreck', x: 32, y: FLOOR - CRANE + 0.5, length: 6, radius: 0.7 },
  ],
  // A building site at night: cranes and half-built towers far off, hanging chains, scaffolding; safety-orange edges.
  palette: {
    sky: { top: 0x0a0911, bottom: 0x221a28 },
    horizon: FLOOR,
    // L7 clean look: no silhouettes (buildings, chains, trees made the screen busy); the sky and glows set the mood
    layers: [],
    terrain: 0x0d0b12,
    accent: 0xff7043,
    glow: [
      { color: 0xffab40, x: 0.5, y: 0.12, radius: 0.1, alpha: 0.12 },
      { color: 0x7986cb, x: 0.12, y: 0.25, radius: 0.14, alpha: 0.08 },
    ],
    dust: 0x6d6070,
    seed: 57,
  },
};
