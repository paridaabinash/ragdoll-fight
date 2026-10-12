// All physics uses meters, seconds and radians. y points DOWN (same as the screen),
// so a world position times PX_PER_M is directly a screen position.

export const PHYSICS_HZ = 60;
/** Real time per tick (s): the server and the screens run PHYSICS_HZ ticks a second, whatever the game speed. */
export const TICK_SECONDS = 1 / PHYSICS_HZ;
/**
 * L7 game-speed dial: how fast the game world runs against real time (1 = normal, 0.85 = everything that moves is 15%
 * slower: running, jumps, bullets, falling bodies, hazards). Timers counted in ticks or real seconds (reload, respawn,
 * stamina refill, chaos rounds) stay in real time. Set once at start by `setGameSpeed` (server: env GAME_SPEED; online
 * clients: from the welcome, so previews stay exact; offline: ?speed=).
 */
export let GAME_SPEED = 1;
export const GAME_SPEED_RANGE = [0.5, 1.5] as const;
/**
 * Game time per tick (s): what physics, bullets and pushes step by (TICK_SECONDS × GAME_SPEED). A live binding: every
 * use reads it when it runs, so `setGameSpeed` reaches all of them. Loops that pace real time use TICK_SECONDS.
 */
export let DT = TICK_SECONDS;

/** Sets the game speed (L7); false (and nothing changes) if it's not a number within GAME_SPEED_RANGE. */
export function setGameSpeed(speed: number): boolean {
  if (!Number.isFinite(speed) || speed < GAME_SPEED_RANGE[0] || speed > GAME_SPEED_RANGE[1]) return false;
  GAME_SPEED = speed;
  DT = TICK_SECONDS * speed;
  return true;
}
/** m/s². Stronger than real gravity so arcs feel snappy. */
export const GRAVITY_Y = 20;
export const PX_PER_M = 40;
/**
 * Physics solver passes per step. Ragdoll bones are held by rigid multibody joints, so few passes are needed.
 * Measured (npm run sim): 4+1 lets a standing ragdoll creep 0.12 m in 30 s; 4+2 holds it (0.005 m).
 * The internal passes (the multibody's own solver) are what make the joint LIMITS hold. Bot fights over many seeds
 * (sim `limits`; 20 fights x 1 min x 4 players): 4+2 let knees and elbows sit 0.3-1 rad past their limits for
 * seconds, even on dead bodies under plain gravity (24 warnings); 8+2 still 16; 4+4 with MOTOR.shoulderMaxTorque 1
 * (a dead body's knee); 4+5 with the cap 0, worst overshoot 0.16 rad. Cost: 0.15 -> 0.17 ms per ragdoll per step.
 */
export const SOLVER_ITERATIONS = 4;
export const SOLVER_INTERNAL_ITERATIONS = 5;

/**
 * Arenas are data files (`arenas/`), so their size isn't a constant. A world built without an arena
 * (some tests and sim scenarios) uses this size: the original 32 x 18 m test range.
 */
export const DEFAULT_BOUNDS = { width: 32, height: 18 } as const;
/** Arenas with a narrow size use it below this many players (picked when the arena is built). */
export const ARENA_SIZE = { fullFromPlayers: 5 } as const;
/** How far outside the arena an arrow may travel before it is deleted. Generous above, so high lobs come back down. */
export const ARENA_MARGIN = { side: 4, top: 30, bottom: 4 } as const;

/**
 * L3: the projectile (a bullet; still called "arrow" in the code from the bow days). Not a physics body: it moves with
 * `stepArrow` and hits things by ray test. It vanishes where it hits (only a sticky bomb and a plunger with a rope stay).
 */
export const ARROW = {
  mass: 0.1, // kg, used only for the push it gives on hit
  length: 0.8, // m, visual only (the tracer)
  maxFlightTicks: 600, // 10 s
} as const;

/**
 * L3: the gun. It points at the mouse pointer (distance doesn't matter); every bullet leaves at the same speed and
 * drops with gravity. After each shot a pump/bolt reload; each shot costs stamina. All *(start)* values.
 */
/**
 * L7 aim point (client input): the mouse moves a point attached to your shoulder; the gun points at it.
 * `maxDistance` (m): how far it can go (the view is ~36 x 20 m, so it always stays on screen). `start` (m): where it
 * starts, ahead of you. `sensitivity`: 1 = the point moves as far in the world as a normal cursor would.
 * `dotRadius` (m) and `dotAlpha`: the faint dot drawn there.
 */
export const AIM_POINT = {
  maxDistance: 5,
  start: 3,
  sensitivity: 1,
  dotRadius: 0.1,
  dotAlpha: 0.45,
} as const;

export const GUN = {
  /** m/s, every shot (the bow's full draw; 0.53 m per tick, more than thin walls are thick). */
  bulletSpeed: 32,
  /** Ticks after a shot before the next one (pump/bolt). 42 = 0.7 s. */
  reloadTicks: 42,
  /** Stamina per shot (of STAMINA.max): about 8 shots in a row, then the arms drop. */
  staminaPerShot: 12,
  /**
   * Online, a shot that reaches the server up to this many ticks before its reload is done is kept and fired on the
   * reload tick (network jitter can bunch two messages sent 0.7 s apart); earlier ones are refused (`fire_too_soon`).
   */
  earlyGraceTicks: 6,
  /** The aim preview shows this much of the flight (ticks): 0.5 s, exact. You judge the drop after that. */
  previewTicks: 30,
  /** The back hand holds the pump/bolt: its elbow bend (rad) while the arms are up. */
  pumpElbow: 0.9,
} as const;

/**
 * Ragdoll body. Sizes are HALF sizes (hx = half width, hy = half height), in meters.
 * Rest pose stands straight up; the feet are at the spawn point. Total height 2.2 m.
 */
export const RAGDOLL = {
  density: 8, // kg/m², gives a ~8 kg body
  friction: 1.2,
  /** S4: hitbox 15% bigger than the original 0.2 m (the drawn cartoon head is bigger still: see the client skin). */
  head: { r: 0.23 },
  /** S4 "clown boots": the lower legs are this many times denser (weight low down, drawn as big boots). */
  bootDensity: 2.5,
  torso: { hx: 0.2, hy: 0.4 },
  upperArm: { hx: 0.07, hy: 0.2 },
  lowerArm: { hx: 0.06, hy: 0.2 },
  upperLeg: { hx: 0.09, hy: 0.25 },
  lowerLeg: { hx: 0.08, hy: 0.25 },
  /** Shoulder joint sits this far below the top of the torso. */
  shoulderDrop: 0.08,
  /**
   * Do different players' bodies bump into each other? Off: players pass through each other (arrows still hit,
   * they use ray tests). On, walking players collided at ~5 m/s, bounced apart and bent elbows past their limits.
   */
  playersCollide: false,
  /**
   * L6 soft CCD (m): Rapier looks this far ahead for contacts of a fast-moving part. Without it, a body thrown up by a
   * trampoline and a jump (26-28 m/s, ~0.46 m per step) sank its head and forearm into a 0.4 m perch's underside and
   * hung there, wedged, for good (bots seed 36). Plain CCD does nothing for multibody links. Measured (120 launches into
   * perch_r at 22-30 m/s): off -> 10 parts inside the perch, 1 body hung; 0.3 or 0.6 -> 0 and 0.
   */
  softCcd: 0.3,
} as const;

