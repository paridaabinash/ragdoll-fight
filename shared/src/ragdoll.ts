import RAPIER from '@dimforge/rapier2d-compat';
import type { Aim } from './aim';
import { ARM_REACH, BALANCE, DT, EFFECT_BODY, FALL, GUN, HAZARD, HIT_REACTION, LEGS, LIMB, MELEE, LIMIT_CHECK, MOTOR, MOVE, RAGDOLL, SOLVER_ITERATIONS, SPECIAL, STUMBLE, TRIP, WALK } from './constants';
import type { Logger } from './log';
import { add, clamp, dist, r2, r3, rotate, rv, scale, sub, vec, wrapAngle, type Vec2 } from './math';

export type PartName =
  | 'head'
  | 'torso'
  | 'armFrontUpper'
  | 'armFrontLower'
  | 'armBackUpper'
  | 'armBackLower'
  | 'legFrontUpper'
  | 'legFrontLower'
  | 'legBackUpper'
  | 'legBackLower';

export type Zone = 'head' | 'torso' | 'arm' | 'leg';
export const PART_ZONE: Record<PartName, Zone> = {
  head: 'head',
  torso: 'torso',
  armFrontUpper: 'arm',
  armFrontLower: 'arm',
  armBackUpper: 'arm',
  armBackLower: 'arm',
  legFrontUpper: 'leg',
  legFrontLower: 'leg',
  legBackUpper: 'leg',
  legBackLower: 'leg',
};

export type JointName = 'neck' | 'shoulderFront' | 'elbowFront' | 'shoulderBack' | 'elbowBack' | 'hipFront' | 'kneeFront' | 'hipBack' | 'kneeBack';

/** What the player wants this tick. Same shape will be sent over the network in Phase 4. */
export interface Controls {
  /**
   * L3: where the gun points (the mouse pointer's direction). null = no aim input: the gun points straight ahead and the
   * body faces the way it walks. The arms are always up unless the world lowers them (`BodyMods.armsDown`).
   */
  aim: Aim | null;
  crouch: boolean;
  /** Held key. A jump happens on the tick it goes from false to true. */
  jump: boolean;
  /** Walk direction: -1 left, 0 stand, +1 right. */
  move: -1 | 0 | 1;
  /** Taunt (S7): a silly dance while standing. Getting hit mid-dance is HUMBLED! */
  taunt?: boolean;
}
export const NO_CONTROLS: Controls = { aim: null, crouch: false, jump: false, move: 0 };

/**
 * What stuck arrows do to the body right now (S3). The world sets it every tick from the player's effects;
 * the ragdoll just moves differently. NO_MODS = the normal body.
 */
export interface BodyMods {
  /** Arrow in the head: floppy neck, heavy head. */
  headHeavy: boolean;
  /** Hit in an arm: the back arm spins in circles while walking (the gun arm keeps aiming; the world swings its aim). */
  armFlail: boolean;
  /**
   * L4 dragging limp (the leg ladder's 2nd stage): this leg hangs and is pulled along while the body hops on the other
   * one (slightly crouched). Jumps are normal: the dragging leg is the joke, not a punishment. (Was the S3 5 s
   * high-step limp, whose jumps misfired into a backflip; removed 2026-10-08: too frustrating to play.)
   */
  dragLeg: Side | null;
  /** Feet in an oil puddle (S5): no grip; standing slides into a split, walking scrambles then slides on the belly. */
  oiled: boolean;
  /** Feather (S5): laughing, arms flail. */
  laughing: boolean;
  /** A balloon tied to this leg (S5): it goes slack so the balloon can float it up (hop on the other foot). */
  floatLeg: 'front' | 'back' | null;
  /** L7: a balloon on the torso/head holds the body up: off the ground it runs and paddles in the air (swimming). */
  floating: boolean;
  /** Standing on a conveyor belt moving at this speed (S6): walking is relative to the belt; standing still rides it. */
  beltSpeed: number;
  /** A limb pinned to a wall (S5): you can barely walk away from it (mash jump to break free). */
  pinned: boolean;
  /** L3: arms down (out of stamina, or laughing): the arms hang instead of holding the gun up. */
  armsDown: boolean;
  /** L5: a melee swing in progress: the arms follow this angle (the body doesn't turn to it). null = no swing. */
  swing: number | null;
  /** L7: just hit by a bullet: walking and air control push weakly for a moment, so the knock shows. */
  flinch: boolean;
  /** L7: a melee swing just ended: the weapon arm is let go (damped), so the weapon swings on and settles. */
  swingSettle: boolean;
  /** L5: arms broken by melee hits: they hang loose (shots still come from the shoulder: you can always fight back). */
  limpArms: Side[];
  /** L5: a melee player (gun knocked away) runs MELEE.runFactor faster. */
  fast: boolean;
}
export const NO_MODS: BodyMods = { headHeavy: false, armFlail: false, dragLeg: null, oiled: false, laughing: false, floatLeg: null, beltSpeed: 0, pinned: false, armsDown: false, swing: null, limpArms: [], fast: false, flinch: false, swingSettle: false, floating: false };

/** What a ragdoll needs from the world it lives in. */
export interface RagdollHost {
  readonly physics: RAPIER.World;
  readonly log: Logger;
  registerCollider(collider: RAPIER.Collider, body: RAPIER.RigidBody, label: string, ownerId?: string, part?: PartName): void;
  /** The label a collider was registered with (for problem logs). */
  labelOf(collider: RAPIER.Collider): string;
  raycast(from: Vec2, to: Vec2, ignoreOwner: string): { point: Vec2; label: string } | null;
  anomaly(ev: string, who: string, data: Record<string, unknown>, lvl?: 'warn' | 'error'): void;
  /** One-tick push / turning push. Ragdoll bodies ignore Rapier's direct impulses, so always use these. */
  push(body: RAPIER.RigidBody, impulse: Vec2, point?: Vec2): void;
  twist(body: RAPIER.RigidBody, torqueImpulse: number): void;
  /**
   * A part was shot off (L0/L4): it's a loose piece now, no longer the player's body. Hits on it must not hurt them,
   * and it keeps lying around (relabelled `label`) until the player respawns.
   */
  releasePart(collider: RAPIER.Collider, body: RAPIER.RigidBody, label: string): void;
}

/** Which of the two arms / legs: the front one (nearer the camera, the gun arm) or the back one. */
export type Side = 'front' | 'back';

// ---- Body layout (rest pose: standing straight, feet at (0, 0), y down so "up" is negative) ----

/** A ball (radius) or a box (half width, half height). */
export type Shape = { r: number } | { hx: number; hy: number };
const { head, torso, upperArm, lowerArm, upperLeg, lowerLeg, shoulderDrop } = RAGDOLL;
const kneeY = -lowerLeg.hy * 2;
const hipY = kneeY - upperLeg.hy * 2;
const torsoTop = hipY - torso.hy * 2;
const shoulderY = torsoTop + shoulderDrop;
const elbowY = shoulderY + upperArm.hy * 2;

const PARTS: Record<PartName, { shape: Shape; center: Vec2 }> = {
  head: { shape: head, center: vec(0, torsoTop - head.r) },
  torso: { shape: torso, center: vec(0, hipY - torso.hy) },
  armFrontUpper: { shape: upperArm, center: vec(0, shoulderY + upperArm.hy) },
  armFrontLower: { shape: lowerArm, center: vec(0, elbowY + lowerArm.hy) },
  armBackUpper: { shape: upperArm, center: vec(0, shoulderY + upperArm.hy) },
  armBackLower: { shape: lowerArm, center: vec(0, elbowY + lowerArm.hy) },
  legFrontUpper: { shape: upperLeg, center: vec(0, hipY + upperLeg.hy) },
  legFrontLower: { shape: lowerLeg, center: vec(0, kneeY + lowerLeg.hy) },
  legBackUpper: { shape: upperLeg, center: vec(0, hipY + upperLeg.hy) },
  legBackLower: { shape: lowerLeg, center: vec(0, kneeY + lowerLeg.hy) },
};

interface JointSpec {
  parent: PartName;
  child: PartName;
  /** Joint position in the rest pose. */
  at: Vec2;
  /** Allowed angle range (child angle minus parent angle) when facing right. null = free (shoulders). */
  limits: [number, number] | null;
}

// Angle signs when facing right: negative = the child swings forward (toward +x).
const JOINTS: Record<JointName, JointSpec> = {
  neck: { parent: 'torso', child: 'head', at: vec(0, torsoTop), limits: [-0.5, 0.5] },
  shoulderFront: { parent: 'torso', child: 'armFrontUpper', at: vec(0, shoulderY), limits: null },
  elbowFront: { parent: 'armFrontUpper', child: 'armFrontLower', at: vec(0, elbowY), limits: [-2.5, 0.05] },
  shoulderBack: { parent: 'torso', child: 'armBackUpper', at: vec(0, shoulderY), limits: null },
  elbowBack: { parent: 'armBackUpper', child: 'armBackLower', at: vec(0, elbowY), limits: [-2.5, 0.05] },
  // (funny legs: the hips bend back to 1.2 rad, was 0.7: the Big Scissor's trailing leg and the Split Leap's back leg)
  hipFront: { parent: 'torso', child: 'legFrontUpper', at: vec(0, hipY), limits: [-1.9, 1.2] },
  kneeFront: { parent: 'legFrontUpper', child: 'legFrontLower', at: vec(0, kneeY), limits: [0, 2.5] },
  hipBack: { parent: 'torso', child: 'legBackUpper', at: vec(0, hipY), limits: [-1.9, 1.2] },
  kneeBack: { parent: 'legBackUpper', child: 'legBackLower', at: vec(0, kneeY), limits: [0, 2.5] },
};
const JOINT_NAMES = Object.keys(JOINTS) as JointName[];
/** The two parts a joint joins, and every part further out (an elbow: upper arm + forearm; a hip: torso + leg). */
function limbOf(joint: JointName): PartName[] {
  return [JOINTS[joint].parent, ...limbFrom(JOINTS[joint].child)];
}
/** A part and every part further out on the same limb (e.g. a thigh: thigh + shin). */
function limbFrom(part: PartName): PartName[] {
  return [part, ...JOINT_NAMES.filter((j) => JOINTS[j].parent === part).flatMap((j) => limbFrom(JOINTS[j].child))];
}

