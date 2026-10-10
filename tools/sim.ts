/**
 * Headless mechanics check: `npm run sim`  (or `npm run sim -- stand jump` for some scenarios)
 * Plays scripted scenarios with no browser and writes every event to logs/sim-latest.jsonl.
 * Prints one summary line per scenario and exits with code 1 if anything looks wrong.
 */
import {
  ARENAS,
  arenaLayout,
  ARROW,
  buildArena,
  buildTestLevel,
  DUMMY_PLAYER,
  GameWorld,
  GRAVITY_Y,
  GROUND_Y,
  GUN,
  initPhysics,
  LOCAL_PLAYER,
  LIMIT_CHECK,
  Logger,
  MELEE,
  PART_NAMES,
  REACH,
  ROTATION,
  seededRandom,
  NO_CONTROLS,
  SPECIAL,
  HIT_REACTION,
  r2,
  PART_SHAPES,
  r3,
  STAMINA,
  BACKYARD,
  TEST_LAB,
  WALK,
  wrapAngle,
  type Aim,
  type Arrow,
  type Controls,
  type EffectKind,
  type LogEntry,
  type PartName,
  type Ragdoll,
  type SpecialKind,
  traceShot,
} from '../shared/src';
import { GameRoom, type Conn, type RoomOptions } from '../server/src/room';
import { DEFAULT_ROOM_SETTINGS, GAME_MODES, ROUND } from '@ragdoll/shared';
import { botFight } from './fight';
import { fileSink } from './log-files';

await initPhysics();

const file = fileSink('sim');
const entries: LogEntry[] = [];
const sink = (e: LogEntry) => {
  entries.push(e);
  file(e);
};
const deg = (d: number) => (d * Math.PI) / 180;
const problems: string[] = [];
const only = process.argv.slice(2);

function check(ok: boolean, msg: string): void {
  if (!ok) problems.push(msg);
}

function freshWorld(scenario: string, level = true): GameWorld {
  const world = new GameWorld(new Logger('sim', sink));
  world.log.info('scenario_start', { scenario });
  if (level) buildTestLevel(world);
  return world;
}

function run(world: GameWorld, ticks: number, each?: (tick: number) => void): void {
  for (let i = 0; i < ticks; i++) {
    world.step();
    each?.(i);
  }
}

/**
 * L3: fires with the gun ready and full stamina, for scenarios about flight, hits and effects (the reload and stamina
 * rules have their own scenarios: `stamina`, `gun`). Null if refused anyway (dead, laughing...).
 */
function readyShot(world: GameWorld, id: string, aim: Aim): Arrow | null {
  const st = world.stats.get(id);
  if (st) {
    st.readyAt = world.tick;
    st.lastShotTick = -Infinity;
    if (st.stamina < GUN.staminaPerShot) st.refill(STAMINA.max);
    st.armsDown = false;
  }
  return world.fire(id, aim).arrow;
}

function shoot(world: GameWorld, aim: Aim): LogEntry | undefined {
  const arrow = readyShot(world, LOCAL_PLAYER, aim);
  if (!arrow) return undefined;
  for (let i = 0; i < ARROW.maxFlightTicks + 5 && arrow.state === 'flying'; i++) world.step();
  return entries.findLast((e) => (e.ev === 'arrow_hit' || e.ev === 'arrow_lost') && e.id === arrow.id);
}

/**
 * Finds an aim whose preview hits a collider whose label passes `want`.
 * Picks the MIDDLE of the first run of angles that hit, not the edge, so small movement of the target doesn't make it miss.
 */
function findAim(world: GameWorld, want: (label: string) => boolean, minAngle = -89): Aim | null {
  // (L3: one bullet speed, so reaching over things takes steep lobs: search up to nearly straight up)
  const run: number[] = [];
  for (let a = 0; a >= minAngle; a -= 0.1) {
    const hit = world.previewShot(LOCAL_PLAYER, { angle: deg(a) }).hit;
    if (hit && want(hit.label)) run.push(a);
    else if (run.length) break;
  }
  return run.length ? { angle: deg(run[Math.floor(run.length / 2)]) } : null;
}

/** Holds the given controls for `ticks` ticks. */
function hold(world: GameWorld, id: string, c: Partial<Controls>, ticks: number, each?: (tick: number) => void): void {
  world.setControls(id, { ...NO_CONTROLS, ...c });
  run(world, ticks, each);
}

const tilt = (r: Ragdoll) => Math.abs(wrapAngle(r.parts.torso.rotation()));
const headY = (r: Ragdoll) => r.parts.head.translation().y;
const since = (mark: number) => entries.slice(mark);
const count = (mark: number, ev: string) => since(mark).filter((e) => e.ev === ev).length;

