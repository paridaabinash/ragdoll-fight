import { ARENA_SIZE, NET } from './constants';
import { DEFAULT_PALETTE, paletteProblems } from './palette';

/**
 * Arenas are DATA: each one is an `ArenaDef` (see `arenas/`). Code never hard-codes an arena's size or layout.
 * Units: meters, y points down. Rectangles are given by their top-left corner + size (easier to write by hand).
 *
 * An arena can have two sizes: "full" for busy rooms and "narrow" for few players. The narrow one keeps only the
 * middle x range (`narrow`): things outside it are dropped, solids crossing its edge are cut, and everything is
 * shifted so the narrow arena starts at x 0. Side walls are added automatically at both edges.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArenaSpawn {
  /** Feet position: x, and y = the top of the surface the player stands on. */
  x: number;
  y: number;
  facing: 1 | -1;
}

export type ArenaAppleKind = 'red' | 'gold';

export interface ArenaDef {
  id: string;
  name: string;
  /** Full size. `height` is the bottom of the ground (nothing solid goes below it). */
  width: number;
  height: number;
  /** x range kept for the narrow size. Leave out for arenas that have one size. */
  narrow?: { from: number; to: number };
  /** Fixed blocks: ground, platforms, steps, cover. */
  /**
   * `surface`: ice (no grip) or bouncy (springy); normal if left out (S6). `decor` (L6): scenery, not a place to
   * stand (a shelf for crates out of reach on purpose): the reach check (`arenaReach`) skips its top.
   */
  solids: (Rect & { label: string; surface?: Surface; decor?: true })[];
  /** Pushable boxes. `x`, `y` = center. */
  crates?: { label: string; x: number; y: number; size: number }[];
  /**
   * Kill zones: a player whose body center enters one dies (a ring-out). The hole itself is a gap in the solids;
   * a solid "pit floor" right under the zone catches the body, so it lies at the bottom instead of falling forever.
   */
  pits?: (Rect & { label: string })[];
  spawns: ArenaSpawn[];
  apples?: { kind: ArenaAppleKind; x: number; y: number }[];
  /** Where power-up bubbles float (used from S5; checked already). */
  pickups?: { x: number; y: number }[];
  /** Trampolines, seesaws, wrecking balls, wind, conveyor belts (S6). */
  hazards?: HazardDef[];
  /** How it looks (L1). Every real arena has one (a test checks); arenas without one get `DEFAULT_PALETTE`. */
  palette?: ArenaPalette;
}

/**
 * L1: an arena's look, as data. Dark, muted backdrop; players and shots are the brightest things on screen
 * (`paletteProblems` checks it). Colours are 0xRRGGBB numbers.
 */
export interface ArenaPalette {
  /** Sky gradient, top of the screen to bottom. */
  sky: { top: number; bottom: number };
  /** y (m) of the ground line the silhouettes stand on (usually the main floor's top). */
  horizon: number;
  /** 2-3 parallax silhouette layers, listed FAR to NEAR: farther ones move less and are lighter (hazier). */
  layers: ParallaxLayer[];
  /** Fill of every solid: a dark silhouette... */
  terrain: number;
  /** ...with one bright edge on top (crimson grass, glowing rim, neon roof edge). */
  accent: number;
  /** Soft light spots in the sky (lamps, moon). x, y, radius: shares of the screen; alpha at the center. */
  glow?: { color: number; x: number; y: number; radius: number; alpha: number }[];
  /**
   * L7: aurora curtains in the sky (fixed on screen like the glows): fine vertical rays rising from a folding line at
   * height `y` (0 top .. 1 bottom of the screen), `height` tall (screen share), `color` at their foot fading to `top`,
   * at most `alpha` opaque. `fold` = how much the line waves (screen share), `phase` shifts the waves.
   */
  aurora?: { color: number; top: number; y: number; height: number; fold: number; alpha: number; phase: number }[];
  /** Dust puffs (L2) and wall-hit dust. */
  dust: number;
  /** The silhouettes are drawn by code from this seed (same arena = same skyline on every screen). */
  seed: number;
}

export interface ParallaxLayer {
  kind: 'hills' | 'trees' | 'houses' | 'factory' | 'chains';
  color: number;
  /** How much it moves with the camera: 0 = not at all (like the sky), 1 = with the arena. */
  depth: number;
  /** Tallest silhouettes reach this far (m) above the horizon (`chains`: hang this far down from the top). */
  height: number;
}

export type Surface = 'ice' | 'bouncy';