/** How the ragdoll holds itself up. Tuned with `npm run sim`. */
export const BALANCE = {
  /**
   * Upright torque on the torso: kp × angle error (rad) + kd × spin speed (rad/s), in N·m.
   * L3: was 260, tuned with arms hanging. The gun holds both arms out front all the time now, and at the L2 run speed
   * the lean then ran away: 0.27 rad while running, and a stop slid 1.2 m into a stumble (the old bow did it too, held
   * drawn: 0.2). Measured (tools probe, run 5.5 m/s then stop): 350 -> lean 0.13, slide 0.19 m; 450 -> 0.11 / 0.17 m;
   * 600 -> 0.09 / 0.16 m (arms hanging at 260: 0.08 / 0.09 m). Picked 400.
   */
  kp: 400,
  kd: 18,
  maxTorque: 320,
  /** Head pulled up, feet pulled down, by this force (N). Equal and opposite, so the body never floats. */
  stretchForce: 70,
  /** Forward lean of the torso while crouching (rad). */
  crouchLean: 0.3,
} as const;

/** Joint motors: stiffness pulls toward the target angle, damping stops wobble. */
// Damping ≈ 2 × sqrt(stiffness) settles without wobble. Weaker leg motors can't lift the body out of a crouch.
export const MOTOR = {
  leg: { stiffness: 8000, damping: 180 },
  neck: { stiffness: 3000, damping: 110 },
  elbow: { stiffness: 3000, damping: 110 },
  /** Shoulders: velocity motor. Target spin = gain × angle error, capped at maxSpeed; factor = how hard it pushes. */
  shoulderAim: { gain: 20, maxSpeed: 20, factor: 800 },
  /** L7: a melee swing drives the shoulders harder and faster (at shoulderAim the arm lagged 2.5 rad behind the swing). */
  shoulderSwing: { gain: 35, maxSpeed: 32, factor: 800 },
  /** L7: after a swing the weapon arm is let go but damped this much, so the weapon swings on and settles (limp: it looped right round). */
  swingSettleFactor: 120,
  shoulderIdle: { gain: 5, maxSpeed: 6, factor: 200 },
  /**
   * Most torque a shoulder motor may use (N·m). Holding the arm out takes ~6, a fast swing ~30. Without a cap the
   * velocity motor is effectively unlimited: an arm caught on a step while swinging up to aim bent the elbows
   * up to 1.1 rad past their limit and shoved the body back at 5 m/s.
   */
  shoulderMaxTorque: 40,
  /** Leg motors never drop below this share of full strength (even while tripped). */
  minLegStrength: 0.05,
  /**
   * S4 spaghetti arms: when not drawing, the shoulders only damp (velocity 0 at this small factor) and the elbows keep
   * this share of their strength, so the arms flop around instead of being held.
   */
  armLimp: { shoulderFactor: 15, elbowStrength: 0.03 },
  /**
   * Air drag on loose arms (N per m/s, per arm part): they trail behind when running and flap on jumps and landings.
   * Measured (sim body_report): 0 -> arms swing 0.16 rad while walking, 1.5 -> 0.51, 3 -> 0.88 but slows the walk to 2.89 m/s.
   */
  armDrag: 1.5,
} as const;

export const MOVE = {
  /**
   * L7: off the ground but hung still (torso slower than `unstickSpeed` m/s) for `unstickTicks`: resting on something
   * (a ledge's corner under the torso, the feet in the air), so a jump is allowed. Only the feet count as ground.
   */
  unstickTicks: 20,
  unstickSpeed: 0.3,
  /** Upward speed added to every body part on jump (m/s). 2026-10-11: 7.5 -> 8 (the user: a little more jump power). */
  jumpSpeed: 8,
  jumpCooldownTicks: 20,
  /**
   * 2026-10-11: for this many ticks after a jump the feet still brush the floor (within `groundCheck`) on the way up.
   * That ground doesn't start a new "time on the ground": it made a running jump look like a stride bound, and letting
   * go of the run key then braked it hard in mid-air (6 -> 0.8 m/s in 0.2 s, some run-ups only).
   */
  liftoffTicks: 4,
  /**
   * L2 jump feel. Coyote time: a jump still works this many ticks after the feet left the ground (walking off an
   * edge). Buffer: a jump pressed this many ticks before landing happens on landing. Tap-or-hold: letting go of jump
   * within `cutTicks` of the jump, while still rising, keeps only `cutKeep` of the upward speed (a short hop).
   */
  coyoteTicks: 6,
  bufferTicks: 6,
  cutTicks: 12,
  cutKeep: 0.45,
  /** A foot counts as on the ground if something is within this distance below it (m). */
  groundCheck: 0.1,
} as const;

export const TRIP = {
  /** Balance fully off for this long after a leg hit, then ramps back. */
  offTicks: 48, // 0.8 s
  /**
   * S4: was 36. The heavier cartoon body (boots, bigger head, loose arms) couldn't stand during a 36-tick ramp and
   * waited for full balance: get-up 87 ticks after falling instead of ~60. 16 -> 68 (sim body_report).
   */
  rampTicks: 16,
  /**
   * Knockdown: feet swept along the arrow's direction, head pushed the other way (m/s of speed change).
   * Two opposite pushes turn the body over without moving it as a whole, so every leg hit really trips.
   */
  sweepSpeed: 4,
  toppleSpeed: 3,
} as const;