const scenarios: Record<string, () => void> = {
  // Preview must match every hit on a fixed target.
  sweep() {
    const world = freshWorld('sweep');
    run(world, 60);
    let shots = 0;
    let compared = 0;
    for (let angle = 10; angle >= -88; angle -= 3.5) {
      const res = shoot(world, { angle: deg(angle) });
      shots++;
      if (res?.ev !== 'arrow_hit' || res.moving || res.predMoving) continue;
      compared++;
      check(res.predErr === 0 && res.predTickErr === 0, `sweep: preview mismatch at ${angle}deg: predErr=${res.predErr} predTickErr=${res.predTickErr}`);
    }
    console.log(`sweep:     ${shots} shots, ${compared} hits on fixed targets compared with the preview`);
    world.dispose();
  },

  thin_wall() {
    const world = freshWorld('thin_wall');
    run(world, 60);
    const res = shoot(world, { angle: deg(-2) });
    console.log(`thin_wall: bullet hit ${res?.target}`);
    check(res?.target === 'thin_wall', `thin_wall: a bullet passed the thin wall (hit ${res?.target})`);
    world.dispose();
  },

  // Stands still for 30 s: must not fall, drift, or shake.
  stand() {
    const world = freshWorld('stand');
    const p = world.player(LOCAL_PLAYER);
    const mark = entries.length;
    let maxTilt = 0;
    let minHead = Infinity;
    let maxHead = -Infinity;
    run(world, 120); // settle
    const x0 = p.center().x;
    run(world, 1800, () => {
      maxTilt = Math.max(maxTilt, tilt(p));
      minHead = Math.min(minHead, headY(p));
      maxHead = Math.max(maxHead, headY(p));
    });
    const drift = Math.abs(p.center().x - x0);
    const headHeight = GROUND_Y - maxHead;
    console.log(`stand:     30 s, max tilt ${r2(maxTilt)} rad, head height ${r2(headHeight)} m, head bob ${r3(maxHead - minHead)} m, drift ${r3(drift)} m, falls ${count(mark, 'ragdoll_fall')}`);
    check(count(mark, 'ragdoll_fall') === 0, 'stand: ragdoll fell over while standing');
    check(maxTilt < 0.15, `stand: torso tilts too much (${r2(maxTilt)} rad)`);
    check(maxHead - minHead < 0.05, `stand: body bobs/shakes (${r3(maxHead - minHead)} m)`);
    check(drift < 0.1, `stand: slides along the ground (${r3(drift)} m)`);
    check(headHeight > 1.9, `stand: sags, head only ${r2(headHeight)} m up`);
    world.dispose();
  },

  crouch() {
    const world = freshWorld('crouch');
    const p = world.player(LOCAL_PLAYER);
    run(world, 120);
    const standY = headY(p);
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, crouch: true });
    run(world, 60);
    const crouchY = headY(p);
    const crouchTilt = tilt(p);
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    run(world, 90);
    const backY = headY(p);
    console.log(`crouch:    head drops ${r2(crouchY - standY)} m (tilt ${r2(crouchTilt)}), back up within ${r3(Math.abs(backY - standY))} m`);
    check(crouchY - standY > 0.4, `crouch: head only drops ${r2(crouchY - standY)} m`);
    check(!p.down, 'crouch: fell over');
    check(Math.abs(backY - standY) < 0.05, `crouch: doesn't stand back up (off by ${r3(backY - standY)} m)`);
    world.dispose();
  },

  jump() {
    const world = freshWorld('jump');
    const p = world.player(LOCAL_PLAYER);
    run(world, 120);
    const mark = entries.length;
    // (held: L2's tap-or-hold makes a one-tick tap a short hop)
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true });
    run(world, 20);
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    run(world, 131);
    const lands = since(mark).filter((e) => e.ev === 'land');
    const land = lands[0];
    const rebound = Math.max(0, ...lands.slice(1).map((e) => Number(e.rise)));
    console.log(`jump:      jumps ${count(mark, 'jump')}, rise ${land?.rise} m, air ${land?.airTicks} ticks, lands with tilt ${land?.tilt}, rebound ${r3(rebound)} m, falls ${count(mark, 'ragdoll_fall')}`);
    check(rebound < 0.15, `jump: bounced back up ${r3(rebound)} m after landing`);
    check(count(mark, 'jump') === 1, 'jump: did not jump');
    check(typeof land?.rise === 'number' && land.rise > 0.8 && land.rise < 2.5, `jump: rise ${land?.rise} m is outside 0.8..2.5`);
    check(count(mark, 'ragdoll_fall') === 0 && !p.down, 'jump: fell over on landing');
    // pressing jump in the air must be refused and logged
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    run(world, 1);
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true });
    run(world, 2);
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    run(world, 3);
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true });
    run(world, 1);
    check(count(mark, 'jump_blocked') >= 1, 'jump: second press in the air was not refused');
    world.dispose();
  },

  // Bow arm must point where you aim, all the way round, turning to face the aim.
  aim() {
    const world = freshWorld('aim');
    const p = world.player(LOCAL_PLAYER);
    run(world, 120);
    let worst = 0;
    let worstAt = 0;
    const mark = entries.length;
    for (let a = 0; a < 360; a += 30) {
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, aim: { angle: deg(a) } });
      run(world, 30); // 0.5 s to get there
      const pointing = p.parts.armFrontUpper.rotation() + Math.PI / 2;
      const err = Math.abs(wrapAngle(pointing - deg(a)));
      if (err > worst) [worst, worstAt] = [err, a];
    }
    world.setControls(LOCAL_PLAYER, NO_CONTROLS);
    run(world, 120);
    console.log(`aim:       12 directions, worst arm error ${r2(worst)} rad at ${worstAt}deg, turns ${count(mark, 'facing_flip')}, falls ${count(mark, 'ragdoll_fall')}`);
    check(worst < 0.15, `aim: arm misses the aim by ${r2(worst)} rad at ${worstAt}deg`);
    check(count(mark, 'facing_flip') >= 1, 'aim: never turned around');
    check(count(mark, 'ragdoll_fall') === 0, 'aim: fell over while aiming');
    world.dispose();
  },

  // Leg hit must trip the dummy; it must get back up.
  trip() {
    const world = freshWorld('trip');
    // L3: at 32 m/s the thin wall hides p2's legs from p1's spot (lobs land on the head): step past it first
    world.relocate(LOCAL_PLAYER, { x: 18, y: GROUND_Y }, 1);
    run(world, 120);
    const aim = findAim(world, (l) => l.startsWith(`${DUMMY_PLAYER}:leg`));
    check(aim !== null, 'trip: no aim found that hits the dummy leg');
    if (!aim) return;
    const mark = entries.length;
    const res = shoot(world, aim);
    run(world, 360);
    const fall = since(mark).find((e) => e.ev === 'ragdoll_fall' && e.id === DUMMY_PLAYER);
    const up = since(mark).find((e) => e.ev === 'ragdoll_up' && e.id === DUMMY_PLAYER);
    console.log(`trip:      hit ${res?.target}, trips ${count(mark, 'trip')}, fell ${!!fall}, back up after ${up?.downTicks ?? '-'} ticks, upright now ${!world.player(DUMMY_PLAYER).down}`);
    check(String(res?.target).startsWith(`${DUMMY_PLAYER}:leg`), `trip: arrow hit ${res?.target}, not the leg`);
    check(count(mark, 'trip') === 1, 'trip: leg hit did not trip');
    check(!world.player(DUMMY_PLAYER).down, 'trip: dummy did not get back up within 6 s');
    world.dispose();
  },

  headshot() {
    const world = freshWorld('headshot');
    run(world, 120);
    const aim = findAim(world, (l) => l === `${DUMMY_PLAYER}:head`);
    check(aim !== null, 'headshot: no aim found that hits the dummy head');
    if (!aim) return;
    const res = shoot(world, aim);
    run(world, 240);
    console.log(`headshot:  hit ${res?.target} zone ${res?.zone}, push ${res?.impulse}, dummy upright after 4 s ${!world.player(DUMMY_PLAYER).down}`);
    check(res?.zone === 'head', `headshot: hit ${res?.target}`);
    world.dispose();
  },

  // Dropped from 4 m, tilted: must land, stay in one piece, and stand up.
  drop() {
    const world = freshWorld('drop', false);
    world.addBox('ground', 'fixed', { x: 16, y: GROUND_Y + 0.5 }, { x: 16, y: 0.5 });
    const p = world.addPlayer(LOCAL_PLAYER, { x: 16, y: GROUND_Y - 4 }, 1);
    world.push(p.parts.head, { x: 4, y: 0 }); // knock it into a tumble
    const mark = entries.length;
    run(world, 480);
    console.log(`drop:      lands, upright after 8 s ${!p.down}, tilt ${r2(tilt(p))}, joint problems ${count(mark, 'joint_over_limit') + count(mark, 'joint_stretched')}`);
    check(!p.down, 'drop: did not stand up within 8 s after a fall');
    world.dispose();
  },

  // ---- Phase 3 ----

  // Walk right, stop, walk left: reaches speed, stops without sliding, turns, never falls.
  walk() {
    const world = freshWorld('walk');
    run(world, 120);
    const mark = entries.length;
    let at1s = 0;
    let top = 0;
    hold(world, LOCAL_PLAYER, { move: 1 }, 120, (t) => {
      const vx = world.player(LOCAL_PLAYER).speedX();
      if (t === 59) at1s = vx;
      top = Math.max(top, vx);
    });
    const xStop = world.player(LOCAL_PLAYER).center().x;
    const walkHeight = GROUND_Y - world.player(LOCAL_PLAYER).parts.head.translation().y;
    let stopTicks = -1;
    hold(world, LOCAL_PLAYER, {}, 90, (t) => {
      if (stopTicks < 0 && Math.abs(world.player(LOCAL_PLAYER).speedX()) < 0.3) stopTicks = t;
    });
    const slide = world.player(LOCAL_PLAYER).center().x - xStop;
    hold(world, LOCAL_PLAYER, { move: -1 }, 90);
    const facingLeft = world.player(LOCAL_PLAYER).facing === -1;
    hold(world, LOCAL_PLAYER, {}, 60);
    const p = world.player(LOCAL_PLAYER);
    console.log(`walk:      speed ${r2(at1s)} m/s after 1 s (top ${r2(top)}), head ${r2(walkHeight)} m up while walking, stops in ${stopTicks} ticks, slides ${r3(slide)} m, turned left ${facingLeft}, falls ${count(mark, 'ragdoll_fall')}`);
    check(walkHeight > 1.75, `walk: sinks while walking (head only ${r2(walkHeight)} m up, 2 m standing)`);
    check(at1s >= WALK.speed * 0.9, `walk: only ${r2(at1s)} m/s after 1 s`);
    check(top < WALK.speed * 1.15, `walk: overshoots to ${r2(top)} m/s`);
    check(stopTicks >= 0 && stopTicks <= 30, `walk: takes ${stopTicks} ticks to stop`);
    check(Math.abs(slide) < 0.5, `walk: slides ${r3(slide)} m after letting go`);
    check(facingLeft, 'walk: did not turn to walk left');
    check(count(mark, 'ragdoll_fall') === 0 && !p.down, 'walk: fell over');
    check(count(mark, 'walk_start') === 2 && count(mark, 'walk_stop') === 2, 'walk: walk_start / walk_stop not logged twice each');
    world.dispose();
  },

  walk_aim() {
    // (on the long floor: at the L2 speed the Backyard's thin wall was reached within 2 s)
    const world = feelWorld('walk_aim');
    const mark = entries.length;
    const aim = { angle: deg(-20) };
    let speed = 0;
    let armErr = 0;
    hold(world, LOCAL_PLAYER, { move: 1, aim }, 120, (t) => {
      const p = world.player(LOCAL_PLAYER);
      if (t >= 60) {
        speed = Math.max(speed, p.speedX());
        armErr = Math.max(armErr, Math.abs(wrapAngle(p.parts.armFrontUpper.rotation() + Math.PI / 2 - aim.angle)));
      }
    });
    hold(world, LOCAL_PLAYER, { move: 1, crouch: true }, 120);
    const crouchSpeed = world.player(LOCAL_PLAYER).speedX();
    hold(world, LOCAL_PLAYER, {}, 60);
    console.log(`walk_aim:  aiming ${r2(speed)} m/s (arm error ${r2(armErr)} rad), crouching ${r2(crouchSpeed)} m/s, falls ${count(mark, 'ragdoll_fall')}`);
    const want = WALK.speed;
    check(Math.abs(speed - want) < 0.35, `walk_aim: ${r2(speed)} m/s while aiming, want ~${want}`);
    check(armErr < 0.2, `walk_aim: arm wobbles ${r2(armErr)} rad off the aim while walking`);
    check(Math.abs(crouchSpeed - WALK.speed * WALK.crouchFactor) < 0.35, `walk_aim: ${r2(crouchSpeed)} m/s while crouching`);
    check(count(mark, 'ragdoll_fall') === 0, 'walk_aim: fell over');
    world.dispose();
  },

  walk_jump() {
    const world = freshWorld('walk_jump');
    run(world, 120);
    const mark = entries.length;
    hold(world, LOCAL_PLAYER, { move: 1 }, 60);
    hold(world, LOCAL_PLAYER, { move: 1, jump: true }, 20); // held: a full jump
    hold(world, LOCAL_PLAYER, { move: 1 }, 101);
    hold(world, LOCAL_PLAYER, {}, 60);
    // (funny legs: a run bounds, so there are small landings before the jump: count from the jump on)
    const jumpTick = Number(since(mark).find((e) => e.ev === 'jump')?.tick ?? 0);
    const lands = since(mark).filter((e) => e.ev === 'land' && Number(e.tick) > jumpTick);
    const rebound = Math.max(0, ...lands.slice(1).map((e) => Number(e.rise)));
    console.log(`walk_jump: rise ${lands[0]?.rise} m, rebound ${r3(rebound)} m, falls ${count(mark, 'ragdoll_fall')}`);
    check(count(mark, 'jump') === 1, 'walk_jump: did not jump');
    check(count(mark, 'ragdoll_fall') === 0 && !world.player(LOCAL_PLAYER).down, 'walk_jump: fell over');
    check(rebound < 0.15, `walk_jump: bounced ${r3(rebound)} m`);
    world.dispose();
  },

  // Body hits do about 20, a full-power headshot 50 (L7: was a one-hit kill), a second headshot kills; the shooter gets the kill.
  damage() {
    const world = freshWorld('damage');
    run(world, 120);
    const torso = findAim(world, (l) => l === `${DUMMY_PLAYER}:torso`);
    check(torso !== null, 'damage: no full-power aim at the dummy torso');
    const mark = entries.length;
    if (torso) shoot(world, torso);
    const body = since(mark).find((e) => e.ev === 'damage');
    run(world, 120);
    const head = findAim(world, (l) => l === `${DUMMY_PLAYER}:head`);
    check(head !== null, 'damage: no full-power aim at the dummy head');
    const mark2 = entries.length;
    if (head) shoot(world, head);
    const headHit = since(mark2).find((e) => e.ev === 'damage');
    // (L7: hits knock the body now: wait until it has stopped swaying, or a ~1 s flight misses the moving head)
    run(world, 60);
    for (let i = 0; i < 300 && Math.hypot(world.player(DUMMY_PLAYER).speedX(), world.player(DUMMY_PLAYER).parts.head.linvel().y) > 0.05; i++) world.step();
    const head2 = findAim(world, (l) => l === `${DUMMY_PLAYER}:head`);
    if (head2) shoot(world, head2);
    const death = since(mark2).find((e) => e.ev === 'death');
    console.log(`damage:    torso hit ${body?.amount} (hp ${body?.hp}), headshot ${headHit?.amount}, then another: death ${death?.id} by ${death?.killer} (${death?.cause})`);
    check(typeof body?.amount === 'number' && body.amount > 15 && body.amount <= 20, `damage: full-power torso hit did ${body?.amount}`);
    check(typeof headHit?.amount === 'number' && headHit.amount > 40 && headHit.amount <= 50, `damage: full-power headshot did ${headHit?.amount} (L7: 50)`);
    check(death?.id === DUMMY_PLAYER && death.killer === LOCAL_PLAYER && death.cause === 'arrow', 'damage: torso + two headshots did not kill with credit to the shooter');
    check(world.playerStats(LOCAL_PLAYER).kills === 1 && world.playerStats(DUMMY_PLAYER).deaths === 1, 'damage: score not counted');
    world.dispose();
  },

  // Knocked out of the arena: credit to the last hitter only within 3 s.
  kill_credit() {
    const results: string[] = [];
    for (const waitTicks of [30, 240]) {
      const world = freshWorld(`kill_credit_${waitTicks}`, false);
      world.addBox('ground', 'fixed', { x: 16, y: GROUND_Y + 0.5 }, { x: 16, y: 0.5 });
      world.spawnPoints = [{ x: 4, y: GROUND_Y, facing: 1 }, { x: 28, y: GROUND_Y, facing: -1 }];
      world.addPlayer(LOCAL_PLAYER, { x: 4, y: GROUND_Y }, 1);
      world.addPlayer(DUMMY_PLAYER, { x: 28, y: GROUND_Y }, -1);
      run(world, 120);
      const aim = findAim(world, (l) => l === `${DUMMY_PLAYER}:torso`);
      if (!aim) {
        problems.push('kill_credit: no aim at the dummy torso');
        return;
      }
      shoot(world, aim);
      run(world, waitTicks);
      const mark = entries.length;
      for (const b of Object.values(world.player(DUMMY_PLAYER).parts)) world.push(b, { x: b.mass() * 18, y: -b.mass() * 4 }); // shove it off the edge
      run(world, 120);
      const death = since(mark).find((e) => e.ev === 'death');
      results.push(`${waitTicks} ticks later -> killer ${death?.killer ?? 'none'} (${death?.cause})`);
      const want = waitTicks <= 180 ? LOCAL_PLAYER : null;
      check(death?.cause === 'out_of_arena' && (death.killer ?? null) === want, `kill_credit: after ${waitTicks} ticks killer was ${death?.killer}, want ${want}`);
      world.dispose();
    }
    console.log(`kill_cred: ${results.join(' | ')}`);
  },

  // L3: holding the trigger fires on every reload; each shot costs 12: arms drop after ~9 shots and shots are refused;
  // arms come back at 40 after the rest; aiming itself is free; L7: jumps are free (a jump with no stamina still goes).
  stamina() {
    const world = freshWorld('stamina');
    run(world, 60);
    const st = world.playerStats(LOCAL_PLAYER);
    const aim = { angle: deg(-20) };
    const mark = entries.length;
    let emptyAt = -1;
    const start = world.tick;
    // like the browser with the button held: fire whenever the gun is ready, until the arms drop
    world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, aim });
    for (let t = 0; t < 600 && emptyAt < 0; t++) {
      if (st.fireBlock(world.tick) === null) world.fire(LOCAL_PLAYER, aim);
      if (st.armsDown) emptyAt = world.tick - start;
      else world.step();
    }
    const shotsToEmpty = since(mark).filter((e) => e.ev === 'fire').length;
    const lastShot = since(mark).filter((e) => e.ev === 'fire').at(-1);
    const refusedMark = entries.length;
    const lastTick = Number(lastShot?.tick);
    while (world.tick < lastTick + GUN.reloadTicks) world.step(); // reloaded: only the arms stop it now
    const refused = world.fire(LOCAL_PLAYER, aim).refused ?? null;
    const back = since(refusedMark).find((e) => e.ev === 'stamina_recovered') ?? (hold(world, LOCAL_PLAYER, {}, 240), since(refusedMark).find((e) => e.ev === 'stamina_recovered'));
    const backAfter = back ? Number(back.tick) - lastTick : -1;
    // aiming costs nothing
    st.refill(STAMINA.max);
    hold(world, LOCAL_PLAYER, { aim }, 120);
    const aimCost = STAMINA.max - st.stamina;
    // L7: a jump with no stamina at all still goes; and one at 50 leaves it at 50 or more (it only refills)
    hold(world, LOCAL_PLAYER, {}, 30);
    st.stamina = 0;
    const mark2 = entries.length;
    hold(world, LOCAL_PLAYER, { jump: true }, 1);
    const jumped = since(mark2).some((e) => e.ev === 'jump');
    hold(world, LOCAL_PLAYER, {}, 60);
    st.stamina = 50;
    hold(world, LOCAL_PLAYER, { jump: true }, 1);
    const afterJump = st.stamina;
    console.log(`stamina:   trigger held: ${shotsToEmpty} shots before the arms dropped (after ${r2(emptyAt / 60)} s), then refused: ${refused}, arms back ${r2(backAfter / 60)} s after the last shot; aiming 2 s cost ${r2(aimCost)}; a jump with no stamina ${jumped ? 'went' : 'was refused'}`);
    check(shotsToEmpty === Math.ceil(STAMINA.max / GUN.staminaPerShot), `stamina: arms dropped after ${shotsToEmpty} shots, want ${Math.ceil(STAMINA.max / GUN.staminaPerShot)}`);
    check(refused === 'arms_down', `stamina: a shot with the arms down was ${refused ?? 'not refused'}`);
    // rest starts when the last reload is done, then refill to recoverAt
    const wantBack = GUN.reloadTicks + STAMINA.refillDelayTicks + Math.ceil((STAMINA.recoverAt / STAMINA.refillPerSec) * 60);
    check(Math.abs(backAfter - wantBack) <= 3, `stamina: arms back ${backAfter} ticks after the last shot, want ~${wantBack}`);
    check(aimCost === 0, `stamina: aiming cost ${aimCost}`);
    check(jumped && afterJump >= 50, `stamina: a jump with no stamina was refused, or one cost stamina (${r2(afterJump)} of 50) (L7: jumps are free)`);
    world.dispose();
  },

  // L3 feel numbers for the gun: how fast it fires held down, how far the 0.5 s preview reaches, the drop over
  // distance (how high you aim), and hit rate on a standing target at a few distances with a small human-like aim error.
  gun() {
    const preview = GUN.previewTicks / 60;
    const reach = GUN.bulletSpeed * preview; // ~ straight-line length of the preview
    const drops = [10, 20, 30].map((d) => `${d} m: ${r2((GRAVITY_Y * (d / GUN.bulletSpeed) ** 2) / 2)} m`);
    const results: string[] = [];
    let seed = 99;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const gap of [6, 12, 20]) {
      const world = freshWorld(`gun:${gap}`, false);
      world.addBox('ground', 'fixed', { x: 30, y: GROUND_Y + 0.5 }, { x: 30, y: 0.5 });
      world.addPlayer(LOCAL_PLAYER, { x: 6, y: GROUND_Y }, 1);
      world.addPlayer('t', { x: 6 + gap, y: GROUND_Y }, -1);
      run(world, 60);
      const best = findAim(world, (l) => l === 't:torso');
      let hits = 0;
      let fired = 0;
      for (let i = 0; i < 10 && best; i++) {
        const st = world.playerStats('t');
        st.heal(100);
        const a = readyShot(world, LOCAL_PLAYER, { angle: best.angle + (rand() - 0.5) * 2 * deg(2) }); // +-2 degrees
        if (!a) continue;
        fired++;
        for (let k = 0; k < 120 && a.state === 'flying'; k++) world.step();
        if (entries.findLast((e) => e.ev === 'arrow_hit' && e.id === a.id)?.target?.toString().startsWith('t:')) hits++;
        run(world, 60);
      }
      results.push(`${gap} m ${hits}/${fired}`);
      world.dispose();
    }
    console.log(`gun:       ${GUN.bulletSpeed} m/s, reload ${r2(GUN.reloadTicks / 60)} s (${r2(60 / GUN.reloadTicks)} shots/s held), preview ${preview} s ~ ${r2(reach)} m, drop ${drops.join(', ')}; hits with +-2 deg aim error: ${results.join(', ')}`);
  },

  apple() {
    const world = freshWorld('apple');
    // L3: from p1's spot the gold apple is only a 0.3 degree window at 32 m/s and it bobs: shoot from under them
    world.relocate(LOCAL_PLAYER, { x: 16, y: GROUND_Y }, 1);
    run(world, 60);
    const st = world.playerStats(LOCAL_PLAYER);
    const out: string[] = [];
    for (const kind of ['red', 'gold'] as const) {
      if (kind === 'red') st.health = 50;
      else st.stamina = 20;
      const aim = aimAt(world, (l) => l.startsWith(`apple:${kind}`));
      if (!aim) {
        problems.push(`apple: no aim hits the ${kind} apple`);
        continue;
      }
      const mark = entries.length;
      shoot(world, aim);
      const hit = since(mark).find((e) => e.ev === 'apple_hit');
      const apple = world.apples.find((a) => a.kind === kind)!;
      const hidden = !world.outlines().some((o) => o.label === apple.label);
      run(world, 605); // comes back on the step after 600 ticks
      const back = since(mark).some((e) => e.ev === 'apple_spawn' && e.apple === apple.label);
      out.push(`${kind}: gained ${hit?.gained}, hidden ${hidden}, back after 10 s ${back}`);
      check(hit?.gained === (kind === 'red' ? 30 : 50), `apple: ${kind} apple gave ${hit?.gained}`);
      check(hidden, `apple: ${kind} apple still showing after being shot`);
      check(back, `apple: ${kind} apple did not come back after 10 s`);
    }
    console.log(`apple:     ${out.join(' | ')}`);
    world.dispose();
  },

  // Killed: goes limp, comes back 3 s later at the far spawn with full stats, stuck arrows cleared.
  respawn() {
    const world = freshWorld('respawn');
    run(world, 120);
    const head = findAim(world, (l) => l === `${DUMMY_PLAYER}:head`);
    if (!head) {
      problems.push('respawn: no full-power aim at the dummy head');
      return;
    }
    const mark = entries.length;
    world.playerStats(DUMMY_PLAYER).health = 50; // (L7: a headshot does 50, so this one kills)
    shoot(world, head);
    const limp = world.player(DUMMY_PLAYER).limp;
    run(world, 200);
    const respawn = since(mark).find((e) => e.ev === 'respawn');
    const death = since(mark).find((e) => e.ev === 'death');
    const st = world.playerStats(DUMMY_PLAYER);
    const p2 = world.player(DUMMY_PLAYER);
    run(world, 120);
    console.log(`respawn:   limp ${limp}, back after ${respawn && death ? Number(respawn.tick) - Number(death.tick) : '-'} ticks at ${JSON.stringify(respawn?.at)}, hp ${st.health}, standing ${!p2.down && !p2.limp}`);
    check(limp, 'respawn: body did not go limp on death');
    check(!!respawn && Number(respawn.tick) - Number(death?.tick) === 180, 'respawn: did not respawn 3 s after death');
    check(st.alive && st.health === 100 && st.stamina === 100, 'respawn: stats not reset');
    check(!p2.down && !p2.limp, 'respawn: not standing after respawn');
    world.dispose();
  },

  // Two players doing what the netsim bots do (walk, stop, draw toward each other, fire), with fixed random
  // numbers, for 2 minutes of game time. Any joint problem it finds can be replayed exactly.
  brawl() {
    const world = freshWorld('brawl', false);
    buildArenaOnly(world);
    const ids = ['a', 'b'];
    for (const id of ids) world.spawnPlayer(id);
    let seed = 12345;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const plan = new Map<string, { until: number; c: Controls; fireAt: number | null }>();
    const mark = entries.length;
    let shots = 0;
    for (let t = 0; t < 7200; t++) {
      for (const id of ids) {
        const st = world.playerStats(id);
        const cur = plan.get(id);
        if (!cur || world.tick >= cur.until) {
          if (cur?.fireAt !== null && cur?.c.aim && st.alive && world.fire(id, cur.c.aim).arrow) shots++;
          // alternate: walk somewhere (18-36 ticks), then aim at the other player (30-75 ticks) and fire
          const walking = !cur || cur.c.aim !== null;
          const other = world.player(ids.find((x) => x !== id)!);
          const me = world.player(id);
          const dx = other.center().x - me.center().x;
          const angle = Math.atan2(other.center().y - me.center().y - Math.abs(dx) * 0.12, dx) + (rand() - 0.5) * 0.06;
          const c: Controls = walking
            ? { ...NO_CONTROLS, move: ([-1, 0, 1] as const)[Math.floor(rand() * 3)] }
            : { ...NO_CONTROLS, aim: { angle } };
          plan.set(id, { until: world.tick + (walking ? 18 + Math.floor(rand() * 18) : 30 + Math.floor(rand() * 45)), c, fireAt: walking ? null : 1 });
        }
        world.setControls(id, plan.get(id)!.c);
      }
      world.step();
    }
    const warns = since(mark).filter((e) => e.lvl === 'warn' && e.ev !== 'slow_step');
    check(warns.length === 0, `brawl: ${warns.length} warnings during bot-style play (first: ${warns[0]?.ev} ${warns[0]?.who})`);
    console.log(`brawl:     2 min of bot-style play, ${shots} shots, ${count(mark, 'death')} deaths, ${count(mark, 'facing_flip')} turns, warnings ${warns.length}${warns[0] ? ` (first: ${warns[0].ev} ${warns[0].who} at tick ${warns[0].tick})` : ''}`);
    world.dispose();
  },

  // Walk into the thin wall and aim through it (what made netsim bots bend elbows and could shoot through walls).
  wall_hug() {
    const world = freshWorld('wall_hug', false);
    buildArena(world);
    const p = world.addPlayer('x', { x: 14, y: GROUND_Y }, -1);
    run(world, 60);
    const mark = entries.length;
    hold(world, 'x', { move: -1 }, 60);
    const aim = { angle: -3.01 };
    let worstHand = 99;
    let fired = false;
    hold(world, 'x', { aim }, 90, () => {
      const hand = p.launchPoint(aim).x;
      worstHand = Math.min(worstHand, hand);
      if (!fired && hand < 11.95) {
        world.fire('x', aim); // fire at the worst moment: gun hand already past the wall
        fired = true;
      }
    });
    if (!fired) world.fire('x', aim);
    run(world, 120);
    const hit = since(mark).find((e) => e.ev === 'arrow_hit');
    const warns = since(mark).filter((e) => e.ev === 'joint_over_limit');
    console.log(`wall_hug:  gun hand reached x ${r2(worstHand)} (wall 11.95-12.05), fired with hand past the wall ${fired}, arrow hit ${hit?.target} after ${hit?.ticks} ticks, aim_blocked logged ${count(mark, 'aim_blocked') > 0}, elbow warnings ${warns.length}`);
    check(hit?.target === 'thin_wall', `wall_hug: arrow hit ${hit?.target}, must hit the wall it was fired into`);
    check(warns.length === 0, `wall_hug: ${warns.length} joint warnings while aiming into the wall`);
    world.dispose();
  },

  // Seeded 4-player bot fights in both arenas: trips, getting up while aiming, walking into steps and walls.
  // These seeds bent knees/elbows past their limits (up to 1.1 rad, or 0.3-0.5 rad for seconds) before the
  // solver got enough internal passes and the shoulder motor a torque cap. Every joint must stay within its limit.
  limits() {
    const fights: [string, number][] = [['backyard', 1], ['backyard', 5], ['backyard', 6], ['test_lab', 4], ['test_lab', 5], ['test_lab', 7]];
    const out: string[] = [];
    for (const [arena, seed] of fights) {
      const world = freshWorld(`limits:${arena}:${seed}`, false);
      buildArena(world, arenaLayout(ARENAS[arena], 'full'));
      const ids = ['b0', 'b1', 'b2', 'b3'];
      for (const id of ids) world.spawnPlayer(id);
      const mark = entries.length;
      let worst = { over: -Infinity, at: '' };
      const { shots } = botFight(world, ids, seed * 7919, 3000, () => {
        for (const id of ids) {
          const o = world.player(id).worstLimitOver();
          if (o.over > worst.over) worst = { over: o.over, at: `${id}:${o.joint}@${world.tick}` };
        }
      });
      const warns = count(mark, 'joint_over_limit');
      out.push(`${arena}#${seed} ${shots} shots ${count(mark, 'trip')} trips, worst ${r2(worst.over)} (${worst.at}), warnings ${warns}`);
      check(warns === 0, `limits: ${arena} seed ${seed}: ${warns} joint_over_limit warnings`);
      world.dispose();
    }
    console.log(`limits:    ${out.join(' | ')}`);
  },

  // Walk into a Test Lab step (1 m) with the arms hanging, then draw: the forearms are caught on the step while the
  // shoulders swing up. Before the shoulder torque cap the elbows went 0.3 rad (in fights up to 1.1) past straight.
  arm_snag() {
    let worst = { over: -Infinity, at: '' };
    for (const angle of [-0.4, -0.2, 0, 0.1]) {
      const world = freshWorld(`arm_snag:${angle}`, false);
      buildArena(world, arenaLayout(TEST_LAB, 'full'));
      const p = world.addPlayer('x', { x: 12, y: 22 }, 1); // the step starts at x 14
      const track = () => {
        const o = p.worstLimitOver();
        if (o.over > worst.over) worst = { over: o.over, at: `${o.joint} at aim ${angle}` };
      };
      hold(world, 'x', {}, 30);
      hold(world, 'x', { move: 1 }, 70, track);
      hold(world, 'x', { aim: { angle } }, 58, track);
      world.dispose();
    }
    console.log(`arm_snag:  walked into the step, then aimed: worst joint ${r2(worst.over)} rad past its limit (${worst.at})`);
    check(worst.over < 0.1, `arm_snag: ${worst.at} went ${r2(worst.over)} rad past its limit`);
  },

  // L6: the narrow Test Lab's 2 m pocket (arena wall, then the 1 m step_l1 / step_r1; a spawn is in it). An idle body
  // tripped there in many ways (side, spot, direction, extra shove) must get up. Before the leg tuck: 17/36 stayed down
  // for good, wedged across it (the L5 bots sim's `stage_cant_stand` on the idle person).
  pocket() {
    let stuck = 0;
    let runs = 0;
    const upTicks: number[] = [];
    for (const side of [1, -1] as const) {
      for (const x0 of [0.6, 1.0, 1.4]) {
        for (const dir of [1, -1]) {
          for (const shove of [0.5, 1, 1.5]) {
            const world = freshWorld(`pocket:${side}:${x0}:${dir}:${shove}`, false);
            buildArena(world, arenaLayout(TEST_LAB, 'narrow'));
            const p = world.addPlayer('x', { x: side === 1 ? x0 : world.bounds.width - x0, y: 22 }, side);
            run(world, 60);
            p.trip(world.tick, 'sim', dir * side);
            for (const b of p.attached()) world.push(b, { x: dir * side * shove * b.mass(), y: 0 });
            const start = world.tick;
            let up = -1;
            let fell = false;
            run(world, 600, () => {
              fell ||= p.down;
              if (fell && up < 0 && !p.down) up = world.tick - start;
            });
            runs++;
            if (p.down) stuck++;
            else if (fell) upTicks.push(up);
            world.dispose();
          }
        }
      }
    }
    const avg = upTicks.reduce((a, b) => a + b, 0) / Math.max(1, upTicks.length);
    console.log(`pocket:    ${runs} trips in the narrow pocket: still down after 10 s ${stuck}, back up after ${r2(avg / 60)} s on average (slowest ${r2(Math.max(...upTicks) / 60)} s)`);
    check(stuck === 0, `pocket: ${stuck}/${runs} bodies stayed down in the narrow pocket`);
  },

  // L6: limbs slammed into a ledge. A body with its arm raised is launched up into perch_r's underside near its edge
  // at trampoline speeds (20 m/s; 28 m/s ~ a trampoline launch plus a jump, the most the game gives). Without soft CCD
  // the elbow was forced ~1 rad past its limit (the L5 report) and parts sank into the 0.4 m perch; with it, it stays
  // under LIMIT_CHECK.hardOver and nothing ends up inside the perch. (A rarer crush that still forces a joint out is a
  // `joint_spike`, info, if it comes back: see LIMIT_CHECK.spikeTicks.)
  crush() {
    let worst = { over: 0, at: '' };
    let inside = 0;
    let fastest = 0;
    for (const x of [41.65, 41.8, 41.95, 45]) {
      for (const angle of [-1.57, -1.4, -1.2, -1.0]) {
        for (const up of [20, 28]) {
          const world = freshWorld(`crush:${x}:${angle}:${up}`, false);
          buildArena(world, arenaLayout(TEST_LAB, 'full'));
          const p = world.addPlayer('x', { x, y: x < 44 ? 18 : 19 }, 1); // on step_r4 (top 18) or step_r3 (19), under perch_r
          hold(world, 'x', { aim: { angle } }, 40);
          for (const b of p.attached()) world.push(b, { x: 0, y: -up * b.mass() });
          run(world, 120, () => {
            const o = p.worstLimitOver();
            if (o.over > worst.over) worst = { over: o.over, at: `${o.joint} x ${x} aim ${angle} up ${up} m/s` };
            for (const part of Object.values(p.parts)) {
              const c = part.translation();
              const v = part.linvel();
              fastest = Math.max(fastest, Math.hypot(v.x, v.y));
              if (c.x > 42 && c.x < 48 && c.y > 14.02 && c.y < 14.38) inside++;
            }
          });
          world.dispose();
        }
      }
    }
    console.log(`crush:     arm raised into a ledge at 20/28 m/s: worst ${r2(worst.over)} rad past the limit (${worst.at}), part centres inside the perch ${inside} ticks, fastest part ${r2(fastest)} m/s`);
    check(worst.over < LIMIT_CHECK.hardOver, `crush: ${worst.at} went ${r2(worst.over)} rad past its limit`);
    check(inside === 0, `crush: body parts sank into the perch (${inside} ticks)`);
  },

  // L6: a part shot off while the body lies down or flies. Rapier resets the joint tree's root when a joint goes:
  // with the torso as the root a lying body snapped upright in one tick (1.7 rad) and a flying one stopped dead.
  cut_moving() {
    let worstTurn = 0;
    const speeds: string[] = [];
    for (const what of ['shin'] as const) { // (L7: the hand loss is gone; a shin is the part that comes off)
      // lying down
      for (const dir of [1, -1]) {
        const world = freshWorld(`cut_moving:down:${what}:${dir}`, false);
        buildArena(world, arenaLayout(TEST_LAB, 'full'));
        const p = world.addPlayer('x', { x: 4, y: 22 }, 1);
        run(world, 30);
        p.trip(world.tick, 'sim', dir);
        run(world, 30);
        const dmg = world.damage.get('x')!; // (cut directly: the rules' record must agree)
        p.stumpLeg('front');
        [dmg.firstLeg, dmg.legHits] = ['front', 3];
        let prev = p.parts.torso.rotation();
        run(world, 30, () => {
          worstTurn = Math.max(worstTurn, Math.abs(wrapAngle(p.parts.torso.rotation() - prev)));
          prev = p.parts.torso.rotation();
        });
        world.dispose();
      }
      // flying sideways at ~9 m/s
      const vx = (cut: boolean) => {
        const world = freshWorld(`cut_moving:fly:${what}:${cut}`, false);
        buildArena(world, arenaLayout(TEST_LAB, 'full'));
        const p = world.addPlayer('x', { x: 4, y: 18 }, 1);
        run(world, 1);
        for (const b of p.attached()) world.push(b, { x: 10 * b.mass(), y: -3 * b.mass() });
        run(world, 2);
        const dmg = world.damage.get('x')!; // (cut directly: the rules' record must agree)
        if (cut) (p.stumpLeg('front'), (dmg.firstLeg = 'front'), (dmg.legHits = 3));
        run(world, 1);
        const v = p.parts.torso.linvel().x;
        world.dispose();
        return v;
      };
      const whole = vx(false);
      const cut = vx(true);
      speeds.push(`${what} ${r2(cut)} vs ${r2(whole)} m/s`);
      check(Math.abs(cut - whole) < 0.1 * whole, `cut_moving: a flying body lost speed when its ${what} came off (${r2(cut)} vs ${r2(whole)} m/s)`);
    }
    console.log(`cut_moving: lying body's biggest one-tick turn after losing a part ${r2(worstTurn)} rad (was 1.7) | flying: ${speeds.join(', ')}`);
    check(worstTurn < 0.3, `cut_moving: the lying body snapped ${r2(worstTurn)} rad in one tick when a part came off`);
  },

  idle() {
    const world = freshWorld('idle');
    run(world, 600);
    world.dispose();
  },

  // ---- S1: arenas ----

  // Every arena at every size: fill it (up to 8 players, each on a free spawn), let them stand 5 s.
  // Nobody may fall, slide, or start inside something. A new arena file is checked here automatically.
  arena_spawns() {
    const results: string[] = [];
    for (const def of Object.values(ARENAS)) {
      for (const size of def.narrow ? (['full', 'narrow'] as const) : (['full'] as const)) {
        const world = freshWorld(`arena_spawns:${def.id}:${size}`, false);
        const layout = arenaLayout(def, size);
        buildArena(world, layout);
        const mark = entries.length;
        const n = Math.min(8, layout.spawns.length);
        const ids = Array.from({ length: n }, (_, i) => `s${i}`);
        for (const id of ids) world.spawnPlayer(id);
        run(world, 60);
        const start = new Map(ids.map((id) => [id, world.player(id).center()]));
        let worstTilt = 0;
        run(world, 300, () => {
          for (const id of ids) worstTilt = Math.max(worstTilt, tilt(world.player(id)));
        });
        let worstDrift = 0;
        for (const id of ids) {
          const a = start.get(id)!;
          const b = world.player(id).center();
          worstDrift = Math.max(worstDrift, Math.hypot(b.x - a.x, b.y - a.y));
        }
        const down = ids.filter((id) => world.player(id).down || !world.playerStats(id).alive);
        const warns = since(mark).filter((e) => (e.lvl === 'warn' || e.lvl === 'error') && e.ev !== 'slow_step');
        results.push(`${def.id}/${size} ${n} players drift ${r2(worstDrift)} m tilt ${r2(worstTilt)}`);
        check(down.length === 0, `arena_spawns: ${def.id}/${size}: ${down.join(',')} fell or died after spawning`);
        check(worstDrift < 0.3, `arena_spawns: ${def.id}/${size}: a player moved ${r2(worstDrift)} m while standing`);
        check(warns.length === 0, `arena_spawns: ${def.id}/${size}: ${warns.length} warnings (first: ${warns[0]?.ev})`);
        world.dispose();
      }
    }
    console.log(`arena_spawns: ${results.join(' | ')}`);
  },

  // Ring-out: p1 shoots the victim across the pit, then the victim is shoved into the pit
  // (stand-in for a boxing glove). The kill must go to p1, and the body must come to rest at the bottom.
  pit() {
    const world = freshWorld('pit', false);
    buildArena(world, arenaLayout(TEST_LAB, 'full'));
    // (L6: the stairs now reach the pit edge on both sides, so both stand up at bridge level: the shooter on the top
    // step, the victim on the left bridge near its 2 m gap over the pit; the hit, the conveyor and the wind (both
    // toward the gap, by design) send it in)
    world.addPlayer(LOCAL_PLAYER, { x: 23, y: 18 }, 1);
    const victim = world.addPlayer('victim', { x: 29.5, y: 18 }, -1);
    run(world, 60);
    const mark = entries.length;
    const aim = findAim(world, (l) => l.startsWith('victim:'), -30);
    const hit = aim ? shoot(world, aim) : undefined;
    // (the shove toward the pit: 3 m/s in all, the bullet's own L7 knock included; more flies right over the 2 m gap)
    for (const b of Object.values(victim.parts)) world.push(b, { x: (3 - HIT_REACTION.knock.arm) * b.mass(), y: 0 });
    // The body respawns 3 s after death (a new ragdoll), so only look at it until shortly before that.
    let deepest = 0;
    let rest = victim.center();
    for (let t = 0; t < 240; t++) {
      world.step();
      const dead = since(mark).find((e) => e.ev === 'death');
      if (dead && world.tick - Number(dead.tick) > 150) break;
      rest = world.player('victim').center();
      deepest = Math.max(deepest, rest.y);
    }
    const death = since(mark).find((e) => e.ev === 'death');
    const ring = since(mark).find((e) => e.ev === 'ring_out');
    console.log(
      `pit:       arrow ${hit?.ev === 'arrow_hit' ? `hit ${hit.target}` : 'missed'}, ring_out ${!!ring} (pit ${ring?.pit}, last hit ${ring?.lastHitAgo} ticks before), ` +
        `death cause ${death?.cause} killer ${death?.killer}, body rests at y ${r2(rest.y)} (pit floor 25), deepest ${r2(deepest)}`,
    );
    check(hit?.ev === 'arrow_hit' && String(hit.target).startsWith('victim:'), 'pit: setup shot did not hit the victim');
    check(death?.cause === 'pit' && death?.killer === LOCAL_PLAYER, `pit: expected a pit death credited to p1, got ${death?.cause}/${death?.killer}`);
    check(rest.y > 22 && rest.y < 25, `pit: body did not come to rest inside the pit (y ${r2(rest.y)})`);
    world.dispose();
  },

  // Can a player climb the Test Lab steps (1 m each) by walking and jumping? Arena rule: one step <= one jump.
  step_climb() {
    const world = freshWorld('step_climb', false);
    // the stairs only: the trampoline on the lowest step would launch the climber (that's its job, not this test's)
    buildArena(world, { ...arenaLayout(TEST_LAB, 'full'), hazards: [] });
    const p = world.addPlayer(LOCAL_PLAYER, { x: 11, y: 22 }, 1);
    run(world, 60);
    const startTick = world.tick;
    // standing torso height over the feet, to turn torso height into "standing on which step"
    const torsoAbove = 22 - p.center().y;
    const reached: number[] = [];
    let jumps = 0;
    let holdUntil = -1;
    for (let t = 0; t < 900 && reached.length < 4; t++) {
      // a jump every 0.75 s, held 20 ticks (L2: a one-tick tap is only a short hop)
      if (t % 45 === 0 && p.grounded) (holdUntil = t + 20), jumps++;
      const jump = t < holdUntil;
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1, jump });
      world.step();
      const step = Math.round(22 - torsoAbove - p.center().y);
      if (p.grounded && step > reached.length && step <= 4) reached.push(world.tick - startTick);
      if (p.center().x > 25.5) break; // reached the bridge end of the top step
    }
    const ticksTo = reached.map((tk, i) => `h${i + 1} ${r2(tk / 60)}s`);
    console.log(`step_climb: ${ticksTo.join(', ') || 'no step reached'}, jumps ${jumps}, stamina left ${Math.round(world.playerStats(LOCAL_PLAYER).stamina)}, fell ${p.down}`);
    check(reached.length >= 4, `step_climb: only reached step ${reached.length} of 4`);
    world.dispose();
  },

  // ---- S7: match spice ----

  // 3 bots + 1 still person, one match with fast chaos rounds (all five kinds in ~1 min): every round switches on and
  // off, the crown moves around, awards come out, and nothing warns under any round.
  chaos() {
    const { room, mark } = simRoom('chaos', {
      rotation: [TEST_LAB],
      match: { lengthTicks: 75 * 60, killTarget: 99, resultsTicks: 60, modifierEveryTicks: 12 * 60, modifierTicks: 8 * 60 },
    });
    for (let t = 0; t < 76 * 60 && room.match.info.phase === 'playing'; t++) room.tick();
    const log = since(mark);
    const started = log.filter((e) => e.ev === 'modifier_start').map((e) => e.kind);
    const ended = log.filter((e) => e.ev === 'modifier_end').map((e) => e.kind);
    const end = log.find((e) => e.ev === 'match_end');
    const crowns = log.filter((e) => e.ev === 'crown_change').length;
    const calls = new Set(log.filter((e) => e.ev === 'callout').map((e) => e.kind));
    console.log(
      `chaos:     rounds started [${started}], ended [${ended}], crown changes ${crowns}, callouts seen ${calls.size} kinds, ` +
        `awards [${(end?.awards as string[] | undefined)?.join(', ') ?? '-'}], best moment ${end?.best}`,
    );
    check(new Set(started).size === 5 && started.length === ended.length, `chaos: rounds started ${started} / ended ${ended}`);
    check(crowns > 0, 'chaos: the crown never moved');
    check(!!end && Array.isArray(end.awards) && (end.awards as string[]).length > 0, 'chaos: no awards');
    room.close();
  },

  // ---- S6: hazards + floor types (Test Lab, full size; ground top y 22) ----

  // Trampoline on the lowest left step: walk on, get launched, hold right while flying: land on the high perch.
  // L4: two thigh stumps on a trampoline: the pad launches what stands on it (the stump ends are the feet now), so a
  // stumpy body that can't jump up a step can still bounce up to the perch.
  stump_trampoline() {
    const world = lab('stump_trampoline');
    world.addPlayer(LOCAL_PLAYER, { x: 9, y: 22 }, 1);
    run(world, 60);
    for (let i = 0; i < 5; i++) {
      world.bodyHit(LOCAL_PLAYER, i % 2 ? 'legBackLower' : 'legFrontLower', 1, 'sim');
      run(world, 150);
    }
    world.relocate(LOCAL_PLAYER, { x: 15, y: 21 }, 1); // onto the left pad (the 1 m step: too high for stumps to jump)
    const p = world.player(LOCAL_PLAYER);
    const mark = entries.length;
    const y0 = p.center().y;
    let top = y0;
    run(world, 120, () => (top = Math.min(top, p.center().y)));
    const stumps = p.stumps.size;
    console.log(`stump_trampoline: two stumps ${stumps === 2}, launches ${count(mark, 'hazard_hit')}, rose ${r2(y0 - top)} m (perch top is ${r2(y0 - 14)} m above), joint warnings ${count(mark, 'joint_over_limit')}`);
    check(stumps === 2 && count(mark, 'hazard_hit') > 0 && y0 - top > 4, `stump_trampoline: a two-stump body on the pad rose only ${r2(y0 - top)} m`);
    world.dispose();
  },

  trampoline() {
    const world = lab('trampoline');
    const p = world.addPlayer(LOCAL_PLAYER, { x: 11, y: 22 }, 1); // a run-up to the 1 m step, like step_climb
    run(world, 60);
    const mark = entries.length;
    let top = 22;
    for (let t = 0; t < 300; t++) {
      // hop up the 1 m step onto the pad; once launched, steer right only until over the perch (like a player would)
      const launched = count(mark, 'hazard_hit') > 0;
      // L2: at full run speed the momentum alone carried the launched body under the perch (bumping along its
      // underside). The way up now: once launched, hold back (air control kills the run speed in ~0.2 s) until above
      // the perch, then steer over it.
      const above = p.center().y < 14;
      const move = !launched ? 1 : !above ? (p.speedX() > 0.3 ? -1 : 0) : p.center().x < 18 ? 1 : 0;
      world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move, jump: !launched && t % 45 < 20 && t < 150 }); // held: full jumps
      world.step();
      top = Math.min(top, p.center().y);
    }
    const onPerch = p.grounded && p.center().x > 16 && p.center().x < 22 && p.center().y < 14;
    console.log(`trampoline: launches ${count(mark, 'hazard_hit')}, highest torso y ${r2(top)} (perch top 14), ended on the perch ${onPerch} at x ${r2(p.center().x)}, falls ${count(mark, 'ragdoll_fall')}`);
    check(count(mark, 'hazard_hit') >= 1 && top < 13, 'trampoline: no launch high enough for the perch');
    check(onPerch, 'trampoline: did not land on the perch');
    world.dispose();
  },

  // Seesaw: someone stands on the left end, an arrow hits the right end hard: they get launched.
  seesaw() {
    const world = lab('seesaw');
    const v = world.addPlayer('v', { x: 4.5, y: 21.1 }, 1);
    // L3: from the second step (x 17, 2 m up): a quick shot down onto the raised end. A 32 m/s lob from the floor
    // takes 3 s to come down onto it, and by then v has slid off the tilted plank.
    world.addPlayer(LOCAL_PLAYER, { x: 17, y: 20 }, -1);
    run(world, 90);
    const mark = entries.length;
    const y0 = v.center().y;
    // v's weight tips the left end down, so the right end is up: hit it from above (a shot from below would push it
    // further up). The pivot is at x 6; take the quickest shot that comes down onto the far half.
    let aim: Aim | null = null;
    let best = Infinity;
    for (let a = -30; a <= 89.95; a += 0.05) {
      const tryAim = { angle: -Math.PI + deg(a) };
      const p = world.previewShot(LOCAL_PLAYER, tryAim);
      const q = p.points.at(-2);
      if (p.hit?.label === 'seesaw_l' && p.hit.point.x > 7.2 && q && p.hit.point.y > q.y && p.ticks < best) [aim, best] = [tryAim, p.ticks];
    }
    const tilt = world.movableBodies().find((m) => m.label === 'seesaw_l')!.body.rotation();
    if (aim) shootAs(world, aim);
    let rise = 0;
    run(world, 90, () => (rise = Math.max(rise, y0 - v.center().y)));
    console.log(`seesaw:    tipped by v's weight to ${r2(tilt)} rad, right end lobbed ${count(mark, 'hazard_shot')}, player on the left end rose ${r2(rise)} m, stuck ${count(mark, 'stuck_in_hazard')}`);
    check(!!aim && rise > 1, `seesaw: the player was only lifted ${r2(rise)} m`);
    world.dispose();
  },

  // Wrecking ball: p1 shoots it, it swings into a player: BONK, knocked down, and the hit counts for p1.
  wrecking_ball() {
    const world = lab('wrecking_ball');
    const v = world.addPlayer('v', { x: 58.6, y: 22 }, -1);
    world.addPlayer(LOCAL_PLAYER, { x: 51.5, y: 22 }, 1);
    run(world, 60);
    const mark = entries.length;
    const aim = aimAt(world, (l) => l === 'wreck_r');
    if (aim) shootAs(world, aim);
    run(world, 120);
    const bonk = since(mark).find((e) => e.ev === 'hazard_hit' && e.kind === 'wrecking_ball');
    console.log(`wrecking_ball: shot ${count(mark, 'hazard_shot')}, bonk ${!!bonk} at ${bonk?.speed} m/s, victim fell ${count(mark, 'ragdoll_fall') > 0}, last hit by ${world.playerStats('v').lastHit?.by}, x ${r2(v.center().x)}`);
    check(!!bonk && world.playerStats('v').lastHit?.by === LOCAL_PLAYER, 'wrecking_ball: no bonk credited to the shooter');
    world.dispose();
  },

  // Wind over the pit: arrows bend (the preview bends the same way, exactly); a player on the bridge is pushed.
  wind() {
    const world = lab('wind');
    world.addPlayer(LOCAL_PLAYER, { x: 24, y: 18 }, 1);
    run(world, 60);
    const mark = entries.length;
    let compared = 0;
    let worst = 0;
    let bend = 0;
    // L3: every bullet is 32 m/s, so it crosses the wind quickly: lob through it (longer in the wind) onto fixed things
    const lobs: number[] = [];
    for (let d = -20; d >= -80 && lobs.length < 3; d -= 1) {
      const p = world.previewShot(LOCAL_PLAYER, { angle: deg(d) });
      if (p.hit && p.hit.collider.parent()?.isFixed() && p.ticks > 50 && !lobs.some((x) => Math.abs(x - d) < 6)) lobs.push(d);
    }
    for (const deg_ of lobs) {
      const aim = { angle: deg(deg_) };
      const preview = world.previewShot(LOCAL_PLAYER, aim);
      const a = readyShot(world, LOCAL_PLAYER, aim)!;
      for (let i = 0; i < 300 && a.state === 'flying'; i++) world.step();
      const hit = since(mark).find((e) => e.ev === 'arrow_hit' && e.id === a.id);
      if (!hit || hit.moving) continue;
      compared++;
      worst = Math.max(worst, Number(hit.predErr));
      // how far the wind moved it: compare with the same shot in still air
      const still = traceShot(world.player(LOCAL_PLAYER).jointPos('shoulderFront'), aim, (f, t) => world.raycast(f, t, LOCAL_PLAYER), world.bounds);
      bend = Math.max(bend, Math.abs((preview.hit?.point.x ?? 0) - (still.hit?.point.x ?? 0)));
    }
    const v = world.addPlayer('v', { x: 33.8, y: 18 }, 1); // right bridge (ice), inside the wind
    run(world, 60);
    const x0 = v.center().x;
    run(world, 60);
    const pushed = v.center().x - x0;
    console.log(`wind:      ${compared} shots through the wind, worst preview error ${r3(worst)} m, wind moved the landing up to ${r2(bend)} m, player on the bridge pushed ${r2(pushed)} m in 1 s`);
    check(compared >= 2 && worst === 0, `wind: preview error ${worst} m (must be exact)`);
    check(bend > 0.5, 'wind: arrows were barely bent');
    world.dispose();
  },

  // Conveyor on the left bridge: standing still rides it at its speed (toward the gap).
  conveyor() {
    const world = lab('conveyor');
    const p = world.addPlayer(LOCAL_PLAYER, { x: 27, y: 18 }, 1);
    run(world, 30);
    const x0 = p.center().x;
    run(world, 60);
    const speed = p.speedX();
    const moved = p.center().x - x0;
    console.log(`conveyor:  carried at ${r2(speed)} m/s (belt 1.5), moved ${r2(moved)} m in 1 s, falls ${p.down}`);
    check(Math.abs(speed - 1.5) < 0.3, `conveyor: carried at ${r2(speed)} m/s, want ~1.5`);
    world.dispose();
  },

  // Ice (right bridge) vs normal floor (right steps' top): walk, let go, compare the slide.
  ice_floor() {
    const slide = (x: number, y: number, dir: -1 | 1) => {
      const world = lab(`ice_floor:${x}`);
      const p = world.addPlayer(LOCAL_PLAYER, { x, y }, dir);
      run(world, 60);
      hold(world, LOCAL_PLAYER, { move: dir }, 40);
      const at = p.center().x;
      hold(world, LOCAL_PLAYER, {}, 90);
      const d = Math.abs(p.center().x - at);
      world.dispose();
      return d;
    };
    const normal = slide(43.5, 18, -1); // step_r4 top (38-44)
    const ice = slide(37.5, 18, -1); // bridge_r (33-38), ice
    console.log(`ice_floor: after letting go: slid ${r2(normal)} m on normal floor, ${r2(ice)} m on ice`);
    check(ice > normal * 2 && ice > 0.8, 'ice_floor: ice is not slippery');
  },

  // Bouncy block (left yard): dropped from 3 m, it bounces back up much higher than a normal floor would allow.
  bouncy_floor() {
    const bounce = (x: number, top: number) => {
      const world = lab(`bouncy:${x}`);
      const p = world.addPlayer(LOCAL_PLAYER, { x, y: top - 3 }, 1);
      let landed = false;
      let low = -Infinity;
      let peakAfter = Infinity;
      for (let t = 0; t < 150; t++) {
        world.step();
        const y = p.center().y;
        if (!landed && p.grounded) landed = true;
        if (landed) {
          low = Math.max(low, y);
          peakAfter = Math.min(peakAfter, y);
        }
      }
      world.dispose();
      return r2(low - peakAfter);
    };
    const normal = bounce(13, 22);
    const bouncy = bounce(10.2, 21.4);
    console.log(`bouncy_floor: dropped from 3 m: rebound ${normal} m on normal ground, ${bouncy} m on the bouncy block`);
    check(bouncy > normal + 0.5, 'bouncy_floor: no real bounce');
  },

  // ---- S5: power-ups (special arrows) + wall pins. Backyard: walls at x 0 and 32, thin wall at x 12 (shooters stand
  // right of it, at x 14, so it isn't in the way). ----

  // Shoot the bubble: you hold its arrow; your next shot is that arrow; the bubble comes back later.
  pickup() {
    const world = duel('pickup', 8, 29);
    world.specials.setOrder(['glove']);
    const mark = entries.length;
    const aim = aimAt(world, (l) => l.startsWith('bubble:'));
    if (aim) shootAs(world, aim);
    const held = world.playerStats(LOCAL_PLAYER).held;
    const a = readyShot(world, LOCAL_PLAYER, { angle: -0.2 });
    const ev = since(mark).find((e) => e.ev === 'pickup_taken');
    console.log(`pickup:    shot the bubble ${!!ev} (kind ${ev?.kind}), held ${held}, next round kind ${a?.kind}, held after ${world.playerStats(LOCAL_PLAYER).held}`);
    check(held === 'glove' && a?.kind === 'glove' && world.playerStats(LOCAL_PLAYER).held === null, 'pickup: the bubble did not give its round to the next shot');
    world.dispose();
  },

  // Boxing glove: no damage, the victim flies into the wall behind (SPLAT!), the shooter gets the "last hit".
  glove() {
    const world = duel('glove', 14, 29);
    const v = world.player('v');
    const mark = entries.length;
    const x0 = v.center().x;
    special(world, 'glove', (l) => l === 'v:torso');
    let top = 0;
    run(world, 120, () => (top = Math.max(top, Math.abs(v.speedX()))));
    const splat = since(mark).find((e) => e.ev === 'wall_splat');
    const calls = since(mark).filter((e) => e.ev === 'callout').map((e) => e.kind);
    const st = world.playerStats('v');
    const dents = [...(world.damage.get('v')?.dents ?? [])];
    console.log(`glove:     top speed ${r2(top)} m/s, moved ${r2(v.center().x - x0)} m, splat ${!!splat} (${splat?.speed} m/s into ${splat?.wall}), callouts [${calls}], hp ${st.health}, dented [${dents}], last hit by ${st.lastHit?.by}, joint warnings ${count(mark, 'joint_over_limit')}`);
    check(top > 8, `glove: victim only reached ${r2(top)} m/s`);
    check(!!splat && calls.includes('outta_here') && calls.includes('splat'), 'glove: missing SPLAT / OUTTA HERE');
    // L4: a little damage (was none) and a dent where it hit
    check(st.health < 100 && st.health >= 90 && dents.length === 1 && st.lastHit?.by === LOCAL_PLAYER, 'glove: should do a little damage, dent the part and count as the last hit');
    world.dispose();
  },

  // Balloon on the torso: the victim floats up; shooting the balloon pops it and they fall.
  balloon() {
    const world = duel('balloon', 14, 18);
    const v = world.player('v');
    const mark = entries.length;
    const y0 = v.center().y;
    special(world, 'balloon', (l) => l === 'v:torso');
    let rise = 0;
    run(world, 90, () => (rise = Math.max(rise, y0 - v.center().y)));
    const aim = aimAt(world, (l) => l.startsWith('balloon:'));
    if (aim) shootAs(world, aim);
    const popped = since(mark).some((e) => e.ev === 'balloon_pop');
    const yPop = v.center().y;
    run(world, 120);
    const fell = v.center().y - yPop;
    console.log(`balloon:   rose ${r2(rise)} m in 1.5 s, popped by a shot ${popped}, then fell ${r2(fell)} m, joint warnings ${count(mark, 'joint_over_limit')}`);
    check(rise > 1, `balloon: only rose ${r2(rise)} m (a gentle float: ~1.2 m/s)`);
    check(popped && fell > 1, 'balloon: popping did not drop the victim');
    world.dispose();
  },

  // Balloon on a leg: the foot is lifted (hopping on the other one), the body doesn't fly away.
  balloon_leg() {
    const world = duel('balloon_leg', 14, 18);
    const v = world.player('v');
    const mark = entries.length;
    special(world, 'balloon', (l) => l.startsWith('v:leg'));
    const e = since(mark).find((x) => x.ev === 'balloon_start');
    // foot lift = how much higher one foot is than the other (hopping on one foot)
    let footUp = 0;
    let bodyRise = 0;
    const y0 = v.center().y;
    run(world, 150, () => {
      footUp = Math.max(footUp, Math.abs(v.parts.legFrontLower.translation().y - v.parts.legBackLower.translation().y));
      bodyRise = Math.max(bodyRise, y0 - v.center().y);
    });
    console.log(`balloon_leg: tied to ${e?.part}, foot lifted up to ${r2(footUp)} m, body rose ${r2(bodyRise)} m, falls ${count(mark, 'ragdoll_fall')}`);
    check(!!e && footUp > 0.4, 'balloon_leg: the leg was not lifted');
    check(bodyRise < 1.5, `balloon_leg: the whole body floated (${r2(bodyRise)} m)`);
    world.dispose();
  },

  // Oil under a still player: the legs slide apart into a split until they collapse.
  oil_stand() {
    const world = duel('oil_stand', 14, 22);
    const v = world.player('v');
    const mark = entries.length;
    special(world, 'oil', (l) => l.startsWith('v:leg'));
    let spread = 0;
    let downAt = -1;
    run(world, 300, (t) => {
      spread = Math.max(spread, Math.abs(v.jointAngle('hipFront') - v.jointAngle('hipBack')));
      if (downAt < 0 && v.down) downAt = t;
    });
    console.log(`oil_stand: puddle ${count(mark, 'oil_spawn')}, legs spread up to ${r2(spread)} rad, collapsed after ${downAt < 0 ? 'never' : `${r2(downAt / 60)} s`}, joint warnings ${count(mark, 'joint_over_limit')}`);
    check(count(mark, 'oil_spawn') === 1 && spread > 1.2, 'oil_stand: no split');
    world.dispose();
  },

  // Walking into oil: the legs scramble, then the body shoots forward on its belly (SLIP 'N SLIDE).
  oil_walk() {
    const world = duel('oil_walk', 14, 22);
    const v = world.player('v');
    const mark = entries.length;
    special(world, 'oil', (l) => l.startsWith('v:leg'));
    run(world, 30);
    const x0 = v.center().x;
    hold(world, 'v', { move: -1 }, 120);
    const slide = since(mark).find((e) => e.ev === 'oil_slide');
    const calls = since(mark).filter((e) => e.ev === 'callout').map((e) => e.kind);
    console.log(`oil_walk:  scrambles ${count(mark, 'oil_scramble')}, slides ${count(mark, 'oil_slide')}, went ${r2(v.center().x - x0)} m, fell ${count(mark, 'ragdoll_fall') > 0}, callouts [${calls}]`);
    check(!!slide && calls.includes('slip'), "oil_walk: no slide / SLIP 'N SLIDE");
    world.dispose();
  },

  // Wall pin: a leg shot with the thin wall right behind it nails the leg there for 2 s; mashing jump frees it sooner.
  pin() {
    const out: string[] = [];
    for (const mash of [false, true]) {
      const world = freshWorld(`pin:${mash ? 'mash' : 'wait'}`, false);
      buildArena(world);
      world.addPlayer(LOCAL_PLAYER, { x: 18, y: GROUND_Y }, -1);
      const v = world.addPlayer('v', { x: 12.45, y: GROUND_Y }, 1); // back against the thin wall (x 11.95-12.05)
      run(world, 60);
      const mark = entries.length;
      const aim = aimAt(world, (l) => l.startsWith('v:leg'));
      if (aim) shootAs(world, aim);
      const pinned = since(mark).find((e) => e.ev === 'pin_start');
      let maxX = 0;
      let endTick = -1;
      for (let t = 0; t < 200 && endTick < 0; t++) {
        world.setControls('v', { ...NO_CONTROLS, move: 1, jump: mash && t % 6 < 3 });
        world.step();
        maxX = Math.max(maxX, v.center().x);
        const end = since(mark).find((e) => e.ev === 'pin_end');
        if (end) endTick = Number(end.tick) - Number(pinned?.tick ?? 0);
      }
      out.push(`${mash ? 'mashing' : 'waiting'}: pinned ${pinned?.part ?? 'no'}, held within x ${r2(maxX)} while trying to walk away, free after ${endTick} ticks`);
      check(!!pinned, `pin: no pin (${mash ? 'mash' : 'wait'})`);
      check(maxX < 13.6, `pin: the pinned player walked away to x ${r2(maxX)}`);
      if (mash) check(endTick > 0 && endTick < 100, `pin: mashing did not free them sooner (${endTick} ticks)`);
      else check(endTick >= 115 && endTick <= 125, `pin: lasted ${endTick} ticks, want ~120`);
      world.dispose();
    }
    console.log(`pin:       ${out.join(' | ')}`);
  },

  // Plunger: the rope drags the victim toward the shooter for 1.5 s.
  plunger() {
    const world = duel('plunger', 14, 29);
    const v = world.player('v');
    const mark = entries.length;
    const x0 = v.center().x;
    special(world, 'plunger', (l) => l === 'v:torso');
    run(world, 100);
    console.log(`plunger:   rope ${count(mark, 'rope_start')}, victim dragged ${r2(x0 - v.center().x)} m toward the shooter, rope_end ${count(mark, 'rope_end')}`);
    check(x0 - v.center().x > 2, 'plunger: victim was not dragged');
    world.dispose();
  },

  // Sticky bomb: sticks in the victim, beeps 2 s, then blows them and a neighbour away (pushes + damage).
  bomb() {
    const world = duel('bomb', 14, 22);
    world.addPlayer('w', { x: 24.5, y: GROUND_Y }, -1);
    run(world, 30);
    const mark = entries.length;
    const v = world.player('v');
    const w2 = world.player('w');
    const xs = [v.center().x, w2.center().x];
    special(world, 'bomb', (l) => l === 'v:torso');
    run(world, 150);
    const boom = since(mark).find((e) => e.ev === 'bomb_explode');
    console.log(`bomb:      exploded ${!!boom} after ${boom ? Number(boom.tick) - Number(since(mark).find((e) => e.ev === 'bomb_stuck')?.tick) : '-'} ticks, players hit ${boom?.players}, moved ${r2(Math.abs(v.center().x - xs[0]))} / ${r2(Math.abs(w2.center().x - xs[1]))} m, hp ${world.playerStats('v').health} / ${world.playerStats('w').health}`);
    check(!!boom && Number(boom.players) >= 2, 'bomb: did not blow up both players');
    world.dispose();
  },

  // Banana: the preview shows the split; the three real pieces land exactly where the preview said.
  banana() {
    const world = duel('banana', 14, 29);
    world.playerStats(LOCAL_PLAYER).held = 'banana';
    // all three pieces must land on fixed things (a piece that hits v moves v, and the next one then lands elsewhere)
    const fixedEnd = (pts: { x: number; y: number }[]) => !!world.raycast(pts.at(-2)!, { x: pts.at(-1)!.x + (pts.at(-1)!.x - pts.at(-2)!.x), y: pts.at(-1)!.y + (pts.at(-1)!.y - pts.at(-2)!.y) }, LOCAL_PLAYER)?.collider.parent()?.isFixed();
    let aim = { angle: deg(-12) };
    for (let d = -10; d >= -70; d -= 0.5) {
      const p = world.previewShot(LOCAL_PLAYER, { angle: deg(d) });
      if (p.hit?.collider.parent()?.isFixed() && p.branches?.length === 2 && p.branches.every(fixedEnd)) {
        aim = { angle: deg(d) };
        break;
      }
    }
    const preview = world.previewShot(LOCAL_PLAYER, aim);
    const byPlace = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.round(a.x * 100) - Math.round(b.x * 100) || a.y - b.y; // (all three can hit the same wall)
    const want = [preview.points.at(-1)!, ...(preview.branches ?? []).map((b) => b.at(-1)!)].sort(byPlace);
    const mark = entries.length;
    const a = readyShot(world, LOCAL_PLAYER, aim)!;
    run(world, 200);
    const pieces = [a.id, ...since(mark).filter((e) => e.ev === 'fire' && e.of === a.id).map((e) => e.id)];
    const got = since(mark).filter((e) => e.ev === 'arrow_hit' && pieces.includes(e.id)).map((e) => ({ x: (e.point as number[])[0], y: (e.point as number[])[1] })).sort(byPlace);
    const err = got.length === 3 ? Math.max(...got.map((g, i) => Math.hypot(g.x - want[i].x, g.y - want[i].y))) : Infinity;
    console.log(`banana:    preview branches ${preview.branches?.length ?? 0}, real pieces ${pieces.length}, landed ${got.length}, worst preview error ${r3(err)} m`);
    check(pieces.length === 3 && got.length === 3 && err < 0.01, `banana: pieces don't match the preview (error ${r3(err)} m)`);
    world.dispose();
  },

  // Swap: shooter and victim trade places.
  swap() {
    const world = duel('swap', 14, 28);
    const mark = entries.length;
    const before = [world.player(LOCAL_PLAYER).center().x, world.player('v').center().x];
    special(world, 'swap', (l) => l === 'v:torso');
    run(world, 30);
    const after = [world.player(LOCAL_PLAYER).center().x, world.player('v').center().x];
    console.log(`swap:      p1 ${r2(before[0])} -> ${r2(after[0])}, victim ${r2(before[1])} -> ${r2(after[1])}, swapped ${count(mark, 'swap')}, respawn_blocked ${count(mark, 'respawn_blocked')}`);
    check(Math.abs(after[0] - before[1]) < 0.6 && Math.abs(after[1] - before[0]) < 0.6, 'swap: positions not swapped');
    world.dispose();
  },

  // Feather: the victim laughs for 1.5 s: arms flail, can't aim; afterwards aiming works again.
  feather() {
    const world = duel('feather', 14, 22);
    const v = world.player('v');
    const mark = entries.length;
    special(world, 'feather', (l) => l === 'v:torso');
    const aim = { angle: Math.PI };
    let blocked = 0;
    let refused = 0;
    hold(world, 'v', { aim }, 80, () => {
      blocked += v.mods.armsDown ? 1 : 0;
      if (world.fire('v', aim).refused === 'laughing') refused++;
    });
    hold(world, 'v', { aim }, 30);
    console.log(`feather:   laughing ${count(mark, 'effect_start')}, arms down for ${blocked} of 80 ticks (shots refused: laughing ${refused}), aiming again after ${!v.mods.armsDown}, hp ${world.playerStats('v').health}`);
    check(blocked >= 75 && refused >= 75 && !v.mods.armsDown && world.playerStats('v').health === 100, 'feather: laugh did not block aiming/shooting (or did damage)');
    world.dispose();
  },

  // ---- S4: body + movement ----

  // One table that describes how the body feels. The final character look is tuned with this: change body numbers
  // (constants RAGDOLL / BALANCE / MOTOR / WALK), rerun, compare.
  body_report() {
    const r = bodyReport();
    console.log(
      `body_report: mass ${r.mass} kg | stand 10 s drift ${r.drift} m tilt ${r.standTilt} | walk ${r.walkSpeed} m/s lean ${r.walkLean} rad head swing ${r.headSwing} | ` +
        `stop: skid ${r.skid} m, tilt ${r.stopTilt} rad, stumbles ${r.stopStumbles}, falls ${r.stopFalls} | jump rise ${r.jumpRise} m | ` +
        `trip: down after ${r.tripDown} ticks, up after ${r.getUp} ticks | arms idle: swing ${r.armSwing} rad while walking | joint warnings ${r.jointWarnings}`,
    );
    check(r.drift < 0.05, `body_report: standing drift ${r.drift} m`);
    check(r.walkSpeed > 2.7, `body_report: walk speed only ${r.walkSpeed} m/s`);
    check(r.stopFalls === 0, 'body_report: fell over on a plain stop');
    check(r.jumpRise > 0.9, `body_report: jump rise only ${r.jumpRise} m`);
    check(r.getUp > 0 && r.getUp < 150, `body_report: get-up after a trip took ${r.getUp} ticks (limit 150)`);
    check(r.jointWarnings === 0, `body_report: ${r.jointWarnings} joint warnings`);
  },

  // ---- S3: arrow effects (each one compared with the normal body) ----

  // Head arrow: floppy, top-heavy head. Walk 2 s, stop hard: how far the head swings and the body pitches, stumbles, falls.
  head_sway() {
    const res = (['normal', 'head'] as const).map((mode) => {
      const world = solo(`head_sway:${mode}`);
      const p = world.player(LOCAL_PLAYER);
      const mark = entries.length;
      if (mode === 'head') keepEffect(world, 'head', 'head');
      let neck = 0;
      let pitch = 0;
      hold(world, LOCAL_PLAYER, { move: 1 }, 120, () => {
        if (mode === 'head') keepEffect(world, 'head', 'head');
        neck = Math.max(neck, Math.abs(p.jointAngle('neck')));
      });
      hold(world, LOCAL_PLAYER, {}, 120, () => {
        if (mode === 'head') keepEffect(world, 'head', 'head');
        pitch = Math.max(pitch, tilt(p));
      });
      const out = { mode, neck: r2(neck), pitch: r2(pitch), stumbles: count(mark, 'stumble'), falls: count(mark, 'ragdoll_fall') };
      world.dispose();
      return out;
    });
    const [n, h] = res;
    console.log(`head_sway: walking head swing ${n.neck} -> ${h.neck} rad, stop pitch ${n.pitch} -> ${h.pitch} rad, stumbles ${n.stumbles} -> ${h.stumbles}, falls ${n.falls} -> ${h.falls}`);
    check(h.neck > n.neck * 1.5, 'head_sway: the head arrow barely changed the head swing');
    check(n.stumbles === 0 && n.falls === 0, 'head_sway: the normal body stumbled or fell on a plain stop');
    check(h.falls === 0, 'head_sway: the head arrow made the body fall over (should only wobble/stumble)');
  },

  // Arm arrow: arms windmill while walking; aiming still works (arm points, no elbow problems).
  arm_flail() {
    const world = solo('arm_flail');
    const p = world.player(LOCAL_PLAYER);
    const mark = entries.length;
    // L3: the back arm windmills while walking; the gun arm keeps aiming (with the swing, checked below)
    let spin = 0;
    let last = p.parts.armBackUpper.rotation();
    hold(world, LOCAL_PLAYER, { move: 1 }, 150, () => {
      keepEffect(world, 'arm', 'armFrontUpper');
      const a = p.parts.armBackUpper.rotation();
      spin += Math.abs(wrapAngle(a - last));
      last = a;
    });
    const aim = { angle: -0.3 };
    let armErr = 0;
    hold(world, LOCAL_PLAYER, { aim }, 90, (t) => {
      keepEffect(world, 'arm', 'armFrontUpper');
      if (t > 60) armErr = Math.max(armErr, Math.abs(wrapAngle(p.parts.armFrontUpper.rotation() - (aim.angle - Math.PI / 2))));
    });
    const turns = spin / (2 * Math.PI);
    console.log(`arm_flail: back arm turned ${r2(turns)} full circles in 2.5 s of walking, aiming afterwards: arm error ${r2(armErr)} rad, elbow warnings ${count(mark, 'joint_over_limit')}, falls ${count(mark, 'ragdoll_fall')}`);
    check(turns > 1.5, `arm_flail: arms only turned ${r2(turns)} circles`);
    check(armErr < 0.3, `arm_flail: the gun arm didn't follow the aim (L7: an arm hit no longer swings it): error ${r2(armErr)} rad`);
    world.dispose();
  },

  // L4 dragging limp (2 leg hits; was the S3 high-step leg-arrow limp): standing 10 s must not slide or fall; walking,
  // the hurt leg hangs and trails behind (bent, its foot behind the hip) while the body hops on the good one.
  leg_limp() {
    const world = solo('leg_limp');
    for (let i = 0; i < 2; i++) {
      world.bodyHit(LOCAL_PLAYER, 'legFrontLower', 1, 'sim');
      run(world, 150);
    }
    const p = world.player(LOCAL_PLAYER);
    const mark = entries.length;
    const x0 = p.center().x;
    let maxTilt = 0;
    run(world, 600, () => (maxTilt = Math.max(maxTilt, tilt(p))));
    const drift = Math.abs(p.center().x - x0);
    let behind = 0;
    let samples = 0;
    let kneeHurt = 0;
    hold(world, LOCAL_PLAYER, { move: 1 }, 180, (t) => {
      if (t < 60) return;
      samples++;
      // the dragging foot trails behind the hip (facing right: smaller x)
      if (p.parts.legFrontLower.translation().x < p.jointPos('hipFront').x) behind++;
      kneeHurt = Math.max(kneeHurt, Math.abs(p.jointAngle('kneeFront')));
    });
    const trail = Math.round((100 * behind) / Math.max(1, samples));
    // backing off while aiming forward drags the leg the wrong way (a chaos-match knee bent backward like this)
    let kneeWorst = 0;
    hold(world, LOCAL_PLAYER, { move: -1, aim: { angle: 0 } }, 180, () => (kneeWorst = Math.max(kneeWorst, p.limitOver('kneeFront') ?? 0)));
    hold(world, LOCAL_PLAYER, {}, 60);
    console.log(`leg_limp: dragging the front leg: standing 10 s drift ${r3(drift)} m, tilt ${r2(maxTilt)} rad | walking: hurt foot behind the hip ${trail}% of the time, hurt knee bent up to ${r2(kneeHurt)} rad, hops ${p.hops} | backing off: hurt knee up to ${r2(kneeWorst)} rad past its limit | falls ${count(mark, 'ragdoll_fall')}, joint warnings ${count(mark, 'joint_over_limit')}`);
    check(drift < 0.3, `leg_limp: the limping body slid ${r3(drift)} m while standing`);
    check(count(mark, 'ragdoll_fall') === 0, 'leg_limp: fell over while standing/walking with a dragging leg');
    check(trail > 60 && p.hops > 0, `leg_limp: the hurt leg doesn't trail (${trail}% behind) or no hops`);
    check(count(mark, 'joint_over_limit') === 0 && kneeWorst < 0.15, `leg_limp: the dragging knee bent ${r2(kneeWorst)} rad past its limit`);
    world.dispose();
  },

  // Dragging leg (L4: 2 leg hits) + jump: a normal jump (no misfire: decided 2026-10-08), and no fall on landing.
  drag_jump() {
    const rise = (dragging: boolean) => {
      const world = solo(`drag_jump:${dragging}`);
      for (let i = 0; i < (dragging ? 2 : 0); i++) {
        world.bodyHit(LOCAL_PLAYER, 'legFrontLower', 1, 'sim');
        run(world, 150);
      }
      const p = world.player(LOCAL_PLAYER);
      const mark = entries.length;
      const y0 = p.center().y;
      let peak = y0;
      hold(world, LOCAL_PLAYER, { jump: true }, 20, () => (peak = Math.min(peak, p.center().y)));
      hold(world, LOCAL_PLAYER, {}, 120, () => (peak = Math.min(peak, p.center().y)));
      const out = { rise: y0 - peak, falls: count(mark, 'ragdoll_fall'), jumps: count(mark, 'jump') };
      world.dispose();
      return out;
    };
    const whole = rise(false);
    const drag = rise(true);
    console.log(`drag_jump: whole body rises ${r2(whole.rise)} m, with a dragging leg ${r2(drag.rise)} m (${r2(drag.rise / whole.rise)}x), falls ${drag.falls}`);
    check(drag.jumps === 1 && drag.falls === 0 && drag.rise / whole.rise >= 0.85, `drag_jump: a dragging leg's jump rose ${r2(drag.rise)} m (${r2(drag.rise / whole.rise)}x) with ${drag.falls} falls`);
  },

  // Stumble: a standing body tipped forward catches itself with a few quick steps instead of falling.
  stumble() {
    const world = solo('stumble');
    const p = world.player(LOCAL_PLAYER);
    const mark = entries.length;
    // shove the top forward and the feet back (a tip, without moving the body as a whole)
    world.push(p.parts.head, { x: 9 * p.parts.head.mass(), y: 0 });
    world.push(p.parts.torso, { x: 4 * p.parts.torso.mass(), y: 0 });
    let maxTilt = 0;
    const x0 = p.center().x;
    run(world, 180, () => (maxTilt = Math.max(maxTilt, tilt(p))));
    const st = since(mark).find((e) => e.ev === 'stumble');
    console.log(`stumble:   tipped to ${r2(maxTilt)} rad, stumble ${!!st} (dir ${st?.dir}), stepped ${r2(p.center().x - x0)} m, fell ${count(mark, 'ragdoll_fall') > 0}, upright now ${tilt(p) < 0.15}`);
    check(!!st, 'stumble: a forward tip did not trigger the stumble steps');
    check(count(mark, 'ragdoll_fall') === 0, 'stumble: fell instead of catching itself');
    world.dispose();
  },



  // 3 filler bots + 1 person standing still, 2 minutes in the Test Lab: bots must find shots, score kills,
  // never get stuck, never send anything the room refuses, and stay cheap to run.
  // L0 spike: can a body lose parts and still move? The same tests on a whole body, one thigh stump (hops), two stumps
  // (tiny steps), the back forearm gone, and a leg shot off mid-walk. Numbers decide go / change-the-rules for L4.
  // L4: every stage of the damage ladders, reached through the real rules, measured against targets.
  damage_report() {
    const rows = Object.keys(DAMAGE_TARGETS).map((k) => [k, damageTrial(k)] as const);
    const whole = rows[0][1];
    console.log('damage_report:');
    for (const [k, r] of rows) {
      const t = DAMAGE_TARGETS[k];
      const speedShare = r2(r.speed / whole.speed);
      const jumpShare = r2(r.jumpRise / whole.jumpRise);
      const fails: string[] = [];
      if (speedShare < t.speed[0] || speedShare > t.speed[1]) fails.push(`speed ${speedShare}x not in ${t.speed.join('-')}`);
      if (t.jump && (jumpShare < t.jump[0] || jumpShare > t.jump[1])) fails.push(`jump ${jumpShare}x not in ${t.jump.join('-')}`);
      if (r.upright < 95) fails.push(`upright ${r.upright}%`);
      if (!(r.getUp <= 1.5)) fails.push(`get-up ${r.getUp} s`);
      if (r.jointWarnings || r.problems.length) fails.push(`problems [${r.problems.join(',')}]`);
      console.log(
        `  ${fails.length ? 'FAIL' : 'ok  '} ${k.padEnd(18)} stage ${r.stage} | upright ${r.upright}% drift ${r.drift} m | walk ${r.speed} m/s (${speedShare}x) | jump ${r.jumpRise} m (${jumpShare}x) | get-up ${r.getUp} s | head ${r.headHeight} m${fails.length ? ' | ' + fails.join('; ') : ''}`,
      );
      for (const f of fails) problems.push(`damage_report ${k}: ${f}`);
    }
  },

  limb_loss() {
    const modes = ['whole', 'one_leg', 'two_stumps', 'mid_walk'] as const;
    const res = Object.fromEntries(modes.map((m) => [m, limbTrial(m)])) as Record<(typeof modes)[number], ReturnType<typeof limbTrial>>;
    for (const m of modes) {
      res[m].speedShare = r2(res[m].speed / res.whole.speed);
      res[m].jumpShare = r2(res[m].jumpRise / res.whole.jumpRise);
    }
    for (const m of modes) {
      const r = res[m];
      console.log(
        `limb_loss ${m.padEnd(10)}: upright ${r.upright}% | stand drift ${r.drift} m | walk ${r.speed} m/s (${r.speedShare}x whole) hops ${r.hops} | ` +
          `jump rise ${r.jumpRise} m (${r.jumpShare}x) | head height ${r.headHeight} m | aim error ${r.aimErr} rad | piece on ground ${r.pieceGrounded} | ` +
          `joint warnings ${r.jointWarnings}, other problems ${r.problems}`,
      );
    }
    for (const m of modes) {
      const r = res[m];
      check(r.upright >= 90, `limb_loss ${m}: upright only ${r.upright}% of the time`);
      check(r.jointWarnings === 0 && r.problems === 0, `limb_loss ${m}: ${r.jointWarnings} joint warnings, ${r.problems} other problems`);
      if (m !== 'whole') check(r.pieceGrounded, `limb_loss ${m}: the lost piece isn't lying flat on the ground`);
    }
    check(res.one_leg.speedShare >= 0.85 && res.one_leg.hops > 0, `limb_loss one_leg: hopping at ${res.one_leg.speedShare}x the walk speed, ${res.one_leg.hops} hops`);
    check(res.one_leg.jumpShare >= 0.85, `limb_loss one_leg: jump only ${res.one_leg.jumpShare}x as high`);
    check(res.two_stumps.speedShare >= 0.45 && res.two_stumps.jumpRise > 0.2, `limb_loss two_stumps: walk ${res.two_stumps.speedShare}x, jump ${res.two_stumps.jumpRise} m`);
  },

  // L2: how movement feels, measured. Each number has a target range (FEEL); the report says pass/fail per line.
  // L7 step 5: hits you can feel. Each case runs the same body twice, once hit and once not, so the difference is
  // exactly what the hit did: a runner hit head-on is set back; a head hit pitches the torso back; a leg hit pitches it
  // forward; a jump hit mid-air lands shorter; a standing body hit in the torso stays up; no joint warnings.
  hit_reaction() {
    const BULLET = { x: -32, y: 0 }; // coming from the right, at the body (head-on for a runner going right)
    const torsoA = (w: GameWorld) => w.player(LOCAL_PLAYER).parts.torso.rotation();
    /** Runs `ticks` with `controls(i)`, hitting `zone` at tick `at` (or never); returns x, peak torso pitch and falls. */
    const trial = (name: string, zone: 'head' | 'torso' | 'leg' | null, at: number, ticks: number, controls: (i: number) => Partial<typeof NO_CONTROLS>) => {
      const w = solo(`hit_reaction:${name}:${zone ?? 'none'}`);
      const mark = entries.length;
      const a0 = torsoA(w);
      let back = 0;
      let fwd = 0;
      run(w, ticks, (i) => {
        w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, ...controls(i) });
        if (zone && i === at) w.hitReaction(LOCAL_PLAYER, zone, BULLET);
        // pitch "back" = away from the shooter (to the left here: a negative torso angle in y-down coordinates)
        const d = torsoA(w) - a0;
        back = Math.max(back, -d);
        fwd = Math.max(fwd, d);
      });
      const out = { x: w.player(LOCAL_PLAYER).center().x, back, fwd, falls: count(mark, 'ragdoll_fall'), joints: since(mark).filter((e) => e.ev === 'joint_over_limit').length };
      w.dispose();
      return out;
    };
    const runR = () => ({ move: 1 as const });
    const jumpR = (i: number) => ({ move: 1 as const, jump: i < 20 }); // (a held, full jump)
    // runner hit head-on after reaching full speed (tick 40), measured 0.5 s later
    const runC = trial('run', null, 40, 70, runR);
    const runH = trial('run', 'torso', 40, 70, runR);
    const setBack = runC.x - runH.x;
    // standing hits
    const stand = () => ({});
    const head = trial('stand', 'head', 10, 60, stand);
    const leg = trial('stand', 'leg', 10, 60, stand);
    const torso = trial('stand', 'torso', 10, 90, stand);
    // a running jump hit near the top (tick 15), measured on landing-ish (tick 70)
    const jumpC = trial('jump', null, 15, 70, jumpR);
    const jumpH = trial('jump', 'torso', 15, 70, jumpR);
    const shorter = jumpC.x - jumpH.x;
    const joints = [runH, head, leg, torso, jumpH].reduce((n, t) => n + t.joints, 0);
    console.log(
      `hit_reaction: runner set back ${r2(setBack)} m; head hit pitches back ${r2(head.back)} rad (falls ${head.falls}); leg hit pitches forward ${r2(leg.fwd)} rad (falls ${leg.falls}); ` +
        `torso hit standing: falls ${torso.falls}; jump hit lands ${r2(shorter)} m shorter; joint warnings ${joints} (knock ${HIT_REACTION.knock.torso} m/s, flinch ${HIT_REACTION.flinchTicks} ticks)`,
    );
    check(setBack >= 0.3 && setBack <= 0.6, `hit_reaction: a runner hit head-on was set back ${r2(setBack)} m (want 0.3-0.6)`);
    check(head.back >= 0.1, `hit_reaction: a head hit pitched the torso back only ${r2(head.back)} rad`);
    check(leg.fwd >= 0.1, `hit_reaction: a leg hit pitched the torso forward only ${r2(leg.fwd)} rad`);
    check(torso.falls === 0, 'hit_reaction: a standing body hit in the torso fell over');
    check(shorter >= 0.2, `hit_reaction: a jump hit mid-air landed only ${r2(shorter)} m shorter`);
    check(joints === 0, `hit_reaction: ${joints} joint warnings`);
  },

  // L7: floating on a balloon (the "Everyone Has Balloons" round's 20 s balloon): it hovers under the arena's top
  // (never off the screen), stays in from the sides, swims up / down with jump / crouch, and the legs run in the air.
  balloon_float() {
    const w = freshWorld('balloon_float', false);
    w.bounds = { width: 30, height: GROUND_Y + 1 };
    w.addBox('ground', 'fixed', { x: 15, y: GROUND_Y + 0.5 }, { x: 15, y: 0.5 });
    w.addPlayer(LOCAL_PLAYER, { x: 15, y: GROUND_Y }, 1);
    run(w, 60);
    const mark = entries.length;
    w.specials.giveBalloon(LOCAL_PLAYER, 1200);
    const p = w.player(LOCAL_PLAYER);
    const y = () => p.parts.torso.translation().y;
    let top = Infinity;
    let hipMin = 0;
    let hipMax = 0;
    run(w, 600, () => { // 10 s: up to the cap and hovering there
      w.setControls(LOCAL_PLAYER, NO_CONTROLS);
      top = Math.min(top, y());
    });
    const hover = y();
    run(w, 90, () => w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, crouch: true })); // swim down 1.5 s
    const down = y() - hover;
    run(w, 120, () => w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true })); // swim up 2 s
    const upAgain = y();
    let left = Infinity;
    run(w, 300, () => { // swim left into the side for 5 s
      w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: -1 });
      left = Math.min(left, p.parts.torso.translation().x);
      const hip = p.jointAngle('hipFront') * p.facing;
      hipMin = Math.min(hipMin, hip);
      hipMax = Math.max(hipMax, hip);
    });
    const pops = since(mark).filter((e) => e.ev === 'balloon_pop').length;
    const out = since(mark).filter((e) => e.ev === 'left_arena' || e.ev === 'death').length;
    console.log(
      `balloon_float: highest torso y ${r2(top)} (cap ${SPECIAL.balloon.topMargin}), hovers at ${r2(hover)}; swimming down 1.5 s sank ${r2(down)} m, swimming up got back to ${r2(upAgain)}; ` +
        `swimming left for 5 s stopped at x ${r2(left)} (side margin ${SPECIAL.balloon.sideMargin}); legs ran ${r2(hipMin)}..${r2(hipMax)} rad; pops ${pops}, deaths/left ${out}`,
    );
    check(top > SPECIAL.balloon.topMargin - 0.8, `balloon_float: floated up to y ${r2(top)}, above the cap ${SPECIAL.balloon.topMargin}`);
    check(down > 0.5, `balloon_float: swimming down sank only ${r2(down)} m`);
    check(upAgain < hover + down - 0.5, 'balloon_float: swimming up did not rise');
    check(left > SPECIAL.balloon.sideMargin * 0.4, `balloon_float: drifted to x ${r2(left)}, past the side margin`);
    check(hipMax - hipMin > 0.8, `balloon_float: the legs barely moved in the air (${r2(hipMin)}..${r2(hipMax)})`);
    check(pops === 0 && out === 0, `balloon_float: ${pops} pops, ${out} deaths / left the arena`);
    w.dispose();
  },

  // L7 step 8: how springy the legs are. Running: the knees' biggest bend and the hips' swing range; a running jump:
  // the legs in the air; the landing: how far the body sinks below its standing height and how fast it springs back.
  // feel_report and body_report must still pass with 0 falls.
  leg_report() {
    const w = feelWorld('leg_report', 10);
    const p = w.player(LOCAL_PLAYER);
    const mark = entries.length;
    const height = () => Math.max(...p.footPoints().map((f) => f.y)) - p.center().y;
    const stand = height();
    const k = (n: 'kneeFront' | 'kneeBack' | 'hipFront' | 'hipBack') => p.jointAngle(n) * p.facing;
    let kneeMax = 0;
    let hipMin = 0;
    let hipMax = 0;
    run(w, 120, (i) => {
      w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
      if (i < 40) return; // (up to speed first)
      kneeMax = Math.max(kneeMax, k('kneeFront'), k('kneeBack'));
      hipMin = Math.min(hipMin, k('hipFront'), k('hipBack'));
      hipMax = Math.max(hipMax, k('hipFront'), k('hipBack'));
    });
    // running height vs standing (the bent running knees lower the body a little)
    let runLow = 0;
    run(w, 30, () => {
      w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1 });
      runLow = Math.max(runLow, stand - height());
    });
    // stop, then a standing jump: the legs in the air (after the first 0.2 s), then the landing
    run(w, 90, () => w.setControls(LOCAL_PLAYER, NO_CONTROLS));
    let airKnee = 0;
    let airTicks = 0;
    // Split Leap: how far the legs open in the air (back hip minus front hip, rad) and the jump's rise
    let split = 0;
    const footY0 = p.center().y;
    let rise = 0;
    let landedAt = -1;
    let landKnee = 0;
    let sink = 0;
    let back = -1;
    let over = 0;
    run(w, 150, (i) => {
      w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: i < 20 });
      if (!p.grounded && i > 12) {
        airKnee += (k('kneeFront') + k('kneeBack')) / 2;
        airTicks++;
      }
      if (!p.grounded) split = Math.max(split, k('hipBack') - k('hipFront'));
      rise = Math.max(rise, footY0 - p.center().y);
      if (landedAt < 0 && p.grounded && i > 12) landedAt = i;
      if (landedAt >= 0) {
        landKnee = Math.max(landKnee, k('kneeFront'), k('kneeBack'));
        const h = height();
        sink = Math.max(sink, stand - h);
        if (back < 0 && i > landedAt + 2 && stand - h < 0.02) back = i - landedAt;
        if (back >= 0) over = Math.max(over, h - stand);
      }
    });
    const falls = count(mark, 'ragdoll_fall');
    const joints = since(mark).filter((e) => e.ev === 'joint_over_limit').length;
    console.log(
      `leg_report: running knees bend up to ${r2(kneeMax)} rad, hips swing ${r2(hipMin)}..${r2(hipMax)} rad; running the body is up to ${r2(runLow * 100)} cm lower; in the air knees average ${r2(airTicks ? airKnee / airTicks : 0)} rad, legs open up to ${r2(split)} rad (rise ${r2(rise)} m); ` +
        `a standing jump's landing bends the knees ${r2(landKnee)} rad and sinks ${r2(sink * 100)} cm, back up in ${back} ticks (overshoot ${r2(over * 100)} cm); falls ${falls}, joint warnings ${joints}`,
    );
    check(falls === 0, `leg_report: the body fell ${falls} times`);
    check(joints === 0, `leg_report: ${joints} joint warnings`);
    w.dispose();
  },

  // L7 step 7: how long a body lives after losing a leg. In a 4-player bot fight each bot has a leg shot down to a stump
  // (the real ladder: 3 leg hits) a second after it spawns; measured from the loss to its death. (Your play log had a
  // median 3.3 s: losing a leg was almost a death sentence; steps 3 and 5 should give more time. Target over 6 s.)
  stump_survival() {
    const { room, mark } = simRoom('stump_survival', { rotation: [TEST_LAB] });
    const w = () => room.world;
    const cutAt = new Map<string, number>();
    for (let t = 0; t < 3 * 60 * 60; t++) {
      room.tick();
      for (const [id, p] of w().players) {
        if (!id.startsWith('b') || !w().stats.get(id)?.alive || p.stumps.size > 0) continue;
        const born = cutAt.get(id);
        if (born === undefined) cutAt.set(id, w().tick + 60);
        else if (w().tick >= born) {
          for (let i = 0; i < 3 && p.stumps.size === 0; i++) w().bodyHit(id, 'legFrontLower', 1, 'sim:stump_survival');
          cutAt.delete(id);
        }
      }
      for (const id of [...cutAt.keys()]) if (!w().stats.get(id)?.alive) cutAt.delete(id);
    }
    const log = since(mark);
    const after: number[] = [];
    for (const e of log.filter((x) => x.ev === 'part_lost')) {
      const died = log.find((d) => d.ev === 'death' && d.id === e.id && Number(d.tick) >= Number(e.tick));
      if (died) after.push((Number(died.tick) - Number(e.tick)) / 60);
    }
    after.sort((a, b) => a - b);
    const median = after.length ? after[Math.floor(after.length / 2)] : 0;
    console.log(`stump_survival: ${log.filter((x) => x.ev === 'part_lost').length} legs lost, ${after.length} died after, median ${r3(median)} s (quartiles ${r3(after[Math.floor(after.length / 4)] ?? 0)} / ${r3(after[Math.floor((after.length * 3) / 4)] ?? 0)} s)`);
    check(after.length >= 5, `stump_survival: only ${after.length} deaths after a lost leg`);
    check(median > 6, `stump_survival: a body lived a median ${r3(median)} s after losing a leg (target over 6 s)`);
    room.close();
  },

  // L7 step 6: each melee motion at a standing target at several distances: does it hit, which part, how long from
  // the click to the hit, and does the mace's sweep trip. (Each swing on a fresh world, so they don't interact.)
  melee_motions() {
    const rows: string[] = [];
    const staggers: number[] = [];
    let staggerFalls = 0;
    for (const weapon of ['bat', 'mace'] as const) {
      const out: string[] = [];
      let close = 0;
      let trips = 0;
      for (const gap of [0.8, 1.2, 1.6, 2.2]) {
        const w = freshWorld(`melee_motions:${weapon}:${gap}`, false);
        w.addBox('ground', 'fixed', { x: 20, y: GROUND_Y + 0.5 }, { x: 20, y: 0.5 });
        w.addPlayer('a', { x: 10, y: GROUND_Y }, 1);
        w.addPlayer('b', { x: 10 + gap, y: GROUND_Y }, -1);
        run(w, 60);
        w.damage.get('a')!.weapon = weapon;
        w.setControls('a', { ...NO_CONTROLS, aim: { angle: 0 } });
        run(w, 20);
        w.stats.get('a')!.readyAt = w.tick;
        const mark = entries.length;
        const bx = w.player('b').center().x;
        w.fire('a', { angle: 0 });
        run(w, 90);
        const hit = since(mark).find((e) => e.ev === 'melee_hit');
        const tripped = since(mark).some((e) => e.ev === 'trip' && e.id === 'b');
        const staggered = since(mark).some((e) => e.ev === 'stagger' && e.id === 'b');
        // L7: a hit on the body / head makes the victim stagger back a few steps and stay up
        const back = w.player('b').center().x - bx;
        const fell = since(mark).some((e) => e.ev === 'ragdoll_fall' && e.id === 'b');
        if (staggered) {
          staggers.push(back);
          if (fell) staggerFalls++;
        }
        out.push(`${gap} m: ${hit ? `${hit.part} after ${Number(hit.tick)} ticks` : 'miss'}${tripped ? ' (tripped)' : ''}${staggered ? ` (staggered back ${r2(back)} m${fell ? ', fell' : ''})` : ''}`);
        if (hit && gap <= 1.2) close++;
        if (tripped) trips++;
        w.dispose();
      }
      rows.push(`${weapon}: ${out.join(', ')}`);
      check(close === 2, `melee_motions: the ${weapon} missed a standing target in reach (0.8 or 1.2 m)`);
      if (weapon === 'mace') check(trips > 0, 'melee_motions: the mace sweep never tripped anyone');
      else check(trips === 0, 'melee_motions: the bat tripped someone (only the mace sweep should)');
    }
    console.log(`melee_motions: ${rows.join(' | ')}`);
    check(staggers.length > 0 && staggers.every((d) => d > 0.6 && d < 2.5), `melee_motions: staggers back ${staggers.map(r2).join(', ')} m (want 2-3 steps: 0.6-2.5 m)`);
    check(staggerFalls === 0, `melee_motions: ${staggerFalls} staggers ended in a fall`);
  },

  feel_report() {
    const f = feelReport();
    const t = FEEL;
    const lines: [string, string, boolean][] = [
      ['time to 90% speed', `${f.t90} s`, f.t90 <= t.t90],
      ['top run speed', `${f.top} m/s`, f.top >= t.top],
      ['stop: time / distance', `${f.stopTime} s / ${f.stopDist} m`, f.stopTime <= t.stopTime && f.stopDist <= t.stopDist],
      ['stop: tilt / stumbles / falls', `${f.stopTilt} rad / ${f.stopStumbles} / ${f.stopFalls}`, f.stopStumbles === 0 && f.stopFalls === 0],
      ['turn round on the ground', `${f.groundTurn} s, falls ${f.turnFalls}`, f.groundTurn <= t.groundTurn && f.turnFalls === 0],
      ['jump held: rise / apex', `${f.holdRise} m / ${f.apex} s`, f.holdRise >= t.holdRise[0] && f.holdRise <= t.holdRise[1] && f.apex <= t.apex],
      ['jump tapped: rise', `${f.tapRise} m (${f.tapShare}x held)`, f.tapRise >= t.tapRise && f.tapShare <= t.tapShare],
      ['turn round in the air', `${f.airTurn} s`, f.airTurn <= t.airTurn],
      ['coyote: 4 ticks late / 10 late', `${f.coyoteLate} / ${f.coyoteTooLate}`, f.coyoteLate && !f.coyoteTooLate],
      ['buffer: 4 ticks early / 12 early', `${f.bufferEarly} / ${f.bufferTooEarly}`, f.bufferEarly && !f.bufferTooEarly],
      ['get up after a trip', `${f.getUp} s`, f.getUp > 0 && f.getUp < t.getUp],
      ['joint warnings', `${f.jointWarnings}`, f.jointWarnings === 0],
    ];
    console.log('feel_report:');
    for (const [what, value, ok] of lines) {
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what.padEnd(32)} ${value}`);
      check(ok, `feel_report: ${what} = ${value}`);
    }
  },

  bots() {
    // (SIM_BOT_SEED=n gives a different but repeatable fight, for tuning BOT numbers over several runs)
    const { room, mark } = simRoom('bots', { rotation: [TEST_LAB], botSeed: Number(process.env.SIM_BOT_SEED ?? 0) || 0 });
    const times: number[] = [];
    for (let t = 0; t < 7200; t++) {
      const t0 = performance.now();
      room.tick();
      times.push(performance.now() - t0);
    }
    const log = since(mark);
    const shots = log.filter((e) => e.ev === 'bot_fire').length;
    const botKills = log.filter((e) => e.ev === 'death' && String(e.killer ?? '').startsWith('b')).length;
    const hits = log.filter((e) => e.ev === 'damage' && String(e.by).startsWith('b'));
    const onBots = hits.filter((e) => String(e.id).startsWith('b')).length;
    const onPerson = hits.length - onBots;
    // L7: how often a bot hits a moving bot it shot at (target: about 25%, BOT.aimError / BOT.aimTicks)
    const atBots = log.filter((e) => e.ev === 'bot_fire' && String(e.target ?? '').startsWith('b')).length;
    // (bullet hits only: melee swings and blasts log damage too, with speed 0)
    const bulletOnBots = hits.filter((e) => String(e.id).startsWith('b') && Number(e.speed) > 0).length;
    const movingRate = bulletOnBots / Math.max(1, atBots);
    const turns = log.filter((e) => e.ev === 'bot_turn').length;
    const rests = log.filter((e) => e.ev === 'bot_rest' && e.why === 'shots').length;
    const emptied = log.filter((e) => e.ev === 'stamina_empty' && String(e.id).startsWith('b')).length;
    const stuck = log.filter((e) => e.ev === 'bot_stuck');
    const refused = log.filter((e) => ['bot_bad_message', 'fire_too_soon', 'shots_too_close'].includes(String(e.ev)) && String(e.id ?? e.who ?? e.owner).startsWith('b'));
    // L5: critical hits knock guns away; disarmed bots fight on with melee
    const crits = log.filter((e) => e.ev === 'crit').length;
    const swings = log.filter((e) => e.ev === 'bot_swing').length;
    const meleeHits = log.filter((e) => e.ev === 'melee_hit').length;
    const shattered = log.filter((e) => e.ev === 'body_broken').length;
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p99 = [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.99)];
    // L7: how long a life lasts (spawn/respawn to death), the "dying too fast" number (was a median 11.8 s for a person)
    const bornAt = new Map<string, number>();
    const lives: number[] = [];
    for (const e of log) {
      if (e.ev === 'respawn') bornAt.set(String(e.id), Number(e.tick));
      else if (e.ev === 'death') lives.push((Number(e.tick) - (bornAt.get(String(e.id)) ?? 0)) / 60);
    }
    lives.sort((a, b) => a - b);
    const medianLife = lives.length ? lives[Math.floor(lives.length / 2)] : Infinity;
    // L7 step 7: time from losing a leg to dying (your play log: a median 3.3 s; the target is over 6 s)
    const afterLoss: number[] = [];
    for (const e of log.filter((x) => x.ev === 'part_lost')) {
      const died = log.find((d) => d.ev === 'death' && d.id === e.id && Number(d.tick) >= Number(e.tick));
      if (died) afterLoss.push((Number(died.tick) - Number(e.tick)) / 60);
    }
    afterLoss.sort((a, b) => a - b);
    const medianAfterLoss = afterLoss.length ? afterLoss[Math.floor(afterLoss.length / 2)] : null;
    console.log(`bots:      median life ${r3(medianLife)} s over ${lives.length} deaths; legs lost ${log.filter((x) => x.ev === 'part_lost').length}, then death after a median ${medianAfterLoss === null ? '-' : r3(medianAfterLoss)} s (${afterLoss.length} of them died)`);
    console.log(
      `bots:      ${room.botCount} bots + 1 idle person, 2 min in ${room.match.info.arena}/${room.match.info.size}: shots ${shots}, hits ${hits.length} (${onBots} on moving bots, bullets ${bulletOnBots} = ${Math.round(100 * movingRate)}% of ${atBots} shots at them, ${onPerson} on the still person, ${Math.round((100 * hits.length) / Math.max(1, shots))}%), kills ${botKills}, rested for stamina ${rests}x (arms emptied ${emptied}x), ` +
        `crits ${crits} -> melee swings ${swings}, melee hits ${meleeHits}, bodies shattered ${shattered}, ` +
        `turned at obstacles ${turns}, stuck ${stuck.length}, refused ${refused.length}, room tick avg ${r3(avg)} ms back-to-back (99% under ${r3(p99)} ms; the live paced server reads higher, see tools/tick-probe.ts)`,
    );
    check(shots > 40, `bots: only ${shots} shots in 2 min`);
    // (one 2-minute fight is noisy: over 4 seeds BOT.aimError 0.3 averages 24%; this band catches a real change)
    check(movingRate >= 0.12 && movingRate <= 0.38, `bots: hit ${Math.round(100 * movingRate)}% of shots at moving bots (L7 target about 25%)`);
    check(botKills > 0, 'bots: nobody died in 2 min of bot fighting');
    check(stuck.length === 0, `bots: a bot got stuck (${JSON.stringify(stuck[0])})`);
    // L7: crits are rare now (8%, only after 0.25 s in the air): target about 1 a minute in a 4-player room
    console.log(`bots:      crits ${crits} in 2 min (${r3(crits / 2)} a minute; target about 1)`);
    check(crits <= 6, `bots: ${crits} critical hits in 2 min (L7 target about 1 a minute)`);
    // (only bots that lived 5 s after losing the gun count, time to walk to someone: the knock comes in the air and
    // some fall straight into a pit; the idle person never swings)
    const disarmedLived = log.filter((c) => c.ev === 'crit' && String(c.who).startsWith('b')).filter((c) => {
      const died = log.find((e) => e.ev === 'death' && e.id === c.who && Number(e.tick) >= Number(c.tick));
      return !died || Number(died.tick) - Number(c.tick) > 300;
    }).length;
    check(disarmedLived === 0 || swings > 0, `bots: ${disarmedLived} bots lived on with a melee weapon but none swung it`);
    check(refused.length === 0, `bots: the room refused or clamped bot messages (${refused[0]?.ev})`);
    check(avg < 4, `bots: room tick averaged ${r3(avg)} ms (budget 4 ms at 60 Hz)`);
    room.close();
  },

  // L5: a bat player chases a standing target through three lives: hit rate, time to break a body (the
  // MELEE.shatterAfter-th hit), run speed vs a gun player, and no physics blowups (part speeds) from swings or pieces.
  melee() {
    const world = freshWorld('melee', false);
    world.addBox('ground', 'fixed', { x: 40, y: GROUND_Y + 0.5 }, { x: 40, y: 0.5 });
    world.bounds = { width: 80, height: GROUND_Y + 4 };
    world.spawnPoints = [{ x: 22, y: GROUND_Y, facing: -1 }, { x: 26, y: GROUND_Y, facing: -1 }];
    world.addPlayer('a', { x: 10, y: GROUND_Y }, 1);
    world.addPlayer('b', { x: 16, y: GROUND_Y }, -1);
    world.addPlayer('c', { x: 4, y: GROUND_Y }, 1); // a gun player, for the run-speed comparison
    run(world, 60);
    const speedOf = (id: string, ticks: number) => {
      let sum = 0;
      run(world, ticks, (i) => {
        world.setControls(id, { ...NO_CONTROLS, move: 1 });
        if (i >= 30) sum += world.player(id).speedX();
      });
      world.setControls(id, NO_CONTROLS);
      return sum / (ticks - 30);
    };
    const gunSpeed = speedOf('c', 90);
    // knock 'a''s gun away (a forced air-shot crit)
    world.melee.roll = () => 0;
    for (const b of world.player('a').attached()) world.push(b, { x: 0, y: -6 * b.mass() });
    for (let i = 0; i < 10 && world.player('a').grounded; i++) world.step();
    run(world, MELEE.critMinAirTicks); // (L7: a crit needs 0.25 s in the air)
    world.melee.onBulletHit('a', 'c');
    world.melee.roll = seededRandom(5);
    run(world, 90);
    const meleeSpeed = speedOf('a', 90);
    world.relocate('c', { x: 60, y: GROUND_Y }, 1); // out of the way
    const mark = entries.length;
    const lives: number[] = [];
    let lifeStart = world.tick;
    let maxSpeed = 0;
    let lastAlive = true;
    for (let t = 0; t < 60 * 60 && lives.length < 3; t++) {
      const st = world.playerStats('a');
      const alive = world.playerStats('b').alive;
      if (alive && !lastAlive) lifeStart = world.tick;
      if (!alive && lastAlive) lives.push(world.tick - lifeStart);
      lastAlive = alive;
      const shoulder = world.player('a').jointPos('shoulderFront');
      const at = world.player('b').center();
      const d = Math.hypot(at.x - shoulder.x, at.y - shoulder.y);
      const angle = Math.atan2(at.y - shoulder.y, at.x - shoulder.x);
      const dx = at.x - shoulder.x;
      world.setControls('a', { ...NO_CONTROLS, aim: { angle }, move: alive && Math.abs(dx) > MELEE.reach * 0.5 ? (Math.sign(dx) as -1 | 1) : 0 });
      if (alive && d <= MELEE.reach * 0.9 && st.fireBlock(world.tick) === null) world.fire('a', { angle });
      st.refill(100); // (this is about hits, not stamina)
      world.step();
      for (const id of ['a', 'b']) for (const n of PART_NAMES) maxSpeed = Math.max(maxSpeed, Math.hypot(world.player(id).parts[n].linvel().x, world.player(id).parts[n].linvel().y));
    }
    const log = entries.slice(mark);
    const swings = log.filter((e) => e.ev === 'melee_swing').length;
    const hits = log.filter((e) => e.ev === 'melee_hit');
    const broke = hits.filter((e) => e.broke).length;
    const deaths = log.filter((e) => e.ev === 'death' && e.id === 'b');
    const avg = lives.reduce((a, b) => a + b, 0) / Math.max(1, lives.length);
    console.log(
      `melee:     ${swings} swings, ${hits.length} hits (${Math.round((100 * hits.length) / Math.max(1, swings))}%), ${broke} limbs broken, lives ${lives.map((l) => `${r2(l / 60)}s`).join(' / ')} (avg ${r2(avg / 60)} s to break a body), ` +
        `deaths ${deaths.map((e) => e.cause).join(',')}, run ${r2(meleeSpeed)} m/s vs gun ${r2(gunSpeed)} (x${r2(meleeSpeed / gunSpeed)}), fastest part ${r2(maxSpeed)} m/s`,
    );
    check(lives.length === 3, `melee: only ${lives.length} of 3 bodies broken in 60 s`);
    check(deaths.every((e) => e.cause === 'shattered' || e.cause === 'melee'), `melee: a death that wasn't from melee: ${deaths.map((e) => e.cause)}`);
    // (L7: the bat's upswing often lands on the head, so a body can die of the damage before the shattering hit:
    // each life needs at least one hit, not always MELEE.shatterAfter)
    check(hits.length >= lives.length && hits.length / Math.max(1, swings) > 0.5, `melee: hit rate too low (${hits.length}/${swings})`);
    check(meleeSpeed / gunSpeed > 1.1 && meleeSpeed / gunSpeed < 1.45, `melee: melee run speed x${r2(meleeSpeed / gunSpeed)} (want about x${MELEE.runFactor})`);
    check(maxSpeed < 40, `melee: a body part reached ${r2(maxSpeed)} m/s (blowup)`);
    world.dispose();
  },

  // L6: every arena in the rotation gets a 1 min bot fight (3 bots + an idle person, the small size): shots go out
  // and land, people die, no bot gets stuck, nothing warns. The reach check proves the layout; this proves it plays.
  arena_fights() {
    const out: string[] = [];
    for (const arena of ROTATION) {
      const { room, mark } = simRoom(`arena_fights:${arena.id}`, { rotation: [arena] });
      for (let t = 0; t < 3600; t++) room.tick();
      const log = since(mark);
      const shots = log.filter((e) => e.ev === 'bot_fire').length;
      const hits = log.filter((e) => e.ev === 'damage' && String(e.by).startsWith('b')).length;
      const deaths = log.filter((e) => e.ev === 'death');
      const ringOuts = deaths.filter((e) => e.cause === 'pit').length;
      const stuck = log.filter((e) => e.ev === 'bot_stuck').length;
      const refused = log.filter((e) => ['bot_bad_message', 'fire_too_soon', 'shots_too_close'].includes(String(e.ev))).length;
      const crits = log.filter((e) => e.ev === 'crit').length;
      out.push(`${arena.id}/${room.match.info.size} shots ${shots} hits ${hits} (${Math.round((100 * hits) / Math.max(1, shots))}%) deaths ${deaths.length} (ring-outs ${ringOuts}) crits ${crits} stuck ${stuck} refused ${refused}`);
      check(shots > 20 && hits > 5, `arena_fights: ${arena.id}: hardly any fighting (${shots} shots, ${hits} hits in 1 min)`);
      check(deaths.length > 0, `arena_fights: ${arena.id}: nobody died in 1 min`);
      check(stuck === 0, `arena_fights: ${arena.id}: a bot got stuck ${stuck}x`);
      check(refused === 0, `arena_fights: ${arena.id}: ${refused} bot messages refused`);
      room.close();
    }
    console.log(`arena_fights: ${out.join(' | ')}`);
  },

  // L6: what a body can really reach, for the arena reach check (`arenaReach`, numbers in REACH): the highest ledge it
  // climbs and the widest gap it clears (level, 1 m up, 2 m down), running and from standing, whole and on two stumps.
  // Each case tries a few jump timings and keeps the best (a player times their jump). REACH must stay at or under these.
  jump_reach() {
    const G = 20;
    const trial = (name: string, stumps: boolean, solids: { x: number; y: number; w: number; h: number }[], startX: number, jumpAt: number, done: (feet: { x: number; y: number }) => boolean, fail: (feet: { x: number; y: number }) => boolean) => {
      const world = freshWorld(`jump_reach:${name}`, false);
      world.bounds = { width: 80, height: G + 10 };
      world.addBox('ground_l', 'fixed', { x: 10, y: G + 5 }, { x: 10, y: 5 }); // (each case adds its own right side)
      solids.forEach((s, i) => world.addBox(`s${i}`, 'fixed', { x: s.x + s.w / 2, y: s.y + s.h / 2 }, { x: s.w / 2, y: s.h / 2 }));
      world.addPlayer(LOCAL_PLAYER, { x: 3, y: G }, 1);
      run(world, 40);
      if (stumps) {
        for (let i = 0; i < 5; i++) {
          world.bodyHit(LOCAL_PLAYER, i % 2 ? 'legBackLower' : 'legFrontLower', 1, 'sim');
          run(world, 150);
        }
      }
      world.relocate(LOCAL_PLAYER, { x: startX, y: G }, 1);
      run(world, 60);
      const p = world.player(LOCAL_PLAYER);
      let holdUntil = -1;
      let ok = false;
      for (let t = 0; t < 300; t++) {
        const feet = world.feetOf(LOCAL_PLAYER);
        if (holdUntil < 0 && p.center().x >= jumpAt) holdUntil = t + 20;
        world.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, move: 1, jump: t < holdUntil });
        world.step();
        if (fail(feet) || p.down) break;
        if (p.grounded && done(world.feetOf(LOCAL_PLAYER))) {
          ok = true;
          break;
        }
      }
      world.dispose();
      return ok;
    };
    const timings = [0.2, 0.5, 0.8, 1.1, 1.4, 1.8, 2.3];
    /** Highest ledge (m) climbed onto from `run` m away. */
    const climb = (stumps: boolean, run: number) => {
      let best = 0;
      for (let h = 0.4; h <= 2.21; h += 0.1) {
        const ledge = { x: 20, y: G - h, w: 20, h: h + 10 };
        const okAny = timings.some((d) => trial(`climb:${r2(h)}`, stumps, [ledge], 20 - run, 20 - d, (f) => f.x > 20.3 && Math.abs(f.y - (G - h)) < 0.2, () => false));
        if (okAny) best = r2(h);
        else if (h > best + 0.25) break;
      }
      return best;
    };
    /** Widest gap (m) cleared to a far side `dy` m higher (negative = lower), from an 8 m run-up. */
    const gap = (stumps: boolean, dy: number) => {
      let best = 0;
      for (let g = 0.5; g <= 7.01; g += 0.25) {
        const far = { x: 20 + g, y: G - dy, w: 30, h: 10 + dy };
        const okAny = timings.slice(0, 4).some((d) => trial(`gap:${r2(g)}:${dy}`, stumps, [far], 12, 20 - d, (f) => f.x > 20 + g + 0.1 && Math.abs(f.y - (G - dy)) < 0.2, (f) => f.y > G + 1.5 && f.y > G - dy + 1.5));
        if (okAny) best = r2(g);
        else if (g > best + 0.75) break;
      }
      return best;
    };
    const rows = (['whole', 'two_stumps'] as const).map((k) => {
      const s = k === 'two_stumps';
      return { k, climbRun: climb(s, 8), climbStand: climb(s, 0.6), gapLevel: gap(s, 0), gapUp1: gap(s, 1), gapDown2: gap(s, -2) };
    });
    console.log('jump_reach: ' + rows.map((r) => `${r.k}: climb ${r.climbRun} m running / ${r.climbStand} m standing, gap ${r.gapLevel} m level / ${r.gapUp1} m 1 m up / ${r.gapDown2} m 2 m down`).join(' | '));
    const [w, s] = rows;
    const need = (have: number, want: number, what: string) => check(have >= want, `jump_reach: ${what} measured ${have} m, REACH says ${want} m (the arena reach check would promise too much)`);
    need(w.climbRun, REACH.climb, 'climb');
    need(w.gapLevel, REACH.gap, 'level gap');
    need(w.gapUp1, REACH.gapUp1, 'gap 1 m up');
    need(w.gapDown2, REACH.gap, 'gap 2 m down');
    need(s.climbRun, REACH.stumps.climb, 'two-stump climb');
    need(s.gapLevel, REACH.stumps.gap, 'two-stump level gap');
  },

  // Short matches through the rotation (Backyard -> Test Lab -> Backyard): every match ends, results freeze
  // everyone, the next world starts clean, and the person keeps their slot.
  match() {
    const { room, mark, person } = simRoom('match', { rotation: [BACKYARD, TEST_LAB], match: { lengthTicks: 40 * 60, killTarget: 3, resultsTicks: 120 } });
    const slot = room.world.slotOf(person);
    let lastMatch = room.match.info.number;
    const fresh: string[] = [];
    let frozenDamage = 0;
    for (let t = 0; t < 20000 && room.match.info.number < 3; t++) {
      room.tick();
      if (room.match.info.phase === 'results' && since(mark).some((e) => e.ev === 'damage' && Number(e.tick) > room.match.info.resultsUntil! - 120)) frozenDamage++;
      if (room.match.info.number !== lastMatch) {
        lastMatch = room.match.info.number;
        const w = room.world;
        const clean = w.arrows.length === 0 && [...w.stats.values()].every((s) => s.kills === 0 && s.deaths === 0) && w.slotOf(person) === slot && w.players.size === 4;
        fresh.push(`${room.match.info.arena}/${room.match.info.size}${clean ? '' : ' NOT CLEAN'}`);
      }
    }
    const ends = since(mark).filter((e) => e.ev === 'match_end');
    console.log(`match:     ${ends.map((e) => `#${e.match} ${e.arena} ${e.reason} winner ${e.winner} after ${r2(Number(e.ticks) / 60)}s`).join(' | ')} -> next worlds ${fresh.join(', ')}`);
    check(ends.length >= 2, `match: only ${ends.length} matches ended`);
    check(fresh.length >= 2 && fresh[0].startsWith(TEST_LAB.id) && fresh[1].startsWith(BACKYARD.id), `match: rotation wrong: ${fresh.join(', ')}`);
    check(fresh.every((f) => !f.includes('NOT CLEAN')), 'match: a new match did not start clean (arrows, scores, slot or players)');
    check(frozenDamage === 0, 'match: damage happened during the results');
    room.close();
  },

  // M3: every game mode through the real room: one still person + 3 bots, a 90 s match each on a random arena. Prints
  // what each mode's match looked like (for tuning the targets) and checks its rule held.
  modes() {
    for (const [i, mode] of GAME_MODES.entries()) {
      const settings = { ...DEFAULT_ROOM_SETTINGS, mode, arenas: 'random' as const };
      const { room, mark } = simRoom(`modes:${mode}`, { rotation: ROTATION, settings, seed: 11 + i, match: { lengthTicks: 90 * 60, resultsTicks: 60 } });
      const arena = room.match.info.arena;
      for (let t = 0; t < 90 * 60 + 30 && room.match.info.phase === 'playing'; t++) room.tick();
      const ev = since(mark);
      const end = ev.find((e) => e.ev === 'match_end');
      const scores = Object.entries((end?.scores ?? {}) as Record<string, number[]>).map(([id, s]) => `${id} ${s[0]}`).join(' ');
      const of = (name: string) => ev.filter((e) => e.ev === name);
      let extra = '';
      if (mode === 'crown') {
        extra = `crown changes ${of('crown_change').length}`;
        check(of('crown_change').length >= 1, 'modes crown: the crown never moved');
      } else if (mode === 'last_standing') {
        const rounds = of('round_end');
        extra = `rounds ${rounds.length} (${rounds.map((e) => `${e.winner ?? 'none'}/${e.why}/${r2(Number(e.ticks) / 60)}s`).join(', ')})`;
        // (the still person can hide: a round may run to the time limit, then the most health wins it)
        check(rounds.length >= 1, 'modes last_standing: no round ended in 90 s');
        check(rounds.every((e) => Number(e.ticks) <= ROUND.maxTicks), 'modes last_standing: a round ran past the time limit');
        check(!of('respawn').some((e) => !of('round_start').some((s) => s.tick === e.tick)), 'modes last_standing: someone respawned mid-round');
      } else if (mode === 'melee') {
        extra = `swings ${of('melee_swing').length}, hits ${of('melee_hit').length}, bullets ${of('fire').length}`;
        check(of('fire').length === 0, 'modes melee: a bullet was fired');
        check(of('melee_hit').length > 0, 'modes melee: nobody hit anybody');
      } else if (mode === 'chaos') {
        extra = `chaos rounds ${of('modifier_announce').map((e) => e.kind).join(',')}`;
        check(of('modifier_announce').length >= 2, 'modes chaos: fewer than 2 chaos rounds in 90 s (one every 25 s, each needs 18 s of match left)');
      } else if (mode === 'teams') {
        const team = (id: unknown) => room.match.teamOf(String(id));
        const friendly = of('damage').filter((e) => e.by !== e.id && team(e.by) !== undefined && team(e.by) === team(e.id));
        extra = `teams ${JSON.stringify(end?.teamScores)}, blocked ${of('damage_blocked').filter((e) => e.reason === 'teammate').length}, friendly damage ${friendly.length}`;
        check(friendly.length === 0, 'modes teams: a teammate was hurt');
        check(of('team_join').length === 4, 'modes teams: not everyone got a team');
      }
      console.log(`modes:     ${mode.padEnd(13)} ${arena.padEnd(17)} ${end ? `${end.reason} winner ${end.winner} after ${r2(Number(end.ticks) / 60)}s` : 'NOT ENDED'} | ${scores} | ${extra}`);
      check(!!end, `modes ${mode}: the match didn't end`);
      room.close();
    }
  },
};

