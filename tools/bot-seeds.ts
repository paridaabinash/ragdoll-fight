/**
 * The `bots` sim room (Test Lab, filler bots, one idle person) over many different fights:
 *   npx tsx tools/bot-seeds.ts [from=1] [to=13]      (bot seeds from..to-1, 2 min each, ~6 s per seed)
 * `npm run sim` plays one fight; rare physics problems need many. Each seed is the same fight every time (the room
 * option `botSeed`), so a problem found here replays exactly. Prints every warning/error and a count per event;
 * the whole log goes to logs/botseeds-latest.jsonl. (L6: 48 seeds found the narrow-pocket `stage_cant_stand` in 21
 * fights, where the default seed showed nothing.)
 */
import { initPhysics, TEST_LAB } from '../shared/src';
import { GameRoom, type Conn } from '../server/src/room';
import { fileSink } from './log-files';

await initPhysics();
const [from, to] = [Number(process.argv[2] ?? 1), Number(process.argv[3] ?? 13)];
const file = fileSink('botseeds');
const counts = new Map<string, number>();
for (let seed = from; seed < to; seed++) {
  let problems = 0;
  const room = new GameRoom(`seed${seed}`, (e) => {
    file(e);
    if ((e.lvl !== 'warn' && e.lvl !== 'error') || e.ev === 'slow_step') return;
    problems++;
    counts.set(e.ev, (counts.get(e.ev) ?? 0) + 1);
    if (!e.repeatsNotLogged) console.log(`seed ${seed} ${e.lvl} ${JSON.stringify(e).slice(0, 400)}`);
  }, () => {}, { rotation: [TEST_LAB], botSeed: seed });
  const nobody: Conn = { send() {}, close() {}, bufferedAmount: 0 };
  room.join(nobody, 'person');
  for (let t = 0; t < 7200; t++) room.tick();
  room.close();
  console.log(`seed ${seed}: ${problems} problems`);
}
await file.flush();
console.log(`\n${to - from} fights; problems by event: ${[...counts].map(([ev, n]) => `${ev} ${n}`).join(', ') || 'none'}\nlog: ${file.file}`);
