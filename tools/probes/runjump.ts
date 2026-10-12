import { GameWorld, initPhysics, LOCAL_PLAYER, Logger, NO_CONTROLS, WALK, MOVE, type LogEntry } from '../../shared/src';
function flatWorld() {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('probe', (e) => void log.push(e)));
  world.bounds = { width: 100, height: 19 };
  world.addBox('ground', 'fixed', { x: 50, y: 18.5 }, { x: 50, y: 0.5 });
  world.addPlayer(LOCAL_PLAYER, { x: 10, y: 18 }, 1);
  for (let i = 0; i < 90; i++) world.step();
  return { world, log, p: world.player(LOCAL_PLAYER) };
}
await initPhysics();
for (const runup of [70, 75, 80, 85, 90, 95, 100]) {
  const { world, p, log } = flatWorld();
  world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
  for (let i = 0; i < runup; i++) world.step();
  const g0 = p.grounded;
  world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1, jump: true });
  const gs: string[] = [];
  for (let i = 0; i < 8; i++) { world.step(); const q = p as unknown as { lastJumpTick: number; lastGroundTick: number; braking: boolean }; gs.push(`${p.grounded ? 'G' : '.'}${q.lastJumpTick - q.lastGroundTick}`); }
  world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true });
  const vx = p.speedX();
  const row = [];
  for (let i = 0; i < 12; i++) { world.step(); row.push(p.speedX().toFixed(1) + (p.grounded ? 'g' : '')); }
  const jumped = log.filter((e) => e.ev === 'jump').length;
  console.log(gs.join(' '), `walk ${WALK.speed} jump ${MOVE.jumpSpeed} runup ${runup} groundedBefore ${g0} jumps ${jumped} vx ${vx.toFixed(2)} -> ${row.join(' ')}`);
  world.dispose();
}
