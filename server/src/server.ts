import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Logger, NET, parseClientMessage, type LogSink, type RoomList, type RoomSettings, type ServerMessage } from '@ragdoll/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameRoom, type Conn, type RoomOptions } from './room';
import { newRoomCode } from './room-codes';

const JOIN_TIMEOUT_MS = 5000;

/** The player's address. Behind the dev-server proxy, the real one is in X-Forwarded-For (only trusted from this machine). */
function playerAddress(req: IncomingMessage): string {
  const direct = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
  const forwarded = req.headers['x-forwarded-for'];
  const fromProxy = direct === '127.0.0.1' || direct === '::1';
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return fromProxy && first ? first.replace(/^::ffff:/, '') : direct;
}
const MAX_MESSAGE_BYTES = 1024;

export interface GameServer {
  port: number;
  rooms: Map<string, GameRoom>;
  close(): Promise<void>;
}

/** Web addresses other devices on this network can open to play (one per network card, e.g. Wi-Fi and Ethernet). */
export function lanUrls(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${NET.clientPort}`);
  }
  return out;
}

/**
 * Game server on one port:
 * - WebSocket: play. The first message must be `join`; it can name a room by its code, ask for a 'new' one (M1: with
 *   settings), or quick-join (the fullest public room with space). Each room runs its own fixed 60 Hz loop.
 * - GET /rooms: the public rooms for the join screen (mode, arena, who's in, the leader) + this machine's network addresses.
 */
export function createGameServer(opts: {
  port: number;
  sink: LogSink;
  autoTick?: boolean;
  host?: string;
  /** New rooms: arena rotation (default the Backyard only), match length, filler bots. */
  room?: RoomOptions;
  /** M1: what quick play's rooms play (default: `room.settings`, else free-for-all in rotation order). */
  quickSettings?: RoomSettings;
  /** Random seed source for new rooms (tests: repeatable). */
  seed?: () => number;
}): Promise<GameServer> {
  const log = new Logger('server', opts.sink);
  const rooms = new Map<string, GameRoom>();
  let nextConn = 1;
  const seed = opts.seed ?? (() => Math.floor(Math.random() * 1e9));

  /** A room with its own code; `settings`: what a player picked (quick play: the server's choice). */
  const newRoom = (settings: RoomSettings | undefined, by: string): GameRoom => {
    const id = newRoomCode((code) => rooms.has(code));
    const room = new GameRoom(id, opts.sink, (closed) => rooms.delete(closed.id), { ...opts.room, seed: seed(), ...(settings ? { settings } : {}) });
    rooms.set(room.id, room);
    log.info('room_created', { room: id, by, settings: room.settings });
    if (opts.autoTick !== false) room.start();
    return room;
  };

  /** Quick play: the fullest public room with space, so players end up together instead of alone in separate rooms. */
  const quickRoom = (): GameRoom => {
    let best: GameRoom | null = null;
    for (const r of rooms.values()) if (!r.full && !r.closed && !r.settings.private && (!best || r.humans > best.humans)) best = r;
    return best ?? newRoom(opts.quickSettings, 'quick_play');
  };

  const roomList = (): RoomList => ({
    rooms: [...rooms.values()].filter((r) => !r.closed && !r.settings.private).map((r) => r.info()),
    lanUrls: lanUrls(),
  });

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The page is served from another port (Vite), so the browser needs permission to read this (CORS).
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && req.url?.split('?')[0] === '/rooms') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(roomList()));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws: WebSocket, req) => {
    const connId = nextConn++;
    const addr = playerAddress(req);
    const conn: Conn = {
      send: (data) => ws.readyState === ws.OPEN && ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    };
    let joined: { room: GameRoom; id: string } | null = null;
    const refuse = (reason: string) => {
      log.info('connection_refused', { conn: connId, addr, reason });
      ws.send(JSON.stringify({ t: 'error', reason } satisfies ServerMessage));
      ws.close(1008, reason);
    };
    const joinTimer = setTimeout(() => !joined && refuse('join_timeout'), JOIN_TIMEOUT_MS);
    log.info('connection_open', { conn: connId, addr });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return refuse('binary_not_allowed');
      const text = data.toString();
      if (joined) {
        if (!joined.room.closed) joined.room.handleText(joined.id, text);
        return;
      }
      const msg = parseClientMessage(text);
      if ('error' in msg || msg.t !== 'join') return refuse('expected_join');
      if (msg.v !== NET.protocolVersion) return refuse(`protocol_mismatch:server_${NET.protocolVersion}_client_${msg.v}`);
      let room: GameRoom;
      if (msg.room === 'new') room = newRoom(msg.settings ?? opts.quickSettings, `conn${connId}`);
      else if (msg.room) {
        const wanted = rooms.get(msg.room);
        if (!wanted || wanted.closed) return refuse('room_not_found');
        if (wanted.full) return refuse('room_full');
        room = wanted;
      } else room = quickRoom();
      clearTimeout(joinTimer);
      joined = { room, id: room.join(conn, msg.name, msg.hat) };
      log.info('joined_room', { conn: connId, addr, room: room.id, id: joined.id, asked: msg.room ?? 'quick' });
    });

    ws.on('close', (code) => {
      clearTimeout(joinTimer);
      log.info('connection_closed', { conn: connId, addr, code, id: joined?.id ?? null });
      if (joined && !joined.room.closed) joined.room.leave(joined.id, `socket_closed_${code}`);
    });
    ws.on('error', (err) => log.warn('socket_error', { conn: connId, addr, msg: err.message }));
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    // Only this computer by default: players reach the server through the page's dev server (one port),
    // so the game server itself doesn't need to be open to the network.
    http.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      log.info('server_listening', { port, lanUrls: lanUrls() });
      resolve({
        port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            for (const r of [...rooms.values()]) r.close();
            for (const c of wss.clients) c.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