/** Joint limits are slightly soft, so a hard impact can push past them briefly. Only these count as a problem. */
export const LIMIT_CHECK = {
  /** Past the limit by more than this (rad) at any moment. */
  hardOver: 0.5,
  /** Or past by more than `softOver` for at least `softTicks` ticks in a row. */
  softOver: 0.15,
  softTicks: 15,
  /** Joint halves further apart than this (m) for `gapTicks` ticks in a row = the body is coming apart. */
  gap: 0.05,
  gapTicks: 3,
  /**
   * L6 crush spikes. A limb slammed into something (a forearm launched into a ledge's underside by a trampoline at
   * 24 m/s, an arm crushed by the wrecking ball or against a wall) can be forced past its limit (up to ~1.1 rad) or
   * pulled apart for a moment. Rapier's JS API can't make that stiffer: the limits live on the impulse joint, whose
   * correction speed is capped (~3 rad/s back), revolute limits can't be put on the multibody joint, and more solver
   * passes barely help (4+5 -> 8+10: worst 0.45 -> 0.49 rad; only 12+12 cuts it, at 6.5x the cost). A body hanging
   * from a hooked arm under its own weight stays within 0.06 rad, so it's the impact, not a weak motor. Decision: when
   * the joint's limb touches something, or some part of the body changed speed by `impactSpeed` in that step (a hit,
   * a crash: a dead body landing on one leg at 12 m/s bent the other knee 0.51 rad; a head hitting a ledge mid-jump
   * flung the raised arm 0.52 rad past straight), such a moment is a `joint_spike` (info) if the joint is back inside
   * within `spikeTicks`. One that lasts longer, or happens with nothing hitting the body (the body doing it to
   * itself, like the old hand-loss snap), is still a `joint_over_limit` / `joint_stretched` warning.
   */
  spikeTicks: 30,
  /** A part's speed changing this much (m/s) in one step counts as an impact (gravity adds 0.33 per step). */
  impactSpeed: 4,
} as const;

/**
 * Torso tilt (rad) at which the ragdoll counts as fallen / back up. L6: while down, the legs tuck (crouch targets),
 * so a body lying wedged between two walls (the narrow Test Lab's 2 m pocket: 17/36 trips stayed down for good) gets
 * short enough to rise.
 */
export const FALL = { downAngle: 1.2, upAngle: 0.3 } as const;

/** Distance from shoulder to the point arrows launch from (m). Matches the arm length. */
export const ARM_REACH = RAGDOLL.upperArm.hy * 2 + RAGDOLL.lowerArm.hy * 2;

export const DEBUG = {
  /** Log a physics snapshot this often while anything is moving. */
  snapshotEveryTicks: 60,
  /** Speeds above this (m/s) are logged as anomalies. */
  maxBodySpeed: 60,
  /**
   * World steps slower than this (ms) are logged as `slow_step`. A step at 60 Hz has 16.7 ms in all, and the room also
   * needs time for bots and sends. Measured with tools/tick-probe.ts on the i5-1335U dev laptop: back-to-back steps
   * average ~0.6 ms, but the live server's paced steps average ~3 ms (power saving), p99 ~6 ms, p99.9 ~8.5 ms.
   * So 10 ms = clearly abnormal, not the laptop idling (the old 4 ms fired dozens of times a minute in normal play).
   * The code's own cost is checked by the `bots` sim (back-to-back average).
   */
  slowStepMs: 10,
  /** Minimum ticks between two identical anomaly logs. */
  anomalyCooldownTicks: 60,
} as const;

// ---- Phase 3: game rules (starting numbers, confirmed) ----

export const HEALTH = {
  max: 100,
  /** Damage of a full-speed hit before the body-part multiplier. Scales down with slower arrows. */
  baseDamage: 20,
  /** L7: head ×5 → ×2.5 (50 damage, two headshots kill): the one-shot headshot was the main way lives ended in seconds. */
  zoneMultiplier: { head: 2.5, torso: 1, arm: 0.6, leg: 0.6 },
  /**
   * Arrows at or above this share of top speed do full damage. A full-power arrow loses a little speed climbing
   * its arc (31.83 m/s instead of 32 measured online), and that must not turn a one-hit headshot into 99.
   */
  fullDamageSpeedShare: 0.9,
  /** The last player to hit you within this long gets the kill, whatever finishes you off. */
  killCreditTicks: 180, // 3 s
} as const;

/**
 * L7 hits you can feel. Before, a bullet pushed only the part it hit (3.2 N·s: ~0.3 m/s for the whole body), and the
 * run push wiped that out within a hundredth of a second. Now every hit knocks the WHOLE body along the bullet
 * (`knock`, m/s by zone), plus a kick by zone: a head hit snaps the head back (`headSnap`, m/s on the head) and pitches
 * the torso back; a leg hit sweeps the legs along (`legSweep`, m/s on the legs) so the body pitches forward
 * (`pitch`, rad/s of torso spin: + = away from the shooter). For `flinchTicks` the walk and air control push at
 * `flinchControl`, so the knock shows instead of being walked off at once. Mid-air the knock cuts the jump's speed.
 * Measured (sim `hit_reaction`, each case vs the same body unhit): the plan's start (1.2 m/s, 0.2 s flinch) set a
 * runner back only 0.1 m; 2.5 m/s + 0.3 s: 0.42 m (target 0.3-0.6), head hit pitches back 0.22 rad, a jump lands
 * 0.48 m shorter, standing torso hits stay up. Leg hits: a small whole-body knock and a strong sweep, so the top stays
 * and the body pitches forward (0.15 rad; knock 0.7x with sweep 3: 0.07).
 */
export const HIT_REACTION = {
  knock: { head: 2.1, torso: 2.5, arm: 1.75, leg: 0.5 },
  headSnap: 2.5,
  legSweep: 5,
  pitch: { head: 5, torso: 0, arm: 0, leg: -8 },
  flinchTicks: 18,
  flinchControl: 0.25,
} as const;

/**
 * L7 springy, squishy legs (two whole legs only; hopping, dragging, crouching and lying down keep their own legs).
 * - Running (run key held, not braking): the swing leg (the one lifting) is held at `swingShare` of its strength, so it
 *   lags and overshoots (0.35 left the body rocking after a stop);
 *   the standing leg keeps all of it (balance: the run is a push on the whole body, not the legs' doing).
 * - In the air: rising, the legs are left as they are (a tuck or loose legs on the way up cut the standing climb
 *   1.4 -> 1.3 m, which the arenas' reach check relies on); falling slowly (around the top) they open into the
 *   splits (`split`, funny legs; L7 had them dangle loose); falling faster than `reachFall` they reach down under the
 *   body to catch the landing.
 * - Landing: the knees sink by the landing speed (`sinkPerSpeed` rad per m/s, at most `sinkMax`) and spring back over
 *   `landTicks`, the legs held at `landShare` meanwhile (springy, not stiff).
 * Measured by sim `leg_report` (feel_report and body_report must still pass with 0 falls).
 */
