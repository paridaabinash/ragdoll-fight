import { beforeAll, describe, expect, it } from 'vitest';
import { GameRoom, type Conn } from '../../server/src/room';
import {
  buildArena,
  buildTestLevel,
  DUMMY_PLAYER,
  GameWorld,
  GUN,
  initPhysics,
  launchPointFrom,
  LOCAL_PLAYER,
  Logger,
  NO_CONTROLS,
  RAGDOLL,
  SPECIAL,
  STAMINA,
  type GameEvent,
  type LogEntry,
  type ServerMessage,
} from '../src';
import { shoot } from './gun-helpers';

beforeAll(() => initPhysics());

/** The test range (p1 at x 4 facing p2 at x 29), settled. */
function range(settle = 60) {
  const log: LogEntry[] = [];
  const world = new GameWorld(new Logger('test', (e) => void log.push(e)));
  buildTestLevel(world);
  for (let i = 0; i < settle; i++) world.step();
  return { world, log };
}

const DOWN_INTO_GROUND = { angle: 0.6 }; // a fixed target right in front of p1

describe('L3 gun: reload and stamina (shared rules)', () => {
  it('a shot starts a 0.7 s reload: earlier shots are refused (fire_too_soon), then it fires again; reload_done is logged', () => {
    const { world, log } = range();
    const first = world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND);
    expect(first.arrow).not.toBeNull();
    const t0 = world.tick;
    world.step();
    expect(world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND)).toEqual({ arrow: null, refused: 'fire_too_soon' });
    expect(log.find((e) => e.ev === 'fire_too_soon')).toMatchObject({ owner: LOCAL_PLAYER, ticksLeft: GUN.reloadTicks - 1 });
    while (world.tick < t0 + GUN.reloadTicks - 1) world.step();
    expect(world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND).refused).toBe('fire_too_soon'); // one tick early
    world.step();
    expect(log.find((e) => e.ev === 'reload_done')).toMatchObject({ id: LOCAL_PLAYER });
    expect(world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND).arrow).not.toBeNull(); // exactly on time
    expect(log.some((e) => e.ev === 'shots_too_close')).toBe(false);
    world.dispose();
  });

  it('each shot costs 12 stamina; holding fire empties it (arms down) after 9 shots, with no refill in between', () => {
    const { world, log } = range();
    const st = world.playerStats(LOCAL_PLAYER);
    const after: number[] = [];
    for (let shot = 0; shot < 12 && !st.armsDown; shot++) {
      expect(world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND).arrow).not.toBeNull();
      after.push(Math.round(st.stamina));
      for (let i = 0; i < GUN.reloadTicks; i++) world.step(); // fire again the moment it's reloaded
    }
    expect(after).toEqual([88, 76, 64, 52, 40, 28, 16, 4, 0]);
    expect(st.armsDown).toBe(true);
    expect(world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND).refused).toBe('arms_down');
    expect(log.some((e) => e.ev === 'stamina_empty')).toBe(true);
    // arms come back once it has refilled to STAMINA.recoverAt (rest after the last reload, then 30/s)
    for (let i = 0; i < 120 && st.armsDown; i++) world.step();
    expect(st.armsDown).toBe(false);
    expect(world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND).arrow).not.toBeNull();
    world.dispose();
  });

  it('refusal reasons: invalid aim, dead, match over, laughing; a respawned gun is ready at once', () => {
    const { world } = range();
    expect(world.fire(LOCAL_PLAYER, { angle: Infinity }).refused).toBe('invalid_aim');
    world.effects.get(LOCAL_PLAYER)!.add('laugh', 'torso', world.tick);
    expect(world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND).refused).toBe('laughing');
    world.effects.get(LOCAL_PLAYER)!.remove('laugh');
    world.frozen = true;
    expect(world.fire(LOCAL_PLAYER, DOWN_INTO_GROUND).refused).toBe('match_over');
    world.frozen = false;
    const st = world.playerStats(DUMMY_PLAYER);
    st.markDead(world.tick);
    expect(world.fire(DUMMY_PLAYER, { angle: Math.PI }).refused).toBe('dead');
    st.revive(world.tick);
    expect(st.reloadLeft(world.tick)).toBe(0);
    world.dispose();
  });
});

