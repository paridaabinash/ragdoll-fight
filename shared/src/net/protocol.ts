import type { ArenaInfo } from '../arena';
import { NET } from '../constants';
import type { MatchInfo } from '../match';
import { isHat, type HatKind } from '../spice';
import type { Shape } from '../ragdoll';
import type { GameEvent, StaticShape } from '../world';

/**
 * Messages between browser and server. JSON text, except snapshots, which are binary (see snapshot.ts).
 * Everything a client sends is checked by `parseClientMessage` before the server uses it.
 */

export type ClientMessage =
  /** `room`: a room id from the room list, 'new' for a fresh room, or left out for quick play (fullest room with space). */
  | { t: 'join'; v: number; name: string; room?: string; hat?: HatKind }
  /**
   * Sent when something changes. `aim` = the gun's angle (toward the mouse pointer), or null for none (the gun points
   * straight ahead). L3: an angle only (there's no power any more).
   */
  | { t: 'input'; seq: number; aim: number | null; crouch: boolean; jump: boolean; move: -1 | 0 | 1; taunt?: boolean }
  /**
   * A shot, its own message so a quick click is never lost between two inputs. No power or draw time (L3), no swing
   * tick (L7: the gun never wobbles): the server decides if the gun is ready (reload by server tick, stamina, alive).
   */
  | { t: 'fire'; seq: number; angle: number }
  | { t: 'ping'; c: number };

/** L4: one player's bullet holes (part = PART_NAMES index). */
export interface PlayerHoles {
  id: string;
  holes: { part: number; x: number; y: number }[];
}

/** One entry of the room list (GET /rooms on the game server). */
export interface RoomInfo {
  id: string;
  players: string[];
  max: number;
}

/** GET /rooms answer: open rooms + the addresses other devices on this network can open to play. */
export interface RoomList {
  rooms: RoomInfo[];
  lanUrls: string[];
}

export interface NetBodyInfo {
  index: number;
  label: string;
  kind: 'dynamic' | 'apple' | 'bubble';
  shape: Shape;
}

export interface RosterEntry {
  slot: number;
  id: string;
  name: string;
  bot: boolean;
  /** Cosmetic hat (S7). */
  hat: HatKind;
}

export type ServerMessage =
  /**
   * Lasting things that are otherwise only told by events, as they are now, so someone joining mid-match sees them
   * too (L4): every player's bullet holes this life (part index + spot in that part's frame), the bullet holes in the
   * walls this match, and whose hat a headshot knocked off. After the welcome they come with the events.
   */
  | {
      t: 'welcome';
      you: string;
      slot: number;
      room: string;
      tick: number;
      arena: ArenaInfo;
      match: MatchInfo;
      statics: StaticShape[];
      bodies: NetBodyInfo[];
      holes: PlayerHoles[];
      wallHoles: { x: number; y: number; angle: number }[];
      hatsOff: string[];
      /** L7: the server's game speed; the client steps its previews and stand-in bullets by the same game time. */
      gameSpeed: number;
    }
  /** The match started or ended (results), as of `tick` (clients show it when their delayed picture gets there). */
  | { t: 'match'; tick: number; match: MatchInfo }
  /** A new match in a new arena: snapshots and events AFTER `tick` belong to it. Players keep their slots. */
  | { t: 'arena'; tick: number; arena: ArenaInfo; statics: StaticShape[]; bodies: NetBodyInfo[] }
  | { t: 'roster'; players: RosterEntry[] }
  /** Game events (damage, deaths, ...) from one tick, so clients can show them at the right moment. */
  | { t: 'events'; tick: number; events: GameEvent[] }
  /**
   * Answer to a `fire`: the bullet's id and the server tick it was fired on (L4: the one-handed wobble counts from it),
   * or why it was refused (a FireRefusal, e.g. `fire_too_soon`).
   */
  | { t: 'shot'; seq: number; arrow: number | null; tick?: number; reason?: string; swing?: boolean }
  | { t: 'pong'; c: number; tick: number }
  | { t: 'error'; reason: string };

/** Letters, digits, space, _ and -; trimmed; never empty. */
export function sanitizeName(raw: unknown): string {
  const clean = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .slice(0, NET.nameMaxLength);
  return clean || 'archer';
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isSeq = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Parses and checks a client message. Anything malformed comes back as `{ error }`, never half-trusted. */
export function parseClientMessage(text: string): ClientMessage | { error: string } {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
  } catch {
    return { error: 'not_json' };
  }
  if (!m || typeof m !== 'object') return { error: 'not_object' };
  switch (m.t) {
    case 'join': {
      if (!isNum(m.v)) return { error: 'bad_join' };
      if (m.room !== undefined && (typeof m.room !== 'string' || !/^(new|r\d{1,6})$/.test(m.room))) return { error: 'bad_room' };
      if (m.hat !== undefined && !isHat(m.hat)) return { error: 'bad_hat' };
      return { t: 'join', v: m.v, name: sanitizeName(m.name), ...(m.room !== undefined ? { room: m.room as string } : {}), ...(m.hat !== undefined ? { hat: m.hat as HatKind } : {}) };
    }
    case 'input': {
      const aim = m.aim;
      if (!isSeq(m.seq) || !(aim === null || isNum(aim)) || !isBool(m.crouch) || !isBool(m.jump) || ![-1, 0, 1].includes(m.move as number)) return { error: 'bad_input' };
      if (m.taunt !== undefined && !isBool(m.taunt)) return { error: 'bad_input' };
      return { t: 'input', seq: m.seq, aim: aim as number | null, crouch: m.crouch, jump: m.jump, move: m.move as -1 | 0 | 1, ...(m.taunt ? { taunt: true } : {}) };
    }
    case 'fire':
      if (!isSeq(m.seq) || !isNum(m.angle)) return { error: 'bad_fire' };
      // (anything else in it, like a claimed special round or an old client's power or swing tick, is not copied)
      return { t: 'fire', seq: m.seq, angle: m.angle };
    case 'ping':
      if (!isNum(m.c)) return { error: 'bad_ping' };
      return { t: 'ping', c: m.c };
    default:
      return { error: 'unknown_type' };
  }
}
