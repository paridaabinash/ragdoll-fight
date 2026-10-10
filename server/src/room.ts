import {
  arenaInfo as describeArena,
  BACKYARD,
  BOT,
  BotBrain,
  botsWanted,
  DEFAULT_ROOM_SETTINGS,
  captureSnapshot,
  GAME_SPEED,
  TICK_SECONDS,
  encodeSnapshot,
  Logger,
  GUN,
  Match,
  MATCH,
  NET,
  NO_CONTROLS,
  parseClientMessage,
  PART_NAMES,
  r2,
  r3,
  type ArenaDef,
  type BotAction,
  type ClientMessage,
  type Controls,
  type GameWorld,
  type LogSink,
  type MatchSettings,
  type MovableBody,
  type PlayerHoles,
  type RoomInfo,
  type RoomSettings,
  type RosterEntry,
  type HatKind,
  type ServerMessage,
  type SpecialKind,
} from '@ragdoll/shared';

/** One open connection, as the room sees it. Real sockets in the server, fakes in tests. */
export interface Conn {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued but not yet sent (WebSocket.bufferedAmount); a slow client's snapshots are skipped while it's high. */
  readonly bufferedAmount: number;
}

interface Client {
  conn: Conn;
  id: string;
  name: string;
  hat: HatKind;
  controls: Controls;
  /** A jump press seen since the last tick (a tap can start and end between two ticks). */
  pendingJump: boolean;
  /**
   * L3: a shot that arrived a little before the reload was done (network jitter bunched it up): fired on the reload
   * tick instead of refused. `tick`: when it arrived (its swing tick is checked against that).
   */
  queued: { seq: number; angle: number; tick: number } | null;
  lastSeq: number;
  windowStart: number;
  windowMsgs: number;
  stats: { bytesOut: number; msgsIn: number; dropped: number; skipped: number; since: number };
}

/** A filler bot: a brain, plus the same bookkeeping as a human client (its messages go through the same checks). */
interface Bot {
  client: Client;
  brain: BotBrain;
  seq: number;
}

const BACKPRESSURE_BYTES = 256 * 1024;
/** Bots never send anything; their "connection" goes nowhere. */
const NO_CONN: Conn = { send() {}, close() {}, bufferedAmount: 0 };

export interface RoomOptions {
  /** The arenas this room can play, in rotation order (default: the Backyard only). */
  rotation?: ArenaDef[];
  /** Match timing (tests, sims, MATCH_SECONDS); default: the settings' minutes. */
  match?: MatchSettings;
  /** M1: what the room plays (default: free-for-all through `rotation` in order, as before M1). */
  settings?: RoomSettings;
  /** Seed for random arena picks and votes (default 1: repeatable). */
  seed?: number;
  /** Filler bots on/off (default on; the settings can turn them off too). */
  bots?: boolean;
  /** Power-up bubbles hold these special arrows in this order (tests/netsim); default random. */
  pickupOrder?: SpecialKind[];
  /** Added to every bot brain's seed (sims: a different but repeatable fight). Default 0. */
  botSeed?: number;
}

/**
 * One room: matches (a GameWorld each) run at a fixed 60 steps/s, the people connected to it, and filler bots.
 * The room is the only thing that turns network messages into game actions, and it checks all of them
 * (bots' too: their brains produce the same messages a browser sends).
 */
export class GameRoom {
  readonly log: Logger;
  readonly match: Match;
  private movables: MovableBody[];
  private readonly clients = new Map<string, Client>();
  private readonly bots = new Map<string, Bot>();
  private readonly botsOn: boolean;
  /** M1: what this room plays (fixed for its life). */
  readonly settings: RoomSettings;
  private nextPlayer = 1;
  private nextBot = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLoopMs = 0;
  private stepAcc = 0;
  private stepMs = { total: 0, worst: 0, steps: 0, bots: 0, world: 0, net: 0 };
  closed = false;
  private readonly pickupOrder: SpecialKind[] | null;
  private readonly botSeed: number;