export const LEGS = {
  swingShare: 0.6,
  /**
   * Funny legs, Split Leap: around the top of a jump (from the apex for `dangleTicks`, instead of dangling) the legs
   * open into the splits, front leg forward and back leg back by `hip` rad, knees almost straight, held at `share`;
   * falling faster they snap shut and reach down to land (`reachFall`). Not on the way up (the climb, see above).
   */
  split: { hip: 1.1, knee: 0.15, share: 0.6 },
  /** A jump this many ticks before the feet left the ground counts as "this fall began with a jump" (the push takes a few ticks). */
  splitAfterJumpTicks: 15,
  /** Falling faster than `reachFall` m/s, the legs reach down under the body (at `reachShare`) to catch the landing. */
  reachFall: 2,
  /** The Split Leap is held at most this long after the top of a jump (ticks); it replaced L7's dangling legs. */
  dangleTicks: 18,
  reachShare: 0.7,
  sinkPerSpeed: 0.2,
  sinkMax: 0.9,
  landTicks: 14,
  landShare: 0.8,
} as const;

/** Stamina is for weapons only (L7: jumps are free; they used to cost 20 and a tired player couldn't jump). */
export const STAMINA = {
  max: 100,
  refillPerSec: 30,
  /**
   * Refill starts this long after the last spend. L3: a shot counts as spending until its reload is done, so holding
   * fire never rests (otherwise each 0.7 s reload refilled ~6 and "about 8 shots in a row" became ~16).
   */
  refillDelayTicks: 30, // 0.5 s
  /** After running out, the arms stay down until stamina is back to this. */
  recoverAt: 40,
} as const;

export const RESPAWN = {
  delayTicks: 180, // 3 s limp on the ground
  /**
   * L7: 2 s of no damage after respawning (was 1 s), drawn as a shield bubble that flickers in its last
   * `shieldFlickerTicks`; bullets spark off it; it ends at once when you shoot or swing (so it can't be abused).
   */
  protectTicks: 120,
  shieldFlickerTicks: 30,
  /** Respawn with the feet this far above the spawn point, so the body never starts touching the ground. */
  lift: 0.05,
  /**
   * Room a freshly built standing body needs above its feet (m), for `roomToStand` (repair, swap). Measured: the head's
   * top is 2.26 m above the feet (probe tools/probes/body-top.ts). 2026-10-11: the check used to stop at 2.2 m, so a
   * repair under Frozen Lake's ice shelf (2.2 m over the bank) built the head inside the shelf (respawn_blocked).
   */
  standRoom: 2.3,
} as const;

export const APPLE = {
  radius: 0.35,
  respawnTicks: 600, // 10 s
  /** Gentle up-and-down float. */
  bobAmplitude: 0.15,
  bobPeriodTicks: 120,
  redHealth: 30,
  goldStamina: 50,
} as const;

export const WALK = {
  /** L2: was 3 m/s (Stick Fight-like snappy running; sim feel_report). 2026-10-11: 5.5 -> 6 (the user: a little faster). */
  speed: 6, // m/s
  crouchFactor: 0.4,
  /** Share of normal acceleration while in the air. L2: 0.65 (was 0.3: a jump could only be nudged). */
  airControl: 0.65,
  /** How fast walking speed is reached (m/s²). L2: 37 = top speed in ~0.15 s (was 20). */
  accel: 37,
  /** Distance covered by one full step cycle (both legs). L2: 1.7 (was 1.2: at 5.5 m/s the legs blurred). */
  strideLength: 1.7,
  /**
   * L2: full-size steps from this speed up (m/s); faster only steps quicker. Steps used to be sized against the top
   * speed: slower runs (head arrow, crouch) took small steps the body outran, and a heavy head then tipped it over.
   */
  fullStrideSpeed: 3,
  /** Hip swing (rad) and swing-leg knee lift (rad) at full walking speed. */
  hipSwing: 0.55, // (L7: 0.4 -> 0.55 with the springy legs; Big Scissor: see below)
  /**
   * Funny legs, Big Scissor walk (picked from funny-legs-mock.html): the hips swing much wider and the trailing leg's
   * heel flicks up behind. `heelFlick` = extra knee bend (rad) on the leg behind, from `heelFlickFrom` of the way back.
   */
  scissorSwing: 0.55,
  heelFlick: 0.9,
  heelFlickFrom: 0.45,
  /** Seconds to blend the scissor swing in (run key pressed) and out (let go / braking). */
  scissorBlend: 0.15,
  /** A stop let go in the air without a jump (a stride bound, a small drop) brakes on landing, if that's within this. */
  brakeWaitTicks: 30,
  kneeLift: 1.0, // (L7: 0.5 -> 1.0: a much bigger knee bend on the forward swing)
  /**
   * After letting go: brake to a stop this hard (m/s²), feet still slippery. S4 dash feel: was 25 (a crisp stop);
   * 15 + the brake lean below: a stop pitches ~0.25 rad forward and snaps back, no stumble (sim body_report).
   */
  brake: 45,
  /**
   * L2: lean 0.06, brake lean 0.1 (were 0.12 / 0.25). At 5.5 m/s a 0.12 lean ran away to 0.46 rad while running and
   * the stop inherited it (pitch 0.48, ended 0.46 m behind where it began braking); 0.06 runs at 0.12, and the stop
   * pitches 0.16 and takes 0.12 s / 8 cm (probe, brake 45).
   * S4 dash feel: the torso leans this far (rad) into the walk at full speed, and into the slide while braking.
   * Measured (sim body_report) after the arm drag stopped pulling the body back: 0.12 -> 0.12 rad; 0.3 ran away
   * (0.74 rad, skidded backwards). With the old drag 0.12 gave no lean at all.
   */
  lean: 0.06,
  brakeLean: 0.1,
  /**
   * Foot friction while walking (applied as the lower of foot and ground, not Rapier's default average,
   * which kept real friction at 0.35). Measured: 0.2 tips the walker forward 0.37 rad; 0.1 leaves 0.09 rad.
   */
  walkFriction: 0.1,
} as const;

// ---- Phase 4: multiplayer ----

