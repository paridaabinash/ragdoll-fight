import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARROW,
  blendSnapshots,
  buildArena,
  buildTestLevel,
  captureSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  GameWorld,
  GUN,
  initPhysics,
  launchPointFrom,
  launchVelocity,
  LOCAL_PLAYER,
  Logger,
  NET,
  parseClientMessage,
  PART_NAMES,
  PART_SHAPES,
  PHYSICS_HZ,
  raycastShapes,
  replayBuffer,
  sanitizeName,
  seededRandom,
  shoulderFrontFrom,
  SnapshotBuffer,
  traceArrow,
  type PlacedShape,
  type SnapshotData,
} from '../src';

beforeAll(() => initPhysics());

function makeWorld(settle = 120) {
  const world = new GameWorld(new Logger('test', () => {}));
  buildTestLevel(world);
  for (let i = 0; i < settle; i++) world.step();
  return world;
}

/** What the online client knows about the scene: statics + movables + other players' parts. */
function sceneShapes(world: GameWorld, ignore: string): PlacedShape[] {
  const out: PlacedShape[] = world.staticShapes().map((s) => ({ ...s }));
  for (const m of world.movableBodies()) {
    if (!m.collider.isEnabled()) continue;
    const t = m.body.translation();
    out.push({ label: m.label, shape: m.shape, pos: { x: t.x, y: t.y }, angle: m.body.rotation() });
  }
  for (const [id, p] of world.players) {
    if (id === ignore) continue;
    for (const n of PART_NAMES) {
      const b = p.parts[n];
      out.push({ label: `${id}:${n}`, shape: PART_SHAPES[n], pos: { ...b.translation() }, angle: b.rotation() });
    }
  }
  return out;
}

