/**
 * Headless multiplayer check: `npm run netsim`  (or `npm run netsim -- basic lag` for some scenarios)
 * Starts a real game server in this process and connects bot players over real WebSockets.
 * Everything goes to logs/netsim-latest.jsonl (server + bots). Exits 1 if anything looks wrong.
 */
import WebSocket from 'ws';
import {
  decodeSnapshot,
  initPhysics,
  LagLine,
  Logger,
  NET,
  PHYSICS_HZ,
  replayBuffer,
  SnapshotBuffer,
  type Arrival,
  TEST_LAB,
  BACKYARD,
  type ArenaInfo,
  type ArenaDef,
  arenaLayout,
  ROTATION,
  type MatchInfo,
  type GameEvent,
  type LogEntry,
  type RoomList,
  type RosterEntry,
  type ServerMessage,
  type SnapshotData,
  PART_NAMES,
  GUN,
  launchPointFrom,
  launchVelocity,
  raycastShapes,
  shoulderFrontFrom,
  solveAim,
  traceArrow,
  traceShot,
  windAt,
  type PlacedShape,
  type StaticShape,
  type Vec2,
  setGameSpeed,
} from '../shared/src';
import type { RoomOptions } from '../server/src/room';
import { createGameServer, type GameServer } from '../server/src/server';
import { fileSink } from './log-files';

await initPhysics();
const file = fileSink('netsim', { background: true }); // the real server runs in this process: same log writing as live
const entries: LogEntry[] = [];
const sink = (e: LogEntry) => {
  entries.push(e);
  file(e);
};
const problems: string[] = [];
const check = (ok: boolean, msg: string) => void (ok || problems.push(msg));
const only = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r2 = (n: number) => Math.round(n * 100) / 100;
const since = (mark: number) => entries.slice(mark);

/** A scripted player over a real socket, with optional fake lag (each direction gets half, plus random jitter). */
class Bot {
  ws!: WebSocket;
  id = '';
  slot = 0;
  room = '';
  arena: ArenaInfo | null = null;
  match: MatchInfo | null = null;
  /** Chaos rounds heard (kind@start-end), in order. */
  modifiersHeard: string[] = [];
  /** Every `match` and `arena` message, in order (to compare between players). */
  matchLog: string[] = [];
  roster: RosterEntry[] = [];
  events: { tick: number; ev: GameEvent }[] = [];
  snapshots = 0;
  snapshotBytes = 0;
  bytesIn = 0;
  badSnapshots = 0;
  lastSnapshot: SnapshotData | null = null;
  /** Recent snapshots by tick (to compare what two players saw at the same moment). */
  snapsByTick = new Map<number, SnapshotData>();
  /** Movable body labels by snapshot index (from welcome / arena messages). */
  bodyLabels: string[] = [];
  /** L4: everyone's bullet holes when this client joined. */
  welcomeHoles: { id: string; holes: unknown[] }[] = [];
  /** L7: the game speed the server's welcome said. */
  gameSpeed: number | null = null;
  /** The arena's fixed shapes (walls, floors), for a browser-like preview. */
  statics: StaticShape[] = [];
  /** L3: this client's own reload, like the browser: no shot is sent before it (ms, performance.now). */
  readyAtMs = 0;
  private lastFireAt = 0;
  /** Tick the current arena (world) started; snapshots up to it still show the old one. */
  arenaTick = -Infinity;
  shots: { seq: number; arrow: number | null; reason?: string; swing?: boolean }[] = [];
  /** `fire` messages sent (each must get a `shot` reply). */
  firesSent = 0;
  errors: string[] = [];
  closed = false;
  buffer = new SnapshotBuffer();
  /** Every snapshot with when the socket handed it over (`wsMs`) and the fake delay drawn for it (to replay on a perfect clock). */
  netLog: { snap: SnapshotData; wsMs: number; delayMs: number }[] = [];
  private seq = 0;
  private readonly sendLine = new LagLine(() => performance.now(), (fn, ms) => setTimeout(fn, ms));
  private readonly recvLine = new LagLine(() => performance.now(), (fn, ms) => setTimeout(fn, ms));
  private readonly log: Logger;

  constructor(
    readonly name: string,
    private readonly lag = { ms: 0, jitter: 0 },
  ) {
    this.log = new Logger(`bot:${name}`, sink);
  }

