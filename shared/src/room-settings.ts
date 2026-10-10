import { arenaById } from './arenas';
import { ROOM } from './constants';

/**
 * M1: what a room plays, picked by whoever creates it. Checked by `parseRoomSettings` (a client sends it in `join`),
 * kept by the server, shown to everyone in the welcome and the room list.
 */

/** M3: the six game modes (rules in `modes.ts`). */
export type GameMode = 'ffa' | 'crown' | 'last_standing' | 'melee' | 'chaos' | 'teams';
export const GAME_MODES: GameMode[] = ['ffa', 'crown', 'last_standing', 'melee', 'chaos', 'teams'];

/**
 * M2: how the next arena is picked. `vote`: everyone votes between 3 random arenas on the results screen (nobody votes →
 * random). `random`: a shuffle bag (each arena once, then reshuffled). `rotation`: the fixed order. `one`: always `arena`.
 */
export type ArenaChoice = 'vote' | 'random' | 'rotation' | 'one';
export const ARENA_CHOICES: ArenaChoice[] = ['vote', 'random', 'rotation', 'one'];

/** Filler bots: none, or how well they aim (`BOT.levels`). */
export type BotLevel = 'off' | 'easy' | 'normal' | 'hard';
export const BOT_LEVELS: BotLevel[] = ['off', 'easy', 'normal', 'hard'];

export interface RoomSettings {
  mode: GameMode;
  arenas: ArenaChoice;
  /** The arena to play (`one`) or to start with (null: random). */
  arena: string | null;
  bots: BotLevel;
  /** People allowed in (bots don't count). */
  maxPlayers: number;
  /** Match length. */
  minutes: number;
  /** Private rooms are left out of the room list: friends join with the code. */
  private: boolean;
}

/** Quick play's rooms. */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  mode: 'ffa',
  arenas: 'vote',
  arena: null,
  bots: 'normal',
  maxPlayers: ROOM.maxPlayers,
  minutes: ROOM.defaultMinutes,
  private: false,
};

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/**
 * Checks settings from a client. Every field is optional (missing = the default); anything wrong refuses the whole
 * thing, so a half-understood room is never made.
 */
export function parseRoomSettings(raw: unknown): RoomSettings | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'settings_not_object' };
  const m = raw as Record<string, unknown>;
  const out: RoomSettings = { ...DEFAULT_ROOM_SETTINGS };
  if (m.mode !== undefined) {
    if (!GAME_MODES.includes(m.mode as GameMode)) return { error: 'bad_mode' };
    out.mode = m.mode as GameMode;
  }
  if (m.arenas !== undefined) {
    if (!ARENA_CHOICES.includes(m.arenas as ArenaChoice)) return { error: 'bad_arenas' };
    out.arenas = m.arenas as ArenaChoice;
  }
  if (m.arena !== undefined && m.arena !== null) {
    if (typeof m.arena !== 'string' || !arenaById(m.arena)) return { error: 'bad_arena' };
    out.arena = m.arena;
  }
  if (out.arenas === 'one' && !out.arena) return { error: 'one_arena_needs_arena' };
  if (m.bots !== undefined) {
    if (!BOT_LEVELS.includes(m.bots as BotLevel)) return { error: 'bad_bots' };
    out.bots = m.bots as BotLevel;
  }
  if (m.maxPlayers !== undefined) {
    if (!isInt(m.maxPlayers, ROOM.minPlayers, ROOM.maxPlayers)) return { error: 'bad_max_players' };
    out.maxPlayers = m.maxPlayers;
  }
  if (m.minutes !== undefined) {
    if (!isInt(m.minutes, ROOM.minutes[0], ROOM.minutes[1])) return { error: 'bad_minutes' };
    out.minutes = m.minutes;
  }
  if (m.private !== undefined) {
    if (typeof m.private !== 'boolean') return { error: 'bad_private' };
    out.private = m.private;
  }
  return out;
}

/** Room codes: 4 capital letters (`FROG`). Typed in lower case is fine. */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) ? code : null;
}
