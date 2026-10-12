import {
  decodeSnapshot,
  GAME_SPEED,
  GUN,
  setGameSpeed,
  LagLine,
  type ArenaInfo,
  type HatKind,
  type MatchInfo,
  NET,
  r2,
  SnapshotBuffer,
  type Aim,
  type Controls,
  type GameEvent,
  type Logger,
  type NetBodyInfo,
  type PlayerHoles,
  type RoomSettings,
  type RosterEntry,
  type ServerMessage,
  type SnapshotData,
  type StaticShape,
} from '@ragdoll/shared';

const PING_EVERY_MS = 1000;
const STATS_EVERY_MS = 5000;
/** Aim updates are sent at most this often (on/off changes and other keys go out at once). */
const AIM_SEND_MS = 33;

export interface Welcome {
  you: string;
  slot: number;
  /** M1: the room code and what it plays. */
  room: string;
  settings: RoomSettings;
  arena: ArenaInfo;
  match: MatchInfo;
  statics: StaticShape[];
  bodies: NetBodyInfo[];
  /** L4: lasting things as they were when you joined: everyone's bullet holes, wall holes, hats knocked off. */
  holes: PlayerHoles[];
  wallHoles: { x: number; y: number; angle: number }[];
  hatsOff: string[];
}

/** One match's world as the client knows it: the arena and its shapes, shown from `fromTick` on. */
export interface WorldVersion {
  /** Snapshots after this tick show this world. */
  fromTick: number;
  arena: ArenaInfo;
  statics: StaticShape[];
  bodies: NetBodyInfo[];
}

/** Fake bad connection for testing: `?lag=120&jitter=40` (ms, round trip; each direction gets half). */
export interface LagSettings {
  ms: number;
  jitter: number;
}

/**
 * The browser side of the connection: sends inputs/shots, receives snapshots/events, measures ping,
 * and logs network health every 5 s (`net_stats` in logs/client-latest.jsonl).
 */
export class NetClient {
  readonly buffer = new SnapshotBuffer();
  welcome!: Welcome;
  /** Match info by the tick it starts applying (the welcome's, then each change); see `matchAt`. */
  private matches: { tick: number; info: MatchInfo }[] = [];
  /** The world from the welcome, plus one per new match; the screen picks the one for the tick it's showing. */
  private worlds: WorldVersion[] = [];
  roster: RosterEntry[] = [];
  /** Events waiting to be shown when the (delayed) picture reaches their tick. */
  pendingEvents: { tick: number; ev: GameEvent }[] = [];
  /** Replies to your shots; `newest`: the newest snapshot tick when the reply arrived (snapshots after it show the bullet if it still flies). */
  readonly shotReplies = new Map<number, { arrow: number | null; reason?: string; ms: number; newest: number }>();
  rttMs = 0;
  closed: { code: number; reason: string } | null = null;
  private latestSnap: SnapshotData | null = null;
  private seq = 0;
  private lastSent = '';
  private lastRest = '';
  private lastSentAt = 0;
  private lastAimOn = false;
  /** L3: the gun is reloaded again from then on, as far as this client knows (its own shots; ms, performance.now). */
  readyAtMs = 0;
  /** L4: the server tick my last shot was fired on (from its reply): the one-handed wobble counts from it. */
  /** L5: seqs of melee swings sent: their replies have no bullet, so nothing waits for them in `shotReplies`. */
  private readonly swingSeqs = new Set<number>();
  /** That last shot's full reload (ms; L4: longer one-handed). */
  private reloadMs = (GUN.reloadTicks * 1000) / 60;
  private shotSentAt = new Map<number, number>();
  private readonly sendLine = new LagLine(() => performance.now(), (fn, ms) => setTimeout(fn, ms));
  private readonly recvLine = new LagLine(() => performance.now(), (fn, ms) => setTimeout(fn, ms));
  private io = { bytesIn: 0, bytesOut: 0, msgsOut: 0, since: performance.now() };
  private timers: ReturnType<typeof setInterval>[] = [];

  private constructor(
    private readonly ws: WebSocket,
    private readonly log: Logger,
    private readonly lag: LagSettings,
  ) {}

