import RAPIER from '@dimforge/rapier2d-compat';
import { isValidAim, launchVelocity, type Aim } from './aim';
import type { ArenaBounds, ArenaLayout } from './arena';
import { APPLE, ARROW, BIG_HEAD, CROWN, DAMAGE, DEBUG, MELEE, PIN, DEFAULT_BOUNDS, DT, GRAVITY_Y, GUN, HAZARD, HEALTH, MODIFIER, STREAK, RESPAWN, SOLVER_INTERNAL_ITERATIONS, SOLVER_ITERATIONS, SPECIAL, STAMINA } from './constants';
import type { Logger } from './log';
import { add, dist, isFiniteVec, length, r2, r3, rotate, rv, scale, sub, vec, type Vec2 } from './math';
import { outOfArena, stepArrow, traceShot, traceSplitShot } from './projectile';
import { NO_CONTROLS, NO_MODS, PART_NAMES, PART_ZONE, Ragdoll, type Controls, type PartName, type RagdollHost, type Shape, type Side, type Zone } from './ragdoll';
import { EFFECT_MAX_TICKS, effectKindOf, EffectSet, pickCallout, type CalloutKind } from './effects';
import { Specials, type ArrowKind, type SpecialKind } from './specials';
import { Hazards } from './hazards';
import { brokenSides, Melee } from './melee';
import { EXCITEMENT, newTally, pickAwards, type Award, type BestMoment, type ModifierKind, type Tally } from './spice';
import type { Surface } from './arena';
import { BodyDamage, damageFor, killCredit, LEG_STAGE_NAMES, PlayerStats, type Weapon } from './rules';

/** Must be awaited once before creating a GameWorld (loads the physics WASM). */
export const initPhysics = (): Promise<void> => RAPIER.init();

export type BodyKind = 'fixed' | 'dynamic';

export interface Hit {
  point: Vec2;
  collider: RAPIER.Collider;
  label: string;
}

/**
 * A projectile in flight: a bullet (L3; still called Arrow in the code from the bow days). It vanishes where it hits.
 * Only a sticky bomb, and a plunger whose rope caught someone, stay as objects (`stuck`) until they go off / let go.
 */
export interface Arrow {
  id: number;
  ownerId: string;
  /** Position of the bullet's front. */
  pos: Vec2;
  vel: Vec2;
  angle: number;
  state: 'flying' | 'stuck' | 'gone';
  firedTick: number;
  /** Normal, or a special arrow from a power-up (S5). */
  kind: ArrowKind;
  /** Sticky bomb: tick it goes off. */
  fuseAt?: number;
  /** Where it left the gun (for callouts: sniped / point blank). */
  from: Vec2;
  /** A bomb or plunger stuck on something (it moves with it). */
  stuck?: { body: RAPIER.RigidBody; localPos: Vec2; localAngle: number; label: string; since: number };
  /** What the aim preview said would happen, so the hit log can report any difference. */
  /** `moving`: the predicted target can move (so a different result is expected, not a bug). */
  predicted: { hit: Vec2 | null; label: string | null; ticks: number; moving: boolean };
}

/** A collider's shape in world space, for drawing. */
export interface Outline {
  label: string;
  kind: 'fixed' | 'dynamic' | 'player';
  sleeping: boolean;
  /** Corners for boxes; for circles, `points` is empty and `circle` is set. */
  points: Vec2[];
  circle?: { center: Vec2; radius: number };
  angle: number;
}

export interface SpawnPoint {
  /** Feet position. */
  x: number;
  y: number;
  facing: 1 | -1;
}

export type AppleKind = 'red' | 'gold';

export interface Apple {
  label: string;
  kind: AppleKind;
  home: Vec2;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** Tick it was shot, or null while it's up. */
  takenAt: number | null;
}

/**
 * Things that happened this tick that a screen (or, in Phase 4, the network) needs to show.
 * The log has the full detail; these are just enough to draw damage numbers, kill messages, etc.
 */
export type GameEvent =
  /** `hole` (L4): the bullet hole it left, on part `part` (PART_NAMES index) at (x, y) in that part's own frame. */
  | { type: 'damage'; id: string; by: string; amount: number; zone: Zone; pos: Vec2; health: number; hole?: { part: number; x: number; y: number } }
  /** `pos`: body center at death. `pit`: fell into a pit (a ring-out). */
  | { type: 'death'; id: string; killer: string | null; cause: DeathCause; pos: Vec2 }
  | { type: 'respawn'; id: string }
  | { type: 'apple'; label: string; kind: AppleKind; by: string; pos: Vec2 }
  /** A comic banner for a special hit. `size` 0..1 (impact speed share), `by` = who did it. */
  | { type: 'callout'; kind: CalloutKind; id: string; by: string | null; pos: Vec2; size: number }
  /**
   * L3: a bullet hit something that isn't a player (a player hit is a `damage` event): clients draw a bullet hole on
   * fixed things (walls, floors) and a dust puff. `angle`: the way it was flying. Also sent where a pinned limb is nailed.
   */
  | { type: 'impact'; pos: Vec2; angle: number; on: 'wall' | 'object' }
  // S5
  /** A power-up bubble was shot: `by` holds that special arrow now. */
  | { type: 'pickup'; label: string; kind: SpecialKind; by: string; pos: Vec2 }
  | { type: 'wall_splat'; id: string; pos: Vec2; speed: number }
  | { type: 'balloon_pop'; id: string; pos: Vec2 }
  | { type: 'explosion'; pos: Vec2; radius: number; by: string }
  | { type: 'swap'; a: string; b: string }
  // S7
  /** The crown moved (null: off). */
  | { type: 'crown'; id: string | null; from: string | null }
  // L4
  /** The leg damage ladder moved (stage 1-4, see LEG_STAGE_NAMES). */
  | { type: 'damage_stage'; id: string; area: 'legs'; stage: number }
  /** A red apple put the body back together (bullet holes stay). */
  | { type: 'repaired'; id: string }
  // L5
  /** A critical hit knocked `id`'s gun away: they fight with `weapon` until they die. */
  | { type: 'crit'; id: string; by: string | null; weapon: Weapon; pos: Vec2 }
  /** A melee hit on `id` (part, whether it broke the limb). */
  | { type: 'melee_hit'; id: string; by: string; part: PartName; pos: Vec2; broke: boolean };

/** `melee`: killed by a bat/mace hit; `shattered`: the body broke into pieces (the MELEE.shatterAfter-th melee hit). */
export type DeathCause = 'arrow' | 'out_of_arena' | 'pit' | 'melee' | 'shattered';

/** L3: why a shot was refused (also the `shot` reply's reason online). */
export type FireRefusal = 'invalid_aim' | 'dead' | 'match_over' | 'arms_down' | 'laughing' | 'fire_too_soon';
/** A shot: the bullet, or why there is none. */
export type FireResult = { arrow: Arrow; refused?: undefined; swing?: undefined } | { arrow: null; refused: FireRefusal; swing?: undefined } | { arrow: null; swing: true; refused?: undefined };

/** A non-player body the network tracks: crates (dynamic) and apples (kinematic). */
export interface MovableBody {
  label: string;
  kind: 'dynamic' | 'apple' | 'bubble';
  shape: Shape;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/** A fixed collider, described so a client can rebuild and draw it. */
export interface StaticShape {
  label: string;
  shape: Shape;
  pos: Vec2;
  angle: number;
}

export interface PathPreview {
  points: Vec2[];
  hit: Hit | null;
  ticks: number;
  /** Banana: the two outer pieces after the split (the middle one is `points`). */
  branches?: Vec2[][];
}

/** Bodies slower than this (m/s or rad/s) count as still, for snapshot logging. */
const STILL_SPEED = 0.05;

/**
 * The whole simulation. Pure physics + rules, no rendering, so the same code
 * runs in the browser, in tests, in the headless sim tool and (Phase 4) on the server.
 */
export class GameWorld implements RagdollHost {
  readonly physics: RAPIER.World;
  tick = 0;
  arrows: Arrow[] = [];
  readonly players = new Map<string, Ragdoll>();
  readonly stats = new Map<string, PlayerStats>();
  readonly apples: Apple[] = [];
  /** Where players come back after dying. Set by the level. */
  spawnPoints: SpawnPoint[] = [];
  /** The arena this world was built from (null for bare test worlds). Set by `buildArena`. */
  arena: ArenaLayout | null = null;
  /** Arena size: arrows past it (plus margins) are deleted, players past it are out. */
  bounds: ArenaBounds = DEFAULT_BOUNDS;
  /** Match over (results screen): nobody can act or be hurt; the bodies just stand. */
  frozen = false;
  /** Bounty crown holder (S7), or null (off below CROWN.minPlayers players). */
  crown: string | null = null;
  /** Per player, this match: what the awards are made of (S7). */
  readonly tally = new Map<string, Tally>();
  /** The most exciting moment so far (replayed on the results screen). */
  best: (BestMoment & { score: number }) | null = null;
  /** Chaos round on now (S7), and what it changes. */
  modifier: ModifierKind | null = null;
  private modifierEnd = 0;
  /** Share of normal gravity (Moon Gravity < 1). */
  gravityShare = 1;
  /** Every arrow is this kind (Boxing Gloves Only). */
  forcedKind: SpecialKind | null = null;
  /** Everyone's feet are oiled (Oil Floor). */
  allOiled = false;
  /** Who last killed each player (REVENGE!), and each player's last kill tick (DOUBLE KILL). */
  private readonly lastKiller = new Map<string, string>();
  private readonly lastKillTick = new Map<string, number>();
  /** Head hitbox size (1 = normal) and headshot multiplier: Big Head Mode changes both (see `setBigHeads`). */
  headScale = 1;
  headMultiplier: number = HEALTH.zoneMultiplier.head;
  /** Events since the last `takeEvents()`. */
  private events: GameEvent[] = [];
  /** Power-ups, special arrows, wall pins, SPLAT (S5). */
  readonly specials: Specials;
  /** Trampolines, seesaws, wrecking balls, wind, conveyors (S6). */
  readonly hazards: Hazards;
  /** Critical hits, melee swings and hits, knocked-away guns (L5). */
  readonly melee: Melee;
  /** Jump held last tick, per player (a pinned player's presses are counted). */
  private readonly jumpWas = new Map<string, boolean>();
  /** What each player asked for; the rules filter it before the ragdoll sees it. */
  private readonly wanted = new Map<string, Controls>();
  /** Each player's hit effects (S3). */
  readonly effects = new Map<string, EffectSet>();
  /** L4: each player's lasting body damage this life (leg ladder, hand, dents, holes). */
  readonly damage = new Map<string, BodyDamage>();
  /** Bullet holes in walls and floors this match (a new match is a new world: clean walls). */
  readonly wallHoles: { x: number; y: number; angle: number }[] = [];
  /** L4: red-apple repairs waiting for room to stand up (until this tick). */
  private readonly pendingRepair = new Map<string, number>();
  private readonly slots = new Map<string, number>();

