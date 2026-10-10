// Funny legs probe: Big Scissor stride vs. heel flick (and knee lift). For each setting: how wide the hips swing while
// running, the share of running ticks with no foot on the ground (bounding), and the stop (time, distance, stumbles).
// `npx tsx tools/probes/scissor.ts`
import { GameWorld, GROUND_Y, initPhysics, Logger, LOCAL_PLAYER, NO_CONTROLS, WALK, type LogEntry } from '../../shared/src';
await initPhysics();
const r2 = (v: number) => Math.round(v * 100) / 100;
const W = WALK as unknown as Record<string, number>;

function trial(scissor: number, flick: number, lift: number): string {
  W.scissorSwing = scissor;
  W.heelFlick = flick;
  W.kneeLift = lift;
  const log: LogEntry[] = [];
  const w = new GameWorld(new Logger('probe', (e) => void log.push(e)));
  w.bounds = { width: 100, height: GROUND_Y + 1 };
  w.addBox('ground', 'fixed', { x: 50, y: GROUND_Y + 0.5 }, { x: 50, y: 0.5 });
  w.addPlayer(LOCAL_PLAYER, { x: 10, y: GROUND_Y }, 1);
  for (let i = 0; i < 90; i++) w.step();
  const p = w.player(LOCAL_PLAYER);
  const k = (n: 'hipFront' | 'hipBack') => p.jointAngle(n) * p.facing;
  let hipMin = 0;
  let hipMax = 0;
  let air = 0;
  let ticks = 0;
  w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
  for (let i = 0; i < 150; i++) {
    w.step();
    if (i < 40) continue;
    ticks++;
    if (!p.grounded) air++;
    hipMin = Math.min(hipMin, k('hipFront'), k('hipBack'));
    hipMax = Math.max(hipMax, k('hipFront'), k('hipBack'));
  }
  w.dispose();
  // the stop, letting go at 8 different moments of the stride (where in the step you let go matters)
  let worstT = 0;
  let worstD = 0;
  let stumbles = 0;
  let falls = 0;
  for (let late = 0; late < 16; late += 2) {
    const sl: LogEntry[] = [];
    const sw = new GameWorld(new Logger('probe', (e) => void sl.push(e)));
    sw.bounds = { width: 100, height: GROUND_Y + 1 };
    sw.addBox('ground', 'fixed', { x: 50, y: GROUND_Y + 0.5 }, { x: 50, y: 0.5 });
    sw.addPlayer(LOCAL_PLAYER, { x: 10, y: GROUND_Y }, 1);
    for (let i = 0; i < 90; i++) sw.step();
    const sp = sw.player(LOCAL_PLAYER);
    sw.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
    for (let i = 0; i < 100 + late; i++) sw.step();
    const x0 = sp.center().x;
    const mark = sl.length;
    sw.setControls(LOCAL_PLAYER, NO_CONTROLS);
    let stop = -1;
    for (let i = 0; i < 180; i++) {
      sw.step();
      if (stop < 0 && Math.abs(sp.speedX()) < 0.1) stop = i;
    }
    worstT = Math.max(worstT, stop < 0 ? 3 : stop / 60);
    worstD = Math.max(worstD, Math.abs(sp.center().x - x0));
    stumbles += sl.slice(mark).filter((e) => e.ev === 'stumble').length;
    falls += sl.slice(mark).filter((e) => e.ev === 'ragdoll_fall').length;
    sw.dispose();
  }
  return `scissor ${scissor} flick ${flick} lift ${lift} | hips ${r2(hipMin)}..${r2(hipMax)} | air ${Math.round((100 * air) / ticks)}% | 8 stops: worst ${r2(worstT)} s ${r2(worstD)} m, stumbles ${stumbles}, falls ${falls}`;
}

console.log(trial(0, 0, 1.0), ' <- before (L7)');
for (const [sc, f, l] of [
  [0.55, 0.9, 1.0],
  [0.5, 0.9, 1.0],
  [0.6, 0.9, 1.0],
  [0.55, 0.8, 1.0],
  [0.55, 1.0, 1.0],
  [0.45, 0.5, 0.8],
  [0.4, 0.5, 0.8],
]) console.log(trial(sc, f, l));
