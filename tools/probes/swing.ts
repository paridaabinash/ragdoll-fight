// L7 step 6 probe: traces each melee motion (weapon tip relative to the feet, the arm's lag behind its target angle).
import { buildTestLevel, GameWorld, initPhysics, Logger, LOCAL_PLAYER, MELEE, NO_CONTROLS, weaponLine, type LogEntry } from '../../shared/src';
await initPhysics();
for (const weapon of ['bat', 'mace'] as const) {
  const log: LogEntry[] = [];
  const w = new GameWorld(new Logger('p', (e) => void log.push(e)));
  buildTestLevel(w);
  for (let i = 0; i < 60; i++) w.step();
  w.damage.get(LOCAL_PLAYER)!.weapon = weapon;
  const p = w.player(LOCAL_PLAYER);
  const st = w.stats.get(LOCAL_PLAYER)!;
  st.readyAt = w.tick;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const feetY = Math.max(...p.footPoints().map((f) => f.y));
  const x0 = p.center().x;
  w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, aim: { angle: 0 } });
  for (let i = 0; i < 20; i++) w.step();
  console.log(weapon, 'fire', w.fire(LOCAL_PLAYER, { angle: 0 }));
  const m = MELEE.motions[weapon];
  for (let t = 0; t < m.windup + m.ticks + m.settleTicks + 4; t++) {
    const target = w.melee.swingAngle(LOCAL_PLAYER);
    w.step();
    const arm = p.parts.armFrontLower;
    const l = weaponLine({ ...arm.translation(), a: arm.rotation() }, weapon);
    const along = Math.atan2(l.tip.y - l.hand.y, l.tip.x - l.hand.x);
    const lag = target === null ? null : r2(Math.atan2(Math.sin(target - along), Math.cos(target - along)));
    if (t % 2 === 0) console.log(weapon, t, 'tip x', r2(l.tip.x - x0), 'tip h', r2(feetY - l.tip.y), 'lag', lag, 'crouch', p.controls.crouch, 'settle', p.mods.swingSettle);
  }
  console.log(log.filter((e) => ['melee_swing', 'melee_miss', 'melee_hit', 'melee_blocked', 'joint_over_limit', 'ragdoll_fall'].includes(String(e.ev))).map((e) => `${e.tick}:${e.ev}`).join(' '));
  w.dispose();
}
