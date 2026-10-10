// Probe for l7-unstuck: where the feet end up when a body drops into a 0.3 m slot (torso on the edges).
import { GameWorld, initPhysics, Logger, NO_CONTROLS, type LogEntry } from '../../shared/src';
await initPhysics();
const log: LogEntry[] = [];
const w = new GameWorld(new Logger('t', (e) => void log.push(e)));
w.bounds = { width: 40, height: 30 };
w.addBox('floor', 'fixed', { x: 20, y: 29.5 }, { x: 20, y: 0.5 });
w.addBox('block_l', 'fixed', { x: 18.85, y: 22 }, { x: 1, y: 4 });
w.addBox('block_r', 'fixed', { x: 21.15, y: 22 }, { x: 1, y: 4 });
const p = w.addPlayer('a', { x: 20, y: 17.6 }, 1);
const r2 = (v: number) => Math.round(v * 100) / 100;
for (let i = 0; i < 120; i++) {
  w.setControls('a', NO_CONTROLS);
  w.step();
  if (i % 20 === 19) console.log(i, 'grounded', p.grounded, 'center', r2(p.center().x), r2(p.center().y), 'feet', p.footPoints().map((f) => `${r2(f.x)},${r2(f.y)}`).join(' '), 'hips', r2(p.jointAngle('hipFront')), r2(p.jointAngle('hipBack')));
}
console.log(log.filter((e) => ['land', 'ragdoll_fall', 'stumble', 'trip'].includes(String(e.ev))).map((e) => `${e.tick}:${e.ev}`).join(' '));