/**
 * Hazards (S6), all in arena meters (y down):
 * - trampoline: a pad on a floor (top-left x, its top y, width); standing on it launches you up at `power` m/s.
 * - seesaw: a plank `length` long on a pivot whose top is at (x, y); `x` is the middle.
 * - wrecking_ball: a heavy ball on a chain hanging from (x, y), `length` long; shoot it to swing it.
 * - wind: a box where everything (players and arrows) is pushed by (ax, ay) m/s². Always on, so the aim preview
 *   can include it exactly.
 * - conveyor: a belt on a floor (top-left x, its top y, width) that carries you at `speed` m/s (+ = right).
 */
export type HazardDef =
  | { kind: 'trampoline'; label: string; x: number; y: number; w: number; power: number }
  | { kind: 'seesaw'; label: string; x: number; y: number; length: number }
  | { kind: 'wrecking_ball'; label: string; x: number; y: number; length: number; radius: number }
  | { kind: 'wind'; label: string; x: number; y: number; w: number; h: number; ax: number; ay: number }
  | { kind: 'conveyor'; label: string; x: number; y: number; w: number; speed: number };

export type ArenaSize = 'full' | 'narrow';

/** One arena at one size, ready to build. */
export interface ArenaLayout extends Omit<ArenaDef, 'narrow' | 'crates' | 'pits' | 'apples' | 'pickups' | 'hazards'> {
  size: ArenaSize;
  crates: NonNullable<ArenaDef['crates']>;
  pits: NonNullable<ArenaDef['pits']>;
  apples: NonNullable<ArenaDef['apples']>;
  pickups: NonNullable<ArenaDef['pickups']>;
  hazards: HazardDef[];
}

/** What a client needs to know about the arena beyond the solid shapes: its size (camera, arrow limits) and the pits (drawing). */
export interface ArenaInfo {
  id: string;
  name: string;
  size: ArenaSize;
  width: number;
  height: number;
  pits: (Rect & { label: string })[];
  /** Hazards (drawing; wind also goes into the client's aim preview) and which solids are ice / bouncy (S6). */
  hazards: HazardDef[];
  surfaces: { label: string; surface: Surface }[];
  /** How to draw it (L1); the default palette if the arena has none. */
  palette: ArenaPalette;
}

/** Arena size for arrow limits and the camera. */
export interface ArenaBounds {
  width: number;
  height: number;
}

/** Which size to use for this many players. Picked when the arena is built and never changed while it's in play. */
export function arenaSizeFor(def: ArenaDef, players: number): ArenaSize {
  return def.narrow && players < ARENA_SIZE.fullFromPlayers ? 'narrow' : 'full';
}

export function arenaLayout(def: ArenaDef, size: ArenaSize): ArenaLayout {
  const base = { id: def.id, name: def.name, height: def.height, spawns: [...def.spawns], ...(def.palette ? { palette: def.palette } : {}) };
  const full: ArenaLayout = {
    ...base,
    size: 'full',
    width: def.width,
    solids: def.solids.map((s) => ({ ...s })),
    crates: (def.crates ?? []).map((c) => ({ ...c })),
    pits: (def.pits ?? []).map((p) => ({ ...p })),
    apples: (def.apples ?? []).map((a) => ({ ...a })),
    pickups: (def.pickups ?? []).map((p) => ({ ...p })),
    hazards: (def.hazards ?? []).map((h) => ({ ...h })),
  };
  if (size === 'full' || !def.narrow) return full;
  const { from, to } = def.narrow;
  const inside = (x: number) => x >= from && x <= to;
  const clip = <T extends Rect>(r: T): T | null => {
    const x0 = Math.max(r.x, from);
    const x1 = Math.min(r.x + r.w, to);
    return x1 - x0 > 0.01 ? { ...r, x: x0 - from, w: x1 - x0 } : null;
  };
  const shift = <T extends { x: number }>(p: T): T => ({ ...p, x: p.x - from });
  return {
    ...base,
    size: 'narrow',
    width: to - from,
    solids: full.solids.map(clip).filter((s) => s !== null),
    crates: full.crates.filter((c) => inside(c.x)).map(shift),
    pits: full.pits.map(clip).filter((p) => p !== null),
    spawns: full.spawns.filter((s) => inside(s.x)).map(shift),
    apples: full.apples.filter((a) => inside(a.x)).map(shift),
    pickups: full.pickups.filter((p) => inside(p.x)).map(shift),
    // a hazard belongs to the narrow size if its middle is inside it
    hazards: full.hazards.filter((h) => inside(hazardMiddle(h))).map(shift),
  };
}