export const NET = {
  /** Game server: WebSocket for play + GET /rooms for the room list (same port). */
  port: 2567,
  /** The web page (Vite dev server). The server uses this only to tell players the address to share. */
  clientPort: 5173,
  /**
   * 2: join can name a room ('new' = create one); room list at GET /rooms. 3: arena info in welcome, 4 mm positions.
   * 4: matches (`match` / `arena` messages), filler bots instead of the dummy.
   * 5: arrow effects (snapshot effect bits, loose arrows), `drawn` on fire.
   * 6: head scale in the snapshot header (Big Head Mode).
   * 7: power-ups: held arrow per player, bubble contents, arrow kinds, props (puddles/balloons/ropes).
   * 8: hazards and floor surfaces in the arena info.
   * 9: score + crown per player, chaos rounds / awards / best moment in match info, taunt, hats.
   * 10: the arena's palette (L1 look) in the arena info.
   * 11: the gun (L3): input aim is an angle only; fire has no power/draw time, it carries the swing tick instead;
   *     snapshots carry each player's reload left and no stuck/loose arrows; `impact` events.
   * 12: body damage (L4): per player lost parts, dents and leg stage in snapshots; damage events carry the bullet hole.
   * 13: the welcome carries everyone's current bullet holes (L4: late joiners see them too); shot replies carry the tick.
   * 14: critical hits + melee (L5): weapon and broken limbs per player in snapshots, the knocked-away gun as a prop, `shot` replies for swings.
   * 15: the welcome carries the game speed (L7 dial): the client must step its previews by the server's game time;
   *     `fire` has no swing tick any more (L7: the gun never wobbles).
   * 16-18: L7 (shield impacts, leg off, limp leg in snapshots).
   * 19: M1-M3: room codes, room settings in `join`/welcome, the room list's details, `vote`, mode/vote/round/team
   *     scores in match info, teams in the roster.
   */
  protocolVersion: 19,
  /** Humans per room. Filler bots don't count. */
  maxPlayers: 8,
  /** Snapshot every 3 physics ticks = 20 per second. */
  snapshotEveryTicks: 3,
  /** Clients show the world this far in the past (6 ticks = 100 ms = 2 snapshot gaps), so there's always a newer snapshot to blend toward. */
  interpDelayTicks: 6,
  /** Messages per second a client may send before the extras are dropped. */
  maxMessagesPerSec: 120,
  nameMaxLength: 16,
  /**
   * Positions are sent as 16-bit whole numbers of 1/250 m: 4 mm steps (0.16 px on screen), range ±131 m.
   * 2 mm steps only reached ±65 m, less than a 64 m arena plus the arrow margins.
   */
  posScale: 250,
  /** Server writes per-client network stats this often. */
  statsEveryTicks: 300,
} as const;

/** M1: what a room's creator can pick (see `parseRoomSettings`). */
export const ROOM = {
  /** People per room: the creator picks from this range (bots don't count). */
  minPlayers: 2,
  maxPlayers: NET.maxPlayers,
  /** Match length range and default (minutes). */
  minutes: [2, 5] as const,
  defaultMinutes: 3,
  /** M2: arenas offered in a vote. */
  voteOptions: 3,
} as const;

// ---- Slapstick S2: matches + bots ----

/**
 * One match: ends when someone reaches the score target (M3: the mode's, `MODES`) or the time runs out; then results,
 * then the next arena. M1: a room's settings pick the length (minutes); this is the default.
 */
export const MATCH = {
  lengthTicks: 3 * 60 * 60, // 3 min
  resultsTicks: 10 * 60, // 10 s results screen
} as const;

/** Server-side filler bots: they keep quiet rooms busy and leave as people join. */
export const BOT = {
  /** Bots fill a room up to this many players in total. */
  fillTo: 4,
  names: ['Wobbles', 'Noodle', 'Bonk', 'Flop', 'Pickle', 'Sprocket', 'Biscuit'],
  /**
   * Random aim error (rad, standard deviation). L7: 0.07 → 0.3 so bots hit about a quarter of their shots at a moving
   * player (sim `bots`, bullet hits on moving bots per shot at them, 4 seeds each: 0.07 → 51%, 0.15 → 39%, 0.25 → 30%,
   * 0.3 → 24%, 0.35 → 22%). Most hits are close range, where an angle error barely matters, so it falls slowly.
   */
  aimError: 0.3,
  /** L5: a melee bot swings when the enemy's center is within this share of MELEE.reach (parts stick out past the center). */
  meleeReachShare: 0.9,
  /** Ticks spent aiming at a new target before the first shot (reaction time; the gun has no draw). L7: 0.4-0.8 s (was 0.2-0.5 s). */
  aimTicks: [24, 48],
  /**
   * M1: the room's bot level scales the aim error and the reaction time (normal = the numbers above). Easy misses about
   * twice as often; hard hits about a third of its shots at a moving player (sim `bots` with SIM_BOT_LEVEL).
   */
  levels: {
    easy: { aimErrorScale: 1.7, aimTicksScale: 1.5 },
    normal: { aimErrorScale: 1, aimTicksScale: 1 },
    hard: { aimErrorScale: 0.6, aimTicksScale: 0.7 },
  },
  /** L3: after a shot, the chance to keep shooting the same target on the next reload instead of walking a bit. */
  keepShooting: 0.55,
  /** L3: stop shooting below this stamina and wait (walking) until it's back to `restUntil`, so a bot rarely empties its arms. */
  restBelow: 26,
  restUntil: 60,
  /** Ticks spent walking between shots. */
  moveTicks: [20, 50],
  /** Further than this (m), walk toward the target instead of shooting. */
  maxShotRange: 30,
  /** Wanting to walk but moving less than `stuckDist` m in `stuckTicks`: jump, then turn around. */
  stuckTicks: 40,
  stuckDist: 0.3,
  /** After turning around at an obstacle, don't walk that way again for this long. */
  avoidTicks: 180,
  /** Wanting to walk this long without getting 1 m anywhere is logged as an anomaly (it should never happen). */
  stuckAnomalyTicks: 300,
  /**
   * Looking ahead while walking (m, measured up from the lowest sole): knee-height ray, the highest step it jumps (higher
   * is a wall: turn around), the same on two stumps (sim jump_reach: they climb 0.7 m; REACH.stumps.climb promises
   * 0.6), ray length.
   */
  kneeHeight: 0.4,
  maxStepUp: 1.3,
  maxStepUpStumps: 0.6,
  lookAhead: 1.1,
  /** Jump a step when walking at least this fast (m/s), or when this close to it (m) at any speed (L6: a standing jump climbs 1.4 m, so no backing up for a run-up). */
  jumpSpeedNeeded: 1.5,
  standJumpWithin: 0.7,
  /** L2: a jump is held this long (ticks), past MOVE.cutTicks, so it's a full jump, not a tapped hop. */
  jumpHoldTicks: 20,
  /** Aim search: this many arcs between the flat shot and the lob (L3: one bullet speed, so up to 7 previews per decision). */
  aimArcSteps: 6,
  /** Stop walking this close (m) to a pit edge. */
  pitMargin: 1.5,
} as const;

// ---- Slapstick S3: arrow effects + callouts ----

/** What a hit does to the body part it's in. Starting numbers, tuned with the sim (head_sway, arm_flail, leg_limp, ...). */
export const EFFECT = {
  /** A hit's effect lasts this long (a second hit on the same part restarts it). L3: the bullet itself is gone at once. */
  hitTicks: 300, // 5 s
  // (L7: the arm hit's gun swing and its network window were removed: the gun never wobbles. An arm hit only makes the
  // back arm windmill while walking.)
} as const;