describe('L3 gun: the arms always aim', () => {
  it('with no aim input the gun arm points straight ahead; arms down lowers it; the launch point is the same', () => {
    const { world } = range(10);
    const p = world.player(LOCAL_PLAYER);
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    for (let i = 0; i < 40; i++) world.step();
    const pointing = p.parts.armFrontUpper.rotation() + Math.PI / 2; // a hanging arm has rotation 0
    expect(Math.abs(pointing)).toBeLessThan(0.15); // facing right: straight ahead = 0
    const st = world.playerStats(LOCAL_PLAYER);
    st.stamina = 0;
    st.armsDown = true;
    for (let i = 0; i < 60; i++) {
      st.stamina = 0;
      world.step();
    }
    expect(p.mods.armsDown).toBe(true);
    expect(Math.abs(p.parts.armFrontUpper.rotation())).toBeLessThan(0.6); // hanging (roughly down)
    // the shot still starts one arm's length along the aim from the shoulder, wherever the floppy hand is
    const aim = { angle: -0.4 };
    expect(world.previewShot(LOCAL_PLAYER, aim).points[0]).toEqual(launchPointFrom(p.jointPos('shoulderFront'), aim));
    world.dispose();
  });
});

describe('L3 gun: bullets vanish on impact', () => {
  it('a wall hit leaves nothing in the world, only an impact (a bullet hole + dust on screens)', () => {
    const { world, log } = range();
    const a = shoot(world, LOCAL_PLAYER, DOWN_INTO_GROUND);
    const events: GameEvent[] = [];
    for (let i = 0; i < 60 && a.state === 'flying'; i++) {
      world.step();
      events.push(...world.takeEvents());
    }
    expect(a.state).toBe('gone');
    expect(world.arrows).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'impact', on: 'wall' }));
    expect(log.find((e) => e.ev === 'arrow_hit' && e.id === a.id)?.target).toBe('ground');
    world.dispose();
  });

  it('a body hit leaves nothing stuck in the body (no impact event: the damage event is the hit)', () => {
    const { world } = range();
    world.relocate(LOCAL_PLAYER, { x: 20, y: 17 }, 1);
    for (let i = 0; i < 60; i++) world.step();
    const a = shoot(world, LOCAL_PLAYER, { angle: -0.05 });
    const events: GameEvent[] = [];
    for (let i = 0; i < 60 && a.state === 'flying'; i++) {
      world.step();
      events.push(...world.takeEvents());
    }
    expect(events.some((e) => e.type === 'damage' && e.id === DUMMY_PLAYER)).toBe(true);
    expect(events.some((e) => e.type === 'impact')).toBe(false);
    expect(world.arrows).toHaveLength(0);
    world.dispose();
  });

  it('a plunger that misses vanishes; one that catches someone stays stuck while its rope pulls, then goes', () => {
    const { world, log } = range();
    world.playerStats(LOCAL_PLAYER).held = 'plunger';
    const miss = shoot(world, LOCAL_PLAYER, DOWN_INTO_GROUND);
    for (let i = 0; i < 30 && miss.state === 'flying'; i++) world.step();
    expect(miss.state).toBe('gone');
    world.relocate(LOCAL_PLAYER, { x: 20, y: 17 }, 1);
    for (let i = 0; i < 60; i++) world.step();
    world.playerStats(LOCAL_PLAYER).held = 'plunger';
    const hit = shoot(world, LOCAL_PLAYER, { angle: -0.05 });
    for (let i = 0; i < 30 && hit.state === 'flying'; i++) world.step();
    expect(hit.state).toBe('stuck');
    for (let i = 0; i < SPECIAL.plunger.ticks + 2; i++) world.step();
    expect(hit.state).toBe('gone');
    expect(world.arrows).toHaveLength(0);
    expect(log.some((e) => e.ev === 'projectile_after_hit')).toBe(false);
    world.dispose();
  });

  it('a projectile left stuck after its hit is an anomaly (and is removed)', () => {
    const { world, log } = range();
    const a = shoot(world, LOCAL_PLAYER, DOWN_INTO_GROUND);
    a.state = 'stuck'; // what the old bow did with every arrow
    world.step();
    expect(log.find((e) => e.ev === 'projectile_after_hit')).toMatchObject({ lvl: 'error', kind: 'normal' });
    expect(world.arrows).toHaveLength(0);
    world.dispose();
  });

  it('Big Head Mode: ray tests see the bigger heads at once (one zero step used to leave them seeing nothing)', () => {
    const { world } = range();
    world.setBigHeads(true);
    expect(world.previewShot(LOCAL_PLAYER, DOWN_INTO_GROUND).hit?.label).toBe('ground');
    const head = world.player(DUMMY_PLAYER).parts.head.translation();
    const hit = world.raycast({ x: head.x, y: head.y - 1 }, { x: head.x, y: head.y }, 'nobody');
    expect(hit?.label).toBe(`${DUMMY_PLAYER}:head`);
    expect(head.y - hit!.point.y).toBeCloseTo(RAGDOLL.head.r * world.headScale, 1);
    world.dispose();
  });
});