/** Body parts in a fixed order (the network snapshot sends poses in this order). */
export const PART_NAMES = Object.keys(PARTS) as PartName[];
export const PART_SHAPES = Object.fromEntries(PART_NAMES.map((n) => [n, PARTS[n].shape])) as Record<PartName, Shape>;

/** Front shoulder in world space, from the torso's position and angle. */
export function shoulderFrontFrom(torso: Vec2, torsoAngle: number): Vec2 {
  return add(torso, rotate(sub(JOINTS.shoulderFront.at, PARTS.torso.center), torsoAngle));
}

/** Where a bullet leaves the gun: one arm's length from the shoulder, along the aim (not the floppy hand). */
export function launchPointFrom(shoulder: Vec2, aim: Aim): Vec2 {
  return { x: shoulder.x + Math.cos(aim.angle) * ARM_REACH, y: shoulder.y + Math.sin(aim.angle) * ARM_REACH };
}

type PoseJoint = Exclude<JointName, 'shoulderFront' | 'shoulderBack'>;
/**
 * Target joint angles when facing right. Facing left uses the same numbers flipped.
 * Both legs always get the SAME targets: with both feet planted, legs + ground form a closed loop,
 * and different targets per leg make the motors fight each other through the ground (sliding, crossed legs, bouncing).
 */
const POSES: Record<'stand' | 'crouch', Record<PoseJoint, number>> = {
  stand: { neck: 0, elbowFront: -0.2, elbowBack: -0.2, hipFront: -0.05, kneeFront: 0.1, hipBack: -0.05, kneeBack: 0.1 },
  crouch: { neck: 0, elbowFront: -0.2, elbowBack: -0.2, hipFront: -1.1, kneeFront: 2.0, hipBack: -1.1, kneeBack: 2.0 },
};

const MOTOR_OF: Record<PoseJoint, { stiffness: number; damping: number }> = {
  neck: MOTOR.neck,
  elbowFront: MOTOR.elbow,
  elbowBack: MOTOR.elbow,
  hipFront: MOTOR.leg,
  kneeFront: MOTOR.leg,
  hipBack: MOTOR.leg,
  kneeBack: MOTOR.leg,
};

const ARMS: PartName[] = ['armFrontUpper', 'armFrontLower', 'armBackUpper', 'armBackLower'];
const LEG = {
  front: { upper: 'legFrontUpper', lower: 'legFrontLower', knee: 'kneeFront' },
  back: { upper: 'legBackUpper', lower: 'legBackLower', knee: 'kneeBack' },
} as const satisfies Record<Side, { upper: PartName; lower: PartName; knee: JointName }>;
/** The invisible anchor at the torso's middle (the joint tree's root): almost no mass, a huge rotational inertia. */
const ANCHOR = { radius: 0.05, mass: 0.05, inertia: 1000 };
/** Half length of a thigh stump (it keeps the hip end of the thigh). */
const STUMP_HALF = upperLeg.hy * LIMB.stumpShare;

/**
 * An active ragdoll: real hinge joints with limits, joint motors that hold a pose,
 * and a balance controller that keeps it upright. Lives inside a GameWorld.
 */
export class Ragdoll {
  readonly parts = {} as Record<PartName, RAPIER.RigidBody>;
  /** L6: invisible, non-turning root of the joint tree (see the constructor). Removed with the body. */
  readonly anchor: RAPIER.RigidBody;
  private readonly colliders = {} as Record<PartName, RAPIER.Collider>;
  private readonly joints = {} as Record<JointName, RAPIER.RevoluteImpulseJoint>;
  /** The multibody half of each hinge (see the constructor); kept so a joint can be cut when a part is shot off. */
  private readonly links = {} as Record<JointName, RAPIER.MultibodyJoint>;
  /** Joints that were cut (a part shot off): they no longer exist in the physics world. */
  private readonly cut = new Set<JointName>();
  /** Parts shot off: loose pieces now (still in `parts`, so they're drawn and removed on respawn, but not the body). */
  readonly lost = new Set<PartName>();
  /** Legs shot down to a thigh stump. */
  readonly stumps = new Set<Side>();
  private lastHopTick = -Infinity;
  /** L7: ticks between hops right now (for the limp's knee dip). */
  private hopEvery = 0;
  /** L4: the leg being dragged right now (from `mods.dragLeg`), or null. */
  private dragging: Side | null = null;
  /** Hops so far (one leg left), for reports. */
  hops = 0;
  /** Joints whose limits are temporarily widened after turning around, so they don't snap. */
  private readonly relaxed = new Set<JointName>();

  controls: Controls = NO_CONTROLS;
  facing: 1 | -1;
  grounded = false;
  /** 0..1 share of balance strength (drops to 0 when tripped). */
  balance = 1;
  down = false;
  /** Dead: no balance, no motors, no moves. The body just falls. */
  limp = false;
  /** 0..1, how strongly the legs are stepping (0 = standing still). */
  gait = 0;
  /** Effects from stuck arrows (set by the world each tick). */
  mods: BodyMods = NO_MODS;
  /** Tick of the last oil slide (S5); the world turns it into a callout. */
  slippedAt = -Infinity;
  /** Oil: how far the legs have slid apart while standing (rad), and the scramble before a slide. */
  private oilSplit = 0;
  private oilScramble: { dir: -1 | 1; until: number } | null = null;
  /** Balance-off time of the current knock (a trip, or longer for a glove/bomb/oil slide). */
  private offTicks: number = TRIP.offTicks;
  /** Catching a forward tip with a few quick steps: direction and until when. */
  /** A stumble: the legs step by themselves toward `dir` (L7: a melee stagger sets its own speed and a lean back). */
  private stumble: { dir: -1 | 1; until: number; speed?: number; lean?: number } | null = null;
  private lastStumbleEnd = -Infinity;
  private flailPhase = 0;
  /** L3: where the gun arm points this tick (the aim, or straight ahead), or null while the arms hang. */
  private gunAim: Aim | null = null;
  /** Knocked by a glove / bomb / oil slide: the arms hang until then (a trip keeps them up). */
  private stunnedUntil = -Infinity;

  private gaitPhase = 0;
  private walk: { dir: -1 | 1; since: number; startX: number } | null = null;
  /** Braking to a stop after letting go of the walk keys. */
  private braking = false;
  /** Which way the body was going when the brake began (the stop leans that way). */
  private brakeDir = 0;
  /** null = not applied yet to the current feet (e.g. right after a leg became a stump). */
  private slipperyFeet: 'grip' | 'walk' | 'oil' | null = 'grip';
  /** L6: in the air and pressed against a wall in the walk direction: the walk push is held back (see driveWalk). */
  private wallHeld = false;
  /** Aiming into something within arm's reach (e.g. a wall): the arm only rests against it. */
  aimBlocked = false;
  private totalMass = 0;
  private trippedAt = -Infinity;
  private lastJumpTick = -Infinity;
  private jumpHeld = false;
  /** L2: last tick the feet were on the ground (coyote time), last jump press (buffer), and whether this jump was cut short. */
  private lastGroundTick = -Infinity;
  private jumpPressedAt = -Infinity;
  private jumpCut = false;
  private crouching = false;
  private downSince = 0;
  /** L6: since when the body has been down with full balance (null while up or knocked). */
  private tryingSince: number | null = null;
  private air: { since: number; startY: number; peakY: number; fall: number; apexAt: number | null } | null = null;
  /** Funny legs: how much of the Big Scissor swing is on (0..1, blended; see drivePose). */
  private scissor = 0;
  /** L7: where the air-swimming stroke is (rad). */
  private swimPhase = 0;
  /** L7: ticks off the ground but not moving (hung on something): long enough and a jump is allowed. */
  private stillAirTicks = 0;
  /** L7: the last landing: when, and how deep the knees sink (rad) before springing back. */
  private landing: { at: number; sink: number } | null = null;

  /** L7: how long this body has been off the ground (ticks; 0 on the ground). */
  airTicks(tick: number): number {
    return this.air ? tick - this.air.since : 0;
  }
  /** Ticks in a row each joint has been past its limit. */
  private readonly overTicks = new Map<JointName, number>();
  private readonly gapTicks = new Map<JointName, number>();
  /** A limb crushed past its limit (or pulled apart) right now: since when, the worst so far, what it touched. */
  private readonly spikes = new Map<JointName, { since: number; over: number; gap: number; touch: unknown; impact: number }>();
  /**
   * Each part's speed after the last step, and how much it changed in that step: a sudden change (a hit, a hard
   * landing) explains a joint spike in this step or the next one.
   */
  private readonly lastVel = new Map<PartName, Vec2>();
  private readonly lastJolt = new Map<PartName, number>();

