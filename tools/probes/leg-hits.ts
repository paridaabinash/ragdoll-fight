// Funny legs probe: does the Big Scissor walk + Split Leap make legs easier to hit? Real rooms (one still person + 3
// filler bots, 2 minutes, 4 seeds), bullet hits on the moving bots counted by zone, with the new legs and with the old
// leg motion (no scissor, no heel flick, legs straight in the air: close to the old dangle).
// `npx tsx tools/probes/leg-hits.ts`
import { BACKYARD, initPhysics, LEGS, TEST_LAB, WALK, type LogEntry } from '../../shared/src';
import { GameRoom, type Conn } from '../../server/src/room';
await initPhysics();
const W = WALK as unknown as Record<string, number>;
const S = LEGS.split as unknown as Record<string, number>;
const NEW = { scissor: W.scissorSwing, flick: W.heelFlick, split: S.hip };

function fight(seed: number): Record<string, number> {
  const log: LogEntry[] = [];
  const room = new GameRoom(`hits${seed}`, (e) => void log.push(e), () => {}, { rotation: [seed % 2 ? BACKYARD : TEST_LAB], botSeed: seed * 101 });
  const nobody: Conn = { send() {}, close() {}, bufferedAmount: 0 };
  const person = room.join(nobody, 'person');
  for (let t = 0; t < 120 * 60; t++) room.tick();
  room.close();
  const zones: Record<string, number> = { head: 0, torso: 0, arm: 0, leg: 0 };
  for (const e of log) if (e.ev === 'damage' && e.id !== person && e.speed !== 0 && String(e.zone) in zones) zones[String(e.zone)]++;
  return zones;
}

for (const [name, cfg] of [['old legs', { scissor: 0, flick: 0, split: 0 }], ['new legs', NEW]] as const) {
  W.scissorSwing = cfg.scissor;
  W.heelFlick = cfg.flick;
  S.hip = cfg.split;
  const total: Record<string, number> = { head: 0, torso: 0, arm: 0, leg: 0 };
  for (const seed of [1, 2, 3, 4]) for (const [z, n] of Object.entries(fight(seed))) total[z] += n;
  const all = Object.values(total).reduce((a, b) => a + b, 0);
  console.log(`${name}: ${all} bullet hits on moving bots | ` + Object.entries(total).map(([z, n]) => `${z} ${n} (${Math.round((100 * n) / all)}%)`).join(', '));
}
