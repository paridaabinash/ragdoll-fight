import { beforeAll, describe, expect, it } from 'vitest';
import { GameWorld, initPhysics, LOCAL_PLAYER, Logger, PART_SHAPES, RESPAWN, type LogEntry } from '../src';

beforeAll(() => initPhysics());

const FLOOR = 20;
/** A floor, and a fixed slab whose underside is `gap` m above it (x 8-12). */
function slot(gap: number) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  world.bounds = { width: 30, height: FLOOR + 1 };
  world.addBox('ground', 'fixed', { x: 15, y: FLOOR + 0.5 }, { x: 15, y: 0.5 });
  world.addBox('shelf', 'fixed', { x: 10, y: FLOOR - gap - 0.2 }, { x: 2, y: 0.2 });
  return { world, log };
}

/** How far above its feet a freshly built body reaches (the top of its highest part). */
function bodyTop(world: GameWorld): number {
  const p = world.player(LOCAL_PLAYER);
  let top = Infinity;
  for (const [name, b] of Object.entries(p.parts)) {
    const s = PART_SHAPES[name as keyof typeof PART_SHAPES] as { r?: number; hx?: number; hy?: number };
    top = Math.min(top, b.translation().y - (s.r ?? Math.hypot(s.hx ?? 0, s.hy ?? 0)));
  }
  return FLOOR - top;
}

describe('room to stand (repair, swap): the whole standing body must fit', () => {
  it('RESPAWN.standRoom covers a freshly built body', () => {
    const { world } = slot(5);
    world.addPlayer(LOCAL_PLAYER, { x: 3, y: FLOOR }, 1);
    expect(bodyTop(world)).toBeLessThan(RESPAWN.standRoom);
    world.dispose();
  });

  it('a 2.2 m slot (Frozen Lake: the ice shelf over the bank) is no room; a roomy one is', () => {
    // (2026-10-11: the old check stopped at 2.2 m above the feet, so this passed and a repair built the head inside)
    const tight = slot(2.2);
    expect(tight.world.roomToStand({ x: 10, y: FLOOR })).toBe(false);
    expect(tight.world.roomToStand({ x: 3, y: FLOOR })).toBe(true); // beside the shelf
    tight.world.dispose();
    const roomy = slot(RESPAWN.standRoom + 0.05);
    expect(roomy.world.roomToStand({ x: 10, y: FLOOR })).toBe(true);
    roomy.world.dispose();
  });

  it('a body rebuilt where there is room never starts inside anything (no respawn_blocked)', () => {
    const { world, log } = slot(RESPAWN.standRoom + 0.05);
    world.addPlayer(LOCAL_PLAYER, { x: 3, y: FLOOR }, 1);
    for (let i = 0; i < 30; i++) world.step();
    expect(world.roomToStand({ x: 10, y: FLOOR })).toBe(true);
    world.relocate(LOCAL_PLAYER, { x: 10, y: FLOOR }, 1);
    world.step();
    expect(log.filter((e) => e.ev === 'respawn_blocked')).toEqual([]);
    world.dispose();
  });
});