/** Measures the body (see scenario body_report). Each part on a fresh, settled body on flat ground. */
function bodyReport() {
  const mark = entries.length;
  // standing
  let w = solo('body_report:stand');
  let p = w.player(LOCAL_PLAYER);
  const x0 = p.center().x;
  let standTilt = 0;
  run(w, 600, () => (standTilt = Math.max(standTilt, tilt(p))));
  const drift = Math.abs(p.center().x - x0);
  const mass = Object.values(p.parts).reduce((m, b) => m + b.mass(), 0);
  w.dispose();
  // walking + stopping
  w = solo('body_report:walk');
  p = w.player(LOCAL_PLAYER);
  let walkLean = 0;
  let headSwing = 0;
  let armSwing = 0;
  hold(w, LOCAL_PLAYER, { move: 1 }, 120, (t) => {
    if (t < 60) return;
    walkLean = Math.max(walkLean, wrapAngle(p.parts.torso.rotation()));
    headSwing = Math.max(headSwing, Math.abs(p.jointAngle('neck')));
    armSwing = Math.max(armSwing, Math.abs(wrapAngle(p.parts.armBackUpper.rotation() - p.parts.torso.rotation())));
  });
  const walkSpeed = p.speedX();
  const stopX = p.center().x;
  const stopMark = entries.length;
  let stopTilt = 0;
  hold(w, LOCAL_PLAYER, {}, 150, () => (stopTilt = Math.max(stopTilt, tilt(p))));
  const skid = p.center().x - stopX;
  const stopStumbles = count(stopMark, 'stumble');
  const stopFalls = count(stopMark, 'ragdoll_fall');
  w.dispose();
  // jump
  w = solo('body_report:jump');
  p = w.player(LOCAL_PLAYER);
  const y0 = p.center().y;
  let peak = y0;
  w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, jump: true });
  run(w, 90, (t) => {
    if (t >= 19) w.setControls(LOCAL_PLAYER, NO_CONTROLS); // held 20 ticks: a full jump (a tap is a short hop)
    peak = Math.min(peak, p.center().y);
  });
  const jumpRise = y0 - peak;
  w.dispose();
  // trip: knocked over, how long until back up
  w = solo('body_report:trip');
  p = w.player(LOCAL_PLAYER);
  p.trip(w.tick, 'body_report', 1);
  let tripDown = -1;
  let getUp = -1;
  run(w, 400, (t) => {
    if (tripDown < 0 && p.down) tripDown = t;
    if (tripDown >= 0 && getUp < 0 && !p.down) getUp = t - tripDown;
  });
  w.dispose();
  return {
    mass: r2(mass),
    drift: r3(drift),
    standTilt: r2(standTilt),
    walkSpeed: r2(walkSpeed),
    walkLean: r2(walkLean),
    headSwing: r2(headSwing),
    armSwing: r2(armSwing),
    skid: r2(skid),
    stopTilt: r2(stopTilt),
    stopStumbles,
    stopFalls,
    jumpRise: r2(jumpRise),
    tripDown,
    getUp,
    jointWarnings: count(mark, 'joint_over_limit'),
  };
}