  /** `room`: an id from the room list, 'new', or undefined for quick play. */
  connect(port: number, protocol: number = NET.protocolVersion, room?: string): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (data: Buffer, isBinary) => {
      const wsMs = performance.now();
      const delayMs = this.drawDelay();
      this.delayed('recv', delayMs, () => this.receive(data, isBinary, wsMs, delayMs));
    });
    this.ws.on('close', () => (this.closed = true));
    return new Promise((ok, fail) => {
      this.ws.once('open', () => {
        this.sendRaw(JSON.stringify({ t: 'join', v: protocol, name: this.name, ...(room ? { room } : {}) }));
        ok();
      });
      this.ws.once('error', fail);
    });
  }

  async waitWelcome(timeoutMs = 3000): Promise<boolean> {
    for (let t = 0; t < timeoutMs && !this.id && !this.closed; t += 20) await sleep(20);
    return !!this.id;
  }

  /** L3: `aim` = the gun's angle (null: no aim input, the gun points ahead). */
  input(aim: number | null, move: -1 | 0 | 1 = 0, jump = false): void {
    this.log.info('input_sent', { seq: this.seq, aim, move });
    this.sendRaw(JSON.stringify({ t: 'input', seq: this.seq++, aim, crouch: false, jump, move }));
  }

  /** Waits until this client's own reload is done (like the browser holding the button). */
  async reloaded(): Promise<void> {
    while (performance.now() < this.readyAtMs) await sleep(5);
  }

  /** A shot like the browser sends it: the angle; starts the local reload. Returns its seq. */
  fire(angle: number, extra: Record<string, unknown> = {}): number {
    const seq = this.seq++;
    this.firesSent++;
    this.lastFireAt = performance.now();
    this.readyAtMs = this.lastFireAt + (GUN.reloadTicks * 1000) / 60;
    this.log.info('fire_sent', { seq, newest: this.lastSnapshot?.tick ?? null });
    this.sendRaw(JSON.stringify({ t: 'fire', seq, angle, ...extra }));
    return seq;
  }

  sendRaw(text: string): void {
    this.delayed('send', this.drawDelay(), () => this.ws.readyState === WebSocket.OPEN && this.ws.send(text));
  }

  close(): void {
    this.ws.close();
  }

  /** Same order is kept (like a real TCP connection): one queue per direction (`LagLine`). */
  private delayed(dir: 'send' | 'recv', delayMs: number, fn: () => void): void {
    if (!this.lag.ms && !this.lag.jitter) return fn();
    (dir === 'send' ? this.sendLine : this.recvLine).push(delayMs, fn);
  }

  private drawDelay(): number {
    return this.lag.ms / 2 + Math.random() * this.lag.jitter;
  }

  /**
   * When each snapshot WOULD have arrived if only the fake network delayed it: sent exactly on its tick (the
   * server's clock is fixed by the most punctual snapshot), plus the delay drawn for it, never before the one
   * before (`LagLine` keeps order). Lateness from a busy machine (server ticking late, timers firing late) drops out.
   */
  idealArrivals(): Arrival[] {
    const msPerTick = 1000 / PHYSICS_HZ;
    const start = Math.min(...this.netLog.map((m) => m.wsMs - m.snap.tick * msPerTick));
    let last = -Infinity;
    return this.netLog.map((m) => ({ snap: m.snap, atMs: (last = Math.max(last, start + m.snap.tick * msPerTick + m.delayMs)) }));
  }

  private receive(data: Buffer, isBinary: boolean, wsMs: number, delayMs: number): void {
    this.bytesIn += data.byteLength;
    if (isBinary) {
      const snap = decodeSnapshot(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (!snap) {
        this.badSnapshots++;
        return;
      }
      this.snapshots++;
      this.snapshotBytes += data.byteLength;
      this.lastSnapshot = snap;
      this.snapsByTick.set(snap.tick, snap);
      if (this.snapsByTick.size > 1500) this.snapsByTick.delete(this.snapsByTick.keys().next().value!);
      this.buffer.push(snap, performance.now());
      this.netLog.push({ snap, wsMs, delayMs });
      return;
    }
    const msg = JSON.parse(data.toString()) as ServerMessage;
    if (msg.t === 'welcome') {
      [this.id, this.slot, this.room, this.arena, this.match] = [msg.you, msg.slot, msg.room, msg.arena, msg.match];
      this.bodyLabels = msg.bodies.map((b) => b.label);
      this.statics = msg.statics;
      this.welcomeHoles = msg.holes;
      this.gameSpeed = msg.gameSpeed;
    }
    else if (msg.t === 'match') {
      this.match = msg.match;
      const m = msg.match.modifier;
      if (m) this.modifiersHeard.push(`${m.kind}@${m.start}-${m.end}`);
      this.matchLog.push(`match ${msg.match.number} ${msg.match.phase} ${msg.match.result?.reason ?? ''} ${msg.match.result?.winner ?? ''}`);
    } else if (msg.t === 'arena') {
      this.bodyLabels = msg.bodies.map((b) => b.label);
      this.statics = msg.statics;
      this.arenaTick = msg.tick;
      this.arena = msg.arena;
      this.matchLog.push(`arena ${msg.tick} ${msg.arena.id}/${msg.arena.size}`);
    }
    else if (msg.t === 'roster') this.roster = msg.players;
    else if (msg.t === 'events') for (const ev of msg.events) this.events.push({ tick: msg.tick, ev });
    else if (msg.t === 'shot') {
      this.shots.push(msg);
    }
    else if (msg.t === 'error') this.errors.push(msg.reason);
    if (msg.t === 'welcome' || msg.t === 'error') this.log.info(`got_${msg.t}`, msg.t === 'welcome' ? { id: msg.you, room: msg.room } : { reason: msg.reason });
  }

  /** Simple fighter: walks a bit, aims at the nearest other player for 0.3-0.6 s, fires 1-3 times (each on its reload). */
  async fight(ms: number): Promise<void> {
    const end = performance.now() + ms;
    while (performance.now() < end && !this.closed) {
      const move = ([-1, 0, 1] as const)[Math.floor(Math.random() * 3)];
      this.input(null, move);
      await sleep(300 + Math.random() * 300);
      const angle = this.aimAngle();
      this.input(angle, 0);
      await sleep(300 + Math.random() * 300);
      const burst = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < burst && performance.now() < end && !this.closed; i++) {
        await this.reloaded();
        this.fire(angle);
      }
      this.input(null, 0);
      await sleep(100);
    }
  }

  /**
   * L3: where this client's preview says a shot goes, computed exactly like the browser: the shoulder from the newest
   * snapshot, the arena's fixed shapes, wind (L7: the aim is exactly the angle: the gun never wobbles).
   */
  predict(angle: number): { hit: Vec2 | null; label: string | null } {
    const me = this.lastSnapshot?.players.find((p) => p.slot === this.slot);
    if (!me || !this.arena) return { hit: null, label: null };
    const shapes: PlacedShape[] = this.statics.map((s) => ({ ...s }));
    const arena = this.arena;
    const shot = traceShot(shoulderFrontFrom(me.parts[1], me.parts[1].a), { angle }, (a, b) => raycastShapes(a, b, shapes), arena, (p) => windAt(arena.hazards, p));
    return { hit: shot.hit?.point ?? null, label: shot.hit?.label ?? null };
  }

  /**
   * Where a bullet at this client's aim angle lands if it starts where the server really launched it (its `fire` log):
   * this checks the ANGLE (the swing / wobble) exactly, apart from the start point. The start point is the client's
   * newest snapshot of its own shoulder, a little old: if the body sways (an arm-hit gun arm whips it), the plain
   * preview is a few cm off (the one known limit for a moving shooter).
   */
  landFrom(start: Vec2, realAngle: number): Vec2 | null {
    if (!this.arena) return null;
    const shapes: PlacedShape[] = this.statics.map((s) => ({ ...s }));
    const arena = this.arena;
    return traceArrow(start, launchVelocity({ angle: realAngle }), (a, b) => raycastShapes(a, b, shapes), arena, (p) => windAt(arena.hazards, p)).hit?.point ?? null;
  }

  /** Waits (up to `ms`) for a snapshot of the current arena: right after an `arena` message the newest one can still be the old world. */
  async waitNewWorld(ms = 2000): Promise<boolean> {
    for (let t = 0; t < ms; t += 50) {
      if ((this.lastSnapshot?.tick ?? -Infinity) > this.arenaTick) return true;
      await sleep(50);
    }
    this.log.warn('no_new_world_snapshot', { arenaTick: this.arenaTick, newest: this.lastSnapshot?.tick ?? null });
    return false;
  }

  /** Aims at a point (e.g. a power-up bubble) with the same arc math as the server bots, waits for the reload, fires. */
  async shootAt(target: Vec2, extra: Record<string, unknown> = {}): Promise<boolean> {
    const me = this.lastSnapshot?.players.find((p) => p.slot === this.slot);
    if (!me?.alive) {
      this.log.info('shoot_skipped', { why: me ? 'dead' : 'not_in_snapshot', tick: this.lastSnapshot?.tick ?? null });
      return false;
    }
    const shoulder = shoulderFrontFrom(me.parts[1], me.parts[1].a);
    let angle = solveAim(shoulder, target, GUN.bulletSpeed);
    if (angle === null) {
      this.log.info('shoot_skipped', { why: 'out_of_reach', from: [r2(shoulder.x), r2(shoulder.y)], target: [r2(target.x), r2(target.y)] });
      return false;
    }
    angle = solveAim(launchPointFrom(shoulder, { angle }), target, GUN.bulletSpeed) ?? angle;
    this.input(angle);
    await sleep(400); // the arm swings up to the aim
    await this.reloaded();
    this.fire(angle, extra);
    this.input(null);
    await sleep(500);
    return true;
  }

  private aimAngle(): number {
    const snap = this.lastSnapshot;
    const me = snap?.players.find((p) => p.slot === this.slot);
    const others = snap?.players.filter((p) => p.slot !== this.slot && p.alive) ?? [];
    if (!me || !others.length) return -0.3;
    const torso = me.parts[1];
    const target = others.sort((a, b) => Math.abs(a.parts[1].x - torso.x) - Math.abs(b.parts[1].x - torso.x))[0].parts[1];
    // aim a little above the target to make up for the drop over the distance
    const dx = target.x - torso.x;
    return Math.atan2(target.y - torso.y - Math.abs(dx) * 0.12, dx) + (Math.random() - 0.5) * 0.06;
  }
}

