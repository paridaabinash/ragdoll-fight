import { beforeAll, describe, expect, it } from 'vitest';
import { arenaLayout, buildArena, GameWorld, initPhysics, LIMIT_CHECK, Logger, NO_CONTROLS, TEST_LAB, wrapAngle, type LogEntry } from '../src';

beforeAll(async () => {
  await initPhysics();
});

function worldWithLog(size: 'full' | 'narrow' = 'full'): { world: GameWorld; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => entries.push(e)));
  buildArena(world, arenaLayout(TEST_LAB, size));
  return { world, entries };
}

const warnings = (entries: LogEntry[]) => entries.filter((e) => e.lvl !== 'info' && e.lvl !== 'debug' && e.ev !== 'slow_step');

describe('L6: ragdoll edge cases', () => {
  // The narrow Test Lab leaves a 2 m pocket between the arena wall and the first 1 m step (a spawn is in it). A
  // tripped 2.2 m body lay across it, head on the step, feet in the corner: straight legs + unlimited hip motors made it
  // a strut (~1500 N into both walls) and friction held it down for good (17/36 trips, `stage_cant_stand`). While down,
  // the legs now tuck in, so it's short enough to rise.
  it.each([
    { side: 1, x: 0.6, dir: -1, shove: 0.5 },
    { side: 1, x: 1.0, dir: 1, shove: 0.5 },
    { side: -1, x: 0.6, dir: -1, shove: 0.5 },
    { side: -1, x: 1.0, dir: -1, shove: 1.0 },
  ] as const)('a body tripped in the narrow pocket gets back up (%o)', ({ side, x, dir, shove }) => {
    const { world, entries } = worldWithLog('narrow');
    const p = world.addPlayer('p', { x: side === 1 ? x : world.bounds.width - x, y: 22 }, side);
    for (let t = 0; t < 60; t++) world.step();
    p.trip(world.tick, 'test', dir * side);
    for (const b of p.attached()) world.push(b, { x: dir * side * shove * b.mass(), y: 0 });
    let tucked = false;
    for (let t = 0; t < 600; t++) {
      world.step();
      if (p.down && p.jointAngle('kneeFront') * p.facing > 1) tucked = true;
    }
    expect(entries.some((e) => e.ev === 'ragdoll_fall')).toBe(true);
    expect(tucked).toBe(true);
    expect(p.down).toBe(false);
    expect(Math.abs(wrapAngle(p.parts.torso.rotation()))).toBeLessThan(0.3);
    expect(warnings(entries)).toEqual([]);
    world.dispose();
  });

  // Removing a multibody joint (a part shot off) makes Rapier rebuild the joint tree and reset its root's rotation and
  // speed. With the torso as the root, a body lying down was snapped upright in one tick (18 rad/s, legs and neck forced
  // through the floor, joints 0.5-0.9 m apart), and a flying body stopped dead. The root is now an invisible anchor that
  // never turns, and the lost speed is given back.
  it('losing a part (a shin) while lying down does not snap the body upright', () => {
    const { world, entries } = worldWithLog();
    const p = world.addPlayer('x', { x: 4, y: 22 }, 1);
    for (let t = 0; t < 30; t++) world.step();
    p.trip(world.tick, 'test', -1);
    for (let t = 0; t < 30; t++) world.step();
    expect(Math.abs(p.parts.torso.rotation())).toBeGreaterThan(1.2); // lying
    let prev = p.parts.torso.rotation();
    let worstTurn = 0;
    p.stumpLeg('back');
    Object.assign(world.damage.get('x')!, { firstLeg: 'back', legHits: 3 }); // (cut directly: the rules' record must agree, see l0-limbs)
    for (let t = 0; t < 30; t++) {
      world.step();
      const rot = p.parts.torso.rotation();
      worstTurn = Math.max(worstTurn, Math.abs(wrapAngle(rot - prev)));
      prev = rot;
      expect(p.anchor.rotation()).toBeCloseTo(0, 3);
    }
    expect(worstTurn).toBeLessThan(0.3); // was 1.7 rad in one tick
    expect(warnings(entries)).toEqual([]);
    world.dispose();
  });

  it.each(['shin', 'shatter'] as const)('a flying body keeps its speed when it loses a part (%s)', (what) => {
    const speedAfter = (cut: boolean) => {
      const { world } = worldWithLog();
      const p = world.addPlayer('x', { x: 4, y: 18 }, 1);
      world.step();
      for (const b of p.attached()) world.push(b, { x: 10 * b.mass(), y: -3 * b.mass() });
      world.step();
      world.step();
      if (cut && what === 'shin') p.stumpLeg('front');
      if (cut && what === 'shatter') {
        p.setLimp(true);
        p.shatter();
      }
      world.step();
      const vx = p.parts.torso.linvel().x;
      world.dispose();
      return vx;
    };
    const whole = speedAfter(false);
    expect(whole).toBeGreaterThan(7);
    expect(Math.abs(speedAfter(true) - whole) / whole).toBeLessThan(0.1); // was: stopped dead (0 m/s)
  });

  // A limb slammed into something is forced past its limit for a moment (Rapier can't make that stiffer, see
  // LIMIT_CHECK.spikeTicks). With soft CCD that has become rare at game speeds (sim `crush`), so the rule is tested
  // directly: the elbow is forced out in one burst while a hard hit lands elsewhere on the body (the head). That's a
  // `joint_spike` (info) once it comes back, not a warning.
  it('a joint forced out during a hit on the body is a joint_spike, not a warning', () => {
    const { world, entries } = worldWithLog();
    const p = world.addPlayer('x', { x: 30, y: 4 }, 1);
    for (let t = 0; t < 30; t++) world.step(); // falling; the arms are up
    world.push(p.parts.head, { x: -12 * p.parts.head.mass(), y: 0 });
    let worst = 0;
    for (let t = 0; t < 2; t++) {
      world.twist(p.parts.armFrontLower, 8);
      world.twist(p.parts.armFrontUpper, -8);
      world.step();
      worst = Math.max(worst, p.worstLimitOver().over);
    }
    for (let t = 0; t < 60; t++) world.step();
    expect(worst).toBeGreaterThan(LIMIT_CHECK.hardOver);
    const spike = entries.find((e) => e.ev === 'joint_spike' && e.joint === 'elbowFront');
    expect(spike).toBeDefined();
    expect(spike!.impact as number).toBeGreaterThanOrEqual(LIMIT_CHECK.impactSpeed);
    expect(spike!.ticks as number).toBeLessThan(LIMIT_CHECK.spikeTicks);
    expect(warnings(entries)).toEqual([]);
    world.dispose();
  });

  // Soft CCD (RAGDOLL.softCcd): a body launched up into a thin perch at trampoline-plus-jump speed sank its head and
  // forearm into it and hung there for good (bots seed 36). Now it bounces off.
  it('a body launched into a thin ledge does not sink into it', () => {
    let inside = 0;
    // under perch_r (y 14-14.4) the steps' tops are y 18 (x < 44), 19 (x < 46) and 20
    for (const [x, floor] of [[43, 18], [45, 19], [47, 20]]) {
      for (const angle of [-1.57, -0.3]) {
        const { world } = worldWithLog();
        const p = world.addPlayer('x', { x, y: floor }, 1);
        world.setControls('x', { ...NO_CONTROLS, aim: { angle } });
        for (let t = 0; t < 40; t++) world.step();
        for (const b of p.attached()) world.push(b, { x: 0, y: -28 * b.mass() });
        for (let t = 0; t < 120; t++) {
          world.step();
          for (const part of Object.values(p.parts)) {
            const c = part.translation();
            if (c.x > 42 && c.x < 48 && c.y > 14.02 && c.y < 14.38) inside++;
          }
        }
        expect(p.parts.torso.translation().y).toBeGreaterThan(15.5); // back down, not hanging under the perch
        world.dispose();
      }
    }
    expect(inside).toBe(0);
  });

  // ...but a joint forced out with nothing hitting the body (the body doing it to itself) is still a warning at once.
  it('a joint slowly forced past its limit in the air is still a joint_over_limit warning', () => {
    const { world, entries } = worldWithLog();
    const p = world.addPlayer('x', { x: 30, y: 4 }, 1);
    for (let t = 0; t < 30; t++) world.step(); // falling; the arms have come up to aim (that swing is fast)
    let worstElsewhere = 0;
    for (let t = 0; t < 40 && p.worstLimitOver().over <= LIMIT_CHECK.hardOver; t++) {
      const before = p.parts.head.linvel();
      world.twist(p.parts.armFrontLower, 6);
      world.twist(p.parts.armFrontUpper, -6);
      world.step();
      const after = p.parts.head.linvel();
      worstElsewhere = Math.max(worstElsewhere, Math.hypot(after.x - before.x, after.y - before.y));
    }
    expect(worstElsewhere).toBeLessThan(LIMIT_CHECK.impactSpeed); // nothing hits the body: it builds up
    expect(p.worstLimitOver().over).toBeGreaterThan(LIMIT_CHECK.hardOver);
    expect(entries.some((e) => e.ev === 'joint_over_limit' && String(e.who).endsWith(':elbowFront'))).toBe(true);
    expect(entries.some((e) => e.ev === 'joint_spike')).toBe(false);
    world.dispose();
  });

  // The L5 report guessed the arm hooked over a ledge bends because it carries the body's weight. Measured: a forearm
  // over a ledge's top with the whole body hanging from it (the floor removed) stays within 0.06 rad. The big bends
  // come from hard impacts (above).
  it('an arm hooked over a ledge holds the hanging body without bending backward', () => {
    const base = arenaLayout(TEST_LAB, 'full');
    // standing on a floor beside a wide ledge whose top is just above where the raised arm crosses its edge
    const aim = -0.6;
    const shoulder = { x: 10, y: 22 - 1.72 };
    const ledge = { label: 'ledge', x: shoulder.x + 0.2, y: shoulder.y + Math.tan(aim) * 0.2 + 0.08, w: 3, h: 0.4 };
    const layout = { ...base, solids: [{ label: 'floor', x: 0, y: 22, w: 64, h: 4 }, ledge], crates: [], pits: [], hazards: [], apples: [], pickups: [] };
    const world = new GameWorld(new Logger('test', () => {}));
    buildArena(world, layout);
    const p = world.addPlayer('x', { x: 10, y: 22 }, 1);
    world.setControls('x', { ...NO_CONTROLS, aim: { angle: aim } });
    for (let t = 0; t < 60; t++) world.step();
    // the floor goes: the whole body hangs from the forearm on the ledge until it slides off
    world.physics.forEachCollider((c) => {
      if (world.labelOf(c) === 'floor') world.physics.removeCollider(c, false);
    });
    let hooked = 0;
    let worst = -Infinity;
    for (let t = 0; t < 60; t++) {
      world.step();
      const touch = p.contactInfo().touch as Record<string, string[]>;
      if (!touch.armFrontLower?.includes('ledge')) continue;
      hooked++;
      worst = Math.max(worst, p.limitOver('elbowFront') ?? -Infinity);
    }
    expect(hooked).toBeGreaterThan(5);
    expect(worst).toBeLessThan(0.1);
    world.dispose();
  });

  // In the air, walking into a wall pressed the torso against it and friction held the whole body up there (sim
  // arena_fights: a bot pinned to Construction Site's pit wall hung on after the pin let go, walking into it for good).
  // No walk push now while the torso is pressed against a wall that way; a jump up a step (shins brushing its face)
  // still gets it (sim jump_reach, step_climb).
  it('walking into a wall in the air does not hold the body up there', () => {
    const { world, entries } = worldWithLog();
    // beside Test Lab's step_r4 (x 36-44, y 18-22, flush with the pit: x 28-36, floor y 25)
    const p = world.addPlayer('x', { x: 35.75, y: 21 }, 1);
    world.setControls('x', { ...NO_CONTROLS, move: 1 });
    for (let t = 0; t < 180; t++) world.step();
    expect(entries.some((e) => e.ev === 'air_push_wall')).toBe(true);
    expect(p.center().y).toBeGreaterThan(23.5); // slid down to the pit floor (it hung at 20.6 before)
    world.dispose();
  });
});
