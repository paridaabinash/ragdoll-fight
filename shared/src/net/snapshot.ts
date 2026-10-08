import { NET } from '../constants';
import { OILED_BIT } from '../effects';
import { PART_NAMES, type PartName } from '../ragdoll';
import { WEAPONS, type Weapon } from '../rules';
import { kindCode, kindFromCode, PROP_CODE, type Prop, type PropType, type SpecialKind } from '../specials';
import type { GameWorld, MovableBody } from '../world';

/**
 * The state of the game at one tick, as sent 20 times a second.
 * Packed into bytes: positions as 16-bit whole numbers of 2 mm, angles as 16-bit fractions of a half turn.
 * A full 8-player snapshot is about 0.6 KB (+ ~9 bytes per arrow), vs. several KB as JSON.
 */
export interface Pose {
  x: number;
  y: number;
  a: number;
}

export interface NetPlayer {
  slot: number;
  alive: boolean;
  armsDown: boolean;
  protected: boolean;
  facing: 1 | -1;
  down: boolean;
  limp: boolean;
  grounded: boolean;
  hp: number;
  stamina: number;
  /** Active effects as bits (EFFECT_BIT: head 1, arm 2, leg 4, ...). */
  fx: number;
  /** L3: ticks until the gun is reloaded (0 = ready; drawn as the pump/bolt moving). */
  reload: number;
  /**
   * L4 body damage: parts shot off (bit i = PART_NAMES[i] is a loose piece now; a lost shin means that thigh is a
   * stump), parts dented by a glove (same bits), and the leg stage (0-4, see LEG_STAGE_NAMES).
   */
  lost: number;
  dents: number;
  legStage: number;
  /** L5: the gun, or the melee weapon after a critical hit (WEAPONS index), and limbs broken by melee (part bits). */
  weapon: Weapon;
  broken: number;
  /** The special arrow they hold for their next shot (S5), or null. */
  held: SpecialKind | null;
  kills: number;
  deaths: number;
  /** Match score (S7) and whether they wear the bounty crown. */
  score: number;
  crown: boolean;
  /** One pose per body part, in PART_NAMES order. */
  parts: Pose[];
}

export interface NetBody {
  index: number;
  enabled: boolean;
  pose: Pose;
  /** Power-up bubble: which special arrow is inside (S5). */
  holds: SpecialKind | null;
}

export interface NetArrow {
  id: number;
  ownerSlot: number;
  /** L3: a sticky bomb / plunger on something (bullets themselves vanish where they hit). */
  stuck: boolean;
  /** Special round kind (S5), null for a normal bullet. */
  kind: SpecialKind | null;
  pose: Pose;
}

export interface SnapshotData {
  tick: number;
  /** Head hitbox size (1 = normal; Big Head Mode makes it bigger). Clients use it for the preview and drawing. */
  headScale: number;
  players: NetPlayer[];
  bodies: NetBody[];
  arrows: NetArrow[];
  /** Puddles, balloons, plunger ropes (S5). */
  props: Prop[];
}

const KIND_SNAPSHOT = 1;
const PLAYER_BYTES = 1 + 1 + 1 + 1 + 1 + 1 + 1 + 2 + 2 + 1 + 1 + 2 + 2 + 2 + 2 + PART_NAMES.length * 6;
const BODY_BYTES = 1 + 1 + 1 + 6;
const ARROW_BYTES = 2 + 1 + 1 + 6;
const PROP_BYTES = 2 + 1 + 1 + 1 + 2 + 2;
const HEADER_BYTES = 1 + 4 + 1 + 1 + 1 + 2 + 1;
const PROP_TYPES = Object.keys(PROP_CODE) as PropType[];
const ANGLE_SCALE = 32767 / Math.PI;

const poseOf = (b: { translation(): { x: number; y: number }; rotation(): number }): Pose => {
  const t = b.translation();
  return { x: t.x, y: t.y, a: b.rotation() };
};