/**
 * Callouts: comic banners the server picks for special hits (everyone sees the same one).
 * Distances in meters from where the arrow was fired to where it hit.
 */
export const CALLOUT = {
  snipedFrom: 25,
  pointBlankWithin: 3,
} as const;

/** What the effects do to the body (S3). Tuned with the sim: head_sway, arm_flail, leg_limp, stumble. */
export const EFFECT_BODY = {
  /** Head arrow: neck motor share (floppy head) and extra downward pull on the head (N): top-heavy. */
  headNeckStrength: 0.15,
  headExtraWeight: 30,
  /**
   * L2: running speed share with a head arrow. At the L2 speed (5.5 m/s) the floppy head pulled the runner over (probe:
   * 9-12 falls in 16 runs at 4-5.5 m/s); at 3.5 m/s none, and every stop still stumbles (16/16).
   */
  headRunFactor: 0.6,
  /** L2: share of the walk push while a limb is pinned (the full push bent a pinned knee 0.26 rad backward). */
  pinnedWalk: 0.25,
  /**
   * Share of the upright balance torque left with a head arrow: wobbly, and hard stops pitch the body forward.
   * Measured (sim head_sway, stop from full walk): 1 -> pitch 0.06 rad; 0.5 -> 0.09; 0.3 -> 0.2 (one stumble, no fall);
   * 0.2 -> 1.38 (falls over). Picked 0.3.
   * L3: 0.4. With the gun always held out front, 0.3 made every stop from a run a fall (6/6, tilt 1.55); 0.4: no falls,
   * every stop still stumbles (6/6, tilt up to 0.54); 0.5 barely wobbles (0.14). (BALANCE.kp also went 260 -> 400.)
   */
  headBalanceShare: 0.4,
  /** Arm arrow: while walking (not aiming), the arms spin in circles at this speed (rad/s). */
  flailSpeed: 9,
} as const;

/**
 * Stumble: standing (not walking), on the ground, with full balance, and the torso tips past `tilt` (rad): the legs
 * take a few quick steps that way (`ticks` long, at `speed` m/s) to catch it. Then not again for `cooldownTicks`.
 */
export const STUMBLE = {
  /**
   * Tip that sets it off, only while still tipping further (not already recovering). Normal body: a real tip only
   * (landings and stops on steps reach ~0.16 for a moment: at 0.15 bots stumbled ~60 times a minute). With a head
   * arrow lower, since the heavy head is what should make you stumble (a hard stop pitches it ~0.2; normal ~0.06).
   */
  tilt: 0.3,
  headTilt: 0.15,
  /** "Still tipping": spinning further over at least this fast (rad/s). */
  tippingSpeed: 0.2,
  /** With a head arrow, a stop from at least this speed (m/s) always stumbles (the head's momentum). */
  headStopSpeed: 2,
  ticks: 30,
  speed: 1.8,
  cooldownTicks: 60,
} as const;

/** Big Head Mode (a chaos round, S7): head hitbox this many times bigger (same weight), headshot multiplier instead of ×5. */
export const BIG_HEAD = { hitboxScale: 2, headMultiplier: 2 } as const;

// ---- Slapstick S5: power-ups (special arrows) + wall pins ----

/** Power-up bubbles: shoot one to get its special arrow for your next shot. */
export const PICKUP = {
  radius: 0.45,
  respawnTicks: 900, // 15 s
  bobAmplitude: 0.2,
  bobPeriodTicks: 150,
} as const;

/** What each special arrow does (starting numbers; tuned with the sim: glove, balloon_*, oil_*, pin, ...). */
export const SPECIAL = {
  /** Share of normal arrow damage. 0 = no damage (the hit still counts for kill credit). */
  /** L4: the glove does a little damage now (and leaves a dent). */
  damageShare: { glove: 0.25, balloon: 0.5, oil: 0, plunger: 0.5, bomb: 0, banana: 1, swap: 0, feather: 0 },
  /** Boxing glove: every part gets this speed change along the arrow (m/s) plus some lift; balance off this long. */
  glove: { speed: 14, lift: 4, stunTicks: 90 },
  /**
   * Helium balloon: lasts this long; lifts up to this share of the body's weight from the torso (less from a limb),
   * easing off as it nears `riseSpeed` (m/s), so the victim floats up slowly instead of rocketing (a flat 1.2× lift
   * accelerated the whole time: 4.5 m in 1.5 s). A leg balloon pulls the foot and that leg goes slack (sim
   * balloon_leg: 0.45 -> foot not lifted, 0.7 -> foot up 1.13 m while the body stays down: a one-foot hop).
   */
  /**
   * L7: a balloon that floats up to `popBelowTop` m under the arena's top edge pops there (the player drops back):
   * in a 20 s "Everyone Has Balloons" round an unpopped balloon carried a player out over the top (sim chaos).
   */
  /**
   * L7 floating (a balloon on the torso/head): it hovers at most `topMargin` m under the arena's top (no higher: it used
   * to carry players off the top of the screen) and a stiff push (`sideSpring` m/s² per m: 10 lost to the air-control
   * push and let it out of the arena, sim balloon_float) keeps it `sideMargin` m in
   * from the sides. You swim: jump (W / Space) adds `swimUp` of the body's weight in lift, crouch (S) takes `swimDown`
   * off; A / D push sideways like air control. The body runs and paddles in the air (`swimHz` cycles a second, `idleHz`
   * when no key is held).
   */
  balloon: {
    ticks: 240, torsoLift: 1.2, limbLift: 0.7, riseSpeed: 1.2, string: 1.2, radius: 0.35, popBelowTop: 0.5,
    topMargin: 2.5, sideMargin: 1.5, sideSpring: 150, swimUp: 0.35, swimDown: 0.3, swimHz: 1.6, idleHz: 0.6,
  },
  /**
   * Oil: a puddle this wide on the floor under the hit, for this long. Feet in it have almost no grip. Standing
   * still, the legs slowly slide into a split; walking, the legs scramble, then the body shoots forward on its belly.
   */
  oil: { width: 4, ticks: 480, friction: 0.01, splitSpeed: 0.7, splitMax: 1.5, scrambleTicks: 30, slideSpeed: 7, slideStunTicks: 70 },
  /** Plunger: a rubber rope drags the victim toward the shooter for this long (accel m/s², top speed m/s). */
  plunger: { ticks: 90, accel: 16, maxSpeed: 6 },
  /** Sticky bomb: sticks, beeps, then pushes everyone within `radius` away (up to `push` m/s, + damage at the center). */
  bomb: { fuseTicks: 120, radius: 4.5, push: 12, lift: 4, damage: 15 },
  /** Banana: splits into 3 after this many ticks of flight, spread by this angle (rad). */
  banana: { splitTicks: 12, spread: 0.12 },
  /** Feather: the victim laughs this long: arms flail, can't aim. */
  feather: { ticks: 90 },
} as const;