/** L4 damage_report targets: share of the whole body's walk speed / jump, upright share, get-up time (s). */
const DAMAGE_TARGETS: Record<string, { speed: [number, number]; jump?: [number, number] }> = {
  whole: { speed: [0.95, 1.05], jump: [0.95, 1.05] },
  dragging: { speed: [0.6, 0.9], jump: [0.85, 1.1] },
  one_stump: { speed: [0.85, 1.1], jump: [0.85, 1.1] },
  one_stump_tripped: { speed: [0.85, 1.1], jump: [0.85, 1.1] },
  two_stumps: { speed: [0.4, 0.75], jump: [0.3, 0.65] },
};

/**
 * One `damage_report` stage: reach it through the real ladder (world.bodyHit, a few seconds apart so trips settle),
 * then stand 3 s, walk 3 s, jump, and get tripped once (get-up time). Upright = torso under 0.6 rad and not down.
 */
function damageTrial(stage: keyof typeof DAMAGE_TARGETS) {
  const w = solo(`damage_report:${stage}`);
  const p0 = w.player(LOCAL_PLAYER);
  const mark = entries.length;
  const legHits = ({ whole: 0, dragging: 2, one_stump: 3, one_stump_tripped: 4, two_stumps: 5 } as Record<string, number>)[stage] ?? 0;
  for (let i = 0; i < legHits; i++) {
    w.bodyHit(LOCAL_PLAYER, i % 2 ? 'legBackLower' : 'legFrontLower', 1, 'sim');
    hold(w, LOCAL_PLAYER, {}, 150);
  }
  const p = w.player(LOCAL_PLAYER);
  void p0;
  let ticks = 0;
  let up = 0;
  const watch = () => {
    ticks++;
    if (tilt(p) < 0.6 && !p.down) up++;
  };
  hold(w, LOCAL_PLAYER, {}, 120, watch);
  const x0 = p.center().x;
  hold(w, LOCAL_PLAYER, {}, 180, watch);
  const drift = Math.abs(p.center().x - x0);
  hold(w, LOCAL_PLAYER, { move: 1 }, 60, watch);
  const wx = p.center().x;
  hold(w, LOCAL_PLAYER, { move: 1 }, 120, watch);
  const speed = (p.center().x - wx) / 2;
  hold(w, LOCAL_PLAYER, { move: -1 }, 150, watch); // back toward the middle
  hold(w, LOCAL_PLAYER, {}, 90, watch);
  const y0 = p.center().y;
  let peak = y0;
  hold(w, LOCAL_PLAYER, { jump: true }, 20, () => (watch(), (peak = Math.min(peak, p.center().y))));
  hold(w, LOCAL_PLAYER, {}, 160, () => (watch(), (peak = Math.min(peak, p.center().y))));
  // tripped: how long until it's back up
  const tripMark = entries.length;
  p.trip(w.tick, 'sim', 1);
  hold(w, LOCAL_PLAYER, {}, 360);
  const upLog = since(tripMark).find((e) => e.ev === 'ragdoll_up');
  const fell = since(tripMark).some((e) => e.ev === 'ragdoll_fall');
  const getUp = !fell ? 0 : upLog ? r2(Number(upLog.downTicks) / 60) : Infinity;
  const problems = since(mark).filter((e) => (e.lvl === 'warn' || e.lvl === 'error') && e.ev !== 'slow_step');
  const result = {
    stage: w.damage.get(LOCAL_PLAYER)!.legStage,
    upright: Math.round((100 * up) / ticks),
    drift: r3(drift),
    speed: r2(speed),
    jumpRise: r2(y0 - peak),
    getUp,
    headHeight: r2(GROUND_Y - p.parts.head.translation().y),
    jointWarnings: count(mark, 'joint_over_limit'),
    problems: problems.map((e) => String(e.ev)),
  };
  w.dispose();
  return result;
}