export function arenaInfo(l: ArenaLayout): ArenaInfo {
  return {
    id: l.id,
    name: l.name,
    size: l.size,
    width: l.width,
    height: l.height,
    pits: l.pits.map((p) => ({ ...p })),
    hazards: l.hazards.map((h) => ({ ...h })),
    surfaces: l.solids.filter((s) => s.surface).map((s) => ({ label: s.label, surface: s.surface! })),
    palette: structuredClone(l.palette ?? DEFAULT_PALETTE),
  };
}

/** x of a hazard's middle. */
export function hazardMiddle(h: HazardDef): number {
  return 'w' in h ? h.x + h.w / 2 : h.x;
}

/** Wind push (m/s²) at a point: the sum of the wind boxes it's in. The same on server and client (aim preview). */
export function windAt(hazards: HazardDef[], p: { x: number; y: number }): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const h of hazards) {
    if (h.kind === 'wind' && p.x > h.x && p.x < h.x + h.w && p.y > h.y && p.y < h.y + h.h) {
      x += h.ax;
      y += h.ay;
    }
  }
  return { x, y };
}

/** Space a standing ragdoll needs above its spawn point (half width, height). */
const STAND = { hw: 0.45, h: 2.25 };
/** Both feet must be on the surface: the spawn must be this far inside the solid's edges. */
const FOOTING = 0.2;
/** Spawns closer than this would start bodies inside each other. */
const MIN_SPAWN_GAP = 1.5;

const overlaps = (a: Rect, b: Rect, eps = 1e-6) => a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
const containsPoint = (r: Rect, x: number, y: number) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
const finite = (...v: number[]) => v.every(Number.isFinite);

/**
 * Checks an arena layout and returns every problem found (empty = good). Pure data checks, no physics, so tests
 * can run it on every arena file. `npm run sim` (`arena_spawns`) then checks the same arenas with real bodies.
 */
