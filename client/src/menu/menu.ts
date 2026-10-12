import Phaser from 'phaser';
import {
  ARENA_CHOICES,
  arenaById,
  arenaLayout,
  BOT_LEVELS,
  DEFAULT_ROOM_SETTINGS,
  GAME_MODES,
  HATS,
  MODES,
  normalizeRoomCode,
  parseRoomSettings,
  ROOM,
  ROTATION,
  type ArenaChoice,
  type BotLevel,
  type GameMode,
  type HatKind,
  type Logger,
  type RoomInfo,
  type RoomList,
  type RoomSettings,
} from '@ragdoll/shared';
import { VIEW } from '../camera';
import { GameScene } from '../GameScene';
import { savedHat, saveHat, type HatProgress } from '../progress';
import { SCENE } from '../skin';
import { arenaThumb } from './arena-thumb';
import { CharacterPreview } from './character';
import { quietLogger } from './quiet-log';
import { HOSTED, serverHttp } from '../server-url';
import './menu.css';

const NAME_KEY = 'ragdoll.name';
const SETTINGS_KEY = 'ragdoll.roomSettings';
const ROOMS_REFRESH_MS = 2000;

/** M4: how each mode looks on its card and in the room list. */
export const MODE_ICONS: Record<GameMode, string> = { ffa: '🎯', crown: '👑', last_standing: '💀', melee: '🏏', chaos: '🌀', teams: '⚔️' };
const ARENA_CHOICE_LOOK: Record<ArenaChoice, { label: string; hint: string }> = {
  vote: { label: 'Vote', hint: 'After each match everyone votes between 3 arenas. Nobody votes: a random one.' },
  random: { label: 'Random', hint: 'A new random arena every match (each one once before any repeats).' },
  rotation: { label: 'In order', hint: 'Every arena in a fixed order.' },
  one: { label: 'One arena', hint: 'Always the arena you pick below.' },
};
const BOT_LOOK: Record<BotLevel, string> = { off: 'Off', easy: 'Easy', normal: 'Normal', hard: 'Hard' };

/** What the page asks the game to join. `room`: a code, 'new' (with `settings`) or undefined (quick play). */
export interface JoinRequest {
  name: string;
  hat: HatKind;
  room?: string;
  settings?: RoomSettings;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

/**
 * M4 home page: a live bot fight behind it, your character card (live ragdoll, name, hat), Play / Create room / Join
 * with code / Practice, and the open rooms with their arenas. The page only asks to join; `join` does the connecting
 * (and throws with a reason the menu shows).
 */
export class Menu {
  private bg: Phaser.Game | null = null;
  private preview: CharacterPreview | null = null;
  private refresher: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private hatIndex = 0;
  private lastRoomsError = '';
  /** Address other devices should open (shown in the game HUD too). */
  shareUrl = '';
  /** `?room=FROG`: the page was opened from an invite. */
  private readonly invite: string | null;
  private settings: RoomSettings;
  private wired = false;

  constructor(
    private readonly log: Logger,
    private readonly progress: HatProgress,
    private readonly join: (req: JoinRequest) => Promise<void>,
  ) {
    this.invite = normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? '');
    this.settings = this.loadSettings();
  }

  /** Shows the home page (again, after a game: `status` says why). */
  show(status = ''): void {
    if (!this.wired) this.wire();
    $('menu').hidden = false;
    $('menu-bg').hidden = false;
    this.setStatus(status);
    this.setBusy(false);
    this.startBackground();
    this.preview ??= new CharacterPreview($('preview'), this.log, HATS[this.hatIndex].kind);
    void this.refreshRooms();
    this.refresher ??= setInterval(() => void this.refreshRooms(), ROOMS_REFRESH_MS);
    if (this.invite) {
      $('invite').hidden = false;
      $('invite').textContent = `You're invited to room ${this.invite}`;
      $('play').textContent = `JOIN ${this.invite}`;
    }
    this.log.info('menu_shown', { invite: this.invite, status: status || null });
  }

