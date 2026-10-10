import { beforeAll, describe, expect, it } from 'vitest';
import { GameRoom, type Conn } from '../../server/src/room';
import { newRoomCode } from '../../server/src/room-codes';
import {
  BACKYARD,
  DEFAULT_ROOM_SETTINGS,
  initPhysics,
  normalizeRoomCode,
  parseClientMessage,
  parseRoomSettings,
  ROOM,
  ROTATION,
  type LogEntry,
  type RoomSettings,
  type ServerMessage,
} from '../src';

beforeAll(() => initPhysics());

const conn = (into: ServerMessage[] = []): Conn => ({
  send(d) {
    if (typeof d === 'string') into.push(JSON.parse(d) as ServerMessage);
  },
  close() {},
  bufferedAmount: 0,
});

function room(settings: Partial<RoomSettings>) {
  const log: LogEntry[] = [];
  const r = new GameRoom('TEST', (e) => void log.push(e), () => {}, { rotation: ROTATION, settings: { ...DEFAULT_ROOM_SETTINGS, ...settings } });
  return { r, log };
}

describe('M1 room settings', () => {
  it('missing fields are the defaults; every field is checked', () => {
    expect(parseRoomSettings({})).toEqual(DEFAULT_ROOM_SETTINGS);
    expect(parseRoomSettings({ mode: 'teams', arenas: 'one', arena: 'frozen_lake', bots: 'easy', maxPlayers: 4, minutes: 5, private: true })).toEqual({
      mode: 'teams',
      arenas: 'one',
      arena: 'frozen_lake',
      bots: 'easy',
      maxPlayers: 4,
      minutes: 5,
      private: true,
    });
    expect(parseRoomSettings({ mode: 'deathmatch' })).toEqual({ error: 'bad_mode' });
    expect(parseRoomSettings({ arenas: 'all' })).toEqual({ error: 'bad_arenas' });
    expect(parseRoomSettings({ arena: 'moon_base' })).toEqual({ error: 'bad_arena' });
    expect(parseRoomSettings({ arenas: 'one' })).toEqual({ error: 'one_arena_needs_arena' });
    expect(parseRoomSettings({ bots: 'godlike' })).toEqual({ error: 'bad_bots' });
    expect(parseRoomSettings({ maxPlayers: ROOM.maxPlayers + 1 })).toEqual({ error: 'bad_max_players' });
    expect(parseRoomSettings({ maxPlayers: 1 })).toEqual({ error: 'bad_max_players' });
    expect(parseRoomSettings({ minutes: 2.5 })).toEqual({ error: 'bad_minutes' });
    expect(parseRoomSettings({ minutes: Infinity })).toEqual({ error: 'bad_minutes' });
    expect(parseRoomSettings({ private: 'yes' })).toEqual({ error: 'bad_private' });
    expect(parseRoomSettings(null)).toEqual({ error: 'settings_not_object' });
    expect(parseRoomSettings([1])).toEqual({ error: 'settings_not_object' });
  });

  it('join carries settings only for a new room; bad settings refuse the join', () => {
    const join = (m: object) => parseClientMessage(JSON.stringify({ t: 'join', v: 19, name: 'a', ...m }));
    expect(join({ room: 'new', settings: { mode: 'crown' } })).toMatchObject({ room: 'new', settings: { ...DEFAULT_ROOM_SETTINGS, mode: 'crown' } });
    expect(join({ room: 'FROG', settings: { mode: 'crown' } })).toEqual({ error: 'settings_without_new_room' });
    expect(join({ settings: {} })).toEqual({ error: 'settings_without_new_room' });
    expect(join({ room: 'new', settings: { minutes: 99 } })).toEqual({ error: 'bad_settings:bad_minutes' });
  });

  it('room codes: 4 letters, any case typed; new codes never clash', () => {
    expect(normalizeRoomCode(' frog ')).toBe('FROG');
    expect(normalizeRoomCode('FR0G')).toBeNull();
    expect(normalizeRoomCode('FROGS')).toBeNull();
    const taken = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const c = newRoomCode((x) => taken.has(x));
      expect(c).toMatch(/^[A-Z]{4}$/);
      expect(taken.has(c)).toBe(false);
      taken.add(c);
    }
  });

  it('max players: the room is full at the creator\'s number; bots fill a small room only up to it', () => {
    const { r } = room({ maxPlayers: 2 });
    r.join(conn(), 'a');
    expect(r.full).toBe(false);
    expect(r.botCount).toBe(1);
    r.join(conn(), 'b');
    expect(r.full).toBe(true);
    expect(r.botCount).toBe(0);
    r.close();
  });

  it('bots off: nobody but people; bot level reaches the brains', () => {
    const off = room({ bots: 'off' });
    off.r.join(conn(), 'a');
    expect(off.r.botCount).toBe(0);
    off.r.close();
    const easy = room({ bots: 'easy' });
    easy.r.join(conn(), 'a');
    expect(easy.r.botCount).toBe(3);
    expect(easy.log.filter((e) => e.ev === 'bot_join').every((e) => e.skill === 'easy')).toBe(true);
    easy.r.close();
  });

  it('the welcome carries the settings; the room list entry shows mode, arena, players, time left', () => {
    const msgs: ServerMessage[] = [];
    const { r } = room({ mode: 'crown', arenas: 'one', arena: BACKYARD.id, minutes: 2 });
    r.join(conn(msgs), 'ann');
    const welcome = msgs.find((m) => m.t === 'welcome');
    expect(welcome && welcome.t === 'welcome' && welcome.settings).toMatchObject({ mode: 'crown', arenas: 'one', arena: BACKYARD.id, minutes: 2 });
    const info = r.info();
    expect(info).toMatchObject({ id: 'TEST', players: ['ann'], bots: 3, max: DEFAULT_ROOM_SETTINGS.maxPlayers, mode: 'crown', arena: BACKYARD.id, arenaName: BACKYARD.name, phase: 'playing', leader: null });
    expect(info.secondsLeft).toBe(120);
    r.close();
  });
});