export function validateArena(l: ArenaLayout): string[] {
  const out: string[] = [];
  const where = `${l.id}/${l.size}`;
  if (!finite(l.width, l.height) || l.width < 10 || l.height < 8) out.push(`${where}: size ${l.width}x${l.height} too small or not a number`);
  const labels = new Set<string>();
  const label = (s: string) => {
    if (labels.has(s)) out.push(`${where}: label ${s} used twice`);
    labels.add(s);
  };
  const inBounds = (r: Rect) => r.x >= -1e-6 && r.x + r.w <= l.width + 1e-6 && r.y + r.h <= l.height + 1e-6 && r.y >= -10;

  for (const s of l.solids) {
    label(s.label);
    if (!finite(s.x, s.y, s.w, s.h) || s.w <= 0 || s.h <= 0) out.push(`${where}: solid ${s.label} has a bad size`);
    else if (!inBounds(s)) out.push(`${where}: solid ${s.label} is outside the arena`);
  }
  const crateRects = l.crates.map((c) => ({ label: c.label, x: c.x - c.size / 2, y: c.y - c.size / 2, w: c.size, h: c.size }));
  for (const c of crateRects) {
    label(c.label);
    if (!inBounds(c)) out.push(`${where}: crate ${c.label} is outside the arena`);
    for (const s of l.solids) if (overlaps(c, s)) out.push(`${where}: crate ${c.label} is inside solid ${s.label}`);
  }
  for (const p of l.pits) {
    label(p.label);
    if (!inBounds(p)) out.push(`${where}: pit ${p.label} is outside the arena`);
    for (const s of l.solids) if (overlaps(p, s)) out.push(`${where}: pit ${p.label} overlaps solid ${s.label}`);
    const floor = l.solids.some((s) => Math.abs(s.y - (p.y + p.h)) < 0.05 && s.x <= p.x + 1e-6 && s.x + s.w >= p.x + p.w - 1e-6);
    if (!floor) out.push(`${where}: pit ${p.label} has no solid floor right under it (bodies would fall forever)`);
  }

  const need = l.size === 'full' ? NET.maxPlayers : ARENA_SIZE.fullFromPlayers - 1;
  if (l.spawns.length < need) out.push(`${where}: ${l.spawns.length} spawns, needs at least ${need}`);
  l.spawns.forEach((sp, i) => {
    const name = `spawn ${i} (${sp.x}, ${sp.y})`;
    if (!finite(sp.x, sp.y) || (sp.facing !== 1 && sp.facing !== -1)) {
      out.push(`${where}: ${name} is malformed`);
      return;
    }
    const room = { x: sp.x - STAND.hw, y: sp.y - STAND.h, w: STAND.hw * 2, h: STAND.h - 0.02 };
    if (!inBounds(room)) out.push(`${where}: ${name} is too close to the arena edge`);
    const standsOn = l.solids.some((s) => Math.abs(s.y - sp.y) < 0.05 && s.x <= sp.x - FOOTING && s.x + s.w >= sp.x + FOOTING);
    if (!standsOn) out.push(`${where}: ${name} is not standing on top of a solid`);
    for (const s of l.solids) if (overlaps(room, s)) out.push(`${where}: ${name} has no room to stand (inside ${s.label})`);
    for (const c of crateRects) if (overlaps(room, c)) out.push(`${where}: ${name} has no room to stand (inside ${c.label})`);
    for (const p of l.pits) if (overlaps(room, p)) out.push(`${where}: ${name} is in pit ${p.label}`);
    l.spawns.forEach((o, j) => {
      if (j > i && Math.hypot(o.x - sp.x, o.y - sp.y) < MIN_SPAWN_GAP) out.push(`${where}: ${name} is closer than ${MIN_SPAWN_GAP} m to spawn ${j}`);
    });
  });

  const floating = (kind: string, list: { x: number; y: number }[]) =>
    list.forEach((p, i) => {
      if (!finite(p.x, p.y) || p.x < 0.5 || p.x > l.width - 0.5 || p.y < 0.5 || p.y > l.height) out.push(`${where}: ${kind} ${i} is outside the arena`);
      for (const s of l.solids) if (containsPoint(s, p.x, p.y)) out.push(`${where}: ${kind} ${i} is inside ${s.label}`);
    });
  floating('apple', l.apples);
  floating('pickup', l.pickups);
  if (l.palette) out.push(...paletteProblems(l.palette, `${where}: palette`));

  for (const h of l.hazards) {
    label(h.label);
    const where2 = `${where}: ${h.kind} ${h.label}`;
    const onFloor = (x: number, w: number, y: number) => l.solids.some((s) => Math.abs(s.y - y) < 0.05 && s.x <= x + 1e-6 && s.x + s.w >= x + w - 1e-6);
    if (h.kind === 'trampoline' || h.kind === 'conveyor') {
      if (!(h.w > 0) || h.x < 0 || h.x + h.w > l.width) out.push(`${where2} is outside the arena`);
      else if (!onFloor(h.x, h.w, h.y)) out.push(`${where2} is not lying on top of a solid`);
    } else if (h.kind === 'wind') {
      if (!(h.w > 0 && h.h > 0) || h.x < 0 || h.x + h.w > l.width || h.y < -10 || h.y + h.h > l.height) out.push(`${where2} is outside the arena`);
    } else if (h.kind === 'seesaw') {
      if (h.x - h.length / 2 < 0 || h.x + h.length / 2 > l.width) out.push(`${where2} is outside the arena`);
    } else if (h.kind === 'wrecking_ball') {
      if (h.x - h.length < 0 || h.x + h.length > l.width || h.y + h.length + h.radius > l.height) out.push(`${where2} can swing outside the arena`);
    }
  }
  return out;
}

/**
 * The usual ground: a slab from `floorY` down to the arena bottom, with pits cut into it.
 * Each pit is a hole `depth` deep with a thin floor at the bottom, and a kill zone that starts `PIT_KILL_BELOW`
 * under the surface (so you visibly drop in before it counts).
 */
export function groundWithPits(width: number, floorY: number, bottom: number, pits: { x: number; w: number; depth: number }[]): Pick<ArenaDef, 'solids' | 'pits'> {
  const solids: ArenaDef['solids'] = [];
  const kill: NonNullable<ArenaDef['pits']> = [];
  let x = 0;
  const sorted = [...pits].sort((a, b) => a.x - b.x);
  sorted.forEach((p, i) => {
    if (p.x > x) solids.push({ label: `ground_${i + 1}`, x, y: floorY, w: p.x - x, h: bottom - floorY });
    solids.push({ label: `pit_floor_${i + 1}`, x: p.x, y: floorY + p.depth, w: p.w, h: bottom - floorY - p.depth });
    kill.push({ label: `pit_${i + 1}`, x: p.x, y: floorY + PIT_KILL_BELOW, w: p.w, h: p.depth - PIT_KILL_BELOW });
    x = p.x + p.w;
  });
  if (x < width) solids.push({ label: sorted.length ? `ground_${sorted.length + 1}` : 'ground', x, y: floorY, w: width - x, h: bottom - floorY });
  return { solids, pits: kill };
}

/** A pit's kill zone starts this far below the ground surface. */
export const PIT_KILL_BELOW = 1.2;