describe('online preview math', () => {
  it('ray tests on plain shapes agree with Rapier on the whole level', () => {
    const world = makeWorld();
    const shapes = sceneShapes(world, LOCAL_PLAYER);
    let compared = 0;
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 400; i++) {
      const from = { x: rand() * 32, y: rand() * 17 };
      const to = { x: from.x + (rand() - 0.5) * 8, y: from.y + (rand() - 0.5) * 8 };
      const mine = raycastShapes(from, to, shapes);
      const rapier = world.raycast(from, to, LOCAL_PLAYER);
      expect(mine?.label ?? null).toBe(rapier?.label ?? null);
      if (mine && rapier) {
        expect(Math.hypot(mine.point.x - rapier.point.x, mine.point.y - rapier.point.y)).toBeLessThan(1e-3);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(50);
  });

  it('the client preview (shared shoulder math + traceArrow) matches the world preview', () => {
    const world = makeWorld();
    const me = world.player(LOCAL_PLAYER);
    const shapes = sceneShapes(world, LOCAL_PLAYER);
    for (const angle of [-0.1, -0.3, -0.6, -0.9]) {
      const aim = { angle };
      const exact = world.previewShot(LOCAL_PLAYER, aim);
      const t = me.parts.torso;
      const start = launchPointFrom(shoulderFrontFrom(t.translation(), t.rotation()), aim);
      const client = traceArrow(start, launchVelocity(aim), (a, b) => raycastShapes(a, b, shapes), world.bounds);
      expect(client.hit?.label).toBe(exact.hit?.label);
      expect(client.ticks).toBe(exact.ticks);
    }
  });
});

describe('snapshots', () => {
  it('pack and unpack with ~4 mm / ~0.0001 rad error, and stay small', () => {
    const world = makeWorld();
    world.fire(LOCAL_PLAYER, { angle: -0.3 });
    for (let i = 0; i < 10; i++) world.step();
    const snap = captureSnapshot(world, world.movableBodies());
    const bytes = encodeSnapshot(snap);
    const back = decodeSnapshot(bytes)!;
    expect(back.tick).toBe(snap.tick);
    expect(back.players.map((p) => p.slot)).toEqual(snap.players.map((p) => p.slot));
    for (let i = 0; i < snap.players.length; i++) {
      for (let k = 0; k < PART_NAMES.length; k++) {
        const a = snap.players[i].parts[k];
        const b = back.players[i].parts[k];
        expect(Math.abs(a.x - b.x)).toBeLessThan(1 / NET.posScale);
        expect(Math.abs(Math.atan2(Math.sin(a.a - b.a), Math.cos(a.a - b.a)))).toBeLessThan(2e-4);
      }
      expect(back.players[i].alive).toBe(snap.players[i].alive);
      expect(back.players[i].facing).toBe(snap.players[i].facing);
      expect(back.players[i].reload).toBe(snap.players[i].reload); // L3: ticks until the gun is ready
    }
    expect(snap.players.find((p) => p.slot === world.slotOf(LOCAL_PLAYER))!.reload).toBe(GUN.reloadTicks - 10);
    expect(back.arrows).toHaveLength(1);
    expect(back.arrows[0].id).toBe(snap.arrows[0].id);
    expect(back.bodies).toHaveLength(snap.bodies.length);
    expect(bytes.byteLength).toBeLessThan(250); // 2 players, 5 bodies, 1 arrow
  });

  it('rejects garbage', () => {
    expect(decodeSnapshot(new Uint8Array([9, 9, 9]))).toBeNull();
    const ok = encodeSnapshot({ tick: 1, headScale: 1, players: [], bodies: [], arrows: [], props: [] });
    expect(decodeSnapshot(ok.slice(0, ok.length - 1))).toBeNull();
  });
});

describe('smoothing', () => {
  const snap = (tick: number, x: number, a: number): SnapshotData => ({
    tick,
    headScale: 1,
    players: [],
    bodies: [{ index: 0, enabled: true, holds: null, pose: { x, y: 0, a } }],
    arrows: [],
    props: [],
  });

  it('blends angles the short way round', () => {
    const mid = blendSnapshots(snap(0, 0, 3.1), snap(3, 0, -3.1), 0.5);
    expect(Math.abs(Math.cos(mid.bodies[0].pose.a) + 1)).toBeLessThan(0.01); // ~±π, not ~0
  });

  it('shows the world 100 ms behind the newest snapshot and blends between snapshots', () => {
    const buf = new SnapshotBuffer();
    for (let i = 0; i <= 10; i++) buf.push(snap(i * 3, i, 0), i * 50); // 20/s, perfectly on time
    const now = 500;
    expect(buf.renderTick(now)).toBeCloseTo(30 - NET.interpDelayTicks, 5);
    const s = buf.sample(now + 25)!;
    expect(s.bodies[0].pose.x).toBeCloseTo(8.5, 5);
    expect(buf.stats.underruns).toBe(0);
  });

  // The same judge netsim `lag` uses: a 20/s stream, one-way delay 60 ms + random jitter, order kept, perfect clock.
  it('the 100 ms buffer covers 40 ms of jitter and visibly runs dry beyond it', () => {
    const dryPct = (jitterMs: number, seed: number) => {
      const rand = seededRandom(seed);
      let last = -Infinity;
      const arrivals = Array.from({ length: 400 }, (_, i) => {
        const tick = i * NET.snapshotEveryTicks;
        return { snap: snap(tick, 0, 0), atMs: (last = Math.max(last, (tick * 1000) / PHYSICS_HZ + 60 + rand() * jitterMs)) };
      });
      const r = replayBuffer(arrivals, 1000 / 60, 2000, 19000);
      expect(r.frames).toBeGreaterThan(1000);
      return (100 * r.underruns) / r.frames;
    };
    for (const seed of [1, 2, 3]) {
      expect(dryPct(40, seed)).toBe(0); // netsim lag: 120±40 ms
      expect(dryPct(80, seed)).toBeGreaterThan(1); // so netsim's 1% limit would catch a buffer that's too short
    }
  });
});

describe('client messages', () => {
  it('accepts good messages and rejects bad ones', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 1, aim: 0.2, crouch: false, jump: true, move: -1 }))).toMatchObject({ t: 'input', aim: 0.2, move: -1 });
    expect(parseClientMessage('{nope')).toEqual({ error: 'not_json' });
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 1, aim: [0.2, 0.5], crouch: false, jump: false, move: 0 }))).toEqual({ error: 'bad_input' }); // L3: the bow's [angle, power]
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 1, aim: 'x', crouch: false, jump: false, move: 0 }))).toEqual({ error: 'bad_input' });
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 1, aim: null, crouch: false, jump: false, move: 2 }))).toEqual({ error: 'bad_input' });
    // L3: fire = angle; an old client's power / swing tick (L7) / a claimed special is simply not copied
    expect(parseClientMessage(JSON.stringify({ t: 'fire', seq: 2, angle: 0.5, swing: 120, power: 1.5, kind: 'glove' }))).toEqual({ t: 'fire', seq: 2, angle: 0.5 });
    expect(parseClientMessage(JSON.stringify({ t: 'fire', seq: 2, angle: 'x' }))).toEqual({ error: 'bad_fire' });
    expect(parseClientMessage(JSON.stringify({ t: 'hack' }))).toEqual({ error: 'unknown_type' });
  });
  it('join can name a room or ask for a new one; anything else is refused', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'join', v: 2, name: 'a', room: 'r12' }))).toMatchObject({ t: 'join', room: 'r12' });
    expect(parseClientMessage(JSON.stringify({ t: 'join', v: 2, name: 'a', room: 'new' }))).toMatchObject({ room: 'new' });
    expect(parseClientMessage(JSON.stringify({ t: 'join', v: 2, name: 'a' }))).not.toHaveProperty('room');
    expect(parseClientMessage(JSON.stringify({ t: 'join', v: 2, name: 'a', room: '../x' }))).toEqual({ error: 'bad_room' });
    expect(parseClientMessage(JSON.stringify({ t: 'join', v: 2, name: 'a', room: 5 }))).toEqual({ error: 'bad_room' });
  });
  it('cleans names', () => {
    expect(sanitizeName('  <b>Ana</b>!!  ')).toBe('bAnab');
    expect(sanitizeName('')).toBe('archer');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(NET.nameMaxLength);
  });
});

