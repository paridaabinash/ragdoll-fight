import { NET, PHYSICS_HZ } from '../constants';
import { lerp, wrapAngle } from '../math';
import { PART_NAMES } from '../ragdoll';
import type { NetArrow, NetBody, NetPlayer, Pose, SnapshotData } from './snapshot';

const TORSO = PART_NAMES.indexOf('torso');

const TICKS_PER_MS = PHYSICS_HZ / 1000;
/** Snapshots older than this behind the newest are dropped. */
const KEEP_TICKS = 120;

/** Blends two poses; the angle goes the short way round (so 179° → -179° doesn't spin a full turn). */
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), a: a.a + wrapAngle(b.a - a.a) * t };
}

/** Blends two snapshots. Things only in one of them (new arrows, players who just joined) are taken as they are. */
export function blendSnapshots(a: SnapshotData, b: SnapshotData, t: number): SnapshotData {
  const near = t < 0.5 ? a : b;
  const players: NetPlayer[] = b.players.map((pb) => {
    const pa = a.players.find((p) => p.slot === pb.slot);
    if (!pa) return pb;
    // A respawn teleports the body: blending would draw it sliding across the arena.
    const teleported = Math.hypot(pa.parts[TORSO].x - pb.parts[TORSO].x, pa.parts[TORSO].y - pb.parts[TORSO].y) > 3;
    if (teleported) return near === a ? pa : pb;
    const flags = near === a ? pa : pb;
    return { ...flags, parts: pb.parts.map((part, i) => lerpPose(pa.parts[i], part, t)) };
  });
  const bodies: NetBody[] = b.bodies.map((bb) => {
    const ba = a.bodies.find((x) => x.index === bb.index);
    return ba ? { ...(near === a ? ba : bb), pose: lerpPose(ba.pose, bb.pose, t) } : bb;
  });
  const arrows: NetArrow[] = b.arrows.map((ab) => {
    const aa = a.arrows.find((x) => x.id === ab.id);
    return aa ? { ...ab, pose: lerpPose(aa.pose, ab.pose, t) } : ab;
  });
  return { tick: lerp(a.tick, b.tick, t), headScale: near.headScale, players, bodies, arrows, props: near.props };
}

export interface BufferStats {
  /** Times the render moment ran past the newest snapshot (nothing new to blend toward). */
  underruns: number;
  /** Largest gap between two snapshot arrivals since the last reset (ms). */
  maxGapMs: number;
  received: number;
}

/**
 * Keeps recent snapshots and answers "what should be on screen now?".
 * It estimates the server's current tick from arrival times, then shows `NET.interpDelayTicks` behind it.
 */
export class SnapshotBuffer {
  private snaps: SnapshotData[] = [];
  /** serverTick ≈ localMs * TICKS_PER_MS + offset */
  private offset: number | null = null;
  private lastArrivalMs: number | null = null;
  /** Ticks where the world was replaced (a new match): snapshots on either side are never blended together. */
  private cuts: number[] = [];
  stats: BufferStats = { underruns: 0, maxGapMs: 0, received: 0 };

  /** Snapshots after `tick` show a different world (new match): never blend across it. */
  cut(tick: number): void {
    this.cuts.push(tick);
  }

  push(s: SnapshotData, nowMs: number): void {
    if (this.snaps.length && s.tick <= this.snaps[this.snaps.length - 1].tick) return; // old or repeated
    this.snaps.push(s);
    const newest = s.tick;
    this.snaps = this.snaps.filter((x) => newest - x.tick <= KEEP_TICKS);
    this.cuts = this.cuts.filter((c) => newest - c <= KEEP_TICKS);
    this.stats.received++;
    if (this.lastArrivalMs !== null) this.stats.maxGapMs = Math.max(this.stats.maxGapMs, nowMs - this.lastArrivalMs);
    this.lastArrivalMs = nowMs;
    // Track the EARLIEST-arriving snapshots: one that arrives "early" means our estimate was behind, so jump forward;
    // otherwise drift back slowly. Late (delayed) snapshots then just eat into the 100 ms buffer instead of stalling it.
    const sample = s.tick - nowMs * TICKS_PER_MS;
    if (this.offset === null || sample > this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.01;
  }

  /** The (fractional) tick to show at `nowMs`. */
  renderTick(nowMs: number): number {
    return this.offset === null ? 0 : nowMs * TICKS_PER_MS + this.offset - NET.interpDelayTicks;
  }

  /** The blended state for `nowMs`, or null before the first snapshot. */
  sample(nowMs: number): SnapshotData | null {
    if (!this.snaps.length) return null;
    const t = this.renderTick(nowMs);
    const last = this.snaps[this.snaps.length - 1];
    if (t >= last.tick) {
      if (this.snaps.length > 1) this.stats.underruns++;
      return last;
    }
    if (t <= this.snaps[0].tick) return this.snaps[0];
    for (let i = this.snaps.length - 1; i > 0; i--) {
      const a = this.snaps[i - 1];
      const b = this.snaps[i];
      if (t < a.tick) continue;
      const cut = this.cuts.find((c) => a.tick <= c && c < b.tick);
      if (cut !== undefined) return t <= cut ? a : b; // a new world between the two: show one or the other
      return blendSnapshots(a, b, (t - a.tick) / (b.tick - a.tick));
    }
    return this.snaps[0];
  }

  /** Snapshots newer than what's on screen (2 is healthy at 20/s with a 100 ms delay). */
  depth(nowMs: number): number {
    const t = this.renderTick(nowMs);
    return this.snaps.filter((s) => s.tick > t).length;
  }

  resetStats(): BufferStats {
    const out = this.stats;
    this.stats = { underruns: 0, maxGapMs: 0, received: 0 };
    return out;
  }
}

/** A snapshot and when it reaches the client (ms). */
export interface Arrival {
  snap: SnapshotData;
  atMs: number;
}

/**
 * Plays a snapshot stream through a fresh `SnapshotBuffer` on a perfect clock: each snapshot pushed at its `atMs`
 * (sorted), a frame drawn every `frameMs` from `fromMs` to `toMs`. Returns the buffer stats for those frames.
 * netsim `lag` uses this to judge the smoothing against the fake network delay alone: on a real clock, a busy
 * machine also makes timers run late, and the buffer runs dry for reasons that have nothing to do with the network.
 */
export function replayBuffer(arrivals: Arrival[], frameMs: number, fromMs: number, toMs: number): BufferStats & { frames: number } {
  const buf = new SnapshotBuffer();
  let next = 0;
  let frames = 0;
  for (let t = fromMs; t <= toMs; t += frameMs) {
    for (; next < arrivals.length && arrivals[next].atMs <= t; next++) buf.push(arrivals[next].snap, arrivals[next].atMs);
    if (frames === 0) buf.resetStats(); // count only the window's frames (gaps before it don't count either)
    buf.sample(t);
    frames++;
  }
  return { ...buf.stats, frames };
}

/**
 * The picture at any `tick` from a list of snapshots sorted by tick (replays): blends the two around it.
 * Before the first / after the last it holds that end. Null if the list is empty.
 */
export function sampleSnapshots(snaps: SnapshotData[], tick: number): SnapshotData | null {
  if (!snaps.length) return null;
  if (tick <= snaps[0].tick) return snaps[0];
  const last = snaps[snaps.length - 1];
  if (tick >= last.tick) return last;
  let lo = 0;
  let hi = snaps.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid].tick <= tick) lo = mid;
    else hi = mid;
  }
  const a = snaps[lo];
  const b = snaps[hi];
  return blendSnapshots(a, b, (tick - a.tick) / (b.tick - a.tick));
}