/** One `limb_loss` trial: lose the parts, then stand, walk, aim and jump, measuring each. */
function limbTrial(mode: 'whole' | 'one_leg' | 'two_stumps' | 'mid_walk') {
  const w = solo(`limb_loss:${mode}`);
  const p = w.player(LOCAL_PLAYER);
  const mark = entries.length;
  // (the L0 spike cuts the body directly; L4's rules are told the same, or the world flags body_state_mismatch)
  const sync = () => {
    const dmg = w.damage.get(LOCAL_PLAYER)!;
    const order = (['front', 'back'] as const).filter((x) => p.stumps.has(x));
    [dmg.firstLeg, dmg.legHits] = [order[0] ?? null, order.length === 2 ? 5 : order.length * 3];
  };
  if (mode === 'one_leg') p.stumpLeg('front');
  if (mode === 'two_stumps') (p.stumpLeg('front'), p.stumpLeg('back'));
  sync();
  let ticks = 0;
  let up = 0;
  const watch = () => {
    ticks++;
    if (tilt(p) < 0.6 && !p.down) up++;
  };
  if (mode === 'mid_walk') {
    hold(w, LOCAL_PLAYER, { move: 1 }, 60, watch);
    p.stumpLeg('front');
    sync();
    hold(w, LOCAL_PLAYER, { move: 1 }, 60, watch);
    hold(w, LOCAL_PLAYER, { move: -1 }, 60, watch); // back to the middle of the ground
  }
  // settle, then stand still 3 s
  hold(w, LOCAL_PLAYER, {}, 120, watch);
  const x0 = p.center().x;
  hold(w, LOCAL_PLAYER, {}, 180, watch);
  const drift = Math.abs(p.center().x - x0);
  const headHeight = GROUND_Y - p.parts.head.translation().y;
  // walk right 3 s: speed over the last 2 s
  const hops0 = p.hops;
  hold(w, LOCAL_PLAYER, { move: 1 }, 60, watch);
  const wx = p.center().x;
  hold(w, LOCAL_PLAYER, { move: 1 }, 120, watch);
  const speed = (p.center().x - wx) / 2;
  const hops = p.hops - hops0;
  hold(w, LOCAL_PLAYER, {}, 90, watch);
  // aim the gun arm 1 s and see where it points
  const aim = { angle: -0.4 };
  hold(w, LOCAL_PLAYER, { aim }, 60, watch);
  const arm = p.parts.armFrontUpper.rotation();
  const aimErr = Math.abs(wrapAngle(aim.angle - Math.PI / 2 - arm));
  hold(w, LOCAL_PLAYER, {}, 60, watch);
  // jump
  const y0 = p.center().y;
  let peak = y0;
  hold(w, LOCAL_PLAYER, { jump: true }, 20, () => (watch(), (peak = Math.min(peak, p.center().y)))); // held: full jump
  hold(w, LOCAL_PLAYER, {}, 71, () => (watch(), (peak = Math.min(peak, p.center().y))));
  // a lost piece should be lying on the floor, not floating or sunk
  // (lying flat: its centre is about half its thickness above the floor)
  const piece = [...p.lost][0];
  const half = piece ? PART_SHAPES[piece] : null;
  const pieceGrounded = !!piece && !!half && 'hx' in half && Math.abs(p.parts[piece].translation().y - (GROUND_Y - half.hx)) < 0.05;
  const problems = since(mark).filter((e) => (e.lvl === 'warn' || e.lvl === 'error') && e.ev !== 'joint_over_limit' && e.ev !== 'slow_step').length;
  const result = {
    upright: Math.round((100 * up) / ticks),
    drift: r3(drift),
    speed: r2(speed),
    hops,
    jumpRise: r2(y0 - peak),
    headHeight: r2(headHeight),
    aimErr: r2(aimErr),
    pieceGrounded,
    jointWarnings: count(mark, 'joint_over_limit'),
    problems,
  };
  w.dispose();
  return { ...result, speedShare: 0, jumpShare: 0 };
}

