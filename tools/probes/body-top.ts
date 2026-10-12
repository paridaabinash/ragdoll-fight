import { GameWorld, initPhysics, LOCAL_PLAYER, Logger, PART_SHAPES } from '../../shared/src';
await initPhysics();
const w = new GameWorld(new Logger('probe', () => undefined));
w.bounds = { width: 40, height: 21 };
w.addBox('ground', 'fixed', { x: 20, y: 20.5 }, { x: 20, y: 0.5 });
w.addPlayer(LOCAL_PLAYER, { x: 10, y: 20 }, 1);
const p = w.player(LOCAL_PLAYER);
const top = () => {
  let t = Infinity;
  let wide = 0;
  for (const [name, b] of Object.entries(p.parts)) {
    const s = PART_SHAPES[name as keyof typeof PART_SHAPES] as { r?: number; hx?: number; hy?: number };
    const reach = s.r ?? Math.hypot(s.hx ?? 0, s.hy ?? 0);
    t = Math.min(t, b.translation().y - reach);
    wide = Math.max(wide, Math.abs(b.translation().x - 10) + reach);
  }
  return { above: +(20 - t).toFixed(3), halfWidth: +wide.toFixed(3) };
};
console.log('at spawn', top());
for (let i = 0; i < 120; i++) w.step();
console.log('standing', top());
