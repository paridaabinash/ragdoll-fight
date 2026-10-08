import type { ArenaLayout } from './arena';
import { GRAVITY_Y, HAZARD, MOVE, REACH } from './constants';

/**
 * L6: the arena reach check. Pure data, no physics (like `validateArena`), so tests run it on every arena.
 * It finds every place you can stand (a "surface": the free top of the solids, touching tops merged, and seesaw planks)
 * and works out how a body gets between them by walking off edges, jumping gaps, climbing ledges and trampolines,
 * using the measured abilities in REACH (sim `jump_reach`). Every place must lead to every other (from one spawn's
 * place out to all of them and back): a place nobody can reach, an island, or a pocket with no way out is a design
 * mistake this catches before anyone plays it.
 * Not modelled (so it can under- or over-promise a little): walls in the way of a jump's arc, wind, bouncy floors,
 * a seesaw's tipping, standing on crates.
 */
export interface StandSurface {
  id: number;
  /** The solids whose tops make it. */
  labels: string[];
  x0: number;
  x1: number;
  /** Top (y down). */
  y: number;
  /** A spawn stands on it. */
  spawn: boolean;
}

export interface Ability {
  /** Highest ledge (m) climbed onto. */
  climb: number;
  /** Widest level gap (m) jumped. */
  gap: number;
  /** Widest gap (m) to a ledge 1 m up (only used when `climb` > 1). */
  gapUp1: number;
}

export const ABILITY: Record<'whole' | 'stumps', Ability> = {
  whole: { climb: REACH.climb, gap: REACH.gap, gapUp1: REACH.gapUp1 },
  stumps: { climb: REACH.stumps.climb, gap: REACH.stumps.gap, gapUp1: 0 },
};

export interface ReachReport {
  surfaces: StandSurface[];
  /** Can't be reached from the first spawn's place (so not from everywhere: the arena falls apart into islands). */
  unreachable: StandSurface[];
  /** Reachable, but there's no way back to the first spawn's place from there (you'd be stuck, or cut off). */
  traps: StandSurface[];
  /** Trampolines with a solid over them lower than the launch: they throw you into its underside. */
  blockedTrampolines: { label: string; by: string; room: number; launch: number }[];
}

const EPS = 0.02;
/** A place must be at least this wide to stand on (both feet). */
const MIN_WIDTH = 0.6;

type Span = [number, number];

function subtract(parts: Span[], [a, b]: Span): Span[] {
  const out: Span[] = [];
  for (const [x0, x1] of parts) {
    if (b <= x0 || a >= x1) out.push([x0, x1]);
    else {
      if (a > x0) out.push([x0, a]);
      if (b < x1) out.push([b, x1]);
    }
  }
  return out;
}

/** Every place you can stand: the tops of solids with standing room above, not inside a pit's kill zone. */
export function standSurfaces(l: ArenaLayout): StandSurface[] {
  const raw: Omit<StandSurface, 'id' | 'spawn'>[] = [];
  for (const s of l.solids) {
    if (s.decor) continue;
    let parts: Span[] = [[s.x, s.x + s.w]];
    for (const o of l.solids) if (o !== s && o.y < s.y - EPS && o.y + o.h > s.y - REACH.headroom) parts = subtract(parts, [o.x, o.x + o.w]);
    for (const p of l.pits) if (p.y <= s.y - 0.3 && p.y + p.h >= s.y - 0.3 - EPS) parts = subtract(parts, [p.x, p.x + p.w]);
    for (const [x0, x1] of parts) if (x1 - x0 >= MIN_WIDTH - EPS) raw.push({ labels: [s.label], x0, x1, y: s.y });
  }
  // a seesaw plank is a place too (taken level: it tips, but you can walk across it)
  for (const h of l.hazards) if (h.kind === 'seesaw') raw.push({ labels: [h.label], x0: h.x - h.length / 2, x1: h.x + h.length / 2, y: h.y - HAZARD.seesaw.thickness });
  // touching tops at the same height are one place
  raw.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const merged: Omit<StandSurface, 'id' | 'spawn'>[] = [];
  for (const r of raw) {
    const last = merged.at(-1);
    if (last && Math.abs(last.y - r.y) < 0.05 && r.x0 <= last.x1 + EPS) {
      last.x1 = Math.max(last.x1, r.x1);
      last.labels.push(...r.labels);
    } else merged.push({ ...r, labels: [...r.labels] });
  }
  return merged.map((m, id) => ({ ...m, id, spawn: l.spawns.some((sp) => Math.abs(sp.y - m.y) < 0.05 && sp.x >= m.x0 && sp.x <= m.x1) }));
}