/** feel_report targets (L2). Times in seconds, distances in meters. */
const FEEL = {
  t90: 0.2,
  top: 5.2,
  stopTime: 0.2,
  stopDist: 0.6,
  groundTurn: 0.4,
  holdRise: [1.2, 1.6],
  apex: 0.8,
  tapRise: 0.35,
  tapShare: 0.65,
  airTurn: 0.35,
  getUp: 2.5,
} as const;

/** p1 on a long flat floor (100 m) with a 2 m high block from x 40 to 50 (for walking off an edge). Settled. */
function feelWorld(scenario: string, x = 10, onBlock = false): GameWorld {
  const world = freshWorld(scenario, false);
  world.bounds = { width: 100, height: GROUND_Y + 1 }; // (default is the 32 m Backyard: running off it counts as leaving the arena)
  world.addBox('ground', 'fixed', { x: 50, y: GROUND_Y + 0.5 }, { x: 50, y: 0.5 });
  world.addBox('block', 'fixed', { x: 45, y: GROUND_Y - 1 }, { x: 5, y: 1 });
  world.addPlayer(LOCAL_PLAYER, { x, y: onBlock ? GROUND_Y - 2 : GROUND_Y }, 1);
  run(world, 90);
  return world;
}

/** Ticks until `done` is true (holding controls `c`), or -1 after `max` ticks. */
function ticksUntil(w: GameWorld, c: Partial<Controls>, max: number, done: () => boolean, each?: () => void): number {
  w.setControls(LOCAL_PLAYER, { ...NO_CONTROLS, ...c });
  for (let i = 1; i <= max; i++) {
    w.step();
    each?.();
    if (done()) return i;
  }
  return -1;
}