  constructor(
    readonly id: string,
    sink: LogSink,
    private readonly onEmpty: (room: GameRoom) => void,
    opts: RoomOptions = {},
  ) {
    this.log = new Logger(`room:${id}`, sink);
    this.settings = opts.settings ?? { ...DEFAULT_ROOM_SETTINGS, arenas: 'rotation' };
    this.botsOn = (opts.bots ?? true) && this.settings.bots !== 'off';
    const timing: MatchSettings = opts.match ?? { lengthTicks: this.settings.minutes * 60 * 60, resultsTicks: MATCH.resultsTicks };
    // The first arena is sized for a filled room (people arrive one by one after it's built).
    this.match = new Match(this.log, opts.rotation ?? [BACKYARD], this.botsOn ? this.fillTo : 1, timing, {
      mode: this.settings.mode,
      arenas: this.settings.arenas,
      first: this.settings.arena,
      seed: opts.seed ?? 1,
    });
    this.pickupOrder = opts.pickupOrder ?? null;
    this.botSeed = opts.botSeed ?? 0;
    if (this.pickupOrder) this.world.specials.setOrder(this.pickupOrder);
    this.movables = this.world.movableBodies();
    this.log.info('room_open', { room: id, arena: this.match.info.arena, size: this.match.info.size, rotation: (opts.rotation ?? [BACKYARD]).map((a) => a.id), settings: this.settings });
  }

  /** Bots fill the room up to this many players (fewer in a small room). */
  private get fillTo(): number {
    return Math.min(BOT.fillTo, this.settings.maxPlayers);
  }

  /** M1: this room in the room list. */
  info(): RoomInfo {
    const m = this.match.info;
    const top = this.match.scores()[0];
    const leaderName = top && top.score > 0 ? this.everyone().find((c) => c.id === top.id)?.name : undefined;
    const until = m.phase === 'results' ? (m.resultsUntil ?? this.world.tick) : m.endTick;
    return {
      id: this.id,
      players: this.playerNames(),
      bots: this.bots.size,
      max: this.settings.maxPlayers,
      mode: this.settings.mode,
      arena: m.arena,
      arenaName: m.arenaName,
      phase: m.phase,
      secondsLeft: Math.max(0, Math.ceil((until - this.world.tick) / 60)),
      leader: leaderName ? { name: leaderName, score: top.score } : null,
    };
  }

  /** The current match's world (a new one each match). */
  get world(): GameWorld {
    return this.match.world;
  }

  get humans(): number {
    return this.clients.size;
  }

  get botCount(): number {
    return this.bots.size;
  }

  /** Names of the people in the room (for the room list; bots not included). */
  playerNames(): string[] {
    return [...this.clients.values()].map((c) => c.name);
  }

  get full(): boolean {
    return this.clients.size >= this.settings.maxPlayers;
  }

  /** Starts the real-time loop. Tests call `tick()` directly instead. */
  start(): void {
    this.lastLoopMs = performance.now();
    this.timer = setInterval(() => this.loop(), 1000 / 60);
  }

  join(conn: Conn, rawName: string, hat: HatKind = 'none'): string {
    const id = `p${this.nextPlayer++}`;
    const client = this.newClient(conn, id, this.uniqueName(rawName));
    client.hat = hat;
    this.match.join(id);
    this.clients.set(id, client);
    this.log.info('join', { room: this.id, id, name: client.name, humans: this.humans });
    this.sendTo(client, {
      t: 'welcome',
      you: id,
      slot: this.world.slotOf(id),
      room: this.id,
      settings: this.settings,
      tick: this.world.tick,
      arena: this.arenaInfo(),
      match: this.match.info,
      statics: this.world.staticShapes(),
      bodies: this.bodyInfo(),
      holes: this.holes(),
      wallHoles: [...this.world.wallHoles],
      hatsOff: [...this.world.damage].filter(([, d]) => d.hatOff).map(([pid]) => pid),
      gameSpeed: GAME_SPEED,
    });
    this.fillBots();
    this.broadcastRoster();
    return id;
  }

  leave(id: string, reason: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    this.match.leave(id);
    this.log.info('leave', { room: this.id, id, name: client.name, reason, humans: this.humans });
    if (this.humans === 0) {
      this.close();
      return;
    }
    this.fillBots();
    this.broadcastRoster();
  }