/** Wall pin: reach behind the hit (m), how long (ticks), a jump press takes this off; it tears out when a joint next to the pinned part is forced this far (rad) past its limit; it only takes hold on a body slower than `maxSpeed` (m/s, L6). */
export const PIN = { reach: 0.6, ticks: 120, mashTicks: 18, tearOver: 0.2, maxSpeed: 2.5 } as const;

/** SPLAT!: a body moving sideways at least `minSpeed` that loses `dropShare` of it in one tick against a wall. */
export const SPLAT = { minSpeed: 6, dropShare: 0.6, cooldownTicks: 60 } as const;

// ---- Slapstick S6: hazards + floor types ----

export const HAZARD = {
  /**
   * Trampoline: a strip of the floor (no lip: a 0.3 m pad wedged walkers against its side and even 8 cm stopped
   * their feet); a player is launched at most this often.
   */
  trampoline: { cooldownTicks: 20 },
  /**
   * Seesaw plank: thickness, weight (density), how far it tips each way (rad), and the kick an arrow gives an end (N·s),
   * pressing that end into the plank. Measured (sim seesaw), lift of a player on the other end: 45 -> 0.29 m,
   * 90 -> 1.05 m, 140 -> 2.36 m (bow). L6, with the gun's faster bullets: 140 -> 3.61 m, 110 -> 2.36 m (back to the bow's lift).
   */
  seesaw: { thickness: 0.3, density: 6, limit: 0.45, shotImpulse: 110 },
  /**
   * Wrecking ball: weight (density); an arrow swings it at `shotSpeed` m/s; moving faster than `hitSpeed` it knocks
   * players down (balance off `stunTicks`, pushed along with `push` × its speed). Whoever swung it in the last
   * `creditTicks` gets the hit (kill credit).
   */
  wreck: { density: 25, shotSpeed: 7, hitSpeed: 3, stunTicks: 60, push: 0.8, creditTicks: 180 },
  /** Wind: players feel this share of a wind box's push (arrows feel all of it). */
  wind: { playerShare: 0.5 },
  /** Conveyor: how hard it carries you toward its speed (m/s²). */
  conveyor: { accel: 12 },
  /** Floor types: ice grip, bouncy springiness. */
  surface: { iceFriction: 0.02, bouncyRestitution: 0.95 },
  /** A player inside a seesaw plank / wrecking ball this long is an anomaly. */
  stuckTicks: 30,
} as const;

// ---- Slapstick S7: match spice ----

/** Bounty crown: on with this many players; killing the holder scores this much (a normal kill scores 1). */
export const CROWN = {
  minPlayers: 3,
  bonus: 2,
  /** M3 Crown Keeper: the crown needs this many players, and its holder scores 1 point per this many ticks held. */
  keeperMinPlayers: 2,
  keeperTicksPerPoint: 60,
} as const;

/**
 * M3: game modes' numbers (the rules themselves are in `modes.ts`). Targets: the score that ends a match early.
 * Starting points, to tune after play.
 */
export const MODE = {
  ffaTarget: 15,
  /** Crown Keeper: seconds holding the crown. */
  crownTarget: 60,
  /** Last Stickman Standing: round wins. */
  roundsTarget: 3,
  meleeTarget: 15,
  chaosTarget: 15,
  /** Team Battle: the team's kills. */
  teamTarget: 25,
  /** Chaos mode: chaos rounds come this much more often (60 s → 25 s) and last this share as long (20 s → 18 s). */
  chaosEveryScale: 25 / 60,
  chaosLengthScale: 0.9,
} as const;

/**
 * M3 Last Stickman Standing: the pause after a round (everyone sees who won it), and the longest a round may last: then
 * the player with the most health left wins it (a tie: nobody). Sim `modes`: a round with no time limit stalled for
 * over a minute when two players couldn't reach each other; most rounds end in 20-30 s.
 */
export const ROUND = { pauseTicks: 3 * 60, maxTicks: 60 * 60 } as const;

/** Chaos rounds: one every `everyTicks` of a match, lasting `ticks`, announced `announceTicks` ahead. */
export const MODIFIER = {
  everyTicks: 60 * 60, // 60 s
  ticks: 20 * 60, // 20 s
  announceTicks: 3 * 60,
  /** Moon Gravity: this share of normal gravity (bodies and arrows). */
  moonGravity: 0.35,
} as const;

/** Callout timing: a second kill within this long is a DOUBLE KILL. */
export const STREAK = { doubleKillTicks: 180 } as const;

/**
 * Losing body parts (L0 spike, used by L4's damage ladders). A leg shot down to a stump keeps `stumpShare` of the thigh
 * (no knee, no shin). One leg left: the body hops, one hop per `hopStride` m, each hop `hopSpeed` m/s up. Two stumps:
 * walk and jump are scaled down. All *(start)* values, measured by the sim scenario `limb_loss`.
 */
export const LIMB = {
  stumpShare: 0.4,
  hopStride: 1.0,
  hopSpeed: 1.8,
  stumpsSpeed: 0.6,
  stumpsJump: 0.7,
  /** One leg left: the stump's hip angle (rad, negative = forward), held up out of the way. */
  stumpLift: -0.7,
  /** One leg left: the good knee's bend (rad) while standing/hopping: slightly crouched under the extra weight. */
  oneLegKnee: 0.5,
  /** Speed (m/s) of the small kick a shot-off piece gets, so it tumbles away instead of standing there. */
  pieceKick: 2,
  /**
   * L7: a leg shot off flies: along the bullet (`along` m/s), up (`up` m/s), spinning (`spin` rad/s), so everyone sees
   * it go. (The plain `pieceKick` was a small tumble you missed.) It lands with a thud: a piece that was falling
   * faster than `thudFall` m/s and then stops falling (slower than 1 m/s) makes a `thud` event (dust on screens).
   */
  lostLeg: { along: 4.5, up: 6, spin: 16 },
  thudFall: 3,
  /**
   * L4 dragging limp: the hurt leg hangs (motors at `dragStrength` of normal) trailing behind (hip `dragHip` rad, knee
   * `dragKnee` rad bent), its foot slippery so it's pulled along; the body hops on the good leg like one-leg mode.
   */
  dragHip: 0.35,
  dragKnee: 0.6,
  dragStrength: 0.06,
  /** A dragging leg costs speed (a full one-leg hop runs at full speed: L0). */
  dragSpeed: 0.75,
  /**
   * L7: limping on a dragged leg, the good knee dips this much deeper (rad) between hops and comes back up for the next
   * push: a heavier, clearer limp. Walking speed and jump height stay the same (the body is moved by pushes, not legs).
   */
  hopDip: 0.55,
} as const;

