// Temporary L2 probe (deleted after): trace the trampoline scenario.
import { arenaLayout, buildArena, GameWorld, initPhysics, Logger, NO_CONTROLS, LOCAL_PLAYER, TEST_LAB, type LogEntry } from '../shared/src';
await initPhysics();
const log: LogEntry[] = [];
const w = new GameWorld(new Logger('p', (e) => void log.push(e)));
buildArena(w, arenaLayout(TEST_LAB, 'full'));
const p = w.addPlayer(LOCAL_PLAYER, { x: 11, y: 22 }, 1);
for (let i = 0; i < 60; i++) w.step();
const r2 = (v: number) => Math.round(v * 100) / 100;
for (let t = 0; t < 150; t++) {
  w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1, jump: t % 45 < 20 });
  w.step();
  if (t % 6 === 0) {
    const f1 = p.parts.legFrontLower.translation(), f2 = p.parts.legBackLower.translation();
    console.log(t, 'torso', r2(p.center().x), r2(p.center().y), 'feet x', r2(f1.x), r2(f2.x), 'y', r2(f1.y), r2(f2.y), 'g', p.grounded, 'vx', r2(p.speedX()));
  }
}
console.log(log.filter((e) => ['jump', 'jump_blocked', 'jump_cut', 'land', 'hazard_hit', 'stumble'].includes(String(e.ev))).map((e) => `${e.tick}:${e.ev}${e.reason ? '/' + e.reason : ''}`).join(' '));
