/**
 * Server tick cost, measured two ways on the same room (3 filler bots + 1 idle person, no sockets):
 *   hot   = ticks back-to-back (what `npm run sim -- bots` reports: the code's cost on a busy, fast core)
 *   timer = one tick every 1/60 s from a timer (what the live server does: the CPU idles between ticks)
 * `npx tsx tools/tick-probe.ts [hot|timer] [test_lab|backyard] [log|bglog]`
 *   log = write logs/probe-latest.jsonl synchronously (the old server way), bglog = in the background (the server now)
 * Why this exists: on a laptop the same code is several times slower when paced (power saving puts a mostly idle
 * thread on a slow core / low clock). See "Server tick cost" in ragdoll architecture.md.
 */
import { BACKYARD, DEBUG, initPhysics, TEST_LAB, type LogEntry } from '@ragdoll/shared';
import { GameRoom, type Conn } from '../server/src/room';
import { fileSink } from './log-files';

await initPhysics();
const mode = process.argv[2] === 'timer' ? 'timer' : 'hot';
const arena = process.argv[3] === 'backyard' ? BACKYARD : TEST_LAB;
const logArg = process.argv.find((a) => a === 'log' || a === 'bglog');
const file = logArg ? fileSink('probe', { background: logArg === 'bglog' }) : null;
const TICKS = 3600;
const WARMUP = 600;

const stats: LogEntry[] = [];
let slowSteps = 0;
const sink = (e: LogEntry) => {
  if (e.ev === 'room_stats') stats.push(e);
  if (e.ev === 'slow_step') slowSteps++;
  file?.(e);
};
const room = new GameRoom('probe', sink, () => {}, { rotation: [arena] });
const nobody: Conn = { send() {}, close() {}, bufferedAmount: 0 };
room.join(nobody, 'person');

// time the world step (Match.step = GameWorld.step + match rules) separately from the whole tick
const worldMs: number[] = [];
const tickMs: number[] = [];
const step = room.match.step.bind(room.match);
room.match.step = () => {
  const t0 = performance.now();
  const r = step();
  worldMs.push(performance.now() - t0);
  return r;
};
const once = () => {
  const t0 = performance.now();
  room.tick();
  tickMs.push(performance.now() - t0);
};

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const f = (x: number) => x.toFixed(3);
function report(): never {
  const t = tickMs.slice(WARMUP);
  const w = worldMs.slice(WARMUP);
  const parts = stats.slice(WARMUP / 300);
  const mean = (k: string) => f(avg(parts.map((e) => Number(e[k]))));
  console.log(
    `${mode.padEnd(5)} ${arena.id}${logArg ? ` +${logArg}` : ''}: tick avg ${f(avg(t))} ms (p50 ${f(pct(t, 0.5))}, p99 ${f(pct(t, 0.99))}, worst ${f(Math.max(...t))}) | ` +
      `world step avg ${f(avg(w))} p99 ${f(pct(w, 0.99))} p99.9 ${f(pct(w, 0.999))} | parts: bots ${mean('botsMs')} world ${mean('worldMs')} net ${mean('netMs')} | ` +
      `world steps over 4/8/12 ms: ${[4, 8, 12].map((ms) => w.filter((x) => x > ms).length).join('/')} of ${w.length}, slow_step logged (>${DEBUG.slowStepMs} ms) ${slowSteps}`,
  );
  room.close();
  process.exit(0);
}

if (mode === 'hot') {
  for (let i = 0; i < TICKS; i++) once();
  report();
} else {
  setInterval(() => (once(), tickMs.length >= TICKS && report()), 1000 / 60);
}