/**
 * L4 body damage: hits add up over one life. Legs: one shared ladder (see `BodyDamage`): 1st leg hit a trip, 2nd a
 * dragging limp, 3rd that leg is shot to a thigh stump, 4th a trip on the other leg, 5th two stumps. (L7: the back hand
 * being shot off, its slower reload and wobbling gun were removed: annoying, not funny.) A red apple repairs (holes stay); respawning
 * resets everything. All *(start)* values, measured by the sim scenario `damage_report`.
 */
export const DAMAGE = {
  /** Bullet holes kept per player (the oldest go). */
  maxHoles: 24,
  /** Bullet holes in walls and floors kept per match (the oldest go): the server keeps them for late joiners. */
  maxWallHoles: 150,
  /**
   * A body that stays down this long with full balance (alive, not knocked; L6: counted from when balance came back,
   * not from the fall) in a damage stage is an anomaly: it can't get up.
   */
  stuckDownTicks: 300,
  /** A red apple's repair waits for room to stand this long, then gives up (logged). */
  repairWaitTicks: 180,
} as const;

/**
 * L5 critical hits + melee. A rare critical hit knocks your gun away (it lies on the floor; nobody can pick it up) and
 * you fight on with a melee weapon until you die. Crits: a bullet hitting you in the air (`critAirChance`), or a glove
 * punching you into a wall (SPLAT!: always). Melee players run faster and take less bullet damage, so they can reach
 * gun players. Each melee hit breaks the limb it hits; the `shatterAfter`-th melee hit breaks the body into pieces.
 * All *(start)* values, measured by the sim scenario `melee`.
 */
export const MELEE = {
  /**
   * L7: 25% → 8%, and only after `critMinAirTicks` in the air (0.25 s: not the tiny hops of running). 20 crits in 7 min
   * were too many to notice each one. After a crit the hands are empty for `drawTicks` (0.6 s: swings are refused),
   * then the bat/mace comes out.
   */
  critAirChance: 0.08,
  critMinAirTicks: 15,
  drawTicks: 36,
  /** A glove punch counts for a wall-splat crit for this long after it (ticks). */
  gloveSplatTicks: 90,
  /** About how far (m) a swing reaches from the shoulder (bots close in to it; the real hit test is the weapon's path). */
  reach: 1.8,
  /**
   * L7 swings: one click = one swing, toward where you FACE (no pointer). First a short wind-up (`windup` ticks: the arm
   * goes to the start, no hits), then the stroke: the arm sweeps the weapon through an angle in the facing frame
   * (0 = straight ahead, + = down, y points down) from `from` to `to` over `ticks`; then the arm goes loose for
   * `settleTicks` (the weapon swings on with its momentum and settles). The hit is tested along the drawn weapon
   * (hand to tip) between its last and current place on every tick from `activeFrom` (share of the stroke) to
   * `activeAfter` ticks into the settle, so what you see is what hits.
   * - bat: the upswing: from low behind, up and over the top, down in front.
   * - mace: the low sweep: from low behind, along the floor (about 15 cm above it at the bottom, standing), to low in
   *   front: a hit trips the victim.
   * Measured with tools/probes/swing.ts (tip path and the arm's lag behind its target).
   */
  motions: {
    bat: { windup: 8, from: 2.5, to: 6.9, ticks: 16, activeFrom: 0.45, activeAfter: 4, settleTicks: 18, trips: false },
    mace: { windup: 8, from: 2.3, to: 0.6, ticks: 14, activeFrom: 0.3, activeAfter: 2, settleTicks: 10, trips: true },
  },
  /** The weapon's length (m) from the hand to its far end (the bat's tip / the mace's spikes), as drawn. L7: the mace 0.74 → 0.95 (a long gada): standing, a shorter one couldn't be low and reach a body's legs at once (its sweep hit torsos or missed). */
  weaponLength: { bat: 0.92, mace: 0.95 },
  /** Ticks between swings (the gun's reload slot) and stamina per swing. */
  cooldownTicks: 36,
  stamina: 8,
  damage: 35,
  headDamage: 45,
  /**
   * The hit knocks the victim along the swing (m/s). L7: 5 -> 3, and the victim then STAGGERS back: for `stagger.ticks`
   * the legs take quick steps away from the hit (`stagger.speed` m/s, facing kept) with the torso leaned back
   * (`stagger.lean` rad), then catch the balance. (A mace hit on the legs trips instead.)
   */
  push: 3,
  stagger: { ticks: 42, speed: 2.6, lean: 0.28 },
  /** A player with a broken limb takes this much more damage. */
  brokenDamage: 1.25,
  shatterAfter: 3,
  /** Melee players run this much faster and take this share of bullet damage. */
  runFactor: 1.25,
  bulletShare: 0.7,
  /**
   * The knocked-away gun: its box (half sizes, m: the size it is drawn, so it lies on the floor as seen), its kick
   * (m/s; L7: 4 → 6, a big arc you can follow) and spin (rad/s; L7: it tumbles away).
   */
  gun: { hx: 0.62, hy: 0.09, kick: 6, spin: 14 },
} as const;

/**
 * L6: what the arena reach check (`arenaReach`) may assume a body can do (m). Below what sim `jump_reach` measures
 * with the best jump timing (whole: climb 2.0 m running / 1.4 m standing, gap 4.0 m level / 3.5 m to 1 m up / 5.0 m to
 * 2 m down; two stumps: climb 0.7 m, gap 1.5 m level), so it promises what an ordinary jump does, not a perfect one.
 * Gaps to lower ground grow with the extra fall time (jump physics: MOVE.jumpSpeed, GRAVITY_Y).
 */
export const REACH = {
  climb: 1.4,
  gap: 3.5,
  /** Gap onto a ledge 1 m higher; higher ledges shrink it in a straight line down to 0 at `climb`. */
  gapUp1: 3.0,
  stumps: { climb: 0.6, gap: 1.25 },
  /** A trampoline throws you this share of its power²/2g (measured: two stumps rose 8.1 m of 9.0). */
  trampolineShare: 0.8,
  /** How far sideways you can steer while flying up from a trampoline (m). */
  trampolineSideways: 4,
  /** A body needs this much room over a surface to stand on it (a low gap under a platform isn't a place). */
  headroom: 1.9,
} as const;