async function withServer(name: string, fn: (srv: GameServer) => Promise<void>, room?: RoomOptions): Promise<void> {
  new Logger('netsim', sink).info('scenario_start', { scenario: name });
  const srv = await createGameServer({ port: 0, sink, room });
  try {
    await fn(srv);
  } finally {
    await srv.close();
  }
}

/**
 * 6 bots fight in one arena for a few seconds: everyone got the same arena (its small size: a room's first arena is
 * sized for a filled room of 4), the server built it without problems, every body part decodes inside it, bullets fly.
 */
async function arenaCheck(def: ArenaDef): Promise<void> {
  await withServer(
    `arena:${def.id}`,
    async (srv) => {
      const mark = entries.length;
      const bots = ['ari', 'bo', 'cy', 'di', 'ed', 'fa'].map((n) => new Bot(n));
      for (const b of bots) {
        await b.connect(srv.port);
        await b.waitWelcome();
      }
      await Promise.all(bots.map((b) => b.fight(4000)));
      const arenas = new Set(bots.map((b) => JSON.stringify(b.arena)));
      const info = bots[0].arena;
      const want = arenaLayout(def, def.narrow ? 'narrow' : 'full');
      let maxX = 0;
      let outside = 0;
      let poses = 0;
      for (const b of bots) {
        for (const p of b.lastSnapshot?.players ?? []) {
          for (const part of p.parts) {
            poses++;
            maxX = Math.max(maxX, part.x);
            if (!info || part.x < -4 || part.x > info.width + 4 || part.y < -30 || part.y > info.height + 4) outside++;
          }
        }
      }
      const loaded = since(mark).find((e) => e.ev === 'arena_loaded');
      const fired = bots.reduce((n, b) => n + b.shots.filter((s) => s.arrow !== null).length, 0);
      console.log(
        `arena:     ${def.id}: ${bots.length} bots, got ${info?.id}/${info?.size} ${info?.width}x${info?.height}, same for all ${arenas.size === 1}, ` +
          `server arena problems ${loaded?.problems}, furthest body part x ${r2(maxX)}, parts outside the arena ${outside}/${poses}, bullets fired ${fired}, bad snapshots ${bots.reduce((n, b) => n + b.badSnapshots, 0)}`,
      );
      check(arenas.size === 1 && info?.id === def.id && info.width === want.width, `arena: ${def.id}: bots got different or wrong arenas (${[...arenas].join(' / ')})`);
      check(loaded?.problems === 0, `arena: ${def.id}: server built the arena with ${loaded?.problems} problems`);
      check(want.width <= 32 || maxX > 32, `arena: ${def.id}: nobody was further right than x ${r2(maxX)} (past the old 32 m arena)`);
      check(outside === 0 && poses > 0, `arena: ${def.id}: ${outside} body parts decoded outside the arena`);
      check(fired > 3, `arena: ${def.id}: only ${fired} bullets fired`);
      for (const b of bots) b.close();
      await sleep(300);
    },
    { rotation: [def] },
  );
}