  /** A text message from a client. Malformed, out-of-order or too-frequent messages are dropped and logged. */
  handleText(id: string, text: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    client.stats.msgsIn++;
    if (this.world.tick - client.windowStart >= 60) {
      client.windowStart = this.world.tick;
      client.windowMsgs = 0;
    }
    if (++client.windowMsgs > NET.maxMessagesPerSec) {
      client.stats.dropped++;
      this.world.anomaly('rate_limited', id, { msgsThisSecond: client.windowMsgs });
      return;
    }
    const msg = parseClientMessage(text);
    if ('error' in msg) {
      client.stats.dropped++;
      this.world.anomaly('bad_message', id, { error: msg.error, sample: text.slice(0, 80) });
      return;
    }
    this.apply(client, msg);
  }

  /** One fixed physics step, plus everything the clients need to hear about it. */
  tick(): void {
    const started = performance.now();
    for (const bot of this.bots.values()) for (const action of bot.brain.think(this.world)) this.botSends(bot, action);
    const botsDone = performance.now();
    for (const c of this.everyone()) {
      this.world.setControls(c.id, { ...c.controls, jump: c.controls.jump || c.pendingJump });
      c.pendingJump = false;
    }
    const change = this.match.step();
    const worldDone = performance.now();
    if (change === 'new_world') this.onNewWorld();
    // Shots that arrived a few ticks early go out the moment the reload is done (between ticks, like a message
    // arriving), so the bullet is in this tick's snapshot.
    for (const c of this.everyone()) if (c.queued && this.world.playerStats(c.id).reloadLeft(this.world.tick) === 0) this.shootQueued(c);
    if (change) this.broadcast({ t: 'match', tick: change === 'new_world' ? this.match.info.startTick : this.world.tick, match: this.match.info });
    const events = this.world.takeEvents();
    if (events.length) this.broadcast({ t: 'events', tick: this.world.tick, events });
    if (this.world.tick % NET.snapshotEveryTicks === 0) this.sendSnapshot();
    const done = performance.now();
    const s = this.stepMs;
    s.total += done - started;
    s.bots += botsDone - started;
    s.world += worldDone - botsDone;
    s.net += done - worldDone;
    s.steps++;
    s.worst = Math.max(s.worst, done - started);
    if (this.world.tick % NET.statsEveryTicks === 0) this.logStats();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients.values()) c.conn.close(1001, 'room closed');
    this.clients.clear();
    this.bots.clear();
    this.match.dispose();
    this.log.info('room_closed', { room: this.id });
    this.onEmpty(this);
  }

  // ---- internals ----

  private loop(): void {
    const now = performance.now();
    this.stepAcc += Math.min(now - this.lastLoopMs, 250) / 1000;
    this.lastLoopMs = now;
    let steps = 0;
    // (ticks are paced in real time: TICK_SECONDS; the game speed only changes how much game time a tick covers)
    while (this.stepAcc >= TICK_SECONDS && steps < 5 && !this.closed) {
      this.tick();
      this.stepAcc -= TICK_SECONDS;
      steps++;
    }
    if (this.stepAcc >= TICK_SECONDS) {
      const data = { droppedMs: Math.round(this.stepAcc * 1000) };
      // A new room's first steps are slow while the code warms up (compiles); only later slowness is a problem.
      if (this.world.tick < 60) this.log.info('server_warmup_slow', data);
      else this.world.anomaly('server_behind', this.id, data);
      this.stepAcc = 0;
    }
  }

  /** A new match started in a new world: everyone gets its shapes. Snapshots after `tick` show the new world. */
  private onNewWorld(): void {
    if (this.pickupOrder) this.world.specials.setOrder(this.pickupOrder);
    this.movables = this.world.movableBodies();
    for (const c of this.everyone()) {
      // a shot waiting for the old world's reload doesn't carry over
      if (c.queued) this.sendTo(c, { t: 'shot', seq: c.queued.seq, arrow: null, reason: 'match_over' });
      c.queued = null;
    }
    this.broadcast({ t: 'arena', tick: this.match.info.startTick, arena: this.arenaInfo(), statics: this.world.staticShapes(), bodies: this.bodyInfo() });
    this.broadcastRoster();
  }

  /** L4: everyone's bullet holes this life, for a welcome (later ones come with the damage events). */
  private holes(): PlayerHoles[] {
    const out: PlayerHoles[] = [];
    for (const [id, dmg] of this.world.damage) {
      if (dmg.holes.length) out.push({ id, holes: dmg.holes.map((h) => ({ part: PART_NAMES.indexOf(h.part), x: h.x, y: h.y })) });
    }
    return out;
  }

  private arenaInfo() {
    return describeArena(this.world.arena!);
  }

  private bodyInfo() {
    return this.movables.map((m, index) => ({ index, label: m.label, kind: m.kind, shape: m.shape }));
  }

  private newClient(conn: Conn, id: string, name: string): Client {
    return {
      conn,
      id,
      name,
      hat: 'none',
      controls: NO_CONTROLS,
      pendingJump: false,
      queued: null,
      lastSeq: -1,
      windowStart: this.world.tick,
      windowMsgs: 0,
      stats: { bytesOut: 0, msgsIn: 0, dropped: 0, skipped: 0, since: this.world.tick },
    };
  }

  /** People and bots (bots' "clients" carry the same bookkeeping). */
  private everyone(): Client[] {
    return [...this.clients.values(), ...[...this.bots.values()].map((b) => b.client)];
  }

  /** Adds or removes filler bots so the room has `BOT.fillTo` players while few people are in it. */
  private fillBots(): void {
    if (!this.botsOn) return;
    const want = botsWanted(this.humans, this.fillTo);
    const skill = this.settings.bots === 'off' ? 'normal' : this.settings.bots;
    while (this.bots.size < want) {
      const id = `b${this.nextBot++}`;
      const taken = new Set([...this.clients.values(), ...[...this.bots.values()].map((b) => b.client)].map((c) => c.name));
      const name = BOT.names.find((n) => !taken.has(n)) ?? this.uniqueName('Bot');
      const bot: Bot = { client: this.newClient(NO_CONN, id, name), brain: new BotBrain(id, this.nextBot * 7919 + this.botSeed, skill), seq: 0 };
      this.match.join(id, true);
      this.bots.set(id, bot);
      this.log.info('bot_join', { room: this.id, id, name, humans: this.humans, bots: this.bots.size, skill, team: this.match.teamOf(id) ?? null });
    }
    while (this.bots.size > want) {
      // (M3 Team Battle: a bot from the bigger team leaves, so the teams stay even)
      const counts = this.match.teamCounts();
      const bigger = counts[0] === counts[1] ? undefined : counts[0] > counts[1] ? 0 : 1;
      const ids = [...this.bots.keys()];
      const id = (bigger === undefined ? undefined : ids.reverse().find((b) => this.match.teamOf(b) === bigger)) ?? [...this.bots.keys()].pop()!;
      this.bots.delete(id);
      this.match.leave(id);
      this.log.info('bot_leave', { room: this.id, id, humans: this.humans, bots: this.bots.size });
    }
  }

  /** A bot's action goes through the same message check and handling as a person's. */
  private botSends(bot: Bot, action: BotAction): void {
    const msg = parseClientMessage(JSON.stringify({ ...action, seq: bot.seq++ }));
    if ('error' in msg) {
      this.world.anomaly('bot_bad_message', bot.client.id, { error: msg.error, action }, 'error');
      return;
    }
    this.apply(bot.client, msg);
  }

  private apply(client: Client, msg: ClientMessage): void {
    switch (msg.t) {
      case 'join':
        this.world.anomaly('bad_message', client.id, { error: 'already_joined' });
        return;
      case 'ping':
        this.sendTo(client, { t: 'pong', c: msg.c, tick: this.world.tick });
        return;
      case 'input': {
        if (msg.seq <= client.lastSeq) return; // stale
        client.lastSeq = msg.seq;
        const aim = msg.aim === null ? null : { angle: msg.aim };
        if (msg.jump) client.pendingJump = true;
        client.controls = { aim, crouch: msg.crouch, jump: msg.jump, move: msg.move, taunt: !!msg.taunt };
        return;
      }
      case 'fire':
        this.fire(client, msg.seq, msg.angle);
        return;
      case 'vote': {
        const refused = this.match.vote(client.id, msg.arena);
        if (refused) {
          this.log.info('vote_refused', { id: client.id, arena: msg.arena, reason: refused });
          return;
        }
        // (votes are lasting state: they live in the match info everyone gets)
        this.broadcast({ t: 'match', tick: this.world.tick, match: this.match.info });
        return;
      }
    }
  }

  /**
   * L3: a shot. The world decides (reload by server tick, stamina, alive, match on); the room relays the answer. A shot that arrives at most GUN.earlyGraceTicks before the reload is
   * done is held and fired on the reload tick: two messages sent 0.7 s apart can arrive closer than that.
   */
  private fire(client: Client, seq: number, angle: number): void {
    const st = this.world.playerStats(client.id);
    const left = st.reloadLeft(this.world.tick);
    if (left > 0 && left <= GUN.earlyGraceTicks && st.alive && !this.world.frozen && !client.queued) {
      client.queued = { seq, angle, tick: this.world.tick };
      this.log.info('fire_queued', { id: client.id, seq, earlyBy: left });
      return;
    }
    this.shoot(client, seq, angle);
  }

  private shootQueued(client: Client): void {
    const q = client.queued!;
    client.queued = null;
    this.shoot(client, q.seq, q.angle);
  }

  private shoot(client: Client, seq: number, angle: number): void {
    const res = this.world.fire(client.id, { angle });
    // (L5: a melee player's click is a swing: no bullet, `swing: true`)
    this.sendTo(client, { t: 'shot', seq, arrow: res.arrow?.id ?? null, ...(res.refused ? { reason: res.refused } : { tick: this.world.tick }), ...(res.swing ? { swing: true } : {}) });
  }

  private roster(): RosterEntry[] {
    const entry = (c: Client, bot: boolean): RosterEntry => {
      const team = this.match.teamOf(c.id);
      return { slot: this.world.slotOf(c.id), id: c.id, name: c.name, bot, hat: c.hat, ...(team !== undefined ? { team } : {}) };
    };
    return [...[...this.clients.values()].map((c) => entry(c, false)), ...[...this.bots.values()].map((b) => entry(b.client, true))];
  }

  private broadcastRoster(): void {
    this.broadcast({ t: 'roster', players: this.roster() });
  }

  private sendSnapshot(): void {
    const bytes = encodeSnapshot(captureSnapshot(this.world, this.movables));
    for (const c of this.clients.values()) {
      if (c.conn.bufferedAmount > BACKPRESSURE_BYTES) {
        c.stats.skipped++; // this client can't keep up; a newer snapshot will replace this one anyway
        this.world.anomaly('backpressure', c.id, { queuedBytes: c.conn.bufferedAmount });
        continue;
      }
      c.conn.send(bytes);
      c.stats.bytesOut += bytes.byteLength;
    }
  }

  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      c.conn.send(text);
      c.stats.bytesOut += text.length;
    }
  }

  private sendTo(client: Client, msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    client.conn.send(text);
    client.stats.bytesOut += text.length;
  }

  private uniqueName(raw: string): string {
    const taken = new Set([...this.clients.values(), ...[...this.bots.values()].map((b) => b.client)].map((c) => c.name));
    if (!taken.has(raw)) return raw;
    for (let i = 2; ; i++) if (!taken.has(`${raw}${i}`)) return `${raw}${i}`;
  }

  private logStats(): void {
    const s = this.stepMs;
    const n = Math.max(1, s.steps);
    this.log.info('room_stats', {
      room: this.id,
      humans: this.humans,
      bots: this.bots.size,
      match: this.match.info.number,
      phase: this.match.info.phase,
      arrows: this.world.arrows.length,
      // Whole tick, then its parts: bot brains, the world step (physics + rules), and events/snapshots/sends.
      stepAvgMs: r3(s.total / n),
      stepWorstMs: r3(s.worst),
      botsMs: r3(s.bots / n),
      worldMs: r3(s.world / n),
      netMs: r3(s.net / n),
    });
    this.stepMs = { total: 0, worst: 0, steps: 0, bots: 0, world: 0, net: 0 };
    for (const c of this.clients.values()) {
      const secs = (this.world.tick - c.stats.since) / 60;
      if (secs <= 0) continue;
      this.log.info('net_stats', {
        id: c.id,
        kbPerSecOut: r2(c.stats.bytesOut / 1024 / secs),
        msgsPerSecIn: r2(c.stats.msgsIn / secs),
        dropped: c.stats.dropped,
        snapshotsSkipped: c.stats.skipped,
      });
      c.stats = { bytesOut: 0, msgsIn: 0, dropped: 0, skipped: 0, since: this.world.tick };
    }
  }
}