describe('shots start at the shoulder', () => {
  it("standing against a wall, the bullet hits the wall instead of starting on the far side", () => {
    const world = new GameWorld(new Logger('test', () => {}));
    buildArena(world);
    world.addPlayer('x', { x: 12.3, y: 17 }, -1); // right against the thin wall (x 12); gun hand would be at ~11.5
    const aim = { angle: -3.01 };
    const hand = world.player('x').launchPoint(aim);
    expect(hand.x).toBeLessThan(11.95); // the hand really is past the wall
    const preview = world.previewShot('x', aim);
    expect(preview.hit?.label).toBe('thin_wall');
    expect(preview.ticks).toBe(0);
    const arrow = world.fire('x', aim).arrow!;
    expect(arrow.state).toBe('gone'); // L3: it vanished in the wall at once
    expect(world.takeEvents().find((e) => e.type === 'impact')).toMatchObject({ on: 'wall' });
  });

  it('an enemy right in front (closer than the gun hand) takes the hit', () => {
    const sink: { ev: string; [k: string]: unknown }[] = [];
    const world = new GameWorld(new Logger('test', (e) => void sink.push(e)));
    buildArena(world);
    world.addPlayer('a', { x: 6, y: 17 }, 1);
    world.addPlayer('b', { x: 6.5, y: 17 }, -1); // players pass through each other, so they can stand this close
    world.fire('a', { angle: 0 });
    const dmg = sink.find((e) => e.ev === 'damage');
    expect(dmg?.id).toBe('b');
    expect(dmg?.by).toBe('a');
  });
});

describe('players joining and leaving', () => {
  it('spawns are clear of each other, slots are reused, leaving removes the body', () => {
    const world = makeWorld(10);
    const a = world.spawnPlayer('a');
    const b = world.spawnPlayer('b');
    expect(Math.abs(a.center().x - b.center().x)).toBeGreaterThan(1);
    const slotA = world.slotOf('a');
    world.removePlayer('a');
    expect(world.players.has('a')).toBe(false);
    world.spawnPlayer('c');
    expect(world.slotOf('c')).toBe(slotA);
    for (let i = 0; i < ARROW.maxFlightTicks / 10; i++) world.step();
  });
});