  private nextArrowId = 1;
  private readonly colliderLabels = new Map<number, string>();
  private readonly bodyLabels = new Map<number, string>();
  /** collider handle -> player id + body part, so a player's own arrows ignore them and hits know the part. */
  private readonly colliderOwners = new Map<number, { ownerId: string; part?: PartName }>();
  /** Bodies that belong to a player's ragdoll. */
  private readonly ownedBodies = new Set<number>();
  private readonly anomalyLastTick = new Map<string, { tick: number; hidden: number }>();
  /** Bodies given a push this tick; their forces are cleared after the next physics step. */
  private readonly pushed = new Set<RAPIER.RigidBody>();
  /** Rapier's raycasts don't see newly added colliders until the next step. */
  private queriesDirty = false;

  constructor(readonly log: Logger) {
    this.physics = new RAPIER.World({ x: 0, y: GRAVITY_Y });
    this.physics.timestep = DT;
    this.physics.numSolverIterations = SOLVER_ITERATIONS;
    this.physics.numInternalPgsIterations = SOLVER_INTERNAL_ITERATIONS;
    log.tickSource = () => this.tick;
    this.specials = new Specials(this);
    this.hazards = new Hazards(this);
    this.melee = new Melee(this);
  }

  /** Queues a game event for the screens / network. */
  emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  labelOf(c: RAPIER.Collider): string {
    return this.colliderLabels.get(c.handle) ?? 'unknown';
  }

  isPlayerBody(b: RAPIER.RigidBody): boolean {
    return this.ownedBodies.has(b.handle);
  }

  /** Damage from something other than an arrow hit (a bomb): logged, shown, and it can kill. */
  hurt(id: string, by: string, amount: number, pos: Vec2, how: { zone: Zone; part: string; cause: DeathCause } = { zone: 'torso', part: 'blast', cause: 'arrow' }): void {
    const st = this.stats.get(id);
    if (!st || amount <= 0 || this.frozen) return;
    const done = st.takeDamage(Math.round(amount * this.brokenFactor(id)), by, this.tick);
    if (done <= 0) return;
    this.log.info('damage', { id, by, zone: how.zone, part: how.part, amount: r2(done), hp: r2(st.health), speed: 0 });
    this.events.push({ type: 'damage', id, by, amount: done, zone: how.zone, pos, health: st.health });
    if (st.health <= 0) this.die(id, how.cause);
  }

  /** L5: a player with a limb broken by melee takes MELEE.brokenDamage more. */
  private brokenFactor(id: string): number {
    return this.damage.get(id)?.broken.size ? MELEE.brokenDamage : 1;
  }

  /** L5: the body breaks into pieces: a death, credited to `by`; the pieces stay until respawn. */
  shatter(id: string, by: string): void {
    const st = this.stats.get(id);
    const p = this.players.get(id);
    if (!st?.alive || !p || this.frozen) return;
    st.markHit(by, this.tick);
    p.shatter();
    this.log.info('body_broken', { who: id, by, meleeHits: this.damage.get(id)?.meleeHits });
    this.callout('shattered', id, by, p.center(), 1, {});
    this.die(id, 'shattered');
  }

  /** Removes a loose, non-player body (a knocked-away gun), and anything stuck on it, cleanly. */
  removeBody(body: RAPIER.RigidBody): void {
    this.dropArrowsOn(body, 'body_removed');
    for (let i = 0; i < body.numColliders(); i++) this.colliderLabels.delete(body.collider(i).handle);
    this.bodyLabels.delete(body.handle);
    this.pushed.delete(body);
    this.physics.removeRigidBody(body);
    this.queriesDirty = true;
  }

  /** Where a player's feet are (standing point under the body). */
  feetOf(id: string): Vec2 {
    const p = this.player(id);
    return { x: p.center().x, y: Math.max(...p.footPoints().map((f) => f.y)) };
  }

  /** Is there room for a standing body at these feet? (Players pass through each other, so only the scene counts.) */
  roomToStand(feet: Vec2): boolean {
    this.refreshQueries();
    let clear = true;
    this.physics.intersectionsWithShape({ x: feet.x, y: feet.y - RESPAWN.lift - 1.1 }, 0, new RAPIER.Cuboid(0.45, 1.05), (c) => {
      // (L4: shot-off pieces lying around are loose bits: they don't stop anyone standing there; L5: nor do dropped guns,
      // which players pass through)
      if (c.isSensor() || this.colliderOwners.has(c.handle) || this.labelOf(c).startsWith('piece:') || this.labelOf(c).startsWith('dropped_gun:')) return true;
      clear = false;
      return false;
    });
    return clear;
  }

  /** Rebuilds a player's body standing at `feet` (swap arrow). Stats and effects stay; stuck arrows go. */
  relocate(id: string, feet: Vec2, facing: 1 | -1): void {
    this.rebuild(id, { x: feet.x, y: feet.y - RESPAWN.lift }, facing);
    this.log.info('relocate', { id, to: rv(feet), facing });
  }

  registerCollider(collider: RAPIER.Collider, body: RAPIER.RigidBody, label: string, ownerId?: string, part?: PartName): void {
    this.bodyLabels.set(body.handle, label);
    this.colliderLabels.set(collider.handle, label);
    if (ownerId) {
      this.colliderOwners.set(collider.handle, { ownerId, part });
      this.ownedBodies.add(body.handle);
    }
    this.queriesDirty = true;
  }

  /** A body part was shot off: from now on it's a loose piece, not the player (hits on it hurt nobody). */
  releasePart(collider: RAPIER.Collider, body: RAPIER.RigidBody, label: string): void {
    this.colliderOwners.delete(collider.handle);
    this.ownedBodies.delete(body.handle);
    this.colliderLabels.set(collider.handle, label);
    this.bodyLabels.set(body.handle, label);
    this.queriesDirty = true;
  }