const scenarios: Record<string, () => Promise<void>> = {
  // 4 players fight for 12 s: everyone hears the same story, at the right rate, within budget.
  // L7 game-speed dial: a server at 0.85 tells every client in the welcome; bots fight; still-target shots land exactly
  // where the server's own preview said (the server and the bots share the dial here: one process).
  async game_speed() {
    setGameSpeed(0.85);
    try {
      await withServer('game_speed', async (srv) => {
        const mark = entries.length;
        const bots = ['sam', 'tia', 'uma'].map((n) => new Bot(n));
        for (const b of bots) await b.connect(srv.port);
        await Promise.all(bots.map((b) => b.waitWelcome()));
        await Promise.all(bots.map((b) => b.fight(8000)));
        const log = since(mark);
        const still = log.filter((e) => e.ev === 'arrow_hit' && e.moving === false);
        const off = still.filter((e) => Number(e.predErr) > 0.01 || Number(e.predTickErr) !== 0);
        const speeds = bots.map((b) => b.gameSpeed);
        const trouble = log.filter((e) => e.lvl === 'warn' || e.lvl === 'error').filter((e) => !['slow_step', 'rate_limited'].includes(String(e.ev)));
        console.log(`game_speed: welcome said ${speeds.join('/')}, hits on still things ${still.length} (off the preview ${off.length}), warnings ${trouble.map((e) => e.ev).join(',') || 0}`);
        check(speeds.every((v) => v === 0.85), `game_speed: welcome said ${speeds}`);
        check(still.length > 5 && off.length === 0, `game_speed: ${off.length} of ${still.length} still hits off the preview`);
        check(trouble.length === 0, `game_speed: ${trouble[0]?.ev}`);
        for (const b of bots) b.close();
        await sleep(300);
      });
    } finally {
      setGameSpeed(1);
    }
  },

  async basic() {
    await withServer('basic', async (srv) => {
      const bots = ['ana', 'ben', 'cid', 'dee'].map((n) => new Bot(n));
      for (const b of bots) await b.connect(srv.port);
      const welcomed = await Promise.all(bots.map((b) => b.waitWelcome()));
      await sleep(300);
      const rosterSizes = bots.map((b) => b.roster.length);
      const hasDummy = bots.some((b) => b.roster.some((r) => r.bot));
      const startSnaps = bots.map((b) => b.snapshots);
      const t0 = performance.now();
      await Promise.all(bots.map((b) => b.fight(12000)));
      const secs = (performance.now() - t0) / 1000;
      const rates = bots.map((b, i) => (b.snapshots - startSnaps[i]) / secs);
      const kbps = bots.map((b) => b.bytesIn / 1024 / secs);
      const avgSnap = bots.map((b) => b.snapshotBytes / Math.max(1, b.snapshots));
      const fired = bots.reduce((n, b) => n + b.shots.filter((s) => s.arrow !== null).length, 0);
      const story = (b: Bot) => JSON.stringify(b.events.filter((e) => e.ev.type !== 'apple'));
      const same = bots.every((b) => story(b) === story(bots[0]));
      const deaths = bots[0].events.filter((e) => e.ev.type === 'death').length;
      const callouts = bots[0].events.filter((e) => e.ev.type === 'callout').map((e) => (e.ev as { kind: string }).kind);
      const damage = bots[0].events.filter((e) => e.ev.type === 'damage').length;
      console.log(
        `basic:     4 bots, welcomed ${welcomed.filter(Boolean).length}/4, roster ${rosterSizes.join('/')}, dummy ${hasDummy}, snapshots/s ${rates.map(r2).join(' ')}, ` +
          `snapshot ~${Math.round(avgSnap[0])} B, in ${kbps.map(r2).join(' ')} KB/s, bullets fired ${fired}, damage events ${damage}, deaths ${deaths}, callouts [${callouts.join(',')}], same story on all bots ${same}`,
      );
      check(welcomed.every(Boolean), 'basic: not every bot was welcomed');
      check(rosterSizes.every((n) => n === 4) && !hasDummy, `basic: roster sizes ${rosterSizes} / dummy ${hasDummy}, want 4 humans and no dummy`);
      check(rates.every((r) => Math.abs(r - 20) < 2), `basic: snapshot rates ${rates.map(r2)}, want ~20/s`);
      check(kbps.every((k) => k < 40), `basic: download ${kbps.map(r2)} KB/s, budget 40`);
      check(bots.every((b) => b.badSnapshots === 0), 'basic: some snapshots failed to decode');
      check(fired > 10, `basic: only ${fired} bullets fired`);
      check(damage > 0, 'basic: bots never hit anyone (aiming or hit sync broken?)');
      check(same, 'basic: bots saw different game events');
      for (const b of bots) b.close();
      await sleep(300);
      check(srv.rooms.size === 0, `basic: ${srv.rooms.size} room(s) still open after everyone left`);
    });
  },

  // Filler bots: a lone player gets 3 bots; each person who joins replaces one; when people leave, bots come back;
  // the room closes when the last person leaves (bots don't keep it open).
  async fill() {
    await withServer('fill', async (srv) => {
      const count = (b: Bot) => `${b.roster.filter((r) => !r.bot).length}+${b.roster.filter((r) => r.bot).length}`;
      const a = new Bot('solo');
      await a.connect(srv.port);
      await a.waitWelcome();
      await sleep(200);
      const alone = count(a);
      const b = new Bot('friend');
      await b.connect(srv.port);
      await b.waitWelcome();
      await sleep(200);
      const two = count(a);
      b.close();
      await sleep(300);
      const back = count(a);
      a.close();
      await sleep(300);
      console.log(`fill:      people+bots alone ${alone} -> two people ${two} -> one left ${back} -> rooms open ${srv.rooms.size}`);
      check(alone === '1+3', `fill: alone the room had ${alone} (want 1 person + 3 bots)`);
      check(two === '2+2', `fill: with two people the room had ${two} (want 2+2)`);
      check(back === '1+3', `fill: after one left the room had ${back} (want 1+3)`);
      check(srv.rooms.size === 0, 'fill: room not closed when the last person left');
    });
  },

  // Short matches (6 s, 2 s results), Backyard -> Test Lab: 2 people + 2 bots fight through two match changes.
  // Both people must hear the same match story, get the new arena, and keep receiving good snapshots.
  async match_cycle() {
    await withServer(
      'match_cycle',
      async (srv) => {
        const mark = entries.length;
        const bots = [new Bot('mia'), new Bot('neo')];
        for (const b of bots) {
          await b.connect(srv.port);
          await b.waitWelcome();
        }
        await Promise.all(bots.map((b) => b.fight(17500)));
        const log = since(mark);
        const ends = log.filter((e) => e.ev === 'match_end');
        const starts = log.filter((e) => e.ev === 'match_start');
        const botShots = log.filter((e) => e.ev === 'bot_fire').length;
        const tooSoon = log.filter((e) => e.ev === 'fire_too_soon' && String(e.owner).startsWith('b'));
        const same = bots.every((b) => JSON.stringify(b.matchLog) === JSON.stringify(bots[0].matchLog));
        const slotsKept = bots.every((b) => b.lastSnapshot?.players.some((p) => p.slot === b.slot));
        console.log(
          `match_cycle: matches started ${starts.map((e) => `${e.arena}/${e.size}`).join(' -> ')}, ended ${ends.map((e) => e.reason).join(',')}, ` +
            `people heard [${bots[0].matchLog.join(' | ')}], same for both ${same}, still in snapshots with own slot ${slotsKept}, ` +
            `server bot shots ${botShots}, bot shots too soon ${tooSoon.length}, bad snapshots ${bots.reduce((n, b) => n + b.badSnapshots, 0)}`,
        );
        check(starts.length >= 3 && starts[1]?.arena === TEST_LAB.id && starts[2]?.arena === BACKYARD.id, 'match_cycle: matches did not follow the rotation');
        check(ends.length >= 2, `match_cycle: only ${ends.length} matches ended`);
        check(same, 'match_cycle: the two people heard different match/arena messages');
        check(bots[0].matchLog.some((l) => l.startsWith(`arena`) && l.includes(TEST_LAB.id)), 'match_cycle: nobody got the Test Lab arena message');
        check(slotsKept, 'match_cycle: a person lost their slot in the new match');
        check(botShots > 3, `match_cycle: server bots fired only ${botShots} times`);
        check(tooSoon.length === 0, `match_cycle: ${tooSoon.length} bot shots came before their reload`);
        check(bots.every((b) => b.badSnapshots === 0), 'match_cycle: bad snapshots');
        for (const b of bots) b.close();
        await sleep(300);
      },
      { rotation: [BACKYARD, TEST_LAB], match: { lengthTicks: 6 * 60, killTarget: 50, resultsTicks: 2 * 60 } },
    );
  },

  // 120 ms lag with 40 ms jitter: the 100 ms buffer must still have something to blend toward almost always.
  // Judged on a perfect clock (`idealArrivals` + `replayBuffer`): the server, the bots and the frame timer share one
  // Node process, so on a busy machine timers run late and the real-clock buffer runs dry for machine reasons.
  // The real-clock number is still printed, next to how long the process stalled, to show the difference.
  async lag() {
    await withServer('lag', async (srv) => {
      const lagMark = entries.length;
      const bots = [new Bot('slow1', { ms: 120, jitter: 40 }), new Bot('slow2', { ms: 120, jitter: 40 })];
      for (const b of bots) await b.connect(srv.port);
      await Promise.all(bots.map((b) => b.waitWelcome()));
      await sleep(500);
      for (const b of bots) b.buffer.resetStats();
      const FRAME_MS = 16;
      const fromMs = performance.now();
      let samples = 0;
      let lastFrame = fromMs;
      const stalls = { count: 0, worstMs: 0 }; // frame timer gaps over 2 frames: the process was busy
      const sampler = setInterval(() => {
        const now = performance.now();
        if (now - lastFrame > 2 * FRAME_MS) stalls.count++;
        stalls.worstMs = Math.max(stalls.worstMs, now - lastFrame);
        lastFrame = now;
        for (const b of bots) b.buffer.sample(now);
        samples++;
      }, FRAME_MS);
      await Promise.all(bots.map((b) => b.fight(8000)));
      clearInterval(sampler);
      const toMs = performance.now();
      const stats = bots.map((b) => b.buffer.resetStats());
      await sleep(600); // replies to the last shots are still on the way
      const realPct = stats.map((s) => (100 * s.underruns) / Math.max(1, samples));
      const ideal = bots.map((b) => replayBuffer(b.idealArrivals(), 1000 / 60, fromMs, toMs));
      const underrunPct = ideal.map((s) => (100 * s.underruns) / Math.max(1, s.frames));
      new Logger('netsim', sink).info('lag_smoothing', {
        idealPct: underrunPct.map(r2),
        idealFrames: ideal[0].frames,
        realPct: realPct.map(r2),
        realFrames: samples,
        expectedFrames: Math.round((toMs - fromMs) / FRAME_MS),
        stalls: stalls.count,
        worstStallMs: Math.round(stalls.worstMs),
      });
      // Shots must go through under lag: every shot answered, and refused only for fair game reasons (dead,
      // arms down, laughing, match over), never because lag bunched shots up (fire_too_soon: the client waits for its
      // own reload; jitter of a few ticks is absorbed by the server's early-shot queue). How many shots happen depends
      // on deaths and machine speed, so no fixed count.
      const sent = bots.reduce((n, b) => n + b.firesSent, 0);
      const replies = bots.flatMap((b) => b.shots);
      const fired = replies.filter((s) => s.arrow !== null).length;
      const refused = replies.filter((s) => s.arrow === null).map((s) => s.reason ?? '?');
      const unfair = refused.filter((r) => !['dead', 'arms_down', 'laughing', 'match_over'].includes(r));
      const queued = since(lagMark).filter((e) => e.ev === 'fire_queued').length;
      console.log(
        `lag:       120±40 ms, smoothing ran dry ${underrunPct.map(r2).join('% ')}% of ${ideal[0].frames} frames (perfect clock); ` +
          `real clock ${realPct.map(r2).join('% ')}% of ${samples} frames (expected ~${Math.round((toMs - fromMs) / FRAME_MS)}), process stalls ${stalls.count} (worst ${Math.round(stalls.worstMs)} ms), ` +
          `worst snapshot gap ${stats.map((s) => Math.round(s.maxGapMs)).join('/')} ms`,
      );
      console.log(`lag:       shots sent ${sent}, answered ${replies.length}, bullets fired ${fired}, refused [${refused.join(' ')}], held a few ticks for the reload ${queued}`);
      check(ideal.every((s) => s.frames > 300), `lag: only ${ideal.map((s) => s.frames)} frames replayed`);
      check(underrunPct.every((p) => p < 1), `lag: smoothing ran dry ${underrunPct.map(r2)}% of frames (perfect clock: the 100 ms buffer is too short for 120±40 ms)`);
      check(sent > 0 && replies.length === sent, `lag: ${replies.length} of ${sent} shots answered`);
      check(fired > 0 && unfair.length === 0, `lag: ${fired} bullets fired; shots refused for lag reasons: [${unfair.join(' ')}]`);
      // Shots under lag land where the client's own preview said (L7: the gun never wobbles, so the aim is exactly the
      // angle sent). slow1 stands still and fires at the floor ahead; it predicts each shot like the browser does.
      const shooter = bots[0];
      const room = srv.rooms.get(shooter.room)!;
      const errs: number[] = [];
      shooter.input(null, 0);
      // (the fight may have killed it: wait for the respawn, then let the new body settle)
      const alive = () => room.world.playerStats(shooter.id).alive;
      for (let t = 0; t < 100 && !alive(); t++) await sleep(50);
      // ...until the body is really still: the client predicts from a snapshot ~RTT old, so a shoulder still settling
      // after the respawn moved the start of the shot (12 cm off at the landing, the one known limit for a moving shooter)
      const torso = () => shooter.lastSnapshot?.players.find((q) => q.slot === shooter.slot)?.parts[1];
      for (let t = 0; t < 30; t++) {
        const a0 = torso();
        await sleep(300);
        const a1 = torso();
        if (a0 && a1 && Math.hypot(a1.x - a0.x, a1.y - a0.y) < 0.003 && Math.abs(a1.a - a0.a) < 0.003) break;
      }
      for (let i = 0; i < 8 && !shooter.closed && alive(); i++) {
        room.world.playerStats(shooter.id).refill(100); // (stay out of arms-down: the arms dropping moves the shoulder)
        await shooter.reloaded();
        const angle = 0.45 + 0.05 * (i % 3); // down into the floor ahead: a fixed target
        const want = shooter.predict(angle);
        const seq = shooter.fire(angle);
        for (let t = 0; t < 60 && !shooter.shots.some((s) => s.seq === seq); t++) await sleep(20);
        const reply = shooter.shots.find((s) => s.seq === seq);
        await sleep(300); // the bullet lands
        const hit = since(lagMark).find((e) => e.ev === 'arrow_hit' && e.id === reply?.arrow);
        if (!want.hit || !hit) continue;
        const p = hit.point as number[];
        errs.push(Math.hypot(p[0] - want.hit.x, p[1] - want.hit.y));
      }
      const worst = errs.length ? Math.max(...errs) : Infinity;
      console.log(`lag:       still shooter under lag: ${errs.length} shots compared, worst preview vs server hit ${r2(worst * 100)} cm`);
      check(errs.length >= 5, `lag: only ${errs.length} still shots compared`);
      check(worst < 0.05, `lag: a shot landed ${r2(worst)} m from where the client's preview said`);
      for (const b of bots) b.close();
    }, { bots: false }); // (no filler bots: they shot and even killed the shooter during the precise phases)
  },

  // Bad behaviour is refused and logged, never trusted. (No filler bots: the arrow count check assumes nobody else shoots.)
  async cheat() {
    await withServer(
      'cheat',
      async (srv) => {
      const mark = entries.length;
      const c = new Bot('cheater');
      await c.connect(srv.port);
      await c.waitWelcome();
      await sleep(100);
      // L3: a hacked client spams fire (10 shots in 0.2 s, ignoring its reload): one bullet, the rest refused by the
      // server's own reload clock (fire_too_soon). Then garbage (a NaN aim, a fire with no number), a flood.
      for (let i = 0; i < 10; i++) {
        c.sendRaw(JSON.stringify({ t: 'fire', seq: 100 + i, angle: 0.5 }));
        await sleep(20);
      }
      await sleep(300);
      const spam = [...c.shots];
      c.sendRaw('{not json');
      c.sendRaw(JSON.stringify({ t: 'input', seq: 999, aim: NaN, crouch: false, jump: false, move: 0 }));
      c.sendRaw(JSON.stringify({ t: 'fire', seq: 1000, angle: 'up' }));
      for (let i = 0; i < 200; i++) c.sendRaw(JSON.stringify({ t: 'ping', c: i }));
      await sleep(400);
      const wrong = new Bot('old');
      await wrong.connect(srv.port, 0);
      await sleep(300);
      const log = entries.slice(mark);
      const bad = log.filter((e) => e.ev === 'bad_message').length;
      const limited = log.some((e) => e.ev === 'rate_limited');
      const fires = log.filter((e) => e.ev === 'fire' && e.owner === c.id).length;
      const tooSoon = spam.filter((s) => s.reason === 'fire_too_soon').length;
      console.log(
        `cheat:     fire spam (10 in 0.2 s) -> ${fires} bullet, ${tooSoon} refused fire_too_soon, other replies [${spam.filter((s) => s.arrow === null && s.reason !== 'fire_too_soon').map((s) => s.reason)}]; ` +
          `bad messages logged ${bad}, shot replies after the garbage ${c.shots.length - spam.length}, rate limited ${limited}, old client refused: ${wrong.errors[0] ?? 'no'}`,
      );
      check(fires === 1 && tooSoon === 9, `cheat: fire spam gave ${fires} bullets and ${tooSoon} fire_too_soon refusals (want 1 and 9)`);
      check(log.every((e) => e.ev !== 'shots_too_close'), 'cheat: two shots closer than the reload');
      check(bad >= 1, 'cheat: malformed messages were not logged');
      check(c.shots.length === spam.length, `cheat: a malformed fire was answered (${c.shots.length - spam.length} extra replies; it must be dropped)`);
      check(limited, 'cheat: message flood was not rate limited');
      check((wrong.errors[0] ?? '').startsWith('protocol_mismatch'), 'cheat: wrong protocol version was not refused');
      check(!srv.rooms.size || [...srv.rooms.values()].every((r) => r.world.arrows.length <= 1), 'cheat: extra bullets were created');
      c.close();
      },
      { bots: false },
    );
  },

  // A 9th player goes to a second room.
  // Find-and-join like the join screen: list rooms over HTTP, make a new room, a friend joins it by id from the list.
  async rooms() {
    await withServer('rooms', async (srv) => {
      const list = async () => (await (await fetch(`http://127.0.0.1:${srv.port}/rooms`)).json()) as RoomList;
      const empty = await list();
      const host = new Bot('host');
      await host.connect(srv.port, NET.protocolVersion, 'new');
      await host.waitWelcome();
      const other = new Bot('other');
      await other.connect(srv.port, NET.protocolVersion, 'new'); // a second, separate room
      await other.waitWelcome();
      const seen = await list();
      const hostRoom = seen.rooms.find((r) => r.players.includes('host'));
      const friend = new Bot('friend');
      await friend.connect(srv.port, NET.protocolVersion, hostRoom?.id);
      await friend.waitWelcome();
      await sleep(200);
      const after = await list();
      const botsWithTwo = friend.roster.filter((r) => r.bot).length;
      const lost = new Bot('lost');
      await lost.connect(srv.port, NET.protocolVersion, 'r999');
      await sleep(300);
      // fill the host's room and try one more
      const fillers: Bot[] = [];
      for (let i = 0; i < NET.maxPlayers - 2; i++) {
        const b = new Bot(`f${i}`);
        await b.connect(srv.port, NET.protocolVersion, hostRoom?.id);
        await b.waitWelcome();
        fillers.push(b);
      }
      const late = new Bot('late');
      await late.connect(srv.port, NET.protocolVersion, hostRoom?.id);
      await sleep(300);
      const bad = new Bot('bad');
      await bad.connect(srv.port, NET.protocolVersion, '../etc');
      await sleep(300);
      const friendRoom = after.rooms.find((r) => r.id === hostRoom?.id);
      console.log(
        `rooms:     empty list ${empty.rooms.length} rooms, lan urls [${empty.lanUrls.join(', ')}] -> after 2 "new": ${seen.rooms.length} rooms; ` +
          `friend joined ${friend.room} (host in ${host.room}), room now [${friendRoom?.players.join(', ')}], bots with two people ${botsWithTwo}, with 8 people ${friend.roster.filter((r) => r.bot).length}; ` +
          `unknown room -> ${lost.errors[0]}, 9th into full room -> ${late.errors[0]}, bad id -> ${bad.errors[0]}`,
      );
      check(empty.rooms.length === 0, 'rooms: list not empty at start');
      check(seen.rooms.length === 2 && host.room !== other.room, 'rooms: "new" did not make separate rooms');
      check(!!hostRoom && friend.room === host.room, "rooms: friend didn't land in the host's room");
      check(friendRoom?.players.join(',') === 'host,friend', `rooms: host's room lists [${friendRoom?.players}]`);
      check(botsWithTwo === 2, `rooms: with two people the room had ${botsWithTwo} filler bots (want 2)`);
      check(friend.roster.filter((r) => r.bot).length === 0, 'rooms: a full room still has filler bots');
      check(lost.errors[0] === 'room_not_found', `rooms: unknown room gave ${lost.errors[0]}`);
      check(late.errors[0] === 'room_full', `rooms: full room gave ${late.errors[0]}`);
      check(bad.errors[0] === 'expected_join', `rooms: bad room id gave ${bad.errors[0]}`);
      for (const b of [host, other, friend, ...fillers]) b.close();
      await sleep(300);
    });
  },

  // S1: 6 players in the Test Lab (bigger than one screen). Everyone gets the same arena; positions past the old
  // 32 m arena arrive intact; the server builds the arena without problems.
  // L6: every arena in the rotation, each on its own server: a new arena is checked over the network for free.
  async arena() {
    for (const def of ROTATION) await arenaCheck(def);
  },

  // S5: shoot the bubble -> everyone sees you hold its arrow; fire it -> everyone sees the oil puddle; a player who
  // joins later sees the puddle too; a client that claims a special arrow in its fire message gets a normal one.
  async pickups() {
    await withServer(
      'pickups',
      async (srv) => {
        const mark = entries.length;
        const a = new Bot('ace');
        const b = new Bot('bea');
        for (const x of [a, b]) {
          await x.connect(srv.port);
          await x.waitWelcome();
        }
        await sleep(400);
        const room = [...srv.rooms.values()][0];
        const bubble = room.world.specials.bubbles[0];
        let held: string | null = null;
        const picked = () => a.events.some((e) => e.ev.type === 'pickup' && e.ev.by === a.id);
        for (let i = 0; i < 4 && !picked(); i++) {
          await a.shootAt({ x: bubble.home.x, y: bubble.home.y + 0.1 });
          for (let t = 0; t < 1500 && !picked(); t += 50) await sleep(50); // the arrow takes a moment to get there
        }
        await sleep(200); // a snapshot after the pickup
        held = a.lastSnapshot?.players.find((p) => p.slot === a.slot)?.held ?? null;
        const seenByB = b.lastSnapshot?.players.find((p) => p.slot === a.slot)?.held ?? null;
        const pickupEvents = [a, b].map((x) => x.events.filter((e) => e.ev.type === 'pickup').length);
        // fire it at b
        const bTorso = b.lastSnapshot?.players.find((p) => p.slot === b.slot)?.parts[1];
        if (bTorso) await a.shootAt(bTorso);
        await sleep(300);
        const puddles = (x: Bot) => x.lastSnapshot?.props.filter((p) => p.type === 'puddle').length ?? 0;
        const late = new Bot('late');
        await late.connect(srv.port);
        await late.waitWelcome();
        await sleep(400);
        // a cheater claims a glove in the fire message: the server ignores it
        const claimMark = entries.length;
        const bt = b.lastSnapshot?.players.find((p) => p.slot === a.slot)?.parts[1];
        if (bt) await b.shootAt(bt, { special: 'glove', kind: 'glove' });
        const claimed = since(claimMark).filter((e) => e.ev === 'fire' && e.owner === b.id);
        console.log(
          `pickups:   bubble shot -> ace holds ${held} (bea sees ${seenByB}), pickup events ${pickupEvents.join('/')}, ` +
            `puddles seen ace/bea/late-joiner ${puddles(a)}/${puddles(b)}/${puddles(late)}, cheater's arrow kinds [${claimed.map((e) => e.kind ?? 'normal')}], ` +
            `oil spawned ${since(mark).filter((e) => e.ev === 'oil_spawn').length}`,
        );
        check(held === 'oil' && seenByB === 'oil', `pickups: the bubble's arrow did not show as held (${held}/${seenByB})`);
        check(pickupEvents.every((n) => n === 1), 'pickups: not everyone got the pickup event');
        check(puddles(a) === 1 && puddles(b) === 1 && puddles(late) === 1, 'pickups: the puddle was not seen by everyone (incl. the late joiner)');
        check(claimed.length > 0 && claimed.every((e) => e.kind === undefined), 'pickups: a client claimed a special arrow it did not hold');
        for (const x of [a, b, late]) x.close();
        await sleep(300);
      },
      { rotation: [BACKYARD], pickupOrder: ['oil'], bots: false },
    );
  },

  // S6: 6 players in the full Test Lab (the 2nd match: the 1st is sized before anyone joins). One shoots the wrecking
  // ball; every player sees the same ball and seesaw at the same ticks; nobody gets stuck in a hazard.
  async hazards() {
    await withServer(
      'hazards',
      async (srv) => {
        const bots = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((n) => new Bot(n));
        for (const b of bots) {
          await b.connect(srv.port);
          await b.waitWelcome();
        }
        for (let t = 0; t < 8000 && bots[0].arena?.size !== 'full'; t += 100) await sleep(100);
        const mark = entries.length;
        const [a] = bots;
        await a.waitNewWorld();
        const ballIndex = () => a.bodyLabels.indexOf('wreck_r');
        const ballPose = () => a.lastSnapshot?.bodies.find((b) => b.index === ballIndex())?.pose;
        const start = ballPose();
        const shot = start ? await a.shootAt({ x: start.x, y: start.y }) : false;
        await Promise.all(bots.slice(1).map((b) => b.fight(5000)));
        // same tick, same poses for the moving hazards, on every player
        const watch = ['wreck_r', 'seesaw_l'];
        let compared = 0;
        let differ = 0;
        for (const [tick, snap] of a.snapsByTick) {
          for (const other of bots.slice(1)) {
            const o = other.snapsByTick.get(tick);
            if (!o) continue;
            for (const label of watch) {
              const pa = snap.bodies.find((b) => b.index === a.bodyLabels.indexOf(label))?.pose;
              const pb = o.bodies.find((b) => b.index === other.bodyLabels.indexOf(label))?.pose;
              if (!pa || !pb) continue;
              compared++;
              if (pa.x !== pb.x || pa.y !== pb.y || pa.a !== pb.a) differ++;
            }
          }
        }
        const log = since(mark);
        // the biggest swing seen (a pendulum can be back at rest by the end)
        let moved = 0;
        for (const snap of a.snapsByTick.values()) {
          const p = snap.bodies.find((b) => b.index === ballIndex())?.pose;
          if (p && start) moved = Math.max(moved, Math.hypot(p.x - start.x, p.y - start.y));
        }
        const trouble = log.filter((e) => ['stuck_in_hazard', 'bot_stuck'].includes(String(e.ev)));
        console.log(
          `hazards:   arena ${a.arena?.id}/${a.arena?.size} with ${a.arena?.hazards.length} hazards, ball shot ${log.some((e) => e.ev === 'hazard_shot')}, ball moved ${r2(moved)} m, ` +
            `hazard hits ${log.filter((e) => e.ev === 'hazard_hit').length}, poses compared ${compared}, different ${differ}, stuck ${trouble.length}`,
        );
        check(a.arena?.size === 'full' && a.arena.hazards.length === 6, 'hazards: not in the full Test Lab with its 6 hazards');
        check(compared > 50 && differ === 0, `hazards: players saw different hazard positions (${differ} of ${compared})`);
        check(trouble.length === 0, `hazards: ${trouble[0]?.ev} ${trouble[0]?.who ?? ''}`);
        check(!!start && shot, `hazards: no shot at the wrecking ball (ball found ${!!start}, see shoot_skipped)`);
        check(moved > 0.5, `hazards: the shot wrecking ball only moved ${r2(moved)} m`);
        for (const b of bots) b.close();
        await sleep(300);
      },
      { rotation: [TEST_LAB], match: { lengthTicks: 240, killTarget: 99, resultsTicks: 60 }, bots: false },
    );
  },

  // S7: chaos rounds over real sockets: two players hear the same round with the same start/end ticks; someone who
  // joins during a round gets it in their welcome.
  // L4: body damage seen the same by everyone: a player is shot down step by step on the server; every client's
  // snapshots show the same lost parts and leg stage at the same ticks, a late joiner sees the current stumps, and
  // after respawning all of it is gone everywhere.
  async damage() {
    await withServer(
      'damage',
      async (srv) => {
        const [a, b] = [new Bot('ana'), new Bot('bea')];
        for (const x of [a, b]) await x.connect(srv.port);
        await Promise.all([a, b].map((x) => x.waitWelcome()));
        await sleep(400);
        const room = srv.rooms.get(a.room)!;
        const w = room.world;
        const mark = entries.length;
        for (const [part, n] of [['legFrontLower', 3]] as const) {
          for (let i = 0; i < n; i++) {
            w.bodyHit(a.id, part, 1, 'netsim');
            await sleep(700); // trips settle
          }
        }
        // bullet holes in ana (as bullets leave them): the late joiner must get them in its welcome
        for (const [part, x, y] of [['torso', 0.05, 0.1], ['head', 0.1, 0], ['legFrontUpper', 0, -0.1]] as const) w.damage.get(a.id)!.addHole({ part, x, y });
        await sleep(400);
        const late = new Bot('late');
        await late.connect(srv.port, NET.protocolVersion, a.room);
        await late.waitWelcome();
        await sleep(500);
        const seen = (x: Bot) => {
          const p = x.lastSnapshot?.players.find((q) => q.slot === a.slot);
          return p ? `${p.legStage}:${p.lost}` : 'none';
        };
        // the same tick in both players' snapshots: identical damage bits
        const ticks = [...a.snapsByTick.keys()].filter((t) => b.snapsByTick.has(t)).slice(-60);
        const differ = ticks.filter((t) => {
          const pa = a.snapsByTick.get(t)!.players.find((q) => q.slot === a.slot);
          const pb = b.snapsByTick.get(t)!.players.find((q) => q.slot === a.slot);
          return !pa || !pb || pa.lost !== pb.lost || pa.legStage !== pb.legStage || pa.dents !== pb.dents;
        }).length;
        const lateHoles = late.welcomeHoles.find((h) => h.id === a.id)?.holes.length ?? 0;
        const want = `3:${1 << PART_NAMES.indexOf('legFrontLower')}`;
        const before = [seen(a), seen(b), seen(late)];
        w.hurt(a.id, b.id, 1000, w.player(a.id).center());
        await sleep(3800); // respawn
        const after = [seen(a), seen(b), seen(late)];
        const stageLogs = since(mark).filter((e) => e.ev === 'damage_stage' && e.who === a.id).map((e) => `${e.area}${e.stage}`);
        console.log(`damage:    stages on the server [${stageLogs.join(' ')}]; ana/bea/late joiner see ${before.join(' / ')} (want ${want}), same bits at the same ticks ${ticks.length - differ}/${ticks.length}, late joiner got ${lateHoles} of ana's 3 holes; after respawn ${after.join(' / ')}`);
        check(before.every((s) => s === want), `damage: the clients don't all see the stump (${before.join(' / ')}, want ${want})`);
        check(lateHoles === 3, `damage: the late joiner's welcome had ${lateHoles} of ana's 3 bullet holes`);
        check(ticks.length > 20 && differ === 0, `damage: ${differ} of ${ticks.length} ticks showed different damage to the two players`);
        check(after.every((s) => s === '0:0'), `damage: after respawning the damage is still shown (${after.join(' / ')})`);
        for (const x of [a, b, late]) x.close();
      },
      { bots: false },
    );
  },

  // L5: a critical hit knocks ana's gun away (forced on the server); ana swings at bea (the same fire message): the
  // server swings, both players see the same weapon, broken limbs and dropped gun at the same ticks, the 3rd hit
  // shatters bea for everyone, and a late joiner sees the bat and the gun on the floor from its first snapshot.
  async melee() {
    await withServer(
      'melee',
      async (srv) => {
        const [a, b] = [new Bot('ana'), new Bot('bea')];
        for (const x of [a, b]) await x.connect(srv.port);
        await Promise.all([a, b].map((x) => x.waitWelcome()));
        await sleep(400);
        const w = srv.rooms.get(a.room)!.world;
        const mark = entries.length;
        w.melee.roll = () => 0;
        for (const part of w.player(a.id).attached()) w.push(part, { x: 0, y: -6 * part.mass() });
        await sleep(80);
        w.melee.onBulletHit(a.id, b.id);
        w.melee.roll = () => 0.9;
        const weapon = w.damage.get(a.id)!.weapon;
        await sleep(1200);
        const late = new Bot('late');
        await late.connect(srv.port, NET.protocolVersion, a.room);
        await late.waitWelcome();
        await sleep(400);
        const lateSees = late.lastSnapshot?.players.find((p) => p.slot === a.slot)?.weapon;
        const lateGun = late.lastSnapshot?.props.some((p) => p.type === 'gun' && p.a === a.slot) ?? false;
        const swingSeqs: number[] = [];
        for (let i = 0; i < 6 && w.playerStats(b.id).alive; i++) {
          const feet = w.feetOf(a.id);
          w.relocate(b.id, { x: feet.x + 1.2 * w.player(a.id).facing, y: feet.y }, (-w.player(a.id).facing) as 1 | -1);
          await sleep(600);
          await a.reloaded();
          const s = w.player(a.id).jointPos('shoulderFront');
          const t = w.player(b.id).center();
          swingSeqs.push(a.fire(Math.atan2(t.y - s.y, t.x - s.x)));
          await sleep(500);
        }
        await sleep(400);
        const replies = a.shots.filter((x) => swingSeqs.includes(x.seq));
        const hits = since(mark).filter((e) => e.ev === 'melee_hit').length;
        const shattered = (x: Bot) => x.events.some((e) => e.ev.type === 'death' && e.ev.id === b.id && e.ev.cause === 'shattered');
        // the same tick in everyone's snapshots: the same weapon, broken limbs and dropped gun
        const ticks = [...a.snapsByTick.keys()].filter((t) => b.snapsByTick.has(t) && late.snapsByTick.has(t)).slice(-90);
        const view = (x: Bot, t: number) => {
          const s = x.snapsByTick.get(t)!;
          const pa = s.players.find((q) => q.slot === a.slot);
          const pb = s.players.find((q) => q.slot === b.slot);
          return `${pa?.weapon}|${pb?.broken}|${pb?.lost}|${s.props.filter((p) => p.type === 'gun').length}`;
        };
        const differ = ticks.filter((t) => view(a, t) !== view(b, t) || view(a, t) !== view(late, t)).length;
        console.log(
          `melee:     ana got a ${weapon}; ${swingSeqs.length} swings -> replies ${replies.map((r) => (r.swing ? 'swing' : (r.reason ?? 'arrow'))).join(',')}, server hits ${hits}, shattered seen by ana/bea/late ${[a, b, late].map(shattered).join('/')}; ` +
            `late joiner sees ${lateSees} + dropped gun ${lateGun}; same state at the same ticks ${ticks.length - differ}/${ticks.length}`,
        );
        check(weapon !== 'gun', 'melee: the crit did not take the gun');
        check(replies.length === swingSeqs.length && replies.every((r) => r.swing && r.arrow === null), 'melee: a swing was not answered as a swing');
        check(hits >= 3 && [a, b, late].every(shattered), `melee: bea was not shattered for everyone (${hits} hits)`);
        check(lateSees === weapon && lateGun, `melee: the late joiner saw ${lateSees}, dropped gun ${lateGun}`);
        check(ticks.length > 20 && differ === 0, `melee: ${differ} of ${ticks.length} ticks showed different melee state to the players`);
        for (const x of [a, b, late]) x.close();
      },
      { bots: false },
    );
  },

  async chaos() {
    await withServer(
      'chaos',
      async (srv) => {
        const a = new Bot('ca');
        const b = new Bot('cb');
        for (const x of [a, b]) {
          await x.connect(srv.port);
          await x.waitWelcome();
        }
        const room = [...srv.rooms.values()][0];
        for (let t = 0; t < 12000 && !room.world.modifier; t += 50) await sleep(50);
        await sleep(200);
        const late = new Bot('late');
        await late.connect(srv.port);
        await late.waitWelcome();
        const lateSees = late.match?.modifier ? `${late.match.modifier.kind}@${late.match.modifier.start}-${late.match.modifier.end}` : null;
        await sleep(300);
        console.log(`chaos:     heard ${a.modifiersHeard.join(',')} / ${b.modifiersHeard.join(',')}, server round on: ${room.world.modifier}, late joiner's welcome: ${lateSees}`);
        check(a.modifiersHeard.length > 0 && a.modifiersHeard.join() === b.modifiersHeard.join(), 'chaos: the two players heard different rounds');
        check(!!lateSees && lateSees === a.modifiersHeard.at(-1), 'chaos: a late joiner did not get the round that is on');
        for (const x of [a, b, late]) x.close();
        await sleep(300);
      },
      { rotation: [BACKYARD], match: { lengthTicks: 30 * 60, killTarget: 99, resultsTicks: 120, modifierEveryTicks: 6 * 60, modifierTicks: 4 * 60 }, bots: false },
    );
  },

  async full() {
    await withServer('full', async (srv) => {
      const bots = Array.from({ length: NET.maxPlayers + 1 }, (_, i) => new Bot(`b${i}`));
      for (const b of bots) {
        await b.connect(srv.port);
        await b.waitWelcome();
      }
      const rooms = new Set(bots.map((b) => b.room));
      console.log(`full:      ${bots.length} players -> rooms ${[...rooms].join(', ')} (sizes ${[...srv.rooms.values()].map((r) => r.humans).join('/')})`);
      check(rooms.size === 2 && [...srv.rooms.values()].some((r) => r.humans === NET.maxPlayers), 'full: rooms were not filled up to the limit');
      for (const b of bots) b.close();
      await sleep(300);
    });
  },
};

for (const [name, fn] of Object.entries(scenarios)) if (!only.length || only.includes(name)) await fn();

const bad = entries.filter((e) => e.lvl === 'error' || (e.lvl === 'warn' && !['slow_step', 'rate_limited', 'bad_message', 'invalid_controls'].includes(e.ev)));
for (const e of bad) problems.push(`${e.lvl} ${e.ev} ${JSON.stringify(e).slice(0, 200)}`);
console.log(`\nlog: ${file.file}`);
console.log(`events: ${entries.length}, problems: ${problems.length}`);
for (const p of problems.slice(0, 30)) console.log('  PROBLEM ' + p);
process.exit(problems.length ? 1 : 0);
