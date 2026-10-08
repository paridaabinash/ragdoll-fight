import { ARENA_MARGIN } from './constants';
import { arenaLayout, validateArena, type ArenaLayout } from './arena';
import { BACKYARD } from './arenas';
import { r2 } from './math';
import type { GameWorld } from './world';

export const LOCAL_PLAYER = 'p1';
/** A second ragdoll to shoot at. Gets no controls, so it just stands and balances. */
export const DUMMY_PLAYER = 'p2';

/** Ground top of the Backyard (the original test range). Tests and sim scenarios that build their own ground use it. */
export const GROUND_Y = 17;

/** Wall thickness at the arena's sides. */
const WALL = 0.5;

/**
 * Builds an arena with no players: walls at both sides, solids, crates, apples, pits and spawn points.
 * The server uses this; the default is the Backyard. Anything wrong with the arena data is logged as an error.
 */
export function buildArena(world: GameWorld, layout: ArenaLayout = arenaLayout(BACKYARD, 'full')): void {
  const problems = validateArena(layout);
  for (const p of problems) world.log.error('arena_invalid', { arena: layout.id, size: layout.size, problem: p });
  const { width, height } = layout;
  world.arena = layout;
  world.bounds = { width, height };
  // The side walls go up into the sky as far as anything may fly (ARENA_MARGIN.top): a player thrown higher than the
  // arena's top edge (a trampoline in the Moon Gravity round) flew over a wall that stopped at y 0 (L6, sim chaos).
  const top = -ARENA_MARGIN.top;
  const wall = { y: (top + height) / 2, hy: (height - top) / 2 };
  world.addBox('wall_left', 'fixed', { x: -WALL / 2, y: wall.y }, { x: WALL / 2, y: wall.hy });
  world.addBox('wall_right', 'fixed', { x: width + WALL / 2, y: wall.y }, { x: WALL / 2, y: wall.hy });
  for (const s of layout.solids) world.addBox(s.label, 'fixed', { x: s.x + s.w / 2, y: s.y + s.h / 2 }, { x: s.w / 2, y: s.h / 2 }, s.surface);
  for (const c of layout.crates) world.addBox(c.label, 'dynamic', { x: c.x, y: c.y }, { x: c.size / 2, y: c.size / 2 });
  world.spawnPoints = layout.spawns.map((s) => ({ ...s }));
  for (const a of layout.apples) world.addApple(a.kind, { x: a.x, y: a.y });
  for (const p of layout.pickups) world.specials.addBubble({ x: p.x, y: p.y });
  world.hazards.build(layout.hazards);
  world.log.info('arena_loaded', {
    arena: layout.id,
    size: layout.size,
    width: r2(width),
    height: r2(height),
    spawns: layout.spawns.length,
    pits: layout.pits.length,
    problems: problems.length,
  });
}

/** Offline test range: an arena plus you (p1) and a dummy (p2) on its first two spawn points. Used by the local mode, tests and the sim. */
export function buildTestLevel(world: GameWorld, layout: ArenaLayout = arenaLayout(BACKYARD, 'full')): void {
  buildArena(world, layout);
  const [a, b] = layout.spawns;
  world.addPlayer(LOCAL_PLAYER, { x: a.x, y: a.y }, a.facing);
  world.addPlayer(DUMMY_PLAYER, { x: b.x, y: b.y }, b.facing);
}
