import { groundWithPits, type ArenaDef } from '../arena';

/**
 * Test arena for the slapstick systems: bigger than the screen, three heights, cover, and a pit in the middle.
 * Not a final arena: later phases add every hazard here so each one can be tried in play.
 *
 * Full: 64 x 26 m. Narrow (few players): only x 12-52 (40 m), the outer yards with crates are dropped.
 * Ground top at y 22. Heights below are "h" = meters above the ground.
 *
 *   perch (h8)          perch (h8)            <- trampolines on the lowest steps launch you up there
 *     steps h1-h4 -> bridge (h4, 2 m gap) <- steps h1-h4
 *   ground ......|  pit (x 28-36)  |...... ground
 *
 * Steps rise 1 m each: a jump (~1.4 m) climbs one.
 */
const FLOOR = 22;
const ground = groundWithPits(64, FLOOR, 26, [{ x: 28, w: 8, depth: 3 }]);

/** A block standing on the ground, `h` tall. */
const block = (label: string, x: number, w: number, h: number) => ({ label, x, y: FLOOR - h, w, h });
/** A thin floating platform whose top is `h` above the ground. */
const ledge = (label: string, x: number, w: number, h: number) => ({ label, x, y: FLOOR - h, w, h: 0.4 });

export const TEST_LAB: ArenaDef = {
  id: 'test_lab',
  name: 'Test Lab',
  width: 64,
  height: 26,
  narrow: { from: 12, to: 52 },
  solids: [
    ...ground.solids,
    // left steps, rising toward the middle (each block sits on the one below)
    { label: 'step_l1', x: 14, y: 21, w: 12, h: 1 },
    { label: 'step_l2', x: 16, y: 20, w: 10, h: 1 },
    { label: 'step_l3', x: 18, y: 19, w: 8, h: 1 },
    // (L6: the top steps reach the pit edge: a 2 m pocket between their 4 m back wall and the pit, under the bridge,
    // had no way out but the pit; the reach check found it)
    { label: 'step_l4', x: 20, y: 18, w: 8, h: 4 },
    // right steps (mirror)
    { label: 'step_r1', x: 38, y: 21, w: 12, h: 1 },
    { label: 'step_r2', x: 38, y: 20, w: 10, h: 1 },
    { label: 'step_r3', x: 38, y: 19, w: 8, h: 1 },
    { label: 'step_r4', x: 36, y: 18, w: 8, h: 4 },
    // bridge over the pit, with a 2 m gap to jump (the right half is ice)
    ledge('bridge_l', 26, 5, 4),
    { ...ledge('bridge_r', 33, 5, 4), surface: 'ice' },
    // high perches
    ledge('perch_l', 16, 6, 8),
    ledge('perch_r', 42, 6, 8),
    // a bouncy block in the left yard, low cover in the right yard
    { ...block('bouncer_l', 9.4, 1.6, 0.6), surface: 'bouncy' },
    block('cover_r', 53.4, 0.6, 2),
  ],
  crates: [
    { label: 'crate_1', x: 3, y: FLOOR - 0.5, size: 1 },
    { label: 'crate_3', x: 55, y: FLOOR - 0.5, size: 1 },
    { label: 'crate_4', x: 60, y: FLOOR - 0.5, size: 1 },
  ],
  pits: ground.pits,
  spawns: [
    // middle part (also used by the narrow size)
    { x: 13, y: FLOOR, facing: 1 },
    { x: 51, y: FLOOR, facing: -1 },
    { x: 24, y: FLOOR - 4, facing: 1 },
    { x: 40, y: FLOOR - 4, facing: -1 },
    { x: 19, y: FLOOR - 8, facing: 1 },
    { x: 45, y: FLOOR - 8, facing: -1 },
    // outer yards (full size only)
    { x: 2, y: FLOOR, facing: 1 },
    { x: 62, y: FLOOR, facing: -1 },
  ],
  apples: [
    { kind: 'red', x: 19, y: FLOOR - 10.5 },
    { kind: 'gold', x: 45, y: FLOOR - 10.5 },
    { kind: 'red', x: 6, y: FLOOR - 5 },
    { kind: 'gold', x: 58, y: FLOOR - 5 },
  ],
  pickups: [{ x: 32, y: FLOOR - 7 }],
  // S6: one of every hazard (the outer-yard ones are full size only)
  hazards: [
    // trampolines on the lowest steps, next to the high perches: the way up (hold toward the perch while flying)
    { kind: 'trampoline', label: 'tramp_l', x: 14.2, y: FLOOR - 1, w: 1.6, power: 19 },
    { kind: 'trampoline', label: 'tramp_r', x: 48.2, y: FLOOR - 1, w: 1.6, power: 19 },
    // wind over the pit, blowing right: bends arrows across it and pushes people on the bridge
    { kind: 'wind', label: 'wind_pit', x: 27, y: FLOOR - 13, w: 10, h: 8.9, ax: 8, ay: 0 },
    // the left bridge is a conveyor toward the gap
    { kind: 'conveyor', label: 'belt_l', x: 26.5, y: FLOOR - 4, w: 4, speed: 1.5 },
    // left yard: a seesaw; right yard: a wrecking ball
    { kind: 'seesaw', label: 'seesaw_l', x: 6, y: FLOOR - 0.6, length: 4 },
    { kind: 'wrecking_ball', label: 'wreck_r', x: 56.5, y: FLOOR - 9, length: 7, radius: 0.7 },
  ],
  // L1: a lab/foundry at night: chimneys and tanks far off, chains hanging in front; amber warning edges.
  palette: {
    sky: { top: 0x080c10, bottom: 0x142028 },
    horizon: FLOOR,
    layers: [
      { kind: 'factory', color: 0x22303a, depth: 0.15, height: 13 },
      { kind: 'chains', color: 0x18232b, depth: 0.35, height: 9 },
      { kind: 'factory', color: 0x0f171d, depth: 0.6, height: 6 },
    ],
    terrain: 0x0b1115,
    accent: 0xffa000,
    glow: [
      { color: 0xffb300, x: 0.22, y: 0.3, radius: 0.2, alpha: 0.12 },
      { color: 0x4dd0e1, x: 0.78, y: 0.22, radius: 0.16, alpha: 0.1 },
    ],
    dust: 0x5f6f78,
    seed: 23,
  },
};