  /**
   * Connects and joins (`room`: a room code, 'new' (M1: with `settings`), or undefined for quick play); resolves on the
   * welcome.
   */
  static connect(url: string, name: string, log: Logger, lag: LagSettings, room?: string, hat?: HatKind, settings?: RoomSettings): Promise<NetClient> {
    log.info('net_connecting', { url, name, lag, room: room ?? 'quick' });
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const client = new NetClient(ws, log, lag);
    return new Promise((resolve, reject) => {
      let welcomed = false;
      ws.onopen = () => client.send(JSON.stringify({ t: 'join', v: NET.protocolVersion, name, ...(room ? { room } : {}), ...(hat ? { hat } : {}), ...(settings ? { settings } : {}) }));
      ws.onmessage = (e) =>
        client.delayed('recv', () => {
          const msg = client.receive(e.data as ArrayBuffer | string);
          if (msg?.t === 'welcome' && !welcomed) {
            welcomed = true;
            client.startTimers();
            resolve(client);
          } else if (msg?.t === 'error' && !welcomed) reject(new Error(msg.reason));
        });
      ws.onerror = () => !welcomed && reject(new Error(`can't reach the game server at ${url}`));
      ws.onclose = (e) => {
        client.closed = { code: e.code, reason: e.reason || 'connection lost' };
        client.timers.forEach(clearInterval);
        // (leaving on purpose is not a problem)
        log[e.reason === 'left' ? 'info' : 'warn']('net_closed', { code: e.code, reason: e.reason, clean: e.wasClean });
        if (!welcomed) reject(new Error(e.reason || `connection closed (${e.code})`));
      };
    });
  }

  /** The match as of `tick` (timer, phase, results): changes show up when the delayed picture reaches them. */
  matchAt(tick: number): MatchInfo {
    let m = this.matches[0].info;
    for (const v of this.matches) if (v.tick <= tick) m = v.info;
    return m;
  }

  /** The world (arena + shapes) to draw at `tick`. */
  worldAt(tick: number): WorldVersion {
    let w = this.worlds[0];
    for (const v of this.worlds) if (v.fromTick < tick) w = v;
    return w;
  }

  /** Newest snapshot received (no smoothing delay). */
  latest(): SnapshotData | null {
    return this.latestSnap;
  }

  /** Sends controls when they change. Aim angle changes are limited to ~30 per second. */
  sendInput(c: Controls): void {
    const aim = c.aim ? +c.aim.angle.toFixed(4) : null;
    const rest = JSON.stringify([c.crouch, c.jump, c.move, !!c.taunt]);
    const body = JSON.stringify(aim) + rest;
    if (body === this.lastSent) return;
    const now = performance.now();
    const aimOnlyChange = rest === this.lastRest && (aim !== null) === this.lastAimOn;
    if (aimOnlyChange && now - this.lastSentAt < AIM_SEND_MS) return; // called every frame, so the newest aim goes out shortly
    this.lastSent = body;
    this.lastRest = rest;
    this.lastSentAt = now;
    this.lastAimOn = aim !== null;
    this.send(JSON.stringify({ t: 'input', seq: this.seq++, aim, crouch: c.crouch, jump: c.jump, move: c.move, ...(c.taunt ? { taunt: true } : {}) }));
  }

  /** L3: this client's own reload: can it fire now? (The server decides; this stops sending shots it would refuse.) */
  gunReady(now = performance.now()): boolean {
    return now >= this.readyAtMs;
  }

  /** Reload share for the gun drawing and the ring: 0 = just fired .. 1 = ready. */
  readyShare(now = performance.now()): number {
    return 1 - Math.max(0, Math.min(1, (this.readyAtMs - now) / this.reloadMs));
  }

  /**
   * Sends a shot (`aim` = where you aim: L7, the gun never wobbles, the bullet goes exactly there); starts the local
   * reload; returns its seq. `melee` (L5): it's a bat/mace swing (same message; no bullet comes back).
   */
  fire(aim: Aim, reloadTicks: number = GUN.reloadTicks, melee = false): number {
    const seq = this.seq++;
    const now = performance.now();
    this.shotSentAt.set(seq, now);
    if (melee) this.swingSeqs.add(seq);
    this.reloadMs = (reloadTicks * 1000) / 60;
    this.readyAtMs = now + this.reloadMs;
    this.send(JSON.stringify({ t: 'fire', seq, angle: +aim.angle.toFixed(4) }));
    this.log.info('shot_sent', { seq, angleDeg: Math.round((aim.angle * 180) / Math.PI), newest: this.latestSnap?.tick ?? null });
    return seq;
  }

  nameOf(id: string): string {
    const r = this.roster.find((e) => e.id === id);
    return r ? `${r.name}${r.bot ? ' (bot)' : ''}` : id;
  }

  // ---- internals ----

  /** M2: my vote for the next arena (the server checks it; everyone hears it in the match info). */
  vote(arena: string): void {
    this.log.info('vote_sent', { arena });
    this.send(JSON.stringify({ t: 'vote', arena }));
  }

  /** Leaves the room (M4: back to the menu). */
  leave(): void {
    this.timers.forEach(clearInterval);
    this.ws.close(1000, 'left');
  }

  private send(text: string): void {
    this.io.bytesOut += text.length;
    this.io.msgsOut++;
    this.delayed('send', () => this.ws.readyState === WebSocket.OPEN && this.ws.send(text));
  }