  /** `surface`: ice (almost no grip) or bouncy (springy) floor (S6). */
  addBox(label: string, kind: BodyKind, center: Vec2, half: Vec2, surface?: Surface): RAPIER.RigidBody {
    const desc = kind === 'fixed' ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    const body = this.physics.createRigidBody(desc.setTranslation(center.x, center.y));
    const cd = RAPIER.ColliderDesc.cuboid(half.x, half.y);
    // The surface's rule wins over the feet's ("Min" over "Average" for grip, "Max" for bounce), so it really applies.
    if (surface === 'ice') cd.setFriction(HAZARD.surface.iceFriction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    if (surface === 'bouncy') cd.setRestitution(HAZARD.surface.bouncyRestitution).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
    const collider = this.physics.createCollider(cd, body);
    this.registerCollider(collider, body, label);
    return body;
  }

  /**
   * Adds a ragdoll player standing with its feet at `feet`. `slot`: keep this collision slot (a new match's world
   * keeps everyone's slot, because clients know players by slot); otherwise the lowest free one.
   */
  addPlayer(id: string, feet: Vec2, facing: 1 | -1 = 1, wantSlot?: number): Ragdoll {
    if (this.players.has(id)) throw new Error(`player ${id} already exists`);
    const used = new Set(this.slots.values());
    let slot = 1;
    if (wantSlot !== undefined && !used.has(wantSlot)) slot = wantSlot;
    else while (used.has(slot)) slot++; // lowest free slot, so slots are reused after players leave
    if (slot > 15) throw new Error('world is full (15 ragdolls max: one collision bit each)');
    this.slots.set(id, slot);
    const ragdoll = new Ragdoll(this, id, slot, feet, facing);
    if (this.headScale !== 1) ragdoll.setHeadScale(this.headScale);
    this.players.set(id, ragdoll);
    this.stats.set(id, new PlayerStats(id, this.log));
    this.effects.set(id, new EffectSet());
    this.damage.set(id, new BodyDamage());
    this.tally.set(id, newTally());
    this.log.info('player_added', { id, feet: rv(feet), facing });
    return ragdoll;
  }

  /** Adds a player at the spawn point farthest from everyone else, with the short spawn protection. */
  spawnPlayer(id: string, slot?: number): Ragdoll {
    const spot = this.pickSpawn(id);
    const ragdoll = this.addPlayer(id, { x: spot.x, y: spot.y - RESPAWN.lift }, spot.facing, slot);
    this.playerStats(id).revive(this.tick);
    this.checkSpawnClear(ragdoll);
    return ragdoll;
  }

  /** Removes a player completely (left the game). Their arrows already in the air keep flying. */
  removePlayer(id: string): void {
    const ragdoll = this.players.get(id);
    if (!ragdoll) return;
    this.removeRagdoll(ragdoll);
    this.players.delete(id);
    this.stats.delete(id);
    this.wanted.delete(id);
    this.effects.delete(id);
    this.damage.delete(id);
    this.melee.clearOwner(id);
    this.pendingRepair.delete(id);
    this.slots.delete(id);
    this.tally.delete(id);
    if (this.crown === id) this.crown = null; // (given to the new leader on the next tick)
    this.log.info('player_removed', { id });
  }

  /** Collision slot (1..15) of a player; the network uses it as a short id. */
  slotOf(id: string): number {
    const slot = this.slots.get(id);
    if (slot === undefined) throw new Error(`unknown player ${id}`);
    return slot;
  }

  /** Crates, apples and power-up bubbles, in a stable order (the network refers to them by index). */
  movableBodies(): MovableBody[] {
    const out: MovableBody[] = [];
    this.physics.forEachCollider((c) => {
      const body = c.parent();
      if (!body || body.isFixed() || this.isRagdollPart(body)) return;
      const label = this.colliderLabels.get(c.handle) ?? 'unknown';
      if (label.startsWith('balloon:') || label.startsWith('dropped_gun:')) return; // these come and go: sent as props instead
      out.push({ label, kind: label.startsWith('apple:') ? 'apple' : label.startsWith('bubble:') ? 'bubble' : 'dynamic', shape: shapeOf(c), body, collider: c });
    });
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Every fixed collider (ground, walls, platforms). */
  staticShapes(): StaticShape[] {
    const out: StaticShape[] = [];
    this.physics.forEachCollider((c) => {
      if (!c.parent()?.isFixed()) return;
      out.push({ label: this.colliderLabels.get(c.handle) ?? 'unknown', shape: shapeOf(c), pos: { ...c.translation() }, angle: c.rotation() });
    });
    return out;
  }

  playerStats(id: string): PlayerStats {
    const s = this.stats.get(id);
    if (!s) throw new Error(`unknown player ${id}`);
    return s;
  }

  /** A floating apple you shoot to claim: red = health, gold = stamina. */
  addApple(kind: AppleKind, home: Vec2): Apple {
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(home.x, home.y));
    // Sensor: arrows (ray tests) hit it, but bodies pass through it.
    const collider = this.physics.createCollider(RAPIER.ColliderDesc.ball(APPLE.radius).setSensor(true), body);
    const label = `apple:${kind}:${this.apples.length + 1}`;
    this.registerCollider(collider, body, label);
    const apple: Apple = { label, kind, home, body, collider, takenAt: null };
    this.apples.push(apple);
    this.log.info('apple_spawn', { apple: label, kind, p: rv(home) });
    return apple;
  }

  /** Game events since the last call (damage, deaths, respawns, apples). */
  takeEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  spendStamina(id: string, amount: number): boolean {
    return this.stats.get(id)?.trySpend(amount, this.tick) ?? true;
  }

  player(id: string): Ragdoll {
    const p = this.players.get(id);
    if (!p) throw new Error(`unknown player ${id}`);
    return p;
  }

  bodyByLabel(label: string): RAPIER.RigidBody | null {
    for (const [handle, l] of this.bodyLabels) if (l === label) return this.physics.getRigidBody(handle);
    return null;
  }

  /**
   * Gives a body a one-tick push (an impulse, in N·s), optionally at a point so it also spins.
   * Done as a force for one step because Rapier ignores direct impulses on multibody (ragdoll) bodies.
   */
  push(body: RAPIER.RigidBody, impulse: Vec2, point?: Vec2): void {
    const force = scale(impulse, 1 / DT);
    if (point) body.addForceAtPoint(force, point, true);
    else body.addForce(force, true);
    this.pushed.add(body);
  }

  /** One-tick turning push (torque impulse, N·m·s). See `push`. */
  twist(body: RAPIER.RigidBody, torqueImpulse: number): void {
    body.addTorque(torqueImpulse / DT, true);
    this.pushed.add(body);
  }

  setControls(id: string, controls: Controls): void {
    this.player(id);
    if (controls.aim && !isValidAim(controls.aim)) {
      this.anomaly('invalid_controls', id, { aim: controls.aim.angle });
      controls = { ...controls, aim: null };
    }
    const move = controls.move === -1 || controls.move === 1 ? controls.move : 0;
    // (only the angle is kept: nothing else a caller puts in the aim object reaches the body)
    const aim = controls.aim ? { angle: controls.aim.angle } : null;
    this.wanted.set(id, { aim, crouch: !!controls.crouch, jump: !!controls.jump, move, taunt: !!controls.taunt });
  }

  /**
   * Big Head Mode (a chaos round, S7): every head hitbox BIG_HEAD.hitboxScale times bigger (same weight), and the
   * headshot multiplier BIG_HEAD.headMultiplier instead of ×5, so it isn't a one-shot lottery. Off restores both.
   */
  setBigHeads(on: boolean): void {
    this.headScale = on ? BIG_HEAD.hitboxScale : 1;
    this.headMultiplier = on ? BIG_HEAD.headMultiplier : HEALTH.zoneMultiplier.head;
    for (const p of this.players.values()) p.setHeadScale(this.headScale);
    this.queriesDirty = true;
    this.log.info('big_heads', { on, headScale: this.headScale, headMultiplier: this.headMultiplier, players: this.players.size });
  }

  /**
   * Full flight path for an aim, using the exact same step + hit test as real bullets. Screens show only its first
   * GUN.previewTicks; bots use all of it. A held banana (not in a gloves-only round) splits into three.
   */
  previewShot(ownerId: string, aim: Aim): PathPreview {
    if (!isValidAim(aim)) return { points: [], hit: null, ticks: 0 };
    const kind = this.forcedKind ?? this.stats.get(ownerId)?.held;
    return this.trace(ownerId, aim, kind === 'banana');
  }

  /** `banana`: the shot splits into three (the held arrow is a banana). */
  private trace(ownerId: string, aim: Aim, banana = false): PathPreview {
    this.refreshQueries();
    const shoulder = this.player(ownerId).jointPos('shoulderFront');
    const ray = (from: Vec2, to: Vec2) => this.raycast(from, to, ownerId);
    const field = this.arrowField;
    if (banana) return traceSplitShot(shoulder, aim, ray, this.bounds, SPECIAL.banana.splitTicks, SPECIAL.banana.spread, field);
    return traceShot(shoulder, aim, ray, this.bounds, field);
  }

  /** Extra push on arrows besides normal gravity: wind (S6) and Moon Gravity (S7). The preview uses the same. */
  readonly arrowField = (p: Vec2): Vec2 => {
    const wind = this.hazards.windAt(p);
    return { x: wind.x, y: wind.y + (this.gravityShare - 1) * GRAVITY_Y };
  };

  /**
   * A chaos round on/off (S7). Everything it changes is put back exactly when it ends.
   * `ticks`: how long it lasts (balloons last the round).
   */
  setModifier(kind: ModifierKind, on: boolean, ticks = 0): void {
    if (on) {
      this.modifier = kind;
      this.modifierEnd = this.tick + ticks;
    } else if (this.modifier === kind) this.modifier = null;
    if (kind === 'moon') {
      this.gravityShare = on ? MODIFIER.moonGravity : 1;
      this.physics.gravity = { x: 0, y: GRAVITY_Y * this.gravityShare };
    } else if (kind === 'big_heads') this.setBigHeads(on);
    else if (kind === 'glove_only') this.forcedKind = on ? 'glove' : null;
    else if (kind === 'oil_floor') this.allOiled = on;
    else if (kind === 'balloons' && on) for (const id of this.players.keys()) this.specials.giveBalloon(id, ticks);
    this.log.info(on ? 'modifier_start' : 'modifier_end', { kind, gravityShare: this.gravityShare, forced: this.forcedKind, allOiled: this.allOiled, headScale: this.headScale });
  }

  /** The awards for this match so far (S7). */
  awards(): Award[] {
    return pickAwards(this.tally, [...this.players.keys()]);
  }

  /**
   * L3: the gun fires along `aim` (L7: exactly where the player aims; the gun never wobbles). This is the one place a
   * shot is allowed or refused (dead, match over, arms down, laughing, still reloading); the room relays it.
   */
  fire(ownerId: string, aim: Aim): FireResult {
    if (!aim || !isValidAim(aim)) {
      this.anomaly('shot_blocked', ownerId, { reason: 'invalid_aim', aim: aim?.angle ?? null });
      return { arrow: null, refused: 'invalid_aim' };
    }
    const st = this.stats.get(ownerId);
    if (st) {
      const block = this.frozen ? 'match_over' : (st.fireBlock(this.tick) ?? (this.effects.get(ownerId)?.has('laugh') ? 'laughing' : null));
      if (block === 'fire_too_soon') {
        this.log.info('fire_too_soon', { owner: ownerId, ticksLeft: st.reloadLeft(this.tick), sinceLast: this.tick - st.lastShotTick });
        return { arrow: null, refused: block };
      }
      if (block) {
        this.log.info('shot_blocked', { owner: ownerId, reason: block, stamina: r2(st.stamina) });
        return { arrow: null, refused: block };
      }
      // (fireBlock just checked the reload: this only fires if that check breaks)
      // (L5: a melee swing has its own, shorter cooldown)
      const minGap = this.damage.get(ownerId)?.weapon !== 'gun' && this.damage.has(ownerId) ? MELEE.cooldownTicks : GUN.reloadTicks;
      if (this.tick - st.lastShotTick < minGap) this.anomaly('shots_too_close', ownerId, { ticks: this.tick - st.lastShotTick, reload: minGap }, 'error');
      // L5: with the gun knocked away, the click swings the melee weapon instead (same checks, its own cooldown)
      if (this.damage.get(ownerId)?.weapon !== 'gun' && this.damage.has(ownerId)) {
        st.shoot(this.tick, MELEE.cooldownTicks, MELEE.stamina);
        this.melee.startSwing(ownerId, aim);
        return { arrow: null, swing: true };
      }
      st.shoot(this.tick, GUN.reloadTicks);
    }
    // A held special round goes out with this shot (the server decides what you hold; clients can't claim one).
    // In a "Boxing Gloves Only" round every shot is a glove (a held one stays for later).
    const kind: ArrowKind = this.forcedKind ?? st?.held ?? 'normal';
    if (st && !this.forcedKind) st.held = null;
    const preview = this.trace(ownerId, aim, kind === 'banana');
    const vel = launchVelocity(aim);
    const arrow: Arrow = {
      id: this.nextArrowId++,
      ownerId,
      pos: preview.points[0],
      from: preview.points[0],
      vel,
      angle: aim.angle,
      state: 'flying',
      firedTick: this.tick,
      kind,
      predicted: {
        hit: preview.hit?.point ?? null,
        label: preview.hit?.label ?? null,
        ticks: preview.ticks,
        moving: preview.hit ? !(preview.hit.collider.parent()?.isFixed() ?? true) : false,
      },
    };
    this.arrows.push(arrow);
    if (this.damage.get(ownerId)?.weapon !== 'gun' && this.damage.has(ownerId)) this.anomaly('gun_while_melee', ownerId, { arrow: arrow.id }, 'error');
    const blockedAtArm = preview.ticks === 0 && preview.hit !== null;
    this.log.info('fire', {
      id: arrow.id,
      owner: ownerId,
      angleDeg: Math.round((aim.angle * 180) / Math.PI),
      ...(kind !== 'normal' ? { kind } : {}),
      // after the shot: stamina left, ticks until the next one, arms dropped?
      ...(st ? { stamina: r2(st.stamina), readyIn: st.reloadLeft(this.tick), armsDown: st.armsDown } : {}),
      from: rv(arrow.pos),
      predTarget: arrow.predicted.label,
      predHit: arrow.predicted.hit ? rv(arrow.predicted.hit) : null,
      predTicks: preview.ticks,
      blockedAtArm,
    });
    // Something between shoulder and gun hand (a wall you lean on, an enemy in your face): it takes the bullet now.
    if (blockedAtArm) this.resolveHit(arrow, preview.hit!);
    return { arrow };
  }

  step(): void {
    const started = performance.now();
    this.applyRules();
    this.moveApples();
    this.specials.preStep();
    this.hazards.preStep();
    this.melee.preStep();
    this.updateCrown();
    for (const p of this.players.values()) {
      p.prePhysics(this.tick);
    }
    this.physics.step();
    for (const b of this.pushed) {
      b.resetForces(false);
      b.resetTorques(false);
    }
    this.pushed.clear();
    this.queriesDirty = false;
    this.tick++;
    for (const [id, st] of this.stats) {
      // the gun is ready again from this tick on (shots between now and the next step may go out)
      if (st.alive && this.tick === st.readyAt && st.lastShotTick > -Infinity) this.log.info('reload_done', { id, stamina: r2(st.stamina), armsDown: st.armsDown });
    }
    this.updateArrows();
    for (const p of this.players.values()) p.postPhysics(this.tick);
    this.specials.postStep();
    this.checkOut();
    this.checkAnomalies();
    const ms = performance.now() - started;
    if (ms > DEBUG.slowStepMs) this.anomaly('slow_step', 'world', { ms: r3(ms) });
    if (this.tick % DEBUG.snapshotEveryTicks === 0 && this.isAnythingMoving()) {
      this.log.debug('snapshot', this.snapshot());
    }
  }

  counts(): { flying: number; stuck: number } {
    let flying = 0;
    for (const a of this.arrows) if (a.state === 'flying') flying++;
    return { flying, stuck: this.arrows.length - flying };
  }

  snapshot(): Record<string, unknown> {
    const bodies: unknown[] = [];
    this.physics.forEachRigidBody((b) => {
      if (!b.isDynamic() || this.isRagdollPart(b)) return; // ragdolls get their own compact entry
      bodies.push({ id: this.bodyLabel(b), p: rv(b.translation()), a: r3(b.rotation()), v: rv(b.linvel()), sleep: b.isSleeping() });
    });
    const ragdolls = [...this.players.values()].map((p) => {
      const st = this.stats.get(p.id);
      return { ...p.snapshot(), hp: st ? r2(st.health) : null, sta: st ? r2(st.stamina) : null, armsDown: st?.armsDown ?? false, alive: st?.alive ?? true };
    });
    const flying = this.arrows.filter((a) => a.state === 'flying').map((a) => ({ id: a.id, p: rv(a.pos), v: rv(a.vel) }));
    return { ragdolls, bodies, flying, stuck: this.counts().stuck };
  }

  outlines(): Outline[] {
    const out: Outline[] = [];
    this.physics.forEachCollider((c) => {
      if (!c.isEnabled()) return; // e.g. an apple that was shot and hasn't come back yet
      const body = c.parent();
      const label = this.colliderLabels.get(c.handle) ?? 'unknown';
      const kind = this.colliderOwners.has(c.handle) ? 'player' : body?.isDynamic() ? 'dynamic' : 'fixed';
      const center = c.translation();
      const angle = c.rotation();
      const base = { label, kind, sleeping: body?.isSleeping() ?? false, angle } as const;
      if (c.shape.type === RAPIER.ShapeType.Ball) {
        out.push({ ...base, points: [], circle: { center: { ...center }, radius: c.radius() } });
      } else {
        const h = c.halfExtents(); // null for shapes we don't use yet
        if (!h) return;
        const corners = [vec(-h.x, -h.y), vec(h.x, -h.y), vec(h.x, h.y), vec(-h.x, h.y)];
        out.push({ ...base, points: corners.map((p) => add(center, rotate(p, angle))) });
      }
    });
    return out;
  }

  dispose(): void {
    this.physics.free();
  }

  // ---- internals ----

  /** Before each step: stamina, what each player is allowed to do, deaths and respawns. */
  private applyRules(): void {
    for (const id of [...this.players.keys()]) {
      const st = this.stats.get(id)!;
      if (st.respawnDue(this.tick)) this.respawn(id);
      const want = this.wanted.get(id) ?? NO_CONTROLS;
      st.updateStamina(this.tick);
      const p = this.player(id);
      if (!st.alive || this.frozen) p.controls = NO_CONTROLS;
      // (arms down: the body lowers them, see BodyMods.armsDown)
      else p.controls = want;
      const fx = this.effects.get(id);
      // Pinned to a wall: jump presses struggle free (they don't jump).
      const pressed = want.jump && !this.jumpWas.get(id);
      this.jumpWas.set(id, want.jump);
      const pinnedPart = fx?.get('pinned')?.part;
      if (pinnedPart && p.strainOn(pinnedPart) > PIN.tearOver) {
        // The nail tears out when it forces a joint next to the pinned part past its limit (a tripped body falling
        // with its shin nailed bent the knee 0.4 rad backward, L5 bots sim). A pin that hurts nothing lasts its time.
        this.log.info('pin_torn', { id, part: pinnedPart, strain: r2(p.strainOn(pinnedPart)) });
        this.specials.unpin(id, 'torn');
      } else if (fx?.has('pinned')) {
        if (pressed && st.alive) this.specials.mash(id);
        p.controls = { ...p.controls, jump: false };
      }
      p.mods = !st.alive || !fx
        ? NO_MODS
        : {
            headHeavy: fx.has('head'),
            armFlail: fx.has('arm'),
            // (L5: a leg broken by melee drags too, unless it's a stump already)
            dragLeg: this.damage.get(id)?.draggingLeg ?? brokenSides(this.damage.get(id)?.broken ?? new Set()).legs.find((s) => !p.stumps.has(s)) ?? null,
            oiled: this.specials.isOiled(id),
            laughing: fx.has('laugh'),
            floatLeg: floatLegOf(fx.get('balloon')?.part),
            beltSpeed: this.hazards.beltUnder(id),
            pinned: fx.has('pinned'),
            // Out of stamina (L3: shots spend it), or laughing too hard (feather): the arms drop.
            armsDown: st.armsDown || fx.has('laugh'),
            // L5: a melee swing drives the arms; a broken back arm hangs (a broken gun/weapon arm still works: you can
            // always fight back); melee players run faster
            swing: this.melee.swingAngle(id),
            limpArms: brokenSides(this.damage.get(id)?.broken ?? new Set()).arms.filter((s) => s === 'back'),
            fast: (this.damage.get(id)?.weapon ?? 'gun') !== 'gun',
          };
      if (this.allOiled && st.alive) p.mods = { ...p.mods, oiled: true };
    }
    this.updateEffects();
    this.retryRepairs();
  }

  /** Effects that ran out end (L3: there are no stuck bullets to drop any more). */
  private updateEffects(): void {
    for (const [id, set] of this.effects) {
      for (const e of set.takeExpired(this.tick)) {
        this.log.info('effect_end', { id, kind: e.kind, reason: 'time', ticks: this.tick - e.start });
        this.specials.onEffectEnd(id, e.kind);
      }
    }
  }

  private moveApples(): void {
    for (const a of this.apples) {
      if (a.takenAt !== null && this.tick - a.takenAt >= APPLE.respawnTicks) {
        a.takenAt = null;
        a.collider.setEnabled(true);
        this.log.info('apple_spawn', { apple: a.label, kind: a.kind, p: rv(a.home) });
      }
      const bob = APPLE.bobAmplitude * Math.sin((2 * Math.PI * this.tick) / APPLE.bobPeriodTicks);
      a.body.setNextKinematicTranslation({ x: a.home.x, y: a.home.y + bob });
    }
  }

  private shootApple(arrow: Arrow, apple: Apple, point: Vec2): void {
    apple.takenAt = this.tick;
    apple.collider.setEnabled(false);
    arrow.state = 'gone'; // the arrow is used up
    const st = this.stats.get(arrow.ownerId);
    const gained = !st?.alive ? 0 : apple.kind === 'red' ? st.heal(APPLE.redHealth) : st.refill(APPLE.goldStamina);
    this.log.info('apple_hit', { apple: apple.label, kind: apple.kind, by: arrow.ownerId, arrow: arrow.id, gained: r2(gained), hp: st ? r2(st.health) : null, sta: st ? r2(st.stamina) : null });
    this.events.push({ type: 'apple', label: apple.label, kind: apple.kind, by: arrow.ownerId, pos: point });
    // L4: a health apple also puts a damaged body back together (holes stay)
    if (apple.kind === 'red' && st?.alive && this.damage.get(arrow.ownerId)?.repairable) this.repairBody(arrow.ownerId);
  }

  /**
   * L4: a red apple puts the body back together: legs, hand and dents (bullet holes stay). The body is rebuilt
   * standing where its feet are; with no room to stand there (lying under something) it waits for room
   * (DAMAGE.repairWaitTicks), then gives up. (Public for tests and tools; in the game only a red apple calls it.)
   */
  repairBody(id: string): void {
    const p = this.players.get(id);
    const dmg = this.damage.get(id);
    if (!p || !dmg) return;
    // stand on the floor under the body (not "the feet": a stumped body's shot-off shin may be lying anywhere)
    const c = p.center();
    const floor = this.castFixed(c, { x: c.x, y: c.y + 4 });
    const feet = floor ? { x: c.x, y: floor.point.y } : this.feetOf(id);
    if (!floor || !this.roomToStand(feet)) {
      if (!this.pendingRepair.has(id)) {
        this.pendingRepair.set(id, this.tick + DAMAGE.repairWaitTicks);
        this.log.info('repair_waiting', { id, at: rv(feet) });
      }
      return;
    }
    this.pendingRepair.delete(id);
    const before = dmg.summary();
    dmg.repair();
    this.rebuild(id, { x: feet.x, y: feet.y - RESPAWN.lift }, p.facing);
    this.log.info('body_repaired', { id, by: 'apple', before, at: rv(feet) });
    this.events.push({ type: 'repaired', id });
  }

  /** Repairs that waited for room to stand: try again; past their time, give up. */
  private retryRepairs(): void {
    for (const [id, until] of [...this.pendingRepair]) {
      if (!this.stats.get(id)?.alive || this.tick > until) {
        this.pendingRepair.delete(id);
        this.log.info('repair_given_up', { id, reason: this.stats.get(id)?.alive ? 'no_room' : 'dead' });
      } else this.repairBody(id);
    }
  }

  /**
   * L4: a leg hit climbs the lasting leg ladder (trip → drag → stump → trip → two stumps; L7: arms and torso have no
   * ladder any more). Called by the hit handling; public for tests and tools.
   * `dirX`: which way the hit pushed (a trip sweeps the feet that way).
   */
  bodyHit(id: string, part: PartName, dirX: number, cause: string): void {
    const p = this.players.get(id);
    const dmg = this.damage.get(id);
    if (!p || !dmg || !this.stats.get(id)?.alive) return;
    const zone = PART_ZONE[part];
    if (zone === 'leg') {
      const side: Side = part.startsWith('legFront') ? 'front' : 'back';
      const before = dmg.legStage;
      const res = dmg.legHit(side);
      // a hit climbs at most one stage (the 4th, a trip on the other leg, none), and never back down
      const climbed = dmg.legStage - before;
      if (climbed < 0 || climbed > 1) this.anomaly(climbed < 0 ? 'stage_backwards' : 'stage_skipped', id, { from: before, to: dmg.legStage, hits: dmg.legHits }, 'error');
      if (res.kind === 'trip') p.trip(this.tick, cause, dirX);
      else if (res.kind === 'stump') p.stumpLeg(res.side);
      if (res.kind !== 'none') {
        this.log.info('damage_stage', { who: id, area: 'legs', stage: dmg.legStage, name: LEG_STAGE_NAMES[dmg.legStage], hits: dmg.legHits, did: res.kind, leg: res.side, cause });
        this.events.push({ type: 'damage_stage', id, area: 'legs', stage: dmg.legStage });
      }
    }
  }

  /**
   * A bullet hit a wall/floor (a hole + dust on screens) or a crate (dust). Wall holes are kept for the match (up to
   * DAMAGE.maxWallHoles) so someone joining later sees them too: anything that lasts is world state, not just an event.
   */
  impact(pos: Vec2, angle: number, on: 'wall' | 'object'): void {
    this.events.push({ type: 'impact', pos: { ...pos }, angle, on });
    if (on !== 'wall') return;
    this.wallHoles.push({ x: r3(pos.x), y: r3(pos.y), angle: r3(angle) });
    if (this.wallHoles.length > DAMAGE.maxWallHoles) this.wallHoles.splice(0, this.wallHoles.length - DAMAGE.maxWallHoles);
  }

  /** L4: a boxing glove leaves the part it hit dented (until an apple or respawn). */
  dent(id: string, part: PartName, by: string): void {
    const dmg = this.damage.get(id);
    if (!dmg || !this.stats.get(id)?.alive) return;
    const fresh = !dmg.dents.has(part);
    dmg.dents.add(part);
    this.log.info('dent', { who: id, part, by, fresh, dents: dmg.dents.size });
  }

  /**
   * `share`: share of normal damage (special arrows); 0 still counts as the last hit (kill credit, e.g. a glove
   * ring-out). `normal`: callouts by zone, trips and arrow effects only for arrows that act like normal ones.
   */
  private hitPlayer(arrow: Arrow, victimId: string, part: PartName, point: Vec2, speed: number, share = 1, normal = true): void {
    const st = this.stats.get(victimId);
    if (!st) return;
    const zone = PART_ZONE[part];
    if (!st.alive || st.isProtected(this.tick) || this.frozen) {
      this.log.info('damage_blocked', { id: victimId, by: arrow.ownerId, zone, reason: !st.alive ? 'dead' : this.frozen ? 'match_over' : 'protected' });
      return;
    }
    if (share <= 0) {
      st.markHit(arrow.ownerId, this.tick);
      this.log.info('special_contact', { id: victimId, by: arrow.ownerId, kind: arrow.kind, zone, part });
      return;
    }
    // L5: melee players (gun knocked away) take MELEE.bulletShare of bullet damage; a broken limb makes it more
    const resist = this.damage.get(victimId)?.weapon !== 'gun' && this.damage.has(victimId) ? MELEE.bulletShare : 1;
    const amount = st.takeDamage(Math.max(1, Math.round(damageFor(zone, speed, this.headMultiplier) * share * resist * this.brokenFactor(victimId))), arrow.ownerId, this.tick);
    this.log.info('damage', { id: victimId, by: arrow.ownerId, zone, part, amount: r2(amount), hp: r2(st.health), speed: r3(speed) });
    // L4: a bullet hole in that part, in its own frame (it moves with the part; stays until respawn, even through an apple)
    const body = this.player(victimId).parts[part];
    const local = rotate(sub(point, body.translation()), -body.rotation());
    const hole = { part: PART_NAMES.indexOf(part), x: r3(local.x), y: r3(local.y) };
    this.damage.get(victimId)?.addHole({ part, x: hole.x, y: hole.y });
    if (zone === 'head' && this.damage.get(victimId)) this.damage.get(victimId)!.hatOff = true; // (screens knock the hat off)
    this.events.push({ type: 'damage', id: victimId, by: arrow.ownerId, amount, zone, pos: point, health: st.health, hole });
    const distance = dist(arrow.from, point);
    const t = this.tally.get(arrow.ownerId);
    if (t && arrow.ownerId !== victimId) t.longestShot = Math.max(t.longestShot, distance);
    if (this.player(victimId).controls.taunt) this.callout('humbled', victimId, arrow.ownerId, point, 0.7, { why: 'hit while taunting' });
    const callout = !normal ? null : pickCallout({ zone, distance, victimAirborne: !this.player(victimId).grounded });
    if (callout) this.callout(callout, victimId, arrow.ownerId, point, speed / GUN.bulletSpeed, { distance: r2(distance), zone });
    if (st.health <= 0) {
      this.die(victimId, 'arrow');
      return;
    }
    if (!normal) return;
    this.bodyHit(victimId, part, arrow.vel.x, `${zone}_hit:arrow:${arrow.id}`);
    if (arrow.ownerId !== victimId) this.melee.onBulletHit(victimId, arrow.ownerId); // L5: a critical hit in the air
    const kind = effectKindOf(zone);
    if (kind) {
      const { effect, refreshed } = this.effects.get(victimId)!.add(kind, part, this.tick);
      this.log.info('effect_start', { id: victimId, kind, part, arrow: arrow.id, until: effect.end, refreshed });
    }
  }

  /** Queues a comic banner (and logs why it was chosen). */
  callout(kind: CalloutKind, id: string, by: string | null, pos: Vec2, size: number, why: Record<string, unknown> = {}): void {
    const s = r2(Math.max(0, Math.min(1, size)));
    this.events.push({ type: 'callout', kind, id, by, pos: { ...pos }, size: s });
    this.log.info('callout', { kind, id, by, size: s, ...why });
    // awards + the match's best moment (S7)
    const t = this.tally.get(id);
    if (t && kind === 'splat') t.splats++;
    if (t && kind === 'pinned') t.pinned++;
    const score = (EXCITEMENT[kind] ?? 0) + s * 5;
    if (!this.best || score > this.best.score) this.best = { score, tick: this.tick, kind, id, by, pos: { ...pos } };
  }

  /**
   * Bounty crown (S7): with CROWN.minPlayers+ players the leader (highest score, above 0) wears it; someone has to
   * score more than the holder to take it without killing them. Killing the holder takes it (see `die`).
   */
  private updateCrown(): void {
    if (this.players.size < CROWN.minPlayers) {
      if (this.crown) this.setCrown(null, 'too few players');
      return;
    }
    let lead: string | null = this.crown;
    let top = lead ? (this.stats.get(lead)?.score ?? 0) : 0;
    for (const [id, st] of this.stats) if (st.score > top) [lead, top] = [id, st.score];
    if (lead !== this.crown && top > 0) this.setCrown(lead, 'leader');
    if (this.crown) {
      const t = this.tally.get(this.crown);
      if (t) t.crownTicks++;
    }
  }

  private setCrown(id: string | null, why: string): void {
    const from = this.crown;
    this.crown = id;
    this.log.info('crown_change', { from, to: id, why });
    this.events.push({ type: 'crown', id, from });
  }

  /**
   * Players in a pit's kill zone die (a ring-out: the kill goes to whoever hit them last, within 3 s).
   * Past the arena edge is also out; in a walled arena that should be impossible, so it's flagged.
   */
  private checkOut(): void {
    const pits = this.arena?.pits ?? [];
    for (const [id, p] of this.players) {
      if (!this.stats.get(id)?.alive) continue;
      const c = p.center();
      const pit = pits.find((z) => c.x > z.x && c.x < z.x + z.w && c.y > z.y && c.y < z.y + z.h);
      if (pit) {
        const st = this.stats.get(id)!;
        this.log.info('ring_out', { id, pit: pit.label, at: rv(c), lastHitBy: st.lastHit?.by ?? null, lastHitAgo: st.lastHit ? this.tick - st.lastHit.tick : null });
        this.die(id, 'pit');
        this.callout('ring_out', id, killCredit(st.lastHit, this.tick), c, 1, { pit: pit.label });
      } else if (outOfArena(c, this.bounds)) {
        if (this.arena) this.anomaly('left_arena', id, { at: rv(c), arena: this.arena.id, size: this.arena.size });
        this.die(id, 'out_of_arena');
      }
    }
  }

  private die(id: string, cause: DeathCause): void {
    const st = this.stats.get(id)!;
    if (!st.alive) return;
    const killer = killCredit(st.lastHit, this.tick);
    this.specials.onDeath(id); // (before markDead: it logs the held arrow being lost)
    st.markDead(this.tick);
    this.player(id).setLimp(true);
    // Effects end with the life.
    for (const e of this.effects.get(id)?.clear() ?? []) {
      this.log.info('effect_end', { id, kind: e.kind, reason: 'death', ticks: this.tick - e.start });
      this.specials.onEffectEnd(id, e.kind);
    }
    const killerStats = killer && killer !== id ? this.stats.get(killer) : undefined;
    const pos = this.player(id).center();
    if (killer === id) {
      // their own bomb / glove bounce: no kill for anyone
      const t = this.tally.get(id);
      if (t) t.selfOwns++;
      this.callout('self_own', id, id, pos, 0.8, { cause });
    } else if (killerStats && killer) {
      killerStats.kills++;
      const crowned = this.crown === id;
      killerStats.score += crowned ? CROWN.bonus : 1;
      if (crowned) this.setCrown(killer, 'took it');
      if (this.lastKiller.get(killer) === id) this.callout('revenge', id, killer, pos, 0.8, {});
      if (this.tick - (this.lastKillTick.get(killer) ?? -Infinity) <= STREAK.doubleKillTicks) this.callout('double_kill', id, killer, pos, 1, {});
      this.lastKillTick.set(killer, this.tick);
    }
    if (killer && killer !== id) this.lastKiller.set(id, killer);
    this.log.info('death', {
      id,
      killer,
      cause,
      lastHitAgo: st.lastHit ? this.tick - st.lastHit.tick : null,
      score: { [id]: [st.kills, st.deaths, st.score], ...(killerStats && killer ? { [killer]: [killerStats.kills, killerStats.deaths, killerStats.score] } : {}) },
    });
    this.events.push({ type: 'death', id, killer, cause, pos });
  }

  /** Rebuilds the player's ragdoll at the spawn point farthest from everyone else. */
  private respawn(id: string): void {
    const spot = this.pickSpawn(id);
    // L4: a fresh body: every bit of damage (and the holes) goes
    const dmg = this.damage.get(id);
    if (dmg && (dmg.repairable || dmg.holes.length)) this.log.info('body_repaired', { id, by: 'respawn', before: dmg.summary() });
    dmg?.reset();
    this.melee.clearOwner(id); // (the knocked-away gun goes: a fresh gun in the hands)
    this.pendingRepair.delete(id);
    this.rebuild(id, { x: spot.x, y: spot.y - RESPAWN.lift }, spot.facing);
    // (the old body and its loose pieces went with removeRagdoll: none may be left)
    for (const label of this.bodyLabels.values()) if (label.startsWith(`piece:${id}:`)) this.anomaly('piece_left_behind', id, { piece: label }, 'error');
    this.stats.get(id)!.revive(this.tick);
    this.log.info('respawn', { id, at: [spot.x, spot.y], facing: spot.facing });
    this.events.push({ type: 'respawn', id });
    if (this.modifier === 'balloons') this.specials.giveBalloon(id, Math.max(1, this.modifierEnd - this.tick));
  }

  /** A fresh body for a player at `feet` (same slot). The old body and its stuck arrows go. */
  private rebuild(id: string, feet: Vec2, facing: 1 | -1): Ragdoll {
    this.removeRagdoll(this.player(id));
    const ragdoll = new Ragdoll(this, id, this.slots.get(id)!, feet, facing);
    if (this.headScale !== 1) ragdoll.setHeadScale(this.headScale);
    this.players.set(id, ragdoll);
    this.checkSpawnClear(ragdoll);
    // L4: the damage this life still has goes onto the new body (a swap keeps your stumps; respawn/apple cleared it first)
    const dmg = this.damage.get(id);
    if (dmg?.stumps.length) {
      for (const side of dmg.stumps) ragdoll.stumpLeg(side);
      this.log.info('body_reapplied', { id, ...dmg.summary() });
    }
    return ragdoll;
  }


  /**
   * The clear spawn point farthest from living players. "Clear" = no body, crate or wall where the new body would stand:
   * two ragdolls spawned inside each other burst apart and bend joints past their limits.
   */
  private pickSpawn(id: string): SpawnPoint {
    if (!this.spawnPoints.length) throw new Error('no spawn points set');
    this.refreshQueries();
    let best: SpawnPoint | null = null;
    let bestDist = -1;
    let fallback = this.spawnPoints[0];
    let fallbackDist = -1;
    for (const sp of this.spawnPoints) {
      let nearest = Infinity;
      for (const [other, p] of this.players) {
        // Straight-line distance (not just sideways): arenas have several heights.
        if (other !== id && this.stats.get(other)?.alive) nearest = Math.min(nearest, dist(p.center(), { x: sp.x, y: sp.y - 1.4 }));
      }
      if (nearest > fallbackDist) [fallback, fallbackDist] = [sp, nearest];
      if (nearest > bestDist && this.spawnClear(sp, id)) [best, bestDist] = [sp, nearest];
    }
    if (!best) this.anomaly('spawn_crowded', id, { used: [fallback.x, fallback.y], points: this.spawnPoints.length });
    return best ?? fallback;
  }

  private spawnClear(sp: SpawnPoint, ignoreId: string): boolean {
    let clear = true;
    const standing = new RAPIER.Cuboid(0.45, 1.1); // roughly the space a standing ragdoll takes
    this.physics.intersectionsWithShape({ x: sp.x, y: sp.y - RESPAWN.lift - 1.1 }, 0, standing, (c) => {
      if (c.isSensor() || this.colliderOwners.get(c.handle)?.ownerId === ignoreId || this.labelOf(c).startsWith('dropped_gun:')) return true;
      clear = false;
      return false;
    });
    return clear;
  }

  /** Removes a ragdoll's bodies (Rapier removes their colliders and joints too) and any bomb/plunger stuck on it. */
  private removeRagdoll(ragdoll: Ragdoll): void {
    this.specials.onBodyRemoved(ragdoll.id);
    const handles = new Set(Object.values(ragdoll.parts).map((b) => b.handle));
    let arrows = 0;
    for (const a of this.arrows) {
      if (a.stuck && handles.has(a.stuck.body.handle)) {
        a.state = 'gone';
        arrows++;
      }
    }
    this.arrows = this.arrows.filter((a) => a.state !== 'gone');
    for (const body of [...Object.values(ragdoll.parts), ragdoll.anchor]) {
      for (let i = 0; i < body.numColliders(); i++) {
        const c = body.collider(i);
        this.colliderLabels.delete(c.handle);
        this.colliderOwners.delete(c.handle);
      }
      this.bodyLabels.delete(body.handle);
      this.ownedBodies.delete(body.handle);
      this.pushed.delete(body);
      this.physics.removeRigidBody(body);
    }
    this.queriesDirty = true;
    this.log.info('ragdoll_removed', { id: ragdoll.id, arrowsRemoved: arrows });
  }

  /** A respawned body must not start inside anything solid. */
  private checkSpawnClear(ragdoll: Ragdoll): void {
    this.refreshQueries();
    for (const body of Object.values(ragdoll.parts)) {
      const c = body.collider(0);
      this.physics.intersectionsWithShape(c.translation(), c.rotation(), c.shape, (other) => {
        const label = this.colliderLabels.get(other.handle) ?? 'unknown';
        if (!other.isSensor() && other.parent()?.isFixed()) this.anomaly('respawn_blocked', ragdoll.id, { part: this.bodyLabel(body), inside: label }, 'error');
        return true;
      }, undefined, undefined, c);
    }
  }

  /**
   * A zero-length step updates Rapier's raycast data without moving anything. TWO of them: after a collider changes
   * size (Big Head Mode's heads), one zero step left every ray test seeing nothing at all until the next real step
   * (found in L3: previews and point-blank checks right after the round started hit nothing, even the ground).
   */
  private refreshQueries(): void {
    if (!this.queriesDirty) return;
    this.physics.timestep = 0;
    this.physics.step();
    this.physics.step();
    this.physics.timestep = DT;
    this.queriesDirty = false;
  }

  private updateArrows(): void {
    for (const arrow of this.arrows) {
      if (arrow.state === 'gone') continue; // removed earlier (e.g. broken numbers); never bring it back
      if (arrow.state === 'stuck') {
        this.followBody(arrow);
        continue;
      }
      const res = this.advance(arrow.pos, arrow.vel, arrow.ownerId);
      arrow.pos = res.pos;
      arrow.vel = res.vel;
      arrow.angle = Math.atan2(res.vel.y, res.vel.x);
      if (res.hit) this.resolveHit(arrow, res.hit);
      else if (outOfArena(arrow.pos, this.bounds)) this.removeArrow(arrow, 'out_of_arena');
      else if (this.tick - arrow.firedTick >= ARROW.maxFlightTicks) this.removeArrow(arrow, 'timeout');
    }
    this.specials.splitBananas((from, vel) => {
      const piece: Arrow = { ...from, id: this.nextArrowId++, vel, angle: Math.atan2(vel.y, vel.x), kind: 'normal', predicted: { hit: null, label: null, ticks: 0, moving: true } };
      this.arrows.push(piece);
      this.log.info('fire', { id: piece.id, owner: from.ownerId, piece: true, of: from.id, from: rv(piece.pos) });
    });
    this.arrows = this.arrows.filter((a) => a.state !== 'gone');
  }

  /** One tick of flight. The ray from old to new position means fast arrows can never skip through thin things. */
  private advance(pos: Vec2, vel: Vec2, ownerId: string): { pos: Vec2; vel: Vec2; hit: Hit | null } {
    const next = stepArrow(pos, vel, DT, this.arrowField(pos));
    const hit = this.raycast(pos, next.pos, ownerId);
    return { pos: hit ? hit.point : next.pos, vel: next.vel, hit };
  }

  /** First FIXED collider (floors, walls) on the line from `from` to `to`. */
  castFixed(from: Vec2, to: Vec2): Hit | null {
    this.refreshQueries();
    const d = sub(to, from);
    if (d.x === 0 && d.y === 0) return null;
    const h = this.physics.castRay(new RAPIER.Ray(from, d), 1, true, undefined, undefined, undefined, undefined, (c) => !!c.parent()?.isFixed());
    return h ? { point: add(from, scale(d, h.timeOfImpact)), collider: h.collider, label: this.labelOf(h.collider) } : null;
  }

  /** First collider on the line from `from` to `to`, skipping everything owned by `ignoreOwner`. */
  raycast(from: Vec2, to: Vec2, ignoreOwner: string): Hit | null {
    const dir = sub(to, from);
    if (dir.x === 0 && dir.y === 0) return null;
    const hit = this.physics.castRay(
      new RAPIER.Ray(from, dir),
      1, // dir is the full step, so 1 = the end of this tick's movement
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      // (L5: knocked-away guns are props only: bullets pass through, like the client's preview, which can't see them)
      (c) => this.colliderOwners.get(c.handle)?.ownerId !== ignoreOwner && !this.labelOf(c).startsWith('dropped_gun:'),
    );
    if (!hit) return null;
    return {
      point: add(from, scale(dir, hit.timeOfImpact)),
      collider: hit.collider,
      label: this.colliderLabels.get(hit.collider.handle) ?? 'unknown',
    };
  }

  /**
   * L3: a bullet reached something (not an apple / bubble / balloon: see `resolveHit`). It pushes what it hit, hurts a
   * player (effects, trip, pin), and then it's GONE: nothing stays stuck in bodies, walls or crates. Only a sticky bomb
   * and a plunger whose rope caught someone stay, as objects, on what they hit (`specials.onHit` says so).
   */
  private strike(arrow: Arrow, hit: Hit): void {
    const impactVel = arrow.vel;
    const body = hit.collider.parent();
    let impulse = 0;
    if (body?.isDynamic()) {
      const push = scale(impactVel, ARROW.mass);
      this.push(body, push, hit.point);
      impulse = length(push);
    }
    const flightTicks = this.tick - arrow.firedTick;
    const victim = this.colliderOwners.get(hit.collider.handle);
    this.log.info('arrow_hit', {
      id: arrow.id,
      owner: arrow.ownerId,
      target: hit.label,
      zone: victim?.part ? PART_ZONE[victim.part] : null,
      /** Hits on moving things can differ from the preview; that's expected. */
      moving: body ? !body.isFixed() : false,
      point: rv(hit.point),
      ticks: flightTicks,
      speed: r3(length(impactVel)),
      impulse: r3(impulse),
      predTarget: arrow.predicted.label,
      predMoving: arrow.predicted.moving,
      predErr: arrow.predicted.hit ? r3(dist(arrow.predicted.hit, hit.point)) : null,
      predTickErr: flightTicks - arrow.predicted.ticks,
    });
    const who = victim?.part ? { id: victim.ownerId, part: victim.part } : null;
    // A wall, floor or crate: clients draw a bullet hole (fixed things only) and dust.
    if (!who) this.impact(hit.point, arrow.angle, body && !body.isFixed() ? 'object' : 'wall');
    this.hazards.onArrowHit(arrow, hit, impactVel);
    const special = this.specials.onHit(arrow, hit, who);
    if (who) this.hitPlayer(arrow, who.id, who.part, hit.point, length(impactVel), special?.damageShare ?? 1, !special);
    if (special?.stick && body) {
      // a bomb / plunger: it stays on what it hit and moves with it
      const rot = body.rotation();
      arrow.stuck = { body, localPos: rotate(sub(hit.point, body.translation()), -rot), localAngle: arrow.angle - rot, label: hit.label, since: this.tick };
      arrow.pos = { ...hit.point };
      arrow.vel = { x: 0, y: 0 };
      arrow.state = 'stuck';
      return;
    }
    arrow.state = 'gone';
    arrow.vel = { x: 0, y: 0 };
    // A normal bullet through a limb with a wall right behind it nails the limb there (the hit itself does it).
    if (!special && who && this.stats.get(who.id)?.alive) this.specials.tryPin(arrow, hit, who, impactVel);
  }

  private followBody(arrow: Arrow): void {
    const s = arrow.stuck;
    if (!s) return;
    const rot = s.body.rotation();
    arrow.pos = add(s.body.translation(), rotate(s.localPos, rot));
    arrow.angle = s.localAngle + rot;
  }

  /**
   * A bullet reached something: an apple or a bubble/balloon takes it, anything else it strikes. One place for both
   * the flight and a point-blank shot (inside arm's reach): the point-blank path used to just stick, so a bot shooting
   * up into its own balloon left an arrow stuck in it, and removing the balloon later crashed the physics engine.
   */
  private resolveHit(arrow: Arrow, hit: Hit): void {
    const apple = this.apples.find((a) => a.collider.handle === hit.collider.handle);
    const target = apple ? null : this.specials.targetOf(hit.collider);
    if (apple) this.shootApple(arrow, apple, hit.point);
    else if (target) this.specials.shootTarget(arrow, target, hit.point);
    else this.strike(arrow, hit);
  }

  /**
   * A body is about to be removed from the world (a balloon): arrows stuck in it must go first, or the next step reads
   * a body that no longer exists (a crash inside the physics engine). Should never find any: logged as an anomaly.
   */
  dropArrowsOn(body: RAPIER.RigidBody, why: string): void {
    for (const a of this.arrows) {
      if (a.state !== 'stuck' || a.stuck?.body.handle !== body.handle) continue;
      this.anomaly('arrow_on_removed_body', `arrow${a.id}`, { body: this.bodyLabel(body), why }, 'error');
      this.removeArrow(a, why);
    }
  }

  private removeArrow(arrow: Arrow, reason: string): void {
    arrow.state = 'gone';
    this.log.info('arrow_lost', { id: arrow.id, owner: arrow.ownerId, reason, pos: rv(arrow.pos), ticks: this.tick - arrow.firedTick });
  }

  private checkAnomalies(): void {
    this.physics.forEachRigidBody((b) => {
      if (!b.isDynamic()) return;
      const label = this.bodyLabel(b);
      const p = b.translation();
      const v = b.linvel();
      if (!isFiniteVec(p) || !isFiniteVec(v)) {
        this.anomaly('nan_body', label, { p: [p.x, p.y], v: [v.x, v.y] }, 'error');
        return;
      }
      if (length(v) > DEBUG.maxBodySpeed) this.anomaly('body_too_fast', label, { speed: r3(length(v)), p: rv(p) });
      // A player leaving the arena is a death (handled in step), not a physics problem.
      if (outOfArena(p, this.bounds) && !this.isRagdollPart(b)) this.anomaly('body_out_of_arena', label, { p: rv(p) });
    });
    for (const [id, set] of this.effects) {
      for (const e of set.all()) {
        if (!this.stats.get(id)?.alive) this.anomaly('effect_on_dead', id, { kind: e.kind }, 'error');
        if (e.end - e.start > EFFECT_MAX_TICKS[e.kind] || e.end < this.tick) this.anomaly('effect_too_long', id, { kind: e.kind, start: e.start, end: e.end }, 'error');
      }
    }
    this.checkBodyDamage();
    for (const st of this.stats.values()) {
      const bad = (v: number, max: number) => !Number.isFinite(v) || v < 0 || v > max;
      if (bad(st.health, HEALTH.max) || bad(st.stamina, STAMINA.max)) {
        this.anomaly('stats_out_of_range', st.id, { hp: st.health, sta: st.stamina }, 'error');
      }
    }
    for (const a of this.arrows) {
      if (!isFiniteVec(a.pos) || !isFiniteVec(a.vel)) {
        this.anomaly('nan_arrow', `arrow:${a.id}`, { p: [a.pos.x, a.pos.y], v: [a.vel.x, a.vel.y] }, 'error');
        a.state = 'gone';
      }
      // L3: bullets vanish where they hit. Only a bomb (until it goes off) or a plunger (while its rope pulls) may stay.
      const life = a.kind === 'bomb' ? SPECIAL.bomb.fuseTicks : a.kind === 'plunger' ? SPECIAL.plunger.ticks : 0;
      if (a.state === 'stuck' && (!a.stuck || this.tick - a.stuck.since > life + 2)) {
        this.anomaly('projectile_after_hit', `arrow:${a.id}`, { kind: a.kind, on: a.stuck?.label ?? null, ticks: a.stuck ? this.tick - a.stuck.since : null }, 'error');
        a.state = 'gone';
      }
    }
    this.arrows = this.arrows.filter((a) => a.state !== 'gone');
  }

  /**
   * L4 checks (the ladder's own one-step check is in `bodyHit`): the body really has the stumps / missing hand the
   * rules say; a damaged body that stays down too long (alive, not knocked out) can't get up in that stage.
   */
  private checkBodyDamage(): void {
    for (const [id, dmg] of this.damage) {
      const st = this.stats.get(id);
      const p = this.players.get(id);
      if (!st?.alive || !p) continue;
      const stage = dmg.legStage;
      const stumps = dmg.stumps;
      if (stumps.length !== p.stumps.size || stumps.some((s) => !p.stumps.has(s))) {
        this.anomaly('body_state_mismatch', id, { rules: dmg.summary(), body: { stumps: [...p.stumps], lost: [...p.lost] } }, 'error');
      }
      if (stage > 0) {
        // (counted from when it could get up: full balance. Stun after stun keeps a body down without a chance.)
        const stuck = p.stuckTicks(this.tick);
        if (stuck >= DAMAGE.stuckDownTicks) this.anomaly('stage_cant_stand', id, { stage, name: LEG_STAGE_NAMES[stage], stuckTicks: stuck, downTicks: p.downTicks(this.tick), ...p.situation(), ...p.contactInfo() });
      }
    }
  }

  /** Logs a problem, but at most once per cooldown per (event, thing), so logs don't flood. */
  anomaly(ev: string, who: string, data: Record<string, unknown>, lvl: 'warn' | 'error' = 'warn'): void {
    const key = `${ev}:${who}`;
    const last = this.anomalyLastTick.get(key);
    if (last && this.tick - last.tick < DEBUG.anomalyCooldownTicks) {
      last.hidden++; // not logged now, but counted, so the next line says how many were skipped
      return;
    }
    this.anomalyLastTick.set(key, { tick: this.tick, hidden: 0 });
    this.log[lvl](ev, { who, ...data, ...(last?.hidden ? { repeatsNotLogged: last.hidden } : {}) });
  }

  private isAnythingMoving(): boolean {
    if (this.arrows.some((a) => a.state === 'flying')) return true;
    let moving = false;
    this.physics.forEachRigidBody((b) => {
      if (b.isDynamic() && (length(b.linvel()) > STILL_SPEED || Math.abs(b.angvel()) > STILL_SPEED)) moving = true;
    });
    return moving;
  }

  private isRagdollPart(b: RAPIER.RigidBody): boolean {
    return this.ownedBodies.has(b.handle);
  }

  private bodyLabel(b: RAPIER.RigidBody): string {
    return this.bodyLabels.get(b.handle) ?? `body:${b.handle}`;
  }
}

/** Which leg a balloon is tied to (null for the torso, head or an arm). */
function floatLegOf(part: PartName | undefined): 'front' | 'back' | null {
  return part?.startsWith('legFront') ? 'front' : part?.startsWith('legBack') ? 'back' : null;
}

function shapeOf(c: RAPIER.Collider): Shape {
  if (c.shape.type === RAPIER.ShapeType.Ball) return { r: c.radius() };
  const h = c.halfExtents();
  return { hx: h?.x ?? 0, hy: h?.y ?? 0 };
}
