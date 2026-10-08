/**
 * Seeded bot-style fight, used by the `limits` sim scenario and shared/test/joint-limits.test.ts.
 * Each player loops like a netsim bot: walk (or stand) 18-36 ticks, aim at a random other player (18 ticks, then
 * 24-48 more: L3, the gun has no draw, so both are just aiming), fire. Leg hits trip players, and they keep aiming and
 * walking while down and getting up. Same seed = same fight, so any problem it finds replays exactly.
 */
import { NO_CONTROLS, type Controls, type GameWorld } from '../shared/src';

export function botFight(world: GameWorld, ids: string[], seed: number, ticks: number, each?: () => void): { shots: number } {
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const plan = new Map<string, { until: number; c: Controls; stage: number; angle: number }>();
  let shots = 0;
  for (let t = 0; t < ticks; t++) {
    for (const id of ids) {
      let cur = plan.get(id);
      if (!cur || world.tick >= cur.until) {
        const stage = cur ? (cur.stage + 1) % 3 : 0;
        if (cur?.stage === 2 && world.playerStats(id).alive && world.fire(id, { angle: cur.angle }).arrow) shots++;
        const me = world.player(id).center();
        const others = ids.filter((x) => x !== id);
        const other = world.player(others[Math.floor(rand() * others.length)]).center();
        const dx = other.x - me.x;
        // aim a little above the target to make up for the drop, plus a little spread
        const angle = Math.atan2(other.y - me.y - Math.abs(dx) * 0.12, dx) + (rand() - 0.5) * 0.06;
        const c: Controls =
          stage === 0 ? { ...NO_CONTROLS, move: ([-1, 0, 1] as const)[Math.floor(rand() * 3)] } : { ...NO_CONTROLS, aim: { angle } };
        const len = stage === 0 ? 18 + rand() * 18 : stage === 1 ? 18 : 24 + rand() * 24;
        cur = { until: world.tick + Math.floor(len), c, stage, angle };
        plan.set(id, cur);
      }
      world.setControls(id, cur.c);
    }
    world.step();
    each?.();
  }
  return { shots };
}
