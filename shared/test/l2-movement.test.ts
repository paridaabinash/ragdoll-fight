import { beforeAll, describe, expect, it } from 'vitest';
import { BOT, EFFECT_BODY, GameWorld, GROUND_Y, initPhysics, Logger, MOVE, NO_CONTROLS, WALK, type Controls, type LogEntry } from '../src';

beforeAll(() => initPhysics());

/** p1 on a long floor with a 2 m block from x 40 to 50, settled. */
function world(x = 10, onBlock = false) {
  const log: LogEntry[] = [];
  const w = new GameWorld(new Logger('test', (e) => void log.push(e)));
  w.bounds = { width: 100, height: GROUND_Y + 1 };
  w.addBox('ground', 'fixed', { x: 50, y: GROUND_Y + 0.5 }, { x: 50, y: 0.5 });
  w.addBox('block', 'fixed', { x: 45, y: GROUND_Y - 1 }, { x: 5, y: 1 });
  const p = w.addPlayer('p1', { x, y: onBlock ? GROUND_Y - 2 : GROUND_Y }, 1);
  for (let i = 0; i < 90; i++) w.step();
  const hold = (c: Partial<Controls>, ticks: number, each?: () => void) => {
    w.setControls('p1', { ...NO_CONTROLS, ...c });
    for (let i = 0; i < ticks; i++) (w.step(), each?.());
  };
  return { w, p, log, hold };
}

describe('L2 movement feel', () => {
  it('runs fast, gets there quickly and stops quickly', () => {
    const { w, p, hold } = world();
    hold({ move: 1 }, 15);
    expect(p.speedX()).toBeGreaterThan(0.85 * WALK.speed);
    hold({ move: 1 }, 45);
    expect(p.speedX()).toBeGreaterThan(5);
    hold({}, 15);
    expect(Math.abs(p.speedX())).toBeLessThan(0.3);
    w.dispose();
  });

  it('tap = short hop, hold = full jump (letting go early cuts the rise)', () => {
    const rise = (holdTicks: number) => {
      const { w, p, log, hold } = world();
      const y0 = p.center().y;
      let peak = y0;
      hold({ jump: true }, holdTicks, () => (peak = Math.min(peak, p.center().y)));
      hold({}, 90, () => (peak = Math.min(peak, p.center().y)));
      const cut = log.some((e) => e.ev === 'jump_cut');
      w.dispose();
      return { rise: y0 - peak, cut };
    };
    const held = rise(MOVE.cutTicks + 5);
    const tapped = rise(1);
    expect(held.cut).toBe(false);
    expect(held.rise).toBeGreaterThan(1.2);
    expect(tapped.cut).toBe(true);
    expect(tapped.rise).toBeGreaterThan(0.3);
    expect(tapped.rise).toBeLessThan(0.65 * held.rise);
  });

  it('coyote time: a jump just after walking off an edge still works, a late one does not', () => {
    const offEdge = (late: number) => {
      const { w, p, log, hold } = world(47, true);
      w.setControls('p1', { ...NO_CONTROLS, move: 1 });
      for (let i = 0; i < 240 && !(p.center().x > 50.3 && !p.grounded); i++) w.step();
      hold({ move: 1 }, late - 1);
      const mark = log.length;
      hold({ move: 1, jump: true }, 20);
      const jump = log.slice(mark).find((e) => e.ev === 'jump');
      w.dispose();
      return jump;
    };
    expect(offEdge(3)).toMatchObject({ coyote: expect.any(Number) });
    expect(offEdge(MOVE.coyoteTicks + 4)).toBeUndefined();
  });

  it('jump buffer: pressed just before landing, it jumps on landing; pressed too early, it does not', () => {
    // when does a held jump land? (the world is deterministic)
    const probe = world();
    probe.hold({ jump: true }, 40);
    let land = 40;
    while (!probe.p.grounded && land < 200) (probe.w.step(), land++);
    probe.w.dispose();
    const pressEarly = (early: number) => {
      const { w, log, hold } = world();
      hold({ jump: true }, 40);
      hold({}, land - 40 - early);
      const mark = log.length;
      hold({ jump: true }, early + 20);
      const jump = log.slice(mark).find((e) => e.ev === 'jump');
      w.dispose();
      return jump;
    };
    expect(pressEarly(3)).toMatchObject({ buffered: expect.any(Number) });
    expect(pressEarly(MOVE.bufferTicks + 6)).toBeUndefined();
  });

  it('a head arrow slows running (a floppy head can not sprint)', () => {
    const { w, p, hold } = world();
    const keep = () => w.effects.get('p1')!.add('head', 'head', w.tick);
    hold({ move: 1 }, 60, keep);
    expect(p.speedX()).toBeLessThan(WALK.speed * EFFECT_BODY.headRunFactor + 0.3);
    expect(p.speedX()).toBeGreaterThan(WALK.speed * EFFECT_BODY.headRunFactor - 0.5);
    w.dispose();
  });

  it('bots hold jump long enough for a full jump', () => {
    expect(BOT.jumpHoldTicks).toBeGreaterThan(MOVE.cutTicks);
  });
});