function feelReport() {
  const mark = entries.length;
  const secs = (ticks: number) => (ticks < 0 ? 99 : r2(ticks / 60));
  const target = WALK.speed;
  // speed up, top speed, stop
  let w = feelWorld('feel:run');
  let p = w.player(LOCAL_PLAYER);
  const t90 = ticksUntil(w, { move: 1 }, 120, () => p.speedX() >= 0.9 * target);
  hold(w, LOCAL_PLAYER, { move: 1 }, 60);
  const top = p.speedX();
  const stopMark = entries.length;
  const x0 = p.center().x;
  let stopTilt = 0;
  const stopTicks = ticksUntil(w, {}, 120, () => Math.abs(p.speedX()) < 0.1, () => (stopTilt = Math.max(stopTilt, tilt(p))));
  const stopDist = p.center().x - x0;
  hold(w, LOCAL_PLAYER, {}, 60, () => (stopTilt = Math.max(stopTilt, tilt(p))));
  const stopStumbles = count(stopMark, 'stumble');
  const stopFalls = count(stopMark, 'ragdoll_fall');
  w.dispose();
  // turn round while running
  w = feelWorld('feel:turn');
  p = w.player(LOCAL_PLAYER);
  hold(w, LOCAL_PLAYER, { move: 1 }, 90);
  const turnMark = entries.length;
  const groundTurn = ticksUntil(w, { move: -1 }, 120, () => p.speedX() <= -0.9 * target);
  hold(w, LOCAL_PLAYER, {}, 60);
  const turnFalls = count(turnMark, 'ragdoll_fall');
  w.dispose();
  // jumps: held and tapped (standing)
  const jumpRise = (holdTicks: number) => {
    const jw = feelWorld(`feel:jump_${holdTicks}`);
    const jp = jw.player(LOCAL_PLAYER);
    const y0 = jp.center().y;
    let peak = y0;
    let apexTick = 0;
    let t = 0;
    hold(jw, LOCAL_PLAYER, { jump: true }, holdTicks, () => {
      t++;
      if (jp.center().y < peak) (peak = jp.center().y), (apexTick = t);
    });
    hold(jw, LOCAL_PLAYER, {}, 90, () => {
      t++;
      if (jp.center().y < peak) (peak = jp.center().y), (apexTick = t);
    });
    jw.dispose();
    return { rise: y0 - peak, apex: apexTick };
  };
  const held = jumpRise(40);
  const tapped = jumpRise(1);
  // turn round in the air: running right at full speed, jump and hold left
  w = feelWorld('feel:air_turn');
  p = w.player(LOCAL_PLAYER);
  hold(w, LOCAL_PLAYER, { move: 1 }, 90);
  hold(w, LOCAL_PLAYER, { move: 1, jump: true }, 2);
  const airTurn = ticksUntil(w, { move: -1, jump: true }, 120, () => p.speedX() <= 0 || p.grounded);
  const airTurnOk = !p.grounded;
  w.dispose();
  // coyote time: walk off the 2 m block, press jump `late` ticks after the feet leave it
  const coyote = (late: number) => {
    const cw = feelWorld(`feel:coyote_${late}`, 47, true);
    const cp = cw.player(LOCAL_PLAYER);
    // (past the block's edge at x 50: mid-step both feet leave the ground for a moment while still on top; funny legs:
    // the long Big Scissor stride's trailing foot can still land on the block after that, so "left it" = every foot
    // past the edge, in the air)
    ticksUntil(cw, { move: 1 }, 240, () => cp.center().x > 50.3 && !cp.grounded && cp.footPoints().every((f) => f.x > 50.02));
    const m = entries.length;
    hold(cw, LOCAL_PLAYER, { move: 1 }, late - 1);
    hold(cw, LOCAL_PLAYER, { move: 1, jump: true }, 20);
    // (only a jump off the edge in mid-air counts: a press too late for that is kept a few ticks (the jump buffer) and
    // can fire on landing on the floor below, which is the buffer working, not coyote time)
    const jumped = since(m).some((e) => e.ev === 'jump' && e.coyote !== undefined);
    cw.dispose();
    return jumped;
  };
  // jump buffer: jump, then press again `early` ticks before the landing (the landing tick comes from a first run:
  // the sim is deterministic)
  const landAt = (() => {
    const bw = feelWorld('feel:buffer_probe');
    const bp = bw.player(LOCAL_PLAYER);
    hold(bw, LOCAL_PLAYER, { jump: true }, 40);
    const t = 40 + ticksUntil(bw, {}, 120, () => bp.grounded);
    bw.dispose();
    return t;
  })();
  const buffer = (early: number) => {
    const bw = feelWorld(`feel:buffer_${early}`);
    hold(bw, LOCAL_PLAYER, { jump: true }, 40);
    hold(bw, LOCAL_PLAYER, {}, landAt - 40 - early);
    const m = entries.length;
    hold(bw, LOCAL_PLAYER, { jump: true }, early + 20);
    const jumped = count(m, 'jump') > 0;
    bw.dispose();
    return jumped;
  };
  // trip: knocked over, how long until back up
  w = feelWorld('feel:trip');
  p = w.player(LOCAL_PLAYER);
  p.trip(w.tick, 'feel_report', 1);
  let down = -1;
  let up = -1;
  run(w, 400, (t) => {
    if (down < 0 && p.down) down = t;
    if (down >= 0 && up < 0 && !p.down) up = t - down;
  });
  w.dispose();
  return {
    t90: secs(t90),
    top: r2(top),
    stopTime: secs(stopTicks),
    stopDist: r2(stopDist),
    stopTilt: r2(stopTilt),
    stopStumbles,
    stopFalls,
    groundTurn: secs(groundTurn),
    turnFalls,
    holdRise: r2(held.rise),
    apex: secs(held.apex),
    tapRise: r2(tapped.rise),
    tapShare: r2(tapped.rise / held.rise),
    airTurn: airTurnOk ? secs(airTurn) : 99,
    coyoteLate: coyote(4),
    coyoteTooLate: coyote(10),
    bufferEarly: buffer(4),
    bufferTooEarly: buffer(12),
    getUp: secs(up),
    jointWarnings: count(mark, 'joint_over_limit'),
  };
}