  constructor(
    private readonly host: RagdollHost,
    readonly id: string,
    /** 1..15. Parts of the same ragdoll never collide with each other. */
    slot: number,
    feet: Vec2,
    facing: 1 | -1,
  ) {
    if (slot < 1 || slot > 15) throw new Error(`ragdoll slot must be 1..15, got ${slot}`);
    // Collision groups: 16 "I am" bits + 16 "I collide with" bits. A body never collides with its own parts;
    // with RAGDOLL.playersCollide off, all ragdolls share one bit, so no ragdoll collides with another either.
    const member = RAGDOLL.playersCollide ? 1 << slot : 1 << 1;
    const groups = ((member << 16) | (0xffff & ~member)) >>> 0;
    const { physics } = host;

    for (const name of Object.keys(PARTS) as PartName[]) {
      const { shape, center } = PARTS[name];
      const body = physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(feet.x + center.x, feet.y + center.y).setSoftCcdPrediction(RAGDOLL.softCcd));
      const desc = 'r' in shape ? RAPIER.ColliderDesc.ball(shape.r) : RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy);
      const density = RAGDOLL.density * (name === 'legFrontLower' || name === 'legBackLower' ? RAGDOLL.bootDensity : 1);
      const collider = physics.createCollider(desc.setDensity(density).setFriction(RAGDOLL.friction).setCollisionGroups(groups), body);
      host.registerCollider(collider, body, `${id}:${name}`, id, name);
      this.parts[name] = body;
      this.colliders[name] = collider;
    }
    this.updateMass();
    // L6: the root of the joint tree is an invisible anchor that can't turn, hinged freely to the torso. Whenever a
    // multibody joint is removed (a hand or shin shot off, a shatter), Rapier rebuilds the tree and resets the ROOT's
    // rotation to 0 (it keeps the joint angles). With the torso as the root, a body lying down (torso at 1.7 rad) was
    // snapped upright in one tick: 18 rad/s of spin, legs and neck forced through the floor, joints 0.5-0.9 m apart.
    // The anchor's rotation is always 0, so the reset changes nothing, and the torso's angle is a joint angle (kept).
    const torsoAt = PARTS.torso.center;
    // (Rapier ignores lockRotations() on a multibody root, so it can't turn because of a huge rotational inertia: the
    // free hinge passes it no turning force, and the solver's small leaks can't move it.)
    this.anchor = physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(feet.x + torsoAt.x, feet.y + torsoAt.y)
        .setAdditionalMassProperties(ANCHOR.mass, vec(0, 0), ANCHOR.inertia),
    );
    // (a massless sensor in no collision group, so the world knows the body as the player's; nothing touches it)
    const anchorCollider = physics.createCollider(RAPIER.ColliderDesc.ball(ANCHOR.radius).setDensity(0).setSensor(true).setCollisionGroups(0), this.anchor);
    host.registerCollider(anchorCollider, this.anchor, `${id}:anchor`, id);
    if (!physics.createMultibodyJoint(RAPIER.JointData.revolute(vec(0, 0), vec(0, 0)), this.anchor, this.parts.torso, true)) throw new Error('could not create the anchor joint');
    for (const name of JOINT_NAMES) {
      const spec = JOINTS[name];
      const data = () => RAPIER.JointData.revolute(sub(spec.at, PARTS[spec.parent].center), sub(spec.at, PARTS[spec.child].center));
      // Two joints per hinge:
      // - multibody joint: keeps the bones exactly together. Impulse joints alone are slightly springy and
      //   make the whole body bounce back up after landing.
      // - impulse joint on the same anchor: carries the motor and the limits, which can be changed at runtime
      //   (Rapier's JS API has neither for multibody joints).
      const link = physics.createMultibodyJoint(data(), this.parts[spec.parent], this.parts[spec.child], true);
      if (!link) throw new Error(`could not create the multibody joint ${name}`);
      this.links[name] = link;
      this.joints[name] = physics.createImpulseJoint(data(), this.parts[spec.parent], this.parts[spec.child], true) as RAPIER.RevoluteImpulseJoint;
      // Shoulder velocity motors are otherwise unlimited and can lever the elbows past their limits (see MOTOR).
      if (!spec.limits) this.joints[name].setMotorMaxForce(MOTOR.shoulderMaxTorque);
    }
    this.facing = facing;
    for (const name of JOINT_NAMES) {
      const lim = this.limitsFor(name);
      if (lim) this.joints[name].setLimits(lim[0], lim[1]);
    }
  }

  center(): Vec2 {
    return { ...this.parts.torso.translation() };
  }

  /** Sideways speed of the whole body (mass-weighted), m/s. */
  speedX(): number {
    let momentum = 0;
    for (const b of this.attached()) momentum += b.mass() * b.linvel().x;
    return momentum / this.totalMass;
  }

  /** The parts still attached to the body (all of them, until something is shot off). */
  attached(): RAPIER.RigidBody[] {
    return PART_NAMES.filter((n) => !this.lost.has(n)).map((n) => this.parts[n]);
  }

  /** Legs still whole (2, 1 or 0: the rest are stumps). */
  get legsLeft(): number {
    return 2 - this.stumps.size;
  }

  /** L4: legs the body stands on: whole and not dragging (a dragging leg hangs). One = the hop mode. */
  get standingLegs(): number {
    const drag = this.mods.dragLeg;
    return this.legsLeft - (drag && !this.stumps.has(drag) ? 1 : 0);
  }

  /** L4: how long (ticks) the body has been down (fallen) at `tick`; 0 while up. */
  downTicks(tick: number): number {
    return this.down ? tick - this.downSince : 0;
  }

  /**
   * L6: how long (ticks) the body has been down with full balance, i.e. able to get up but not up; 0 otherwise. (A body
   * kept down by stun after stun, six gloves in a row, is down for a long time without ever having had the chance.)
   */
  stuckTicks(tick: number): number {
    return this.down && this.tryingSince !== null ? tick - this.tryingSince : 0;
  }

  /**
   * Shoots a leg down to a thigh stump: the knee is cut, the shin falls off as a loose piece, and the thigh keeps only
   * its hip end (no knee, no shin). Returns false if that leg already is one.
   */
  stumpLeg(side: Side, dirX = -this.facing): boolean {
    if (this.stumps.has(side)) return false;
    const leg = LEG[side];
    this.cutJoints([leg.knee]);
    this.release(leg.lower);
    // L7: the shin flies off along the bullet in a big spinning arc (on top of release's small tumble)
    const shin = this.parts[leg.lower];
    const dir = Math.sign(dirX) || -this.facing;
    this.host.push(shin, { x: dir * LIMB.lostLeg.along * shin.mass(), y: -LIMB.lostLeg.up * shin.mass() });
    this.host.twist(shin, dir * LIMB.lostLeg.spin * shin.principalInertia());
    const thigh = this.colliders[leg.upper];
    thigh.setHalfExtents({ x: upperLeg.hx, y: STUMP_HALF });
    // the thigh's body stays where it was (its joint to the hip doesn't move); only its shape shrinks toward the hip
    thigh.setTranslationWrtParent({ x: 0, y: -upperLeg.hy + STUMP_HALF });
    this.parts[leg.upper].recomputeMassPropertiesFromColliders();
    this.stumps.add(side);
    this.slipperyFeet = null; // the stump end is a foot now: give it the right grip on the next tick
    this.updateMass();
    this.host.log.info('part_lost', { id: this.id, part: leg.lower, stump: leg.upper, legsLeft: this.legsLeft, mass: r2(this.totalMass) });
    return true;
  }

  /**
   * L5: the body breaks into pieces (the last melee hit): every joint is cut and every part but the torso becomes a
   * loose piece. It's a death (the world makes it one); the pieces stay until respawn (they go with the body).
   */
  shatter(): void {
    this.cutJoints(this.liveJoints());
    for (const part of PART_NAMES) if (part !== 'torso' && !this.lost.has(part)) this.release(part);
    this.updateMass();
    this.host.log.info('body_shattered', { id: this.id, pieces: this.lost.size + 1 });
  }

  /** Removes both halves of a hinge from the physics world. */
  private cutJoints(names: JointName[]): void {
    // Rapier rebuilds the joint tree when a multibody joint goes and zeroes the root's speed (the anchor's: its
    // rotation stays 0, see the constructor), so the whole body would stop dead (1.1 m/s lost mid-fall, sim probe).
    // Give every part still on the tree that speed back with a one-tick push (multibody links ignore setLinvel). In
    // the air Rapier applies a push to a multibody link in all but the first of its SOLVER_ITERATIONS sub-steps
    // (measured: 2 passes -> 50% of the speed, 4 -> 75%, 5 -> 80%, 8 -> 87.5%), so the push is scaled up to match.
    const share = (SOLVER_ITERATIONS - 1) / SOLVER_ITERATIONS;
    const v = scale(this.anchor.linvel(), 1 / share);
    for (const name of names) {
      this.host.physics.removeMultibodyJoint(this.links[name], true);
      this.host.physics.removeImpulseJoint(this.joints[name], true);
      this.cut.add(name);
      this.relaxed.delete(name);
      this.overTicks.delete(name);
      this.gapTicks.delete(name);
      this.spikes.delete(name);
    }
    const offTree = new Set(names.map((n) => JOINTS[n].child).flatMap(limbFrom));
    for (const b of [this.anchor, ...PART_NAMES.filter((n) => !offTree.has(n) && !this.lost.has(n)).map((n) => this.parts[n])]) {
      this.host.push(b, { x: v.x * b.mass(), y: v.y * b.mass() });
    }
  }

  /** A part leaves the body: a loose piece from now on (and every part below it in that limb is already gone). */
  private release(part: PartName): void {
    this.lost.add(part);
    // a loose piece grips like a body part, not like a walking foot (a shin lost mid-step kept the slippery walking
    // grip and slid 14 m)
    const c = this.colliders[part];
    c.setFriction(RAGDOLL.friction);
    c.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
    // knocked loose: a small kick backward and up at its top end, so it tumbles away (a shin cut while standing
    // otherwise stayed standing on its own, balanced like a stick)
    const b = this.parts[part];
    const top = add(b.translation(), rotate(vec(0, -0.2), b.rotation()));
    this.host.push(b, { x: -this.facing * LIMB.pieceKick * b.mass(), y: -LIMB.pieceKick * b.mass() }, top);
    this.host.releasePart(this.colliders[part], this.parts[part], `piece:${this.id}:${part}`);
  }

  private updateMass(): void {
    this.totalMass = this.attached().reduce((m, b) => m + b.mass(), 0);
  }

  /** Joints still there (not cut). */
  private liveJoints(): JointName[] {
    return JOINT_NAMES.filter((n) => !this.cut.has(n));
  }

  /** What each leg stands on: the shin, or the thigh stump. A dragging leg isn't one (it hangs, L4). */
  private feet(): PartName[] {
    const drag = this.mods.dragLeg;
    return (['front', 'back'] as const)
      .filter((side) => side !== drag || this.stumps.has(side))
      .map((side) => (this.stumps.has(side) ? LEG[side].upper : LEG[side].lower));
  }

  /**
   * L4: a leg starts dragging: its foot goes slippery for good (so it slides along behind), and the feet's grip is
   * re-applied to the legs still standing.
   */
  private updateDrag(): void {
    const drag = this.mods.dragLeg && !this.stumps.has(this.mods.dragLeg) ? this.mods.dragLeg : null;
    if (drag === this.dragging) return;
    if (drag) {
      const c = this.colliders[LEG[drag].lower];
      c.setFriction(WALK.walkFriction);
      c.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    }
    this.host.log.info(drag ? 'drag_start' : 'drag_end', { id: this.id, leg: drag ?? this.dragging });
    this.dragging = drag;
    this.slipperyFeet = null;
  }

  /**
   * L4: where the body's soles are now (world space): the bottom of each shin, or of a thigh stump; a dragging leg's
   * foot too (it touches whatever it's dragged through). Never a shot-off piece: that's not the body any more (a shin
   * lying on a trampoline kept launching its stumped owner, sim chaos).
   */
  footPoints(): Vec2[] {
    return (['front', 'back'] as const).map((side) => this.footPoint(this.stumps.has(side) ? LEG[side].upper : LEG[side].lower));
  }

  /** The bottom end of a foot part (shin or stump), in world space. */
  private footPoint(name: PartName): Vec2 {
    const b = this.parts[name];
    const local = name === 'legFrontUpper' || name === 'legBackUpper' ? vec(0, -upperLeg.hy + 2 * STUMP_HALF) : vec(0, lowerLeg.hy);
    return add(b.translation(), rotate(local, b.rotation()));
  }

  /**
   * Head hitbox size (Big Head Mode). The weight stays the same (density goes down as the area goes up), so balance
   * doesn't change; only the target gets bigger.
   */
  setHeadScale(scale: number): void {
    const c = this.colliders.head;
    c.setRadius(RAGDOLL.head.r * scale);
    c.setDensity(RAGDOLL.density / (scale * scale));
  }

  /** Torso angle the balance aims for: lean into the walk, into the slide while braking, forward while crouching. */
  private leanTarget(c: Controls): number {
    // L7: staggering back from a melee hit: the torso leans back, the way the hit pushed (the legs step under it)
    if (this.stumble?.lean) return this.stumble.lean * this.stumble.dir;
    if (c.crouch) return BALANCE.crouchLean * this.facing;
    // Directions come from what the player does (walk key, or the way they were going when the brake began), not from
    // the measured speed: its sign flips around zero during a stop and made the lean rock back and forth.
    if (this.braking) return WALK.brakeLean * this.brakeDir;
    // No running lean with an arrow in the head: heavy head + lean tipped the runner over (sim head_sway: fell
    // after 1 s). The stop lean stays: that's what pitches the heavy head into a stumble.
    return this.mods.headHeavy ? 0 : WALK.lean * this.gait * c.move;
  }

  /**
   * Spaghetti arms: still air pushes back on the loose arms, so they trail behind when running (sideways only:
   * up/down drag braked jumps). The torso gets the same push forward at the shoulder, so the arms trail but the body
   * as a whole isn't slowed or tipped back (with plain drag it leaned the runner backwards and fought the walk lean).
   */
  private dragArms(): void {
    let total = 0;
    for (const name of ARMS) {
      if (this.lost.has(name)) continue;
      const b = this.parts[name];
      const fx = -MOTOR.armDrag * b.linvel().x * DT;
      this.host.push(b, { x: fx, y: 0 });
      total += fx;
    }
    this.host.push(this.parts.torso, { x: -total, y: 0 }, this.jointPos('shoulderFront'));
  }

  /** Go limp (death) or come back to life. */
  setLimp(limp: boolean): void {
    this.limp = limp;
    if (limp) {
      this.setSlipperyFeet('grip');
      this.walk = null;
      this.gait = 0;
    }
  }

  /** World position of a joint (measured on its parent part). */
  jointPos(name: JointName): Vec2 {
    const spec = JOINTS[name];
    const parent = this.parts[spec.parent];
    return add(parent.translation(), rotate(sub(spec.at, PARTS[spec.parent].center), parent.rotation()));
  }

  /** Bullets launch from where the gun hand is when the arm points along the aim. */
  launchPoint(aim: Aim): Vec2 {
    return launchPointFrom(this.jointPos('shoulderFront'), aim);
  }

  jointAngle(name: JointName): number {
    const spec = JOINTS[name];
    return wrapAngle(this.parts[spec.child].rotation() - this.parts[spec.parent].rotation());
  }

  /**
   * How far (rad) a joint is past its limit: 0 or less = inside. null = no limit (shoulders) or limits widened
   * for a moment after turning around. Same number the `joint_over_limit` check uses.
   */
  limitOver(name: JointName): number | null {
    const lim = this.limitsFor(name);
    if (!lim || this.relaxed.has(name)) return null;
    const a = this.jointAngle(name);
    return Math.max(lim[0] - a, a - lim[1]);
  }

  /** How far past its limit (rad) the worst joint next to `part` is (0 when all are inside): for a wall pin. */
  strainOn(part: PartName): number {
    let worst = 0;
    for (const joint of this.liveJoints()) {
      if (JOINTS[joint].child !== part && JOINTS[joint].parent !== part) continue;
      worst = Math.max(worst, this.limitOver(joint) ?? 0);
    }
    return worst;
  }

  /** The joint furthest past its limit right now (see `limitOver`). */
  worstLimitOver(): { joint: JointName; over: number } {
    let worst = { joint: JOINT_NAMES[0], over: -Infinity };
    for (const joint of this.liveJoints()) {
      const over = this.limitOver(joint);
      if (over !== null && over > worst.over) worst = { joint, over };
    }
    return worst;
  }

  /** Knocks the legs out: balance off for a while, legs go limp, feet swept along `dirX` (+1 / -1). */
  /** Balance off for `ticks`, then the usual ramp back (glove, bomb, oil slide). */
  stun(tick: number, ticks: number, cause: string): void {
    this.trippedAt = tick;
    this.offTicks = ticks;
    this.stunnedUntil = tick + ticks;
    this.host.log.info('stun', { id: this.id, cause, ticks });
  }

  /**
   * L7: a melee hit on the body or head: the body staggers back 2-3 quick steps away from the hit (`dirX`), leaning
   * back, facing kept, then catches its balance (the stumble ends with a brake). Not when down, limp or in the air.
   */
  staggerBack(tick: number, dirX: number, cause: string): void {
    if (this.limp || this.down || !this.grounded) return;
    const dir = (Math.sign(dirX) || -this.facing) as -1 | 1;
    const S = MELEE.stagger;
    this.braking = false;
    this.stumble = { dir, until: tick + S.ticks, speed: S.speed * (this.standingLegs < 2 ? 0.5 : 1), lean: S.lean };
    this.host.log.info('stagger', { id: this.id, cause, dir, ticks: S.ticks });
  }

  trip(tick: number, cause: string, dirX: number): void {
    this.trippedAt = tick;
    this.offTicks = TRIP.offTicks;
    const dir = Math.sign(dirX) || this.facing;
    for (const foot of this.feet()) this.host.push(this.parts[foot], { x: dir * TRIP.sweepSpeed * this.parts[foot].mass(), y: 0 });
    this.host.push(this.parts.head, { x: -dir * TRIP.toppleSpeed * this.parts.head.mass(), y: 0 });
    this.host.log.info('trip', { id: this.id, cause, dir });
  }

  /** Called by the world before each physics step. */
  prePhysics(tick: number): void {
    this.updateDrag();
    // L4: on one leg (or none) the crouch key does nothing: a full crouch on one leg collapsed the body (L0 spike: 37%
    // upright). The one-leg and stump stances are slightly crouched by themselves.
    const c = this.standingLegs < 2 && this.controls.crouch ? { ...this.controls, crouch: false } : this.controls;
    if (c.crouch !== this.crouching) {
      this.crouching = c.crouch;
      this.host.log.info(c.crouch ? 'crouch_start' : 'crouch_end', { id: this.id, grounded: this.grounded });
    }
    this.updateRelaxedLimits();
    this.grounded = this.checkGround();
    if (this.grounded) this.lastGroundTick = tick;
    if (this.limp) {
      this.balance = 0;
      this.goLimp();
      return;
    }
    let want = this.facing;
    if (c.aim) {
      const cx = Math.cos(c.aim.angle);
      want = cx > 0.15 ? 1 : cx < -0.15 ? -1 : this.facing; // aiming nearly straight up/down keeps the current side
    } else if (c.move !== 0) {
      want = c.move; // not aiming: face where you walk
    }
    if (want !== this.facing) this.turn(want);
    this.balance = this.balanceAt(tick);
    this.updateStumble(tick, c);
    // L3: the arms are always up holding the gun (at the aim, or straight ahead), except when the world lowers them
    // (arms down, laughing) or a glove/bomb/oil slide has knocked them loose.
    this.gunAim = this.mods.armsDown || tick < this.stunnedUntil ? null : (c.aim ?? { angle: this.facing > 0 ? 0 : Math.PI });
    // L5: a melee swing drives the arms through its arc (facing stays: it's still decided by the aim above)
    if (this.mods.swing !== null && !this.mods.armsDown) this.gunAim = { angle: this.mods.swing };

    this.updateAimBlocked(this.gunAim);
    // A stumble walks the legs by itself (facing stays as it is: you stumble, you don't turn round).
    const s = this.stumble;
    this.driveWalk(tick, s ? { ...c, move: s.dir } : c, s ? (s.speed ?? STUMBLE.speed) / WALK.speed : 1);
    this.drivePose(c, tick);
    this.driveShoulder('shoulderFront', this.gunAim);
    this.driveShoulder('shoulderBack', this.gunAim);
    this.driveBalance(c);
    if (this.mods.headHeavy) this.host.push(this.parts.head, { x: 0, y: EFFECT_BODY.headExtraWeight * DT });
    this.flailPhase = (this.flailPhase + EFFECT_BODY.flailSpeed * DT) % (2 * Math.PI);
    // L7: swimming in the air (floating on a balloon): faster strokes while a key is held
    if (this.mods.floating && !this.grounded) {
      const hz = c.move !== 0 || c.jump || c.crouch ? SPECIAL.balloon.swimHz : SPECIAL.balloon.idleHz;
      this.swimPhase = (this.swimPhase + 2 * Math.PI * hz * DT) % (2 * Math.PI);
    }
    if (!this.gunAim) this.dragArms();
    this.handleJump(tick, c);
  }

  /**
   * Stumble: standing on the ground at full balance, and the torso tips past STUMBLE.tilt: walk a few quick steps
   * that way to get the feet back under the body. A shared reaction (heavy head, hard stops, landings).
   */
  private updateStumble(tick: number, c: Controls): void {
    // L7: a stagger whose back hits a wall or a step's face ends there (the legs used to keep walking into it for the
    // rest of the 0.7 s, running on the spot): once a few ticks in, pressed against something that way and not moving
    const st = this.stumble;
    if (st?.lean && tick >= st.until - MELEE.stagger.ticks + 6 && Math.sign(this.speedX()) !== st.dir && (this.pressedToward('torso', st.dir) || Math.abs(this.speedX()) < 0.3)) {
      this.host.log.info('stagger_bumped', { id: this.id, dir: st.dir, ticksLeft: st.until - tick });
      st.until = tick;
    }
    if (this.stumble && tick >= this.stumble.until) {
      this.stumble = null;
      this.lastStumbleEnd = tick;
      this.braking = true; // stop the extra steps smoothly
    }
    // Not while braking: a stop's own lean into the slide is controlled; only a real push makes you stumble.
    // Not while a walk is still on either (the tick you let go, the brake isn't registered yet).
    if (this.stumble || this.braking || this.walk || c.move !== 0 || c.crouch || !this.grounded || this.balance < 1 || tick - this.lastStumbleEnd < STUMBLE.cooldownTicks) return;
    // Rotation > 0 tips the top of the torso toward +x (y points down).
    // The tip is measured against the lean the body means to have.
    const tilt = wrapAngle(this.parts.torso.rotation() - this.leanTarget(c));
    const tipping = this.parts.torso.angvel() * Math.sign(tilt) > STUMBLE.tippingSpeed;
    if (Math.abs(tilt) < (this.mods.headHeavy ? STUMBLE.headTilt : STUMBLE.tilt) || !tipping) return;
    const dir = (tilt > 0 ? 1 : -1) as -1 | 1;
    this.stumble = { dir, until: tick + STUMBLE.ticks };
    this.host.log.info('stumble', { id: this.id, cause: 'tip', tilt: r2(tilt), dir, headHeavy: this.mods.headHeavy, vx: r2(this.speedX()) });
  }

  /** Called by the world after each physics step: state changes + problem checks. */
  postPhysics(tick: number): void {
    const torsoBody = this.parts.torso;
    const tilt = Math.abs(wrapAngle(torsoBody.rotation()));
    if (!this.down && tilt > FALL.downAngle) {
      this.down = true;
      this.downSince = tick;
      this.host.log.info('ragdoll_fall', { id: this.id, tilt: r2(tilt), tripped: this.balance < 1, p: rv(torsoBody.translation()) });
    } else if (this.down && tilt < FALL.upAngle) {
      this.down = false;
      this.host.log.info('ragdoll_up', { id: this.id, downTicks: tick - this.downSince });
    }
    this.tryingSince = this.down && this.balance >= 1 ? (this.tryingSince ?? tick) : null;

    const y = torsoBody.translation().y;
    const tv = torsoBody.linvel();
    this.stillAirTicks = !this.grounded && Math.hypot(tv.x, tv.y) < MOVE.unstickSpeed ? this.stillAirTicks + 1 : 0;
    if (!this.grounded) {
      const vy = torsoBody.linvel().y;
      if (!this.air) this.air = { since: tick, startY: y, peakY: y, fall: Math.max(0, vy), apexAt: vy >= 0 ? tick : null };
      else {
        this.air.peakY = Math.min(this.air.peakY, y);
        this.air.fall = Math.max(this.air.fall, vy);
        if (this.air.apexAt === null && vy >= 0) this.air.apexAt = tick;
      }
    } else if (this.air) {
      const airTicks = tick - this.air.since;
      // L7: the knees sink by how hard it landed, then spring back (see drivePose)
      const sink = Math.min(LEGS.sinkMax, this.air.fall * LEGS.sinkPerSpeed);
      if (airTicks > 5) this.landing = { at: tick, sink };
      if (airTicks > 5) this.host.log.info('land', { id: this.id, airTicks, rise: r3(this.air.startY - this.air.peakY), tilt: r2(tilt), fall: r2(this.air.fall), sink: r2(sink) });
      this.air = null;
    }

    for (const name of this.liveJoints()) this.checkJoint(tick, name);
    for (const name of PART_NAMES) {
      const v = this.parts[name].linvel();
      const before = this.lastVel.get(name);
      this.lastJolt.set(name, before ? dist(v, before) : 0);
      this.lastVel.set(name, v);
    }
  }

  /**
   * The biggest change of speed (m/s) in this step or the one before of any attached part outside `limb`: a hit or a
   * crash elsewhere on the body, if it's big. (The step before too: a dead body's back shin hit the pit floor and the
   * front knee was forced out one step later. The limb's own parts are left out: a joint limit catching its limb jolts
   * them by 6-8 m/s by itself, which would make every overshoot look like an impact.)
   */
  private impactSpeed(limb: Set<PartName>): number {
    let worst = 0;
    for (const name of PART_NAMES) {
      const before = this.lastVel.get(name);
      if (!before || this.lost.has(name) || limb.has(name)) continue;
      worst = Math.max(worst, dist(this.parts[name].linvel(), before), this.lastJolt.get(name) ?? 0);
    }
    return worst;
  }

  /**
   * Joint problem checks: past the limit (hard, or soft but lasting) and the two halves apart. A limb crushed against
   * something can be forced out for a moment (see LIMIT_CHECK.spikeTicks): that's followed as a spike and only warned
   * about if it lasts.
   */
  private checkJoint(tick: number, name: JointName): void {
    const spec = JOINTS[name];
    const over = this.limitOver(name) ?? -Infinity;
    const child = this.parts[spec.child];
    const onChild = add(child.translation(), rotate(sub(spec.at, PARTS[spec.child].center), child.rotation()));
    const gap = dist(this.jointPos(name), onChild);
    const who = `${this.id}:${name}`;
    const spike = this.spikes.get(name);
    if (spike) {
      spike.over = Math.max(spike.over, over);
      spike.gap = Math.max(spike.gap, gap);
      const ticks = tick - spike.since;
      if (over <= LIMIT_CHECK.softOver && gap <= LIMIT_CHECK.gap) {
        this.spikes.delete(name);
        this.host.log.info('joint_spike', { id: this.id, joint: name, peakOver: r2(spike.over), peakGap: r3(spike.gap), ticks, impact: spike.impact, touch: spike.touch });
      } else if (ticks >= LIMIT_CHECK.spikeTicks) {
        this.spikes.delete(name);
        const data = { ticks, peakOver: r2(spike.over), peakGap: r3(spike.gap), impact: spike.impact, ...this.situation(), ...this.contactInfo() };
        if (over > LIMIT_CHECK.softOver) this.host.anomaly('joint_over_limit', who, { angle: r2(this.jointAngle(name)), limits: this.limitsFor(name), over: r2(over), ...data });
        if (gap > LIMIT_CHECK.gap) this.host.anomaly('joint_stretched', who, { gap: r3(gap), ...data });
      }
      return;
    }
    const overTicks = over > LIMIT_CHECK.softOver ? (this.overTicks.get(name) ?? 0) + 1 : 0;
    this.overTicks.set(name, overTicks);
    // Rapier can report the two halves of a joint one tick apart on a hard landing; only a lasting gap is real.
    const gapTicks = gap > LIMIT_CHECK.gap ? (this.gapTicks.get(name) ?? 0) + 1 : 0;
    this.gapTicks.set(name, gapTicks);
    const hard = over > LIMIT_CHECK.hardOver;
    const stretched = gapTicks >= LIMIT_CHECK.gapTicks;
    if (hard || stretched) {
      const impact = this.impactSpeed(new Set(limbOf(name)));
      if (impact >= LIMIT_CHECK.impactSpeed || this.limbTouches(name)) {
        this.spikes.set(name, { since: tick, over, gap, touch: this.contactInfo().touch, impact: r2(impact) });
        return;
      }
    }
    if (hard || overTicks >= LIMIT_CHECK.softTicks) {
      this.host.anomaly('joint_over_limit', who, { angle: r2(this.jointAngle(name)), limits: this.limitsFor(name), over: r2(over), ticks: overTicks, ...this.situation(), ...this.contactInfo() });
    }
    if (stretched) this.host.anomaly('joint_stretched', who, { gap: r3(gap), ticks: gapTicks, ...this.contactInfo() });
  }

  /**
   * L6: is this part pressed against something fixed (a wall, a step's side) on its `dir` side (+1 right, -1 left)?
   * Read from the contact normals: the one from the part into the wall points mostly that way.
   */
  private pressedToward(part: PartName, dir: number): boolean {
    const { physics } = this.host;
    const c = this.colliders[part];
    let pressed = false;
    physics.contactPairsWith(c, (other) => {
      if (pressed || !other.parent()?.isFixed()) return;
      physics.contactPair(c, other, (m, flipped) => {
        if (m.numContacts() === 0) return;
        const n = m.normal(); // from the pair's first collider into the second
        if ((flipped ? -n.x : n.x) * dir > 0.7) pressed = true;
      });
    });
    return pressed;
  }

  /** Does the limb below a joint (its two parts and everything further out) touch anything outside the body? */
  private limbTouches(name: JointName): boolean {
    const { physics } = this.host;
    const parts = limbOf(name).filter((p) => !this.lost.has(p));
    let touching = false;
    for (const part of parts) {
      const c = this.colliders[part];
      physics.contactPairsWith(c, (other) => physics.contactPair(c, other, (m) => m.numContacts() > 0 && (touching = true)));
      if (touching) return true;
    }
    return false;
  }

  /** What the body is doing and being asked to do, attached to problem logs so they explain themselves. */
  situation(): Record<string, unknown> {
    const c = this.controls;
    return {
      ctl: { move: c.move, aim: c.aim ? r2(c.aim.angle) : null, crouch: c.crouch, jump: c.jump },
      facing: this.facing,
      vx: r2(this.speedX()),
      grounded: this.grounded,
      balance: r2(this.balance),
      limp: this.limp,
      armsUp: !!this.gunAim,
      aimBlocked: this.aimBlocked,
    };
  }

  /**
   * What the body is touching and how it's held, for problem logs about contact (a joint forced past its limit, a body
   * that can't get up): each touching part with the labels it touches, the torso's tilt and speed, the shoulder angles.
   */
  contactInfo(): Record<string, unknown> {
    const { physics } = this.host;
    const touch: Record<string, string[]> = {};
    for (const name of PART_NAMES) {
      if (this.lost.has(name)) continue;
      const c = this.colliders[name];
      const labels = new Set<string>();
      physics.contactPairsWith(c, (other) => physics.contactPair(c, other, (m) => m.numContacts() > 0 && labels.add(this.host.labelOf(other))));
      if (labels.size) touch[name] = [...labels];
    }
    const t = this.parts.torso;
    const sh = (n: JointName) => (this.cut.has(n) ? null : r2(this.jointAngle(n)));
    return { touch, tilt: r2(wrapAngle(t.rotation())), p: rv(t.translation()), v: rv(t.linvel()), shoulders: [sh('shoulderFront'), sh('shoulderBack')] };
  }

  snapshot(): Record<string, unknown> {
    const j: Record<string, number> = {};
    for (const name of this.liveJoints()) j[name] = r2(this.jointAngle(name));
    return {
      id: this.id,
      p: rv(this.parts.torso.translation()),
      a: r2(this.parts.torso.rotation()),
      head: rv(this.parts.head.translation()),
      grounded: this.grounded,
      facing: this.facing,
      balance: r2(this.balance),
      down: this.down,
      limp: this.limp,
      vx: r2(this.speedX()),
      gait: r2(this.gait),
      ctl: this.situation().ctl,
      j,
      ...(this.lost.size ? { lost: [...this.lost] } : {}),
    };
  }

  // ---- internals ----

  private limitsFor(name: JointName): [number, number] | null {
    const lim = JOINTS[name].limits;
    if (!lim) return null;
    return this.facing === 1 ? lim : [-lim[1], -lim[0]];
  }

  private turn(facing: 1 | -1): void {
    this.facing = facing;
    for (const name of this.liveJoints()) if (JOINTS[name].limits) this.relaxed.add(name);
    this.host.log.info('facing_flip', { id: this.id, facing });
  }

  /** After turning, each limit stays wide enough to include the current angle, then tightens once the motor brings the joint inside. */
  private updateRelaxedLimits(): void {
    for (const name of this.relaxed) {
      const [lo, hi] = this.limitsFor(name)!;
      const a = this.jointAngle(name);
      if (a >= lo && a <= hi) {
        this.joints[name].setLimits(lo, hi);
        this.relaxed.delete(name);
      } else {
        this.joints[name].setLimits(Math.min(lo, a), Math.max(hi, a));
      }
    }
  }

  private checkGround(): boolean {
    for (const name of this.feet()) {
      const foot = this.footPoint(name);
      if (this.host.raycast(add(foot, vec(0, -0.02)), add(foot, vec(0, MOVE.groundCheck)), this.id)) return true;
    }
    return false;
  }

  private balanceAt(tick: number): number {
    const t = tick - this.trippedAt;
    if (t < this.offTicks) return 0;
    if (t < this.offTicks + TRIP.rampTicks) return (t - this.offTicks) / TRIP.rampTicks;
    return 1;
  }

  /**
   * Walking: every part is pushed by the same speed change (so the body moves as one piece, not dragged
   * by the torso), and the legs step in a rhythm matched to the speed. Feet go slippery while walking so
   * planted-foot friction doesn't fight each step.
   */
  private driveWalk(tick: number, c: Controls, speedScale = 1): void {
    const vx = this.speedX();
    if (c.move !== 0) this.braking = false;
    // Funny legs: the wide stride bounds (both feet off the ground 25-45% of a run). A stop let go in such a bound used
    // to be cancelled at once (in the air), so the body glided on at full speed and stumbled (sim feel_report: 1.07 s /
    // 3.18 m). Now a stop let go in the air without a jump (a bound, a small drop) waits and brakes on landing, up to
    // WALK.brakeWaitTicks in the air (it brakes in the air too, at the air-control rate: waiting a whole bound to brake
    // left 2.4 m/s after 0.25 s, tests l2-movement / phase3 walking); a jump keeps its momentum as before.
    const jumpedThisAir = this.lastJumpTick >= this.lastGroundTick;
    const cancelInAir = !this.grounded && (jumpedThisAir || tick - this.lastGroundTick > WALK.brakeWaitTicks);
    if (this.braking && (Math.abs(vx) < 0.05 || cancelInAir || this.balance < 1)) this.braking = false;
    const scrambling = this.updateOilScramble(tick, c);
    // On a conveyor the floor itself moves: walking is relative to it, and standing still means riding along.
    const belt = this.grounded ? this.mods.beltSpeed : 0;
    if ((c.move !== 0 || this.braking || belt) && this.balance > 0 && !scrambling) {
      // two stumps: tiny steps; dragging a leg (L4): a limp
      const stumpy = (this.legsLeft === 0 ? LIMB.stumpsSpeed : this.dragging ? LIMB.dragSpeed : 1) * (this.mods.fast ? MELEE.runFactor : 1);
      // a heavy, floppy head can't sprint: at full L2 speed it pulled the runner over (sim/probe: falls at 4+ m/s)
      const wobbly = this.mods.headHeavy ? EFFECT_BODY.headRunFactor : 1;
      const target = c.move * WALK.speed * speedScale * stumpy * wobbly * (c.crouch ? WALK.crouchFactor : 1) + belt;
      const riding = belt && c.move === 0 && !this.braking;
      // pinned: walking only strains against the pin (L2: the stronger walk pulled a pinned knee 0.26 rad backward)
      const strain = (this.mods.pinned ? EFFECT_BODY.pinnedWalk : 1) * (this.mods.flinch ? HIT_REACTION.flinchControl : 1);
      const accel = (riding ? HAZARD.conveyor.accel : this.braking ? WALK.brake : WALK.accel) * (this.grounded ? 1 : WALK.airControl) * this.balance * strain;
      const dv = clamp(target - vx, -accel * DT, accel * DT);
      // In the air, pushing the torso into a wall it already presses against moves nothing; it only presses harder, and
      // friction then held the body up there (L6: pinned to a pit's side wall, a bot walking into it hung on for good
      // after the pin let go). So no push while the TORSO is against a wall that way. (Only the torso: a jump up a step
      // brushes its face with the shins, and that push is what carries the body over the edge; blocking it for any part
      // cut the running climb 2.0 -> 1.7 m.)
      const intoWall = !this.grounded && dv !== 0 && this.pressedToward('torso', Math.sign(dv));
      if (intoWall !== this.wallHeld) {
        this.wallHeld = intoWall;
        this.host.log.info(intoWall ? 'air_push_wall' : 'air_push_free', { id: this.id, dir: Math.sign(dv), y: r2(this.center().y) });
      }
      if (!intoWall) for (const b of this.attached()) this.host.push(b, { x: b.mass() * dv, y: 0 });
    }
    this.hop(tick, c, vx);
    // In the air the feet are slippery too: with grippy feet, holding a direction into a wall (a step's side) let the
    // body cling there by friction, hanging forever just under the top with no ground to jump from (L2: stronger air
    // control made it common).
    this.setSlipperyFeet(this.mods.oiled ? 'oil' : !this.grounded || c.move !== 0 || this.braking || belt ? 'walk' : 'grip');

    // Steps only while actually moving on the ground; fades to 0 so standing returns to identical leg targets.
    const want = this.grounded && c.move !== 0 ? clamp(Math.abs(vx) / WALK.fullStrideSpeed, 0, 1) : 0;
    this.gait += (want - this.gait) * 0.2;
    if (this.gait < 0.01) this.gait = 0;
    // Scrambling in oil: the legs spin like a cartoon while the body goes nowhere.
    const phaseSpeed = scrambling ? 4 * WALK.speed : Math.abs(vx);
    if (scrambling) this.gait = 1;
    this.gaitPhase = (this.gaitPhase + (phaseSpeed * DT * 2 * Math.PI) / WALK.strideLength) % (2 * Math.PI);

    if (c.move !== 0 && !this.walk) {
      this.walk = { dir: c.move, since: tick, startX: this.center().x };
      this.host.log.info('walk_start', { id: this.id, dir: c.move, crouch: c.crouch, });
    } else if (this.walk && c.move !== this.walk.dir) {
      if (c.move === 0) {
        this.braking = true;
        this.brakeDir = this.walk.dir;
        // A heavy head (arrow in it) and a stop from running: the head's momentum always throws you into stutter-steps.
        if (this.mods.headHeavy && !this.stumble && Math.abs(vx) >= STUMBLE.headStopSpeed) {
          this.stumble = { dir: this.walk.dir, until: tick + STUMBLE.ticks };
          this.host.log.info('stumble', { id: this.id, cause: 'head_stop', dir: this.walk.dir, vx: r2(vx) });
        }
      }
      this.host.log.info('walk_stop', { id: this.id, dist: r3(this.center().x - this.walk.startX), ticks: tick - this.walk.since, vx: r2(vx) });
      this.walk = c.move !== 0 ? { dir: c.move, since: tick, startX: this.center().x } : null;
      if (this.walk) this.host.log.info('walk_start', { id: this.id, dir: c.move, crouch: c.crouch, });
    }
  }

  /**
   * One leg left: moving along the ground is a series of hops (one per LIMB.hopStride m, so long strides at the same
   * speed). The speed itself comes from the walk push, as always; the hop only lifts the body.
   */
  private hop(tick: number, c: Controls, vx: number): void {
    if (this.standingLegs !== 1 || !this.grounded || c.move === 0 || this.balance < 1) return;
    const every = Math.round(LIMB.hopStride / Math.max(Math.abs(vx), 1) / DT);
    this.hopEvery = every;
    if (tick - this.lastHopTick < every) return;
    this.lastHopTick = tick;
    this.hops++;
    for (const b of this.attached()) this.host.push(b, { x: 0, y: -LIMB.hopSpeed * b.mass() });
  }

  private updateAimBlocked(aim: Aim | null): void {
    const hit = aim ? this.host.raycast(this.jointPos('shoulderFront'), this.launchPoint(aim), this.id) : null;
    const blocked = !!hit;
    if (blocked !== this.aimBlocked) {
      this.aimBlocked = blocked;
      this.host.log.info(blocked ? 'aim_blocked' : 'aim_clear', { id: this.id, ...(hit ? { by: hit.label } : {}) });
    }
  }

  /** Feet grip: normal, slippery while walking, or (oil) almost none. */
  private setSlipperyFeet(mode: 'grip' | 'walk' | 'oil'): void {
    if (mode === this.slipperyFeet) return;
    this.slipperyFeet = mode;
    for (const foot of this.feet()) {
      const c = this.colliders[foot];
      c.setFriction(mode === 'oil' ? SPECIAL.oil.friction : mode === 'walk' ? WALK.walkFriction : RAGDOLL.friction);
      // Rapier averages the two surfaces' friction by default; "Min" makes slippery feet really slippery.
      c.setFrictionCombineRule(mode === 'grip' ? RAPIER.CoefficientCombineRule.Average : RAPIER.CoefficientCombineRule.Min);
    }
  }

  /**
   * Oil + trying to walk: the legs scramble in place for a moment (no grip, no progress), then the body shoots
   * forward and slides on its belly (balance off). Returns true while scrambling.
   */
  private updateOilScramble(tick: number, c: Controls): boolean {
    const o = SPECIAL.oil;
    if (this.oilScramble) {
      if (tick < this.oilScramble.until) return true;
      const dir = this.oilScramble.dir;
      this.oilScramble = null;
      for (const b of this.attached()) this.host.push(b, { x: dir * o.slideSpeed * b.mass(), y: -0.5 * b.mass() });
      // the head goes first: tip forward onto the belly
      this.host.push(this.parts.head, { x: dir * 3 * this.parts.head.mass(), y: 0 });
      for (const foot of this.feet()) this.host.push(this.parts[foot], { x: -dir * 3 * this.parts[foot].mass(), y: 0 });
      this.stun(tick, o.slideStunTicks, 'oil_slide');
      this.slippedAt = tick;
      this.host.log.info('oil_slide', { id: this.id, dir, speed: o.slideSpeed });
      return false;
    }
    if (this.mods.oiled && c.move !== 0 && this.grounded && this.balance >= 1) {
      this.oilScramble = { dir: c.move, until: tick + o.scrambleTicks };
      this.host.log.info('oil_scramble', { id: this.id, dir: c.move });
      return true;
    }
    return false;
  }

  /** Dead: motors only damp the joints a little (like stiff cloth), no balance, no moves. */
  private goLimp(): void {
    for (const name of this.liveJoints()) {
      if (JOINTS[name].limits) this.joints[name].configureMotorPosition(0, 0, 2);
      else this.joints[name].configureMotorVelocity(0, 2);
    }
  }

  private drivePose(c: Controls, tick: number): void {
    // L6: while down (fallen), the legs tuck in: the body gets short enough to rise even when it lies wedged between
    // two walls. Straight legs made it a strut there: the unlimited hip motors pressed the head into one wall and the
    // feet into the other with ~1500 N, and friction held it down for good (sim `pocket`).
    const pose = c.crouch || this.down ? POSES.crouch : POSES.stand;
    const legStrength = Math.max(MOTOR.minLegStrength, this.balance);
    const drag = this.dragging;
    // Stepping: legs swing in opposite directions, and each knee lifts during its half of the cycle.
    // Big Scissor: only while running on purpose (the run key held, not braking), blended in and out over
    // WALK.scissorBlend s. Kept on through a stop, the wide swing tripped the body (stop 0.17 s / 0.4 m -> 1.07 s /
    // 3.18 m and a stumble, sim feel_report).
    // (let go = fade out at once, even in the air; holding run in the air keeps it as it was)
    const scissorOn = c.move === 0 || this.braking ? 0 : this.grounded ? 1 : this.scissor;
    this.scissor += Math.sign(scissorOn - this.scissor) * Math.min(Math.abs(scissorOn - this.scissor), DT / WALK.scissorBlend);
    const swing = this.gait * (WALK.hipSwing + WALK.scissorSwing * this.scissor) * Math.sin(this.gaitPhase);
    const lift = this.gait * WALK.kneeLift;
    // the leg that's far behind bends its knee, so its heel flicks up (front leg behind: sin < 0)
    const flick = (behind: number) => (this.scissor * this.gait * WALK.heelFlick * Math.max(0, behind - WALK.heelFlickFrom)) / (1 - WALK.heelFlickFrom);
    // Standing in oil: the legs slowly slide apart into a split (the one place the legs get different targets on
    // purpose: the split is the joke), until the body collapses.
    const splitting = this.mods.oiled && this.grounded && c.move === 0 && !this.oilScramble;
    this.oilSplit = splitting ? Math.min(SPECIAL.oil.splitMax, this.oilSplit + SPECIAL.oil.splitSpeed * DT) : Math.max(0, this.oilSplit - 2 * DT);
    const step: Partial<Record<PoseJoint, number>> = {
      hipFront: -swing - this.oilSplit,
      hipBack: swing + this.oilSplit,
      kneeFront: lift * Math.max(0, Math.cos(this.gaitPhase)) + flick(-Math.sin(this.gaitPhase)),
      kneeBack: lift * Math.max(0, -Math.cos(this.gaitPhase)) + flick(Math.sin(this.gaitPhase)),
    };
    // L7 swimming in the air (a balloon on the torso, off the ground): the legs run in big strides, knees bending as
    // each comes forward, like running on air
    if (this.mods.floating && !this.grounded) {
      const ph = this.swimPhase;
      step.hipFront = -0.75 * Math.sin(ph) - pose.hipFront;
      step.hipBack = 0.75 * Math.sin(ph) - pose.hipBack;
      step.kneeFront = 0.5 + 0.6 * Math.max(0, Math.cos(ph)) - pose.kneeFront;
      step.kneeBack = 0.5 + 0.6 * Math.max(0, -Math.cos(ph)) - pose.kneeBack;
    }
    // L7 springy legs (two whole legs, not crouched / down / oiled / tied to a balloon): a loose swing leg while running,
    // a tuck then dangling legs in the air, knees that sink on landing and spring back. `share` scales a leg's strength.
    const share = { Front: 1, Back: 1 };
    // (not with a heavy, floppy head: loose legs under it fell over, sim head_sway)
    const springy = this.standingLegs === 2 && !drag && !this.down && !c.crouch && !splitting && !this.oilScramble && !this.mods.floatLeg && !this.mods.headHeavy && !this.mods.floating;
    if (springy && !this.grounded && this.air) {
      // falling slowly (around the top of a jump) the legs open into the splits; falling faster, they reach down under the body
      // to catch it (landing on still-dangling, bent legs took ~1 s to straighten under the body's weight)
      const vy = this.parts.torso.linvel().y;
      const falling = vy > LEGS.reachFall;
      if (vy < 0) {
        // rising: the legs as they are (jumps climb and cross gaps exactly as before: tucking or dangling on the way
        // up cut the standing climb 1.4 -> 1.3 m, which the arenas' reach check relies on)
      } else if (!falling && this.air.apexAt !== null && tick - this.air.apexAt < LEGS.dangleTicks && (this.lastJumpTick >= this.air.since - LEGS.splitAfterJumpTicks || (c.move !== 0 && this.scissor > 0.5))) {
        // (only after a jump (a coyote one too) or in a running bound (the run key held): those leaps are the joke. A
        // body just dropped keeps its legs as they are: the splits there put a foot on the ledge beside a slot it was
        // dropping into, test l7-unstuck)
        // (only just after the top: a body stuck against a step's face, neither rising nor falling, kept its legs
        // dangling and could never stand again: sim step_climb)
        // Split Leap: the front leg forward, the back leg back (in the air the legs aren't a closed loop through the
        // ground, so different targets per leg are fine here)
        const sp = LEGS.split;
        step.hipFront = -sp.hip - pose.hipFront;
        step.hipBack = sp.hip - pose.hipBack;
        step.kneeFront = sp.knee - pose.kneeFront;
        step.kneeBack = sp.knee - pose.kneeBack;
        share.Front = share.Back = sp.share;
      } else if (falling) share.Front = share.Back = LEGS.reachShare;
    } else if (springy && this.grounded) {
      // the lifting (swing) leg is loose while running: it lags and overshoots (only while the run key is held: loose
      // while braking, the body kept rocking after a stop)
      if (this.gait > 0.3 && c.move !== 0 && !this.braking) {
        if (Math.cos(this.gaitPhase) > 0) share.Front = LEGS.swingShare;
        else share.Back = LEGS.swingShare;
      }
      // landing: knees sink by the landing speed, then spring back (the hips fold half as much: the body drops straight)
      const since = this.landing ? tick - this.landing.at : Infinity;
      if (this.landing && since < LEGS.landTicks) {
        const k = this.landing.sink * (1 - since / LEGS.landTicks);
        step.kneeFront = (step.kneeFront ?? 0) + k;
        step.kneeBack = (step.kneeBack ?? 0) + k;
        step.hipFront = (step.hipFront ?? 0) - k / 2;
        step.hipBack = (step.hipBack ?? 0) - k / 2;
        share.Front = share.Back = LEGS.landShare; // (both legs catch the landing: no loose swing leg now)
      }
    }
    if (this.standingLegs === 1) {
      // Hopping on the one good leg: it points straight down in the world (not along the torso), so the foot is always
      // under the body's weight. With two legs a lean is caught by stepping; one leg can't step, and planted behind a
      // forward-leaning torso it stayed there (stuck leaning 0.27 rad, creeping backward). No stepping swing; the knee
      // tucks in the air.
      const good: Side = this.stumps.has('front') || drag === 'front' ? 'back' : 'front';
      const hip = good === 'front' ? 'hipFront' : 'hipBack';
      const knee = good === 'front' ? 'kneeFront' : 'kneeBack';
      // Slightly crouched on it (the one leg carries all the weight): knee bent by k, thigh forward by k/2, so the foot
      // stays under the hip.
      const k = LIMB.oneLegKnee;
      step[hip] = -k / 2 - this.parts.torso.rotation() * this.facing - pose[hip];
      step[knee] = k - pose[knee] + (this.grounded ? 0 : 0.6 * this.gait);
      // L7 limping on a dragged leg: the good knee dips deeper between hops (deepest midway), up again for the push
      if (drag && this.grounded && this.gait > 0.3 && this.hopEvery > 0) {
        const t = Math.min(1, (tick - this.lastHopTick) / this.hopEvery);
        const dip = LIMB.hopDip * Math.sin(Math.PI * t);
        step[knee] = (step[knee] ?? 0) + dip;
        step[hip] = (step[hip] ?? 0) - dip / 2;
      }
      // The stump is held up and forward, out of the way: left hanging, it props the body up like a third leg once it
      // sinks a little (mid-walk loss: stuck leaning forward on stump + bent knee, head 0.3 m low).
      const otherHip = good === 'front' ? 'hipBack' : 'hipFront';
      const otherKnee = good === 'front' ? 'kneeBack' : 'kneeFront';
      if (drag) {
        // L4 dragging limp: the hurt leg hangs back, knee bent, barely held (see the strength below): pulled along
        step[otherHip] = LIMB.dragHip - pose[otherHip];
        step[otherKnee] = LIMB.dragKnee - pose[otherKnee];
      } else step[otherHip] = LIMB.stumpLift - pose[otherHip];
    }
    for (const name of Object.keys(pose) as PoseJoint[]) {
      if (this.cut.has(name)) continue;
      let target = pose[name] + (step[name] ?? 0);
      const gun = this.gunAim;
      if (gun && name === 'elbowFront') target = -0.02; // gun arm straight
      if (gun && name === 'elbowBack') target = -GUN.pumpElbow; // the back hand holds the pump/bolt
      const m = MOTOR_OF[name];
      const isLeg = name.startsWith('hip') || name.startsWith('knee');
      // L4: a dragging leg is barely held: it hangs and is pulled along.
      const weakLeg = drag && isLeg && name.endsWith(drag === 'front' ? 'Front' : 'Back') ? LIMB.dragStrength : 1;
      // (a leg strong enough to stand on needs thousands of N·m to bend; a balloon gives ~100, so that leg goes slack)
      const floatLeg = this.mods.floatLeg;
      const slackLeg = floatLeg && isLeg && name.endsWith(floatLeg === 'front' ? 'Front' : 'Back') ? MOTOR.minLegStrength : 1;
      const floppyNeck = name === 'neck' && this.mods.headHeavy ? EFFECT_BODY.headNeckStrength : 1;
      // Spaghetti arms: elbows only hold while the arms are up.
      const brokenArm = (name === 'elbowFront' && this.mods.limpArms.includes('front')) || (name === 'elbowBack' && this.mods.limpArms.includes('back'));
      const limpElbow = name.startsWith('elbow') && (!gun || brokenArm) ? MOTOR.armLimp.elbowStrength : 1;
      const springShare = isLeg ? share[name.endsWith('Front') ? 'Front' : 'Back'] : 1;
      const strength = (isLeg ? legStrength * weakLeg * slackLeg * springShare : 1) * floppyNeck * limpElbow;
      this.joints[name].configureMotorPosition(target * this.facing, m.stiffness * strength, m.damping * strength);
    }
  }

  /**
   * Shoulders turn all the way round, so a position motor (which wraps at ±PI) can't drive them.
   * Instead: work out the short-way angle error ourselves and ask for a matching spin speed.
   */
  private driveShoulder(name: 'shoulderFront' | 'shoulderBack', aim: Aim | null): void {
    const arm = this.parts[JOINTS[name].child];
    if (this.mods.swingSettle && name === 'shoulderFront') {
      this.joints[name].configureMotorVelocity(0, MOTOR.swingSettleFactor);
      return;
    }
    if (this.mods.limpArms.includes(name === 'shoulderFront' ? 'front' : 'back')) {
      // L5: broken by a melee hit: it hangs loose (the motor only damps a little, like a spaghetti arm)
      this.joints[name].configureMotorVelocity(0, MOTOR.armLimp.shoulderFactor);
      return;
    }
    // Aiming into something within arm's reach (a wall you lean on): the gun arm lowers instead of pressing into it.
    // Pressing (even gently) made the wall bend the elbows 0.3-0.65 rad past their limits in the netsim.
    // The shot still works: it hits what's in the way (see traceShot).
    const raise = aim && !this.aimBlocked ? aim : null;
    if (this.controls.taunt && this.grounded && !this.controls.move && !this.limp) {
      // Taunt: both arms pump up and down (opposite each other), a little dance.
      const wave = Math.sin(this.flailPhase * 1.5) * (name === 'shoulderFront' ? 1 : -1);
      const want = this.parts.torso.rotation() + Math.PI * (0.75 + 0.2 * wave) * this.facing;
      const err = wrapAngle(want - arm.rotation());
      this.joints[name].configureMotorVelocity(clamp(MOTOR.shoulderAim.gain * err, -MOTOR.shoulderAim.maxSpeed, MOTOR.shoulderAim.maxSpeed), MOTOR.shoulderIdle.factor);
      return;
    }
    // L7 swimming in the air: the back arm paddles round (the gun arm keeps aiming)
    if (this.mods.floating && !this.grounded && name === 'shoulderBack') {
      const hz = this.controls.move !== 0 || this.controls.jump || this.controls.crouch ? SPECIAL.balloon.swimHz : SPECIAL.balloon.idleHz;
      this.joints[name].configureMotorVelocity(-2 * Math.PI * hz * this.facing, MOTOR.shoulderIdle.factor);
      return;
    }
    // Hit in an arm: the back arm windmills while walking (the gun arm keeps aiming, with the swing); laughing: both.
    const flail = (this.mods.armFlail && this.gait > 0.2 && (name === 'shoulderBack' || !raise)) || this.mods.laughing;
    if (flail) {
      // (velocity motor, gentle force: arms flop, not fight)
      this.joints[name].configureMotorVelocity(EFFECT_BODY.flailSpeed * this.facing * (name === 'shoulderFront' ? 1 : -1), MOTOR.shoulderIdle.factor);
      return;
    }
    if (!raise) {
      // Spaghetti arms: arms down / stunned / dead, they just flop (the motor only damps a little, like air).
      this.joints[name].configureMotorVelocity(0, MOTOR.armLimp.shoulderFactor);
      return;
    }
    // An arm hanging straight down has rotation 0, so pointing along angle θ needs rotation θ - PI/2.
    const err = wrapAngle(raise.angle - Math.PI / 2 - arm.rotation());
    const m = this.mods.swing !== null ? MOTOR.shoulderSwing : MOTOR.shoulderAim;
    this.joints[name].configureMotorVelocity(clamp(m.gain * err, -m.maxSpeed, m.maxSpeed), m.factor);
  }

  private driveBalance(c: Controls): void {
    if (this.balance <= 0) return;
    const t = this.parts.torso;
    const err = wrapAngle(t.rotation() - this.leanTarget(c));
    const torque = clamp(-(BALANCE.kp * err + BALANCE.kd * t.angvel()), -BALANCE.maxTorque, BALANCE.maxTorque);
    const heavyHead = this.mods.headHeavy ? EFFECT_BODY.headBalanceShare : 1;
    this.host.twist(t, torque * this.balance * heavyHead * DT);
    const f = BALANCE.stretchForce * this.balance * DT;
    this.host.push(this.parts.head, { x: 0, y: -f });
    const feet = this.feet();
    for (const foot of feet) this.host.push(this.parts[foot], { x: 0, y: f / feet.length });
  }

  /** Jump key let go soon after a jump while still going up: keep only part of the upward speed (a short hop). */
  private cutJumpIfLetGo(tick: number, c: Controls): void {
    if (c.jump || this.jumpCut || tick <= this.lastJumpTick || tick - this.lastJumpTick > MOVE.cutTicks) return;
    this.jumpCut = true;
    const vy = this.parts.torso.linvel().y;
    if (vy >= 0) return; // already falling: nothing to cut
    for (const b of this.attached()) {
      const up = Math.min(0, b.linvel().y);
      this.host.push(b, { x: 0, y: -up * (1 - MOVE.cutKeep) * b.mass() });
    }
    this.host.log.info('jump_cut', { id: this.id, afterTicks: tick - this.lastJumpTick, vy: r2(vy) });
  }

  /**
   * Jumps (L2): a press is remembered for MOVE.bufferTicks (pressed just before landing, it jumps on landing), works
   * for MOVE.coyoteTicks after walking off an edge, and letting go early while still rising cuts the jump short
   * (tap = hop, hold = full jump).
   */
  private handleJump(tick: number, c: Controls): void {
    const pressed = c.jump && !this.jumpHeld;
    this.jumpHeld = c.jump;
    this.cutJumpIfLetGo(tick, c);
    if (pressed) this.jumpPressedAt = tick;
    // a press not used yet and still fresh
    if (this.jumpPressedAt <= this.lastJumpTick || tick - this.jumpPressedAt > MOVE.bufferTicks) return;
    const coyote = !this.grounded && tick - this.lastGroundTick <= MOVE.coyoteTicks && this.lastGroundTick > this.lastJumpTick;
    // L7: hung still in the air on something (the torso caught on a ledge's corner, the feet in the air) for
    // MOVE.unstickTicks: that's resting on it, so it can jump off. Only the feet count as ground, so a body hung on a
    // corner could never jump again (sim arena_fights: bots stuck on Windy Rooftop's water tower corner).
    const hung = !this.grounded && this.stillAirTicks >= MOVE.unstickTicks && !this.mods.floating;
    if (hung && pressed) this.host.log.info('jump_unstuck', { id: this.id, stillTicks: this.stillAirTicks, at: rv(this.center()) });
    if (!this.grounded && !coyote && !hung) {
      if (pressed) this.host.log.info('jump_blocked', { id: this.id, reason: 'in_air', buffered: true });
      return; // stays buffered for a few ticks, in case the feet land
    }
    if (tick - this.lastJumpTick < MOVE.jumpCooldownTicks) {
      if (pressed) this.host.log.info('jump_blocked', { id: this.id, reason: 'cooldown' });
      return;
    }
    // (L7: jumps are free: stamina is for weapons only)
    this.lastJumpTick = tick;
    this.jumpCut = false;
    const jumpSpeed = MOVE.jumpSpeed * (this.legsLeft === 0 ? LIMB.stumpsJump : 1);
    // Every part leaves at exactly the jump speed: falling speed is cancelled (a buffered jump fires on the landing tick,
    // a coyote jump while dropping) and so is rising speed (funny legs: a running bound already moving up added to the
    // jump: running jumps rose 2.6 m and climbed 2.2 m instead of 1.8, by luck of the stride; sim walk_jump / jump_reach)
    for (const b of this.attached()) this.host.push(b, { x: 0, y: -(jumpSpeed + b.linvel().y) * b.mass() });
    this.host.log.info('jump', {
      id: this.id,
      crouching: c.crouch,
      ...(coyote ? { coyote: tick - this.lastGroundTick } : {}),
      ...(tick > this.jumpPressedAt ? { buffered: tick - this.jumpPressedAt } : {}),
      ...(this.legsLeft < 2 ? { legsLeft: this.legsLeft } : {}),
    });
  }
}