  /** Hides it and stops everything it runs (the game takes over the screen). */
  hide(): void {
    $('menu').hidden = true;
    $('menu-bg').hidden = true;
    $('create').hidden = true;
    if (this.refresher) clearInterval(this.refresher);
    this.refresher = null;
    this.preview?.destroy();
    this.preview = null;
    this.bg?.destroy(true);
    this.bg = null;
  }

  // ---- background: bots fighting in a random arena ----

  private startBackground(): void {
    if (this.bg) return;
    const def = ROTATION[Math.floor(Math.random() * ROTATION.length)];
    this.bg = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'menu-bg',
      width: VIEW.width,
      height: VIEW.height,
      backgroundColor: SCENE.background,
      scale: { mode: Phaser.Scale.ENVELOP, autoCenter: Phaser.Scale.CENTER_BOTH },
      banner: false,
      audio: { noAudio: true },
      input: { keyboard: false },
      scene: new GameScene(quietLogger('menu_bg', this.log), arenaLayout(def, 'full'), false, true),
    });
    this.log.info('menu_background', { arena: def.id });
  }

  // ---- wiring ----

  private wire(): void {
    this.wired = true;
    const name = $<HTMLInputElement>('name');
    try {
      name.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      /* storage blocked: just start empty */
    }
    const saved = savedHat(this.progress.p);
    this.hatIndex = Math.max(0, HATS.findIndex((h) => h.kind === saved));
    $('hat-prev').onclick = () => this.stepHat(-1);
    $('hat-next').onclick = () => this.stepHat(1);
    this.showHat();
    $('play').onclick = () => void this.go(this.invite ? { room: this.invite } : {});
    $('new-room').onclick = () => this.openCreate();
    $('join-code-btn').onclick = () => {
      const f = $('join-code');
      f.hidden = !f.hidden;
      if (!f.hidden) $('code').focus();
    };
    $<HTMLFormElement>('join-code').onsubmit = (e) => {
      e.preventDefault();
      const code = normalizeRoomCode($<HTMLInputElement>('code').value);
      if (!code) return this.setStatus('A room code is 4 letters, like FROG.');
      void this.go({ room: code });
    };
    $('practice').onclick = () => {
      const arena = ROTATION[Math.floor(Math.random() * ROTATION.length)].id;
      this.log.info('menu_practice', { arena });
      location.href = `?mode=local&bot=1&arena=${arena}`;
    };
    $('create-close').onclick = () => ($('create').hidden = true);
    // a click on the dark shade around the panel closes it. (A block, not `a && b`: an `onclick` that returns false
    // cancels the click's default, and that stopped CREATE ROOM from submitting the form.)
    $('create').onclick = (e) => {
      if (e.target === $('create')) $('create').hidden = true;
    };
    $<HTMLFormElement>('create-form').onsubmit = (e) => {
      e.preventDefault();
      this.saveSettings();
      void this.go({ room: 'new', settings: this.settings });
    };
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('create').hidden) $('create').hidden = true;
    });
  }

  private async go(target: { room?: string; settings?: RoomSettings }): Promise<void> {
    if (this.busy) return;
    const name = $<HTMLInputElement>('name').value.trim() || 'archer';
    const shown = HATS[this.hatIndex];
    const hat: HatKind = shown.unlocked(this.progress.p) ? shown.kind : savedHat(this.progress.p);
    saveHat(hat);
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* not important */
    }
    this.setBusy(true);
    this.setStatus('Connecting...', true);
    this.log.info('menu_join', { room: target.room ?? 'quick', settings: target.settings ?? null, hat });
    try {
      await this.join({ name, hat, ...target });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('join_failed', { msg, room: target.room ?? 'quick' });
      this.setStatus(
        msg.includes("can't reach")
          ? `${msg}. Is the server running (npm run dev)?`
          : msg === 'room_full'
            ? 'That room is full. Pick another or make a new one.'
            : msg === 'room_not_found'
              ? `No room ${target.room ?? ''} right now. Check the code, or make a new one.`
              : `Couldn't join: ${msg}`,
      );
      this.setBusy(false);
      void this.refreshRooms();
    }
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    for (const id of ['play', 'new-room', 'join-code-btn', 'practice', 'create-go']) $<HTMLButtonElement>(id).disabled = on;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#rooms button')) b.disabled = on || b.dataset.full === '1';
  }

  private setStatus(text: string, ok = false): void {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('ok', ok);
  }

  // ---- hats ----

  private stepHat(dir: number): void {
    this.hatIndex = (this.hatIndex + dir + HATS.length) % HATS.length;
    this.showHat();
  }

  /** Locked hats can be tried on in the preview; you play in the last unlocked one. */
  private showHat(): void {
    const h = HATS[this.hatIndex];
    const open = h.unlocked(this.progress.p);
    $('hat-name').textContent = h.name;
    $('hat-name').parentElement!.classList.toggle('locked', !open);
    $('hat-lock').textContent = open ? '' : `🔒 ${h.how}`;
    if (open) saveHat(h.kind);
    this.preview?.setHat(h.kind);
    const locked = HATS.filter((x) => !x.unlocked(this.progress.p)).length;
    $('hat-help').textContent = locked ? `${HATS.length - locked} of ${HATS.length} hats unlocked. Play to unlock more.` : 'All hats unlocked!';
  }

  // ---- rooms ----

  /** Reads the room list from the game server and redraws it (also shows the address friends should open). */
  private async refreshRooms(): Promise<void> {
    const list = $('rooms');
    try {
      const res = await fetch(serverHttp('/rooms'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RoomList;
      this.lastRoomsError = '';
      const rooms = [...data.rooms].sort((a, b) => Number(a.players.length >= a.max) - Number(b.players.length >= b.max) || b.players.length - a.players.length);
      list.replaceChildren(...(rooms.length ? rooms.map((r) => this.roomCard(r)) : [el('li', { className: 'empty', textContent: 'No open rooms yet. Press PLAY or create one.' })]));
      $('rooms-count').textContent = rooms.length ? `${rooms.length} room${rooms.length > 1 ? 's' : ''}` : '';
      // Hosted: friends open this same page (the server's network addresses are private ones, useless to them).
      // Dev: the dev server's addresses on this network.
      const here = data.lanUrls.find((u) => u.includes(location.hostname));
      const urls = HOSTED ? [location.origin] : here ? [here] : data.lanUrls;
      this.shareUrl = urls[0] ?? '';
      const intro = HOSTED ? 'Friends open' : 'Friends on the same network open';
      $('share').innerHTML = urls.length ? `${intro}: ${urls.map((u) => `<code>${u}</code>`).join(' or ')}` : '';
    } catch (err) {
      const msg = HOSTED ? "Can't reach the game server. It may be down or restarting; trying again..." : `Can't reach the game server (via ${location.host}/rooms). Is it running (npm run dev)?`;
      list.replaceChildren(el('li', { className: 'empty', textContent: msg }));
      if (this.lastRoomsError !== msg) this.log.warn('rooms_unreachable', { url: serverHttp('/rooms'), err: String(err) });
      this.lastRoomsError = msg;
    }
  }

  private roomCard(r: RoomInfo): HTMLLIElement {
    const full = r.players.length >= r.max;
    const mode = MODES[r.mode];
    const clock = `${Math.floor(r.secondsLeft / 60)}:${String(r.secondsLeft % 60).padStart(2, '0')}`;
    const state = r.phase === 'results' ? 'between matches' : `${clock} left`;
    const leader = r.leader ? ` · ${r.leader.name} leads (${r.leader.score})` : '';
    const btn = el('button', { type: 'button', className: 'btn-small', textContent: full ? 'Full' : 'Join', disabled: this.busy || full });
    btn.dataset.full = full ? '1' : '0';
    btn.onclick = () => void this.go({ room: r.id });
    return el(
      'li',
      { className: 'room' },
      el('img', { src: arenaThumb(r.arena, 216, 122), alt: r.arenaName }),
      el(
        'div',
        { className: 'meta' },
        el('div', { className: 'title' }, el('span', { className: 'code', textContent: r.id }), el('span', { className: 'badge', textContent: `${MODE_ICONS[r.mode]} ${mode.name}` })),
        el('div', { className: 'sub', textContent: `${r.arenaName} · ${state}${leader}` }),
        el('div', { className: 'sub', textContent: `${r.players.length}/${r.max} people${r.bots ? ` + ${r.bots} bots` : ''}${r.players.length ? `: ${r.players.join(', ')}` : ''}` }),
      ),
      btn,
    );
  }

  // ---- create a room ----

  private openCreate(): void {
    $('create').hidden = false;
    this.renderCreate();
    this.log.info('menu_create_open', {});
  }

  private renderCreate(): void {
    const s = this.settings;
    const set = (patch: Partial<RoomSettings>) => {
      this.settings = { ...this.settings, ...patch };
      this.renderCreate();
    };
    $('modes').replaceChildren(
      ...GAME_MODES.map((m) => {
        const b = el('button', { type: 'button', className: 'mode' }, el('span', { className: 'icon', textContent: MODE_ICONS[m] }), el('span', { className: 'name', textContent: MODES[m].name }), el('span', { className: 'blurb', textContent: MODES[m].blurb }));
        b.setAttribute('aria-pressed', String(s.mode === m));
        b.onclick = () => set({ mode: m });
        return b;
      }),
    );
    const seg = <T extends string | number>(id: string, values: readonly T[], label: (v: T) => string, current: T, pick: (v: T) => void) =>
      $(id).replaceChildren(
        ...values.map((v) => {
          const b = el('button', { type: 'button', textContent: label(v) });
          b.setAttribute('aria-pressed', String(v === current));
          b.onclick = () => pick(v);
          return b;
        }),
      );
    seg('arena-choice', ARENA_CHOICES, (v) => ARENA_CHOICE_LOOK[v].label, s.arenas, (v) => set({ arenas: v, arena: v === 'one' ? (s.arena ?? ROTATION[0].id) : null }));
    $('arena-hint').textContent = ARENA_CHOICE_LOOK[s.arenas].hint;
    const arenas = $('arenas');
    arenas.hidden = s.arenas !== 'one';
    if (s.arenas === 'one') {
      arenas.replaceChildren(
        ...ROTATION.map((a) => {
          const b = el('button', { type: 'button', className: 'arena-opt' }, el('img', { src: arenaThumb(a.id), alt: '' }), el('span', { textContent: a.name }));
          b.setAttribute('aria-pressed', String(s.arena === a.id));
          b.onclick = () => set({ arena: a.id });
          return b;
        }),
      );
    }
    seg('bots', BOT_LEVELS, (v) => BOT_LOOK[v], s.bots, (v) => set({ bots: v }));
    const minutes = Array.from({ length: ROOM.minutes[1] - ROOM.minutes[0] + 1 }, (_, i) => ROOM.minutes[0] + i);
    seg('minutes', minutes, (v) => `${v} min`, s.minutes, (v) => set({ minutes: v }));
    const max = $<HTMLInputElement>('max');
    max.min = String(ROOM.minPlayers);
    max.max = String(ROOM.maxPlayers);
    max.value = String(s.maxPlayers);
    $('max-out').textContent = String(s.maxPlayers);
    max.oninput = () => {
      this.settings = { ...this.settings, maxPlayers: Number(max.value) };
      $('max-out').textContent = max.value;
    };
    const priv = $<HTMLInputElement>('private');
    priv.checked = s.private;
    priv.onchange = () => (this.settings = { ...this.settings, private: priv.checked });
  }

  private loadSettings(): RoomSettings {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
      if (raw) {
        const s = parseRoomSettings(raw);
        if (!('error' in s) && (!s.arena || arenaById(s.arena))) return s;
      }
    } catch {
      /* blocked or broken: defaults */
    }
    return { ...DEFAULT_ROOM_SETTINGS };
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* not important */
    }
  }
}