/** p1 alone on flat ground, settled. */
function solo(scenario: string): GameWorld {
  const world = freshWorld(scenario, false);
  world.addBox('ground', 'fixed', { x: 16, y: GROUND_Y + 0.5 }, { x: 16, y: 0.5 });
  world.addPlayer(LOCAL_PLAYER, { x: 8, y: GROUND_Y }, 1);
  run(world, 90);
  return world;
}

/** Keeps an effect on p1 (restarts it before it runs out), like being hit there again and again. */
function keepEffect(world: GameWorld, kind: EffectKind, part: PartName): void {
  const fx = world.effects.get(LOCAL_PLAYER)!;
  const e = fx.get(kind);
  if (!e || e.end - world.tick < 30) fx.add(kind, part, world.tick);
}

/** The Test Lab at full size with all its hazards, no players. */
function lab(scenario: string): GameWorld {
  const world = freshWorld(scenario, false);
  buildArena(world, arenaLayout(TEST_LAB, 'full'));
  return world;
}

/** Backyard (walls at x 0 and 32): p1 at `from` facing the victim 'v' at `at`. Settled. */
function duel(scenario: string, from: number, at: number): GameWorld {
  const world = freshWorld(scenario, false);
  buildArena(world);
  world.addPlayer(LOCAL_PLAYER, { x: from, y: GROUND_Y }, from < at ? 1 : -1);
  world.addPlayer('v', { x: at, y: GROUND_Y }, from < at ? -1 : 1);
  run(world, 60);
  return world;
}

/** An aim (either side) whose preview hits a collider whose label passes `want`: middle of the first hitting run. */
function aimAt(world: GameWorld, want: (label: string) => boolean, where: (h: { point: { x: number; y: number } }) => boolean = () => true): Aim | null {
  for (const side of [1, -1]) {
    const hits: number[] = [];
    for (let a = 30; a >= -89; a -= 0.1) {
      const angle = side === 1 ? deg(a) : -Math.PI - deg(a); // left: -180° is flat, -170° is up-left, +170° down-left
      const hit = world.previewShot(LOCAL_PLAYER, { angle }).hit;
      if (hit && want(hit.label) && where(hit)) hits.push(angle);
      else if (hits.length) break;
    }
    if (hits.length) return { angle: hits[Math.floor(hits.length / 2)] };
  }
  return null;
}

/** p1 fires (gun ready) and the world runs until that bullet stops flying. */
function shootAs(world: GameWorld, aim: Aim): void {
  const a = readyShot(world, LOCAL_PLAYER, aim);
  for (let i = 0; i < ARROW.maxFlightTicks && a && a.state === 'flying'; i++) world.step();
}

/** p1 holds a special arrow and shoots it at a target. */
function special(world: GameWorld, kind: SpecialKind, want: (label: string) => boolean): void {
  world.playerStats(LOCAL_PLAYER).held = kind;
  const aim = aimAt(world, want);
  check(!!aim, `${kind}: no aim found at the target`);
  if (aim) shootAs(world, aim);
}

/** A server room run by hand (no sockets): one person who stands still, plus the filler bots. */
function simRoom(scenario: string, opts: RoomOptions): { room: GameRoom; mark: number; person: string } {
  new Logger('sim', sink).info('scenario_start', { scenario });
  const mark = entries.length;
  const room = new GameRoom(scenario, sink, () => {}, opts);
  const nobody: Conn = { send() {}, close() {}, bufferedAmount: 0 };
  const person = room.join(nobody, 'person');
  return { room, mark, person };
}

/** The arena without the default p1/p2, for scenarios that add their own players. */
function buildArenaOnly(world: GameWorld): void {
  buildArena(world);
}

for (const [name, fn] of Object.entries(scenarios)) if (!only.length || only.includes(name)) fn();

const bad = entries.filter((e) => e.lvl === 'error' || (e.lvl === 'warn' && e.ev !== 'slow_step'));
for (const e of bad) problems.push(`${e.lvl} ${e.ev} ${JSON.stringify(e)}`);
const slow = entries.filter((e) => e.ev === 'slow_step').length;

console.log(`\nlog: ${file.file}`);
console.log(`events: ${entries.length}, slow steps: ${slow}, problems: ${problems.length}`);
for (const p of problems.slice(0, 30)) console.log('  PROBLEM ' + p.slice(0, 300));
process.exit(problems.length ? 1 : 0);