describe('L3 gun online: the room', () => {
  function room() {
    const log: LogEntry[] = [];
    const replies: Extract<ServerMessage, { t: 'shot' }>[] = [];
    const conn: Conn = {
      send(d) {
        if (typeof d !== 'string') return;
        const m = JSON.parse(d) as ServerMessage;
        if (m.t === 'shot') replies.push(m);
      },
      close() {},
      bufferedAmount: 0,
    };
    const r = new GameRoom('t1', (e) => void log.push(e), () => {}, { bots: false });
    const id = r.join(conn, 'gunner');
    for (let i = 0; i < 60; i++) r.tick();
    let seq = 0;
    const send = (m: object) => r.handleText(id, JSON.stringify({ ...m, seq: seq++ }));
    const ticks = (n: number) => {
      for (let i = 0; i < n; i++) r.tick();
    };
    return { r, id, log, replies, send, ticks };
  }

  it('the fire message has no power: a shot is an angle (L7: no swing tick), refused if it comes too soon', () => {
    const { r, log, replies, send, ticks } = room();
    send({ t: 'fire', angle: 0.6 });
    ticks(10);
    send({ t: 'fire', angle: 0.6 }); // 32 ticks early: refused
    expect(replies.map((m) => m.reason ?? 'ok')).toEqual(['ok', 'fire_too_soon']);
    expect(log.some((e) => e.ev === 'fire_too_soon')).toBe(true);
    r.close();
  });

  it('a shot that arrives a few ticks early (network jitter) is kept and fired on the reload tick', () => {
    const { r, id, log, replies, send, ticks } = room();
    send({ t: 'fire', angle: 0.6 });
    const t0 = r.world.tick;
    ticks(GUN.reloadTicks - 3);
    send({ t: 'fire', angle: 0.6 }); // 3 ticks early
    expect(log.find((e) => e.ev === 'fire_queued')).toMatchObject({ id, earlyBy: 3 });
    expect(replies).toHaveLength(1);
    ticks(3);
    expect(replies.map((m) => m.reason ?? 'ok')).toEqual(['ok', 'ok']);
    const fires = log.filter((e) => e.ev === 'fire' && e.owner === id);
    expect(Number(fires[1].tick) - Number(fires[0].tick)).toBe(GUN.reloadTicks);
    expect(r.world.playerStats(id).lastShotTick).toBe(t0 + GUN.reloadTicks);
    r.close();
  });

  it('spamming fire gets one shot per reload, never more', () => {
    const { r, id, log, send, ticks } = room();
    for (let t = 0; t < 200; t++) {
      if (t % 4 === 0) send({ t: 'fire', angle: 0.6 });
      ticks(1);
    }
    const fires = log.filter((e) => e.ev === 'fire' && e.owner === id).map((e) => Number(e.tick));
    for (let i = 1; i < fires.length; i++) expect(fires[i] - fires[i - 1]).toBeGreaterThanOrEqual(GUN.reloadTicks);
    expect(fires.length).toBeGreaterThanOrEqual(4);
    expect(log.some((e) => e.ev === 'shots_too_close')).toBe(false);
    r.close();
  });

  it('L7: with a hit arm the server fires exactly the angle sent (no swing): preview = real bullet', () => {
    const { r, id, log, send, ticks } = room();
    const world = r.world;
    world.effects.get(id)!.add('arm', 'armFrontUpper', world.tick);
    world.setControls(id, NO_CONTROLS);
    ticks(1);
    const aim = { angle: 0.7 };
    const preview = world.previewShot(id, aim);
    send({ t: 'fire', angle: aim.angle, swing: world.tick - 9 }); // (an old client's swing tick: ignored)
    const fire = log.find((e) => e.ev === 'fire' && e.owner === id)!;
    const bullet = world.arrows.find((a) => a.id === fire.id)!;
    expect(bullet.angle).toBeCloseTo(aim.angle, 9);
    for (let i = 0; i < 60 && bullet.state === 'flying'; i++) ticks(1);
    const hit = log.find((e) => e.ev === 'arrow_hit' && e.id === fire.id)!;
    expect(hit.target).toBe(preview.hit?.label);
    expect(hit.predErr).toBe(0);
    expect(log.some((e) => e.ev === 'swing_ok' || e.ev === 'swing_clamped')).toBe(false);
    r.close();
  });

});

describe('L3 gun: stamina numbers', () => {
  it('the start values: 32 m/s, 0.7 s reload, 12 per shot of 100', () => {
    expect(GUN.bulletSpeed).toBe(32);
    expect(GUN.reloadTicks).toBe(42);
    expect(GUN.staminaPerShot / STAMINA.max).toBeCloseTo(0.12);
    expect(GUN.previewTicks).toBe(30);
  });

  it('Backyard players face each other across the thin wall: point-blank shots never pass through it', () => {
    const world = new GameWorld(new Logger('test', () => {}));
    buildArena(world);
    world.addPlayer('x', { x: 12.3, y: 17 }, -1);
    const a = world.fire('x', { angle: Math.PI }).arrow!;
    expect(a.state).toBe('gone');
    world.dispose();
  });
});