/** Reads the current world into a SnapshotData (server side). `movables` is `world.movableBodies()`, captured once. */
export function captureSnapshot(world: GameWorld, movables: MovableBody[]): SnapshotData {
  const players: NetPlayer[] = [];
  for (const [id, p] of world.players) {
    const st = world.playerStats(id);
    players.push({
      slot: world.slotOf(id),
      alive: st.alive,
      armsDown: st.armsDown,
      protected: st.isProtected(world.tick),
      facing: p.facing,
      down: p.down,
      limp: p.limp,
      grounded: p.grounded,
      hp: st.health,
      stamina: st.stamina,
      fx: (world.effects.get(id)?.bits() ?? 0) | (p.mods.oiled ? OILED_BIT : 0),
      held: st.held,
      reload: st.reloadLeft(world.tick),
      lost: partBits(PART_NAMES.filter((n) => p.lost.has(n))),
      dents: partBits([...(world.damage.get(id)?.dents ?? [])]),
      legStage: world.damage.get(id)?.legStage ?? 0,
      weapon: world.damage.get(id)?.weapon ?? 'gun',
      broken: partBits([...(world.damage.get(id)?.broken ?? [])]),
      kills: st.kills,
      score: st.score,
      crown: world.crown === id,
      deaths: st.deaths,
      parts: PART_NAMES.map((n) => poseOf(p.parts[n])),
    });
  }
  const bubbleKind = (m: MovableBody) => (m.kind === 'bubble' ? (world.specials.bubbles.find((b) => b.label === m.label)?.kind ?? null) : null);
  const bodies = movables.map((m, index) => ({ index, enabled: m.collider.isEnabled(), pose: poseOf(m.body), holds: bubbleKind(m) }));
  const arrows: NetArrow[] = [];
  for (const a of world.arrows) {
    if (a.state === 'gone') continue;
    const owner = world.players.has(a.ownerId) ? world.slotOf(a.ownerId) : 0;
    arrows.push({ id: a.id, ownerSlot: owner, stuck: a.state === 'stuck', kind: a.kind === 'normal' ? null : a.kind, pose: { x: a.pos.x, y: a.pos.y, a: a.angle } });
  }
  return { tick: world.tick, headScale: world.headScale, players, bodies, arrows, props: world.specials.props() };
}

/** A set of body parts as bits (bit i = PART_NAMES[i]). */
export const partBits = (parts: readonly PartName[]): number => parts.reduce((b, n) => b | (1 << PART_NAMES.indexOf(n)), 0);
export const hasPart = (bits: number, part: PartName): boolean => (bits & (1 << PART_NAMES.indexOf(part))) !== 0;

const toI16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

function writePose(dv: DataView, o: number, p: Pose): number {
  dv.setInt16(o, toI16(p.x * NET.posScale), true);
  dv.setInt16(o + 2, toI16(p.y * NET.posScale), true);
  dv.setInt16(o + 4, toI16(wrap(p.a) * ANGLE_SCALE), true);
  return o + 6;
}

function readPose(dv: DataView, o: number): Pose {
  return { x: dv.getInt16(o, true) / NET.posScale, y: dv.getInt16(o + 2, true) / NET.posScale, a: dv.getInt16(o + 4, true) / ANGLE_SCALE };
}

export function encodeSnapshot(s: SnapshotData): Uint8Array {
  const arrows = s.arrows.slice(0, 65535);
  const props = s.props.slice(0, 255);
  const buf = new ArrayBuffer(HEADER_BYTES + s.players.length * PLAYER_BYTES + s.bodies.length * BODY_BYTES + arrows.length * ARROW_BYTES + props.length * PROP_BYTES);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o++, KIND_SNAPSHOT);
  dv.setUint32(o, s.tick, true);
  o += 4;
  dv.setUint8(o++, Math.max(1, Math.min(255, Math.round(s.headScale * 10))));
  dv.setUint8(o++, s.players.length);
  dv.setUint8(o++, s.bodies.length);
  dv.setUint16(o, arrows.length, true);
  o += 2;
  dv.setUint8(o++, props.length);
  for (const p of s.players) {
    dv.setUint8(o++, p.slot);
    const flags =
      (p.alive ? 1 : 0) | (p.armsDown ? 2 : 0) | (p.protected ? 4 : 0) | (p.facing < 0 ? 8 : 0) | (p.down ? 16 : 0) | (p.limp ? 32 : 0) | (p.grounded ? 64 : 0) | (p.crown ? 128 : 0);
    dv.setUint8(o++, flags);
    dv.setUint8(o++, Math.max(0, Math.min(255, Math.ceil(p.hp)))); // ceil: 0.3 hp shows as 1 (still alive)
    dv.setUint8(o++, Math.max(0, Math.min(255, Math.floor(p.stamina))));
    dv.setUint8(o++, p.fx & 0xff);
    dv.setUint8(o++, kindCode(p.held));
    dv.setUint8(o++, Math.max(0, Math.min(255, Math.round(p.reload))));
    dv.setUint16(o, p.lost & 0xffff, true);
    dv.setUint16(o + 2, p.dents & 0xffff, true);
    dv.setUint8(o + 4, p.legStage & 0xff);
    dv.setUint8(o + 5, WEAPONS.indexOf(p.weapon));
    dv.setUint16(o + 6, p.broken & 0xffff, true);
    o += 8;
    dv.setUint16(o, Math.min(65535, p.kills), true);
    dv.setUint16(o + 2, Math.min(65535, p.deaths), true);
    dv.setUint16(o + 4, Math.min(65535, p.score), true);
    o += 6;
    for (const part of p.parts) o = writePose(dv, o, part);
  }
  for (const b of s.bodies) {
    dv.setUint8(o++, b.index);
    dv.setUint8(o++, b.enabled ? 1 : 0);
    dv.setUint8(o++, kindCode(b.holds));
    o = writePose(dv, o, b.pose);
  }
  for (const a of arrows) {
    dv.setUint16(o, a.id & 0xffff, true);
    dv.setUint8(o + 2, (a.ownerSlot & 0x0f) | (a.stuck ? 0x80 : 0));
    dv.setUint8(o + 3, kindCode(a.kind));
    o = writePose(dv, o + 4, a.pose);
  }
  for (const p of props) {
    dv.setUint16(o, p.id & 0xffff, true);
    dv.setUint8(o + 2, PROP_CODE[p.type]);
    dv.setUint8(o + 3, Math.max(0, Math.min(255, Math.round(p.a))));
    dv.setUint8(o + 4, Math.max(0, Math.min(255, Math.round(p.b))));
    dv.setInt16(o + 5, toI16(p.x * NET.posScale), true);
    dv.setInt16(o + 7, toI16(p.y * NET.posScale), true);
    o += PROP_BYTES;
  }
  return new Uint8Array(buf);
}

