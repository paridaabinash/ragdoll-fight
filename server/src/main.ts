/** `npm run dev:server` (or `npm run dev` for server + client). Logs go to logs/server-latest.jsonl. */
import { arenaById, DEFAULT_ROOM_SETTINGS, GAME_SPEED, GAME_SPEED_RANGE, initPhysics, MATCH, NET, ROTATION, setGameSpeed, type MatchSettings, type RoomSettings } from '@ragdoll/shared';
import { fileSink } from '../../tools/log-files';
import { createGameServer, lanUrls } from './server';

await initPhysics();
const sink = fileSink('server', { background: true }); // log writes never block the game loop
// L7 game-speed dial: GAME_SPEED=0.85 slows everything that moves by 15% (sent to every client in the welcome)
if (process.env.GAME_SPEED !== undefined && !setGameSpeed(Number(process.env.GAME_SPEED))) {
  console.error(`GAME_SPEED=${process.env.GAME_SPEED} ignored: must be a number from ${GAME_SPEED_RANGE[0]} to ${GAME_SPEED_RANGE[1]}`);
}
sink({ t: 0, src: 'server', lvl: 'info', ev: 'game_speed', speed: GAME_SPEED });
const port = Number(process.env.PORT) || NET.port;
// Rooms can play every arena in ROTATION. Quick play's rooms: free-for-all, arenas voted (M1/M2).
// ARENA=backyard (or test_lab) makes quick play's rooms play only that arena, for testing one. MODE=teams picks the mode.
const rotation = ROTATION;
const only = arenaById(process.env.ARENA ?? '');
const quickSettings: RoomSettings = { ...DEFAULT_ROOM_SETTINGS, ...(only ? { arenas: 'one', arena: only.id } : {}) };
const mode = process.env.MODE;
if (mode) {
  if (['ffa', 'crown', 'last_standing', 'melee', 'chaos', 'teams'].includes(mode)) quickSettings.mode = mode as RoomSettings['mode'];
  else console.error(`MODE=${mode} ignored`);
}
// MATCH_SECONDS=30 for short matches while testing, in every room (results 5 s; chaos rounds scaled down so one still happens).
const secs = Number(process.env.MATCH_SECONDS) || 0;
const short = Math.round(secs * 60);
const match: MatchSettings | undefined = secs > 0 ? { ...MATCH, lengthTicks: short, resultsTicks: 5 * 60, modifierEveryTicks: Math.round(short * 0.4), modifierTicks: Math.round(short / 3) } : undefined;
const server = await createGameServer({ port, sink, room: { rotation, ...(match ? { match } : {}) }, quickSettings });
const urls = lanUrls();
console.log(`game server on port ${server.port}, quick play: ${quickSettings.mode}, arenas ${only ? only.id : quickSettings.arenas}, matches ${match ? match.lengthTicks / 60 : quickSettings.minutes * 60} s  (log: ${sink.file})`);
console.log(
  urls.length
    ? `players on this network open:\n${urls.map((u) => `  ${u}`).join('\n')}`
    : 'no network address found: only this computer can play (http://localhost:' + NET.clientPort + ')',
);

const stop = async () => {
  await server.close();
  await sink.flush();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