  /** Fake lag keeps message order, like a real connection: each message waits for the one before it. */
  private delayed(dir: 'send' | 'recv', fn: () => void): void {
    if (!this.lag.ms && !this.lag.jitter) return fn();
    (dir === 'send' ? this.sendLine : this.recvLine).push(this.lag.ms / 2 + Math.random() * this.lag.jitter, fn);
  }

  private receive(data: ArrayBuffer | string): ServerMessage | null {
    const now = performance.now();
    if (typeof data !== 'string') {
      this.io.bytesIn += data.byteLength;
      const snap = decodeSnapshot(new Uint8Array(data));
      if (!snap) {
        this.log.warn('bad_snapshot', { bytes: data.byteLength });
        return null;
      }
      this.latestSnap = snap;
      this.buffer.push(snap, now);
      return null;
    }
    this.io.bytesIn += data.length;
    const msg = JSON.parse(data) as ServerMessage;
    switch (msg.t) {
      case 'welcome':
        this.welcome = msg;
        this.matches = [{ tick: -Infinity, info: msg.match }];
        this.worlds = [{ fromTick: -Infinity, arena: msg.arena, statics: msg.statics, bodies: msg.bodies }];
        // L7: step previews and stand-in bullets by the server's game time, or they'd drift from the real bullets
        if (!setGameSpeed(msg.gameSpeed)) this.log.error('bad_game_speed', { got: msg.gameSpeed ?? null, using: GAME_SPEED });
        this.log.info('net_welcome', { room: msg.room, you: msg.you, slot: msg.slot, arena: msg.arena.id, size: msg.arena.size, statics: msg.statics.length, bodies: msg.bodies.length, gameSpeed: GAME_SPEED });
        break;
      case 'match':
        this.matches = [...this.matches.slice(-2), { tick: msg.tick, info: msg.match }];
        this.log.info('net_match', { match: msg.match.number, phase: msg.match.phase, arena: msg.match.arena, result: msg.match.result?.reason ?? null, winner: msg.match.result?.winner ?? null });
        break;
      case 'arena':
        this.worlds = [...this.worlds.slice(-1), { fromTick: msg.tick, arena: msg.arena, statics: msg.statics, bodies: msg.bodies }];
        this.buffer.cut(msg.tick);
        this.log.info('net_arena', { tick: msg.tick, arena: msg.arena.id, size: msg.arena.size, statics: msg.statics.length, bodies: msg.bodies.length });
        break;
      case 'roster':
        this.roster = msg.players;
        this.log.info('net_roster', { players: msg.players.map((p) => `${p.name}${p.bot ? '(bot)' : ''}`) });
        break;
      case 'events':
        for (const ev of msg.events) this.pendingEvents.push({ tick: msg.tick, ev });
        break;
      case 'shot': {
        const sent = this.shotSentAt.get(msg.seq);
        const ms = sent === undefined ? -1 : Math.round(now - sent);
        this.shotSentAt.delete(msg.seq);
        if (this.swingSeqs.delete(msg.seq)) {
          if (msg.swing || msg.reason) this.log.info('swing_reply', { seq: msg.seq, ok: !!msg.swing, reason: msg.reason ?? null, ms });
          else this.log.warn('swing_reply_odd', { seq: msg.seq, arrow: msg.arrow, ms }); // a bullet for a swing: the client and server disagree on the weapon
          break;
        }
        this.shotReplies.set(msg.seq, { arrow: msg.arrow, reason: msg.reason, ms, newest: this.latestSnap?.tick ?? 0 });
        this.log.info('shot_reply', { seq: msg.seq, arrow: msg.arrow, reason: msg.reason ?? null, ms });
        break;
      }
      case 'pong':
        this.rttMs = Math.round(now - msg.c);
        break;
      case 'error':
        this.log.error('server_error', { reason: msg.reason });
        break;
    }
    return msg;
  }

  private startTimers(): void {
    this.timers.push(setInterval(() => this.send(JSON.stringify({ t: 'ping', c: performance.now() })), PING_EVERY_MS));
    this.timers.push(
      setInterval(() => {
        const now = performance.now();
        const secs = (now - this.io.since) / 1000;
        const b = this.buffer.resetStats();
        const data = {
          rttMs: this.rttMs,
          snapshotsPerSec: r2(b.received / secs),
          underruns: b.underruns,
          maxGapMs: Math.round(b.maxGapMs),
          depth: this.buffer.depth(now),
          kbInPerSec: r2(this.io.bytesIn / 1024 / secs),
          kbOutPerSec: r2(this.io.bytesOut / 1024 / secs),
          msgsOutPerSec: r2(this.io.msgsOut / secs),
        };
        if (b.received / secs < 15 || b.maxGapMs > 250) this.log.warn('net_poor', data);
        else this.log.info('net_stats', data);
        this.io = { bytesIn: 0, bytesOut: 0, msgsOut: 0, since: now };
      }, STATS_EVERY_MS),
    );
  }
}