/** Returns null for anything that isn't a well-formed snapshot. */
export function decodeSnapshot(bytes: Uint8Array): SnapshotData | null {
  if (bytes.byteLength < HEADER_BYTES || bytes[0] !== KIND_SNAPSHOT) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 1;
  const tick = dv.getUint32(o, true);
  o += 4;
  const headScale = dv.getUint8(o++) / 10;
  const np = dv.getUint8(o++);
  const nb = dv.getUint8(o++);
  const na = dv.getUint16(o, true);
  o += 2;
  const nq = dv.getUint8(o++);
  if (bytes.byteLength !== HEADER_BYTES + np * PLAYER_BYTES + nb * BODY_BYTES + na * ARROW_BYTES + nq * PROP_BYTES) return null;
  const players: NetPlayer[] = [];
  for (let i = 0; i < np; i++) {
    const slot = dv.getUint8(o++);
    const f = dv.getUint8(o++);
    const hp = dv.getUint8(o++);
    const stamina = dv.getUint8(o++);
    const fx = dv.getUint8(o++);
    const held = kindFromCode(dv.getUint8(o++));
    const reload = dv.getUint8(o++);
    const lost = dv.getUint16(o, true);
    const dents = dv.getUint16(o + 2, true);
    const legStage = dv.getUint8(o + 4);
    const weapon = WEAPONS[dv.getUint8(o + 5)] ?? 'gun';
    const broken = dv.getUint16(o + 6, true);
    o += 8;
    const kills = dv.getUint16(o, true);
    const deaths = dv.getUint16(o + 2, true);
    const score = dv.getUint16(o + 4, true);
    o += 6;
    const parts: Pose[] = [];
    for (let k = 0; k < PART_NAMES.length; k++, o += 6) parts.push(readPose(dv, o));
    players.push({
      slot,
      alive: !!(f & 1),
      armsDown: !!(f & 2),
      protected: !!(f & 4),
      facing: f & 8 ? -1 : 1,
      down: !!(f & 16),
      limp: !!(f & 32),
      grounded: !!(f & 64),
      crown: !!(f & 128),
      score,
      hp,
      stamina,
      fx,
      held,
      reload,
      lost,
      dents,
      legStage,
      weapon,
      broken,
      kills,
      deaths,
      parts,
    });
  }
  const bodies: NetBody[] = [];
  for (let i = 0; i < nb; i++) {
    const index = dv.getUint8(o++);
    const enabled = dv.getUint8(o++) === 1;
    const holds = kindFromCode(dv.getUint8(o++));
    bodies.push({ index, enabled, holds, pose: readPose(dv, o) });
    o += 6;
  }
  const arrows: NetArrow[] = [];
  for (let i = 0; i < na; i++) {
    const id = dv.getUint16(o, true);
    const meta = dv.getUint8(o + 2);
    arrows.push({ id, ownerSlot: meta & 0x0f, stuck: !!(meta & 0x80), kind: kindFromCode(dv.getUint8(o + 3)), pose: readPose(dv, o + 4) });
    o += ARROW_BYTES;
  }
  const props: Prop[] = [];
  for (let i = 0; i < nq; i++) {
    const type = PROP_TYPES[dv.getUint8(o + 2) - 1];
    if (!type) return null;
    props.push({ id: dv.getUint16(o, true), type, a: dv.getUint8(o + 3), b: dv.getUint8(o + 4), x: dv.getInt16(o + 5, true) / NET.posScale, y: dv.getInt16(o + 7, true) / NET.posScale });
    o += PROP_BYTES;
  }
  return { tick, headScale, players, bodies, arrows, props };
}