/** Time in the air of a full jump that lands `drop` m lower (jump physics). */
function airTime(drop: number): number {
  const v = MOVE.jumpSpeed;
  return (v + Math.sqrt(v * v + 2 * GRAVITY_Y * Math.max(0, drop))) / GRAVITY_Y;
}

/** How far across (m) a jump reaches to a place `rise` m higher (negative: lower). */
export function jumpReach(a: Ability, rise: number): number {
  if (rise <= 0) return a.gap * (airTime(-rise) / airTime(0));
  if (rise > a.climb) return -1;
  if (a.climb <= 1 || rise <= 1) {
    const at1 = a.climb > 1 ? a.gapUp1 : 0;
    const top = Math.min(1, a.climb);
    return rise <= top ? a.gap + (at1 - a.gap) * (rise / top) : at1;
  }
  return a.gapUp1 * ((a.climb - rise) / (a.climb - 1));
}

/** Can a body standing on A get onto B? */
export function canGo(A: StandSurface, B: StandSurface, a: Ability): boolean {
  if (A === B) return false;
  const rise = A.y - B.y;
  const reach = jumpReach(a, rise);
  if (reach < 0) return false;
  const gaps: number[] = [];
  if (rise > EPS) {
    // up: take off from a part of A that isn't under B (B is solid: you can't jump through it from below)
    if (A.x0 < B.x0 - EPS) gaps.push(Math.max(0, B.x0 - A.x1));
    if (A.x1 > B.x1 + EPS) gaps.push(Math.max(0, A.x0 - B.x1));
  } else {
    // level or down: off an edge of A, onto a part of B that isn't under A
    if (B.x0 < A.x0 - EPS) gaps.push(Math.max(0, A.x0 - B.x1));
    if (B.x1 > A.x1 + EPS) gaps.push(Math.max(0, B.x0 - A.x1));
  }
  return gaps.some((g) => g <= reach + EPS);
}

/** The reach check for one arena layout and one body (`whole`, or `stumps` = two thigh stumps, L4). */
export function arenaReach(l: ArenaLayout, who: 'whole' | 'stumps' = 'whole'): ReachReport {
  const a = ABILITY[who];
  const surfaces = standSurfaces(l);
  const next = new Map<StandSurface, StandSurface[]>(surfaces.map((s) => [s, surfaces.filter((t) => canGo(s, t, a))]));
  // trampolines: from the surface the pad lies on, up to anything within the launch (steering sideways a little)
  const blockedTrampolines: ReachReport['blockedTrampolines'] = [];
  for (const h of l.hazards) {
    if (h.kind !== 'trampoline') continue;
    const launch = (REACH.trampolineShare * h.power * h.power) / (2 * GRAVITY_Y);
    const pad = surfaces.find((s) => Math.abs(s.y - h.y) < 0.05 && h.x >= s.x0 - EPS && h.x + h.w <= s.x1 + EPS);
    for (const o of l.solids) {
      const room = h.y - (o.y + o.h);
      if (room > EPS && room < launch && o.x < h.x + h.w && o.x + o.w > h.x) blockedTrampolines.push({ label: h.label, by: o.label, room: Math.round(room * 100) / 100, launch: Math.round(launch * 10) / 10 });
    }
    if (!pad) continue;
    for (const t of surfaces) {
      const rise = pad.y - t.y;
      if (t === pad || rise <= 0 || rise > launch) continue;
      // over the pad: steer out from under it first; beside it: steer across
      const covers = t.x0 <= h.x && t.x1 >= h.x + h.w;
      const side = covers ? Math.min(h.x + h.w - t.x0, t.x1 - h.x) : Math.max(0, t.x0 - (h.x + h.w), h.x - t.x1);
      if (side <= REACH.trampolineSideways) next.get(pad)!.push(t);
    }
  }
  const walk = (from: StandSurface[], edges: (s: StandSurface) => StandSurface[]) => {
    const seen = new Set(from);
    const todo = [...from];
    while (todo.length) for (const t of edges(todo.pop()!)) if (!seen.has(t)) (seen.add(t), todo.push(t));
    return seen;
  };
  // Every place should lead to every other: start from one spawn's place, go everywhere, and from everywhere get back.
  const starts = surfaces.filter((s) => s.spawn).slice(0, 1);
  const reached = walk(starts, (s) => next.get(s)!);
  const back = walk(starts, (s) => surfaces.filter((t) => next.get(t)!.includes(s)));
  return {
    surfaces,
    unreachable: surfaces.filter((s) => !reached.has(s)),
    traps: surfaces.filter((s) => reached.has(s) && !back.has(s)),
    blockedTrampolines,
  };
}

/** One line per problem, for logs and the arena map. */
export function describeSurface(s: StandSurface): string {
  return `${s.labels.join('+')} (x ${Math.round(s.x0 * 10) / 10}-${Math.round(s.x1 * 10) / 10}, y ${s.y})`;
}
